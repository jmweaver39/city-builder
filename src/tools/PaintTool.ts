/**
 * Paint. Nothing is placed freely: every line, area and stamp sits on a road and
 * stores where on the road it is, so it follows the road from then on.
 *
 * A line takes two clicks: where it starts, across the road and along it, and how
 * far it runs. It follows the road's own curve at the chosen offset, through joints.
 * An area takes two clicks too, on its two sides. A stamp takes one, on a lane.
 */
import type { NetworkChange } from '../core/RoadNetwork';
import { pathPoints, roadPathBetween } from '../core/roadPaint';
import type { DecalKind, LineStyle, RoadPaintPiece, Vec3 } from '../core/types';
import type { ToolMark } from '../render/api';
import { lateralStops, nearestStop, roadCursor, stopPosition, stopRow, type LateralStop, type RoadCursor, type StopKind } from './roadAnchors';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolPointer } from './types';

export const LINE_STYLES: readonly { style: LineStyle; name: string }[] = [
  { style: 'solid', name: 'Solid line' },
  { style: 'dashed', name: 'Dashed line' },
  { style: 'dotted', name: 'Dotted line' },
  { style: 'double', name: 'Double line' },
  { style: 'solidDashed', name: 'Solid and dashed' },
  { style: 'dashedSolid', name: 'Dashed and solid' },
];

export const LINE_DECALS: readonly DecalKind[] = ['line', 'dashedLine', 'doubleLine'];
export const AREA_DECALS: readonly DecalKind[] = ['hatch', 'fill'];
export const STAMP_DECALS: readonly DecalKind[] = [
  'crosswalk',
  'stopLine',
  'yieldTriangles',
  'arrowStraight',
  'arrowLeft',
  'arrowRight',
  'arrowStraightLeft',
  'arrowStraightRight',
  'text',
];

/** Stamps laid across a lane rather than along it. */
const ACROSS_LANE: readonly DecalKind[] = ['stopLine', 'yieldTriangles'];

/**
 * A sensible width for each kind, set when a kind is picked. Width means something
 * different per kind: line thickness, crosswalk depth, tooth size, stamp scale
 * where 1 is a 5 m arrow, or text height.
 */
export function defaultDecalWidth(kind: DecalKind): number {
  if (LINE_DECALS.includes(kind)) return 0.2;
  if (AREA_DECALS.includes(kind)) return 0.4;
  switch (kind) {
    case 'crosswalk':
      return 3;
    case 'stopLine':
      return 0.5;
    case 'yieldTriangles':
      return 0.8;
    case 'text':
      return 2;
    default:
      return 1;
  }
}

const STOP_COLOR: Record<StopKind, string> = { edge: COLORS.snap, boundary: COLORS.neutral, centre: COLORS.warn };
const MIN_RUN = 0.5;

interface Start {
  segmentId: number;
  t: number;
  /** Right of a-to-b. */
  offset: number;
  stop: LateralStop;
}

interface Draft {
  pieces: RoadPaintPiece[];
  /** Right of the walking direction. */
  offset: number;
  offset2?: number;
  points: Vec3[];
}

export class PaintTool extends Tool {
  readonly id: ToolId = 'paint';
  private start: Start | null = null;
  private cursor: RoadCursor | null = null;
  private stop: LateralStop | null = null;
  private draft: Draft | null = null;
  private reason: string | null = null;

  get startPoint(): Start | null {
    return this.start;
  }

  private get kind(): DecalKind {
    return this.ctx.settings.paint.kind;
  }

  private get isLine(): boolean {
    return LINE_DECALS.includes(this.kind);
  }

  private get isArea(): boolean {
    return AREA_DECALS.includes(this.kind);
  }

  private get isStamp(): boolean {
    return !this.isLine && !this.isArea;
  }

  /** Stops a stamp may use: lanes, not the lines between them. */
  private stopsFor(segmentId: number): LateralStop[] {
    const stops = lateralStops(this.ctx.net, segmentId);
    return this.isStamp ? stops.filter((s) => s.kind === 'centre') : stops;
  }

  private update(e: ToolPointer): void {
    const { net } = this.ctx;
    this.cursor = roadCursor(this.ctx, e, !this.isStamp);
    this.stop = this.cursor ? nearestStop(this.stopsFor(this.cursor.segmentId), this.cursor.lateral) : null;
    this.draft = null;
    this.reason = null;
    const cursor = this.cursor;
    if (!this.start || !cursor) return;
    const pieces = roadPathBetween(net, this.start, { segmentId: cursor.segmentId, t: cursor.t });
    if (!pieces) {
      this.reason = 'That is not further along this road.';
      return;
    }
    const first = pieces[0];
    const last = pieces[pieces.length - 1];
    const offset = first.t0 <= first.t1 ? this.start.offset : -this.start.offset;
    let offset2: number | undefined;
    if (this.isArea) {
      const far = this.stop?.offset ?? cursor.lateral;
      offset2 = last.t0 <= last.t1 ? far : -far;
      if (Math.abs(offset2 - offset) < 0.1) {
        this.reason = 'Pick a different line across the road for the far side.';
        return;
      }
    }
    const line = pathPoints(net, pieces, offset);
    let run = 0;
    for (let i = 1; i < line.length; i++) run += Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z);
    if (run < MIN_RUN) {
      this.reason = 'Pick a point further along the road.';
      return;
    }
    const points = offset2 === undefined ? line : [...line, ...pathPoints(net, pieces, offset2).reverse()];
    this.draft = { pieces, offset, offset2, points };
  }

  private rows(): ToolMark[] {
    const { net } = this.ctx;
    const cursor = this.cursor;
    if (!cursor) return [];
    const marks: ToolMark[] = [];
    const row = (t: number) => {
      for (const { pos, stop } of stopRow(net, cursor.segmentId, t)) {
        if (this.isStamp && stop.kind !== 'centre') continue;
        marks.push({ kind: 'point', pos, color: STOP_COLOR[stop.kind], radius: stop.kind === 'centre' ? 0.35 : 0.45 });
      }
    };
    if (!this.isStamp) {
      row(0);
      row(1);
    }
    row(cursor.t);
    return marks;
  }

  private show(e: ToolPointer | null): void {
    const { net, settings } = this.ctx;
    const marks = this.rows();
    const cursor = this.cursor;
    if (this.start) {
      marks.push({ kind: 'ring', pos: stopPosition(net, this.start.segmentId, this.start.t, this.start.offset), color: COLORS.ok, radius: 1 });
    }
    if (cursor && this.stop) {
      const at = this.start && this.isLine ? null : stopPosition(net, cursor.segmentId, cursor.t, this.stop.offset);
      if (at) marks.push({ kind: 'ring', pos: at, color: COLORS.snap, radius: 1 });
    }
    if (this.draft) {
      const line = this.isArea ? [...this.draft.points, this.draft.points[0]] : this.draft.points;
      marks.push({ kind: 'line', points: line, color: settings.paint.color, width: Math.max(0.3, settings.paint.width), dashed: settings.paint.lineStyle === 'dashed' });
    }
    this.ctx.setMarks(marks);
    if (!e) return;
    const name = this.isLine ? (LINE_STYLES.find((l) => l.style === settings.paint.lineStyle)?.name ?? 'Line') : this.kind;
    const lines = [`Paint ${name}`, `${settings.paint.color}, ${settings.paint.width.toFixed(2)} m`];
    const notes: string[] = [];
    if (!cursor) notes.push('Move over a road');
    else if (this.reason) notes.push(this.reason);
    else if (this.isStamp) notes.push('Click to place on this lane');
    else if (!this.start) notes.push(cursor.atEnd ? 'Click to start at the junction edge' : 'Click to start here');
    else notes.push(cursor.atEnd ? 'Click to finish at the junction edge' : 'Click to finish here');
    this.ctx.setHud({ x: e.x, y: e.y, lines, notes, tone: this.reason ? 'warning' : 'ok' });
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    this.update(e);
    this.show(e);
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    this.update(e);
    const cursor = this.cursor;
    const stop = this.stop;
    if (!cursor || !stop) {
      this.ctx.toast('Paint goes on a road.', 'warning');
      return;
    }
    if (this.isStamp) {
      this.placeStamp(cursor, stop);
    } else if (!this.start) {
      this.start = { segmentId: cursor.segmentId, t: cursor.t, offset: stop.offset, stop };
    } else if (this.draft) {
      this.placePath(this.draft);
    } else if (this.reason) {
      this.ctx.toast(this.reason, 'warning');
    }
    this.update(e);
    this.show(e);
    this.ctx.changed();
  }

  private placePath(draft: Draft): void {
    const { paint } = this.ctx.settings;
    this.ctx.history.hint('Paint');
    this.ctx.net.addDecal({
      kind: this.kind,
      points: [],
      road: { pieces: draft.pieces, offset: draft.offset, ...(draft.offset2 === undefined ? {} : { offset2: draft.offset2 }) },
      ...(this.isLine ? { lineStyle: paint.lineStyle } : {}),
      color: paint.color,
      width: paint.width,
      rotation: 0,
    });
    this.start = null;
  }

  private placeStamp(cursor: RoadCursor, lane: LateralStop): void {
    const { net, settings } = this.ctx;
    const { paint } = settings;
    if (this.kind === 'text' && !paint.text.trim()) {
      this.ctx.toast('Type some text first.', 'warning');
      return;
    }
    const def = net.roadTypeOf(cursor.segmentId);
    const piece = { segmentId: cursor.segmentId, t0: cursor.t, t1: cursor.t };
    const half = (lane.width ?? 3) / 2;
    let offset = lane.offset;
    let offset2: number | undefined;
    if (this.kind === 'crosswalk') {
      offset = -def.halfWidth;
      offset2 = def.halfWidth;
    } else if (ACROSS_LANE.includes(this.kind)) {
      offset = lane.offset - half;
      offset2 = lane.offset + half;
    }
    this.ctx.history.hint('Paint');
    net.addDecal({
      kind: this.kind,
      points: [],
      road: { pieces: [piece], offset, ...(offset2 === undefined ? {} : { offset2 }), dir: lane.dir ?? 1 },
      color: paint.color,
      width: paint.width,
      rotation: 0,
      ...(this.kind === 'text' ? { text: paint.text } : {}),
    });
  }

  back(): boolean {
    if (!this.start) return false;
    this.start = null;
    if (this.pointer) this.update(this.pointer);
    this.show(this.pointer);
    this.ctx.changed();
    return true;
  }

  settingsChanged(): void {
    if (this.isStamp) this.start = null;
    if (this.pointer) this.update(this.pointer);
    this.show(this.pointer);
  }

  networkChanged(change: NetworkChange): void {
    if (this.start && !this.ctx.net.getSegment(this.start.segmentId)) this.start = null;
    if (change.reset) this.start = null;
    this.cursor = null;
    this.draft = null;
  }

  deactivate(): void {
    this.start = null;
    this.cursor = null;
    this.stop = null;
    this.draft = null;
  }
}
