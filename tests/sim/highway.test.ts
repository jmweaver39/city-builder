import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { Simulation } from '../../src/sim';
import { expectFiniteState, run, v, worstLaneOverlap } from './helpers';

/** A one-way highway with a right-hand off-ramp at x = 0. */
function offRampNet(type = 'highway-3', length = 1500) {
  const net = new RoadNetwork();
  const a = net.addNode(v(-length, 0));
  const n = net.addNode(v(0, 0));
  const b = net.addNode(v(800, 0));
  const r = net.addNode(v(420, 260));
  const inSeg = net.addSegment(a, n, { roadType: type });
  const outSeg = net.addSegment(n, b, { roadType: type });
  const rampSeg = net.addSegment(n, r, { roadType: 'ramp-1', c1: v(150, 0), c2: v(300, 150) });
  return { net, a, n, b, r, inSeg, outSeg, rampSeg };
}

/** A one-way highway with a right-hand on-ramp at x = 0. */
function onRampNet(type = 'highway-2') {
  const net = new RoadNetwork();
  const a = net.addNode(v(-1000, 0));
  const n = net.addNode(v(0, 0));
  const b = net.addNode(v(1200, 0));
  const r = net.addNode(v(-420, 260));
  const mainIn = net.addSegment(a, n, { roadType: type });
  const mainOut = net.addSegment(n, b, { roadType: type });
  const ramp = net.addSegment(r, n, { roadType: 'ramp-1', c1: v(-300, 150), c2: v(-150, 0) });
  return { net, a, n, b, r, mainIn, mainOut, ramp };
}

describe('off-ramp', () => {
  function exitRun(flowPerHour: number, seed: number) {
    const { net, a, b, r } = offRampNet();
    net.setTraffic({ autoGateways: false });
    const src = net.addEndpoint({ kind: 'gateway', nodeId: a, ratePerHour: flowPerHour, attraction: 0 });
    const main = net.addEndpoint({ kind: 'gateway', nodeId: b, ratePerHour: 0, attraction: 3 });
    const exit = net.addEndpoint({ kind: 'gateway', nodeId: r, ratePerHour: 0, attraction: 1 });
    const sim = new Simulation(net, seed);
    run(sim, 1200, () => {
      expectFiniteState(sim);
      expect(worstLaneOverlap(sim)).toBe(0);
    });
    return { sim, src, main, exit };
  }

  it('takes more than 90% off at the ramp first time at moderate flow', () => {
    const { sim, main, exit } = exitRun(3000, 31);
    const e = sim.endpointStats(exit)!;
    const m = sim.endpointStats(main)!;
    const s = sim.stats();
    // Most of the 25% bound for the ramp left there; none of them gave up.
    expect(e.destined).toBeGreaterThan(100);
    expect(e.arrived / e.destined).toBeGreaterThan(0.9);
    expect(s.missedExits ?? 0).toBeLessThan(e.destined * 0.1);
    expect(m.arrived).toBeGreaterThan(300);
    expect(s.despawnedStuck).toBe(0);
  });

  it('gets to the exit lane from the far lanes in time, ending up in the right lane', () => {
    const { sim, exit } = exitRun(3600, 32);
    expect(sim.endpointStats(exit)!.arrived).toBeGreaterThan(100);
  });

  it('a short approach still works: the change happens late, not never', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-450, 0));
    const n = net.addNode(v(0, 0));
    const b = net.addNode(v(600, 0));
    const r = net.addNode(v(420, 260));
    net.addSegment(a, n, { roadType: 'highway-3' });
    net.addSegment(n, b, { roadType: 'highway-3' });
    net.addSegment(n, r, { roadType: 'ramp-1', c1: v(150, 0), c2: v(300, 150) });
    net.setTraffic({ autoGateways: false });
    net.addEndpoint({ kind: 'gateway', nodeId: a, ratePerHour: 2400, attraction: 0 });
    net.addEndpoint({ kind: 'gateway', nodeId: b, ratePerHour: 0, attraction: 1 });
    const exit = net.addEndpoint({ kind: 'gateway', nodeId: r, ratePerHour: 0, attraction: 1 });
    const sim = new Simulation(net, 33);
    run(sim, 900, () => expect(worstLaneOverlap(sim)).toBe(0));
    const e = sim.endpointStats(exit)!;
    expect(e.arrived / e.destined).toBeGreaterThan(0.8);
    expect(sim.stats().despawnedStuck).toBe(0);
  });

  it('a car that misses a junction with another way round carries on and reroutes', () => {
    // The ramp can also be reached from a second exit further on. Traffic bound for it
    // that misses the first turn must not stop dead on the mainline.
    const net = new RoadNetwork();
    const a = net.addNode(v(-400, 0));
    const n1 = net.addNode(v(0, 0));
    const n2 = net.addNode(v(600, 0));
    const b = net.addNode(v(1200, 0));
    const d = net.addNode(v(300, 500));
    const link = net.addNode(v(300, 250));
    net.addSegment(a, n1, { roadType: 'highway-2' });
    net.addSegment(n1, n2, { roadType: 'highway-2' });
    net.addSegment(n2, b, { roadType: 'highway-2' });
    net.addSegment(n1, link, { roadType: 'ramp-1', c1: v(150, 0), c2: v(250, 100) });
    net.addSegment(n2, link, { roadType: 'ramp-1', c1: v(750, 80), c2: v(450, 250) });
    net.addSegment(link, d, { roadType: 'ramp-1' });
    net.setTraffic({ autoGateways: false });
    net.addEndpoint({ kind: 'gateway', nodeId: a, ratePerHour: 2800, attraction: 0 });
    net.addEndpoint({ kind: 'gateway', nodeId: b, ratePerHour: 0, attraction: 1 });
    const exit = net.addEndpoint({ kind: 'gateway', nodeId: d, ratePerHour: 0, attraction: 1 });
    const sim = new Simulation(net, 34);
    let stoppedOnMainline = 0;
    const main = new Set<number>();
    for (const s of net.segments.slice(0, 2)) for (const l of net.laneGraph.roadLanes.get(s.id)!) main.add(l);
    run(sim, 900, () => {
      const { veh } = sim.state;
      for (let i = 0; i < veh.liveCount; i++) {
        const k = veh.live[i];
        if (main.has(veh.lane[k]) && veh.v[k] < 0.5) stoppedOnMainline++;
      }
    });
    expect(sim.endpointStats(exit)!.arrived).toBeGreaterThan(100);
    expect(stoppedOnMainline).toBe(0);
  });
});

describe('on-ramp', () => {
  it('keeps both feeders moving at heavy flow with no deadlock', () => {
    const { net, a, b, r, mainIn, ramp } = onRampNet();
    net.setTraffic({ autoGateways: false });
    net.addEndpoint({ kind: 'gateway', nodeId: a, ratePerHour: 3400, attraction: 0 });
    net.addEndpoint({ kind: 'gateway', nodeId: r, ratePerHour: 1400, attraction: 0 });
    const sinks = net.addEndpoint({ kind: 'gateway', nodeId: b, ratePerHour: 0, attraction: 1 });
    const sim = new Simulation(net, 41);
    run(sim, 300);
    let last = sim.endpointStats(sinks)!.arrived;
    const mainFlows: number[] = [];
    const rampFlows: number[] = [];
    for (let i = 0; i < 6; i++) {
      run(sim, 300, () => {
        expectFiniteState(sim);
        expect(worstLaneOverlap(sim)).toBe(0);
      });
      const now = sim.endpointStats(sinks)!.arrived;
      expect(now - last).toBeGreaterThan(150);
      last = now;
      mainFlows.push(sim.segmentTraffic(mainIn).flowPerHour);
      rampFlows.push(sim.segmentTraffic(ramp).flowPerHour);
    }
    expect(Math.min(...mainFlows)).toBeGreaterThan(600);
    expect(Math.min(...rampFlows)).toBeGreaterThan(200);
    expect(sim.stats().despawnedStuck).toBe(0);
  });

  it('merges 3 + ramp without overlaps at moderate flow, mainline nearly free', () => {
    const { net, a, b, r, mainOut } = onRampNet('highway-3');
    net.setTraffic({ autoGateways: false });
    net.addEndpoint({ kind: 'gateway', nodeId: a, ratePerHour: 2400, attraction: 0 });
    net.addEndpoint({ kind: 'gateway', nodeId: r, ratePerHour: 500, attraction: 0 });
    net.addEndpoint({ kind: 'gateway', nodeId: b, ratePerHour: 0, attraction: 1 });
    const sim = new Simulation(net, 42);
    run(sim, 900, () => expect(worstLaneOverlap(sim)).toBe(0));
    expect(sim.segmentTraffic(mainOut).speedRatio).toBeGreaterThan(0.6);
    expect((sim.stats().arrivedTotal / 900) * 3600).toBeGreaterThan(2300);
  });
});

