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
import { terrainHeight } from '../core/terrain';
import { LINE_WIDTH, PAINT_COL, ROAD_LIFT, hexRGB, strokesOf, type RGB } from './constants';

const CROSSWALK_DEPTH = 3;
const CROSSWALK_GAP = 0.5;
const STOP_WIDTH = 0.45;
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
  /** Arc length to keep lane lines back from the road end. */
  setback: number;
  node: Id;
  sign: string;
  controlled: boolean;
}

function planEnd(net: RoadNetwork, segId: Id, nodeId: Id, m: MarkingStyle): EndPlan {
  const g = net.nodeGeom(nodeId);
  const node = net.getNode(nodeId);
  const junction = g?.kind === 'junction' && g.arms.length >= 3;
  let crosswalk: CrosswalkStyle = 'none';
  let sign = 'none';
  let controlled = false;
  // Hidden automatic paint leaves the turn arrows, which belong to the lanes.
  if (junction && node && !node.control.hideAutoMarkings) {
    crosswalk = node.control.crosswalks[segId] ?? m.crosswalk;
    const ctl = effectiveControl(net, nodeId);
    sign = ctl.signs[segId] ?? 'none';
    controlled = ctl.kind !== 'none';
  }
  const stopBar = junction && controlled && m.stopLines && sign !== 'priority';
  let setback = 0;
  if (crosswalk !== 'none') setback = CROSSWALK_GAP + CROSSWALK_DEPTH + (stopBar ? STOP_GAP + STOP_WIDTH : 0.3);
  else if (stopBar) setback = 0.5 + STOP_WIDTH;
  return { junction: !!junction, crosswalk, setback, node: nodeId, sign, controlled };
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
): void {
  for (const k of strokesOf(style)) {
    const pts = path.line(s0, s1, offset + k.shift);
    buf.ribbon(pts, width, PAINT_COL[color], k.period, k.duty);
  }
}

function drawLines(buf: PaintBuf, path: StationPath, lanes: readonly LaneDef[], m: MarkingStyle, oneWay: boolean, medianKind: string, medianWidth: number, s0: number, s1: number, medianOffset = 0): void {
  const n = lanes.length;
  if (!n) return;
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
    if (physical && a.dir === b.dir) {
      drawBoundary(buf, path, s0, s1, edgeA - 0.16, m.edgeLine, m.edgeColor);
      drawBoundary(buf, path, s0, s1, edgeB + 0.16, m.edgeLine, m.edgeColor);
      continue;
    }
    if (a.dir !== b.dir) {
      if (physical) {
        drawBoundary(buf, path, s0, s1, edgeA - 0.16, m.edgeLine, m.edgeColor);
        drawBoundary(buf, path, s0, s1, edgeB + 0.16, m.edgeLine, m.edgeColor);
        continue;
      }
      if (oneWay) continue;
      const style = over?.style ?? m.centerLine;
      const color = over?.color ?? m.centerColor;
      if (medianKind === 'paint' && medianWidth > 0.4 && holdsMedian) {
        drawBoundary(buf, path, s0, s1, edgeA, style, color);
        drawBoundary(buf, path, s0, s1, edgeB, style, color);
      } else {
        drawBoundary(buf, path, s0, s1, mid, style, color);
      }
    } else {
      drawBoundary(buf, path, s0, s1, mid, over?.style ?? m.laneLine, over?.color ?? m.laneColor);
    }
  }
  const lo = lanes[0].offset - lanes[0].width / 2;
  const hi = lanes[n - 1].offset + lanes[n - 1].width / 2;
  drawBoundary(buf, path, s0, s1, lo + 0.18, m.edgeLine, m.edgeColor, LINE_WIDTH * 1.2);
  drawBoundary(buf, path, s0, s1, hi - 0.18, m.edgeLine, m.edgeColor, LINE_WIDTH * 1.2);
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

/** Paint at one end. end -1 is a (lanes dir -1 arrive), +1 is b (lanes dir 1 arrive). */
function drawEnd(buf: PaintBuf, net: RoadNetwork, segId: Id, path: StationPath, lanes: readonly LaneDef[], def: { halfWidth: number; sidewalk: number }, m: MarkingStyle, end: -1 | 1, plan: EndPlan): void {
  if (!plan.junction) return;
  const white = PAINT_COL.white;
  const cutS = end > 0 ? path.s1 : path.s0;
  const inward = -end; // Direction of increasing distance from the road end, in s.
  const incoming = lanes.map((l, i) => ({ l, i })).filter(({ l }) => l.dir === end);
  const lo = incoming.length ? Math.min(...incoming.map(({ l }) => l.offset - l.width / 2)) : 0;
  const hi = incoming.length ? Math.max(...incoming.map(({ l }) => l.offset + l.width / 2)) : 0;

  let lineS = cutS + inward * 0.5;
  if (plan.crosswalk !== 'none') {
    const centre = cutS + inward * (CROSSWALK_GAP + CROSSWALK_DEPTH / 2);
    const H = def.halfWidth;
    const a = path.at(centre, -H + 0.2);
    const b = path.at(centre, H - 0.2);
    paintCrosswalk(buf, { x: a.x, y: a.y, z: a.z }, { x: b.x, y: b.y, z: b.z }, CROSSWALK_DEPTH, plan.crosswalk, white);
    lineS = cutS + inward * (CROSSWALK_GAP + CROSSWALK_DEPTH + STOP_GAP);
  }
  if (incoming.length && plan.controlled) {
    const a = path.at(lineS, lo + 0.1);
    const b = path.at(lineS, hi - 0.1);
    if (plan.sign === 'yield') {
      // Travel direction from the right vector: t = (r.z, -r.x). Teeth point at the driver.
      const tx = b.rz * end;
      const tz = -b.rx * end;
      paintTeeth(buf, { x: a.x, y: a.y, z: a.z }, { x: b.x, y: b.y, z: b.z }, -tx, -tz, white);
    } else if (m.stopLines && plan.sign !== 'priority') {
      buf.bar(a.x, a.y, a.z, b.x, b.y, b.z, STOP_WIDTH, white);
    }
  }
  if (m.turnArrows) {
    const span = path.s1 - path.s0;
    if (span > 22) {
      const arrowS = lineS + inward * ARROW_BACK;
      for (const { l, i } of incoming) {
        if (l.kind === 'bike') continue;
        const turns = turnsOfLane(net, segId, i);
        if (!turns) continue;
        const p = path.at(arrowS, l.offset);
        const fx = p.rz * end;
        const fz = -p.rx * end;
        const shape = arrowShape(turns.has('left'), turns.has('straight'), turns.has('right'), turns.has('uturn'));
        buf.stamp(placeStamp(shape, p.x, p.z, fx, fz, 1), p.y, white);
      }
    }
  }
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
  const planA = planEnd(net, id, seg.a, m);
  const planB = planEnd(net, id, seg.b, m);
  const s0 = path.s0 + planA.setback;
  const s1 = path.s1 - planB.setback;
  drawLines(buf, path, lanes, m, oneWay, def.median.kind, def.median.width, s0, s1, def.median.offset ?? 0);
  drawEnd(buf, net, id, path, lanes, def, m, -1, planA);
  drawEnd(buf, net, id, path, lanes, def, m, 1, planB);
  paintLaneSymbols(buf, path, lanes, s0, s1);
}
