/**
 * The slow part of driving, run about once a second per vehicle: look along the
 * route for the next lane change that matters and for the next place to slow down.
 */
import { FLAG_LEFT, FLAG_NONE } from './routing';
import { NEXT_LOCK_DIST, PLAN_DECEL, STRATEGIC_MAX_DIST, STRATEGIC_MAX_HOPS, STRATEGIC_PERIOD_STEPS } from './constants';
import { TURN_LEFT, TURN_RIGHT } from './compiled';
import { pickNext, retarget, sinkOn, tableOf } from './pathing';
import type { World } from './world';

const SLOW_HORIZON = 260;
/** Speed a vehicle takes into a kerbside zone. */
const ZONE_ENTRY_SPEED = 5;

function strategic(w: World, v: number): void {
  const { g, veh, routes } = w;
  const { len: laneLen, isConn, nextStart, prof, profStart, left, right, turn } = g;
  const table = tableOf(w, v);
  const lane0 = veh.lane[v];
  const pos = veh.s[v];

  let dest = veh.dest[v];
  if (dest >= routes.places.length) dest = veh.dest[v] = -1;
  if (dest < 0 || table.cost[dest * g.n + lane0] === Infinity) {
    retarget(w, v, lane0);
    dest = veh.dest[v];
  }
  veh.needDir[v] = 0;
  veh.needMust[v] = 0;
  veh.needCount[v] = 0;
  veh.limitV[v] = 1e3;
  veh.limitD[v] = 0;
  veh.blink[v] = 0;
  if (dest < 0) return;

  const base = dest * g.n;
  const flag = table.flag;
  const toEnd = laneLen[lane0] - pos;
  // Far from the end the choice stays open to newer tables.
  if (toEnd > NEXT_LOCK_DIST && veh.permit[v] < 0) veh.nextLane[v] = -1;
  if (veh.nextLane[v] < 0) veh.nextLane[v] = pickNext(w, v, lane0);

  let cur = lane0;
  let d = toEnd;
  let hops = 0;
  let found = false;
  let bestSq = Infinity;
  let limV = 1e3;
  let limD = 0;
  const speedNow = veh.v[v];
  const planReach = Math.min(SLOW_HORIZON, (speedNow * speedNow) / (2 * PLAN_DECEL) + 60);

  while (hops < STRATEGIC_MAX_HOPS && d < STRATEGIC_MAX_DIST) {
    const sink = sinkOn(w, v, cur);
    if (sink >= 0 && (cur !== lane0 || sink >= pos)) {
      if (routes.places[dest].isZone) {
        const at = d - laneLen[cur] + sink;
        const sq = ZONE_ENTRY_SPEED * ZONE_ENTRY_SPEED + 2 * PLAN_DECEL * Math.max(at, 0);
        if (sq < bestSq) {
          bestSq = sq;
          limV = ZONE_ENTRY_SPEED;
          limD = at;
        }
      }
      break;
    }
    if (!found && !isConn[cur]) {
      const f = flag[base + cur];
      if (f !== FLAG_NONE) {
        found = true;
        veh.needDir[v] = f === FLAG_LEFT ? -1 : 1;
        veh.needDist[v] = d;
        // How many changes, by following the flags across.
        let c = cur;
        let count = 0;
        while (count < 6 && flag[base + c] !== FLAG_NONE) {
          const nb = flag[base + c] === FLAG_LEFT ? left[c] : right[c];
          if (nb < 0) break;
          c = nb;
          count++;
        }
        veh.needCount[v] = count;
        veh.needMust[v] = pickNext(w, v, cur) < 0 ? 1 : 0;
      }
    }
    if (nextStart[cur] === nextStart[cur + 1]) break;
    const n = cur === lane0 ? veh.nextLane[v] : pickNext(w, v, cur);
    if (n < 0) break;
    if (hops === 0 && isConn[n] && d < 50) {
      if (turn[n] === TURN_LEFT) veh.blink[v] = -1;
      else if (turn[n] === TURN_RIGHT) veh.blink[v] = 1;
    }
    if (d < planReach) {
      const e = prof[profStart[n]];
      const sq = e * e + 2 * PLAN_DECEL * d;
      if (sq < bestSq) {
        bestSq = sq;
        limV = e;
        limD = d;
      }
    } else if (found) {
      break;
    }
    d += laneLen[n];
    cur = n;
    hops++;
  }
  veh.limitV[v] = limV;
  veh.limitD[v] = limD;
}

export function strategicPass(w: World): void {
  const { veh, tick } = w;
  const { live, stratTick } = veh;
  const count = veh.liveCount;
  for (let i = 0; i < count; i++) {
    const v = live[i];
    if (stratTick[v] <= tick) {
      strategic(w, v);
      stratTick[v] = tick + STRATEGIC_PERIOD_STEPS;
    }
  }
}
