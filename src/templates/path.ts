/**
 * Plan-view paths and vertical profiles, the raw material of every template.
 *
 * A Path is a chain of straight lines and circular arcs, tangent at every joint,
 * in the XZ plane. It knows its length and can give a pose at any arc length, so
 * a ramp can start exactly on a mainline station. Headings follow core: radians,
 * atan2(z, x), increasing clockwise viewed from above, so a positive turn is a
 * right turn and (-sin h, cos h) is the right-hand normal.
 *
 * A Profile is the road's height as a function of arc length: a polyline of
 * (station, height) knots with parabolic vertical curves round each knot, the way
 * a real road is designed. Slope is continuous and never exceeds the steepest
 * polyline span.
 */
import type { Vec3 } from '../core';

export interface Pose {
  x: number;
  z: number;
  /** Heading in radians. */
  h: number;
}

export type TurnSign = 1 | -1;

interface LinePrim {
  kind: 'line';
  x0: number;
  z0: number;
  h: number;
  len: number;
}

interface ArcPrim {
  kind: 'arc';
  cx: number;
  cz: number;
  r: number;
  /** 1 turns right, -1 turns left. */
  sign: TurnSign;
  h0: number;
  sweep: number;
  len: number;
}

type Prim = LinePrim | ArcPrim;

/** One cubic of a path, in plan. */
export interface PlanPiece {
  s0: number;
  s1: number;
  p0: Vec3;
  p1: Vec3;
  p2: Vec3;
  p3: Vec3;
}

const TAU = Math.PI * 2;
/** Arcs are split into Beziers no longer than this. */
const MAX_BEZIER_SWEEP = Math.PI / 4;
/** Soft breaks closer than this to a kept break are dropped. Core refuses short roads. */
const MIN_PIECE = 26;

export const deg = (d: number): number => (d * Math.PI) / 180;

function wrap2Pi(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

export function poseAdvance(p: Pose, len: number): Pose {
  return { x: p.x + Math.cos(p.h) * len, z: p.z + Math.sin(p.h) * len, h: p.h };
}

export class Path {
  readonly prims: Prim[] = [];
  private readonly ends: number[] = [];
  private cursor: Pose;
  readonly start: Pose;

  constructor(start: Pose) {
    this.start = { ...start };
    this.cursor = { ...start };
  }

  get length(): number {
    return this.ends.length ? this.ends[this.ends.length - 1] : 0;
  }

  get end(): Pose {
    return { ...this.cursor };
  }

  private push(p: Prim): void {
    this.prims.push(p);
    this.ends.push(this.length + p.len);
  }

  line(len: number): this {
    if (len < 1e-6) return this;
    const c = this.cursor;
    this.push({ kind: 'line', x0: c.x, z0: c.z, h: c.h, len });
    this.cursor = poseAdvance(c, len);
    return this;
  }

  /** Turn by `sweep` radians. Sign 1 is a right turn. */
  arc(radius: number, sweep: number, sign: TurnSign): this {
    if (sweep < 1e-6) return this;
    const c = this.cursor;
    const cx = c.x - Math.sin(c.h) * sign * radius;
    const cz = c.z + Math.cos(c.h) * sign * radius;
    this.push({ kind: 'arc', cx, cz, r: radius, sign, h0: c.h, sweep, len: radius * sweep });
    const h = c.h + sign * sweep;
    this.cursor = { x: cx + Math.sin(h) * sign * radius, z: cz - Math.cos(h) * sign * radius, h };
    return this;
  }

  right(radius: number, sweep: number): this {
    return this.arc(radius, sweep, 1);
  }

  left(radius: number, sweep: number): this {
    return this.arc(radius, sweep, -1);
  }

  /**
   * Curve-line-curve to a target pose: arc of radius r1 turning s1, a tangent line,
   * then an arc of radius r2 turning s2 that lands on the target heading.
   * Throws when the circles are too close for that shape to exist.
   */
  curveTo(target: Pose, r1: number, s1: TurnSign, r2: number, s2: TurnSign): this {
    const fit = fitCsc(this.cursor, target, r1, s1, r2, s2);
    if (!fit) throw new RangeError('Curve does not fit between the two poses');
    this.arc(r1, fit.sweep1, s1);
    this.line(fit.line);
    this.arc(r2, fit.sweep2, s2);
    return this;
  }

  poseAt(s: number): Pose {
    const clamped = Math.min(Math.max(s, 0), this.length);
    let from = 0;
    for (let i = 0; i < this.prims.length; i++) {
      const to = this.ends[i];
      if (clamped <= to || i === this.prims.length - 1) return primPose(this.prims[i], clamped - from);
      from = to;
    }
    return { ...this.start };
  }

  /** Nearest station to a plan point, with its distance from the path. */
  project(x: number, z: number): { s: number; distance: number } {
    let best = { s: 0, distance: Infinity };
    let from = 0;
    for (let i = 0; i < this.prims.length; i++) {
      const p = this.prims[i];
      let u: number;
      if (p.kind === 'line') {
        u = (x - p.x0) * Math.cos(p.h) + (z - p.z0) * Math.sin(p.h);
      } else {
        const vx = x - p.cx;
        const vz = z - p.cz;
        const h = Math.atan2(p.sign * vx, -p.sign * vz);
        u = wrap2Pi(p.sign * (h - p.h0)) * p.r;
        if (u > p.len) u = u - p.len < TAU * p.r - u ? p.len : 0;
      }
      u = Math.min(Math.max(u, 0), p.len);
      const at = primPose(p, u);
      const d = Math.hypot(at.x - x, at.z - z);
      if (d < best.distance) best = { s: from + u, distance: d };
      from = this.ends[i];
    }
    return best;
  }

  /**
   * Stations where this path crosses another in plan, ordered along this path.
   * Sampled every metre or so, which is plenty for placing vertical knots.
   */
  crossings(other: Path, step = 2): { s: number; otherS: number }[] {
    const out: { s: number; otherS: number }[] = [];
    const n = Math.ceil(this.length / step);
    const m = Math.ceil(other.length / step);
    const a = samples(this, n);
    const b = samples(other, m);
    for (let i = 0; i < n; i++) {
      const ax = a[i * 2];
      const az = a[i * 2 + 1];
      const bx = a[i * 2 + 2];
      const bz = a[i * 2 + 3];
      const loX = Math.min(ax, bx) - 1e-9;
      const hiX = Math.max(ax, bx) + 1e-9;
      const loZ = Math.min(az, bz) - 1e-9;
      const hiZ = Math.max(az, bz) + 1e-9;
      for (let j = 0; j < m; j++) {
        const cx = b[j * 2];
        const cz = b[j * 2 + 1];
        const dx = b[j * 2 + 2];
        const dz = b[j * 2 + 3];
        if (Math.max(cx, dx) < loX || Math.min(cx, dx) > hiX) continue;
        if (Math.max(cz, dz) < loZ || Math.min(cz, dz) > hiZ) continue;
        const denom = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
        if (Math.abs(denom) < 1e-12) continue;
        const u = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / denom;
        const v = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / denom;
        if (u >= 0 && u < 1 && v >= 0 && v < 1) {
          out.push({ s: ((i + u) / n) * this.length, otherS: ((j + v) / m) * other.length });
        }
      }
    }
    out.sort((p, q) => p.s - q.s);
    return out;
  }

  /** Every station where one primitive gives way to the next. */
  joints(): number[] {
    return this.ends.slice(0, -1);
  }

  /**
   * The path as cubics, broken at `hard` stations (always) and `soft` stations
   * (when not too close to another break). Heights are added later.
   */
  pieces(hard: readonly number[], soft: readonly number[]): PlanPiece[] {
    const L = this.length;
    const hardStops = uniqueSorted([0, L, ...hard.filter((s) => s > 0.01 && s < L - 0.01)]);
    const softStops = [...soft, ...this.joints(), ...this.arcBreaks()];
    const stops: number[] = [];
    // Between two hard stops, keep soft stops that respect the minimum length.
    for (let i = 0; i + 1 < hardStops.length; i++) {
      const lo = hardStops[i];
      const hi = hardStops[i + 1];
      stops.push(lo);
      let last = lo;
      for (const s of uniqueSorted(softStops)) {
        if (s <= lo || s >= hi) continue;
        if (s - last < MIN_PIECE || hi - s < MIN_PIECE) continue;
        stops.push(s);
        last = s;
      }
    }
    stops.push(L);
    const out: PlanPiece[] = [];
    for (let i = 0; i + 1 < stops.length; i++) out.push(this.pieceBetween(stops[i], stops[i + 1]));
    return out;
  }

  private arcBreaks(): number[] {
    const out: number[] = [];
    let from = 0;
    for (let i = 0; i < this.prims.length; i++) {
      const p = this.prims[i];
      if (p.kind === 'arc') {
        const n = Math.ceil(p.sweep / MAX_BEZIER_SWEEP - 1e-9);
        for (let k = 1; k < n; k++) out.push(from + (p.len * k) / n);
      }
      from = this.ends[i];
    }
    return out;
  }

  private pieceBetween(s0: number, s1: number): PlanPiece {
    const a = this.poseAt(s0);
    const b = this.poseAt(s1);
    const span = s1 - s0;
    // One cubic is accurate for a line or a short arc. Handle length comes from
    // the turn, which matches the standard arc approximation exactly on an arc.
    const turn = Math.abs(wrapPi(b.h - a.h));
    const h = turn < 1e-6 ? span / 3 : (4 / 3) * Math.tan(turn / 4) * (span / turn);
    return {
      s0,
      s1,
      p0: { x: a.x, y: 0, z: a.z },
      p1: { x: a.x + Math.cos(a.h) * h, y: 0, z: a.z + Math.sin(a.h) * h },
      p2: { x: b.x - Math.cos(b.h) * h, y: 0, z: b.z - Math.sin(b.h) * h },
      p3: { x: b.x, y: 0, z: b.z },
    };
  }
}

function primPose(p: Prim, u: number): Pose {
  if (p.kind === 'line') {
    return { x: p.x0 + Math.cos(p.h) * u, z: p.z0 + Math.sin(p.h) * u, h: p.h };
  }
  const h = p.h0 + (p.sign * u) / p.r;
  return { x: p.cx + Math.sin(h) * p.sign * p.r, z: p.cz - Math.cos(h) * p.sign * p.r, h };
}

function samples(path: Path, n: number): Float64Array {
  const out = new Float64Array((n + 1) * 2);
  for (let i = 0; i <= n; i++) {
    const p = path.poseAt((i / n) * path.length);
    out[i * 2] = p.x;
    out[i * 2 + 1] = p.z;
  }
  return out;
}

function wrapPi(a: number): number {
  return wrap2Pi(a + Math.PI) - Math.PI;
}

function uniqueSorted(list: readonly number[]): number[] {
  const sorted = [...list].sort((a, b) => a - b);
  const out: number[] = [];
  for (const s of sorted) if (!out.length || s - out[out.length - 1] > 1e-6) out.push(s);
  return out;
}

export interface CscFit {
  sweep1: number;
  line: number;
  sweep2: number;
}

/** Solve a curve-line-curve between two poses, or null if none exists. */
export function fitCsc(a: Pose, b: Pose, r1: number, s1: TurnSign, r2: number, s2: TurnSign): CscFit | null {
  const c1x = a.x - Math.sin(a.h) * s1 * r1;
  const c1z = a.z + Math.cos(a.h) * s1 * r1;
  const c2x = b.x - Math.sin(b.h) * s2 * r2;
  const c2z = b.z + Math.cos(b.h) * s2 * r2;
  const dx = c2x - c1x;
  const dz = c2z - c1z;
  const d = Math.hypot(dx, dz);
  const k = s2 * r2 - s1 * r1;
  if (d < 1e-9 || Math.abs(k) > d) return null;
  const delta = Math.atan2(dz, dx);
  const off = Math.asin(k / d);
  const phi = delta - off;
  const line = d * Math.cos(off);
  const clean = (x: number) => (x > TAU - 1e-7 ? 0 : x);
  return {
    sweep1: clean(wrap2Pi(s1 * (phi - a.h))),
    line,
    sweep2: clean(wrap2Pi(s2 * (b.h - phi))),
  };
}

// ---------------------------------------------------------------------------
// Vertical profile
// ---------------------------------------------------------------------------

/** Default half-length of a vertical curve round a knot. */
export const VERTICAL_BLEND = 30;

export class Profile {
  private readonly ss: number[];
  private readonly ys: number[];
  private readonly grades: number[] = [];
  private readonly blends: number[];

  /** Knots are (station, height) pairs and must be in station order. */
  constructor(knots: readonly (readonly [number, number])[], blend = VERTICAL_BLEND) {
    const clean: [number, number][] = [];
    for (const [s, y] of knots) {
      const last = clean[clean.length - 1];
      if (last && s - last[0] < 1e-6) {
        last[1] = y;
        continue;
      }
      clean.push([s, y]);
    }
    this.ss = clean.map((k) => k[0]);
    this.ys = clean.map((k) => k[1]);
    for (let i = 0; i + 1 < clean.length; i++) {
      this.grades.push((this.ys[i + 1] - this.ys[i]) / (this.ss[i + 1] - this.ss[i]));
    }
    this.blends = this.ss.map((_, i) => {
      if (i === 0 || i === this.ss.length - 1) return 0;
      if (Math.abs(this.grades[i] - this.grades[i - 1]) < 1e-9) return 0;
      const room = Math.min(this.ss[i] - this.ss[i - 1], this.ss[i + 1] - this.ss[i]) * 0.45;
      return Math.min(blend, room);
    });
  }

  static flat(y: number): Profile {
    return new Profile([[0, y]]);
  }

  /** Height and slope at a station. */
  at(s: number): { y: number; slope: number } {
    const { ss, ys, grades, blends } = this;
    if (ss.length === 1) return { y: ys[0], slope: 0 };
    if (s <= ss[0]) return { y: ys[0], slope: 0 };
    const n = ss.length - 1;
    if (s >= ss[n]) return { y: ys[n], slope: 0 };
    let i = 0;
    while (i < n - 1 && s > ss[i + 1]) i++;
    // Inside the vertical curve round either end of this span?
    for (const k of [i, i + 1]) {
      const b = blends[k];
      if (b > 0 && Math.abs(s - ss[k]) < b) {
        const g0 = grades[k - 1];
        const g1 = grades[k];
        const u = s - (ss[k] - b);
        return {
          y: ys[k] - g0 * b + g0 * u + ((g1 - g0) * u * u) / (4 * b),
          slope: g0 + ((g1 - g0) * u) / (2 * b),
        };
      }
    }
    return { y: ys[i] + grades[i] * (s - ss[i]), slope: grades[i] };
  }

  /** Where the profile changes form. A cubic is exact between these. */
  breaks(): number[] {
    const out: number[] = [];
    this.ss.forEach((s, i) => {
      const b = this.blends[i];
      if (b > 0) out.push(s - b, s + b);
      else out.push(s);
    });
    return out;
  }

  /** Steepest grade along the profile. */
  maxGrade(): number {
    return this.grades.reduce((m, g) => Math.max(m, Math.abs(g)), 0);
  }
}
