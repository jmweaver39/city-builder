/**
 * Zoning by region. Fill block: click inside an area enclosed by roads. Frontage:
 * drag along roads for a strip on the side you are on. Rectangle and polygon:
 * shapes whose corners snap to road edges. Dezone uses the same modes.
 */
import { cubicTangentXZ } from '../core/bezier';
import { distXZ } from '../core/math';
import type { NetworkChange } from '../core/RoadNetwork';
import type { Id, Vec3, ZoneAnchor, ZoneKind, ZoneRegion, ZoneSettings } from '../core/types';
import {
  coverageOf,
  fillBlock,
  frontageStrip,
  groundUsable,
  polygonArea,
  snapShape,
  zoneRates,
  type ShapeResult,
} from '../core/zones';
import type { ToolMark, ZoneGhost } from '../render/api';
import { pickRoad } from './pick';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolKey, type ToolPointer } from './types';
import { placeZones, ZONE_NAMES } from './zoneOps';

export type ZoneMode = 'block' | 'frontage' | 'rect' | 'polygon';

export const ZONE_COLORS: Record<ZoneKind | 'none', string> = {
  residential: '#58c86a',
  commercial: '#4f9cff',
  industrial: '#f2b33d',
  office: '#b48cff',
  none: '#ff6b6b',
};

const INVALID = '#ff4d4d';
const CLOSE_PX_WORLD = 6;
const RECT_ALIGN_REACH = 30;

interface Shape {
  polygon: Vec3[];
  anchors: (ZoneAnchor | null)[];
  source: ZoneRegion['source'];
}

interface Preview {
  shapes: Shape[];
  error: string | null;
  area: number;
}

export class ZoneTool extends Tool {
  readonly id: ToolId = 'zone';
  private preview: Preview | null = null;
  private dragFrom: Vec3 | null = null;
  private frontage = new Map<Id, { t0: number; t1: number; side: 1 | -1 }>();
  private dragging = false;
  private corners: Vec3[] = [];
  private blockKey = '';
  private blockResult: ShapeResult | null = null;

  private get s() {
    return this.ctx.settings.zone;
  }

  private get settings(): ZoneSettings {
    const s = this.s;
    return { depth: s.depth, setback: s.setback, snap: s.snap, snapDistance: s.snapDistance, excludeFast: s.excludeFast };
  }

  get pendingCorners(): number {
    return this.corners.length;
  }

  private ground(e: ToolPointer): Vec3 | null {
    return this.ctx.view.pickPlane(e.x, e.y, 0);
  }

  private shapeOf(result: ShapeResult, source: ZoneRegion['source']): Shape | string {
    return 'error' in result ? result.error : { ...result, source };
  }

  /** Work out what a click or drag here would zone. */
  private compute(e: ToolPointer): Preview | null {
    const { net } = this.ctx;
    const mode = this.s.mode;
    const at = this.ground(e);
    if (!at) return null;
    let shapes: Shape[] = [];
    let error: string | null = null;
    if (mode === 'block') {
      const key = `${Math.round(at.x / 4)},${Math.round(at.z / 4)},${net.version},${JSON.stringify(this.settings)}`;
      if (key !== this.blockKey) {
        this.blockKey = key;
        this.blockResult = fillBlock(net, at, this.settings);
      }
      const r = this.shapeOf(this.blockResult!, 'block');
      if (typeof r === 'string') error = r;
      else shapes = [r];
    } else if (mode === 'frontage') {
      if (!this.frontage.size) {
        const hit = pickRoad(this.ctx, e, 30);
        if (!hit) return { shapes: [], error: 'Move along a road', area: 0 };
        const span = 0.04;
        const r = frontageStrip(net, hit.segmentId, hit.t - span, hit.t + span, hit.lateral >= 0 ? 1 : -1, this.settings);
        const shape = this.shapeOf(r, 'frontage');
        if (typeof shape === 'string') error = shape;
        else shapes = [shape];
      } else {
        for (const [id, f] of this.frontage) {
          const shape = this.shapeOf(frontageStrip(net, id, f.t0, f.t1, f.side, this.settings), 'frontage');
          if (typeof shape === 'string') error ??= shape;
          else shapes.push(shape);
        }
      }
    } else if (mode === 'rect') {
      if (!this.dragFrom) return { shapes: [], error: 'Drag out a rectangle', area: 0 };
      shapes = [this.rectangle(this.dragFrom, at)];
    } else {
      const pts = [...this.corners, at];
      if (pts.length < 3) return { shapes: [], error: this.corners.length ? 'Click more corners' : 'Click the corners of the area', area: 0 };
      const snapped = snapShape(net, pts, this.settings);
      shapes = [{ ...snapped, source: 'shape' }];
    }
    let area = 0;
    for (const sh of shapes) {
      const c = coverageOf(net, sh.polygon, this.settings.setback);
      area += c.area;
      const centre = sh.polygon.reduce((m, p) => ({ x: m.x + p.x / sh.polygon.length, z: m.z + p.z / sh.polygon.length }), { x: 0, z: 0 });
      if (!error && !groundUsable(centre.x, centre.z) && c.area < polygonArea(sh.polygon) * 0.5) error = 'Mostly water or off the map';
    }
    if (!error && shapes.length && area < 50) error = 'That is all road';
    return { shapes, error, area };
  }

  /** Two corners of a rectangle, lined up with the nearest road if there is one. */
  private rectangle(a: Vec3, b: Vec3): Shape {
    const { net } = this.ctx;
    let ux = 1;
    let uz = 0;
    const hit = net.nearestSegment(a, RECT_ALIGN_REACH);
    if (hit) {
      const t = cubicTangentXZ(net.cubicOf(hit.segmentId), hit.t);
      ux = t.x;
      uz = t.z;
    }
    const vx = -uz;
    const vz = ux;
    const du = (b.x - a.x) * ux + (b.z - a.z) * uz;
    const dv = (b.x - a.x) * vx + (b.z - a.z) * vz;
    const p = (u: number, v: number): Vec3 => ({ x: a.x + ux * u + vx * v, y: 0, z: a.z + uz * u + vz * v });
    const snapped = snapShape(net, [p(0, 0), p(du, 0), p(du, dv), p(0, dv)], this.settings);
    return { ...snapped, source: 'shape' };
  }

  private show(e: ToolPointer | null): void {
    const { view } = this.ctx;
    const kind = this.s.kind;
    const p = this.preview;
    const color = p?.error ? INVALID : ZONE_COLORS[kind];
    const ghosts: ZoneGhost[] = (p?.shapes ?? []).map((sh) => ({ points: sh.polygon, color }));
    view.setZoneGhost(ghosts);
    const marks: ToolMark[] = [];
    for (const sh of p?.shapes ?? []) {
      marks.push({ kind: 'line', points: [...sh.polygon, sh.polygon[0]], color, width: 0.5 });
      sh.polygon.forEach((pt, i) => {
        if (sh.anchors[i] && (sh.source !== 'frontage' || i === 0)) marks.push({ kind: 'point', pos: pt, color: COLORS.snap, radius: 0.6 });
      });
    }
    for (const c of this.corners) marks.push({ kind: 'ring', pos: c, color: COLORS.ok, radius: 1.5 });
    this.ctx.setMarks(marks);
    if (!e) return;
    const lines = [`${ZONE_NAMES[kind]}${kind === 'none' ? '' : `, ${this.s.density} density`}`];
    if (p && p.area > 0) {
      lines.push(`${Math.round(p.area).toLocaleString()} m²`);
      if (kind !== 'none') lines.push(`About ${zoneRates(kind, this.s.density, p.area).ratePerHour} vehicles an hour`);
    }
    const notes: string[] = [];
    if (p?.error) notes.push(p.error);
    else if (this.s.mode === 'block') notes.push('Click to zone this block');
    else if (this.s.mode === 'frontage') notes.push(this.dragging ? 'Release to zone' : 'Drag along roads, on the side to zone');
    else if (this.s.mode === 'rect') notes.push(this.dragging ? 'Release to zone' : 'Drag out a rectangle');
    else notes.push(this.corners.length >= 3 ? 'Click the first corner or press Enter to finish' : 'Click corners. They snap to road edges');
    this.ctx.setHud({ x: e.x, y: e.y, lines, notes, tone: p?.error ? 'warning' : 'ok' });
  }

  private refresh(e: ToolPointer): void {
    this.preview = this.compute(e);
    this.show(e);
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    if (this.dragging && this.s.mode === 'frontage') this.collectFrontage(e);
    this.refresh(e);
  }

  private collectFrontage(e: ToolPointer): void {
    const hit = pickRoad(this.ctx, e, 30);
    if (!hit) return;
    const known = this.frontage.get(hit.segmentId);
    if (!known) {
      this.frontage.set(hit.segmentId, { t0: hit.t, t1: hit.t, side: hit.lateral >= 0 ? 1 : -1 });
      return;
    }
    known.t0 = Math.min(known.t0, hit.t);
    known.t1 = Math.max(known.t1, hit.t);
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    const mode = this.s.mode;
    const at = this.ground(e);
    if (!at) return;
    if (mode === 'block') {
      this.refresh(e);
      this.commit();
    } else if (mode === 'frontage') {
      this.dragging = true;
      this.frontage.clear();
      this.collectFrontage(e);
      this.refresh(e);
    } else if (mode === 'rect') {
      this.dragging = true;
      this.dragFrom = at;
      this.refresh(e);
    } else {
      if (this.corners.length >= 3 && distXZ(at, this.corners[0]) <= CLOSE_PX_WORLD) {
        this.finishPolygon();
        return;
      }
      this.corners.push(at);
      this.refresh(e);
    }
    this.ctx.changed();
  }

  pointerUp(e: ToolPointer): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.refresh(e);
    this.commit();
    this.frontage.clear();
    this.dragFrom = null;
    this.refresh(e);
  }

  doubleClick(_e: ToolPointer): void {
    if (this.s.mode === 'polygon') this.finishPolygon();
  }

  /** Close the polygon being clicked. */
  finishPolygon(): boolean {
    if (this.s.mode !== 'polygon' || this.corners.length < 3) return false;
    const { net } = this.ctx;
    const snapped = snapShape(net, this.corners, this.settings);
    this.preview = { shapes: [{ ...snapped, source: 'shape' }], error: null, area: coverageOf(net, snapped.polygon, this.settings.setback).area };
    if (this.preview.area < 50) this.preview.error = 'That is all road';
    this.corners = [];
    this.commit();
    if (this.pointer) this.refresh(this.pointer);
    this.ctx.changed();
    return true;
  }

  private commit(): void {
    const p = this.preview;
    if (!p || !p.shapes.length) return;
    if (p.error) {
      this.ctx.toast(p.error, 'warning');
      return;
    }
    const s = this.s;
    this.ctx.history.hint(s.kind === 'none' ? 'Dezone' : `Zone ${ZONE_NAMES[s.kind].toLowerCase()}`);
    placeZones(
      this.ctx.net,
      p.shapes.map((sh) => ({
        kind: s.kind,
        density: s.density,
        enabled: true,
        name: '',
        polygon: sh.polygon,
        anchors: sh.anchors,
        source: sh.source,
        settings: this.settings,
      })),
    );
    this.blockKey = '';
  }

  keyDown(e: ToolKey): boolean {
    if (e.key === 'Enter') return this.finishPolygon();
    return false;
  }

  back(): boolean {
    if (this.corners.length) {
      this.corners.pop();
      if (this.pointer) this.refresh(this.pointer);
      return true;
    }
    return false;
  }

  activate(): void {
    this.ctx.view.setZoneOverlay(true);
  }

  settingsChanged(): void {
    this.blockKey = '';
    if (this.s.mode !== 'polygon') this.corners = [];
    if (this.pointer) this.refresh(this.pointer);
  }

  networkChanged(_change: NetworkChange): void {
    this.blockKey = '';
  }

  deactivate(): void {
    this.corners = [];
    this.frontage.clear();
    this.dragging = false;
    this.preview = null;
    this.ctx.view.setZoneGhost([]);
    this.ctx.view.setZoneOverlay(false);
  }
}

