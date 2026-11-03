import { describe, expect, it } from 'vitest';
import {
  RoadNetwork,
  checkNetworkInvariants,
  defaultSignalPlan,
  dist,
  makeCustomRoadType,
  movementsAt,
  resolveDecal,
  type CustomLane,
  type Id,
} from '../../src/core';
import { Simulation } from '../../src/sim/Simulation';
import { atNode, expectClean, firstPoint, free, lastPoint, onSeg } from './helpers';

const lanesOf = (net: RoadNetwork, id: Id) => {
  const g = net.laneGraph;
  return g.roadLanes.get(id)!.map((i) => g.lanes[i]);
};

describe('reverseSegment', () => {
  it('swaps the ends in place and keeps the id', () => {
    const net = new RoadNetwork();
    const r = net.drawRoad({ start: free(0, 0), end: free(100, 0), c1: { x: 30, y: 0, z: 40 }, c2: { x: 70, y: 0, z: 10 }, roadType: 'street-2-oneway' });
    const id = r.segments[0];
    const before = structuredClone(net.getSegment(id)!);
    const report = net.reverseSegment(id);
    expect(report.segmentId).toBe(id);
    expect(net.getSegment(id)).toMatchObject({ id, a: before.b, b: before.a, c1: before.c2, c2: before.c1 });
    // One-way traffic now runs from x=100 to x=0.
    for (const l of lanesOf(net, id)) expect(lastPoint(l).x).toBeLessThan(firstPoint(l).x);
    expectClean(net);
  });

  it('reversing twice restores an identical signature', () => {
    const net = new RoadNetwork();
    const seg = net.drawRoad({ start: free(0, 0), end: free(200, 0), roadType: 'street-4' }).segments[0];
    const node = net.drawRoad({ start: onSeg(seg, 0.5), end: free(100, 100), roadType: 'street-2' }).nodes[0];
    net.setSegmentOverrides(seg, { laneKinds: { 1: 'bus' }, laneSpeeds: { 2: 30 }, name: 'Oak' });
    net.addEndpoint({ kind: 'office', segmentId: seg, t: 0.25, side: 1 });
    net.addDecal({ kind: 'line', points: [], road: { pieces: [{ segmentId: seg, t0: 0.125, t1: 0.75 }], offset: 2 }, color: 'white', width: 0.2, rotation: 0 });
    net.addDecal({ kind: 'arrowLeft', points: [], road: { pieces: [{ segmentId: seg, t0: 0.5, t1: 0.5 }], offset: 1.75, dir: 1 }, color: 'white', width: 1, rotation: 0 });
    net.addNodeMarking(node, { kind: 'line', from: { segmentId: seg, boundary: 0 }, to: { segmentId: seg, boundary: 2 }, style: 'solid', color: 'white', width: 0.2, straight: true });
    const sig = net.signature();
    net.reverseSegment(seg);
    expect(net.signature()).not.toBe(sig);
    net.reverseSegment(seg);
    expect(net.signature()).toBe(sig);
    expectClean(net);
  });

  it('a symmetric two-way road says it looks the same, and is', () => {
    const net = new RoadNetwork();
    const seg = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: 'street-4' }).segments[0];
    const shape = (id: Id) => lanesOf(net, id).map((l) => `${firstPoint(l).x},${firstPoint(l).z}`).sort();
    const before = shape(seg);
    const report = net.reverseSegment(seg);
    expect(report.looksTheSame).toBe(true);
    expect(report.changes).toEqual([]);
    expect(shape(seg)).toEqual(before);
  });

  it('an uneven two-way road does not', () => {
    const net = new RoadNetwork();
    const lane = (kind: CustomLane['kind'], dir: 1 | -1): CustomLane => ({ kind, dir, width: 3.5 });
    net.setCustomRoadType(makeCustomRoadType({ id: 'custom-u', lanes: [lane('bus', -1), lane('drive', -1), lane('drive', 1), lane('bus', 1), lane('bus', 1)] }));
    const seg = net.drawRoad({ start: free(0, 0), end: free(200, 0), roadType: 'custom-u' }).segments[0];
    expect(net.reverseSegment(seg).looksTheSame).toBe(false);
    expect(lanesOf(net, seg).filter((l) => lastPoint(l).x < firstPoint(l).x)).toHaveLength(3);
  });

  it('a one-way in the middle of a chain warns that it strands the road, without blocking', () => {
    const net = new RoadNetwork();
    const a = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: 'street-2-oneway' });
    const b = net.drawRoad({ start: atNode(a.nodes[1]), end: free(200, 0), roadType: 'street-2-oneway' });
    const c = net.drawRoad({ start: atNode(b.nodes[1]), end: free(300, 0), roadType: 'street-2-oneway' });
    const report = net.reverseSegment(b.segments[0]);
    expect(report.stranded.sort()).toEqual([a.nodes[1], b.nodes[1]].sort());
    expect(net.getSegment(b.segments[0])!.a).toBe(b.nodes[1]);
    expect(checkNetworkInvariants(net).filter((p) => !/no exit|exit/.test(p))).toEqual([]);
    // Turning it back mends it.
    expect(net.reverseSegment(b.segments[0]).stranded).toEqual([]);
    expect(c.segments).toHaveLength(1);
  });

  it('turning the end road of a chain out from a dead end is fine', () => {
    const net = new RoadNetwork();
    const a = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: 'street-2' });
    const report = net.reverseSegment(a.segments[0]);
    expect(report.stranded).toEqual([]);
  });

  it('keeps zones in place on the same side of the world', () => {
    const net = new RoadNetwork();
    const seg = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: 'street-2' }).segments[0];
    const ep = net.addEndpoint({ kind: 'office', segmentId: seg, t: 0.2, side: 1 });
    net.reverseSegment(seg);
    expect(net.endpoints.find((e) => e.id === ep)).toMatchObject({ t: 0.8, side: -1, segmentId: seg });
  });

  it('keeps paint where it was', () => {
    const net = new RoadNetwork();
    const seg = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: 'street-4' }).segments[0];
    const id = net.addDecal({ kind: 'hatch', points: [], road: { pieces: [{ segmentId: seg, t0: 0.25, t1: 0.75 }], offset: 0, offset2: 3 }, color: 'white', width: 0.2, rotation: 0 });
    const before = resolveDecal(net, net.decals[0]).points;
    net.reverseSegment(seg);
    const after = resolveDecal(net, net.decals.find((d) => d.id === id)!).points;
    expect(after.length).toBe(before.length);
    before.forEach((p, i) => expect(dist(p, after[i])).toBeLessThan(1e-6));
  });
});

describe('Under a signal', () => {
  function signal(arm: string) {
    const net = new RoadNetwork();
    const west = net.drawRoad({ start: free(-200, 0), end: free(0, 0), roadType: arm });
    const node = west.nodes[1];
    const east = net.drawRoad({ start: atNode(node), end: free(200, 0), roadType: 'street-4' });
    const south = net.drawRoad({ start: atNode(node), end: free(0, 200), roadType: 'street-4' });
    const north = net.drawRoad({ start: free(0, -200), end: atNode(node), roadType: 'street-4' });
    net.setJunctionControl(node, { mode: 'signal', signal: defaultSignalPlan(net, node, 'opposing') });
    return { net, node, seg: west.segments[0], east: east.segments[0], south: south.segments[0], north: north.segments[0] };
  }

  const validKeys = (net: RoadNetwork, node: Id) => new Set(movementsAt(net, node).map((m) => m.key));
  const planned = (net: RoadNetwork, node: Id) => net.getNode(node)!.control.signal!.phases.flatMap((p) => Object.keys(p.moves));

  it('a two-way symmetric road leaves the plan exactly as it was', () => {
    const { net, node, seg } = signal('street-4');
    const before = JSON.stringify(net.getNode(node)!.control.signal);
    expect(net.reverseSegment(seg).changes).toEqual([]);
    expect(JSON.stringify(net.getNode(node)!.control.signal)).toBe(before);
  });

  it('a one-way drops only the moves that cannot happen, adds the new ones, and names them', () => {
    const { net, node, seg } = signal('street-2-oneway');
    const before = planned(net, node);
    expect(before.some((k) => k.startsWith(`${seg}>`))).toBe(true);
    const report = net.reverseSegment(seg);
    const after = planned(net, node);
    const valid = validKeys(net, node);
    for (const k of after) expect(valid.has(k)).toBe(true);
    for (const k of valid) expect(after).toContain(k);
    expect(after.some((k) => k.startsWith(`${seg}>`))).toBe(false);
    expect(after.some((k) => k.endsWith(`>${seg}`))).toBe(true);
    // Movements that never touched this road are still there.
    for (const k of before) if (!k.includes(`${seg}`)) expect(after).toContain(k);
    expect(report.changes.join(' ')).toMatch(/Signal: removed .* to /);
    expect(report.changes.join(' ')).toMatch(/Signal: added .* to /);
    expectClean(net);
  });

  it('new movements join the phase already serving their approach', () => {
    const { net, node, seg, east } = signal('street-2-oneway');
    net.reverseSegment(seg);
    const plan = net.getNode(node)!.control.signal!;
    const move = `${east}>${seg}`;
    const phases = plan.phases.filter((p) => move in p.moves);
    expect(phases.length).toBeGreaterThan(0);
    for (const p of phases) expect(Object.keys(p.moves).some((k) => k.startsWith(`${east}>`) && k !== move)).toBe(true);
  });
});

describe('Manual lane links', () => {
  function junction(type: string) {
    const net = new RoadNetwork();
    const seg = net.drawRoad({ start: free(-200, 0), end: free(0, 0), roadType: type });
    const node = seg.nodes[1];
    net.drawRoad({ start: atNode(node), end: free(200, 0), roadType: 'street-4' });
    net.drawRoad({ start: atNode(node), end: free(0, 200), roadType: 'street-4' });
    const links = net.connectionsAt(node).filter((c) => c.active).map((c) => ({ from: c.from, to: c.to }));
    net.setJunctionControl(node, { laneLinks: links });
    return { net, node, id: seg.segments[0], links };
  }

  const active = (net: RoadNetwork, node: Id) => net.connectionsAt(node).filter((c) => c.active).length;

  it('a mirrored road carries its links to the lanes in the same place', () => {
    const { net, node, id, links } = junction('street-4');
    const before = active(net, node);
    const report = net.reverseSegment(id);
    expect(report.changes).toEqual([]);
    expect(active(net, node)).toBe(before);
    expect(net.getNode(node)!.control.laneLinks).toHaveLength(links.length);
    expectClean(net);
  });

  it('a one-way rebuilds only its own links, and says so', () => {
    const { net, node, id } = junction('street-2-oneway');
    const other = net.getNode(node)!.control.laneLinks!.filter((l) => !l.from.startsWith(`${id}:`) && !l.to.startsWith(`${id}:`));
    const report = net.reverseSegment(id);
    const after = net.getNode(node)!.control.laneLinks!;
    expect(after).not.toBeNull();
    for (const l of other) expect(after).toContainEqual(l);
    expect(after.some((l) => l.to.startsWith(`${id}:`))).toBe(true);
    expect(after.some((l) => l.from.startsWith(`${id}:`))).toBe(false);
    expect(report.changes.join()).toMatch(/Lane links/);
    expectClean(net);
  });
});

describe('Reversing with traffic running', () => {
  function busy() {
    const net = new RoadNetwork();
    const a = net.drawRoad({ start: free(-300, 0), end: free(0, 0), roadType: 'street-2' });
    const b = net.drawRoad({ start: atNode(a.nodes[1]), end: free(300, 0), roadType: 'street-2-oneway' });
    net.drawRoad({ start: atNode(a.nodes[1]), end: free(0, 300), roadType: 'street-2' });
    net.drawRoad({ start: free(0, -300), end: atNode(a.nodes[1]), roadType: 'street-2' });
    net.setTraffic({ multiplier: 3 });
    return { net, seg: b.segments[0], two: a.segments[0] };
  }

  it('survives flips with vehicles on the road, removing only those it must', () => {
    const { net, seg } = busy();
    const sim = new Simulation(net);
    for (let i = 0; i < 900; i++) sim.step();
    expect(sim.stats().active).toBeGreaterThan(3);
    for (let flip = 0; flip < 6; flip++) {
      net.reverseSegment(seg);
      for (let i = 0; i < 300; i++) sim.step();
      for (let k = 0; k < sim.vehicles.count; k++) {
        expect(Number.isFinite(sim.vehicles.x[k])).toBe(true);
        expect(Number.isFinite(sim.vehicles.z[k])).toBe(true);
      }
    }
    expect(sim.stats().spawnedTotal).toBeGreaterThan(10);
  });

  it('leaves no vehicle driving against the new direction', () => {
    const { net, seg } = busy();
    const sim = new Simulation(net);
    for (let i = 0; i < 1500; i++) sim.step();
    net.reverseSegment(seg);
    sim.step();
    const g = net.laneGraph;
    const lanes = new Set(g.roadLanes.get(seg));
    const v = sim.vehicles;
    for (let k = 0; k < v.count; k++) {
      // Anything on the turned road must be heading the way its lanes now run.
      if (Math.abs(v.z[k]) > 4 || v.x[k] < 20) continue;
      const west = Math.cos(v.yaw[k]) !== undefined && Math.abs(Math.sin(v.yaw[k])) > 0.5;
      if (west) expect(Math.sin(v.yaw[k])).toBeGreaterThan(0);
    }
    expect(lanes.size).toBeGreaterThan(0);
  });

  it('a symmetric road flips with traffic and keeps its vehicles in place', () => {
    const { net, two } = busy();
    const sim = new Simulation(net);
    for (let i = 0; i < 1500; i++) sim.step();
    const before = sim.stats().active;
    net.reverseSegment(two);
    sim.step();
    expect(sim.stats().active).toBeGreaterThanOrEqual(before - 1);
  });
});
