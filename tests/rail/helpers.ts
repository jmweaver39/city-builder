import { RoadNetwork, type Id, type Vec3 } from '../../src/core';
import { CAR_KINDS } from '../../src/rail';
import type { CarView, TrainSim } from '../../src/rail';

export const v = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });

/** One long straight of track, cut at the given x values, with stations. */
export function straightLine(net: RoadNetwork, type: string, x0: number, x1: number): { seg: Id; a: Id; b: Id } {
  const a = net.addNode(v(x0, 0));
  const b = net.addNode(v(x1, 0));
  const seg = net.addSegment(a, b, { roadType: type });
  return { seg, a, b };
}

export function station(net: RoadNetwork, seg: Id, t: number, name: string, platformLength = 260, kind: 'surface' | 'underground' | 'gateway' = 'surface'): Id {
  return net.addStation({ name, kind, segmentId: seg, t, platformLength });
}

export interface Box {
  x: number;
  z: number;
  y: number;
  hl: number;
  hw: number;
  yaw: number;
  train: number;
  hidden: boolean;
}

export function boxes(view: CarView): Box[] {
  const out: Box[] = [];
  for (let i = 0; i < view.count; i++) {
    const k = CAR_KINDS[view.kind[i]];
    out.push({
      x: view.x[i],
      z: view.z[i],
      y: view.y[i],
      hl: k.length / 2,
      hw: k.width / 2,
      yaw: view.yaw[i],
      train: view.train[i],
      hidden: (view.flags[i] & 1) !== 0,
    });
  }
  return out;
}

/** Separating axis test of two oriented boxes in plan. */
export function overlap(a: Box, b: Box): boolean {
  if (Math.abs(a.y - b.y) > 4) return false;
  const reach = a.hl + a.hw + b.hl + b.hw;
  if (Math.abs(a.x - b.x) > reach || Math.abs(a.z - b.z) > reach) return false;
  const axes: [number, number][] = [];
  for (const q of [a, b]) {
    const fx = -Math.sin(q.yaw);
    const fz = -Math.cos(q.yaw);
    axes.push([fx, fz], [-fz, fx]);
  }
  const project = (q: Box, ax: number, az: number): number => {
    const fx = -Math.sin(q.yaw);
    const fz = -Math.cos(q.yaw);
    return Math.abs(fx * ax + fz * az) * q.hl + Math.abs(-fz * ax + fx * az) * q.hw;
  };
  for (const [ax, az] of axes) {
    const d = Math.abs((a.x - b.x) * ax + (a.z - b.z) * az);
    if (d > project(a, ax, az) + project(b, ax, az)) return false;
  }
  return true;
}

/** Number of overlapping pairs of cars from different trains. */
export function countOverlaps(trains: TrainSim): number {
  const list = boxes(trains.view).filter((b) => !b.hidden);
  const cells = new Map<number, Box[]>();
  const key = (i: number, j: number) => (i + 2048) * 4096 + (j + 2048);
  const size = 40;
  let hits = 0;
  for (const b of list) {
    const i = Math.floor(b.x / size);
    const j = Math.floor(b.z / size);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const o of cells.get(key(i + di, j + dj)) ?? []) {
          if (o.train !== b.train && overlap(o, b)) hits++;
        }
      }
    }
    const k = key(i, j);
    const cell = cells.get(k);
    if (cell) cell.push(b);
    else cells.set(k, [b]);
  }
  return hits;
}

/** A single line along x with one passing loop on the +z side, round x = xm. */
export function loopedLine(net: RoadNetwork, type: string, x0: number, x1: number, xm: number, half = 330): { west: Id; east: Id; main: Id[]; loop: Id[] } {
  const a = net.addNode(v(x0, 0));
  const p = net.addNode(v(xm - half, 0));
  const q = net.addNode(v(xm + half, 0));
  const b = net.addNode(v(x1, 0));
  const west = net.addSegment(a, p, { roadType: type });
  const mid = net.addSegment(p, q, { roadType: type });
  const east = net.addSegment(q, b, { roadType: type });
  const off = 12;
  const s = 170;
  const p2 = net.addNode(v(xm - half + s, off));
  const q2 = net.addNode(v(xm + half - s, off));
  const l1 = net.addSegment(p, p2, { c1: v(xm - half + s * 0.5, 0), c2: v(xm - half + s * 0.5, off), roadType: type });
  const l2 = net.addSegment(p2, q2, { roadType: type });
  const l3 = net.addSegment(q2, q, { c1: v(xm + half - s * 0.5, off), c2: v(xm + half - s * 0.5, 0), roadType: type });
  return { west, east, main: [mid], loop: [l1, l2, l3] };
}

/** Run a sim, asserting no overlap at every step. Returns the worst count seen. */
export function runChecked(sim: TrainSim, steps: number, every = 1): number {
  let worst = 0;
  for (let i = 0; i < steps; i++) {
    sim.step();
    if (i % every === 0) worst = Math.max(worst, countOverlaps(sim));
  }
  return worst;
}
