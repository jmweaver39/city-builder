/**
 * Markings placed by hand at nodes. Everything is recomputed from the anchors, so
 * a marking follows its road: the layer rebuilds any node a network change touches.
 */
import * as THREE from 'three';
import { fillerPolygon, lineCurve, polygonCentre, sampleCurve } from '../core/nodeMarkings';
import type { NetworkChange, RoadNetwork } from '../core/RoadNetwork';
import type { Id, LineStyle, NodeFillStyle, NodeFillerMarking, NodeLineMarking, NodeLineStyle, Vec3 } from '../core/types';
import { ChunkBatch, PAINT_SCHEMA, PaintBuf, type LinePoint } from './batch';
import { BIAS_DECAL, MARK_LIFT, PAINT_COL, ROAD_LIFT, strokesOf, type RGB } from './constants';
import { paintCrosswalk } from './markings';
import { makePaintMaterial, type Shared } from './materials';

const LINE_STROKES: Partial<Record<NodeLineStyle, LineStyle>> = {
  solid: 'solid',
  dashed: 'dashed',
  double: 'double',
  solidDashed: 'solidDashed',
  dotted: 'dotted',
};
const CROSSWALKS = { crosswalkZebra: 'zebra', crosswalkLadder: 'ladder', crosswalkLines: 'lines' } as const;
const STRIPE_STEP = 1.4;

/** Ribbon points along a polyline, shifted sideways. */
function ribbonPoints(pts: readonly Vec3[], shift: number): LinePoint[] {
  const out: LinePoint[] = [];
  let u = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    const rx = -dz / l;
    const rz = dx / l;
    if (i > 0) u += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
    out.push({ x: p.x + rx * shift, y: p.y + ROAD_LIFT, z: p.z + rz * shift, rx, rz, u });
  }
  return out;
}

const lifted = (p: Vec3): Vec3 => ({ x: p.x, y: p.y + ROAD_LIFT, z: p.z });

function buildLine(net: RoadNetwork, nodeId: Id, m: NodeLineMarking, buf: PaintBuf): void {
  const curve = lineCurve(net, nodeId, m);
  if (!curve) return;
  const color = PAINT_COL[m.color];
  const stroked = LINE_STROKES[m.style];
  if (stroked) {
    const pts = sampleCurve(curve, 0.8);
    for (const k of strokesOf(stroked)) buf.ribbon(ribbonPoints(pts, k.shift * (m.width / 0.16)), m.width, color, k.period, k.duty);
    return;
  }
  const a = lifted(curve.p0);
  const b = lifted(curve.p3);
  if (m.style === 'stopLine') {
    buf.bar(a.x, a.y, a.z, b.x, b.y, b.z, m.width, color);
    return;
  }
  const style = CROSSWALKS[m.style as keyof typeof CROSSWALKS];
  if (!style) return;
  // Across one arm the anchors are on the cut line, so stand it just inside the junction.
  const depth = Math.max(m.width, 1);
  let shiftX = 0;
  let shiftZ = 0;
  if (m.from.segmentId === m.to.segmentId) {
    const node = net.getNode(nodeId);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    if (node) {
      const sideOfNode = (node.pos.x - a.x) * -dz + (node.pos.z - a.z) * dx >= 0 ? 1 : -1;
      shiftX = (-dz / l) * sideOfNode * (depth / 2 + 0.3);
      shiftZ = (dx / l) * sideOfNode * (depth / 2 + 0.3);
    }
  }
  paintCrosswalk(buf, { x: a.x + shiftX, y: a.y, z: a.z + shiftZ }, { x: b.x + shiftX, y: b.y, z: b.z + shiftZ }, depth, style, color);
}

/** The parts of a straight line inside a polygon, as parameter pairs along it. */
export function clipToPolygon(ax: number, az: number, bx: number, bz: number, poly: readonly Vec3[]): [number, number][] {
  const cuts = [0, 1];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const rx = bx - ax;
    const rz = bz - az;
    const sx = q.x - p.x;
    const sz = q.z - p.z;
    const denom = rx * sz - rz * sx;
    if (Math.abs(denom) < 1e-9) continue;
    const t = ((p.x - ax) * sz - (p.z - az) * sx) / denom;
    const u = ((p.x - ax) * rz - (p.z - az) * rx) / denom;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
  }
  cuts.sort((x, y) => x - y);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const t = (cuts[i] + cuts[i + 1]) / 2;
    if (inside(ax + (bx - ax) * t, az + (bz - az) * t, poly)) out.push([cuts[i], cuts[i + 1]]);
  }
  return out;
}

function inside(x: number, z: number, poly: readonly Vec3[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}

function clippedBar(buf: PaintBuf, ax: number, az: number, bx: number, bz: number, poly: readonly Vec3[], y: number, width: number, color: RGB): void {
  for (const [t0, t1] of clipToPolygon(ax, az, bx, bz, poly)) {
    buf.bar(ax + (bx - ax) * t0, y, az + (bz - az) * t0, ax + (bx - ax) * t1, y, az + (bz - az) * t1, width, color);
  }
}

function outlineOf(poly: readonly Vec3[], y: number, width: number, color: RGB, buf: PaintBuf): void {
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    buf.bar(p.x, y, p.z, q.x, y, q.z, width, color);
  }
}

function fillSolid(poly: readonly Vec3[], y: number, color: RGB, buf: PaintBuf): void {
  const contour = poly.map((p) => new THREE.Vector2(p.x, p.z));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  const coords: number[] = [];
  for (const f of faces) for (const i of f) coords.push(poly[i].x, poly[i].z);
  buf.stamp(coords, y, color);
}

/** Stripes across the polygon, in the frame of its longest edge. */
function fillStripes(style: NodeFillStyle, poly: readonly Vec3[], y: number, width: number, color: RGB, buf: PaintBuf): void {
  let ux = 1;
  let uz = 0;
  let longest = -1;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const l = Math.hypot(q.x - p.x, q.z - p.z);
    if (l > longest && l > 1e-6) {
      longest = l;
      ux = (q.x - p.x) / l;
      uz = (q.z - p.z) / l;
    }
  }
  const vx = -uz;
  const vz = ux;
  const c = polygonCentre(poly);
  let reach = 0;
  for (const p of poly) reach = Math.max(reach, Math.hypot(p.x - c.x, p.z - c.z));
  const span = reach + 2;
  const at = (a: number, b: number): [number, number] => [c.x + ux * a + vx * b, c.z + uz * a + vz * b];
  for (let k = -span * 2; k <= span * 2; k += STRIPE_STEP) {
    if (style === 'hatch') {
      const [ax, az] = at(k - span, -span);
      const [bx, bz] = at(k + span, span);
      clippedBar(buf, ax, az, bx, bz, poly, y, width, color);
    } else {
      // A row of Vs pointing along the longest edge, mirrored about the centre line.
      const [tipX, tipZ] = at(k, 0);
      const [l, m] = at(k - span, -span);
      const [r, s] = at(k - span, span);
      clippedBar(buf, l, m, tipX, tipZ, poly, y, width, color);
      clippedBar(buf, r, s, tipX, tipZ, poly, y, width, color);
    }
  }
}

function buildFiller(net: RoadNetwork, nodeId: Id, m: NodeFillerMarking, buf: PaintBuf): void {
  const poly = fillerPolygon(net, nodeId, m);
  if (!poly) return;
  const color = PAINT_COL[m.color];
  const y = polygonCentre(poly).y + ROAD_LIFT;
  if (m.fill === 'solid') {
    fillSolid(poly, y, color, buf);
    return;
  }
  outlineOf(poly, y, Math.max(0.12, m.width), color, buf);
  fillStripes(m.fill, poly, y, Math.max(0.1, m.width), color, buf);
}

/** All hand-placed paint at one node. */
export function buildNodeMarkings(net: RoadNetwork, nodeId: Id, buf: PaintBuf): void {
  for (const m of net.getNode(nodeId)?.control.markings ?? []) {
    if (m.kind === 'line') buildLine(net, nodeId, m, buf);
    else buildFiller(net, nodeId, m, buf);
  }
}

export class NodeMarkingLayer {
  readonly group = new THREE.Group();
  private batch: ChunkBatch;
  private material: THREE.Material;
  private dirty = new Set<Id>();
  private wholeMap = true;
  private known = new Set<Id>();
  private off: () => void;

  constructor(private readonly net: RoadNetwork, shared: Shared) {
    this.material = makePaintMaterial(shared, { bias: BIAS_DECAL, lift: MARK_LIFT + 0.006, fade: false });
    this.batch = new ChunkBatch(PAINT_SCHEMA, this.material, { renderOrder: 6, receiveShadow: true, chunkSize: 500 });
    this.group.add(this.batch.group);
    this.off = net.onChange((c) => this.note(c));
  }

  private note(c: NetworkChange): void {
    if (c.reset) this.wholeMap = true;
    for (const id of c.dirtyNodes) this.dirty.add(id);
    for (const id of c.removedNodes) this.dirty.add(id);
  }

  /** Rebuild whatever changed. Call once a frame. */
  flush(): void {
    if (this.wholeMap) {
      this.wholeMap = false;
      this.dirty.clear();
      for (const id of this.known) this.batch.set(id, null);
      this.known.clear();
      for (const n of this.net.nodes) if (n.control.markings) this.dirty.add(n.id);
    }
    if (!this.dirty.size) return;
    for (const id of this.dirty) {
      const buf = new PaintBuf();
      buildNodeMarkings(this.net, id, buf);
      this.batch.set(id, buf.toPiece());
      if (buf.vertexCount) this.known.add(id);
      else this.known.delete(id);
    }
    this.dirty.clear();
    this.batch.flush();
  }

  dispose(): void {
    this.off();
    this.batch.dispose();
    this.material.dispose();
  }
}
