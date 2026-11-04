/**
 * What goes with a road when it is turned round. RoadNetwork.reverseSegment swaps
 * the ends. These work out everything attached to them, using public reads only.
 */
import type { RoadNetwork } from './RoadNetwork';
import { isOneWay, lanesMirror } from './roadTypes';
import { movementsAt } from './signals';
import type {
  Id,
  LaneLink,
  MarkingAnchor,
  MarkingPointSetting,
  MovementKey,
  NodeMarking,
  MovementState,
  RoadNode,
  RoadPaintRef,
  RoadTypeDef,
  SegmentOverrides,
  TurnKind,
} from './types';

export interface ReverseReport {
  segmentId: Id;
  /** Plain sentences naming what had to change at the junctions. */
  changes: string[];
  /** Nodes where a lane now has no way out, or no way in. */
  stranded: Id[];
  /** The road reads the same from both ends, so nothing visible changed. */
  looksTheSame: boolean;
}

/**
 * Mirror a curve parameter. Rounded to a fixed grid, because 1 - (1 - t) is not
 * always t in floating point and turning a road twice should change nothing.
 */
export function flipT(t: number): number {
  return Math.round((1 - t) * 1e9) / 1e9;
}

export function isSymmetricRoad(def: RoadTypeDef, overrides: SegmentOverrides): boolean {
  if (isOneWay(def) || !lanesMirror(def)) return false;
  if ((def.sidewalkLeft ?? def.sidewalk) !== (def.sidewalkRight ?? def.sidewalk)) return false;
  return !overrides.laneKinds && !overrides.laneSpeeds;
}

function nameOf(net: RoadNetwork, id: Id): string {
  return net.getSegment(id)?.overrides.name || net.roadTypeOf(id).name;
}

/** Boundaries count across a-to-b, so swapping the ends mirrors them. Kerb and row anchors keep their places. */
function mirrorAnchor(a: MarkingAnchor, id: Id, count: number, ends = false): MarkingAnchor {
  if (a.segmentId !== id || a.corner !== undefined) return a;
  const out: MarkingAnchor = { ...a, boundary: count - 1 - a.boundary };
  if (ends && a.end) out.end = a.end === 'a' ? 'b' : 'a';
  return out;
}

function mirrorPoint(p: MarkingPointSetting, id: Id, count: number, ends = false): MarkingPointSetting {
  if (p.segmentId !== id) return p;
  const out: MarkingPointSetting = { ...p, boundary: count - 1 - p.boundary };
  // At a node, left and right are as seen from the arm, which turning the road does not change.
  // Along a segment they are seen from a to b, which it does.
  if (ends) {
    if (p.offset) out.offset = -p.offset;
    if (p.place) out.place = p.place === 'left' ? 'right' : 'left';
    if (p.end) out.end = p.end === 'a' ? 'b' : 'a';
  }
  return out;
}

function mirrorList(list: NodeMarking[], id: Id, count: number, ends: boolean): NodeMarking[] {
  return list.map((m) =>
    m.kind === 'line'
      ? { ...m, from: mirrorAnchor(m.from, id, count, ends), to: mirrorAnchor(m.to, id, count, ends) }
      : { ...m, anchors: m.anchors.map((a) => mirrorAnchor(a, id, count, ends)) },
  );
}

/**
 * Mirror what a node holds on one of its arms when that road turns round: marking
 * anchors, point settings, and the lane of any arrow taken away. `lanes` are the
 * road's lanes, the same before and after since only the ends swap.
 */
export function mirrorMarkings(node: RoadNode, id: Id, count: number, lanes: readonly { offset: number }[] = []): void {
  const c = node.control;
  if (c.markings) c.markings = mirrorList(c.markings, id, count, false);
  if (c.markingPoints) c.markingPoints = c.markingPoints.map((p) => mirrorPoint(p, id, count));
  if (c.autoOff) {
    c.autoOff = c.autoOff.map((r) => {
      if (r.kind !== 'arrow' || r.segmentId !== id) return r;
      const old = lanes[r.lane];
      const lane = old ? lanes.findIndex((l) => Math.abs(l.offset + old.offset) < 0.01) : -1;
      return { ...r, lane: lane < 0 ? r.lane : lane };
    });
  }
}

/** Mirror a segment's own markings when it turns round: its ends swap too. */
export function mirrorSegmentMarkings(overrides: SegmentOverrides, id: Id, count: number): void {
  if (overrides.handMarkings) overrides.handMarkings = mirrorList(overrides.handMarkings, id, count, true);
  if (overrides.markingPoints) overrides.markingPoints = overrides.markingPoints.map((p) => mirrorPoint(p, id, count, true));
}

/** Mirror paint on one segment. Walking order stays the same in the world. */
export function flipPaintOn(ref: RoadPaintRef, id: Id): boolean {
  if (!ref.pieces.some((p) => p.segmentId === id)) return false;
  // A stamp has no walking direction, so its measures flip with the segment.
  const stamp = ref.pieces.length === 1 && ref.pieces[0].t0 === ref.pieces[0].t1;
  ref.pieces = ref.pieces.map((p) => (p.segmentId === id ? { ...p, segmentId: id, t0: flipT(p.t0), t1: flipT(p.t1) } : p));
  if (stamp) {
    ref.offset = -ref.offset;
    if (ref.offset2 !== undefined) ref.offset2 = -ref.offset2;
    if (ref.dir) ref.dir = ref.dir === 1 ? -1 : 1;
  }
  return true;
}

export interface LinkMirror {
  /** Links not touching the road, untouched. */
  kept: LaneLink[];
  /** Links touching it, carried to the lane in the same place, heading the same way. */
  moved: LaneLink[];
  /** Links touching it with no such lane. */
  lost: LaneLink[];
}

/**
 * Before the swap: a link to lane i stays right if some lane will sit where lane i
 * sits, running the same way. That is the lane mirrored across the road.
 */
export function mirrorLaneLinks(net: RoadNetwork, nodeId: Id, id: Id): LinkMirror | null {
  const links = net.getNode(nodeId)?.control.laneLinks;
  if (!links) return null;
  const def = net.roadTypeOf(id);
  const mirrored = (ref: string): string | null => {
    const [seg, lane] = ref.split(':').map(Number);
    if (seg !== id) return ref;
    const here = def.lanes[lane];
    if (!here) return null;
    const j = def.lanes.findIndex((l) => l.dir === -here.dir && Math.abs(l.offset + here.offset) < 0.01);
    return j < 0 ? null : `${id}:${j}`;
  };
  const out: LinkMirror = { kept: [], moved: [], lost: [] };
  for (const link of links) {
    const touches = link.from.startsWith(`${id}:`) || link.to.startsWith(`${id}:`);
    if (!touches) {
      out.kept.push(link);
      continue;
    }
    const from = mirrored(link.from);
    const to = mirrored(link.to);
    if (from && to) out.moved.push({ from, to });
    else out.lost.push(link);
  }
  return out;
}

/** After the swap: put the links back, filling in the road's new lanes automatically. */
export function reconcileLaneLinks(net: RoadNetwork, nodeId: Id, id: Id, mirror: LinkMirror | null, report: ReverseReport): void {
  if (!mirror) return;
  if (mirror.lost.length === 0) {
    net.setJunctionControl(nodeId, { laneLinks: [...mirror.kept, ...mirror.moved] });
    return;
  }
  // Ask for the automatic links, and take only the ones on this road.
  net.setJunctionControl(nodeId, { laneLinks: null });
  const auto = net
    .connectionsAt(nodeId)
    .filter((c) => c.active && (c.fromSegment === id || c.toSegment === id))
    .map((c) => ({ from: c.from, to: c.to }));
  const seen = new Set<string>();
  const merged = [...mirror.kept, ...mirror.moved, ...auto].filter((l) => {
    const key = `${l.from}>${l.to}`;
    return !seen.has(key) && !!seen.add(key);
  });
  net.setJunctionControl(nodeId, { laneLinks: merged });
  report.changes.push(`Lane links at the junction with ${nameOf(net, id)} were rebuilt for the new direction.`);
}

function stateFor(turn: TurnKind): MovementState {
  return turn === 'left' || turn === 'uturn' ? 'permissive' : 'protected';
}

/**
 * Keep a signal plan true to the movements now possible. A movement that cannot
 * happen any more goes. One that has just become possible joins the phases already
 * running its approach, or else the phases that lost something.
 */
export function reconcileSignal(net: RoadNetwork, nodeId: Id, id: Id, report: ReverseReport): void {
  const plan = net.getNode(nodeId)?.control.signal;
  if (!plan) return;
  const moves = movementsAt(net, nodeId);
  const valid = new Map(moves.map((m) => [m.key, m]));
  const present = new Set<MovementKey>();
  const removed = new Set<MovementKey>();
  const hurt = new Set<number>();
  const phases = plan.phases.map((phase, i) => {
    const kept: typeof phase.moves = {};
    for (const [key, state] of Object.entries(phase.moves)) {
      if (valid.has(key)) {
        kept[key] = state;
        present.add(key);
      } else {
        removed.add(key);
        hurt.add(i);
      }
    }
    return { ...phase, moves: kept };
  });
  const added = moves.filter((m) => !present.has(m.key));
  if (!removed.size && !added.length) return;
  const label = (key: MovementKey) => {
    const [from, to] = key.split('>').map(Number);
    const name = (seg: Id) => (net.getSegment(seg) ? nameOf(net, seg) : `road ${seg}`);
    return `${name(from)} to ${name(to)}`;
  };
  for (const m of added) {
    let homes = phases.filter((p) => Object.keys(p.moves).some((k) => k.startsWith(`${m.fromSegment}>`)));
    if (!homes.length) homes = phases.filter((_, i) => hurt.has(i));
    if (!homes.length) homes = phases.slice(0, 1);
    for (const p of homes) p.moves[m.key] = stateFor(m.turn);
  }
  const left = phases.filter((p) => Object.keys(p.moves).length > 0);
  net.setJunctionControl(nodeId, { signal: { ...plan, phases: left.length ? left : phases.slice(0, 1) } });
  if (removed.size) report.changes.push(`Signal: removed ${[...removed].map(label).join(', ')}.`);
  if (added.length) report.changes.push(`Signal: added ${added.map((m) => label(m.key)).join(', ')}.`);
}

/** Where the road now ends up with a driving lane going nowhere, or coming from nowhere. */
export function strandedNodes(net: RoadNetwork, id: Id): Id[] {
  const graph = net.laneGraph;
  const seg = net.getSegment(id);
  const dense = graph.roadLanes.get(id);
  if (!seg || !dense) return [];
  const def = net.roadTypeOf(id);
  const out = new Set<Id>();
  dense.forEach((idx, i) => {
    if (idx < 0) return;
    const lane = graph.lanes[idx];
    if (lane.vehicleKind === 'bike') return;
    const forward = def.lanes[i].dir === 1;
    const ahead = forward ? seg.b : seg.a;
    const behind = forward ? seg.a : seg.b;
    if (lane.next.length === 0 && (net.getNode(ahead)?.segments.length ?? 0) > 1) out.add(ahead);
    if (lane.prev.length === 0 && (net.getNode(behind)?.segments.length ?? 0) > 1) out.add(behind);
  });
  return [...out];
}

