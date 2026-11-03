import { expect } from 'vitest';
import {
  RoadNetwork,
  checkNetworkInvariants,
  closestPointOnCubic,
  dist,
  type GLane,
  type Id,
  type LaneGraph,
  type RoadAnchor,
  type Vec3,
} from '../../src/core';

export const v = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });
export const free = (x: number, z: number, y = 0): RoadAnchor => ({ kind: 'free', pos: v(x, z, y) });
export const atNode = (id: Id): RoadAnchor => ({ kind: 'node', id });
export const onSeg = (id: Id, t: number): RoadAnchor => ({ kind: 'segment', id, t });

export function expectClean(net: RoadNetwork): void {
  expect(checkNetworkInvariants(net)).toEqual([]);
}

export function lanePoint(lane: GLane, i: number): Vec3 {
  return { x: lane.pts[i * 3], y: lane.pts[i * 3 + 1], z: lane.pts[i * 3 + 2] };
}

export const firstPoint = (lane: GLane): Vec3 => lanePoint(lane, 0);
export const lastPoint = (lane: GLane): Vec3 => lanePoint(lane, lane.cum.length - 1);

function direction(a: Vec3, b: Vec3): Vec3 {
  const l = dist(a, b);
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l, z: (b.z - a.z) / l };
}

export const startDir = (lane: GLane): Vec3 => direction(lanePoint(lane, 0), lanePoint(lane, 1));
export const endDir = (lane: GLane): Vec3 => {
  const n = lane.cum.length;
  return direction(lanePoint(lane, n - 2), lanePoint(lane, n - 1));
};

export function degreesBetween(a: Vec3, b: Vec3): number {
  const d = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
  return (Math.acos(d) * 180) / Math.PI;
}

/** Each connector meets the road lanes at both ends, in position and direction. */
export function expectConnectorsContinuous(graph: LaneGraph, nodeId: Id, maxDegrees = 3): void {
  for (const idx of graph.connectorsAt.get(nodeId) ?? []) {
    const c = graph.lanes[idx];
    const from = graph.lanes[c.fromLane];
    const to = graph.lanes[c.toLane];
    expect(dist(firstPoint(c), lastPoint(from)), `${c.key} start gap`).toBeLessThan(0.01);
    expect(dist(lastPoint(c), firstPoint(to)), `${c.key} end gap`).toBeLessThan(0.01);
    expect(degreesBetween(endDir(from), startDir(c)), `${c.key} start tangent`).toBeLessThan(maxDegrees);
    expect(degreesBetween(endDir(c), startDir(to)), `${c.key} end tangent`).toBeLessThan(maxDegrees);
  }
}

/** Road lanes in the graph that lead nowhere. */
export function lanesWithoutExit(graph: LaneGraph, kind: 'drive' | 'all' = 'drive'): GLane[] {
  return graph.lanes.filter((l) => l.next.length === 0 && (kind === 'all' || l.vehicleKind === 'drive'));
}

/** Connectors grouped as "from-segment>to-segment". */
export function movementKeys(graph: LaneGraph, nodeId: Id): Set<string> {
  const out = new Set<string>();
  for (const idx of graph.connectorsAt.get(nodeId) ?? []) {
    const c = graph.lanes[idx];
    out.add(`${graph.lanes[c.fromLane].segmentId}>${graph.lanes[c.toLane].segmentId}`);
  }
  return out;
}

/** Largest distance from sample points of a curve to the nearest of the given segments. */
export function maxDeviation(net: RoadNetwork, ids: Id[], original: (t: number) => Vec3, samples = 400): number {
  let worst = 0;
  for (let i = 0; i <= samples; i++) {
    const p = original(i / samples);
    let best = Infinity;
    for (const id of ids) best = Math.min(best, closestPointOnCubic(net.cubicOf(id), p, false).distance);
    if (best > worst) worst = best;
  }
  return worst;
}

/** Small deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
