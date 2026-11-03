import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { Simulation } from '../../src/sim';
import { crossroads, expectFiniteState, free, run, v, worstLaneOverlap } from './helpers';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function checkAll(sim: Simulation): void {
  expectFiniteState(sim);
  expect(worstLaneOverlap(sim)).toBe(0);
}

describe('edits under traffic', () => {
  it('removes vehicles when the road under them is deleted', () => {
    const { net, segs } = crossroads('street-2');
    net.setTraffic({ autoGatewayRatePerLane: 600 });
    const sim = new Simulation(net, 61);
    run(sim, 200, () => checkAll(sim));
    const before = sim.stats().active;
    expect(before).toBeGreaterThan(5);
    net.removeSegment(segs[0]);
    run(sim, 1, () => checkAll(sim));
    const s = sim.stats();
    expect(s.removedByEdit ?? 0).toBeGreaterThan(0);
    run(sim, 200, () => checkAll(sim));
    expect(sim.stats().arrivedTotal).toBeGreaterThan(0);
  });

  it('keeps vehicles on a surviving road at their fraction when a node is dragged', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-500, 0));
    const b = net.addNode(v(500, 0));
    net.addSegment(a, b, { roadType: 'street-2' });
    const sim = new Simulation(net, 62);
    run(sim, 120);
    const count = sim.stats().active;
    net.moveNode(b, v(500, 80));
    sim.step();
    expect(sim.stats().active).toBeGreaterThanOrEqual(count - 1);
    expect(sim.stats().removedByEdit).toBe(0);
    checkAll(sim);
  });

  it('keeps cars in place when a road is split', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-800, 0));
    const b = net.addNode(v(800, 0));
    const seg = net.addSegment(a, b, { roadType: 'street-2' });
    net.setTraffic({ autoGatewayRatePerLane: 500 });
    const sim = new Simulation(net, 63);
    run(sim, 200);
    const before = new Map<number, number>();
    for (let i = 0; i < sim.vehicles.count; i++) before.set(sim.vehicles.id[i], sim.vehicles.x[i]);
    net.splitSegment(seg, 0.5);
    sim.step();
    checkAll(sim);
    let moved = 0;
    for (let i = 0; i < sim.vehicles.count; i++) {
      const was = before.get(sim.vehicles.id[i]);
      if (was !== undefined && Math.abs(was - sim.vehicles.x[i]) > 30) moved++;
    }
    expect(moved).toBe(0);
    expect(sim.stats().removedByEdit).toBeLessThan(4);
  });

  it('retargets a vehicle when its destination becomes unreachable', () => {
    const { net, segs, ends } = crossroads('street-2', 500);
    net.setTraffic({ autoGateways: false });
    net.addEndpoint({ kind: 'gateway', nodeId: ends[0], ratePerHour: 1200, attraction: 1 });
    const gone = net.addEndpoint({ kind: 'gateway', nodeId: ends[1], ratePerHour: 0, attraction: 2 });
    net.addEndpoint({ kind: 'gateway', nodeId: ends[2], ratePerHour: 0, attraction: 1 });
    const sim = new Simulation(net, 64);
    run(sim, 120);
    net.updateEndpoint(gone, { enabled: false });
    net.removeSegment(segs[1]);
    run(sim, 300, () => checkAll(sim));
    const s = sim.stats();
    expect(s.retargeted ?? 0).toBeGreaterThan(0);
    expect(s.arrivedTotal).toBeGreaterThan(20);
    expect(s.despawnedStuck).toBe(0);
  });

  it('survives clearing, loading and undoing the whole project', () => {
    const { net } = crossroads('street-2');
    const sim = new Simulation(net, 65);
    run(sim, 120);
    const snap = net.snapshot();
    net.clear();
    run(sim, 5, () => checkAll(sim));
    expect(sim.stats().active).toBe(0);
    net.load(snap);
    run(sim, 120, () => checkAll(sim));
    expect(sim.stats().active).toBeGreaterThan(0);
  });

  it('keeps traffic through an undo, and drops it for a different project', () => {
    const { net, segs } = crossroads('street-2');
    net.setTraffic({ autoGatewayRatePerLane: 500 });
    const sim = new Simulation(net, 67);
    const before = net.snapshot();
    run(sim, 200, () => checkAll(sim));
    net.removeSegment(segs[0]);
    run(sim, 3, () => checkAll(sim));
    const count = sim.stats().active;
    const ids = new Set(Array.from(sim.vehicles.id.subarray(0, sim.vehicles.count)));
    expect(count).toBeGreaterThan(5);
    net.load(before, 'undo');
    sim.step();
    checkAll(sim);
    let kept = 0;
    for (let i = 0; i < sim.vehicles.count; i++) if (ids.has(sim.vehicles.id[i])) kept++;
    expect(kept).toBeGreaterThanOrEqual(count - 2);
    // Without a reason it still counts as restoring: the editor need not change.
    const count2 = sim.stats().active;
    net.load(net.snapshot());
    sim.step();
    expect(sim.stats().active).toBeGreaterThanOrEqual(count2 - 2);
    run(sim, 60, () => checkAll(sim));
    net.load(net.snapshot(), 'replace');
    sim.step();
    expect(sim.stats().active).toBeLessThan(3);
    expect(sim.stats().arrivedTotal).toBeLessThan(3);
  });

  it('changes junction control and road type mid-run', () => {
    const { net, hub, segs } = crossroads('street-2');
    net.setTraffic({ autoGatewayRatePerLane: 500 });
    const sim = new Simulation(net, 66);
    run(sim, 100, () => checkAll(sim));
    net.setJunctionControl(hub, { mode: 'signal' });
    run(sim, 100, () => checkAll(sim));
    net.setJunctionControl(hub, { mode: 'allStop' });
    run(sim, 100, () => checkAll(sim));
    net.setRoadType(segs[0], 'street-4');
    run(sim, 100, () => checkAll(sim));
    net.setSegmentOverrides(segs[1], { speedKmh: 20 });
    run(sim, 100, () => checkAll(sim));
    expect(sim.stats().arrivedTotal).toBeGreaterThan(50);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('fuzz: delete and rebuild under traffic, seed %i', (seed) => {
    const rand = mulberry32(seed * 7919);
    const net = new RoadNetwork();
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];
    const types = ['street-2', 'street-4', 'avenue-4', 'street-2-oneway', 'highway-2', 'ramp-1', 'avenue-4-bus', 'street-2-bike'];
    const size = 350;
    // A loose grid of roads to start.
    for (let i = -2; i <= 2; i++) {
      net.drawRoad({ start: free(i * 140, -size), end: free(i * 140, size), roadType: pick(types) });
      net.drawRoad({ start: free(-size, i * 140 + 25), end: free(size, i * 140 + 25), roadType: pick(types) });
    }
    net.setTraffic({ autoGatewayRatePerLane: 500, despawnStuckSec: 90 });
    const sim = new Simulation(net, seed);
    let maxActive = 0;
    for (let round = 0; round < 40; round++) {
      run(sim, 5 + rand() * 10, () => {
        checkAll(sim);
        maxActive = Math.max(maxActive, sim.stats().active);
      });
      const segs = net.segments;
      const op = rand();
      try {
        if (op < 0.3 && segs.length > 4) {
          net.removeSegment(pick(segs).id);
        } else if (op < 0.45 && net.nodes.length) {
          const n = pick(net.nodes);
          net.moveNode(n.id, v(n.pos.x + (rand() - 0.5) * 30, n.pos.z + (rand() - 0.5) * 30));
        } else if (op < 0.6 && segs.length) {
          net.splitSegment(pick(segs).id, 0.2 + rand() * 0.6);
        } else if (op < 0.7 && segs.length) {
          net.setRoadType(pick(segs).id, pick(types));
        } else if (op < 0.8 && net.nodes.length) {
          const mode = pick(['auto', 'priority', 'allStop', 'signal'] as const);
          net.setJunctionControl(pick(net.nodes).id, { mode });
        } else if (op < 0.9) {
          net.batch(() => {
            for (let i = 0; i < 3 && net.segments.length > 4; i++) net.removeSegment(pick(net.segments).id);
          });
        } else {
          const ax = (rand() - 0.5) * size * 2;
          const az = (rand() - 0.5) * size * 2;
          const bx = (rand() - 0.5) * size * 2;
          const bz = (rand() - 0.5) * size * 2;
          if (Math.hypot(ax - bx, az - bz) > 60) net.drawRoad({ start: free(ax, az), end: free(bx, bz), roadType: pick(types) });
        }
      } catch (e) {
        // Refused edits are the network's business. The sim must only survive them.
        expect(String(e)).toMatch(/Error/);
      }
      checkAll(sim);
    }
    run(sim, 60, () => checkAll(sim));
    expect(maxActive).toBeLessThan(2500);
    expect(sim.stats().spawnedTotal).toBeGreaterThan(0);
  });
});

