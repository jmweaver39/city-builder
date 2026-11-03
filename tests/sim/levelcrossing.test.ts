/**
 * Road traffic over a level crossing, with trains running. Cars stop for a closed
 * crossing as for a red light, and no road vehicle ever touches another or a train.
 */
import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { CAR_KINDS, TrainSim } from '../../src/rail';
import { boxesOverlap, Simulation, VEHICLE_PARAMS } from '../../src/sim';
import { checkBodies, newBodyCheck } from './helpers';
import { station, straightLine, v } from '../rail/helpers';

describe('level crossing', () => {
  it('cars cross in front of trains with no collisions', () => {
    const net = new RoadNetwork();
    straightLine(net, 'rail-double', -1900, 1900);
    const road = net.drawRoad({ start: { kind: 'free', pos: v(300, -400) }, end: { kind: 'free', pos: v(300, 400) }, roadType: 'street-2' });
    expect(road.junctions).toHaveLength(1);
    net.setTraffic({ autoGatewayRatePerLane: 500, defaultMix: { car: 6, van: 1, truck: 2, bus: 1 } });
    const rails = net.segments.filter((s) => net.roadTypeOf(s.id).category === 'rail').map((s) => s.id);
    const a = station(net, rails[0], 0.2, 'A', 300);
    const b = station(net, rails[1], 0.8, 'B', 300);
    net.addLine({ name: 'L', color: '#fff', stops: [a, b], trainType: 'emu', cars: 8, trains: 3, headwaySec: 60 });

    const sim = new Simulation(net, 5);
    const trains = new TrainSim(net, 5);
    trains.onCrossing = (lanes, closed) => {
      for (const l of lanes) sim.blockConflict(l, closed);
    };
    const roads = newBodyCheck();
    let trainHits = 0;
    let closedSteps = 0;
    let carsOverRails = 0;
    const cx = net.getNode(road.junctions[0])!.pos;
    for (let i = 0; i < 12000; i++) {
      sim.step();
      trains.step();
      checkBodies(sim, roads);
      if (trains.crossings[0].closed) closedSteps++;
      const tv = trains.view;
      const view = sim.vehicles;
      for (let k = 0; k < view.count; k++) {
        if (Math.abs(view.x[k] - cx.x) < 6 && Math.abs(view.z[k] - cx.z) < 8) carsOverRails++;
        const p = VEHICLE_PARAMS[view.type[k]];
        for (let t = 0; t < tv.count; t++) {
          if (Math.abs(tv.y[t] - view.y[k]) > 3) continue;
          const c = CAR_KINDS[tv.kind[t]];
          if (boxesOverlap(view.x[k], view.z[k], view.yaw[k], p.length / 2, p.width / 2, tv.x[t], tv.z[t], tv.yaw[t], c.length / 2, c.width / 2)) trainHits++;
        }
      }
    }
    const s = sim.stats();
    console.log(`level crossing: closed ${closedSteps} steps, cars over the rails ${carsOverRails}, road overlaps ${roads.hits}, train hits ${trainHits}, safety ${s.safetyStops}, stuck ${s.despawnedStuck}, arrived ${s.arrivedTotal}`);
    expect(closedSteps).toBeGreaterThan(500);
    expect(carsOverRails).toBeGreaterThan(500);
    expect(trainHits).toBe(0);
    expect(roads.hits).toBe(0);
    expect(s.collisions).toBe(0);
    expect(s.despawnedStuck).toBe(0);
    expect(s.arrivedTotal).toBeGreaterThan(300);
  });

  it('survives load() of a different project with a stale graph, as the rail demo does', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: { kind: 'free', pos: v(-300, 0) }, end: { kind: 'free', pos: v(300, 0) }, roadType: 'street-2' });
    const sim = new Simulation(net, 1);
    for (let i = 0; i < 300; i++) sim.step();
    const other = new RoadNetwork();
    straightLine(other, 'rail-double', -900, 900);
    other.drawRoad({ start: { kind: 'free', pos: v(0, -300) }, end: { kind: 'free', pos: v(0, 300) }, roadType: 'avenue-4' });
    net.load(other.snapshot(), 'replace');
    sim.reset();
    for (let i = 0; i < 300; i++) sim.step();
    expect(sim.stats().spawnedTotal).toBeGreaterThan(0);
    net.load(net.snapshot());
    for (let i = 0; i < 50; i++) sim.step();
  });
});
