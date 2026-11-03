import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { Simulation } from '../../src/sim/Simulation';
import { CAR_KINDS, TrainSim } from '../../src/rail';
import { station, straightLine, v } from './helpers';

describe('level crossings', () => {
  it('closes for a train and stops road traffic, then reopens', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-double', -1900, 1900);
    const road = net.drawRoad({ start: { kind: 'free', pos: v(300, -400) }, end: { kind: 'free', pos: v(300, 400) }, roadType: 'street-2' });
    const node = road.junctions[0];
    const ends = net.deadEnds();
    net.addEndpoint({ kind: 'gateway', nodeId: ends[0], ratePerHour: 900 });
    net.addEndpoint({ kind: 'gateway', nodeId: ends[1], ratePerHour: 900 });
    const segs = net.segments.filter((s) => net.roadTypeOf(s.id).category === 'rail').map((s) => s.id);
    const a = station(net, segs[0], 0.2, 'A', 300);
    const b = station(net, segs[1], 0.8, 'B', 300);
    expect(seg).toBeDefined();
    net.addLine({ name: 'L', color: '#fff', stops: [a, b], trainType: 'emu', cars: 8, trains: 2, headwaySec: 60 });

    const sim = new Simulation(net, 3);
    const trains = new TrainSim(net, 3);
    trains.onCrossing = (lanes, closed) => {
      for (const l of lanes) sim.blockConflict(l, closed);
    };
    expect(trains.graph.crossings).toHaveLength(1);
    const cx = net.getNode(node)!.pos;
    let closedSteps = 0;
    let openSteps = 0;
    let carsInBoxWhileTrain = 0;
    let carsThrough = 0;
    let trainOnCrossing = 0;
    for (let i = 0; i < 9000; i++) {
      sim.step();
      trains.step();
      const closed = trains.crossings[0].closed;
      if (closed) closedSteps++;
      else openSteps++;
      // Is a train body over the road?
      const tv = trains.view;
      let trainHere = false;
      for (let k = 0; k < tv.count; k++) {
        const half = CAR_KINDS[tv.kind[k]].length / 2;
        if (Math.abs(tv.x[k] - cx.x) < half + 4 && Math.abs(tv.z[k] - cx.z) < 6) trainHere = true;
      }
      if (trainHere) trainOnCrossing++;
      const view = sim.vehicles;
      for (let k = 0; k < view.count; k++) {
        const inBox = Math.abs(view.x[k] - cx.x) < 4 && Math.abs(view.z[k] - cx.z) < 7;
        if (inBox && trainHere) carsInBoxWhileTrain++;
        if (inBox && !trainHere) carsThrough++;
      }
      if (trainHere) expect(closed).toBe(true);
    }
    expect(trainOnCrossing).toBeGreaterThan(50);
    expect(closedSteps).toBeGreaterThan(100);
    expect(openSteps).toBeGreaterThan(closedSteps);
    expect(carsThrough).toBeGreaterThan(0);
    expect(carsInBoxWhileTrain).toBe(0);
    expect(trains.crossings[0].gate).toBeGreaterThanOrEqual(0);
  });
});
