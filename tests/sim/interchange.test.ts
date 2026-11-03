import { describe, expect, it } from 'vitest';
import type { RoadNetwork } from '../../src/core';
import { Simulation } from '../../src/sim';
import { expectFiniteState, newSweep, run, sweepCrossings, worstLaneOverlap } from './helpers';
import { diamond, roundabout } from './scenarios';

/** Thirty simulated minutes in five-minute windows. Returns arrivals per window. */
function endurance(net: RoadNetwork, seed: number) {
  const sim = new Simulation(net, seed);
  const sweep = newSweep();
  const windows: number[] = [];
  let last = 0;
  for (let i = 0; i < 6; i++) {
    run(sim, 300, () => {
      if (sim.state.tick % 5 === 0) {
        sweepCrossings(sim, sweep);
        expect(worstLaneOverlap(sim)).toBe(0);
        expectFiniteState(sim);
      }
    });
    const now = sim.stats().arrivedTotal;
    windows.push(now - last);
    last = now;
  }
  return { sim, sweep, windows };
}

describe('roundabout', () => {
  it('runs 30 minutes at heavy traffic with no gridlock', () => {
    const net = roundabout();
    net.setTraffic({ autoGatewayRatePerLane: 650 });
    const { sim, sweep, windows } = endurance(net, 51);
    const s = sim.stats();
    console.log('roundabout windows', windows, 'stuck', s.despawnedStuck, 'active', s.active, 'queued', s.queuedAtSources);
    for (const w of windows) expect(w).toBeGreaterThan(100);
    const peak = Math.max(...windows);
    for (const w of windows.slice(3)) expect(w).toBeGreaterThan(0.75 * peak);
    expect(s.despawnedStuck).toBeLessThanOrEqual(2);
    expect(sweep.sample).toEqual([]);
  });

  it('copes with overload: 4x traffic keeps moving', () => {
    const net = roundabout(35, 300);
    net.setTraffic({ autoGatewayRatePerLane: 300, multiplier: 4 });
    const { sim, windows } = endurance(net, 52);
    const s = sim.stats();
    console.log('roundabout overload', windows, 'stuck', s.despawnedStuck, 'queued', s.queuedAtSources);
    for (const w of windows) expect(w).toBeGreaterThan(100);
    expect(s.despawnedStuck).toBeLessThanOrEqual(5);
  });
});

describe('diamond interchange', () => {
  it('runs 30 minutes at heavy traffic with no gridlock', () => {
    const net = diamond();
    net.setTraffic({ autoGatewayRatePerLane: 500 });
    const { sim, sweep, windows } = endurance(net, 53);
    const s = sim.stats();
    console.log('diamond windows', windows, 'stuck', s.despawnedStuck, 'active', s.active, 'queued', s.queuedAtSources, 'missed', s.missedExits);
    // The first window is warm-up: vehicles need a kilometre to reach a sink.
    for (const w of windows) expect(w).toBeGreaterThan(150);
    // No decay: gridlock shows as throughput sliding away from its peak.
    const peak = Math.max(...windows);
    for (const w of windows.slice(3)) expect(w).toBeGreaterThan(0.75 * peak);
    expect(s.despawnedStuck).toBeLessThanOrEqual(2);
    expect(sweep.sample).toEqual([]);
  });

  it('uses the ramps: traffic moves between the street and the highway', () => {
    const net = diamond();
    net.setTraffic({ autoGatewayRatePerLane: 400 });
    const sim = new Simulation(net, 54);
    const rampSegs = net.segments.filter((s) => s.roadType === 'ramp-1').map((s) => s.id);
    run(sim, 900);
    expect(rampSegs.length).toBe(4);
    for (const r of rampSegs) expect(sim.segmentTraffic(r).flowPerHour).toBeGreaterThan(30);
  });
});
