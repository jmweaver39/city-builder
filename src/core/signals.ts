/**
 * Junction control as data: default signal plans and the resolved control of a
 * node. No timing logic lives here. That belongs to the simulator.
 */
import type {
  Id,
  MovementKey,
  MovementState,
  NodeArm,
  RoadTypeDef,
  SignalPhase,
  SignalPlan,
  SignKind,
  TurnKind,
} from './types';
import type { RoadNetwork } from './RoadNetwork';
import { headingOf, wrapAngle } from './math';
import { RANK_AVENUE, isOneWay } from './roadTypes';

export type SignalPreset = 'opposing' | 'protectedLefts' | 'split';

export interface Movement {
  key: MovementKey;
  fromSegment: Id;
  toSegment: Id;
  turn: TurnKind;
  /** Dense lane graph indices of the connectors serving this movement. */
  connectors: number[];
}

/** The movements through a node, from its connectors. */
export function movementsAt(net: RoadNetwork, nodeId: Id): Movement[] {
  const graph = net.laneGraph;
  const byKey = new Map<MovementKey, Movement>();
  for (const idx of graph.connectorsAt.get(nodeId) ?? []) {
    const lane = graph.lanes[idx];
    if (lane.vehicleKind === 'rail') continue;
    const from = graph.lanes[lane.fromLane].segmentId;
    const to = graph.lanes[lane.toLane].segmentId;
    const key: MovementKey = `${from}>${to}`;
    let m = byKey.get(key);
    if (!m) {
      m = { key, fromSegment: from, toSegment: to, turn: lane.turn ?? 'straight', connectors: [] };
      byKey.set(key, m);
    }
    m.connectors.push(idx);
  }
  return [...byKey.values()];
}

/** Two arms are one axis when this close to opposite. */
const AXIS_TOLERANCE = 0.7;

function oppositeness(a: NodeArm, b: NodeArm): number {
  return Math.abs(wrapAngle(headingOf(a.dir) - headingOf(b.dir) - Math.PI));
}

interface Approach {
  arm: NodeArm;
  def: RoadTypeDef;
  moves: Movement[];
}

function approachesAt(net: RoadNetwork, nodeId: Id): { approaches: Approach[]; arms: NodeArm[] } {
  const geom = net.nodeGeom(nodeId);
  const arms = geom?.arms ?? [];
  const moves = movementsAt(net, nodeId);
  const approaches: Approach[] = [];
  for (const arm of arms) {
    const own = moves.filter((m) => m.fromSegment === arm.segmentId);
    if (own.length) approaches.push({ arm, def: net.roadTypeOf(arm.segmentId), moves: own });
  }
  return { approaches, arms };
}

/** Pair approaches that face each other, highest ranked roads first. */
function pairApproaches(list: Approach[]): Approach[][] {
  const left = [...list].sort((a, b) => b.def.rank - a.def.rank);
  const groups: Approach[][] = [];
  while (left.length) {
    const first = left.shift()!;
    let best = -1;
    let bestGap = AXIS_TOLERANCE;
    left.forEach((other, i) => {
      const gap = oppositeness(first.arm, other.arm);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    });
    if (best >= 0) groups.push([first, left.splice(best, 1)[0]]);
    else groups.push([first]);
  }
  return groups;
}

function phaseTiming(group: Approach[]): Pick<SignalPhase, 'greenSec' | 'yellowSec' | 'allRedSec' | 'minGreenSec' | 'maxGreenSec'> {
  const lanes = Math.max(...group.map((a) => a.def.lanes.length));
  const greenSec = Math.min(40, 14 + 2 * lanes);
  return { greenSec, yellowSec: 3, allRedSec: 1.5, minGreenSec: 6, maxGreenSec: 60 };
}

/**
 * A default plan for a node. Works for any number of arms: approaches that face
 * each other share a phase and the rest get their own. Arms with no way in are
 * skipped, so one-way roads just drop out.
 *
 * - 'opposing': facing approaches go together, with lefts yielding (permissive).
 * - 'protectedLefts': as opposing, with a leading phase for lefts where they exist.
 * - 'split': each approach runs alone.
 */
export function defaultSignalPlan(net: RoadNetwork, nodeId: Id, preset: SignalPreset = 'opposing'): SignalPlan {
  const { approaches } = approachesAt(net, nodeId);
  const groups = preset === 'split' ? approaches.map((a) => [a]) : pairApproaches(approaches);
  const phases: SignalPhase[] = [];
  const pushPhase = (name: string, group: Approach[], moves: Record<MovementKey, MovementState>, shorter = false) => {
    const timing = phaseTiming(group);
    phases.push({
      id: phases.length + 1,
      name,
      ...timing,
      greenSec: shorter ? Math.max(8, Math.round(timing.greenSec * 0.5)) : timing.greenSec,
      moves,
    });
  };

  groups.forEach((group, g) => {
    const label = `Group ${g + 1}`;
    const shared = group.length === 2;
    if (preset === 'protectedLefts' && shared) {
      const lefts: Record<MovementKey, MovementState> = {};
      for (const a of group) {
        for (const m of a.moves) if (m.turn === 'left' || m.turn === 'uturn') lefts[m.key] = 'protected';
      }
      if (Object.keys(lefts).length) {
        pushPhase(`${label} lefts`, group, lefts, true);
        const through: Record<MovementKey, MovementState> = {};
        for (const a of group) {
          for (const m of a.moves) if (m.turn === 'straight' || m.turn === 'right') through[m.key] = 'protected';
        }
        pushPhase(`${label} through`, group, through);
        return;
      }
    }
    const moves: Record<MovementKey, MovementState> = {};
    for (const a of group) {
      for (const m of a.moves) {
        moves[m.key] = shared && (m.turn === 'left' || m.turn === 'uturn') ? 'permissive' : 'protected';
      }
    }
    pushPhase(label, group, moves);
  });

  return { kind: 'fixed', offsetSec: 0, phases };
}

export interface EffectiveControl {
  /** 'none' covers dead ends, plain joints and free-flowing merges and splits. */
  kind: 'none' | 'priority' | 'allStop' | 'signal';
  /** Per incoming segment. Empty when kind is 'none' or 'signal'. */
  signs: Record<number, SignKind>;
  /** The plan to run when kind is 'signal'. */
  signal: SignalPlan | null;
  /** True when the node's mode was 'auto' and core picked this. */
  auto: boolean;
}

function isFreeFlow(net: RoadNetwork, arms: NodeArm[]): boolean {
  let inbound = 0;
  let outbound = 0;
  for (const arm of arms) {
    const def = net.roadTypeOf(arm.segmentId);
    if (!isOneWay(def)) return false;
    if (def.category !== 'highway' && def.category !== 'ramp') return false;
    if (arm.atStart) outbound++;
    else inbound++;
  }
  return inbound === 1 || outbound === 1;
}

/** The two arms of the road everyone else yields to. */
function mainAxis(net: RoadNetwork, arms: NodeArm[]): [NodeArm, NodeArm] {
  let best: [NodeArm, NodeArm] = [arms[0], arms[1]];
  let score = -Infinity;
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      const a = net.roadTypeOf(arms[i].segmentId);
      const b = net.roadTypeOf(arms[j].segmentId);
      const straightness = 1 - oppositeness(arms[i], arms[j]) / Math.PI;
      const s = (a.rank + b.rank) * 1000 + (a.lanes.length + b.lanes.length) * 10 + straightness;
      if (s > score) {
        score = s;
        best = [arms[i], arms[j]];
      }
    }
  }
  return best;
}

function computedSigns(net: RoadNetwork, arms: NodeArm[]): Record<number, SignKind> {
  const [p, q] = mainAxis(net, arms);
  const signs: Record<number, SignKind> = {};
  for (const arm of arms) {
    const main = arm === p || arm === q;
    signs[arm.segmentId] = main ? 'priority' : 'yield';
  }
  return signs;
}

function incomingArms(net: RoadNetwork, arms: NodeArm[]): NodeArm[] {
  return arms.filter((arm) => {
    const def = net.roadTypeOf(arm.segmentId);
    return arm.atStart ? def.lanes.some((l) => l.dir === -1) : def.lanes.some((l) => l.dir === 1);
  });
}

function autoPicksSignal(net: RoadNetwork, arms: NodeArm[]): boolean {
  const big = arms.filter((a) => net.roadTypeOf(a.segmentId).rank >= RANK_AVENUE);
  if (big.length >= 3) return true;
  // Two big arms are one road passing through unless they meet at an angle.
  return big.length === 2 && oppositeness(big[0], big[1]) > AXIS_TOLERANCE;
}

/**
 * What a node really does, resolving 'auto' from the road types. Signs are only
 * given for roads that arrive at the node.
 */
export function effectiveControl(net: RoadNetwork, nodeId: Id): EffectiveControl {
  const node = net.getNode(nodeId);
  const geom = net.nodeGeom(nodeId);
  if (!node || !geom) return { kind: 'none', signs: {}, signal: null, auto: true };
  // Track at a level crossing plays no part in who goes first on the road.
  const arms = geom.arms.filter((a) => net.roadTypeOf(a.segmentId).category !== 'rail');
  const mode = node.control.mode;
  const auto = mode === 'auto';
  const plan = (): SignalPlan => node.control.signal ?? defaultSignalPlan(net, nodeId, 'opposing');

  if (mode === 'signal') return { kind: 'signal', signs: {}, signal: plan(), auto };
  if (mode === 'allStop') {
    const signs: Record<number, SignKind> = {};
    for (const arm of incomingArms(net, arms)) signs[arm.segmentId] = 'stop';
    return { kind: 'allStop', signs, signal: null, auto };
  }
  if (arms.length < 3) {
    if (mode === 'auto') return { kind: 'none', signs: {}, signal: null, auto };
  } else if (mode === 'auto') {
    if (isFreeFlow(net, arms)) return { kind: 'none', signs: {}, signal: null, auto };
    if (autoPicksSignal(net, arms)) return { kind: 'signal', signs: {}, signal: plan(), auto };
  }

  const incoming = new Set(incomingArms(net, arms).map((a) => a.segmentId));
  const manual = node.control.signs;
  const useManual = !auto && Object.keys(manual).length > 0;
  const all = useManual ? manual : arms.length >= 2 ? computedSigns(net, arms) : {};
  const signs: Record<number, SignKind> = {};
  for (const [seg, sign] of Object.entries(all)) {
    if (incoming.has(Number(seg))) signs[Number(seg)] = sign;
  }
  return { kind: 'priority', signs, signal: null, auto };
}
