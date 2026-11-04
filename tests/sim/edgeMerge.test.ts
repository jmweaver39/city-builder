import { describe, expect, it } from 'vitest';
import { RoadNetwork, makeAttach, type Id } from '../../src/core';
import { Simulation } from '../../src/sim';
import { applyRampLaneChange } from '../../src/tools/edgeMergeOps';
import { setJointAlign } from '../../src/tools/endAlign';
import { atNode, expectFiniteState, free, run, v, worstLaneOverlap } from './helpers';

/** A 3-lane highway along x with an edge-merged ramp at x = 0. */
function build(on: boolean, type = 'highway-3') {
  const net = new RoadNetwork();
  net.drawRoad({ start: free(-1400, 0), end: free(1400, 0), roadType: type });
  const near = net.nearestSegment(v(0, 0))!;
  const attach = { ...makeAttach(0, v(1, 0), v(1, 0), 1), edge: {} };
  const anchor = { kind: 'segment' as const, id: near.segmentId, t: near.t };
  const r = on
    ? net.drawRoad({ start: free(-500, 200), end: anchor, c1: v(-300, 70), c2: v(-150, 9), roadType: 'ramp-1', endAttach: attach })
    : net.drawRoad({ start: anchor, end: free(500, 200), c1: v(150, 9), c2: v(300, 70), roadType: 'ramp-1', startAttach: attach });
  const node = on ? r.nodes[r.nodes.length - 1] : r.nodes[0];
  return { net, node };
}

function gateways(net: RoadNetwork, on: boolean, main: number, ramp: number) {
  net.setTraffic({ autoGateways: false });
  const pos = (id: Id) => net.getNode(id)!.pos;
  const ends = net.deadEnds();
  const west = ends.find((n) => pos(n).x < -1000)!;
  const east = ends.find((n) => pos(n).x > 1000)!;
  const side = ends.find((n) => Math.abs(pos(n).z) > 100)!;
  net.addEndpoint({ kind: 'gateway', nodeId: west, ratePerHour: main, attraction: 0 });
  const e = net.addEndpoint({ kind: 'gateway', nodeId: east, ratePerHour: 0, attraction: 3 });
  const r = on ? net.addEndpoint({ kind: 'gateway', nodeId: side, ratePerHour: ramp, attraction: 0 }) : net.addEndpoint({ kind: 'gateway', nodeId: side, ratePerHour: 0, attraction: 1 });
  return { east: e, ramp: r };
}

/**
 * Run and check every step. Lane overlap is checked off the lanes being changed into:
 * two drivers starting a lane change from either side in the same step count as on one
 * lane while still beside each other, as on any busy highway.
 */
function drive(net: RoadNetwork, seed: number, seconds: number, strict = true) {
  const sim = new Simulation(net, seed);
  run(sim, seconds, () => {
    expectFiniteState(sim);
    if (strict) expect(worstLaneOverlap(sim)).toBeLessThan(0.5);
  });
  return sim;
}

describe('edge merge in the sim', () => {
  for (const seed of [3, 11]) {
    it(`on-ramp at heavy traffic merges into the edge lane with nobody stuck (seed ${seed})`, () => {
      const { net, node } = build(true);
      expect(net.nodeGeom(node)!.kind).toBe('merge');
      const g = gateways(net, true, 3600, 1000);
      const sim = drive(net, seed, 900, false);
      const s = sim.stats();
      expect(s.despawnedStuck).toBe(0);
      expect(s.safetyStops ?? 0).toBeLessThanOrEqual(2);
      // Ramp traffic gets on: arrivals past the merge well beyond what the highway alone delivers early on.
      expect(sim.endpointStats(g.east)!.arrived).toBeGreaterThan(550);
    });
  }

  it('off-ramp at heavy traffic: exits leave from the edge lane, the rest run on', () => {
    const { net, node } = build(false);
    expect(net.nodeGeom(node)!.kind).toBe('merge');
    const g = gateways(net, false, 3600, 0);
    const sim = drive(net, 5, 900);
    expect(sim.stats().despawnedStuck).toBe(0);
    const r = sim.endpointStats(g.ramp)!;
    expect(r.arrived).toBeGreaterThan(120);
    expect(r.arrived / r.destined).toBeGreaterThan(0.8);
  });

  it('an added lane: ramp traffic runs on in its own lane and merges at the lane drop', () => {
    const { net, node } = build(true);
    expect(applyRampLaneChange(net, node, 'add', 300)).toBeNull();
    gateways(net, true, 3600, 1000);
    const sim = drive(net, 7, 900);
    expect(sim.stats().despawnedStuck).toBe(0);
  });

  it('exit only: the edge lane all leaves, nobody stuck', () => {
    const { net, node } = build(false);
    expect(applyRampLaneChange(net, node, 'drop')).toBeNull();
    const g = gateways(net, false, 3000, 0);
    const sim = drive(net, 9, 900);
    expect(sim.stats().despawnedStuck).toBe(0);
    expect(sim.endpointStats(g.ramp)!.arrived).toBeGreaterThan(100);
  });
});

describe('lined-up lane drop in the sim', () => {
  for (const align of ['left', 'centre', 'right'] as const) {
    it(`3 lanes to 2, ${align}: the lane that ends merges, nothing stuck`, () => {
      const net = new RoadNetwork();
      const a = net.drawRoad({ start: free(-1200, 0), end: free(0, 0), roadType: 'highway-3' });
      const n = a.nodes[a.nodes.length - 1];
      net.drawRoad({ start: atNode(n), end: free(1200, 0), roadType: 'highway-2' });
      setJointAlign(net, n, align, a.segments[0]);
      net.setTraffic({ autoGateways: false });
      const pos = (id: Id) => net.getNode(id)!.pos;
      const ends = net.deadEnds();
      net.addEndpoint({ kind: 'gateway', nodeId: ends.find((x) => pos(x).x < 0)!, ratePerHour: 2600, attraction: 0 });
      const e = net.addEndpoint({ kind: 'gateway', nodeId: ends.find((x) => pos(x).x > 0)!, ratePerHour: 0, attraction: 1 });
      const sim = drive(net, 21, 700);
      expect(sim.stats().despawnedStuck).toBe(0);
      expect(sim.endpointStats(e)!.arrived).toBeGreaterThan(250);
    });
  }
});
