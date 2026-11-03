/**
 * Road shapes from clicks. Pure functions: given the start, the optional control
 * point and the end, build the cubic that will be drawn, including its heights.
 */
import type { Cubic } from '../core/bezier';
import { cubicLength, cubicPoint, curvatureXZ } from '../core/bezier';
import { maxGrade } from '../core/geometry';
import { addScaled, clamp, distXZ, dotXZ, lerp, normalizeXZ, sub } from '../core/math';
import type { Vec3 } from '../core/types';

/** Slope at a free end, as a share of the mean grade. Below 1 eases in and out. */
const FREE_END_EASE = 0.5;
/** The slope carried over from the previous road never exceeds this share of the mean grade. */
const CARRY_LIMIT = 1.5;
const CARRY_MARGIN = 0.01;

export interface DraftEnds {
  start: Vec3;
  end: Vec3;
  /** Plan direction the road leaves the start, when it must continue something. */
  startDir?: Vec3 | null;
  /** Plan direction of travel on arriving at the end. */
  endDir?: Vec3 | null;
  /** Rise per metre of plan length carried over from the road before. */
  startSlope?: number | null;
  endSlope?: number | null;
}

/** Plan-view controls of a straight piece. */
function straightPlan(start: Vec3, end: Vec3): [Vec3, Vec3] {
  return [lerp(start, end, 1 / 3), lerp(start, end, 2 / 3)];
}

/** Controls of the circular arc leaving `start` along `dir` that reaches `end`. */
function arcFrom(start: Vec3, end: Vec3, dir: Vec3): { c1: Vec3; c2: Vec3; endDir: Vec3 } {
  const chord = distXZ(start, end);
  const c = normalizeXZ(sub(end, start), dir);
  const cos = clamp(dotXZ(dir, c), -1, 1);
  const theta = Math.acos(cos);
  const k = theta < 1e-4 ? 1 / 3 : (2 / 3) * (Math.tan(Math.min(theta, 2.4) / 2) / Math.sin(Math.min(theta, 2.4)));
  const h = chord * k;
  const endDir = normalizeXZ({ x: 2 * cos * c.x - dir.x, y: 0, z: 2 * cos * c.z - dir.z }, c);
  return { c1: addScaled(start, dir, h), c2: addScaled(end, endDir, -h), endDir };
}

/** Controls that meet both end directions. */
function hermite(start: Vec3, end: Vec3, startDir: Vec3, endDir: Vec3): [Vec3, Vec3] {
  const chord = distXZ(start, end);
  const c = normalizeXZ(sub(end, start), startDir);
  // Longer handles when the ends turn away from the chord, so the road sweeps round.
  const spread = (a: Vec3) => 1 / 3 / Math.max(0.35, (1 + dotXZ(a, c)) / 2);
  return [addScaled(start, startDir, chord * spread(startDir)), addScaled(end, endDir, -chord * spread(endDir))];
}

/** True when arriving along `dir` makes sense for this chord. */
export function usableEndDir(start: Vec3, end: Vec3, dir: Vec3 | null | undefined): dir is Vec3 {
  if (!dir) return false;
  return dotXZ(dir, normalizeXZ(sub(end, start))) > 0.1;
}

function planOf(mode: 'straight' | 'curved' | 'freeform', ends: DraftEnds, control: Vec3 | null): [Vec3, Vec3] {
  const { start, end } = ends;
  const startDir = ends.startDir ?? null;
  const endDir = usableEndDir(start, end, ends.endDir) ? ends.endDir : null;
  if (mode === 'curved' && control) {
    const c1 = lerp(start, control, 2 / 3);
    const c2 = lerp(end, control, 2 / 3);
    if (endDir) return [c1, addScaled(end, endDir, -distXZ(c2, end))];
    return [c1, c2];
  }
  if (mode === 'freeform') {
    if (startDir && endDir) return hermite(start, end, startDir, endDir);
    if (startDir) {
      const arc = arcFrom(start, end, startDir);
      return [arc.c1, arc.c2];
    }
    if (endDir) {
      // The same arc seen from the other end.
      const arc = arcFrom(end, start, { x: -endDir.x, y: 0, z: -endDir.z });
      return [arc.c2, arc.c1];
    }
  }
  return straightPlan(start, end);
}

/**
 * Give a plan-view curve its heights. Ends without a carried slope ease in, so
 * the grade changes smoothly and is steepest in the middle.
 */
export function withGrade(plan: Cubic, ends: Pick<DraftEnds, 'startSlope' | 'endSlope'>): Cubic {
  const { p0, p1, p2, p3 } = plan;
  const flat: Cubic = { p0: { ...p0, y: 0 }, p1: { ...p1, y: 0 }, p2: { ...p2, y: 0 }, p3: { ...p3, y: 0 } };
  const L = Math.max(cubicLength(flat, 24), 1e-6);
  const rise = p3.y - p0.y;
  const grade = rise / L;
  const limit = Math.abs(grade) * CARRY_LIMIT + CARRY_MARGIN;
  const s0 = ends.startSlope == null ? grade * FREE_END_EASE : clamp(ends.startSlope, -limit, limit);
  const s1 = ends.endSlope == null ? grade * FREE_END_EASE : clamp(ends.endSlope, -limit, limit);
  return {
    p0,
    p1: { x: p1.x, y: p0.y + s0 * distXZ(p0, p1), z: p1.z },
    p2: { x: p2.x, y: p3.y - s1 * distXZ(p2, p3), z: p2.z },
    p3,
  };
}

/** The cubic for one placement. */
export function buildCubic(mode: 'straight' | 'curved' | 'freeform', ends: DraftEnds, control: Vec3 | null): Cubic {
  const [c1, c2] = planOf(mode, ends, control);
  return withGrade({ p0: ends.start, p1: c1, p2: c2, p3: ends.end }, ends);
}

/** Tangent direction and slope at the far end, to carry into the next piece. */
export function endState(c: Cubic): { dir: Vec3; slope: number } {
  const plan = distXZ(c.p2, c.p3);
  if (plan > 1e-6) return { dir: normalizeXZ(sub(c.p3, c.p2)), slope: (c.p3.y - c.p2.y) / plan };
  return { dir: normalizeXZ(sub(c.p3, c.p0)), slope: 0 };
}

export interface DraftReadout {
  length: number;
  /** Tightest plan radius. Infinity when straight. */
  radius: number;
  /** Steepest grade along the curve, as a fraction. */
  grade: number;
}

export function readout(c: Cubic): DraftReadout {
  let kappa = 0;
  for (let i = 0; i <= 32; i++) kappa = Math.max(kappa, Math.abs(curvatureXZ(c, i / 32)));
  return { length: cubicLength(c, 48), radius: kappa > 1e-5 ? 1 / kappa : Infinity, grade: maxGrade(c) };
}

export function formatReadout(r: DraftReadout, angle: number | null): string[] {
  const lines = [`Length ${r.length.toFixed(1)} m`];
  lines.push(Number.isFinite(r.radius) ? `Radius ${r.radius.toFixed(0)} m` : 'Radius straight');
  lines.push(`Slope ${(r.grade * 100).toFixed(1)}%`);
  if (angle !== null) lines.push(`Angle ${Math.abs((angle * 180) / Math.PI).toFixed(1)}°`);
  return lines;
}

/** Sample a cubic, for marks that follow it. */
export function samplePoints(c: Cubic, n = 24): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) out.push(cubicPoint(c, i / n));
  return out;
}
