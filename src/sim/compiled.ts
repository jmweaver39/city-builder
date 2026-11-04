/**
 * The lane graph flattened into typed arrays for the hot path, plus derived data
 * the core does not keep: a speed profile along each lane and merge groupings.
 * Rebuilt on every graph version. Immutable after that.
 */
import type { GLane, Id, LaneGraph, RoadNetwork, TurnKind } from '../core';
import { sweepConflicts, type SweepCache, type SweepHit, type SweptStop } from './sweep';
import { sharedStretches } from './proximity';
import {
  CONNECTOR_CHORD,
  CONNECTOR_LATERAL_ACCEL,
  CURVE_LATERAL_ACCEL,
  MIN_CURVE_SPEED,
  PLAN_DECEL,
  PROFILE_STEP,
  ROAD_CHORD,
} from './constants';

/** Point at distance `d` back from the end of a lane, into out. */
function backFromEnd(l: GLane, d: number, out: { x: number; z: number }): void {
  const s = Math.max(0, l.length - d);
  const { cum, pts } = l;
  let i = cum.length - 2;
  while (i > 0 && cum[i] > s) i--;
  const span = cum[i + 1] - cum[i];
  const f = span > 0 ? Math.min(1, Math.max(0, (s - cum[i]) / span)) : 0;
  out.x = pts[i * 3] + (pts[i * 3 + 3] - pts[i * 3]) * f;
  out.z = pts[i * 3 + 2] + (pts[i * 3 + 5] - pts[i * 3 + 2]) * f;
}

/** How far back from their shared end two lanes stay within `gap` of each other. */
function closeFromEnd(a: GLane, b: GLane, gap: number): number {
  const limit = Math.min(a.length, b.length, 300);
  const pa = { x: 0, z: 0 };
  const pb = { x: 0, z: 0 };
  for (let d = 1; d <= limit; d += 1) {
    backFromEnd(a, d, pa);
    backFromEnd(b, d, pb);
    if (Math.hypot(pa.x - pb.x, pa.z - pb.z) >= gap) return d;
  }
  return limit;
}

export const KIND_CROSS = 0;
export const KIND_MERGE = 1;
export const KIND_DIVERGE = 2;
/** A long body on this path swings over the other though the centrelines never meet. See sweep.ts. */
export const KIND_SWEEP = 3;
/** Bodies of any size touch here though the centrelines do not cross. */
export const KIND_NEAR = 4;
/** Two long bodies, one on each path, touch here. */
export const KIND_SWEEP_PAIR = 5;
/** A long body on the other path swings over this one. */
export const KIND_SWEEP_THEIRS = 6;

/** Is this one of the swept-path kinds, which are about bodies, not right of way? */
export function isSweep(kind: number): boolean {
  return kind === KIND_SWEEP || kind === KIND_SWEEP_THEIRS || kind === KIND_SWEEP_PAIR;
}

/**
 * Does a conflict of this kind matter between a body of length `mine` on this path and
 * one of length `theirs` on the other? A swept path matters only to the body that
 * sweeps it; every other kind always matters.
 */
export function sweepApplies(kind: number, mine: number, theirs: number, long: number): boolean {
  if (kind === KIND_SWEEP) return mine >= long;
  if (kind === KIND_SWEEP_THEIRS) return theirs >= long;
  if (kind === KIND_SWEEP_PAIR) return mine >= long && theirs >= long;
  return true;
}

export const ALLOW_CAR = 1;
export const ALLOW_BUS = 2;
export const ALLOW_BIKE = 4;
export const ALLOW_VAN = 8;
export const ALLOW_TRUCK = 16;
/** Every class a general traffic lane takes. */
export const ALLOW_MOTOR = ALLOW_CAR | ALLOW_VAN | ALLOW_TRUCK | ALLOW_BUS;

/** Allow bit of each vehicle class, indexed like VEHICLE_TYPES. */
export const TYPE_BITS: readonly number[] = [ALLOW_CAR, ALLOW_VAN, ALLOW_TRUCK, ALLOW_BUS, ALLOW_BIKE];

const CLASS_BITS: Record<string, number> = { car: ALLOW_CAR, van: ALLOW_VAN, truck: ALLOW_TRUCK, bus: ALLOW_BUS, bike: ALLOW_BIKE };

/** Bits of the classes a lane is closed to (SegmentOverrides.laneBans). */
function banBits(list: readonly string[] | undefined): number {
  let bits = 0;
  for (const c of list ?? []) bits |= CLASS_BITS[c] ?? 0;
  return bits;
}

/** Who may use a lane of this kind. Anything else, such as rail, is closed to road traffic. */
function allowOf(kind: string): number {
  if (kind === 'drive') return ALLOW_MOTOR;
  if (kind === 'bus') return ALLOW_BUS;
  if (kind === 'bike') return ALLOW_BIKE;
  return 0;
}

export const TURN_STRAIGHT = 0;
export const TURN_RIGHT = 1;
export const TURN_LEFT = 2;
export const TURN_UTURN = 3;

function turnCode(t: TurnKind | null): number {
  if (t === 'left') return TURN_LEFT;
  if (t === 'right') return TURN_RIGHT;
  if (t === 'uturn') return TURN_UTURN;
  return TURN_STRAIGHT;
}

export interface CompiledGraph {
  graph: LaneGraph;
  version: number;
  n: number;
  len: Float64Array;
  speed: Float64Array;
  /** 1 for connectors. */
  isConn: Uint8Array;
  allow: Uint8Array;
  left: Int32Array;
  right: Int32Array;
  fromLane: Int32Array;
  toLane: Int32Array;
  nodeId: Int32Array;
  /** Dense segment index, -1 for connectors. */
  segIdx: Int32Array;
  turn: Uint8Array;
  /** Compressed next and prev lists. */
  nextStart: Int32Array;
  nextList: Int32Array;
  prevStart: Int32Array;
  prevList: Int32Array;
  /** Conflicts of each connector. */
  confStart: Int32Array;
  confLane: Int32Array;
  confSelf: Float64Array;
  confOther: Float64Array;
  confKind: Uint8Array;
  /** 1 when the core found a crossing on this connector, as opposed to a body conflict. */
  coreCross: Uint8Array;
  /** Heading change through a connector, radians, 0 for road lanes. */
  turnAngle: Float64Array;
  /** Furthest crossing or near-miss point along a connector, -1 when it has none. */
  lastCross: Float64Array;
  /** How far before the end of a lane to wait, clear of long bodies turning past. */
  setback: Float64Array;
  /** Per connector: road lanes of other arms whose last `sweptDepth` metres its long body swings over. */
  sweptStart: Int32Array;
  sweptLane: Int32Array;
  sweptDepth: Float64Array;
  /** Where a connector first comes within a lane of another bound for the same exit. */
  mergeFrom: Float64Array;
  /** Geometry, flattened. */
  ptStart: Int32Array;
  pts: Float32Array;
  cum: Float32Array;
  /** Allowed speed by distance along the lane, already braked for bends further along it. */
  profStart: Int32Array;
  prof: Float32Array;
  /** Road lanes running too close to another for two bodies side by side. See proximity.ts. */
  shareStart: Int32Array;
  shareLane: Int32Array;
  shareFrom: Float64Array;
  shareTo: Float64Array;
  shareOffset: Float64Array;
  shareGap: Float64Array;
  /** Road lanes fed by two or more connectors. */
  mergeLanes: Int32Array;
  segCount: number;
  segIds: Id[];
  segIndex: Map<Id, number>;
}

const NO_HITS: SweepHit[] = [];

function sampleXZ(pts: Float32Array, cum: Float32Array, s: number, out: { x: number; z: number; i: number }): void {
  const last = cum.length - 2;
  let i = out.i;
  while (i < last && cum[i + 1] < s) i++;
  const span = cum[i + 1] - cum[i];
  const f = span > 0 ? Math.min(1, Math.max(0, (s - cum[i]) / span)) : 0;
  out.x = pts[i * 3] + (pts[i * 3 + 3] - pts[i * 3]) * f;
  out.z = pts[i * 3 + 2] + (pts[i * 3 + 5] - pts[i * 3 + 2]) * f;
  out.i = i;
}

/**
 * Bend speed limits along a road lane. The polyline's turning at each station is
 * spread over the half segments either side of it, so the cumulative turn grows
 * linearly along an arc and a constant radius reads as constant whatever the
 * station spacing or where samples fall. Windows are kept inside the lane and the
 * turn is extrapolated over its first and last half segment, so the ends of a lane
 * see the bend too: a curve cut into several segments (core/curveChain.ts) then
 * reads the same through every joint instead of as straight at each one.
 */
function roadBends(
  pts: Float32Array,
  cum: Float32Array,
  length: number,
  count: number,
  chord: number,
  lateral: number,
  out: number[],
  base: number,
): void {
  const np = cum.length;
  if (np < 3) return;
  const mids = new Float64Array(np - 1);
  const turns = new Float64Array(np - 1);
  let total = 0;
  for (let j = 0; j + 1 < np; j++) {
    if (j > 0) {
      const ux = pts[j * 3] - pts[j * 3 - 3];
      const uz = pts[j * 3 + 2] - pts[j * 3 - 1];
      const wx = pts[j * 3 + 3] - pts[j * 3];
      const wz = pts[j * 3 + 5] - pts[j * 3 + 2];
      total += Math.abs(Math.atan2(ux * wz - uz * wx, ux * wx + uz * wz));
    }
    mids[j] = (cum[j] + cum[j + 1]) / 2;
    turns[j] = total;
  }
  const m = np - 1;
  const turnAt = (s: number): number => {
    if (m === 1) return 0;
    let j = 0;
    if (s <= mids[0]) j = 0;
    else if (s >= mids[m - 1]) j = m - 2;
    else while (j < m - 2 && mids[j + 1] < s) j++;
    const span = mids[j + 1] - mids[j];
    return span > 1e-9 ? turns[j] + ((turns[j + 1] - turns[j]) * (s - mids[j])) / span : turns[j];
  };
  for (let i = 0; i < count; i++) {
    const s = (length * i) / (count - 1);
    const lo = Math.max(0, s - chord);
    const hi = Math.min(length, s + chord);
    if (hi - lo < 0.5) continue;
    const kappa = (turnAt(hi) - turnAt(lo)) / (hi - lo);
    if (kappa > 1e-4) {
      const v = Math.max(MIN_CURVE_SPEED, Math.sqrt(lateral / kappa));
      if (v < out[base + i]) out[base + i] = v;
    }
  }
}

/** Append the speed samples of one lane to `out`. Returns the sample count. */
function writeProfile(
  pts: Float32Array,
  cum: Float32Array,
  length: number,
  speed: number,
  connector: boolean,
  out: number[],
): number {
  const count = Math.max(2, Math.ceil(length / PROFILE_STEP) + 1);
  const step = length / (count - 1);
  const base = out.length;
  for (let i = 0; i < count; i++) out.push(speed);
  if (step <= 0 || cum.length < 2) return count;
  // Bends are measured over a fixed chord, so station spacing does not show up as
  // curvature. On connectors the chord is about a wheelbase: a car takes a tight
  // corner in a junction's curve as one smooth arc, whatever the curve's sharpest point.
  const chord = Math.max(step, connector ? CONNECTOR_CHORD : ROAD_CHORD);
  const lateral = connector ? CONNECTOR_LATERAL_ACCEL : CURVE_LATERAL_ACCEL;
  if (!connector) {
    roadBends(pts, cum, length, count, chord, lateral, out, base);
  } else {
    const a = { x: 0, z: 0, i: 0 };
    const b = { x: 0, z: 0, i: 0 };
    const c = { x: 0, z: 0, i: 0 };
    for (let i = 0; i < count; i++) {
      const s = (length * i) / (count - 1);
      sampleXZ(pts, cum, Math.max(0, s - chord), a);
      sampleXZ(pts, cum, s, b);
      sampleXZ(pts, cum, Math.min(length, s + chord), c);
      const ux = b.x - a.x;
      const uz = b.z - a.z;
      const wx = c.x - b.x;
      const wz = c.z - b.z;
      const lu = Math.hypot(ux, uz);
      const lw = Math.hypot(wx, wz);
      if (lu > 0.5 && lw > 0.5) {
        const angle = Math.abs(Math.atan2(ux * wz - uz * wx, ux * wx + uz * wz));
        const kappa = angle / ((lu + lw) / 2);
        if (kappa > 1e-4) {
          const v = Math.max(MIN_CURVE_SPEED, Math.sqrt(lateral / kappa));
          if (v < out[base + i]) out[base + i] = v;
        }
      }
    }
  }
  for (let i = count - 2; i >= 0; i--) {
    const limit = Math.sqrt(out[base + i + 1] ** 2 + 2 * PLAN_DECEL * step);
    if (limit < out[base + i]) out[base + i] = limit;
  }
  return count;
}

export function compileGraph(net: RoadNetwork, sweepCache: SweepCache = new Map()): CompiledGraph {
  const graph = net.laneGraph;
  const lanes = graph.lanes;
  const n = lanes.length;
  const setback = new Float64Array(n);
  const swept = new Map<number, SweptStop[]>();
  const extra = sweepConflicts(graph, sweepCache, setback, swept);
  const sweptStart = new Int32Array(n + 1);
  let sweptTotal = 0;
  for (let i = 0; i < n; i++) {
    sweptStart[i] = sweptTotal;
    sweptTotal += swept.get(i)?.length ?? 0;
  }
  sweptStart[n] = sweptTotal;
  const sweptLane = new Int32Array(sweptTotal);
  const sweptDepth = new Float64Array(sweptTotal);
  for (const [c, list] of swept) {
    let k = sweptStart[c];
    for (const r of list) {
      sweptLane[k] = r.lane;
      sweptDepth[k++] = r.depth;
    }
  }

  const len = new Float64Array(n);
  const speed = new Float64Array(n);
  const isConn = new Uint8Array(n);
  const allow = new Uint8Array(n);
  const left = new Int32Array(n);
  const right = new Int32Array(n);
  const fromLane = new Int32Array(n);
  const toLane = new Int32Array(n);
  const nodeId = new Int32Array(n);
  const segIdx = new Int32Array(n);
  const turn = new Uint8Array(n);
  const nextStart = new Int32Array(n + 1);
  const prevStart = new Int32Array(n + 1);
  const confStart = new Int32Array(n + 1);
  const ptStart = new Int32Array(n + 1);
  const profStart = new Int32Array(n + 1);
  const lastCross = new Float64Array(n).fill(-1);
  const coreCross = new Uint8Array(n);
  const turnAngle = new Float64Array(n);
  const mergeFrom = new Float64Array(n);

  const segIds: Id[] = [];
  const segIndex = new Map<Id, number>();
  for (const s of net.segments) {
    segIndex.set(s.id, segIds.length);
    segIds.push(s.id);
  }

  let nextTotal = 0;
  let prevTotal = 0;
  let confTotal = 0;
  let ptTotal = 0;
  for (let i = 0; i < n; i++) {
    const l = lanes[i];
    nextStart[i] = nextTotal;
    prevStart[i] = prevTotal;
    confStart[i] = confTotal;
    ptStart[i] = ptTotal;
    nextTotal += l.next.length;
    prevTotal += l.prev.length;
    confTotal += l.conflicts.length + (extra.get(i)?.length ?? 0);
    ptTotal += l.cum.length;
  }
  nextStart[n] = nextTotal;
  prevStart[n] = prevTotal;
  confStart[n] = confTotal;
  ptStart[n] = ptTotal;

  const nextList = new Int32Array(nextTotal);
  const prevList = new Int32Array(prevTotal);
  const confLane = new Int32Array(confTotal);
  const confSelf = new Float64Array(confTotal);
  const confOther = new Float64Array(confTotal);
  const confKind = new Uint8Array(confTotal);
  const pts = new Float32Array(ptTotal * 3);
  const cum = new Float32Array(ptTotal);
  const profile: number[] = [];

  for (let i = 0; i < n; i++) {
    const l = lanes[i];
    len[i] = Math.max(l.length, 0.01);
    const connector = l.kind === 'connector';
    speed[i] = Math.max(connector ? Math.min(lanes[l.fromLane].speed, lanes[l.toLane].speed) : l.speed, 1);
    isConn[i] = l.kind === 'connector' ? 1 : 0;
    allow[i] = allowOf(l.vehicleKind);
    // Vehicle restrictions: classes banned from this road lane (core/trafficRules.ts).
    if (!connector) {
      const bans = net.getSegment(l.segmentId)?.overrides.laneBans?.[l.laneIndex];
      if (bans) allow[i] &= ~banBits(bans);
    }
    left[i] = l.left;
    right[i] = l.right;
    fromLane[i] = l.fromLane;
    toLane[i] = l.toLane;
    nodeId[i] = l.nodeId;
    segIdx[i] = l.kind === 'road' ? (segIndex.get(l.segmentId) ?? -1) : -1;
    turn[i] = turnCode(l.turn);
    nextList.set(l.next, nextStart[i]);
    prevList.set(l.prev, prevStart[i]);
    mergeFrom[i] = l.length;
    if (l.kind === 'connector' && l.cum.length >= 2) {
      const m = l.cum.length;
      const ax = l.pts[3] - l.pts[0];
      const az = l.pts[5] - l.pts[2];
      const bx = l.pts[m * 3 - 3] - l.pts[m * 3 - 6];
      const bz = l.pts[m * 3 - 1] - l.pts[m * 3 - 4];
      turnAngle[i] = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
    }
    let k = confStart[i];
    for (const c of l.conflicts) {
      confLane[k] = c.lane;
      confSelf[k] = c.selfS;
      confOther[k] = c.otherS;
      confKind[k] = c.kind === 'cross' ? KIND_CROSS : c.kind === 'merge' ? KIND_MERGE : KIND_DIVERGE;
      if (c.kind === 'cross' && c.selfS > lastCross[i]) lastCross[i] = c.selfS;
      if (c.kind === 'cross') coreCross[i] = 1;
      if (c.kind === 'merge' && c.selfS < mergeFrom[i]) mergeFrom[i] = c.selfS;
      k++;
    }
    for (const c of (extra.get(i) ?? NO_HITS)) {
      confLane[k] = c.lane;
      confSelf[k] = c.selfS;
      confOther[k] = c.otherS;
      confKind[k++] = c.all ? KIND_NEAR : c.pair ? KIND_SWEEP_PAIR : c.own === false ? KIND_SWEEP_THEIRS : KIND_SWEEP;
      if (c.all && c.selfS > lastCross[i]) lastCross[i] = c.selfS;
    }
    pts.set(l.pts, ptStart[i] * 3);
    cum.set(l.cum, ptStart[i]);
    profStart[i] = profile.length;
    const samples = writeProfile(l.pts, l.cum, l.length, speed[i], connector, profile);
    if (connector) {
      // A connector's speed is what can actually be held through it.
      for (let p = profStart[i]; p < profStart[i] + samples; p++) if (profile[p] < speed[i]) speed[i] = profile[p];
    }
  }
  profStart[n] = profile.length;
  // A connector is no use to a class that cannot use both of the lanes it joins, bans included.
  for (let i = 0; i < n; i++) if (isConn[i]) allow[i] &= allow[fromLane[i]] & allow[toLane[i]];

  const shared = sharedStretches(graph);
  const shareStart = new Int32Array(n + 1);
  let shareTotal = 0;
  for (let i = 0; i < n; i++) {
    shareStart[i] = shareTotal;
    shareTotal += shared.get(i)?.length ?? 0;
  }
  shareStart[n] = shareTotal;
  const shareLane = new Int32Array(shareTotal);
  const shareFrom = new Float64Array(shareTotal);
  const shareTo = new Float64Array(shareTotal);
  const shareOffset = new Float64Array(shareTotal);
  const shareGap = new Float64Array(shareTotal);
  for (const [lane, list] of shared) {
    let k = shareStart[lane];
    for (const st of list) {
      shareLane[k] = st.other;
      shareFrom[k] = st.from;
      shareTo[k] = st.to;
      shareGap[k] = st.gap;
      shareOffset[k++] = st.offset;
    }
  }

  const merges: number[] = [];
  for (let i = 0; i < n; i++) {
    if (isConn[i]) continue;
    let feeders = 0;
    for (let k = prevStart[i]; k < prevStart[i + 1]; k++) if (isConn[prevList[k]]) feeders++;
    // An edge merge (core/edgeMerge.ts): a ramp's connector joins a lane the highway runs
    // straight into, so the road lane before it is a feeder to order against too.
    const total = prevStart[i + 1] - prevStart[i];
    if (feeders >= 2 || (feeders >= 1 && total >= 2)) merges.push(i);
    if (feeders >= 1 && total > feeders) {
      // The merge zone starts where the ramp's path comes within a lane of the highway lane's.
      for (let k = prevStart[i]; k < prevStart[i + 1]; k++) {
        const c = prevList[k];
        if (!isConn[c]) continue;
        for (let q = prevStart[i]; q < prevStart[i + 1]; q++) {
          const r = prevList[q];
          if (isConn[r]) continue;
          const zone = closeFromEnd(lanes[c], lanes[r], (lanes[c].width + lanes[r].width) / 2);
          if (len[c] - zone < mergeFrom[c]) mergeFrom[c] = len[c] - zone;
          if (len[r] - zone < mergeFrom[r]) mergeFrom[r] = len[r] - zone;
        }
      }
    }
  }

  return {
    graph,
    version: graph.version,
    n,
    len,
    speed,
    isConn,
    allow,
    left,
    right,
    fromLane,
    toLane,
    nodeId,
    segIdx,
    turn,
    nextStart,
    nextList,
    prevStart,
    prevList,
    confStart,
    confLane,
    confSelf,
    confOther,
    confKind,
    lastCross,
    coreCross,
    turnAngle,
    setback,
    sweptStart,
    sweptLane,
    sweptDepth,
    mergeFrom,
    ptStart,
    pts,
    cum,
    profStart,
    prof: Float32Array.from(profile),
    shareStart,
    shareLane,
    shareFrom,
    shareTo,
    shareOffset,
    shareGap,
    mergeLanes: Int32Array.from(merges),
    segCount: segIds.length,
    segIds,
    segIndex,
  };
}
