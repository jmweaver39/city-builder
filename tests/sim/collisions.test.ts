/**
 * The hard invariant: no two vehicles' real footprints ever overlap, anywhere. Checked
 * at every step with oriented boxes built from the published view alone, by code
 * written apart from the sim's own safety pass, so it trusts nothing inside the sim.
 */
import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { Simulation } from '../../src/sim';
import { checkBodies, expectFiniteState, free, newBodyCheck, run, v } from './helpers';
import { controlled, diamond, laneDrop, onRamp, roundabout, weave } from './scenarios';

function expectNoContact(sim: Simulation, seconds: number) {
  const check = newBodyCheck();
  run(sim, seconds, () => checkBodies(sim, check));
  const s = sim.stats();
  console.log(
    `bodies: ${check.vehicleSteps} vehicle-steps, ${check.hits} overlaps; sim collisions ${s.collisions}, ` +
      `safety stops ${s.safetyStops}, stuck ${s.despawnedStuck}, arrived ${s.arrivedTotal}`,
  );
  expect(check.sample).toEqual([]);
  expect(check.hits).toBe(0);
  expect(s.collisions).toBe(0);
  return { check, s };
}

describe('no collisions, by real footprint', () => {
  it.each([
    ['stop', 'street-2', 400],
    ['allStop', 'street-4', 400],
    ['priority', 'street-4', 600],
    ['signal', 'avenue-4', 600],
    ['lefts', 'avenue-6', 600],
    ['auto', 'street-4', 900],
  ] as const)('4-way, %s control on %s', (mode, type, rate) => {
    const sim = new Simulation(controlled(type, mode, rate), 7);
    const { check, s } = expectNoContact(sim, 900);
    expect(check.vehicleSteps).toBeGreaterThan(200000);
    // A last-resort clamp: a handful of near misses at most, never a way of life.
    expect(s.safetyStops ?? 0).toBeLessThan(60);
  });

  it('roundabout', () => {
    const net = roundabout();
    net.setTraffic({ autoGatewayRatePerLane: 650 });
    const { s } = expectNoContact(new Simulation(net, 7), 900);
    expect(s.safetyStops ?? 0).toBeLessThan(60);
  });

  it('diamond interchange', () => {
    const net = diamond();
    net.setTraffic({ autoGatewayRatePerLane: 500 });
    const { s } = expectNoContact(new Simulation(net, 7), 1200);
    expect(s.safetyStops ?? 0).toBeLessThan(120);
  });

  it('on-ramp at heavy flow', () => {
    const o = onRamp();
    o.net.setTraffic({ autoGateways: false });
    o.net.addEndpoint({ kind: 'gateway', nodeId: o.a, ratePerHour: 3400, attraction: 0 });
    o.net.addEndpoint({ kind: 'gateway', nodeId: o.r, ratePerHour: 1400, attraction: 0 });
    o.net.addEndpoint({ kind: 'gateway', nodeId: o.b, ratePerHour: 0, attraction: 1 });
    const { s } = expectNoContact(new Simulation(o.net, 7), 900);
    expect(s.safetyStops ?? 0).toBeLessThan(60);
  });

  it('weaving section', () => {
    const { s } = expectNoContact(new Simulation(weave().net, 7), 900);
    expect(s.safetyStops ?? 0).toBeLessThan(60);
  });

  it('lane drop', () => {
    const { s } = expectNoContact(new Simulation(laneDrop(), 7), 900);
    expect(s.safetyStops ?? 0).toBeLessThan(60);
  });

  it('bikes and buses mixed in with cars', () => {
    const net = new RoadNetwork();
    const hub = net.addNode(v(0, 0));
    for (const p of [v(300, 0), v(-300, 0), v(0, 300), v(0, -300)]) net.addSegment(hub, net.addNode(p), { roadType: 'street-2-bike' });
    net.setTraffic({ autoGatewayRatePerLane: 500, defaultMix: { car: 6, van: 1, truck: 2, bus: 1 } });
    expectNoContact(new Simulation(net, 7), 900);
  });

  it.each([1, 2, 3, 4, 5])('fuzzed edits under traffic, seed %i', (seed) => {
    let a = seed * 2654435761;
    const rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const types = ['street-2', 'street-4', 'avenue-4', 'street-2-oneway', 'highway-2', 'avenue-4-bus', 'street-2-bike'];
    const net = new RoadNetwork();
    for (let i = -2; i <= 2; i++) {
      net.drawRoad({ start: free(i * 140, -350), end: free(i * 140, 350), roadType: pick(types) });
      net.drawRoad({ start: free(-350, i * 140 + 25), end: free(350, i * 140 + 25), roadType: pick(types) });
    }
    net.setTraffic({ autoGatewayRatePerLane: 500, defaultMix: { car: 6, van: 1, truck: 2, bus: 1 } });
    const sim = new Simulation(net, seed);
    const check = newBodyCheck();
    for (let round = 0; round < 30; round++) {
      run(sim, 5 + rand() * 10, () => checkBodies(sim, check));
      const segs = net.segments;
      try {
        const op = rand();
        if (op < 0.3 && segs.length > 4) net.removeSegment(pick(segs).id);
        else if (op < 0.5 && net.nodes.length) {
          const n = pick(net.nodes);
          net.moveNode(n.id, v(n.pos.x + (rand() - 0.5) * 30, n.pos.z + (rand() - 0.5) * 30));
        } else if (op < 0.65 && segs.length) net.splitSegment(pick(segs).id, 0.2 + rand() * 0.6);
        else if (op < 0.8 && segs.length) net.setRoadType(pick(segs).id, pick(types));
        else if (op < 0.9) net.setJunctionControl(pick(net.nodes).id, { mode: pick(['auto', 'priority', 'allStop', 'signal'] as const) });
        else net.drawRoad({ start: free((rand() - 0.5) * 600, (rand() - 0.5) * 600), end: free((rand() - 0.5) * 600, (rand() - 0.5) * 600), roadType: pick(types) });
      } catch {
        // A refused edit is the network's business.
      }
      sim.step();
      checkBodies(sim, check);
      expectFiniteState(sim);
    }
    expect(check.sample).toEqual([]);
    expect(check.hits).toBe(0);
    expect(sim.stats().collisions).toBe(0);
  });
});
