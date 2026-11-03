/** Mandatory and MOBIL-style discretionary lane changes. */
import { ENTRY_GHOST, ENTRY_REQUEST } from './buckets';
import {
  DISCRETIONARY_PERIOD_STEPS,
  LANE_CHANGE_BASE_DIST,
  LANE_CHANGE_BODY_DISTS,
  LANE_CHANGE_COOLDOWN,
  LANE_CHANGE_COST_SEC,
  LANE_CHANGE_SEC,
  MANDATORY_PERIOD_STEPS,
} from './constants';
import { dropClaim } from './junctions';
import { allowBit, tableOf } from './pathing';
import type { World } from './world';

const POLITENESS = 0.3;
const CHANGE_THRESHOLD = 0.25;
const KEEP_RIGHT_BIAS = 0.3;
const MAX_FOLLOWER_BRAKE = 2.5;
/** Do not start a change for speed this close to the end of a lane. */
const NO_DISCRETIONARY_DIST = 60;
/** Body clear of the lane start by this much before changing: arrivals are not in the lane list. */
const MIN_LANE_ENTRY = 3;
/** Two changes into one lane in one step must be at least this far apart. */
const TAKEN_RANGE = 40;
/** A must-take driver matches traffic this close in the lane it needs, plus a margin. */
const SEEK_RANGE = 60;
const SEEK_MARGIN = 3.5;

// Neighbours found by lookAt.
let frontGap = Infinity;
let frontV = 0;
let backGap = Infinity;
let backV = 0;
let backU = -1;

/** Road a vehicle needs ahead of it to change lanes at all, tight as that is. */
export function laneChangeRoom(length: number): number {
  return 10 + length;
}

/** The vehicles around position `at` on lane `t`, for a body of length `length`. */
function lookAt(w: World, v: number, t: number, at: number, length: number): void {
  const { bk, veh } = w;
  const { start, eV, eS, eT } = bk;
  const a = start[t];
  const b = start[t + 1];
  // First entry at or behind `at`. Lists are sorted front first.
  let lo = a;
  let hi = b;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (eS[mid] > at) lo = mid + 1;
    else hi = mid;
  }
  frontGap = Infinity;
  frontV = 0;
  backGap = Infinity;
  backV = 0;
  backU = -1;
  for (let e = lo - 1; e >= a; e--) {
    const u = eV[e];
    if (u === v || eT[e] === ENTRY_REQUEST) continue;
    const gap = eS[e] - veh.len[u] - at;
    if (gap < frontGap) {
      frontGap = gap;
      frontV = veh.v[u];
    }
    // Ghosts do not end the search: one can hide inside a long vehicle further on.
    if (eT[e] !== ENTRY_GHOST) break;
  }
  for (let e = lo; e < b; e++) {
    const u = eV[e];
    if (u === v || eT[e] === ENTRY_REQUEST) continue;
    const gap = at - length - eS[e];
    if (gap < backGap) {
      backGap = gap;
      backV = veh.v[u];
      backU = u;
    }
    if (eT[e] !== ENTRY_GHOST) break;
  }
}

/** Has someone already moved in near here this step, from the other side? */
function justTaken(w: World, target: number, at: number): boolean {
  const { bk } = w;
  return bk.changeTick[target] === w.tick && Math.abs(bk.changeAt[target] - at) < TAKEN_RANGE;
}

function idmAccel(w: World, v: number, sp: number, gap: number, leadV: number, v0: number): number {
  const { veh } = w;
  const a = veh.accel[v];
  const b = veh.decel[v];
  const r = sp / (v0 > 1 ? v0 : 1);
  const r2 = r * r;
  const free = a * (1 - r2 * r2);
  if (gap === Infinity) return free;
  const star = veh.minGap[v] + Math.max(0, sp * veh.headway[v] + (sp * (sp - leadV)) / (2 * Math.sqrt(a * b)));
  const g = gap > 0.1 ? gap : 0.1;
  return free - a * (star / g) * (star / g);
}

function doChange(w: World, v: number, target: number, at: number, toRight: boolean): void {
  const { veh, g, bk } = w;
  const from = veh.lane[v];
  if (veh.permit[v] >= 0) dropClaim(w, v);
  // The lane lists are from the start of the step. Anyone joining this lane behind
  // the vehicle later in the step reads the tail, so it must be current.
  const rear = at - veh.len[v];
  if (rear < bk.tailRear[target]) {
    bk.tailRear[target] = rear;
    bk.tailV[target] = veh.v[v];
  }
  bk.changeTick[target] = w.tick;
  bk.changeAt[target] = at;
  veh.lane[v] = target;
  veh.s[v] = at;
  veh.ptIdx[v] = 0;
  veh.nextLane[v] = -1;
  veh.lcFrom[v] = from;
  veh.lcSec[v] = LANE_CHANGE_SEC;
  // It finishes before the lane does: the ghost in the old lane cannot follow onto the next.
  const remaining = (g.len[target] - at) * 0.95;
  const wanted = Math.max(LANE_CHANGE_BASE_DIST + LANE_CHANGE_BODY_DISTS * veh.len[v], veh.v[v] * LANE_CHANGE_SEC);
  veh.lcLen[v] = wanted < remaining ? wanted : remaining;
  veh.lcCool[v] = LANE_CHANGE_COOLDOWN;
  veh.reqLane[v] = -1;
  veh.stratTick[v] = 0;
  // Offset in the right-vector sense: moving right, the vehicle starts to the left.
  const width = (g.graph.lanes[from].width + g.graph.lanes[target].width) / 2;
  veh.latStart[v] = toRight ? -width : width;
  veh.stopHold[v] = 0;
  veh.arriveTime[v] = -1;
  veh.waitSec[v] = 0;
}

function tryMandatory(w: World, v: number, dir: number, urgency: number): void {
  const { g, veh } = w;
  const l = veh.lane[v];
  const target = dir < 0 ? g.left[l] : g.right[l];
  if (target < 0 || !(g.allow[target] & allowBit(w, v)) || w.blocked[target]) {
    veh.reqLane[v] = -1;
    return;
  }
  const dest = veh.dest[v];
  if (dest < 0 || tableOf(w, v).cost[dest * g.n + target] === Infinity) {
    veh.reqLane[v] = -1;
    return;
  }
  if (veh.lcSec[v] > 0.6 || veh.s[v] < veh.len[v] + MIN_LANE_ENTRY) return;
  const at = (veh.s[v] * g.len[target]) / g.len[l];
  if (justTaken(w, target, at)) return;
  const length = veh.len[v];
  if (g.len[target] - at < laneChangeRoom(length)) return;
  lookAt(w, v, target, at, length);
  const sp = veh.v[v];
  const relaxed = 1 - urgency;
  // The margins for hesitation only matter at speed. In a stopped queue a body-sized
  // space is enough, and a driver who opened one must not be left waiting for more.
  const hurry = Math.min(1, Math.max(sp, backV) / 6);
  const needFront = 1.2 + relaxed * hurry * 3 + Math.max(0, sp - frontV) * (0.4 + relaxed * 0.8);
  const needBack = 1.2 + relaxed * hurry * 4 + Math.max(0, backV - sp) * (0.6 + relaxed * 0.9) + backV * 0.15 * relaxed;
  if (frontGap >= needFront && backGap >= needBack) {
    veh.seekV[v] = Infinity;
    doChange(w, v, target, at, dir > 0);
    return;
  }
  veh.reqLane[v] = urgency > 0.3 ? target : -1;
  // Nothing else gets to this destination, so fall in with the lane it needs while
  // there is still road left, rather than driving past the queue to its head.
  if (veh.needMust[v] && urgency > 0.15) {
    const near = frontGap < SEEK_RANGE ? (backGap < SEEK_RANGE ? Math.max(frontV, backV) : frontV) : backGap < SEEK_RANGE ? backV : -1;
    veh.seekV[v] = near >= 0 ? near + SEEK_MARGIN : Infinity;
  }
}

function tryDiscretionary(w: World, v: number): void {
  const { g, veh } = w;
  const l = veh.lane[v];
  const pos = veh.s[v];
  if (veh.lcCool[v] > 0 || g.len[l] - pos < NO_DISCRETIONARY_DIST || pos < veh.len[v] + MIN_LANE_ENTRY) return;
  const leftLane = g.left[l];
  const rightLane = g.right[l];
  if (leftLane < 0 && rightLane < 0) return;
  const sp = veh.v[v];
  const dest = veh.dest[v];
  if (dest < 0) return;
  const table = tableOf(w, v).cost;
  const base = dest * g.n;
  const here = table[base + l];
  const bit = allowBit(w, v);
  const v0 = g.speed[l] * veh.speedFactor[v];
  const aCur = veh.acc[v];
  const length = veh.len[v];

  for (let side = 0; side < 2; side++) {
    const target = side === 0 ? rightLane : leftLane;
    if (target < 0 || !(g.allow[target] & bit) || w.blocked[target]) continue;
    // Never for speed onto a lane that leads away from the route.
    if (!(table[base + target] <= here + LANE_CHANGE_COST_SEC * 0.34)) continue;
    const at = (pos * g.len[target]) / g.len[l];
    if (justTaken(w, target, at)) continue;
    lookAt(w, v, target, at, length);
    if (frontGap < 2.5 + Math.max(0, sp - frontV) * 1.2) continue;
    if (backGap < 3 + Math.max(0, backV - sp) * 1.5) continue;
    const aNew = idmAccel(w, v, sp, frontGap, frontV, v0);
    let loss = 0;
    if (backU >= 0) {
      const fNew = idmAccel(w, backU, backV, backGap, sp, g.speed[target] * veh.speedFactor[backU]);
      if (fNew < -MAX_FOLLOWER_BRAKE) continue;
      loss = Math.max(0, veh.acc[backU] - fNew);
    }
    const bias = side === 0 ? KEEP_RIGHT_BIAS : -KEEP_RIGHT_BIAS;
    if (aNew - aCur + bias - POLITENESS * loss > CHANGE_THRESHOLD) {
      doChange(w, v, target, at, side === 0);
      return;
    }
  }
}

export function laneChangePass(w: World): void {
  const { veh, g, tick } = w;
  const { live, lane, needDir, needDist, needCount, needMust, reqLane, lcSec, seekV } = veh;
  const count = veh.liveCount;
  for (let i = 0; i < count; i++) {
    const v = live[i];
    const l = lane[v];
    if (g.isConn[l]) {
      reqLane[v] = -1;
      seekV[v] = Infinity;
      continue;
    }
    const dir = needDir[v];
    if (dir !== 0) {
      const dist = needDist[v];
      const c = needCount[v] || 1;
      const reference = g.speed[l] > 8 ? g.speed[l] : 8;
      const startDist = (6 + 6 * c) * reference;
      if (dist < startDist) {
        if (((tick + v) & (MANDATORY_PERIOD_STEPS - 1)) === 0) {
          let urgency = 1 - dist / startDist;
          if (needMust[v] && dist < 60) urgency = 1;
          if (urgency < 0) urgency = 0;
          tryMandatory(w, v, dir, urgency);
        }
        continue;
      }
    }
    reqLane[v] = -1;
    seekV[v] = Infinity;
    if (lcSec[v] <= 0 && (tick + v) % DISCRETIONARY_PERIOD_STEPS === 0) tryDiscretionary(w, v);
  }
}
