/** Car following and motion: the per-vehicle hot path. No allocation in here. */
import { ENTRY_GHOST, ENTRY_REAL, ENTRY_REQUEST } from './buckets';
import { KIND_DIVERGE, KIND_MERGE, KIND_SWEEP } from './compiled';
import {
  CLEAR_MARGIN,
  DT,
  LANE_CHANGE_SEC,
  LONG_BODY,
  MAX_DECEL,
  MUST_TAKE_LAST_STRETCH,
  MUST_TAKE_PATIENCE_SEC,
  PLAN_DECEL,
  STOP_GAP_BONUS,
  YIELD_PATIENCE_SEC,
} from './constants';
import { CTL_SIGNAL, DENY_BLOCKED, DENY_LIGHT, DENY_NONE, dropClaim, evaluate } from './junctions';
import { laneChangeRoom } from './laneChange';
import { allowBit, nextOf, pickNext, retarget, sinkOn, tableOf } from './pathing';
import { LIGHT_RED } from './signals';
import type { World } from './world';
import { freeVehicle } from './vehicles';

/** Half length of the crossing zone a connector vehicle holds short of. */
const GUARD_MARGIN = 2.5;
const GUARD_RANGE = 30;
/** How far past the hold point, in metres, the guard may still act: about half a car's width short of the other path. */
const GUARD_LAST_CHANCE = -1.3;
/** Moving this far resets the stuck timer. */
const STUCK_PROGRESS = 2;

// Results of walkAhead and guard, kept out of the heap.
let outGap = Infinity;
let outLeadV = 0;
let outHard = Infinity;
let outStop = Infinity;

/** IDM with a fixed free-road term. */
function idm(free: number, v: number, gap: number, dv: number, a: number, b: number, T: number, s0: number): number {
  let star = v * T + (v * dv) / (2 * Math.sqrt(a * b));
  star = star > 0 ? s0 + star : s0;
  const g = gap > 0.1 ? gap : 0.1;
  const r = star / g;
  return free - a * r * r;
}

function requestReach(v: number, decel: number): number {
  return (v * v) / (2 * decel) + v * 0.8 + 6;
}

/** Distance to wait at, given a point some way short of the end of the lane. */
function waitPoint(d: number, back: number): number {
  const at = d - back;
  return at > 0.05 ? at : d < 0.05 ? d : 0.05;
}

/** What the first vehicle on a lane finds beyond its lane end. */
function walkAhead(w: World, v: number, lane: number, pos: number, sp: number): void {
  const { g, veh, bk, jn } = w;
  const { len: laneLen, isConn } = g;
  outGap = Infinity;
  outLeadV = 0;
  outHard = Infinity;
  outStop = Infinity;
  const sink = sinkOn(w, v, lane);
  if (sink >= 0 && sink >= pos) return;
  let d = laneLen[lane] - pos;
  const reach = requestReach(sp, veh.decel[v]);
  const horizon = (sp * 5 > reach ? sp * 5 : reach) + 30;
  let cur = lane;
  let nxt = nextOf(w, v);
  let permitSeen = false;
  if (veh.denied[v] === DENY_BLOCKED) veh.denied[v] = DENY_NONE;
  for (let hop = 0; hop < 8; hop++) {
    if (d > horizon) return;
    if (nxt < 0) {
      if (hop > 0 && sinkOn(w, v, cur) >= 0) return;
      // Stop with enough lane left to change out of it.
      outStop = waitPoint(d, laneChangeRoom(veh.len[v]));
      // Waiting at the end of the lane for a gap that is not coming.
      if (hop === 0 && d < MUST_TAKE_LAST_STRETCH + laneChangeRoom(veh.len[v]) && sp < 2) {
        veh.mustWait[v] += DT;
        if (veh.mustWait[v] > MUST_TAKE_PATIENCE_SEC) giveUpOnLane(w, v, lane);
      }
      return;
    }
    if (w.blocked[nxt]) {
      if (veh.permit[v] === nxt) dropClaim(w, v);
      veh.denied[v] = DENY_BLOCKED;
      outStop = waitPoint(d, g.setback[cur]);
      return;
    }
    if (isConn[nxt] && jn.needPermit[nxt]) {
      if (permitSeen) {
        // One junction at a time. A second one close behind waits at its own line.
        return;
      }
      permitSeen = true;
      if (d <= reach || veh.permit[v] === nxt) {
        if (!evaluate(w, v, nxt, d)) {
          outStop = waitPoint(d, g.setback[cur]);
          return;
        }
      } else if (veh.permit[v] >= 0) {
        dropClaim(w, v);
      }
    }
    const tail = bk.tailRear[nxt];
    if (tail !== Infinity) {
      outGap = d + tail;
      outHard = outGap;
      outLeadV = bk.tailV[nxt];
      return;
    }
    d += laneLen[nxt];
    cur = nxt;
    nxt = pickNext(w, v, cur);
    if (sinkOn(w, v, cur) >= 0) return;
  }
}

/**
 * Inside a junction: hold short of a crossing until everyone who entered earlier has
 * cleared it, and follow a vehicle on a branch that has not yet separated from this.
 */
function guard(w: World, v: number, c: number, pos: number): void {
  const { g, veh, bk } = w;
  const { confStart, confLane, confSelf, confOther, confKind } = g;
  const { start, eV, eS, eT } = bk;
  outGap = Infinity;
  outLeadV = 0;
  outStop = Infinity;
  const k0 = confStart[c];
  const k1 = confStart[c + 1];
  for (let k = k0; k < k1; k++) {
    const kind = confKind[k];
    const selfS = confSelf[k];
    if (kind === KIND_DIVERGE) {
      if (pos > selfS) continue;
      const other = confLane[k];
      for (let e = start[other + 1] - 1; e >= start[other]; e--) {
        // Tails of vehicles that have left the other branch are bodies too.
        if (eT[e] === ENTRY_GHOST || eT[e] === ENTRY_REQUEST) continue;
        const u = eV[e];
        const gap = eS[e] - veh.len[u] - pos;
        if (eS[e] <= pos) continue;
        if (gap < outGap) {
          outGap = gap;
          outLeadV = veh.v[u];
        }
        break;
      }
    } else if (kind !== KIND_MERGE) {
      // Past the hold point the guard still works, until the nose reaches the other path.
      const toZone = selfS - GUARD_MARGIN - pos;
      if (toZone < GUARD_LAST_CHANCE || toZone > GUARD_RANGE) continue;
      const hold = toZone > 0.05 ? toZone : 0.05;
      const other = confLane[k];
      const otherS = confOther[k];
      const a = start[other];
      const b = start[other + 1];
      const mine = veh.enterTick[v];
      const sweep = kind === KIND_SWEEP;
      const myLen = veh.len[v];
      for (let e = a; e < b; e++) {
        if (eT[e] === ENTRY_REQUEST || eT[e] === ENTRY_GHOST) continue;
        const u = eV[e];
        if (u === v || eS[e] - veh.len[u] > otherS + GUARD_MARGIN) continue;
        if (sweep && myLen < LONG_BODY && veh.len[u] < LONG_BODY) continue;
        // Crossings go in order of entry. A later arrival matters only once it is
        // past its own last chance to stop, which the order then cannot undo.
        const theirs = veh.enterTick[u];
        const earlier = theirs < mine || (theirs === mine && veh.id[u] < veh.id[v]);
        if (earlier || eS[e] >= otherS - GUARD_MARGIN - GUARD_LAST_CHANCE) {
          if (hold < outStop) outStop = hold;
        }
      }
    }
  }
}

export function accelPass(w: World): void {
  const { g, veh, bk, tick } = w;
  const { n, len: laneLen, isConn, prof, profStart, confStart } = g;
  const { start, eV, eS, eT } = bk;
  const { s, v: speed, len, accel, decel, headway, minGap, maxSpeed, speedFactor, limitV, limitD, acc, gapHard } = veh;
  const { vlTick, vlGap, vlV, vlFloor, seekV, yieldSec, lcFrom } = veh;

  for (let l = 0; l < n; l++) {
    const a = start[l];
    const b = start[l + 1];
    if (a === b) continue;
    const pa = profStart[l];
    const steps = profStart[l + 1] - pa - 1;
    const perMetre = steps / laneLen[l];
    const conn = isConn[l] === 1 && confStart[l] !== confStart[l + 1];
    let seenReal = false;
    for (let e = a; e < b; e++) {
      if (eT[e] !== ENTRY_REAL) continue;
      const v = eV[e];
      const pos = s[v];
      const sp = speed[v];
      const ai = accel[v];
      const bi = decel[v];
      const T = headway[v];
      const s0 = minGap[v];

      // The entry in front on this lane. A ghost is followed but does not end the
      // search: it can sit inside the body of a long vehicle further ahead.
      let gap = Infinity;
      let leadV = 0;
      let hard = Infinity;
      for (let k = e - 1; k >= a; k--) {
        const u = eV[k];
        if (u === v) continue;
        const t = eT[k];
        const gk = eS[k] - len[u] - pos;
        if (t === ENTRY_REQUEST) {
          // Let someone in only if they are clearly ahead and it takes no hard braking,
          // and not for ever: they may be waiting on something else entirely.
          if (gk < 1.5 || yieldSec[v] > YIELD_PATIENCE_SEC) continue;
          const vu = speed[u];
          if ((sp * sp - vu * vu) / (2 * gk) > 2.5) continue;
          if (sp < 0.5) yieldSec[v] += DT;
          if (gk < gap) {
            gap = gk;
            leadV = vu;
          }
          continue;
        }
        if (gk < gap) {
          gap = gk;
          leadV = speed[u];
        }
        // A ghost is a real body part-way across this lane, so it is solid too.
        if (gk < hard) hard = gk;
        if (t !== ENTRY_GHOST) break;
      }

      // Until a lane change finishes the body is still partly in the old lane.
      const from = lcFrom[v];
      if (from >= 0) {
        const at = (pos * laneLen[from]) / laneLen[l];
        for (let k = start[from + 1] - 1; k >= start[from]; k--) {
          if (eS[k] <= at || eT[k] === ENTRY_REQUEST) continue;
          const u = eV[k];
          if (u === v) continue;
          const gk = eS[k] - len[u] - at;
          if (gk < gap) {
            gap = gk;
            leadV = speed[u];
          }
          if (gk < hard) hard = gk;
          break;
        }
      }

      // Desired speed: the limit here, what the bends allow, and what is coming.
      let idx = ((pos * perMetre) | 0) + 1;
      if (idx > steps) idx = steps;
      if (idx < 0) idx = 0;
      let v0 = prof[pa + idx];
      const lv = limitV[v];
      if (lv < v0) {
        const ld = limitD[v];
        const allowed = ld > 0 ? Math.sqrt(lv * lv + 2 * PLAN_DECEL * ld) : lv;
        if (allowed < v0) v0 = allowed;
      }
      v0 *= speedFactor[v];
      if (v0 > maxSpeed[v]) v0 = maxSpeed[v];
      if (v0 > seekV[v]) v0 = seekV[v];
      if (v0 < 1) v0 = 1;

      let free: number;
      if (sp <= v0) {
        const r = sp / v0;
        const r2 = r * r;
        free = ai * (1 - r2 * r2);
      } else {
        // Over the target: close the difference briskly, so bends are met at speed.
        free = (v0 - sp) * 1.2;
        if (free < -bi) free = -bi;
      }

      let out = free;
      if (gap !== Infinity) {
        const x = idm(free, sp, gap, sp - leadV, ai, bi, T, s0);
        if (x < out) out = x;
      }

      if (!seenReal) {
        walkAhead(w, v, l, pos, sp);
        if (outGap !== Infinity) {
          const x = idm(free, sp, outGap, sp - outLeadV, ai, bi, T, s0);
          if (x < out) out = x;
          if (outHard < hard) hard = outHard;
        }
        if (outStop !== Infinity) {
          const x = idm(free, sp, outStop + STOP_GAP_BONUS, sp, ai, bi, T, s0);
          if (x < out) out = x;
        }
      }

      if (conn) {
        guard(w, v, l, pos);
        if (outGap !== Infinity) {
          const x = idm(free, sp, outGap, sp - outLeadV, ai, bi, T, s0);
          if (x < out) out = x;
          // A body on a branch that has not separated yet is as solid as one ahead.
          if (outGap < hard) hard = outGap;
        }
        if (outStop !== Infinity) {
          const x = idm(free, sp, outStop + STOP_GAP_BONUS, sp, ai, bi, T, s0);
          if (x < out) out = x;
        }
      }

      if (vlTick[v] === tick) {
        const x = idm(free, sp, vlGap[v], sp - vlV[v], ai, bi, T, s0);
        const floor = vlFloor[v];
        const limited = x < floor ? floor : x;
        if (limited < out) out = limited;
      }

      if (out < -MAX_DECEL) out = -MAX_DECEL;
      acc[v] = out;
      gapHard[v] = hard;
      seenReal = true;
    }
  }
}

function remove(w: World, v: number): void {
  const { veh } = w;
  if (veh.permit[v] >= 0) dropClaim(w, v);
  freeVehicle(veh, v);
}

export interface ArrivalSink {
  onArrive(w: World, v: number): void;
  onSegmentEnter(seg: number): void;
}

/** A vehicle held at the end of a lane it may not leave. */
function hold(w: World, v: number, lane: number): void {
  const { veh, g } = w;
  veh.s[v] = g.len[lane] - 0.02;
  if (veh.v[v] > 1) w.counters.forcedStops++;
  veh.v[v] = 0;
}

function giveUpOnLane(w: World, v: number, lane: number): void {
  const { g, veh } = w;
  const { nextStart, nextList, allow } = g;
  const bit = allowBit(w, v);
  const old = veh.dest[v];
  for (let k = nextStart[lane]; k < nextStart[lane + 1]; k++) {
    const n = nextList[k];
    if (!(allow[n] & bit)) continue;
    retarget(w, v, n);
    if (veh.dest[v] >= 0) {
      veh.nextLane[v] = n;
      w.counters.missedExits++;
      return;
    }
    veh.dest[v] = old;
  }
  veh.mustWait[v] = 0;
}

/** Move a vehicle whose front passed the end of its lane. Returns false if it was removed. */
function crossLanes(w: World, v: number, sink: ArrivalSink): boolean {
  const { g, veh, bk, jn, sig } = w;
  const { len: laneLen, isConn, segIdx } = g;
  for (let guardHops = 0; guardHops < 6; guardHops++) {
    const l = veh.lane[v];
    let over = veh.s[v] - laneLen[l];
    if (over < 0) return true;
    let n = nextOf(w, v);
    if (n < 0) {
      n = pickNext(w, v, l);
      veh.nextLane[v] = n;
    }
    if (n < 0) {
      const dest = veh.dest[v];
      const table = tableOf(w, v);
      const noRoute = dest < 0 || table.cost[dest * g.n + l] === Infinity;
      if (noRoute && g.nextStart[l] === g.nextStart[l + 1]) {
        remove(w, v);
        w.counters.removedUnroutable++;
        return false;
      }
      if (noRoute) retarget(w, v, l);
      hold(w, v, l);
      return true;
    }
    if (w.blocked[n]) {
      if (veh.permit[v] === n) dropClaim(w, v);
      hold(w, v, l);
      return true;
    }
    if (isConn[n]) {
      if ((jn.needPermit[n] && veh.permit[v] !== n) || (jn.ctl[n] === CTL_SIGNAL && sig.state[n] === LIGHT_RED)) {
        if (veh.permit[v] === n) dropClaim(w, v);
        hold(w, v, l);
        return true;
      }
    }
    const tail = bk.tailRear[n];
    if (tail !== Infinity && over > tail - CLEAR_MARGIN) {
      over = tail - CLEAR_MARGIN;
      if (over < 0) {
        const lead = bk.tailV[n];
        veh.s[v] = laneLen[l] - 0.02;
        if (veh.v[v] > lead) veh.v[v] = lead;
        return true;
      }
    }
    if (veh.permit[v] === n) dropClaim(w, v);
    else if (veh.permit[v] >= 0) dropClaim(w, v);
    veh.prev2[v] = veh.prev1[v];
    veh.prev1[v] = l;
    veh.lane[v] = n;
    veh.s[v] = over;
    veh.ptIdx[v] = 0;
    veh.nextLane[v] = -1;
    veh.stopHold[v] = 0;
    veh.arriveTime[v] = -1;
    veh.waitSec[v] = 0;
    veh.mustWait[v] = 0;
    veh.stratTick[v] = 0;
    veh.lcFrom[v] = -1;
    veh.reqLane[v] = -1;
    if (isConn[n]) veh.enterTick[v] = w.tick;
    veh.denied[v] = DENY_NONE;
    const rear = over - veh.len[v];
    if (rear < bk.tailRear[n]) {
      bk.tailRear[n] = rear;
      bk.tailV[n] = veh.v[v];
    }
    if (!isConn[n]) sink.onSegmentEnter(segIdx[n]);
    if (over < laneLen[n]) return true;
  }
  return true;
}

export function integrate(w: World, sink: ArrivalSink): void {
  const { veh, bk, routes, g } = w;
  const { order } = bk;
  const { alive, acc, s, gapHard, lcSec, lcCool, stuckSec, stuckProgress, needDist, limitD, permitDist, lcFrom, lane, denied } = veh;
  const speed = veh.v;
  const { len: laneLen } = g;
  const { sinkFlag } = routes;
  const count = bk.orderCount;
  const stuckLimit = w.net.traffic.despawnStuckSec;

  for (let i = 0; i < count; i++) {
    const v = order[i];
    if (!alive[v]) continue;
    const sp = speed[v];
    let nv = sp + acc[v] * DT;
    if (nv < 0) nv = 0;
    let ds = (sp + nv) * 0.5 * DT;
    const room = gapHard[v] - CLEAR_MARGIN;
    if (ds > room) {
      ds = room > 0 ? room : 0;
      const cap = ds / DT;
      if (nv > cap) nv = cap;
    }
    const pos = s[v] + ds;
    s[v] = pos;
    speed[v] = nv;
    needDist[v] -= ds;
    limitD[v] -= ds;
    permitDist[v] -= ds;
    if (lcSec[v] > 0) {
      // Across the lane in step with distance along it, so a stopped vehicle stays put.
      lcSec[v] -= (ds * LANE_CHANGE_SEC) / veh.lcLen[v];
      if (lcSec[v] <= 0) lcFrom[v] = -1;
    }
    if (lcCool[v] > 0) lcCool[v] -= DT;

    // Stuck means no progress, so a slow queue creeping forward does not count, and
    // nor does waiting at a red light or a closed lane, which is not being stuck.
    if (denied[v] !== DENY_LIGHT && denied[v] !== DENY_BLOCKED) stuckSec[v] += DT;
    stuckProgress[v] += ds;
    if (stuckProgress[v] > STUCK_PROGRESS) {
      stuckProgress[v] = 0;
      stuckSec[v] = 0;
      veh.yieldSec[v] = 0;
    }
    if (stuckLimit > 0 && stuckSec[v] > stuckLimit) {
      remove(w, v);
      w.counters.despawnedStuck++;
      continue;
    }

    const l = lane[v];
    if (sinkFlag[l]) {
      const at = sinkOn(w, v, l);
      if (at >= 0 && pos >= at && pos - ds <= at + 0.01 + (laneLen[l] - at)) {
        sink.onArrive(w, v);
        remove(w, v);
        w.counters.arrived++;
        continue;
      }
    }
    if (pos >= laneLen[l]) crossLanes(w, v, sink);
  }
}
