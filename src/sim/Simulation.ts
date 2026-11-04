/**
 * The traffic simulation. See "Simulation design" in ARCHITECTURE.md.
 *
 * A step runs: signals, table refresh, lane lists, strategy, merge order, car
 * following with junction entry, lane changes, motion, spawning, and output.
 * All randomness comes from a seeded generator and all logic runs on the fixed
 * step, so a seed reproduces a run exactly. Wall time is read only for `stepMs`.
 */
import type { Id, NetworkChange, RoadNetwork, Vec3 } from '../core';
import { VEHICLE_TYPES } from './api';
import type {
  SegmentTraffic,
  SignalHead,
  SignalPhaseStatus,
  SimApi,
  SimStats,
  VehicleDetail,
  VehicleView,
  EndpointStats,
  LightState,
} from './api';
import { Buckets, ENTRY_REAL } from './buckets';
import { compileGraph, type CompiledGraph } from './compiled';
import {
  DT,
  EMA_PERIOD_STEPS,
  FLOW_WINDOW_SEC,
  HISTORY_MAX,
  HISTORY_PERIOD_SEC,
  MAX_FRAME_DT,
  TABLE_REFRESH_SEC,
  THROUGHPUT_WINDOW_SEC,
} from './constants';
import { accelPass, integrate, type ArrivalSink } from './dynamics';
import { CTL_SIGNAL, JunctionSystem } from './junctions';
import { laneChangePass } from './laneChange';
import { mergePass } from './merge';
import { pickNext, retarget, tableOf } from './pathing';
import { remapVehicles, resolveOverlaps } from './remap';
import { clearEditOverlaps, enforceNoOverlap, snapshotVehicles } from './safety';
import { Rng } from './rng';
import { collectPlaces, Routing, type Place } from './routing';
import { lightName, SignalSystem } from './signals';
import { Spawner } from './spawner';
import type { SweepCache } from './sweep';
import { strategicPass } from './strategy';
import { clearVehicles, createVehicleStore, type VehicleStore } from './vehicles';
import { placeAll, writeView } from './view';
import { emptyCounters, type Counters, type World } from './world';

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

interface HistoryPoint {
  time: number;
  throughput: number;
  flow: number;
  active: number;
}

export class Simulation implements SimApi, ArrivalSink {
  speed = 1;
  private _time = 0;
  private accumulator = 0;
  private _alpha = 0;
  private _stepMs = 0;

  private readonly net: RoadNetwork;
  private readonly seed: number;
  private world: World;
  private spawner = new Spawner();
  private offNet: () => void;
  private graphDirty = false;
  private placesDirty = false;
  private resetDirty = false;
  /** Segments turned round since the last rebuild. */
  private readonly reversedSegs = new Set<Id>();
  private tick = 0;
  private refreshEvery = 1;
  /** Closed lanes, by key so that a closure outlives graph rebuilds. */
  private blockedKeys = new Set<string>();
  /** Stop short of these lane ends (setStopBack), by key. */
  private stopBackKeys = new Map<string, number>();
  private sweepCache: SweepCache = new Map();

  // Per-segment readouts.
  private segSpeed: Float64Array;
  private segCount: Int32Array;
  private segEnterNow: Int32Array;
  private segEnterPrev: Int32Array;
  private flowBucketTick = 0;
  private arrivalsNow = 0;
  private arrivalsPrev = 0;
  private arrivalBucketTick = 0;
  private historyPoints: HistoryPoint[] = [];
  private nextHistory = HISTORY_PERIOD_SEC;

  constructor(net: RoadNetwork, seed = 1) {
    this.net = net;
    this.seed = seed;
    const g = compileGraph(net, this.sweepCache);
    const veh = createVehicleStore(1024);
    this.world = this.createWorld(g, veh, new Rng(seed), null);
    this.world.routes.setPlaces(collectPlaces(net, g));
    this.spawner.setPlaces(this.world, this.world.routes.places, []);
    this.updateRefreshPace();
    this.segSpeed = new Float64Array(g.segCount).fill(1);
    this.segCount = new Int32Array(g.segCount);
    this.segEnterNow = new Int32Array(g.segCount);
    this.segEnterPrev = new Int32Array(g.segCount);
    this.world.bk.build(g, veh);
    this.offNet = net.onChange((e) => this.onNetChange(e));
  }

  private createWorld(g: CompiledGraph, veh: VehicleStore, rng: Rng, prev: World | null): World {
    const sig = new SignalSystem(g.n);
    const jn = new JunctionSystem(g);
    jn.compile(this.net, g, sig, prev?.sig ?? null);
    sig.init(this._time);
    const routes = new Routing(g, jn);
    if (prev) routes.adoptFlow(prev.routes);
    const blocked = new Uint8Array(g.n);
    for (const key of this.blockedKeys) {
      const lane = g.graph.byKey.get(key);
      if (lane !== undefined) blocked[lane] = 1;
    }
    let stopBack: Float32Array | undefined;
    if (this.stopBackKeys.size) {
      stopBack = new Float32Array(g.n);
      for (const [key, m] of this.stopBackKeys) {
        const lane = g.graph.byKey.get(key);
        if (lane !== undefined) stopBack[lane] = m;
      }
    }
    return {
      net: this.net,
      g,
      veh,
      bk: new Buckets(g.n, veh.capacity),
      routes,
      jn,
      sig,
      rng,
      blocked,
      stopBack,
      tick: this.tick,
      time: this._time,
      counters: prev?.counters ?? emptyCounters(),
    };
  }

  private updateRefreshPace(): void {
    const rows = this.world.routes.places.length;
    const stepsPerCycle = TABLE_REFRESH_SEC / DT;
    this.refreshEvery = Math.max(1, Math.floor(stepsPerCycle / Math.max(rows, 1)));
  }

  /** Stop listening to the network. */
  dispose(): void {
    this.offNet();
  }

  private onNetChange(e: NetworkChange): void {
    this.graphDirty = true;
    for (const id of e.reversedSegments) this.reversedSegs.add(id);
    // A re-laid road keeps its lane keys, but they may name other lanes now: re-seat by position.
    for (const id of e.relaidSegments ?? []) this.reversedSegs.add(id);
    if (e.endpointsChanged || e.settingsChanged) this.placesDirty = true;
    // Undo arrives as a reset too. Only a different project drops the traffic; anything
    // else keeps it, remapped by lane key like any other edit.
    if (e.reset && e.reason === 'replace') this.resetDirty = true;
    if (e.reset) this.placesDirty = true;
  }

  /** Catch up with edits. Returns true if there was anything to do. */
  private sync(): boolean {
    if (!this.graphDirty) return false;
    this.graphDirty = false;
    const w = this.world;
    if (this.resetDirty) {
      this.reset();
      return true;
    }
    const version = this.net.laneGraph.version;
    if (version !== w.g.version) this.rebuild(false);
    else if (this.placesDirty) this.rebuildPlaces(w.routes.places);
    this.placesDirty = false;
    return true;
  }

  private rebuild(fresh: boolean): void {
    const old = this.world;
    const oldGraph = old.g.graph;
    const g = compileGraph(this.net, this.sweepCache);
    if (!fresh) remapVehicles(old, old.g, oldGraph, g, this.reversedSegs);
    this.reversedSegs.clear();
    const w = this.createWorld(g, old.veh, old.rng, old);
    this.world = w;
    w.bk.resetOrder();
    for (let i = 0; i < w.veh.liveCount; i++) w.bk.append(w.veh.live[i]);
    w.bk.build(g, w.veh);
    resolveOverlaps(w);
    clearEditOverlaps(w);
    this.resizeSegments(old.g, g);

    const places = collectPlaces(this.net, g);
    const oldPlaces = old.routes.places;
    w.routes.setPlaces(places);
    this.spawner.setPlaces(w, places, oldPlaces);
    this.remapDestinations(oldPlaces, places);
    this.updateRefreshPace();
  }

  private rebuildPlaces(oldPlaces: Place[]): void {
    const w = this.world;
    const places = collectPlaces(this.net, w.g);
    w.routes.setPlaces(places);
    this.spawner.setPlaces(w, places, oldPlaces);
    this.remapDestinations(oldPlaces, places);
    this.updateRefreshPace();
  }

  private remapDestinations(oldPlaces: Place[], places: Place[]): void {
    const { veh } = this.world;
    const index = new Map<string, number>();
    places.forEach((p, i) => index.set(p.key, i));
    const toNew = oldPlaces.map((p) => index.get(p.key) ?? -1);
    for (let i = 0; i < veh.liveCount; i++) {
      const v = veh.live[i];
      const d = veh.dest[v];
      veh.dest[v] = d >= 0 && d < toNew.length ? toNew[d] : -1;
      const src = veh.source[v];
      veh.source[v] = src >= 0 && src < toNew.length ? toNew[src] : -1;
      veh.nextLane[v] = -1;
      veh.stratTick[v] = 0;
    }
  }

  private resizeSegments(oldG: CompiledGraph, g: CompiledGraph): void {
    const speed = new Float64Array(g.segCount).fill(1);
    const count = new Int32Array(g.segCount);
    const now = new Int32Array(g.segCount);
    const prev = new Int32Array(g.segCount);
    for (let i = 0; i < oldG.segCount; i++) {
      const at = g.segIndex.get(oldG.segIds[i]);
      if (at === undefined) continue;
      speed[at] = this.segSpeed[i];
      count[at] = this.segCount[i];
      now[at] = this.segEnterNow[i];
      prev[at] = this.segEnterPrev[i];
    }
    this.segSpeed = speed;
    this.segCount = count;
    this.segEnterNow = now;
    this.segEnterPrev = prev;
  }

  // ---------------------------------------------------------------------------
  // SimApi
  // ---------------------------------------------------------------------------

  get time(): number {
    return this._time;
  }

  get renderAlpha(): number {
    return this._alpha;
  }

  get vehicles(): VehicleView {
    return this.world.veh.view;
  }

  /** Internal state, for tests and debugging. Read only. */
  get state(): World {
    return this.world;
  }

  advance(realDt: number): void {
    if (this.sync()) writeView(this.world.veh);
    if (this.speed <= 0) return;
    const dt = Math.min(Math.max(realDt, 0), MAX_FRAME_DT) * this.speed;
    this.accumulator += dt;
    while (this.accumulator >= DT) {
      this.accumulator -= DT;
      this.step();
    }
    this._alpha = this.accumulator / DT;
  }

  step(): void {
    const started = nowMs();
    this.sync();
    const w = this.world;
    this.tick++;
    this._time = this.tick * DT;
    w.tick = this.tick;
    w.time = this._time;

    w.sig.update(this._time, w.g, w.bk);
    if (this.tick % this.refreshEvery === 0) w.routes.refreshNext();
    w.bk.ensureCapacity(w.veh.capacity);
    w.bk.build(w.g, w.veh);
    snapshotVehicles(w.veh);
    strategicPass(w);
    mergePass(w);
    accelPass(w);
    laneChangePass(w);
    integrate(w, this);
    this.spawner.step(w, this.enterSegment);
    placeAll(w.g, w.veh);
    enforceNoOverlap(w, this.takeBackSpawn);
    writeView(w.veh);
    this.housekeeping(w);
    const spent = nowMs() - started;
    this._stepMs += (spent - this._stepMs) * 0.05;
  }

  onArrive(w: World, v: number): void {
    const { veh, counters } = w;
    counters.tripSecSum += w.time - veh.spawnTime[v];
    const d = veh.dest[v];
    if (d >= 0) this.spawner.counts[d].arrived++;
    this.arrivalsNow++;
  }

  onSegmentEnter(seg: number): void {
    if (seg >= 0) this.segEnterNow[seg]++;
  }

  private enterSegment = (seg: number): void => this.onSegmentEnter(seg);

  private takeBackSpawn = (v: number): void => this.spawner.unspawn(this.world, v);

  private housekeeping(w: World): void {
    const tick = this.tick;
    if (tick % EMA_PERIOD_STEPS === 0) this.sampleLanes(w);
    if (tick - this.flowBucketTick >= FLOW_WINDOW_SEC / DT) {
      this.flowBucketTick = tick;
      const swap = this.segEnterPrev;
      this.segEnterPrev = this.segEnterNow;
      this.segEnterNow = swap;
      swap.fill(0);
    }
    if (tick - this.arrivalBucketTick >= THROUGHPUT_WINDOW_SEC / DT) {
      this.arrivalBucketTick = tick;
      this.arrivalsPrev = this.arrivalsNow;
      this.arrivalsNow = 0;
    }
    if (this._time >= this.nextHistory) {
      this.nextHistory += HISTORY_PERIOD_SEC;
      const s = this.stats();
      this.historyPoints.push({ time: this._time, throughput: s.throughputPerHour, flow: s.flow, active: s.active });
      if (this.historyPoints.length > HISTORY_MAX) this.historyPoints.shift();
    }
  }

  private sampleLanes(w: World): void {
    const { g, bk, veh, routes } = w;
    const { start, eT, eV } = bk;
    const { laneFlow } = routes;
    const { segSpeed, segCount } = this;
    segCount.fill(0);
    for (let l = 0; l < g.n; l++) {
      let sum = 0;
      let count = 0;
      for (let e = start[l]; e < start[l + 1]; e++) {
        if (eT[e] !== ENTRY_REAL) continue;
        sum += veh.v[eV[e]];
        count++;
      }
      const ratio = count ? Math.min(1, sum / count / g.speed[l]) : 1;
      laneFlow[l] += (ratio - laneFlow[l]) * 0.25;
      const seg = g.segIdx[l];
      if (seg >= 0) segCount[seg] += count;
    }
    // Segment speed: the worst-weighted mean of its lanes.
    const n = g.segCount;
    for (let i = 0; i < n; i++) {
      const dense = g.graph.roadLanes.get(g.segIds[i]);
      if (!dense) continue;
      let sum = 0;
      let lanes = 0;
      for (const l of dense) {
        if (l < 0 || g.allow[l] === 0) continue;
        sum += laneFlow[l];
        lanes++;
      }
      segSpeed[i] = lanes ? sum / lanes : 1;
    }
  }

  reset(): void {
    const old = this.world;
    clearVehicles(old.veh);
    this.tick = 0;
    this._time = 0;
    this.accumulator = 0;
    this._alpha = 0;
    // The network may have moved on since the last step, as after load(): everything
    // below reads it, so it must be read against the graph it has now.
    const g = this.net.laneGraph.version === old.g.version ? old.g : compileGraph(this.net, this.sweepCache);
    this.graphDirty = false;
    this.placesDirty = false;
    this.resetDirty = false;
    const w = this.createWorld(g, old.veh, new Rng(this.seed), null);
    this.world = w;
    w.routes.setPlaces(collectPlaces(this.net, w.g));
    this.spawner = new Spawner();
    this.spawner.setPlaces(w, w.routes.places, []);
    w.bk.build(w.g, w.veh);
    this.updateRefreshPace();
    if (g !== old.g) this.resizeSegments(old.g, g);
    this.segCount.fill(0);
    this.segSpeed.fill(1);
    this.segEnterNow.fill(0);
    this.segEnterPrev.fill(0);
    this.flowBucketTick = 0;
    this.arrivalBucketTick = 0;
    this.arrivalsNow = 0;
    this.arrivalsPrev = 0;
    this.historyPoints = [];
    this.nextHistory = HISTORY_PERIOD_SEC;
  }

  stats(): SimStats {
    const { veh, g, counters } = this.world;
    const count = veh.liveCount;
    let flow = 0;
    let speedSum = 0;
    let jammed = 0;
    for (let i = 0; i < count; i++) {
      const v = veh.live[i];
      const limit = g.speed[veh.lane[v]];
      const ratio = Math.min(1, veh.v[v] / limit);
      flow += ratio;
      speedSum += veh.v[v];
      if (ratio < 0.15) jammed++;
    }
    const windowSec = this.arrivalsPrev
      ? THROUGHPUT_WINDOW_SEC + (this.tick - this.arrivalBucketTick) * DT
      : Math.max(this._time - this.arrivalBucketTick * DT, 1);
    return {
      active: count,
      spawnedTotal: counters.spawned,
      arrivedTotal: counters.arrived,
      despawnedStuck: counters.despawnedStuck,
      throughputPerHour: ((this.arrivalsPrev + this.arrivalsNow) / windowSec) * 3600,
      flow: count ? flow / count : 1,
      meanSpeedKmh: count ? (speedSum / count) * 3.6 : 0,
      meanTripSec: counters.arrived ? counters.tripSecSum / counters.arrived : 0,
      jammed,
      stepMs: this._stepMs,
      removedByEdit: counters.removedByEdit,
      removedUnroutable: counters.removedUnroutable,
      retargeted: counters.retargeted,
      missedExits: counters.missedExits,
      forcedStops: counters.forcedStops,
      collisions: counters.collisions,
      safetyStops: counters.safetyStops,
      queuedAtSources: this.spawner.queued(),
    };
  }

  segmentTraffic(id: Id): SegmentTraffic {
    const i = this.world.g.segIndex.get(id);
    if (i === undefined) return { speedRatio: 1, flowPerHour: 0, count: 0 };
    const elapsed = FLOW_WINDOW_SEC + (this.tick - this.flowBucketTick) * DT;
    const span = this._time < FLOW_WINDOW_SEC ? Math.max(this._time, 1) : elapsed;
    return {
      speedRatio: this.segSpeed[i],
      flowPerHour: ((this.segEnterPrev[i] + this.segEnterNow[i]) / span) * 3600,
      count: this.segCount[i],
    };
  }

  signalHeads(): readonly SignalHead[] {
    return this.world.sig.heartbeat();
  }

  signalStatus(nodeId: Id): SignalPhaseStatus | null {
    return this.world.sig.status(nodeId);
  }

  /** The light on a connector, or 'off' when it is not at a signal. */
  connectorLight(lane: number): LightState {
    const w = this.world;
    if (w.blocked[lane]) return 'red';
    if (w.jn.ctl[lane] !== CTL_SIGNAL) return 'off';
    return lightName(w.sig.state[lane]);
  }

  blockConflict(lane: number, blocked: boolean): void {
    // The caller's index is into the network's graph as it is now.
    this.sync();
    const w = this.world;
    const key = w.g.graph.lanes[lane]?.key;
    if (key === undefined) return;
    if (blocked) this.blockedKeys.add(key);
    else this.blockedKeys.delete(key);
    w.blocked[lane] = blocked ? 1 : 0;
  }

  setStopBack(lane: number, metres: number): void {
    this.sync();
    const w = this.world;
    const key = w.g.graph.lanes[lane]?.key;
    if (key === undefined || w.g.isConn[lane]) return;
    const m = Math.max(0, Math.min(8, metres));
    if (m > 0) this.stopBackKeys.set(key, m);
    else this.stopBackKeys.delete(key);
    if (!w.stopBack && m > 0) w.stopBack = new Float32Array(w.g.n);
    if (w.stopBack) w.stopBack[lane] = m;
  }

  endpointStats(id: Id): EndpointStats | null {
    const c = this.spawner.countsFor(id);
    const i = this.world.routes.places.findIndex((p) => p.endpointId === id);
    if (!c) return null;
    return { spawned: c.spawned, arrived: c.arrived, destined: c.destined, queued: i >= 0 ? this.spawner.pending[i] : 0 };
  }

  vehicleDetail(id: number): VehicleDetail | null {
    const w = this.world;
    const { veh, g, routes } = w;
    let slot = -1;
    for (let i = 0; i < veh.liveCount; i++) {
      if (veh.id[veh.live[i]] === id) {
        slot = veh.live[i];
        break;
      }
    }
    if (slot < 0) return null;
    const dest = veh.dest[slot];
    const source = veh.source[slot];
    const route: Vec3[] = [];
    let lane = veh.lane[slot];
    let from = veh.s[slot];
    const seen = new Set<number>();
    for (let hop = 0; hop < 400 && lane >= 0 && !seen.has(lane); hop++) {
      seen.add(lane);
      const gl = g.graph.lanes[lane];
      for (let i = 0; i < gl.cum.length; i++) {
        if (gl.cum[i] >= from) route.push({ x: gl.pts[i * 3], y: gl.pts[i * 3 + 1], z: gl.pts[i * 3 + 2] });
      }
      if (dest >= 0 && routes.places[dest].sinks.some((k) => k.lane === lane)) break;
      lane = pickNext(w, slot, lane);
      from = 0;
    }
    return {
      id,
      type: VEHICLE_TYPES[veh.type[slot]],
      speedKmh: veh.v[slot] * 3.6,
      from: source >= 0 ? (routes.places[source]?.name ?? '') : '',
      to: dest >= 0 ? (routes.places[dest]?.name ?? '') : '',
      ageSec: this._time - veh.spawnTime[slot],
      route,
    };
  }

  history(): readonly HistoryPoint[] {
    return this.historyPoints;
  }
}

export type { Counters };
