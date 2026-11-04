/**
 * The one paint pipeline. Automatic road markings, junction guides and gores,
 * hand-placed junction and road markings and Paint tool decals all draw through
 * these functions, with the measures of core/paintStandard.ts, into PaintBufs
 * whose marks are sorted into stacking layers, and render with one material.
 *
 *   paintRoadLine   a line along a road at an offset, dashed in the road's own phase
 *   paintSpecAlong  any line look along any path (lines, teeth, painted lanes)
 *   paintCrossing   crosswalks and stop bars across a road
 *   paintArea       filled and patterned areas
 *   PaintBatches    four chunk batches, one per layer, sharing the paint material
 */
import * as THREE from 'three';
import { fillStyleInfo, lineStyleInfo, markingHex, resolvedStyle } from '../core/markingStyle';
import { CROSSWALK, LINE_W, PAINT_MATERIAL, fitDashes, strokesOfSpec, styleSpan, type ResolvedSpec } from '../core/paintStandard';
import { cumulative, polygonCentre } from '../core/nodeMarkings';
import type { LineStyleSpec, NodeFillerMarking, Station, Vec3 } from '../core/types';
import { ChunkBatch, PAINT_LAYER_NAMES, PAINT_SCHEMA, PaintBuf, type LinePoint, type PaintLayerName } from './batch';
import { ROAD_LIFT, hexRGB, type RGB } from './constants';
import { makePaintMaterial, type Shared } from './materials';

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const colourCache = new Map<string, RGB>();

/** Linear colour of a look: its own hex, or the named paint colour. */
export function paintRGB(m: { color: LineStyleSpec['color']; hex?: string }): RGB {
  const hex = markingHex(m);
  let c = colourCache.get(hex);
  if (!c) colourCache.set(hex, (c = hexRGB(parseInt(hex.slice(1), 16))));
  return c;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Linear lookup along stations, by arc length. */
export class StationPath {
  constructor(readonly st: readonly Station[]) {}
  get s0(): number {
    return this.st[0].s;
  }
  get s1(): number {
    return this.st[this.st.length - 1].s;
  }
  /** Point at arc length s, offset to the right. */
  at(s: number, offset: number): LinePoint {
    const st = this.st;
    let i = 0;
    while (i + 2 < st.length && st[i + 1].s < s) i++;
    const a = st[i];
    const b = st[i + 1];
    const f = Math.min(1, Math.max(0, (s - a.s) / Math.max(b.s - a.s, 1e-6)));
    let rx = a.right.x + (b.right.x - a.right.x) * f;
    let rz = a.right.z + (b.right.z - a.right.z) * f;
    const l = Math.hypot(rx, rz) || 1;
    rx /= l;
    rz /= l;
    return {
      x: a.pos.x + (b.pos.x - a.pos.x) * f + rx * offset,
      y: a.pos.y + (b.pos.y - a.pos.y) * f + ROAD_LIFT,
      z: a.pos.z + (b.pos.z - a.pos.z) * f + rz * offset,
      rx,
      rz,
      u: s,
    };
  }
  /** Polyline at a fixed offset between two arc lengths. */
  line(s0: number, s1: number, offset: number): LinePoint[] {
    const out: LinePoint[] = [this.at(s0, offset)];
    for (const st of this.st) {
      if (st.s <= s0 + 0.01 || st.s >= s1 - 0.01) continue;
      const rx = st.right.x;
      const rz = st.right.z;
      out.push({ x: st.pos.x + rx * offset, y: st.pos.y + ROAD_LIFT, z: st.pos.z + rz * offset, rx, rz, u: st.s });
    }
    out.push(this.at(s1, offset));
    return out;
  }
  /** Arc length at a curve parameter t, from the stations' own t. */
  sAtT(t: number): number {
    const st = this.st;
    if (t <= st[0].t) return st[0].s;
    if (t >= st[st.length - 1].t) return st[st.length - 1].s;
    let i = 0;
    while (i + 2 < st.length && st[i + 1].t < t) i++;
    const a = st[i];
    const b = st[i + 1];
    return a.s + ((t - a.t) / Math.max(b.t - a.t, 1e-9)) * (b.s - a.s);
  }
}

/** Ribbon points along a polyline, shifted sideways (right of travel is positive). */
export function ribbonPoints(pts: readonly Vec3[], shift: number, u0 = 0): LinePoint[] {
  const out: LinePoint[] = [];
  let u = u0;
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

/** Place local triangles at a point. fx, fz is forward. */
export function placeStamp(tris: readonly number[], x: number, z: number, fx: number, fz: number, scale: number): number[] {
  const rx = -fz;
  const rz = fx;
  const out = new Array<number>(tris.length);
  for (let i = 0; i < tris.length; i += 2) {
    const a = tris[i] * scale;
    const b = tris[i + 1] * scale;
    out[i] = x + rx * a + fx * b;
    out[i + 1] = z + rz * a + fz * b;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lines along a road
// ---------------------------------------------------------------------------

/**
 * Where a road's dashes start and how long the run they are fitted to is. Every
 * dashed line along one road, automatic or not, takes its phase from this, so a
 * hand-drawn line continuing an automatic one meets it dash for dash.
 */
export interface DashPhase {
  origin: number;
  run: number;
}

/** The period a stroke takes in a phase: fitted to the run, 0 (solid) when the run is too short. */
export function phasedPeriod(phase: DashPhase, period: number, duty: number): number {
  return period > 0 ? fitDashes(phase.run, period, duty) : 0;
}

/**
 * A line along a road from s0 to s1 (arc lengths, s0 below s1) at a lateral offset
 * right of a-to-b, in a look given in the road's a-to-b frame. The automatic lines
 * and every hand-placed line along a road draw through this.
 */
export function paintRoadLine(buf: PaintBuf, path: StationPath, s0: number, s1: number, offset: number, spec: ResolvedSpec, phase: DashPhase, rgb: RGB): void {
  if (s1 - s0 < 0.05) return;
  const strokes = strokesOfSpec(spec);
  if (!strokes) {
    // Teeth, zigzags and painted lanes have no phase: draw them along the offset path.
    const pts = path.line(s0, s1, offset).map((p) => ({ x: p.x, y: p.y - ROAD_LIFT, z: p.z }));
    paintSpecAlong(buf, pts, spec);
    return;
  }
  const rgb2 = spec.color2 || spec.hex2 ? paintRGB({ color: spec.color2 ?? spec.color, hex: spec.hex2 }) : rgb;
  buf.inLayer('line', () => {
    for (const k of strokes) {
      const pts = path.line(s0, s1, offset + k.shift).map((p) => ({ ...p, u: p.u - phase.origin }));
      const period = phasedPeriod(phase, k.period, k.duty);
      buf.ribbon(pts, k.width, k.second ? rgb2 : rgb, period, period > 0 ? k.duty : 1);
    }
  });
}

// ---------------------------------------------------------------------------
// Any look along any path
// ---------------------------------------------------------------------------

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
  buf.inLayer('fill', () => buf.stamp(coords, y, color));
}

/**
 * Paint a line-family look along a path (unlifted road points). `tipSide` points
 * shark's teeth: +1 to the right of travel, -1 to the left. `u0` is where the
 * path's dashes start; `speedKmh` sets unset dashes.
 */
export function paintSpecAlong(buf: PaintBuf, pts: readonly Vec3[], raw: LineStyleSpec, tipSide: 1 | -1 = 1, speedKmh = 50, u0 = 0): void {
  if (pts.length < 2) return;
  const spec = resolvedStyle(raw, speedKmh);
  if (spec.style === 'empty') return;
  const color = paintRGB(spec);
  const strokes = strokesOfSpec(spec);
  if (strokes) {
    const color2 = spec.color2 || spec.hex2 ? paintRGB({ color: spec.color2 ?? spec.color, hex: spec.hex2 }) : color;
    buf.inLayer('line', () => {
      for (const k of strokes) buf.ribbon(ribbonPoints(pts, k.shift, u0), k.width, k.second ? color2 : color, k.period, k.period > 0 ? k.duty : 1);
    });
    return;
  }
  const span = styleSpan(spec);
  const centre = spec.offset + (spec.align === 'left' ? -span / 2 : spec.align === 'right' ? span / 2 : 0);
  const w = spec.width;
  switch (spec.style) {
    case 'zigzag': {
      const steps = walk(pts, Math.max(0.2, spec.dash / 2));
      const zig: Vec3[] = steps.map((s, i) => {
        const k = i === 0 || i === steps.length - 1 ? 0 : i % 2 ? 1 : -1;
        const o = centre + k * spec.gap;
        return { x: s.p.x + s.n.x * o, y: s.p.y, z: s.p.z + s.n.z * o };
      });
      if (zig.length >= 2) buf.inLayer('line', () => buf.ribbon(ribbonPoints(zig, 0), w, color, 0, 1));
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
      buf.inLayer('bar', () => buf.stamp(coords, (pts[0].y ?? 0) + ROAD_LIFT, color));
      return;
    }
    default:
      // A painted lane, or a crosswalk look used as a part of a line: a band.
      band(buf, pts, centre - w / 2, centre + w / 2, color);
  }
}

// ---------------------------------------------------------------------------
// Across a road
// ---------------------------------------------------------------------------

/**
 * A crossing from a to b (unlifted road points), `width` deep, centred on the line
 * between them: every crosswalk look, and stop bars. Automatic crosswalks draw
 * through this too.
 */
export function paintCrossing(buf: PaintBuf, a: Vec3, b: Vec3, raw: LineStyleSpec): void {
  const spec = resolvedStyle(raw);
  const color = paintRGB(spec);
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
  const bar = (s0: number, d0: number, s1: number, d1: number, width: number, period = 0, duty = 1) => {
    const [x0, z0] = at(s0, d0);
    const [x1, z1] = at(s1, d1);
    buf.bar(x0, y, z0, x1, y, z1, width, color, period, duty);
  };
  const dashOf = () => {
    const period = Math.max(0.1, spec.dash) + Math.max(0.05, spec.space);
    return { period, duty: Math.max(0.1, spec.dash) / period };
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
  const rail = CROSSWALK.rail;
  buf.inLayer('bar', () => {
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
        stripes(-h + rail, h - rail);
        bar(0, -h + rail / 2, L, -h + rail / 2, rail);
        bar(0, h - rail / 2, L, h - rail / 2, rail);
        break;
      case 'crosswalkLines': {
        const lw = Math.max(0.1, spec.dash);
        bar(0, -h + lw / 2, L, -h + lw / 2, lw);
        bar(0, h - lw / 2, L, h - lw / 2, lw);
        break;
      }
      case 'crosswalkDashedLines': {
        const lw = Math.max(0.1, spec.dash);
        const period = Math.max(0.1, spec.gap) + Math.max(0.05, spec.space);
        const duty = Math.max(0.1, spec.gap) / period;
        bar(0, -h + lw / 2, L, -h + lw / 2, lw, period, duty);
        bar(0, h - lw / 2, L, h - lw / 2, lw, period, duty);
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
      case 'stopLineDashed': {
        const d = dashOf();
        bar(0, 0, L, 0, depth, d.period, d.duty);
        return;
      }
      case 'stopLineDouble':
      case 'stopLineSolidDashed': {
        // Two bars, `width` each, `gap` apart; the dashed one is the one further back (-d).
        const w = Math.max(0.1, spec.width);
        const off = (w + Math.max(0.05, spec.gap)) / 2;
        bar(0, off, L, off, w);
        if (spec.style === 'stopLineDouble') bar(0, -off, L, -off, w);
        else {
          const d = dashOf();
          bar(0, -off, L, -off, w, d.period, d.duty);
        }
        return;
      }
      default:
        stripes(-h, h);
    }
    if (spec.border) {
      const d = h + CROSSWALK.borderGap + CROSSWALK.border / 2;
      for (const side of [-1, 1]) {
        const [x0, z0] = at(0, side * d);
        const [x1, z1] = at(L, side * d);
        if (spec.border === 'dashed') buf.bar(x0, y, z0, x1, y, z1, CROSSWALK.border, color, 1, 0.5);
        else buf.bar(x0, y, z0, x1, y, z1, CROSSWALK.border, color);
      }
    }
  });
}

/** True for looks laid across a road rather than along it. */
export function isCrossingStyle(style: LineStyleSpec['style']): boolean {
  const f = lineStyleInfo(style).family;
  return f === 'crosswalk' || f === 'stop';
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

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
    if (insidePolygon(ax + (bx - ax) * t, az + (bz - az) * t, poly)) out.push([cuts[i], cuts[i + 1]]);
  }
  return out;
}

export function insidePolygon(x: number, z: number, poly: readonly Vec3[]): boolean {
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

export type AreaLook = Pick<NodeFillerMarking, 'fill' | 'color' | 'hex' | 'width' | 'angle' | 'step' | 'noOutline' | 'invert'>;

/**
 * A filled or patterned area inside `poly` (road points, already lifted to the
 * paint height `y`). Hand-placed areas, Paint tool areas and gores draw through this.
 */
export function paintArea(buf: PaintBuf, poly: readonly Vec3[], y: number, m: AreaLook): void {
  if (poly.length < 3) return;
  const color = paintRGB(m);
  if (m.fill === 'solid') {
    const contour = poly.map((p) => new THREE.Vector2(p.x, p.z));
    const faces = THREE.ShapeUtils.triangulateShape(contour, []);
    const coords: number[] = [];
    for (const f of faces) for (const i of f) coords.push(poly[i].x, poly[i].z);
    buf.inLayer('fill', () => buf.stamp(coords, y, color));
    return;
  }
  if (!m.noOutline) {
    // The edge of an area is drawn as an edge line.
    const w = Math.max(0.12, Math.min(m.width, LINE_W.edge));
    buf.inLayer('line', () => {
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % poly.length];
        buf.bar(p.x, y, p.z, q.x, y, q.z, w, color);
      }
    });
  }
  const width = Math.max(0.05, m.width);
  const defaults: Record<string, number> = { stripes: 45, hatch: 45, grid: 0, chevron: 0, triangle: 0 };
  const angle = m.fill === 'hatch' ? 45 : (m.angle ?? defaults[m.fill] ?? 0);
  const step = Math.max(width * 1.5, m.step ?? fillStyleInfo(m.fill).defaults.step ?? 1.6);
  // Inverted chevrons and triangles point the other way along the area.
  const f = areaFrame(poly, m.fill === 'hatch' || m.fill === 'stripes' || m.fill === 'grid' ? 0 : angle + (m.invert ? 180 : 0));
  const span = f.reach;
  const at = (a: number, b: number, fr = f): [number, number] => [fr.c.x + fr.ux * a + fr.vx * b, fr.c.z + fr.uz * a + fr.vz * b];
  buf.inLayer('fill', () => {
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
          if ([p0, p1, p2].every(([x, z]) => insidePolygon(x, z, poly))) coords.push(p0[0], p0[1], p1[0], p1[1], p2[0], p2[1]);
        }
      }
      buf.stamp(coords, y, color);
    }
  });
}

// ---------------------------------------------------------------------------
// Material and batches
// ---------------------------------------------------------------------------

const materials = new WeakMap<Shared, THREE.Material>();

/** The one paint material, shared by every paint layer of a scene. */
export function markingMaterial(shared: Shared): THREE.Material {
  let m = materials.get(shared);
  if (!m) {
    m = makePaintMaterial(shared, { bias: PAINT_MATERIAL.bias, lift: PAINT_MATERIAL.lift });
    materials.set(shared, m);
  }
  return m;
}

/** Render order of each paint layer. Everything placed by anyone sorts by layer only. */
export const PAINT_ORDER: Record<PaintLayerName, number> = { fill: 5, line: 5.25, bar: 5.5, symbol: 5.75 };

/** Four chunk batches, one per paint layer, keyed alike. */
export class PaintBatches {
  readonly group = new THREE.Group();
  private readonly layers: ChunkBatch[];

  constructor(material: THREE.Material, opts: { chunkSize?: number } = {}) {
    this.layers = PAINT_LAYER_NAMES.map((l) => new ChunkBatch(PAINT_SCHEMA, material, { renderOrder: PAINT_ORDER[l], receiveShadow: true, chunkSize: opts.chunkSize }));
    for (const b of this.layers) this.group.add(b.group);
  }

  /** Replace (or with null remove) a key's paint in every layer. */
  set(id: number, buf: PaintBuf | null): void {
    const pieces = buf ? buf.toLayerPieces() : [null, null, null, null];
    this.layers.forEach((b, i) => b.set(id, pieces[i]));
  }

  has(id: number): boolean {
    return this.layers.some((b) => b.has(id));
  }

  clear(): void {
    for (const b of this.layers) b.clear();
  }

  flush(): void {
    for (const b of this.layers) b.flush();
  }

  dispose(): void {
    for (const b of this.layers) b.dispose();
    this.group.clear();
  }
}
