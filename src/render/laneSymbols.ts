/**
 * Road paint that says what a lane is for: BUS in block letters, and a bicycle.
 * Drawn as plain triangles, so they sit in the same paint batch as the arrows.
 */
import type { LaneDef } from '../core/types';
import type { PaintBuf } from './batch';
import { PAINT_COL } from './constants';
import { placeStamp, type StationPath } from './markings';

const SPACING = 42;
const END_MARGIN = 14;

function bar(a0: number, b0: number, a1: number, b1: number): number[] {
  return [a0, b0, a1, b0, a1, b1, a0, b0, a1, b1, a0, b1];
}

/** Block letters reading along travel. Local frame: +a right, +b forward, metres. */
function busLetters(): number[] {
  const h = 1.5; // Letter height along the road, stretched like real road text.
  const w = 0.42;
  const t = 0.11;
  const out: number[] = [];
  const letter = (x: number, parts: (x: number) => number[]) => out.push(...parts(x));
  const span = (x: number) => [
    ...bar(x, -h, x + t, h),
  ];
  const B = (x: number) => [
    ...span(x),
    ...bar(x, h - t, x + w, h),
    ...bar(x, -t / 2, x + w, t / 2),
    ...bar(x, -h, x + w, -h + t),
    ...bar(x + w - t, 0, x + w, h),
    ...bar(x + w - t, -h, x + w, 0),
  ];
  const U = (x: number) => [...span(x), ...bar(x + w - t, -h, x + w, h), ...bar(x, -h, x + w, -h + t)];
  const S = (x: number) => [
    ...bar(x, h - t, x + w, h),
    ...bar(x, 0, x + t, h),
    ...bar(x, -t / 2, x + w, t / 2),
    ...bar(x + w - t, -h, x + w, 0),
    ...bar(x, -h, x + w, -h + t),
  ];
  const pitch = w + 0.18;
  letter(-pitch * 1.5 + 0.09, B);
  letter(-pitch * 0.5 + 0.09, U);
  letter(pitch * 0.5 + 0.09, S);
  return out;
}

function ring(x: number, y: number, r: number, t: number): number[] {
  const out: number[] = [];
  const n = 14;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const p = (a: number, k: number): [number, number] => [x + Math.cos(a) * k, y + Math.sin(a) * k];
    out.push(...p(a0, r - t), ...p(a1, r - t), ...p(a1, r), ...p(a0, r - t), ...p(a1, r), ...p(a0, r));
  }
  return out;
}

/** A straight stroke of thickness t between two points. */
function stroke(x0: number, y0: number, x1: number, y1: number, t: number): number[] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const l = Math.hypot(dx, dy) || 1;
  const nx = (-dy / l) * (t / 2);
  const ny = (dx / l) * (t / 2);
  return [x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 + nx, y0 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny];
}

/** A side-on bicycle with the wheels along the road. */
function bicycle(): number[] {
  const r = 0.42;
  const t = 0.07;
  const axle = 0.62;
  return [
    ...ring(0, axle, r, t),
    ...ring(0, -axle, r, t),
    // Frame, drawn as a rider sees it from above: a slim diamond between the wheels.
    ...stroke(0, -axle, 0.26, -0.05, t),
    ...stroke(0.26, -0.05, 0, axle, t),
    ...stroke(0, -axle, -0.2, 0.28, t),
    ...stroke(-0.2, 0.28, 0, axle, t),
    ...stroke(-0.2, 0.28, 0.26, -0.05, t),
    ...stroke(0.34, 0.72, -0.34, 0.72, t),
  ];
}

const BUS = busLetters();
const BIKE = bicycle();

/** Paint symbols along every bus and bike lane between two arc lengths. */
export function paintLaneSymbols(buf: PaintBuf, path: StationPath, lanes: readonly LaneDef[], s0: number, s1: number): void {
  const a = s0 + END_MARGIN;
  const b = s1 - END_MARGIN;
  if (b < a) return;
  for (const lane of lanes) {
    if (lane.kind === 'drive') continue;
    const shape = lane.kind === 'bus' ? BUS : BIKE;
    const scale = lane.kind === 'bus' ? Math.min(1.5, lane.width / 2.4) : Math.min(1, lane.width / 1.6);
    const count = Math.max(1, Math.floor((b - a) / SPACING) + 1);
    const step = count > 1 ? (b - a) / (count - 1) : 0;
    for (let i = 0; i < count; i++) {
      const s = count > 1 ? a + i * step : (a + b) / 2;
      const p = path.at(s, lane.offset);
      // Travel from the right vector: t = (r.z, -r.x), reversed for dir -1 lanes.
      const fx = p.rz * lane.dir;
      const fz = -p.rx * lane.dir;
      buf.stamp(placeStamp(shape, p.x, p.z, fx, fz, scale), p.y, PAINT_COL.white);
    }
  }
}
