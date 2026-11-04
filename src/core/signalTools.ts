/**
 * Timed traffic light extras: copy one junction's plan and paste it on another,
 * matching arms by their order round the junction, and link junctions into a
 * green wave by setting each plan's offset from the travel time between them.
 * Pure over the network; edits go through setJunctionControl, so they undo.
 */
import type { RoadNetwork } from './RoadNetwork';
import { headingOf, wrapAngle } from './math';
import { effectiveControl, movementsAt } from './signals';
import type { Id, MovementKey, MovementState, SignalPhase, SignalPlan, TurnKind } from './types';

/** A plan lifted off a junction, described by arm positions instead of segment ids. */
export interface PlanClip {
  plan: SignalPlan;
  /** Road arms of the source, clockwise. */
  arms: number;
  /** Per movement key of the source: arm positions and turn. */
  moves: Record<MovementKey, { from: number; to: number; turn: TurnKind }>;
  source: Id;
}

function roadArms(net: RoadNetwork, nodeId: Id): Id[] {
  return (net.nodeGeom(nodeId)?.arms ?? []).filter((a) => net.roadTypeOf(a.segmentId).category !== 'rail').map((a) => a.segmentId);
}

/** The plan running at a node now, its own or the automatic one. Null without lights. */
export function planAt(net: RoadNetwork, nodeId: Id): SignalPlan | null {
  const ec = effectiveControl(net, nodeId);
  return ec.kind === 'signal' ? ec.signal : null;
}

export function copySignalPlan(net: RoadNetwork, nodeId: Id): PlanClip | null {
  const plan = planAt(net, nodeId);
  if (!plan) return null;
  const arms = roadArms(net, nodeId);
  const moves: PlanClip['moves'] = {};
  for (const m of movementsAt(net, nodeId)) {
    const from = arms.indexOf(m.fromSegment);
    const to = arms.indexOf(m.toSegment);
    if (from >= 0 && to >= 0) moves[m.key] = { from, to, turn: m.turn };
  }
  return { plan: structuredClone(plan), arms: arms.length, moves, source: nodeId };
}

export type PasteResult = { ok: true; plan: SignalPlan; matched: number; added: number } | { ok: false; reason: string };

/** The clip's plan fitted to another junction, without applying it. */
export function fitSignalPlan(net: RoadNetwork, clip: PlanClip, nodeId: Id): PasteResult {
  const geom = net.nodeGeom(nodeId);
  if (!geom || geom.kind !== 'junction') return { ok: false, reason: 'Not a junction.' };
  const arms = roadArms(net, nodeId);
  if (arms.length !== clip.arms) return { ok: false, reason: `This junction has ${arms.length} arms; the copied plan is for ${clip.arms}.` };
  const target = movementsAt(net, nodeId);
  const byKey = new Map(target.map((m) => [m.key, m]));
  // The rotation of arms that keeps the most movements the same kind of turn.
  let best = 0;
  let bestScore = -1;
  for (let r = 0; r < arms.length; r++) {
    let score = 0;
    for (const mv of Object.values(clip.moves)) {
      const key = `${arms[(mv.from + r) % arms.length]}>${arms[(mv.to + r) % arms.length]}`;
      const m = byKey.get(key);
      if (m) score += m.turn === mv.turn ? 2 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  const mapKey = (key: MovementKey): MovementKey | null => {
    const mv = clip.moves[key];
    if (!mv) return null;
    const k = `${arms[(mv.from + best) % arms.length]}>${arms[(mv.to + best) % arms.length]}`;
    return byKey.has(k) ? k : null;
  };
  const covered = new Set<MovementKey>();
  let matched = 0;
  const phases: SignalPhase[] = clip.plan.phases.map((ph) => {
    const moves: Record<MovementKey, MovementState> = {};
    for (const [key, state] of Object.entries(ph.moves)) {
      const k = mapKey(key);
      if (!k) continue;
      moves[k] = state;
      if (!covered.has(k)) matched++;
      covered.add(k);
    }
    return { ...ph, moves };
  });
  // Movements the copy did not cover run with the rest of their approach.
  let added = 0;
  for (const m of target) {
    if (covered.has(m.key)) continue;
    let homes = phases.filter((p) => Object.keys(p.moves).some((k) => k.startsWith(`${m.fromSegment}>`)));
    if (!homes.length) homes = phases.slice(0, 1);
    for (const p of homes) p.moves[m.key] = m.turn === 'left' || m.turn === 'uturn' ? 'permissive' : 'protected';
    added++;
  }
  if (!phases.length) return { ok: false, reason: 'The copied plan has no phases.' };
  return { ok: true, plan: { ...structuredClone(clip.plan), phases }, matched, added };
}

/** Paste a copied plan on a junction, turning its lights on. */
export function pasteSignalPlan(net: RoadNetwork, clip: PlanClip, nodeId: Id): PasteResult {
  const fit = fitSignalPlan(net, clip, nodeId);
  if (fit.ok) net.setJunctionControl(nodeId, { mode: 'signal', signal: fit.plan });
  return fit;
}

export function cycleOf(plan: SignalPlan): number {
  return plan.phases.reduce((s, p) => s + Math.max(p.greenSec, 0) + Math.max(p.yellowSec, 0) + Math.max(p.allRedSec, 0), 0);
}

function phaseStart(plan: SignalPlan, k: number): number {
  let t = 0;
  for (let i = 0; i < k; i++) {
    const p = plan.phases[i];
    t += Math.max(p.greenSec, 0) + Math.max(p.yellowSec, 0) + Math.max(p.allRedSec, 0);
  }
  return t;
}

/** Shortest road distance between two nodes and the segment it arrives on, or null. */
export function roadDistance(net: RoadNetwork, from: Id, to: Id, limit = 5000): { metres: number; lastSegment: Id | null; firstSegment: Id | null } | null {
  if (from === to) return { metres: 0, lastSegment: null, firstSegment: null };
  const dist = new Map<Id, number>([[from, 0]]);
  const via = new Map<Id, { seg: Id; prev: Id }>();
  const open: Id[] = [from];
  while (open.length) {
    open.sort((a, b) => dist.get(a)! - dist.get(b)!);
    const n = open.shift()!;
    const d = dist.get(n)!;
    if (n === to) break;
    if (d > limit) break;
    for (const sid of net.getNode(n)?.segments ?? []) {
      const seg = net.getSegment(sid);
      if (!seg || net.roadTypeOf(sid).category === 'rail') continue;
      const other = seg.a === n ? seg.b : seg.a;
      const nd = d + (net.segmentGeom(sid)?.fullLength ?? 0);
      if (nd < (dist.get(other) ?? Infinity)) {
        dist.set(other, nd);
        via.set(other, { seg: sid, prev: n });
        if (!open.includes(other)) open.push(other);
      }
    }
  }
  const metres = dist.get(to);
  if (metres === undefined) return null;
  let first: Id | null = null;
  let cur = to;
  const last = via.get(to)?.seg ?? null;
  while (cur !== from) {
    const v = via.get(cur)!;
    first = v.seg;
    cur = v.prev;
  }
  return { metres, lastSegment: last, firstSegment: first };
}

/** The phase serving traffic arriving on `seg` and going straight on, or the first that serves it at all. */
function throughPhase(net: RoadNetwork, nodeId: Id, plan: SignalPlan, seg: Id | null): number {
  if (seg === null) return 0;
  const moves = movementsAt(net, nodeId).filter((m) => m.fromSegment === seg);
  const straight = moves.filter((m) => m.turn === 'straight').map((m) => m.key);
  const any = moves.map((m) => m.key);
  for (const keys of [straight, any]) {
    const k = plan.phases.findIndex((p) => keys.some((key) => p.moves[key] === 'protected'));
    if (k >= 0) return k;
  }
  return 0;
}

export interface GreenWaveStep {
  nodeId: Id;
  offsetSec: number;
  /** Seconds after the first junction its green arrives. */
  travelSec: number;
  metres: number;
}

export type GreenWaveResult = { ok: true; cycleSec: number; steps: GreenWaveStep[]; plans: Map<Id, SignalPlan> } | { ok: false; reason: string };

/**
 * Link junctions, in the order given, into a green wave at `speedKmh`: every plan
 * takes the first junction's cycle length (greens scaled to fit) and an offset so
 * that its green for traffic coming from the previous junction opens as that
 * traffic arrives. Plans become fixed time.
 */
export function planGreenWave(net: RoadNetwork, nodes: Id[], speedKmh: number): GreenWaveResult {
  if (nodes.length < 2) return { ok: false, reason: 'Pick at least two junctions with lights.' };
  const v = Math.max(speedKmh, 5) / 3.6;
  const plans = new Map<Id, SignalPlan>();
  for (const id of nodes) {
    const p = planAt(net, id);
    if (!p || !p.phases.length) return { ok: false, reason: 'Every junction in a green wave needs traffic lights.' };
    plans.set(id, structuredClone(p));
  }
  const first = plans.get(nodes[0])!;
  const cycle = cycleOf(first);
  if (cycle <= 0) return { ok: false, reason: 'The first junction has no cycle.' };
  const leg0 = roadDistance(net, nodes[0], nodes[1]);
  if (!leg0) return { ok: false, reason: 'The junctions are not joined by road.' };
  // The first junction's own green for traffic heading on along the wave.
  const firstGeom = net.nodeGeom(nodes[0]);
  const outArm = firstGeom?.arms.find((a) => a.segmentId === leg0.firstSegment);
  let intoFirst: Id | null = null;
  if (outArm) {
    let bestGap = 0.7;
    for (const a of firstGeom!.arms) {
      if (a === outArm) continue;
      const gap = Math.abs(wrapAngle(headingOf(a.dir) - headingOf(outArm.dir) - Math.PI));
      if (gap < bestGap) {
        bestGap = gap;
        intoFirst = a.segmentId;
      }
    }
  }
  const s0 = phaseStart(first, throughPhase(net, nodes[0], first, intoFirst));
  const off0 = first.offsetSec;
  const steps: GreenWaveStep[] = [{ nodeId: nodes[0], offsetSec: ((off0 % cycle) + cycle) % cycle, travelSec: 0, metres: 0 }];
  first.offsetSec = steps[0].offsetSec;
  first.kind = 'fixed';
  let metres = 0;
  for (let i = 1; i < nodes.length; i++) {
    const leg = roadDistance(net, nodes[i - 1], nodes[i]);
    if (!leg) return { ok: false, reason: 'The junctions are not joined by road.' };
    metres += leg.metres;
    const plan = plans.get(nodes[i])!;
    fitCycle(plan, cycle);
    const k = throughPhase(net, nodes[i], plan, leg.lastSegment);
    const travel = metres / v;
    let off = (phaseStart(plan, k) - s0 + off0 - travel) % cycle;
    if (off < 0) off += cycle;
    plan.offsetSec = Math.round(off * 10) / 10;
    plan.kind = 'fixed';
    steps.push({ nodeId: nodes[i], offsetSec: plan.offsetSec, travelSec: travel, metres });
  }
  return { ok: true, cycleSec: cycle, steps, plans };
}

/** Scale greens so the plan's cycle is `cycle`, keeping yellows and all-reds. */
function fitCycle(plan: SignalPlan, cycle: number): void {
  const now = cycleOf(plan);
  if (Math.abs(now - cycle) < 0.05) return;
  const fixed = plan.phases.reduce((s, p) => s + Math.max(p.yellowSec, 0) + Math.max(p.allRedSec, 0), 0);
  const greens = now - fixed;
  const want = Math.max(cycle - fixed, plan.phases.length * 4);
  for (const p of plan.phases) p.greenSec = Math.round((greens > 0 ? (p.greenSec / greens) * want : want / plan.phases.length) * 10) / 10;
}

export function applyGreenWave(net: RoadNetwork, nodes: Id[], speedKmh: number): GreenWaveResult {
  const r = planGreenWave(net, nodes, speedKmh);
  if (!r.ok) return r;
  net.batch(() => {
    for (const [id, plan] of r.plans) net.setJunctionControl(id, { mode: 'signal', signal: plan });
  });
  return r;
}
