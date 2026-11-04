/**
 * Merge ordering. All vehicles about to join a lane from different feeders are put
 * in one total order, and each follows the one before it, projected from the other
 * feeder. A total order has no cycles, which is why zipper merges cannot deadlock.
 *
 * Vehicles still approaching order by time to the merge point. Once inside, that would
 * fight the rule that crossings go in order of entry: a car waiting at a
 * crossing for one that entered earlier could be the leader of that very car here,
 * by way of a third, and all three would sit still with an empty road ahead. So inside
 * the order is entry order too, except that a vehicle already past the merge point
 * goes first, because its body is physically in the way.
 */
import { ENTRY_REAL, ENTRY_REAR } from './buckets';
import { DT, FREE_MERGE_HORIZON, LONG_BODY, MAX_DECEL } from './constants';
import { CTL_NONE } from './junctions';
import { nextOf } from './pathing';
import type { World } from './world';

const MAX_LIST = 128;
const listV = new Int32Array(MAX_LIST);
const listD = new Float64Array(MAX_LIST);
const listKey = new Float64Array(MAX_LIST);
const listEta = new Float64Array(MAX_LIST);
const listF = new Int32Array(MAX_LIST);
const listHold = new Float64Array(MAX_LIST);

/**
 * Speeds below this rank as this, so in slow traffic the order is simply distance
 * and feeders alternate. Above it the faster vehicle arrives first and leads. With
 * too low a floor, a stopped queue loses to every moving car on the other feeder.
 */
const ORDER_SPEED_FLOOR = 12;
/** Sort key of vehicles past the merge point, ahead of everything keyed by entry step. */
const PAST_BASE = -1e9;
/** Sort key base for permit holders, after everyone inside. */
const HOLDER_BASE = 1e9;
/** Extra room behind a long leader at a merge, metres. */
const LONG_LEADER_MARGIN = 5;

function etaOf(d: number, v: number): number {
  return d / (v > ORDER_SPEED_FLOOR ? v : ORDER_SPEED_FLOOR);
}

export function mergePass(w: World): void {
  const { g, veh, bk, jn, tick } = w;
  const { mergeLanes, prevStart, prevList, isConn, fromLane, len: laneLen, mergeFrom } = g;
  const { start, eV, eS, eT } = bk;
  const { v: speed, permitDist, len, vlGap, vlV, vlFloor, vlTick, id, enterTick } = veh;

  for (let i = 0; i < mergeLanes.length; i++) {
    const x = mergeLanes[i];
    let count = 0;
    // An edge merge (core/edgeMerge.ts): the highway lane runs straight into x as a road
    // lane, with no junction box and no crossings. Everyone then goes by time to the merge
    // point, which keeps the order in step with where vehicles actually are.
    let edge = false;
    for (let k = prevStart[x]; k < prevStart[x + 1]; k++) if (!isConn[prevList[k]]) edge = true;
    for (let k = prevStart[x]; k < prevStart[x + 1]; k++) {
      const c = prevList[k];
      if (!isConn[c]) {
        for (let e = start[c]; e < start[c + 1]; e++) {
          if (eT[e] !== ENTRY_REAL || count >= MAX_LIST) continue;
          const toEnd = laneLen[c] - eS[e];
          if (toEnd > FREE_MERGE_HORIZON) break;
          const u = eV[e];
          if (nextOf(w, u) !== x) continue;
          const eta = etaOf(toEnd, speed[u]);
          const zone = laneLen[c] - mergeFrom[c];
          listV[count] = u;
          listD[count] = toEnd;
          listEta[count] = eta;
          listKey[count] = toEnd <= zone ? PAST_BASE + toEnd : tick + eta / DT;
          listHold[count] = toEnd - zone;
          listF[count++] = k;
        }
        continue;
      }
      const free = jn.ctl[c] === CTL_NONE;
      const zone = laneLen[c] - mergeFrom[c];
      for (let e = start[c]; e < start[c + 1]; e++) {
        // A tail still on the feeder belongs to a body past the merge, and leads.
        const t = eT[e];
        if ((t !== ENTRY_REAL && t !== ENTRY_REAR) || count >= MAX_LIST) continue;
        const u = eV[e];
        const d = laneLen[c] - eS[e];
        const eta = etaOf(d, speed[u]);
        listV[count] = u;
        listD[count] = d;
        listEta[count] = eta;
        // Past the merge point the body is in the way, whatever else: distance decides.
        // Inside, entry order decides, free merge or not, so that it agrees with the
        // guard; anything else lets two vehicles each defer to the other.
        listKey[count] = d <= zone ? PAST_BASE + d : edge ? tick + eta / DT : enterTick[u];
        listHold[count] = d - zone;
        listF[count++] = k;
      }
      if (free) {
        const from = fromLane[c];
        const horizon = FREE_MERGE_HORIZON - laneLen[c];
        for (let e = start[from]; e < start[from + 1]; e++) {
          if (eT[e] !== ENTRY_REAL) continue;
          const toEnd = laneLen[from] - eS[e];
          if (toEnd > horizon || count >= MAX_LIST) break;
          const u = eV[e];
          if (nextOf(w, u) !== c) continue;
          const d = toEnd + laneLen[c];
          const eta = etaOf(d, speed[u]);
          listV[count] = u;
          listD[count] = d;
          listEta[count] = eta;
          // When it will be inside: the same scale as entry steps of those already in,
          // so the order does not flip at the moment someone crosses the line.
          listKey[count] = edge ? tick + eta / DT : tick + etaOf(toEnd, speed[u]) / DT;
          listHold[count] = d - zone;
          listF[count++] = k;
        }
      } else {
        for (let u = jn.claimHead[c]; u >= 0 && count < MAX_LIST; u = veh.claimNext[u]) {
          // A waiting claim is not coming in yet, so it leads nobody into the merge.
          if (veh.claimWait[u]) continue;
          const d = permitDist[u] + laneLen[c];
          const eta = etaOf(d, speed[u]);
          listV[count] = u;
          listD[count] = d;
          listEta[count] = eta;
          // Cleared at a controlled junction: after everyone inside. The permit check has
          // already ordered these against each other, and ranking them by predicted entry
          // instead locks a busy roundabout.
          listKey[count] = HOLDER_BASE + eta;
          listHold[count] = d - zone;
          listF[count++] = k;
        }
      }
    }
    if (count < 2) continue;
    // Small list: insertion sort, by key, then distance, then identity.
    for (let a = 1; a < count; a++) {
      const kv = listV[a];
      const kd = listD[a];
      const ke = listEta[a];
      const kk = listKey[a];
      const kf = listF[a];
      const kh = listHold[a];
      let b = a - 1;
      while (b >= 0 && (listKey[b] > kk || (listKey[b] === kk && (listD[b] > kd || (listD[b] === kd && id[listV[b]] > id[kv]))))) {
        listV[b + 1] = listV[b];
        listD[b + 1] = listD[b];
        listEta[b + 1] = listEta[b];
        listKey[b + 1] = listKey[b];
        listF[b + 1] = listF[b];
        listHold[b + 1] = listHold[b];
        b--;
      }
      listV[b + 1] = kv;
      listD[b + 1] = kd;
      listEta[b + 1] = ke;
      listKey[b + 1] = kk;
      listF[b + 1] = kf;
      listHold[b + 1] = kh;
    }
    for (let a = 1; a < count; a++) {
      if (listF[a] === listF[a - 1]) continue;
      const u = listV[a];
      // A tail is listed only to lead; it never follows anything.
      if (veh.lane[u] !== prevList[listF[a]] && veh.permit[u] !== prevList[listF[a]] && listD[a] < 0) continue;
      const lead = listV[a - 1];
      // A long leader's tail cuts inwards across the converging paths: keep further back.
      const extra = len[lead] >= LONG_BODY ? LONG_LEADER_MARGIN : 0;
      const spatial = listD[a] - listD[a - 1] - len[lead] - extra;
      const timed = (listEta[a] - listEta[a - 1]) * (speed[u] > ORDER_SPEED_FLOOR ? speed[u] : ORDER_SPEED_FLOOR) - len[lead] - extra;
      let gap = spatial > timed ? spatial : timed;
      // A follower level with its leader may come up to its own merge point, rather than
      // braking for a body it is not yet near, but only as far as the leader's tail has
      // passed the leader's merge point. Otherwise it arrives beside that tail.
      const leaderTail = listHold[a - 1] + len[lead] + extra;
      const hold = listHold[a] - (leaderTail > 0 ? leaderTail : 0) - 1;
      if (hold > gap) gap = hold;
      if (vlTick[u] !== tick || gap < vlGap[u]) {
        vlTick[u] = tick;
        vlGap[u] = gap;
        vlV[u] = speed[lead];
        // Gentle while there is room; as hard as it takes once the gap is nearly gone.
        vlFloor[u] = listD[a] < 20 || hold < 25 || gap < 10 ? -MAX_DECEL : -3.5;
      }
    }
  }
}
