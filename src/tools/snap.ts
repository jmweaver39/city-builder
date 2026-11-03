/**
 * Snapping for road drawing. Pure functions over a RoadNetwork.
 *
 * Order of preference: existing nodes, points along existing roads, then the
 * guides from the point being drawn from: angle steps relative to the road being
 * left, and whole multiples of the length step. Roads have no grid.
 */
import { cubicTangentXZ } from '../core/bezier';
import { add, distXZ, normalizeXZ, scale, signedTurn, sub } from '../core/math';
import type { RoadAnchor, RoadNetwork } from '../core/RoadNetwork';
import { totalHalfWidth } from '../core/roadTypes';
import type { Id, Vec3 } from '../core/types';
import { nearestOnLevel } from './pick';
import { refineSegmentHit, snapWithGrid, type GridSettings } from './grid';

export const ANGLE_STEP = (15 * Math.PI) / 180;
export const LENGTH_STEP = 8;
/** The cursor must be this close to a guide line to catch it, in metres. */
export const GUIDE_CATCH = 5;
/** ...and within this angle. Keeps near-origin moves from flicking between guides. */
export const GUIDE_CATCH_ANGLE = (4 * Math.PI) / 180;
export const LENGTH_CATCH = 2.5;
export const NODE_CATCH = 8;
/** A hit this close to a segment end lands on its node instead. */
export const SEGMENT_END_GAP = 6;

export type SnapKind = 'free' | 'node' | 'segment' | 'angle' | 'length' | 'angleLength' | 'grid' | 'gridLine';

export interface SnapHit {
  pos: Vec3;
  anchor: RoadAnchor;
  kind: SnapKind;
  /** Turn from the reference direction, radians. Set when a reference exists. */
  angle: number | null;
  /** Guide ray to draw. */
  guide: { from: Vec3; to: Vec3 } | null;
}

export interface SnapFrom {
  pos: Vec3;
  /** Direction the angle guides are measured from. Null falls back to world axes. */
  ref: Vec3 | null;
}

export interface SnapToggles {
  nodes: boolean;
  segments: boolean;
  angle: boolean;
  length: boolean;
}

export interface SnapQuery {
  /** The cursor on the plane of each height band, highest first. */
  picks: { level: number; pos: Vec3 }[];
  /** The cursor at the drawing elevation. Sets the height of a free end. */
  raw: Vec3;
  from: SnapFrom | null;
  toggles: SnapToggles;
  /** Ctrl or Cmd held: no snapping of any kind. */
  disabled: boolean;
  /** Never snap to these, usually the node being drawn from. */
  ignoreNodes?: readonly Id[];
  /** The optional drawing grid. Absent or disabled leaves snapping exactly as without it. */
  grid?: GridSettings | null;
}

const BAND_TOLERANCE = 2.5;

function turnFrom(from: SnapFrom | null, pos: Vec3): number | null {
  if (!from) return null;
  if (distXZ(from.pos, pos) < 1e-6) return null;
  const dir = normalizeXZ(sub(pos, from.pos));
  return signedTurn(from.ref ?? { x: 1, y: 0, z: 0 }, dir);
}

function snapToNode(net: RoadNetwork, q: SnapQuery): SnapHit | null {
  const ignore = q.ignoreNodes ?? [];
  let best: { id: Id; d: number; pos: Vec3 } | null = null;
  for (const { level, pos } of q.picks) {
    const box = { minX: pos.x - NODE_CATCH, minZ: pos.z - NODE_CATCH, maxX: pos.x + NODE_CATCH, maxZ: pos.z + NODE_CATCH };
    for (const id of net.nodesInRegion(box)) {
      if (ignore.includes(id)) continue;
      const node = net.getNode(id)!;
      if (Math.abs(node.pos.y - level) > BAND_TOLERANCE) continue;
      const d = distXZ(node.pos, pos);
      if (d <= NODE_CATCH && (!best || d < best.d)) best = { id, d, pos: node.pos };
    }
  }
  if (!best) return null;
  return {
    pos: { ...best.pos },
    anchor: { kind: 'node', id: best.id },
    kind: 'node',
    angle: turnFrom(q.from, best.pos),
    guide: null,
  };
}

function snapToSegment(net: RoadNetwork, q: SnapQuery): SnapHit | null {
  let best: SnapHit | null = null;
  let bestD = Infinity;
  for (const { level, pos } of q.picks) {
    const hit = nearestOnLevel(net, pos, level, 40);
    if (!hit) continue;
    const def = net.roadTypeOf(hit.segmentId);
    if (hit.distance > Math.max(NODE_CATCH, totalHalfWidth(def) + 1) || hit.distance >= bestD) continue;
    const seg = net.getSegment(hit.segmentId)!;
    const length = net.segmentGeom(hit.segmentId)?.fullLength ?? 0;
    bestD = hit.distance;
    if (hit.t * length < SEGMENT_END_GAP || (1 - hit.t) * length < SEGMENT_END_GAP) {
      const nodeId = hit.t < 0.5 ? seg.a : seg.b;
      if ((q.ignoreNodes ?? []).includes(nodeId)) continue;
      const node = net.getNode(nodeId)!;
      best = {
        pos: { ...node.pos },
        anchor: { kind: 'node', id: nodeId },
        kind: 'node',
        angle: turnFrom(q.from, node.pos),
        guide: null,
      };
    } else {
      best = {
        pos: { ...hit.point },
        anchor: { kind: 'segment', id: hit.segmentId, t: hit.t },
        kind: 'segment',
        angle: turnFrom(q.from, hit.point),
        guide: null,
      };
    }
  }
  return best;
}

function snapToGuides(q: SnapQuery): SnapHit {
  const { raw, from, toggles } = q;
  const free: SnapHit = { pos: { ...raw }, anchor: { kind: 'free', pos: { ...raw } }, kind: 'free', angle: turnFrom(from, raw), guide: null };
  if (!from) return free;
  const delta = sub(raw, from.pos);
  const plan = Math.hypot(delta.x, delta.z);
  if (plan < 1) return free;

  let dir = normalizeXZ(delta);
  let length = plan;
  let kind: SnapKind = 'free';
  let guide: SnapHit['guide'] = null;

  if (toggles.angle) {
    const ref = from.ref ?? { x: 1, y: 0, z: 0 };
    const turn = signedTurn(ref, dir);
    const stepped = Math.round(turn / ANGLE_STEP) * ANGLE_STEP;
    const cos = Math.cos(stepped);
    const sin = Math.sin(stepped);
    // signedTurn is positive clockwise from above, which rotates x towards z.
    const candidate = { x: ref.x * cos - ref.z * sin, y: 0, z: ref.x * sin + ref.z * cos };
    const along = delta.x * candidate.x + delta.z * candidate.z;
    const lateral = Math.abs(delta.x * candidate.z - delta.z * candidate.x);
    if (along > 0 && lateral <= GUIDE_CATCH && Math.abs(turn - stepped) <= GUIDE_CATCH_ANGLE) {
      dir = candidate;
      length = along;
      kind = 'angle';
    }
  }

  if (toggles.length) {
    const rounded = Math.max(1, Math.round(length / LENGTH_STEP)) * LENGTH_STEP;
    if (Math.abs(rounded - length) <= LENGTH_CATCH || kind === 'angle') {
      length = rounded;
      kind = kind === 'angle' ? 'angleLength' : 'length';
    }
  }

  if (kind === 'free') return free;
  const pos = add(from.pos, scale(dir, length));
  pos.y = raw.y;
  if (kind === 'angle' || kind === 'angleLength') {
    const far = add(from.pos, scale(dir, Math.max(length, 40) * 1.5));
    far.y = raw.y;
    guide = { from: { ...from.pos }, to: far };
  }
  return { pos, anchor: { kind: 'free', pos: { ...pos } }, kind, angle: turnFrom(from, pos), guide };
}

/** Where a road end lands for this cursor position. */
export function snapRoadPoint(net: RoadNetwork, q: SnapQuery): SnapHit {
  if (q.disabled) {
    return { pos: { ...q.raw }, anchor: { kind: 'free', pos: { ...q.raw } }, kind: 'free', angle: turnFrom(q.from, q.raw), guide: null };
  }
  if (q.toggles.nodes) {
    const hit = snapToNode(net, q);
    if (hit) return hit;
  }
  if (q.toggles.segments) {
    const hit = snapToSegment(net, q);
    if (hit) return q.grid?.enabled ? refineSegmentHit(net, hit, q.grid, SEGMENT_END_GAP) : hit;
  }
  // The optional grid (grid.ts) comes after nodes and roads, which make connections.
  if (q.grid?.enabled) return snapWithGrid(q, snapToGuides);
  return snapToGuides(q);
}

/**
 * Plan-view direction of travel for continuing past a dead end, with the slope
 * of that road. Null unless the node has exactly one road.
 */
export function continuationAt(net: RoadNetwork, nodeId: Id): { dir: Vec3; slope: number } | null {
  const node = net.getNode(nodeId);
  if (!node || node.segments.length !== 1) return null;
  const segId = node.segments[0];
  const seg = net.getSegment(segId)!;
  const c = net.cubicOf(segId);
  const atStart = seg.a === nodeId;
  const inner = atStart ? cubicFirstHandle(c) : cubicLastHandle(c);
  const planOut = distXZ(inner, node.pos);
  const dir = planOut > 1e-6 ? normalizeXZ(sub(node.pos, inner)) : normalizeXZ(scale(cubicTangentXZ(c, atStart ? 0 : 1), atStart ? -1 : 1));
  const slope = planOut > 1e-6 ? (node.pos.y - inner.y) / planOut : 0;
  return { dir, slope };
}

function cubicFirstHandle(c: { p0: Vec3; p1: Vec3 }): Vec3 {
  return c.p1;
}

function cubicLastHandle(c: { p2: Vec3; p3: Vec3 }): Vec3 {
  return c.p2;
}

/** Direction the angle guides at an anchor are measured from. */
export function referenceDirection(net: RoadNetwork, anchor: RoadAnchor, towards: Vec3 | null): Vec3 | null {
  if (anchor.kind === 'segment') {
    if (!net.getSegment(anchor.id)) return null;
    return cubicTangentXZ(net.cubicOf(anchor.id), anchor.t);
  }
  if (anchor.kind === 'node') {
    const geom = net.nodeGeom(anchor.id);
    const arms = geom?.arms ?? [];
    if (!arms.length) return null;
    if (arms.length === 1 || !towards) return arms[0].dir;
    const node = net.getNode(anchor.id)!;
    const look = normalizeXZ(sub(towards, node.pos));
    let best = arms[0].dir;
    let bestCos = -2;
    for (const arm of arms) {
      const cos = Math.abs(arm.dir.x * look.x + arm.dir.z * look.z);
      if (cos > bestCos) {
        bestCos = cos;
        best = arm.dir;
      }
    }
    return best;
  }
  return null;
}
