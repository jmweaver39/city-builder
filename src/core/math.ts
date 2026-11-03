/**
 * Small vector helpers on the plain Vec3 interface. Every function returns a new
 * object unless its name says otherwise, so callers can freely keep the results.
 *
 * Plan view means the XZ plane looked at from above. In this project's axes
 * atan2(z, x) increases clockwise when viewed from above.
 */
import type { Vec3 } from './types';

export const EPS = 1e-9;
export const TAU = Math.PI * 2;

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function copy(a: Vec3): Vec3 {
  return { x: a.x, y: a.y, z: a.z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, k: number): Vec3 {
  return { x: a.x * k, y: a.y * k, z: a.z * k };
}

/** a + b * k */
export function addScaled(a: Vec3, b: Vec3, k: number): Vec3 {
  return { x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function dotXZ(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** Plan-view cross product a.x * b.z - a.z * b.x. Positive when b is clockwise of a. */
export function crossXZ(a: Vec3, b: Vec3): number {
  return a.x * b.z - a.z * b.x;
}

export function length(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function lengthXZ(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.z * a.z);
}

export function dist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function distXZ(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Unit vector, or `fallback` (default zero) for a zero-length input. */
export function normalize(a: Vec3, fallback: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const l = length(a);
  if (l < EPS) return copy(fallback);
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

/** Unit horizontal vector with y = 0, or `fallback` for a vertical or zero input. */
export function normalizeXZ(a: Vec3, fallback: Vec3 = { x: 1, y: 0, z: 0 }): Vec3 {
  const l = lengthXZ(a);
  if (l < EPS) return copy(fallback);
  return { x: a.x / l, y: 0, z: a.z / l };
}

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/**
 * The project-wide right vector: (-f.z, 0, f.x), normalised. Traffic drives on
 * this side. Do not reimplement it; a flipped sign puts traffic on the wrong side.
 */
export function rightOf(f: Vec3, fallback: Vec3 = { x: 0, y: 0, z: 1 }): Vec3 {
  const l = Math.sqrt(f.x * f.x + f.z * f.z);
  if (l < EPS) return copy(fallback);
  return { x: -f.z / l, y: 0, z: f.x / l };
}

export function leftOf(f: Vec3, fallback: Vec3 = { x: 0, y: 0, z: -1 }): Vec3 {
  const l = Math.sqrt(f.x * f.x + f.z * f.z);
  if (l < EPS) return copy(fallback);
  return { x: f.z / l, y: 0, z: -f.x / l };
}

/** Plan-view heading of a vector. Increases clockwise viewed from above. */
export function headingOf(a: Vec3): number {
  return Math.atan2(a.z, a.x);
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % TAU;
  if (r <= -Math.PI) r += TAU;
  else if (r > Math.PI) r -= TAU;
  return r;
}

/** Wrap an angle to [0, 2 PI). */
export function wrapPositive(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/**
 * Plan-view signed turn from heading `from` to heading `to`, in (-PI, PI].
 * Positive turns right (clockwise viewed from above).
 */
export function signedTurn(from: Vec3, to: Vec3): number {
  return Math.atan2(crossXZ(from, to), dotXZ(from, to));
}

/** Unsigned angle between two 3D vectors, in [0, PI]. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const la = length(a);
  const lb = length(b);
  if (la < EPS || lb < EPS) return 0;
  return Math.acos(clamp(dot(a, b) / (la * lb), -1, 1));
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite smoothstep: 0 at or below edge0, 1 at or above edge1. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function isFiniteVec(a: Vec3 | null | undefined): a is Vec3 {
  return !!a && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
}

/**
 * Plan-view intersection of segments ab and cd, inclusive of the end points.
 * Returns the parameters along each, or null when parallel or apart.
 */
export function segmentIntersectXZ(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
  eps = 1e-9,
): { u: number; v: number } | null {
  const rx = bx - ax;
  const rz = bz - az;
  const sx = dx - cx;
  const sz = dz - cz;
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-14) return null;
  const qx = cx - ax;
  const qz = cz - az;
  const u = (qx * sz - qz * sx) / denom;
  if (u < -eps || u > 1 + eps) return null;
  const v = (qx * rz - qz * rx) / denom;
  if (v < -eps || v > 1 + eps) return null;
  return { u: clamp(u, 0, 1), v: clamp(v, 0, 1) };
}
