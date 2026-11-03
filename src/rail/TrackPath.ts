/**
 * A directed walk over track pieces, measured in metres from its start. Positions
 * outside the walk run straight on from its ends, which is where a freight train
 * sits while it is entering or leaving the map.
 */
import type { TrackGraph } from './TrackGraph';

export interface PathPoint {
  x: number;
  y: number;
  z: number;
}

export class TrackPath {
  /** Directed states. See TrackGraph. */
  states: number[] = [];
  /** Distance at the start of each state. */
  start: number[] = [];
  length = 0;

  constructor(private graph: TrackGraph) {}

  append(state: number): void {
    this.states.push(state);
    this.start.push(this.length);
    this.length += this.graph.pieces[state >> 1].length;
  }

  /** Index of the state holding distance s. `hint` starts the search. */
  locate(s: number, hint = 0): number {
    const { start, states } = this;
    const last = states.length - 1;
    let i = Math.max(0, Math.min(hint, last));
    while (i < last && s >= start[i + 1]) i++;
    while (i > 0 && s < start[i]) i--;
    return i;
  }

  /** World position at s into `out`. Returns the state index, for use as the next hint. */
  sample(s: number, out: PathPoint, hint = 0): number {
    const i = this.locate(s, hint);
    const state = this.states[i];
    const piece = this.graph.pieces[state >> 1];
    const local = s - this.start[i];
    const forward = (state & 1) === 0;
    const { pts, cum, length } = piece;
    const n = cum.length;
    let u = forward ? local : length - local;
    let over = 0;
    if (u < 0) {
      over = u;
      u = 0;
    } else if (u > length) {
      over = u - length;
      u = length;
    }
    // Binary search on the polyline.
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= u) lo = m;
      else hi = m;
    }
    const span = cum[hi] - cum[lo];
    const f = span > 1e-6 ? (u - cum[lo]) / span : 0;
    const ax = pts[lo * 3];
    const ay = pts[lo * 3 + 1];
    const az = pts[lo * 3 + 2];
    const bx = pts[hi * 3];
    const by = pts[hi * 3 + 1];
    const bz = pts[hi * 3 + 2];
    out.x = ax + (bx - ax) * f;
    out.y = ay + (by - ay) * f;
    out.z = az + (bz - az) * f;
    if (over !== 0 && span > 1e-6) {
      const k = over / span;
      out.x += (bx - ax) * k;
      out.y += (by - ay) * k;
      out.z += (bz - az) * k;
    }
    return i;
  }

  /** Grade at s along the direction of travel. */
  grade(s: number, a: PathPoint, b: PathPoint): number {
    const h = this.sample(s - 4, a);
    this.sample(s + 4, b, h);
    const run = Math.hypot(b.x - a.x, b.z - a.z);
    return run > 0.1 ? (b.y - a.y) / run : 0;
  }
}
