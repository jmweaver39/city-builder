/**
 * Markings placed by hand at nodes and along segments. Everything is recomputed
 * from the anchors, so a marking follows its road: the layer rebuilds any node or
 * segment a network change touches. Every style of core/markingStyle.ts is drawn
 * here: lines (solid, dashed, double, dotted, zigzag, teeth, lanes), crosswalks
 * and stop lines, and patterned areas, in named or the user's own colours, with
 * parts of a line in other styles between the lines it crosses.
 */
import * as THREE from 'three';
import { lineStyleInfo, markingHex, resolvedStyle } from '../core/markingStyle';
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
import { ChunkBatch, PAINT_SCHEMA, PaintBuf, type LinePoint } from './batch';
import { BIAS_DECAL, hexRGB, MARK_LIFT, ROAD_LIFT, type RGB } from './constants';
import { makePaintMaterial, type Shared } from './materials';

const BORDER_WIDTH = 0.2;
const RAIL_WIDTH = 0.25;

const colourCache = new Map<string, RGB>();
function colourOf(m: { color: LineStyleSpec['color']; hex?: string }): RGB {
  const hex = markingHex(m);
  let c = colourCache.get(hex);
  if (!c) colourCache.set(hex, (c = hexRGB(parseInt(hex.slice(1), 16))));
  return c;
}

/** Ribbon points along a polyline, shifted sideways (right of travel is positive). */
export function ribbonPoints(pts: readonly Vec3[], shift: number): LinePoint[] {
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

/** Points every `step` metres along a polyline, with their normals. */
function walk(pts: readonly Vec3[], step: number): { p: Vec3; n: { x: number; z: number }; t: { x: number; z: number } }[] {
  const cum = cumulative(pts);
  const total = cum[cum.length - 1];
  const out: { p: Vec3; n: { x: number; z: number }; t: { x: number; z: number } }[] = [];
  if (total < 1e-6 || step <= 0) return out;
  let k = 1;
  for (let s = 0; s <= total + 1e-6; s += step) {
    while (k < cum.length - 1 && cum[k] < s) k++;
    const a = pts[k - 1];
    const b = pts[k];
    const span = cum[k] - cum[k - 1] || 1;
    const f = Math.min(1, Math.max(0, (s - cum[k - 1]) / span));
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    out.push({ p: { x: a.x + dx * f, y: a.y + (b.y - a.y) * f, z: a.z + dz * f }, n: { x: -dz / l, z: dx / l }, t: { x: dx / l, z: dz / l } });
  }
  return out;
}

/** Total width a line style takes across its path, for alignment. */
function styleSpan(spec: ReturnType<typeof resolvedStyle>): number {
  switch (spec.style) {
    case 'double':
    case 'doubleDashed':
    case 'solidDashed':
    case 'dashedSolid':
      return spec.width * 2 + spec.gap;
    case 'zigzag':
      return spec.gap * 2 + spec.width;
    case 'sharkTeeth':
      return spec.width;
    default:
      return spec.width;
  }
}

/** Fill the band between two offset copies of a path. */
function band(buf: PaintBuf, pts: readonly Vec3[], left: number, right: number, color: RGB): void {
  const n = normalsOf(pts);
  const l = pts.map((p, i) => ({ x: p.x + n[i].x * left, z: p.z + n[i].z * left }));
  const r = pts.map((p, i) => ({ x: p.x + n[i].x * right, z: p.z + n[i].z * right }));
  const coords: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    coords.push(l[i].x, l[i].z, r[i].x, r[i].z, r[i + 1].x, r[i + 1].z);
    coords.push(l[i].x, l[i].z, r[i + 1].x, r[i + 1].z, l[i + 1].x, l[i + 1].z);
  }
  const y = (pts[0]?.y ?? 0) + ROAD_LIFT;
  buf.stamp(coords, y, color);
}

/**
 * Paint a line-family style along a path. `tipSide` points shark's teeth: +1 to
 * the right of travel, -1 to the left.
 */
export function paintAlong(buf: PaintBuf, pts: readonly Vec3[], raw: LineStyleSpec, tipSide: 1 | -1 = 1): void {
  if (pts.length < 2) return;
  const spec = resolvedStyle(raw);
  if (spec.style === 'empty') return;
  const color = colourOf(spec);
  const span = styleSpan(spec);
  const centre = spec.offset + (spec.align === 'left' ? -span / 2 : spec.align === 'right' ? span / 2 : 0);
  const w = spec.width;
  const dashed = (shift: number, width = w) => buf.ribbon(ribbonPoints(pts, shift), width, color, spec.dash + spec.space, spec.dash / (spec.dash + spec.space));
  const solid = (shift: number, width = w) => buf.ribbon(ribbonPoints(pts, shift), width, color, 0, 1);
  const side = spec.gap / 2 + w / 2;
  switch (spec.style) {
    case 'solid':
    case 'stopLine':
      solid(centre);
      return;
    case 'dashed':
    case 'dotted':
      dashed(centre);
      return;
    case 'double':
      solid(centre - side);
      solid(centre + side);
      return;
    case 'doubleDashed':
      dashed(centre - side);
      dashed(centre + side);
      return;
    case 'solidDashed':
      solid(centre - side);
      dashed(centre + side);
      return;
    case 'dashedSolid':
      dashed(centre - side);
      solid(centre + side);
      return;
    case 'zigzag': {
      const steps = walk(pts, Math.max(0.2, spec.dash / 2));
      const zig: Vec3[] = steps.map((s, i) => {
        const k = i === 0 || i === steps.length - 1 ? 0 : i % 2 ? 1 : -1;
        const o = centre + k * spec.gap;
        return { x: s.p.x + s.n.x * o, y: s.p.y, z: s.p.z + s.n.z * o };
      });
      if (zig.length >= 2) buf.ribbon(ribbonPoints(zig, 0), w, color, 0, 1);
      return;
    }
    case 'sharkTeeth': {
      const base = Math.max(0.1, spec.dash);
      const period = base + Math.max(0, spec.space);
      const total = cumulative(pts).at(-1) ?? 0;
      const n = Math.max(0, Math.floor((total - base) / period) + 1);
      if (!n) return;
      // Centre the row along the path, so both ends look the same.
      const lead = (total - ((n - 1) * period + base)) / 2 + base / 2;
      const marks = walk(pts, 0.05);
      const coords: number[] = [];
      for (let i = 0; i < n; i++) {
        const s = marks[Math.min(marks.length - 1, Math.round((lead + i * period) / 0.05))];
        const c = { x: s.p.x + s.n.x * centre, z: s.p.z + s.n.z * centre };
        const half = base / 2;
        // Base on the path, tip `width` away to one side.
        coords.push(c.x - s.t.x * half, c.z - s.t.z * half, c.x + s.t.x * half, c.z + s.t.z * half, c.x + s.n.x * w * tipSide, c.z + s.n.z * w * tipSide);
      }
      buf.stamp(coords, (pts[0].y ?? 0) + ROAD_LIFT, color);
      return;
    }
    case 'lane':
      band(buf, pts, centre - w / 2, centre + w / 2, color);
      return;
    default:
      // A crosswalk style used as a part of a line: draw it as a band.
      band(buf, pts, centre - w / 2, centre + w / 2, color);
  }
}

/** A crossing from a to b, `depth` deep, centred on the line between them. */
export function paintCrossing(buf: PaintBuf, a: Vec3, b: Vec3, raw: LineStyleSpec): void {
  const spec = resolvedStyle(raw);
  const color = colourOf(spec);
  const depth = Math.max(0.3, spec.width);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const L = Math.hypot(dx, dz);
  if (L < 0.1) return;
  const ux = dx / L;
  const uz = dz / L;
  const vx = -uz;
  const vz = ux;
  const y = Math.max(a.y, b.y) + ROAD_LIFT;
  const o = spec.offset;
  const at = (s: number, d: number): [number, number] => [a.x + ux * s + vx * (d + o), a.z + uz * s + vz * (d + o)];
  const bar = (s0: number, d0: number, s1: number, d1: number, width: number) => {
    const [x0, z0] = at(s0, d0);
    const [x1, z1] = at(s1, d1);
    buf.bar(x0, y, z0, x1, y, z1, width, color);
  };
  const rect = (s0: number, s1: number, d0: number, d1: number) => {
    const p = [at(s0, d0), at(s1, d0), at(s1, d1), at(s0, d1)];
    buf.stamp([p[0][0], p[0][1], p[1][0], p[1][1], p[2][0], p[2][1], p[0][0], p[0][1], p[2][0], p[2][1], p[3][0], p[3][1]], y, color);
  };
  /** Stripes across the road from d0 to d1, `dash` wide, `space` apart, centred along it. */
  const stripes = (d0: number, d1: number) => {
    const dash = Math.max(0.1, spec.dash);
    const period = dash + Math.max(0.05, spec.space);
    const n = Math.max(1, Math.floor((L - dash) / period) + 1);
    const used = (n - 1) * period + dash;
    const start = (L - used) / 2 + dash / 2;
    for (let i = 0; i < n; i++) {
      const s = start + i * period;
      bar(s, d0, s, d1, dash);
    }
  };
  const h = depth / 2;
  switch (spec.style) {
    case 'crosswalkZebra':
      stripes(-h, h);
      break;
    case 'crosswalkDoubleZebra': {
      const g = Math.min(spec.gap, depth * 0.6);
      stripes(-h, -g / 2);
      stripes(g / 2, h);
      break;
    }
    case 'crosswalkLadder':
      stripes(-h + RAIL_WIDTH, h - RAIL_WIDTH);
      bar(0, -h + RAIL_WIDTH / 2, L, -h + RAIL_WIDTH / 2, RAIL_WIDTH);
      bar(0, h - RAIL_WIDTH / 2, L, h - RAIL_WIDTH / 2, RAIL_WIDTH);
      break;
    case 'crosswalkLines': {
      const lw = Math.max(0.1, spec.dash);
      bar(0, -h + lw / 2, L, -h + lw / 2, lw);
      bar(0, h - lw / 2, L, h - lw / 2, lw);
      break;
    }
    case 'crosswalkSolid':
      rect(0, L, -h, h);
      break;
    case 'crosswalkChessboard': {
      const cell = Math.max(0.2, spec.dash);
      const rows = Math.max(1, Math.round(depth / cell));
      const ch = depth / rows;
      const cols = Math.max(1, Math.floor(L / cell));
      const cw = L / cols;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if ((r + c) % 2 === 0) rect(c * cw, (c + 1) * cw, -h + r * ch, -h + (r + 1) * ch);
      break;
    }
    case 'stopLine':
      bar(0, 0, L, 0, depth);
      return;
    default:
      stripes(-h, h);
  }
  if (spec.border) {
    const d = h + 0.15 + BORDER_WIDTH / 2;
    for (const side of [-1, 1]) {
      const [x0, z0] = at(0, side * d);
      const [x1, z1] = at(L, side * d);
      if (spec.border === 'dashed') buf.bar(x0, y, z0, x1, y, z1, BORDER_WIDTH, color, 1, 0.5);
      else buf.bar(x0, y, z0, x1, y, z1, BORDER_WIDTH, color);
    }
  }
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
    const style = family === 'stop' ? { ...m, style: 'stopLine' as const } : m;
    paintCrossing(buf, { x: a.x + shift.x, y: a.y, z: a.z + shift.z }, { x: b.x + shift.x, y: b.y, z: b.z + shift.z }, style);
    return;
  }
  const tip = teethSide(net, host, m, pts);
  if (!m.rules?.length) {
    paintAlong(buf, pts, m, tip);
    return;
  }
  const total = cumulative(pts).at(-1) ?? 0;
  const crossings = lineCrossings(net, host, m, pts);
  for (const part of lineStretches(total, m.rules, crossings)) {
    const piece = slicePolyline(pts, part.s0, part.s1);
    if (piece.length < 2) continue;
    paintAlong(buf, piece, part.rule < 0 ? m : m.rules[part.rule].style, tip);
  }
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

/** Signed area in plan: positive when the points run anticlockwise seen with +z down. */
function signedArea(poly: readonly Vec3[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j].x * poly[i].z - poly[i].x * poly[j].z;
  return a / 2;
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

/** Unit normal of an edge pointing into a polygon wound with `sign`. */
function normal(a: Vec3, b: Vec3, sign: number): { x: number; z: number } {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: (-dz / l) * sign, z: (dx / l) * sign };
}

/** The frame of an area's longest edge, turned by `angle` degrees. */
function areaFrame(poly: readonly Vec3[], angle: number): { ux: number; uz: number; vx: number; vz: number; c: Vec3; reach: number } {
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
  const r = (angle * Math.PI) / 180;
  const cx = Math.cos(r);
  const sx = Math.sin(r);
  const tx = ux * cx - uz * sx;
  const tz = ux * sx + uz * cx;
  const c = polygonCentre(poly);
  let reach = 0;
  for (const p of poly) reach = Math.max(reach, Math.hypot(p.x - c.x, p.z - c.z));
  return { ux: tx, uz: tz, vx: -tz, vz: tx, c, reach: reach + 2 };
}

/** The pattern of an area, inside `poly`. */
function fillPattern(m: NodeFillerMarking, poly: readonly Vec3[], y: number, color: RGB, buf: PaintBuf): void {
  const width = Math.max(0.05, m.width);
  const defaults: Record<string, number> = { stripes: 45, hatch: 45, grid: 0, chevron: 0, triangle: 0 };
  const angle = m.fill === 'hatch' ? 45 : (m.angle ?? defaults[m.fill] ?? 0);
  const step = Math.max(width * 1.5, m.step ?? (m.fill === 'chevron' || m.fill === 'triangle' ? 2 : 1.4));
  const f = areaFrame(poly, m.fill === 'hatch' || m.fill === 'stripes' || m.fill === 'grid' ? 0 : angle);
  const span = f.reach;
  const at = (a: number, b: number, fr = f): [number, number] => [fr.c.x + fr.ux * a + fr.vx * b, fr.c.z + fr.uz * a + fr.vz * b];
  if (m.fill === 'stripes' || m.fill === 'hatch' || m.fill === 'grid') {
    const angles = m.fill === 'grid' ? [angle, angle + 90] : [angle];
    for (const a of angles) {
      const fr = areaFrame(poly, a);
      for (let k = -span; k <= span; k += step) {
        const [ax, az] = at(k, -span, fr);
        const [bx, bz] = at(k, span, fr);
        clippedBar(buf, ax, az, bx, bz, poly, y, width, color);
      }
    }
    return;
  }
  if (m.fill === 'chevron') {
    // Rows of Vs pointing along the area's axis, mirrored about its centre line.
    for (let k = -span * 2; k <= span * 2; k += step) {
      const [tipX, tipZ] = at(k, 0);
      const [l, mm] = at(k - span, -span);
      const [r, s] = at(k - span, span);
      clippedBar(buf, l, mm, tipX, tipZ, poly, y, width, color);
      clippedBar(buf, r, s, tipX, tipZ, poly, y, width, color);
    }
    return;
  }
  if (m.fill === 'triangle') {
    const size = step * 0.6;
    const coords: number[] = [];
    for (let a = -span; a <= span; a += step) {
      for (let b = -span; b <= span; b += step) {
        const p0 = at(a - size / 2, b - size / 2);
        const p1 = at(a - size / 2, b + size / 2);
        const p2 = at(a + size / 2, b);
        if ([p0, p1, p2].every(([x, z]) => inside(x, z, poly))) coords.push(p0[0], p0[1], p1[0], p1[1], p2[0], p2[1]);
      }
    }
    buf.stamp(coords, y, color);
  }
}

function buildFiller(net: RoadNetwork, host: HostArg, m: NodeFillerMarking, buf: PaintBuf): void {
  const outer = fillerPolygon(net, host, m);
  if (!outer) return;
  const poly = m.offset ? insetPolygon(outer, m.offset) : outer;
  const color = colourOf(m);
  const y = polygonCentre(poly).y + ROAD_LIFT;
  if (m.fill === 'solid') {
    fillSolid(poly, y, color, buf);
    return;
  }
  if (!m.noOutline) outlineOf(poly, y, Math.max(0.12, Math.min(m.width, 0.3)), color, buf);
  fillPattern(m, poly, y, color, buf);
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
  private batch: ChunkBatch;
  private segBatch: ChunkBatch;
  private material: THREE.Material;
  private dirty = new Set<Id>();
  private dirtySegs = new Set<Id>();
  private wholeMap = true;
  private known = new Set<Id>();
  private knownSegs = new Set<Id>();
  private off: () => void;

  constructor(private readonly net: RoadNetwork, shared: Shared) {
    this.material = makePaintMaterial(shared, { bias: BIAS_DECAL, lift: MARK_LIFT + 0.006, fade: false });
    this.batch = new ChunkBatch(PAINT_SCHEMA, this.material, { renderOrder: 6, receiveShadow: true, chunkSize: 500 });
    this.segBatch = new ChunkBatch(PAINT_SCHEMA, this.material, { renderOrder: 6, receiveShadow: true, chunkSize: 500 });
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
      for (const n of this.net.nodes) if (n.control.markings) this.dirty.add(n.id);
      for (const s of this.net.segments) if (s.overrides.handMarkings) this.dirtySegs.add(s.id);
    }
    if (this.dirty.size) {
      for (const id of this.dirty) {
        const buf = new PaintBuf();
        if (this.net.getNode(id)) buildNodeMarkings(this.net, id, buf);
        this.batch.set(id, buf.toPiece());
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
        this.segBatch.set(id, buf.toPiece());
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
    this.material.dispose();
  }
}
