import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { buildRoundabout, DEFAULT_ROUNDABOUT, findRoundabouts, planRoundabout, type RoundaboutParams } from '../../src/core/roundabout';
import { Simulation } from '../../src/sim';
import { expectFiniteState, free, newSweep, run, sweepCrossings, worstLaneOverlap } from './helpers';

/** A 4-way of `type` with 400 m arms, replaced by a roundabout built the way the tool builds it. */
function fourArm(type: string, params: Partial<RoundaboutParams>): RoadNetwork {
  const net = new RoadNetwork();
  net.drawRoad({ start: free(-400, 0), end: free(400, 0), roadType: type });
  net.drawRoad({ start: free(0, -400), end: free(0, 400), roadType: type });
  const node = net.nodes.find((n) => n.segments.length === 4)!.id;
  const plan = planRoundabout(net, { x: 0, y: 0, z: 0 }, { ...DEFAULT_ROUNDABOUT, ...params }, node);
  expect(plan.reasons).toEqual([]);
  buildRoundabout(net, plan);
  expect(findRoundabouts(net)[0].arms).toHaveLength(4);
  return net;
}

/** Twenty simulated minutes in five-minute windows. Returns arrivals per window. */
function twentyMinutes(net: RoadNetwork, seed: number) {
  const sim = new Simulation(net, seed);
  const sweep = newSweep();
  const windows: number[] = [];
  const ringTraffic: number[] = [];
  const ring = findRoundabouts(net)[0].segments;
  let last = 0;
  for (let i = 0; i < 4; i++) {
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
    ringTraffic.push(ring.reduce((s, id) => s + sim.segmentTraffic(id).flowPerHour, 0));
  }
  return { sim, sweep, windows, ringTraffic };
}

describe('roundabout built by the tool, under heavy traffic', () => {
  const cases: { name: string; type: string; params: Partial<RoundaboutParams>; rate: number; floor: number }[] = [
    { name: 'single-lane, yield at entries', type: 'street-2', params: { radius: 28, lanes: 1 }, rate: 700, floor: 110 },
    { name: 'two-lane, yield at entries', type: 'avenue-4', params: { radius: 38, lanes: 2 }, rate: 600, floor: 140 },
    { name: 'two-lane, signals', type: 'avenue-4', params: { radius: 38, lanes: 2, priority: 'signal' }, rate: 600, floor: 110 },
  ];
  for (const c of cases) {
    it(`${c.name}: 20 minutes of sustained arrivals with no gridlock`, () => {
      const net = fourArm(c.type, c.params);
      net.setTraffic({ autoGatewayRatePerLane: c.rate });
      const { sim, sweep, windows, ringTraffic } = twentyMinutes(net, 71);
      const s = sim.stats();
      console.log(`roundabout ${c.name}`, { windows, ringFlowPerHour: ringTraffic.map(Math.round), stuck: s.despawnedStuck, active: s.active, queued: s.queuedAtSources });
      // Sustained arrivals in every window, with no slide from the peak, which is how gridlock shows.
      // The first window is warm-up: cars need 400 m to reach a sink.
      expect(windows[0]).toBeGreaterThan(c.floor * 0.6);
      for (const w of windows.slice(1)) expect(w).toBeGreaterThan(c.floor);
      const peak = Math.max(...windows);
      for (const w of windows.slice(1)) expect(w).toBeGreaterThan(0.8 * peak);
      expect(s.despawnedStuck).toBeLessThanOrEqual(2);
      expect(sweep.sample).toEqual([]);
      // Traffic really uses the ring.
      expect(Math.min(...ringTraffic)).toBeGreaterThan(200);
    });
  }
});
