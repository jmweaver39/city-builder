import { describe, expect, it } from 'vitest';
import {
  RoadNetwork,
  checkNetworkInvariants,
  closestPointOnCubic,
  cubicTangentXZ,
  dist,
  distXZ,
  nextAlongRoad,
  offsetPoint,
  pathPoints,
  resolveDecal,
  roadPathBetween,
  rotationFacing,
  visibleSpan,
  type Decal,
  type Id,
  type RoadPaintRef,
} from '../../src/core';
import { expectClean, atNode, free } from './helpers';

const line = (net: RoadNetwork, road: RoadPaintRef): Id =>
  net.addDecal({ kind: 'line', lineStyle: 'dashed', points: [], road, color: 'white', width: 0.15, rotation: 0 });
const decal = (net: RoadNetwork, id: Id) => net.decals.find((d) => d.id === id) as Decal;

/** A curved road between two T junctions. */
function curvedRoad() {
  const net = new RoadNetwork();
  const seg = net.drawRoad({
    start: free(0, 0),
    end: free(300, 0),
    c1: { x: 100, y: 0, z: 120 },
    c2: { x: 200, y: 0, z: 120 },
    roadType: 'street-4',
  }).segments[0];
  const s = net.getSegment(seg)!;
  const nodeA = s.a;
  const nodeB = s.b;
  net.drawRoad({ start: free(0, -100), end: atNode(nodeA), roadType: 'street-4' });
  net.drawRoad({ start: free(-100, 60), end: atNode(nodeA), roadType: 'street-4' });
  net.drawRoad({ start: free(300, -100), end: atNode(nodeB), roadType: 'street-4' });
  net.drawRoad({ start: free(400, 60), end: atNode(nodeB), roadType: 'street-4' });
  return { net, seg, nodeA, nodeB };
}

describe('A line along a road', () => {
  it('follows the curve at exactly its offset and stops at both junction edges', () => {
    const { net, seg } = curvedRoad();
    const id = line(net, { pieces: [{ segmentId: seg, t0: 0, t1: 1 }], offset: 3.5 });
    const pts = resolveDecal(net, decal(net, id)).points;
    const c = net.cubicOf(seg);
    expect(pts.length).toBeGreaterThan(20);
    for (const p of pts) {
      const hit = closestPointOnCubic(c, p);
      expect(hit.distance).toBeCloseTo(3.5, 1);
    }
    const span = visibleSpan(net, seg)!;
    expect(span.lo).toBeGreaterThan(0);
    expect(span.hi).toBeLessThan(1);
    expect(dist(pts[0], offsetPoint(c, span.lo, 3.5))).toBeLessThan(1e-6);
    expect(dist(pts[pts.length - 1], offsetPoint(c, span.hi, 3.5))).toBeLessThan(1e-6);
  });

  it('keeps meeting the junction edge when the junction grows', () => {
    const { net, seg, nodeB } = curvedRoad();
    const id = line(net, { pieces: [{ segmentId: seg, t0: 0, t1: 1 }], offset: 0 });
    const before = visibleSpan(net, seg)!.hi;
    net.drawRoad({ start: free(450, 40), end: atNode(nodeB), roadType: 'avenue-6' });
    const after = visibleSpan(net, seg)!.hi;
    const pts = resolveDecal(net, decal(net, id)).points;
    expect(after).not.toBe(before);
    expect(dist(pts[pts.length - 1], offsetPoint(net.cubicOf(seg), after, 0))).toBeLessThan(1e-6);
  });

  it('follows when a node moves, and when the curve is reshaped', () => {
    const { net, seg, nodeB } = curvedRoad();
    const id = line(net, { pieces: [{ segmentId: seg, t0: 0.2, t1: 0.8 }], offset: 3.5 });
    const before = resolveDecal(net, decal(net, id)).points[0];
    net.moveNode(nodeB, { x: 340, y: 0, z: 80 });
    const moved = resolveDecal(net, decal(net, id)).points;
    expect(dist(moved[0], before)).toBeGreaterThan(5);
    expect(closestPointOnCubic(net.cubicOf(seg), moved[10]).distance).toBeCloseTo(3.5, 1);
    const s = net.getSegment(seg)!;
    net.setSegmentControls(seg, { ...s.c1, z: s.c1.z + 40 }, s.c2);
    const bent = resolveDecal(net, decal(net, id)).points;
    expect(closestPointOnCubic(net.cubicOf(seg), bent[10]).distance).toBeCloseTo(3.5, 1);
    expect(decal(net, id).points).toEqual([]);
  });

  it('walking b to a puts the offset on the walker\'s right', () => {
    const net = new RoadNetwork();
    const seg = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: 'street-4' }).segments[0];
    const id = line(net, { pieces: [{ segmentId: seg, t0: 1, t1: 0 }], offset: 3 });
    const pts = resolveDecal(net, decal(net, id)).points;
    expect(pts[0].x).toBeGreaterThan(pts[pts.length - 1].x);
    expect(pts[0].z).toBeCloseTo(-3, 6);
  });
});

describe('Paths along a road', () => {
  function chain() {
    const net = new RoadNetwork();
    const a = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: 'street-4' });
    const b = net.drawRoad({ start: atNode(a.nodes[1]), end: free(200, 0), roadType: 'street-4' });
    const c = net.drawRoad({ start: free(300, 0), end: atNode(b.nodes[1]), roadType: 'street-4' });
    return { net, a: a.segments[0], b: b.segments[0], c: c.segments[0] };
  }

  it('walks through plain joints either way, entering each piece at the right end', () => {
    const { net, a, b, c } = chain();
    expect(roadPathBetween(net, { segmentId: a, t: 0.5 }, { segmentId: c, t: 0.5 })).toEqual([
      { segmentId: a, t0: 0.5, t1: 1 },
      { segmentId: b, t0: 0, t1: 1 },
      { segmentId: c, t0: 1, t1: 0.5 },
    ]);
    expect(roadPathBetween(net, { segmentId: c, t: 0.5 }, { segmentId: a, t: 0.5 })).toEqual([
      { segmentId: c, t0: 0.5, t1: 1 },
      { segmentId: b, t0: 1, t1: 0 },
      { segmentId: a, t0: 1, t1: 0.5 },
    ]);
  });

  it('a line through a head-on joint stays on the same side of the road', () => {
    const { net, a, c } = chain();
    const pieces = roadPathBetween(net, { segmentId: a, t: 0 }, { segmentId: c, t: 0 })!;
    const pts = pathPoints(net, pieces, 3.5);
    for (const p of pts) expect(p.z).toBeCloseTo(3.5, 6);
    expect(pts[0].x).toBeCloseTo(0, 6);
    expect(pts[pts.length - 1].x).toBeCloseTo(300, 6);
  });

  it('goes straight on through a junction and refuses a turn', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-100, 0), end: free(100, 0), roadType: 'street-4' });
    const r = net.drawRoad({ start: free(0, -100), end: free(0, 100), roadType: 'street-4' });
    const node = r.junctions[0];
    const arms = net.nodeGeom(node)!.arms;
    const at = (x: number, z: number) => arms.find((a) => a.dir.x * x + a.dir.z * z > 0.9)!.segmentId;
    expect(nextAlongRoad(net, at(1, 0), node)).toBe(at(-1, 0));
    expect(roadPathBetween(net, { segmentId: at(1, 0), t: 0.5 }, { segmentId: at(-1, 0), t: 0.5 })).not.toBeNull();
    expect(roadPathBetween(net, { segmentId: at(1, 0), t: 0.5 }, { segmentId: at(0, 1), t: 0.5 })).toBeNull();
  });

  it('is null for roads that do not connect', () => {
    const net = new RoadNetwork();
    const a = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: 'street-2' }).segments[0];
    const b = net.drawRoad({ start: free(0, 100), end: free(100, 100), roadType: 'street-2' }).segments[0];
    expect(roadPathBetween(net, { segmentId: a, t: 0 }, { segmentId: b, t: 0 })).toBeNull();
  });
});

describe('Areas and stamps', () => {
  it('an area follows both sides of the road', () => {
    const { net, seg } = curvedRoad();
    const id = net.addDecal({
      kind: 'hatch',
      points: [],
      road: { pieces: [{ segmentId: seg, t0: 0.3, t1: 0.7 }], offset: 0, offset2: 3.5 },
      color: 'white',
      width: 0.2,
      rotation: 0,
    });
    const pts = resolveDecal(net, decal(net, id)).points;
    const c = net.cubicOf(seg);
    const half = pts.length / 2;
    for (let i = 0; i < half; i++) expect(closestPointOnCubic(c, pts[i]).distance).toBeCloseTo(0, 1);
    for (let i = half; i < pts.length; i++) expect(closestPointOnCubic(c, pts[i]).distance).toBeCloseTo(3.5, 1);
  });

  it('a stamp faces along its lane and turns with the road', () => {
    const { net, seg, nodeB } = curvedRoad();
    const id = net.addDecal({
      kind: 'arrowStraight',
      points: [],
      road: { pieces: [{ segmentId: seg, t0: 0.5, t1: 0.5 }], offset: 1.75, dir: 1 },
      color: 'white',
      width: 1,
      rotation: 0,
    });
    const r = resolveDecal(net, decal(net, id));
    const c = net.cubicOf(seg);
    expect(r.points).toHaveLength(1);
    expect(r.rotation).toBeCloseTo(rotationFacing(cubicTangentXZ(c, 0.5)), 6);
    net.moveNode(nodeB, { x: 300, y: 0, z: 200 });
    expect(resolveDecal(net, decal(net, id)).rotation).not.toBeCloseTo(r.rotation, 2);
  });

  it('a stamp laid across a lane has both ends', () => {
    const { net, seg } = curvedRoad();
    const id = net.addDecal({
      kind: 'stopLine',
      points: [],
      road: { pieces: [{ segmentId: seg, t0: 0.5, t1: 0.5 }], offset: 0, offset2: 3.5, dir: 1 },
      color: 'white',
      width: 0.5,
      rotation: 0,
    });
    const r = resolveDecal(net, decal(net, id));
    expect(r.points).toHaveLength(2);
    expect(distXZ(r.points[0], r.points[1])).toBeCloseTo(3.5, 6);
  });
});

describe('Paint through edits', () => {
  it('survives a split with the same geometry', () => {
    const { net, seg } = curvedRoad();
    const id = line(net, { pieces: [{ segmentId: seg, t0: 0.1, t1: 0.9 }], offset: 3.5 });
    const before = resolveDecal(net, decal(net, id)).points;
    const { right } = net.splitSegment(seg, 0.4);
    const d = decal(net, id);
    expect(d.road!.pieces.map((p) => p.segmentId)).toEqual([seg, right]);
    const after = resolveDecal(net, d).points;
    expect(dist(after[0], before[0])).toBeLessThan(1e-6);
    expect(dist(after[after.length - 1], before[before.length - 1])).toBeLessThan(1e-6);
    const c = net.cubicOf(seg);
    expect(closestPointOnCubic(c, after[3]).distance).toBeCloseTo(3.5, 1);
    expectClean(net);
  });

  it('a split beyond the paint leaves it on the a side, rescaled', () => {
    const { net, seg } = curvedRoad();
    const id = line(net, { pieces: [{ segmentId: seg, t0: 0.1, t1: 0.3 }], offset: 0 });
    const before = resolveDecal(net, decal(net, id)).points[0];
    net.splitSegment(seg, 0.6);
    const d = decal(net, id);
    expect(d.road!.pieces).toHaveLength(1);
    expect(d.road!.pieces[0].t1).toBeCloseTo(0.5, 9);
    expect(dist(resolveDecal(net, d).points[0], before)).toBeLessThan(1e-6);
  });

  it('a split in the b part moves it to the new segment', () => {
    const { net, seg } = curvedRoad();
    const id = line(net, { pieces: [{ segmentId: seg, t0: 0.9, t1: 0.7 }], offset: 0 });
    const { right } = net.splitSegment(seg, 0.5);
    expect(decal(net, id).road!.pieces[0].segmentId).toBe(right);
    expect(decal(net, id).road!.pieces[0].t0).toBeCloseTo(0.8, 9);
  });

  it('a reversed span split keeps walking order', () => {
    const { net, seg } = curvedRoad();
    const id = line(net, { pieces: [{ segmentId: seg, t0: 0.9, t1: 0.1 }], offset: 2 });
    const before = resolveDecal(net, decal(net, id)).points[0];
    const { right } = net.splitSegment(seg, 0.5);
    expect(decal(net, id).road!.pieces.map((p) => p.segmentId)).toEqual([right, seg]);
    expect(dist(resolveDecal(net, decal(net, id)).points[0], before)).toBeLessThan(1e-6);
  });

  it('moves stamps with a split', () => {
    const { net, seg } = curvedRoad();
    const id = net.addDecal({
      kind: 'text',
      text: 'BUS',
      points: [],
      road: { pieces: [{ segmentId: seg, t0: 0.75, t1: 0.75 }], offset: 1, dir: -1 },
      color: 'white',
      width: 2,
      rotation: 0,
    });
    const before = resolveDecal(net, decal(net, id)).points[0];
    const { right } = net.splitSegment(seg, 0.5);
    expect(decal(net, id).road!.pieces[0].segmentId).toBe(right);
    expect(dist(resolveDecal(net, decal(net, id)).points[0], before)).toBeLessThan(1e-6);
  });

  it('is removed with its road', () => {
    const { net, seg } = curvedRoad();
    const id = line(net, { pieces: [{ segmentId: seg, t0: 0, t1: 1 }], offset: 0 });
    const other = net.addDecal({ kind: 'line', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], color: 'red', width: 1, rotation: 0 });
    net.removeSegment(seg);
    expect(net.decals.map((d) => d.id)).toEqual([other]);
    expect(id).toBeGreaterThan(0);
    expectClean(net);
  });

  it('losing an end road shortens the line, and losing a middle one makes two', () => {
    const net = new RoadNetwork();
    const seg = net.drawRoad({ start: free(0, 0), end: free(300, 0), roadType: 'street-2' }).segments[0];
    const { right } = net.splitSegment(seg, 1 / 3);
    const { right: third } = net.splitSegment(right!, 0.5);
    const road = { pieces: [{ segmentId: seg, t0: 0, t1: 1 }, { segmentId: right!, t0: 0, t1: 1 }, { segmentId: third!, t0: 0, t1: 1 }], offset: 0 };
    line(net, structuredClone(road));
    net.removeSegment(right!);
    expect(net.decals).toHaveLength(2);
    expect(net.decals.map((d) => d.road!.pieces[0].segmentId).sort()).toEqual([seg, third].sort());
    expect(new Set(net.decals.map((d) => d.id)).size).toBe(2);
    net.removeSegment(seg);
    expect(net.decals).toHaveLength(1);
    expect(checkNetworkInvariants(net)).toEqual([]);
  });

  it('reversing the road keeps the paint where it was', () => {
    const net = new RoadNetwork();
    const seg = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: 'street-4' }).segments[0];
    const id = line(net, { pieces: [{ segmentId: seg, t0: 0.2, t1: 0.8 }], offset: 3 });
    const stamp = net.addDecal({ kind: 'arrowLeft', points: [], road: { pieces: [{ segmentId: seg, t0: 0.5, t1: 0.5 }], offset: 1.75, dir: 1 }, color: 'white', width: 1, rotation: 0 });
    const before = resolveDecal(net, decal(net, id)).points;
    const stampBefore = resolveDecal(net, decal(net, stamp));
    net.reverseSegment(seg);
    const after = resolveDecal(net, decal(net, id)).points;
    expect(after).toHaveLength(before.length);
    expect(dist(after[0], before[0])).toBeLessThan(1e-6);
    const stampAfter = resolveDecal(net, decal(net, stamp));
    expect(dist(stampAfter.points[0], stampBefore.points[0])).toBeLessThan(1e-6);
    expect(stampAfter.rotation).toBeCloseTo(stampBefore.rotation, 6);
  });
});

describe('Saving', () => {
  it('round trips with the same signature', () => {
    const { net, seg } = curvedRoad();
    line(net, { pieces: [{ segmentId: seg, t0: 0, t1: 1 }], offset: 3.5 });
    const back = new RoadNetwork(net.serialize());
    expect(back.signature()).toBe(net.signature());
    expect(resolveDecal(back, back.decals[0]).points.length).toBeGreaterThan(5);
  });

  it('old world-point decals load and read back unchanged', () => {
    const { net } = curvedRoad();
    const data = JSON.parse(net.serialize());
    data.decals = [{ id: data.nextId++, kind: 'arrowLeft', points: [{ x: 5, y: 0, z: 5 }], color: 'white', width: 1, rotation: 1 }];
    const back = new RoadNetwork(data);
    const d = back.decals[0];
    expect(d.road).toBeUndefined();
    expect(resolveDecal(back, d)).toBe(d);
  });

  it('a decal naming a missing road is dropped, and a malformed one refused', () => {
    const { net } = curvedRoad();
    const data = JSON.parse(net.serialize());
    data.decals = [{ id: data.nextId++, kind: 'line', points: [], road: { pieces: [{ segmentId: 99999, t0: 0, t1: 1 }], offset: 0 }, color: 'white', width: 1, rotation: 0 }];
    expect(new RoadNetwork(structuredClone(data)).decals).toEqual([]);
    data.decals[0].road = { pieces: [], offset: 0 };
    expect(() => new RoadNetwork(data)).toThrow(/no pieces/);
  });
});
