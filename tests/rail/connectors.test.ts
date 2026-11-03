import { describe, expect, it } from 'vitest';
import { canLink, RoadNetwork, checkNetworkInvariants, type GLane } from '../../src/core';
import { buildTrackGraph } from '../../src/rail';
import { straightLine, v } from './helpers';

const railLanes = (net: RoadNetwork): GLane[] => net.laneGraph.lanes.filter((l) => l.vehicleKind === 'rail');

describe('rail connectors', () => {
  it('rail links only to rail', () => {
    expect(canLink('rail', 'rail')).toBe(true);
    for (const k of ['drive', 'bus', 'bike'] as const) {
      expect(canLink('rail', k)).toBe(false);
      expect(canLink(k, 'rail')).toBe(false);
    }
  });

  it('a level crossing keeps road and rail apart', () => {
    const net = new RoadNetwork();
    straightLine(net, 'rail-double', -300, 300);
    const r = net.drawRoad({ start: { kind: 'free', pos: v(0, -200) }, end: { kind: 'free', pos: v(0, 200) }, roadType: 'street-2' });
    expect(r.junctions).toHaveLength(1);
    const g = net.laneGraph;
    const conn = g.connectorsAt.get(r.junctions[0])!.map((i) => g.lanes[i]);
    const road = conn.filter((c) => c.vehicleKind !== 'rail');
    const rail = conn.filter((c) => c.vehicleKind === 'rail');
    expect(rail.length).toBeGreaterThan(0);
    expect(road.length).toBeGreaterThan(0);
    for (const c of conn) {
      const from = g.lanes[c.fromLane];
      const to = g.lanes[c.toLane];
      expect(from.vehicleKind === 'rail').toBe(to.vehicleKind === 'rail');
      expect(c.vehicleKind === 'rail').toBe(from.vehicleKind === 'rail');
      for (const k of c.conflicts) expect(g.lanes[k.lane].vehicleKind === 'rail').toBe(c.vehicleKind === 'rail');
    }
    expect(rail.every((c) => c.turn === 'straight')).toBe(true);
    expect(checkNetworkInvariants(net)).toEqual([]);
    expect(net.deadEnds()).toHaveLength(2);
  });

  it('a dead end of track has no way round', () => {
    const net = new RoadNetwork();
    straightLine(net, 'rail-double', 0, 400);
    expect(railLanes(net).filter((l) => l.kind === 'connector')).toEqual([]);
    expect(net.deadEnds()).toEqual([]);
  });

  it('has a slow turnout on the branch and line speed straight on', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-single', -600, 600);
    const r = net.drawRoad({
      start: { kind: 'segment', id: seg, t: 0.5 },
      end: { kind: 'free', pos: v(400, 60) },
      c1: v(140, 0),
      c2: v(260, 30),
      roadType: 'rail-single',
    });
    const node = r.nodes[0];
    const g = net.laneGraph;
    const conn = g.connectorsAt.get(node)!.map((i) => g.lanes[i]);
    expect(conn.length).toBeGreaterThanOrEqual(4);
    const branch = conn.filter((c) => c.turn !== 'straight');
    expect(branch.length).toBeGreaterThan(0);
    for (const c of branch) expect(c.speed).toBeLessThanOrEqual(40 / 3.6 + 1e-6);
    const straight = conn.filter((c) => c.turn === 'straight');
    expect(Math.max(...straight.map((c) => c.speed))).toBeGreaterThan(40 / 3.6);
  });

  it('a flat crossing at a wide angle has no way between the tracks', () => {
    const net = new RoadNetwork();
    straightLine(net, 'rail-single', -500, 500);
    const r = net.drawRoad({ start: { kind: 'free', pos: v(0, -500) }, end: { kind: 'free', pos: v(0, 500) }, roadType: 'rail-single' });
    const g = net.laneGraph;
    const conn = g.connectorsAt.get(r.junctions[0])!.map((i) => g.lanes[i]);
    expect(conn.every((c) => c.turn === 'straight')).toBe(true);
    const tg = buildTrackGraph(net);
    const links = tg.pieces.filter((p) => p.kind === 'link');
    expect(links).toHaveLength(2);
    // The two paths cross, so they are one block.
    expect(links[0].block).toBe(links[1].block);
  });

  it('folds the two lanes of single track into one physical track', () => {
    const net = new RoadNetwork();
    straightLine(net, 'rail-single', 0, 900);
    const tg = buildTrackGraph(net);
    expect(railLanes(net)).toHaveLength(2);
    expect(tg.pieces.every((p) => p.normal === 0)).toBe(true);
    expect(tg.pieces.reduce((sum, p) => sum + p.length, 0)).toBeCloseTo(900, 0);
    expect(tg.ends).toHaveLength(2);
  });

  it('double track joined head on still lines up', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(300, 0));
    const c = net.addNode(v(600, 0));
    net.addSegment(a, b, { roadType: 'rail-double' });
    net.addSegment(c, b, { roadType: 'rail-double' });
    const tg = buildTrackGraph(net);
    for (const p of tg.pieces) {
      expect(tg.next[p.id * 2].length + tg.next[p.id * 2 + 1].length).toBeGreaterThanOrEqual(1);
    }
  });
});
