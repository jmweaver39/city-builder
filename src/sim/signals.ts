/**
 * Signal timing. Plans come from the core as data; this runs them. Each connector
 * at a signalled node gets a light state, read straight from `state` in the hot path.
 */
import type { Id, RoadNetwork, SignalPlan } from '../core';
import type { LightState, SignalHead, SignalPhaseStatus } from './api';
import type { Buckets } from './buckets';
import { ENTRY_REAL } from './buckets';
import type { CompiledGraph } from './compiled';
import { DT } from './constants';

export const LIGHT_RED = 0;
export const LIGHT_YELLOW = 1;
export const LIGHT_PERMISSIVE = 2;
export const LIGHT_PROTECTED = 3;

const STAGE_GREEN = 0;
const STAGE_YELLOW = 1;
const STAGE_ALLRED = 2;
const STAGE_NAMES = ['green', 'yellow', 'allRed'];

/** A detector this far upstream of the line calls and extends actuated phases. */
const DETECT_DIST = 40;
const DETECT_GAP_SEC = 2.5;

class Controller {
  phase = 0;
  stage = STAGE_GREEN;
  /** Seconds left in this stage. */
  left = 0;
  greenElapsed = 0;
  sinceCall = 0;
  cycle = 0;
  /** Light per phase per connector. */
  states: Uint8Array[];
  /** Connectors no phase mentions. They run permissive rather than never at all. */
  orphans: number[];

  constructor(
    readonly nodeId: Id,
    readonly plan: SignalPlan,
    readonly conns: number[],
    g: CompiledGraph,
  ) {
    this.states = plan.phases.map((ph) => {
      const row = new Uint8Array(conns.length);
      conns.forEach((c, i) => {
        const from = g.graph.lanes[g.fromLane[c]].segmentId;
        const to = g.graph.lanes[g.toLane[c]].segmentId;
        const st = ph.moves[`${from}>${to}`];
        row[i] = st === 'protected' ? LIGHT_PROTECTED : st === 'permissive' ? LIGHT_PERMISSIVE : LIGHT_RED;
      });
      return row;
    });
    this.orphans = conns.filter((_, i) => this.states.every((row) => row[i] === LIGHT_RED));
    for (const ph of plan.phases) this.cycle += Math.max(ph.greenSec, 0) + Math.max(ph.yellowSec, 0) + Math.max(ph.allRedSec, 0);
    if (plan.phases.length) this.left = Math.max(plan.phases[0].greenSec, 0.1);
  }

  private light(i: number, phase: number, stage: number): number {
    const here = this.states[phase][i];
    if (stage === STAGE_GREEN || here === LIGHT_RED) return here;
    const next = this.states[(phase + 1) % this.states.length][i];
    // Running on into the next phase needs no yellow.
    if (next !== LIGHT_RED) return here;
    return stage === STAGE_YELLOW ? LIGHT_YELLOW : LIGHT_RED;
  }

  write(state: Uint8Array): void {
    const { conns } = this;
    if (!this.states.length || this.cycle <= 0) {
      for (const c of conns) state[c] = LIGHT_PERMISSIVE;
      return;
    }
    for (let i = 0; i < conns.length; i++) state[conns[i]] = this.light(i, this.phase, this.stage);
    for (const c of this.orphans) state[c] = LIGHT_PERMISSIVE;
  }

  /** Put a fixed plan where the clock says it should be. Returns true on change. */
  setByClock(time: number): boolean {
    const { plan, cycle } = this;
    if (cycle <= 0 || !plan.phases.length) return false;
    let t = (time + plan.offsetSec) % cycle;
    if (t < 0) t += cycle;
    for (let p = 0; p < plan.phases.length; p++) {
      const ph = plan.phases[p];
      const spans = [Math.max(ph.greenSec, 0), Math.max(ph.yellowSec, 0), Math.max(ph.allRedSec, 0)];
      for (let st = 0; st < 3; st++) {
        if (t < spans[st]) {
          const changed = p !== this.phase || st !== this.stage;
          this.phase = p;
          this.stage = st;
          this.left = spans[st] - t;
          return changed;
        }
        t -= spans[st];
      }
    }
    return false;
  }

  private phaseHasDemand(p: number, g: CompiledGraph, bk: Buckets): boolean {
    const row = this.states[p];
    for (let i = 0; i < row.length; i++) {
      if (row[i] !== LIGHT_RED && laneCalls(this.conns[i], g, bk)) return true;
    }
    return false;
  }

  /** Step an actuated plan. Returns true when lights changed. */
  stepActuated(g: CompiledGraph, bk: Buckets): boolean {
    const { plan } = this;
    const count = plan.phases.length;
    if (!count) return false;
    const ph = plan.phases[this.phase];
    if (this.stage === STAGE_GREEN) {
      this.greenElapsed += DT;
      if (this.phaseHasDemand(this.phase, g, bk)) this.sinceCall = 0;
      else this.sinceCall += DT;
      const minGreen = Math.max(ph.minGreenSec, 0);
      const maxGreen = Math.max(ph.maxGreenSec, minGreen);
      if (this.greenElapsed < minGreen) return false;
      const othersWaiting = this.nextDemand(g, bk) !== this.phase;
      if (!othersWaiting) return false;
      if (this.greenElapsed >= maxGreen || this.sinceCall >= DETECT_GAP_SEC) {
        this.stage = STAGE_YELLOW;
        this.left = Math.max(ph.yellowSec, 0);
        if (this.left > 0) return true;
      } else {
        return false;
      }
    }
    this.left -= DT;
    if (this.left > 0) return false;
    if (this.stage === STAGE_YELLOW) {
      this.stage = STAGE_ALLRED;
      this.left = Math.max(ph.allRedSec, 0);
      if (this.left > 0) return true;
    }
    this.phase = this.nextDemand(g, bk);
    this.stage = STAGE_GREEN;
    this.greenElapsed = 0;
    this.sinceCall = 0;
    this.left = 0;
    return true;
  }

  /** The next phase in order with demand, or the current one if nothing else wants it. */
  private nextDemand(g: CompiledGraph, bk: Buckets): number {
    const count = this.plan.phases.length;
    for (let k = 1; k < count; k++) {
      const p = (this.phase + k) % count;
      if (this.phaseHasDemand(p, g, bk)) return p;
    }
    return this.phase;
  }

  status(): SignalPhaseStatus {
    return { phaseIndex: this.phase, stage: STAGE_NAMES[this.stage], remainingSec: Math.max(0, this.left) };
  }
}

/** True when a vehicle is near the line on the lane feeding connector c. */
function laneCalls(c: number, g: CompiledGraph, bk: Buckets): boolean {
  const from = g.fromLane[c];
  const a = bk.start[from];
  const b = bk.start[from + 1];
  for (let e = a; e < b; e++) {
    if (bk.eT[e] !== ENTRY_REAL) continue;
    return g.len[from] - bk.eS[e] < DETECT_DIST;
  }
  return false;
}

export class SignalSystem {
  /** Light of each lane. Only connectors at signals are meaningful. */
  state: Uint8Array;
  private controllers: Controller[] = [];
  private byNode = new Map<Id, Controller>();
  private heads: SignalHead[] = [];
  private headConns: number[][] = [];

  constructor(n: number) {
    this.state = new Uint8Array(n);
  }

  add(net: RoadNetwork, g: CompiledGraph, nodeId: Id, plan: SignalPlan, conns: number[], previous: SignalSystem | null): void {
    const c = new Controller(nodeId, plan, conns, g);
    const old = previous?.byNode.get(nodeId);
    if (old && old.plan.phases.length === plan.phases.length) {
      c.phase = old.phase;
      c.stage = old.stage;
      c.left = old.left;
      c.greenElapsed = old.greenElapsed;
    }
    this.controllers.push(c);
    this.byNode.set(nodeId, c);
    this.addHeads(net, g, nodeId, conns);
  }

  private addHeads(net: RoadNetwork, g: CompiledGraph, nodeId: Id, conns: number[]): void {
    const byLane = new Map<number, number[]>();
    for (const c of conns) {
      const from = g.fromLane[c];
      if (!byLane.has(from)) byLane.set(from, []);
      byLane.get(from)!.push(c);
    }
    for (const [lane, list] of byLane) {
      const gl = g.graph.lanes[lane];
      const n = gl.cum.length;
      if (n < 2) continue;
      const x = gl.pts[n * 3 - 3];
      const y = gl.pts[n * 3 - 2];
      const z = gl.pts[n * 3 - 1];
      const dx = x - gl.pts[n * 3 - 6];
      const dz = z - gl.pts[n * 3 - 4];
      const l = Math.hypot(dx, dz) || 1;
      this.heads.push({
        nodeId,
        segmentId: gl.segmentId,
        laneIndex: gl.laneIndex,
        pos: { x, y, z },
        facing: { x: dx / l, y: 0, z: dz / l },
        state: 'red',
      });
      this.headConns.push(list);
    }
  }

  /** Set every light for this moment. Call once after compiling. */
  init(time: number): void {
    for (const c of this.controllers) {
      if (c.plan.kind === 'fixed') c.setByClock(time);
      c.write(this.state);
    }
  }

  update(time: number, g: CompiledGraph, bk: Buckets): void {
    const { controllers, state } = this;
    for (let i = 0; i < controllers.length; i++) {
      const c = controllers[i];
      const changed = c.plan.kind === 'fixed' ? c.setByClock(time) : c.stepActuated(g, bk);
      if (changed) c.write(state);
    }
  }

  /** Seconds until a yellow at this node turns red. */
  yellowLeft(nodeId: Id): number {
    const c = this.byNode.get(nodeId);
    return c ? c.left : 0;
  }

  heartbeat(): readonly SignalHead[] {
    const { heads, headConns, state } = this;
    for (let i = 0; i < heads.length; i++) {
      let best = LIGHT_RED;
      for (const c of headConns[i]) if (state[c] > best) best = state[c];
      heads[i].state = lightName(best);
    }
    return heads;
  }

  status(nodeId: Id): SignalPhaseStatus | null {
    return this.byNode.get(nodeId)?.status() ?? null;
  }
}

export function lightName(state: number): LightState {
  if (state >= LIGHT_PERMISSIVE) return 'green';
  return state === LIGHT_YELLOW ? 'yellow' : 'red';
}
