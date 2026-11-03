import { describe, expect, it } from 'vitest';
import { makeCustomRoadType, RoadNetwork, type LaneKind } from '../../src/core';
import { Simulation } from '../../src/sim';
import { crossroads, run, v } from './helpers';

describe('closing a lane from outside', () => {
  it('stops traffic before a closed connector like a red light, and lets it go after', () => {
    const { net, hub, segs } = crossroads('street-2');
    net.setTraffic({ autoGatewayRatePerLane: 500 });
    const sim = new Simulation(net, 3);
    run(sim, 120);
    const graph = net.laneGraph;
    const closed = graph.connectorsAt.get(hub)!.filter((c) => graph.lanes[graph.lanes[c].fromLane].segmentId === segs[0]);
    for (const c of closed) sim.blockConflict(c, true);
    expect(sim.connectorLight(closed[0])).toBe('red');
    const entered = new Set<number>();
    const before = new Set<number>();
    for (let i = 0; i < sim.state.veh.liveCount; i++) {
      const k = sim.state.veh.live[i];
      if (closed.includes(sim.state.veh.lane[k])) before.add(sim.state.veh.id[k]);
    }
    run(sim, 200, () => {
      const { veh } = sim.state;
      for (let i = 0; i < veh.liveCount; i++) {
        const k = veh.live[i];
        if (closed.includes(veh.lane[k]) && !before.has(veh.id[k])) entered.add(veh.id[k]);
      }
    });
    expect(entered.size).toBe(0);
    // Traffic queues on the closed approach, but waiting at a closure is not being stuck.
    expect(sim.segmentTraffic(segs[0]).count).toBeGreaterThan(5);
    expect(sim.stats().despawnedStuck).toBe(0);
    // A closure survives a rebuild of the graph.
    net.setJunctionControl(hub, { mode: 'allStop' });
    run(sim, 10);
    expect(sim.connectorLight(net.laneGraph.connectorsAt.get(hub)!.find((c) => closed.includes(c))!)).toBe('red');
    for (const c of net.laneGraph.connectorsAt.get(hub)!) sim.blockConflict(c, false);
    run(sim, 200, () => {
      const { veh } = sim.state;
      for (let i = 0; i < veh.liveCount; i++) if (closed.includes(veh.lane[veh.live[i]])) entered.add(veh.id[veh.live[i]]);
    });
    expect(entered.size).toBeGreaterThan(5);
  });
});

describe('rail lanes', () => {
  it('keeps road traffic off rail and makes no gateway of a rail dead end', () => {
    const net = new RoadNetwork();
    const rail = makeCustomRoadType({ id: 'test-rail', forwardLanes: 1, backwardLanes: 1, speedKmh: 80 });
    // The rail agent's LaneKind may not exist yet: build the type the way they will.
    net.setCustomRoadType({ ...rail, lanes: rail.lanes.map((l) => ({ ...l, kind: 'rail' as LaneKind })) });
    const a = net.addNode(v(-400, 0));
    const hub = net.addNode(v(0, 0));
    const b = net.addNode(v(400, 0));
    const r1 = net.addNode(v(0, -300));
    const r2 = net.addNode(v(0, 300));
    net.addSegment(a, hub, { roadType: 'street-2' });
    net.addSegment(hub, b, { roadType: 'street-2' });
    const t1 = net.addSegment(r1, hub, { roadType: 'test-rail' });
    const t2 = net.addSegment(hub, r2, { roadType: 'test-rail' });
    net.setTraffic({ autoGatewayRatePerLane: 600 });
    const sim = new Simulation(net, 4);
    const railLanes = new Set([...net.laneGraph.roadLanes.get(t1)!, ...net.laneGraph.roadLanes.get(t2)!]);
    run(sim, 600, () => {
      const { veh, g } = sim.state;
      for (let i = 0; i < veh.liveCount; i++) {
        const lane = veh.lane[veh.live[i]];
        expect(railLanes.has(lane)).toBe(false);
        expect(g.allow[lane]).toBeGreaterThan(0);
      }
    });
    expect(sim.state.routes.places.length).toBe(2);
    expect(sim.stats().arrivedTotal).toBeGreaterThan(50);
  });
});
