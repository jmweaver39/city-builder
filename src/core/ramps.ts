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
import type { Id, LaneDef, RampAttach, RoadCategory, RoadNode, RoadTypeDef, Segment, Vec3 } from './types';
import type { Cubic } from './bezier';
import { cubicPoint, cubicTangentXZ } from './bezier';
import type { ArmLanes, LaneEnd, LinkSet } from './connectors';
import { feedOrphans, linkGeneral, linkTurnarounds, shareLanes, turnBetween } from './connectors';
import { addScaled, distXZ, dotXZ, normalizeXZ, rightOf, scale, signedTurn, sub } from './math';
import { effectiveLanes, isOneWay } from './roadTypes';

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
export function attachPointFrom(nodePos: Vec3, hostDir: Vec3, hostLanes: readonly LaneDef[], attach: RampAttach, rampDir: Vec3): Vec3 {
  const aligned: 1 | -1 = dotXZ(hostDir, rampDir) >= 0 ? 1 : -1;
  const travel = scale(hostDir, aligned);
  // The host on the ramp's left means the ramp is on the host's right.
  const side: 1 | -1 = attach.hostSide === -1 ? 1 : -1;
  const edge = carriagewayEdge(hostLanes, aligned, side);
  const p = addScaled(nodePos, rightOf(travel), edge);
  return { x: p.x, y: nodePos.y, z: p.z };
}

/** A segment's curve with any attached ends moved onto their host's carriageway edge. */
export function attachedCubic(acc: AttachAccess, seg: Segment, raw: Cubic): Cubic {
  const { attachA, attachB } = seg.overrides;
  if (!attachA && !attachB) return raw;
  let { p0, p3 } = raw;
  const endPoint = (attach: RampAttach, nodeId: Id, rampDir: Vec3): Vec3 | null => {
    const host = pickHost(acc, nodeId, seg.id);
    const node = acc.node(nodeId);
    if (!host || !node) return null;
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

/** True when a node's connectors follow the controlled-access rules. */
export function isControlledAccess(arms: readonly { category?: RoadCategory }[]): boolean {
  return arms.length >= 3 && arms.some((a) => a.category === 'highway');
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
}

/**
 * Problems with how a new road meets a highway at one end. `cubic` is the draft,
 * already moved onto any lane it attaches to.
 */
export function rampEndIssues(def: RoadTypeDef, cubic: Cubic, end: DraftEnd): RampIssue[] {
  if (end.hostDef.category !== 'highway') return [];
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
          ? 'Leaves against the highway traffic, so nothing could take it. Draw it the other way round.'
          : 'Joins against the highway traffic, so it could never merge. Draw it the other way round.',
        at: end.pos,
      });
    }
  } else if (def.category !== 'rail') {
    out.push({
      code: 'atGradeHighway',
      severity: 'warning',
      message: 'Joins a highway at grade: right in and right out only, no turning across it.',
      at: end.pos,
    });
  }
  return out;
}
