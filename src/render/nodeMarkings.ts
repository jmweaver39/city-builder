/**
 * Markings placed by hand at nodes and along segments. Everything is recomputed
 * from the anchors, so a marking follows its road: the layer rebuilds any node or
 * segment a network change touches. Every style of core/markingStyle.ts is drawn
 * here: lines (solid, dashed, double, dotted, zigzag, teeth, lanes), crosswalks
 * and stop lines, and patterned areas, in named or the user's own colours, with
 * parts of a line in other styles between the lines it crosses.
 */
import * as THREE from 'three';
import { lineStyleInfo, resolvedStyle } from '../core/markingStyle';
import {
  acrossOneArm,
  cumulative,
  fillerPolygon,
  framesOf,
  hostOf,
  lineCrossings,
  lineStretches,
  markingPath,
  polygonCentre,
  slicePolyline,
  type HostArg,
} from '../core/nodeMarkings';
import type { NetworkChange, RoadNetwork } from '../core/RoadNetwork';
import type { Id, LineStyleSpec, MarkingHost, NodeFillerMarking, NodeLineMarking, Vec3 } from '../core/types';
import { PaintBuf } from './batch';
import { ROAD_LIFT } from './constants';
import type { Shared } from './materials';
import { roadSpeed, segmentMarkingRun } from '../core/paintCoherence';
import { segmentDashPhase } from './markings';
import { PaintBatches, StationPath, clipToPolygon as clipShared, markingMaterial, paintArea, paintCrossing as paintCrossingShared, paintRGB, paintRoadLine, paintSpecAlong, ribbonPoints as ribbonShared } from './paint';

/** Ribbon points along a polyline, shifted sideways (right of travel is positive). */
export const ribbonPoints = ribbonShared;
export const clipToPolygon = clipShared;
export const paintCrossing = paintCrossingShared;

/** Right-of-travel normal at each point of a polyline. */
function normalsOf(pts: readonly Vec3[]): { x: number; z: number }[] {
  return pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: -dz / l, z: dx / l };
  });
}

/**
 * Paint a line-family style along a path. `tipSide` points shark's teeth: +1 to
 * the right of travel, -1 to the left. The shared painter (paint.ts).
 */
export function paintAlong(buf: PaintBuf, pts: readonly Vec3[], raw: LineStyleSpec, tipSide: 1 | -1 = 1, speedKmh = 50): void {
  paintSpecAlong(buf, pts, raw, tipSide, speedKmh);
}

/** The direction a row of teeth should point for a line: back up an arm at a junction, else to its right. */
function teethSide(net: RoadNetwork, host: MarkingHost, m: NodeLineMarking, pts: readonly Vec3[]): 1 | -1 {
  const flip = m.align === 'left' ? -1 : 1;
  if (!acrossOneArm(m.from, m.to)) return flip as 1 | -1;
  const frame = framesOf(net, host).find((f) => f.segmentId === m.from.segmentId && f.end === m.from.end);
  if (!frame) return flip as 1 | -1;
  const n = normalsOf(pts)[Math.floor(pts.length / 2)];
  const towardBack = n.x * frame.backDir.x + n.z * frame.backDir.z >= 0 ? 1 : -1;
  return (towardBack * (m.align === 'left' ? -1 : 1)) as 1 | -1;
}

function buildLine(net: RoadNetwork, hostArg: HostArg, m: NodeLineMarking, buf: PaintBuf): void {
  const host = hostOf(hostArg);
  const pts = markingPath(net, host, m);
  if (!pts || pts.length < 2) return;
  const family = lineStyleInfo(m.style).family;
  if (family === 'crosswalk' || family === 'stop') {
    const a = pts[0];
    const b = pts[pts.length - 1];
    let shift = { x: 0, z: 0 };
    // Across one arm on its cut line, stand it just inside the junction.
    if (host.kind === 'node' && acrossOneArm(m.from, m.to) && !m.from.back && family === 'crosswalk') {
      const node = net.getNode(host.id);
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      if (node) {
        const sideOfNode = (node.pos.x - a.x) * -dz + (node.pos.z - a.z) * dx >= 0 ? 1 : -1;
        const k = sideOfNode * (Math.max(m.width, 1) / 2 + 0.3);
        shift = { x: (-dz / l) * k, z: (dx / l) * k };
      }
    }
    const style = m;
    paintCrossing(buf, { x: a.x + shift.x, y: a.y, z: a.z + shift.z }, { x: b.x + shift.x, y: b.y, z: b.z + shift.z }, style);
    return;
  }
  const tip = teethSide(net, host, m, pts);
  const speed = roadSpeed(net, host.kind === 'segment' ? host.id : m.from.segmentId);
  if (!m.rules?.length) {
    // Along a road, a line is painted exactly as the road's own lines: same path, same dash phase.
    if (host.kind === 'segment') {
      const run = segmentMarkingRun(net, host.id, m);
      const geom = net.segmentGeom(host.id);
      const phase = segmentDashPhase(net, host.id);
      if (run && geom && phase) {
        const spec = resolvedStyle(run.look, speed);
        paintRoadLine(buf, new StationPath(geom.stations), run.s0, run.s1, run.offset, spec, phase, paintRGB(spec));
        return;
      }
    }
    paintAlong(buf, pts, m, tip, speed);
    return;
  }
  const total = cumulative(pts).at(-1) ?? 0;
  const crossings = lineCrossings(net, host, m, pts);
  for (const part of lineStretches(total, m.rules, crossings)) {
    const piece = slicePolyline(pts, part.s0, part.s1);
    if (piece.length < 2) continue;
    paintAlong(buf, piece, part.rule < 0 ? m : m.rules[part.rule].style, tip, speed);
  }
}

/** Signed area in plan: positive when the points run anticlockwise seen with +z down. */
function signedArea(poly: readonly Vec3[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j].x * poly[i].z - poly[i].x * poly[j].z;
  return a / 2;
}

/** Unit normal of an edge pointing into a polygon wound with `sign`. */
function normal(a: Vec3, b: Vec3, sign: number): { x: number; z: number } {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: (-dz / l) * sign, z: (dx / l) * sign };
}

/** The polygon moved in by `d` metres along each corner's bisector. */
export function insetPolygon(poly: readonly Vec3[], d: number): Vec3[] {
  if (Math.abs(d) < 1e-6 || poly.length < 3) return [...poly];
  const sign = signedArea(poly) > 0 ? 1 : -1;
  const n = poly.length;
  return poly.map((p, i) => {
    const a = poly[(i - 1 + n) % n];
    const b = poly[(i + 1) % n];
    const n1 = normal(a, p, sign);
    const n2 = normal(p, b, sign);
    let bx = n1.x + n2.x;
    let bz = n1.z + n2.z;
    const bl = Math.hypot(bx, bz) || 1;
    bx /= bl;
    bz /= bl;
    const cos = Math.max(0.25, bx * n1.x + bz * n1.z);
    return { x: p.x + (bx * d) / cos, y: p.y, z: p.z + (bz * d) / cos };
  });
}

function buildFiller(net: RoadNetwork, host: HostArg, m: NodeFillerMarking, buf: PaintBuf): void {
  const outer = fillerPolygon(net, host, m);
  if (!outer) return;
  const poly = m.offset ? insetPolygon(outer, m.offset) : outer;
  paintArea(buf, poly, polygonCentre(poly).y + ROAD_LIFT, m);
}

/** All hand-placed paint of a node, or of a segment. */
export function buildNodeMarkings(net: RoadNetwork, hostArg: HostArg, buf: PaintBuf): void {
  const host = hostOf(hostArg);
  for (const m of net.markingsOf(host)) {
    if (m.kind === 'line') buildLine(net, host, m, buf);
    else buildFiller(net, host, m, buf);
  }
}

export class NodeMarkingLayer {
  readonly group = new THREE.Group();
  private batch: PaintBatches;
  private segBatch: PaintBatches;
  private material: THREE.Material;
  private dirty = new Set<Id>();
  private dirtySegs = new Set<Id>();
  private wholeMap = true;
  private known = new Set<Id>();
  private knownSegs = new Set<Id>();
  private off: () => void;

  constructor(private readonly net: RoadNetwork, shared: Shared) {
    // The one paint material and stacking order every marking uses.
    this.material = markingMaterial(shared);
    this.batch = new PaintBatches(this.material, { chunkSize: 500 });
    this.segBatch = new PaintBatches(this.material, { chunkSize: 500 });
    this.group.add(this.batch.group, this.segBatch.group);
    this.off = net.onChange((c) => this.note(c));
  }

  private note(c: NetworkChange): void {
    if (c.reset) this.wholeMap = true;
    for (const id of c.dirtyNodes) this.dirty.add(id);
    for (const id of c.removedNodes) this.dirty.add(id);
    for (const id of c.dirtySegments) this.dirtySegs.add(id);
    for (const id of c.removedSegments) this.dirtySegs.add(id);
    // A segment's ends move with its nodes.
    for (const id of c.dirtyNodes) for (const s of this.net.getNode(id)?.segments ?? []) if (this.knownSegs.has(s)) this.dirtySegs.add(s);
  }

  /** Rebuild whatever changed. Call once a frame. */
  flush(): void {
    if (this.wholeMap) {
      this.wholeMap = false;
      this.dirty.clear();
      this.dirtySegs.clear();
      for (const id of this.known) this.batch.set(id, null);
      for (const id of this.knownSegs) this.segBatch.set(id, null);
      this.known.clear();
      this.knownSegs.clear();
      // A new map with no markings still has to drop the old map's paint.
      this.batch.flush();
      this.segBatch.flush();
      for (const n of this.net.nodes) if (n.control.markings) this.dirty.add(n.id);
      for (const s of this.net.segments) if (s.overrides.handMarkings) this.dirtySegs.add(s.id);
    }
    if (this.dirty.size) {
      for (const id of this.dirty) {
        const buf = new PaintBuf();
        if (this.net.getNode(id)) buildNodeMarkings(this.net, id, buf);
        this.batch.set(id, buf);
        if (buf.vertexCount) this.known.add(id);
        else this.known.delete(id);
      }
      this.dirty.clear();
      this.batch.flush();
    }
    if (this.dirtySegs.size) {
      for (const id of this.dirtySegs) {
        const buf = new PaintBuf();
        if (this.net.getSegment(id)) buildNodeMarkings(this.net, { kind: 'segment', id }, buf);
        this.segBatch.set(id, buf);
        if (buf.vertexCount) this.knownSegs.add(id);
        else this.knownSegs.delete(id);
      }
      this.dirtySegs.clear();
      this.segBatch.flush();
    }
  }

  dispose(): void {
    this.off();
    this.batch.dispose();
    this.segBatch.dispose();
  }
}
