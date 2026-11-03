/**
 * Which lanes link to which at a node, and the connector curves for those links.
 * The rules are the ones in ARCHITECTURE.md under "Connectors". This module knows
 * nothing about the dense lane graph: it works on lane ends and returns protos
 * that laneGraph.ts assembles.
 */
import type { Id, JunctionControl, LaneKind, NodeGeom, RampAttach, RoadCategory, RoadTypeDef, SegmentGeom, TurnKind, Vec3 } from './types';
import type { NodeLayout } from './junction';
import { cubicPoint, cubicDerivative, type Cubic } from './bezier';
import { toPolylineData, type PolylineData } from './geometry';
import { clamp, crossXZ, distXZ, dotXZ, lengthXZ, scale, signedTurn, segmentIntersectXZ } from './math';
import { isOneWay } from './roadTypes';
import { isControlledAccess, linkControlledAccess } from './ramps';

/** One lane where it meets a node. */
export interface LaneEnd {
  segmentId: Id;
  laneIndex: number;
  kind: LaneKind;
  /** Offset from the centreline, positive right of the driver. Sorts lanes left to right. */
  lat: number;
  width: number;
  speed: number;
  /** Where the lane ends at the node, or starts if outgoing. */
  pos: Vec3;
  /** Unit direction of travel there. */
  tan: Vec3;
}

export interface ArmLanes {
  segmentId: Id;
  atStart: boolean;
  /** Unit horizontal, away from the node, at the cut. */
  cutDir: Vec3;
  oneWay: boolean;
  /** The road's category, for the controlled-access rules in ramps.ts. */
  category?: RoadCategory;
  /** Set when this end of the road is attached to a lane of another road. */
  attach?: RampAttach;
  /** Lanes arriving at the node, left to right as the driver sees them. */
  incoming: LaneEnd[];
  /** Lanes leaving the node, left to right as the driver sees them. */
  outgoing: LaneEnd[];
}

export interface LaneLinkSpec {
  from: LaneEnd;
  to: LaneEnd;
  turn: TurnKind;
}

export interface ConflictProto {
  /** Index into the node's connector list. */
  other: number;
  selfS: number;
  otherS: number;
  kind: 'cross' | 'merge' | 'diverge';
}

export interface ConnectorProto {
  key: string;
  nodeId: Id;
  from: LaneEnd;
  to: LaneEnd;
  turn: TurnKind;
  vehicleKind: LaneKind;
  width: number;
  speed: number;
  poly: PolylineData;
  conflicts: ConflictProto[];
}

// ---------------------------------------------------------------------------
// Arm lanes
// ---------------------------------------------------------------------------

/** What buildArmLanes needs to know about each road lane. */
export interface RoadLaneInfo {
  kind: LaneKind;
  offset: number;
  dir: 1 | -1;
  width: number;
  speed: number;
  /** First and last positions of the lane's polyline, in travel order. */
  start: Vec3;
  end: Vec3;
}

/** Each arm's lanes, split by whether they arrive at or leave this node. */
export function buildArmLanes(
  layout: NodeLayout,
  geom: NodeGeom,
  geomOf: (id: Id) => SegmentGeom | undefined,
  defOf: (id: Id) => RoadTypeDef,
  lanesOf: (id: Id) => readonly (RoadLaneInfo | null)[],
  attachOf?: (id: Id, atStart: boolean) => RampAttach | undefined,
): ArmLanes[] {
  return layout.arms.map((arm, armIndex) => {
    const seg = geomOf(arm.segmentId);
    const cut = geom.arms[armIndex];
    const incoming: LaneEnd[] = [];
    const outgoing: LaneEnd[] = [];
    const stations = seg?.stations ?? [];
    if (stations.length > 0) {
      const st = arm.atStart ? stations[0] : stations[stations.length - 1];
      const lanes = lanesOf(arm.segmentId);
      for (let i = 0; i < lanes.length; i++) {
        const lane = lanes[i];
        if (!lane) continue;
        const arriving = arm.atStart ? lane.dir === -1 : lane.dir === 1;
        const tan = lane.dir === 1 ? st.tangent : scale(st.tangent, -1);
        const end: LaneEnd = {
          segmentId: arm.segmentId,
          laneIndex: i,
          kind: lane.kind,
          lat: lane.dir === 1 ? lane.offset : -lane.offset,
          width: lane.width,
          speed: lane.speed,
          pos: arriving ? lane.end : lane.start,
          tan,
        };
        (arriving ? incoming : outgoing).push(end);
      }
    }
    incoming.sort((a, b) => a.lat - b.lat);
    outgoing.sort((a, b) => a.lat - b.lat);
    const def = defOf(arm.segmentId);
    const attach = attachOf?.(arm.segmentId, arm.atStart);
    return {
      segmentId: arm.segmentId,
      atStart: arm.atStart,
      cutDir: cut.cutDir,
      oneWay: isOneWay(def),
      category: def.category,
      ...(attach ? { attach } : {}),
      incoming,
      outgoing,
    };
  });
}

/** Bike lanes join bike lanes only. Rail joins rail only. Bus lanes join drive or bus lanes. */
export function canLink(from: LaneKind, to: LaneKind): boolean {
  if ((from === 'rail') !== (to === 'rail')) return false;
  return (from === 'bike') === (to === 'bike');
}

// ---------------------------------------------------------------------------
// Turn classification
// ---------------------------------------------------------------------------

/** Most a through movement may bend before it counts as a turn. */
const STRAIGHT_LIMIT = 0.96;

interface Exit {
  arm: number;
  turn: TurnKind;
  lanes: LaneEnd[];
}

/**
 * The arms a driver on arm `from` can leave by, ordered left to right, with turn
 * kinds. Clockwise from the arriving arm is left to right. The least-bent exit
 * within limits is 'straight', and everything else is a left or right of it.
 */
function exitsFrom(arms: ArmLanes[], from: number, accept: (l: LaneEnd) => boolean): Exit[] {
  const n = arms.length;
  const heading = scale(arms[from].cutDir, -1);
  const found: { arm: number; lanes: LaneEnd[]; bend: number }[] = [];
  for (let k = 1; k < n; k++) {
    const i = (from + k) % n;
    const lanes = arms[i].outgoing.filter(accept);
    if (lanes.length) found.push({ arm: i, lanes, bend: signedTurn(heading, arms[i].cutDir) });
  }
  let straight = -1;
  let best = STRAIGHT_LIMIT;
  found.forEach((e, i) => {
    if (Math.abs(e.bend) < best) {
      best = Math.abs(e.bend);
      straight = i;
    }
  });
  return found.map((e, i) => {
    let turn: TurnKind;
    if (i === straight) turn = 'straight';
    else if (straight >= 0) turn = i < straight ? 'left' : 'right';
    else turn = e.bend < 0 ? 'left' : 'right';
    return { arm: e.arm, turn, lanes: e.lanes };
  });
}

/** Turn kind of a specific movement. */
export function turnBetween(arms: ArmLanes[], fromArm: number, toArm: number): TurnKind {
  if (fromArm === toArm) return 'uturn';
  const e = exitsFrom(arms, fromArm, () => true).find((x) => x.arm === toArm);
  if (e) return e.turn;
  // The target has no outgoing lanes yet; judge by angle alone.
  const bend = signedTurn(scale(arms[fromArm].cutDir, -1), arms[toArm].cutDir);
  return Math.abs(bend) < STRAIGHT_LIMIT ? 'straight' : bend < 0 ? 'left' : 'right';
}

// ---------------------------------------------------------------------------
// Assigning lanes
// ---------------------------------------------------------------------------

export class LinkSet {
  readonly links = new Map<string, LaneLinkSpec>();

  add(from: LaneEnd, to: LaneEnd, turn: TurnKind): void {
    const key = `${from.segmentId}.${from.laneIndex}>${to.segmentId}.${to.laneIndex}`;
    if (!this.links.has(key)) this.links.set(key, { from, to, turn });
  }

  hasFrom(l: LaneEnd): boolean {
    for (const k of this.links.values()) if (k.from === l) return true;
    return false;
  }

  feedersOf(l: LaneEnd): LaneLinkSpec[] {
    const out: LaneLinkSpec[] = [];
    for (const k of this.links.values()) if (k.to === l) out.push(k);
    return out;
  }
}

type Align = 'left' | 'right' | 'lateral';

/** Link lanes I to lanes O of one exit, both sorted left to right. */
function connect(set: LinkSet, I: LaneEnd[], O: LaneEnd[], align: Align, turn: TurnKind): void {
  if (!I.length || !O.length) return;
  if (I.length === O.length) {
    for (let k = 0; k < I.length; k++) set.add(I[k], O[k], turn);
    return;
  }
  if (align === 'left') {
    for (let k = 0; k < I.length; k++) set.add(I[k], O[Math.min(k, O.length - 1)], turn);
    return;
  }
  if (align === 'right') {
    for (let k = 0; k < I.length; k++) {
      set.add(I[I.length - 1 - k], O[Math.max(O.length - 1 - k, 0)], turn);
    }
    return;
  }
  // Lateral: each lane takes the nearest lane across; leftovers on the far side
  // fan out from the nearest lane. Both lists are sorted, so links never cross.
  const fed = new Array<boolean>(O.length).fill(false);
  for (const lane of I) {
    let best = 0;
    for (let o = 1; o < O.length; o++) {
      if (Math.abs(O[o].lat - lane.lat) < Math.abs(O[best].lat - lane.lat) - 1e-6) best = o;
    }
    fed[best] = true;
    set.add(lane, O[best], turn);
  }
  for (let o = 0; o < O.length; o++) {
    if (fed[o]) continue;
    let best = 0;
    for (let k = 1; k < I.length; k++) {
      if (Math.abs(I[k].lat - O[o].lat) < Math.abs(I[best].lat - O[o].lat)) best = k;
    }
    set.add(I[best], O[o], turn);
  }
}

/**
 * Share `trunk` lanes among branches ordered left to right. Outer branches hug
 * their own side, so a mainline keeps its lanes and an exit shares the last one.
 * Calls back with each trunk lane index and the lane of the branch it pairs with.
 */
export function shareLanes(
  trunk: number,
  branches: number[],
  pair: (trunkLane: number, branch: number, branchLane: number) => void,
): void {
  const k = branches.length;
  const ranges = branches.map((count, j) => {
    const width = Math.min(count, trunk);
    const start = k === 1 ? 0 : Math.round(((trunk - width) * j) / (k - 1));
    return { start, end: start + width };
  });
  // Lanes nobody took (more trunk lanes than branch lanes) join the nearest branch.
  for (let lane = 0; lane < trunk; lane++) {
    if (ranges.some((r) => lane >= r.start && lane < r.end)) continue;
    let best = 0;
    let bestGap = Infinity;
    ranges.forEach((r, j) => {
      const gap = lane < r.start ? r.start - lane : lane - r.end + 1;
      if (gap < bestGap) {
        bestGap = gap;
        best = j;
      }
    });
    ranges[best].start = Math.min(ranges[best].start, lane);
    ranges[best].end = Math.max(ranges[best].end, lane + 1);
  }
  ranges.forEach((r, j) => {
    const span = r.end - r.start;
    const count = branches[j];
    const seen = new Set<number>();
    const emit = (t: number, b: number) => {
      const id = t * 1000 + b;
      if (seen.has(id)) return;
      seen.add(id);
      pair(r.start + t, j, b);
    };
    for (let t = 0; t < span; t++) emit(t, Math.floor(((t + 0.5) * count) / span));
    for (let b = 0; b < count; b++) emit(Math.floor(((b + 0.5) * span) / count), b);
  });
}

export function linkGeneral(set: LinkSet, arms: ArmLanes[], accept: (l: LaneEnd) => boolean): void {
  for (let a = 0; a < arms.length; a++) {
    const lanes = arms[a].incoming.filter(accept);
    if (!lanes.length) continue;
    const exits = exitsFrom(arms, a, accept);
    if (!exits.length) continue;
    const n = lanes.length;
    if (exits.length === 1) {
      connect(set, lanes, exits[0].lanes, 'lateral', exits[0].turn);
      continue;
    }
    const alignOf = (turn: TurnKind): Align => (turn === 'left' ? 'left' : turn === 'right' ? 'right' : 'lateral');
    if (n === 1) {
      for (const e of exits) connect(set, lanes, e.lanes, alignOf(e.turn), e.turn);
      continue;
    }
    const through = exits.findIndex((e) => e.turn === 'straight');
    if (through >= 0) {
      const lefts = exits.slice(0, through);
      const rights = exits.slice(through + 1);
      for (const e of lefts) set.add(lanes[0], e.lanes[0], e.turn);
      for (const e of rights) set.add(lanes[n - 1], e.lanes[e.lanes.length - 1], e.turn);
      let straightLanes = lanes;
      if (n > 2) {
        straightLanes = lanes.slice(lefts.length ? 1 : 0, rights.length ? n - 1 : n);
      } else if (lefts.length && !rights.length) {
        straightLanes = [lanes[1]];
      } else if (rights.length && !lefts.length) {
        straightLanes = [lanes[0]];
      }
      connect(set, straightLanes, exits[through].lanes, 'lateral', 'straight');
      continue;
    }
    // No way straight on: split the approach across the exits, left to right.
    const m = exits.length;
    exits.forEach((e, j) => {
      const part = lanes.slice(Math.floor((j * n) / m), Math.ceil(((j + 1) * n) / m));
      connect(set, part, e.lanes, alignOf(e.turn), e.turn);
    });
  }
}

/** One-way trunk splitting into, or formed from, several one-way branches. */
function linkBranches(
  set: LinkSet,
  arms: ArmLanes[],
  trunkArm: number,
  branchArms: number[],
  mode: 'diverge' | 'merge',
  accept: (l: LaneEnd) => boolean,
): void {
  const trunk = (mode === 'diverge' ? arms[trunkArm].incoming : arms[trunkArm].outgoing).filter(accept);
  const branches = branchArms.map((b) => (mode === 'diverge' ? arms[b].outgoing : arms[b].incoming).filter(accept));
  shareLanes(
    trunk.length,
    branches.map((b) => b.length),
    (t, j, b) => {
      if (mode === 'diverge') set.add(trunk[t], branches[j][b], turnBetween(arms, trunkArm, branchArms[j]));
      else set.add(branches[j][b], trunk[t], turnBetween(arms, branchArms[j], trunkArm));
    },
  );
}

/** Arm indices clockwise from `from`, excluding it. */
function clockwiseFrom(arms: ArmLanes[], from: number): number[] {
  const out: number[] = [];
  for (let k = 1; k < arms.length; k++) out.push((from + k) % arms.length);
  return out;
}

/** Bus lanes go on after everything else, so they never take a car's only turn. */
function linkBusLanes(set: LinkSet, arms: ArmLanes[]): void {
  const road = (l: LaneEnd) => l.kind !== 'bike' && l.kind !== 'rail';
  for (let a = 0; a < arms.length; a++) {
    for (const lane of arms[a].incoming) {
      if (lane.kind !== 'bus') continue;
      const exits = exitsFrom(arms, a, road);
      const allowed = exits.some((e) => e.turn !== 'left') ? exits.filter((e) => e.turn !== 'left') : exits;
      for (const e of allowed) {
        const bus = e.lanes.filter((l) => l.kind === 'bus');
        const pool = bus.length ? bus : e.lanes;
        let target = pool[pool.length - 1];
        if (e.turn === 'left') target = pool[0];
        else if (e.turn === 'straight') {
          for (const l of pool) if (Math.abs(l.lat - lane.lat) < Math.abs(target.lat - lane.lat)) target = l;
        }
        set.add(lane, target, e.turn);
      }
    }
  }
}

/** Give any lane leaving a junction a feeder, taken from the lane beside it. */
export function feedOrphans(set: LinkSet, arms: ArmLanes[], accept: (l: LaneEnd) => boolean): void {
  for (const arm of arms) {
    const lanes = arm.outgoing.filter(accept);
    for (let i = 0; i < lanes.length; i++) {
      if (set.feedersOf(lanes[i]).length) continue;
      for (let d = 1; d < lanes.length; d++) {
        const near = lanes[i + d] ?? lanes[i - d];
        const other = lanes[i - d] && lanes[i + d] ? lanes[i - d] : undefined;
        const source = (near && set.feedersOf(near)[0]) ?? (other && set.feedersOf(other)[0]);
        if (source) {
          set.add(source.from, lanes[i], source.turn);
          break;
        }
      }
    }
  }
}

/** Any lane still without an exit turns round, if it can. This is the dead-end rule. */
export function linkTurnarounds(set: LinkSet, arms: ArmLanes[]): void {
  for (const arm of arms) {
    for (const bike of [false, true]) {
      // Trains change ends at a dead end, they never loop round.
      const accept = (l: LaneEnd) => l.kind !== 'rail' && (l.kind === 'bike') === bike;
      const stuck = arm.incoming.filter((l) => accept(l) && !set.hasFrom(l));
      if (stuck.length) connect(set, stuck, arm.outgoing.filter(accept), 'lateral', 'uturn');
    }
  }
}

/** Sharpest change of heading a pair of points can take a train through. */
export const RAIL_MAX_BEND = (40 * Math.PI) / 180;

/**
 * Track links only where a train can run through: nearly straight on, or off to one
 * side at a turnout. A sharper angle is a flat crossing with no way between the
 * tracks, and a road arm is never a way out at all.
 */
function linkRail(set: LinkSet, arms: ArmLanes[]): void {
  const rail = (l: LaneEnd) => l.kind === 'rail';
  for (let a = 0; a < arms.length; a++) {
    const lanes = arms[a].incoming.filter(rail);
    if (!lanes.length) continue;
    const heading = scale(arms[a].cutDir, -1);
    const exits: { lanes: LaneEnd[]; bend: number }[] = [];
    for (let b = 0; b < arms.length; b++) {
      if (b === a) continue;
      const out = arms[b].outgoing.filter(rail);
      if (!out.length) continue;
      const bend = signedTurn(heading, arms[b].cutDir);
      if (Math.abs(bend) <= RAIL_MAX_BEND) exits.push({ lanes: out, bend });
    }
    let straight = 0;
    exits.forEach((e, i) => {
      if (Math.abs(e.bend) < Math.abs(exits[straight].bend)) straight = i;
    });
    exits.forEach((e, i) => {
      const turn: TurnKind = i === straight ? 'straight' : e.bend < exits[straight].bend ? 'left' : 'right';
      connect(set, lanes, e.lanes, 'lateral', turn);
    });
  }
}

/** Road-to-road pairs at a plain joint. The lanes line up exactly. */
export function plainJointLinks(arms: ArmLanes[]): LaneLinkSpec[] {
  const out: LaneLinkSpec[] = [];
  const link = (from: ArmLanes, to: ArmLanes) => {
    for (const lane of from.incoming) {
      let best: LaneEnd | null = null;
      for (const o of to.outgoing) {
        if (!best || Math.abs(o.lat - lane.lat) < Math.abs(best.lat - lane.lat)) best = o;
      }
      if (best) out.push({ from: lane, to: best, turn: 'straight' });
    }
  };
  link(arms[0], arms[1]);
  link(arms[1], arms[0]);
  return out;
}

/** The automatic lane links at a junction or dead end. */
export function autoLaneLinks(arms: ArmLanes[]): LaneLinkSpec[] {
  const set = new LinkSet();
  const drive = (l: LaneEnd) => l.kind === 'drive';
  const bike = (l: LaneEnd) => l.kind === 'bike';

  const inArms: number[] = [];
  const outArms: number[] = [];
  arms.forEach((arm, i) => {
    if (arm.incoming.some(drive)) inArms.push(i);
    if (arm.outgoing.some(drive)) outArms.push(i);
  });
  if (isControlledAccess(arms)) {
    // Highways: own carriageway only, merge and diverge, no turns across.
    linkControlledAccess(set, arms);
    linkRail(set, arms);
    return [...set.links.values()];
  }
  const allOneWay = arms.every((a) => a.oneWay);
  if (allOneWay && inArms.length === 1 && outArms.length >= 2) {
    const from = inArms[0];
    const branches = clockwiseFrom(arms, from).filter((i) => outArms.includes(i));
    linkBranches(set, arms, from, branches, 'diverge', drive);
  } else if (allOneWay && outArms.length === 1 && inArms.length >= 2) {
    const to = outArms[0];
    const branches = clockwiseFrom(arms, to).filter((i) => inArms.includes(i)).reverse();
    linkBranches(set, arms, to, branches, 'merge', drive);
  } else {
    linkGeneral(set, arms, drive);
  }
  feedOrphans(set, arms, drive);
  linkGeneral(set, arms, bike);
  feedOrphans(set, arms, bike);
  linkBusLanes(set, arms);
  feedOrphans(set, arms, (l) => l.kind !== 'bike' && l.kind !== 'rail');
  linkRail(set, arms);
  linkTurnarounds(set, arms);
  return [...set.links.values()];
}

function parseLaneRef(ref: string): { segmentId: Id; laneIndex: number } | null {
  const m = /^(\d+):(\d+)$/.exec(ref);
  return m ? { segmentId: Number(m[1]), laneIndex: Number(m[2]) } : null;
}

export function laneRef(l: Pick<LaneEnd, 'segmentId' | 'laneIndex'>): string {
  return `${l.segmentId}:${l.laneIndex}`;
}

/** The links from a user-set list. Links that no longer make sense are skipped. */
export function controlLaneLinks(control: JunctionControl, arms: ArmLanes[]): LaneLinkSpec[] {
  const set = new LinkSet();
  const find = (ref: string, side: 'incoming' | 'outgoing'): { lane: LaneEnd; arm: number } | null => {
    const parsed = parseLaneRef(ref);
    if (!parsed) return null;
    for (let i = 0; i < arms.length; i++) {
      for (const lane of arms[i][side]) {
        if (lane.segmentId === parsed.segmentId && lane.laneIndex === parsed.laneIndex) return { lane, arm: i };
      }
    }
    return null;
  };
  for (const link of control.laneLinks ?? []) {
    const from = find(link.from, 'incoming');
    const to = find(link.to, 'outgoing');
    if (!from || !to || !canLink(from.lane.kind, to.lane.kind)) continue;
    set.add(from.lane, to.lane, turnBetween(arms, from.arm, to.arm));
  }
  return [...set.links.values()];
}

/** A lane link that is possible at a node, for a lane connection editor. */
export interface PossibleConnection {
  from: string;
  to: string;
  fromSegment: Id;
  toSegment: Id;
  turn: TurnKind;
  /** True when this link currently exists. */
  active: boolean;
}

export function possibleConnections(arms: ArmLanes[], activeKeys: ReadonlySet<string>): PossibleConnection[] {
  const out: PossibleConnection[] = [];
  arms.forEach((arm, a) => {
    for (const from of arm.incoming) {
      arms.forEach((target, b) => {
        for (const to of target.outgoing) {
          if (!canLink(from.kind, to.kind)) continue;
          const uturn = a === b;
          const key = `${laneRef(from)}>${laneRef(to)}`;
          const active = activeKeys.has(key);
          if (uturn && !active && arms.length > 1) continue;
          out.push({
            from: laneRef(from),
            to: laneRef(to),
            fromSegment: from.segmentId,
            toSegment: to.segmentId,
            turn: turnBetween(arms, a, b),
            active,
          });
        }
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Connector curves
// ---------------------------------------------------------------------------

/** Comfortable lateral acceleration for connector speed limits, m/s^2. */
const TURN_ACCEL = 3;
const MIN_TURN_SPEED = 3;
/** The same for track, which has no room to lean a passenger. */
const RAIL_TURN_ACCEL = 1;
/** Limit through the diverging side of a turnout, 40 km/h. */
const RAIL_SWITCH_SPEED = 40 / 3.6;

function horizontal(v: Vec3): Vec3 {
  const l = lengthXZ(v);
  return l < 1e-9 ? { x: 1, y: 0, z: 0 } : { x: v.x / l, y: 0, z: v.z / l };
}

function slopeOf(v: Vec3): number {
  const l = lengthXZ(v);
  return l < 1e-9 ? 0 : clamp(v.y / l, -1, 1);
}

/** Cubic from one lane end to another, tangent to both. */
export function connectorCubic(from: Pick<LaneEnd, 'pos' | 'tan'>, to: Pick<LaneEnd, 'pos' | 'tan'>): Cubic {
  const p0 = from.pos;
  const p3 = to.pos;
  const d0 = horizontal(from.tan);
  const d3 = horizontal(to.tan);
  const chord = distXZ(p0, p3);
  let h0 = chord / 3;
  let h3 = chord / 3;
  const denom = crossXZ(d0, d3);
  const dx = p3.x - p0.x;
  const dz = p3.z - p0.z;
  if (Math.abs(denom) > 0.05) {
    // Corner where the two lane lines meet: p0 + d0 u = p3 - d3 v.
    const u = (dx * d3.z - dz * d3.x) / denom;
    const v = (dx * d0.z - dz * d0.x) / denom;
    if (u > 0 && v > 0 && u < chord * 4 && v < chord * 4) {
      // The floor stops a lopsided corner bunching all its turn at one end.
      h0 = Math.max(0.6 * u, 0.3 * chord);
      h3 = Math.max(0.6 * v, 0.3 * chord);
    } else if (dotXZ(d0, d3) < 0) {
      h0 = h3 = 0.67 * chord;
    }
  } else if (dotXZ(d0, d3) < 0) {
    h0 = h3 = 0.67 * chord;
  }
  const p1 = { x: p0.x + d0.x * h0, y: p0.y + slopeOf(from.tan) * h0, z: p0.z + d0.z * h0 };
  const p2 = { x: p3.x - d3.x * h3, y: p3.y - slopeOf(to.tan) * h3, z: p3.z - d3.z * h3 };
  return { p0, p1, p2, p3 };
}

function sampleConnector(c: Cubic): { poly: PolylineData; maxKappa: number } | null {
  // Turn per step sets the sample count, with extra points hugging each end so
  // the first and last chords agree with the road lanes they continue.
  const d0 = c.p1;
  const chordish = distXZ(c.p0, d0) + distXZ(d0, c.p2) + distXZ(c.p2, c.p3);
  const startDir = horizontal(cubicDerivative(c, 0));
  const endDir = horizontal(cubicDerivative(c, 1));
  const turn = Math.abs(signedTurn(startDir, endDir));
  const steps = clamp(Math.ceil(turn / 0.16) + Math.ceil(chordish / 10), 6, 26);
  const ts: number[] = [0, 0.015, 0.05];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (t > 0.08 && t < 0.92) ts.push(t);
  }
  ts.push(0.95, 0.985, 1);
  const n = ts.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const zs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = cubicPoint(c, ts[i]);
    xs[i] = p.x;
    ys[i] = p.y;
    zs[i] = p.z;
  }
  const poly = toPolylineData(xs, ys, zs);
  if (!poly) return null;
  // Largest heading change per metre along the polyline.
  let maxKappa = 0;
  const pts = poly.pts;
  for (let i = 1; i + 1 < poly.cum.length; i++) {
    const ax = pts[i * 3] - pts[i * 3 - 3];
    const az = pts[i * 3 + 2] - pts[i * 3 - 1];
    const bx = pts[i * 3 + 3] - pts[i * 3];
    const bz = pts[i * 3 + 5] - pts[i * 3 + 2];
    const ds = (poly.cum[i + 1] - poly.cum[i - 1]) / 2;
    const a = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
    if (ds > 0.2 && a / ds > maxKappa) maxKappa = a / ds;
  }
  return { poly, maxKappa };
}

export function connectorKey(nodeId: Id, link: LaneLinkSpec): string {
  const { from, to } = link;
  return `c${nodeId}:${from.segmentId}.${from.laneIndex}>${to.segmentId}.${to.laneIndex}`;
}

/** Build the connector for a link, or null if the two ends coincide. */
export function buildConnector(nodeId: Id, link: LaneLinkSpec): ConnectorProto | null {
  const { from, to, turn } = link;
  const sampled = sampleConnector(connectorCubic(from, to));
  if (!sampled) return null;
  let speed = Math.min(from.speed, to.speed);
  const rail = from.kind === 'rail';
  if (sampled.maxKappa > 1e-6) {
    speed = Math.min(speed, Math.max(MIN_TURN_SPEED, Math.sqrt((rail ? RAIL_TURN_ACCEL : TURN_ACCEL) / sampled.maxKappa)));
  }
  if (rail && turn !== 'straight') speed = Math.min(speed, RAIL_SWITCH_SPEED);
  const vehicleKind: LaneKind = rail
    ? 'rail'
    : from.kind === 'bike' || to.kind === 'bike'
      ? 'bike'
      : from.kind === 'bus' || to.kind === 'bus'
        ? 'bus'
        : 'drive';
  return {
    key: connectorKey(nodeId, link),
    nodeId,
    from,
    to,
    turn,
    vehicleKind,
    width: (from.width + to.width) / 2,
    speed,
    poly: sampled.poly,
    conflicts: [],
  };
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/** Height gap above which two crossing connectors do not touch. */
const CONFLICT_HEADROOM = 3;

interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function boundsOf(pts: Float32Array): Bounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    if (pts[i] < minX) minX = pts[i];
    if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 2] < minZ) minZ = pts[i + 2];
    if (pts[i + 2] > maxZ) maxZ = pts[i + 2];
  }
  return { minX, maxX, minZ, maxZ };
}

function firstCrossing(a: ConnectorProto, b: ConnectorProto): { selfS: number; otherS: number } | null {
  const pa = a.poly.pts;
  const pb = b.poly.pts;
  const na = a.poly.cum.length;
  const nb = b.poly.cum.length;
  for (let i = 0; i + 1 < na; i++) {
    const ax = pa[i * 3];
    const az = pa[i * 3 + 2];
    const bx = pa[i * 3 + 3];
    const bz = pa[i * 3 + 5];
    const loX = Math.min(ax, bx);
    const hiX = Math.max(ax, bx);
    const loZ = Math.min(az, bz);
    const hiZ = Math.max(az, bz);
    for (let j = 0; j + 1 < nb; j++) {
      const cx = pb[j * 3];
      const cz = pb[j * 3 + 2];
      const dx = pb[j * 3 + 3];
      const dz = pb[j * 3 + 5];
      if ((cx < loX && dx < loX) || (cx > hiX && dx > hiX)) continue;
      if ((cz < loZ && dz < loZ) || (cz > hiZ && dz > hiZ)) continue;
      const r = segmentIntersectXZ(ax, az, bx, bz, cx, cz, dx, dz);
      if (!r) continue;
      const ya = pa[i * 3 + 1] + (pa[i * 3 + 4] - pa[i * 3 + 1]) * r.u;
      const yb = pb[j * 3 + 1] + (pb[j * 3 + 4] - pb[j * 3 + 1]) * r.v;
      if (Math.abs(ya - yb) >= CONFLICT_HEADROOM) continue;
      const selfS = a.poly.cum[i] + (a.poly.cum[i + 1] - a.poly.cum[i]) * r.u;
      const otherS = b.poly.cum[j] + (b.poly.cum[j + 1] - b.poly.cum[j]) * r.v;
      return { selfS, otherS };
    }
  }
  return null;
}

function pointAt(poly: PolylineData, s: number, out: { x: number; z: number }, hint: number): number {
  const { cum, pts } = poly;
  let i = hint;
  const last = cum.length - 2;
  while (i < last && cum[i + 1] < s) i++;
  while (i > 0 && cum[i] > s) i--;
  const span = cum[i + 1] - cum[i];
  const f = span > 0 ? clamp((s - cum[i]) / span, 0, 1) : 0;
  out.x = pts[i * 3] + (pts[i * 3 + 3] - pts[i * 3]) * f;
  out.z = pts[i * 3 + 2] + (pts[i * 3 + 5] - pts[i * 3 + 2]) * f;
  return i;
}

/**
 * How far from their shared end two paths stay within `gap` of each other.
 * `fromEnd` measures back from the ends of both polylines, as for a merge.
 */
function sharedStretch(a: PolylineData, b: PolylineData, gap: number, fromEnd: boolean): number {
  const limit = Math.min(a.length, b.length);
  const pa = { x: 0, z: 0 };
  const pb = { x: 0, z: 0 };
  let ha = fromEnd ? a.cum.length - 2 : 0;
  let hb = fromEnd ? b.cum.length - 2 : 0;
  const step = Math.max(0.5, limit / 24);
  let d = 0;
  while (d < limit) {
    const next = Math.min(limit, d + step);
    ha = pointAt(a, fromEnd ? a.length - next : next, pa, ha);
    hb = pointAt(b, fromEnd ? b.length - next : next, pb, hb);
    if (Math.hypot(pa.x - pb.x, pa.z - pb.z) >= gap) return next;
    d = next;
  }
  return limit;
}

/** Fill in `conflicts` on every connector of one node. */
export function computeConflicts(list: ConnectorProto[]): void {
  const bounds = list.map((c) => boundsOf(c.poly.pts));
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const ba = bounds[i];
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      // A level crossing is closed by the trains, not by road priority.
      if ((a.vehicleKind === 'rail') !== (b.vehicleKind === 'rail')) continue;
      const sameFrom = a.from === b.from;
      const sameTo = a.to === b.to;
      let kind: ConflictProto['kind'] | null = null;
      let selfS = 0;
      let otherS = 0;
      if (sameTo) {
        const d = sharedStretch(a.poly, b.poly, (a.width + b.width) / 2, true);
        kind = 'merge';
        selfS = a.poly.length - d;
        otherS = b.poly.length - d;
      } else if (sameFrom) {
        const d = sharedStretch(a.poly, b.poly, (a.width + b.width) / 2, false);
        kind = 'diverge';
        selfS = d;
        otherS = d;
      } else {
        const bb = bounds[j];
        if (ba.maxX < bb.minX || bb.maxX < ba.minX || ba.maxZ < bb.minZ || bb.maxZ < ba.minZ) continue;
        const hit = firstCrossing(a, b);
        if (!hit) continue;
        kind = 'cross';
        selfS = hit.selfS;
        otherS = hit.otherS;
      }
      a.conflicts.push({ other: j, selfS, otherS, kind });
      b.conflicts.push({ other: i, selfS: otherS, otherS: selfS, kind });
    }
  }
}
