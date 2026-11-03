/**
 * Paint that follows a road. A decal with a `road` reference stores pieces of
 * segments and a lateral offset, and every world position is derived from the live
 * curves, so paint moves with its road. resolveDecal is the one way to read it.
 */
import { cubicTangentXZ, offsetPoint } from './bezier';
import { clamp, dotXZ, scale } from './math';
import { alongGuide, connectorGuide } from './nodeMarkings';
import type { RoadNetwork } from './RoadNetwork';
import type { Decal, Id, RoadPaintPiece, RoadPaintRef, Vec3 } from './types';

/** Sample spacing along a road. Fine enough to follow the tightest legal curve. */
const SPACING = 1.5;
const MAX_SAMPLES = 240;
/** Roads this close to dead ahead carry on through a junction. */
const THROUGH_COS = Math.cos((35 * Math.PI) / 180);

/** Parameters of the visible span of a segment, between junction cuts. */
export function visibleSpan(net: RoadNetwork, segmentId: Id): { lo: number; hi: number } | null {
  const st = net.segmentGeom(segmentId)?.stations;
  if (!st || st.length < 2) return null;
  return { lo: st[0].t, hi: st[st.length - 1].t };
}

/** Points along one piece at a lateral offset measured right of the walking direction. */
export function piecePoints(net: RoadNetwork, piece: RoadPaintPiece, lateral: number): Vec3[] {
  const span = visibleSpan(net, piece.segmentId);
  if (!span) return [];
  const forward = piece.t0 <= piece.t1;
  const lo = Math.max(Math.min(piece.t0, piece.t1), span.lo);
  const hi = Math.min(Math.max(piece.t0, piece.t1), span.hi);
  if (!(hi > lo)) return [];
  const c = net.cubicOf(piece.segmentId);
  const length = (net.segmentGeom(piece.segmentId)?.fullLength ?? 0) * (hi - lo);
  const n = clamp(Math.ceil(length / SPACING), 2, MAX_SAMPLES);
  const offset = forward ? lateral : -lateral;
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) out.push(offsetPoint(c, lo + ((hi - lo) * i) / n, offset));
  return forward ? out : out.reverse();
}

/** The node two consecutive pieces of a path meet at. */
function sharedNode(net: RoadNetwork, a: RoadPaintPiece, b: RoadPaintPiece): Id | null {
  const sa = net.getSegment(a.segmentId);
  const sb = net.getSegment(b.segmentId);
  if (!sa || !sb) return null;
  const leaving = a.t0 <= a.t1 ? sa.b : sa.a;
  return leaving === sb.a || leaving === sb.b ? leaving : null;
}

/**
 * A line along every piece at one lateral offset. Where it passes through a
 * junction it follows the lane path there, not a straight bridge.
 */
export function pathPoints(net: RoadNetwork, pieces: readonly RoadPaintPiece[], lateral: number): Vec3[] {
  const out: Vec3[] = [];
  pieces.forEach((piece, i) => {
    const pts = piecePoints(net, piece, lateral);
    const last = out[out.length - 1];
    const first = pts[0];
    if (last && first) {
      const gap = Math.hypot(last.x - first.x, last.z - first.z);
      const node = gap > 0.5 ? sharedNode(net, pieces[i - 1], piece) : null;
      const guide = node === null ? null : connectorGuide(net, node, last, first, pieces[i - 1].segmentId, piece.segmentId);
      if (guide) out.push(...alongGuide(guide, last, first).slice(1, -1));
    }
    // Pieces meeting at a plain joint share a point.
    const joined = last && first && Math.hypot(last.x - first.x, last.z - first.z) < 0.01;
    out.push(...(joined ? pts.slice(1) : pts));
  });
  return out;
}

const STAMP_KINDS = new Set<Decal['kind']>([
  'crosswalk',
  'stopLine',
  'yieldTriangles',
  'arrowStraight',
  'arrowLeft',
  'arrowRight',
  'arrowStraightLeft',
  'arrowStraightRight',
  'text',
]);

/** Rotation about +Y that faces `dir`. A stamp at rotation 0 faces -Z, like vehicle yaw. */
export function rotationFacing(dir: Vec3): number {
  return Math.atan2(-dir.x, -dir.z);
}

function resolveStamp(net: RoadNetwork, d: Decal, ref: RoadPaintRef): Decal {
  const piece = ref.pieces[0];
  const span = piece && visibleSpan(net, piece.segmentId);
  if (!span) return { ...d, points: [] };
  const t = clamp(piece.t0, span.lo, span.hi);
  const c = net.cubicOf(piece.segmentId);
  const facing = scale(cubicTangentXZ(c, t), ref.dir ?? 1);
  const points = [offsetPoint(c, t, ref.offset)];
  if (ref.offset2 !== undefined) points.push(offsetPoint(c, t, ref.offset2));
  return { ...d, points, rotation: rotationFacing(facing) };
}

/**
 * A decal with its world points filled in, ready to draw or pick. A decal with no
 * road reference, as in an older save, comes back unchanged.
 */
export function resolveDecal(net: RoadNetwork, d: Decal): Decal {
  const ref = d.road;
  if (!ref) return d;
  if (STAMP_KINDS.has(d.kind)) return resolveStamp(net, d, ref);
  const line = pathPoints(net, ref.pieces, ref.offset);
  if (ref.offset2 === undefined) return { ...d, points: line };
  return { ...d, points: [...line, ...pathPoints(net, ref.pieces, ref.offset2).reverse()] };
}

function awayFrom(net: RoadNetwork, segId: Id, nodeId: Id): Vec3 {
  const seg = net.getSegment(segId)!;
  const c = net.cubicOf(segId);
  return seg.a === nodeId ? cubicTangentXZ(c, 0) : scale(cubicTangentXZ(c, 1), -1);
}

/** The road carrying on from a segment past a node, or null where it ends or forks. */
export function nextAlongRoad(net: RoadNetwork, segId: Id, nodeId: Id): Id | null {
  const node = net.getNode(nodeId);
  if (!node) return null;
  if (node.segments.length === 2) return node.segments[0] === segId ? node.segments[1] : node.segments[0];
  const type = net.getSegment(segId)!.roadType;
  const heading = awayFrom(net, segId, nodeId);
  let best: Id | null = null;
  let bestCos = THROUGH_COS;
  for (const other of node.segments) {
    if (other === segId || net.getSegment(other)!.roadType !== type) continue;
    const cos = -dotXZ(heading, awayFrom(net, other, nodeId));
    if (cos > bestCos) {
      bestCos = cos;
      best = other;
    }
  }
  return best;
}

export interface RoadSpot {
  segmentId: Id;
  t: number;
}

/**
 * The pieces walking along the road from one spot to another, through plain joints
 * and straight on through junctions. Null when they are not on the same road.
 */
export function roadPathBetween(net: RoadNetwork, a: RoadSpot, b: RoadSpot): RoadPaintPiece[] | null {
  if (a.segmentId === b.segmentId) return [{ segmentId: a.segmentId, t0: a.t, t1: b.t }];
  for (const exitAtB of [true, false]) {
    const pieces: RoadPaintPiece[] = [];
    const seen = new Set<Id>([a.segmentId]);
    let cur = a.segmentId;
    let leavingB = exitAtB;
    let entry = a.t;
    for (;;) {
      const seg = net.getSegment(cur);
      if (!seg) break;
      pieces.push({ segmentId: cur, t0: entry, t1: leavingB ? 1 : 0 });
      const nodeId = leavingB ? seg.b : seg.a;
      const next = nextAlongRoad(net, cur, nodeId);
      if (next === null || seen.has(next)) break;
      seen.add(next);
      const other = net.getSegment(next)!;
      const enteringAtA = other.a === nodeId;
      if (next === b.segmentId) {
        pieces.push({ segmentId: next, t0: enteringAtA ? 0 : 1, t1: b.t });
        return pieces;
      }
      cur = next;
      entry = enteringAtA ? 0 : 1;
      leavingB = enteringAtA;
    }
  }
  return null;
}

/** Split pieces when a segment is cut at parameter ts. The new id takes the b side. */
export function splitPaintPieces(pieces: readonly RoadPaintPiece[], id: Id, ts: number, rightId: Id): RoadPaintPiece[] {
  const left = (t: number) => clamp(t / ts, 0, 1);
  const right = (t: number) => clamp((t - ts) / (1 - ts), 0, 1);
  const out: RoadPaintPiece[] = [];
  for (const p of pieces) {
    if (p.segmentId !== id) {
      out.push(p);
      continue;
    }
    const lo = Math.min(p.t0, p.t1);
    const hi = Math.max(p.t0, p.t1);
    if (hi <= ts) out.push({ segmentId: id, t0: left(p.t0), t1: left(p.t1) });
    else if (lo >= ts) out.push({ segmentId: rightId, t0: right(p.t0), t1: right(p.t1) });
    else if (p.t0 < p.t1) {
      out.push({ segmentId: id, t0: left(p.t0), t1: 1 }, { segmentId: rightId, t0: 0, t1: right(p.t1) });
    } else {
      out.push({ segmentId: rightId, t0: right(p.t0), t1: 0 }, { segmentId: id, t0: 1, t1: left(p.t1) });
    }
  }
  return out;
}

/** The stretches left when a segment is deleted, each still in walking order. */
export function piecesWithout(pieces: readonly RoadPaintPiece[], id: Id): RoadPaintPiece[][] {
  const runs: RoadPaintPiece[][] = [];
  let run: RoadPaintPiece[] = [];
  for (const p of pieces) {
    if (p.segmentId === id) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push(p);
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

/** Whether a line along the pieces is one point long, as a stamp's is. */
export function isStampRef(ref: RoadPaintRef): boolean {
  return ref.pieces.length === 1 && ref.pieces[0].t0 === ref.pieces[0].t1;
}

export function paintSegments(ref: RoadPaintRef): Id[] {
  return ref.pieces.map((p) => p.segmentId);
}

