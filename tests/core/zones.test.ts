import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ZONE_SETTINGS,
  RoadNetwork,
  closestPointOnCubic,
  coverageOf,
  fillBlock,
  frontageStrip,
  pointInPolygon,
  polygonArea,
  totalHalfWidth,
  zonePolygon,
  type Vec3,
  type ZoneRegion,
} from '../../src/core';
import { free, atNode } from './helpers';

const v = (x: number, z: number): Vec3 => ({ x, y: 0, z });

/** A 3 by 3 street grid at 200 m spacing, so the middle block runs 200 to 400. */
function grid(type = 'street-2'): RoadNetwork {
  const net = new RoadNetwork();
  for (const k of [0, 200, 400, 600]) {
    net.drawRoad({ start: free(0, k), end: free(600, k), roadType: type });
    net.drawRoad({ start: free(k, 0), end: free(k, 600), roadType: type });
  }
  return net;
}

const settings = { ...DEFAULT_ZONE_SETTINGS };

describe('Fill block', () => {
  it('finds the block between the road edges on a grid', () => {
    const net = grid();
    const r = fillBlock(net, v(300, 300), settings);
    if ('error' in r) throw new Error(r.error);
    const edge = totalHalfWidth(net.roadType('street-2')!) + settings.setback;
    const xs = r.polygon.map((p) => p.x);
    const zs = r.polygon.map((p) => p.z);
    expect(Math.min(...xs)).toBeCloseTo(200 + edge, 0);
    expect(Math.max(...xs)).toBeCloseTo(400 - edge, 0);
    expect(Math.min(...zs)).toBeCloseTo(200 + edge, 0);
    expect(Math.max(...zs)).toBeCloseTo(400 - edge, 0);
    // Corners are rounded by junctions, so a little under the full square.
    const side = 200 - 2 * edge;
    expect(polygonArea(r.polygon)).toBeGreaterThan(side * side * 0.95);
    expect(polygonArea(r.polygon)).toBeLessThan(side * side * 1.01);
    expect(r.anchors.filter(Boolean).length).toBeGreaterThan(r.polygon.length * 0.7);
  });

  it('follows a curved road along one side of the block', () => {
    const net = new RoadNetwork();
    const south = net.drawRoad({ start: free(0, 0), end: free(400, 0), roadType: 'street-2' });
    const north = net.drawRoad({ start: free(0, 300), end: free(400, 300), c1: { x: 130, y: 0, z: 200 }, c2: { x: 270, y: 0, z: 200 }, roadType: 'street-2' });
    net.drawRoad({ start: atNode(south.nodes[0]), end: atNode(north.nodes[0]), roadType: 'street-2' });
    net.drawRoad({ start: atNode(south.nodes[1]), end: atNode(north.nodes[1]), roadType: 'street-2' });
    const r = fillBlock(net, v(200, 80), settings);
    if ('error' in r) throw new Error(r.error);
    const curve = north.segments[0];
    const edge = totalHalfWidth(net.roadType('street-2')!) + settings.setback;
    const onCurve = r.anchors.filter((a) => a?.segmentId === curve);
    expect(onCurve.length).toBeGreaterThan(20);
    for (let i = 0; i < r.polygon.length; i++) {
      if (r.anchors[i]?.segmentId !== curve) continue;
      expect(closestPointOnCubic(net.cubicOf(curve), r.polygon[i]).distance).toBeCloseTo(edge, 1);
    }
    expect(pointInPolygon(200, 80, r.polygon)).toBe(true);
    expect(pointInPolygon(200, 240, r.polygon)).toBe(false);
  });

  it('refuses a click on a road, and land that is not enclosed', () => {
    const net = grid();
    expect(fillBlock(net, v(300, 200), settings)).toMatchObject({ error: expect.stringMatching(/not on a road/) });
    const open = new RoadNetwork();
    open.drawRoad({ start: free(0, 0), end: free(400, 0), roadType: 'street-2' });
    expect(fillBlock(open, v(200, 50), settings)).toMatchObject({ error: expect.stringMatching(/not enclosed/) });
  });

  it('honours the setback', () => {
    const net = grid();
    const a = fillBlock(net, v(300, 300), settings);
    const b = fillBlock(net, v(300, 300), { ...settings, setback: 10 });
    if ('error' in a || 'error' in b) throw new Error('no block');
    expect(polygonArea(b.polygon)).toBeLessThan(polygonArea(a.polygon) - 3000);
  });
});

describe('Frontage', () => {
  it('follows a curve at the setback and the depth on the side asked for', () => {
    const net = new RoadNetwork();
    const seg = net.drawRoad({ start: free(0, 0), end: free(300, 0), c1: { x: 100, y: 0, z: 150 }, c2: { x: 200, y: 0, z: 150 }, roadType: 'street-2' }).segments[0];
    const r = frontageStrip(net, seg, 0.2, 0.8, -1, { ...settings, depth: 30 });
    if ('error' in r) throw new Error(r.error);
    const edge = totalHalfWidth(net.roadType('street-2')!) + settings.setback;
    const c = net.cubicOf(seg);
    const half = r.polygon.length / 2;
    for (let i = 0; i < half; i++) expect(closestPointOnCubic(c, r.polygon[i]).distance).toBeCloseTo(edge, 1);
    for (let i = half; i < r.polygon.length; i++) expect(closestPointOnCubic(c, r.polygon[i]).distance).toBeCloseTo(edge + 30, 0);
    // Left of a-to-b is the inside of this bend, so the strip stays below the road.
    expect(Math.max(...r.polygon.map((p) => p.z))).toBeLessThan(110);
  });

  it('refuses frontage on a highway', () => {
    const net = new RoadNetwork();
    const seg = net.drawRoad({ start: free(0, 0), end: free(300, 0), roadType: 'highway-3' }).segments[0];
    expect(frontageStrip(net, seg, 0.2, 0.8, 1, settings)).toMatchObject({ error: expect.stringMatching(/Highways/) });
  });
});

describe('Clipping and layering', () => {
  it('a road through a region cuts it', () => {
    const net = new RoadNetwork();
    const poly = [v(0, 0), v(200, 0), v(200, 200), v(0, 200)];
    const whole = coverageOf(net, poly, 2).area;
    expect(whole).toBeCloseTo(40000, -3);
    net.drawRoad({ start: free(-50, 100), end: free(250, 100), roadType: 'avenue-4' });
    const cut = coverageOf(net, poly, 2);
    const band = 2 * (totalHalfWidth(net.roadType('avenue-4')!) + 2) * 200;
    expect(cut.area).toBeLessThan(whole - band * 0.85);
    expect(cut.cells.every((c) => Math.abs(c.z - 100) > totalHalfWidth(net.roadType('avenue-4')!))).toBe(true);
  });

  it('water and the map edge are never zoned', () => {
    const net = new RoadNetwork();
    const river = coverageOf(net, [v(-100, 300), v(100, 300), v(100, 700), v(-100, 700)], 0);
    const all = 200 * 400;
    expect(river.area).toBeLessThan(all * 0.95);
    const edge = coverageOf(net, [v(1950, 0), v(2100, 0), v(2100, 100), v(1950, 100)], 0);
    expect(edge.cells.every((c) => c.x <= 2000)).toBe(true);
  });

  it('a later region hides an earlier one where they overlap', () => {
    const net = new RoadNetwork();
    const below = [v(0, 0), v(100, 0), v(100, 100), v(0, 100)];
    const above = [v(50, 0), v(150, 0), v(150, 100), v(50, 100)];
    // A cell centred on the shared edge counts as hidden.
    expect(coverageOf(net, below, 0, [above]).area).toBe(4800);
  });
});

describe('Regions in the network', () => {
  const region = (net: RoadNetwork, extra: Partial<ZoneRegion> = {}): Omit<ZoneRegion, 'id'> => ({
    kind: 'residential',
    density: 'medium',
    enabled: true,
    name: '',
    polygon: [v(20, 20), v(180, 20), v(180, 180), v(20, 180)],
    source: 'shape',
    settings,
    ...extra,
  });

  it('held corners follow the road when it moves, and survive a split', () => {
    const net = new RoadNetwork();
    const seg = net.drawRoad({ start: free(0, 0), end: free(300, 0), roadType: 'street-2' }).segments[0];
    const r = frontageStrip(net, seg, 0.2, 0.8, 1, settings);
    if ('error' in r) throw new Error(r.error);
    const id = net.addZone(region(net, { ...r, source: 'frontage' }));
    const z = () => net.project.zones!.find((x) => x.id === id)!;
    const before = zonePolygon(net, z());
    net.moveNode(net.getSegment(seg)!.b, { x: 300, y: 0, z: 60 });
    const moved = zonePolygon(net, z());
    expect(moved[moved.length / 2 - 1].z).toBeGreaterThan(before[before.length / 2 - 1].z + 20);
    const { right } = net.splitSegment(seg, 0.5);
    const after = zonePolygon(net, z());
    after.forEach((p, i) => expect(Math.hypot(p.x - moved[i].x, p.z - moved[i].z)).toBeLessThan(1e-6));
    expect(z().anchors!.some((a) => a?.segmentId === right)).toBe(true);
  });

  it('a frontage strip goes with its road; a block keeps its last shape', () => {
    const net = grid();
    const seg = net.nearestSegment(v(300, 200), 5)!.segmentId;
    const strip = frontageStrip(net, seg, 0.3, 0.7, 1, settings);
    const block = fillBlock(net, v(300, 300), settings);
    if ('error' in strip || 'error' in block) throw new Error('no shape');
    const s = net.addZone(region(net, { ...strip, source: 'frontage' }));
    const b = net.addZone(region(net, { ...block, source: 'block' }));
    const shape = zonePolygon(net, net.project.zones!.find((x) => x.id === b)!);
    net.removeSegment(seg);
    expect(net.project.zones!.some((x) => x.id === s)).toBe(false);
    const kept = net.project.zones!.find((x) => x.id === b)!;
    expect(zonePolygon(net, kept)).toEqual(shape);
    expect(kept.anchors!.every((a) => a?.segmentId !== seg)).toBe(true);
  });

  it('reversing a road keeps held corners where they are', () => {
    const net = new RoadNetwork();
    const seg = net.drawRoad({ start: free(0, 0), end: free(300, 0), roadType: 'street-2' }).segments[0];
    const r = frontageStrip(net, seg, 0.25, 0.75, 1, settings);
    if ('error' in r) throw new Error(r.error);
    const id = net.addZone(region(net, { ...r, source: 'frontage' }));
    const before = zonePolygon(net, net.project.zones![0]);
    net.reverseSegment(seg);
    const after = zonePolygon(net, net.project.zones![0]);
    after.forEach((p, i) => expect(Math.hypot(p.x - before[i].x, p.z - before[i].z)).toBeLessThan(1e-3));
    expect(id).toBeGreaterThan(0);
  });

  it('saves and loads, and old saves have no zones field', () => {
    const net = grid();
    const before = JSON.parse(net.serialize());
    expect('zones' in before).toBe(false);
    const block = fillBlock(net, v(300, 300), settings);
    if ('error' in block) throw new Error(block.error);
    net.addZone(region(net, { ...block, source: 'block' }));
    const back = new RoadNetwork(net.serialize());
    expect(back.signature()).toBe(net.signature());
    expect(back.project.zones).toHaveLength(1);
    expect(new RoadNetwork(before).project.zones).toBeUndefined();
  });

  it('removing a zone removes the access points it owns', () => {
    const net = grid();
    const seg = net.nearestSegment(v(300, 200), 5)!.segmentId;
    const id = net.addZone(region(net));
    net.addEndpoint({ kind: 'residential', segmentId: seg, t: 0.5, side: 1, regionId: id });
    net.addEndpoint({ kind: 'office', segmentId: seg, t: 0.5, side: -1 });
    net.removeZone(id);
    expect(net.endpoints.map((e) => e.kind)).toEqual(['office']);
  });
});
