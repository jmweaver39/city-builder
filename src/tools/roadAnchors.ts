/**
 * Snap points for paint. Everything painted sits on a road: at an edge, a lane
 * boundary or a lane centre, at the junction edges or anywhere along the road.
 */
import { offsetPoint } from '../core/bezier';
import { boundaryOffsets } from '../core/nodeMarkings';
import type { RoadNetwork } from '../core/RoadNetwork';
import { visibleSpan } from '../core/roadPaint';
import { effectiveLanes } from '../core/roadTypes';
import { autoLinesOf, SNAP_TOL } from '../core/paintCoherence';
import type { AutoLineRole } from '../core/paintStandard';
import type { Id, Vec3 } from '../core/types';
import { pickNodeHit, pickRoad } from './pick';
import type { ToolContext, ToolPointer } from './types';

/** Inside this far of a road's end, along the road, a click means the end itself. */
export const END_CATCH = 12;

/** 'line' is where the road paints a line of its own (lane, centre or edge line): hand-drawn lines snap there. */
export type StopKind = 'edge' | 'boundary' | 'centre' | 'line';

/** A place across a road. Offset is right of a-to-b. */
export interface LateralStop {
  offset: number;
  kind: StopKind;
  /** Centres only. */
  lane?: number;
  width?: number;
  dir?: 1 | -1;
  /** Lines only: which automatic line sits here. */
  role?: AutoLineRole;
}

/** Every stop across a road, left to right. */
export function lateralStops(net: RoadNetwork, segmentId: Id): LateralStop[] {
  const seg = net.getSegment(segmentId);
  if (!seg) return [];
  const def = net.roadType(seg.roadType);
  if (!def) return [];
  const edges = boundaryOffsets(def, seg.overrides);
  const stops: LateralStop[] = edges.map((offset, i) => ({
    offset,
    kind: i === 0 || i === edges.length - 1 ? 'edge' : 'boundary',
  }));
  // Where the road paints its own lines, a hand-drawn line goes exactly there, so the
  // two meet seamlessly: those positions take the place of a boundary next to them.
  for (const l of autoLinesOf(net, segmentId)) {
    for (let i = stops.length - 1; i >= 0; i--) if (stops[i].kind === 'boundary' && Math.abs(stops[i].offset - l.offset) < SNAP_TOL) stops.splice(i, 1);
    if (!stops.some((s) => s.kind === 'line' && Math.abs(s.offset - l.offset) < 0.01)) stops.push({ offset: l.offset, kind: 'line', role: l.role });
  }
  effectiveLanes(def, seg.overrides).forEach((l, lane) => {
    stops.push({ offset: l.offset, kind: 'centre', lane, width: l.width, dir: l.dir });
  });
  return stops.sort((a, b) => a.offset - b.offset);
}

export function nearestStop(stops: readonly LateralStop[], lateral: number): LateralStop | null {
  let best: LateralStop | null = null;
  for (const s of stops) if (!best || Math.abs(s.offset - lateral) < Math.abs(best.offset - lateral)) best = s;
  return best;
}

export interface RoadCursor {
  segmentId: Id;
  /** 0 and 1 mean the junction edges. */
  t: number;
  /** Right of a-to-b. */
  lateral: number;
  /** True when the cursor caught one of the road's ends. */
  atEnd: boolean;
  /** Set when the pointer is over a junction or transition surface: the cursor is on the nearest arm's cut. */
  nodeId?: Id;
}

/** Keep t on the visible road, catching its ends. */
export function snapAlong(net: RoadNetwork, segmentId: Id, t: number, catchEnds = true): { t: number; atEnd: boolean } {
  const span = visibleSpan(net, segmentId);
  if (!span) return { t, atEnd: false };
  const length = net.segmentGeom(segmentId)?.fullLength ?? 0;
  if (catchEnds) {
    if ((t - span.lo) * length < END_CATCH) return { t: 0, atEnd: true };
    if ((span.hi - t) * length < END_CATCH) return { t: 1, atEnd: true };
  }
  const margin = Math.min(2 / Math.max(length, 1), (span.hi - span.lo) / 2);
  const held = Math.min(Math.max(t, span.lo + margin), span.hi - margin);
  // A coarse grid, so turning a road twice gives back exactly what was placed.
  return { t: Math.round(held * 1e6) / 1e6, atEnd: false };
}

/**
 * The road position under the pointer, or null off the road. Over a junction or
 * transition surface it is the cut line of the arm nearest the pointer, so paint
 * can start or end at either side of it.
 */
export function roadCursor(ctx: ToolContext, e: Pick<ToolPointer, 'x' | 'y'>, catchEnds = true): RoadCursor | null {
  const hit = pickRoad(ctx, e, 2);
  if (!hit) {
    const node = pickNodeHit(ctx, e);
    return node ? junctionCursor(ctx.net, node.id, node.point) : null;
  }
  const along = snapAlong(ctx.net, hit.segmentId, hit.t, catchEnds);
  return { segmentId: hit.segmentId, t: along.t, lateral: hit.lateral, atEnd: along.atEnd };
}

/** The arm cut of a junction nearest a point on its surface, as a road cursor. */
export function junctionCursor(net: RoadNetwork, nodeId: Id, p: Vec3): RoadCursor | null {
  const g = net.nodeGeom(nodeId);
  if (!g || !g.arms.length) return null;
  let best: { arm: (typeof g.arms)[number]; d: number } | null = null;
  for (const arm of g.arms) {
    const a = arm.leftEdge;
    const b = arm.rightEdge;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
    const d = Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
    if (!best || d < best.d) best = { arm, d };
  }
  if (!best) return null;
  const segmentId = best.arm.segmentId;
  const st = net.segmentGeom(segmentId)?.stations;
  if (!st || st.length < 2) return null;
  const cut = best.arm.atStart ? st[0] : st[st.length - 1];
  const lateral = (p.x - cut.pos.x) * cut.right.x + (p.z - cut.pos.z) * cut.right.z;
  return { segmentId, t: best.arm.atStart ? 0 : 1, lateral, atEnd: true, nodeId };
}

/** The world position of a stop at a place along a road. A t of 0 or 1 is the visible end. */
export function stopPosition(net: RoadNetwork, segmentId: Id, t: number, offset: number): Vec3 {
  const span = visibleSpan(net, segmentId);
  const at = span ? Math.min(Math.max(t, span.lo), span.hi) : t;
  return offsetPoint(net.cubicOf(segmentId), at, offset);
}

/** A row of anchor positions across a road at one place. */
export function stopRow(net: RoadNetwork, segmentId: Id, t: number): { pos: Vec3; stop: LateralStop }[] {
  return lateralStops(net, segmentId).map((stop) => ({ stop, pos: stopPosition(net, segmentId, t, stop.offset) }));
}

