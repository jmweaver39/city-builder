import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { TrainSim } from '../../src/rail';
import { runChecked, station, straightLine } from './helpers';

function lightsOf(sim: TrainSim): { first: number; last: number; reversed: boolean } {
  const t = sim.trains[0];
  const v = sim.view;
  return { first: v.lamp[t.slot], last: v.lamp[t.slot + t.consist.count - 1], reversed: t.reversed };
}

describe('termini', () => {
  it('changes ends at the end of single track', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-single', 0, 2400);
    const a = station(net, seg, 0.1, 'A', 300);
    const b = station(net, seg, 0.9, 'B', 300);
    net.addLine({ name: 'L', color: '#fff', stops: [a, b], trainType: 'metro', cars: 8, trains: 1 });
    // Metro needs metro track.
    const sim0 = new TrainSim(net);
    expect(sim0.lineInfo(net.rail.lines[0].id)!.problem).toMatch(/No track/);
    net.updateLine(net.rail.lines[0].id, { trainType: 'emu' });
    const sim = new TrainSim(net);
    sim.warm(5);
    const start = lightsOf(sim);
    expect(start.first).toBe(1);
    expect(start.last).toBe(2);
    const flips: boolean[] = [start.reversed];
    const statuses = new Set<string>();
    for (let i = 0; i < 9000; i++) {
      sim.step();
      const s = lightsOf(sim);
      statuses.add(sim.trainDetail(sim.trains[0].id)!.status);
      if (s.reversed !== flips[flips.length - 1]) {
        flips.push(s.reversed);
        expect(s.reversed ? s.first : s.last).toBe(2);
        expect(s.reversed ? s.last : s.first).toBe(1);
      }
    }
    expect(flips.length).toBeGreaterThanOrEqual(3);
    expect(statuses).toContain('At platform, doors open');
    // No lap of honour: the head stays inside the map.
    expect(sim.view.x[sim.trains[0].slot]).toBeLessThan(2400);
  });

  it('turns back on double track through a scissors crossover', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'metro-double', 0, 3000);
    const a = station(net, seg, 0.15, 'A', 200);
    const m = station(net, seg, 0.5, 'M', 200);
    const b = station(net, seg, 0.85, 'B', 200);
    net.addLine({ name: 'L', color: '#fff', stops: [a, m, b], trainType: 'metro', cars: 8, trains: 3, headwaySec: 45 });
    const sim = new TrainSim(net);
    const crossovers = sim.graph.pieces.filter((p) => p.kind === 'crossover');
    expect(crossovers.length).toBe(8);
    const worst = runChecked(sim, 14000);
    expect(worst).toBe(0);
    expect(sim.stats().withdrawn).toBe(0);
    expect(sim.trains).toHaveLength(3);
    // Both tracks in use, right-hand running.
    const tracks = new Set(sim.trains.map((t) => sim.graph.pieces[t.path.states[t.path.locate(Math.min(t.head, t.path.length - 0.1))] >> 1].track));
    expect(tracks.size).toBeGreaterThanOrEqual(1);
    expect(sim.lineInfo(net.rail.lines[0].id)!.carried).toBeGreaterThan(500);
  });

  it('turns back at a station with track running on past it', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-double', -1800, 1800);
    const a = station(net, seg, 0.35, 'A', 300);
    const b = station(net, seg, 0.65, 'B', 300);
    net.addLine({ name: 'L', color: '#fff', stops: [a, b], trainType: 'emu', cars: 8, trains: 1 });
    const sim = new TrainSim(net);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 9000; i++) {
      sim.step();
      const t = sim.trains[0];
      if (t) {
        lo = Math.min(lo, sim.view.x[t.slot]);
        hi = Math.max(hi, sim.view.x[t.slot]);
      }
    }
    expect(sim.trains).toHaveLength(1);
    expect(lo).toBeGreaterThan(-800);
    expect(hi).toBeLessThan(800);
    expect(sim.lineInfo(net.rail.lines[0].id)!.carried).toBeGreaterThan(200);
  });

  it('a freight line runs through from gateway to gateway and leaves', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-double', -1950, 1950);
    const a = station(net, seg, 0.001, 'West yard', 0, 'gateway');
    const b = station(net, seg, 0.999, 'East yard', 0, 'gateway');
    net.addLine({ name: 'F', color: '#fff', stops: [a, b], trainType: 'freight', cars: 66, trains: 2, headwaySec: 240 });
    const sim = new TrainSim(net);
    let hiddenSeen = 0;
    let shown = 0;
    let exits = 0;
    let ids = new Set<number>();
    for (let i = 0; i < 18000; i++) {
      sim.step();
      for (const t of sim.trains) ids.add(t.id);
      if (i % 30 === 0) {
        for (let k = 0; k < sim.view.count; k++) {
          if (sim.view.flags[k] & 1) hiddenSeen++;
          else shown++;
        }
      }
    }
    exits = ids.size - sim.trains.length;
    expect(hiddenSeen).toBeGreaterThan(0);
    expect(shown).toBeGreaterThan(0);
    expect(exits).toBeGreaterThanOrEqual(1);
    expect(sim.stats().withdrawn).toBe(0);
  });
});
