/**
 * Concrete pier parts in one family: tapered round or rounded-rectangle columns
 * with a darker foot, hammerhead and portal cap beams with rounded ends and a
 * sloped underside, and footing pads. Everything is written into a SurfBuf with
 * smooth normals; quads pick their winding from the normal, so callers never
 * have to.
 */
import type { SurfBuf, SurfStyle } from './batch';

type P3 = readonly [number, number, number];

/** One quad with per-vertex normals and styles, wound to face its normals. */
export function quadAuto(buf: SurfBuf, p: readonly P3[], n: readonly P3[], s: SurfStyle | readonly SurfStyle[]): void {
  const st = (i: number) => (Array.isArray(s) ? (s as SurfStyle[])[i] : (s as SurfStyle));
  // Diagonals' cross product: the face normal for the order 0, 1, 2, 3.
  const ax = p[2][0] - p[0][0];
  const ay = p[2][1] - p[0][1];
  const az = p[2][2] - p[0][2];
  const bx = p[3][0] - p[1][0];
  const by = p[3][1] - p[1][1];
  const bz = p[3][2] - p[1][2];
  const fx = ay * bz - az * by;
  const fy = az * bx - ax * bz;
  const fz = ax * by - ay * bx;
  const mx = n[0][0] + n[1][0] + n[2][0] + n[3][0];
  const my = n[0][1] + n[1][1] + n[2][1] + n[3][1];
  const mz = n[0][2] + n[1][2] + n[2][2] + n[3][2];
  const v = [0, 1, 2, 3].map((i) => buf.vert(p[i][0], p[i][1], p[i][2], n[i][0], n[i][1], n[i][2], st(i)));
  if (fx * mx + fy * my + fz * mz >= 0) buf.quad(v[0], v[1], v[2], v[3]);
  else buf.quad(v[0], v[3], v[2], v[1]);
}

/** Points round a rounded rectangle (a stadium): straight half length e along (ax, az), radius r. */
function stadium(e: number, r: number, sides: number): { u: number; v: number; nu: number; nv: number }[] {
  const half = Math.max(2, Math.round(sides / 2));
  const out: { u: number; v: number; nu: number; nv: number }[] = [];
  for (const end of [1, -1]) {
    for (let i = 0; i <= half; i++) {
      // Right end sweeps -90..90 degrees, left end 90..270.
      const a = (end > 0 ? -Math.PI / 2 : Math.PI / 2) + (i / half) * Math.PI;
      const c = Math.cos(a);
      const q = Math.sin(a);
      out.push({ u: end * e + c * r, v: q * r, nu: c, nv: q });
    }
  }
  return out;
}

export interface ColumnSpec {
  x: number;
  z: number;
  /** Unit plan axis the section is stretched along. */
  ax: number;
  az: number;
  /** Foot (buried a little) and head. */
  y0: number;
  y1: number;
  /** Ground at the column, where the darker foot fades out above. */
  ground: number;
  /** Radius at the ground and at the head. */
  r0: number;
  r1: number;
  /** Straight half length of a rounded-rectangle section, 0 for round. */
  stretch: number;
  sides: number;
  /** Close the top with a flat face (pads and plinths). */
  top?: boolean;
}

/** A tapered column, with a stained foot fading into clean concrete over the first metres. */
export function column(buf: SurfBuf, c: ColumnSpec, clean: SurfStyle, stain: SurfStyle): void {
  const bx = -c.az;
  const bz = c.ax;
  const h = Math.max(0.01, c.y1 - c.ground);
  const radiusAt = (y: number) => c.r0 + (c.r1 - c.r0) * Math.min(1, Math.max(0, (y - c.ground) / h));
  const fade = Math.min(c.ground + 1.8, c.y1 - 0.05);
  const rings: { y: number; s: SurfStyle }[] = [{ y: c.y0, s: stain }];
  if (c.ground > c.y0 + 0.02 && c.ground < c.y1 - 0.05) rings.push({ y: c.ground + 0.02, s: stain });
  if (fade > rings[rings.length - 1].y + 0.05) rings.push({ y: fade, s: clean });
  rings.push({ y: c.y1, s: c.top ? stain : clean });
  const pts = stadium(1, 1, c.sides);
  const world = (k: number, y: number): { p: P3; n: P3 } => {
    const q = pts[k];
    const r = radiusAt(y);
    // The straight part tapers with the radius.
    const e = c.stretch * (r / Math.max(c.r0, 1e-6));
    const uu = Math.sign(q.u - q.nu) * e + q.nu * r;
    const vv = q.nv * r;
    return {
      p: [c.x + c.ax * uu + bx * vv, y, c.z + c.az * uu + bz * vv],
      n: [c.ax * q.nu + bx * q.nv, 0, c.az * q.nu + bz * q.nv],
    };
  };
  for (let j = 0; j + 1 < rings.length; j++) {
    const lo = rings[j];
    const hi = rings[j + 1];
    for (let k = 0; k < pts.length; k++) {
      const k2 = (k + 1) % pts.length;
      const a = world(k, lo.y);
      const b = world(k, hi.y);
      const d = world(k2, hi.y);
      const e = world(k2, lo.y);
      quadAuto(buf, [a.p, b.p, d.p, e.p], [a.n, b.n, d.n, e.n], [lo.s, hi.s, hi.s, lo.s]);
    }
  }
  if (c.top) {
    const up: P3 = [0, 1, 0];
    const centre: P3 = [c.x, c.y1, c.z];
    for (let k = 0; k < pts.length; k++) {
      const a = world(k, c.y1).p;
      const b = world((k + 1) % pts.length, c.y1).p;
      quadAuto(buf, [centre, a, b, centre], [up, up, up, up], clean);
    }
  }
}

export interface BeamSpec {
  /** Origin and the unit plan axis the beam runs along (across the deck). */
  x: number;
  z: number;
  ux: number;
  uz: number;
  /** Extent along the axis, from the origin. */
  u0: number;
  u1: number;
  /** Half thickness across the axis (along the deck). The ends are rounded to it. */
  thick: number;
  /** Height of the flat top. */
  top: number;
  /** Depth under the top at u. */
  depth: (u: number) => number;
  /** Where the depth profile bends, so stations land on it. */
  breaks?: readonly number[];
  /** Stations per rounded end. */
  endSteps: number;
}

/** A cap beam: flat top, rounded ends in plan, and an underside that follows depth(u). */
export function beam(buf: SurfBuf, b: BeamSpec, style: SurfStyle, under: SurfStyle): void {
  const vx = -b.uz;
  const vz = b.ux;
  const t = Math.min(b.thick, (b.u1 - b.u0) / 2);
  // Stations: round ends by angle, the middle at the profile's breaks.
  const st: { u: number; vh: number; nu: number; nv: number }[] = [];
  for (let i = 0; i <= b.endSteps; i++) {
    const a = (i / b.endSteps) * (Math.PI / 2);
    st.push({ u: b.u0 + t - t * Math.cos(a), vh: t * Math.sin(a), nu: -Math.cos(a), nv: Math.sin(a) });
  }
  const mids = [...(b.breaks ?? [])].filter((u) => u > b.u0 + t + 0.01 && u < b.u1 - t - 0.01).sort((p, q) => p - q);
  for (const u of mids) st.push({ u, vh: t, nu: 0, nv: 1 });
  for (let i = b.endSteps; i >= 0; i--) {
    const a = (i / b.endSteps) * (Math.PI / 2);
    st.push({ u: b.u1 - t + t * Math.cos(a), vh: t * Math.sin(a), nu: Math.cos(a), nv: Math.sin(a) });
  }
  const P = (u: number, v: number, y: number): P3 => [b.x + b.ux * u + vx * v, y, b.z + b.uz * u + vz * v];
  const bot = (u: number) => b.top - b.depth(u);
  const slope = (u: number) => (bot(u + 0.05) - bot(u - 0.05)) / 0.1;
  const up: P3 = [0, 1, 0];
  for (let i = 0; i + 1 < st.length; i++) {
    const p = st[i];
    const q = st[i + 1];
    if (q.u - p.u < 1e-5 && Math.abs(q.vh - p.vh) < 1e-5) continue;
    // Top.
    quadAuto(buf, [P(p.u, -p.vh, b.top), P(p.u, p.vh, b.top), P(q.u, q.vh, b.top), P(q.u, -q.vh, b.top)], [up, up, up, up], style);
    // Underside, tilted with its slope.
    const dn = (u: number): P3 => {
      const g = slope(u);
      const l = Math.hypot(g, 1);
      return [(b.ux * g) / l, -1 / l, (b.uz * g) / l];
    };
    quadAuto(buf, [P(p.u, -p.vh, bot(p.u)), P(q.u, -q.vh, bot(q.u)), P(q.u, q.vh, bot(q.u)), P(p.u, p.vh, bot(p.u))], [dn(p.u), dn(q.u), dn(q.u), dn(p.u)], under);
    // The two sides, rounding over the ends.
    for (const side of [1, -1]) {
      const n = (s: (typeof st)[number]): P3 => [b.ux * s.nu + vx * s.nv * side, 0, b.uz * s.nu + vz * s.nv * side];
      quadAuto(
        buf,
        [P(p.u, side * p.vh, b.top), P(p.u, side * p.vh, bot(p.u)), P(q.u, side * q.vh, bot(q.u)), P(q.u, side * q.vh, b.top)],
        [n(p), n(p), n(q), n(q)],
        style,
      );
    }
  }
}
