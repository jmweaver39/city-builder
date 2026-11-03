import { describe, expect, it } from 'vitest';
import { parseProject, RoadNetwork } from '../../src/core';
import { History } from '../../src/app/History';
import { TrainSim } from '../../src/rail';
import { runChecked, station, straightLine, v } from './helpers';

function line() {
  const net = new RoadNetwork();
  const { seg } = straightLine(net, 'rail-double', -1900, 1900);
  const a = station(net, seg, 0.15, 'A', 300);
  const b = station(net, seg, 0.5, 'B', 300);
  const c = station(net, seg, 0.85, 'C', 300);
  const id = net.addLine({ name: 'L', color: '#e33', stops: [a, b, c], trainType: 'emu', cars: 8, trains: 4, headwaySec: 60 });
  return { net, seg, id, stations: [a, b, c] };
}

describe('edits under running trains', () => {
  it('keeps trains where they are when the track is split', () => {
    const { net, seg } = line();
    const sim = new TrainSim(net);
    runChecked(sim, 3000, 20);
    const before = sim.trains.map((t) => ({ id: t.id, x: sim.view.x[t.slot], z: sim.view.z[t.slot] }));
    expect(before.length).toBeGreaterThan(1);
    net.splitSegment(seg, 0.3);
    net.splitSegment(net.segments[net.segments.length - 1].id, 0.6);
    sim.step();
    for (const b of before) {
      const t = sim.trains.find((x) => x.id === b.id);
      expect(t, `train ${b.id}`).toBeDefined();
      expect(Math.hypot(sim.view.x[t!.slot] - b.x, sim.view.z[t!.slot] - b.z)).toBeLessThan(3);
    }
    expect(net.rail.stations).toHaveLength(3);
    expect(runChecked(sim, 3000, 5)).toBe(0);
    expect(sim.stats().removedByEdit).toBe(0);
  });

  it('removes trains whose track is bulldozed, and the line carries on where it can', () => {
    const { net, seg, id } = line();
    const sim = new TrainSim(net);
    runChecked(sim, 3000, 20);
    const r = net.splitSegment(seg, 0.62);
    net.removeSegment(r.right!);
    expect(() => runChecked(sim, 50)).not.toThrow();
    expect(net.rail.stations).toHaveLength(2);
    expect(net.rail.lines.find((l) => l.id === id)!.stops).toHaveLength(2);
    expect(runChecked(sim, 4000, 5)).toBe(0);
    expect(sim.lineInfo(id)!.problem).toBeNull();
    expect(sim.trains.length).toBeGreaterThan(0);
  });

  it('survives deleting every piece of track', () => {
    const { net } = line();
    const sim = new TrainSim(net);
    runChecked(sim, 2000, 50);
    net.batch(() => {
      for (const s of [...net.segments]) net.removeSegment(s.id);
    });
    runChecked(sim, 100);
    expect(sim.trains).toHaveLength(0);
    expect(net.rail.stations).toHaveLength(0);
  });

  it('reroutes when a curve is moved under a train', () => {
    const { net, seg } = line();
    const sim = new TrainSim(net);
    runChecked(sim, 2500, 50);
    const s = net.getSegment(seg)!;
    const n = net.getNode(s.b)!;
    net.moveNode(n.id, v(n.pos.x, n.pos.z + 40));
    expect(() => runChecked(sim, 2000, 5)).not.toThrow();
  });

  it('undo brings a deleted line back and trains run again', () => {
    const { net, id } = line();
    const history = new History(net);
    const sim = new TrainSim(net);
    runChecked(sim, 1500, 50);
    net.removeLine(id);
    sim.step();
    expect(sim.trains).toHaveLength(0);
    history.undo();
    runChecked(sim, 1500, 50);
    expect(sim.trains.length).toBeGreaterThan(0);
  });

  it('changing the train type of a line swaps its trains', () => {
    const { net, id } = line();
    const sim = new TrainSim(net);
    runChecked(sim, 1500, 50);
    net.updateLine(id, { trainType: 'intercity', cars: 12, trains: 1 });
    runChecked(sim, 2000, 50);
    expect(sim.trains.every((t) => t.consist.type.id === 'intercity')).toBe(true);
    expect(sim.trains.length).toBe(1);
  });
});

describe('save and load', () => {
  it('round trips stations and lines', () => {
    const { net } = line();
    const text = net.serialize();
    const copy = new RoadNetwork(text);
    expect(copy.rail).toEqual(net.rail);
    expect(copy.serialize()).toBe(text);
    const sim = new TrainSim(copy);
    runChecked(sim, 1500, 50);
    expect(sim.trains.length).toBeGreaterThan(0);
  });

  it('loads old saves with no rail block and keeps their signature', () => {
    const net = new RoadNetwork();
    straightLine(net, 'street-2', 0, 100);
    const text = net.serialize();
    expect(text).not.toContain('rail');
    const copy = new RoadNetwork(text);
    expect(copy.signature()).toBe(net.signature());
    expect(copy.rail.stations).toEqual([]);
  });

  it('drops stations on missing track and stops at missing stations', () => {
    const { net } = line();
    const data = JSON.parse(net.serialize());
    data.rail.stations[0].segmentId = 9999;
    const p = parseProject(data);
    expect(p.rail!.stations).toHaveLength(2);
    expect(p.rail!.lines[0].stops).toHaveLength(2);
  });

  it('undo and redo cover station and line edits', () => {
    const { net, seg } = line();
    const history = new History(net);
    history.hint('Add station');
    const id = station(net, seg, 0.32, 'Extra', 200);
    expect(net.rail.stations).toHaveLength(4);
    history.undo();
    expect(net.rail.stations).toHaveLength(3);
    history.redo();
    expect(net.rail.stations.map((s) => s.id)).toContain(id);
  });
});
