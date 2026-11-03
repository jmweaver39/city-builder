import { describe, expect, it } from 'vitest';
import { RoadNetwork, checkNetworkInvariants } from '../../src/core';
import { buildRailDemo, TrainSim } from '../../src/rail';
import { countOverlaps } from './helpers';

describe('rail demo', () => {
  it('builds a valid scene where every line runs within seconds', () => {
    const net = new RoadNetwork();
    buildRailDemo(net);
    expect(checkNetworkInvariants(net)).toEqual([]);
    const sim = new TrainSim(net);
    for (const l of net.rail.lines) expect(sim.lineInfo(l.id)!.problem, l.name).toBeNull();
    expect(sim.graph.crossings).toHaveLength(1);
    sim.warm(30);
    const lines = new Set(sim.trains.map((t) => t.lineId));
    expect(lines.size).toBe(3);
    let worst = 0;
    for (let i = 0; i < 6000; i++) {
      sim.step();
      if (i % 5 === 0) worst = Math.max(worst, countOverlaps(sim));
    }
    expect(worst).toBe(0);
    expect(sim.stats().withdrawn).toBe(0);
    for (const l of net.rail.lines) expect(sim.lineInfo(l.id)!.running, l.name).toBeGreaterThan(0);
  });
});
