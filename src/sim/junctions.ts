/**
 * Junction control: who may enter a connector. Everything here comes down to one
 * rule, enforced where vehicles cross lane boundaries: no vehicle enters a
 * connector that needs a permit without holding one. A permit is granted when the
 * control device allows it, the exit has room, and the vehicle's time through each
 * conflict point is clear of everyone it must respect.
 *
 * Holders are re-checked each step until they can no longer stop, so a yellow or a
 * car arriving late takes the permit back. Crossings are decided here; merges are
 * ordered afterwards by virtual leaders in merge.ts.
 *
 * Inside a junction every crossing is taken in order of entry: a vehicle may only
 * come in if it will reach each crossing after those already inside have left it,
 * and the guard in dynamics.ts holds it to that if they run late. Each vehicle then
 * waits only for earlier ones, so the wait graph has no cycles, which rules out the
 * pinwheel of four left turners each blocking the next.
 */
import { effectiveControl, type Id, type RoadNetwork, type SignalPlan } from '../core';
import { ENTRY_GHOST, ENTRY_REAL, ENTRY_REQUEST } from './buckets';
import { KIND_DIVERGE, KIND_MERGE, KIND_NEAR, KIND_SWEEP, TURN_LEFT, TURN_UTURN, type CompiledGraph } from './compiled';
import {
  COURTESY_QUEUE_LENGTH,
  COURTESY_WAIT_QUEUED_SEC,
  COURTESY_WAIT_SEC,
  CROSS_HEADWAY,
  CROSS_MARGIN,
  DT,
  EXIT_MOVING_SPEED,
  LONG_BODY,
  MERGE_HEADWAY,
  SIGNAL_DELAY_SEC,
  STOP_DELAY_SEC,
  STOP_SIGN_HOLD_SEC,
  STOPPED_DIST,
  STOPPED_SPEED,
  YIELD_DELAY_SEC,
} from './constants';
import { nextOf } from './pathing';
import { LIGHT_PERMISSIVE, LIGHT_PROTECTED, LIGHT_RED, LIGHT_YELLOW, type SignalSystem } from './signals';
import type { World } from './world';

export const CTL_NONE = 0;
export const CTL_PRIORITY = 1;
export const CTL_ALLSTOP = 2;
export const CTL_SIGNAL = 3;

const SIGN_STOP = 0;
const SIGN_YIELD = 1;
const SIGN_NONE = 2;
const SIGN_PRIORITY = 3;

/** Why a vehicle was last refused entry, in `veh.denied`. For debugging and overlays. */
export const DENY_NONE = 0;
export const DENY_LIGHT = 1;
export const DENY_STOP_SIGN = 2;
export const DENY_EXIT_FULL = 3;
export const DENY_OCCUPIED = 4;
export const DENY_CLAIMED = 5;
export const DENY_ARRIVAL = 6;
export const DENY_QUEUE_ORDER = 7;
export const DENY_BLOCKED = 8;

/** Braking a driver considers reasonable when deciding to stop for something. */
const COMFORT_STOP = 3.5;

/** Time to cover x from speed v, accelerating at a up to cap. */
export function timeToCover(x: number, v: number, a: number, cap: number): number {
  if (x <= 0) return 0;
  const top = cap > v ? cap : v;
  const t1 = (top - v) / a;
  const x1 = (v + top) * 0.5 * t1;
  if (x <= x1) return (Math.sqrt(v * v + 2 * a * x) - v) / a;
  return t1 + (x - x1) / (top > 0.5 ? top : 0.5);
}

export class JunctionSystem {
  ctl: Uint8Array;
  sign: Uint8Array;
  /** 1 for connectors that must be entered with a permit. */
  needPermit: Uint8Array;
  /** Routing penalty of each connector, seconds. */
  delay: Float64Array;
  /** Head of the list of vehicles holding a permit for each connector. */
  claimHead: Int32Array;

  constructor(g: CompiledGraph) {
    const n = g.n;
    this.ctl = new Uint8Array(n);
    this.sign = new Uint8Array(n).fill(SIGN_NONE);
    this.needPermit = new Uint8Array(n);
    this.delay = new Float64Array(n);
    this.claimHead = new Int32Array(n).fill(-1);
  }

  /** Read every node's control into per-connector arrays. */
  compile(net: RoadNetwork, g: CompiledGraph, sig: SignalSystem, previous: SignalSystem | null): void {
    const { ctl, sign, needPermit, delay } = this;
    for (const [nodeId, conns] of g.graph.connectorsAt) {
      if (!conns.length) continue;
      const ec = effectiveControl(net, nodeId);
      const kind =
        ec.kind === 'signal' ? CTL_SIGNAL : ec.kind === 'allStop' ? CTL_ALLSTOP : ec.kind === 'priority' ? CTL_PRIORITY : CTL_NONE;
      for (const c of conns) {
        ctl[c] = kind;
        const fromSeg = g.graph.lanes[g.fromLane[c]].segmentId;
        const s = ec.signs[fromSeg] ?? 'none';
        sign[c] = s === 'stop' ? SIGN_STOP : s === 'yield' ? SIGN_YIELD : s === 'priority' ? SIGN_PRIORITY : SIGN_NONE;
        needPermit[c] = kind !== CTL_NONE || g.lastCross[c] >= 0 ? 1 : 0;
        delay[c] =
          kind === CTL_SIGNAL
            ? SIGNAL_DELAY_SEC
            : kind === CTL_ALLSTOP || sign[c] === SIGN_STOP
              ? STOP_DELAY_SEC
              : sign[c] === SIGN_YIELD
                ? YIELD_DELAY_SEC
                : 0;
      }
      if (kind === CTL_SIGNAL) sig.add(net, g, nodeId, ec.signal as SignalPlan, conns, previous);
    }
  }
}

export function addClaim(w: World, v: number, c: number, d: number): void {
  const { veh, jn, bk, g } = w;
  veh.permit[v] = c;
  veh.permitDist[v] = d;
  const head = jn.claimHead[c];
  veh.claimNext[v] = head;
  veh.claimPrev[v] = -1;
  if (head >= 0) veh.claimPrev[head] = v;
  jn.claimHead[c] = v;
  bk.reserve[g.toLane[c]] += veh.len[v] + 2;
}

export function dropClaim(w: World, v: number): void {
  const { veh, jn, bk, g } = w;
  const c = veh.permit[v];
  if (c < 0) return;
  const p = veh.claimPrev[v];
  const n = veh.claimNext[v];
  if (p >= 0) veh.claimNext[p] = n;
  else jn.claimHead[c] = n;
  if (n >= 0) veh.claimPrev[n] = p;
  veh.permit[v] = -1;
  bk.reserve[g.toLane[c]] -= veh.len[v] + 2;
}

/** +1 when c outranks d, -1 when c must give way to d, 0 when neither does. */
function relation(w: World, c: number, d: number): number {
  const { jn, g, sig } = w;
  if (jn.ctl[c] === CTL_SIGNAL) {
    const a = sig.state[c];
    const b = sig.state[d];
    if (b <= LIGHT_YELLOW) return 1;
    if (a === LIGHT_PROTECTED && b === LIGHT_PERMISSIVE) return 1;
    if (a === LIGHT_PERMISSIVE && b === LIGHT_PROTECTED) return -1;
  } else {
    const a = jn.sign[c];
    const b = jn.sign[d];
    if (a !== b) return a > b ? 1 : -1;
  }
  const ca = g.turn[c] === TURN_LEFT || g.turn[c] === TURN_UTURN;
  const cb = g.turn[d] === TURN_LEFT || g.turn[d] === TURN_UTURN;
  if (ca !== cb) return ca ? -1 : 1;
  return 0;
}

/** Has this vehicle waited long enough to be let out, given the queue behind it? */
function isBoosted(w: World, u: number, c: number): boolean {
  const wait = w.veh.waitSec[u];
  if (wait <= COURTESY_WAIT_QUEUED_SEC) return false;
  if (wait > COURTESY_WAIT_SEC) return true;
  return w.bk.count[w.g.fromLane[c]] >= COURTESY_QUEUE_LENGTH;
}

function roomOnExit(w: World, v: number, c: number): boolean {
  const { g, veh, bk } = w;
  const x = g.toLane[c];
  const held = veh.permit[v] === c ? veh.len[v] + 2 : 0;
  const reserved = bk.reserve[x] - held;
  const tail = bk.tailRear[x];
  // Space past the last crossing point counts: queueing there blocks nothing.
  const slack = g.lastCross[c] >= 0 ? g.len[c] - g.lastCross[c] - CROSS_MARGIN : g.len[c];
  if (tail === Infinity && reserved <= 0.01) return true;
  const need = Math.min(veh.len[v] + 1, g.len[x] + Math.max(slack, 0));
  const open = (tail === Infinity ? g.len[x] : Math.min(tail, g.len[x])) + Math.max(slack, 0) - reserved;
  if (open >= need) return true;
  return tail !== Infinity && tail > 0 && bk.tailV[x] > EXIT_MOVING_SPEED && reserved <= veh.len[v] + 2;
}

/** Does a vehicle arriving through [tin, tout] clear my window, in either order? */
function windowsDisjoint(arrive: number, clear: number, tin: number, tout: number, headway: number): boolean {
  return clear + headway < tin || arrive > tout + headway;
}

/** Next arrival on `lane` heading for connector d within the window. Depth bounds upstream walking. */
function arrivalClashes(
  w: World,
  lane: number,
  d: number,
  toConflict: number,
  arrive: number,
  clear: number,
  headway: number,
  depth: number,
): boolean {
  const { g, veh, bk } = w;
  const { eV, eS, eT, start } = bk;
  const cap = g.speed[d];
  const a = start[lane];
  const b = start[lane + 1];
  for (let e = a; e < b; e++) {
    if (eT[e] !== ENTRY_REAL) continue;
    const u = eV[e];
    if (depth === 0) {
      if (nextOf(w, u) !== d) continue;
    }
    const dist = g.len[lane] - eS[e] + toConflict;
    // A driver stopped at the line and refused entry is no threat yet.
    if (veh.v[u] < 1 && veh.waitSec[u] > 0.5 && veh.permit[u] !== d) continue;
    const tin = timeToCover(dist - CROSS_MARGIN, veh.v[u], veh.accel[u], Math.max(cap, g.speed[lane]));
    if (tin > clear + headway) return false;
    return true;
  }
  if (depth < 2) {
    const reach = (clear + headway) * g.speed[lane];
    if (g.len[lane] + toConflict > reach) return false;
    const { prevStart, prevList } = g;
    for (let k = prevStart[lane]; k < prevStart[lane + 1]; k++) {
      if (arrivalClashes(w, prevList[k], d, toConflict + g.len[lane], arrive, clear, headway, depth + 1)) return true;
    }
  }
  return false;
}

/** May this vehicle, d metres from connector c, enter it? Keeps or changes its permit. */
export function evaluate(w: World, v: number, c: number, d: number): boolean {
  const { g, veh, jn, sig, bk, tick } = w;
  const speed = veh.v[v];
  const held = veh.permit[v] === c;
  const brakeNeeded = (speed * speed) / (2 * Math.max(d, 0.1));

  const near = d < STOPPED_DIST && speed < STOPPED_SPEED;
  if (near) {
    veh.stopHold[v] += DT;
    if (veh.arriveTime[v] < 0) veh.arriveTime[v] = w.time;
  }

  const ctl = jn.ctl[c];
  let ok = true;
  let sneaking = false;
  veh.denied[v] = DENY_NONE;
  if (w.blocked[c]) {
    ok = false;
    veh.denied[v] = DENY_BLOCKED;
  }
  if (!ok) {
    // Closed from outside: nothing else to check.
  } else if (ctl === CTL_SIGNAL) {
    const light = sig.state[c];
    if (light === LIGHT_RED) {
      ok = false;
      veh.denied[v] = DENY_LIGHT;
    } else if (light === LIGHT_YELLOW) {
      const left = sig.yellowLeft(g.nodeId[c]);
      const eta = timeToCover(d, speed, veh.accel[v], g.speed[c]);
      sneaking = near && veh.waitSec[v] > 2;
      // Time-based, so a driver never reaches the line after it turns red.
      if (eta > left - DT && !sneaking) {
        ok = false;
        veh.denied[v] = DENY_LIGHT;
      }
    }
  } else if (ctl === CTL_ALLSTOP || jn.sign[c] === SIGN_STOP) {
    if (veh.stopHold[v] < STOP_SIGN_HOLD_SEC) {
      ok = false;
      veh.denied[v] = DENY_STOP_SIGN;
    }
  }

  if (ok && !roomOnExit(w, v, c)) {
    ok = false;
    veh.denied[v] = DENY_EXIT_FULL;
  }
  if (ok) veh.readyTick[v] = tick;
  if (ok) ok = conflictsClear(w, v, c, d);

  // A holder that can no longer stop keeps its permit, unless the light is red.
  if (!ok && held && brakeNeeded > COMFORT_STOP && !w.blocked[c] && !(ctl === CTL_SIGNAL && sig.state[c] === LIGHT_RED)) {
    veh.permitDist[v] = d;
    return true;
  }
  if (ok) {
    if (!held) addClaim(w, v, c, d);
    else veh.permitDist[v] = d;
    return true;
  }
  if (held) dropClaim(w, v);
  if (near || speed < 2) veh.waitSec[v] += DT;
  return false;
}

function conflictsClear(w: World, v: number, c: number, d: number): boolean {
  const { g, veh, jn, sig, bk } = w;
  const { confStart, confLane, confSelf, confOther, confKind, speed: laneSpeed, len: laneLen } = g;
  const { eV, eS, eT, start } = bk;
  const k0 = confStart[c];
  const k1 = confStart[c + 1];
  if (k0 === k1) return true;

  const speed = veh.v[v];
  const accel = veh.accel[v];
  const myLen = veh.len[v];
  const cap = laneSpeed[c];
  const boosted = isBoosted(w, v, c);
  const allStop = jn.ctl[c] === CTL_ALLSTOP;

  for (let k = k0; k < k1; k++) {
    const kind = confKind[k];
    if (kind === KIND_DIVERGE) continue;
    const other = confLane[k];
    const selfS = confSelf[k];
    const otherS = confOther[k];
    const merge = kind === KIND_MERGE;
    const sweep = kind === KIND_SWEEP;
    // A swept or near conflict is about bodies, so there is no right of way in it: first in.
    let rel = sweep || kind === KIND_NEAR ? 0 : relation(w, c, other);
    if (boosted && rel < 0) rel = 1;
    if (merge && rel >= 0 && jn.ctl[c] === CTL_NONE) continue;

    const arrive = timeToCover(d + selfS - CROSS_MARGIN, speed, accel, cap);
    const clear = timeToCover(d + selfS + CROSS_MARGIN + myLen, speed, accel, cap);
    const headway = merge ? MERGE_HEADWAY : CROSS_HEADWAY;

    // Vehicles already on the other connector, including tails of ones that left it.
    const a = start[other];
    const b = start[other + 1];
    for (let e = a; e < b; e++) {
      if (eT[e] === ENTRY_REQUEST || eT[e] === ENTRY_GHOST) continue;
      const u = eV[e];
      const rear = eS[e] - veh.len[u];
      if (rear > otherS + CROSS_MARGIN) continue;
      if (merge && rel >= 0) continue;
      if (sweep && myLen < LONG_BODY && veh.len[u] < LONG_BODY) continue;
      // Whoever is already inside goes first, even if it has yet to reach this point.
      // Entry order is what makes a deadlock impossible, so nobody may jump it. A
      // stopped vehicle gives no clue when it will clear, so it simply blocks.
      const vu = veh.v[u];
      if (vu < 0.5 || arrive < (otherS + CROSS_MARGIN - rear) / (vu > 1.5 ? vu : 1.5) + headway) {
        veh.denied[v] = DENY_OCCUPIED;
        return false;
      }
    }

    // Vehicles holding a permit for it.
    for (let u = jn.claimHead[other]; u >= 0; u = veh.claimNext[u]) {
      const du = veh.permitDist[u];
      const vu = veh.v[u];
      const committed = (vu * vu) / (2 * Math.max(du, 0.1)) > COMFORT_STOP;
      // Outranking someone only counts if they have not been waiting too long.
      if (rel > 0 && !committed && !isBoosted(w, u, other)) continue;
      if (merge && rel >= 0) continue;
      if (sweep && myLen < LONG_BODY && veh.len[u] < LONG_BODY) continue;
      const aU = veh.accel[u];
      const capU = laneSpeed[other];
      const tin = timeToCover(du + otherS - CROSS_MARGIN, vu, aU, capU);
      const tout = timeToCover(du + otherS + CROSS_MARGIN + veh.len[u], vu, aU, capU);
      if (!windowsDisjoint(arrive, clear, tin, tout, headway)) {
        veh.denied[v] = DENY_CLAIMED;
        return false;
      }
    }

    // Vehicles still coming that I have to give way to.
    if (rel < 0) {
      const closing = merge ? Math.max(0, laneSpeed[g.fromLane[other]] - cap) * 0.12 : 0;
      if (arrivalClashes(w, g.fromLane[other], other, otherS, arrive, clear, headway + closing, 0)) {
        veh.denied[v] = DENY_ARRIVAL;
        return false;
      }
    }

    // All-way stop: first to arrive goes first, if it is actually able to.
    if (allStop) {
      const from = g.fromLane[other];
      const fa = start[from];
      const fb = start[from + 1];
      for (let e = fa; e < fb; e++) {
        if (eT[e] !== ENTRY_REAL) continue;
        const u = eV[e];
        if (laneLen[from] - eS[e] < STOPPED_DIST + 1 && veh.nextLane[u] === other) {
          const mine = veh.arriveTime[v];
          const theirs = veh.arriveTime[u];
          const earlier = theirs >= 0 && (theirs < mine || (theirs === mine && veh.id[u] < veh.id[v]));
          if (earlier && veh.readyTick[u] >= w.tick - 1) {
            veh.denied[v] = DENY_QUEUE_ORDER;
            return false;
          }
        }
        break;
      }
    }
  }
  return true;
}


