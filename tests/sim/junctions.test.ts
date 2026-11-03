import { describe, expect, it } from 'vitest';
import { effectiveControl, RoadNetwork } from '../../src/core';
import { Simulation } from '../../src/sim';
import { crossroads, expectFiniteState, newSweep, run, sweepCrossings, v, worstLaneOverlap } from './helpers';

function runCrossing(sim: Simulation, seconds: number) {
  const sweep = newSweep();
  run(sim, seconds, () => {
    sweepCrossings(sim, sweep);
    expect(worstLaneOverlap(sim)).toBe(0);
  });
  return sweep;
}

describe('4-way junctions', () => {
  it('stop signs: no crossing conflicts, everyone gets through', () => {
    const { net, hub, segs } = crossroads('street-2');
    net.setJunctionControl(hub, { mode: 'priority' });
    for (const s of segs) net.setSign(hub, s, 'stop');
    net.setTraffic({ autoGatewayRatePerLane: 250 });
    const sim = new Simulation(net, 21);
    const sweep = runCrossing(sim, 1800);
    expect(sweep.sample).toEqual([]);
    // Demand: 4 lanes in, 250 an hour each, for half an hour, is 500.
    expect(sim.stats().arrivedTotal).toBeGreaterThan(0.85 * 500);
    expect(sim.stats().despawnedStuck).toBe(0);
  });

  it('all-way stop: first come first served, no clashes', () => {
    const { net, hub } = crossroads('street-2');
    net.setJunctionControl(hub, { mode: 'allStop' });
    net.setTraffic({ autoGatewayRatePerLane: 250 });
    const sim = new Simulation(net, 22);
    const sweep = runCrossing(sim, 1800);
    expect(sweep.sample).toEqual([]);
    expect(sim.stats().arrivedTotal).toBeGreaterThan(0.85 * 500);
    expect(sim.stats().despawnedStuck).toBe(0);
  });

  it('priority: main road flows, side road finds gaps, no clashes', () => {
    const net = new RoadNetwork();
    const hub = net.addNode(v(0, 0));
    const e = net.addNode(v(400, 0));
    const w = net.addNode(v(-400, 0));
    const s = net.addNode(v(0, 300));
    const n = net.addNode(v(0, -300));
    net.addSegment(hub, e, { roadType: 'street-4' });
    net.addSegment(hub, w, { roadType: 'street-4' });
    net.addSegment(hub, s, { roadType: 'street-2' });
    net.addSegment(hub, n, { roadType: 'street-2' });
    expect(effectiveControl(net, hub).kind).toBe('priority');
    net.setTraffic({ autoGatewayRatePerLane: 300 });
    const sim = new Simulation(net, 23);
    const sweep = runCrossing(sim, 1800);
    expect(sweep.sample).toEqual([]);
    const side = sim.segmentTraffic(net.segments[2].id);
    expect(side.flowPerHour).toBeGreaterThan(50);
    // Demand: 6 lanes in at 300 an hour for half an hour is 900. The side roads run at
    // capacity here, so some of it is still queueing at the end.
    expect(sim.stats().arrivedTotal).toBeGreaterThan(0.8 * 900);
    expect(sim.stats().despawnedStuck).toBe(0);
  });

  it('signals: no clashes under heavy load', () => {
    const { net, hub } = crossroads('avenue-4');
    expect(effectiveControl(net, hub).kind).toBe('signal');
    net.setTraffic({ autoGatewayRatePerLane: 500 });
    const sim = new Simulation(net, 24);
    const sweep = runCrossing(sim, 1800);
    expect(sweep.sample).toEqual([]);
    // Demand: 8 lanes in at 500 an hour for half an hour is 2000, a third of it turning
    // left across heavy opposing flow on a shared lane, which is what limits capacity.
    expect(sim.stats().arrivedTotal).toBeGreaterThan(0.6 * 2000);
    expect(sim.stats().despawnedStuck).toBe(0);
  });

  it.each([['street-2'], ['street-4'], ['avenue-4']])('auto control on %s stays clear and moving when saturated', (type) => {
    const { net } = crossroads(type);
    net.setTraffic({ autoGatewayRatePerLane: 900 });
    const sim = new Simulation(net, 25);
    let last = 0;
    const sweep = newSweep();
    for (let w = 0; w < 4; w++) {
      run(sim, 300, () => {
        sweepCrossings(sim, sweep);
        expectFiniteState(sim);
      });
      const now = sim.stats().arrivedTotal;
      expect(now).toBeGreaterThan(last + 20);
      last = now;
    }
    expect(sweep.sample).toEqual([]);
    expect(sim.stats().despawnedStuck).toBe(0);
  });

  it('does not block the box: nobody stops on a crossing when the exit is full', () => {
    // A signal holds a queue on the east arm, right back into a priority junction.
    const net = new RoadNetwork();
    const hub = net.addNode(v(0, 0));
    const near = net.addNode(v(90, 0));
    const far = net.addNode(v(400, 0));
    const west = net.addNode(v(-300, 0));
    const north = net.addNode(v(0, -300));
    const south = net.addNode(v(0, 300));
    const c1 = net.addNode(v(90, -300));
    const c2 = net.addNode(v(90, 300));
    net.addSegment(west, hub, { roadType: 'street-2' });
    net.addSegment(hub, near, { roadType: 'street-2' });
    net.addSegment(near, far, { roadType: 'street-2' });
    net.addSegment(north, hub, { roadType: 'street-2' });
    net.addSegment(hub, south, { roadType: 'street-2' });
    net.addSegment(near, c1, { roadType: 'street-2' });
    net.addSegment(near, c2, { roadType: 'street-2' });
    net.setJunctionControl(near, { mode: 'allStop' });
    net.setJunctionControl(hub, { mode: 'priority' });
    net.setTraffic({ autoGatewayRatePerLane: 800 });
    const sim = new Simulation(net, 26);
    const conn = new Set(net.laneGraph.connectorsAt.get(hub)!);
    let parkedOnCrossing = 0;
    run(sim, 1200, () => {
      const { veh, g } = sim.state;
      for (let i = 0; i < veh.liveCount; i++) {
        const k = veh.live[i];
        const l = veh.lane[k];
        if (!conn.has(l) || g.lastCross[l] < 0) continue;
        if (veh.v[k] < 0.1 && veh.s[k] > 1 && veh.s[k] - veh.len[k] < g.lastCross[l]) parkedOnCrossing++;
      }
    });
    // Vehicle-steps. Brief stops can happen; a blocked box would rack up tens of thousands.
    expect(parkedOnCrossing).toBeLessThan(600);
    expect(sim.stats().arrivedTotal).toBeGreaterThan(200);
  });
});
