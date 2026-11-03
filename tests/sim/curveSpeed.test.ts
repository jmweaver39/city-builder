import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { fitCurve } from '../../src/core/curveFit';
import { drawChain } from '../../src/core/curveChain';
import { compileGraph } from '../../src/sim/compiled';
import { v } from './helpers';

/**
 * Speed a vehicle aims for along a chain of lanes, by distance, from the compiled
 * per-lane profiles, as dynamics.ts reads them (the sample just ahead).
 */
function targetSpeeds(net: RoadNetwork, segs: number[], laneIndex: number): number[] {
  const g = compileGraph(net);
  const graph = net.laneGraph;
  const out: number[] = [];
  for (const seg of segs) {
    const idx = graph.roadLanes.get(seg)![laneIndex];
    const a = g.profStart[idx];
    const b = g.profStart[idx + 1];
    const len = graph.lanes[idx].length;
    const steps = b - a - 1;
    for (let s = 0; s < len; s += 0.5) {
      const i = Math.min(steps, Math.floor((s * steps) / len) + 1);
      out.push(g.prof[a + i]);
    }
  }
  return out;
}

describe('speed through a fitted curve', () => {
  it('holds steady along a constant-radius arc made of several pieces', () => {
    const net = new RoadNetwork();
    // A 180 degree arc of radius 60 m, no spirals, so curvature is constant end to end.
    const fit = fitCurve({ start: v(0, 0), startDir: v(1, 0), end: v(0, 120), spirals: false });
    expect(fit.cubics.length).toBeGreaterThanOrEqual(4);
    const r = drawChain(net, { start: { kind: 'free', pos: v(0, 0) }, end: { kind: 'free', pos: v(0, 120) }, cubics: fit.cubics, roadType: 'street-2' });
    // Lane 1 drives a to b.
    const lane = net.roadType('street-2')!.lanes.findIndex((l) => l.dir === 1);
    const speeds = targetSpeeds(net, r.segments, lane);
    // Leave out the ends of the whole road, where the road itself starts and stops.
    const inner = speeds.slice(Math.floor(speeds.length * 0.1), Math.ceil(speeds.length * 0.9));
    const lo = Math.min(...inner);
    const hi = Math.max(...inner);
    // Curve-limited, not the 50 km/h limit, and steady across the joints.
    expect(hi).toBeLessThan(50 / 3.6 - 0.5);
    expect((hi - lo) / lo).toBeLessThan(0.01);
    // The speed a car can hold at that radius, sqrt(a / k), for this lane's own radius.
    const offset = net.roadType('street-2')!.lanes[lane].offset;
    expect(lo).toBeCloseTo(Math.sqrt(2.6 * (60 - offset)), 1);
  });
});
