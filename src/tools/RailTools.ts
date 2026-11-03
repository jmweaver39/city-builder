/**
 * Station and line tools. A station goes on track, with a platform that must fit
 * on plain track and be long enough for the trains that will use it. A line is a
 * list of stations clicked in order, made into a line on Enter or double click.
 */
import { cubicPoint, cubicTangentXZ } from '../core/bezier';
import { distXZ } from '../core/math';
import type { RailStationKind, TrainTypeId } from '../core/railTypes';
import type { Id, Vec3 } from '../core/types';
import { TRAIN_TYPES, trainLength } from '../rail/consists';
import { completeLine, nextStationName, platformFits, platformRoom, stationKindAt } from '../rail/lines';
import type { TrainSim } from '../rail/TrainSim';
import type { ToolMark } from '../render/api';
import { heightLevels, nearestOnLevel } from './pick';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolKey, type ToolPointer } from './types';

/** What the rail tools need beyond the road tools' context. */
export interface RailHooks {
  trains: TrainSim;
  pickTrain(clientX: number, clientY: number): number | null;
}

export type StationKindChoice = 'auto' | RailStationKind;

export class StationTool extends Tool {
  readonly id: ToolId = 'station';
  rail: RailHooks | null = null;
  platformLength = 220;
  kind: StationKindChoice = 'auto';
  private hover: { segmentId: Id; t: number; pos: Vec3; ok: boolean; kind: RailStationKind; reason: string | null } | null = null;

  private stationNear(pos: Vec3): Id | null {
    const { net } = this.ctx;
    let best: Id | null = null;
    let bestD = 30;
    for (const st of net.rail.stations) {
      if (!net.getSegment(st.segmentId)) continue;
      const p = cubicPoint(net.cubicOf(st.segmentId), st.t);
      const d = distXZ(p, pos);
      if (Math.abs(p.y - pos.y) < 3 && d < bestD) {
        best = st.id;
        bestD = d;
      }
    }
    return best;
  }

  private trackAt(e: ToolPointer): { segmentId: Id; t: number; pos: Vec3 } | null {
    const { net, view } = this.ctx;
    for (const level of heightLevels(net)) {
      const raw = view.pickPlane(e.x, e.y, level);
      if (!raw) continue;
      const hit = nearestOnLevel(net, raw, level, 25);
      if (!hit || net.roadTypeOf(hit.segmentId).category !== 'rail') continue;
      if (hit.distance > net.roadTypeOf(hit.segmentId).halfWidth + 4) continue;
      return { segmentId: hit.segmentId, t: hit.t, pos: hit.point };
    }
    return null;
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    this.refresh();
  }

  settingsChanged(): void {
    this.refresh();
  }

  deactivate(): void {
    this.hover = null;
  }

  refresh(): void {
    const e = this.pointer;
    const { net } = this.ctx;
    this.hover = null;
    if (!e) return;
    const hit = this.trackAt(e);
    if (!hit) {
      this.ctx.setMarks([]);
      this.ctx.setHud({ x: e.x, y: e.y, lines: ['Station'], notes: ['Point at track to place a station'], tone: 'ok' });
      return;
    }
    const existing = this.stationNear(hit.pos);
    if (existing !== null) {
      const st = net.rail.stations.find((s) => s.id === existing)!;
      this.ctx.setMarks([{ kind: 'ring', pos: hit.pos, color: COLORS.snap, radius: 12 }]);
      this.ctx.setHud({ x: e.x, y: e.y, lines: [st.name], notes: ['Click to edit this station'], tone: 'ok' });
      return;
    }
    let kind: RailStationKind = this.kind === 'auto' ? stationKindAt(hit.pos) : this.kind;
    const seg = net.getSegment(hit.segmentId)!;
    const atEnd = [seg.a, seg.b].map((n) => net.getNode(n)!).find((n) => n.segments.length === 1 && distXZ(n.pos, hit.pos) < 120);
    // A track running off the map edge takes a freight gateway by default.
    if (this.kind === 'auto' && atEnd && Math.max(Math.abs(atEnd.pos.x), Math.abs(atEnd.pos.z)) > 1700) kind = 'gateway';
    const lines: string[] = [];
    const notes: string[] = [];
    let ok = true;
    let reason: string | null = null;
    const marks: ToolMark[] = [];
    let t = hit.t;
    if (kind === 'gateway') {
      if (!atEnd) {
        ok = false;
        reason = 'A freight gateway goes at the end of a track';
      } else {
        t = atEnd.id === seg.a ? 0.0005 : 0.9995;
        lines.push('Freight gateway');
        notes.push('Freight runs through to here and leaves the map');
        marks.push({ kind: 'ring', pos: atEnd.pos, color: COLORS.ok, radius: 10 });
      }
    } else {
      const L = this.platformLength;
      const room = this.rail ? platformRoom(this.rail.trains.graph, hit.pos) : null;
      lines.push(`${kind === 'underground' ? 'Subway station' : 'Station'}, platform ${Math.round(L)} m`);
      if (room && (room.back < L / 2 || room.ahead < L / 2)) {
        ok = false;
        reason = `Only ${Math.round(Math.min(room.back, room.ahead) * 2)} m of plain track here for a ${Math.round(L)} m platform`;
      }
      const fits = platformFits(L);
      const yes = fits.filter((f) => f.fits).map((f) => `${TRAIN_TYPES[f.type].name} ${f.cars}`);
      const no = fits.filter((f) => !f.fits).map((f) => `${TRAIN_TYPES[f.type].name} ${f.cars} (${Math.round(f.length)} m)`);
      if (yes.length) lines.push(`Fits: ${yes.join(', ')}`);
      if (no.length) notes.push(`Too short for ${no.join(', ')}`);
      // Ghost of the platform along the track.
      const c = net.cubicOf(hit.segmentId);
      const dir = cubicTangentXZ(c, hit.t);
      const half = L / 2;
      const right = { x: -dir.z, z: dir.x };
      const off = net.roadTypeOf(hit.segmentId).halfWidth + 2.5;
      const p = (s: number, o: number): Vec3 => ({ x: hit.pos.x + dir.x * s + right.x * o, y: hit.pos.y + 1, z: hit.pos.z + dir.z * s + right.z * o });
      marks.push({ kind: 'line', points: [p(-half, off), p(half, off)], color: ok ? COLORS.ok : COLORS.bad, width: 2.5 });
      marks.push({ kind: 'line', points: [p(-half, -off), p(half, -off)], color: ok ? COLORS.ok : COLORS.bad, width: 2.5 });
    }
    if (reason) notes.unshift(reason);
    marks.push({ kind: 'point', pos: hit.pos, color: ok ? COLORS.ok : COLORS.bad, radius: 2 });
    this.ctx.setMarks(marks);
    this.ctx.setHud({ x: e.x, y: e.y, lines, notes: ok ? [...notes, 'Click to place'] : notes, tone: ok ? 'ok' : 'error' });
    this.hover = { segmentId: hit.segmentId, t, pos: hit.pos, ok, kind, reason };
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    this.refresh();
    const h = this.hover;
    const { net } = this.ctx;
    const hit = this.trackAt(e);
    if (hit) {
      const existing = this.stationNear(hit.pos);
      if (existing !== null) {
        this.ctx.inspect({ kind: 'station', id: existing });
        return;
      }
    }
    if (!h) return;
    if (!h.ok) {
      if (h.reason) this.ctx.toast(h.reason, 'error');
      return;
    }
    this.ctx.history.hint('Add station');
    net.addStation({
      name: h.kind === 'gateway' ? `${nextStationName(net)} yard` : nextStationName(net),
      kind: h.kind,
      segmentId: h.segmentId,
      t: h.t,
      platformLength: h.kind === 'gateway' ? 0 : this.platformLength,
    });
    this.refresh();
    this.ctx.changed();
  }
}

export class LineTool extends Tool {
  readonly id: ToolId = 'line';
  rail: RailHooks | null = null;
  /** 'auto' chooses from the track. */
  trainType: TrainTypeId | 'auto' = 'auto';
  cars = 0;
  trains = 3;
  stops: Id[] = [];

  activate(): void {
    this.stops = [];
    this.refresh();
  }

  deactivate(): void {
    this.stops = [];
  }

  settingsChanged(): void {
    this.refresh();
  }

  private stationAt(e: ToolPointer): Id | null {
    const { net, view } = this.ctx;
    let best: Id | null = null;
    let bestD = 45;
    for (const st of net.rail.stations) {
      if (!net.getSegment(st.segmentId)) continue;
      const p = cubicPoint(net.cubicOf(st.segmentId), st.t);
      const raw = view.pickPlane(e.x, e.y, p.y);
      if (!raw) continue;
      const d = distXZ(raw, p);
      const reach = Math.max(45, st.platformLength / 2);
      if (d < reach && d < bestD + (reach - 45)) {
        best = st.id;
        bestD = d;
      }
    }
    return best;
  }

  private posOf(id: Id): Vec3 | null {
    const { net } = this.ctx;
    const st = net.rail.stations.find((s) => s.id === id);
    if (!st || !net.getSegment(st.segmentId)) return null;
    return cubicPoint(net.cubicOf(st.segmentId), st.t);
  }

  private draft() {
    return completeLine(this.ctx.net, {
      stops: this.stops,
      trainType: this.trainType === 'auto' ? undefined : this.trainType,
      cars: this.cars > 0 ? this.cars : undefined,
      trains: this.trains,
    });
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    this.refresh();
  }

  refresh(): void {
    const e = this.pointer;
    const { net } = this.ctx;
    const marks: ToolMark[] = [];
    const pts = this.stops.map((id) => this.posOf(id)).filter((p): p is Vec3 => !!p);
    const hover = e ? this.stationAt(e) : null;
    for (const p of pts) marks.push({ kind: 'ring', pos: p, color: COLORS.snap, radius: 14 });
    const hp = hover !== null ? this.posOf(hover) : null;
    if (hp) marks.push({ kind: 'ring', pos: hp, color: COLORS.ok, radius: 18 });
    const chain = hp && hover !== this.stops[this.stops.length - 1] ? [...pts, hp] : pts;
    if (chain.length > 1) marks.push({ kind: 'line', points: chain.map((p) => ({ ...p, y: p.y + 2 })), color: COLORS.guide, width: 2, dashed: true });
    this.ctx.setMarks(marks);
    if (!e) return;
    const lines = [`Line: ${this.stops.length} stop${this.stops.length === 1 ? '' : 's'}`];
    const notes: string[] = [];
    let tone: 'ok' | 'warning' | 'error' = 'ok';
    if (this.stops.length >= 2 && this.rail) {
      const d = this.draft();
      const check = this.rail.trains.checkLine(d);
      lines.push(`${TRAIN_TYPES[d.trainType].name}, ${d.cars} cars, ${Math.round(trainLength(d.trainType, d.cars))} m, ${d.trains} trains`);
      if (check.problem) {
        notes.push(check.problem);
        tone = 'error';
      } else {
        if (check.warning) {
          notes.push(check.warning);
          tone = 'warning';
        }
        notes.push('Enter or double click makes the line');
      }
    }
    if (hover !== null) notes.push(`Click to add ${net.rail.stations.find((s) => s.id === hover)?.name}`);
    else if (!this.stops.length) notes.push('Click stations in the order trains call');
    if (this.stops.length) notes.push('Right click removes the last stop');
    this.ctx.setHud({ x: e.x, y: e.y, lines, notes, tone });
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    const id = this.stationAt(e);
    if (id === null) return;
    if (this.stops[this.stops.length - 1] !== id) this.stops.push(id);
    this.refresh();
    this.ctx.changed();
  }

  doubleClick(): void {
    this.finish();
  }

  keyDown(e: ToolKey): boolean {
    if (e.key === 'Enter') {
      this.finish();
      return true;
    }
    return false;
  }

  back(): boolean {
    if (!this.stops.length) return false;
    this.stops.pop();
    this.refresh();
    this.ctx.changed();
    return true;
  }

  /** Make the line from the stops picked so far. */
  finish(): void {
    if (this.stops.length < 2 || !this.rail) {
      this.ctx.toast('Pick at least two stations', 'warning');
      return;
    }
    const d = this.draft();
    const check = this.rail.trains.checkLine(d);
    if (check.problem) {
      this.ctx.toast(check.problem, 'error');
      return;
    }
    this.ctx.history.hint('Add line');
    this.ctx.net.addLine(d);
    this.ctx.toast(`${d.name} added: ${TRAIN_TYPES[d.trainType].name}, ${d.trains} trains${check.warning ? `. ${check.warning}` : ''}`, check.warning ? 'warning' : 'info');
    this.stops = [];
    this.refresh();
    this.ctx.changed();
  }
}
