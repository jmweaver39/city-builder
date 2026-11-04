/**
 * Ramps and controlled-access roads.
 *
 * Three things live here:
 *
 * 1. Lane attach. A ramp end can sit on the outer edge of a highway's carriageway
 *    instead of on its centreline (SegmentOverrides.attachA / attachB). The node
 *    stays on the highway centreline, where the highway is split. Only the ramp's
 *    curve end moves, and it is recomputed from the node and the highway's current
 *    direction and lanes, so the ramp stays attached when the highway moves.
 *
 * 2. Connector rules at junctions with a 'highway' arm. Traffic stays on its own
 *    carriageway: a ramp or street is reached only from the lanes next to it, never
 *    across opposing traffic or a median, with no left turns or U-turns across.
 *    Joins are merge-only (right in, right out). See linkControlledAccess.
 *
 * 3. Draft checks for the editor: a ramp drawn against the traffic it joins, and
 *    a street joining a highway at grade.
 */
import type { HighwayAccess, Id, LaneDef, RampAttach, RoadCategory, RoadNode, RoadTypeDef, Segment, TurnKind, Vec3 } from './types';
import type { Cubic } from './bezier';
import { cubicPoint, cubicTangentXZ } from './bezier';
import type { ArmLanes, LaneEnd, LaneLinkSpec } from './connectors';
import { LinkSet, feedOrphans, linkGeneral, linkTurnarounds, shareLanes, turnBetween } from './connectors';
import { addScaled, distXZ, dotXZ, normalizeXZ, rightOf, scale, signedTurn, sub } from './math';
import { effectiveLanes, isOneWay } from './roadTypes';
import { endShift } from './laneAlign';

/** Sharpest turn a ramp may make off or onto the traffic it serves, radians (about 115 degrees). */
export const MAX_RAMP_TURN = 2.0;
/** Highway arms closer than this to straight on carry one flow through the node. */
const PAIR_LIMIT = 0.96;

// ---------------------------------------------------------------------------
// Lane attach
// ---------------------------------------------------------------------------

/** What attach geometry needs from the network, so this module stays free of RoadNetwork. */
export interface AttachAccess {
  node(id: Id): RoadNode | undefined;
  segment(id: Id): Segment | undefined;
  def(seg: Segment): RoadTypeDef;
}

export function attachAt(seg: Segment, nodeId: Id): RampAttach | undefined {
  if (seg.a === nodeId && seg.overrides.attachA) return seg.overrides.attachA;
  if (seg.b === nodeId && seg.overrides.attachB) return seg.overrides.attachB;
  return undefined;
}

function rawCubic(acc: AttachAccess, seg: Segment): Cubic | null {
  const a = acc.node(seg.a);
  const b = acc.node(seg.b);
  if (!a || !b) return null;
  return { p0: a.pos, p1: seg.c1, p2: seg.c2, p3: b.pos };
}

/** The road a ramp end at this node attaches to: a highway first, then the widest road. */
export function pickHost(acc: AttachAccess, nodeId: Id, selfId: Id): Segment | null {
  const node = acc.node(nodeId);
  if (!node) return null;
  let best: Segment | null = null;
  let bestScore = -Infinity;
  for (const id of node.segments) {
    if (id === selfId) continue;
    const seg = acc.segment(id);
    if (!seg || attachAt(seg, nodeId) || seg.a === seg.b) continue;
    const def = acc.def(seg);
    if (def.category === 'rail') continue;
    const score = (def.category === 'highway' ? 1000 : 0) + def.lanes.length * 10 - id * 1e-6;
    if (score > bestScore) {
      bestScore = score;
      best = seg;
    }
  }
  return best;
}

/**
 * Host forward (a to b) direction at one of its nodes. Where the host carries on
 * through the node as another road, the two directions are averaged, so a ramp
 * sits square to the highway even when the joint has a kink.
 */
export function hostDirection(acc: AttachAccess, host: Segment, nodeId: Id): Vec3 | null {
  const c = rawCubic(acc, host);
  if (!c) return null;
  const own = cubicTangentXZ(c, host.a === nodeId ? 0 : 1);
  const node = acc.node(nodeId);
  const category = acc.def(host).category;
  let best: Vec3 | null = null;
  let bestDot = Math.cos(0.5);
  for (const id of node?.segments ?? []) {
    if (id === host.id) continue;
    const seg = acc.segment(id);
    if (!seg || attachAt(seg, nodeId) || acc.def(seg).category !== category) continue;
    const oc = rawCubic(acc, seg);
    if (!oc) continue;
    // That road's direction leaving this node, turned to agree with the host's travel.
    const t = cubicTangentXZ(oc, seg.a === nodeId ? 0 : 1);
    const hostLeaves = host.a === nodeId;
    const otherLeaves = seg.a === nodeId;
    const along = hostLeaves === otherLeaves ? scale(t, -1) : t;
    const d = dotXZ(along, own);
    if (d > bestDot) {
      bestDot = d;
      best = along;
    }
  }
  return best ? normalizeXZ({ x: own.x + best.x, y: 0, z: own.z + best.z }, own) : own;
}
const hostDirAt = hostDirection;

/**
 * Lateral offset of the outer edge of a road's carriageway on one side, measured
 * right of `aligned` travel (1 = the road's a to b, -1 = b to a). `side` 1 is right.
 */
export function carriagewayEdge(lanes: readonly LaneDef[], aligned: 1 | -1, side: 1 | -1): number {
  let edge = side > 0 ? -Infinity : Infinity;
  for (const l of lanes) {
    if (l.kind === 'rail') continue;
    const o = l.offset * aligned;
    edge = side > 0 ? Math.max(edge, o + l.width / 2) : Math.min(edge, o - l.width / 2);
  }
  return Number.isFinite(edge) ? edge : 0;
}

/**
 * Where a ramp end attached to a host lands. `hostDir` is the host's a-to-b
 * direction at the node, `rampDir` the ramp's direction of travel (a to b) there.
 */
export function attachPointFrom(
  nodePos: Vec3,
  hostDir: Vec3,
  hostLanes: readonly LaneDef[],
  attach: RampAttach,
  rampDir: Vec3,
  /** The ramp's own lanes: an edge merge sits beside the carriageway edge, not on it (core/edgeMerge.ts). */
  rampLanes?: readonly LaneDef[],
  /** The host end's sideways move at the node, right of its a to b (core/laneAlign.ts). */
  hostShift = 0,
): Vec3 {
  // A street terminal ends on the node like any junction arm; only its lanes are chosen.
  if (attach.lanes) return { ...nodePos };
  const aligned: 1 | -1 = dotXZ(hostDir, rampDir) >= 0 ? 1 : -1;
  const travel = scale(hostDir, aligned);
  // The host on the ramp's left means the ramp is on the host's right.
  const side: 1 | -1 = attach.hostSide === -1 ? 1 : -1;
  let edge = carriagewayEdge(hostLanes, aligned, side) + hostShift * aligned;
  // An edge-merged ramp's inner carriageway edge meets the host's, so its lanes run alongside.
  if (attach.edge && rampLanes) edge -= carriagewayEdge(rampLanes, 1, side === 1 ? -1 : 1);
  const p = addScaled(nodePos, rightOf(travel), edge);
  return { x: p.x, y: nodePos.y, z: p.z };
}

/**
 * Where an edge-merged ramp end lands: beside the narrower of the host roads at the
 * node (the one without the added or dropped lane), taking any lane alignment into account.
 */
export function edgeAttachPoint(acc: AttachAccess, seg: Segment | null, nodeId: Id, attach: RampAttach, rampDir: Vec3, rampLanes?: readonly LaneDef[]): Vec3 | null {
  const node = acc.node(nodeId);
  if (!node) return null;
  const lanes = rampLanes ?? (seg ? effectiveLanes(acc.def(seg), seg.overrides) : undefined);
  const side: 1 | -1 = attach.hostSide === -1 ? 1 : -1;
  let best: Vec3 | null = null;
  let bestLat = Infinity;
  for (const id of node.segments) {
    if (seg && id === seg.id) continue;
    const host = acc.segment(id);
    if (!host || attachAt(host, nodeId) || host.a === host.b || acc.def(host).category === 'rail') continue;
    const dir = hostDirAt(acc, host, nodeId);
    if (!dir) continue;
    const p = attachPointFrom(node.pos, dir, effectiveLanes(acc.def(host), host.overrides), attach, rampDir, lanes, endShift(acc, host, nodeId));
    const lat = dotXZ(sub(p, node.pos), rightOf(rampDir)) * side;
    if (lat < bestLat) {
      bestLat = lat;
      best = p;
    }
  }
  return best;
}

/** A segment's curve with any attached ends moved onto their host's carriageway edge. */
export function attachedCubic(acc: AttachAccess, seg: Segment, raw: Cubic): Cubic {
  const { attachA, attachB } = seg.overrides;
  if (!attachA && !attachB) return raw;
  let { p0, p3 } = raw;
  const endPoint = (attach: RampAttach, nodeId: Id, rampDir: Vec3): Vec3 | null => {
    const node = acc.node(nodeId);
    if (!node) return null;
    if (attach.edge && !attach.lanes) return edgeAttachPoint(acc, seg, nodeId, attach, rampDir);
    const host = pickHost(acc, nodeId, seg.id);
    if (!host) return null;
    const dir = hostDirAt(acc, host, nodeId);
    if (!dir) return null;
    return attachPointFrom(node.pos, dir, effectiveLanes(acc.def(host), host.overrides), attach, rampDir);
  };
  if (attachA && seg.a !== seg.b) {
    const dir = normalizeXZ(sub(distXZ(raw.p1, raw.p0) > 1e-3 ? raw.p1 : raw.p3, raw.p0));
    p0 = endPoint(attachA, seg.a, dir) ?? p0;
  }
  if (attachB && seg.a !== seg.b) {
    const dir = normalizeXZ(sub(raw.p3, distXZ(raw.p2, raw.p3) > 1e-3 ? raw.p2 : raw.p0));
    p3 = endPoint(attachB, seg.b, dir) ?? p3;
  }
  return { p0, p1: raw.p1, p2: raw.p2, p3 };
}

/**
 * A ramp attach for a road being drawn from or to a point on a host road.
 * `hostDir` is the host's a-to-b direction there, `lateral` the signed side of the
 * host (right of a-to-b positive) on which the new road lies, and `rampDir` the new
 * road's direction of travel there.
 */
export function makeAttach(lane: number, hostDir: Vec3, rampDir: Vec3, lateral: number): RampAttach {
  const aligned = dotXZ(hostDir, rampDir) >= 0 ? 1 : -1;
  // lateral is measured in the host's a-to-b frame; turn it into the ramp's frame.
  const rampSide = Math.sign(lateral * aligned) || 1;
  return { lane: Math.max(0, Math.round(lane)), hostSide: rampSide > 0 ? -1 : 1 };
}

// ---------------------------------------------------------------------------
// Controlled-access connectors
// ---------------------------------------------------------------------------

/**
 * True when a node's connectors follow the controlled-access rules. `access` is the
 * node's `JunctionControl.highwayAccess`: a 'crossing' is an ordinary junction instead
 * (core/highwayCrossing.ts), and absent keeps these rules, as in older saves.
 */
export function isControlledAccess(arms: readonly { category?: RoadCategory }[], access?: HighwayAccess): boolean {
  return access !== 'crossing' && arms.length >= 3 && arms.some((a) => a.category === 'highway');
}

interface Flow {
  /** Arm whose incoming lanes carry the flow in, or null where the flow starts here. */
  from: number | null;
  /** Arm whose outgoing lanes carry it on, or null where it ends here. */
  to: number | null;
  tin: LaneEnd[];
  tout: LaneEnd[];
  /** No opposing carriageway beside it, so its left side is a kerb, not a median. */
  oneWay: boolean;
  /** Travel direction into and out of the node. */
  headIn: Vec3;
  headOut: Vec3;
}

interface Branch {
  arm: number;
  lanes: LaneEnd[];
  side: 1 | -1;
  /** Lanes of the flow it takes, or null to work it out. */
  feed: number | null;
  /** Sort key across its side, outermost first. */
  order: number;
}

/** Pair two ordered lists without crossing; every lane on both sides gets a link. */
function pairOrdered(set: LinkSet, I: readonly LaneEnd[], O: readonly LaneEnd[], turn: ReturnType<typeof turnBetween>): void {
  if (!I.length || !O.length) return;
  for (let t = 0; t < I.length; t++) set.add(I[t], O[Math.floor(((t + 0.5) * O.length) / I.length)], turn);
  for (let b = 0; b < O.length; b++) set.add(I[Math.floor(((b + 0.5) * I.length) / O.length)], O[b], turn);
}

/**
 * Links at a junction with a highway arm. Every highway carriageway passing
 * through is a flow; other arms branch off or join a flow on their own side only.
 */
export function linkControlledAccess(set: LinkSet, arms: ArmLanes[]): void {
  const road = (l: LaneEnd) => l.kind !== 'bike' && l.kind !== 'rail';
  const n = arms.length;
  const inn = arms.map((a) => a.incoming.filter(road));
  const out = arms.map((a) => a.outgoing.filter(road));
  const isHw = arms.map((a) => a.category === 'highway');

  // Highway carriageways through the node: least bent pairs first.
  const cands: { i: number; j: number; bend: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (!isHw[i] || !inn[i].length) continue;
    for (let j = 0; j < n; j++) {
      if (j === i || !isHw[j] || !out[j].length) continue;
      const bend = Math.abs(signedTurn(scale(arms[i].cutDir, -1), arms[j].cutDir));
      if (bend < PAIR_LIMIT) cands.push({ i, j, bend });
    }
  }
  cands.sort((a, b) => a.bend - b.bend || a.i - b.i || a.j - b.j);
  const usedIn = new Set<number>();
  const usedOut = new Set<number>();
  const flows: Flow[] = [];
  const flowOf = (from: number | null, to: number | null): Flow => {
    const headIn = from !== null ? scale(arms[from].cutDir, -1) : arms[to!].cutDir;
    const headOut = to !== null ? arms[to].cutDir : headIn;
    return {
      from,
      to,
      tin: from !== null ? inn[from] : [],
      tout: to !== null ? out[to] : [],
      oneWay: (from === null || arms[from].oneWay) && (to === null || arms[to].oneWay),
      headIn,
      headOut,
    };
  };
  for (const c of cands) {
    if (usedIn.has(c.i) || usedOut.has(c.j)) continue;
    usedIn.add(c.i);
    usedOut.add(c.j);
    flows.push(flowOf(c.i, c.j));
  }
  const paired = flows.length;

  const sideOf = (f: Flow, k: number): 1 | -1 => {
    const attach = arms[k].attach;
    if (attach) {
      // An attached ramp knows its side, however close to parallel it leaves.
      const travel = arms[k].atStart ? arms[k].cutDir : scale(arms[k].cutDir, -1);
      const withFlow = dotXZ(travel, f.from !== null ? f.headIn : f.headOut) >= 0;
      return (withFlow ? -attach.hostSide : attach.hostSide) as 1 | -1;
    }
    if (f.from !== null && f.to !== null) {
      // Clockwise from the arriving arm is left to right.
      const pos = (x: number) => (x - f.from! + n) % n;
      return pos(k) < pos(f.to) ? -1 : 1;
    }
    return signedTurn(f.from !== null ? f.headIn : f.headOut, arms[k].cutDir) >= 0 ? 1 : -1;
  };
  const trunk = new Set<number>();
  for (const f of flows) {
    if (f.from !== null) trunk.add(f.from);
    if (f.to !== null) trunk.add(f.to);
  }

  const runFlow = (f: Flow) => {
    const exits: Branch[] = [];
    const entries: Branch[] = [];
    for (let k = 0; k < n; k++) {
      if (k === f.from || k === f.to) continue;
      const side = sideOf(f, k);
      // A median is on the left of a two-way highway: only the right side is ours.
      if (side < 0 && !f.oneWay) continue;
      const attach = arms[k].attach;
      const feed = attach ? Math.max(1, Math.round(attach.lane) + 1) : null;
      // Sort key: further round towards the arriving arm is further out on the right.
      const order = f.from !== null ? ((k - f.from + n) % n) * side : signedTurn(f.headIn, arms[k].cutDir) * side;
      if (out[k].length && !usedOut.has(k) && Math.abs(signedTurn(f.headIn, arms[k].cutDir)) <= MAX_RAMP_TURN) {
        exits.push({ arm: k, lanes: out[k], side, feed, order });
      }
      if (inn[k].length && !usedIn.has(k) && Math.abs(signedTurn(scale(arms[k].cutDir, -1), f.headOut)) <= MAX_RAMP_TURN) {
        entries.push({ arm: k, lanes: inn[k], side, feed, order });
      }
    }
    linkFlow(set, arms, f, exits, entries);
  };
  for (const f of flows) runFlow(f);
  // A highway branch that no flow took, or a highway that ends or begins here,
  // still keeps its traffic to its own side.
  for (let i = 0; i < n; i++) {
    if (isHw[i] && inn[i].length && !usedIn.has(i) && inn[i].every((l) => !set.hasFrom(l))) {
      usedIn.add(i);
      flows.push(flowOf(i, null));
    }
  }
  for (let j = 0; j < n; j++) {
    if (isHw[j] && out[j].length && !usedOut.has(j) && out[j].every((l) => !set.feedersOf(l).length)) {
      usedOut.add(j);
      flows.push(flowOf(null, j));
    }
  }
  for (const f of flows.slice(paired)) runFlow(f);

  // Side roads may reach each other only when no flow runs between them.
  const groups = new Map<string, number[]>();
  for (let k = 0; k < n; k++) {
    if (trunk.has(k)) continue;
    const key = flows.map((f) => sideOf(f, k)).join(',');
    const g = groups.get(key);
    if (g) g.push(k);
    else groups.set(key, [k]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const sub = g.map((k) => arms[k]);
    linkGeneral(set, sub, road);
    linkGeneral(set, sub, (l) => l.kind === 'bike');
    feedOrphans(set, sub, (l) => l.kind === 'bike');
  }
  feedOrphans(set, arms, road);
  // A side road left with no way on turns round. A highway never does.
  linkTurnarounds(set, arms.filter((a) => a.category !== 'highway'));
}

function linkFlow(set: LinkSet, arms: ArmLanes[], f: Flow, exits: Branch[], entries: Branch[]): void {
  const { tin, tout } = f;
  const m = tin.length;
  const p = tout.length;
  const turnTo = (k: number) => (f.from !== null ? turnBetween(arms, f.from, k) : 'straight');
  const turnFrom = (k: number) => (f.to !== null ? turnBetween(arms, k, f.to) : 'straight');

  if (f.to === null || f.from === null) {
    // Nothing straight on: share the flow among its branches left to right.
    const list = (f.to === null ? exits : entries).slice().sort((a, b) => a.side * a.order - b.side * b.order);
    const trunkLanes = f.to === null ? tin : tout;
    if (!list.length || !trunkLanes.length) return;
    shareLanes(
      trunkLanes.length,
      list.map((b) => b.lanes.length),
      (t, j, b) => {
        const br = list[j];
        if (f.to === null) set.add(trunkLanes[t], br.lanes[b], turnTo(br.arm));
        else set.add(br.lanes[b], trunkLanes[t], turnFrom(br.arm));
      },
    );
    return;
  }

  const outermostFirst = (list: Branch[]) => list.slice().sort((a, b) => b.order - a.order);

  // Exits: the lanes on the exit's side feed it. Lanes the mainline drops leave here.
  let dropBudget = Math.max(0, m - p);
  const fed = { 1: 0, [-1]: 0 } as Record<1 | -1, number>;
  for (const e of outermostFirst(exits)) {
    const want = e.feed ?? Math.max(1, dropBudget);
    const k = Math.max(1, Math.min(want, e.feed === null ? e.lanes.length : m, m));
    if (e.feed === null) dropBudget = Math.max(0, dropBudget - k);
    const feeders = e.side > 0 ? tin.slice(m - k) : tin.slice(0, k);
    // A branch is a turn to its own side, whatever order near-parallel arms sort in.
    pairOrdered(set, feeders, e.lanes, e.side > 0 ? 'right' : 'left');
    fed[e.side] = Math.max(fed[e.side], k);
  }
  const drops = exits.length ? Math.max(0, m - p) : 0;
  const dropRight = Math.min(drops, fed[1]);
  const dropLeft = Math.min(drops - dropRight, fed[-1]);

  // Entries: a joining road takes the lanes on its side. Lanes the mainline adds are its own.
  let addBudget = Math.max(0, p - m);
  const took = { 1: 0, [-1]: 0 } as Record<1 | -1, number>;
  for (const e of outermostFirst(entries)) {
    const want = e.feed ?? Math.max(1, addBudget);
    const k = Math.max(1, Math.min(want, e.feed === null ? e.lanes.length : p, p));
    if (e.feed === null) addBudget = Math.max(0, addBudget - k);
    const targets = e.side > 0 ? tout.slice(p - k) : tout.slice(0, k);
    pairOrdered(set, e.lanes, targets, e.side > 0 ? 'right' : 'left');
    took[e.side] = Math.max(took[e.side], k);
  }
  const adds = entries.length ? Math.max(0, p - m) : 0;
  const resRight = Math.min(adds, took[1]);
  const resLeft = Math.min(adds - resRight, took[-1]);

  const through = tin.slice(dropLeft, m - dropRight);
  const targets = tout.slice(resLeft, p - resRight);
  pairOrdered(set, through.length ? through : tin, targets.length ? targets : tout, turnBetween(arms, f.from, f.to));
}

// ---------------------------------------------------------------------------
// Street attaches
// ---------------------------------------------------------------------------
//
// A road can attach to lanes of a street or avenue too, in one of two ways:
//
// - Side merge (no `lanes`): a one-way road leaving or joining along the kerb,
//   like a highway ramp or a free-flow slip lane. Its end sits on the carriageway
//   edge and the outermost `lane + 1` lanes of the carriageway on its side feed or
//   take it. Nothing crosses to the other carriageway.
// - Terminal (`lanes`): the road ends on the node like any junction arm, and turns
//   into or out of exactly the chosen host lanes, left into the far carriageway and
//   right into the near one. A two-way road uses the same lanes both ways.
//
// The host's own traffic is linked as if the attached road were not there, so its
// through lanes keep going straight and the chosen lanes also serve the attached
// road. Hand-set laneLinks still win, as everywhere.

/** Roads a lane attach can use at grade with turns: streets, one-way streets and avenues. */
export function isStreetHost(category: RoadCategory | undefined): boolean {
  return category === 'street' || category === 'avenue' || category === 'oneway';
}

const roadLane = (l: LaneEnd) => l.kind !== 'bike' && l.kind !== 'rail';

/** The host arm of an attached arm at a node, as pickHost picks it, and the arm it carries on as. */
function hostArmsOf(arms: readonly ArmLanes[], k: number): { h: number; h2: number | null } | null {
  let h = -1;
  let best = -Infinity;
  arms.forEach((a, i) => {
    if (i === k || a.attach || a.category === 'rail') return;
    const score = (a.category === 'highway' ? 1000 : 0) + (a.incoming.length + a.outgoing.length) * 10 - a.segmentId * 1e-6;
    if (score > best) {
      best = score;
      h = i;
    }
  });
  if (h < 0) return null;
  let h2: number | null = null;
  let bend = PAIR_LIMIT;
  arms.forEach((a, i) => {
    if (i === k || i === h || a.attach || a.category === 'rail') return;
    const b = Math.abs(signedTurn(scale(arms[h].cutDir, -1), a.cutDir));
    if (b < bend) {
      bend = b;
      h2 = i;
    }
  });
  return { h, h2 };
}

/** One host lane an attached road links with, and the arm it is on at the node. */
interface HostPick {
  lane: LaneEnd;
  arm: number;
}

interface StreetPlan {
  arm: number;
  /** Host lanes the attached road's arriving lanes turn into. */
  targets: HostPick[];
  /** Host lanes that turn into the attached road's leaving lanes. */
  sources: HostPick[];
  /** A side merge: every link is a turn to the attached road's side. */
  forced: TurnKind | null;
  /** Arm straight across the junction, for a terminal. */
  across: number | null;
}

/**
 * The host lanes across the road at arm `h`, nearest the attached road's side
 * first, each with whether it arrives at the node there. This is the order
 * `RampAttach.lanes` counts in.
 */
export function hostCrossSection(arms: readonly ArmLanes[], h: number, rightSide: boolean): { lane: LaneEnd; incoming: boolean }[] {
  // Positions across the road, right of a driver arriving on h positive.
  const slots = [
    ...arms[h].incoming.filter(roadLane).map((lane) => ({ lane, incoming: true, x: lane.lat })),
    ...arms[h].outgoing.filter(roadLane).map((lane) => ({ lane, incoming: false, x: -lane.lat })),
  ];
  slots.sort((a, b) => (rightSide ? b.x - a.x : a.x - b.x));
  return slots.map(({ lane, incoming }) => ({ lane, incoming }));
}

function nearestLat(list: readonly LaneEnd[], lat: number): LaneEnd | null {
  let best: LaneEnd | null = null;
  for (const l of list) if (!best || Math.abs(l.lat - lat) < Math.abs(best.lat - lat)) best = l;
  return best;
}

function planStreetAttach(arms: readonly ArmLanes[], k: number): StreetPlan | null {
  const attach = arms[k].attach;
  if (!attach) return null;
  const host = hostArmsOf(arms, k);
  if (!host || !isStreetHost(arms[host.h].category)) return null;
  const { h, h2 } = host;
  const terminal = Array.isArray(attach.lanes);
  const arrive = scale(arms[h].cutDir, -1);
  let rightSide: boolean;
  if (terminal) {
    rightSide = dotXZ(arms[k].cutDir, rightOf(arrive)) >= 0;
  } else {
    // A side merge runs nearly parallel, so it goes by the side it was drawn on.
    const travel = arms[k].atStart ? arms[k].cutDir : scale(arms[k].cutDir, -1);
    rightSide = (dotXZ(travel, arrive) >= 0 ? -attach.hostSide : attach.hostSide) > 0;
  }
  const slots = hostCrossSection(arms, h, rightSide);
  if (!slots.length) return null;
  let chosen: number[];
  if (terminal) {
    chosen = [...new Set(attach.lanes!.filter((p) => Number.isInteger(p) && p >= 0 && p < slots.length))];
  } else {
    // Only the carriageway on its own side: the outermost lane + 1 lanes of it.
    let near = 0;
    while (near < slots.length && slots[near].incoming === slots[0].incoming) near++;
    chosen = [];
    for (let p = 0; p <= Math.min(Math.round(attach.lane), near - 1); p++) chosen.push(p);
  }
  const inn = arms[k].incoming.filter(roadLane);
  const out = arms[k].outgoing.filter(roadLane);
  const targets: HostPick[] = [];
  const sources: HostPick[] = [];
  const heading = scale(arms[k].cutDir, -1);
  for (const p of chosen) {
    const { lane, incoming } = slots[p];
    // The same piece of road on the far side of the node, for a lane that carries on.
    const other = (list: 'incoming' | 'outgoing') => (h2 === null ? null : nearestLat(arms[h2][list].filter(roadLane), lane.lat));
    if (inn.length) {
      const t = incoming ? other('outgoing') : lane;
      const arm = incoming ? h2 : h;
      if (t && arm !== null && (terminal || Math.abs(signedTurn(heading, arms[arm].cutDir)) <= MAX_RAMP_TURN)) targets.push({ lane: t, arm });
    }
    if (out.length) {
      const s = incoming ? lane : other('incoming');
      const arm = incoming ? h : h2;
      if (s && arm !== null && (terminal || Math.abs(signedTurn(scale(arms[arm].cutDir, -1), arms[k].cutDir)) <= MAX_RAMP_TURN)) sources.push({ lane: s, arm });
    }
  }
  if ((inn.length && !targets.length) || (out.length && !sources.length)) return null;
  let across: number | null = null;
  if (terminal) {
    let bend = PAIR_LIMIT;
    arms.forEach((a, i) => {
      if (i === k || i === h || i === h2) return;
      const b = Math.abs(signedTurn(heading, a.cutDir));
      if (b < bend) {
        bend = b;
        across = i;
      }
    });
  }
  return { arm: k, targets, sources, forced: terminal ? null : rightSide ? 'right' : 'left', across };
}

/**
 * Split `r` lanes of the attached road into one block per group, left to right,
 * each at least one lane, the rest shared by group size. Null when there are
 * fewer lanes than groups, so a lane has to serve several.
 */
function blocksFor(r: number, sizes: readonly number[]): [number, number][] | null {
  const g = sizes.length;
  if (r < g) return null;
  const total = sizes.reduce((a, b) => a + b, 0);
  const counts = sizes.map(() => 1);
  for (let left = r - g; left > 0; left--) {
    let best = 0;
    let need = -Infinity;
    sizes.forEach((s, i) => {
      const n = (s / total) * r - counts[i];
      if (n > need) {
        need = n;
        best = i;
      }
    });
    counts[best]++;
  }
  const out: [number, number][] = [];
  let at = 0;
  for (const c of counts) {
    out.push([at, at + c]);
    at += c;
  }
  return out;
}

/** Link the attached road's lanes with its picked host lanes, left turns on its left lanes. */
function linkPicks(set: LinkSet, arms: ArmLanes[], plan: StreetPlan, picks: HostPick[], arriving: boolean): void {
  const k = plan.arm;
  const own = (arriving ? arms[k].incoming : arms[k].outgoing).filter(roadLane);
  const groups = new Map<number, LaneEnd[]>();
  for (const p of picks) {
    const g = groups.get(p.arm) ?? [];
    if (!g.includes(p.lane)) g.push(p.lane);
    groups.set(p.arm, g);
  }
  const heading = scale(arms[k].cutDir, -1);
  const list = [...groups].map(([arm, lanes]) => ({
    arm,
    lanes: lanes.sort((a, b) => a.lat - b.lat),
    bend: arriving ? signedTurn(heading, arms[arm].cutDir) : signedTurn(scale(arms[arm].cutDir, -1), arms[k].cutDir),
  }));
  // Most to the left first: those take the attached road's left lanes.
  list.sort((a, b) => a.bend - b.bend);
  const turnOf = (arm: number) => plan.forced ?? (arriving ? turnBetween(arms, k, arm) : turnBetween(arms, arm, k));
  const blocks = blocksFor(own.length, list.map((g) => g.lanes.length));
  list.forEach((g, j) => {
    const mine = blocks ? own.slice(blocks[j][0], blocks[j][1]) : own;
    if (arriving) pairOrdered(set, mine, g.lanes, turnOf(g.arm));
    else pairOrdered(set, g.lanes, mine, turnOf(g.arm));
  });
}

/**
 * Links at a junction on a street or avenue where roads attach to chosen lanes,
 * or null when no attach there applies (then the usual rules run). `base` links
 * the other arms as if the attached roads were not there.
 */
export function linkStreetAttaches(arms: ArmLanes[], base: (arms: ArmLanes[]) => LaneLinkSpec[]): LaneLinkSpec[] | null {
  if (arms.length < 3 || isControlledAccess(arms)) return null;
  const plans: StreetPlan[] = [];
  arms.forEach((a, k) => {
    if (!a.attach) return;
    const plan = planStreetAttach(arms, k);
    if (plan) plans.push(plan);
  });
  if (!plans.length) return null;
  const planned = new Set(plans.map((p) => p.arm));
  const rest = arms.filter((_, i) => !planned.has(i));
  if (rest.length < 2) return null;
  const set = new LinkSet();
  const armOf = (l: LaneEnd, side: 'incoming' | 'outgoing') => arms.findIndex((a) => a[side].includes(l));
  for (const l of base(rest)) {
    const from = armOf(l.from, 'incoming');
    const to = armOf(l.to, 'outgoing');
    set.add(l.from, l.to, from >= 0 && to >= 0 && from !== to ? turnBetween(arms, from, to) : l.turn);
  }
  for (const plan of plans) {
    if (plan.targets.length) linkPicks(set, arms, plan, plan.targets, true);
    if (plan.sources.length) linkPicks(set, arms, plan, plan.sources, false);
    // A terminal still carries straight across the junction to the road opposite.
    const o = plan.across;
    if (o !== null) {
      const k = plan.arm;
      pairOrdered(set, arms[k].incoming.filter(roadLane), arms[o].outgoing.filter(roadLane), turnBetween(arms, k, o));
      pairOrdered(set, arms[o].incoming.filter(roadLane), arms[k].outgoing.filter(roadLane), turnBetween(arms, o, k));
    }
  }
  const bike = (l: LaneEnd) => l.kind === 'bike';
  if (plans.some((p) => arms[p.arm].incoming.some(bike) || arms[p.arm].outgoing.some(bike))) {
    linkGeneral(set, arms, bike);
    feedOrphans(set, arms, bike);
  }
  feedOrphans(set, arms, roadLane);
  linkTurnarounds(set, arms);
  return [...set.links.values()];
}

/** A street node where only side merges join the street: these flow freely, like a highway merge. */
export function isStreetMerge(arms: readonly { category?: RoadCategory; attach?: RampAttach }[]): boolean {
  const attached = arms.filter((a) => a.attach);
  const plain = arms.filter((a) => !a.attach);
  if (!attached.length || plain.length > 2 || plain.length === 0) return false;
  if (attached.some((a) => a.attach!.lanes)) return false;
  return plain.every((a) => isStreetHost(a.category));
}

/**
 * Names of the host lanes a street terminal uses, for the inspector, with the turn
 * each one is ('left' into the far carriageway, 'right' into the near one).
 * `near` is how many lanes the carriageway on the road's side has.
 */
export function terminalLaneNames(attach: RampAttach, near: number, total: number): { position: number; name: string; turn: 'left' | 'right' }[] {
  const out: { position: number; name: string; turn: 'left' | 'right' }[] = [];
  for (const p of [...new Set(attach.lanes ?? [])].sort((a, b) => a - b)) {
    if (p < 0 || p >= total) continue;
    if (p < near) {
      const name = p === 0 ? 'near kerb lane' : p === near - 1 ? 'near inner lane' : `near lane ${p + 1}`;
      out.push({ position: p, name, turn: 'right' });
    } else {
      const far = total - near;
      const q = p - near;
      const name = q === far - 1 ? 'far kerb lane' : q === 0 ? 'far inner lane' : `far lane ${far - q}`;
      out.push({ position: p, name, turn: 'left' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Draft checks
// ---------------------------------------------------------------------------

export interface RampIssue {
  code: 'wrongWay' | 'atGradeHighway';
  severity: 'error' | 'warning';
  message: string;
  at: Vec3;
}

/** What the draft checks need to know about one end of the draft. */
export interface DraftEnd {
  /** The highway the end joins, with its a-to-b direction and one-wayness there. */
  hostDef: RoadTypeDef;
  hostDir: Vec3;
  pos: Vec3;
  /** True for the start of the draft, where traffic leaves the host. */
  leaving: boolean;
  /** The lane attach at this end, if any. */
  attach?: RampAttach;
}

/**
 * Problems with how a new road meets a highway at one end. `cubic` is the draft,
 * already moved onto any lane it attaches to.
 */
export function rampEndIssues(def: RoadTypeDef, cubic: Cubic, end: DraftEnd): RampIssue[] {
  // On a street only a side merge has to run with the traffic; a terminal turns.
  const sideMerge = isStreetHost(end.hostDef.category) && !!end.attach && !end.attach.lanes && isOneWay(def);
  if (end.hostDef.category !== 'highway' && !sideMerge) return [];
  const what = end.hostDef.category === 'highway' ? 'highway' : 'street';
  const out: RampIssue[] = [];
  const t = end.leaving ? 0 : 1;
  const travel = cubicTangentXZ(cubic, t);
  if (isOneWay(def)) {
    // Which side of the host is the new road on? Judge from the curve away from the end.
    let lateral = 0;
    for (const s of [0.25, 0.5, 0.75, 1]) {
      const q = cubicPoint(cubic, end.leaving ? s : 1 - s);
      lateral = dotXZ(sub(q, end.pos), rightOf(end.hostDir));
      if (Math.abs(lateral) > 0.5) break;
    }
    const hostTravel = isOneWay(end.hostDef) || lateral >= 0 ? end.hostDir : scale(end.hostDir, -1);
    if (dotXZ(travel, hostTravel) < Math.cos(MAX_RAMP_TURN)) {
      out.push({
        code: 'wrongWay',
        severity: 'error',
        message: end.leaving
          ? `Leaves against the ${what} traffic, so nothing could take it. Draw it the other way round.`
          : `Joins against the ${what} traffic, so it could never merge. Draw it the other way round.`,
        at: end.pos,
      });
    }
  } else if (def.category !== 'rail') {
    out.push({
      code: 'atGradeHighway',
      severity: 'warning',
      message: 'Joins a highway at grade: right in and right out only. Carry the road across for a signalled crossing, or change it in the junction panel.',
      at: end.pos,
    });
  }
  return out;
}
