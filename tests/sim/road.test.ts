import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { Simulation, VEHICLE_PARAMS, VEHICLE_TYPES } from '../../src/sim';
import { expectFiniteState, run, v, worstLaneOverlap } from './helpers';

function road(type: string, length = 1600) {
  const net = new RoadNetwork();
  const a = net.addNode(v(-length / 2, 0));
  const b = net.addNode(v(length / 2, 0));
  const seg = net.addSegment(a, b, { roadType: type });
  return { net, a, b, seg };
}

describe('single road', () => {
  it.each([
    ['street-2', 2, 300],
    ['street-2', 2, 500],
    ['avenue-4', 4, 400],
  ])('flow on %s matches the requested rate within 15%%', (type, lanes, ratePerLane) => {
    const { net } = road(type);
    net.setTraffic({ autoGateways: true, autoGatewayRatePerLane: ratePerLane, defaultMix: { car: 1, van: 0, truck: 0, bus: 0 } });
    const sim = new Simulation(net, 11);
    run(sim, 600); // warm up
    const before = sim.stats().arrivedTotal;
    const span = 3600;
    run(sim, span);
    const measured = ((sim.stats().arrivedTotal - before) / span) * 3600;
    const requested = (lanes / 2) * ratePerLane * 2;
    expect(measured).toBeGreaterThan(requested * 0.85);
    expect(measured).toBeLessThan(requested * 1.15);
  });

  it('keeps cars on the right of the road for their direction, with positive headways', () => {
    const { net, seg } = road('street-4');
    net.setTraffic({ autoGatewayRatePerLane: 500 });
    const sim = new Simulation(net, 5);
    const graph = net.laneGraph;
    const dense = graph.roadLanes.get(seg)!;
    // Drivers going +x see the road's right at +z, so their lanes sit at z > 0.
    const forward = dense.filter((l) => graph.lanes[l].pts[3] > graph.lanes[l].pts[0]);
    const backward = dense.filter((l) => graph.lanes[l].pts[3] < graph.lanes[l].pts[0]);
    expect(forward.length).toBe(2);
    expect(backward.length).toBe(2);
    let checked = 0;
    run(sim, 900, () => {
      expectFiniteState(sim);
      expect(worstLaneOverlap(sim)).toBe(0);
      const { veh } = sim.state;
      for (let i = 0; i < veh.liveCount; i++) {
        const k = veh.live[i];
        const lane = sim.state.g.graph.lanes[veh.lane[k]];
        if (lane.kind !== 'road') continue;
        const goingPlusX = lane.pts[3] > lane.pts[0];
        const z = lane.pts[2];
        if (goingPlusX) expect(z).toBeGreaterThan(0);
        else expect(z).toBeLessThan(0);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(10000);
  });

  it('never lets a follower reach its leader in a stopped queue', () => {
    // One lane, a sign-controlled T holding traffic back, so queues form on a lane.
    const net = new RoadNetwork();
    const a = net.addNode(v(-600, 0));
    const hub = net.addNode(v(0, 0));
    const b = net.addNode(v(600, 0));
    const c = net.addNode(v(0, 400));
    const side = net.addSegment(hub, c, { roadType: 'street-2' });
    net.addSegment(a, hub, { roadType: 'avenue-4' });
    net.addSegment(hub, b, { roadType: 'avenue-4' });
    net.setJunctionControl(hub, { mode: 'priority' });
    net.setSign(hub, side, 'stop');
    net.setTraffic({ autoGatewayRatePerLane: 700 });
    const sim = new Simulation(net, 2);
    let minSpeed = Infinity;
    run(sim, 900, () => {
      expect(worstLaneOverlap(sim)).toBe(0);
      for (let i = 0; i < sim.vehicles.count; i++) minSpeed = Math.min(minSpeed, sim.vehicles.speed[i]);
    });
    expect(minSpeed).toBeLessThan(0.5);
  });

  it('gives each vehicle type its own length and acceleration', () => {
    const { net } = road('highway-3');
    net.setTraffic({ defaultMix: { car: 1, van: 1, truck: 1, bus: 1 } });
    const sim = new Simulation(net, 8);
    run(sim, 200);
    const { veh } = sim.state;
    const seen = new Map<number, { len: number; accel: number[] }>();
    for (let i = 0; i < veh.liveCount; i++) {
      const k = veh.live[i];
      const e = seen.get(veh.type[k]) ?? { len: veh.len[k], accel: [] };
      e.accel.push(veh.accel[k]);
      seen.set(veh.type[k], e);
    }
    expect(seen.get(0)!.len).toBe(4.5);
    expect(seen.get(1)!.len).toBe(5.5);
    expect(seen.get(2)!.len).toBe(12);
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean(seen.get(2)!.accel)).toBeLessThan(mean(seen.get(0)!.accel));
  });

  it('honours the multiplier and a zero rate', () => {
    const { net } = road('street-2');
    net.setTraffic({ multiplier: 0 });
    const sim = new Simulation(net, 1);
    run(sim, 120);
    expect(sim.stats().spawnedTotal).toBe(0);
    net.setTraffic({ multiplier: 2 });
    run(sim, 600);
    const s = sim.stats();
    // Two gateways, 300 per lane per hour, doubled, for ten minutes.
    expect(s.spawnedTotal).toBeGreaterThan(160);
    expect(s.spawnedTotal).toBeLessThan(240);
  });

  it('resets to an empty network', () => {
    const { net } = road('street-2');
    const sim = new Simulation(net, 1);
    run(sim, 300);
    expect(sim.stats().spawnedTotal).toBeGreaterThan(0);
    sim.reset();
    const s = sim.stats();
    expect(s.active).toBe(0);
    expect(s.spawnedTotal).toBe(0);
    expect(s.arrivedTotal).toBe(0);
    expect(sim.time).toBe(0);
    expect(sim.vehicles.count).toBe(0);
    run(sim, 120);
    expect(sim.stats().spawnedTotal).toBeGreaterThan(0);
  });

  it('runs fixed steps from advance, pauses at speed 0, and interpolates', () => {
    const { net } = road('street-2');
    const sim = new Simulation(net, 1);
    sim.speed = 2;
    sim.advance(0.1);
    expect(sim.time).toBeCloseTo(0.2, 5);
    sim.advance(0.025);
    expect(sim.renderAlpha).toBeGreaterThan(0.4);
    expect(sim.renderAlpha).toBeLessThan(0.6);
    sim.speed = 0;
    const t = sim.time;
    sim.advance(1);
    expect(sim.time).toBe(t);
  });

  it('reports a segment readout and a history', () => {
    const { net, seg } = road('street-2');
    net.setTraffic({ autoGatewayRatePerLane: 600 });
    const sim = new Simulation(net, 1);
    run(sim, 200);
    const tr = sim.segmentTraffic(seg);
    expect(tr.count).toBeGreaterThan(0);
    expect(tr.speedRatio).toBeGreaterThan(0.5);
    expect(tr.speedRatio).toBeLessThanOrEqual(1);
    expect(tr.flowPerHour).toBeGreaterThan(500);
    expect(tr.flowPerHour).toBeLessThan(2000);
    expect(sim.history().length).toBeGreaterThanOrEqual(3);
    const detail = sim.vehicleDetail(sim.vehicles.id[0]);
    expect(detail).not.toBeNull();
    expect(detail!.route.length).toBeGreaterThan(1);
  });
});

describe('lanes and curves', () => {
  it('keeps cars out of bus lanes and lets buses use them', () => {
    const { net, seg } = road('avenue-4-bus', 1200);
    net.setTraffic({ autoGatewayRatePerLane: 500, defaultMix: { car: 3, van: 0, truck: 0, bus: 1 } });
    const sim = new Simulation(net, 4);
    let busOnBusLane = 0;
    run(sim, 600, () => {
      const { veh, g } = sim.state;
      for (let i = 0; i < veh.liveCount; i++) {
        const k = veh.live[i];
        const lane = g.graph.lanes[veh.lane[k]];
        const isBus = veh.type[k] === 3;
        if (lane.vehicleKind === 'bus') {
          expect(isBus).toBe(true);
          busOnBusLane++;
        }
        expect(lane.vehicleKind).not.toBe('bike');
      }
    });
    expect(busOnBusLane).toBeGreaterThan(100);
    expect(seg).toBeGreaterThan(0);
  });

  it('keeps motor traffic off bike lanes, and bikes on them', () => {
    const { net } = road('street-2-bike', 1000);
    net.setTraffic({ autoGatewayRatePerLane: 900 });
    const sim = new Simulation(net, 4);
    const bikes = new Set<number>();
    let top = 0;
    run(sim, 900, () => {
      const { veh, g } = sim.state;
      for (let i = 0; i < veh.liveCount; i++) {
        const k = veh.live[i];
        const onBikeLane = g.graph.lanes[veh.lane[k]].vehicleKind === 'bike';
        expect(onBikeLane).toBe(veh.type[k] === 4);
        if (veh.type[k] === 4) {
          bikes.add(veh.id[k]);
          top = Math.max(top, veh.v[k]);
        }
      }
    });
    const s = sim.stats();
    // A 5% share of about 450 spawns.
    expect(bikes.size).toBeGreaterThan(8);
    expect(bikes.size).toBeLessThan(45);
    expect(top).toBeGreaterThan(4.5);
    expect(top).toBeLessThan(6);
    expect(s.arrivedTotal).toBeGreaterThan(150);
    const params = VEHICLE_PARAMS[4];
    expect(params.length).toBe(1.8);
    expect(VEHICLE_TYPES[4]).toBe('bike');
  });

  it('spawns no bikes where there is no bike lane', () => {
    const { net } = road('street-2', 1000);
    net.setTraffic({ autoGatewayRatePerLane: 900 });
    const sim = new Simulation(net, 4);
    run(sim, 300, () => {
      const { veh } = sim.state;
      for (let i = 0; i < veh.liveCount; i++) expect(veh.type[veh.live[i]]).not.toBe(4);
    });
    expect(sim.stats().spawnedTotal).toBeGreaterThan(50);
  });

  it('slows for a tight bend on a road and for a small loop', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-500, 0));
    const b = net.addNode(v(0, 0));
    const c = net.addNode(v(60, 60));
    const d = net.addNode(v(60, 500));
    const k = 33;
    net.addSegment(a, b, { roadType: 'ramp-1' });
    net.addSegment(b, c, { roadType: 'ramp-1', c1: v(k, 0), c2: v(60, 60 - k) });
    net.addSegment(c, d, { roadType: 'ramp-1' });
    net.setTraffic({ autoGatewayRatePerLane: 400, defaultMix: { car: 1, van: 0, truck: 0, bus: 0 } });
    const sim = new Simulation(net, 2);
    let inBend = 0;
    let onStraight = 0;
    run(sim, 400, () => {
      const view = sim.vehicles;
      for (let i = 0; i < view.count; i++) {
        const x = view.x[i];
        const z = view.z[i];
        const speed = view.speed[i];
        if (x > 15 && x < 45 && z > 3 && z < 45) inBend = Math.max(inBend, speed);
        if (x < -200) onStraight = Math.max(onStraight, speed);
      }
    });
    const limit = 60 / 3.6;
    expect(onStraight).toBeGreaterThan(limit * 0.9);
    // Radius 60: sqrt(2.6 * 60) = 12.5 m/s, a touch over for the fastest drivers.
    expect(inBend).toBeGreaterThan(5);
    expect(inBend).toBeLessThan(14);
  });
});

describe('endpoints', () => {
  it('sends traffic only between enabled endpoints', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-500, 0));
    const b = net.addNode(v(500, 0));
    const seg = net.addSegment(a, b, { roadType: 'street-2' });
    net.setTraffic({ autoGateways: false });
    const home = net.addEndpoint({ kind: 'residential', segmentId: seg, t: 0.3, ratePerHour: 600 });
    const shop = net.addEndpoint({ kind: 'commercial', segmentId: seg, t: 0.7, ratePerHour: 600 });
    const off = net.addEndpoint({ kind: 'office', segmentId: seg, t: 0.5, ratePerHour: 600, enabled: false });
    const sim = new Simulation(net, 9);
    run(sim, 900, () => expectFiniteState(sim));
    const h = sim.endpointStats(home)!;
    const s = sim.endpointStats(shop)!;
    expect(h.spawned).toBeGreaterThan(100);
    expect(s.spawned).toBeGreaterThan(100);
    expect(h.arrived).toBeGreaterThan(60);
    expect(s.arrived).toBeGreaterThan(60);
    expect(sim.endpointStats(off)).toBeNull();
  });

  it('never targets the source, and keeps gateways out of each other when autoGateways is off', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-500, 0));
    const b = net.addNode(v(500, 0));
    net.addSegment(a, b, { roadType: 'street-2' });
    net.setTraffic({ autoGateways: false });
    const sim = new Simulation(net, 9);
    run(sim, 120);
    expect(sim.stats().spawnedTotal).toBe(0);
    net.setTraffic({ autoGateways: true });
    run(sim, 300);
    const { veh } = sim.state;
    expect(veh.liveCount).toBeGreaterThan(0);
    for (let i = 0; i < veh.liveCount; i++) {
      const k = veh.live[i];
      expect(veh.dest[k]).not.toBe(veh.source[k]);
    }
  });

  it('does not stack a source: a full road queues at the gateway', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-200, 0));
    const b = net.addNode(v(200, 0));
    net.addSegment(a, b, { roadType: 'street-2' });
    net.setTraffic({ autoGatewayRatePerLane: 6000, defaultMix: { car: 1, van: 0, truck: 0, bus: 0 } });
    const sim = new Simulation(net, 1);
    run(sim, 300, () => expect(worstLaneOverlap(sim)).toBe(0));
    const s = sim.stats();
    expect(s.queuedAtSources ?? 0).toBeGreaterThan(50);
    // Far below the requested 12,000 per hour: a lane carries about 2,000.
    expect((s.arrivedTotal / 300) * 3600).toBeLessThan(5000);
    expect(s.arrivedTotal).toBeGreaterThan(100);
  });
});
