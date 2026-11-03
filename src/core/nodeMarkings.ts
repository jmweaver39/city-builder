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

function pointOn(frame: ArmFrame, boundary: number, back = 0): AnchorPoint | null {
  const offset = frame.offsets[boundary];
  if (offset === undefined) return null;
  const bx = -frame.inward.x * back;
  const bz = -frame.inward.z * back;
  return {
    anchor: back ? { segmentId: frame.segmentId, boundary, back } : { segmentId: frame.segmentId, boundary },
    pos: { x: frame.pos.x + frame.right.x * offset + bx, y: frame.pos.y, z: frame.pos.z + frame.right.z * offset + bz },
    inward: frame.inward,
    edge: boundary === 0 || boundary === frame.offsets.length - 1,
  };
}

/** A row of anchors across an arm, a distance back from its cut line. */
export function armRow(net: RoadNetwork, nodeId: Id, segmentId: Id, back: number): AnchorPoint[] {
  const frame = armFrames(net, nodeId).find((f) => f.segmentId === segmentId);
  if (!frame) return [];
  const length = net.segmentGeom(segmentId)?.length ?? 0;
  const at = Math.max(0, Math.min(back, length * 0.45));
  return frame.offsets.map((_, i) => pointOn(frame, i, at)!);
}

// ---------------------------------------------------------------------------
// The junction outline
// ---------------------------------------------------------------------------

export interface CornerChain {
  /** The arm whose left edge, looking at the node, starts the chain. */
  segmentId: Id;
  nextSegmentId: Id;
  points: Vec3[];
  /** Arc length at each point. */
  cum: number[];
  length: number;
}

function nearestIndex(poly: readonly Vec3[], p: Vec3): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = (poly[i].x - p.x) ** 2 + (poly[i].z - p.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return bestD < 0.25 ? best : -1;
}

/**
 * The kerb from each arm's left edge to the next arm's right edge, clockwise, the
 * same walk the renderer uses for its corners, so marks sit on what is drawn.
 */
export function cornerChains(net: RoadNetwork, nodeId: Id): CornerChain[] {
  const geom = net.nodeGeom(nodeId);
  if (!geom || geom.kind !== 'junction' || geom.outline.length < 3) return [];
  const poly = geom.outline;
  const n = poly.length;
  const out: CornerChain[] = [];
  geom.arms.forEach((arm, i) => {
    const next = geom.arms[(i + 1) % geom.arms.length];
    const from = nearestIndex(poly, arm.leftEdge);
    const to = nearestIndex(poly, next.rightEdge);
    if (from < 0 || to < 0) return;
    const points: Vec3[] = [];
    for (let k = 0; k <= n; k++) {
      const j = (from + k) % n;
      points.push(poly[j]);
      if (j === to && k > 0) break;
    }
    if (points[points.length - 1] !== poly[to]) return;
    const cum = [0];
    for (let k = 1; k < points.length; k++) cum.push(cum[k - 1] + Math.hypot(points[k].x - points[k - 1].x, points[k].z - points[k - 1].z));
    out.push({ segmentId: arm.segmentId, nextSegmentId: next.segmentId, points, cum, length: cum[cum.length - 1] });
  });
  return out;
}

function pointAlong(chain: CornerChain, u: number): Vec3 {
  const s = Math.min(1, Math.max(0, u)) * chain.length;
  let k = 1;
  while (k < chain.cum.length - 1 && chain.cum[k] < s) k++;
  const a = chain.points[k - 1];
  const b = chain.points[k];
  const span = chain.cum[k] - chain.cum[k - 1];
  const f = span > 1e-9 ? (s - chain.cum[k - 1]) / span : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
}

/** The part of a chain between two fractions, in the order asked for. */
export function chainBetween(chain: CornerChain, u0: number, u1: number): Vec3[] {
  const lo = Math.min(u0, u1) * chain.length;
  const hi = Math.max(u0, u1) * chain.length;
  const out: Vec3[] = [pointAlong(chain, lo / Math.max(chain.length, 1e-9))];
  for (let k = 0; k < chain.points.length; k++) if (chain.cum[k] > lo + 1e-6 && chain.cum[k] < hi - 1e-6) out.push(chain.points[k]);
  out.push(pointAlong(chain, hi / Math.max(chain.length, 1e-9)));
  return u0 <= u1 ? out : out.reverse();
}

/** Anchors along every corner of a node, about one per `spacing` metres. */
export function outlineAnchors(net: RoadNetwork, nodeId: Id, spacing = 2): AnchorPoint[] {
  const out: AnchorPoint[] = [];
  const node = net.getNode(nodeId);
  if (!node) return out;
  for (const chain of cornerChains(net, nodeId)) {
    const steps = Math.max(2, Math.round(chain.length / spacing));
    // The two ends are the road edges, already anchors on the cut lines.
    for (let k = 1; k < steps; k++) {
      const u = Math.round((k / steps) * 1e6) / 1e6;
      const pos = pointAlong(chain, u);
      const inward = normalizeXZ({ x: node.pos.x - pos.x, y: 0, z: node.pos.z - pos.z });
      out.push({ anchor: { segmentId: chain.segmentId, boundary: 0, corner: u }, pos, inward, edge: true });
    }
  }
  return out;
}

/**
 * Which corner chain an anchor lies on, and where. An outline anchor names its
 * chain. A road-edge anchor on a cut line is the end of two chains; `other` picks
 * the one that also holds the other anchor.
 */
function onChain(net: RoadNetwork, nodeId: Id, a: MarkingAnchor, chains: CornerChain[]): { chain: CornerChain; u: number }[] {
  if (a.corner !== undefined) {
    const chain = chains.find((c) => c.segmentId === a.segmentId);
    return chain ? [{ chain, u: a.corner }] : [];
  }
  if (a.back) return [];
  const arm = net.nodeGeom(nodeId)?.arms.find((x) => x.segmentId === a.segmentId);
  const seg = net.getSegment(a.segmentId);
  if (!arm || !seg) return [];
  const count = boundaryOffsets(net.roadTypeOf(a.segmentId), seg.overrides).length;
  // Looking at the node, an arm's left edge is the segment's right when it leaves from a.
  const leftBoundary = arm.atStart ? count - 1 : 0;
  const rightBoundary = arm.atStart ? 0 : count - 1;
  const out: { chain: CornerChain; u: number }[] = [];
  for (const chain of chains) {
    if (chain.segmentId === a.segmentId && a.boundary === leftBoundary) out.push({ chain, u: 0 });
    if (chain.nextSegmentId === a.segmentId && a.boundary === rightBoundary) out.push({ chain, u: 1 });
  }
  return out;
}

/** The kerb between two anchors on the same corner, or null if they share none. */
export function outlinePath(net: RoadNetwork, nodeId: Id, a: MarkingAnchor, b: MarkingAnchor): Vec3[] | null {
  const chains = cornerChains(net, nodeId);
  for (const p of onChain(net, nodeId, a, chains)) {
    for (const q of onChain(net, nodeId, b, chains)) {
      if (p.chain === q.chain && Math.abs(p.u - q.u) > 1e-6) return chainBetween(p.chain, p.u, q.u);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Following lane paths through a junction
// ---------------------------------------------------------------------------

/** A connector's points, in travel order. */
function connectorPoints(pts: Float32Array): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < pts.length; i += 3) out.push({ x: pts[i], y: pts[i + 1], z: pts[i + 2] });
  return out;
}

/**
 * A path along `guide` that starts at `from` and ends at `to`: each point keeps its
 * place along the guide and slides sideways, blending the start's offset into the
 * end's. So it bends exactly as the lane path does.
 */
export function alongGuide(guide: readonly Vec3[], from: Vec3, to: Vec3): Vec3[] {
  const n = guide.length;
  if (n < 2) return [from, to];
  const side = (i: number): { rx: number; rz: number } => {
    const a = guide[Math.max(0, i - 1)];
    const b = guide[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    return { rx: -dz / l, rz: dx / l };
  };
  const s0 = side(0);
  const s1 = side(n - 1);
  const d0 = (from.x - guide[0].x) * s0.rx + (from.z - guide[0].z) * s0.rz;
  const d1 = (to.x - guide[n - 1].x) * s1.rx + (to.z - guide[n - 1].z) * s1.rz;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(guide[i].x - guide[i - 1].x, guide[i].z - guide[i - 1].z));
  const total = cum[n - 1] || 1;
  const out: Vec3[] = [from];
  for (let i = 1; i < n - 1; i++) {
    const f = cum[i] / total;
    const d = d0 + (d1 - d0) * f;
    const s = side(i);
    out.push({ x: guide[i].x + s.rx * d, y: from.y + (to.y - from.y) * f, z: guide[i].z + s.rz * d });
  }
  out.push(to);
  return folds(out, guide, side) ? smoothAlong(guide, from, to, side) : out;
}

/**
 * True when an offset copy of a guide doubles back on itself, which happens when the
 * offset on the inside of a turn is wider than the turn's radius.
 */
function folds(out: readonly Vec3[], guide: readonly Vec3[], side: (i: number) => { rx: number; rz: number }): boolean {
  for (let i = 0; i + 1 < out.length; i++) {
    const s = side(Math.min(i, guide.length - 1));
    const dx = out[i + 1].x - out[i].x;
    const dz = out[i + 1].z - out[i].z;
    // The guide's direction is the side vector turned back a quarter.
    if (dx * s.rz - dz * s.rx < -1e-6 * (Math.abs(dx) + Math.abs(dz) + 1e-9)) return true;
  }
  return false;
}

/** A smooth curve from `from` to `to` that leaves and arrives in the guide's directions. */
function smoothAlong(guide: readonly Vec3[], from: Vec3, to: Vec3, side: (i: number) => { rx: number; rz: number }): Vec3[] {
  const n = Math.max(guide.length, 8);
  const s0 = side(0);
  const s1 = side(guide.length - 1);
  const h = HANDLE_SHARE * distXZ(from, to);
  const p1 = { x: from.x + s0.rz * h, z: from.z - s0.rx * h };
  const p2 = { x: to.x - s1.rz * h, z: to.z + s1.rx * h };
  const out: Vec3[] = [from];
  for (let i = 1; i < n - 1; i++) {
    const t = i / (n - 1);
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push({
      x: a * from.x + b * p1.x + c * p2.x + d * to.x,
      y: from.y + (to.y - from.y) * t,
      z: a * from.z + b * p1.z + c * p2.z + d * to.z,
    });
  }
  out.push(to);
  return out;
}

/**
 * The lane path through a node from near one point to near another, either way
 * round, as points from the first to the second. Only connectors between the two
 * given roads are considered when they are given.
 */
export function connectorGuide(net: RoadNetwork, nodeId: Id, from: Vec3, to: Vec3, segA?: Id, segB?: Id): Vec3[] | null {
  const graph = net.laneGraph;
  let best: Vec3[] | null = null;
  let bestD = Infinity;
  for (const idx of graph.connectorsAt.get(nodeId) ?? []) {
    const lane = graph.lanes[idx];
    const fromSeg = graph.lanes[lane.fromLane].segmentId;
    const toSeg = graph.lanes[lane.toLane].segmentId;
    const pts = connectorPoints(lane.pts);
    const first = pts[0];
    const last = pts[pts.length - 1];
    const fit = (p: Vec3, q: Vec3) => Math.hypot(p.x - from.x, p.z - from.z) + Math.hypot(q.x - to.x, q.z - to.z);
    const forward = segA === undefined || (fromSeg === segA && toSeg === segB);
    const backward = segA === undefined || (fromSeg === segB && toSeg === segA);
    if (forward && fit(first, last) < bestD) {
      bestD = fit(first, last);
      best = pts;
    }
    if (backward && fit(last, first) < bestD) {
      bestD = fit(last, first);
      best = [...pts].reverse();
    }
  }
  return best;
}

/** A line between anchors on two arms, following the lane paths between them. */
export function lanePath(net: RoadNetwork, nodeId: Id, a: MarkingAnchor, b: MarkingAnchor): Vec3[] | null {
  const p = resolveAnchor(net, nodeId, a);
  const q = resolveAnchor(net, nodeId, b);
  if (!p || !q || a.segmentId === b.segmentId) return null;
  const guide = connectorGuide(net, nodeId, p.pos, q.pos, a.segmentId, b.segmentId);
  return guide ? alongGuide(guide, p.pos, q.pos) : null;
}

/** Every anchor at a node. */
export function nodeAnchors(net: RoadNetwork, nodeId: Id): AnchorPoint[] {
  const out: AnchorPoint[] = [];
  for (const frame of armFrames(net, nodeId)) {
    for (let i = 0; i < frame.offsets.length; i++) out.push(pointOn(frame, i)!);
  }
  return out;
}

/** One anchor, or null when its arm, boundary or corner no longer exists. */
export function resolveAnchor(net: RoadNetwork, nodeId: Id, anchor: MarkingAnchor): AnchorPoint | null {
  if (anchor.corner !== undefined) {
    const chain = cornerChains(net, nodeId).find((c) => c.segmentId === anchor.segmentId);
    const node = net.getNode(nodeId);
    if (!chain || !node) return null;
    const pos = pointAlong(chain, anchor.corner);
    return { anchor, pos, inward: normalizeXZ({ x: node.pos.x - pos.x, y: 0, z: node.pos.z - pos.z }), edge: true };
  }
  const frame = armFrames(net, nodeId).find((f) => f.segmentId === anchor.segmentId);
  return frame ? pointOn(frame, anchor.boundary, anchor.back ?? 0) : null;
}

export function sameAnchor(a: MarkingAnchor, b: MarkingAnchor): boolean {
  return a.segmentId === b.segmentId && a.boundary === b.boundary && a.corner === b.corner && (a.back ?? 0) === (b.back ?? 0);
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

/**
 * The points of a line marking, whatever its path. Null when an anchor is gone, or
 * the path asked for no longer exists, as when the arms stop sharing a corner.
 */
export function markingPath(net: RoadNetwork, nodeId: Id, m: NodeLineMarking): Vec3[] | null {
  if (m.path === 'outline') return outlinePath(net, nodeId, m.from, m.to);
  if (m.path === 'lanes') return lanePath(net, nodeId, m.from, m.to);
  const c = lineCurve(net, nodeId, m);
  return c ? sampleCurve(c, 0.8) : null;
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

