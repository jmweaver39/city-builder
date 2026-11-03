import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { buildStarterScene } from '../../src/app/starter';
import { Simulation } from '../../src/sim/Simulation';

describe('Starter scene with the real simulation', () => {
  it('has vehicles on the road after the warm-up main.ts runs', () => {
    const net = new RoadNetwork();
    buildStarterScene(net);
    const sim = new Simulation(net);
    for (let i = 0; i < 400; i++) sim.step();
    expect(sim.stats().active).toBeGreaterThanOrEqual(5);
  });

  it('has traffic moving soon after loading, and it reaches its destinations', () => {
    const net = new RoadNetwork();
    buildStarterScene(net);
    const sim = new Simulation(net);
    const seen: number[] = [];
    for (let s = 1; s <= 180; s++) {
      for (let i = 0; i < 10; i++) sim.step();
      if (s % 30 === 0) seen.push(sim.stats().active);
    }
    const stats = sim.stats();
    expect(seen[0]).toBeGreaterThan(5);
    expect(stats.arrivedTotal).toBeGreaterThan(10);
    expect(stats.despawnedStuck).toBe(0);
    expect(stats.flow).toBeGreaterThan(0.4);
  }, 60000);
});
