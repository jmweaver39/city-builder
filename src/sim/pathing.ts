/** Reading routes out of the cost tables. */
import { TYPE_BITS } from './compiled';
import { ROUTE_NOISE } from './constants';
import { hashNoise } from './rng';
import type { RouteTable } from './routing';
import type { World } from './world';

export function tableOf(w: World, v: number): RouteTable {
  return w.routes.tableFor(w.veh.type[v]);
}

export function allowBit(w: World, v: number): number {
  return TYPE_BITS[w.veh.type[v]];
}

/** Best lane after `lane` for this vehicle, or -1 when no lane on leads to its destination. */
export function pickNext(w: World, v: number, lane: number): number {
  const { g, veh } = w;
  const { nextStart, nextList, allow } = g;
  const a = nextStart[lane];
  const b = nextStart[lane + 1];
  const bit = allowBit(w, v);
  const dest = veh.dest[v];
  if (dest < 0) {
    // Nowhere to be: take any way on.
    for (let k = a; k < b; k++) if (allow[nextList[k]] & bit) return nextList[k];
    return -1;
  }
  const cost = tableOf(w, v).cost;
  const base = dest * g.n;
  if (b - a === 1) {
    const n = nextList[a];
    return allow[n] & bit && cost[base + n] < Infinity ? n : -1;
  }
  const seed = veh.noiseSeed[v];
  let best = -1;
  let bestCost = Infinity;
  for (let k = a; k < b; k++) {
    const n = nextList[k];
    if (!(allow[n] & bit)) continue;
    const c = cost[base + n];
    if (c === Infinity) continue;
    const noisy = c * (1 + ROUTE_NOISE * hashNoise(seed, n));
    if (noisy < bestCost) {
      bestCost = noisy;
      best = n;
    }
  }
  return best;
}

/** The vehicle's next lane, chosen once per lane unless strategy clears it. */
export function nextOf(w: World, v: number): number {
  const veh = w.veh;
  let n = veh.nextLane[v];
  if (n < 0) {
    n = pickNext(w, v, veh.lane[v]);
    veh.nextLane[v] = n;
  }
  return n;
}

/** Where on `lane` this vehicle's destination takes it off the road, or -1. */
export function sinkOn(w: World, v: number, lane: number): number {
  if (!w.routes.sinkFlag[lane]) return -1;
  const dest = w.veh.dest[v];
  if (dest < 0) return -1;
  const sinks = w.routes.places[dest].sinks;
  for (let i = 0; i < sinks.length; i++) if (sinks[i].lane === lane) return sinks[i].s;
  return -1;
}

/**
 * Point the vehicle at a destination it can still reach from `lane`, weighted by
 * attraction, or at nothing if there is none.
 */
export function retarget(w: World, v: number, lane: number): void {
  const { g, veh, routes } = w;
  const places = routes.places;
  const table = tableOf(w, v);
  const old = veh.dest[v];
  let total = 0;
  for (let i = 0; i < places.length; i++) {
    if (i !== old && places[i].weight > 0 && table.cost[i * g.n + lane] < Infinity) total += places[i].weight;
  }
  let pick = -1;
  if (total > 0) {
    let r = w.rng.next() * total;
    for (let i = 0; i < places.length; i++) {
      if (i === old || places[i].weight <= 0 || !(table.cost[i * g.n + lane] < Infinity)) continue;
      pick = i;
      r -= places[i].weight;
      if (r <= 0) break;
    }
  }
  veh.dest[v] = pick;
  veh.nextLane[v] = -1;
  veh.mustWait[v] = 0;
  if (pick >= 0) w.counters.retargeted++;
}
