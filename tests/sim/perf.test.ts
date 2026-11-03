import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { Simulation } from '../../src/sim';
import { free } from './helpers';

/** A city-sized grid of avenues and streets, with auto gateways round the edge. */
function city() {
  const net = new RoadNetwork();
  const span = 1800;
  const spacing = 300;
  const roads: { a: number; horizontal: boolean }[] = [];
  for (let p = -span + spacing; p < span; p += spacing) {
    roads.push({ a: p, horizontal: true }, { a: p, horizontal: false });
  }
  net.batch(() => {
    roads.forEach((r, i) => {
      const type = i % 4 < 2 ? 'avenue-4' : 'street-4';
      if (r.horizontal) net.drawRoad({ start: free(-span, r.a), end: free(span, r.a), roadType: type });
      else net.drawRoad({ start: free(r.a, -span), end: free(r.a, span), roadType: type });
    });
  });
  return net;
}

describe('performance', () => {
  it('5000 vehicles on a large network', () => {
    const net = city();
    net.setTraffic({ autoGatewayRatePerLane: 900, despawnStuckSec: 0 });
    const graph = net.laneGraph;
    const sim = new Simulation(net, 81);
    let steps = 0;
    while (sim.stats().active < 5000 && steps < 30000) {
      sim.step();
      steps++;
    }
    const active = sim.stats().active;
    const t0 = performance.now();
    const n = 1000;
    for (let i = 0; i < n; i++) sim.step();
    const avg = (performance.now() - t0) / n;
    const s = sim.stats();
    console.log(
      `perf: ${graph.lanes.length} lanes, ${net.segments.length} segments, ${net.nodes.length} nodes; ` +
        `warm-up ${steps} steps; ${active}->${s.active} vehicles; ${avg.toFixed(3)} ms/step; ` +
        `flow ${s.flow.toFixed(2)}, jammed ${s.jammed}, arrived ${s.arrivedTotal}`,
    );
    expect(active).toBeGreaterThanOrEqual(5000);
    // Enforced loosely so a busy machine does not fail the suite. The target is 4 ms.
    expect(avg).toBeLessThan(12);
  }, 300000);
});
