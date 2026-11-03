import { expect } from 'vitest';
import { RoadNetwork, type Id, type RoadAnchor, type Vec3 } from '../../src/core';
import { Simulation, VEHICLE_PARAMS } from '../../src/sim';
import { KIND_CROSS } from '../../src/sim/compiled';

export const v = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });
export const free = (x: number, z: number, y = 0): RoadAnchor => ({ kind: 'free', pos: v(x, z, y) });
export const atNode = (id: Id): RoadAnchor => ({ kind: 'node', id });
export const onSeg = (id: Id, t: number): RoadAnchor => ({ kind: 'segment', id, t });

/** Everything finite, speeds sane. Run on any network at any time. */
export function expectFiniteState(sim: Simulation): void {
  const view = sim.vehicles;
  const { veh, g } = sim.state;
  expect(view.count).toBe(veh.liveCount);
  for (let i = 0; i < view.count; i++) {
    if (
      !Number.isFinite(view.x[i]) ||
      !Number.isFinite(view.y[i]) ||
      !Number.isFinite(view.z[i]) ||
      !Number.isFinite(view.yaw[i]) ||
      !Number.isFinite(view.speed[i])
    ) {
      throw new Error(`vehicle ${view.id[i]} has a non-finite state`);
    }
    if (view.speed[i] < 0 || view.speed[i] > 70) throw new Error(`vehicle ${view.id[i]} speed ${view.speed[i]}`);
  }
  for (let i = 0; i < veh.liveCount; i++) {
    const k = veh.live[i];
    const l = veh.lane[k];
    if (l < 0 || l >= g.n) throw new Error(`vehicle in lane ${l} of ${g.n}`);
    if (!Number.isFinite(veh.s[k]) || !Number.isFinite(veh.v[k])) throw new Error('non-finite s or v');
    if (veh.s[k] < -0.01 || veh.s[k] > g.len[l] + 1) throw new Error(`s ${veh.s[k]} on lane of ${g.len[l]}`);
  }
}

/** Largest overlap between two vehicles on one lane, or 0. Measured from raw state. */
export function worstLaneOverlap(sim: Simulation): number {
  const { veh, g } = sim.state;
  const byLane = new Map<number, number[]>();
  for (let i = 0; i < veh.liveCount; i++) {
    const k = veh.live[i];
    const l = veh.lane[k];
    if (!byLane.has(l)) byLane.set(l, []);
    byLane.get(l)!.push(k);
  }
  let worst = 0;
  for (const list of byLane.values()) {
    list.sort((a, b) => veh.s[b] - veh.s[a]);
    for (let i = 1; i < list.length; i++) {
      const front = list[i - 1];
      const back = list[i];
      const overlap = veh.s[back] - (veh.s[front] - veh.len[front]);
      if (overlap > worst) worst = overlap;
    }
  }
  return worst;
}

export interface CrossingSweep {
  /** Steps with two vehicles on a crossing point at once. */
  clashes: number;
  /** Distinct pairs of vehicles that clashed. */
  pairs: Set<string>;
  sample: string[];
}

export function newSweep(): CrossingSweep {
  return { clashes: 0, pairs: new Set(), sample: [] };
}

/**
 * Do two vehicles occupy the crossing point of two connectors at once? A vehicle
 * occupies a point while any of its body is within `margin` of it. Vehicles whose
 * tails are still on a connector they left count too.
 */
export function sweepCrossings(sim: Simulation, sweep: CrossingSweep, margin = 1): void {
  const { g, veh } = sim.state;
  // Lists are from the start of this step, so rebuild from raw state.
  const on = new Map<number, { v: number; front: number }[]>();
  for (let i = 0; i < veh.liveCount; i++) {
    const k = veh.live[i];
    const put = (lane: number, front: number) => {
      if (!on.has(lane)) on.set(lane, []);
      on.get(lane)!.push({ v: k, front });
    };
    put(veh.lane[k], veh.s[k]);
    const over = veh.len[k] - veh.s[k];
    const p1 = veh.prev1[k];
    if (over > 0 && p1 >= 0) {
      put(p1, veh.s[k] + g.len[p1]);
      const p2 = veh.prev2[k];
      if (over > g.len[p1] && p2 >= 0) put(p2, veh.s[k] + g.len[p1] + g.len[p2]);
    }
  }
  for (const [lane, list] of on) {
    if (!g.isConn[lane]) continue;
    for (let c = g.confStart[lane]; c < g.confStart[lane + 1]; c++) {
      if (g.confKind[c] !== KIND_CROSS) continue;
      const other = g.confLane[c];
      if (other < lane) continue;
      const theirs = on.get(other);
      if (!theirs) continue;
      for (const a of list) {
        const inA = a.front >= g.confSelf[c] - margin && a.front - veh.len[a.v] <= g.confSelf[c] + margin;
        if (!inA) continue;
        for (const b of theirs) {
          if (a.v === b.v) continue;
          const inB = b.front >= g.confOther[c] - margin && b.front - veh.len[b.v] <= g.confOther[c] + margin;
          if (!inB) continue;
          sweep.clashes++;
          sweep.pairs.add(`${veh.id[a.v]}/${veh.id[b.v]}`);
          if (sweep.sample.length < 5) {
            sweep.sample.push(
              `t=${sim.time.toFixed(1)} ${g.graph.lanes[lane].key}@${a.front.toFixed(1)} x ${g.graph.lanes[other].key}@${b.front.toFixed(1)} at ${g.confSelf[c].toFixed(1)}/${g.confOther[c].toFixed(1)}`,
            );
          }
        }
      }
    }
  }
}

/** A straight 4-way of the given road type with four long arms. */
export function crossroads(roadType: string, arm = 300) {
  const net = new RoadNetwork();
  const hub = net.addNode(v(0, 0));
  const ends = [v(arm, 0), v(-arm, 0), v(0, arm), v(0, -arm)].map((p) => net.addNode(p));
  const segs = ends.map((e) => net.addSegment(hub, e, { roadType }));
  return { net, hub, ends, segs };
}

/** Run with per-step checks. */
export function run(sim: Simulation, seconds: number, each?: () => void): void {
  const steps = Math.round(seconds * 10);
  for (let i = 0; i < steps; i++) {
    sim.step();
    each?.();
  }
}

/** Corners of a vehicle's footprint from public view data alone. Yaw 0 faces -Z. */
function corners(x: number, z: number, yaw: number, length: number, width: number): number[] {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const sx = -fz;
  const sz = fx;
  const l = length / 2;
  const w = width / 2;
  return [
    x + fx * l + sx * w, z + fz * l + sz * w,
    x + fx * l - sx * w, z + fz * l - sz * w,
    x - fx * l - sx * w, z - fz * l - sz * w,
    x - fx * l + sx * w, z - fz * l + sz * w,
  ];
}

/** Separating axes over corner projections, written apart from the sim's own test. */
function polygonsOverlap(a: number[], b: number[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const nx = poly[j * 2 + 1] - poly[i * 2 + 1];
      const nz = poly[i * 2] - poly[j * 2];
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (let k = 0; k < 4; k++) {
        const pa = a[k * 2] * nx + a[k * 2 + 1] * nz;
        const pb = b[k * 2] * nx + b[k * 2 + 1] * nz;
        minA = Math.min(minA, pa);
        maxA = Math.max(maxA, pa);
        minB = Math.min(minB, pb);
        maxB = Math.max(maxB, pb);
      }
      if (maxA < minB || maxB < minA) return false;
    }
  }
  return true;
}

export interface BodyCheck {
  /** Vehicle pairs overlapping, summed over steps. */
  hits: number;
  pairs: Set<string>;
  sample: string[];
  steps: number;
  vehicleSteps: number;
}

export function newBodyCheck(): BodyCheck {
  return { hits: 0, pairs: new Set(), sample: [], steps: 0, vehicleSteps: 0 };
}

/**
 * True geometric check: does any vehicle's real footprint overlap any other, anywhere
 * in the world? Reads only the published view, so it trusts nothing inside the sim.
 */
export function checkBodies(sim: Simulation, check: BodyCheck): void {
  const view = sim.vehicles;
  const n = view.count;
  check.steps++;
  check.vehicleSteps += n;
  const cell = 20;
  const grid = new Map<string, number[]>();
  const boxes: number[][] = [];
  for (let i = 0; i < n; i++) {
    const p = VEHICLE_PARAMS[view.type[i]];
    boxes.push(corners(view.x[i], view.z[i], view.yaw[i], p.length, p.width));
    const key = `${Math.floor(view.x[i] / cell)},${Math.floor(view.z[i] / cell)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(i);
  }
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(view.x[i] / cell);
    const cz = Math.floor(view.z[i] / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const j of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
          if (j <= i || Math.abs(view.y[i] - view.y[j]) > 2.5) continue;
          if (!polygonsOverlap(boxes[i], boxes[j])) continue;
          check.hits++;
          check.pairs.add(`${view.id[i]}/${view.id[j]}`);
          if (check.sample.length < 4) {
            check.sample.push(`t=${sim.time.toFixed(1)} #${view.id[i]} type ${view.type[i]} at (${view.x[i].toFixed(1)}, ${view.z[i].toFixed(1)}) with #${view.id[j]} type ${view.type[j]} at (${view.x[j].toFixed(1)}, ${view.z[j].toFixed(1)})`);
          }
        }
      }
    }
  }
}
