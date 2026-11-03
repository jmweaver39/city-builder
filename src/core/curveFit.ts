/**
 * Curve fitting for drawn roads.
 *
 * Real roads are laid out as straight tangents, circular arcs of constant radius
 * and clothoid spirals that ease curvature in and out between them. A single
 * cubic Bezier cannot do that past about 90 degrees: it bunches its bend near one
 * end and balloons at the other. This module fits such an alignment to what the
 * player asked for, then approximates it with a short chain of cubics, each
 * covering at most about 45 degrees, joined with matching tangent (G1) and
 * curvature (G2), within a few centimetres of the true alignment.
 *
 * Plan view only, apart from the vertical profile, which is one smooth Hermite
 * grade line over the whole chain. Conventions follow bezier.ts: plan curvature
 * is positive bending right (clockwise from above), and heading h has direction
 * (cos h, sin h) in (x, z), so a positive heading change is a right turn.
 */
import type { Vec3 } from './types';
import { closestPointOnCubic, cubicLength, cubicTangent, curvatureXZ, type Cubic } from './bezier';
import { clamp, distXZ, normalizeXZ, signedTurn, sub, wrapAngle } from './math';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Most turn one cubic of a chain may cover. */
export const MAX_PIECE_TURN = (45 * Math.PI) / 180;
/** Largest plan distance allowed between the chain and the true alignment. */
export const FIT_TOLERANCE = 0.03;
/** Pieces shorter than this are folded into a neighbour, so the chain has no slivers. */
export const MIN_PIECE_LENGTH = 6;
/** Most sweep a fitted curve may have. A full circle has nowhere to go. */
export const MAX_SWEEP = (350 * Math.PI) / 180;
/** Each easing spiral turns this share of the sweep... */
const SPIRAL_SHARE = 0.2;
/** ...up to this much. */
const MAX_SPIRAL_ANGLE = (15 * Math.PI) / 180;
/** Straight between the two halves of a reverse curve, as a share of the mean arc length. */
const REVERSE_TANGENT_SHARE = 0.1;
/** Slope at a free end, as a share of the mean grade, as in tools/draft.ts. */
const FREE_END_EASE = 0.5;
const CARRY_LIMIT = 1.5;
const CARRY_MARGIN = 0.01;

// ---------------------------------------------------------------------------
// Alignment: tangents, spirals and arcs
// ---------------------------------------------------------------------------

export type ElementKind = 'line' | 'spiral' | 'arc';

/** A stretch whose plan curvature changes linearly from k0 to k1 along its length. */
export interface AlignmentElement {
  kind: ElementKind;
  length: number;
  k0: number;
  k1: number;
}

export interface AlignmentState {
  s: number;
  x: number;
  z: number;
  /** Heading, radians. Direction (cos h, sin h). */
  h: number;
}

export interface Alignment {
  elements: AlignmentElement[];
  /** State at the start of each element, parallel to `elements`. */
  starts: AlignmentState[];
  length: number;
}

export interface AlignmentPoint extends AlignmentState {
  /** Signed plan curvature, positive bending right. */
  k: number;
}

// 5-point Gauss-Legendre.
const GL_X = [-0.906179845938664, -0.5384693101056831, 0, 0.5384693101056831, 0.906179845938664];
const GL_W = [0.2369268850561891, 0.4786286704993665, 0.5688888888888889, 0.4786286704993665, 0.2369268850561891];

/** State `u` metres into an element that starts at (x, z, h). */
function advance(x: number, z: number, h: number, el: AlignmentElement, u: number): { x: number; z: number; h: number } {
  if (u <= 0) return { x, z, h };
  const dk = el.length > 0 ? (el.k1 - el.k0) / el.length : 0;
  const k0 = el.k0;
  if (Math.abs(dk) < 1e-14) {
    if (Math.abs(k0) < 1e-10) return { x: x + Math.cos(h) * u, z: z + Math.sin(h) * u, h };
    const h1 = h + k0 * u;
    return { x: x + (Math.sin(h1) - Math.sin(h)) / k0, z: z + (Math.cos(h) - Math.cos(h1)) / k0, h: h1 };
  }
  const headingAt = (v: number) => h + k0 * v + 0.5 * dk * v * v;
  const turn = Math.abs(k0) * u + Math.abs(0.5 * dk * u * u);
  const m = Math.max(1, Math.ceil(turn / 0.08), Math.ceil(u / 40));
  const step = u / m;
  let sx = 0;
  let sz = 0;
  for (let i = 0; i < m; i++) {
    const a = i * step;
    for (let j = 0; j < 5; j++) {
      const v = a + (step * (GL_X[j] + 1)) / 2;
      const w = (GL_W[j] * step) / 2;
      const hv = headingAt(v);
      sx += w * Math.cos(hv);
      sz += w * Math.sin(hv);
    }
  }
  return { x: x + sx, z: z + sz, h: headingAt(u) };
}

/** Lay elements end to end from a start point and heading. Zero-length elements are dropped. */
export function buildAlignment(x0: number, z0: number, h0: number, elements: AlignmentElement[]): Alignment {
  const kept = elements.filter((e) => e.length > 1e-9);
  const starts: AlignmentState[] = [];
  let st = { x: x0, z: z0, h: h0 };
  let s = 0;
  for (const el of kept) {
    starts.push({ s, ...st });
    st = advance(st.x, st.z, st.h, el, el.length);
    s += el.length;
  }
  if (!kept.length) starts.push({ s: 0, x: x0, z: z0, h: h0 });
  return { elements: kept, starts, length: s };
}

function elementAt(al: Alignment, s: number): number {
  let i = 0;
  while (i + 1 < al.elements.length && al.starts[i + 1].s <= s) i++;
  return i;
}

/** Position, heading and curvature at arc length s, clamped to the alignment. */
export function alignmentPoint(al: Alignment, s: number): AlignmentPoint {
  const c = clamp(s, 0, al.length);
  if (!al.elements.length) return { ...al.starts[0], s: c, k: 0 };
  const i = elementAt(al, c);
  const el = al.elements[i];
  const st = al.starts[i];
  const u = clamp(c - st.s, 0, el.length);
  const p = advance(st.x, st.z, st.h, el, u);
  const k = el.length > 0 ? el.k0 + ((el.k1 - el.k0) * u) / el.length : el.k0;
  return { ...p, s: c, k };
}

export function alignmentEnd(al: Alignment): AlignmentPoint {
  return alignmentPoint(al, al.length);
}

/** Integral of |curvature| from 0 to u within one element. */
function absTurnIn(el: AlignmentElement, u: number): number {
  if (u <= 0 || el.length <= 0) return 0;
  const k0 = el.k0;
  const ku = el.k0 + ((el.k1 - el.k0) * u) / el.length;
  if (k0 * ku >= 0) return (u * (Math.abs(k0) + Math.abs(ku))) / 2;
  // Crosses zero: two triangles.
  return (u * (k0 * k0 + ku * ku)) / (2 * (Math.abs(k0) + Math.abs(ku)));
}

/** Total absolute turn from the start to s. */
export function absTurnTo(al: Alignment, s: number): number {
  let total = 0;
  for (let i = 0; i < al.elements.length; i++) {
    const el = al.elements[i];
    const st = al.starts[i].s;
    if (s <= st) break;
    total += absTurnIn(el, Math.min(el.length, s - st));
  }
  return total;
}

/** Largest |curvature| as a radius. Infinity for a straight alignment. */
export function alignmentMinRadius(al: Alignment): number {
  let k = 0;
  for (const el of al.elements) k = Math.max(k, Math.abs(el.k0), Math.abs(el.k1));
  return k > 1e-12 ? 1 / k : Infinity;
}

/** Signed total heading change, positive right. */
export function alignmentSweep(al: Alignment): number {
  let t = 0;
  for (const el of al.elements) t += ((el.k0 + el.k1) / 2) * el.length;
  return t;
}

// ---------------------------------------------------------------------------
// Curve shapes
// ---------------------------------------------------------------------------

/** Turn of each easing spiral for a curve sweeping A. */
export function spiralAngleFor(sweep: number, spirals = true): number {
  return spirals ? Math.min(SPIRAL_SHARE * Math.abs(sweep), MAX_SPIRAL_ANGLE) : 0;
}

/**
 * Spiral in, arc, spiral out, turning `sigma` (1 right, -1 left) through `sweep`
 * with arc radius R. Each spiral turns `thetaS`, so its length is 2 R thetaS.
 */
export function curveElements(sigma: 1 | -1, R: number, sweep: number, thetaS: number): AlignmentElement[] {
  const k = sigma / R;
  const ts = Math.min(thetaS, sweep / 2);
  if (ts <= 1e-9) return [{ kind: 'arc', length: R * sweep, k0: k, k1: k }];
  const ls = 2 * R * ts;
  const la = R * (sweep - 2 * ts);
  const out: AlignmentElement[] = [{ kind: 'spiral', length: ls, k0: 0, k1: k }];
  if (la > 1e-9) out.push({ kind: 'arc', length: la, k0: k, k1: k });
  out.push({ kind: 'spiral', length: ls, k0: k, k1: 0 });
  return out;
}

function scaleElements(els: AlignmentElement[], R: number): AlignmentElement[] {
  return els.map((e) => ({ kind: e.kind, length: e.length * R, k0: e.k0 / R, k1: e.k1 / R }));
}

/** End of a unit-scale shape laid from the origin heading +x. */
function unitEnd(els: AlignmentElement[]): AlignmentState {
  const al = buildAlignment(0, 0, 0, els);
  const e = alignmentEnd(al);
  return e;
}

// ---------------------------------------------------------------------------
// Local frames
// ---------------------------------------------------------------------------

interface Frame {
  x: number;
  z: number;
  h: number;
  cos: number;
  sin: number;
}

function frameOf(p: Vec3, dir: Vec3): Frame {
  const h = Math.atan2(dir.z, dir.x);
  return { x: p.x, z: p.z, h, cos: Math.cos(h), sin: Math.sin(h) };
}

/** World XZ vector into the frame: x along the heading, z to its right. */
function toLocal(f: Frame, dx: number, dz: number): { x: number; z: number } {
  return { x: dx * f.cos + dz * f.sin, z: -dx * f.sin + dz * f.cos };
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

export type FitKind = 'straight' | 'curve' | 'reverse' | 'loop';

export interface FitRequest {
  start: Vec3;
  /** Plan direction of travel leaving the start. */
  startDir?: Vec3 | null;
  end: Vec3;
  /** Plan direction of travel arriving at the end. */
  endDir?: Vec3 | null;
  /** Tangent intersection, as the Curved draw mode's middle click. Implies both directions. */
  control?: Vec3 | null;
  /** Rise per metre of plan length to keep at each end. Null eases in. */
  startSlope?: number | null;
  endSlope?: number | null;
  /** Hard minimum arc radius of the road. */
  minRadius?: number;
  /** Radius under which the result carries a warning. */
  comfortRadius?: number;
  /** Signed sweep wanted, to choose between a bend and a loop that meet the same ends. */
  sweepHint?: number;
  /** Ease curvature in and out with clothoids. Default true. */
  spirals?: boolean;
  maxPieceTurn?: number;
  tolerance?: number;
  minPieceLength?: number;
}

export interface ChainPiece {
  /** Arc length range of the alignment this cubic covers. */
  s0: number;
  s1: number;
  cubic: Cubic;
  /** Largest plan distance between this cubic and the alignment. */
  error: number;
}

export interface FitResult {
  /** False when the geometry breaks a rule. The geometry is still there to preview. */
  ok: boolean;
  /** Why it is not ok. */
  reason?: string;
  /** Advice, such as a radius under the comfortable one. */
  warning?: string;
  kind: FitKind;
  alignment: Alignment;
  pieces: ChainPiece[];
  cubics: Cubic[];
  /** Tightest arc radius. Infinity when straight. */
  radius: number;
  /** Signed total turn, radians, positive right. */
  sweep: number;
  /** Plan length. */
  length: number;
  /** Largest plan distance between the chain and the alignment. */
  error: number;
}

interface Candidate {
  kind: FitKind;
  elements: AlignmentElement[];
  radius: number;
  sweep: number;
}

const lineEl = (length: number): AlignmentElement => ({ kind: 'line', length, k0: 0, k1: 0 });

function sign(v: number): 1 | -1 {
  return v < 0 ? -1 : 1;
}

/**
 * A single curve between two fixed directions, with a straight on one side: the
 * end equation p = t0 d0 + R E + t1 d1 is linear in (t0, R, t1). One of t0, t1 is
 * zero, which gives the largest radius that fits.
 */
function singleCurve(end: { x: number; z: number }, sigma: 1 | -1, sweep: number, spirals: boolean): Candidate | null {
  if (sweep < 1e-6 || sweep > MAX_SWEEP + 1e-9) return null;
  const thetaS = spiralAngleFor(sweep, spirals);
  const unit = curveElements(sigma, 1, sweep, thetaS);
  const e = unitEnd(unit);
  // Local frame: start heading 0. End direction at local heading sigma * sweep.
  const ux = 1;
  const uz = 0;
  const wx = Math.cos(sigma * sweep);
  const wz = Math.sin(sigma * sweep);
  const solve = (ax: number, az: number): { t: number; R: number } | null => {
    // end = t a + R e
    const det = ax * e.z - az * e.x;
    if (Math.abs(det) < 1e-12) return null;
    const t = (end.x * e.z - end.z * e.x) / det;
    const R = (ax * end.z - az * end.x) / det;
    return { t, R };
  };
  let best: Candidate | null = null;
  const lead = solve(ux, uz);
  const options: { t0: number; t1: number; R: number }[] = [];
  if (lead) options.push({ t0: lead.t, t1: 0, R: lead.R });
  const trail = solve(wx, wz);
  if (trail) options.push({ t0: 0, t1: trail.t, R: trail.R });
  for (const o of options) {
    if (!(o.R > 1e-6) || o.t0 < -1e-6 || o.t1 < -1e-6) continue;
    // A bend takes the largest radius that fits. A loop could grow without limit on
    // ever longer straights, so it takes the compact one, with no straight on one side.
    if (best && (sweep > Math.PI ? best.radius <= o.R : best.radius >= o.R)) continue;
    const els = [lineEl(Math.max(0, o.t0)), ...scaleElements(unit, o.R), lineEl(Math.max(0, o.t1))];
    best = { kind: sweep > Math.PI ? 'loop' : 'curve', elements: els, radius: o.R, sweep: sigma * sweep };
  }
  return best;
}

/**
 * Roots of g over [lo, hi] found by scanning then bisecting, for shapes whose end
 * direction must match a chord. `g` returns an unwrapped angle difference.
 */
function scanRoots(g: (x: number) => number, lo: number, hi: number, steps: number): number[] {
  const roots: number[] = [];
  let px = lo;
  let pv = g(lo);
  for (let i = 1; i <= steps; i++) {
    const x = lo + ((hi - lo) * i) / steps;
    const v = g(x);
    if (Number.isFinite(pv) && Number.isFinite(v) && pv * v <= 0 && Math.abs(v - pv) < Math.PI) {
      let a = px;
      let b = x;
      let fa = pv;
      for (let k = 0; k < 60; k++) {
        const m = (a + b) / 2;
        const fm = g(m);
        if (fa * fm <= 0) b = m;
        else {
          a = m;
          fa = fm;
        }
      }
      roots.push((a + b) / 2);
    }
    px = x;
    pv = v;
  }
  return roots;
}

/** Spiral, arc, spiral leaving along the start direction and free to arrive any way. */
function curveFromStart(end: { x: number; z: number }, spirals: boolean): Candidate | null {
  const chord = Math.hypot(end.x, end.z);
  const phi = Math.atan2(end.z, end.x);
  const sigma = sign(phi);
  const aphi = Math.abs(phi);
  // Pure arc: sweep is twice the chord angle.
  if (!spirals || aphi < 1e-6) {
    const sweep = 2 * aphi;
    if (sweep > MAX_SWEEP) return null;
    const half = Math.sin(aphi);
    if (half < 1e-9) return null;
    const R = chord / (2 * half);
    return { kind: sweep > Math.PI ? 'loop' : 'curve', elements: curveElements(sigma, R, sweep, 0), radius: R, sweep: sigma * sweep };
  }
  const endAngle = (A: number) => {
    const e = unitEnd(curveElements(sigma, 1, A, spiralAngleFor(A, true)));
    return { angle: Math.atan2(e.z, e.x) * sigma, len: Math.hypot(e.x, e.z) };
  };
  // The end angle grows with the sweep. Track it unwrapped.
  let prevA = 1e-4;
  let prev = endAngle(prevA).angle;
  const steps = 175;
  for (let i = 1; i <= steps; i++) {
    const A = (MAX_SWEEP * i) / steps;
    let cur = endAngle(A).angle;
    while (cur < prev - Math.PI) cur += 2 * Math.PI;
    if ((prev - aphi) * (cur - aphi) <= 0) {
      let a = prevA;
      let b = A;
      const base = prev;
      const unwrap = (v: number) => {
        let w = v;
        while (w < base - Math.PI) w += 2 * Math.PI;
        return w;
      };
      for (let k = 0; k < 60; k++) {
        const m = (a + b) / 2;
        const fm = unwrap(endAngle(m).angle) - aphi;
        if (fm >= 0) b = m;
        else a = m;
      }
      const sweep = (a + b) / 2;
      const len = endAngle(sweep).len;
      if (len < 1e-9) return null;
      const R = chord / len;
      return {
        kind: sweep > Math.PI ? 'loop' : 'curve',
        elements: curveElements(sigma, R, sweep, spiralAngleFor(sweep, true)),
        radius: R,
        sweep: sigma * sweep,
      };
    }
    prevA = A;
    prev = cur;
  }
  return null;
}

/**
 * A reverse curve: one way, a short straight, then back the other way, with the
 * same radius on both halves. Turn `sigma` first; net turn `delta`.
 */
function reverseCurve(end: { x: number; z: number }, delta: number, sigma: 1 | -1, spirals: boolean): Candidate | null {
  const chord = Math.hypot(end.x, end.z);
  const phi = Math.atan2(end.z, end.x);
  const lo = Math.max(0, sigma * delta) + 1e-4;
  const hi = lo + Math.PI * 0.95;
  const shape = (a1: number): AlignmentElement[] => {
    const a2 = a1 - sigma * delta;
    const tangent = (REVERSE_TANGENT_SHARE * (a1 + a2)) / 2;
    return [
      ...curveElements(sigma, 1, a1, spiralAngleFor(a1, spirals)),
      lineEl(tangent),
      ...curveElements(sigma === 1 ? -1 : 1, 1, a2, spiralAngleFor(a2, spirals)),
    ];
  };
  const diff = (a1: number) => {
    const e = unitEnd(shape(a1));
    return wrapAngle(Math.atan2(e.z, e.x) - phi);
  };
  let best: Candidate | null = null;
  for (const a1 of scanRoots(diff, lo, hi, 120)) {
    if (Math.abs(diff(a1)) > 1e-6) continue;
    const e = unitEnd(shape(a1));
    const len = Math.hypot(e.x, e.z);
    if (len < 1e-9) continue;
    const R = chord / len;
    if (best && best.radius >= R) continue;
    best = { kind: 'reverse', elements: scaleElements(shape(a1), R), radius: R, sweep: delta };
  }
  return best;
}

function isStraightRequest(end: { x: number; z: number }): boolean {
  return end.x > 0 && Math.abs(end.z) < Math.max(0.005, end.x * 1e-5);
}

/** Candidates for a road leaving along d0 and arriving along d1. */
function bothDirCandidates(f: Frame, end: { x: number; z: number }, d1: Vec3, spirals: boolean): Candidate[] {
  const d1h = Math.atan2(d1.z, d1.x);
  const delta = wrapAngle(d1h - f.h);
  const out: Candidate[] = [];
  if (Math.abs(delta) < 1e-5) {
    if (isStraightRequest(end)) {
      out.push({ kind: 'straight', elements: [lineEl(end.x)], radius: Infinity, sweep: 0 });
      return out;
    }
  } else {
    const c = singleCurve(end, sign(delta), Math.abs(delta), spirals);
    if (c) out.push(c);
  }
  const reverses: Candidate[] = [];
  for (const sigma of [1, -1] as const) {
    const r = reverseCurve(end, delta, sigma, spirals);
    if (r) reverses.push(r);
  }
  // Of the two reverse curves, the gentler one first.
  reverses.sort((a, b) => b.radius - a.radius);
  out.push(...reverses);
  // The long way round, as a loop.
  const loopSweep = 2 * Math.PI - Math.abs(delta);
  const loop = singleCurve(end, delta > 0 ? -1 : 1, loopSweep, spirals);
  if (loop) out.push(loop);
  return out;
}

function choose(cands: Candidate[], req: FitRequest): Candidate | null {
  if (!cands.length) return null;
  if (req.sweepHint !== undefined) {
    let best = cands[0];
    for (const c of cands) if (Math.abs(c.sweep - req.sweepHint) < Math.abs(best.sweep - req.sweepHint) - 1e-6) best = c;
    return best;
  }
  const min = req.minRadius ?? 0;
  const fine = cands.find((c) => c.radius >= min);
  if (fine) return fine;
  return cands.reduce((a, b) => (b.radius > a.radius ? b : a));
}

/** The alignment for a request, before it is cut into cubics. */
function fitCandidate(req: FitRequest, spirals: boolean): { cand: Candidate | null; frame: Frame } {
  let start = req.start;
  let end = req.end;
  let d0 = req.startDir ? normalizeXZ(req.startDir) : null;
  let d1 = req.endDir ? normalizeXZ(req.endDir) : null;
  if (req.control) {
    const c = req.control;
    if (distXZ(c, start) > 1e-6) d0 = normalizeXZ(sub(c, start));
    if (!d1 && distXZ(end, c) > 1e-6) d1 = normalizeXZ(sub(end, c));
  }
  // Only an arrival direction: fit it backwards and turn it round.
  let reversed = false;
  if (!d0 && d1) {
    reversed = true;
    [start, end] = [end, start];
    d0 = { x: -d1.x, y: 0, z: -d1.z };
    d1 = null;
  }
  const chordDir = normalizeXZ(sub(end, start));
  const frame = frameOf(start, d0 ?? chordDir);
  const local = toLocal(frame, end.x - start.x, end.z - start.z);
  let cand: Candidate | null = null;
  if (!d0) {
    cand = { kind: 'straight', elements: [lineEl(Math.hypot(local.x, local.z))], radius: Infinity, sweep: 0 };
  } else if (d1) {
    const cands = bothDirCandidates(frame, local, d1, spirals);
    // A control point names a single bend.
    cand = choose(req.control ? cands.filter((c) => c.kind === 'curve' || c.kind === 'straight') : cands, req);
  } else if (isStraightRequest(local)) {
    cand = { kind: 'straight', elements: [lineEl(local.x)], radius: Infinity, sweep: 0 };
  } else {
    cand = curveFromStart(local, spirals);
  }
  if (reversed && cand) {
    // Fitted from the far end: drive it the other way from the true start.
    const e = alignmentEnd(buildAlignment(frame.x, frame.z, frame.h, cand.elements));
    const back = { x: Math.cos(e.h + Math.PI), y: 0, z: Math.sin(e.h + Math.PI) };
    return { cand: reverseCandidate(cand), frame: frameOf(req.start, back) };
  }
  return { cand, frame };
}

/** The same path driven the other way. */
function reverseCandidate(c: Candidate): Candidate {
  const els = [...c.elements].reverse().map((e) => ({ kind: e.kind, length: e.length, k0: -e.k1, k1: -e.k0 }));
  return { ...c, elements: els, sweep: -c.sweep };
}

/** Fit a smooth alignment to a request and cut it into cubics. */
export function fitCurve(req: FitRequest): FitResult {
  const spirals = req.spirals !== false;
  const min = req.minRadius ?? 0;
  let { cand, frame } = fitCandidate(req, spirals);
  // Spirals tighten the arc to make room for themselves. Without them the radius is larger.
  if (spirals && (!cand || cand.radius < min)) {
    const plain = fitCandidate(req, false);
    if (plain.cand && (!cand || plain.cand.radius > cand.radius)) ({ cand, frame } = plain);
  }
  const chord = distXZ(req.start, req.end);
  if (!cand) {
    const straight = buildAlignment(req.start.x, req.start.z, Math.atan2(req.end.z - req.start.z, req.end.x - req.start.x), [lineEl(chord)]);
    const reason =
      chord < 1e-3
        ? 'The road has no length.'
        : 'No smooth curve fits: the end is almost straight behind the start.';
    return finish(req, straight, 'straight', false, reason);
  }
  const al = buildAlignment(frame.x, frame.z, frame.h, cand.elements);
  let ok = true;
  let reason: string | undefined;
  if (cand.radius < min) {
    ok = false;
    reason = `Curve too tight: ${cand.radius.toFixed(1)} m radius is under this road's minimum of ${min.toFixed(1)} m.`;
  }
  let res = finish(req, al, cand.kind, ok, reason);
  // A gentle bend reads the same without spirals, and then one cubic will do.
  if (spirals && res.cubics.length > 1 && cand.kind === 'curve' && Math.abs(cand.sweep) <= (req.maxPieceTurn ?? MAX_PIECE_TURN)) {
    const plain = fitCandidate(req, false);
    if (plain.cand && plain.cand.radius >= min) {
      const alt = finish(req, buildAlignment(plain.frame.x, plain.frame.z, plain.frame.h, plain.cand.elements), plain.cand.kind, true);
      if (alt.cubics.length === 1) res = alt;
    }
  }
  if (res.ok && req.comfortRadius && res.radius < req.comfortRadius) {
    res.warning = `Tight: ${res.radius.toFixed(0)} m radius, ${req.comfortRadius.toFixed(0)} m advised for this road.`;
  }
  return res;
}

function finish(req: FitRequest, al: Alignment, kind: FitKind, ok: boolean, reason?: string): FitResult {
  const pieces = approximateAlignment(al, {
    maxTurn: req.maxPieceTurn ?? MAX_PIECE_TURN,
    tolerance: req.tolerance ?? FIT_TOLERANCE,
    minLength: req.minPieceLength ?? MIN_PIECE_LENGTH,
  });
  // The chain meets the requested ends exactly.
  if (pieces.length) {
    const first = pieces[0].cubic;
    const last = pieces[pieces.length - 1].cubic;
    shiftEnd(first, 'p0', req.start);
    shiftEnd(last, 'p3', req.end);
  }
  applyProfile(pieces, al.length, req);
  return {
    ok,
    reason,
    kind,
    alignment: al,
    pieces,
    cubics: pieces.map((p) => p.cubic),
    radius: alignmentMinRadius(al),
    sweep: alignmentSweep(al),
    length: al.length,
    error: pieces.reduce((m, p) => Math.max(m, p.error), 0),
  };
}

/** Move one end of a cubic onto a point, carrying its handle along. */
function shiftEnd(c: Cubic, which: 'p0' | 'p3', to: Vec3): void {
  const handle = which === 'p0' ? 'p1' : 'p2';
  const dx = to.x - c[which].x;
  const dz = to.z - c[which].z;
  c[which] = { x: to.x, y: c[which].y, z: to.z };
  c[handle] = { x: c[handle].x + dx, y: c[handle].y, z: c[handle].z + dz };
}

// ---------------------------------------------------------------------------
// Cubic approximation
// ---------------------------------------------------------------------------

export interface ApproxOptions {
  maxTurn: number;
  tolerance: number;
  minLength: number;
}

/** (2/3) tan(a/2) / sin(a): handle length per chord of a circular arc's cubic. */
function arcHandle(alpha: number): number {
  const a = Math.abs(alpha);
  if (a < 1e-6) return 1 / 3;
  return ((2 / 3) * Math.tan(a / 2)) / Math.sin(a);
}

/**
 * The cubic between two alignment points that matches position, tangent and
 * curvature at both ends, where such handles exist. Falls back to arc-like handles.
 */
export function hermiteG2(
  p0: { x: number; z: number; h: number; k: number },
  p3: { x: number; z: number; h: number; k: number },
): Cubic {
  const t0 = { x: Math.cos(p0.h), z: Math.sin(p0.h) };
  const t3 = { x: Math.cos(p3.h), z: Math.sin(p3.h) };
  const dx = p3.x - p0.x;
  const dz = p3.z - p0.z;
  const c = Math.hypot(dx, dz);
  const make = (a: number, b: number): Cubic => ({
    p0: { x: p0.x, y: 0, z: p0.z },
    p1: { x: p0.x + t0.x * a, y: 0, z: p0.z + t0.z * a },
    p2: { x: p3.x - t3.x * b, y: 0, z: p3.z - t3.z * b },
    p3: { x: p3.x, y: 0, z: p3.z },
  });
  if (c < 1e-9) return make(0, 0);
  const cross = (ax: number, az: number, bx: number, bz: number) => ax * bz - az * bx;
  const a0 = Math.atan2(cross(t0.x, t0.z, dx, dz), t0.x * dx + t0.z * dz);
  const a3 = Math.atan2(cross(dx, dz, t3.x, t3.z), dx * t3.x + dz * t3.z);
  let a = c * arcHandle(a0);
  let b = c * arcHandle(a3);
  const guess = { a, b };
  // k0 = (2/3)(cross(t0, D) - b X) / a^2, k3 = (2/3)(cross(D, t3) - a X) / b^2.
  const X = cross(t0.x, t0.z, t3.x, t3.z);
  const C0 = cross(t0.x, t0.z, dx, dz);
  const C3 = cross(dx, dz, t3.x, t3.z);
  let converged = false;
  for (let i = 0; i < 30; i++) {
    const f1 = a * a * p0.k - (2 / 3) * (C0 - b * X);
    const f2 = b * b * p3.k - (2 / 3) * (C3 - a * X);
    if (Math.abs(f1) + Math.abs(f2) < 1e-12 * Math.max(1, c * c)) {
      converged = true;
      break;
    }
    const j11 = 2 * a * p0.k;
    const j12 = (2 / 3) * X;
    const j21 = (2 / 3) * X;
    const j22 = 2 * b * p3.k;
    const det = j11 * j22 - j12 * j21;
    if (Math.abs(det) < 1e-14 * Math.max(1, c)) break;
    const da = (f1 * j22 - f2 * j12) / det;
    const db = (j11 * f2 - j21 * f1) / det;
    a -= da;
    b -= db;
    if (!(a > 0.02 * c && b > 0.02 * c && a < 1.2 * c && b < 1.2 * c)) break;
  }
  if (!converged || !(a > 0.02 * c && b > 0.02 * c && a < 1.2 * c && b < 1.2 * c)) return make(guess.a, guess.b);
  return make(a, b);
}

/** Largest plan distance from the alignment between s0 and s1 to the cubic, or Infinity if it strays. */
function fitError(al: Alignment, s0: number, s1: number, c: Cubic): number {
  const len = s1 - s0;
  const n = clamp(Math.ceil(len / 1.5), 12, 64);
  let worst = 0;
  for (let i = 0; i <= n; i++) {
    const q = alignmentPoint(al, s0 + (len * i) / n);
    const hit = closestPointOnCubic(c, { x: q.x, y: 0, z: q.z });
    worst = Math.max(worst, hit.distance);
  }
  // A cubic that loops or bulges past the ends shows as extra length.
  const cl = cubicLength(c, 64);
  if (Math.abs(cl - len) > Math.max(0.05, 0.003 * len)) worst = Math.max(worst, Math.abs(cl - len));
  return worst;
}

function fitPiece(al: Alignment, s0: number, s1: number): ChainPiece {
  const cubic = hermiteG2(alignmentPoint(al, s0), alignmentPoint(al, s1));
  return { s0, s1, cubic, error: fitError(al, s0, s1, cubic) };
}

/** True when the cubic's end curvatures match the alignment's, so joins stay G2. */
function curvatureMatches(al: Alignment, p: ChainPiece): boolean {
  const ok = (k: number, kc: number) => Math.abs(k - kc) <= 0.005 * Math.max(Math.abs(k), Math.abs(kc)) + 1e-6;
  return ok(alignmentPoint(al, p.s0).k, curvatureXZ(p.cubic, 0)) && ok(alignmentPoint(al, p.s1).k, curvatureXZ(p.cubic, 1));
}

/**
 * The cubic between two alignment points with the smallest error, keeping
 * position and tangent at both ends but not curvature. Pattern search on the two
 * handle lengths, from the G2 and arc-like handles.
 */
function fitPieceG1(al: Alignment, s0: number, s1: number): ChainPiece {
  const start = fitPiece(al, s0, s1);
  const c0 = start.cubic;
  const t0 = { x: Math.cos(alignmentPoint(al, s0).h), z: Math.sin(alignmentPoint(al, s0).h) };
  const t3 = { x: Math.cos(alignmentPoint(al, s1).h), z: Math.sin(alignmentPoint(al, s1).h) };
  const chord = distXZ(c0.p0, c0.p3);
  const make = (a: number, b: number): Cubic => ({
    p0: { ...c0.p0 },
    p1: { x: c0.p0.x + t0.x * a, y: 0, z: c0.p0.z + t0.z * a },
    p2: { x: c0.p3.x - t3.x * b, y: 0, z: c0.p3.z - t3.z * b },
    p3: { ...c0.p3 },
  });
  let a = distXZ(c0.p0, c0.p1);
  let b = distXZ(c0.p2, c0.p3);
  let best = start.error;
  let step = chord * 0.05;
  for (let it = 0; it < 60 && step > chord * 1e-5; it++) {
    let moved = false;
    for (const [da, db] of [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [-step, -step]]) {
      const na = a + da;
      const nb = b + db;
      if (na <= 0.02 * chord || nb <= 0.02 * chord) continue;
      const e = fitError(al, s0, s1, make(na, nb));
      if (e < best) {
        best = e;
        a = na;
        b = nb;
        moved = true;
        break;
      }
    }
    if (!moved) step /= 2;
  }
  return { s0, s1, cubic: make(a, b), error: best };
}

/** s where the absolute turn from the start reaches `target`. */
function sAtTurn(al: Alignment, target: number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  for (let i = 0; i < 60; i++) {
    const m = (a + b) / 2;
    if (absTurnTo(al, m) < target) a = m;
    else b = m;
  }
  return (a + b) / 2;
}

/**
 * Cut an alignment into as few cubics as keep each within `maxTurn` and
 * `tolerance`. Plan only: every y is 0.
 */
export function approximateAlignment(al: Alignment, opts: ApproxOptions): ChainPiece[] {
  const L = al.length;
  if (L < 1e-9) return [];
  const turnOf = (a: number, b: number) => absTurnTo(al, b) - absTurnTo(al, a);
  // A gentle bend is one cubic when one is close enough, even if only G1 at its ends.
  if (turnOf(0, L) <= opts.maxTurn + 1e-9) {
    const one = fitPiece(al, 0, L);
    if (one.error <= opts.tolerance) return [one];
    const g1 = fitPieceG1(al, 0, L);
    if (g1.error <= opts.tolerance) return [g1];
  }
  // Breaks at every element end, so each piece is one kind of curvature, and every
  // maxTurn through long arcs and spirals.
  const breaks = new Set<number>([0, L]);
  al.elements.forEach((el, i) => {
    const s0 = al.starts[i].s;
    const s1 = s0 + el.length;
    breaks.add(s0);
    breaks.add(s1);
    if (el.kind === 'line') return;
    const t0 = absTurnTo(al, s0);
    const turn = absTurnTo(al, s1) - t0;
    const n = Math.max(1, Math.ceil(turn / opts.maxTurn - 1e-9));
    for (let k = 1; k < n; k++) breaks.add(el.kind === 'arc' ? s0 + (el.length * k) / n : sAtTurn(al, t0 + (turn * k) / n, s0, s1));
  });
  const cuts = [...breaks].filter((s) => s >= 0 && s <= L).sort((a, b) => a - b);
  const spans: [number, number][] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    if (cuts[k + 1] - cuts[k] > 1e-6) spans.push([cuts[k], cuts[k + 1]]);
  }
  let pieces = spans.map(([a, b]) => fitPiece(al, a, b));
  // Anything over tolerance is halved until it fits.
  const refine = (p: ChainPiece, depth: number): ChainPiece[] => {
    if (p.error <= opts.tolerance || depth > 6 || p.s1 - p.s0 < 1) return [p];
    const m = (p.s0 + p.s1) / 2;
    return [...refine(fitPiece(al, p.s0, m), depth + 1), ...refine(fitPiece(al, m, p.s1), depth + 1)];
  };
  pieces = pieces.flatMap((p) => refine(p, 0));
  // Merge neighbours while the result still fits and still meets its neighbours G2.
  let merged = true;
  while (merged && pieces.length > 1) {
    merged = false;
    for (let k = 0; k + 1 < pieces.length; k++) {
      const a = pieces[k];
      const b = pieces[k + 1];
      if (turnOf(a.s0, b.s1) > opts.maxTurn + 1e-6) continue;
      const m = fitPiece(al, a.s0, b.s1);
      if (m.error > opts.tolerance || !curvatureMatches(al, m)) continue;
      pieces.splice(k, 2, m);
      merged = true;
      break;
    }
  }
  // Fold slivers into a neighbour when that stays close.
  let folded = true;
  while (folded && pieces.length > 1) {
    folded = false;
    for (let k = 0; k < pieces.length; k++) {
      const p = pieces[k];
      if (p.s1 - p.s0 >= opts.minLength) continue;
      const options: { at: number; piece: ChainPiece }[] = [];
      if (k > 0) options.push({ at: k - 1, piece: fitPiece(al, pieces[k - 1].s0, p.s1) });
      if (k + 1 < pieces.length) options.push({ at: k, piece: fitPiece(al, p.s0, pieces[k + 1].s1) });
      options.sort((x, y) => x.piece.error - y.piece.error);
      const best = options[0];
      if (!best || best.piece.error > Math.max(opts.tolerance * 4, 0.1)) continue;
      if (turnOf(best.piece.s0, best.piece.s1) > opts.maxTurn * 1.5) continue;
      pieces.splice(best.at, 2, best.piece);
      folded = true;
      break;
    }
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// Vertical profile
// ---------------------------------------------------------------------------

export interface Profile {
  y0: number;
  y1: number;
  /** Grade at each end, rise per metre of plan length. */
  m0: number;
  m1: number;
  length: number;
}

/** One smooth grade line from start to end. Free ends ease in at half the mean grade. */
export function makeProfile(y0: number, y1: number, length: number, startSlope?: number | null, endSlope?: number | null): Profile {
  const L = Math.max(length, 1e-6);
  const grade = (y1 - y0) / L;
  const limit = Math.abs(grade) * CARRY_LIMIT + CARRY_MARGIN;
  const m0 = startSlope == null ? grade * FREE_END_EASE : clamp(startSlope, -limit, limit);
  const m1 = endSlope == null ? grade * FREE_END_EASE : clamp(endSlope, -limit, limit);
  return { y0, y1, m0, m1, length: L };
}

/** Height and grade at plan distance s. */
export function profileAt(p: Profile, s: number): { y: number; grade: number } {
  const L = p.length;
  const u = clamp(s / L, 0, 1);
  const u2 = u * u;
  const u3 = u2 * u;
  const y = (2 * u3 - 3 * u2 + 1) * p.y0 + (u3 - 2 * u2 + u) * L * p.m0 + (-2 * u3 + 3 * u2) * p.y1 + (u3 - u2) * L * p.m1;
  const dy = (6 * u2 - 6 * u) * p.y0 + (3 * u2 - 4 * u + 1) * L * p.m0 + (-6 * u2 + 6 * u) * p.y1 + (3 * u2 - 2 * u) * L * p.m1;
  return { y, grade: dy / L };
}

/** Give every piece its heights from one profile, so the grade runs on unbroken across joins. */
export function applyProfile(pieces: ChainPiece[], length: number, req: Pick<FitRequest, 'start' | 'end' | 'startSlope' | 'endSlope'>): void {
  const prof = makeProfile(req.start.y, req.end.y, length, req.startSlope, req.endSlope);
  for (const p of pieces) {
    const a = profileAt(prof, p.s0);
    const b = profileAt(prof, p.s1);
    const c = p.cubic;
    const ha = distXZ(c.p0, c.p1);
    const hb = distXZ(c.p2, c.p3);
    c.p0 = { ...c.p0, y: a.y };
    c.p1 = { ...c.p1, y: a.y + a.grade * ha };
    c.p2 = { ...c.p2, y: b.y - b.grade * hb };
    c.p3 = { ...c.p3, y: b.y };
  }
  if (pieces.length) {
    pieces[0].cubic.p0.y = req.start.y;
    pieces[pieces.length - 1].cubic.p3.y = req.end.y;
  }
}

// ---------------------------------------------------------------------------
// Refitting an existing cubic
// ---------------------------------------------------------------------------

/** Signed total plan turn of a cubic, positive right. */
export function cubicSweep(c: Cubic, samples = 96): number {
  let total = 0;
  let prev = normalizeXZ(cubicTangent(c, 0));
  for (let i = 1; i <= samples; i++) {
    const t = normalizeXZ(cubicTangent(c, i / samples));
    total += signedTurn(prev, t);
    prev = t;
  }
  return total;
}

/** Ratio of the largest to the smallest plan curvature on a curved cubic: 1 is a perfect arc. */
export function curvatureSpread(c: Cubic, samples = 48): number {
  let lo = Infinity;
  let hi = 0;
  for (let i = 0; i <= samples; i++) {
    const k = Math.abs(curvatureXZ(c, i / samples));
    lo = Math.min(lo, k);
    hi = Math.max(hi, k);
  }
  return lo > 1e-12 ? hi / lo : Infinity;
}

/**
 * A fitted chain with the same ends, end directions and end grades as an
 * existing cubic, turning the same way round. For "Smooth curve".
 */
export function refitCubic(c: Cubic, opts: Omit<FitRequest, 'start' | 'end' | 'startDir' | 'endDir' | 'sweepHint' | 'control'> = {}): FitResult {
  const slopeAt = (from: Vec3, to: Vec3) => {
    const h = distXZ(from, to);
    return h > 1e-6 ? (to.y - from.y) / h : null;
  };
  const d0 = normalizeXZ(cubicTangent(c, 0));
  const d1 = normalizeXZ(cubicTangent(c, 1));
  return fitCurve({
    startSlope: slopeAt(c.p0, c.p1),
    endSlope: slopeAt(c.p2, c.p3),
    ...opts,
    start: c.p0,
    end: c.p3,
    startDir: d0,
    endDir: d1,
    sweepHint: cubicSweep(c),
  });
}
