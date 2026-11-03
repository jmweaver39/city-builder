/**
 * Junction layout: how arms are ordered around a node, how far each one is
 * trimmed back, and the NodeGeom outline. Everything is computed from the arms'
 * curves and road types, so it can be redone one node at a time.
 *
 * Order of work for a node:
 *   computeNodeLayout  raw trims, independent of anything at the far end of a road
 *   finalizeTrims      per segment, shrinks the two raw trims to fit the road
 *   buildNodeGeom      cut points and outline, once final trims are known
 */
import type { Id, NodeArm, NodeGeom, RoadTypeDef, SegmentGeom, Station, Vec3 } from './types';
import type { SegmentCurve } from './geometry';
import { cubicTangentXZ, cubicPoint } from './bezier';
import {
  addScaled,
  clamp,
  crossXZ,
  distXZ,
  dotXZ,
  headingOf,
  normalizeXZ,
  rightOf,
  scale,
  segmentIntersectXZ,
  signedTurn,
  sub,
  wrapAngle,
  wrapPositive,
} from './math';
import { lanesMirror, sidewalkOn, totalHalfWidth } from './roadTypes';
import { GRADE_CLEARANCE } from './terrain';
import type { JunctionShape } from './types';
import { applyShapeTrims, hasShape, shapeOutlineHooks } from './junctionShape';

/** Longest trim for one road end, per ARCHITECTURE.md. */
export const MAX_TRIM = 80;
/** Tangents within this of each other count as continuous at a plain joint. */
const PLAIN_MAX_ANGLE = (3 * Math.PI) / 180;
/** Grade change allowed across a plain joint. */
const PLAIN_MAX_SLOPE_STEP = 0.1;
/** Neighbouring arms this close to a straight line have nothing to clear. */
const STRAIGHT_THROUGH = Math.PI - 0.03;
/** Arms wider apart than this only taper between road widths. */
const WIDE_ANGLE = 2.6;
const MIN_TRIM = 1;

export interface ArmSource {
  segmentId: Id;
  /** True when the segment leaves this node at its a end. */
  atStart: boolean;
  curve: SegmentCurve;
  def: RoadTypeDef;
  /** Lanes by kind in index order, to tell apart overridden lanes. */
  laneSig: string;
}

export interface ArmLayout {
  source: ArmSource;
  segmentId: Id;
  atStart: boolean;
  /** Unit horizontal, pointing away from the node. */
  dir: Vec3;
  /** Clockwise sort key. Tangent heading nudged by where the arm goes next. */
  angle: number;
  /** Trim wanted by this node alone. */
  rawTrim: number;
  /** Right vector shared across a plain joint, in this segment's a-to-b sense. */
  jointRight: Vec3 | null;
}

export interface NodeLayout {
  nodeId: Id;
  kind: NodeGeom['kind'];
  /** Clockwise viewed from above. */
  arms: ArmLayout[];
}

// ---------------------------------------------------------------------------
// Walking road edges
// ---------------------------------------------------------------------------

interface EdgeLine {
  x: number[];
  y: number[];
  z: number[];
  /** Arc length along the centreline from the node, negative behind it. */
  s: number[];
}

/** Stations ordered outward from the node, with s measured from it. */
function forEachOutward(src: ArmSource, limit: number, visit: (st: Station, s: number) => void): void {
  const st = src.curve.stations;
  const L = src.curve.length;
  if (src.atStart) {
    for (let i = 0; i < st.length; i++) {
      visit(st[i], st[i].s);
      if (st[i].s >= limit) return;
    }
  } else {
    for (let i = st.length - 1; i >= 0; i--) {
      const s = L - st[i].s;
      visit(st[i], s);
      if (s >= limit) return;
    }
  }
}

/**
 * A road edge walked outward from the node. side 1 is the right edge looking
 * away from the node, -1 the left. The line starts `back` metres behind the node
 * and carries on straight past the end of a short road, so that a crossing is
 * still found when it lies outside the road itself.
 */
function edgeLine(arm: ArmLayout, side: 1 | -1, width: number, back: number, limit: number): EdgeLine {
  const src = arm.source;
  const lateral = side * (src.atStart ? 1 : -1) * width;
  const line: EdgeLine = { x: [], y: [], z: [], s: [] };
  let last: Station | null = null;
  let lastS = 0;
  forEachOutward(src, limit, (st, s) => {
    if (!last) {
      line.x.push(st.pos.x + st.right.x * lateral - arm.dir.x * back);
      line.y.push(st.pos.y);
      line.z.push(st.pos.z + st.right.z * lateral - arm.dir.z * back);
      line.s.push(-back);
    }
    line.x.push(st.pos.x + st.right.x * lateral);
    line.y.push(st.pos.y);
    line.z.push(st.pos.z + st.right.z * lateral);
    line.s.push(s);
    last = st;
    lastS = s;
  });
  if (last && lastS < limit) {
    const end = last as Station;
    const outward = normalizeXZ(end.tangent, arm.dir);
    const k = (limit - lastS) * (src.atStart ? 1 : -1);
    line.x.push(end.pos.x + end.right.x * lateral + outward.x * k);
    line.y.push(end.pos.y);
    line.z.push(end.pos.z + end.right.z * lateral + outward.z * k);
    line.s.push(limit);
  }
  return line;
}

/** The crossing of two edge lines furthest out from the node. */
function outermostCrossing(a: EdgeLine, b: EdgeLine): { sa: number; sb: number } | null {
  let best: { sa: number; sb: number } | null = null;
  let score = -Infinity;
  for (let i = 0; i + 1 < a.x.length; i++) {
    const ax = a.x[i];
    const az = a.z[i];
    const bx = a.x[i + 1];
    const bz = a.z[i + 1];
    for (let j = 0; j + 1 < b.x.length; j++) {
      const r = segmentIntersectXZ(ax, az, bx, bz, b.x[j], b.z[j], b.x[j + 1], b.z[j + 1]);
      if (!r) continue;
      const sa = a.s[i] + (a.s[i + 1] - a.s[i]) * r.u;
      const sb = b.s[j] + (b.s[j + 1] - b.s[j]) * r.v;
      if (sa + sb > score) {
        score = sa + sb;
        best = { sa, sb };
      }
    }
  }
  return best;
}

/** True when the far end of b's left edge is still left of a's right edge. */
function stillOverlappingAtEnd(a: EdgeLine, b: EdgeLine): boolean {
  const n = a.x.length - 1;
  const m = b.x.length - 1;
  const heading = { x: a.x[n] - a.x[n - 1], y: 0, z: a.z[n] - a.z[n - 1] };
  const toB = { x: b.x[m] - a.x[n], y: 0, z: b.z[m] - a.z[n] };
  return crossXZ(heading, toB) < 0;
}

function heightAt(line: EdgeLine, s: number): number {
  for (let i = 0; i + 1 < line.s.length; i++) {
    if (s <= line.s[i + 1]) {
      const span = line.s[i + 1] - line.s[i];
      const f = span > 1e-9 ? clamp((s - line.s[i]) / span, 0, 1) : 0;
      return line.y[i] + (line.y[i + 1] - line.y[i]) * f;
    }
  }
  return line.y[line.y.length - 1];
}

/**
 * Two arms overlapping in plan may already be stacked with clearance, as at a
 * multi-level node. Returns the distance out where that happens, or Infinity.
 */
function stackedFrom(a: EdgeLine, b: EdgeLine, upTo: number): number {
  for (let s = 5; s < upTo; s += 5) {
    if (Math.abs(heightAt(a, s) - heightAt(b, s)) >= GRADE_CLEARANCE) return s;
  }
  return Infinity;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function armDirection(src: ArmSource): Vec3 {
  const c = src.curve.cubic;
  const tan = cubicTangentXZ(c, src.atStart ? 0 : 1);
  return src.atStart ? tan : scale(tan, -1);
}

/** A heading that separates arms leaving a node on the same tangent. */
function sortAngle(src: ArmSource, dir: Vec3): number {
  const base = headingOf(dir);
  const L = src.curve.length;
  if (L < 1e-6) return base;
  const s = Math.min(L, 30);
  const t = src.atStart ? s / L : 1 - s / L;
  const c = src.curve.cubic;
  const from = cubicPoint(c, src.atStart ? 0 : 1);
  const to = cubicPoint(c, t);
  const chord = sub(to, from);
  const bend = wrapAngle(headingOf(chord) - base);
  return base + clamp(bend, -1, 1) * 0.02;
}

function isPlainJoint(a: ArmLayout, b: ArmLayout): boolean {
  const sa = a.source;
  const sb = b.source;
  if (sa.def.id !== sb.def.id || sa.laneSig !== sb.laneSig) return false;
  const headOn = sa.atStart === sb.atStart;
  if (headOn && !lanesMirror(sa.def)) return false;
  if (Math.abs(signedTurn(a.dir, scale(b.dir, -1))) > PLAIN_MAX_ANGLE) return false;
  // Compare the grade seen by something driving through.
  const grade = (src: ArmSource): number => {
    const c = src.curve.cubic;
    const d = src.atStart ? sub(c.p1, c.p0) : sub(c.p2, c.p3);
    const h = Math.sqrt(d.x * d.x + d.z * d.z);
    return h < 1e-6 ? 0 : d.y / h;
  };
  return Math.abs(grade(sa) + grade(sb)) <= PLAIN_MAX_SLOPE_STEP;
}

function setJointRights(a: ArmLayout, b: ArmLayout): void {
  const forward = (arm: ArmLayout) => (arm.atStart ? arm.dir : scale(arm.dir, -1));
  const ra = rightOf(forward(a));
  const rb = rightOf(forward(b));
  const flip = a.atStart === b.atStart ? -1 : 1;
  const sum = { x: ra.x + rb.x * flip, y: 0, z: ra.z + rb.z * flip };
  const mid = normalizeXZ(sum, ra);
  a.jointRight = mid;
  b.jointRight = flip === 1 ? { ...mid } : scale(mid, -1);
}

function cornerMargin(wa: number, wb: number): number {
  return clamp(1 + 0.25 * Math.min(wa, wb), 1.5, 3.5);
}

/**
 * Trim for two roads of different widths meeting end to end. Lanes shift sideways
 * by the difference in half width across the connectors, so the taper has to be
 * long enough to take that shift at the road's speed, or every lane through the
 * transition becomes a speed trap. Connector speed goes as the square root of
 * TURN_ACCEL over curvature, and an S bend across d in length L peaks at 6d / L^2.
 */
function widthTaper(a: RoadTypeDef, b: RoadTypeDef): number {
  const shift = Math.abs(a.halfWidth - b.halfWidth);
  if (shift < 1e-6) return 1.5;
  const speed = Math.min(a.speedKmh, b.speedKmh) / 3.6;
  return Math.max(1.5 + 2 * shift, (speed * Math.sqrt(2 * shift)) / 2);
}

/** Length per metre of sideways shift when an uneven road meets itself head on. */
const HEAD_ON_TAPER = 3;

/**
 * An uneven road joined head on: each side's lanes land where the other side's
 * opposing lanes are, so traffic must shift across. Give that S-bend room. Lateral
 * position is measured from each driver's side of the centreline, as in connectors.
 */
function headOnTaper(a: ArmLayout, b: ArmLayout): number {
  const sa = a.source;
  const sb = b.source;
  if (sa.def.id !== sb.def.id || sa.atStart !== sb.atStart) return 0;
  const lanes = sa.def.lanes;
  const arriving = lanes.filter((l) => l.dir === (sa.atStart ? -1 : 1)).map((l) => l.dir * l.offset);
  const leaving = lanes.filter((l) => l.dir === (sa.atStart ? 1 : -1)).map((l) => l.dir * l.offset);
  let shift = 0;
  for (const x of arriving) {
    let nearest = Infinity;
    for (const y of leaving) nearest = Math.min(nearest, Math.abs(x - y));
    if (Number.isFinite(nearest)) shift = Math.max(shift, nearest);
  }
  return shift * HEAD_ON_TAPER;
}

/** Lay out a node. Arms may arrive in any order. */
export function computeNodeLayout(nodeId: Id, sources: ArmSource[], shape?: JunctionShape): NodeLayout {
  const arms: ArmLayout[] = sources.map((source) => {
    const dir = armDirection(source);
    return {
      source,
      segmentId: source.segmentId,
      atStart: source.atStart,
      dir,
      angle: sortAngle(source, dir),
      rawTrim: 0,
      jointRight: null,
    };
  });
  arms.sort((a, b) => a.angle - b.angle || a.segmentId - b.segmentId);
  if (arms.length === 0) return { nodeId, kind: 'empty', arms };
  if (arms.length === 1) return { nodeId, kind: 'deadEnd', arms };
  if (arms.length === 2 && isPlainJoint(arms[0], arms[1])) {
    setJointRights(arms[0], arms[1]);
    return { nodeId, kind: 'plain', arms };
  }

  const n = arms.length;
  const widths = arms.map((a) => totalHalfWidth(a.source.def));
  const back = 2.5 * Math.max(...widths);
  const limit = MAX_TRIM + 1;
  const rightLines: (EdgeLine | undefined)[] = new Array(n);
  const leftLines: (EdgeLine | undefined)[] = new Array(n);
  const rightLine = (i: number) => (rightLines[i] ??= edgeLine(arms[i], 1, widths[i], back, limit));
  const leftLine = (i: number) => (leftLines[i] ??= edgeLine(arms[i], -1, widths[i], back, limit));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const theta = wrapPositive(arms[j].angle - arms[i].angle);
      if (theta >= STRAIGHT_THROUGH) continue;
      const a = rightLine(i);
      const b = leftLine(j);
      let hit = outermostCrossing(a, b);
      if (!hit) {
        if (theta > 1 || !stillOverlappingAtEnd(a, b)) continue;
        hit = { sa: MAX_TRIM, sb: MAX_TRIM };
      }
      let si = hit.sa;
      let sj = hit.sb;
      if (theta > WIDE_ANGLE) {
        const taper = 3 * Math.abs(widths[i] - widths[j]);
        si = Math.min(si, taper);
        sj = Math.min(sj, taper);
      }
      const stacked = stackedFrom(a, b, Math.max(si, sj));
      if (stacked < Infinity) {
        si = Math.min(si, stacked);
        sj = Math.min(sj, stacked);
      }
      const margin = cornerMargin(widths[i], widths[j]);
      arms[i].rawTrim = Math.max(arms[i].rawTrim, si + margin);
      arms[j].rawTrim = Math.max(arms[j].rawTrim, sj + margin);
    }
  }

  const taper = n === 2 ? Math.max(widthTaper(arms[0].source.def, arms[1].source.def), headOnTaper(arms[0], arms[1])) : MIN_TRIM;
  for (const arm of arms) arm.rawTrim = clamp(Math.max(arm.rawTrim, taper), 0, MAX_TRIM);
  // Junction shape: trim deltas and room for kerb radii. See junctionShape.ts.
  if (shape && hasShape(shape)) {
    const kerbMeet = (i: number, j: number, wi: number, wj: number) => outermostCrossing(edgeLine(arms[i], 1, wi, back, limit), edgeLine(arms[j], -1, wj, back, limit));
    applyShapeTrims(arms, shape, kerbMeet, MIN_TRIM, MAX_TRIM);
  }
  return { nodeId, kind: 'junction', arms };
}

/**
 * Fit the two raw trims of one road onto it. When they do not fit, both shrink
 * in proportion. Some road always remains unless the road itself has no length.
 */
export function finalizeTrims(fullLength: number, rawA: number, rawB: number): { trimA: number; trimB: number } {
  const keep = Math.min(1, fullLength * 0.2);
  const room = fullLength - keep;
  const wanted = rawA + rawB;
  if (wanted <= room) return { trimA: rawA, trimB: rawB };
  if (wanted <= 0 || room <= 0) return { trimA: 0, trimB: 0 };
  const k = room / wanted;
  return { trimA: rawA * k, trimB: rawB * k };
}

// ---------------------------------------------------------------------------
// Node geometry
// ---------------------------------------------------------------------------

function cutOf(arm: ArmLayout, geom: SegmentGeom | undefined, nodePos: Vec3): { centre: Vec3; cutDir: Vec3; trim: number; outRight: Vec3 } {
  const stations = geom?.stations;
  if (!stations || stations.length === 0) {
    return { centre: nodePos, cutDir: arm.dir, trim: 0, outRight: rightOf(arm.dir) };
  }
  const st = arm.atStart ? stations[0] : stations[stations.length - 1];
  const sign = arm.atStart ? 1 : -1;
  const cutDir = normalizeXZ(scale(st.tangent, sign), arm.dir);
  return {
    centre: st.pos,
    cutDir,
    trim: arm.atStart ? geom!.trimA : geom!.trimB,
    outRight: scale(st.right, sign),
  };
}

interface Corner {
  p: Vec3;
  dir: Vec3;
}

/**
 * Curve from one arm's edge to the next arm's edge, tangent to both. The edges
 * carry on inward from their cut points and, where they meet, that meeting point
 * is the control of a quadratic. At a gore this gives the long taper; at a street
 * corner, a rounded kerb.
 */
function cornerPoints(a: Corner, b: Corner, theta: number, nodePos: Vec3, out: Vec3[]): void {
  const chord = distXZ(a.p, b.p);
  const denom = crossXZ(a.dir, b.dir);
  const steps = 5;
  const reflex = theta > Math.PI;
  // Facing edges that have not cleared each other, as at a capped trim: each cut
  // point sits inside the other road, so there is no corner to round.
  const toB = sub(b.p, a.p);
  const overlapping = !reflex && (crossXZ(a.dir, toB) < -1e-6 || crossXZ(b.dir, toB) < -1e-6);
  if (overlapping) return;
  if (Math.abs(denom) > 0.01) {
    // Solve a.p - u a.dir = b.p - v b.dir.
    const dx = a.p.x - b.p.x;
    const dz = a.p.z - b.p.z;
    const u = (dx * b.dir.z - dz * b.dir.x) / denom;
    const v = (dx * a.dir.z - dz * a.dir.x) / denom;
    const reach = chord * 1.5 + 10;
    if (u > 1e-3 && v > 1e-3 && u < reach && v < reach) {
      const cx = a.p.x - a.dir.x * u;
      const cz = a.p.z - a.dir.z * u;
      const cy = (a.p.y + b.p.y) / 2;
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const m = 1 - t;
        out.push({
          x: m * m * a.p.x + 2 * m * t * cx + t * t * b.p.x,
          y: m * m * a.p.y + 2 * m * t * cy + t * t * b.p.y,
          z: m * m * a.p.z + 2 * m * t * cz + t * t * b.p.z,
        });
      }
      return;
    }
  }
  if (!reflex || dotXZ(a.dir, b.dir) < 0 || chord < 1e-6) return; // Straight chord.
  // Edges point the same way round the node, as on the outside of a hairpin.
  const h = Math.max(distXZ(a.p, nodePos), distXZ(b.p, nodePos)) * 1.3 + 1;
  const c1 = addScaled(a.p, a.dir, -h);
  const c2 = addScaled(b.p, b.dir, -h);
  const samples = 8;
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    const m = 1 - t;
    const w0 = m * m * m;
    const w1 = 3 * m * m * t;
    const w2 = 3 * m * t * t;
    const w3 = t * t * t;
    out.push({
      x: w0 * a.p.x + w1 * c1.x + w2 * c2.x + w3 * b.p.x,
      y: m * a.p.y + t * b.p.y,
      z: w0 * a.p.z + w1 * c1.z + w2 * c2.z + w3 * b.p.z,
    });
  }
}

/** True when a closed polygon crosses itself, in plan view. */
export function polygonSelfIntersects(poly: readonly Vec3[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = poly[j];
      const d = poly[(j + 1) % n];
      if (segmentIntersectXZ(a.x, a.z, b.x, b.z, c.x, c.z, d.x, d.z, -1e-9)) return true;
    }
  }
  return false;
}

/** Twice the signed plan area. Positive means clockwise viewed from above. */
function signedArea(poly: readonly Vec3[]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area;
}

function convexHull(points: readonly Vec3[]): Vec3[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  const turn = (o: Vec3, a: Vec3, b: Vec3) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: Vec3[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec3[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function buildOutline(
  arms: { centre: Vec3; cutDir: Vec3; outRight: Vec3; angle: number; trim: number }[],
  widths: number[],
  nodePos: Vec3,
  /** Widths on each side of an arm, where they differ from `widths`. */
  sides?: { left: number; right: number }[],
  /** Replaces a corner's points, given the automatic ones. From a junction shape. */
  corner?: (i: number, j: number, a: Corner, b: Corner, base: Vec3[]) => Vec3[] | null,
): { points: Vec3[]; simplified: boolean } {
  const n = arms.length;
  const lefts = arms.map((a, i) => addScaled(a.centre, a.outRight, sides?.[i].left ?? widths[i]));
  const rights = arms.map((a, i) => addScaled(a.centre, a.outRight, -(sides?.[i].right ?? widths[i])));
  // A cut point inside another arm's road is interior to the junction surface.
  // This is what a capped trim or a shrunken short road leaves behind.
  const buried = (p: Vec3, own: number): boolean => {
    for (let i = 0; i < n; i++) {
      if (i === own) continue;
      const rel = sub(p, arms[i].centre);
      const along = dotXZ(rel, arms[i].cutDir);
      const across = dotXZ(rel, arms[i].outRight);
      // A cut at an angle to this one pokes past it by up to width * sin(angle).
      const poke = widths[own] * Math.abs(crossXZ(arms[i].cutDir, arms[own].cutDir)) + 0.02;
      // Only the visible cut-to-node stretch counts, never the far side of the node.
      if (along <= poke && along >= -arms[i].trim && Math.abs(across) < widths[i] - 1e-6) return true;
    }
    return false;
  };
  const keepLeft = lefts.map((p, i) => !buried(p, i));
  const keepRight = rights.map((p, i) => !buried(p, i));
  // Two corner points inside each other's road: the wider road keeps its point.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (keepLeft[i] || keepRight[j]) continue;
    if (widths[i] >= widths[j]) keepLeft[i] = true;
    else keepRight[j] = true;
  }

  const raw: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (keepRight[i]) raw.push(rights[i]);
    if (keepLeft[i]) raw.push(lefts[i]);
    if (keepLeft[i] && keepRight[j]) {
      const theta = wrapPositive(arms[j].angle - arms[i].angle);
      const a = { p: lefts[i], dir: arms[i].cutDir };
      const b = { p: rights[j], dir: arms[j].cutDir };
      if (corner) {
        const base: Vec3[] = [];
        cornerPoints(a, b, theta, nodePos, base);
        raw.push(...(corner(i, j, a, b, base) ?? base));
      } else cornerPoints(a, b, theta, nodePos, raw);
    }
  }
  const clean: Vec3[] = [];
  for (const p of raw) {
    const last = clean[clean.length - 1];
    if (!last || distXZ(last, p) > 0.01) clean.push(p);
  }
  if (clean.length > 1 && distXZ(clean[0], clean[clean.length - 1]) <= 0.01) clean.pop();
  if (clean.length < 3 || polygonSelfIntersects(clean)) {
    const hull = convexHull(clean);
    return { points: signedArea(hull) < 0 ? hull.reverse() : hull, simplified: true };
  }
  return { points: signedArea(clean) < 0 ? clean.reverse() : clean, simplified: false };
}

/** Road edge to sidewalk edge on each side of an arm, as seen looking at the node. */
function outerWidths(arm: ArmLayout): { left: number; right: number } {
  const def = arm.source.def;
  const nearSide = arm.atStart ? 1 : -1;
  return { left: def.halfWidth + sidewalkOn(def, nearSide), right: def.halfWidth + sidewalkOn(def, nearSide === 1 ? -1 : 1) };
}

/** Cut points and outline for a node, once final trims are in `geomOf`. */
export function buildNodeGeom(layout: NodeLayout, nodePos: Vec3, geomOf: (id: Id) => SegmentGeom | undefined, shape?: JunctionShape): NodeGeom {
  const cuts = layout.arms.map((arm) => ({ ...cutOf(arm, geomOf(arm.segmentId), nodePos), angle: arm.angle }));
  const arms: NodeArm[] = layout.arms.map((arm, i) => {
    const cut = cuts[i];
    const w = arm.source.def.halfWidth;
    return {
      segmentId: arm.segmentId,
      atStart: arm.atStart,
      dir: arm.dir,
      leftEdge: addScaled(cut.centre, cut.outRight, w),
      rightEdge: addScaled(cut.centre, cut.outRight, -w),
      centre: cut.centre,
      cutDir: cut.cutDir,
      trim: cut.trim,
    };
  });
  const hasSurface = layout.kind === 'junction';
  // Junction shape: kerb radii, moved kerbs and corners without sidewalk. See junctionShape.ts.
  const hooks = hasSurface && shape && hasShape(shape) ? shapeOutlineHooks(layout.arms.map((a) => ({ segmentId: a.segmentId, atStart: a.atStart, def: a.source.def })), cuts, shape) : null;
  hooks?.kerbs.forEach((k, i) => {
    if (k?.left) arms[i].kerbLeft = k.left;
    if (k?.right) arms[i].kerbRight = k.right;
  });
  const widths = layout.arms.map((a) => a.source.def.halfWidth);
  const inner = hasSurface ? buildOutline(cuts, widths, nodePos, hooks?.innerSides, hooks?.innerCorner) : null;
  const outerSides = layout.arms.map((a) => outerWidths(a));
  const outer = hasSurface ? buildOutline(cuts, layout.arms.map((a) => totalHalfWidth(a.source.def)), nodePos, outerSides, hooks?.outerCorner) : null;
  return {
    nodeId: layout.nodeId,
    arms,
    outline: inner?.points ?? [],
    outerOutline: outer?.points ?? [],
    outlineSimplified: !!(inner?.simplified || outer?.simplified),
    isPlainJoint: layout.kind === 'plain',
    kind: layout.kind,
  };
}
