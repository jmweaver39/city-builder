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

const STEP = 2.5;

/** A body walked along each connector: its length, the room it needs, and the least turn worth checking. */
interface Body {
  length: number;
  clearance: number;
  minTurn: number;
}

/** A long vehicle: 12 m, half its width plus half a car's plus a margin. */
const LONG: Body = { length: 12, clearance: 2.4, minTurn: 0.45 };
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
  hits: { a: number; b: number; aS: number; bS: number; all: boolean }[];
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
  sweepBody(graph, ids, lanes, CAR, hits, null);
  sweepBody(graph, ids, lanes, LONG, hits, setbacks);
  return { lanes, hits, setbacks };
}

function sweepBody(
  graph: LaneGraph,
  ids: number[],
  lanes: GLane[],
  body: Body,
  hits: NodeSweep['hits'],
  setbacks: Map<number, number> | null,
): void {
  const SWEEP_LENGTH = body.length;
  const SWEEP_CLEARANCE = body.clearance;
  const all = body === CAR;
  const incoming = [...new Set(lanes.map((l) => l.fromLane))];
  const f = { x: 0, z: 0 };
  const r = { x: 0, z: 0 };
  const p = { x: 0, z: 0 };
  // Other paths, sampled once.
  const samples = lanes.map((l) => {
    const count = Math.max(2, Math.ceil(l.length / STEP) + 1);
    const xs = new Float64Array(count);
    const zs = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      pointAt(l, (l.length * i) / (count - 1), p);
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
    const known = new Set(c.conflicts.filter((k) => k.kind === 'merge').map((k) => k.lane));
    // First and last contact with each other path, along this one and along that.
    const seen = new Map<number, { aS: number; aEnd: number; bS: number }>();
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
      for (let b = 0; b < lanes.length; b++) {
        if (b === a) continue;
        const d = lanes[b];
        // Branches from one lane are kept apart by following until they separate, which
        // is enough for cars. A long body still swings over the other branch after that.
        if ((all && d.fromLane === c.fromLane) || d.vehicleKind === 'bike' || known.has(ids[b])) continue;
        const sample = samples[b];
        for (let i = 0; i < sample.count; i++) {
          if (distanceToSegment(sample.xs[i], sample.zs[i], f.x, f.z, r.x, r.z) < SWEEP_CLEARANCE) {
            const hit = seen.get(b);
            if (hit) hit.aEnd = s;
            else seen.set(b, { aS: s, aEnd: s, bS: (d.length * i) / (sample.count - 1) });
            break;
          }
        }
      }
      // Waiting vehicles at another arm's stop line. Going back from the line, find
      // where the lane leaves this body's reach.
      for (const idx of setbacks ? incoming : []) {
        if (idx === c.fromLane) continue;
        const lane = graph.lanes[idx];
        for (let e = 0; e <= MAX_SETBACK; e += 1) {
          if (e > lane.length * 0.5) break;
          pointAt(lane, lane.length - e, p);
          if (distanceToSegment(p.x, p.z, f.x, f.z, r.x, r.z) >= SWEEP_CLEARANCE) continue;
          if (e + 1 > (setbacks!.get(idx) ?? 0)) setbacks!.set(idx, e + 1);
        }
      }
    }
    for (const [b, hit] of seen) {
      // A zone point covers a body length past itself, so a long sweep gets a chain of
      // them. Positions on this connector are where the nose is, which may be beyond
      // its end on the exit lane while the tail still swings through.
      // A zone point sits just past first contact: the guard holds a little before a
      // point, and that must be before the bodies touch, not after.
      const bS = Math.min(lanes[b].length, hit.bS + ZONE_OFFSET);
      for (let q = hit.aS; ; q += SWEEP_LENGTH) {
        const at = Math.min(q, hit.aEnd) + ZONE_OFFSET;
        hits.push({ a, b, aS: at, bS, all });
        if (q >= hit.aEnd) break;
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
      add(ids[h.a], { lane: ids[h.b], selfS: h.aS, otherS: h.bS, all: h.all });
      add(ids[h.b], { lane: ids[h.a], selfS: h.bS, otherS: h.aS, all: h.all });
    }
  }
  return out;
}
