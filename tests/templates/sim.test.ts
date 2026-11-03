import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { Simulation } from '../../src/sim';
import { TEMPLATES, stampTemplate } from '../../src/templates';
import { entryLanes } from './helpers';

/** Each stub feeds this share of the auto gateway default. */
const MODERATE = 0.7;
const WINDOW_STEPS = 3000; // Five simulated minutes.
const WINDOWS = 4;

function scenario(id: string, params: Record<string, number>, seed: number) {
  const net = new RoadNetwork();
  const stamp = stampTemplate(net, id, params, { pos: { x: 0, y: 0, z: 0 }, rotation: 0, elevation: 0 });
  expect(stamp.problems).toEqual([]);
  net.setTraffic({ multiplier: MODERATE });
  const lanes = stamp.ports.reduce((n, p) => n + (p.flow === 'out' ? 0 : entryLanes(net, p.nodeId).length), 0);
  const demandPerWindow = (lanes * net.traffic.autoGatewayRatePerLane * MODERATE) / 12;
  const sim = new Simulation(net, seed);
  const arrivals: number[] = [];
  let last = 0;
  for (let w = 0; w < WINDOWS; w++) {
    for (let i = 0; i < WINDOW_STEPS; i++) sim.step();
    const total = sim.stats().arrivedTotal;
    arrivals.push(total - last);
    last = total;
  }
  return { arrivals, demandPerWindow, stats: sim.stats() };
}

describe.each(TEMPLATES.map((t) => [t.id] as const))('%s under traffic', (id) => {
  it.each([[1], [2]])('flows for 20 simulated minutes, seed %i', (seed) => {
    const { arrivals, demandPerWindow, stats } = scenario(id, {}, seed);
    // Vehicles need a few minutes to fill the network, so judge the first window softly.
    expect(arrivals[0]).toBeGreaterThan(demandPerWindow * 0.3);
    for (const count of arrivals.slice(1)) expect(count).toBeGreaterThan(demandPerWindow * 0.6);
    // Gridlock shows up as throughput falling away while vehicles pile up. Small
    // stamps see few vehicles per window, so leave room for Poisson scatter.
    expect(arrivals[WINDOWS - 1]).toBeGreaterThan(Math.max(...arrivals) * 0.55);
    expect(stats.active).toBeLessThan(demandPerWindow * 2);
    expect(stats.despawnedStuck).toBeLessThanOrEqual(Math.ceil(stats.arrivedTotal * 0.005));
    expect(stats.queuedAtSources ?? 0).toBeLessThan(demandPerWindow * 0.25);
  });
});

describe('collector-distributor roads under traffic', () => {
  it('flows for 20 simulated minutes', () => {
    const { arrivals, demandPerWindow, stats } = scenario('cloverleaf', { collector: 1 }, 3);
    for (const count of arrivals.slice(1)) expect(count).toBeGreaterThan(demandPerWindow * 0.6);
    expect(stats.despawnedStuck).toBe(0);
  });
});
