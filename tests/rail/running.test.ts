import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { TrainSim, RAIL_DT } from '../../src/rail';
import { countOverlaps, station, straightLine } from './helpers';

describe('a train on a line', () => {
  it('runs between two stations and turns back', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-single', -1000, 1000);
    const a = station(net, seg, 0.15, 'West');
    const b = station(net, seg, 0.85, 'East');
    net.addLine({ name: 'L', color: '#f00', stops: [a, b], trainType: 'emu', cars: 8, trains: 1 });
    const sim = new TrainSim(net);
    let max = 0;
    const seen: string[] = [];
    let last = '';
    for (let i = 0; i < 12000; i++) {
      sim.step();
      if (sim.trains.length) {
        const d = sim.trainDetail(sim.trains[0].id)!;
        max = Math.max(max, d.speedKmh);
        const tag = `${d.status.startsWith('At') ? 'stop' : 'go'}:${d.next}`;
        if (tag !== last) {
          seen.push(tag);
          last = tag;
        }
      }
    }
    console.log(seen.slice(0, 12), max, sim.stats());
    expect(sim.trains.length).toBe(1);
    expect(max).toBeGreaterThan(60);
    expect(sim.stats().carried).toBeGreaterThan(0);
    expect(countOverlaps(sim)).toBe(0);
    expect(RAIL_DT).toBeGreaterThan(0);
  });
});
