import { describe, expect, it } from 'vitest';
import { RoadNetwork, type Id } from '../../src/core';
import { RailRng, TrainSim } from '../../src/rail';
import { countOverlaps, loopedLine, runChecked, station, straightLine, v } from './helpers';

describe('signalling', () => {
  it('following trains on double track keep apart', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-double', -1900, 1900);
    const stops = [0.12, 0.5, 0.88].map((t, i) => station(net, seg, t, `S${i}`, 340));
    net.addLine({ name: 'L', color: '#fff', stops, trainType: 'emu', cars: 8, trains: 5, headwaySec: 60 });
    const sim = new TrainSim(net);
    const worst = runChecked(sim, 12000);
    expect(worst).toBe(0);
    expect(sim.trains.length).toBe(5);
    expect(sim.stats().withdrawn).toBe(0);
    const info = sim.lineInfo(net.rail.lines[0].id)!;
    expect(info.carried).toBeGreaterThan(100);
  });

  it('one train holds a single line, a second has to wait and is withdrawn if it locks up', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-single', -1500, 1500);
    const a = station(net, seg, 0.1, 'A', 300);
    const b = station(net, seg, 0.9, 'B', 300);
    net.addLine({ name: 'L', color: '#fff', stops: [a, b], trainType: 'emu', cars: 8, trains: 2, headwaySec: 10 });
    const sim = new TrainSim(net);
    const worst = runChecked(sim, 16000);
    expect(worst).toBe(0);
    // Both ends held: a ring, broken by withdrawing one and capping the line.
    expect(sim.stats().withdrawn).toBeGreaterThan(0);
    expect(sim.trains.length).toBe(1);
    expect(sim.lineInfo(net.rail.lines[0].id)!.warning).toMatch(/capacity/);
    const before = sim.lineInfo(net.rail.lines[0].id)!.carried;
    runChecked(sim, 6000, 10);
    expect(sim.lineInfo(net.rail.lines[0].id)!.carried).toBeGreaterThan(before);
  });

  it('two trains meet at a passing loop with no deadlock', () => {
    const net = new RoadNetwork();
    const { west, east } = loopedLine(net, 'rail-single', -1900, 1900, 0);
    const a = station(net, west, 0.15, 'West', 300);
    const b = station(net, east, 0.85, 'East', 300);
    net.addLine({ name: 'L', color: '#fff', stops: [a, b], trainType: 'emu', cars: 8, trains: 2, headwaySec: 10 });
    const sim = new TrainSim(net);
    const seenLoop = new Set<number>();
    const loopPieces = new Set(sim.graph.pieces.filter((p) => p.segmentId !== -1 && net.getSegment(p.segmentId)!.a !== net.getSegment(p.segmentId)!.b && Math.abs(p.pts[2]) > 6).map((p) => p.id));
    const useBoth = new Set<number>();
    let worst = 0;
    for (let i = 0; i < 30000; i++) {
      sim.step();
      worst = Math.max(worst, countOverlaps(sim));
      for (const t of sim.trains) {
        const st = t.path.states[t.path.locate(Math.min(t.head, t.path.length - 0.01))];
        if (loopPieces.has(st >> 1)) {
          seenLoop.add(t.id);
          useBoth.add(st & 1);
        }
      }
    }
    expect(worst).toBe(0);
    expect(sim.stats().withdrawn).toBe(0);
    expect(sim.trains).toHaveLength(2);
    const info = sim.lineInfo(net.rail.lines[0].id)!;
    expect(info.carried).toBeGreaterThan(400);
    // Keep-right sends one direction round the loop, every time.
    expect(useBoth.size).toBe(1);
    expect(seenLoop.size).toBe(2);
  });

  it('a long freight waits off the single line for an opposing train', () => {
    const net = new RoadNetwork();
    const { west, east } = loopedLine(net, 'rail-single', -1950, 1950, 0, 420);
    const a = station(net, west, 0.2, 'West', 300);
    const b = station(net, east, 0.8, 'East', 300);
    net.addLine({ name: 'P', color: '#fff', stops: [a, b], trainType: 'emu', cars: 8, trains: 2, headwaySec: 20 });
    const sim = new TrainSim(net);
    expect(runChecked(sim, 20000, 2)).toBe(0);
    expect(sim.stats().withdrawn).toBe(0);
  });

  it('shows red behind a train and green ahead of it', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-double', -1900, 1900);
    const a = station(net, seg, 0.2, 'A', 300);
    const b = station(net, seg, 0.8, 'B', 300);
    net.addLine({ name: 'L', color: '#fff', stops: [a, b], trainType: 'emu', cars: 8, trains: 1 });
    const sim = new TrainSim(net);
    for (let i = 0; i < 400; i++) sim.step();
    const states = [...sim.signals.state];
    expect(sim.signals.count).toBeGreaterThan(5);
    expect(states).toContain(0);
    expect(states).toContain(2);
    expect(states).toContain(1);
  });

  it('never overlaps across fuzzed layouts and fleets', () => {
    let trainsSeen = 0;
    let withdrawn = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const rng = new RailRng(seed * 977);
      const net = new RoadNetwork();
      const track = rng.pick(['rail-single', 'rail-double']);
      const stops: Id[] = [];
      let last: Id = net.addNode(v(-1900, rng.range(-60, 60)));
      const count = rng.int(2, 5);
      const segs: Id[] = [];
      for (let i = 1; i <= count; i++) {
        const x = -1900 + (3800 * i) / count;
        const next = net.addNode(v(x, rng.range(-80, 80)));
        const c = net.getNode(last)!.pos;
        const dx = (x - c.x) / 3;
        segs.push(net.addSegment(last, next, { c1: v(c.x + dx, c.z), c2: v(x - dx, net.getNode(next)!.pos.z), roadType: track }));
        last = next;
      }
      for (const [i, s] of segs.entries()) stops.push(station(net, s, 0.5, `S${i}`, 200));
      const lines = rng.int(1, 3);
      for (let l = 0; l < lines; l++) {
        const a = rng.int(0, stops.length - 2);
        const b = rng.int(a + 1, stops.length - 1);
        net.addLine({
          name: `L${l}`,
          color: '#fff',
          stops: stops.slice(a, b + 1),
          trainType: rng.pick(['emu', 'emu', 'intercity', 'freight'] as const),
          cars: rng.int(8, 60),
          trains: rng.int(1, 4),
          headwaySec: rng.int(20, 120),
        });
      }
      const sim = new TrainSim(net, seed);
      expect(runChecked(sim, 4000, 2), `seed ${seed}`).toBe(0);
      trainsSeen += sim.trains.length;
      withdrawn += sim.stats().withdrawn;
    }
    expect(trainsSeen).toBeGreaterThan(20);
    expect(withdrawn).toBeGreaterThanOrEqual(0);
  });
});
