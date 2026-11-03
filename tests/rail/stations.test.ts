import { describe, expect, it } from 'vitest';
import { RoadNetwork, stationLayout } from '../../src/core';
import { History } from '../../src/app/History';
import { buildTrackGraph, checkPlatform, stationKindAt, TrainSim, FLAG_DOORS, FLAG_DOORS_R, stationEntrances, ISLAND_HALF } from '../../src/rail';
import { rig } from '../tools/helpers';
import { station, straightLine, v } from './helpers';

const sidesOf = (net: RoadNetwork, id: number) => buildTrackGraph(net).stations.get(id)!.stops.map((s) => [s.track, s.sides]);

describe('platform layouts', () => {
  it('old stations keep their layout: both sides on double track, right on single', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-double', -1000, 1000);
    const id = station(net, seg, 0.5, 'A', 200);
    expect(net.serialize()).not.toContain('layout');
    expect(sidesOf(net, id)).toEqual([[0, 1], [1, 2]]);
    const single = new RoadNetwork();
    const s = straightLine(single, 'rail-single', -1000, 1000);
    const id2 = station(single, s.seg, 0.5, 'B', 200);
    expect(stationLayout(single.rail.stations[0], single.roadTypeOf(s.seg))).toBe('right');
    expect(sidesOf(single, id2)).toEqual([[0, 2]]);
  });

  it('left and right side platforms serve only the track beside them', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-double', -1000, 1000);
    const id = net.addStation({ name: 'L', kind: 'surface', segmentId: seg, t: 0.5, platformLength: 200, layout: 'left' });
    expect(sidesOf(net, id)).toEqual([[0, 1]]);
    net.updateStation(id, { layout: 'right' });
    expect(sidesOf(net, id)).toEqual([[1, 2]]);
  });

  it('double track spreads round an island and the platform sits between', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-double', -1000, 1000);
    const id = net.addStation({ name: 'I', kind: 'surface', segmentId: seg, t: 0.5, platformLength: 200, layout: 'island' });
    const g = buildTrackGraph(net);
    expect(g.stations.get(id)!.stops.map((s) => [s.track, s.sides])).toEqual([[0, 2], [1, 1]]);
    // Tracks are ISLAND_HALF either side at the platform, and back to normal far away.
    const at = (track: number, x: number) => {
      const near = g.nearest(v(x, track === 0 ? -ISLAND_HALF : ISLAND_HALF), 6);
      return near ? g.pieces[near.piece].track === track : false;
    };
    expect(at(0, 0)).toBe(true);
    expect(at(1, 0)).toBe(true);
    const far = g.nearest(v(-800, -2.25), 0.5);
    expect(far).not.toBeNull();
  });

  it('opens doors on the platform side only', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-single', -1500, 1500);
    const a = net.addStation({ name: 'A', kind: 'surface', segmentId: seg, t: 0.15, platformLength: 260, layout: 'left' });
    const b = net.addStation({ name: 'B', kind: 'surface', segmentId: seg, t: 0.85, platformLength: 260, layout: 'right' });
    net.addLine({ name: 'L', color: '#fff', stops: [a, b], trainType: 'emu', cars: 8, trains: 1 });
    const sim = new TrainSim(net);
    const seen = new Set<string>();
    for (let i = 0; i < 9000; i++) {
      sim.step();
      const t = sim.trains[0];
      if (!t || t.state !== 'dwell' || t.timer < 4) continue;
      const k = t.slot + 2;
      const f = sim.view.flags[k];
      const doors = f & (FLAG_DOORS | FLAG_DOORS_R);
      if (!doors) continue;
      // World side of the open doors: left of the car is -x local.
      const yaw = sim.view.yaw[k];
      const localX = { x: Math.cos(yaw), z: -Math.sin(yaw) };
      const sx = f & FLAG_DOORS_R ? 1 : -1;
      const doorZ = localX.z * sx;
      // The line runs along x; segment right (+lateral) is +z. Left platform: doors face -z.
      const stop = sim.view.x[k] < 0 ? 'A' : 'B';
      seen.add(`${stop}:${doorZ > 0 ? 'right' : 'left'}:${doors === (FLAG_DOORS | FLAG_DOORS_R) ? 'both' : 'one'}`);
    }
    expect(seen).toEqual(new Set(['A:left:one', 'B:right:one']));
  });
});

describe('levels and checks', () => {
  it('picks elevated on a viaduct and underground in a tunnel', () => {
    expect(stationKindAt(v(0, 0, 12))).toBe('elevated');
    expect(stationKindAt(v(0, 0, -12))).toBe('underground');
    expect(stationKindAt(v(0, 0, 0))).toBe('surface');
  });

  it('refuses a platform over a road, on a tight curve, or an island with no room', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-double', -1000, 1000);
    const ok = checkPlatform(net, seg, 0.5, 200, { left: 8, right: 8 }, 'surface', false);
    expect(ok.problems).toEqual([]);
    net.addSegment(net.addNode(v(-300, 12)), net.addNode(v(300, 12)), { roadType: 'street-2' });
    const road = checkPlatform(net, seg, 0.5, 200, { left: 8, right: 8 }, 'surface', false);
    expect(road.problems.join()).toMatch(/overlap a road/);
    // Underground under the same road is fine; under other tunnels it is not.
    const tunnel = new RoadNetwork();
    const t = tunnel.addSegment(tunnel.addNode(v(-1000, 0, -12)), tunnel.addNode(v(1000, 0, -12)), { roadType: 'metro-double' });
    tunnel.addSegment(tunnel.addNode(v(-300, 12)), tunnel.addNode(v(300, 12)), { roadType: 'street-2' });
    expect(checkPlatform(tunnel, t, 0.5, 180, { left: 8, right: 8 }, 'underground', false).problems).toEqual([]);
    tunnel.addSegment(tunnel.addNode(v(-300, 9, -10)), tunnel.addNode(v(300, 9, -10)), { roadType: 'metro-single' });
    expect(checkPlatform(tunnel, t, 0.5, 180, { left: 8, right: 8 }, 'underground', false).problems.join()).toMatch(/station box would overlap other track/);
    const curvy = new RoadNetwork();
    const c = curvy.addSegment(curvy.addNode(v(0, 0)), curvy.addNode(v(200, 200)), { c1: v(110, 0), c2: v(200, 90), roadType: 'rail-double' });
    expect(checkPlatform(curvy, c, 0.5, 200, { left: 8, right: 8 }, 'surface', false).problems.join()).toMatch(/gently curved/);
    const short = new RoadNetwork();
    const sh = straightLine(short, 'rail-double', 0, 300);
    expect(checkPlatform(short, sh.seg, 0.5, 200, { left: 8, right: 8 }, 'surface', true).problems.join()).toMatch(/island needs/);
  });

  it('puts subway entrances beside the nearest road', () => {
    const net = new RoadNetwork();
    net.addSegment(net.addNode(v(-500, 60)), net.addNode(v(500, 60)), { roadType: 'street-2' });
    const [e] = stationEntrances(net, [v(0, 0, -12)], { x: 0, z: 1 });
    expect(e.onStreet).toBe(true);
    // On the station side of the road, beside the pavement, not in the road.
    expect(e.pos.z).toBeLessThan(60 - 5);
    expect(e.pos.z).toBeGreaterThan(40);
    const [lonely] = stationEntrances(new RoadNetwork(), [v(0, 0, -12)], { x: 0, z: 1 });
    expect(lonely.onStreet).toBe(false);
  });
});

describe('layout persistence', () => {
  it('survives split, reverse, save and undo', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-double', -1000, 1000);
    const history = new History(net);
    history.hint('Add');
    const id = net.addStation({ name: 'S', kind: 'elevated', segmentId: seg, t: 0.7, platformLength: 200, layout: 'left', building: 'right' });
    const st = () => net.rail.stations.find((s) => s.id === id)!;
    net.splitSegment(seg, 0.3);
    expect(st().layout).toBe('left');
    net.reverseSegment(st().segmentId);
    expect(st().layout).toBe('right');
    expect(st().building).toBe('left');
    const copy = new RoadNetwork(net.serialize());
    expect(copy.rail.stations[0]).toEqual(st());
    history.undo();
    expect(st().layout).toBe('left');
    while (history.canUndo) history.undo();
    expect(net.rail.stations).toHaveLength(0);
    history.redo();
    expect(st().kind).toBe('elevated');
  });

  it('the station tool places the side under the cursor, and ] and [ change it', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-double', -1000, 1000);
    const r = rig(null, net);
    const trains = new TrainSim(net);
    r.tools.setRail({ trains, pickTrain: () => null });
    r.tools.setTool('station');
    r.hover(-300, -3);
    r.click(-300, -3);
    expect(net.rail.stations[0].layout).toBe('left');
    r.hover(300, 3);
    r.key('[');
    r.click(300, 3);
    expect(net.rail.stations[1].layout).toBe('left');
    r.key('[');
    r.key(']');
    r.key(']');
    r.hover(700, 0);
    expect(seg).toBeDefined();
  });
});

describe('stations do not overlap', () => {
  it('refuses a second station whose platforms overlap the first on the same track', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-double', -1000, 1000);
    net.addStation({ name: 'First', kind: 'surface', segmentId: seg, t: 0.5, platformLength: 200 });
    const reach = { left: 7.5, right: 7.5 };
    // 100 m away with 200 m platforms: they overlap by 100 m.
    expect(checkPlatform(net, seg, 0.55, 200, reach, 'surface', false).problems.join()).toMatch(/overlap First station/);
    // 250 m away they do not.
    expect(checkPlatform(net, seg, 0.625, 200, reach, 'surface', false).problems).toEqual([]);
  });

  it('refuses an underground station on a second tunnel that runs through an existing station box', () => {
    const net = new RoadNetwork();
    const a = net.addSegment(net.addNode(v(-1000, 0, -12)), net.addNode(v(1000, 0, -12)), { roadType: 'metro-double' });
    net.addStation({ name: 'Deep', kind: 'underground', segmentId: a, t: 0.5, platformLength: 180, layout: 'island' });
    // A second line crossing under at a shallow angle at the same depth: its box clashes.
    const b = net.addSegment(net.addNode(v(-600, -60, -12)), net.addNode(v(600, 60, -12)), { roadType: 'metro-double' });
    const reach = { left: 7.5, right: 7.5 };
    expect(checkPlatform(net, b, 0.5, 180, reach, 'underground', false).problems.join()).toMatch(/station box would overlap (Deep station|other track)/);
    // The same crossing 12 m deeper is clear of the box.
    const deep = new RoadNetwork();
    const a2 = deep.addSegment(deep.addNode(v(-1000, 0, -12)), deep.addNode(v(1000, 0, -12)), { roadType: 'metro-double' });
    deep.addStation({ name: 'Deep', kind: 'underground', segmentId: a2, t: 0.5, platformLength: 180, layout: 'island' });
    const b2 = deep.addSegment(deep.addNode(v(-600, -60, -24)), deep.addNode(v(600, 60, -24)), { roadType: 'metro-double' });
    expect(checkPlatform(deep, b2, 0.5, 180, reach, 'underground', false).problems).toEqual([]);
  });

  it('a station cannot sit on top of another line passing just beside it at the same level', () => {
    const net = new RoadNetwork();
    const a = net.addSegment(net.addNode(v(-1000, 0, -12)), net.addNode(v(1000, 0, -12)), { roadType: 'metro-double' });
    net.addSegment(net.addNode(v(-1000, 9, -12)), net.addNode(v(1000, 9, -12)), { roadType: 'metro-single' });
    expect(checkPlatform(net, a, 0.5, 180, { left: 7.5, right: 7.5 }, 'underground', false).problems.join()).toMatch(/other track/);
  });
});
