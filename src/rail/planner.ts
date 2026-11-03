/**
 * Route finding over directed track states. Cost is running time, with a penalty
 * for wrong-road running and for not keeping right, so a line takes its own track
 * on double track and the two directions take opposite sides of a passing loop.
 */
import type { TrackGraph, TrackPiece } from './TrackGraph';

export interface RouteRules {
  /** Metro stock runs on metro track, everything else off it. */
  metro: boolean;
  /** Needs wires or a third rail. */
  electric: boolean;
  maxSpeed: number;
}

/** Seconds a train would give up to stay on the right-hand road. */
const KEEP_RIGHT_PENALTY = 45;
const WRONG_ROAD_FACTOR = 5;
const WRONG_ROAD_PENALTY = 60;

export function trackAllows(p: TrackPiece, rules: RouteRules): boolean {
  if (p.metro !== rules.metro) return false;
  return !rules.electric || p.electrified || p.thirdRail;
}

export function opposite(state: number): number {
  return state ^ 1;
}

/** Seconds to run a state. */
function runTime(p: TrackPiece, forward: boolean, rules: RouteRules): number {
  const t = p.length / Math.max(1, Math.min(p.speed, rules.maxSpeed));
  const wrong = p.normal !== 0 && (p.normal === 1) !== forward;
  return wrong ? t * WRONG_ROAD_FACTOR + WRONG_ROAD_PENALTY : t;
}

export interface Route {
  states: number[];
  cost: number;
}

class MinHeap {
  keys: number[] = [];
  vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(k: number, v: number): void {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(k);
    vals.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= k) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }

  pop(): number {
    const { keys, vals } = this;
    const top = vals[0];
    const k = keys.pop()!;
    const v = vals.pop()!;
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= k) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return top;
  }
}

/**
 * Cheapest way from any start state to any target piece. The result starts at a
 * start state and ends on a target. A start already on a target costs nothing.
 */
export function findRoute(g: TrackGraph, starts: readonly number[], targets: ReadonlySet<number>, rules: RouteRules | null): Route | null {
  const n = g.next.length;
  const dist = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  for (const s of starts) {
    dist[s] = 0;
    heap.push(0, s);
  }
  let goal = -1;
  while (heap.size) {
    const s = heap.pop();
    const d = dist[s];
    if (targets.has(s >> 1)) {
      goal = s;
      break;
    }
    const list = g.next[s];
    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      const p = g.pieces[q >> 1];
      if (rules && !trackAllows(p, rules)) continue;
      const cost = d + (rules ? runTime(p, (q & 1) === 0, rules) + i * KEEP_RIGHT_PENALTY : p.length);
      if (cost < dist[q]) {
        dist[q] = cost;
        from[q] = s;
        heap.push(cost, q);
      }
    }
  }
  if (goal < 0) return null;
  const states: number[] = [];
  for (let s = goal; s >= 0; s = from[s]) states.push(s);
  states.reverse();
  return { states, cost: dist[goal] };
}
