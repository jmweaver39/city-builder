/**
 * Quay walls: geometry of a wall following one bank of the river, and snapping
 * clicks onto that line. A quay is stored as a stretch of bank (see wallTypes.ts),
 * so it always follows the river's curve exactly.
 */
import { MAP_HALF_SIZE, riverCentreZ, riverDistance, terrainHeight } from './terrain';
import type { Quay } from './wallTypes';

/** Distance of the wall's water face from the river centreline. The water line is at 30. */
export const QUAY_LINE = 26;
/** Land behind the wall is held at this height, the level ground roads are built at. */
export const QUAY_TOP = 0;
/** The fill behind the wall reaches back to where the bank is already at QUAY_TOP. */
export const QUAY_LAND = 41;
/** Thickness of the wall at its top. */
export const QUAY_THICKNESS = 0.8;
/** Shortest quay worth building, along the bank. */
export const MIN_QUAY_LENGTH = 8;
/** A click this far from the river centreline still snaps to the bank. */
export const QUAY_SNAP_DISTANCE = 75;

function slopeAt(x: number): number {
  const e = 0.5;
  return (riverCentreZ(x + e) - riverCentreZ(x - e)) / (2 * e);
}

/** Unit normal across the river at centreline x, pointing toward `bank`. */
export function bankNormal(x: number, bank: 1 | -1): { x: number; z: number } {
  const m = slopeAt(x);
  const l = Math.sqrt(1 + m * m);
  return { x: (-m / l) * bank, z: (1 / l) * bank };
}

/** The point `d` metres out from the centreline at x, on `bank`. */
export function bankPoint(x: number, bank: 1 | -1, d: number): { x: number; z: number } {
  const n = bankNormal(x, bank);
  return { x: x + n.x * d, z: riverCentreZ(x) + n.z * d };
}

export interface BankSnap {
  bank: 1 | -1;
  /** Centreline x of the snapped point. */
  x: number;
  /** The point on the quay line. */
  pos: { x: number; y: number; z: number };
}

/** Which bank a point is on, and the centreline x it lies across from. */
export function bankParam(px: number, pz: number): { bank: 1 | -1; x: number; d: number } {
  const bank: 1 | -1 = pz >= riverCentreZ(px) ? 1 : -1;
  // The offset curve is close to the normal through the point, so a few fixed-point steps find it.
  let x = px;
  let d = 0;
  for (let k = 0; k < 8; k++) {
    const n = bankNormal(x, bank);
    d = (px - x) * n.x + (pz - riverCentreZ(x)) * n.z;
    x = px - n.x * d;
  }
  return { bank, x, d };
}

/** Snap a click onto the quay line along the nearer bank. Null when far from the river. */
export function snapToBank(px: number, pz: number, bank?: 1 | -1): BankSnap | null {
  if (riverDistance(px, pz) > QUAY_SNAP_DISTANCE) return null;
  const p = bankParam(px, pz);
  const b = bank ?? p.bank;
  const x = Math.max(-MAP_HALF_SIZE + 20, Math.min(MAP_HALF_SIZE - 20, p.x));
  const q = bankPoint(x, b, QUAY_LINE);
  return { bank: b, x, pos: { x: q.x, y: QUAY_TOP, z: q.z } };
}

export interface QuaySample {
  /** Centreline x. */
  cx: number;
  /** Water face of the wall at the top. */
  x: number;
  z: number;
  /** Unit plan direction from the water toward the land. */
  nx: number;
  nz: number;
  /** River bed at the wall's foot. */
  bed: number;
  /** Arc length along the wall. */
  s: number;
}

/** Points along the wall from x0 to x1, about every `step` metres of wall. */
export function quaySamples(q: Pick<Quay, 'bank' | 'x0' | 'x1'>, step = 2.5): QuaySample[] {
  const out: QuaySample[] = [];
  const len = Math.max(q.x1 - q.x0, 0);
  const n = Math.max(1, Math.ceil(len / step));
  let s = 0;
  let px = 0;
  let pz = 0;
  for (let i = 0; i <= n; i++) {
    const cx = q.x0 + (len * i) / n;
    const nrm = bankNormal(cx, q.bank);
    const p = bankPoint(cx, q.bank, QUAY_LINE);
    if (i > 0) s += Math.hypot(p.x - px, p.z - pz);
    px = p.x;
    pz = p.z;
    out.push({ cx, x: p.x, z: p.z, nx: nrm.x, nz: nrm.z, bed: terrainHeight(p.x, p.z), s });
  }
  return out;
}

/** Wall length along the bank. */
export function quayLength(q: Pick<Quay, 'bank' | 'x0' | 'x1'>): number {
  const pts = quaySamples(q, 4);
  return pts[pts.length - 1].s;
}

/** True when (x, z) is behind this quay, in the land it holds up. */
export function behindQuay(q: Pick<Quay, 'bank' | 'x0' | 'x1'>, x: number, z: number): boolean {
  const p = bankParam(x, z);
  if (p.bank !== q.bank || p.x < q.x0 || p.x > q.x1) return false;
  return p.d >= QUAY_LINE - 1e-6 && p.d <= QUAY_LAND;
}

/** Ground height behind a quay, or null when (x, z) is not behind it. */
export function quayGround(q: Pick<Quay, 'bank' | 'x0' | 'x1'>, x: number, z: number): number | null {
  if (!behindQuay(q, x, z)) return null;
  return Math.max(terrainHeight(x, z), QUAY_TOP);
}

/** Why a quay cannot be built, or null. */
export function quayProblem(q: Pick<Quay, 'bank' | 'x0' | 'x1'>, others: readonly Quay[]): string | null {
  if (quayLength(q) < MIN_QUAY_LENGTH) return 'Too short for a quay.';
  if (q.x0 < -MAP_HALF_SIZE || q.x1 > MAP_HALF_SIZE) return 'Outside the map.';
  for (const o of others) {
    if (o.bank === q.bank && q.x0 < o.x1 - 0.5 && q.x1 > o.x0 + 0.5) return 'Overlaps another quay.';
  }
  return null;
}
