/**
 * Road paint, driven entirely by effectiveMarkings. Lines are ribbons along the
 * stations. Stop lines, crosswalks, arrows and yield triangles sit at lane ends.
 */
import type { CrosswalkStyle, Id, LaneDef, MarkingStyle, PaintColor, Station, TurnKind, Vec3 } from '../core/types';
import type { RoadNetwork } from '../core/RoadNetwork';
import { effectiveLanes, effectiveMarkings } from '../core/roadTypes';
import { effectiveControl } from '../core/signals';
import { PaintBuf, type LinePoint } from './batch';
import { paintLaneSymbols } from './laneSymbols';
import { isAutoOff } from '../core/autoMarkings';
import { isRampJunction, overlapClip } from './gore';
import { terrainHeight } from '../core/terrain';
import { LINE_WIDTH, PAINT_COL, ROAD_LIFT, hexRGB, strokesOf, type RGB } from './constants';

export const CROSSWALK_DEPTH = 3;
export const CROSSWALK_GAP = 0.5;
export const STOP_WIDTH = 0.45;
const STOP_GAP = 0.9;
const ARROW_BACK = 7.5;

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
    const out: LinePoint[] = [];
    if (s1 - s0 < 0.05) return out;
    out.push(this.at(s0, offset));
    for (const st of this.st) {
      if (st.s <= s0 + 0.01 || st.s >= s1 - 0.01) continue;
      const rx = st.right.x;
      const rz = st.right.z;
      out.push({ x: st.pos.x + rx * offset, y: st.pos.y + ROAD_LIFT, z: st.pos.z + rz * offset, rx, rz, u: st.s });
    }
    out.push(this.at(s1, offset));
    return out;
  }
}

// ---------------------------------------------------------------------------
// Arrow stamps. Local frame: +a is right of travel, +b is forward, metres.
// ---------------------------------------------------------------------------

function rect(a0: number, b0: number, a1: number, b1: number): number[] {
  return [a0, b0, a1, b0, a1, b1, a0, b0, a1, b1, a0, b1];
}

const HEAD_STRAIGHT = [-0.42, 0.9, 0.42, 0.9, 0, 2.5];
const STEM_T = 0.13;

/** Triangles for a set of moves, flat a, b pairs. */
export function arrowShape(left: boolean, straight: boolean, right: boolean, uturn: boolean): number[] {
  const out: number[] = [];
  const top = straight ? 0.9 : uturn ? 0.7 : -0.25;
  out.push(...rect(-STEM_T, -2.5, STEM_T, top));
  if (straight) out.push(...HEAD_STRAIGHT);
  const branch = (side: 1 | -1) => {
    out.push(...rect(side * STEM_T, -0.55, side * 0.7, -0.25));
    out.push(side * 0.7, -0.92, side * 0.7, 0.12, side * 1.7, -0.4);
  };
  if (left) branch(-1);
  if (right) branch(1);
  if (uturn) {
    out.push(...rect(-1.05, 0.42, STEM_T, 0.7));
    out.push(...rect(-1.05, -0.3, -0.79, 0.7));
    out.push(-1.34, -0.3, -0.5, -0.3, -0.92, -1.2);
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
// Crosswalks and bars, shared with decals.
// ---------------------------------------------------------------------------

export function paintCrosswalk(buf: PaintBuf, a: Vec3, b: Vec3, depth: number, style: CrosswalkStyle, color: RGB): void {
  if (style === 'none') return;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.1) return;
  // Along the line of travel, across the crossing.
  const rx = -dz / len;
  const rz = dx / len;
  const edge = (k: number, w: number) =>
    buf.bar(a.x + rx * k, a.y, a.z + rz * k, b.x + rx * k, b.y, b.z + rz * k, w, color);
  if (style === 'zebra' || style === 'ladder') {
    const inner = style === 'ladder' ? depth - 0.7 : depth;
    buf.bar(a.x, a.y, a.z, b.x, b.y, b.z, inner, color, 1.2, 0.5);
  }
  if (style === 'ladder' || style === 'lines') {
    edge(depth / 2 - 0.15, 0.3);
    edge(-depth / 2 + 0.15, 0.3);
  }
}

export function paintTeeth(buf: PaintBuf, a: Vec3, b: Vec3, pointX: number, pointZ: number, color: RGB, size = 1): void {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.1) return;
  const ux = dx / len;
  const uz = dz / len;
  const step = 1.05 * size;
  const count = Math.max(1, Math.floor(len / step));
  const pad = (len - count * step) / 2;
  const hb = 0.4 * size;
  const tall = 0.95 * size;
  const coords: number[] = [];
  for (let i = 0; i < count; i++) {
    const k = pad + (i + 0.5) * step;
    const cx = a.x + ux * k;
    const cz = a.z + uz * k;
    coords.push(cx - ux * hb, cz - uz * hb, cx + ux * hb, cz + uz * hb, cx + pointX * tall, cz + pointZ * tall);
  }
  buf.stamp(coords, a.y, color);
}

// ---------------------------------------------------------------------------
// Segment paint
// ---------------------------------------------------------------------------

interface EndPlan {
  /** Arm is at a junction with paint at this end. */
  junction: boolean;
  crosswalk: CrosswalkStyle;
  /** Arc length from the cut line to where lane lines stop. The same on every arm of a junction. */
  setback: number;
  node: Id;
  sign: string;
  controlled: boolean;
}

export const TEETH_DEPTH = 0.95;

interface ArmControl {
  crosswalk: CrosswalkStyle;
  sign: string;
  controlled: boolean;
  /** Depth of the bar or teeth this arm paints, 0 for none. */
  bar: number;
}

function armControl(net: RoadNetwork, segId: Id, nodeId: Id): ArmControl | null {
  const g = net.nodeGeom(nodeId);
  const node = net.getNode(nodeId);
  const seg = net.getSegment(segId);
  if (!g || !node || !seg || g.kind !== 'junction' || g.arms.length < 3) return null;
  // Hidden automatic paint leaves the turn arrows, which belong to the lanes.
  if (node.control.hideAutoMarkings) return { crosswalk: 'none', sign: 'none', controlled: false, bar: 0 };
  // Highway merges and diverges flow freely: no crossings, stop lines or teeth (gore.ts).
  if (isRampJunction(net, nodeId)) return { crosswalk: 'none', sign: 'none', controlled: false, bar: 0 };
  const m = effectiveMarkings(net.roadTypeOf(segId), seg.overrides);
  const crosswalk = node.control.crosswalks[segId] ?? m.crosswalk;
  const ctl = effectiveControl(net, nodeId);
  const sign = ctl.signs[segId] ?? 'none';
  const controlled = ctl.kind !== 'none';
  const bar = !controlled ? 0 : sign === 'yield' ? TEETH_DEPTH : m.stopLines && sign !== 'priority' ? STOP_WIDTH : 0;
  return { crosswalk, sign, controlled, bar };
}

/**
 * How far back from the cut line every arm of a junction stops its lane lines.
 * One value per junction, so stop lines and crosswalks line up across all arms.
 */
export function junctionSetback(net: RoadNetwork, nodeId: Id): number {
  const g = net.nodeGeom(nodeId);
  if (!g || g.kind !== 'junction' || g.arms.length < 3) return 0;
  let crosswalk = false;
  let bar = 0;
  for (const arm of g.arms) {
    const c = armControl(net, arm.segmentId, nodeId);
    if (!c) continue;
    if (c.crosswalk !== 'none') crosswalk = true;
    bar = Math.max(bar, c.bar);
  }
  if (!crosswalk && bar === 0) return 0;
  return (crosswalk ? CROSSWALK_GAP + CROSSWALK_DEPTH + STOP_GAP : 0.5) + bar;
}

function planEnd(net: RoadNetwork, segId: Id, nodeId: Id): EndPlan {
  const c = armControl(net, segId, nodeId);
  if (!c) return { junction: false, crosswalk: 'none', setback: 0, node: nodeId, sign: 'none', controlled: false };
  return { junction: true, crosswalk: c.crosswalk, setback: junctionSetback(net, nodeId), node: nodeId, sign: c.sign, controlled: c.controlled };
}

/**
 * Stretch a dash pattern to fit a run exactly, so a dash rather than a gap meets
 * each end. Returns the period to use, or 0 when the run is too short to dash.
 */
export function fitDashes(length: number, period: number, duty: number): number {
  const dash = period * duty;
  if (length < dash * 1.5) return 0;
  const n = Math.max(1, Math.round((length - dash) / period));
  return length / (n + duty);
}

function drawBoundary(
  buf: PaintBuf,
  path: StationPath,
  s0: number,
  s1: number,
  offset: number,
  style: MarkingStyle['laneLine'],
  color: PaintColor,
  width = LINE_WIDTH,
  rgb?: RGB,
): void {
  for (const k of strokesOf(style)) {
    const pts = path.line(s0, s1, offset + k.shift).map((p) => ({ ...p, u: p.u - s0 }));
    const period = k.period > 0 ? fitDashes(s1 - s0, k.period, k.duty) : 0;
    buf.ribbon(pts, width, rgb ?? PAINT_COL[color], period, period > 0 ? k.duty : 1);
  }
}

export interface BoundaryLine {
  offset: number;
  style: MarkingStyle['laneLine'];
  color: PaintColor;
  width: number;
  /** Overrides the paint colour, for the pale outline. */
  rgb?: RGB;
}

/** Pale outline along roads and junctions with no kerb, so every road reads as one shape. */
const OUTLINE = hexRGB(0xc9c9c4);
const OUTLINE_WIDTH = 0.16;

/** Every painted line along a road, as offsets from the centreline. */
export function boundaryLines(lanes: readonly LaneDef[], m: MarkingStyle, oneWay: boolean, medianKind: string, medianWidth: number, medianOffset = 0, outline = 0): BoundaryLine[] {
  const out: BoundaryLine[] = [];
  const add = (offset: number, style: MarkingStyle['laneLine'], color: PaintColor, width = LINE_WIDTH) => {
    if (style !== 'none') out.push({ offset, style, color, width });
  };
  const n = lanes.length;
  if (!n) {
    if (outline > 0) {
      out.push({ offset: -outline + 0.1, style: 'solid', color: 'white', width: OUTLINE_WIDTH, rgb: OUTLINE });
      out.push({ offset: outline - 0.1, style: 'solid', color: 'white', width: OUTLINE_WIDTH, rgb: OUTLINE });
    }
    return out;
  }
  const raised = medianKind === 'grass' || medianKind === 'barrier';
  for (let i = 0; i + 1 < n; i++) {
    const a = lanes[i];
    const b = lanes[i + 1];
    const edgeA = a.offset + a.width / 2;
    const edgeB = b.offset - b.width / 2;
    const mid = (edgeA + edgeB) / 2;
    const over = m.boundaries?.[i];
    // The median can sit anywhere in the strip, so it belongs to one gap only.
    const holdsMedian = medianOffset > edgeA - 0.01 && medianOffset < edgeB + 0.01 && medianWidth > 0;
    const physical = raised && holdsMedian;
    if (physical) {
      add(edgeA - 0.16, m.edgeLine, m.edgeColor);
      add(edgeB + 0.16, m.edgeLine, m.edgeColor);
      continue;
    }
    if (a.dir !== b.dir) {
      if (oneWay) continue;
      const style = over?.style ?? m.centerLine;
      const color = over?.color ?? m.centerColor;
      if (medianKind === 'paint' && medianWidth > 0.4 && holdsMedian) {
        add(edgeA, style, color);
        add(edgeB, style, color);
      } else {
        add(mid, style, color);
      }
    } else {
      add(mid, over?.style ?? m.laneLine, over?.color ?? m.laneColor);
    }
  }
  const lo = lanes[0].offset - lanes[0].width / 2;
  const hi = lanes[n - 1].offset + lanes[n - 1].width / 2;
  add(lo + 0.18, m.edgeLine, m.edgeColor, LINE_WIDTH * 1.2);
  add(hi - 0.18, m.edgeLine, m.edgeColor, LINE_WIDTH * 1.2);
  // Roads with no kerb get a pale outline at the very edge of the paving.
  if (outline > 0) {
    out.push({ offset: -outline + 0.1, style: 'solid', color: 'white', width: OUTLINE_WIDTH, rgb: OUTLINE });
    out.push({ offset: outline - 0.1, style: 'solid', color: 'white', width: OUTLINE_WIDTH, rgb: OUTLINE });
  }
  return out;
}

function drawLines(
  buf: PaintBuf,
  path: StationPath,
  lines: readonly BoundaryLine[],
  s0: number,
  s1: number,
  clip?: ((offset: number, s0: number, s1: number) => [number, number]) | null,
): void {
  for (const l of lines) {
    // Near a ramp junction a line may lie on another road; that stretch is left off.
    const [a, b] = clip ? clip(l.offset, s0, s1) : [s0, s1];
    if (b - a > 0.05) drawBoundary(buf, path, a, b, l.offset, l.style, l.color, l.width, l.rgb);
  }
}

function turnsOfLane(net: RoadNetwork, segId: Id, laneIndex: number): Set<TurnKind> | null {
  const graph = net.laneGraph;
  const idx = graph.roadLanes.get(segId)?.[laneIndex];
  if (idx === undefined || idx < 0) return null;
  const lane = graph.lanes[idx];
  const out = new Set<TurnKind>();
  for (const nx of lane.next) {
    const t = graph.lanes[nx]?.turn;
    if (t) out.add(t);
  }
  return out.size ? out : null;
}

export interface ArmEndLayout {
  /** Arc length of the cut line, where the road meets the junction surface. */
  cutS: number;
  setback: number;
  /** Where every lane line stops, at the setback. */
  lineEnds: Vec3[];
  /** Stop bar or teeth base, from the centre line or median edge to the kerb. */
  stop: { a: Vec3; b: Vec3; kind: 'bar' | 'teeth' } | null;
  crosswalk: { a: Vec3; b: Vec3; style: CrosswalkStyle } | null;
  /** Where turn arrows go, one per approaching lane. */
  arrows: { pos: Vec3; laneIndex: number }[];
}

/** Paint positions at one end of a segment. end -1 is a, +1 is b. Null away from junctions. */
export function armEndLayout(net: RoadNetwork, segId: Id, end: -1 | 1): ArmEndLayout | null {
  const seg = net.getSegment(segId);
  const geom = net.segmentGeom(segId);
  if (!seg || !geom || geom.stations.length < 2) return null;
  const plan = planEnd(net, segId, end > 0 ? seg.b : seg.a);
  if (!plan.junction) return null;
  const def = net.roadTypeOf(segId);
  const m = effectiveMarkings(def, seg.overrides);
  const lanes = effectiveLanes(def, seg.overrides);
  const path = new StationPath(geom.stations);
  const oneWay = lanes.every((l) => l.dir === 1);
  const cutS = end > 0 ? path.s1 : path.s0;
  const inward = -end;
  const at = (s: number, o: number): Vec3 => {
    const p = path.at(s, o);
    return { x: p.x, y: p.y, z: p.z };
  };
  const lineS = cutS + inward * plan.setback;
  const lines = boundaryLines(lanes, m, oneWay, def.median.kind, def.median.width, def.median.offset ?? 0);
  const lineEnds: Vec3[] = [];
  for (const l of lines) for (const k of strokesOf(l.style)) lineEnds.push(at(lineS, l.offset + k.shift));

  let crosswalk: ArmEndLayout['crosswalk'] = null;
  if (plan.crosswalk !== 'none') {
    const centre = cutS + inward * (CROSSWALK_GAP + CROSSWALK_DEPTH / 2);
    crosswalk = { a: at(centre, -def.halfWidth), b: at(centre, def.halfWidth), style: plan.crosswalk };
  }

  const incoming = lanes.map((l, i) => ({ l, i })).filter(({ l }) => l.dir === end);
  let stop: ArmEndLayout['stop'] = null;
  if (incoming.length && plan.controlled) {
    const lo = Math.min(...incoming.map(({ l }) => l.offset - l.width / 2));
    const hi = Math.max(...incoming.map(({ l }) => l.offset + l.width / 2));
    const opposing = lanes.filter((l) => l.dir !== end);
    // From the centre line (or median edge) on the inside to the kerb on the outside.
    let inner: number;
    let outer: number;
    if (!opposing.length) {
      inner = -def.halfWidth;
      outer = def.halfWidth;
    } else if (end > 0) {
      const oppHi = Math.max(...opposing.map((l) => l.offset + l.width / 2));
      const gapIsMedian = lo - oppHi > 0.4;
      inner = gapIsMedian ? lo : (lo + oppHi) / 2;
      outer = def.halfWidth;
    } else {
      const oppLo = Math.min(...opposing.map((l) => l.offset - l.width / 2));
      const gapIsMedian = oppLo - hi > 0.4;
      inner = gapIsMedian ? hi : (hi + oppLo) / 2;
      outer = -def.halfWidth;
    }
    const a = Math.min(inner, outer);
    const b = Math.max(inner, outer);
    if (plan.sign === 'yield') {
      const base = cutS + inward * (plan.setback - TEETH_DEPTH);
      stop = { a: at(base, a), b: at(base, b), kind: 'teeth' };
    } else if (m.stopLines && plan.sign !== 'priority') {
      const centre = cutS + inward * (plan.setback - STOP_WIDTH / 2);
      stop = { a: at(centre, a), b: at(centre, b), kind: 'bar' };
    }
  }
  const arrows: ArmEndLayout['arrows'] = [];
  if (m.turnArrows && path.s1 - path.s0 > 22 && !isRampJunction(net, plan.node)) {
    const arrowS = lineS + inward * ARROW_BACK;
    for (const { l, i } of incoming) if (l.kind !== 'bike') arrows.push({ pos: at(arrowS, l.offset), laneIndex: i });
  }
  // Single automatic markings the user took away (core/autoMarkings.ts).
  const ctl = net.getNode(plan.node)?.control;
  if (ctl?.autoOff) {
    if (stop && isAutoOff(ctl, { kind: 'stop', segmentId: segId })) stop = null;
    const kept = arrows.filter((a) => !isAutoOff(ctl, { kind: 'arrow', segmentId: segId, lane: a.laneIndex }));
    arrows.length = 0;
    arrows.push(...kept);
  }
  return { cutS, setback: plan.setback, lineEnds, stop, crosswalk, arrows };
}

/** Paint at one end. */
function drawEnd(buf: PaintBuf, net: RoadNetwork, segId: Id, path: StationPath, end: -1 | 1): void {
  const layout = armEndLayout(net, segId, end);
  if (!layout) return;
  const white = PAINT_COL.white;
  if (layout.crosswalk) paintCrosswalk(buf, layout.crosswalk.a, layout.crosswalk.b, CROSSWALK_DEPTH, layout.crosswalk.style, white);
  if (layout.stop) {
    const { a, b } = layout.stop;
    if (layout.stop.kind === 'teeth') {
      // Travel direction from the right vector: t = (r.z, -r.x). Teeth point at the driver.
      const p = path.at(layout.cutS, 0);
      paintTeeth(buf, a, b, -p.rz * end, p.rx * end, white);
    } else {
      buf.bar(a.x, a.y, a.z, b.x, b.y, b.z, STOP_WIDTH, white);
    }
  }
  for (const arrow of layout.arrows) {
    const turns = turnsOfLane(net, segId, arrow.laneIndex);
    if (!turns) continue;
    // Every arrow on an approach shares one station, so they line up across the lanes.
    const p = path.at(layout.cutS + -end * (layout.setback + ARROW_BACK), 0);
    const fx = p.rz * end;
    const fz = -p.rx * end;
    const shape = arrowShape(turns.has('left'), turns.has('straight'), turns.has('right'), turns.has('uturn'));
    buf.stamp(placeStamp(shape, arrow.pos.x, arrow.pos.z, fx, fz, 1), arrow.pos.y, white);
  }
}

// ---------------------------------------------------------------------------
// Guide lines through a junction
// ---------------------------------------------------------------------------

interface Track {
  pts: { x: number; y: number; z: number }[];
}

function connectorTrack(pts: Float32Array): Track {
  const out: Track['pts'] = [];
  for (let i = 0; i < pts.length; i += 3) out.push({ x: pts[i], y: pts[i + 1], z: pts[i + 2] });
  return { pts: out };
}

/** Resample to n points evenly by arc length. */
function resampleTrack(t: Track, n: number): Track['pts'] {
  const p = t.pts;
  const cum = [0];
  for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z));
  const total = cum[cum.length - 1] || 1;
  const out: Track['pts'] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const s = (total * i) / (n - 1);
    while (k + 2 < p.length && cum[k + 1] < s) k++;
    const f = Math.min(1, Math.max(0, (s - cum[k]) / Math.max(cum[k + 1] - cum[k], 1e-9)));
    out.push({ x: p[k].x + (p[k + 1].x - p[k].x) * f, y: p[k].y + (p[k + 1].y - p[k].y) * f, z: p[k].z + (p[k + 1].z - p[k].z) * f });
  }
  return out;
}

/**
 * Ribbon points along a track, shifted right of travel by `shift`. The ends take
 * the road's own direction, so a shifted end lands exactly on the cut line.
 */
function trackLine(p: Track['pts'], shift: number, startDir?: { x: number; z: number }, endDir?: { x: number; z: number }): LinePoint[] {
  const out: LinePoint[] = [];
  let u = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[Math.max(0, i - 1)];
    const b = p[Math.min(p.length - 1, i + 1)];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    if (i === 0 && startDir) {
      dx = startDir.x;
      dz = startDir.z;
    } else if (i === p.length - 1 && endDir) {
      dx = endDir.x;
      dz = endDir.z;
    }
    const l = Math.hypot(dx, dz) || 1;
    const rx = -dz / l;
    const rz = dx / l;
    if (i > 0) u += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
    out.push({ x: p[i].x + rx * shift, y: p[i].y + ROAD_LIFT, z: p[i].z + rz * shift, rx, rz, u });
  }
  return out;
}

/** Movements turning more than this get no guides: they are turns, not lines carried through. */
const MAX_GUIDE_TURN = (20 * Math.PI) / 180;

export interface GuideLine {
  pts: LinePoint[];
  color: RGB;
  /** Which guide this is, to take it away by itself: 'L' and 'R' edges, 'M0'... between lanes. */
  from: Id;
  to: Id;
  part: string;
}

/** The painted line, if any, at a lateral position on a road. */
function lineAt(net: RoadNetwork, segId: Id, offset: number): BoundaryLine | null {
  const seg = net.getSegment(segId);
  if (!seg) return null;
  const def = net.roadTypeOf(segId);
  const lanes = effectiveLanes(def, seg.overrides);
  const lines = boundaryLines(lanes, effectiveMarkings(def, seg.overrides), lanes.every((l) => l.dir === 1), def.median.kind, def.median.width, def.median.offset ?? 0);
  let best: BoundaryLine | null = null;
  for (const l of lines) if (Math.abs(l.offset - offset) < 0.5 && (!best || Math.abs(l.offset - offset) < Math.abs(best.offset - offset))) best = l;
  return best;
}

/**
 * Dashed guides that carry lane lines through a junction along the connectors, so
 * the lines on one arm meet the matching lines on the other where they would not
 * otherwise. Only near-straight movements get guides. Their edges continue where
 * the two roads' lines do not line up or the road type changes; the boundaries
 * between lanes continue only along the main road of a big junction.
 */
export function junctionGuides(net: RoadNetwork, nodeId: Id): GuideLine[] {
  const g = net.nodeGeom(nodeId);
  const node = net.getNode(nodeId);
  if (!g || !node || g.kind !== 'junction' || g.arms.length < 3 || node.control.hideAutoMarkings) return [];
  const graph = net.laneGraph;
  const ids = graph.connectorsAt.get(nodeId) ?? [];
  let span = 0;
  for (const a of g.arms) for (const b of g.arms) span = Math.max(span, Math.hypot(a.centre.x - b.centre.x, a.centre.z - b.centre.z));
  const maxRank = Math.max(...g.arms.map((a) => net.roadTypeOf(a.segmentId).rank));
  const groups = new Map<string, number[]>();
  for (const id of ids) {
    const c = graph.lanes[id];
    if (c.turn !== 'straight' || c.vehicleKind === 'bike') continue;
    const key = `${graph.lanes[c.fromLane].segmentId}>${graph.lanes[c.toLane].segmentId}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(id);
  }
  const out: GuideLine[] = [];
  // Travel direction where a road lane meets the junction: its last or first step.
  const endDir = (laneIdx: number, atEnd: boolean) => {
    const p = graph.lanes[laneIdx].pts;
    const n = p.length / 3;
    return atEnd ? { x: p[n * 3 - 3] - p[n * 3 - 6], z: p[n * 3 - 1] - p[n * 3 - 4] } : { x: p[3] - p[0], z: p[5] - p[2] };
  };
  const laneEdge = (laneIdx: number, side: -1 | 1) => {
    const lane = graph.lanes[laneIdx];
    const def = net.roadTypeOf(lane.segmentId);
    const seg = net.getSegment(lane.segmentId)!;
    const ld = effectiveLanes(def, seg.overrides)[lane.laneIndex];
    // Left or right of travel, in the segment's own offsets.
    return ld.offset + side * ld.dir * (ld.width / 2);
  };
  for (const list of groups.values()) {
    // Order across the movement, left to right of travel.
    const first = graph.lanes[list[0]].pts;
    const dx = first[3] - first[0];
    const dz = first[5] - first[2];
    const l = Math.hypot(dx, dz) || 1;
    const rx = -dz / l;
    const rz = dx / l;
    const lat = (id: number) => (graph.lanes[id].pts[0] - first[0]) * rx + (graph.lanes[id].pts[2] - first[2]) * rz;
    // A lane can fan out into several straight connectors, some changing lane on the way.
    // Keep the one per entering lane that holds its line best.
    const shift = (id: number) => {
      const p = graph.lanes[id].pts;
      const n = p.length / 3;
      return Math.abs((p[n * 3 - 3] - p[0]) * rx + (p[n * 3 - 1] - p[2]) * rz);
    };
    const best = new Map<number, number>();
    for (const id of list) {
      const from = graph.lanes[id].fromLane;
      const cur = best.get(from);
      if (cur === undefined || shift(id) < shift(cur)) best.set(from, id);
    }
    list.length = 0;
    list.push(...best.values());
    list.sort((p, q) => lat(p) - lat(q));
    const c0 = graph.lanes[list[0]];
    const fromSeg = graph.lanes[c0.fromLane].segmentId;
    const toSeg = graph.lanes[c0.toLane].segmentId;
    const typeChange = net.getSegment(fromSeg)?.roadType !== net.getSegment(toSeg)?.roadType;
    const din = endDir(c0.fromLane, true);
    const dout = endDir(c0.toLane, false);
    const turn = Math.abs(Math.atan2(din.x * dout.z - din.z * dout.x, din.x * dout.x + din.z * dout.z));
    if (turn > MAX_GUIDE_TURN) continue;
    const mainRoad = net.roadTypeOf(fromSeg).rank >= maxRank && net.roadTypeOf(toSeg).rank >= maxRank;
    const edge = (id: number, side: -1 | 1) => {
      const c = graph.lanes[id];
      const a = lineAt(net, graph.lanes[c.fromLane].segmentId, laneEdge(c.fromLane, side));
      const b = lineAt(net, graph.lanes[c.toLane].segmentId, laneEdge(c.toLane, side));
      if (!a || !b) return;
      // Where the line runs straight on into the next road, the gap reads as continuous.
      const pts = trackLine(resampleTrack(connectorTrack(c.pts), 24), (side * c.width) / 2, endDir(c.fromLane, true), endDir(c.toLane, false));
      const p0 = pts[0];
      const p1 = pts[pts.length - 1];
      const l0 = Math.hypot(din.x, din.z) || 1;
      const drift = Math.abs((din.x * (p1.z - p0.z) - din.z * (p1.x - p0.x)) / l0);
      if (!typeChange && drift < 0.3) return;
      out.push({ pts, color: PAINT_COL[a.color], from: fromSeg, to: toSeg, part: side < 0 ? 'L' : 'R' });
    };
    edge(list[0], -1);
    edge(list[list.length - 1], 1);
    if ((span > 40 && mainRoad) || typeChange) {
      for (let k = 0; k + 1 < list.length; k++) {
        const a = graph.lanes[list[k]];
        const b = graph.lanes[list[k + 1]];
        if (!lineAt(net, fromSeg, laneEdge(a.fromLane, 1))) continue;
        const pa = resampleTrack(connectorTrack(a.pts), 24);
        const pb = resampleTrack(connectorTrack(b.pts), 24);
        const mid = pa.map((p, i) => ({ x: (p.x + pb[i].x) / 2, y: (p.y + pb[i].y) / 2, z: (p.z + pb[i].z) / 2 }));
        out.push({ pts: trackLine(mid, 0, endDir(a.fromLane, true), endDir(a.toLane, false)), color: PAINT_COL.white, from: fromSeg, to: toSeg, part: `M${k}` });
      }
    }
  }
  if (!node.control.autoOff) return out;
  return out.filter((gl) => !isAutoOff(node.control, { kind: 'guide', from: gl.from, to: gl.to, part: gl.part }));
}

/**
 * The pale outline round a junction, along its corner curves, wherever the roads
 * either side have no kerb. Cut lines, where roads join, are left open.
 */
export function junctionOutline(net: RoadNetwork, nodeId: Id): LinePoint[][] {
  const g = net.nodeGeom(nodeId);
  if (!g || g.kind !== 'junction' || g.outline.length < 3) return [];
  const poly = g.outline;
  const n = poly.length;
  const near = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z) < 0.05;
  const armAt = (p: Vec3) => g.arms.find((a) => near(a.kerbLeft ?? a.leftEdge, p) || near(a.kerbRight ?? a.rightEdge, p));
  const kerbless = (segId: Id) => net.roadTypeOf(segId).category !== 'rail';
  const out: LinePoint[][] = [];
  let run: Vec3[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const pts: LinePoint[] = [];
      let u = 0;
      for (let i = 0; i < run.length; i++) {
        const a = run[Math.max(0, i - 1)];
        const b = run[Math.min(run.length - 1, i + 1)];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        // Clockwise outline: the inside is on the right. Sit the line just inside.
        const rx = -dz / l;
        const rz = dx / l;
        if (i > 0) u += Math.hypot(run[i].x - run[i - 1].x, run[i].z - run[i - 1].z);
        pts.push({ x: run[i].x + rx * 0.1, y: run[i].y + ROAD_LIFT, z: run[i].z + rz * 0.1, rx, rz, u });
      }
      out.push(pts);
    }
    run = [];
  };
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const armA = armAt(a);
    const armB = armAt(b);
    // An edge between the two cut points of one arm is where its road joins.
    const isCut = armA && armB && armA === armB;
    const corner = !isCut && (!armA || kerbless(armA.segmentId)) && (!armB || kerbless(armB.segmentId));
    if (!corner) {
      flush();
      continue;
    }
    if (!run.length) run.push(a);
    run.push(b);
  }
  flush();
  return out;
}

export function buildJunctionGuides(net: RoadNetwork, nodeId: Id, buf: PaintBuf): void {
  for (const g of junctionGuides(net, nodeId)) buf.ribbon(g.pts, 0.12, g.color, 1.5, 0.5);
  for (const pts of junctionOutline(net, nodeId)) buf.ribbon(pts, OUTLINE_WIDTH, OUTLINE, 0, 1);
}

const GRATE = hexRGB(0x101214);
const IRON = hexRGB(0x24262a);
const JOINT = hexRGB(0x16181b);
const EXPANSION_EVERY = 102;

/** Small dark marks that make a road feel made: gullies, manholes, deck joints. */
function drawFixtures(buf: PaintBuf, id: Id, path: StationPath, lanes: readonly LaneDef[], halfWidth: number, sidewalk: number, s0: number, s1: number): void {
  const hash = (n: number) => {
    const v = Math.sin(n * 12.9898 + id * 4.1) * 43758.5453;
    return v - Math.floor(v);
  };
  for (let k = Math.ceil(s0 / EXPANSION_EVERY); k * EXPANSION_EVERY < s1; k++) {
    const p = path.at(k * EXPANSION_EVERY, 0);
    if (p.y - ROAD_LIFT - terrainHeight(p.x, p.z) < 3) continue;
    const a = path.at(k * EXPANSION_EVERY, -halfWidth);
    const b = path.at(k * EXPANSION_EVERY, halfWidth);
    buf.bar(a.x, a.y, a.z, b.x, b.y, b.z, 0.32, JOINT);
  }
  if (sidewalk > 0) {
    // Gullies against the kerb, on alternating sides.
    let side = hash(1) < 0.5 ? 1 : -1;
    for (let s = s0 + 8 + hash(2) * 12; s < s1 - 6; s += 38 + hash(s) * 14) {
      side = -side;
      const c = path.at(s, side * (halfWidth - 0.26));
      const fx = c.rz;
      const fz = -c.rx;
      buf.stamp(placeStamp(rect(-0.2, -0.42, 0.2, 0.42), c.x, c.z, fx, fz, 1), c.y, IRON);
      for (let b = -0.32; b < 0.33; b += 0.106) {
        buf.stamp(placeStamp(rect(-0.16, b - 0.024, 0.16, b + 0.024), c.x, c.z, fx, fz, 1), c.y + 0.002, GRATE);
      }
    }
  }
  // Manhole covers in the lanes, off the wheel paths.
  const drive = lanes.filter((l) => l.kind === 'drive');
  if (drive.length) {
    for (let s = s0 + 14 + hash(3) * 40; s < s1 - 8; s += 62 + hash(s + 9) * 70) {
      const lane = drive[Math.floor(hash(s) * drive.length) % drive.length];
      const c = path.at(s, lane.offset);
      const disc = (r: number) => {
        const out: number[] = [];
        for (let i = 0; i < 12; i++) {
          const a0 = (i / 12) * Math.PI * 2;
          const a1 = ((i + 1) / 12) * Math.PI * 2;
          out.push(c.x, c.z, c.x + Math.cos(a0) * r, c.z + Math.sin(a0) * r, c.x + Math.cos(a1) * r, c.z + Math.sin(a1) * r);
        }
        return out;
      };
      buf.stamp(disc(0.42), c.y, JOINT);
      buf.stamp(disc(0.36), c.y + 0.002, IRON);
    }
  }
}

/** All paint of one segment. */
export function buildSegmentPaint(net: RoadNetwork, id: Id, buf: PaintBuf): void {
  const seg = net.getSegment(id);
  const geom = net.segmentGeom(id);
  if (!seg || !geom || geom.stations.length < 2) return;
  const def = net.roadTypeOf(id);
  const m = effectiveMarkings(def, seg.overrides);
  const lanes = effectiveLanes(def, seg.overrides);
  const path = new StationPath(geom.stations);
  const oneWay = lanes.every((l) => l.dir === 1);
  const s0 = path.s0 + planEnd(net, id, seg.a).setback;
  const s1 = path.s1 - planEnd(net, id, seg.b).setback;
  drawLines(buf, path, boundaryLines(lanes, m, oneWay, def.median.kind, def.median.width, def.median.offset ?? 0), s0, s1, overlapClip(net, id));
  if (def.category !== 'rail') {
    const edges = boundaryLines([], m, oneWay, 'none', 0, 0, def.halfWidth);
    drawLines(buf, path, edges, path.s0, path.s1, overlapClip(net, id));
  }
  drawEnd(buf, net, id, path, -1);
  drawEnd(buf, net, id, path, 1);
  paintLaneSymbols(buf, path, lanes, s0, s1);
}
