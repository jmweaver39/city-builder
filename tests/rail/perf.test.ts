import { describe, expect, it } from 'vitest';
import { RoadNetwork, type Id } from '../../src/core';
import { TrainSim } from '../../src/rail';
import { station, v } from './helpers';

describe('performance', () => {
  it('runs 30 long trains in well under a frame', () => {
    const net = new RoadNetwork();
    // Ten parallel double-track lines, each with three freight trains of 120 wagons.
    for (let k = 0; k < 10; k++) {
      const z = -1800 + k * 400;
      const a = net.addNode(v(-1950, z));
      const b = net.addNode(v(1950, z));
      const seg = net.addSegment(a, b, { roadType: 'rail-double' });
      const w: Id = station(net, seg, 0.0005, `W${k}`, 0, 'gateway');
      const e: Id = station(net, seg, 0.9995, `E${k}`, 0, 'gateway');
      net.addLine({ name: `F${k}`, color: '#fff', stops: [w, e], trainType: 'freight', cars: 120, trains: 3, headwaySec: 60 });
    }
    const sim = new TrainSim(net);
    for (let i = 0; i < 3000; i++) sim.step();
    expect(sim.trains.length).toBeGreaterThanOrEqual(20);
    const cars = sim.view.count;
    const t0 = performance.now();
    const steps = 600;
    for (let i = 0; i < steps; i++) sim.step();
    const per = (performance.now() - t0) / steps;
    console.log(`rail perf: ${sim.trains.length} trains, ${cars} cars, ${per.toFixed(3)} ms per step`);
    expect(cars).toBeGreaterThan(2000);
    // 60 fps at 4x speed needs 4 steps in 16 ms of frame.
    expect(per).toBeLessThan(2);
  });
});
