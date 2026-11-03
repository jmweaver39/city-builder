/** Carrying vehicles over a change of lane graph. */
import type { LaneGraph } from '../core';
import { ENTRY_REAL } from './buckets';
import type { CompiledGraph } from './compiled';
import { freeVehicle } from './vehicles';
import type { World } from './world';

/** Beyond this many vehicle-lane pairs an edit falls back to keeping fractions. */
const RELOCATE_BUDGET = 3_000_000;
/** How far a vehicle may be snapped to a lane near where it was. */
const SNAP_DIST = 25;

function pointOn(old: CompiledGraph, lane: number, s: number, out: { x: number; z: number; dx: number; dz: number }): void {
  const { ptStart, cum, pts } = old;
  const base = ptStart[lane];
  const last = ptStart[lane + 1] - base - 2;
  let i = 0;
  while (i < last && cum[base + i + 1] < s) i++;
  const c0 = cum[base + i];
  const span = last >= 0 ? cum[base + i + 1] - c0 : 0;
  const f = span > 0 ? Math.min(1, Math.max(0, (s - c0) / span)) : 0;
  const k = (base + i) * 3;
  out.x = pts[k] + (pts[k + 3] - pts[k]) * f;
  out.z = pts[k + 2] + (pts[k + 5] - pts[k + 2]) * f;
  const dx = pts[k + 3] - pts[k];
  const dz = pts[k + 5] - pts[k + 2];
  const l = Math.hypot(dx, dz) || 1;
  out.dx = dx / l;
  out.dz = dz / l;
}

/** Nearest place on `lanes`, heading the same way. Returns distance, and lane and s in `hit`. */
function nearestOn(
  g: CompiledGraph,
  lanes: number[],
  p: { x: number; z: number; dx: number; dz: number },
  hit: { lane: number; s: number },
): number {
  const { ptStart, pts, cum } = g;
  let best = Infinity;
  for (const lane of lanes) {
    const base = ptStart[lane];
    const count = ptStart[lane + 1] - base;
    for (let i = 0; i + 1 < count; i++) {
      const k = (base + i) * 3;
      const ax = pts[k];
      const az = pts[k + 2];
      const ex = pts[k + 3] - ax;
      const ez = pts[k + 5] - az;
      const l2 = ex * ex + ez * ez;
      if (l2 < 1e-6) continue;
      const lenE = Math.sqrt(l2);
      if ((ex * p.dx + ez * p.dz) / lenE < 0.7) continue;
      const t = Math.min(1, Math.max(0, ((p.x - ax) * ex + (p.z - az) * ez) / l2));
      const qx = ax + ex * t - p.x;
      const qz = az + ez * t - p.z;
      const dist = qx * qx + qz * qz;
      if (dist < best) {
        best = dist;
        hit.lane = lane;
        hit.s = cum[base + i] + (cum[base + i + 1] - cum[base + i]) * t;
      }
    }
  }
  return Math.sqrt(best);
}

/**
 * Move every vehicle to the new graph. A lane that survives keeps its vehicles at
 * their fraction along it. When a lane changed size or vanished, as a split does to
 * the far half of a road, vehicles look for the lane now under them first, so a road
 * being cut in two does not throw cars back along it. A vehicle with no lane is
 * removed.
 */
export function remapVehicles(w: World, oldG: CompiledGraph, oldGraph: LaneGraph, g: CompiledGraph, reversed?: ReadonlySet<number>): void {
  const { veh, counters } = w;
  const graph = g.graph;
  const same = oldGraph.byKey === graph.byKey;

  const changed: number[] = [];
  if (!same) {
    for (let l = 0; l < g.n; l++) {
      if (g.isConn[l]) continue;
      const oldIdx = oldGraph.byKey.get(graph.lanes[l].key);
      if (oldIdx === undefined || Math.abs(oldG.len[oldIdx] - g.len[l]) > 2 || reversed?.has(graph.lanes[l].segmentId)) changed.push(l);
    }
  }
  const canSnap = changed.length * veh.liveCount * 24 < RELOCATE_BUDGET;
  const p = { x: 0, z: 0, dx: 0, dz: 0 };
  const hit = { lane: -1, s: 0 };
  const carry = (l: number): number => {
    if (l < 0 || same) return l;
    const key = oldGraph.lanes[l]?.key;
    return key === undefined ? -1 : (graph.byKey.get(key) ?? -1);
  };

  for (let i = veh.liveCount - 1; i >= 0; i--) {
    const v = veh.live[i];
    const old = veh.lane[v];
    const key = oldGraph.lanes[old]?.key;
    let lane = key === undefined ? -1 : (graph.byKey.get(key) ?? -1);
    // A turned road keeps its lane keys, but each now runs the other way. Only a lane
    // heading the way the vehicle is heading, found by position below, can take it.
    if (reversed?.has(oldGraph.lanes[old]?.segmentId)) lane = -1;
    const oldLen = oldG.len[old];
    let s = veh.s[v];
    let placed = false;
    if (!same && canSnap && changed.length && (lane < 0 || Math.abs(g.len[lane] - oldLen) > 2)) {
      pointOn(oldG, old, s, p);
      const candidates = lane >= 0 && !changed.includes(lane) ? [...changed, lane] : changed;
      const dist = nearestOn(g, candidates, p, hit);
      if (dist < SNAP_DIST) {
        lane = hit.lane;
        s = hit.s;
        placed = true;
      }
    }
    if (lane < 0) {
      freeVehicle(veh, v);
      counters.removedByEdit++;
      continue;
    }
    if (!placed) s = (s / oldLen) * g.len[lane];
    const max = g.len[lane] - 0.05;
    veh.lane[v] = lane;
    veh.s[v] = s < max ? (s > 0 ? s : 0) : Math.max(max, 0);
    veh.ptIdx[v] = 0;
    veh.nextLane[v] = -1;
    veh.stratTick[v] = 0;
    veh.reqLane[v] = -1;
    veh.lcFrom[v] = carry(veh.lcFrom[v]);
    veh.prev1[v] = carry(veh.prev1[v]);
    veh.prev2[v] = carry(veh.prev2[v]);
    veh.permit[v] = -1;
    veh.claimNext[v] = -1;
    veh.claimPrev[v] = -1;
  }
}

/** Remove vehicles that an edit left overlapping. The one in front stays. */
export function resolveOverlaps(w: World): void {
  const { veh, bk, g, counters } = w;
  const { start, eV, eS, eT } = bk;
  for (let l = 0; l < g.n; l++) {
    let frontRear = Infinity;
    for (let e = start[l]; e < start[l + 1]; e++) {
      if (eT[e] !== ENTRY_REAL) continue;
      const v = eV[e];
      if (eS[e] > frontRear - 0.1) {
        if (veh.alive[v]) {
          freeVehicle(veh, v);
          counters.removedByEdit++;
        }
        continue;
      }
      frontRear = eS[e] - veh.len[v];
    }
  }
}
