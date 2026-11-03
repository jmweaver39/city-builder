/**
 * Where hand-placed markings at a node sit. Markings store anchors by arm and
 * boundary index, so everything here is derived from the live road geometry and
 * a marking follows its road. Pure reads of a RoadNetwork.
 */
import type { Cubic } from './bezier';
import { cubicLength, cubicPoint } from './bezier';
import { stationAt } from './geometry';
import { clamp, distXZ, normalizeXZ } from './math';
import type { RoadNetwork } from './RoadNetwork';
import { effectiveLanes } from './roadTypes';
import type {
  Id,
  LaneDef,
  MarkingAnchor,
  NodeFillerMarking,
  NodeLineMarking,
  RoadTypeDef,
  SegmentOverrides,
  Vec3,
} from './types';

/** With no junction surface, anchors step back along each arm so the two sides differ. */
const JOINT_SETBACK = 6;
const MERGE_GAP = 0.05;
/** Handle length as a share of the chord, close to a circular arc for a right angle. */
const HANDLE_SHARE = 0.42;

/** Offsets of the road edges and lane edges, left to right along a-to-b. */
export function boundaryOffsets(def: RoadTypeDef, overrides?: SegmentOverrides): number[] {
  const lanes: readonly LaneDef[] = effectiveLanes(def, overrides);
  const raw = [-def.halfWidth, def.halfWidth];
  for (const l of lanes) raw.push(l.offset - l.width / 2, l.offset + l.width / 2);
  raw.sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of raw) if (!out.length || x - out[out.length - 1] > MERGE_GAP) out.push(x);
  return out;
}

export interface ArmFrame {
  segmentId: Id;
  /** Point on the road's centreline where the anchors sit. */
  pos: Vec3;
  /** Right of a-to-b travel. Offsets are measured along it. */
  right: Vec3;
  /** Unit plan direction along the road towards the node. */
  inward: Vec3;
  offsets: number[];
}

/** The anchor line of each arm of a node. */
export function armFrames(net: RoadNetwork, nodeId: Id): ArmFrame[] {
  const geom = net.nodeGeom(nodeId);
  if (!geom) return [];
  const out: ArmFrame[] = [];
  for (const arm of geom.arms) {
    const seg = net.getSegment(arm.segmentId);
    const segGeom = net.segmentGeom(arm.segmentId);
    if (!seg || !segGeom || segGeom.stations.length < 2) continue;
    const setback = geom.kind === 'junction' ? 0 : Math.min(JOINT_SETBACK, segGeom.length * 0.4);
    const s = arm.atStart ? segGeom.trimA + setback : segGeom.fullLength - segGeom.trimB - setback;
    const st = stationAt(net.curveOf(arm.segmentId), s);
    const flip = arm.atStart ? -1 : 1;
    out.push({
      segmentId: arm.segmentId,
      pos: st.pos,
      right: st.right,
      inward: normalizeXZ({ x: st.tangent.x * flip, y: 0, z: st.tangent.z * flip }),
      offsets: boundaryOffsets(net.roadTypeOf(arm.segmentId), seg.overrides),
    });
  }
  return out;
}

export interface AnchorPoint {
  anchor: MarkingAnchor;
  pos: Vec3;
  inward: Vec3;
  /** True on the outer edges of the road. */
  edge: boolean;
}

function pointOn(frame: ArmFrame, boundary: number): AnchorPoint | null {
  const offset = frame.offsets[boundary];
  if (offset === undefined) return null;
  return {
    anchor: { segmentId: frame.segmentId, boundary },
    pos: { x: frame.pos.x + frame.right.x * offset, y: frame.pos.y, z: frame.pos.z + frame.right.z * offset },
    inward: frame.inward,
    edge: boundary === 0 || boundary === frame.offsets.length - 1,
  };
}

/** Every anchor at a node. */
export function nodeAnchors(net: RoadNetwork, nodeId: Id): AnchorPoint[] {
  const out: AnchorPoint[] = [];
  for (const frame of armFrames(net, nodeId)) {
    for (let i = 0; i < frame.offsets.length; i++) out.push(pointOn(frame, i)!);
  }
  return out;
}

/** One anchor, or null when its arm or boundary no longer exists. */
export function resolveAnchor(net: RoadNetwork, nodeId: Id, anchor: MarkingAnchor): AnchorPoint | null {
  const frame = armFrames(net, nodeId).find((f) => f.segmentId === anchor.segmentId);
  return frame ? pointOn(frame, anchor.boundary) : null;
}

export function sameAnchor(a: MarkingAnchor, b: MarkingAnchor): boolean {
  return a.segmentId === b.segmentId && a.boundary === b.boundary;
}

/** Both anchors on one arm: a line across the road, not a turn. */
export function acrossOneArm(a: MarkingAnchor, b: MarkingAnchor): boolean {
  return a.segmentId === b.segmentId;
}

function straightBetween(p0: Vec3, p3: Vec3): Cubic {
  const third = (k: number): Vec3 => ({ x: p0.x + (p3.x - p0.x) * k, y: p0.y + (p3.y - p0.y) * k, z: p0.z + (p3.z - p0.z) * k });
  return { p0, p1: third(1 / 3), p2: third(2 / 3), p3 };
}

/** The curve of a line between two anchors, tangent to the lanes at both ends. */
export function anchorCurve(p: AnchorPoint, q: AnchorPoint, straight: boolean): Cubic {
  if (straight) return straightBetween(p.pos, q.pos);
  const handle = HANDLE_SHARE * distXZ(p.pos, q.pos);
  const a = handle;
  const b = handle;
  const k = 1 / 3;
  return {
    p0: p.pos,
    p1: { x: p.pos.x + p.inward.x * a, y: p.pos.y + (q.pos.y - p.pos.y) * k, z: p.pos.z + p.inward.z * a },
    p2: { x: q.pos.x + q.inward.x * b, y: q.pos.y + (p.pos.y - q.pos.y) * k, z: q.pos.z + q.inward.z * b },
    p3: q.pos,
  };
}

/** The curve of a line marking. Null when an anchor is gone. */
export function lineCurve(net: RoadNetwork, nodeId: Id, m: NodeLineMarking): Cubic | null {
  const p = resolveAnchor(net, nodeId, m.from);
  const q = resolveAnchor(net, nodeId, m.to);
  if (!p || !q || distXZ(p.pos, q.pos) < 0.05) return null;
  return anchorCurve(p, q, m.straight);
}

/** The corners of a filler, in click order. Null when an anchor is gone. */
export function fillerPolygon(net: RoadNetwork, nodeId: Id, m: Pick<NodeFillerMarking, 'anchors'>): Vec3[] | null {
  const out: Vec3[] = [];
  for (const anchor of m.anchors) {
    const p = resolveAnchor(net, nodeId, anchor);
    if (!p) return null;
    out.push(p.pos);
  }
  return out.length >= 3 ? out : null;
}

/** The middle of a curve, to label or pick a marking by. */
export function curveMidpoint(c: Cubic): Vec3 {
  return cubicPoint(c, 0.5);
}

/** Evenly spaced samples of a curve, about one per `spacing` metres. */
export function sampleCurve(c: Cubic, spacing: number): Vec3[] {
  const n = clamp(Math.ceil(cubicLength(c, 16) / spacing), 2, 64);
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) out.push(cubicPoint(c, i / n));
  return out;
}

/** Mean of a set of points. */
export function polygonCentre(points: readonly Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
    z += p.z;
  }
  const n = Math.max(points.length, 1);
  return { x: x / n, y: y / n, z: z / n };
}

