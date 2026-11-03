/** Poisson sources and arrival counts per place. */
import type { Id, VehicleMix } from '../core';
import { ENTRY_REQUEST } from './buckets';
import { ALLOW_BIKE, ALLOW_BUS, ALLOW_CAR, type CompiledGraph } from './compiled';
import { BIKE_SHARE, DT, SOURCE_QUEUE_CAP } from './constants';
import { allocVehicle } from './vehicles';
import type { LanePoint, Place, RouteTable } from './routing';
import { TYPE_BIKE, TYPE_BUS, VEHICLE_PARAMS } from './vehicleTypes';
import type { World } from './world';

export interface PlaceCounts {
  spawned: number;
  arrived: number;
  /** Vehicles sent here, counted at spawn. */
  destined: number;
}

const COLOR_COUNT = 16;
/** Minimum time between spawns onto one lane, so stale gaps are never trusted. */
const LANE_SPAWN_GAP_SEC = 0.6;

export class Spawner {
  /** Unit-rate time to the next arrival, per place. */
  private nextArrival: Float64Array = new Float64Array(0);
  pending: Int32Array = new Int32Array(0);
  counts: PlaceCounts[] = [];
  private byKey = new Map<string, PlaceCounts>();
  private laneStamp: Float64Array = new Float64Array(0);

  /** Line up with a new place list, keeping what survives. */
  setPlaces(w: World, places: Place[], oldPlaces: Place[]): void {
    const oldNext = new Map<string, number>();
    const oldPending = new Map<string, number>();
    oldPlaces.forEach((p, i) => {
      oldNext.set(p.key, this.nextArrival[i]);
      oldPending.set(p.key, this.pending[i]);
    });
    this.nextArrival = new Float64Array(places.length);
    this.pending = new Int32Array(places.length);
    this.counts = places.map((p, i) => {
      this.nextArrival[i] = oldNext.get(p.key) ?? w.rng.exp();
      this.pending[i] = oldPending.get(p.key) ?? 0;
      let c = this.byKey.get(p.key);
      if (!c) {
        c = { spawned: 0, arrived: 0, destined: 0 };
        this.byKey.set(p.key, c);
      }
      return c;
    });
    this.laneStamp = new Float64Array(w.g.n).fill(-1e9);
  }

  reset(w: World): void {
    this.byKey.clear();
    this.pending.fill(0);
    for (let i = 0; i < this.nextArrival.length; i++) this.nextArrival[i] = w.rng.exp();
    this.counts = this.counts.map((_, i) => {
      const c = { spawned: 0, arrived: 0, destined: 0 };
      this.byKey.set(w.routes.places[i].key, c);
      return c;
    });
    this.laneStamp.fill(-1e9);
  }

  countsFor(endpointId: Id): PlaceCounts | null {
    return this.byKey.get(`e${endpointId}`) ?? null;
  }

  /** Take back a vehicle the safety pass found no room for. It waits at its source. */
  unspawn(w: World, v: number): void {
    const source = w.veh.source[v];
    const dest = w.veh.dest[v];
    w.counters.spawned--;
    if (source >= 0 && source < this.counts.length) {
      this.counts[source].spawned--;
      if (this.pending[source] < SOURCE_QUEUE_CAP) this.pending[source]++;
    }
    if (dest >= 0 && dest < this.counts.length) this.counts[dest].destined--;
  }

  queued(): number {
    let t = 0;
    for (let i = 0; i < this.pending.length; i++) t += this.pending[i];
    return t;
  }

  step(w: World, onEnter: (seg: number) => void): void {
    const places = w.routes.places;
    const multiplier = w.net.traffic.multiplier;
    for (let i = 0; i < places.length; i++) {
      const p = places[i];
      if (p.rate <= 0) continue;
      const rate = (p.rate * multiplier) / 3600;
      if (rate <= 0) continue;
      let next = this.nextArrival[i] - rate * DT;
      while (next <= 0) {
        next += w.rng.exp();
        if (this.pending[i] < SOURCE_QUEUE_CAP) this.pending[i]++;
      }
      this.nextArrival[i] = next;
      let tries = 3;
      while (this.pending[i] > 0 && tries-- > 0) {
        const r = this.trySpawn(w, i, p, onEnter);
        if (r === 'sent') this.pending[i]--;
        else if (r === 'noRoute') {
          this.pending[i]--;
          tries++;
          if (this.pending[i] === 0) break;
        } else break;
      }
    }
  }

  private pickType(w: World, mix: VehicleMix): number {
    const total = mix.car + mix.van + mix.truck + mix.bus;
    if (!(total > 0)) return 0;
    let r = w.rng.next() * total;
    r -= mix.car;
    if (r < 0) return 0;
    r -= mix.van;
    if (r < 0) return 1;
    r -= mix.truck;
    if (r < 0) return 2;
    return 3;
  }

  /** Is this destination reachable from any of the source's lanes? */
  private reachable(w: World, table: RouteTable, dest: number, sources: LanePoint[], bit: number): boolean {
    const base = dest * w.g.n;
    for (let i = 0; i < sources.length; i++) {
      const l = sources[i].lane;
      if (w.g.allow[l] & bit && table.cost[base + l] < Infinity) return true;
    }
    return false;
  }

  private pickDest(w: World, from: number, table: RouteTable, sources: LanePoint[], bit: number): number {
    const places = w.routes.places;
    let total = 0;
    for (let i = 0; i < places.length; i++) {
      if (i === from || places[i].weight <= 0) continue;
      if (this.reachable(w, table, i, sources, bit)) total += places[i].weight;
    }
    if (total <= 0) return -1;
    let r = w.rng.next() * total;
    let pick = -1;
    for (let i = 0; i < places.length; i++) {
      if (i === from || places[i].weight <= 0) continue;
      if (!this.reachable(w, table, i, sources, bit)) continue;
      pick = i;
      r -= places[i].weight;
      if (r <= 0) break;
    }
    return pick;
  }

  private trySpawn(w: World, index: number, place: Place, onEnter: (seg: number) => void): 'sent' | 'noRoute' | 'blocked' {
    const { g, routes } = w;
    const mix = place.mix ?? w.net.traffic.defaultMix;
    // A small share rides wherever a bike lane leads somewhere.
    let type = TYPE_BIKE;
    let table = routes.bike;
    let bit = ALLOW_BIKE;
    let dest = -1;
    if (this.hasLane(g, place.sources, ALLOW_BIKE) && w.rng.next() < BIKE_SHARE) {
      dest = this.pickDest(w, index, table, place.sources, bit);
    }
    if (dest < 0) {
      type = this.pickType(w, mix);
      bit = type === TYPE_BUS ? ALLOW_BUS : ALLOW_CAR;
      if (!this.hasLane(g, place.sources, bit)) {
        type = 0;
        bit = ALLOW_CAR;
        if (!this.hasLane(g, place.sources, bit)) return 'noRoute';
      }
      table = type === TYPE_BUS ? routes.bus : routes.car;
      dest = this.pickDest(w, index, table, place.sources, bit);
      if (dest < 0) return 'noRoute';
    }

    // Cheapest open lane first, with a little noise to spread vehicles across lanes.
    const base = dest * g.n;
    let best = -1;
    let bestCost = Infinity;
    const stamp = this.laneStamp;
    const time = w.time;
    for (let i = 0; i < place.sources.length; i++) {
      const pt = place.sources[i];
      if (!(g.allow[pt.lane] & bit)) continue;
      const c = table.cost[base + pt.lane];
      if (c === Infinity) continue;
      if (time - stamp[pt.lane] < LANE_SPAWN_GAP_SEC || w.blocked[pt.lane]) continue;
      if (!this.hasRoom(w, pt, type)) continue;
      const noisy = c + w.rng.next() * 3;
      if (noisy < bestCost) {
        bestCost = noisy;
        best = i;
      }
    }
    if (best < 0) return 'blocked';
    this.place(w, index, dest, place.sources[best], type);
    onEnter(g.segIdx[place.sources[best].lane]);
    return 'sent';
  }

  private hasLane(g: CompiledGraph, sources: LanePoint[], bit: number): boolean {
    for (let i = 0; i < sources.length; i++) if (g.allow[sources[i].lane] & bit) return true;
    return false;
  }

  private frontAt(w: World, pt: LanePoint, type: number): number {
    const length = VEHICLE_PARAMS[type].length;
    return Math.min(Math.max(pt.s, length), w.g.len[pt.lane] - 0.2);
  }

  private hasRoom(w: World, pt: LanePoint, type: number): boolean {
    const { bk, veh } = w;
    const p = VEHICLE_PARAMS[type];
    const front = this.frontAt(w, pt, type);
    // At a lane start the tail is current; the lists below are a step old.
    if (pt.s === 0 && bk.tailRear[pt.lane] < front + p.minGap + 1) return false;
    const { start, eS, eV, eT } = bk;
    for (let e = start[pt.lane]; e < start[pt.lane + 1]; e++) {
      if (eT[e] === ENTRY_REQUEST) continue;
      const u = eV[e];
      const rear = eS[e] - veh.len[u];
      if (eS[e] >= front - p.length) {
        if (rear - front < p.minGap + 1 && eS[e] >= front) return false;
        // Overlapping my body, or close behind me.
        if (eS[e] < front && front - p.length - eS[e] < 6 + veh.v[u] * 1.2) return false;
      } else if (front - p.length - eS[e] < 6 + veh.v[u] * 1.2) {
        return false;
      } else {
        break;
      }
    }
    return true;
  }

  private place(w: World, source: number, dest: number, pt: LanePoint, type: number): void {
    const { g, veh, bk, rng, routes } = w;
    const v = allocVehicle(veh);
    bk.ensureCapacity(veh.capacity);
    const p = VEHICLE_PARAMS[type];
    const lane = pt.lane;
    const front = this.frontAt(w, pt, type);
    let speed = Math.min(g.speed[lane] * 0.75, 14);
    const tail = bk.tailRear[lane];
    if (tail !== Infinity && tail > front) {
      const gap = tail - front;
      const safe = Math.max(0, (gap - p.minGap) / p.headway) + bk.tailV[lane] * 0.5;
      if (safe < speed) speed = safe;
    }
    if (routes.places[source].isZone) speed = Math.min(speed, 3);

    veh.type[v] = type;
    veh.color[v] = rng.int(COLOR_COUNT);
    veh.lane[v] = lane;
    veh.s[v] = front;
    veh.v[v] = speed;
    veh.acc[v] = 0;
    veh.gapHard[v] = Infinity;
    veh.len[v] = p.length;
    veh.halfWidth[v] = p.width / 2;
    veh.spawnTick[v] = w.tick;
    veh.yieldSec[v] = 0;
    veh.accel[v] = p.accel * rng.range(0.9, 1.1);
    veh.decel[v] = p.decel;
    veh.headway[v] = p.headway * rng.range(0.92, 1.12);
    veh.minGap[v] = p.minGap;
    veh.maxSpeed[v] = p.maxSpeed;
    veh.speedFactor[v] = rng.range(0.93, 1.07);
    veh.noiseSeed[v] = rng.int(0x7fffffff);
    veh.dest[v] = dest;
    veh.source[v] = source;
    veh.prev1[v] = -1;
    veh.prev2[v] = -1;
    veh.ptIdx[v] = 0;
    veh.nextLane[v] = -1;
    veh.permit[v] = -1;
    veh.permitDist[v] = 0;
    veh.claimNext[v] = -1;
    veh.claimPrev[v] = -1;
    veh.lcFrom[v] = -1;
    veh.lcSec[v] = 0;
    veh.lcCool[v] = 0;
    veh.latStart[v] = 0;
    veh.reqLane[v] = -1;
    veh.needDir[v] = 0;
    veh.needCount[v] = 0;
    veh.needMust[v] = 0;
    veh.needDist[v] = 0;
    veh.limitV[v] = 1e3;
    veh.limitD[v] = 0;
    veh.mustWait[v] = 0;
    veh.seekV[v] = Infinity;
    veh.stopHold[v] = 0;
    veh.arriveTime[v] = -1;
    veh.waitSec[v] = 0;
    veh.stuckSec[v] = 0;
    veh.stuckProgress[v] = 0;
    veh.spawnTime[v] = w.time;
    veh.vlTick[v] = -1;
    veh.enterTick[v] = 0;
    veh.readyTick[v] = -1;
    veh.stratTick[v] = 0;
    veh.blink[v] = 0;
    veh.seen[v] = 0;
    veh.wx[v] = NaN;

    bk.append(v);
    const rear = front - p.length;
    if (rear < bk.tailRear[lane]) {
      bk.tailRear[lane] = rear;
      bk.tailV[lane] = speed;
    }
    this.laneStamp[lane] = w.time;
    w.counters.spawned++;
    this.counts[source].spawned++;
    this.counts[dest].destined++;
  }
}
