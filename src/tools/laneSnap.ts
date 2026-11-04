/**
 * Lane snapping for ramps. Hovering a highway (or a street, see streetEndFor) offers a snap
 * point on every lane. The chosen lane decides where a ramp leaves or joins (the
 * outer edge of its carriageway, aligned with the traffic) and which lanes feed
 * it (the chosen lane and every lane outside it). Pure functions over a network.
 */
import { cubicPoint, cubicTangentXZ, type Cubic } from '../core/bezier';
import { addScaled, dotXZ, rightOf, scale, sub } from '../core/math';
import type { RoadAnchor, RoadNetwork } from '../core/RoadNetwork';
import { carriagewayEdge, hostDirection, isStreetHost, makeAttach, pickHost } from '../core/ramps';
import { effectiveLanes, isOneWay } from '../core/roadTypes';
import type { Id, RampAttach, Vec3 } from '../core/types';

export interface LaneSpot {
  /** Lanes in from the outer edge of its carriageway: 0 is the outermost. */
  fromEdge: number;
  /** Lanes on this carriageway. */
  count: number;
  /** Side of the host centreline, right of its a-to-b being 1. */
  side: 1 | -1;
  /** Centre of the lane at the snap. */
  centre: Vec3;
  /** Outer edge of the lane's carriageway, where a ramp leaves or joins. */
  edge: Vec3;
  /** Direction the lane's traffic runs. */
  travel: Vec3;
  /** Offset right of the host's a-to-b at the snap. */
  lateral: number;
}

export interface LaneChoice {
  host: Id;
  /** Host a-to-b direction at the snap. */
  hostDir: Vec3;
  lanes: LaneSpot[];
  chosen: LaneSpot;
  /** The host is a street or avenue rather than a highway: terminals and side merges. */
  street: boolean;
  /** Snap point on the host centreline. */
  pos: Vec3;
  /** Lanes picked with Shift-click, as well as or instead of the chosen one. */
  picked: LaneSpot[];
}

/** The highway under a segment or node anchor, with its direction there. */
function hostAt(net: RoadNetwork, anchor: RoadAnchor): { host: Id; pos: Vec3; dir: Vec3 } | null {
  if (anchor.kind === 'segment') {
    if (!net.getSegment(anchor.id)) return null;
    const c = net.cubicOf(anchor.id);
    return { host: anchor.id, pos: cubicPoint(c, anchor.t), dir: cubicTangentXZ(c, anchor.t) };
  }
  if (anchor.kind === 'node') {
    const node = net.getNode(anchor.id);
    // A dead end is carried on, not joined from the side.
    if (!node || node.segments.length < 2) return null;
    const host = pickHost(net.attachAccess, anchor.id, -1);
    if (!host) return null;
    const dir = hostDirection(net.attachAccess, host, anchor.id);
    return dir ? { host: host.id, pos: node.pos, dir } : null;
  }
  return null;
}

/** Lane snap points on a highway at an anchor, with the one nearest the cursor chosen. */
export function laneChoiceAt(net: RoadNetwork, anchor: RoadAnchor, cursor: Vec3): LaneChoice | null {
  const at = hostAt(net, anchor);
  if (!at) return null;
  const seg = net.getSegment(at.host)!;
  const def = net.roadTypeOf(at.host);
  const street = isStreetHost(def.category);
  if (def.category !== 'highway' && !street) return null;
  const all = effectiveLanes(def, seg.overrides);
  const lanes = all.filter((l) => l.kind === 'drive' || l.kind === 'bus');
  if (!lanes.length) return null;
  const oneWay = isOneWay(def);
  const right = rightOf(at.dir);
  const n = lanes.length;
  const sideOf = (i: number): 1 | -1 => (oneWay ? (i >= (n - 1) / 2 ? 1 : -1) : lanes[i].dir === 1 ? 1 : -1);
  const spots: LaneSpot[] = lanes.map((l, i) => {
    const side = sideOf(i);
    const group = lanes.filter((_, j) => sideOf(j) === side);
    const fromEdge = group.filter((o) => (side > 0 ? o.offset > l.offset : o.offset < l.offset)).length;
    const travel = oneWay || l.dir === 1 ? at.dir : scale(at.dir, -1);
    return {
      fromEdge,
      count: group.length,
      side,
      centre: addScaled(at.pos, right, l.offset),
      edge: addScaled(at.pos, right, carriagewayEdge(all, 1, side)),
      travel,
      lateral: l.offset,
    };
  });
  const lateral = dotXZ(sub(cursor, at.pos), right);
  let chosen = spots[0];
  for (const s of spots) {
    if (Math.abs(dotXZ(sub(s.centre, at.pos), right) - lateral) < Math.abs(dotXZ(sub(chosen.centre, at.pos), right) - lateral)) chosen = s;
  }
  return { host: at.host, hostDir: at.dir, lanes: spots, chosen, street, pos: { ...at.pos }, picked: [] };
}

/** Sharpest a one-way road may meet a street and still merge along its kerb, radians. */
const SIDE_MERGE_ANGLE = (35 * Math.PI) / 180;

/** How a road meets a street at a lane choice: where its end goes and the attach it gets. */
export interface StreetEnd {
  attach: RampAttach;
  /** A side merge on the kerb, rather than a terminal on the node. */
  side: boolean;
  /** Where the road's end goes. */
  pos: Vec3;
  /** Direction its traffic must run there, or null when free (a terminal). */
  travel: Vec3 | null;
  /** The lanes used, nearest the road first, with the turn into or out of each. */
  lanes: { spot: LaneSpot; turn: 'left' | 'right' | 'merge' }[];
}

/**
 * A road from `other` meeting a street at a lane choice. A one-way road arriving
 * along the kerb, on lanes of its own side only, merges there like a highway ramp;
 * anything else is a terminal on the node that turns into exactly the lanes used.
 */
export function streetEndFor(choice: LaneChoice, other: Vec3, oneWay: boolean): StreetEnd {
  const right = rightOf(choice.hostDir);
  const away = sub(other, choice.pos);
  const roadSide: 1 | -1 = dotXZ(away, right) >= 0 ? 1 : -1;
  // Every lane across, nearest the road's side first: the order RampAttach.lanes counts in.
  const across = [...choice.lanes].sort((a, b) => (b.lateral - a.lateral) * roadSide);
  const used = choice.picked.length ? choice.picked : [choice.chosen];
  const positions = [...new Set(used.map((u) => across.findIndex((s) => Math.abs(s.lateral - u.lateral) < 1e-3)))].filter((p) => p >= 0).sort((a, b) => a - b);
  const near = across[0];
  const len = Math.hypot(away.x, away.z);
  const shallow = len > 1e-3 && Math.abs(dotXZ(away, choice.hostDir)) / len > Math.cos(SIDE_MERGE_ANGLE);
  const sameWay = positions.every((p) => dotXZ(across[p].travel, near.travel) > 0);
  const hostSide = makeAttach(0, choice.hostDir, scale(choice.hostDir, 1), roadSide).hostSide;
  if (oneWay && shallow && sameWay && positions.length) {
    const lane = positions[positions.length - 1];
    // The road runs with the near lanes' traffic.
    const attach = makeAttach(lane, choice.hostDir, near.travel, roadSide);
    return { attach, side: true, pos: { ...near.edge }, travel: near.travel, lanes: positions.map((p) => ({ spot: across[p], turn: 'merge' })) };
  }
  // A lane running the same way as the near kerb lane is turned into to the right.
  const lanes = positions.map((p) => ({ spot: across[p], turn: (dotXZ(across[p].travel, near.travel) > 0 ? 'right' : 'left') as 'left' | 'right' }));
  return { attach: { lane: 0, hostSide, lanes: positions }, side: false, pos: { ...choice.pos }, travel: null, lanes };
}

/** The attach for a road leaving (or joining) the chosen lane along `rampDir`. */
export function attachFor(choice: LaneChoice, rampDir: Vec3): RampAttach {
  return makeAttach(choice.chosen.fromEdge, choice.hostDir, rampDir, choice.chosen.side);
}

/** The same attach seen from a road running the other way. */
export function flipAttach(a: RampAttach | undefined): RampAttach | undefined {
  return a ? { ...a, hostSide: a.hostSide === 1 ? -1 : 1 } : undefined;
}

export function reverseCubic(c: Cubic): Cubic {
  return { p0: c.p3, p1: c.p2, p2: c.p1, p3: c.p0 };
}

/** Small chevrons along a curve, pointing the way traffic runs, as line points. */
export function travelChevrons(c: Cubic, spacing = 28, size = 2.2): Vec3[][] {
  const out: Vec3[][] = [];
  let length = 0;
  let prev = c.p0;
  for (let i = 1; i <= 32; i++) {
    const p = cubicPoint(c, i / 32);
    length += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
  }
  const count = Math.max(1, Math.floor(length / spacing));
  for (let k = 0; k < count; k++) {
    const t = (k + 0.5) / count;
    const p = cubicPoint(c, t);
    const f = cubicTangentXZ(c, t);
    const r = rightOf(f);
    const y = p.y + 0.4;
    const back = addScaled(p, f, -size);
    out.push([
      { x: back.x + r.x * size, y, z: back.z + r.z * size },
      { x: p.x, y, z: p.z },
      { x: back.x - r.x * size, y, z: back.z - r.z * size },
    ]);
  }
  return out;
}
