/**
 * Roads crossing a highway at grade.
 *
 * A junction with a highway arm is controlled access by default (core/ramps.ts):
 * right in and right out only, free-flowing. A road drawn straight across a highway
 * instead makes a crossing (`JunctionControl.highwayAccess === 'crossing'`):
 *
 * - Connectors: the highway keeps every lane straight on, its outer lanes also turn
 *   off, and the side road crosses and turns as at any junction.
 * - Control: auto picks traffic lights, with every phase protected. A crossing on its
 *   own runs protected lefts. Two crossings of a divided highway (two one-way roads)
 *   close together run as one linked pair, so nothing stops in the median between.
 *
 * Older saves have no `highwayAccess`, so their junctions keep right in and right
 * out. `drawRoad` sets 'crossing' on crossings it makes (`tagNewCrossings`).
 */
import type { Id, MovementKey, MovementState, NodeArm, RoadCategory, SignalPhase, SignalPlan } from './types';
import type { RoadNetwork } from './RoadNetwork';
import type { ArmLanes, LaneEnd } from './connectors';
import { LinkSet, connect, exitsFrom, feedOrphans, linkGeneral, linkTurnarounds } from './connectors';
import { defaultSignalPlan, movementsAt, type Movement } from './signals';
import { headingOf, wrapAngle } from './math';

/** Two arms are one road passing through when this close to opposite, radians. */
const OPPOSITE = 0.7;
/**
 * Two crossings of a divided highway closer than this (node to node, metres) run as
 * one linked pair. A median wider than this has room to queue in.
 */
export const PAIR_MAX = 60;
/** Roads that are not the side road of a crossing. */
const NOT_SIDE: ReadonlySet<RoadCategory> = new Set<RoadCategory>(['highway', 'ramp', 'rail', 'roundabout']);

function oppositeness(a: NodeArm, b: NodeArm): number {
  return Math.abs(wrapAngle(headingOf(a.dir) - headingOf(b.dir) - Math.PI));
}

function roadArms(net: RoadNetwork, nodeId: Id): NodeArm[] {
  return (net.nodeGeom(nodeId)?.arms ?? []).filter((a) => net.roadTypeOf(a.segmentId).category !== 'rail');
}

/**
 * True when a node is shaped like a road crossing a highway: two or more highway
 * arms, and a side road (not a ramp) passing straight through. No ramp or lane attach.
 */
export function crossingShaped(net: RoadNetwork, nodeId: Id): boolean {
  const geom = net.nodeGeom(nodeId);
  if (!geom || geom.kind !== 'junction') return false;
  const arms = roadArms(net, nodeId);
  const cat = (a: NodeArm) => net.roadTypeOf(a.segmentId).category;
  for (const a of arms) {
    const c = cat(a);
    if (c === 'ramp' || c === 'roundabout') return false;
    const seg = net.getSegment(a.segmentId);
    if (seg && ((seg.a === nodeId && seg.overrides.attachA) || (seg.b === nodeId && seg.overrides.attachB))) return false;
  }
  const side = arms.filter((a) => !NOT_SIDE.has(cat(a)));
  if (arms.filter((a) => cat(a) === 'highway').length < 2 || side.length < 2) return false;
  for (let i = 0; i < side.length; i++) {
    for (let j = i + 1; j < side.length; j++) if (oppositeness(side[i], side[j]) < OPPOSITE) return true;
  }
  return false;
}

/** True when a node is a highway junction set to work as an at-grade crossing. */
export function isHighwayCrossing(net: RoadNetwork, nodeId: Id): boolean {
  const node = net.getNode(nodeId);
  if (!node || node.control.highwayAccess !== 'crossing') return false;
  const arms = roadArms(net, nodeId);
  return arms.length >= 3 && arms.some((a) => net.roadTypeOf(a.segmentId).category === 'highway');
}

/** True when a road other than a ramp meets a highway at this junction, so the access choice matters. */
export function hasHighwayAccessChoice(net: RoadNetwork, nodeId: Id): boolean {
  if (net.nodeGeom(nodeId)?.kind !== 'junction') return false;
  const arms = roadArms(net, nodeId);
  const cats = arms.map((a) => net.roadTypeOf(a.segmentId).category);
  return arms.length >= 3 && cats.includes('highway') && cats.some((c) => !NOT_SIDE.has(c));
}

/**
 * Mark the crossings a draw made. `before` holds the nodes that were already
 * crossing-shaped, which stay as they were. A node the user set by hand is left alone.
 */
export function tagNewCrossings(net: RoadNetwork, nodes: Iterable<Id>, before: ReadonlySet<Id>): void {
  for (const id of nodes) {
    const node = net.getNode(id);
    if (!node || before.has(id) || node.control.highwayAccess !== undefined) continue;
    if (crossingShaped(net, id)) net.setJunctionControl(id, { highwayAccess: 'crossing' });
  }
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

/**
 * Links at a crossing. A highway approach with a highway straight ahead keeps
 * every lane going straight, lane for lane; its leftmost lane also turns left and
 * its rightmost turns right. Everything else links as at any junction.
 */
export function linkHighwayCrossing(set: LinkSet, arms: ArmLanes[]): void {
  const drive = (l: LaneEnd) => l.kind === 'drive';
  const own = new Set<number>();
  arms.forEach((arm, a) => {
    if (arm.category !== 'highway') return;
    const lanes = arm.incoming.filter(drive);
    if (lanes.length < 2) return;
    const exits = exitsFrom(arms, a, drive);
    const through = exits.findIndex((e) => e.turn === 'straight');
    if (through < 0 || arms[exits[through].arm].category !== 'highway') return;
    own.add(a);
    connect(set, lanes, exits[through].lanes, 'lateral', 'straight');
    const n = lanes.length;
    for (const e of exits.slice(0, through)) set.add(lanes[0], e.lanes[0], e.turn);
    for (const e of exits.slice(through + 1)) set.add(lanes[n - 1], e.lanes[e.lanes.length - 1], e.turn);
  });
  const general = new LinkSet();
  linkGeneral(general, arms, drive);
  for (const l of general.links.values()) {
    const from = arms.findIndex((arm) => arm.incoming.includes(l.from));
    if (!own.has(from)) set.add(l.from, l.to, l.turn);
  }
  feedOrphans(set, arms, drive);
  const bike = (l: LaneEnd) => l.kind === 'bike';
  linkGeneral(set, arms, bike);
  feedOrphans(set, arms, bike);
  feedOrphans(set, arms, (l) => l.kind !== 'bike' && l.kind !== 'rail');
  // A side road left with no way on turns round. A highway never does.
  linkTurnarounds(set, arms.filter((a) => a.category !== 'highway'));
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface CrossingPair {
  /** The lower node id, which runs the first half of the shared cycle. */
  first: Id;
  second: Id;
  /** The side road between them, across the median. */
  link: Id;
  length: number;
}

/** A crossing that can pair: auto or lights, and every highway arm one-way. */
function pairable(net: RoadNetwork, nodeId: Id): boolean {
  if (!isHighwayCrossing(net, nodeId)) return false;
  const node = net.getNode(nodeId)!;
  if (node.control.mode !== 'auto' && node.control.mode !== 'signal') return false;
  const hw = roadArms(net, nodeId).filter((a) => net.roadTypeOf(a.segmentId).category === 'highway');
  return hw.every((a) => net.roadTypeOf(a.segmentId).lanes.every((l) => l.dir === 1));
}

function partnerOf(net: RoadNetwork, nodeId: Id): { node: Id; link: Id; length: number } | null {
  if (!pairable(net, nodeId)) return null;
  let best: { node: Id; link: Id; length: number } | null = null;
  for (const segId of net.getNode(nodeId)!.segments) {
    const seg = net.getSegment(segId);
    if (!seg || NOT_SIDE.has(net.roadTypeOf(segId).category)) continue;
    const other = seg.a === nodeId ? seg.b : seg.a;
    if (other === nodeId || !pairable(net, other)) continue;
    const length = net.segmentGeom(segId)?.fullLength ?? Infinity;
    if (length > PAIR_MAX) continue;
    if (!best || length < best.length) best = { node: other, link: segId, length };
  }
  return best;
}

/**
 * The crossing paired with this one across the median of a divided highway, when
 * each is the other's nearest, or null.
 */
export function crossingPair(net: RoadNetwork, nodeId: Id): CrossingPair | null {
  const p = partnerOf(net, nodeId);
  if (!p || partnerOf(net, p.node)?.node !== nodeId) return null;
  return { first: Math.min(nodeId, p.node), second: Math.max(nodeId, p.node), link: p.link, length: p.length };
}

interface PairSide {
  /** From the side road outside the pair. */
  outer: Movement[];
  /** From the highway carriageway, except into the median. */
  highway: Movement[];
  /** From the highway carriageway into the median. */
  intoMedian: Movement[];
  /** From the link across the median. */
  median: Movement[];
}

function pairSide(net: RoadNetwork, nodeId: Id, link: Id): PairSide {
  const side: PairSide = { outer: [], highway: [], intoMedian: [], median: [] };
  for (const m of movementsAt(net, nodeId)) {
    if (m.fromSegment === link) side.median.push(m);
    else if (net.roadTypeOf(m.fromSegment).category !== 'highway') side.outer.push(m);
    else if (m.toSegment === link) side.intoMedian.push(m);
    else side.highway.push(m);
  }
  return side;
}

function lanesOf(net: RoadNetwork, moves: readonly Movement[]): number {
  return Math.max(1, ...moves.map((m) => net.roadTypeOf(m.fromSegment).lanes.length));
}

/**
 * One node's half of a linked pair. Both nodes build the same phase list from the
 * same data, so their cycles match and, run by the clock from offset 0, stay in
 * step. Every phase lets traffic into the median at one end only while the other
 * end lets it out, and a short phase clears the median before the far end changes,
 * so nothing waits in it. Every move is protected:
 *
 * 1. Both carriageways run straight on and turn away from the median.
 * 2. The first carriageway also turns into the median; the far end lets it out.
 * 3. The side road crosses from the first end; the far end lets it out.
 * 4. The median clears.
 * 5 to 7. The same from the second end.
 */
export function pairedSignalPlan(net: RoadNetwork, nodeId: Id, pair: CrossingPair): SignalPlan {
  const A = pairSide(net, pair.first, pair.link);
  const B = pairSide(net, pair.second, pair.link);
  const clearSec = Math.max(3, Math.min(8, Math.round(pair.length / 6)));
  interface Row {
    name: string;
    a: Movement[];
    b: Movement[];
    green: number;
    clear?: boolean;
  }
  const hwGreen = Math.min(40, 10 + 5 * lanesOf(net, [...A.highway, ...B.highway]));
  const rows: Row[] = [];
  if (A.highway.length || B.highway.length) rows.push({ name: 'Highway', a: A.highway, b: B.highway, green: hwGreen });
  const halves: [PairSide, 'a' | 'b', PairSide, string][] = [
    [A, 'a', B, 'first'],
    [B, 'b', A, 'second'],
  ];
  for (const [near, at, far, label] of halves) {
    const put = (name: string, moves: Movement[], green: number, clear = false) => {
      rows.push({ name, a: at === 'a' ? moves : far.median, b: at === 'b' ? moves : far.median, green, clear });
    };
    let fed = false;
    if (near.intoMedian.length) {
      put(`Highway turns at ${label} crossing`, [...near.highway, ...near.intoMedian], 8);
      fed = true;
    }
    if (near.outer.length) {
      put(`Side road at ${label} crossing`, near.outer, Math.min(30, 10 + 2 * lanesOf(net, near.outer)));
      fed = true;
    }
    if (fed && far.median.length) put('Clear the median', [], clearSec, true);
  }
  const mine = nodeId === pair.first ? 'a' : 'b';
  const phases: SignalPhase[] = rows.map((r, i) => {
    const moves: Record<MovementKey, MovementState> = {};
    for (const m of r[mine]) moves[m.key] = 'protected';
    return {
      id: i + 1,
      name: r.name,
      greenSec: r.green,
      yellowSec: 3,
      allRedSec: r.clear ? 1 : 1.5,
      minGreenSec: r.clear ? r.green : 6,
      maxGreenSec: r.clear ? r.green : 60,
      moves,
    };
  });
  return { kind: 'fixed', offsetSec: 0, phases };
}

/**
 * The plan a node's lights run when nobody has set one: a linked pair or protected
 * lefts at a highway crossing, opposing approaches together anywhere else.
 */
export function autoSignalPlan(net: RoadNetwork, nodeId: Id): SignalPlan {
  if (isHighwayCrossing(net, nodeId)) {
    const pair = crossingPair(net, nodeId);
    return pair ? pairedSignalPlan(net, nodeId, pair) : defaultSignalPlan(net, nodeId, 'protectedLefts');
  }
  return defaultSignalPlan(net, nodeId, 'opposing');
}
