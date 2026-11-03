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
  MarkingHost,
  MarkingPointSetting,
  NodeFillerMarking,
  NodeLineMarking,
  RoadTypeDef,
  SegmentOverrides,
  Vec3,
} from './types';

/** A node id, as everywhere before segment markings, or a host of either kind. */
export type HostArg = Id | MarkingHost;

export function hostOf(h: HostArg): MarkingHost {
  return typeof h === 'number' ? { kind: 'node', id: h } : h;
}

export function sameHost(a: MarkingHost, b: MarkingHost): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** Sideways step of a point placed on the left or right edge of its boundary line. */
export const PLACE_SHIFT = 0.075;

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
  /** Segment hosts: which end of the segment this cut line is at. */
  end?: 'a' | 'b';
  /** Point on the road's centreline where the anchors sit. */
  pos: Vec3;
  /** Right of a-to-b travel. Offsets are measured along it. */
  right: Vec3;
  /** Unit plan direction into the host: towards the node, or along a segment towards its other end. */
  inward: Vec3;
  /** Unit plan direction a row further `back` moves: away from the node, or into the segment. */
  backDir: Vec3;
  offsets: number[];
  /** Arc length on the segment's curve where the cut line sits, and the sign `back` moves it by. */
  s: number;
  backSign: 1 | -1;
  /** 1 when a-to-b right is the right as seen looking into the host, -1 when it is the left. */
  seenSign: 1 | -1;
  /** Lane flow at each boundary. */
  flows: AnchorFlow[];
  /** The point settings of this host. */
  points: readonly MarkingPointSetting[];
}

/**
 * Which way traffic runs beside a boundary, looking into the host: 'enter' with
 * the lanes on both sides heading in, 'exit' heading out, 'split' between the two,
 * 'edge' at the road's sides.
 */
export type AnchorFlow = 'enter' | 'exit' | 'split' | 'edge';

function flowsOf(def: RoadTypeDef, overrides: SegmentOverrides | undefined, offsets: readonly number[], inwardDir: 1 | -1): AnchorFlow[] {
  const lanes = effectiveLanes(def, overrides);
  const laneAt = (x: number) => lanes.find((l) => Math.abs(x - l.offset) < l.width / 2 - 0.01);
  return offsets.map((o, i) => {
    if (i === 0 || i === offsets.length - 1) return 'edge';
    const left = laneAt(o - 0.2);
    const right = laneAt(o + 0.2);
    const ins = [left, right].map((l) => (l ? (l.dir === inwardDir ? 1 : -1) : 0));
    if (ins[0] === 1 && ins[1] === 1) return 'enter';
    if (ins[0] === -1 && ins[1] === -1) return 'exit';
    if (ins[0] && ins[1]) return 'split';
    return ins[0] === 1 || ins[1] === 1 ? 'enter' : ins[0] === -1 || ins[1] === -1 ? 'exit' : 'edge';
  });
}

/** The anchor line of each arm of a node, or of each end of a segment. */
export function framesOf(net: RoadNetwork, hostArg: HostArg): ArmFrame[] {
  const host = hostOf(hostArg);
  if (host.kind === 'segment') return segmentFrames(net, host.id);
  const nodeId = host.id;
  const geom = net.nodeGeom(nodeId);
  if (!geom) return [];
  const points = net.pointsOf(host);
  const out: ArmFrame[] = [];
  for (const arm of geom.arms) {
    const seg = net.getSegment(arm.segmentId);
    const segGeom = net.segmentGeom(arm.segmentId);
    if (!seg || !segGeom || segGeom.stations.length < 2) continue;
    const setback = geom.kind === 'junction' ? 0 : Math.min(JOINT_SETBACK, segGeom.length * 0.4);
    const s = arm.atStart ? segGeom.trimA + setback : segGeom.fullLength - segGeom.trimB - setback;
    const st = stationAt(net.curveOf(arm.segmentId), s);
    const flip = arm.atStart ? -1 : 1;
    const inward = normalizeXZ({ x: st.tangent.x * flip, y: 0, z: st.tangent.z * flip });
    const def = net.roadTypeOf(arm.segmentId);
    const offsets = boundaryOffsets(def, seg.overrides);
    out.push({
      segmentId: arm.segmentId,
      pos: st.pos,
      right: st.right,
      inward,
      backDir: { x: -inward.x, y: 0, z: -inward.z },
      offsets,
      s,
      backSign: arm.atStart ? 1 : -1,
      seenSign: arm.atStart ? -1 : 1,
      // Lanes running towards the node: towards a when the arm leaves from a.
      flows: flowsOf(def, seg.overrides, offsets, arm.atStart ? -1 : 1),
      points,
    });
  }
  return out;
}

/** The anchor line of each arm of a node. */
export function armFrames(net: RoadNetwork, nodeId: Id): ArmFrame[] {
  return framesOf(net, nodeId);
}

/** A segment's two visible ends, cut lines facing each other along the road. */
export function segmentFrames(net: RoadNetwork, segmentId: Id): ArmFrame[] {
  const seg = net.getSegment(segmentId);
  const geom = net.segmentGeom(segmentId);
  if (!seg || !geom || geom.stations.length < 2) return [];
  const def = net.roadTypeOf(segmentId);
  const offsets = boundaryOffsets(def, seg.overrides);
  const points = net.pointsOf({ kind: 'segment', id: segmentId });
  const curve = net.curveOf(segmentId);
  const out: ArmFrame[] = [];
  for (const end of ['a', 'b'] as const) {
    const s = end === 'a' ? geom.trimA : geom.fullLength - geom.trimB;
    const st = stationAt(curve, s);
    const sign = end === 'a' ? 1 : -1;
    const inward = normalizeXZ({ x: st.tangent.x * sign, y: 0, z: st.tangent.z * sign });
    out.push({
      segmentId,
      end,
      pos: st.pos,
      right: st.right,
      inward,
      backDir: inward,
      offsets,
      s,
      backSign: sign,
      seenSign: 1,
      // Along a segment, entering means running a to b.
      flows: flowsOf(def, seg.overrides, offsets, 1),
      points,
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
  flow?: AnchorFlow;
  /** The point is turned off: kept for markings using it, not offered for new ones. */
  off?: boolean;
}

function settingFor(frame: ArmFrame, boundary: number): MarkingPointSetting | undefined {
  return frame.points.find((p) => p.segmentId === frame.segmentId && p.boundary === boundary && p.end === frame.end);
}

/** Metres along `right` a point's settings move it. */
export function pointShift(frame: ArmFrame, boundary: number): number {
  const set = settingFor(frame, boundary);
  if (!set) return 0;
  const place = set.place === 'left' ? -PLACE_SHIFT : set.place === 'right' ? PLACE_SHIFT : 0;
  return ((set.offset ?? 0) + place) * frame.seenSign;
}

function pointOn(frame: ArmFrame, boundary: number, back = 0): AnchorPoint | null {
  const raw = frame.offsets[boundary];
  if (raw === undefined) return null;
  const offset = raw + pointShift(frame, boundary);
  const bx = frame.backDir.x * back;
  const bz = frame.backDir.z * back;
  const anchor: MarkingAnchor = { segmentId: frame.segmentId, boundary };
  if (back) anchor.back = back;
  if (frame.end) anchor.end = frame.end;
  const out: AnchorPoint = {
    anchor,
    pos: { x: frame.pos.x + frame.right.x * offset + bx, y: frame.pos.y, z: frame.pos.z + frame.right.z * offset + bz },
    inward: frame.inward,
    edge: boundary === 0 || boundary === frame.offsets.length - 1,
    flow: frame.flows[boundary],
  };
  if (settingFor(frame, boundary)?.off) out.off = true;
  return out;
}

function frameFor(frames: readonly ArmFrame[], a: Pick<MarkingAnchor, 'segmentId' | 'end'>): ArmFrame | undefined {
  return frames.find((f) => f.segmentId === a.segmentId && f.end === a.end);
}

/** A row of anchors across an arm, a distance back from its cut line. */
export function armRow(net: RoadNetwork, hostArg: HostArg, segmentId: Id, back: number, end?: 'a' | 'b'): AnchorPoint[] {
  const host = hostOf(hostArg);
  const frame = frameFor(framesOf(net, host), { segmentId, end });
  if (!frame) return [];
  const length = net.segmentGeom(segmentId)?.length ?? 0;
  // Along a segment a row may go nearly to the far end; at a node, no further than the middle.
  const at = Math.max(0, Math.min(back, length * (host.kind === 'segment' ? 0.98 : 0.45)));
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
    const from = nearestIndex(poly, arm.kerbLeft ?? arm.leftEdge);
    const to = nearestIndex(poly, next.kerbRight ?? next.rightEdge);
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

/** The centreline of a segment between two arc lengths, in the order asked for. */
function centrelineBetween(net: RoadNetwork, segmentId: Id, s0: number, s1: number): Vec3[] {
  const curve = net.curveOf(segmentId);
  const lo = Math.min(s0, s1);
  const hi = Math.max(s0, s1);
  const n = clamp(Math.ceil((hi - lo) / 1.5), 2, 200);
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) out.push(stationAt(curve, lo + ((hi - lo) * i) / n).pos);
  return s0 <= s1 ? out : out.reverse();
}

/** Arc length of an anchor on a segment host's curve. */
function anchorS(frame: ArmFrame, back: number | undefined): number {
  return frame.s + frame.backSign * (back ?? 0);
}

/** A line along a segment between anchors at different distances, following the road's curve. */
export function segmentPath(net: RoadNetwork, segmentId: Id, a: MarkingAnchor, b: MarkingAnchor): Vec3[] | null {
  const frames = segmentFrames(net, segmentId);
  const fa = frameFor(frames, a);
  const fb = frameFor(frames, b);
  const p = resolveAnchor(net, { kind: 'segment', id: segmentId }, a);
  const q = resolveAnchor(net, { kind: 'segment', id: segmentId }, b);
  if (!fa || !fb || !p || !q) return null;
  const sa = anchorS(fa, a.back);
  const sb = anchorS(fb, b.back);
  if (Math.abs(sa - sb) < 0.5) return null;
  return alongGuide(centrelineBetween(net, segmentId, sa, sb), p.pos, q.pos);
}

/** Every anchor of a host's cut lines. Turned-off points are left out unless asked for. */
export function nodeAnchors(net: RoadNetwork, hostArg: HostArg, withOff = false): AnchorPoint[] {
  const out: AnchorPoint[] = [];
  for (const frame of framesOf(net, hostArg)) {
    for (let i = 0; i < frame.offsets.length; i++) {
      const p = pointOn(frame, i)!;
      if (withOff || !p.off) out.push(p);
    }
  }
  return out;
}

/** One anchor, or null when its arm, boundary or corner no longer exists. */
export function resolveAnchor(net: RoadNetwork, hostArg: HostArg, anchor: MarkingAnchor): AnchorPoint | null {
  const host = hostOf(hostArg);
  if (anchor.corner !== undefined) {
    if (host.kind !== 'node') return null;
    const chain = cornerChains(net, host.id).find((c) => c.segmentId === anchor.segmentId);
    const node = net.getNode(host.id);
    if (!chain || !node) return null;
    const pos = pointAlong(chain, anchor.corner);
    return { anchor, pos, inward: normalizeXZ({ x: node.pos.x - pos.x, y: 0, z: node.pos.z - pos.z }), edge: true, flow: 'edge' };
  }
  const frame = frameFor(framesOf(net, host), anchor);
  return frame ? pointOn(frame, anchor.boundary, anchor.back ?? 0) : null;
}

export function sameAnchor(a: MarkingAnchor, b: MarkingAnchor): boolean {
  return a.segmentId === b.segmentId && a.boundary === b.boundary && a.corner === b.corner && (a.back ?? 0) === (b.back ?? 0) && a.end === b.end;
}

/** Both anchors on one arm, or one end of a segment: a line across the road, not a turn. */
export function acrossOneArm(a: MarkingAnchor, b: MarkingAnchor): boolean {
  return a.segmentId === b.segmentId && a.end === b.end;
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
export function markingPath(net: RoadNetwork, hostArg: HostArg, m: Pick<NodeLineMarking, 'from' | 'to' | 'straight' | 'path'>): Vec3[] | null {
  const host = hostOf(hostArg);
  if (host.kind === 'segment') {
    if (!acrossOneArm(m.from, m.to)) {
      const along = segmentPath(net, host.id, m.from, m.to);
      if (along) return along;
    }
    const c = lineCurve(net, host, { ...m, straight: true });
    return c ? sampleCurve(c, 0.8) : null;
  }
  if (m.path === 'outline') return outlinePath(net, host.id, m.from, m.to);
  if (m.path === 'lanes') return lanePath(net, host.id, m.from, m.to);
  const c = lineCurve(net, host, m);
  return c ? sampleCurve(c, 0.8) : null;
}

/** The curve of a line marking. Null when an anchor is gone. */
export function lineCurve(net: RoadNetwork, hostArg: HostArg, m: Pick<NodeLineMarking, 'from' | 'to' | 'straight'>): Cubic | null {
  const p = resolveAnchor(net, hostArg, m.from);
  const q = resolveAnchor(net, hostArg, m.to);
  if (!p || !q || distXZ(p.pos, q.pos) < 0.05) return null;
  return anchorCurve(p, q, m.straight);
}

/**
 * The outline of a filler, in click order. Corners next to each other along a kerb
 * follow the kerb, and on a segment two corners at different distances follow the
 * road. Null when an anchor is gone.
 */
export function fillerPolygon(net: RoadNetwork, hostArg: HostArg, m: Pick<NodeFillerMarking, 'anchors'>): Vec3[] | null {
  const host = hostOf(hostArg);
  const pts: Vec3[] = [];
  for (const anchor of m.anchors) {
    const p = resolveAnchor(net, host, anchor);
    if (!p) return null;
    pts.push(p.pos);
  }
  if (pts.length < 3) return null;
  const out: Vec3[] = [];
  const n = m.anchors.length;
  for (let i = 0; i < n; i++) {
    const a = m.anchors[i];
    const b = m.anchors[(i + 1) % n];
    out.push(pts[i]);
    let edge: Vec3[] | null = null;
    if (host.kind === 'node') edge = a.corner !== undefined || b.corner !== undefined ? outlinePath(net, host.id, a, b) : null;
    else if (!acrossOneArm(a, b)) edge = segmentPath(net, host.id, a, b);
    if (edge && edge.length > 2) out.push(...edge.slice(1, -1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Where lines cross, and the parts of a line
// ---------------------------------------------------------------------------

/** Arc length along a polyline at each point. */
export function cumulative(pts: readonly Vec3[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return out;
}

/** The part of a polyline between two arc lengths. */
export function slicePolyline(pts: readonly Vec3[], s0: number, s1: number): Vec3[] {
  const cum = cumulative(pts);
  const total = cum[cum.length - 1];
  const lo = clamp(Math.min(s0, s1), 0, total);
  const hi = clamp(Math.max(s0, s1), 0, total);
  if (hi - lo < 1e-6) return [];
  const at = (s: number): Vec3 => {
    let k = 1;
    while (k < cum.length - 1 && cum[k] < s) k++;
    const span = cum[k] - cum[k - 1];
    const f = span > 1e-9 ? (s - cum[k - 1]) / span : 0;
    const a = pts[k - 1];
    const b = pts[k];
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
  };
  const out: Vec3[] = [at(lo)];
  for (let i = 0; i < pts.length; i++) if (cum[i] > lo + 1e-6 && cum[i] < hi - 1e-6) out.push(pts[i]);
  out.push(at(hi));
  return out;
}

/** Where two polylines first cross, as the arc length along the first. */
function firstCrossing(a: readonly Vec3[], b: readonly Vec3[]): { s: number; pos: Vec3 } | null {
  const cum = cumulative(a);
  for (let i = 0; i + 1 < a.length; i++) {
    const p = a[i];
    const r = { x: a[i + 1].x - p.x, z: a[i + 1].z - p.z };
    for (let j = 0; j + 1 < b.length; j++) {
      const q = b[j];
      const sv = { x: b[j + 1].x - q.x, z: b[j + 1].z - q.z };
      const den = r.x * sv.z - r.z * sv.x;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((q.x - p.x) * sv.z - (q.z - p.z) * sv.x) / den;
      const u = ((q.x - p.x) * r.z - (q.z - p.z) * r.x) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        return { s: cum[i] + t * (cum[i + 1] - cum[i]), pos: { x: p.x + r.x * t, y: p.y, z: p.z + r.z * t } };
      }
    }
  }
  return null;
}

export interface LineCrossing {
  markingId: Id;
  s: number;
  pos: Vec3;
}

/** Every other line of the host that crosses this one, in order along it. Ends that touch count. */
export function lineCrossings(net: RoadNetwork, hostArg: HostArg, m: NodeLineMarking, path = markingPath(net, hostArg, m)): LineCrossing[] {
  if (!path) return [];
  const out: LineCrossing[] = [];
  const total = cumulative(path).at(-1) ?? 0;
  for (const other of net.markingsOf(hostOf(hostArg))) {
    if (other.id === m.id || other.kind !== 'line') continue;
    const op = markingPath(net, hostArg, other);
    if (!op) continue;
    const hit = firstCrossing(path, op);
    if (hit && hit.s > 0.05 && hit.s < total - 0.05) out.push({ markingId: other.id, ...hit });
  }
  return out.sort((x, y) => x.s - y.s);
}

/** Arc length of a part bound along a line: its ends, or where it crosses a line. Null when that line is gone. */
export function boundAt(bound: import('./types').RuleBound, total: number, crossings: readonly LineCrossing[]): number | null {
  if ('end' in bound) return bound.end === 0 ? 0 : total;
  return crossings.find((c) => c.markingId === bound.cross)?.s ?? null;
}

export interface LineStretch {
  s0: number;
  s1: number;
  /** The rule painting it, or -1 for the line's own style. */
  rule: number;
}

/**
 * How a line is painted along its length: its own style, with each part's range
 * taken over by that part's style. Later parts win where they overlap. A part
 * whose crossing line has gone is left out.
 */
export function lineStretches(total: number, rules: readonly import('./types').LineRule[] | undefined, crossings: readonly LineCrossing[]): LineStretch[] {
  const cuts = new Set<number>([0, total]);
  const ranges: { s0: number; s1: number; rule: number }[] = [];
  (rules ?? []).forEach((r, i) => {
    const a = boundAt(r.from, total, crossings);
    const b = boundAt(r.to, total, crossings);
    if (a === null || b === null || Math.abs(a - b) < 1e-3) return;
    ranges.push({ s0: Math.min(a, b), s1: Math.max(a, b), rule: i });
    cuts.add(Math.min(a, b));
    cuts.add(Math.max(a, b));
  });
  const sorted = [...cuts].sort((x, y) => x - y);
  const out: LineStretch[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const s0 = sorted[i];
    const s1 = sorted[i + 1];
    if (s1 - s0 < 1e-3) continue;
    const mid = (s0 + s1) / 2;
    let rule = -1;
    for (const r of ranges) if (mid >= r.s0 && mid <= r.s1) rule = r.rule;
    const last = out[out.length - 1];
    if (last && last.rule === rule) last.s1 = s1;
    else out.push({ s0, s1, rule });
  }
  return out;
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

