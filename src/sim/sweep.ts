/**
 * Swept-path conflicts. The core finds where lane centrelines meet, but bodies are
 * wider than lines: two cars on paths that pass a metre apart touch, as opposing left
 * turners can. Each connector is walked with a car-sized body for that. And a long
 * vehicle's body is not on its centreline in a turn: with the nose in the junction
 * and the tail still on the approach, a 12 m truck lies diagonally across the road and
 * sweeps over lanes it never crosses. Here that body is walked along each turning
 * connector, and any other connector it reaches is recorded as a conflict that applies
 * when a long vehicle is involved.
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
const OTHER_SPACING = 8;
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
}

interface NodeSweep {
  lanes: GLane[];
  /** By position in the node's connector list. */
  /** a by position in the node's list; b a dense lane index; road when b is an exit lane. */
  hits: { a: number; b: number; road: boolean; aS: number; bS: number; all: boolean }[];
  /** Road lanes into this node whose stop line a turning long body reaches: how far back to wait. */
  setbacks: Map<number, number>;
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
  sweepBody(graph, ids, lanes, CAR, hits, setbacks);
  sweepBody(graph, ids, lanes, LONG, hits, setbacks);
  return { lanes, hits, setbacks };
}

function sweepBody(
  graph: LaneGraph,
  ids: number[],
  lanes: GLane[],
  body: Body,
  hits: NodeSweep['hits'],
  setbacks: Map<number, number>,
): void {
  const SWEEP_LENGTH = body.length;
  const SWEEP_CLEARANCE = body.clearance;
  const all = body === CAR;
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
          const key = Math.floor(s / SWEEP_LENGTH) * 4096 + Math.floor(at / OTHER_SPACING);
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

/** Sweep conflicts of the whole graph, by connector. Conflicts go on both connectors. */
export function sweepConflicts(graph: LaneGraph, cache: SweepCache, setback: Float64Array): Map<number, SweepHit[]> {
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
    for (const h of node.hits) {
      add(ids[h.a], { lane: h.b, selfS: h.aS, otherS: h.bS, all: h.all });
      // Road lanes keep no conflicts: their vehicles are on the connector's side of it.
      if (!h.road) add(h.b, { lane: ids[h.a], selfS: h.bS, otherS: h.aS, all: h.all });
    }
  }
  return out;
}
