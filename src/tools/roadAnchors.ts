/**
 * Snap points for paint. Everything painted sits on a road: at an edge, a lane
 * boundary or a lane centre, at the junction edges or anywhere along the road.
 */
import { offsetPoint } from '../core/bezier';
import { boundaryOffsets } from '../core/nodeMarkings';
import type { RoadNetwork } from '../core/RoadNetwork';
import { visibleSpan } from '../core/roadPaint';
import { effectiveLanes } from '../core/roadTypes';
import type { Id, Vec3 } from '../core/types';
import { pickRoad } from './pick';
import type { ToolContext, ToolPointer } from './types';

/** Inside this far of a road's end, along the road, a click means the end itself. */
export const END_CATCH = 12;

export type StopKind = 'edge' | 'boundary' | 'centre';

/** A place across a road. Offset is right of a-to-b. */
export interface LateralStop {
  offset: number;
  kind: StopKind;
  /** Centres only. */
  lane?: number;
  width?: number;
  dir?: 1 | -1;
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

/** The road position under the pointer, or null off the road. */
export function roadCursor(ctx: ToolContext, e: Pick<ToolPointer, 'x' | 'y'>, catchEnds = true): RoadCursor | null {
  const hit = pickRoad(ctx, e, 2);
  if (!hit) return null;
  const along = snapAlong(ctx.net, hit.segmentId, hit.t, catchEnds);
  return { segmentId: hit.segmentId, t: along.t, lateral: hit.lateral, atEnd: along.atEnd };
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

