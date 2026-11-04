/**
 * One-click junction control: what a Traffic Control card does to a junction, the
 * ghost shown before it is applied, and where a click lands (the junction or one
 * of its arms). Pure over the network, so all of it runs headless.
 *
 * Cards: traffic lights, stop signs, all-way stop, yield, priority road and auto.
 * Stop and Yield put signs on the minor road; clicked on one arm they sign just
 * that arm. Lights, all-way stop and auto always apply to the whole junction.
 */
import { addScaled, rightOf, scale } from '../core/math';
import type { RoadNetwork } from '../core/RoadNetwork';
import { totalHalfWidth } from '../core/roadTypes';
import { effectiveControl, isFreeFlowNode, movementsAt, priorityLayout } from '../core/signals';
import { autoSignalPlan } from '../core/highwayCrossing';
import type { Id, JunctionControl, NodeArm, SignalPlan, SignKind, Vec3 } from '../core/types';
import type { ToolMark } from '../render/api';

export type ControlKind = 'signal' | 'stop' | 'allStop' | 'yield' | 'priority' | 'auto';

export interface ControlCard {
  kind: ControlKind;
  name: string;
  description: string;
  /** Its number in the Traffic Control tab: keys 1 to 9 pick the tab's cards. */
  key: string;
  /** Applies per arm when an arm is clicked. */
  perArm: boolean;
}

export const CONTROL_CARDS: readonly ControlCard[] = [
  { kind: 'signal', name: 'Traffic light', description: 'Default phase plan', key: '1', perArm: false },
  { kind: 'stop', name: 'Stop signs', description: 'Minor road, or one arm', key: '2', perArm: true },
  { kind: 'allStop', name: 'All-way stop', description: 'Every approach', key: '3', perArm: false },
  { kind: 'yield', name: 'Yield', description: 'Minor road, or one arm', key: '4', perArm: true },
  { kind: 'priority', name: 'Priority road', description: 'Main road first', key: '5', perArm: true },
  { kind: 'auto', name: 'Auto', description: 'From the road types', key: '6', perArm: false },
];

export function controlCard(kind: ControlKind): ControlCard {
  return CONTROL_CARDS.find((c) => c.kind === kind)!;
}

/** A junction, or one arm of it. */
export interface ControlTarget {
  nodeId: Id;
  /** The arm's segment, or null for the whole junction. */
  armSeg: Id | null;
}

export type ControlPlan =
  | { ok: true; control: JunctionControl; changed: boolean; summary: string }
  | { ok: false; reason: string };

const MODE_NAMES = { auto: 'Auto', priority: 'Priority signs', allStop: 'All-way stop', signal: 'Traffic lights' } as const;

/** Why no card can be applied here, or null when they can. */
export function controlRefusal(net: RoadNetwork, nodeId: Id): string | null {
  const geom = net.nodeGeom(nodeId);
  if (!geom || geom.kind !== 'junction') return 'Not a junction.';
  if (isFreeFlowNode(net, nodeId)) return 'Highway merges and splits are free-flow, so they take no signs or signals.';
  if (geom.arms.some((a) => net.roadTypeOf(a.segmentId).category === 'roundabout')) {
    return 'Part of a roundabout. Use the Roundabout card to change it.';
  }
  if (priorityLayout(net, nodeId).incoming.length === 0) return 'No traffic arrives at this junction.';
  return null;
}

/** The node's plan when it is still usable, else a fresh default. Keeps a user's edited phases. */
function signalPlanFor(net: RoadNetwork, nodeId: Id): SignalPlan {
  const current = net.getNode(nodeId)?.control.signal;
  if (current && current.phases.length) {
    const keys = new Set(movementsAt(net, nodeId).map((m) => m.key));
    const used = current.phases.flatMap((p) => Object.keys(p.moves));
    if (used.length && used.every((k) => keys.has(k))) return current;
  }
  // Protected or linked phases at a highway crossing (core/highwayCrossing.ts).
  return autoSignalPlan(net, nodeId);
}

function sameSigns(a: Record<number, SignKind>, b: Record<number, SignKind>, arms: Id[]): boolean {
  return arms.every((id) => (a[id] ?? 'none') === (b[id] ?? 'none'));
}

/** What applying `kind` to `target` would set, without touching the network. */
export function planControl(net: RoadNetwork, target: ControlTarget, kind: ControlKind): ControlPlan {
  const { nodeId } = target;
  const node = net.getNode(nodeId);
  if (!node) return { ok: false, reason: 'Not a junction.' };
  const refusal = controlRefusal(net, nodeId);
  if (refusal) return { ok: false, reason: refusal };
  const layout = priorityLayout(net, nodeId);
  const card = controlCard(kind);
  const arm = card.perArm ? target.armSeg : null;
  if (arm !== null && !layout.incoming.includes(arm)) {
    return { ok: false, reason: 'Traffic only leaves the junction along this road, so it has nothing to sign.' };
  }
  const now = node.control;
  const base: JunctionControl = { ...now, signs: { ...now.signs }, crosswalks: { ...now.crosswalks } };

  if (kind === 'signal' || kind === 'allStop' || kind === 'auto') {
    const mode = kind === 'signal' ? 'signal' : kind;
    const control: JunctionControl = { ...base, mode };
    if (kind === 'signal') control.signal = signalPlanFor(net, nodeId);
    if (kind === 'auto') control.signs = {};
    const changed =
      now.mode !== mode || (kind === 'signal' && now.signal !== control.signal) || (kind === 'auto' && Object.keys(now.signs).length > 0);
    const summary = kind === 'auto' ? `Auto: ${autoName(net, nodeId)}` : MODE_NAMES[mode];
    return { ok: true, control, changed, summary };
  }

  // Signs. Start from what the junction shows now when it already has signs, else
  // from the main road going first.
  const current = effectiveControl(net, nodeId);
  const computed: Record<number, SignKind> = {};
  for (const id of layout.arms) computed[id] = layout.main.includes(id) ? 'priority' : 'yield';
  const start: Record<number, SignKind> = { ...computed };
  if (current.kind === 'priority' && !current.auto) Object.assign(start, current.signs);

  const signs: Record<number, SignKind> = { ...start };
  const sign: SignKind = kind === 'stop' ? 'stop' : kind === 'yield' ? 'yield' : 'priority';
  let summary: string;
  if (arm !== null) {
    signs[arm] = sign;
    summary = `${sign === 'priority' ? 'Priority' : sign === 'stop' ? 'Stop' : 'Yield'} on this arm`;
  } else if (kind === 'priority') {
    // The main road goes first; minor arms keep a stop they already have.
    for (const id of layout.arms) {
      if (layout.main.includes(id)) signs[id] = 'priority';
      else signs[id] = start[id] === 'stop' ? 'stop' : 'yield';
    }
    summary = 'Priority road';
  } else {
    let minor = layout.incoming.filter((id) => !layout.main.includes(id));
    // Every way in is on the main road, as at a bend: they all get the sign.
    if (minor.length === 0) minor = layout.incoming;
    for (const id of layout.arms) signs[id] = minor.includes(id) ? sign : 'priority';
    summary = sign === 'stop' ? 'Stop signs on the minor road' : 'Minor road yields';
  }
  const control: JunctionControl = { ...base, mode: 'priority', signs };
  const changed = now.mode !== 'priority' || !sameSigns(now.signs, signs, layout.arms) || Object.keys(now.signs).length === 0;
  return { ok: true, control, changed, summary };
}

function autoName(net: RoadNetwork, nodeId: Id): string {
  const node = net.getNode(nodeId)!;
  const e = effectiveControl(net, nodeId, { ...node.control, mode: 'auto', signs: {} });
  return e.kind === 'none' ? 'free flow' : e.kind === 'signal' ? 'traffic lights' : e.kind === 'allStop' ? 'all-way stop' : 'priority signs';
}

/** Apply a card. Returns what happened. The caller names the undo step. */
export function applyControl(net: RoadNetwork, target: ControlTarget, kind: ControlKind): ControlPlan {
  const plan = planControl(net, target, kind);
  if (plan.ok && plan.changed) net.setJunctionControl(target.nodeId, plan.control);
  return plan;
}

// ---------------------------------------------------------------------------
// Click targets
// ---------------------------------------------------------------------------

/**
 * Turn a road hit near a junction into an arm target. `s` is how far along the
 * segment the hit is, in metres from its a end. Returns null when the hit is
 * further than `reach` from the junction's edge.
 */
export function armTargetFromRoad(net: RoadNetwork, segmentId: Id, t: number, reach: number): ControlTarget | null {
  const seg = net.getSegment(segmentId);
  const geom = net.segmentGeom(segmentId);
  if (!seg || !geom) return null;
  const s = t * geom.fullLength;
  const fromA = s - geom.trimA;
  const fromB = geom.fullLength - s - geom.trimB;
  const ends: { node: Id; d: number }[] = [
    { node: seg.a, d: fromA },
    { node: seg.b, d: fromB },
  ];
  ends.sort((x, y) => x.d - y.d);
  for (const end of ends) {
    if (end.d > reach) continue;
    if (net.nodeGeom(end.node)?.kind !== 'junction') continue;
    return { nodeId: end.node, armSeg: segmentId };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ghost
// ---------------------------------------------------------------------------

export const GHOST_COLORS = {
  stop: '#ef4444',
  yield: '#f59e0b',
  priority: '#facc15',
  go: '#22c55e',
  permissive: '#f59e0b',
  later: '#cbd5e1',
  target: '#e2e8f0',
} as const;

/** Where a sign for traffic arriving on this arm stands: back from the cut, on the arrival side. */
export function signSpot(net: RoadNetwork, arm: NodeArm): Vec3 {
  const def = net.roadTypeOf(arm.segmentId);
  const twoWay = def.lanes.some((l) => l.dir === -1) && def.lanes.some((l) => l.dir === 1);
  const inward = scale(arm.cutDir, -1);
  const right = rightOf(inward);
  const side = twoWay ? def.halfWidth * 0.5 : 0;
  return addScaled(addScaled(arm.centre, right, side), arm.cutDir, 4);
}

function polygon(centre: Vec3, radius: number, sides: number, turn: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= sides; i++) {
    const a = turn + (i / sides) * Math.PI * 2;
    pts.push({ x: centre.x + Math.cos(a) * radius, y: centre.y, z: centre.z + Math.sin(a) * radius });
  }
  return pts;
}

/** A filled-looking shape: a thick ribbon round a small polygon. */
function badge(centre: Vec3, sign: SignKind, facing: Vec3, size: number): ToolMark[] {
  const heading = Math.atan2(facing.z, facing.x);
  if (sign === 'stop') {
    return [{ kind: 'line', points: polygon(centre, size * 0.55, 8, Math.PI / 8), color: GHOST_COLORS.stop, width: size * 0.9 }];
  }
  if (sign === 'yield') {
    // Point towards the arriving driver, like the teeth painted on the road.
    return [{ kind: 'line', points: polygon(centre, size * 0.6, 3, heading), color: GHOST_COLORS.yield, width: size * 0.55 }];
  }
  if (sign === 'priority') {
    return [{ kind: 'line', points: polygon(centre, size * 0.5, 4, heading), color: GHOST_COLORS.priority, width: size * 0.7 }];
  }
  return [];
}

function lanePoints(net: RoadNetwork, idx: number): Vec3[] {
  const lane = net.laneGraph.lanes[idx];
  const pts: Vec3[] = [];
  for (let i = 0; i < lane.pts.length; i += 3) pts.push({ x: lane.pts[i], y: lane.pts[i + 1], z: lane.pts[i + 2] });
  return pts;
}

function arrowHead(pts: Vec3[], color: string, size: number): ToolMark | null {
  if (pts.length < 2) return null;
  const end = pts[pts.length - 1];
  const prev = pts[Math.max(0, pts.length - 3)];
  const dx = end.x - prev.x;
  const dz = end.z - prev.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return null;
  const f = { x: dx / len, y: 0, z: dz / len };
  const r = rightOf(f);
  const back = addScaled(end, f, -size);
  return {
    kind: 'line',
    points: [addScaled(back, r, size * 0.6), end, addScaled(back, r, -size * 0.6)],
    color,
    width: 0.7,
  };
}

/** Marks showing a junction as it would be with `control`, plus the target. */
export function controlGhost(net: RoadNetwork, target: ControlTarget, control: JunctionControl, summary: string): ToolMark[] {
  const marks: ToolMark[] = [];
  const geom = net.nodeGeom(target.nodeId);
  const node = net.getNode(target.nodeId);
  if (!geom || !node) return marks;
  const eff = effectiveControl(net, target.nodeId, control);
  const half = Math.max(...geom.arms.map((a) => totalHalfWidth(net.roadTypeOf(a.segmentId))));
  const size = Math.max(1.8, Math.min(3.5, half * 0.35));

  if (eff.kind === 'signal' && eff.signal) {
    const moves = movementsAt(net, target.nodeId);
    const first = eff.signal.phases[0]?.moves ?? {};
    for (const m of moves) {
      const state = first[m.key];
      const color = state === 'protected' ? GHOST_COLORS.go : state === 'permissive' ? GHOST_COLORS.permissive : GHOST_COLORS.later;
      // One arrow per movement: its middle connector.
      const pts = lanePoints(net, m.connectors[Math.floor(m.connectors.length / 2)]);
      marks.push({ kind: 'line', points: pts, color, width: state ? 0.6 : 0.3, dashed: !state });
      const head = state ? arrowHead(pts, color, 1.6) : null;
      if (head) marks.push(head);
    }
    for (const arm of geom.arms) {
      if (!movementsAt(net, target.nodeId).some((m) => m.fromSegment === arm.segmentId)) continue;
      marks.push({ kind: 'point', pos: signSpot(net, arm), color: GHOST_COLORS.go, radius: size * 0.4 });
    }
  } else {
    for (const arm of geom.arms) {
      const sign = eff.signs[arm.segmentId];
      if (!sign || sign === 'none') continue;
      marks.push(...badge(signSpot(net, arm), sign, arm.cutDir, size));
    }
  }
  // The arm being signed, or the junction, gets a quiet outline.
  if (target.armSeg !== null) {
    const arm = geom.arms.find((a) => a.segmentId === target.armSeg);
    if (arm) marks.push({ kind: 'line', points: [arm.leftEdge, arm.rightEdge], color: GHOST_COLORS.target, width: 0.5, dashed: true });
  } else if (geom.outline.length > 2) {
    marks.push({ kind: 'line', points: [...geom.outline, geom.outline[0]], color: GHOST_COLORS.target, width: 0.35, dashed: true });
  }
  marks.push({ kind: 'label', pos: { x: node.pos.x, y: node.pos.y + 2, z: node.pos.z }, text: summary });
  return marks;
}
