/**
 * Paint. Nothing is placed freely: every line, area and stamp sits on a road and
 * stores where on the road it is, so it follows the road from then on.
 *
 * A line takes two clicks: where it starts, across the road and along it, and how
 * far it runs. It follows the road's own curve at the chosen offset, through joints.
 * An area takes two clicks too, on its two sides. A stamp takes one, on a lane.
 */
import type { NetworkChange } from '../core/RoadNetwork';
import { pathPoints, roadPathBetween, straightPathBetween } from '../core/roadPaint';
import type { Decal, DecalKind, LineStyle, LineStyleSpec, RoadPaintPiece, Vec3 } from '../core/types';
import { FILL_STANDARDS, LINE_STANDARDS, lineStandard, matchStandard, type LineStandardId } from '../core/paintStandard';
import { stackedWith } from '../core/paintCoherence';
import type { DecalInit } from '../core/RoadNetwork';
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
  const look = standardLook(kind);
  if (look) return look.width;
  if (AREA_DECALS.includes(kind)) return FILL_STANDARDS[0].spec.width;
  return kind === 'text' ? 2 : 1;
}

const STOP_COLOR: Record<StopKind, string> = { edge: COLORS.snap, boundary: COLORS.neutral, centre: COLORS.warn, line: COLORS.ok };

/** The line standards offered as Paint cards, in order. */
export const PAINT_LINE_STANDARDS: readonly LineStandardId[] = ['lane', 'laneSolid', 'edge', 'centre', 'centreDouble', 'dotted'];

/** The standard look a kind is placed with when none was picked. */
function standardLook(kind: DecalKind): LineStyleSpec | null {
  switch (kind) {
    case 'line':
    case 'dashedLine':
    case 'doubleLine':
      return lineStandard('lane').spec;
    case 'crosswalk':
      return lineStandard('zebra').spec;
    case 'stopLine':
      return lineStandard('stop').spec;
    case 'yieldTriangles':
      return lineStandard('giveWay').spec;
    default:
      return null;
  }
}

/** Which family of look a kind takes. */
function lookFamily(kind: DecalKind): 'line' | 'crosswalk' | 'stop' | 'teeth' | null {
  if (LINE_DECALS.includes(kind)) return 'line';
  if (kind === 'crosswalk') return 'crosswalk';
  if (kind === 'stopLine') return 'stop';
  if (kind === 'yieldTriangles') return 'teeth';
  return null;
}

const FAMILY_STYLES: Record<'line' | 'crosswalk' | 'stop' | 'teeth', (s: LineStyleSpec['style']) => boolean> = {
  line: (s) => ['solid', 'dashed', 'double', 'doubleDashed', 'solidDashed', 'dashedSolid', 'dotted', 'zigzag'].includes(s),
  crosswalk: (s) => s.startsWith('crosswalk'),
  stop: (s) => s === 'stopLine',
  teeth: (s) => s === 'sharkTeeth',
};

/**
 * The look a decal of this kind is placed with: the picked look when it suits the
 * kind, else the kind's standard, with the panel's colour and width written in.
 */
export function paintLook(settings: { kind: DecalKind; color: Decal['color']; width: number; look?: LineStyleSpec }): LineStyleSpec | null {
  const fam = lookFamily(settings.kind);
  if (!fam) return null;
  const base = settings.look && FAMILY_STYLES[fam](settings.look.style) ? settings.look : standardLook(settings.kind);
  if (!base) return null;
  return { ...base, color: settings.color, width: settings.width > 0 ? settings.width : base.width };
}

/** A name for what is being painted: the standard's, or the kind's. */
export function paintName(settings: { kind: DecalKind; color: Decal['color']; width: number; look?: LineStyleSpec }): string {
  const look = paintLook(settings);
  const std = look ? matchStandard(look) : null;
  if (std) return std.name;
  if (settings.kind === 'hatch') return FILL_STANDARDS[0].name;
  const stampNames: Partial<Record<DecalKind, string>> = {
    arrowStraight: 'Arrow ahead',
    arrowLeft: 'Arrow left',
    arrowRight: 'Arrow right',
    arrowStraightLeft: 'Arrow ahead or left',
    arrowStraightRight: 'Arrow ahead or right',
    text: 'Text',
    fill: 'Solid fill',
  };
  if (stampNames[settings.kind]) return stampNames[settings.kind]!;
  if (look) return `${LINE_STANDARDS.find((s) => s.spec.style === look.style)?.name ?? 'Line'} (own look)`;
  return settings.kind;
}
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
  /** Lines: the offset at the far end, when it is not the start's. */
  offsetEnd?: number;
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
    // A line ends on the stop picked there, which may be another lane or another road.
    let offsetEnd: number | undefined;
    // Along one road the line keeps its lane; turning onto another arm it lands on the stop picked there.
    if (this.isLine && !straightPathBetween(net, this.start, { segmentId: cursor.segmentId, t: cursor.t })) {
      const far = this.stop?.offset ?? cursor.lateral;
      const end = last.t0 <= last.t1 ? far : -far;
      if (Math.abs(end - offset) > 0.05) offsetEnd = end;
    }
    // Across a junction or transition into a road of another type, the line keeps its
    // place on each road: the start's stop on the first, the stop picked on the last.
    if (this.isLine && offsetEnd === undefined && pieces.length > 1) {
      const t0 = net.getSegment(first.segmentId)?.roadType;
      if (pieces.some((p) => net.getSegment(p.segmentId)?.roadType !== t0)) {
        const far = this.stop?.offset ?? cursor.lateral;
        const end = last.t0 <= last.t1 ? far : -far;
        for (const p of pieces) if (net.getSegment(p.segmentId)?.roadType !== t0) p.offset = end;
        pieces[0].offset = offset;
      }
    }
    const line = pathPoints(net, pieces, offset, offsetEnd ?? offset);
    let run = 0;
    for (let i = 1; i < line.length; i++) run += Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z);
    if (run < MIN_RUN) {
      this.reason = 'Pick a point further along the road.';
      return;
    }
    const points = offset2 === undefined ? line : [...line, ...pathPoints(net, pieces, offset2).reverse()];
    this.draft = { pieces, offset, offset2, offsetEnd, points };
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
    // Over a junction or transition: the stops on every arm's cut, both sides of it.
    if (cursor.nodeId !== undefined && !this.isStamp) {
      for (const arm of net.nodeGeom(cursor.nodeId)?.arms ?? []) {
        if (arm.segmentId === cursor.segmentId) continue;
        for (const { pos, stop } of stopRow(net, arm.segmentId, arm.atStart ? 0 : 1)) marks.push({ kind: 'point', pos, color: STOP_COLOR[stop.kind], radius: 0.45 });
      }
    }
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
      const look = paintLook(settings.paint);
      marks.push({ kind: 'line', points: line, color: settings.paint.color, width: Math.max(0.3, settings.paint.width), dashed: !!look && look.style !== 'solid' && look.style !== 'double' });
    }
    this.ctx.setMarks(marks);
    if (!e) return;
    const name = paintName(settings.paint);
    const lines = [`Paint ${name}`, `${settings.paint.color}, ${settings.paint.width.toFixed(2)} m`];
    const notes: string[] = [];
    // One marking per place: a taken place says what the click replaces.
    const taken = this.draft ? this.replaces(this.pathInit(this.draft)) : this.isStamp && cursor && this.stop ? this.replaces(this.stampInit(cursor, this.stop)) : '';
    if (!cursor) notes.push('Move over a road');
    else if (this.reason) notes.push(this.reason);
    else if (this.isStamp) notes.push(taken ? `Click to replace the ${taken}` : 'Click to place on this lane');
    else if (!this.start) notes.push(cursor.atEnd ? 'Click to start at the junction edge' : this.stop?.kind === 'line' ? `Click to start on the ${this.stop.role === 'centre' ? 'centre' : this.stop.role ?? 'lane'} line` : 'Click to start here');
    else if (taken) notes.push(`Click to replace the ${taken}`);
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

  /** The decal a path draft would place. */
  private pathInit(draft: Draft): DecalInit {
    const { paint } = this.ctx.settings;
    const look = paintLook(paint);
    const fill = this.kind === 'hatch' ? { ...FILL_STANDARDS[0].spec, color: paint.color } : this.kind === 'fill' ? { ...FILL_STANDARDS[2].spec, color: paint.color } : undefined;
    return {
      kind: this.kind,
      points: [],
      road: {
        pieces: draft.pieces,
        offset: draft.offset,
        ...(draft.offset2 === undefined ? {} : { offset2: draft.offset2 }),
        ...(draft.offsetEnd === undefined ? {} : { offsetEnd: draft.offsetEnd }),
      },
      ...(look ? { style: look } : {}),
      ...(fill ? { fill } : {}),
      color: paint.color,
      width: look?.width ?? paint.width,
      rotation: 0,
    };
  }

  /** The decal a stamp click would place, or null with a reason toast. */
  private stampInit(cursor: RoadCursor, lane: LateralStop): DecalInit | null {
    const { net, settings } = this.ctx;
    const { paint } = settings;
    if (this.kind === 'text' && !paint.text.trim()) return null;
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
    const look = paintLook(paint);
    return {
      kind: this.kind,
      points: [],
      road: { pieces: [piece], offset, ...(offset2 === undefined ? {} : { offset2 }), dir: lane.dir ?? 1 },
      ...(look ? { style: look } : {}),
      color: paint.color,
      width: look?.width ?? paint.width,
      rotation: 0,
      ...(this.kind === 'text' ? { text: paint.text } : {}),
    };
  }

  /** What placing this would replace, named, or '' when the place is free. */
  private replaces(init: DecalInit | null): string {
    if (!init) return '';
    const { labels } = stackedWith(this.ctx.net, { kind: 'decal', decal: init });
    return labels[0] ?? '';
  }

  private place(init: DecalInit): void {
    this.ctx.history.hint('Paint');
    const net = this.ctx.net;
    net.addDecal(init);
    // One marking per place: say what the new one took the place of.
    const what = net.lastReplaced[0];
    if (what) this.ctx.toast(`Replaced the ${what}.`, 'info');
  }

  private placePath(draft: Draft): void {
    this.place(this.pathInit(draft));
    this.start = null;
  }

  private placeStamp(cursor: RoadCursor, lane: LateralStop): void {
    const init = this.stampInit(cursor, lane);
    if (!init) {
      this.ctx.toast('Type some text first.', 'warning');
      return;
    }
    this.place(init);
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
