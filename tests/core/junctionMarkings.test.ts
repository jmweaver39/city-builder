import { describe, expect, it } from 'vitest';
import {
  RoadNetwork,
  armRow,
  boundaryOffsets,
  alongGuide,
  connectorGuide,
  cornerChains,
  distXZ,
  lanePath,
  markingPath,
  outlineAnchors,
  outlinePath,
  pathPoints,
  resolveAnchor,
  roadPathBetween,
  type Id,
  type NodeLineMarking,
  type Vec3,
} from '../../src/core';
import { atNode, free } from './helpers';

function crossing(): { net: RoadNetwork; node: Id } {
  const net = new RoadNetwork();
  net.drawRoad({ start: free(-200, 0), end: free(200, 0), roadType: 'street-4' });
  const r = net.drawRoad({ start: free(0, -200), end: free(0, 200), roadType: 'street-4' });
  return { net, node: r.junctions[0] };
}

/** Shortest distance from a point to a polyline, in plan. */
function toPolyline(p: Vec3, line: readonly Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(a.x + dx * u - p.x, a.z + dz * u - p.z));
  }
  return best;
}

describe('Along the junction outline', () => {
  it('has one kerb chain per corner, from an arm\'s left edge to the next arm\'s right edge', () => {
    const { net, node } = crossing();
    const chains = cornerChains(net, node);
    const geom = net.nodeGeom(node)!;
    expect(chains).toHaveLength(4);
    chains.forEach((c, i) => {
      expect(distXZ(c.points[0], geom.arms[i].leftEdge)).toBeLessThan(0.05);
      expect(distXZ(c.points[c.points.length - 1], geom.arms[(i + 1) % 4].rightEdge)).toBeLessThan(0.05);
      expect(c.length).toBeGreaterThan(5);
    });
  });

  it('offers anchors along each corner, on the outline', () => {
    const { net, node } = crossing();
    const dots = outlineAnchors(net, node);
    const outline = [...net.nodeGeom(node)!.outline, net.nodeGeom(node)!.outline[0]];
    expect(dots.length).toBeGreaterThan(8);
    for (const d of dots) expect(toPolyline(d.pos, outline)).toBeLessThan(0.02);
  });

  it('a line between two corner anchors follows the rounded kerb, not a chord', () => {
    const { net, node } = crossing();
    const chain = cornerChains(net, node)[0];
    const a = { segmentId: chain.segmentId, boundary: 0, corner: 0.1 };
    const b = { segmentId: chain.segmentId, boundary: 0, corner: 0.9 };
    const path = outlinePath(net, node, a, b)!;
    const outline = [...net.nodeGeom(node)!.outline, net.nodeGeom(node)!.outline[0]];
    expect(path.length).toBeGreaterThan(3);
    for (const p of path) expect(toPolyline(p, outline)).toBeLessThan(0.02);
    // A rounded corner bows away from the chord between its ends.
    const mid = path[Math.floor(path.length / 2)];
    expect(toPolyline(mid, [path[0], path[path.length - 1]])).toBeGreaterThan(0.5);
  });

  it('runs from a road edge on a cut line round the corner', () => {
    const { net, node } = crossing();
    const arm = net.nodeGeom(node)!.arms[0];
    const count = boundaryOffsets(net.roadTypeOf(arm.segmentId)).length;
    const leftEdge = { segmentId: arm.segmentId, boundary: arm.atStart ? count - 1 : 0 };
    const path = outlinePath(net, node, leftEdge, { segmentId: arm.segmentId, boundary: 0, corner: 0.6 })!;
    expect(path).not.toBeNull();
    expect(distXZ(path[0], arm.leftEdge)).toBeLessThan(0.05);
  });

  it('has no outline path between corners that do not touch', () => {
    const { net, node } = crossing();
    const chains = cornerChains(net, node);
    expect(outlinePath(net, node, { segmentId: chains[0].segmentId, boundary: 0, corner: 0.5 }, { segmentId: chains[2].segmentId, boundary: 0, corner: 0.5 })).toBeNull();
  });
});

describe('Along lane paths', () => {
  it('follows the turning lane path between two arms, from anchor to anchor', () => {
    const { net, node } = crossing();
    const arms = net.nodeGeom(node)!.arms;
    const east = arms.find((a) => a.dir.x > 0.9)!;
    const south = arms.find((a) => a.dir.z > 0.9)!;
    // The boundary between the two lanes heading into the junction from the east...
    const fromEast = { segmentId: east.segmentId, boundary: east.atStart ? 1 : 3 };
    // ...to the boundary between the two lanes leaving south.
    const intoSouth = { segmentId: south.segmentId, boundary: south.atStart ? 3 : 1 };
    const path = lanePath(net, node, fromEast, intoSouth)!;
    expect(path).not.toBeNull();
    const p = resolveAnchor(net, node, fromEast)!;
    const q = resolveAnchor(net, node, intoSouth)!;
    expect(distXZ(path[0], p.pos)).toBeLessThan(1e-6);
    expect(distXZ(path[path.length - 1], q.pos)).toBeLessThan(1e-6);
    const guide = connectorGuide(net, node, p.pos, q.pos, east.segmentId, south.segmentId)!;
    // It bends with the lane path: never further from it than half a lane plus a little.
    for (const pt of path) expect(toPolyline(pt, guide)).toBeLessThan(2.2);
    const mid = path[Math.floor(path.length / 2)];
    expect(toPolyline(mid, [path[0], path[path.length - 1]])).toBeGreaterThan(1);
  });

  it('is null on one arm', () => {
    const { net, node } = crossing();
    const arm = net.nodeGeom(node)!.arms[0].segmentId;
    expect(lanePath(net, node, { segmentId: arm, boundary: 1 }, { segmentId: arm, boundary: 3 })).toBeNull();
  });
});

describe('Rows back along an arm', () => {
  it('lays a row across the arm at the distance asked, snapped to boundaries', () => {
    const { net, node } = crossing();
    const arm = net.nodeGeom(node)!.arms[0];
    const row = armRow(net, node, arm.segmentId, 4.6);
    expect(row).toHaveLength(5);
    expect(row[0].anchor.back).toBe(4.6);
    const cut = resolveAnchor(net, node, { segmentId: arm.segmentId, boundary: row[0].anchor.boundary })!;
    expect(distXZ(row[0].pos, cut.pos)).toBeCloseTo(4.6, 6);
  });

  it('a stop line back along an arm is straight across it', () => {
    const { net, node } = crossing();
    const arm = net.nodeGeom(node)!.arms[0].segmentId;
    const id = net.addNodeMarking(node, {
      kind: 'line',
      from: { segmentId: arm, boundary: 0, back: 4.6 },
      to: { segmentId: arm, boundary: 2, back: 4.6 },
      style: 'stopLine',
      color: 'white',
      width: 0.45,
      straight: true,
    });
    const m = net.getNode(node)!.control.markings!.find((x) => x.id === id) as NodeLineMarking;
    const path = markingPath(net, node, m)!;
    expect(distXZ(path[0], path[path.length - 1])).toBeCloseTo(7, 1);
  });
});

describe('Persistence', () => {
  it('outline, lane and row markings save, load, and follow the road', () => {
    const { net, node } = crossing();
    const chain = cornerChains(net, node)[0];
    const arms = net.nodeGeom(node)!.arms;
    net.addNodeMarking(node, { kind: 'line', from: { segmentId: chain.segmentId, boundary: 0, corner: 0.2 }, to: { segmentId: chain.segmentId, boundary: 0, corner: 0.8 }, style: 'solid', color: 'white', width: 0.15, straight: false, path: 'outline' });
    net.addNodeMarking(node, { kind: 'line', from: { segmentId: arms[0].segmentId, boundary: 1 }, to: { segmentId: arms[1].segmentId, boundary: 3 }, style: 'dashed', color: 'white', width: 0.15, straight: false, path: 'lanes' });
    net.addNodeMarking(node, { kind: 'line', from: { segmentId: arms[2].segmentId, boundary: 0, back: 2 }, to: { segmentId: arms[2].segmentId, boundary: 4, back: 2 }, style: 'crosswalkZebra', color: 'white', width: 3, straight: true });
    const back = new RoadNetwork(net.serialize());
    expect(back.signature()).toBe(net.signature());
    const paths = (n: RoadNetwork) => (n.getNode(node)!.control.markings as NodeLineMarking[]).map((m) => markingPath(n, node, m));
    expect(paths(back).every(Boolean)).toBe(true);
    const before = paths(net);
    net.moveNode(node, { x: 10, y: 0, z: 5 });
    const after = paths(net);
    after.forEach((p, i) => {
      expect(p).not.toBeNull();
      expect(distXZ(p![0], before[i]![0])).toBeGreaterThan(1);
    });
  });
});

describe('Road paint through a junction', () => {
  it('follows the lane path through it instead of bridging straight across', () => {
    const net = new RoadNetwork();
    const a = net.drawRoad({ start: free(-200, 0), end: free(0, 0), roadType: 'street-2' });
    const b = net.drawRoad({ start: atNode(a.nodes[1]), end: free(200, 60), roadType: 'street-2' });
    net.drawRoad({ start: free(0, -200), end: atNode(a.nodes[1]), roadType: 'street-2' });
    net.drawRoad({ start: atNode(a.nodes[1]), end: free(-40, 200), roadType: 'street-2' });
    const node = a.nodes[1];
    expect(net.nodeGeom(node)!.kind).toBe('junction');
    const pieces = roadPathBetween(net, { segmentId: a.segments[0], t: 0.5 }, { segmentId: b.segments[0], t: 0.5 })!;
    expect(pieces).toHaveLength(2);
    const line = pathPoints(net, pieces, 1.75);
    const inside = line.filter((p) => Math.hypot(p.x, p.z) < 8);
    expect(inside.length).toBeGreaterThan(2);
    const graph = net.laneGraph;
    const guides = (graph.connectorsAt.get(node) ?? []).map((i) => {
      const l = graph.lanes[i];
      const pts: Vec3[] = [];
      for (let k = 0; k < l.pts.length; k += 3) pts.push({ x: l.pts[k], y: l.pts[k + 1], z: l.pts[k + 2] });
      return pts;
    });
    for (const p of inside) expect(Math.min(...guides.map((g) => toPolyline(p, g)))).toBeLessThan(0.15);
  });
});

describe('Paths along a tight lane path', () => {
  it('never doubles back when the offset is wider than the turn', () => {
    const guide: Vec3[] = [];
    for (let z = -10; z < 0; z += 2) guide.push({ x: 0, y: 0, z });
    for (let k = 0; k <= 8; k++) {
      const a = (k / 8) * (Math.PI / 2);
      guide.push({ x: 4 - 4 * Math.cos(a), y: 0, z: 4 * Math.sin(a) });
    }
    for (let x = 6; x <= 10; x += 2) guide.push({ x, y: 0, z: 4 });
    // Two metres to the turn's inside at the start, five at the end: past its 4 m radius.
    const path = alongGuide(guide, { x: 2, y: 0, z: -10 }, { x: 10, y: 0, z: -1 });
    expect(path[0]).toEqual({ x: 2, y: 0, z: -10 });
    expect(path[path.length - 1]).toEqual({ x: 10, y: 0, z: -1 });
    for (let i = 1; i < path.length; i++) {
      expect(path[i].x).toBeGreaterThanOrEqual(path[i - 1].x - 1e-6);
      expect(path[i].z).toBeGreaterThanOrEqual(path[i - 1].z - 1e-6);
    }
  });

  it('keeps the exact lane shape when the offset fits', () => {
    const guide: Vec3[] = [0, 1, 2, 3, 4].map((z) => ({ x: 0, y: 0, z }));
    const path = alongGuide(guide, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 4 });
    for (const p of path) expect(p.x).toBeCloseTo(1, 6);
  });
});
