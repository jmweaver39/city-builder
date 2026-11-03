import { describe, expect, it } from 'vitest';
import {
  RoadNetwork,
  applyJunctionShape,
  armInfos,
  checkNetworkInvariants,
  connectorClearances,
  cornerInfos,
  islandPolygons,
  makeCustomRoadType,
  polygonSelfIntersects,
  shapedKerbLines,
  type Id,
  type JunctionShape,
  type Vec3,
} from '../../src/core';
import { expectConnectorsContinuous, free, lanesWithoutExit } from './helpers';

function area(poly: readonly Vec3[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const q = poly[(i + 1) % poly.length];
    a += poly[i].x * q.z - q.x * poly[i].z;
  }
  return Math.abs(a / 2);
}

function crossing(ew = 'street-2', ns = 'street-2', size = 120): { net: RoadNetwork; node: Id } {
  const net = new RoadNetwork();
  net.drawRoad({ start: free(-size, 0), end: free(size, 0), roadType: ew });
  const r = net.drawRoad({ start: free(0, -size), end: free(0, size), roadType: ns });
  return { net, node: r.junctions[0] };
}

function inside(p: { x: number; z: number }, poly: readonly Vec3[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}

/** Each connector's points, past its first and last metre, inside the asphalt and outside every island. */
function expectConnectorsOnAsphalt(net: RoadNetwork, node: Id): void {
  const g = net.nodeGeom(node)!;
  const islands = islandPolygons(net, node).map((i) => i.poly);
  const graph = net.laneGraph;
  for (const idx of graph.connectorsAt.get(node) ?? []) {
    const c = graph.lanes[idx];
    for (let k = 0; k < c.cum.length; k++) {
      if (c.cum[k] < 1 || c.cum[k] > c.length - 1) continue;
      const p = { x: c.pts[k * 3], z: c.pts[k * 3 + 2] };
      expect(inside(p, g.outline), `${c.key} leaves the asphalt`).toBe(true);
      for (const poly of islands) expect(inside(p, poly), `${c.key} drives through an island`).toBe(false);
    }
  }
}

describe('Corner kerb radius', () => {
  it('reshapes the outline from a tight corner to a wide sweep, always as a simple polygon', () => {
    const { net, node } = crossing();
    const key = cornerInfos(net, node)[0].key;
    const before = net.nodeGeom(node)!;
    const baseArea = area(before.outline);
    let last = -Infinity;
    for (const radius of [0.5, 2, 4, 6, 10, 15, 20]) {
      const res = applyJunctionShape(net, node, { corners: { [key]: { radius } } });
      expect(res.ok, `radius ${radius}: ${res.problems.map((p) => p.message)}`).toBe(true);
      const g = net.nodeGeom(node)!;
      expect(g.outlineSimplified).toBe(false);
      expect(polygonSelfIntersects(g.outline)).toBe(false);
      expect(polygonSelfIntersects(g.outerOutline)).toBe(false);
      // A wider sweep cuts more off the corner block, so there is more asphalt.
      const a = area(g.outline);
      expect(a).toBeGreaterThan(last);
      last = a;
      // The kerb apex sits where a circle of that radius puts it.
      const c = cornerInfos(net, node).find((x) => x.key === key)!;
      expect(c.radius).toBeCloseTo(radius, 5);
      const apexFromMeet = Math.hypot(c.apex.x - c.meetPoint!.x, c.apex.z - c.meetPoint!.z);
      expect(apexFromMeet).toBeCloseTo(radius * (1 / Math.sin(c.opening / 2) - 1), 0);
      expect(checkNetworkInvariants(net)).toEqual([]);
    }
    expect(last).toBeGreaterThan(baseArea);
    // A sweep wider than the junction box pushes the two arms' cut lines out.
    const trims = net.nodeGeom(node)!.arms.map((a) => a.trim);
    expect(Math.max(...trims)).toBeGreaterThan(Math.max(...before.arms.map((a) => a.trim)) + 10);
    expectConnectorsContinuous(net.laneGraph, node);
    expect(lanesWithoutExit(net.laneGraph)).toEqual([]);
  });

  it('only changes the corner it is set on', () => {
    const { net, node } = crossing();
    const [c0, c1] = cornerInfos(net, node);
    const kerb1 = c1.kerb.map((p) => ({ ...p }));
    applyJunctionShape(net, node, { corners: { [c0.key]: { radius: 1.5 } } });
    const after = cornerInfos(net, node).find((c) => c.key === c1.key)!;
    expect(after.kerb.length).toBe(kerb1.length);
    after.kerb.forEach((p, i) => expect(Math.hypot(p.x - kerb1[i].x, p.z - kerb1[i].z)).toBeLessThan(1e-6));
  });

  it('keeps the outline simple at skewed and three-way junctions', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-120, 0), end: free(120, 0), roadType: 'avenue-4' });
    const r = net.drawRoad({ start: free(0, 0), end: free(60, -100), roadType: 'street-2' });
    const node = r.nodes.find((n) => net.getNode(n)!.segments.length === 3) ?? r.junctions[0];
    for (const c of cornerInfos(net, node)) {
      for (const radius of [1, 5, 9]) {
        const res = applyJunctionShape(net, node, { corners: { [c.key]: { radius } } });
        const g = net.nodeGeom(node)!;
        expect(polygonSelfIntersects(g.outline)).toBe(false);
        if (res.ok) expect(g.outlineSimplified).toBe(false);
      }
      applyJunctionShape(net, node, null);
    }
  });
});

describe('Sidewalk edges', () => {
  it('pushes a corner kerb out as a kerb extension, or back for more road, within the sidewalk', () => {
    const { net, node } = crossing();
    const c = cornerInfos(net, node)[0];
    const base = area(net.nodeGeom(node)!.outline);
    expect(applyJunctionShape(net, node, { corners: { [c.key]: { kerb: 1 } } }).ok).toBe(true);
    const bulged = cornerInfos(net, node)[0];
    // The kerb's middle moved about a metre into the road; the ends stay on the road edges.
    expect(Math.hypot(bulged.apex.x - c.apex.x, bulged.apex.z - c.apex.z)).toBeGreaterThan(0.8);
    expect(Math.hypot(bulged.kerb[0].x - c.kerb[0].x, bulged.kerb[0].z - c.kerb[0].z)).toBeLessThan(1e-6);
    expect(area(net.nodeGeom(node)!.outline)).toBeLessThan(base - 1);
    expect(applyJunctionShape(net, node, { corners: { [c.key]: { kerb: -2 } } }).ok).toBe(true);
    expect(area(net.nodeGeom(node)!.outline)).toBeGreaterThan(base + 1);
    const tooFar = applyJunctionShape(net, node, { corners: { [c.key]: { kerb: -2.5 } } });
    expect(tooFar.ok).toBe(false);
    expect(tooFar.problems[0].code).toBe('tooNarrow');
  });

  it('builds a bulb-out over spare road edge at an arm end, and tapers it back along the road', () => {
    const parked = makeCustomRoadType({ id: 'parked', forwardLanes: 1, backwardLanes: 1, shoulder: 2.5, sidewalkWidth: 3 });
    const net = new RoadNetwork();
    net.setCustomRoadType(parked);
    net.drawRoad({ start: free(-120, 0), end: free(120, 0), roadType: 'parked' });
    const r = net.drawRoad({ start: free(0, -120), end: free(0, 120), roadType: 'parked' });
    const node = r.junctions[0];
    const arm = armInfos(net, node)[0];
    expect(arm.spareLeft).toBeCloseTo(2.5);
    const res = applyJunctionShape(net, node, { arms: { [arm.segmentId]: { edgeLeft: 2 } } });
    expect(res.ok, res.problems.map((p) => p.message).join()).toBe(true);
    const g = net.nodeGeom(node)!;
    const a = g.arms.find((x) => x.segmentId === arm.segmentId)!;
    expect(a.kerbLeft).toBeDefined();
    expect(Math.hypot(a.kerbLeft!.x - a.leftEdge.x, a.kerbLeft!.z - a.leftEdge.z)).toBeCloseTo(2, 5);
    expect(g.outline.some((p) => Math.hypot(p.x - a.kerbLeft!.x, p.z - a.kerbLeft!.z) < 0.01)).toBe(true);
    expect(polygonSelfIntersects(g.outline)).toBe(false);
    // Along the road the kerb holds 2 m in at the junction and is back on the edge further out.
    const lines = shapedKerbLines(net, arm.segmentId)!;
    const H = parked.halfWidth;
    const seg = net.getSegment(arm.segmentId)!;
    const geom = net.segmentGeom(arm.segmentId)!;
    const side = a.atStart ? lines.right : lines.left;
    const ordered = a.atStart ? side : [...side].reverse();
    const centreNear = a.atStart ? geom.stations[0].pos : geom.stations[geom.stations.length - 1].pos;
    expect(Math.hypot(ordered[0].x - centreNear.x, ordered[0].z - centreNear.z)).toBeCloseTo(H - 2, 3);
    const far = ordered[ordered.length - 1];
    const centreFar = a.atStart ? geom.stations[geom.stations.length - 1].pos : geom.stations[0].pos;
    expect(Math.hypot(far.x - centreFar.x, far.z - centreFar.z)).toBeCloseTo(H, 3);
    expect(seg).toBeDefined();
    expectConnectorsOnAsphalt(net, node);
  });

  it('refuses a bulb-out that would cover a lane, and narrows a sidewalk', () => {
    const { net, node } = crossing();
    const arm = armInfos(net, node)[0];
    const res = applyJunctionShape(net, node, { arms: { [arm.segmentId]: { edgeLeft: 0.5 } } });
    expect(res.ok).toBe(false);
    expect(res.problems[0].code).toBe('coversLane');
    expect(net.getNode(node)!.control.shape).toBeUndefined();
    const base = area(net.nodeGeom(node)!.outline);
    expect(applyJunctionShape(net, node, { arms: { [arm.segmentId]: { edgeLeft: -1.5 } } }).ok).toBe(true);
    expect(area(net.nodeGeom(node)!.outline)).toBeGreaterThan(base);
    expect(applyJunctionShape(net, node, { arms: { [arm.segmentId]: { edgeLeft: -2.5 } } }).problems[0].code).toBe('tooNarrow');
  });

  it('takes the sidewalk off a corner, running the asphalt to the back edge', () => {
    const { net, node } = crossing();
    const c = cornerInfos(net, node)[0];
    const base = area(net.nodeGeom(node)!.outline);
    expect(applyJunctionShape(net, node, { corners: { [c.key]: { sidewalk: false } } }).ok).toBe(true);
    const g = net.nodeGeom(node)!;
    expect(area(g.outline)).toBeGreaterThan(base + 5);
    expect(polygonSelfIntersects(g.outline)).toBe(false);
    // The asphalt corner now follows the sidewalk's old back edge.
    const after = cornerInfos(net, node).find((x) => x.key === c.key)!;
    for (const p of c.back!.slice(1, -1)) {
      const d = Math.min(...after.kerb.map((q) => Math.hypot(q.x - p.x, q.z - p.z)));
      expect(d).toBeLessThan(0.6);
    }
  });
});

describe('Arm trim', () => {
  it('moves the cut line out or in, within limits that keep lanes and connectors valid', () => {
    const { net, node } = crossing();
    const arm = net.nodeGeom(node)!.arms[0];
    const t0 = arm.trim;
    for (const delta of [5, 12, -2, -4]) {
      const res = applyJunctionShape(net, node, { arms: { [arm.segmentId]: { trim: delta } } });
      expect(res.ok, `${delta}: ${res.problems.map((p) => p.message)}`).toBe(true);
      const now = net.nodeGeom(node)!.arms.find((a) => a.segmentId === arm.segmentId)!.trim;
      expect(now).toBeCloseTo(t0 + delta, 5);
      expect(checkNetworkInvariants(net)).toEqual([]);
      expectConnectorsContinuous(net.laneGraph, node);
      expect(lanesWithoutExit(net.laneGraph)).toEqual([]);
    }
    // Tighter than where the roads stop overlapping is refused.
    const tight = applyJunctionShape(net, node, { arms: { [arm.segmentId]: { trim: -6 } } });
    expect(tight.ok).toBe(false);
    expect(tight.problems[0].code).toBe('tooTight');
    expect(net.nodeGeom(node)!.arms.find((a) => a.segmentId === arm.segmentId)!.trim).toBeCloseTo(t0 - 4, 5);
  });

  it('refuses a trim that leaves no road', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-120, 0), end: free(120, 0), roadType: 'street-2' });
    net.drawRoad({ start: free(0, 0), end: free(0, 24), roadType: 'street-2' });
    net.drawRoad({ start: free(-20, 24), end: free(20, 24), roadType: 'street-2' });
    // The T at the origin, with a 24 m stub up to another T.
    const node = net.nearestNode({ x: 0, y: 0, z: 0 })!.nodeId;
    const g = net.nodeGeom(node)!;
    const short = g.arms.find((a) => (net.segmentGeom(a.segmentId)?.fullLength ?? 99) < 30)!;
    const res = applyJunctionShape(net, node, { arms: { [short.segmentId]: { trim: 30 } } });
    expect(res.ok).toBe(false);
  });

  it('moves the crosswalk and stop line with the cut', () => {
    const { net, node } = crossing();
    const arm = net.nodeGeom(node)!.arms[0];
    const geomBefore = net.segmentGeom(arm.segmentId)!;
    applyJunctionShape(net, node, { arms: { [arm.segmentId]: { trim: 6 } } });
    const geomAfter = net.segmentGeom(arm.segmentId)!;
    // Automatic markings sit a fixed distance back from the segment's trimmed end.
    const end = (g: typeof geomAfter) => (arm.atStart ? g.trimA : g.trimB);
    expect(end(geomAfter) - end(geomBefore)).toBeCloseTo(6, 5);
    const lane = net.laneGraph.lanes.find((l) => l.kind === 'road' && l.segmentId === arm.segmentId)!;
    expect(lane.length).toBeCloseTo(geomAfter.length, 0);
  });
});

describe('Islands', () => {
  it('fills a median gap with a refuge island and splits connectors either side of it', () => {
    const { net, node } = crossing('avenue-4', 'street-2');
    const av = armInfos(net, node).find((a) => a.boundaries.length === 6)!;
    const count = () => net.laneGraph.connectorsAt.get(node)!.length;
    const all = count();
    // From the median's left kerb to its right kerb, looking at the node.
    const refuge: JunctionShape = { islands: [{ id: 1, segmentId: av.segmentId, from: 2, to: 3, back: 6, reach: 0 }] };
    expect(applyJunctionShape(net, node, refuge).ok).toBe(true);
    expect(islandPolygons(net, node)).toHaveLength(1);
    expect(count()).toBe(all);
    // Reaching into the junction it blocks the movements that crossed its line.
    const res = applyJunctionShape(net, node, { islands: [{ ...refuge.islands![0], reach: 9 }] });
    expect(res.ok, res.problems.map((p) => p.message).join()).toBe(true);
    expect(count()).toBeLessThan(all);
    expectConnectorsOnAsphalt(net, node);
    expect(lanesWithoutExit(net.laneGraph)).toEqual([]);
    // Every incoming lane on the island's arm still goes somewhere, on its own side.
    const poly = islandPolygons(net, node)[0].poly;
    const graph = net.laneGraph;
    for (const idx of graph.connectorsAt.get(node)!) {
      const c = graph.lanes[idx];
      for (let k = 0; k < c.cum.length; k++) expect(inside({ x: c.pts[k * 3], z: c.pts[k * 3 + 2] }, poly)).toBe(false);
    }
  });

  it('refuses an island over a lane, and one that would strand a lane', () => {
    const { net, node } = crossing('avenue-4', 'street-2');
    const av = armInfos(net, node).find((a) => a.boundaries.length === 6)!;
    const onLane = applyJunctionShape(net, node, { islands: [{ id: 1, segmentId: av.segmentId, from: 1, to: 2, back: 6, reach: 0 }] });
    expect(onLane.ok).toBe(false);
    expect(onLane.problems[0].code).toBe('coversLane');
    const street = armInfos(net, node).find((a) => a.boundaries.length === 3)!;
    expect(applyJunctionShape(net, node, { islands: [{ id: 1, segmentId: street.segmentId, from: 0, to: 2, back: 4, reach: 0 }] }).ok).toBe(false);
    const huge = applyJunctionShape(net, node, { islands: [{ id: 1, segmentId: av.segmentId, from: 2, to: 3, back: 6, reach: 40 }] });
    expect(huge.ok).toBe(false);
    expect(net.getNode(node)!.control.shape).toBeUndefined();
  });
});

describe('Persistence', () => {
  function shaped(): { net: RoadNetwork; node: Id; key: string; av: Id; street: Id } {
    const { net, node } = crossing('avenue-4', 'street-2');
    const arms = armInfos(net, node);
    const av = arms.find((a) => a.boundaries.length === 6)!.segmentId;
    const street = arms.find((a) => a.boundaries.length === 3)!.segmentId;
    const key = cornerInfos(net, node)[0].key;
    const res = applyJunctionShape(net, node, {
      corners: { [key]: { radius: 3, kerb: 0.5 } },
      arms: { [street]: { trim: 3, edgeRight: -1 } },
      islands: [{ id: 1, segmentId: av, from: 2, to: 3, back: 6, reach: 1 }],
    });
    expect(res.ok, res.problems.map((p) => p.message).join()).toBe(true);
    return { net, node, key, av, street };
  }

  const outlineOf = (net: RoadNetwork, node: Id) => net.nodeGeom(node)!.outline.map((p) => [p.x.toFixed(4), p.z.toFixed(4)].join()).sort();

  it('survives save and load, and old saves load without a shape', () => {
    const { net, node } = shaped();
    const copy = new RoadNetwork(net.serialize());
    expect(copy.getNode(node)!.control.shape).toEqual(net.getNode(node)!.control.shape);
    expect(outlineOf(copy, node)).toEqual(outlineOf(net, node));
    const plain = crossing().net;
    const data = JSON.parse(plain.serialize()) as { nodes: { control: object }[] };
    expect(data.nodes.every((n) => !('shape' in n.control))).toBe(true);
    expect(new RoadNetwork(plain.serialize()).signature()).toBe(plain.signature());
  });

  it('follows a split of an arm onto the new segment id', () => {
    const { net, node, key, street } = shaped();
    const seg = net.getSegment(street)!;
    const outline = outlineOf(net, node);
    // Splitting keeps the a side's id, so split so that the node's side gets the new id when it is at b.
    const r = net.splitSegment(street, seg.b === node ? 0.5 : 0.5);
    const newId = seg.b === node || net.getSegment(street)!.b === r.node ? r.right! : street;
    const nowAtNode = net.getNode(node)!.segments.includes(street) ? street : r.right!;
    const shape = net.getNode(node)!.control.shape!;
    expect(shape.arms?.[nowAtNode]?.trim).toBe(3);
    const ids = Object.keys(shape.corners!)[0].split('>').map(Number);
    expect(ids.every((id) => net.getNode(node)!.segments.includes(id))).toBe(true);
    expect(outlineOf(net, node)).toEqual(outline);
    void key;
    void newId;
  });

  it('keeps the island in place when its road is reversed', () => {
    const { net, node, av } = shaped();
    const centre = (poly: Vec3[]) => ({ x: poly.reduce((s, p) => s + p.x, 0) / poly.length, z: poly.reduce((s, p) => s + p.z, 0) / poly.length });
    const before = centre(islandPolygons(net, node)[0].poly);
    const outline = outlineOf(net, node);
    net.reverseSegment(av);
    const after = centre(islandPolygons(net, node)[0].poly);
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(0.05);
    expect(outlineOf(net, node)).toEqual(outline);
  });

  it('drops what belonged to a removed arm', () => {
    const { net, node, av, street } = shaped();
    const other = net.getNode(node)!.segments.find((s) => s !== av && s !== street && net.roadTypeOf(s).id === 'avenue-4')!;
    net.removeSegment(av);
    const shape = net.getNode(node)?.control.shape;
    expect(shape?.islands ?? []).toEqual([]);
    expect(Object.keys(shape?.corners ?? {}).every((k) => !k.split('>').map(Number).includes(av))).toBe(true);
    expect(shape?.arms?.[street]?.trim).toBe(3);
    void other;
  });
});

describe('Connectors and kerbs', () => {
  it('never lets a connector cross a kerb or island, whatever the handles are set to', () => {
    for (const [ew, ns] of [
      ['street-2', 'street-2'],
      ['avenue-4', 'street-4'],
      ['street-2-bike', 'street-2'],
    ]) {
      const { net, node } = crossing(ew, ns);
      const base = connectorClearances(net, node);
      const corners = cornerInfos(net, node);
      const arms = armInfos(net, node);
      const tries: JunctionShape[] = [];
      for (const radius of [0.5, 3, 8, 14, 22]) for (const kerb of [-1, 0, 1, 2.5]) tries.push({ corners: { [corners[0].key]: { radius, kerb } } });
      for (const trim of [-4, -1, 4, 15]) tries.push({ arms: { [arms[1].segmentId]: { trim } }, corners: { [corners[1].key]: { radius: 9 } } });
      let accepted = 0;
      for (const s of tries) {
        if (!applyJunctionShape(net, node, s).ok) continue;
        accepted++;
        expectConnectorsOnAsphalt(net, node);
        for (const [k, d] of connectorClearances(net, node)) {
          // Room to spare from every kerb and island, or at least no less than it had.
          expect(d, `${ew}/${ns} ${JSON.stringify(s)} ${k}`).toBeGreaterThanOrEqual(Math.min(0, (base.get(k) ?? 0) - 0.05) - 1e-9);
        }
        expect(lanesWithoutExit(net.laneGraph)).toEqual([]);
        applyJunctionShape(net, node, null);
      }
      expect(accepted).toBeGreaterThan(tries.length / 2);
    }
  });
});
