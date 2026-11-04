import { describe, expect, it } from 'vitest';
import { effectiveControl, RoadNetwork, type JunctionControl } from '../../src/core';
import { Simulation } from '../../src/sim';
import { expectFiniteState, free, newSweep, run, sweepCrossings, worstLaneOverlap } from './helpers';

/** An avenue crossing a street at grade, away from the origin, as drawn with the road tool. */
function avenueByStreet(mode?: JunctionControl['mode']) {
  const net = new RoadNetwork();
  net.drawRoad({ start: free(1050, 1500), end: free(1950, 1500), roadType: 'avenue-4' });
  net.drawRoad({ start: free(1500, 1050), end: free(1500, 1950), roadType: 'street-2' });
  const hub = net.nodes.find((n) => Math.abs(n.pos.x - 1500) < 1 && Math.abs(n.pos.z - 1500) < 1)!;
  if (mode) net.setJunctionControl(hub.id, { mode });
  return { net, hub: hub.id };
}

/** Twenty simulated minutes in five-minute windows, checking bodies as it goes. */
function soak(net: RoadNetwork, seed: number) {
  const sim = new Simulation(net, seed);
  const sweep = newSweep();
  const windows: number[] = [];
  let last = 0;
  for (let i = 0; i < 4; i++) {
    run(sim, 300, () => {
      if (sim.state.tick % 5 === 0) {
        sweepCrossings(sim, sweep);
        expect(worstLaneOverlap(sim)).toBe(0);
      }
    });
    const now = sim.stats().arrivedTotal;
    windows.push(now - last);
    last = now;
  }
  expectFiniteState(sim);
  return { s: sim.stats(), sweep, windows };
}

describe('avenue by street crossing', () => {
  // Heavy traffic: past what the junction can take, so queues build on every arm, lane
  // changes into the turn lanes happen close to the line and long vehicles turn beside
  // queues. Any cycle of drivers waiting on each other shows up as vehicles cleared as
  // stuck. One was a permit kept by a driver that someone had changed lanes in front of.
  for (const [mode, seed, rate] of [
    [undefined, 3, 400],
    [undefined, 7, 650],
    ['signal', 3, 650],
  ] as const) {
    it(`runs 20 minutes at heavy traffic with nobody stuck (${mode ?? 'auto'}, seed ${seed})`, () => {
      const { net, hub } = avenueByStreet(mode);
      if (!mode) expect(effectiveControl(net, hub).kind).toBe('priority');
      net.setTraffic({ autoGatewayRatePerLane: rate });
      const { s, sweep, windows } = soak(net, seed);
      expect(s.despawnedStuck).toBe(0);
      expect(s.collisions ?? 0).toBe(0);
      expect(sweep.sample).toEqual([]);
      // No decay: a junction locking up shows as arrivals sliding away from their peak.
      const peak = Math.max(...windows);
      for (const w of windows.slice(1)) expect(w).toBeGreaterThan(0.75 * peak);
    });
  }
});
