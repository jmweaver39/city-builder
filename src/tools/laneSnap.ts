/**
 * Lane snapping for ramps. Hovering a highway with the road tool offers a snap
 * point on every lane. The chosen lane decides where a ramp leaves or joins (the
 * outer edge of its carriageway, aligned with the traffic) and which lanes feed
 * it (the chosen lane and every lane outside it). Pure functions over a network.
 */
import { cubicPoint, cubicTangentXZ, type Cubic } from '../core/bezier';
import { addScaled, dotXZ, rightOf, scale, sub } from '../core/math';
import type { RoadAnchor, RoadNetwork } from '../core/RoadNetwork';
import { carriagewayEdge, hostDirection, makeAttach, pickHost } from '../core/ramps';
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
}

export interface LaneChoice {
  host: Id;
  /** Host a-to-b direction at the snap. */
  hostDir: Vec3;
  lanes: LaneSpot[];
  chosen: LaneSpot;
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
  if (def.category !== 'highway') return null;
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
    };
  });
  const lateral = dotXZ(sub(cursor, at.pos), right);
  let chosen = spots[0];
  for (const s of spots) {
    if (Math.abs(dotXZ(sub(s.centre, at.pos), right) - lateral) < Math.abs(dotXZ(sub(chosen.centre, at.pos), right) - lateral)) chosen = s;
  }
  return { host: at.host, hostDir: at.dir, lanes: spots, chosen };
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
