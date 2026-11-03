/**
 * Cross-section frames: road stations refined and annotated with terrain
 * clearance, so sweeps have enough samples wherever the ground changes under them.
 */
import type { Station } from '../core/types';
import { riverDistance, terrainHeight } from '../core/terrain';
import { ROAD_LIFT } from './constants';

export interface Frame {
  x: number;
  /** Surface height, including ROAD_LIFT. */
  y: number;
  z: number;
  rx: number;
  rz: number;
  /** Unit 3D tangent. */
  tx: number;
  ty: number;
  tz: number;
  /** Arc length along the full curve. */
  s: number;
  /** Surface height over terrain at the centre. */
  c: number;
  /** Terrain height at the centre. */
  ground: number;
}

function makeFrame(a: Station, b: Station, f: number): Frame {
  const x = a.pos.x + (b.pos.x - a.pos.x) * f;
  const y = a.pos.y + (b.pos.y - a.pos.y) * f + ROAD_LIFT;
  const z = a.pos.z + (b.pos.z - a.pos.z) * f;
  let rx = a.right.x + (b.right.x - a.right.x) * f;
  let rz = a.right.z + (b.right.z - a.right.z) * f;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  let tx = a.tangent.x + (b.tangent.x - a.tangent.x) * f;
  let ty = a.tangent.y + (b.tangent.y - a.tangent.y) * f;
  let tz = a.tangent.z + (b.tangent.z - a.tangent.z) * f;
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl;
  ty /= tl;
  tz /= tl;
  const ground = terrainHeight(x, z);
  return { x, y, z, rx, rz, tx, ty, tz, s: a.s + (b.s - a.s) * f, c: y - ROAD_LIFT - ground, ground };
}

/** Longest gap between frames over changing ground. */
const FINE_STEP = 5;

function needsFine(a: Station, b: Station): boolean {
  const check = (s: Station) => s.pos.y !== 0 || riverDistance(s.pos.x, s.pos.z) < 70;
  if (check(a) || check(b)) return true;
  // A long span could jump the whole channel.
  const mx = (a.pos.x + b.pos.x) / 2;
  const mz = (a.pos.z + b.pos.z) / 2;
  return riverDistance(mx, mz) < 70;
}

/** Extra arc lengths to keep as frames, on top of the refined stations. */
export function buildFrames(stations: readonly Station[], extraS: readonly number[] = []): Frame[] {
  const out: Frame[] = [];
  const extras = extraS.slice().sort((p, q) => p - q);
  let e = 0;
  for (let i = 0; i + 1 < stations.length; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    const span = b.s - a.s;
    if (span <= 1e-6) continue;
    const parts = needsFine(a, b) ? Math.ceil(span / FINE_STEP) : 1;
    for (let k = 0; k < parts; k++) {
      const f = k / parts;
      const s = a.s + span * f;
      const next = a.s + (span * (k + 1)) / parts;
      out.push(makeFrame(a, b, f));
      while (e < extras.length && extras[e] <= s + 0.01) e++;
      while (e < extras.length && extras[e] < next - 0.01) {
        out.push(makeFrame(a, b, (extras[e] - a.s) / span));
        e++;
      }
    }
  }
  const last = stations[stations.length - 1];
  const prev = stations[stations.length - 2] ?? last;
  out.push(makeFrame(prev, last, 1));
  return out;
}
