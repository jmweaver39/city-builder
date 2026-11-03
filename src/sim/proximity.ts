/**
 * Road lanes that share space. Near a junction the core trims each road at most 80 m
 * back, so a ramp leaving a highway at a shallow angle can still overlap the highway
 * lane past the cut (a documented core limitation). Two lanes then run side by side
 * closer than a body's width. Here such stretches are found, and the vehicles on them
 * follow one another across the pair as if on one lane, in one order by position.
 */
import type { GLane, LaneGraph } from '../core';

/** Centrelines closer than this put two bodies in contact: a truck and a car, plus a margin. */
const SHARED_WIDTH = 2.6;
const STEP = 3;
/** How far from the node a pair is checked. */
const REACH = 200;

export interface SharedStretch {
  other: number;
  /** Stretch along this lane where the other is within reach. */
  from: number;
  to: number;
  /** Position on the other lane minus position on this one, for the same place. */
  offset: number;
  /** Closest the two centrelines come: two narrow bodies may pass where wide ones cannot. */
  gap: number;
}

function sample(lane: GLane, fromEnd: boolean): { s: Float64Array; x: Float64Array; z: Float64Array } {
  const span = Math.min(REACH, lane.length);
  const count = Math.max(2, Math.ceil(span / STEP) + 1);
  const s = new Float64Array(count);
  const x = new Float64Array(count);
  const z = new Float64Array(count);
  const { cum, pts } = lane;
  let i = 0;
  for (let k = 0; k < count; k++) {
    const at = fromEnd ? lane.length - span + (span * k) / (count - 1) : (span * k) / (count - 1);
    while (i < cum.length - 2 && cum[i + 1] < at) i++;
    const seg = cum[i + 1] - cum[i];
    const f = seg > 0 ? Math.min(1, Math.max(0, (at - cum[i]) / seg)) : 0;
    s[k] = at;
    x[k] = pts[i * 3] + (pts[i * 3 + 3] - pts[i * 3]) * f;
    z[k] = pts[i * 3 + 2] + (pts[i * 3 + 5] - pts[i * 3 + 2]) * f;
  }
  return { s, x, z };
}

function stretchOf(a: GLane, b: GLane, fromEnd: boolean): Omit<SharedStretch, 'other'> | null {
  const pa = sample(a, fromEnd);
  const pb = sample(b, fromEnd);
  let from = Infinity;
  let to = -Infinity;
  let gap = Infinity;
  const offsets: number[] = [];
  for (let i = 0; i < pa.s.length; i++) {
    let best = Infinity;
    let at = 0;
    for (let j = 0; j < pb.s.length; j++) {
      const d = Math.hypot(pa.x[i] - pb.x[j], pa.z[i] - pb.z[j]);
      if (d < best) {
        best = d;
        at = pb.s[j];
      }
    }
    if (best < SHARED_WIDTH) {
      gap = Math.min(gap, best);
      from = Math.min(from, pa.s[i]);
      to = Math.max(to, pa.s[i]);
      offsets.push(at - pa.s[i]);
    }
  }
  if (!offsets.length) return null;
  offsets.sort((p, q) => p - q);
  return { from, to, offset: offsets[offsets.length >> 1], gap };
}

/** Shared stretches of every road lane that starts or ends at a junction. */
export function sharedStretches(graph: LaneGraph): Map<number, SharedStretch[]> {
  const out = new Map<number, SharedStretch[]>();
  const add = (lane: number, s: SharedStretch) => {
    const list = out.get(lane);
    if (list) list.push(s);
    else out.set(lane, [s]);
  };
  for (const ids of graph.connectorsAt.values()) {
    if (ids.length < 2) continue;
    for (const fromEnd of [false, true]) {
      const lanes = [...new Set(ids.map((c) => (fromEnd ? graph.lanes[c].fromLane : graph.lanes[c].toLane)))];
      for (let i = 0; i < lanes.length; i++) {
        for (let j = i + 1; j < lanes.length; j++) {
          const a = graph.lanes[lanes[i]];
          const b = graph.lanes[lanes[j]];
          if (a.segmentId === b.segmentId || a.vehicleKind === 'bike' || b.vehicleKind === 'bike') continue;
          const ab = stretchOf(a, b, fromEnd);
          if (!ab) continue;
          const ba = stretchOf(b, a, fromEnd);
          add(lanes[i], { other: lanes[j], ...ab });
          if (ba) add(lanes[j], { other: lanes[i], ...ba });
        }
      }
    }
  }
  return out;
}
