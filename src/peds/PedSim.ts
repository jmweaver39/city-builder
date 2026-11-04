/**
 * A lightweight pedestrian sim, separate from the road sim. Pure TS, headless.
 *
 * People walk only on the pedestrian graph (sidewalks, corners, crosswalks, lot
 * paths, platforms). Each one makes a trip between plausible places: from homes to
 * shops, offices, industry, bus stops and stations, and back, with the mix and the
 * numbers following the time of day. Only an area round the camera is populated,
 * so nothing runs when the view is far away.
 *
 * At a crosswalk a walker waits for the light (all traffic over the crosswalk red,
 * which gives the walk phase or the parallel through-green) or, unsignalised, for a
 * gap. With the optional hook on, cars turning over a busy crosswalk are held by
 * closing their connectors through SimApi.blockConflict, but only once the gap check
 * shows nobody is already committed, so no car ever has to stop harder than it
 * comfortably can.
 */
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Id } from '../core/types';
import type { SimApi } from '../sim/api';
import {
  buildPedGraph,
  E_CROSS,
  G_APPROACH,
  G_COMMITTED,
  G_FEEDER,
  KERB_HEIGHT,
  nodesNear,
  WATCH_CELL,
  watchCellKey,
  type PedGraph,
  type PlaceKind,
} from './graph';
import { rngFrom } from './places';

export const P_WALKER = 0;
export const P_JOGGER = 1;
export const P_DOG = 2;

const S_WALK = 0;
const S_WAIT_CROSS = 1;
const S_WAIT_STOP = 2;
const S_LEAVE = 3;

/** Longest walk anyone sets out on, metres along the graph. */
const MAX_TRIP = 900;
/** Crossing a road costs this much extra when choosing a route, metres. */
const CROSS_PENALTY = 14;
/** People may join others already crossing for this long after the first stepped out. */
const JOIN_WINDOW = 4;
/** After a crossing held traffic, cars get this long before it can hold them again. */
const HOOK_COOLDOWN = 8;
const FADE_SEC = 0.6;
/** Where traffic stops before a crosswalk: past its far edge, metres back from the junction. */
const STOP_BACK = 3.9;
const HALF_LEN = [2.3, 2.6, 5.2, 6.2, 0.9];

export interface PedSimOptions {
  seed?: number;
  /** Let cars be held for people on crosswalks, through SimApi.blockConflict. */
  hook?: boolean;
}

interface CrossState {
  occupants: number;
  activeSince: number;
  cooldownUntil: number;
  blocked: string[];
  nextCheck: number;
  lastAnswer: boolean;
}

/** Activity over the day, 0..~1.2, by hour. */
export function dayActivity(h: number): number {
  const g = (c: number, w: number) => Math.exp(-((((h - c + 36) % 24) - 12) ** 2) / (2 * w * w));
  return 0.05 + 1.0 * g(8, 1.3) + 0.75 * g(13, 2.6) + 1.0 * g(17.5, 1.8) + 0.35 * g(20.5, 1.5);
}

type Phase = 'morning' | 'midday' | 'evening' | 'night';
function phaseWeights(h: number): Record<Phase, number> {
  const g = (c: number, w: number) => Math.exp(-((((h - c + 36) % 24) - 12) ** 2) / (2 * w * w));
  const m = g(8, 1.6);
  const d = g(13, 2.4);
  const e = g(18, 2);
  const n = g(1.5, 3.5);
  const s = m + d + e + n || 1;
  return { morning: m / s, midday: d / s, evening: e / s, night: n / s };
}

const PRODUCE: Record<PlaceKind, Record<Phase, number>> = {
  home: { morning: 1, midday: 0.55, evening: 0.35, night: 0.25 },
  shop: { morning: 0.1, midday: 0.6, evening: 0.9, night: 0.2 },
  office: { morning: 0.05, midday: 0.45, evening: 1, night: 0.05 },
  work: { morning: 0.05, midday: 0.3, evening: 1, night: 0.15 },
  bus: { morning: 0.5, midday: 0.4, evening: 0.9, night: 0.2 },
  station: { morning: 0.6, midday: 0.5, evening: 1, night: 0.2 },
};
const ATTRACT: Record<PlaceKind, Record<Phase, number>> = {
  home: { morning: 0.1, midday: 0.35, evening: 1, night: 1 },
  shop: { morning: 0.35, midday: 1, evening: 0.6, night: 0.08 },
  office: { morning: 1, midday: 0.3, evening: 0.05, night: 0.02 },
  work: { morning: 1, midday: 0.25, evening: 0.05, night: 0.15 },
  bus: { morning: 0.9, midday: 0.6, evening: 0.4, night: 0.2 },
  station: { morning: 1, midday: 0.6, evening: 0.45, night: 0.15 },
};

function mix(table: Record<Phase, number>, w: Record<Phase, number>): number {
  return table.morning * w.morning + table.midday * w.midday + table.evening * w.evening + table.night * w.night;
}

export class PedSim {
  graph: PedGraph | null = null;
  /** Render arrays, slots 0..count-1. */
  count = 0;
  capacity = 0;
  x = new Float32Array(0);
  y = new Float32Array(0);
  z = new Float32Array(0);
  yaw = new Float32Array(0);
  /** Walk cycle phase in radians, and stride (0 standing, 1 walking, about 1.7 running). */
  phase = new Float32Array(0);
  stride = new Float32Array(0);
  kind = new Uint8Array(0);
  /** Seed for clothing colours and height. */
  look = new Uint32Array(0);
  /** 0 to 1 as people appear at a door and disappear into one. */
  fade = new Float32Array(0);
  /** Graph node of the place each person is heading for, or -1. */
  target = new Int32Array(0);

  // Per person, internal.
  private path: (Int32Array | null)[] = [];
  private pi = new Int32Array(0);
  private along = new Float32Array(0);
  private speed = new Float32Array(0);
  private lat = new Float32Array(0);
  private state = new Uint8Array(0);
  private timer = new Float32Array(0);
  private crossing = new Int32Array(0);
  private goal = new Uint8Array(0);

  hour = 12;
  /** People per unit of place weight at full activity. Quality scales it. */
  density = 1;
  maxPeds = 1500;
  /** Area being populated. Radius 0 switches everything off. */
  focusX = 0;
  focusZ = 0;
  focusR = 0;
  time = 0;
  /** True when doors of a train stand open at this station. Set by the app. */
  stationDoors: ((stationId: Id) => boolean) | null = null;
  hookEnabled: boolean;
  private heldLast = false;

  /** Cars stop for people on crosswalks: the option, and the project's traffic setting. */
  get holdTraffic(): boolean {
    return this.hookEnabled && this.net.project.traffic.pedestriansStopTraffic !== false;
  }
  /** Told each time someone steps onto a crossing, before traffic is held. For tests. */
  onCross: ((crossing: number) => void) | null = null;
  /** Told each time a trip starts, with its origin and destination nodes. For tests. */
  onTrip: ((from: number, to: number, kind: number) => void) | null = null;

  private dirty = true;
  private rebuildTimer = 0;
  private builtAt = { x: Infinity, z: Infinity };
  private rng: () => number;
  private crossState: CrossState[] = [];
  private blockRefs = new Map<string, number>();
  private stopBacks = new Set<string>();
  private warm = true;
  private spawnDebt = 0;
  private doorsWere = new Map<Id, boolean>();
  private off: (() => void) | null;
  private scratch: number[] = [];
  /** Counters, for tests and the stats readout. */
  readonly counts = { spawned: 0, arrived: 0, crossed: 0, waitedAtSignal: 0, boarded: 0, held: 0 };

  // Dijkstra scratch.
  private dist = new Float32Array(0);
  private prev = new Int32Array(0);
  private seen = new Int32Array(0);
  private stamp = 0;
  private heapN: number[] = [];
  private heapD: number[] = [];

  constructor(
    private readonly net: RoadNetwork,
    private readonly sim: SimApi | null,
    opts: PedSimOptions = {},
  ) {
    this.rng = rngFrom(opts.seed ?? 1);
    this.hookEnabled = opts.hook ?? true;
    this.off = net.onChange((e) => {
      this.dirty = true;
      // The crosswalk setting changed: let go of held lanes and stop lines at once.
      if (e.settingsChanged && this.holdTraffic !== this.heldLast) {
        for (const st of this.crossState) this.release(st);
        this.applyStopBacks();
      }
    });
    this.ensure(256);
  }

  dispose(): void {
    this.clear();
    const graph = this.graph;
    this.graph = null;
    this.applyStopBacks();
    this.graph = graph;
    this.off?.();
    this.off = null;
  }

  /** Populate an area round (x, z). Radius 0 empties the world and stops all work. */
  setFocus(x: number, z: number, r: number): void {
    this.focusX = x;
    this.focusZ = z;
    if (r <= 0 && this.focusR > 0) this.clear();
    if (r > 0 && this.focusR <= 0) this.warm = true;
    this.focusR = r;
  }

  /** Remove everyone and release every held lane. */
  clear(): void {
    this.count = 0;
    for (let i = 0; i < this.path.length; i++) this.path[i] = null;
    for (const st of this.crossState) {
      st.occupants = 0;
      this.release(st);
    }
    this.warm = true;
  }

  private ensure(cap: number): void {
    if (cap <= this.capacity) return;
    const n = Math.max(cap, this.capacity * 2);
    const grow = <T extends Float32Array | Int32Array | Uint8Array | Uint32Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(n);
      b.set(a);
      return b;
    };
    this.x = grow(this.x);
    this.y = grow(this.y);
    this.z = grow(this.z);
    this.yaw = grow(this.yaw);
    this.phase = grow(this.phase);
    this.stride = grow(this.stride);
    this.kind = grow(this.kind);
    this.look = grow(this.look);
    this.fade = grow(this.fade);
    this.target = grow(this.target);
    this.pi = grow(this.pi);
    this.along = grow(this.along);
    this.speed = grow(this.speed);
    this.lat = grow(this.lat);
    this.state = grow(this.state);
    this.timer = grow(this.timer);
    this.crossing = grow(this.crossing);
    this.goal = grow(this.goal);
    this.capacity = n;
  }

  // -------------------------------------------------------------------------
  // Graph upkeep
  // -------------------------------------------------------------------------

  private rebuild(): void {
    this.clear();
    this.graph = buildPedGraph(this.net);
    this.builtAt = { x: this.focusX, z: this.focusZ };
    const n = this.graph.n;
    this.dist = new Float32Array(n);
    this.prev = new Int32Array(n);
    this.seen = new Int32Array(n);
    this.stamp = 0;
    this.crossState = this.graph.crossings.map(() => ({ occupants: 0, activeSince: 0, cooldownUntil: 0, blocked: [], nextCheck: 0, lastAnswer: false }));
    this.dirty = false;
    this.warm = true;
    this.applyStopBacks();
  }

  /** Traffic arriving at a crosswalk stops before it, not on it. */
  private applyStopBacks(): void {
    const sim = this.sim;
    if (!sim?.setStopBack) return;
    const want = new Set<string>();
    this.heldLast = this.holdTraffic;
    if (this.holdTraffic && this.graph) for (const c of this.graph.crossings) for (const k of c.approachKeys) want.add(k);
    const byKey = this.net.laneGraph.byKey;
    for (const k of this.stopBacks) {
      if (want.has(k)) continue;
      const idx = byKey.get(k);
      if (idx !== undefined) sim.setStopBack(idx, 0);
    }
    for (const k of want) {
      const idx = byKey.get(k);
      if (idx !== undefined) sim.setStopBack(idx, STOP_BACK);
    }
    this.stopBacks = want;
  }

  /** Build or refresh the graph now, for tests and tools. */
  refresh(): PedGraph {
    if (this.dirty || !this.graph) this.rebuild();
    return this.graph!;
  }

  // -------------------------------------------------------------------------
  // Stepping
  // -------------------------------------------------------------------------

  step(dt: number): void {
    if (this.focusR <= 0 || dt <= 0) return;
    this.time += dt;
    if (this.dirty) {
      // A drag edits every frame: rebuild a few times a second at most.
      this.rebuildTimer -= dt;
      if (this.rebuildTimer <= 0 || !this.graph) {
        this.rebuildTimer = 0.5;
        this.rebuild();
      }
    }
    const g = this.graph;
    if (!g) return;
    this.trainEvents(g);
    this.populate(g, dt);
    this.move(g, dt);
  }

  private target_(g: PedGraph): number {
    const w = phaseWeights(this.hour);
    let sum = 0;
    const r = this.focusR;
    for (const p of g.places) {
      const dx = g.x[p.node] - this.focusX;
      const dz = g.z[p.node] - this.focusZ;
      if (dx * dx + dz * dz > r * r) continue;
      sum += p.weight * (mix(PRODUCE[p.kind], w) + mix(ATTRACT[p.kind], w)) * 0.5;
    }
    return Math.min(this.maxPeds, Math.round(sum * 3.5 * dayActivity(this.hour) * this.density));
  }

  private populate(g: PedGraph, dt: number): void {
    const want = this.target_(g);
    if (this.warm) {
      this.warm = false;
      let guard = want * 3;
      while (this.count < want && guard-- > 0) this.spawn(g, true);
      return;
    }
    if (this.count >= want) return;
    // New trips start at doors at a pace that keeps the population near the target.
    this.spawnDebt += dt * Math.max(0.5, want / 45);
    let guard = 20;
    while (this.spawnDebt >= 1 && this.count < want && guard-- > 0) {
      this.spawnDebt -= 1;
      this.spawn(g, false);
    }
    if (this.spawnDebt > 5) this.spawnDebt = 5;
  }

  /** Bounded Dijkstra from a node. Fills dist and prev for nodes it reaches. */
  private search(g: PedGraph, from: number, limit: number): number[] {
    const reached = this.scratch;
    reached.length = 0;
    this.stamp++;
    const { dist, prev, seen } = this;
    const hn = this.heapN;
    const hd = this.heapD;
    hn.length = 0;
    hd.length = 0;
    const push = (n: number, d: number) => {
      let i = hn.length;
      hn.push(n);
      hd.push(d);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hd[p] <= d) break;
        hn[i] = hn[p];
        hd[i] = hd[p];
        i = p;
      }
      hn[i] = n;
      hd[i] = d;
    };
    const pop = (): number => {
      const top = hn[0];
      const ln = hn.pop()!;
      const ld = hd.pop()!;
      if (hn.length) {
        let i = 0;
        const n = hn.length;
        for (;;) {
          const l = 2 * i + 1;
          if (l >= n) break;
          const r = l + 1;
          const c = r < n && hd[r] < hd[l] ? r : l;
          if (hd[c] >= ld) break;
          hn[i] = hn[c];
          hd[i] = hd[c];
          i = c;
        }
        hn[i] = ln;
        hd[i] = ld;
      }
      return top;
    };
    seen[from] = this.stamp;
    dist[from] = 0;
    prev[from] = -1;
    push(from, 0);
    while (hn.length) {
      const d0 = hd[0];
      const u = pop();
      if (d0 > dist[u]) continue;
      reached.push(u);
      for (let k = g.start[u]; k < g.start[u + 1]; k++) {
        const v = g.to[k];
        const d = d0 + g.len[k] + (g.ekind[k] === E_CROSS ? CROSS_PENALTY : 0);
        if (d > limit) continue;
        if (seen[v] !== this.stamp || d < dist[v]) {
          seen[v] = this.stamp;
          dist[v] = d;
          prev[v] = u;
          push(v, d);
        }
      }
    }
    return reached;
  }

  private pathTo(to: number): Int32Array {
    const out: number[] = [];
    // Bounded: a stale prev chain can loop, which used to grow this array until it threw
    // (seconds of stall, then a dead frame loop). Found by the benchmark's rail view.
    for (let v = to; v >= 0 && out.length <= this.prev.length; v = this.prev[v]) out.push(v);
    out.reverse();
    return Int32Array.from(out);
  }

  /** Start one trip. `midway` puts the person somewhere along it, for filling a view at once. */
  private spawn(g: PedGraph, midway: boolean): boolean {
    const w = phaseWeights(this.hour);
    const r = this.focusR;
    // Origin by production.
    let total = 0;
    const cands = this.originScratch;
    cands.length = 0;
    for (let i = 0; i < g.places.length; i++) {
      const p = g.places[i];
      const dx = g.x[p.node] - this.focusX;
      const dz = g.z[p.node] - this.focusZ;
      if (dx * dx + dz * dz > r * r) continue;
      const wt = p.weight * mix(PRODUCE[p.kind], w);
      if (wt <= 0) continue;
      total += wt;
      cands.push(i, wt);
    }
    if (total <= 0) return false;
    let pick = this.rng() * total;
    let origin = -1;
    for (let i = 0; i < cands.length; i += 2) {
      pick -= cands[i + 1];
      if (pick <= 0) {
        origin = cands[i];
        break;
      }
    }
    if (origin < 0) origin = cands[cands.length - 2];
    const from = g.places[origin];
    const roll = this.rng();
    const day = this.hour > 6 && this.hour < 21.5;
    let kind = P_WALKER;
    let path: Int32Array | null = null;
    let goalKind: PlaceKind | null = null;
    if (from.kind === 'home' && day && roll < 0.08) {
      // A jog or a dog walk: out from home and back again.
      kind = roll < 0.035 ? P_JOGGER : P_DOG;
      const reached = this.search(g, from.node, kind === P_JOGGER ? 700 : 400);
      const minD = kind === P_JOGGER ? 250 : 120;
      const far = reached.filter((n) => this.dist[n] >= minD);
      if (!far.length) return false;
      const turn = far[Math.floor(this.rng() * far.length)];
      const out = this.pathTo(turn);
      const back = out.slice(0, -1).reverse();
      const both = new Int32Array(out.length + back.length);
      both.set(out);
      both.set(back, out.length);
      path = both;
      goalKind = 'home';
    } else {
      const reached = this.search(g, from.node, MAX_TRIP);
      let sum = 0;
      const dests = this.destScratch;
      dests.length = 0;
      const placeAt = this.placeIndex(g);
      for (const n of reached) {
        const list = placeAt.get(n);
        if (!list) continue;
        const d = this.dist[n];
        if (d < 40) continue;
        for (const pi of list) {
          const p = g.places[pi];
          if (p.kind === from.kind && p.kind !== 'home') continue;
          if (from.kind === 'home' && p.kind === 'home') continue;
          const wt = p.weight * mix(ATTRACT[p.kind], w) * Math.exp(-d / 380);
          if (wt <= 0) continue;
          sum += wt;
          dests.push(pi, wt);
        }
      }
      if (sum <= 0) return false;
      let q = this.rng() * sum;
      let dest = dests[dests.length - 2];
      for (let i = 0; i < dests.length; i += 2) {
        q -= dests[i + 1];
        if (q <= 0) {
          dest = dests[i];
          break;
        }
      }
      path = this.pathTo(g.places[dest].node);
      goalKind = g.places[dest].kind;
    }
    if (!path || path.length < 2) return false;
    this.ensure(this.count + 1);
    const i = this.count++;
    this.path[i] = path;
    this.kind[i] = kind;
    this.look[i] = (this.rng() * 4294967296) >>> 0;
    this.speed[i] = kind === P_JOGGER ? 2.6 + this.rng() * 0.7 : kind === P_DOG ? 0.95 + this.rng() * 0.2 : 1.15 + this.rng() * 0.45;
    this.lat[i] = 0.25 + this.rng() * 0.75;
    this.state[i] = S_WALK;
    this.timer[i] = 0;
    this.crossing[i] = -1;
    this.target[i] = path[path.length - 1];
    this.goal[i] = goalKind ? GOALS.indexOf(goalKind) : 0;
    this.phase[i] = this.rng() * Math.PI * 2;
    this.stride[i] = 0;
    this.pi[i] = 0;
    this.along[i] = 0;
    this.fade[i] = 0;
    if (midway) {
      this.fade[i] = 1;
      // Somewhere along the way, never out on a crossing.
      const k = Math.floor(this.rng() * (path.length - 1));
      const e = this.edgeIndex(g, path[k], path[k + 1]);
      this.pi[i] = k;
      this.along[i] = e >= 0 && g.ekind[e] !== E_CROSS ? this.rng() * g.len[e] : 0;
    }
    this.place(g, i);
    this.counts.spawned++;
    this.onTrip?.(path[0], path[path.length - 1], this.kind[i]);
    return true;
  }

  private originScratch: number[] = [];
  private destScratch: number[] = [];
  private placeMap: Map<number, number[]> | null = null;
  private placeMapFor: PedGraph | null = null;

  private placeIndex(g: PedGraph): Map<number, number[]> {
    if (this.placeMapFor !== g || !this.placeMap) {
      this.placeMap = new Map();
      g.places.forEach((p, i) => {
        let list = this.placeMap!.get(p.node);
        if (!list) this.placeMap!.set(p.node, (list = []));
        list.push(i);
      });
      this.placeMapFor = g;
    }
    return this.placeMap;
  }

  private edgeIndex(g: PedGraph, u: number, v: number): number {
    for (let k = g.start[u]; k < g.start[u + 1]; k++) if (g.to[k] === v) return k;
    return -1;
  }

  private remove(i: number): void {
    const j = --this.count;
    if (this.crossing[i] >= 0) this.leaveCrossing(this.crossing[i]);
    if (i !== j) {
      this.path[i] = this.path[j];
      this.x[i] = this.x[j];
      this.y[i] = this.y[j];
      this.z[i] = this.z[j];
      this.yaw[i] = this.yaw[j];
      this.phase[i] = this.phase[j];
      this.stride[i] = this.stride[j];
      this.kind[i] = this.kind[j];
      this.look[i] = this.look[j];
      this.fade[i] = this.fade[j];
      this.target[i] = this.target[j];
      this.pi[i] = this.pi[j];
      this.along[i] = this.along[j];
      this.speed[i] = this.speed[j];
      this.lat[i] = this.lat[j];
      this.state[i] = this.state[j];
      this.timer[i] = this.timer[j];
      this.crossing[i] = this.crossing[j];
      this.goal[i] = this.goal[j];
    }
    this.path[j] = null;
  }

  private move(g: PedGraph, dt: number): void {
    const r2 = (this.focusR + 120) ** 2;
    for (let i = 0; i < this.count; i++) {
      const path = this.path[i]!;
      const st = this.state[i];
      if (st === S_LEAVE) {
        this.fade[i] -= dt / FADE_SEC;
        this.stride[i] = Math.max(0, this.stride[i] - dt * 3);
        if (this.fade[i] <= 0) {
          this.remove(i);
          i--;
        }
        continue;
      }
      if (this.fade[i] < 1) this.fade[i] = Math.min(1, this.fade[i] + dt / FADE_SEC);
      if (st === S_WAIT_STOP) {
        this.timer[i] += dt;
        this.stride[i] = Math.max(0, this.stride[i] - dt * 3);
        if (this.boardNow(g, i)) {
          this.state[i] = S_LEAVE;
          this.counts.boarded++;
        }
        continue;
      }
      if (st === S_WAIT_CROSS) {
        this.timer[i] += dt;
        this.stride[i] = Math.max(0, this.stride[i] - dt * 3);
      }
      // Walking, or about to.
      let left = this.speed[i] * dt;
      let guard = 8;
      while (left > 0 && guard-- > 0) {
        const k = this.pi[i];
        if (k >= path.length - 1) break;
        const e = this.edgeIndex(g, path[k], path[k + 1]);
        if (e < 0) {
          // The graph changed under this person: end the trip quietly.
          this.state[i] = S_LEAVE;
          break;
        }
        // Stepping onto a crosswalk: only when allowed.
        if (g.ekind[e] === E_CROSS && this.crossing[i] < 0) {
          const ci = g.ecross[e];
          if (!this.mayCross(g, ci)) {
            if (this.state[i] !== S_WAIT_CROSS) {
              this.state[i] = S_WAIT_CROSS;
              this.timer[i] = 0;
              if (g.crossings[ci].signal) this.counts.waitedAtSignal++;
            }
            this.along[i] = 0;
            break;
          }
          this.enterCrossing(ci);
          this.crossing[i] = ci;
          this.state[i] = S_WALK;
        }
        const L = g.len[e];
        const room = L - this.along[i];
        if (left < room) {
          this.along[i] += left;
          left = 0;
          break;
        }
        left -= room;
        if (this.crossing[i] >= 0) {
          this.leaveCrossing(this.crossing[i]);
          this.crossing[i] = -1;
          this.counts.crossed++;
        }
        this.pi[i] = k + 1;
        this.along[i] = 0;
      }
      if (this.state[i] === S_WAIT_CROSS) {
        this.place(g, i);
        continue;
      }
      const want = this.kind[i] === P_JOGGER ? 1.7 : 1;
      this.stride[i] += (want - this.stride[i]) * Math.min(1, dt * 4);
      if (this.pi[i] >= path.length - 1 && this.state[i] === S_WALK) this.arrive(g, i);
      this.phase[i] += dt * this.speed[i] * (this.kind[i] === P_JOGGER ? 3.4 : 4.6);
      this.place(g, i);
      const dx = this.x[i] - this.focusX;
      const dz = this.z[i] - this.focusZ;
      if (dx * dx + dz * dz > r2 && this.state[i] === S_WALK) this.state[i] = S_LEAVE;
    }
  }

  private arrive(g: PedGraph, i: number): void {
    const goal = GOALS[this.goal[i]];
    this.counts.arrived++;
    if (goal === 'bus' || (goal === 'station' && g.kind[this.target[i]] === 2)) {
      this.state[i] = S_WAIT_STOP;
      this.timer[i] = 0;
      // Spread out along the stop or platform.
      this.lat[i] = (this.rng() - 0.5) * 2;
      this.along[i] = 0;
      return;
    }
    this.state[i] = S_LEAVE;
  }

  /** Should a waiting person get on now? */
  private boardNow(g: PedGraph, i: number): boolean {
    const goal = GOALS[this.goal[i]];
    const t = this.timer[i];
    if (goal === 'station') {
      const place = g.places.find((p) => p.node === this.target[i] && p.kind === 'station');
      if (place?.stationId !== undefined && this.stationDoors?.(place.stationId) && t > 2 + (this.look[i] % 5)) return true;
      return t > 240 + (this.look[i] % 120);
    }
    // A bus stopping close by takes everyone waiting.
    const v = this.sim?.vehicles;
    if (v && t > 1) {
      const n = this.target[i];
      for (let k = 0; k < v.count; k++) {
        if (v.type[k] !== 3) continue;
        const dx = v.x[k] - g.x[n];
        const dz = v.z[k] - g.z[n];
        if (dx * dx + dz * dz < 16 * 16 && v.speed[k] < 3) return true;
      }
    }
    return t > 150 + (this.look[i] % 150);
  }

  /** Trains opening their doors let people off onto the platform. */
  private trainEvents(g: PedGraph): void {
    if (!this.stationDoors) return;
    for (const pf of g.platforms) {
      const open = this.stationDoors(pf.stationId);
      const was = this.doorsWere.get(pf.stationId) ?? false;
      this.doorsWere.set(pf.stationId, open);
      if (!open || was) continue;
      const mid = pf.nodes[Math.floor(pf.nodes.length / 2)];
      const dx = g.x[mid] - this.focusX;
      const dz = g.z[mid] - this.focusZ;
      if (dx * dx + dz * dz > this.focusR * this.focusR) continue;
      const n = 3 + Math.floor(this.rng() * 6 * this.density);
      for (let k = 0; k < n && this.count < this.maxPeds; k++) this.alight(g, pf.nodes);
    }
  }

  private alight(g: PedGraph, nodes: number[]): void {
    const start = nodes[Math.floor(this.rng() * nodes.length)];
    const reached = this.search(g, start, MAX_TRIP);
    const w = phaseWeights(this.hour);
    const placeAt = this.placeIndex(g);
    let sum = 0;
    const dests = this.destScratch;
    dests.length = 0;
    for (const n of reached) {
      for (const pi of placeAt.get(n) ?? []) {
        const p = g.places[pi];
        if (p.kind === 'station' || p.kind === 'bus') continue;
        const wt = p.weight * mix(ATTRACT[p.kind], w) * Math.exp(-this.dist[n] / 380);
        sum += wt;
        dests.push(pi, wt);
      }
    }
    // Nowhere to walk to from this platform: leave by the platform's far end.
    let end = sum > 0 ? -1 : nodes[this.rng() < 0.5 ? 0 : nodes.length - 1];
    if (sum > 0) {
      let q = this.rng() * sum;
      end = g.places[dests[dests.length - 2]].node;
      for (let i = 0; i < dests.length; i += 2) {
        q -= dests[i + 1];
        if (q <= 0) {
          end = g.places[dests[i]].node;
          break;
        }
      }
    }
    if (end === start) return;
    const path = this.pathTo(end);
    if (path.length < 2) return;
    this.ensure(this.count + 1);
    const i = this.count++;
    this.path[i] = path;
    this.kind[i] = P_WALKER;
    this.look[i] = (this.rng() * 4294967296) >>> 0;
    this.speed[i] = 1.2 + this.rng() * 0.4;
    this.lat[i] = this.rng() * 2 - 1;
    this.state[i] = S_WALK;
    this.timer[i] = 0;
    this.crossing[i] = -1;
    this.target[i] = end;
    this.goal[i] = 0;
    this.phase[i] = this.rng() * 6.28;
    this.stride[i] = 0;
    this.pi[i] = 0;
    this.along[i] = 0;
    this.fade[i] = 0;
    this.place(g, i);
    this.counts.spawned++;
    this.onTrip?.(path[0], path[path.length - 1], this.kind[i]);
  }

  /** World position from the path state. */
  private place(g: PedGraph, i: number): void {
    const path = this.path[i]!;
    const k = Math.min(this.pi[i], path.length - 1);
    const u = path[k];
    const st = this.state[i];
    if (k >= path.length - 1 || st === S_WAIT_STOP) {
      // At the end: spread round the stop.
      const prevN = path[Math.max(0, path.length - 2)];
      let tx = g.x[u] - g.x[prevN];
      let tz = g.z[u] - g.z[prevN];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const spread = st === S_WAIT_STOP ? 2.4 : 0;
      this.x[i] = g.x[u] + tx * this.lat[i] * spread - tz * ((this.look[i] % 7) / 7 - 0.5) * 0.9 * (spread > 0 ? 1 : 0);
      this.y[i] = g.y[u];
      this.z[i] = g.z[u] + tz * this.lat[i] * spread + tx * ((this.look[i] % 7) / 7 - 0.5) * 0.9 * (spread > 0 ? 1 : 0);
      if (st === S_WAIT_STOP) this.yaw[i] = turnToward(this.yaw[i], Math.atan2(tz, -tx), 0.1);
      return;
    }
    const v = path[k + 1];
    const dx = g.x[v] - g.x[u];
    const dz = g.z[v] - g.z[u];
    const L = Math.hypot(dx, dz) || 1;
    const fx = dx / L;
    const fz = dz / L;
    const e = this.edgeIndex(g, u, v);
    const len = e >= 0 ? g.len[e] : L;
    let f = Math.min(1, this.along[i] / len);
    let back = 0;
    if (st === S_WAIT_CROSS) {
      // Waiting at the kerb, in a loose bunch.
      f = 0;
      back = 0.2 + (((this.look[i] >>> 3) % 9) / 8) * (g.spread[u] + 0.25);
    }
    const spread = Math.min(g.spread[u], g.spread[v]);
    const cross = e >= 0 && g.ekind[e] === E_CROSS;
    const lat = (cross ? 1.1 : spread) * this.lat[i];
    // Right of travel, so people keep right and pass on the left.
    const rx = -fz;
    const rz = fx;
    this.x[i] = g.x[u] + dx * f + rx * lat - fx * back + (st === S_WAIT_CROSS ? rx * (((this.look[i] >>> 7) % 11) / 10 - 0.5) * 2.6 : 0);
    this.z[i] = g.z[u] + dz * f + rz * lat - fz * back + (st === S_WAIT_CROSS ? rz * (((this.look[i] >>> 7) % 11) / 10 - 0.5) * 2.6 : 0);
    let y = g.y[u] + (g.y[v] - g.y[u]) * f;
    if (cross && f > 0.06 && f < 0.94) y -= KERB_HEIGHT;
    this.y[i] = y;
    this.yaw[i] = turnToward(this.yaw[i], Math.atan2(-fx, -fz), st === S_WAIT_CROSS ? 0.15 : 0.35);
  }

  // -------------------------------------------------------------------------
  // Crossings
  // -------------------------------------------------------------------------

  private enterCrossing(ci: number): void {
    this.onCross?.(ci);
    const s = this.crossState[ci];
    if (s.occupants === 0) {
      s.activeSince = this.time;
      this.hold(ci);
    }
    s.occupants++;
  }

  private leaveCrossing(ci: number): void {
    const s = this.crossState[ci];
    if (!s) return;
    s.occupants = Math.max(0, s.occupants - 1);
    if (s.occupants === 0 && s.blocked.length) {
      this.release(s);
      s.cooldownUntil = this.time + HOOK_COOLDOWN;
    }
  }

  private hookOn(g: PedGraph, ci: number): boolean {
    return this.holdTraffic && !!this.sim?.blockConflict && g.crossings[ci].hook && g.laneGraphVersion === this.net.laneGraph.version;
  }

  /** Close the connectors over the crosswalk while people are on it. */
  private hold(ci: number): void {
    const g = this.graph!;
    if (!this.hookOn(g, ci)) return;
    const c = g.crossings[ci];
    const s = this.crossState[ci];
    const keys = new Set([...c.fromKeys, ...c.intoKeys]);
    const byKey = this.net.laneGraph.byKey;
    for (const key of keys) {
      const idx = byKey.get(key);
      if (idx === undefined) continue;
      const refs = this.blockRefs.get(key) ?? 0;
      if (refs === 0) this.sim!.blockConflict!(idx, true);
      this.blockRefs.set(key, refs + 1);
      s.blocked.push(key);
    }
    if (s.blocked.length) this.counts.held++;
  }

  private release(s: CrossState): void {
    const byKey = this.net.laneGraph.byKey;
    for (const key of s.blocked) {
      const refs = (this.blockRefs.get(key) ?? 1) - 1;
      if (refs <= 0) {
        this.blockRefs.delete(key);
        const idx = byKey.get(key);
        if (idx !== undefined) this.sim?.blockConflict?.(idx, false);
      } else this.blockRefs.set(key, refs);
    }
    s.blocked.length = 0;
  }

  /** The crossing person i is out on, or -1. */
  crossingOf(i: number): number {
    return this.crossing[i];
  }

  /** True while person i stands at a kerb waiting to cross. */
  waiting(i: number): boolean {
    return this.state[i] === S_WAIT_CROSS;
  }

  /** Lanes this sim is holding closed right now, by key. */
  heldLanes(): string[] {
    return [...this.blockRefs.keys()];
  }

  /** May someone step onto crossing ci now? */
  private mayCross(g: PedGraph, ci: number): boolean {
    const c = g.crossings[ci];
    const s = this.crossState[ci];
    if (s.occupants > 0) {
      if (this.time - s.activeSince >= JOIN_WINDOW) return false;
      // Traffic is held for those already out there: follow them.
      if (s.blocked.length && !c.signal) return true;
    } else if (this.time < s.cooldownUntil) return false;
    if (this.time < s.nextCheck) return s.lastAnswer;
    s.nextCheck = this.time + 0.3;
    s.lastAnswer = this.decide(g, c, ci);
    return s.lastAnswer;
  }

  private decide(g: PedGraph, c: (typeof g.crossings)[number], ci: number): boolean {
    const sim = this.sim;
    if (!sim) return true;
    // An edit left the lane indices behind: wait for the rebuild.
    if (g.laneGraphVersion !== this.net.laneGraph.version) return false;
    const hook = this.hookOn(g, ci);
    if (c.signal && sim.connectorLight) {
      const byKey = this.net.laneGraph.byKey;
      for (const key of c.fromKeys) {
        const idx = byKey.get(key);
        if (idx !== undefined && sim.connectorLight(idx) !== 'red') return false;
      }
      for (const key of c.straightIntoKeys) {
        const idx = byKey.get(key);
        if (idx !== undefined && sim.connectorLight(idx) !== 'red') return false;
      }
      // Enough of the phase left to get across, or at least to get going when traffic is held.
      const status = sim.signalStatus(c.nodeId);
      const need = hook ? 4 : c.length / 1.15 + 1;
      if (status && (status.stage !== 'green' || status.remainingSec < need)) return false;
    }
    return this.gapClear(c, hook);
  }

  /** No vehicle on, or committed to, the crosswalk. */
  private gapClear(c: PedGraph['crossings'][number], hook: boolean): boolean {
    const v = this.sim?.vehicles;
    if (!v || !v.count) return true;
    const crossTime = c.length / 1.15 + 2;
    const w = c.watch;
    const pad = 3;
    const R2 = 2.3 * 2.3;
    for (let k = 0; k < v.count; k++) {
      const x = v.x[k];
      const z = v.z[k];
      if (x < c.minX - pad || x > c.maxX + pad || z < c.minZ - pad || z > c.maxZ + pad) continue;
      const hx = -Math.sin(v.yaw[k]);
      const hz = -Math.cos(v.yaw[k]);
      const half = HALF_LEN[v.type[k]] ?? 2.5;
      const speed = v.speed[k];
      const zone = CROSSWALK_HALF + half + 0.4;
      const cx = Math.floor(x / WATCH_CELL);
      const cz = Math.floor(z / WATCH_CELL);
      // Every path the vehicle could be on is judged; any one in the way is enough.
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        for (let iz = cz - 1; iz <= cz + 1; iz++) {
          const list = c.watchCells.get(watchCellKey(ix, iz));
          if (!list) continue;
          for (const i of list) {
            const dx = w[i] - x;
            const dz = w[i + 1] - z;
            if (dx * dx + dz * dz > R2) continue;
            if (w[i + 2] * hx + w[i + 3] * hz < 0.5) continue;
            const rem = w[i + 4];
            // Body over the crosswalk, or close to it.
            if (rem - half < CROSSWALK_HALF + 0.25 && rem + half > -(CROSSWALK_HALF + 0.25)) return false;
            if (rem <= -zone) continue;
            const group = w[i + 5];
            const gapAhead = rem - half - CROSSWALK_HALF;
            // Allow for drivers speeding up as they come.
            const fast = Math.max(speed, 0.5) * 1.15 + 1;
            const reach = gapAhead / fast;
            if (group === G_COMMITTED) {
              if (speed > 0.3 ? reach < crossTime + 2 : gapAhead < 12) return false;
            } else if (group === G_APPROACH || group === G_FEEDER) {
              const held = hook || (group === G_APPROACH && c.signal);
              if (held) {
                const canStop = speed < 0.3 ? gapAhead > 0.5 : gapAhead > (speed * speed) / (2 * 2.2) + speed * 0.7 + 1;
                if (!canStop) return false;
              } else if (speed > 0.3 ? reach < crossTime + 1 : gapAhead < 6) return false;
            }
          }
        }
      }
    }
    return true;
  }
}

const CROSSWALK_HALF = 1.5;
const GOALS: PlaceKind[] = ['home', 'shop', 'office', 'work', 'bus', 'station'];

function turnToward(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

/** Everyone near (x, z): for tests and picking. */
export function pedsNear(sim: PedSim, x: number, z: number, r: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < sim.count; i++) if ((sim.x[i] - x) ** 2 + (sim.z[i] - z) ** 2 <= r * r) out.push(i);
  return out;
}

export { nodesNear };
