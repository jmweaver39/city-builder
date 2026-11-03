/**
 * A stand-in SimApi for the render sandbox. Vehicles wander the real lane graph
 * with simple stop-at-red logic. Not a traffic model: it exists so the renderer
 * can be checked and measured without the real sim.
 */
import type { GLane, Id } from '../core/types';
import type { RoadNetwork } from '../core/RoadNetwork';
import { effectiveControl } from '../core/signals';
import type { LightState, SegmentTraffic, SignalHead, SignalPhaseStatus, SimApi, SimStats, VehicleDetail, VehicleView } from '../sim/api';

const STEP = 0.1;

function makeView(capacity: number): VehicleView {
  return {
    count: 0,
    capacity,
    id: new Int32Array(capacity),
    type: new Uint8Array(capacity),
    color: new Uint8Array(capacity),
    braking: new Uint8Array(capacity),
    blinker: new Int8Array(capacity),
    speed: new Float32Array(capacity),
    prevX: new Float32Array(capacity),
    prevY: new Float32Array(capacity),
    prevZ: new Float32Array(capacity),
    prevYaw: new Float32Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    z: new Float32Array(capacity),
    yaw: new Float32Array(capacity),
    pitch: new Float32Array(capacity),
  };
}

export class FakeSim implements SimApi {
  speed = 1;
  time = 0;
  vehicles: VehicleView;
  private accum = 0;
  private lane: Int32Array;
  private seg: Int32Array;
  private s: Float32Array;
  private nextLane: Int32Array;
  private drive: number[] = [];
  private heads: SignalHead[] = [];
  private headGroup: number[] = [];
  private headLane: number[] = [];
  private graphVersion = -1;
  private queue = new Map<number, number>();
  private traffic = new Map<Id, SegmentTraffic>();
  private stepMs = 0;

  constructor(
    private readonly net: RoadNetwork,
    count: number,
  ) {
    this.vehicles = makeView(Math.max(count, 16));
    this.vehicles.count = 0;
    this.lane = new Int32Array(count);
    this.seg = new Int32Array(count);
    this.s = new Float32Array(count);
    this.nextLane = new Int32Array(count);
    this.refreshGraph();
    for (let i = 0; i < count; i++) this.spawn(i);
    this.vehicles.count = this.drive.length ? count : 0;
    this.advance(0.21);
  }

  get renderAlpha(): number {
    return this.speed === 0 ? 1 : this.accum / STEP;
  }

  private refreshGraph(): void {
    const g = this.net.laneGraph;
    if (g.version === this.graphVersion) return;
    this.graphVersion = g.version;
    this.drive = g.lanes.filter((l) => l.kind === 'road' && l.vehicleKind !== 'bike').map((l) => l.idx);
    this.rebuildHeads();
    const v = this.vehicles;
    for (let i = 0; i < v.count; i++) {
      if (!g.lanes[this.lane[i]]) this.spawn(i);
    }
  }

  private rebuildHeads(): void {
    const g = this.net.laneGraph;
    this.heads = [];
    this.headGroup = [];
    this.headLane = [];
    for (const node of this.net.nodes) {
      const ctl = effectiveControl(this.net, node.id);
      if (ctl.kind !== 'signal') continue;
      const arms = this.net.nodeGeom(node.id)?.arms ?? [];
      const seen = new Set<number>();
      for (const c of g.connectorsAt.get(node.id) ?? []) {
        const from = g.lanes[c].fromLane;
        if (seen.has(from)) continue;
        seen.add(from);
        const lane = g.lanes[from];
        const n = lane.pts.length / 3;
        const x = lane.pts[n * 3 - 3];
        const y = lane.pts[n * 3 - 2];
        const z = lane.pts[n * 3 - 1];
        const dx = x - lane.pts[n * 3 - 6];
        const dz = z - lane.pts[n * 3 - 4];
        const l = Math.hypot(dx, dz) || 1;
        const arm = arms.findIndex((a) => a.segmentId === lane.segmentId);
        this.heads.push({ nodeId: node.id, segmentId: lane.segmentId, laneIndex: lane.laneIndex, pos: { x, y, z }, facing: { x: dx / l, y: 0, z: dz / l }, state: 'red' });
        this.headGroup.push(arm % 2);
        this.headLane.push(from);
      }
    }
  }

  private spawn(i: number): void {
    const g = this.net.laneGraph;
    const v = this.vehicles;
    if (!this.drive.length) return;
    const idx = this.drive[Math.floor(Math.random() * this.drive.length)];
    const lane = g.lanes[idx];
    this.lane[i] = idx;
    this.seg[i] = 0;
    this.s[i] = Math.random() * lane.length;
    this.nextLane[i] = this.pickNext(lane);
    v.id[i] = v.id[i] || i + 1;
    const r = Math.random();
    v.type[i] = r < 0.74 ? 0 : r < 0.86 ? 1 : r < 0.95 ? 2 : 3;
    v.color[i] = Math.floor(Math.random() * 16);
    v.speed[i] = lane.speed * (0.7 + Math.random() * 0.3);
    this.place(i, lane, true);
  }

  private pickNext(lane: GLane): number {
    if (!lane.next.length) return -1;
    return lane.next[Math.floor(Math.random() * lane.next.length)];
  }

  private place(i: number, lane: GLane, snap: boolean): void {
    const v = this.vehicles;
    const { pts, cum } = lane;
    const s = this.s[i];
    let k = this.seg[i];
    while (k + 2 < cum.length && cum[k + 1] < s) k++;
    while (k > 0 && cum[k] > s) k--;
    this.seg[i] = k;
    const a = k * 3;
    const span = cum[k + 1] - cum[k] || 1;
    const f = (s - cum[k]) / span;
    const dx = pts[a + 3] - pts[a];
    const dy = pts[a + 4] - pts[a + 1];
    const dz = pts[a + 5] - pts[a + 2];
    if (!snap) {
      v.prevX[i] = v.x[i];
      v.prevY[i] = v.y[i];
      v.prevZ[i] = v.z[i];
      v.prevYaw[i] = v.yaw[i];
    }
    v.x[i] = pts[a] + dx * f;
    v.y[i] = pts[a + 1] + dy * f;
    v.z[i] = pts[a + 2] + dz * f;
    v.yaw[i] = Math.atan2(-dx, -dz);
    v.pitch[i] = Math.atan2(dy, Math.hypot(dx, dz));
    if (snap) {
      v.prevX[i] = v.x[i];
      v.prevY[i] = v.y[i];
      v.prevZ[i] = v.z[i];
      v.prevYaw[i] = v.yaw[i];
    }
  }

  private updateLights(): void {
    const t = this.time;
    const cycle = 34;
    for (let i = 0; i < this.heads.length; i++) {
      const phase = ((t + this.heads[i].nodeId * 3.1) % cycle) / cycle;
      const p = this.headGroup[i] === 0 ? phase : (phase + 0.5) % 1;
      const state: LightState = p < 0.38 ? 'green' : p < 0.46 ? 'yellow' : 'red';
      this.heads[i].state = state;
    }
  }

  step(): void {
    const t0 = performance.now();
    this.refreshGraph();
    this.time += STEP;
    this.updateLights();
    const g = this.net.laneGraph;
    const v = this.vehicles;
    const stopped = new Set<number>();
    for (let i = 0; i < this.heads.length; i++) if (this.heads[i].state !== 'green') stopped.add(this.headLane[i]);
    this.queue.clear();
    for (let i = 0; i < v.count; i++) {
      const lane = g.lanes[this.lane[i]];
      if (!lane) {
        this.spawn(i);
        continue;
      }
      const limit = lane.speed * (0.75 + (v.id[i] % 7) * 0.04);
      let target = lane.kind === 'connector' ? Math.min(limit, 9) : limit;
      const left = lane.length - this.s[i];
      if (stopped.has(lane.idx) && left < 45) {
        const q = this.queue.get(lane.idx) ?? 0;
        this.queue.set(lane.idx, q + 1);
        const room = left - 2.5 - q * 7;
        target = Math.max(0, Math.min(target, room * 0.45));
      }
      const speed = v.speed[i];
      const next = speed + Math.max(-4.5, Math.min(2, (target - speed) * 1.2)) * STEP;
      v.braking[i] = next < speed - 0.15 ? 1 : 0;
      v.speed[i] = next;
      this.s[i] += next * STEP;
      let cur = lane;
      let moved = false;
      while (this.s[i] >= cur.length) {
        const n = g.lanes[this.nextLane[i]];
        if (!n) {
          this.spawn(i);
          moved = true;
          break;
        }
        this.s[i] -= cur.length;
        this.lane[i] = n.idx;
        this.seg[i] = 0;
        this.nextLane[i] = this.pickNext(n);
        cur = n;
      }
      if (moved) continue;
      const after = g.lanes[this.nextLane[i]];
      const lead = cur.kind === 'connector' ? cur : after;
      const near = cur.kind === 'connector' || cur.length - this.s[i] < 45;
      const turn = near ? lead?.turn : null;
      v.blinker[i] = turn === 'left' ? -1 : turn === 'right' ? 1 : 0;
      this.place(i, cur, false);
    }
    this.stepMs = performance.now() - t0;
  }

  advance(realDt: number): void {
    if (this.speed === 0) return;
    this.accum += realDt * this.speed;
    let guard = 8;
    while (this.accum >= STEP && guard-- > 0) {
      this.accum -= STEP;
      this.step();
    }
    if (this.accum >= STEP) this.accum = 0;
  }

  reset(): void {
    this.time = 0;
  }

  stats(): SimStats {
    return { active: this.vehicles.count, spawnedTotal: 0, arrivedTotal: 0, despawnedStuck: 0, throughputPerHour: 0, flow: 0.8, meanSpeedKmh: 40, meanTripSec: 0, jammed: 0, stepMs: this.stepMs };
  }

  segmentTraffic(id: Id): SegmentTraffic {
    let t = this.traffic.get(id);
    if (!t) this.traffic.set(id, (t = { speedRatio: 1, flowPerHour: 0, count: 0 }));
    // Patterns that drift slowly, enough to see the overlay update.
    t.speedRatio = 0.5 + 0.5 * Math.sin(id * 1.73 + this.time * 0.25);
    return t;
  }

  signalHeads(): readonly SignalHead[] {
    return this.heads;
  }

  signalStatus(): SignalPhaseStatus | null {
    return null;
  }

  vehicleDetail(): VehicleDetail | null {
    return null;
  }

  history(): readonly { time: number; throughput: number; flow: number; active: number }[] {
    return [];
  }
}
