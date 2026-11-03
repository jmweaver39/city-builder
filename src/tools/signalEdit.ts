/** Pure edits of a signal plan, for the signal editor. All return a new plan. */
import type { MovementKey, MovementState, SignalPhase, SignalPlan } from '../core/types';

export type MoveCell = MovementState | 'red';

export function moveState(phase: SignalPhase, key: MovementKey): MoveCell {
  return phase.moves[key] ?? 'red';
}

/** Red, then permissive, then protected, then red. */
export function nextMoveState(state: MoveCell): MoveCell {
  if (state === 'red') return 'permissive';
  if (state === 'permissive') return 'protected';
  return 'red';
}

function withPhase(plan: SignalPlan, index: number, fn: (p: SignalPhase) => SignalPhase): SignalPlan {
  return { ...plan, phases: plan.phases.map((p, i) => (i === index ? fn(p) : p)) };
}

export function cycleMove(plan: SignalPlan, phaseIndex: number, key: MovementKey): SignalPlan {
  return withPhase(plan, phaseIndex, (p) => {
    const moves = { ...p.moves };
    const next = nextMoveState(moves[key] ?? 'red');
    if (next === 'red') delete moves[key];
    else moves[key] = next;
    return { ...p, moves };
  });
}

export function setPhaseField(
  plan: SignalPlan,
  phaseIndex: number,
  field: 'greenSec' | 'yellowSec' | 'allRedSec' | 'minGreenSec' | 'maxGreenSec' | 'name',
  value: number | string,
): SignalPlan {
  return withPhase(plan, phaseIndex, (p) => ({ ...p, [field]: value }));
}

export function addPhase(plan: SignalPlan): SignalPlan {
  const id = plan.phases.reduce((m, p) => Math.max(m, p.id), 0) + 1;
  const phase: SignalPhase = {
    id,
    name: `Phase ${plan.phases.length + 1}`,
    greenSec: 20,
    yellowSec: 3,
    allRedSec: 1.5,
    minGreenSec: 6,
    maxGreenSec: 60,
    moves: {},
  };
  return { ...plan, phases: [...plan.phases, phase] };
}

export function removePhase(plan: SignalPlan, index: number): SignalPlan {
  if (plan.phases.length <= 1) return plan;
  return { ...plan, phases: plan.phases.filter((_, i) => i !== index) };
}

/** Swap a phase with its neighbour. Out-of-range moves return the plan unchanged. */
export function movePhase(plan: SignalPlan, index: number, direction: 1 | -1): SignalPlan {
  const to = index + direction;
  if (to < 0 || to >= plan.phases.length) return plan;
  const phases = [...plan.phases];
  [phases[index], phases[to]] = [phases[to], phases[index]];
  return { ...plan, phases };
}

/** Length of one full cycle in seconds. */
export function cycleLength(plan: SignalPlan): number {
  return plan.phases.reduce((sum, p) => sum + p.greenSec + p.yellowSec + p.allRedSec, 0);
}
