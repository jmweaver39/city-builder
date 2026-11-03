/**
 * Who is on each lane this step, sorted front to back. Rebuilt from scratch each
 * step, so edits and lane changes cannot leave it inconsistent, but seeded in last
 * step's order so the sort stays close to linear.
 *
 * A lane's list also holds stand-ins for vehicles that are partly or nearly there:
 * - ENTRY_REAR: the tail of a vehicle whose front has already moved to the next
 *   lane. Its position exceeds the lane length. This is what makes a follower on a
 *   diverge see a vehicle that left for the other branch.
 * - ENTRY_GHOST: a vehicle still sliding out of this lane during a lane change.
 * - ENTRY_REQUEST: a vehicle asking to change into this lane. The one behind it may
 *   open a gap. It does not count as occupancy.
 */
import type { CompiledGraph } from './compiled';
import type { VehicleStore } from './vehicles';

export const ENTRY_REAL = 0;
export const ENTRY_REAR = 1;
export const ENTRY_GHOST = 2;
export const ENTRY_REQUEST = 3;

export class Buckets {
  start: Int32Array;
  count: Int32Array;
  fill: Int32Array;
  eV: Int32Array;
  eS: Float64Array;
  eT: Uint8Array;
  order: Int32Array;
  orderCount = 0;
  /** Position of the rearmost bumper on each lane, Infinity when empty. */
  tailRear: Float64Array;
  tailV: Float64Array;
  /** Whose rear that is, or -1. */
  tailVeh: Int32Array;
  /** Length spoken for on the way into each lane, by vehicles on or cleared for connectors. */
  reserve: Float64Array;
  /** Last lane change into each lane: the step, and where. */
  changeTick: Int32Array;
  changeAt: Float64Array;
  private buildTick = 0;

  constructor(n: number, capacity: number) {
    this.start = new Int32Array(n + 1);
    this.count = new Int32Array(n);
    this.fill = new Int32Array(n);
    this.tailRear = new Float64Array(n);
    this.tailV = new Float64Array(n);
    this.tailVeh = new Int32Array(n).fill(-1);
    this.reserve = new Float64Array(n);
    this.changeTick = new Int32Array(n).fill(-1);
    this.changeAt = new Float64Array(n);
    this.eV = new Int32Array(capacity * 5);
    this.eS = new Float64Array(capacity * 5);
    this.eT = new Uint8Array(capacity * 5);
    this.order = new Int32Array(capacity);
    this.tailRear.fill(Infinity);
  }

  ensureCapacity(capacity: number): void {
    if (this.order.length >= capacity) return;
    this.eV = new Int32Array(capacity * 5);
    this.eS = new Float64Array(capacity * 5);
    this.eT = new Uint8Array(capacity * 5);
    const order = new Int32Array(capacity);
    order.set(this.order);
    this.order = order;
  }

  /** Forget the stored order, as after a remap. */
  resetOrder(): void {
    this.orderCount = 0;
  }

  /** Record a new vehicle, which sorts into place on the next build. */
  append(slot: number): void {
    this.order[this.orderCount++] = slot;
  }

  build(g: CompiledGraph, veh: VehicleStore): void {
    const { start, count, fill, eV, eS, eT, order, tailRear, tailV, tailVeh, reserve } = this;
    const { len: laneLen, isConn, toLane, n } = g;
    const { alive, lane, s, len, prev1, prev2, lcFrom, reqLane, permit, seen, v: speed } = veh;
    const tick = ++this.buildTick;

    // Drop dead slots and any duplicate left by a slot being reused.
    let m = 0;
    for (let i = 0; i < this.orderCount; i++) {
      const v = order[i];
      if (alive[v] && seen[v] !== tick) {
        seen[v] = tick;
        order[m++] = v;
      }
    }
    this.orderCount = m;

    count.fill(0);
    reserve.fill(0);
    for (let i = 0; i < m; i++) {
      const v = order[i];
      const l = lane[v];
      count[l]++;
      const over = len[v] - s[v];
      const p1 = prev1[v];
      if (over > 0 && p1 >= 0) {
        count[p1]++;
        if (over > laneLen[p1] && prev2[v] >= 0) count[prev2[v]]++;
      }
      if (lcFrom[v] >= 0) count[lcFrom[v]]++;
      if (reqLane[v] >= 0) count[reqLane[v]]++;
      if (isConn[l]) reserve[toLane[l]] += len[v] + 2;
      if (permit[v] >= 0) reserve[toLane[permit[v]]] += len[v] + 2;
    }
    let total = 0;
    for (let l = 0; l < n; l++) {
      start[l] = total;
      fill[l] = total;
      total += count[l];
    }
    start[n] = total;

    for (let i = 0; i < m; i++) {
      const v = order[i];
      const at = fill[lane[v]]++;
      eV[at] = v;
      eS[at] = s[v];
      eT[at] = ENTRY_REAL;
    }
    for (let i = 0; i < m; i++) {
      const v = order[i];
      const l = lane[v];
      const over = len[v] - s[v];
      const p1 = prev1[v];
      if (over > 0 && p1 >= 0) {
        const pos = s[v] + laneLen[p1];
        let at = fill[p1]++;
        eV[at] = v;
        eS[at] = pos;
        eT[at] = ENTRY_REAR;
        const p2 = prev2[v];
        if (over > laneLen[p1] && p2 >= 0) {
          at = fill[p2]++;
          eV[at] = v;
          eS[at] = pos + laneLen[p2];
          eT[at] = ENTRY_REAR;
        }
      }
      const from = lcFrom[v];
      if (from >= 0) {
        const at = fill[from]++;
        eV[at] = v;
        eS[at] = (s[v] * laneLen[from]) / laneLen[l];
        eT[at] = ENTRY_GHOST;
      }
      const req = reqLane[v];
      if (req >= 0) {
        const at = fill[req]++;
        eV[at] = v;
        eS[at] = (s[v] * laneLen[req]) / laneLen[l];
        eT[at] = ENTRY_REQUEST;
      }
    }

    // Insertion sort each lane, front first, and read off its tail.
    let o = 0;
    for (let l = 0; l < n; l++) {
      const a = start[l];
      const b = start[l + 1];
      if (a === b) {
        tailRear[l] = Infinity;
        tailV[l] = 0;
        tailVeh[l] = -1;
        continue;
      }
      for (let i = a + 1; i < b; i++) {
        const key = eS[i];
        const kv = eV[i];
        const kt = eT[i];
        let j = i - 1;
        while (j >= a && (eS[j] < key || (eS[j] === key && eV[j] > kv))) {
          eS[j + 1] = eS[j];
          eV[j + 1] = eV[j];
          eT[j + 1] = eT[j];
          j--;
        }
        eS[j + 1] = key;
        eV[j + 1] = kv;
        eT[j + 1] = kt;
      }
      let rear = Infinity;
      let rearV = 0;
      let rearVeh = -1;
      for (let i = a; i < b; i++) {
        if (eT[i] === ENTRY_REAL) order[o++] = eV[i];
        if (eT[i] === ENTRY_REQUEST) continue;
        const r = eS[i] - len[eV[i]];
        if (r < rear) {
          rear = r;
          rearV = speed[eV[i]];
          rearVeh = eV[i];
        }
      }
      tailRear[l] = rear;
      tailV[l] = rearV;
      tailVeh[l] = rearVeh;
    }
    this.orderCount = o;
  }
}
