/**
 * The train simulation: fixed step, seeded, no DOM or Three.js.
 *
 * Each step a train asks for more track, then drives on the authority it holds.
 * Signalling is block reservation. A train holds every block its body or planned
 * stop needs, so nothing else can be there, and it only moves onto track it holds.
 * Blocks used in both directions are taken whole, through to the next place a train
 * can stand aside, which is what makes a single line safe. If trains still end up
 * waiting on each other in a ring, the youngest is withdrawn.
 */
import type { NetworkChange, RoadNetwork } from '../core/RoadNetwork';
import type { RailLine, RailStation, TrainTypeId } from '../core/railTypes';
import type { Id, Vec3 } from '../core/types';
import { BUFFER_GAP, G, RAIL_DT, SIGNAL_MARGIN } from './constants';
import { acceleration, CAR_KINDS, makeConsist, TRAIN_TYPES, type Consist } from './consists';
import { findRoute, opposite, type Route, type RouteRules } from './planner';
import { RailRng } from './rng';
import { buildTrackGraph, TrackGraph, type StationPlace } from './TrackGraph';
import { TrackPath, type PathPoint } from './TrackPath';

export const FLAG_HIDDEN = 1;
/** Doors open on the car's own left (local -x). */
export const FLAG_DOORS = 2;
/** Doors open on the car's own right (local +x). */
export const FLAG_DOORS_R = 16;
const DOOR_BITS = FLAG_DOORS | FLAG_DOORS_R;
export const FLAG_BRAKING = 4;

/** Per-car render state. Slots are packed. A train's cars sit together, front first. */
export class CarView {
  count = 0;
  capacity = 0;
  train = new Int32Array(0);
  kind = new Uint8Array(0);
  tint = new Uint8Array(0);
  flags = new Uint8Array(0);
  /** 0 none, 1 white headlights, 2 red tail lights, on the model's front. */
  lamp = new Uint8Array(0);
  line = new Int32Array(0);
  speed = new Float32Array(0);
  prevX = new Float32Array(0);
  prevY = new Float32Array(0);
  prevZ = new Float32Array(0);
  prevYaw = new Float32Array(0);
  x = new Float32Array(0);
  y = new Float32Array(0);
  z = new Float32Array(0);
  /** Radians about +Y. Yaw 0 faces -Z, as vehicles do. */
  yaw = new Float32Array(0);
  /** Radians, nose up. */
  pitch = new Float32Array(0);
  /** Bogies, two per car: x, y, z, yaw. */
  bogie = new Float32Array(0);
  prevBogie = new Float32Array(0);

  ensure(capacity: number): void {
    if (capacity <= this.capacity) return;
    const cap = Math.ceil(capacity * 1.5) + 64;
    const grow = <T extends Float32Array | Uint8Array | Int32Array>(a: T, n: number): T => {
      const out = new (a.constructor as new (n: number) => T)(n);
      out.set(a);
      return out;
    };
    this.train = grow(this.train, cap);
    this.kind = grow(this.kind, cap);
    this.tint = grow(this.tint, cap);
    this.flags = grow(this.flags, cap);
    this.lamp = grow(this.lamp, cap);
    this.line = grow(this.line, cap);
    this.speed = grow(this.speed, cap);
    this.prevX = grow(this.prevX, cap);
    this.prevY = grow(this.prevY, cap);
    this.prevZ = grow(this.prevZ, cap);
    this.prevYaw = grow(this.prevYaw, cap);
    this.x = grow(this.x, cap);
    this.y = grow(this.y, cap);
    this.z = grow(this.z, cap);
    this.yaw = grow(this.yaw, cap);
    this.pitch = grow(this.pitch, cap);
    this.bogie = grow(this.bogie, cap * 8);
    this.prevBogie = grow(this.prevBogie, cap * 8);
    this.capacity = cap;
  }
}

type TrainState = 'run' | 'dwell' | 'turn';

interface Entry {
  block: number;
  start: number;
  end: number;
}

interface PlannedStop {
  station: Id;
  /** Where the head comes to rest. */
  s: number;
  /** Timetabled running time from the previous stop. */
  sched: number;
}

export interface Train {
  id: number;
  lineId: Id;
  consist: Consist;
  slot: number;
  path: TrackPath;
  entries: Entry[];
  /** Crossings on the path. */
  crossings: { index: number; start: number; end: number }[];
  head: number;
  v: number;
  a: number;
  /** True when running with the consist rear leading. */
  reversed: boolean;
  state: TrainState;
  timer: number;
  /** Next stop in the line's cycle. */
  seq: number;
  stops: PlannedStop[];
  stopIndex: number;
  /** Authority ends here. */
  authority: number;
  /** Past this the run is over. */
  runEnd: number;
  /** The run leaves the map rather than stops. */
  exits: boolean;
  reservedFrom: number;
  reservedTo: number;
  held: Map<number, number>;
  blockedBy: number;
  stuck: number;
  passengers: number;
  carried: number;
  departed: number;
  born: number;
  dirty: boolean;
  /** Wants another stop to reverse or plan from. */
  lost: boolean;
  /** Platform sides at the current stop, relative to travel: 1 left, 2 right. */
  doorSides: number;
}

export interface LinePlan {
  line: RailLine;
  ok: boolean;
  problem: string | null;
  warning: string | null;
  /** A diesel type that could run where this electric train cannot. */
  fixType: TrainTypeId | null;
  rules: RouteRules;
  /** Station ids, one full cycle. */
  cycle: Id[];
  /** Seconds round the cycle, timetabled. */
  cycleSec: number;
  lengthM: number;
  trainLength: number;
}

export interface LineCounters {
  carried: number;
  onTime: number;
  arrivals: number;
  next: number;
  from: number;
  /** Most trains this line has been able to run without locking up. */
  limit: number;
  held: number;
}

export interface RailStats {
  trains: number;
  cars: number;
  onBoard: number;
  carried: number;
  /** Percent of arrivals within a minute of the timetable. 100 before any. */
  onTimePct: number;
  lines: number;
  stations: number;
  /** Removed because an edit took the track away. */
  removedByEdit: number;
  /** Withdrawn to break a ring of trains waiting on each other. */
  withdrawn: number;
  stepMs: number;
}

export interface LineInfo {
  id: Id;
  name: string;
  color: string;
  running: number;
  wanted: number;
  problem: string | null;
  warning: string | null;
  /** Diesel type that would run here, when wires are the problem. */
  fixType: TrainTypeId | null;
  carried: number;
  onTimePct: number;
  cycleSec: number;
  lengthKm: number;
  trainLength: number;
}

export interface TrainDetail {
  id: number;
  line: string;
  color: string;
  type: string;
  cars: number;
  lengthM: number;
  massT: number;
  speedKmh: number;
  maxKmh: number;
  status: string;
  next: string;
  passengers: number;
  seats: number;
  gradePct: number;
  route: Vec3[];
}

export interface SignalView {
  count: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  yaw: Float32Array;
  /** 0 green, 1 yellow, 2 red. */
  state: Uint8Array;
}

export interface CrossingView {
  nodeId: Id;
  closed: boolean;
  /** 0 up, 1 down. */
  gate: number;
}

interface SignalSite {
  block: number;
  next: number;
  /** Block after next, along the first way on, or -1. */
  after: number;
}

const LOOKAHEAD = 120;
/** How long ahead of a train a crossing closes. */
const CROSSING_LEAD_SEC = 24;
const CROSSING_MIN_LEAD = 180;
const GATE_SEC = 6;
const ON_TIME_SEC = 60;
const RING_LIMIT_SEC = 60;

const a0: PathPoint = { x: 0, y: 0, z: 0 };
const a1: PathPoint = { x: 0, y: 0, z: 0 };
const a2: PathPoint = { x: 0, y: 0, z: 0 };

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

export class TrainSim {
  readonly view = new CarView();
  readonly signals: SignalView = { count: 0, x: new Float32Array(0), y: new Float32Array(0), z: new Float32Array(0), yaw: new Float32Array(0), state: new Uint8Array(0) };
  graph = new TrackGraph();
  /** Called when a level crossing closes or opens, with dense road lanes. */
  onCrossing: ((lanes: readonly number[], closed: boolean) => void) | null = null;
  /** Bumped on every graph rebuild. */
  graphVersion = 0;
  trains: Train[] = [];
  crossings: CrossingView[] = [];

  private rng: RailRng;
  private time_ = 0;
  private tick = 0;
  private accumulator = 0;
  private alpha = 0;
  private nextId = 1;
  private plans = new Map<Id, LinePlan>();
  private counters = new Map<Id, LineCounters>();
  /** Which ways each block is planned to be run: 1 forward, 2 back. */
  private use = new Uint8Array(0);
  private holders = new Int16Array(0);
  private owner = new Int32Array(0);
  private signalSites: SignalSite[] = [];
  private closedLanes = new Set<string>();
  private dirty = true;
  private removedByEdit = 0;
  private withdrawn = 0;
  private stepMs = 0;
  private off: () => void;

  constructor(
    private readonly net: RoadNetwork,
    private readonly seed = 1,
  ) {
    this.rng = new RailRng(seed);
    this.off = net.onChange((e) => this.onNetChange(e));
    this.rebuild();
  }

  dispose(): void {
    this.off();
  }

  get time(): number {
    return this.time_;
  }

  get renderAlpha(): number {
    return this.alpha;
  }

  private onNetChange(e: NetworkChange): void {
    if (e.reset || e.railChanged) {
      this.dirty = true;
      return;
    }
    if (e.removedSegments.some((id) => this.graph.segments.has(id))) this.dirty = true;
    for (const id of e.dirtySegments) {
      if (this.net.roadTypeOf(id).category === 'rail') this.dirty = true;
    }
    for (const id of e.dirtyNodes) {
      const node = this.net.getNode(id);
      if (node?.segments.some((s) => this.graph.segments.has(s))) this.dirty = true;
    }
  }

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------

  /** Feed simulated seconds, after the sim's speed setting. Runs zero or more steps. */
  advance(dt: number): void {
    if (this.dirty) this.rebuild();
    this.accumulator += Math.min(dt, 2);
    while (this.accumulator >= RAIL_DT) {
      this.accumulator -= RAIL_DT;
      this.step();
    }
    this.alpha = this.accumulator / RAIL_DT;
  }

  /** Run steps with no wall clock, for warming up a scene. */
  warm(seconds: number): void {
    const steps = Math.round(seconds / RAIL_DT);
    for (let i = 0; i < steps; i++) this.step();
  }

  step(): void {
    const started = nowMs();
    if (this.dirty) this.rebuild();
    this.tick++;
    this.time_ = this.tick * RAIL_DT;
    if (this.tick % 10 === 1) this.dispatch();
    const { view } = this;
    view.prevX.set(view.x);
    view.prevY.set(view.y);
    view.prevZ.set(view.z);
    view.prevYaw.set(view.yaw);
    view.prevBogie.set(view.bogie);
    const trains = this.trains;
    for (let i = 0; i < trains.length; i++) {
      const t = trains[i];
      if ((this.tick + i) % 4 === 0 || t.authority - t.head < LOOKAHEAD) this.extend(t);
      this.drive(t);
      this.releaseBehind(t);
      if (t.v > 0 || t.dirty) this.placeCars(t);
      this.progress(t);
    }
    this.flushRemovals();
    if (this.tick % 5 === 0) this.updateCrossings(0.5);
    if (this.tick % 10 === 0) this.updateSignals();
    if (this.tick % 50 === 0) this.breakRings(5);
    this.stepMs += (nowMs() - started - this.stepMs) * 0.05;
  }

  /** Clear the line and start dispatching again. */
  reset(): void {
    for (const t of this.trains) this.releaseAll(t);
    this.trains = [];
    this.view.count = 0;
    this.tick = 0;
    this.time_ = 0;
    this.accumulator = 0;
    this.alpha = 0;
    this.nextId = 1;
    this.rng = new RailRng(this.seed);
    this.counters.clear();
    this.removedByEdit = 0;
    this.withdrawn = 0;
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------

  /** Replace the graph and carry the trains across. */
  private rebuild(): void {
    this.dirty = false;
    const old = this.trains;
    const stale = new Map<Train, { head: Vec3; back: Vec3; tail: Vec3 }>();
    for (const t of old) {
      const len = t.consist.length;
      const hs = Math.min(t.head, t.path.length);
      const ts = Math.max(t.head - len, 0);
      t.path.sample(hs, a0);
      const head = { ...a0 };
      t.path.sample(Math.max(hs - 6, 0), a0);
      const back = { ...a0 };
      t.path.sample(Math.min(ts, t.path.length), a0);
      stale.set(t, { head, back, tail: { ...a0 } });
    }
    this.graph = buildTrackGraph(this.net);
    this.graphVersion++;
    const n = this.graph.blocks.length;
    this.use = new Uint8Array(n);
    this.holders = new Int16Array(n);
    this.owner = new Int32Array(n).fill(-1);
    this.plans.clear();
    for (const line of this.net.rail.lines) this.plans.set(line.id, this.planLine(line));
    this.buildSignals();
    this.resetCrossings();
    for (const c of this.counters.values()) {
      c.limit = Infinity;
      c.held = 0;
    }

    this.trains = [];
    for (const t of old) {
      t.held = new Map();
      t.path = new TrackPath(this.graph);
      const plan = this.plans.get(t.lineId);
      const fit = plan?.ok && plan.line.trainType === t.consist.type.id && plan.line.cars === t.consist.count;
      if (fit && this.remap(t, stale.get(t)!)) {
        this.trains.push(t);
      } else {
        this.removedByEdit++;
      }
    }
    this.repack();
    for (const t of this.trains) {
      if (!t.lost) this.startRun(t);
      this.extend(t);
    }
  }

  private planLine(line: RailLine): LinePlan {
    const type = TRAIN_TYPES[line.trainType];
    const rules: RouteRules = { metro: type.metro, power: type.power, maxSpeed: type.maxKmh / 3.6 };
    const trainLen = makeConsist(line.trainType, line.cars, new RailRng(1)).length;
    const plan: LinePlan = { line, ok: false, problem: null, warning: null, fixType: null, rules, cycle: [], cycleSec: 0, lengthM: 0, trainLength: trainLen };
    if (line.stops.length < 2) {
      plan.problem = 'Needs at least two stops';
      return plan;
    }
    const places: StationPlace[] = [];
    for (const id of line.stops) {
      const p = this.graph.stations.get(id);
      if (!p || !p.stops.length) {
        plan.problem = 'A stop has lost its track';
        return plan;
      }
      places.push(p);
    }
    const loop = line.stops.length > 2 && line.stops[0] === line.stops[line.stops.length - 1];
    const ids = loop ? line.stops.slice(0, -1) : line.stops;
    const cycle = loop ? ids : [...ids, ...ids.slice(1, -1).reverse()];
    const pieces = (id: Id) => new Set(this.graph.stations.get(id)!.stops.map((s) => s.piece));
    const allStates = (id: Id) => this.graph.stations.get(id)!.stops.flatMap((s) => [s.piece * 2, s.piece * 2 + 1]);

    const noRoute = (from: Id, to: Id, starts: number[]): LinePlan => {
      // Say whether wires are what is missing, and offer a diesel that could run.
      const unpowered = type.power !== 'diesel' && findRoute(this.graph, starts, pieces(to), { ...rules, power: 'diesel' });
      if (unpowered) {
        const what = type.power === 'thirdRail' ? 'third rail' : 'overhead wire';
        plan.problem = `${type.name} needs ${what}: the track from ${this.stationName(from)} to ${this.stationName(to)} has none in places`;
        plan.fixType = type.diesel;
      } else {
        plan.problem = `No track from ${this.stationName(from)} to ${this.stationName(to)} for this train`;
      }
      return plan;
    };
    const first = findRoute(this.graph, allStates(cycle[0]), pieces(cycle[1]), rules);
    if (!first) return noRoute(cycle[0], cycle[1], allStates(cycle[0]));
    let state = first.states[0];
    const legs: { route: Route; from: Id }[] = [];
    for (let i = 0; i < cycle.length; i++) {
      const to = cycle[(i + 1) % cycle.length];
      const route = this.bestLeg(state, pieces(to), rules, type.changeEnds);
      if (!route) return noRoute(cycle[i], to, [state, opposite(state)]);
      legs.push({ route, from: cycle[i] });
      state = route.states[route.states.length - 1];
    }

    let length = 0;
    for (const { route } of legs) {
      for (const s of route.states) {
        const p = this.graph.pieces[s >> 1];
        this.use[p.block] |= (s & 1) === 0 ? 1 : 2;
        length += p.length;
      }
      plan.cycleSec += route.cost;
    }
    plan.cycleSec += cycle.length * type.dwell + type.changeEnds * 2;
    plan.lengthM = length;
    plan.cycle = cycle;
    plan.ok = true;
    const short = places.filter((p) => p.kind !== 'gateway' && p.platformLength < trainLen - 1);
    if (short.length) plan.warning = `${short[0].name} platform is ${Math.round(short[0].platformLength)} m, the train is ${Math.round(trainLen)} m`;
    return plan;
  }

  /** The way on from a stop: straight on, or back the way it came when that is shorter. */
  private bestLeg(state: number, targets: ReadonlySet<number>, rules: RouteRules, changeEnds: number): Route | null {
    const ahead = findRoute(this.graph, [state], targets, rules);
    const back = findRoute(this.graph, [opposite(state)], targets, rules);
    if (!ahead) return back;
    if (!back) return ahead;
    return ahead.cost <= back.cost + changeEnds ? ahead : back;
  }

  private stationName(id: Id): string {
    return this.net.rail.stations.find((s) => s.id === id)?.name ?? `Stop ${id}`;
  }

  private buildSignals(): void {
    const g = this.graph;
    const sites: SignalSite[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    const yaws: number[] = [];
    for (const p of g.pieces) {
      if (p.kind !== 'run') continue;
      for (const forward of [true, false]) {
        const state = p.id * 2 + (forward ? 0 : 1);
        const bit = forward ? 1 : 2;
        const normal = p.normal === 0 || (p.normal === 1) === forward;
        if (!normal && !(this.use[p.block] & bit)) continue;
        if (p.normal === 0 && !(this.use[p.block] & bit)) continue;
        const ways = g.next[state];
        if (!ways.length) continue;
        const nextBlock = g.pieces[ways[0] >> 1].block;
        if (nextBlock === p.block) continue;
        const after = g.next[ways[0]]?.[0];
        const afterBlock = after === undefined ? -1 : g.pieces[after >> 1].block;
        const s = forward ? Math.max(0, p.length - 8) : Math.min(p.length, 8);
        const q = pieceAt(p, s);
        const q2 = pieceAt(p, forward ? Math.max(0, s - 2) : Math.min(p.length, s + 2));
        let fx = q.x - q2.x;
        let fz = q.z - q2.z;
        const l = Math.hypot(fx, fz) || 1;
        fx /= l;
        fz /= l;
        // On the right of the driver.
        xs.push(q.x + -fz * 2.4);
        ys.push(q.y);
        zs.push(q.z + fx * 2.4);
        yaws.push(Math.atan2(fx, fz));
        sites.push({ block: p.block, next: nextBlock, after: afterBlock });
      }
    }
    this.signalSites = sites;
    this.signals.count = sites.length;
    this.signals.x = Float32Array.from(xs);
    this.signals.y = Float32Array.from(ys);
    this.signals.z = Float32Array.from(zs);
    this.signals.yaw = Float32Array.from(yaws);
    this.signals.state = new Uint8Array(sites.length);
    this.updateSignals();
  }

  private updateSignals(): void {
    const { holders, owner, signalSites: sites, signals } = this;
    for (let i = 0; i < sites.length; i++) {
      const s = sites[i];
      const mine = holders[s.block] > 0 ? owner[s.block] : -1;
      const nextHeld = holders[s.next] > 0 && owner[s.next] !== mine;
      if (nextHeld) signals.state[i] = 2;
      else if (s.after >= 0 && holders[s.after] > 0 && owner[s.after] !== mine) signals.state[i] = 1;
      else signals.state[i] = 0;
    }
  }

  private resetCrossings(): void {
    const g = this.graph;
    const before = new Map(this.crossings.map((c) => [c.nodeId, c]));
    const wanted = new Set<string>();
    this.crossings = g.crossings.map((c) => {
      const old = before.get(c.nodeId);
      return { nodeId: c.nodeId, closed: old?.closed ?? false, gate: old?.gate ?? 0 };
    });
    const graph = this.net.laneGraph;
    g.crossings.forEach((c, i) => {
      if (!this.crossings[i].closed) return;
      for (const l of c.roadLanes) wanted.add(graph.lanes[l].key);
    });
    for (const key of this.closedLanes) {
      if (wanted.has(key)) continue;
      const idx = graph.byKey.get(key);
      if (idx !== undefined) this.onCrossing?.([idx], false);
    }
    this.closedLanes = wanted;
    const keep = [...wanted].flatMap((k) => {
      const idx = graph.byKey.get(k);
      return idx === undefined ? [] : [idx];
    });
    if (keep.length) this.onCrossing?.(keep, true);
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private counter(id: Id): LineCounters {
    let c = this.counters.get(id);
    if (!c) {
      c = { carried: 0, onTime: 0, arrivals: 0, next: 0, from: 0, limit: Infinity, held: 0 };
      this.counters.set(id, c);
    }
    return c;
  }

  private dispatch(): void {
    for (const plan of this.plans.values()) {
      if (!plan.ok) continue;
      const line = plan.line;
      const c = this.counter(line.id);
      if (this.time_ < c.next) continue;
      let running = 0;
      for (const t of this.trains) if (t.lineId === line.id) running++;
      if (running >= Math.min(line.trains, c.limit)) continue;
      const gap = line.headwaySec ?? Math.max(45, plan.cycleSec / Math.max(line.trains, 1));
      const gateway = this.isGatewayLine(plan);
      // Spread trains by starting them from either end in turn.
      const seq = c.from % 2 === 0 ? 0 : plan.line.stops.length - 1;
      const t = this.spawn(plan, seq) ?? this.spawn(plan, seq === 0 ? plan.line.stops.length - 1 : 0);
      if (t) {
        c.from++;
        c.next = this.time_ + (gateway ? gap : Math.min(gap, 120));
      } else {
        c.next = this.time_ + 5;
      }
    }
  }

  private isGatewayLine(plan: LinePlan): boolean {
    return plan.line.stops.every((id) => this.graph.stations.get(id)?.kind === 'gateway');
  }

  /** Put a new train at a stop of the line's cycle. Null when the track is not free. */
  private spawn(plan: LinePlan, seq: number): Train | null {
    const g = this.graph;
    const stationId = plan.cycle[seq];
    const place = g.stations.get(stationId);
    if (!place) return null;
    const nextId = plan.cycle[(seq + 1) % plan.cycle.length];
    const targets = new Set(g.stations.get(nextId)!.stops.map((s) => s.piece));
    const starts = place.stops.flatMap((s) => [s.piece * 2, s.piece * 2 + 1]);
    const route = findRoute(g, starts, targets, plan.rules);
    if (!route) return null;
    const first = route.states[0];
    const piece = g.pieces[first >> 1];
    const stop = place.stops.find((s) => s.piece === piece.id)!;
    const consist = makeConsist(plan.line.trainType, plan.line.cars, this.rng);
    const len = consist.length;
    const forward = (first & 1) === 0;
    const local = forward ? stop.s : piece.length - stop.s;

    const path = new TrackPath(g);
    let head: number;
    if (place.kind === 'gateway') {
      // Runs out of the map edge: the train starts behind the end of the track.
      for (const s of route.states) path.append(s);
      head = 4;
    } else {
      // Walk back far enough to hold the whole train.
      const behind: number[] = [];
      let room = local;
      let at = first;
      while (room < len / 2 + 6 && g.prev[at].length) {
        at = g.prev[at][0];
        behind.push(at);
        room += g.pieces[at >> 1].length;
      }
      for (let i = behind.length - 1; i >= 0; i--) path.append(behind[i]);
      for (const s of route.states) path.append(s);
      const center = path.start[behind.length] + local;
      head = Math.max(center + len / 2, len + BUFFER_GAP);
    }

    const t: Train = {
      id: this.nextId,
      lineId: plan.line.id,
      consist,
      slot: 0,
      path,
      entries: [],
      crossings: [],
      head,
      v: 0,
      a: 0,
      reversed: false,
      state: 'dwell',
      timer: place.kind === 'gateway' ? 0 : consist.type.dwell * 0.6,
      seq: (seq + 1) % plan.cycle.length,
      stops: [],
      stopIndex: 0,
      authority: head,
      runEnd: head,
      exits: false,
      reservedFrom: 0,
      reservedTo: 0,
      held: new Map(),
      blockedBy: -1,
      stuck: 0,
      passengers: consist.type.passengers ? Math.round(consist.seats * 0.15) : 0,
      carried: 0,
      departed: this.time_,
      born: this.time_,
      dirty: true,
      lost: false,
      doorSides: 3,
    };
    this.buildEntries(t);
    // The whole body must land on free track.
    for (let i = t.reservedFrom; i <= t.reservedTo; i++) {
      if (t.entries.length && this.holders[t.entries[i].block] > 0) return null;
    }
    this.holdRange(t, t.reservedFrom, t.reservedTo);
    this.nextId++;
    this.trains.push(t);
    this.repack();
    this.startRun(t);
    this.placeCars(t);
    const v = this.view;
    for (let i = t.slot; i < t.slot + t.consist.count; i++) {
      v.prevX[i] = v.x[i];
      v.prevY[i] = v.y[i];
      v.prevZ[i] = v.z[i];
      v.prevYaw[i] = v.yaw[i];
    }
    return t;
  }

  /** Give every train its run of slots, in train order. */
  private repack(): void {
    let total = 0;
    for (const t of this.trains) total += t.consist.count;
    const v = this.view;
    v.ensure(total);
    let slot = 0;
    for (const t of this.trains) {
      if (t.slot !== slot || t.dirty) {
        t.dirty = true;
        t.slot = slot;
      }
      const c = t.consist;
      const lineIndex = t.lineId;
      for (let i = 0; i < c.count; i++) {
        const k = slot + i;
        v.train[k] = t.id;
        v.kind[k] = c.kinds[i];
        v.tint[k] = c.tint[i];
        v.line[k] = lineIndex;
      }
      slot += c.count;
    }
    v.count = total;
    for (const t of this.trains) if (t.dirty) this.placeCars(t);
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  /** Plan from where the train is, to its next stop and on as far as it can go. */
  private startRun(t: Train): void {
    const plan = this.plans.get(t.lineId);
    if (!plan?.ok) {
      this.removeLater(t);
      return;
    }
    const g = this.graph;
    const rules = plan.rules;
    const type = t.consist.type;
    const len = t.consist.length;
    const pieceTargets = (id: Id) => new Set(g.stations.get(id)?.stops.map((s) => s.piece) ?? []);
    const headIndex = t.path.locate(Math.min(t.head, t.path.length - 1e-3));
    let cur = t.path.states[headIndex];

    const firstStop = plan.cycle[t.seq];
    let first = findRoute(g, [cur], pieceTargets(firstStop), rules);
    if (t.v < 0.05 && (t.state !== 'run' || !first)) {
      const tailIndex = t.path.locate(Math.max(t.head - len, 0));
      const back = findRoute(g, [opposite(t.path.states[tailIndex])], pieceTargets(firstStop), rules);
      if (back && (!first || back.cost + type.changeEnds < first.cost)) {
        this.changeEnds(t);
        cur = back.states[0];
        first = back;
      }
    }
    if (!first) {
      t.lost = true;
      t.stops = [];
      t.authority = t.head;
      t.runEnd = t.head;
      return;
    }
    t.lost = false;

    // Keep what the train stands on, drop the rest, and lay the new run after it.
    const keep = t.path.locate(Math.min(t.head, t.path.length - 1e-3));
    const tailIdx = t.path.locate(Math.max(t.head - len, 0));
    const rebased = new TrackPath(g);
    for (let i = tailIdx; i <= keep; i++) rebased.append(t.path.states[i]);
    const shift = t.path.start[tailIdx];
    t.head -= shift;

    const stops: PlannedStop[] = [];
    let route: Route | null = first;
    let seq = t.seq;
    let exits = false;
    let runEnd = 0;
    const lastStop = plan.cycle.length;
    for (let hop = 0; hop < lastStop; hop++) {
      for (let i = 1; i < route.states.length; i++) rebased.append(route.states[i]);
      const stationId = plan.cycle[seq];
      const place = g.stations.get(stationId)!;
      const end = route.states[route.states.length - 1];
      if (place.kind === 'gateway') {
        // Run out past the end of the track.
        let tailEnd = end;
        while (g.next[tailEnd].length) {
          tailEnd = g.next[tailEnd][0];
          rebased.append(tailEnd);
        }
        exits = true;
        stops.push({ station: stationId, s: rebased.length, sched: route.cost });
        break;
      }
      const stop = place.stops.find((s) => s.piece === end >> 1)!;
      const piece = g.pieces[stop.piece];
      const index = rebased.states.length - 1;
      const local = (end & 1) === 0 ? stop.s : piece.length - stop.s;
      const center = rebased.start[index] + local;
      stops.push({ station: stationId, s: center + len / 2, sched: route.cost });
      if (hop + 1 === lastStop) break;
      const nextSeq = (seq + 1) % plan.cycle.length;
      const on = findRoute(g, [end], pieceTargets(plan.cycle[nextSeq]), rules);
      const back = findRoute(g, [opposite(end)], pieceTargets(plan.cycle[nextSeq]), rules);
      if (!on || (back && back.cost + type.changeEnds < on.cost)) break;
      route = on;
      seq = nextSeq;
    }

    // Make room past the last stop for the half of the train beyond its centre.
    if (!exits) {
      const last = stops[stops.length - 1];
      let state = rebased.states[rebased.states.length - 1];
      while (rebased.length < last.s + BUFFER_GAP && g.next[state].length) {
        state = g.next[state][0];
        rebased.append(state);
      }
      last.s = Math.min(last.s, rebased.length - BUFFER_GAP);
      // Plan from the stop's own track, so drop whatever lies past it.
      while (rebased.states.length > 1 && rebased.start[rebased.states.length - 1] >= last.s + 1) {
        const dropped = rebased.states.pop()!;
        rebased.start.pop();
        rebased.length -= g.pieces[dropped >> 1].length;
      }
      runEnd = last.s;
    } else {
      runEnd = rebased.length + len + 50;
    }

    t.path = rebased;
    t.stops = stops;
    t.stopIndex = 0;
    t.exits = exits;
    t.runEnd = runEnd;
    while (t.stopIndex < stops.length && stops[t.stopIndex].s < t.head - 1) t.stopIndex++;
    this.releaseAll(t);
    this.buildEntries(t);
    this.holdRange(t, t.reservedFrom, t.reservedTo);
    t.authority = this.authorityOf(t);
    t.dirty = true;
  }

  /** Swap the ends of the train: what was the tail now leads. */
  private changeEnds(t: Train): void {
    const g = this.graph;
    const len = t.consist.length;
    const path = t.path;
    const headIdx = path.locate(Math.min(t.head, path.length - 1e-3));
    const tailIdx = path.locate(Math.max(t.head - len, 0));
    const flipped = new TrackPath(g);
    for (let i = headIdx; i >= tailIdx; i--) flipped.append(opposite(path.states[i]));
    const headEnd = path.start[headIdx] + g.pieces[path.states[headIdx] >> 1].length;
    const newTail = headEnd - t.head;
    t.path = flipped;
    t.head = newTail + len;
    t.reversed = !t.reversed;
    this.releaseAll(t);
    this.buildEntries(t);
    this.holdRange(t, t.reservedFrom, t.reservedTo);
    if (this.trains.includes(t)) this.placeCars(t);
    else t.dirty = true;
  }

  private buildEntries(t: Train): void {
    const g = this.graph;
    const { path } = t;
    const entries: Entry[] = [];
    const crossings: Train['crossings'] = [];
    for (let i = 0; i < path.states.length; i++) {
      const p = g.pieces[path.states[i] >> 1];
      const start = path.start[i];
      const end = start + p.length;
      const last = entries[entries.length - 1];
      if (last && last.block === p.block) last.end = end;
      else entries.push({ block: p.block, start, end });
      const crossing = g.blocks[p.block].crossing;
      if (crossing >= 0) crossings.push({ index: crossing, start, end });
    }
    t.entries = entries;
    t.crossings = crossings;
    const tail = t.head - t.consist.length;
    let from = 0;
    while (from < entries.length - 1 && entries[from].end <= tail) from++;
    let to = from;
    while (to < entries.length - 1 && entries[to].end < t.head) to++;
    t.reservedFrom = from;
    t.reservedTo = to;
  }

  private hold(t: Train, block: number): void {
    const c = t.held.get(block) ?? 0;
    if (c === 0) {
      this.holders[block]++;
      this.owner[block] = t.id;
    }
    t.held.set(block, c + 1);
  }

  private release(t: Train, block: number): void {
    const c = t.held.get(block);
    if (c === undefined) return;
    if (c <= 1) {
      t.held.delete(block);
      this.holders[block]--;
      if (this.holders[block] > 0 && this.owner[block] === t.id) {
        for (const other of this.trains) {
          if (other.held.has(block)) {
            this.owner[block] = other.id;
            break;
          }
        }
      }
    } else {
      t.held.set(block, c - 1);
    }
  }

  private holdRange(t: Train, from: number, to: number): void {
    if (!t.entries.length) return;
    for (let i = from; i <= to; i++) this.hold(t, t.entries[i].block);
  }

  private releaseAll(t: Train): void {
    for (const b of t.held.keys()) {
      this.holders[b]--;
      if (this.holders[b] > 0 && this.owner[b] === t.id) {
        for (const other of this.trains) {
          if (other !== t && other.held.has(b)) {
            this.owner[b] = other.id;
            break;
          }
        }
      }
    }
    t.held.clear();
  }

  private isFree(t: Train, block: number): boolean {
    const h = this.holders[block];
    return h === 0 || (h === 1 && t.held.has(block));
  }

  private isRefuge(block: number): boolean {
    return this.graph.blocks[block].plain && this.use[block] !== 3;
  }

  private authorityOf(t: Train): number {
    const es = t.entries;
    if (!es.length) return t.head;
    if (t.reservedTo >= es.length - 1) return t.runEnd;
    return es[t.reservedTo].end - SIGNAL_MARGIN;
  }

  /** Ask for more track. All of a stretch is taken at once, or none of it. */
  private extend(t: Train): void {
    if (t.lost) return;
    if (t.state !== 'run' && t.timer > 8) return;
    const es = t.entries;
    const last = es.length - 1;
    if (last < 0 || t.reservedTo >= last) {
      t.blockedBy = -1;
      t.authority = this.authorityOf(t);
      return;
    }
    const b = this.planBrake(t);
    const need = Math.min(t.head + (t.v * t.v) / (2 * b) + t.v * 6 + LOOKAHEAD, es[last].end);
    if (es[t.reservedTo].end - SIGNAL_MARGIN >= need) {
      t.blockedBy = -1;
      return;
    }
    // How much plain track the train already stands on, for stopping clear behind it.
    let run = 0;
    for (let j = t.reservedTo; j >= 0 && this.isRefuge(es[j].block); j--) run += es[j].end - es[j].start;
    let commit = -1;
    let bothWays = false;
    let blocker = -1;
    const needRun = t.consist.length + SIGNAL_MARGIN + 10;
    for (let k = t.reservedTo + 1; k <= last; k++) {
      const block = es[k].block;
      if (!this.isFree(t, block)) {
        blocker = this.owner[block];
        break;
      }
      if (this.use[block] === 3) bothWays = true;
      const refuge = this.isRefuge(block);
      if (refuge) run += es[k].end - es[k].start;
      else run = 0;
      if (k === last || (refuge && (!bothWays || run >= needRun))) {
        commit = k;
        if (es[k].end - SIGNAL_MARGIN >= need) break;
      }
    }
    if (commit >= 0) {
      this.holdRange(t, t.reservedTo + 1, commit);
      t.reservedTo = commit;
      t.authority = this.authorityOf(t);
    }
    t.blockedBy = commit < 0 || t.reservedTo < last ? blocker : -1;
  }

  private releaseBehind(t: Train): void {
    const tail = t.head - t.consist.length - 1;
    const es = t.entries;
    while (t.reservedFrom < t.reservedTo && es[t.reservedFrom].end < tail) {
      this.release(t, es[t.reservedFrom].block);
      t.reservedFrom++;
    }
    if (t.reservedTo >= es.length - 1 && t.exits && es.length && es[t.reservedFrom].end < tail) {
      this.release(t, es[t.reservedFrom].block);
    }
  }

  // -------------------------------------------------------------------------
  // Driving
  // -------------------------------------------------------------------------

  private trainGrade(t: Train): number {
    const c = t.consist;
    const h = t.path.sample(Math.min(t.head, t.path.length), a1);
    t.path.sample(Math.max(t.head - c.length, 0), a2, h);
    const run = Math.hypot(a1.x - a2.x, a1.z - a2.z);
    return run > 1 ? (a1.y - a2.y) / run : 0;
  }

  /** Deceleration the driver plans on, allowing for the grade. */
  private planBrake(t: Train): number {
    const b = t.consist.type.brake;
    return Math.max(b * 0.3, b * 0.85 + G * this.trainGrade(t));
  }

  /** Top speed allowed here and now, by the braking curves for what lies ahead. */
  private speedTarget(t: Train, b: number): number {
    const g = this.graph;
    const { path, consist } = t;
    let limit = consist.type.maxKmh / 3.6;
    const tail = t.head - consist.length;
    const horizon = t.head + (t.v * t.v) / (2 * b) + 40;
    let i = path.locate(Math.max(tail, 0));
    for (; i < path.states.length; i++) {
      const start = path.start[i];
      if (start > horizon) break;
      const speed = g.pieces[path.states[i] >> 1].speed;
      const d = Math.max(0, start - t.head);
      const allowed = Math.sqrt(speed * speed + 2 * b * d);
      if (allowed < limit) limit = allowed;
    }
    return limit;
  }

  private drive(t: Train): void {
    const { consist } = t;
    const type = consist.type;
    if (t.state !== 'run' || t.lost) {
      if (t.v > 0) this.brakeToStop(t);
      return;
    }
    const grade = this.trainGrade(t);
    const b = Math.max(type.brake * 0.3, type.brake * 0.85 + G * grade);
    let target = this.speedTarget(t, b);

    // Stop for the next stop or the end of authority, whichever is nearer.
    let stopAt = t.authority;
    if (t.stopIndex < t.stops.length && !(t.exits && t.stopIndex === t.stops.length - 1)) {
      stopAt = Math.min(stopAt, t.stops[t.stopIndex].s);
    }
    const reaction = (t.v * b) / (2 * type.jerk) + t.v * 0.3;
    const room = stopAt - t.head;
    const brakeRoom = Math.max(0, room - reaction);
    const curve = Math.sqrt(2 * b * brakeRoom);
    if (curve < target) target = curve;
    if (room > 0.3 && target < 0.6) target = Math.min(0.6, Math.sqrt(2 * b * room));

    // A heavy train on the ruling grade crawls up it on sand and notch eight.
    let limit = acceleration(consist, t.v, grade);
    if (limit < 0.03 && t.v < 2) limit = 0.03;
    let want: number;
    if (t.v > target) {
      want = Math.max(-Math.max(type.brake * 0.4, type.brake + G * Math.min(grade, 0)), (target - t.v) / 0.7);
      if (t.v > target + 1.5) want = Math.min(want, -b);
    } else {
      want = Math.min(limit, (target - t.v) / 1.5);
    }
    if (room < -0.1) want = -type.emergency;
    const j = type.jerk * RAIL_DT;
    t.a += Math.max(-j, Math.min(j, want - t.a));
    if (want < -b * 1.2) t.a = Math.min(t.a, want);
    // Gravity and rolling drag still act when coasting.
    let a = t.a;
    if (a > limit) a = limit;
    t.v = Math.max(0, t.v + a * RAIL_DT);
    if (t.v < 0.02 && want <= 0) {
      t.v = 0;
      t.a = 0;
    }
    t.head += t.v * RAIL_DT;
  }

  private brakeToStop(t: Train): void {
    const b = t.consist.type.emergency;
    t.v = Math.max(0, t.v - b * RAIL_DT);
    t.a = -b;
    t.head += t.v * RAIL_DT;
  }

  /** State changes: arrivals, dwell, leaving the map. */
  private progress(t: Train): void {
    if (t.lost) {
      if (t.v === 0) {
        this.startRun(t);
        if (t.lost) {
          this.removedByEdit++;
          this.removeLater(t);
        }
      }
      return;
    }
    if (t.state === 'run') {
      if (t.exits) {
        if (t.head - t.consist.length > t.path.length) this.finishExit(t);
        if (t.stopIndex >= t.stops.length - 1) return;
      }
      const stop = t.stops[t.stopIndex];
      if (stop && t.v < 0.05 && stop.s - t.head < 2.5) this.arrive(t);
      return;
    }
    t.timer -= RAIL_DT;
    if (t.timer > 3 && t.state === 'dwell') return;
    this.writeFlags(t);
    if (t.timer > 0) return;
    if (t.state === 'dwell' && t.stopIndex >= t.stops.length) {
      const before = t.reversed;
      this.startRun(t);
      if (t.lost) return;
      if (t.reversed !== before) {
        t.state = 'turn';
        t.timer = t.consist.type.changeEnds;
        return;
      }
    }
    t.state = 'run';
    t.departed = this.time_;
    this.extend(t);
  }

  /** Which side of the train the platform is on, from the stop under its middle. */
  private platformSidesAt(t: Train, stationId: Id): number {
    const place = this.graph.stations.get(stationId);
    if (!place) return 3;
    const mid = t.head - t.consist.length / 2;
    const state = t.path.states[t.path.locate(Math.max(0, Math.min(mid, t.path.length - 1e-3)))];
    const stop = place.stops.find((x) => x.piece === state >> 1) ?? place.stops[0];
    if (!stop) return 3;
    // Run pieces go a to b, so running forward keeps the segment's left and right.
    if ((state & 1) === 0) return stop.sides;
    return ((stop.sides & 1) << 1) | ((stop.sides & 2) >> 1);
  }

  private arrive(t: Train): void {
    const stop = t.stops[t.stopIndex];
    t.doorSides = this.platformSidesAt(t, stop.station);
    const plan = this.plans.get(t.lineId);
    const c = this.counter(t.lineId);
    const late = this.time_ - t.departed - stop.sched * 1.15 - 25;
    c.arrivals++;
    if (late <= ON_TIME_SEC) c.onTime++;
    const type = t.consist.type;
    if (type.passengers) {
      const seats = t.consist.seats;
      const off = Math.round(t.passengers * this.rng.range(0.2, 0.5));
      const room = seats - (t.passengers - off);
      const on = Math.min(room, Math.round(seats * this.rng.range(0.05, 0.25)));
      t.passengers += on - off;
      t.carried += on;
      c.carried += on;
    }
    t.stopIndex++;
    t.seq = plan ? (t.seq + 1) % plan.cycle.length : 0;
    t.state = 'dwell';
    t.timer = type.dwell;
    t.v = 0;
    t.a = 0;
    if (t.stopIndex >= t.stops.length) t.timer += 2;
    this.writeFlags(t);
    // One train too many on this line leaves at the end of its trip.
    if (plan) {
      let running = 0;
      for (const x of this.trains) if (x.lineId === t.lineId) running++;
      if (running > plan.line.trains) this.removeLater(t);
    }
  }

  private finishExit(t: Train): void {
    const plan = this.plans.get(t.lineId);
    const c = this.counter(t.lineId);
    c.arrivals++;
    const stop = t.stops[t.stops.length - 1];
    if (plan && stop && this.time_ - t.departed - stop.sched * 1.3 - 40 <= ON_TIME_SEC) c.onTime++;
    this.removeLater(t);
  }

  private removals: Train[] = [];

  private removeLater(t: Train): void {
    if (!this.removals.includes(t)) this.removals.push(t);
  }

  private flushRemovals(): void {
    if (!this.removals.length) return;
    for (const t of this.removals) this.releaseAll(t);
    const gone = new Set(this.removals);
    this.trains = this.trains.filter((t) => !gone.has(t));
    this.removals = [];
    this.repack();
  }

  private writeFlags(t: Train): void {
    const v = this.view;
    const open = t.state === 'dwell' && t.timer > 3;
    const c = t.consist;
    for (let k = 0; k < c.count; k++) {
      const i = t.slot + k;
      let bits = 0;
      if (open) {
        // A car facing against travel has its own left on the travel right.
        const along = (c.flip[k] === 1) === t.reversed;
        const left = along ? t.doorSides & 1 : t.doorSides & 2;
        const right = along ? t.doorSides & 2 : t.doorSides & 1;
        bits = (left ? FLAG_DOORS : 0) | (right ? FLAG_DOORS_R : 0);
      }
      v.flags[i] = (v.flags[i] & ~DOOR_BITS) | bits;
    }
  }

  private placeCars(t: Train): void {
    t.dirty = false;
    const c = t.consist;
    const v = this.view;
    const { path } = t;
    const front = t.reversed ? t.head - c.length : t.head;
    const sign = t.reversed ? 1 : -1;
    const hiddenBefore = 0;
    const hiddenAfter = path.length;
    const braking = t.a < -0.15;
    let hint = 0;
    for (let i = 0; i < c.count; i++) {
      const slot = t.slot + i;
      const kind = CAR_KINDS[c.kinds[i]];
      const inset = (kind.length - kind.bogieSpacing) / 2;
      const s1 = front + sign * (c.front[i] + inset);
      const s2 = s1 + sign * kind.bogieSpacing;
      hint = path.sample(s1, a0, hint);
      hint = path.sample(s2, a1, hint);
      const fx = a0.x - a1.x;
      const fy = a0.y - a1.y;
      const fz = a0.z - a1.z;
      const run = Math.hypot(fx, fz) || 1;
      const flip = c.flip[i] === 1;
      v.x[slot] = (a0.x + a1.x) / 2;
      v.y[slot] = (a0.y + a1.y) / 2;
      v.z[slot] = (a0.z + a1.z) / 2;
      const yaw = Math.atan2(-fx, -fz);
      v.yaw[slot] = flip ? yaw + Math.PI : yaw;
      const pitch = Math.atan2(fy, run);
      v.pitch[slot] = flip ? -pitch : pitch;
      v.speed[slot] = t.v;
      const hidden = t.exits || t.head - c.length < 0 ? s1 < hiddenBefore || s2 < hiddenBefore || s1 > hiddenAfter || s2 > hiddenAfter : false;
      let flags = v.flags[slot] & DOOR_BITS;
      if (hidden) flags |= FLAG_HIDDEN;
      if (braking) flags |= FLAG_BRAKING;
      v.flags[slot] = flags;
      // Each bogie turns with the rails under it.
      const b = slot * 8;
      hint = this.placeBogie(path, s1, b, hint);
      hint = this.placeBogie(path, s2, b + 4, hint);
      let lamp = 0;
      const outward = i === 0 ? !flip : i === c.count - 1 ? flip : false;
      if (outward) {
        const leading = (i === 0) !== t.reversed;
        lamp = leading ? 1 : 2;
      } else if (i === c.count - 1 && !t.reversed) {
        lamp = 2;
      }
      v.lamp[slot] = lamp;
    }
  }

  private placeBogie(path: TrackPath, s: number, base: number, hint: number): number {
    const v = this.view;
    const h = path.sample(s + 1.3, a2, hint);
    const px = a2.x;
    const py = a2.y;
    const pz = a2.z;
    path.sample(s - 1.3, a2, h);
    const fx = px - a2.x;
    const fz = pz - a2.z;
    v.bogie[base] = (px + a2.x) / 2;
    v.bogie[base + 1] = (py + a2.y) / 2;
    v.bogie[base + 2] = (pz + a2.z) / 2;
    v.bogie[base + 3] = Math.atan2(-fx, -fz);
    return h;
  }

  // -------------------------------------------------------------------------
  // Crossings
  // -------------------------------------------------------------------------

  private updateCrossings(dt: number): void {
    const g = this.graph;
    const n = g.crossings.length;
    if (!n) return;
    const closing = new Uint8Array(n);
    for (const t of this.trains) {
      const tail = t.head - t.consist.length;
      const lead = Math.max(CROSSING_MIN_LEAD, t.v * CROSSING_LEAD_SEC);
      for (const c of t.crossings) {
        if (tail > c.end + 6) continue;
        if (c.start > t.head + lead) continue;
        // A train standing at a signal short of the crossing lets the road go.
        if (c.start > t.authority + SIGNAL_MARGIN) continue;
        if (t.state !== 'run' && c.start > t.head) continue;
        closing[c.index] = 1;
      }
    }
    const graph = this.net.laneGraph;
    for (let i = 0; i < n; i++) {
      const view = this.crossings[i];
      const closed = closing[i] === 1;
      view.gate = Math.max(0, Math.min(1, view.gate + ((closed ? 1 : -1) * dt) / GATE_SEC));
      if (closed === view.closed) continue;
      view.closed = closed;
      const lanes = g.crossings[i].roadLanes;
      this.onCrossing?.(lanes, closed);
      for (const l of lanes) {
        const key = graph.lanes[l].key;
        if (closed) this.closedLanes.add(key);
        else this.closedLanes.delete(key);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rings of waiting trains
  // -------------------------------------------------------------------------

  private breakRings(dt: number): void {
    const byId = new Map(this.trains.map((t) => [t.id, t]));
    const ringed = new Set<Train>();
    for (const start of this.trains) {
      if (start.blockedBy < 0 || start.v > 0 || start.state !== 'run') continue;
      let at: Train | undefined = start;
      const seen = new Set<Train>();
      while (at && !seen.has(at)) {
        seen.add(at);
        at = byId.get(at.blockedBy);
        if (at && (at.state !== 'run' || at.v > 0)) at = undefined;
      }
      if (at === start) for (const t of seen) ringed.add(t);
    }
    let worst: Train | null = null;
    for (const t of this.trains) {
      if (ringed.has(t)) {
        t.stuck += dt;
        if (!worst || t.born > worst.born) worst = t;
      } else {
        t.stuck = 0;
      }
    }
    if (!worst) return;
    let oldest = 0;
    for (const t of ringed) oldest = Math.max(oldest, t.stuck);
    if (oldest < RING_LIMIT_SEC) return;
    const c = this.counter(worst.lineId);
    let running = 0;
    for (const t of this.trains) if (t.lineId === worst.lineId) running++;
    c.limit = Math.max(1, running - 1);
    c.held++;
    this.withdrawn++;
    this.removeLater(worst);
    this.flushRemovals();
  }

  // -------------------------------------------------------------------------
  // Keeping trains through an edit
  // -------------------------------------------------------------------------

  /** Find the train on the new graph. False when its track went. */
  private remap(t: Train, was: { head: Vec3; back: Vec3; tail: Vec3 }): boolean {
    const g = this.graph;
    const head = g.nearest(was.head, 3);
    const tail = g.nearest(was.tail, 3);
    if (!head || !tail) return false;
    const stateAt = (hit: { piece: number; s: number }): number => {
      const p = g.pieces[hit.piece];
      const q0 = pieceAt(p, Math.max(0, hit.s - 2));
      const q1 = pieceAt(p, Math.min(p.length, hit.s + 2));
      const dot = (q1.x - q0.x) * (was.head.x - was.back.x) + (q1.z - q0.z) * (was.head.z - was.back.z);
      return p.id * 2 + (dot >= 0 ? 0 : 1);
    };
    const headState = stateAt(head);
    let states = [headState];
    if (tail.piece !== head.piece) {
      const route = findRoute(g, [stateAt(tail)], new Set([head.piece]), null);
      if (!route || route.states[route.states.length - 1] !== headState) return false;
      states = route.states;
    }
    const lengthOf = (list: number[]) => list.reduce((sum, x) => sum + g.pieces[x >> 1].length, 0);
    const hp = g.pieces[headState >> 1];
    const local = (headState & 1) === 0 ? head.s : hp.length - head.s;
    const firstPiece = g.pieces[states[0] >> 1];
    const tailLocal = (states[0] & 1) === 0 ? tail.s : firstPiece.length - tail.s;
    let newHead = lengthOf(states.slice(0, -1)) + local;
    const hiddenTail = t.head - t.consist.length < 0;
    if (!hiddenTail && Math.abs(newHead - tailLocal - t.consist.length) > 30) return false;
    // Room behind for the whole body.
    while (newHead < t.consist.length + 1 && g.prev[states[0]].length) {
      const before = g.prev[states[0]][0];
      states = [before, ...states];
      newHead += g.pieces[before >> 1].length;
    }
    const path = new TrackPath(g);
    for (const x of states) path.append(x);
    t.path = path;
    t.head = newHead;
    t.entries = [];
    t.stops = [];
    t.stopIndex = 0;
    t.blockedBy = -1;
    t.dirty = true;
    this.buildEntries(t);
    this.holdRange(t, t.reservedFrom, t.reservedTo);
    return true;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  stats(): RailStats {
    let cars = 0;
    let onBoard = 0;
    for (const t of this.trains) {
      cars += t.consist.count;
      onBoard += t.passengers;
    }
    let carried = 0;
    let onTime = 0;
    let arrivals = 0;
    for (const c of this.counters.values()) {
      carried += c.carried;
      onTime += c.onTime;
      arrivals += c.arrivals;
    }
    return {
      trains: this.trains.length,
      cars,
      onBoard,
      carried,
      onTimePct: arrivals ? (onTime / arrivals) * 100 : 100,
      lines: this.net.rail.lines.length,
      stations: this.net.rail.stations.length,
      removedByEdit: this.removedByEdit,
      withdrawn: this.withdrawn,
      stepMs: this.stepMs,
    };
  }

  lineInfo(id: Id): LineInfo | null {
    const line = this.net.rail.lines.find((l) => l.id === id);
    if (!line) return null;
    const plan = this.plans.get(id);
    const c = this.counters.get(id);
    let running = 0;
    for (const t of this.trains) if (t.lineId === id) running++;
    let warning = plan?.warning ?? null;
    if (!warning && c?.held) warning = `Over capacity: ${c.held} train${c.held > 1 ? 's' : ''} withdrawn. Add a passing loop.`;
    return {
      id,
      name: line.name,
      color: line.color,
      running,
      wanted: line.trains,
      problem: plan?.problem ?? null,
      warning,
      fixType: plan?.fixType ?? null,
      carried: c?.carried ?? 0,
      onTimePct: c?.arrivals ? (c.onTime / c.arrivals) * 100 : 100,
      cycleSec: plan?.cycleSec ?? 0,
      lengthKm: (plan?.lengthM ?? 0) / 2000,
      trainLength: plan?.trainLength ?? 0,
    };
  }

  /** Why a line cannot run, or a warning, without adding it. */
  checkLine(init: Omit<RailLine, 'id'>): { problem: string | null; warning: string | null; fixType: TrainTypeId | null; trainLength: number } {
    if (this.dirty) this.rebuild();
    const saved = this.use;
    this.use = new Uint8Array(saved.length);
    const plan = this.planLine({ ...init, id: -1 });
    this.use = saved;
    return { problem: plan.problem, warning: plan.warning, fixType: plan.fixType, trainLength: plan.trainLength };
  }

  /** Slots of a train's cars. */
  trainSlots(id: number): { slot: number; count: number } | null {
    const t = this.trains.find((x) => x.id === id);
    return t ? { slot: t.slot, count: t.consist.count } : null;
  }

  /** Middle of a train, for the follow camera. */
  trainCenter(id: number, out: Vec3): boolean {
    const t = this.trains.find((x) => x.id === id);
    if (!t) return false;
    const v = this.view;
    const k = t.slot + (t.consist.count >> 1);
    const al = this.alpha;
    out.x = v.prevX[k] + (v.x[k] - v.prevX[k]) * al;
    out.y = v.prevY[k] + (v.y[k] - v.prevY[k]) * al;
    out.z = v.prevZ[k] + (v.z[k] - v.prevZ[k]) * al;
    return true;
  }

  trainDetail(id: number): TrainDetail | null {
    const t = this.trains.find((x) => x.id === id);
    if (!t) return null;
    const line = this.net.rail.lines.find((l) => l.id === t.lineId);
    const c = t.consist;
    let status: string;
    if (t.state === 'dwell') status = t.timer > 3 ? 'At platform, doors open' : 'Closing doors';
    else if (t.state === 'turn') status = 'Changing ends';
    else if (t.v < 0.05 && t.blockedBy >= 0) status = 'Held at signal';
    else if (t.v < 0.05) status = 'Waiting';
    else if (t.a < -0.15) status = 'Braking';
    else if (t.a > 0.05) status = 'Accelerating';
    else status = 'Running';
    const stop = t.stops[t.stopIndex];
    const route: Vec3[] = [];
    const end = Math.min(t.path.length, t.head + 1500);
    for (let s = Math.max(t.head, 0); s < end; s += 20) {
      t.path.sample(s, a0);
      route.push({ ...a0 });
    }
    return {
      id,
      line: line?.name ?? 'No line',
      color: line?.color ?? '#ffffff',
      type: c.type.name,
      cars: c.count,
      lengthM: c.length,
      massT: c.mass / 1000,
      speedKmh: t.v * 3.6,
      maxKmh: c.type.maxKmh,
      status,
      next: stop ? this.stationName(stop.station) : '',
      passengers: t.passengers,
      seats: c.seats,
      gradePct: this.trainGrade(t) * 100,
      route,
    };
  }

  /** Where each line runs, as piece ids, for the overlay. */
  linePieces(id: Id): number[] {
    const plan = this.plans.get(id);
    if (!plan?.ok) return [];
    const out = new Set<number>();
    const g = this.graph;
    const cycle = plan.cycle;
    let state = -1;
    for (let i = 0; i < cycle.length; i++) {
      const targets = new Set(g.stations.get(cycle[(i + 1) % cycle.length])!.stops.map((s) => s.piece));
      const starts = state < 0 ? g.stations.get(cycle[i])!.stops.flatMap((s) => [s.piece * 2, s.piece * 2 + 1]) : null;
      const route = starts ? findRoute(g, starts, targets, plan.rules) : this.bestLeg(state, targets, plan.rules, plan.line.trainType === 'freight' ? 240 : 60);
      if (!route) break;
      for (const s of route.states) out.add(s >> 1);
      state = route.states[route.states.length - 1];
    }
    return [...out];
  }
}

function pieceAt(p: { pts: Float32Array; cum: Float32Array; length: number }, s: number): Vec3 {
  const hit = Math.max(0, Math.min(p.length, s));
  const { cum, pts } = p;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (cum[m] <= hit) lo = m;
    else hi = m;
  }
  const span = cum[hi] - cum[lo];
  const f = span > 1e-6 ? (hit - cum[lo]) / span : 0;
  return {
    x: pts[lo * 3] + (pts[hi * 3] - pts[lo * 3]) * f,
    y: pts[lo * 3 + 1] + (pts[hi * 3 + 1] - pts[lo * 3 + 1]) * f,
    z: pts[lo * 3 + 2] + (pts[hi * 3 + 2] - pts[lo * 3 + 2]) * f,
  };
}

export type { RailStation, TrainTypeId };
