/**
 * Cubic Bezier maths. Curves are 3D, but curvature, closest point and curve
 * intersection are measured in plan view (XZ) unless a name says otherwise,
 * because that is how roads relate to each other.
 */
import type { Vec3 } from './types';
import {
  EPS,
  addScaled,
  clamp,
  dist,
  distXZ,
  lerp,
  length,
  normalize,
  normalizeXZ,
  rightOf,
  segmentIntersectXZ,
  sub,
} from './math';

export interface Cubic {
  p0: Vec3;
  p1: Vec3;
  p2: Vec3;
  p3: Vec3;
}

export function makeCubic(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3): Cubic {
  return { p0, p1, p2, p3 };
}

/** A straight cubic with evenly spaced controls, so t is proportional to length. */
export function straightCubic(p0: Vec3, p3: Vec3): Cubic {
  return { p0, p1: lerp(p0, p3, 1 / 3), p2: lerp(p0, p3, 2 / 3), p3 };
}

export function cubicPoint(c: Cubic, t: number): Vec3 {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return {
    x: a * c.p0.x + b * c.p1.x + d * c.p2.x + e * c.p3.x,
    y: a * c.p0.y + b * c.p1.y + d * c.p2.y + e * c.p3.y,
    z: a * c.p0.z + b * c.p1.z + d * c.p2.z + e * c.p3.z,
  };
}

export function cubicDerivative(c: Cubic, t: number): Vec3 {
  const u = 1 - t;
  const a = 3 * u * u;
  const b = 6 * u * t;
  const d = 3 * t * t;
  return {
    x: a * (c.p1.x - c.p0.x) + b * (c.p2.x - c.p1.x) + d * (c.p3.x - c.p2.x),
    y: a * (c.p1.y - c.p0.y) + b * (c.p2.y - c.p1.y) + d * (c.p3.y - c.p2.y),
    z: a * (c.p1.z - c.p0.z) + b * (c.p2.z - c.p1.z) + d * (c.p3.z - c.p2.z),
  };
}

export function cubicSecondDerivative(c: Cubic, t: number): Vec3 {
  const u = 1 - t;
  return {
    x: 6 * (u * (c.p2.x - 2 * c.p1.x + c.p0.x) + t * (c.p3.x - 2 * c.p2.x + c.p1.x)),
    y: 6 * (u * (c.p2.y - 2 * c.p1.y + c.p0.y) + t * (c.p3.y - 2 * c.p2.y + c.p1.y)),
    z: 6 * (u * (c.p2.z - 2 * c.p1.z + c.p0.z) + t * (c.p3.z - 2 * c.p2.z + c.p1.z)),
  };
}

/**
 * Unit 3D tangent. Stays defined where the derivative vanishes, as it does at an
 * end whose control point sits on the end point.
 */
export function cubicTangent(c: Cubic, t: number): Vec3 {
  const d = cubicDerivative(c, t);
  if (length(d) > 1e-7) return normalize(d);
  const lo = cubicPoint(c, clamp(t - 1e-3, 0, 1));
  const hi = cubicPoint(c, clamp(t + 1e-3, 0, 1));
  const near = sub(hi, lo);
  if (length(near) > 1e-9) return normalize(near);
  return normalize(sub(c.p3, c.p0), { x: 1, y: 0, z: 0 });
}

/** Unit horizontal tangent, falling back to the chord for vertical tangents. */
export function cubicTangentXZ(c: Cubic, t: number): Vec3 {
  return normalizeXZ(cubicTangent(c, t), normalizeXZ(sub(c.p3, c.p0)));
}

/** Plan-view signed curvature in 1/m. Positive bends right (clockwise from above). */
export function curvatureXZ(c: Cubic, t: number): number {
  const d = cubicDerivative(c, t);
  const dd = cubicSecondDerivative(c, t);
  const speed2 = d.x * d.x + d.z * d.z;
  if (speed2 < EPS) return 0;
  return (d.x * dd.z - d.z * dd.x) / (speed2 * Math.sqrt(speed2));
}

// ---------------------------------------------------------------------------
// Arc length
// ---------------------------------------------------------------------------

/** Parallel arrays: ss[i] is the arc length at parameter ts[i]. */
export interface ArcTable {
  ts: Float64Array;
  ss: Float64Array;
  length: number;
}

export function arcLengthTable(c: Cubic, steps = 64): ArcTable {
  const n = Math.max(1, Math.floor(steps));
  const ts = new Float64Array(n + 1);
  const ss = new Float64Array(n + 1);
  let prev = c.p0;
  let s = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const p = cubicPoint(c, t);
    s += dist(prev, p);
    ts[i] = t;
    ss[i] = s;
    prev = p;
  }
  return { ts, ss, length: s };
}

export function cubicLength(c: Cubic, steps = 64): number {
  return arcLengthTable(c, steps).length;
}

/** Arc length at parameter t. */
export function lengthAtT(table: ArcTable, t: number): number {
  const n = table.ts.length - 1;
  const x = clamp(t, 0, 1) * n;
  const i = Math.min(Math.floor(x), n - 1);
  return table.ss[i] + (table.ss[i + 1] - table.ss[i]) * (x - i);
}

/** Parameter at arc length s. Clamped to the curve. */
export function tAtLength(table: ArcTable, s: number): number {
  if (s <= 0) return 0;
  if (s >= table.length) return 1;
  let lo = 0;
  let hi = table.ss.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table.ss[mid] <= s) lo = mid;
    else hi = mid;
  }
  const span = table.ss[hi] - table.ss[lo];
  const f = span > EPS ? (s - table.ss[lo]) / span : 0;
  return table.ts[lo] + (table.ts[hi] - table.ts[lo]) * f;
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/**
 * De Casteljau split at t. The two halves trace exactly the original curve and
 * share the object at the split point by value.
 */
export function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
  const q0 = lerp(c.p0, c.p1, t);
  const q1 = lerp(c.p1, c.p2, t);
  const q2 = lerp(c.p2, c.p3, t);
  const r0 = lerp(q0, q1, t);
  const r1 = lerp(q1, q2, t);
  const s = lerp(r0, r1, t);
  return [
    { p0: { ...c.p0 }, p1: q0, p2: r0, p3: { ...s } },
    { p0: { ...s }, p1: r1, p2: q2, p3: { ...c.p3 } },
  ];
}

/** The part of the curve between parameters t0 < t1. */
export function subCubic(c: Cubic, t0: number, t1: number): Cubic {
  if (t1 >= 1) return t0 <= 0 ? c : splitCubic(c, t0)[1];
  const left = splitCubic(c, t1)[0];
  if (t0 <= 0) return left;
  return splitCubic(left, t0 / t1)[1];
}

// ---------------------------------------------------------------------------
// Closest point
// ---------------------------------------------------------------------------

export interface ClosestPoint {
  t: number;
  point: Vec3;
  /** Distance from the query, plan view by default. */
  distance: number;
}

/** Closest point on the curve to p. `plan` (default) ignores height. */
export function closestPointOnCubic(c: Cubic, p: Vec3, plan = true): ClosestPoint {
  const measure = plan ? distXZ : dist;
  const samples = 24;
  let bestT = 0;
  let best = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const d = measure(cubicPoint(c, t), p);
    if (d < best) {
      best = d;
      bestT = t;
    }
  }
  // Newton on d/dt |B(t) - p|^2 = 0, keeping only steps that improve.
  let t = bestT;
  for (let i = 0; i < 6; i++) {
    const b = cubicPoint(c, t);
    const d1 = cubicDerivative(c, t);
    const d2 = cubicSecondDerivative(c, t);
    const rx = b.x - p.x;
    const ry = plan ? 0 : b.y - p.y;
    const rz = b.z - p.z;
    const dy1 = plan ? 0 : d1.y;
    const dy2 = plan ? 0 : d2.y;
    const f = rx * d1.x + ry * dy1 + rz * d1.z;
    const df = d1.x * d1.x + dy1 * dy1 + d1.z * d1.z + rx * d2.x + ry * dy2 + rz * d2.z;
    if (Math.abs(df) < EPS) break;
    const next = clamp(t - f / df, 0, 1);
    const nd = measure(cubicPoint(c, next), p);
    if (nd >= best) break;
    best = nd;
    t = next;
  }
  // A coarse scan can settle a little off when the best spot is a clamped end.
  for (const edge of [0, 1]) {
    const nd = measure(cubicPoint(c, edge), p);
    if (nd < best) {
      best = nd;
      t = edge;
    }
  }
  return { t, point: cubicPoint(c, t), distance: best };
}

// ---------------------------------------------------------------------------
// Curve-curve intersection in plan view
// ---------------------------------------------------------------------------

export interface CurveHit {
  /** Parameter on curve a. */
  ta: number;
  /** Parameter on curve b. */
  tb: number;
  /** Plan-view position. y is the height of curve a there. */
  point: Vec3;
}

function polyline(c: Cubic, n: number): { xs: Float64Array; zs: Float64Array } {
  const xs = new Float64Array(n + 1);
  const zs = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const p = cubicPoint(c, i / n);
    xs[i] = p.x;
    zs[i] = p.z;
  }
  return { xs, zs };
}

function controlLength(c: Cubic): number {
  return distXZ(c.p0, c.p1) + distXZ(c.p1, c.p2) + distXZ(c.p2, c.p3);
}

/** All plan-view crossings between two curves, ordered along curve a. */
export function intersectCubicsXZ(a: Cubic, b: Cubic): CurveHit[] {
  const na = clamp(Math.ceil(controlLength(a) / 5), 12, 160);
  const nb = clamp(Math.ceil(controlLength(b) / 5), 12, 160);
  const pa = polyline(a, na);
  const pb = polyline(b, nb);
  const hits: CurveHit[] = [];
  for (let i = 0; i < na; i++) {
    const ax = pa.xs[i];
    const az = pa.zs[i];
    const bx = pa.xs[i + 1];
    const bz = pa.zs[i + 1];
    const minX = Math.min(ax, bx);
    const maxX = Math.max(ax, bx);
    const minZ = Math.min(az, bz);
    const maxZ = Math.max(az, bz);
    for (let j = 0; j < nb; j++) {
      const cx = pb.xs[j];
      const cz = pb.zs[j];
      const dx = pb.xs[j + 1];
      const dz = pb.zs[j + 1];
      if ((cx < minX && dx < minX) || (cx > maxX && dx > maxX)) continue;
      if ((cz < minZ && dz < minZ) || (cz > maxZ && dz > maxZ)) continue;
      const r = segmentIntersectXZ(ax, az, bx, bz, cx, cz, dx, dz, 1e-7);
      if (!r) continue;
      const refined = refineHit(a, b, (i + r.u) / na, (j + r.v) / nb);
      const dup = hits.some(
        (h) => distXZ(h.point, refined.point) < 0.02 && Math.abs(h.tb - refined.tb) < 0.02,
      );
      if (!dup) hits.push(refined);
    }
  }
  hits.sort((p, q) => p.ta - q.ta);
  return hits;
}

/** Newton iterations on A(ta) = B(tb) in plan view. */
function refineHit(a: Cubic, b: Cubic, ta0: number, tb0: number): CurveHit {
  let ta = ta0;
  let tb = tb0;
  for (let i = 0; i < 6; i++) {
    const pa = cubicPoint(a, ta);
    const pb = cubicPoint(b, tb);
    const fx = pa.x - pb.x;
    const fz = pa.z - pb.z;
    if (Math.abs(fx) + Math.abs(fz) < 1e-7) break;
    const da = cubicDerivative(a, ta);
    const db = cubicDerivative(b, tb);
    const det = da.x * -db.z + db.x * da.z;
    if (Math.abs(det) < 1e-9) break;
    const dta = (fx * -db.z + db.x * fz) / det;
    const dtb = (da.x * fz - da.z * fx) / det;
    const nextA = ta - dta;
    const nextB = tb - dtb;
    if (Math.abs(nextA - ta0) > 0.2 || Math.abs(nextB - tb0) > 0.2) break;
    ta = clamp(nextA, 0, 1);
    tb = clamp(nextB, 0, 1);
  }
  return { ta, tb, point: cubicPoint(a, ta) };
}

// ---------------------------------------------------------------------------
// Offset sampling
// ---------------------------------------------------------------------------

/** Point at parameter t displaced `offset` metres to the right of travel. */
export function offsetPoint(c: Cubic, t: number, offset: number): Vec3 {
  return addScaled(cubicPoint(c, t), rightOf(cubicTangentXZ(c, t)), offset);
}

/** n + 1 samples of the offset curve, evenly spaced in t. */
export function offsetSamples(c: Cubic, offset: number, n = 32): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) out.push(offsetPoint(c, i / n, offset));
  return out;
}

/** Largest distance of the controls from the chord, plan and height together. */
export function isStraightCubic(c: Cubic, tolerance = 1e-3): boolean {
  const chord = sub(c.p3, c.p0);
  const l2 = chord.x * chord.x + chord.y * chord.y + chord.z * chord.z;
  if (l2 < EPS) return dist(c.p0, c.p1) < tolerance && dist(c.p3, c.p2) < tolerance;
  for (const p of [c.p1, c.p2]) {
    const r = sub(p, c.p0);
    const k = (r.x * chord.x + r.y * chord.y + r.z * chord.z) / l2;
    if (k < 0 || k > 1) return false;
    if (dist(p, addScaled(c.p0, chord, k)) > tolerance) return false;
  }
  return true;
}
