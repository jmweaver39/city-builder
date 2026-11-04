/**
 * Swept-path conflicts. The core finds where lane centrelines meet, but bodies are
 * wider than lines: two cars on paths that pass a metre apart touch, as opposing left
 * turners can. Each connector is walked with a car-sized body for that. And a long
 * vehicle's body is not on its centreline in a turn: with the nose in the junction
 * and the tail still on the approach, a 12 m truck lies diagonally across the road and
 * sweeps over lanes it never crosses. Here that body is walked along each turning
 * connector, and any other connector it reaches is recorded as a conflict that applies
 * when the vehicle on the walked connector is long (KIND_SWEEP on it, KIND_SWEEP_THEIRS
 * on the other). Two long bodies are also walked against each other (KIND_SWEEP_PAIR),
 * and each connector records the stop lines of other arms its long body swings over.
 *
 * This is geometry on the scale of a junction, so it is cached per node. GLanes are
 * shared between graph versions while unchanged, which makes identity a safe key.
 */
import type { GLane, Id, LaneGraph } from '../core';
/** Zone points sit this far past first contact. Guard holds come GUARD_MARGIN before them. */
const ZONE_OFFSET = 1;
/** A truck waiting at a stop line is this much wider, each side, than the car allowed for. */
const WAITING_EXTRA = 0.4;
/** Zone points along the other path: each covers its margins and a car's length. */
const OTHER_SPACING = 10;
/** How much of each exit lane a swinging tail is checked against. */
const EXIT_REACH = 16;

const STEP = 2.5;

/** A body walked along each connector: its length, the room it needs, and the least turn worth checking. */
interface Body {
  length: number;
  clearance: number;
  minTurn: number;
}

/**
 * A long vehicle: 12 m, half its width plus half a car's plus a margin. Every connector
 * is walked, even a straight one: the tail may still be on a curved lane behind it, as
 * coming off a loop ramp, and that is where it swings wide.
 */
const LONG: Body = { length: 12, clearance: 2.4, minTurn: 0 };
/** Any car, on any path. Two cars side by side need 1.8 m plus a margin. */
const CAR: Body = { length: 4.5, clearance: 2.1, minTurn: 0 };

export interface SweepHit {
  lane: number;
  selfS: number;
  otherS: number;
  /** True when any two vehicles clash here, false when only a long one makes it so. */
  all: boolean;
  /** True when only two long vehicles clash here, one on each path. */
  pair?: boolean;
  /**
   * For a long-body hit: true when the long body is on this lane, false when it is on
   * `lane`. The walk puts a long body on one path and a car-sized one on the other, so a
   * hit says nothing about a long vehicle on the other path meeting a car on this one.
   */
  own?: boolean;
}

/** A road lane into a node whose last `depth` metres a connector's long body swings over. */
export interface SweptStop {
  lane: number;
  depth: number;
}

interface NodeSweep {
  lanes: GLane[];
  /** By position in the node's connector list. */
  /** a by position in the node's list; b a dense lane index; road when b is an exit lane. */
  hits: { a: number; b: number; road: boolean; aS: number; bS: number; all: boolean; pair?: boolean }[];
  /** Road lanes into this node whose stop line a turning long body reaches: how far back to wait. */
  setbacks: Map<number, number>;
  /** The same for each connector, by position in the node's list: lane to how far back. */
  reaches: Map<number, number>[];
}

export type SweepCache = Map<Id, NodeSweep>;

/** Longest setback worth having, metres. */
const MAX_SETBACK = 10;

function pointAt(lane: GLane, s: number, out: { x: number; z: number }): void {
  const { cum, pts } = lane;
  const last = cum.length - 2;
  let i = 0;
  while (i < last && cum[i + 1] < s) i++;
  const span = cum[i + 1] - cum[i];
  const f = span > 0 ? Math.min(1, Math.max(0, (s - cum[i]) / span)) : 0;
  out.x = pts[i * 3] + (pts[i * 3 + 3] - pts[i * 3]) * f;
  out.z = pts[i * 3 + 2] + (pts[i * 3 + 5] - pts[i * 3 + 2]) * f;
}

function turnOf(lane: GLane): number {
  const n = lane.cum.length;
  if (n < 2) return 0;
  const { pts } = lane;
  const ax = pts[3] - pts[0];
  const az = pts[5] - pts[2];
  const bx = pts[n * 3 - 3] - pts[n * 3 - 6];
  const bz = pts[n * 3 - 1] - pts[n * 3 - 4];
  return Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
}

function distanceToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const ex = bx - ax;
  const ez = bz - az;
  const l2 = ex * ex + ez * ez;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * ex + (pz - az) * ez) / l2)) : 0;
  return Math.hypot(px - ax - ex * t, pz - az - ez * t);
}

function computeNode(graph: LaneGraph, ids: number[]): NodeSweep {
  const lanes = ids.map((i) => graph.lanes[i]);
  const hits: NodeSweep['hits'] = [];
  const setbacks = new Map<number, number>();
  const reaches = lanes.map(() => new Map<number, number>());
  sweepBody(graph, ids, lanes, CAR, hits, setbacks, reaches);
  sweepBody(graph, ids, lanes, LONG, hits, setbacks, reaches);
  sweepPairs(graph, ids, lanes, hits);
  return { lanes, hits, setbacks, reaches };
}

/**
 * Two long bodies, both on the move through a turn, need more room than a long body and
 * a car: neither lies on its centreline, so the walk below, which measures a long body
 * against the other path's centreline with a car's half width beside it, passes two
 * trucks that meet corner to corner. Here both bodies are walked, each as the chord from
 * nose to tail, and every pair of positions closer than two long half widths and a margin
 * is a conflict that applies only when both vehicles are long.
 */
const PAIR_CLEARANCE = 2.7;
const PAIR_STEP = 1;

interface Chords {
  s: Float64Array;
  fx: Float64Array;
  fz: Float64Array;
  rx: Float64Array;
  rz: Float64Array;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** A long body's chord at each nose position along a connector and on into its exit. */
function chordsOf(graph: LaneGraph, c: GLane): Chords {
  const from = graph.lanes[c.fromLane];
  const exit = graph.lanes[c.toLane];
  const reach = c.length + Math.min(LONG.length, exit.length);
  const count = Math.max(2, Math.ceil(reach / PAIR_STEP) + 1);
  const out: Chords = {
    s: new Float64Array(count),
    fx: new Float64Array(count),
    fz: new Float64Array(count),
    rx: new Float64Array(count),
    rz: new Float64Array(count),
    minX: Infinity,
    maxX: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  const p = { x: 0, z: 0 };
  for (let i = 0; i < count; i++) {
    const s = (reach * i) / (count - 1);
    if (s <= c.length) pointAt(c, s, p);
    else pointAt(exit, s - c.length, p);
    out.s[i] = s;
    out.fx[i] = p.x;
    out.fz[i] = p.z;
    const back = s - LONG.length;
    if (back >= 0) pointAt(c, back, p);
    else pointAt(from, Math.max(0, from.length + back), p);
    out.rx[i] = p.x;
    out.rz[i] = p.z;
    out.minX = Math.min(out.minX, out.fx[i], p.x);
    out.maxX = Math.max(out.maxX, out.fx[i], p.x);
    out.minZ = Math.min(out.minZ, out.fz[i], p.z);
    out.maxZ = Math.max(out.maxZ, out.fz[i], p.z);
  }
  return out;
}

/** Closest distance between segments ab and cd in the plane. */
function segmentDistance(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number {
  const ex = bx - ax;
  const ez = bz - az;
  const fx = dx - cx;
  const fz = dz - cz;
  const den = ex * fz - ez * fx;
  if (den !== 0) {
    const t = ((cx - ax) * fz - (cz - az) * fx) / den;
    const u = ((cx - ax) * ez - (cz - az) * ex) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(
    distanceToSegment(ax, az, cx, cz, dx, dz),
    distanceToSegment(bx, bz, cx, cz, dx, dz),
    distanceToSegment(cx, cz, ax, az, bx, bz),
    distanceToSegment(dx, dz, ax, az, bx, bz),
  );
}

function sweepPairs(graph: LaneGraph, ids: number[], lanes: GLane[], hits: NodeSweep['hits']): void {
  const chords = lanes.map((c) => (c.vehicleKind === 'bike' ? null : chordsOf(graph, c)));
  const bucket = Math.max(LONG.length, 8);
  for (let a = 0; a < lanes.length; a++) {
    const A = chords[a];
    if (!A) continue;
    for (let b = a + 1; b < lanes.length; b++) {
      const B = chords[b];
      if (!B) continue;
      // One behind the other from one lane, or into one: following and merging order them.
      if (lanes[a].fromLane === lanes[b].fromLane || lanes[a].toLane === lanes[b].toLane) continue;
      if (A.minX - PAIR_CLEARANCE > B.maxX || B.minX - PAIR_CLEARANCE > A.maxX) continue;
      if (A.minZ - PAIR_CLEARANCE > B.maxZ || B.minZ - PAIR_CLEARANCE > A.maxZ) continue;
      const zones = new Map<number, { aS: number; bS: number }>();
      for (let i = 0; i < A.s.length; i++) {
        for (let j = 0; j < B.s.length; j++) {
          const d = segmentDistance(A.fx[i], A.fz[i], A.rx[i], A.rz[i], B.fx[j], B.fz[j], B.rx[j], B.rz[j]);
          if (d >= PAIR_CLEARANCE) continue;
          const key = Math.floor(A.s[i] / bucket) * 4096 + Math.floor(B.s[j] / bucket);
          const hit = zones.get(key);
          if (!hit) zones.set(key, { aS: A.s[i], bS: B.s[j] });
          else {
            if (A.s[i] < hit.aS) hit.aS = A.s[i];
            if (B.s[j] < hit.bS) hit.bS = B.s[j];
          }
        }
      }
      for (const hit of zones.values()) {
        hits.push({ a, b: ids[b], road: false, aS: hit.aS + ZONE_OFFSET, bS: hit.bS + ZONE_OFFSET, all: false, pair: true });
      }
    }
  }
}

function sweepBody(
  graph: LaneGraph,
  ids: number[],
  lanes: GLane[],
  body: Body,
  hits: NodeSweep['hits'],
  setbacks: Map<number, number>,
  reaches: Map<number, number>[],
): void {
  const SWEEP_LENGTH = body.length;
  const SWEEP_CLEARANCE = body.clearance;
  const all = body === CAR;
  // A zone point covers its margins and a body length past itself.
  const bucket = Math.max(SWEEP_LENGTH, 8);
  // Besides other connectors, the first stretch of each exit lane: a queue there sits
  // right beside where a long tail swings out of the junction.
  const exits = [...new Set(lanes.map((l) => l.toLane))];
  const targets: { lane: GLane; id: number; length: number; road: boolean }[] = [
    ...lanes.map((l, i) => ({ lane: l, id: ids[i], length: l.length, road: false })),
    ...exits.map((id) => ({ lane: graph.lanes[id], id, length: Math.min(EXIT_REACH, graph.lanes[id].length), road: true })),
  ];
  const incoming = [...new Set(lanes.map((l) => l.fromLane))];
  const f = { x: 0, z: 0 };
  const r = { x: 0, z: 0 };
  const p = { x: 0, z: 0 };
  // Other paths, sampled once.
  const samples = targets.map((t) => {
    const l = t.lane;
    const count = Math.max(2, Math.ceil(t.length / STEP) + 1);
    const xs = new Float64Array(count);
    const zs = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      pointAt(l, (t.length * i) / (count - 1), p);
      xs[i] = p.x;
      zs[i] = p.z;
    }
    return { xs, zs, count };
  });
  for (let a = 0; a < lanes.length; a++) {
    const c = lanes[a];
    if (c.vehicleKind === 'bike' || turnOf(c) < body.minTurn) continue;
    const from = graph.lanes[c.fromLane];
    // Crossing pairs still count: the core's point is where centrelines cross, while a
    // tail can reach the other path much earlier. Merges are ordered another way.
    // A long body needs more room than merge ordering gives a car, so it sweeps merges too.
    const known = new Set(all ? c.conflicts.filter((k) => k.kind === 'merge').map((k) => k.lane) : []);
    // First and last contact with each other path, along this one and along that.
    // Contacts that really happen together: with the nose at q, the body reaches the other
    // path at its point i. Bucketed, each pair of buckets becomes one zone, earliest
    // point first. Pairing every point with every other would invent conflicts between
    // positions that never meet, and those can wait on each other for ever.
    const seen = new Map<number, Map<number, { aS: number; bS: number }>>();
    const exit = graph.lanes[c.toLane];
    // The nose runs on along the exit lane until the tail has left the connector.
    const reach = c.length + Math.min(SWEEP_LENGTH, exit.length);
    const steps = Math.ceil(reach / STEP);
    for (let q = 0; q <= steps; q++) {
      const s = (reach * q) / steps;
      if (s <= c.length) pointAt(c, s, f);
      else pointAt(exit, s - c.length, f);
      const back = s - SWEEP_LENGTH;
      if (back >= 0) pointAt(c, back, r);
      else pointAt(from, from.length + back, r);
      for (let b = 0; b < targets.length; b++) {
        if (b === a) continue;
        const target = targets[b];
        const d = target.lane;
        if (target.road) {
          // Its own exit is followed in the ordinary way.
          if (target.id === c.toLane || d.vehicleKind === 'bike') continue;
        } else if ((all && d.fromLane === c.fromLane) || d.vehicleKind === 'bike' || known.has(ids[b])) {
          // Branches from one lane are kept apart by following until they separate, which
          // is enough for cars. A long body still swings over the other branch after that.
          continue;
        }
        const sample = samples[b];
        // Every point of the other path in reach, not just the first: along a merge that
        // stretch is long, and a vehicle past its first point is not yet clear.
        for (let i = 0; i < sample.count; i++) {
          if (distanceToSegment(sample.xs[i], sample.zs[i], f.x, f.z, r.x, r.z) >= SWEEP_CLEARANCE) continue;
          const at = (target.length * i) / (sample.count - 1);
          let pairs = seen.get(b);
          if (!pairs) seen.set(b, (pairs = new Map()));
          const key = Math.floor(s / bucket) * 4096 + Math.floor(at / OTHER_SPACING);
          const hit = pairs.get(key);
          if (!hit) pairs.set(key, { aS: s, bS: at });
          else {
            if (s < hit.aS) hit.aS = s;
            if (at < hit.bS) hit.bS = at;
          }
        }
      }
      // Waiting vehicles at another arm's stop line. Going back from the line, find
      // where the lane leaves this body's reach.
      for (const idx of incoming) {
        if (idx === c.fromLane) continue;
        const lane = graph.lanes[idx];
        for (let e = 0; e <= MAX_SETBACK; e += 1) {
          if (e > lane.length * 0.5) break;
          pointAt(lane, lane.length - e, p);
          // The one waiting may be a truck: allow for its width over a car's.
          if (distanceToSegment(p.x, p.z, f.x, f.z, r.x, r.z) >= SWEEP_CLEARANCE + WAITING_EXTRA) continue;
          if (e + 1 > (setbacks.get(idx) ?? 0)) setbacks.set(idx, e + 1);
          if (e + 1 > (reaches[a].get(idx) ?? 0)) reaches[a].set(idx, e + 1);
        }
      }
    }
    for (const [b, pairs] of seen) {
      const limit = targets[b].length;
      for (const hit of pairs.values()) {
        hits.push({ a, b: targets[b].id, road: targets[b].road, aS: hit.aS + ZONE_OFFSET, bS: Math.min(limit, hit.bS + ZONE_OFFSET), all });
      }
    }
  }
}

function sameLanes(a: GLane[], ids: number[], graph: LaneGraph): boolean {
  if (a.length !== ids.length) return false;
  for (let i = 0; i < ids.length; i++) if (a[i] !== graph.lanes[ids[i]]) return false;
  return true;
}

/**
 * Sweep conflicts of the whole graph, by connector. Conflicts go on both connectors.
 * `swept`, when given, receives for each connector the stop lines of other arms its long
 * body swings over, and how far back from each.
 */
export function sweepConflicts(
  graph: LaneGraph,
  cache: SweepCache,
  setback: Float64Array,
  swept?: Map<number, SweptStop[]>,
): Map<number, SweepHit[]> {
  const out = new Map<number, SweepHit[]>();
  const add = (lane: number, hit: SweepHit) => {
    const list = out.get(lane);
    if (list) list.push(hit);
    else out.set(lane, [hit]);
  };
  for (const [nodeId, ids] of graph.connectorsAt) {
    if (ids.length < 2) continue;
    let node = cache.get(nodeId);
    if (!node || !sameLanes(node.lanes, ids, graph)) {
      node = computeNode(graph, ids);
      cache.set(nodeId, node);
    }
    for (const [lane, back] of node.setbacks) setback[lane] = back;
    if (swept) {
      node.reaches.forEach((reach, a) => {
        if (reach.size) swept.set(ids[a], [...reach].map(([lane, depth]) => ({ lane, depth })));
      });
    }
    for (const h of node.hits) {
      add(ids[h.a], { lane: h.b, selfS: h.aS, otherS: h.bS, all: h.all, pair: h.pair, own: true });
      // Road lanes keep no conflicts: their vehicles are on the connector's side of it.
      if (!h.road) add(h.b, { lane: ids[h.a], selfS: h.bS, otherS: h.aS, all: h.all, pair: h.pair, own: false });
    }
  }
  return out;
}
