import { describe, expect, it } from 'vitest';
import { RoadNetwork, segmentElectrification } from '../../src/core';
import { History } from '../../src/app/History';
import { connectedTrack, setElectrification } from '../../src/tools/RailTools';
import { buildTrackGraph, TrainSim, TRAIN_TYPES, makeConsist, RailRng, CAR_KINDS } from '../../src/rail';
import { rig } from '../tools/helpers';
import { runChecked, station, v } from './helpers';

const power = (net: RoadNetwork, id: number) => segmentElectrification(net.roadTypeOf(id), net.getSegment(id)!.overrides);

/** Three pieces of double track in a row, with stations at both ends. */
function line(track = 'rail-double') {
  const net = new RoadNetwork();
  const n = [-1800, -600, 600, 1800].map((x) => net.addNode(v(x, 0)));
  const segs = [0, 1, 2].map((i) => net.addSegment(n[i], n[i + 1], { roadType: track }));
  const a = station(net, segs[0], 0.4, 'A', 300);
  const b = station(net, segs[2], 0.6, 'B', 300);
  return { net, segs, a, b };
}

describe('electrification is stored per segment', () => {
  it('defaults to wires on main line, third rail on metro, and old saves load unchanged', () => {
    const { net, segs } = line();
    expect(power(net, segs[0])).toBe('overhead');
    const metro = line('metro-double');
    expect(power(metro.net, metro.segs[0])).toBe('thirdRail');
    const text = net.serialize();
    expect(text).not.toContain('electrification');
    expect(new RoadNetwork(text).signature()).toBe(net.signature());
  });

  it('survives split, reverse, save and undo', () => {
    const { net, segs } = line();
    const history = new History(net);
    history.hint('De-electrify');
    expect(setElectrification(net, [segs[1]], false)).toBe(1);
    expect(power(net, segs[1])).toBe('none');
    const r = net.splitSegment(segs[1], 0.5);
    expect(power(net, r.left)).toBe('none');
    expect(power(net, r.right!)).toBe('none');
    net.reverseSegment(r.right!);
    const flipped = r.right!;
    expect(power(net, flipped)).toBe('none');
    const copy = new RoadNetwork(net.serialize());
    expect(power(copy, r.left)).toBe('none');
    expect(power(copy, flipped)).toBe('none');
    // Undo everything: the wires come back.
    while (history.canUndo) history.undo();
    expect(power(net, segs[1])).toBe('overhead');
    history.redo();
    expect(power(net, segs[1])).toBe('none');
  });

  it('putting wires back clears the override instead of storing the default', () => {
    const { net, segs } = line();
    const before = net.signature();
    setElectrification(net, segs, false);
    expect(net.signature()).not.toBe(before);
    setElectrification(net, segs, true);
    expect(net.getSegment(segs[0])!.overrides.electrification).toBeUndefined();
    expect(net.signature()).toBe(before);
    expect(setElectrification(net, segs, true)).toBe(0);
  });

  it('whole line follows track end to end and stops at junctions', () => {
    const { net, segs } = line();
    expect(connectedTrack(net, segs[0]).sort()).toEqual([...segs].sort());
    net.drawRoad({ start: { kind: 'segment', id: segs[1], t: 0.5 }, end: { kind: 'free', pos: v(500, 300) }, c1: v(100, 0), c2: v(300, 100), roadType: 'rail-double' });
    expect(connectedTrack(net, segs[0])).toHaveLength(2);
  });
});

describe('power and routing', () => {
  it('track pieces and links carry power only where the track does', () => {
    const { net, segs } = line();
    setElectrification(net, [segs[1]], false);
    const g = buildTrackGraph(net);
    for (const p of g.pieces.filter((x) => x.kind === 'run')) expect(p.electrified).toBe(p.segmentId !== segs[1]);
  });

  it('an electric line warns where the wires stop and offers a diesel, which then runs', () => {
    const { net, segs, a, b } = line();
    const id = net.addLine({ name: 'L', color: '#fff', stops: [a, b], trainType: 'emu', cars: 8, trains: 2 });
    const sim = new TrainSim(net);
    runChecked(sim, 600, 50);
    expect(sim.trains.length).toBeGreaterThan(0);
    setElectrification(net, [segs[1]], false);
    sim.step();
    const info = sim.lineInfo(id)!;
    expect(info.problem).toMatch(/overhead wire/);
    expect(info.fixType).toBe('dieselCommuter');
    expect(sim.trains).toHaveLength(0);
    net.updateLine(id, { trainType: info.fixType!, cars: TRAIN_TYPES.dieselCommuter.defaultCars });
    expect(runChecked(sim, 4000, 10)).toBe(0);
    expect(sim.lineInfo(id)!.problem).toBeNull();
    expect(sim.trains.length).toBeGreaterThan(0);
    expect(sim.lineInfo(id)!.carried).toBeGreaterThan(0);
  });

  it('diesels run anywhere; metro needs its third rail and has no diesel to offer', () => {
    const { net, segs, a, b } = line();
    setElectrification(net, segs, false);
    const sim = new TrainSim(net);
    for (const t of ['freight', 'dieselCommuter', 'dieselIntercity'] as const) {
      expect(sim.checkLine({ name: 'x', color: '#fff', stops: [a, b], trainType: t, cars: TRAIN_TYPES[t].defaultCars, trains: 1 }).problem, t).toBeNull();
    }
    for (const t of ['emu', 'intercity', 'highspeed'] as const) {
      expect(sim.checkLine({ name: 'x', color: '#fff', stops: [a, b], trainType: t, cars: TRAIN_TYPES[t].defaultCars, trains: 1 }).problem, t).toMatch(/overhead/);
    }
    const metro = line('metro-double');
    setElectrification(metro.net, [metro.segs[1]], false);
    const ms = new TrainSim(metro.net);
    const check = ms.checkLine({ name: 'm', color: '#fff', stops: [metro.a, metro.b], trainType: 'metro', cars: 8, trains: 1 });
    expect(check.problem).toMatch(/third rail/);
    expect(check.fixType).toBeNull();
  });

  it('has American diesels: road switchers on freight and a push-pull commuter', () => {
    const rng = new RailRng(5);
    const c = makeConsist('dieselCommuter', 6, rng);
    expect(CAR_KINDS[c.kinds[0]].id).toBe('dieselLoco');
    expect(CAR_KINDS[c.kinds[1]].id).toBe('bilevel');
    expect(CAR_KINDS[c.kinds[c.count - 1]].id).toBe('bilevelCab');
    expect(c.flip[c.count - 1]).toBe(1);
    const f = makeConsist('freight', 100, rng);
    expect([...f.kinds].filter((k) => CAR_KINDS[k].id === 'dieselLoco').length).toBeGreaterThanOrEqual(2);
    expect(TRAIN_TYPES.freight.power).toBe('diesel');
  });
});

describe('electrify tool and hotkey', () => {
  it('a sweep is one undo step, and O over track toggles it from any tool', () => {
    const { net, segs } = line();
    const r = rig(null, net);
    const history = (r as unknown as { history: History }).history;
    r.tools.setTool('electrify');
    r.tools.electrify.electrify = false;
    r.drag([
      [-1500, 0],
      [-600, 0],
      [300, 0],
    ]);
    expect(power(net, segs[0])).toBe('none');
    expect(power(net, segs[1])).toBe('none');
    expect(power(net, segs[2])).toBe('overhead');
    history.undo();
    expect(segs.map((s) => power(net, s))).toEqual(['overhead', 'overhead', 'overhead']);
    r.tools.setTool('select');
    r.hover(1200, 0);
    expect(r.key('o')).toBe(true);
    expect(power(net, segs[2])).toBe('none');
    expect(r.key('o', { shift: true })).toBe(true);
    expect(segs.map((s) => power(net, s))).toEqual(['overhead', 'overhead', 'overhead']);
    r.hover(0, 900);
    expect(r.key('o')).toBe(false);
  });
});
