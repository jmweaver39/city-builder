/**
 * Station and line tools. A station goes on track, with a platform that must fit
 * on plain track and be long enough for the trains that will use it. A line is a
 * list of stations clicked in order, made into a line on Enter or double click.
 */
import { cubicPoint, cubicTangentXZ } from '../core/bezier';
import { distXZ } from '../core/math';
import { defaultElectrification, electrifiedKind, platformSides, segmentElectrification, trackOffsets, type PlatformLayout, type RailStationKind, type TrainTypeId } from '../core/railTypes';
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Electrification, Id, Vec3 } from '../core/types';
import { TRAIN_TYPES, trainLength } from '../rail/consists';
import { stationReach } from '../rail/footprint';
import { checkPlatform, completeLine, nextStationName, platformFits, platformRoom, stationKindAt } from '../rail/lines';
import type { TrainSim } from '../rail/TrainSim';
import type { ToolMark } from '../render/api';
import { heightLevels, nearestOnLevel, pickRoad } from './pick';
import { Tool } from './Tool';
import { COLORS, type ToolContext, type ToolId, type ToolKey, type ToolPointer } from './types';

/** What the rail tools need beyond the road tools' context. */
export interface RailHooks {
  trains: TrainSim;
  pickTrain(clientX: number, clientY: number): number | null;
}

export type StationKindChoice = 'auto' | RailStationKind;

/** Platform layouts the station tool cycles through. 'side' follows the cursor. */
export type LayoutChoice = 'side' | 'both' | 'island';
const LAYOUTS: LayoutChoice[] = ['side', 'both', 'island'];

interface StationHover {
  segmentId: Id;
  t: number;
  pos: Vec3;
  ok: boolean;
  kind: RailStationKind;
  layout: PlatformLayout;
  reason: string | null;
}

export class StationTool extends Tool {
  readonly id: ToolId = 'station';
  rail: RailHooks | null = null;
  platformLength = 220;
  kind: StationKindChoice = 'auto';
  layout: LayoutChoice = 'side';
  /** Flips the side the cursor picks, or which side gets the building. */
  flip = false;
  /** Put a station building beside it. */
  building = false;
  private hover: StationHover | null = null;

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

  private trackAt(e: ToolPointer): { segmentId: Id; t: number; pos: Vec3; lateral: number } | null {
    const { net, view } = this.ctx;
    for (const level of heightLevels(net)) {
      const raw = view.pickPlane(e.x, e.y, level);
      if (!raw) continue;
      const hit = nearestOnLevel(net, raw, level, 25);
      if (!hit || net.roadTypeOf(hit.segmentId).category !== 'rail') continue;
      if (hit.distance > net.roadTypeOf(hit.segmentId).halfWidth + 8) continue;
      return { segmentId: hit.segmentId, t: hit.t, pos: hit.point, lateral: hit.lateral };
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

  keyDown(e: ToolKey): boolean {
    // See STATION_KEYS: ] cycles the layout, [ flips the side.
    if (e.key === ']') {
      this.layout = LAYOUTS[(LAYOUTS.indexOf(this.layout) + 1) % LAYOUTS.length];
      this.refresh();
      this.ctx.changed();
      return true;
    }
    if (e.key === '[') {
      this.flip = !this.flip;
      this.refresh();
      this.ctx.changed();
      return true;
    }
    return false;
  }

  /** The layout to place, given which side of the track the cursor is on. */
  private layoutAt(lateral: number): PlatformLayout {
    if (this.layout === 'both') return 'both';
    if (this.layout === 'island') return 'island';
    const right = lateral >= 0 !== this.flip;
    return right ? 'right' : 'left';
  }

  refresh(): void {
    const e = this.pointer;
    const { net } = this.ctx;
    this.hover = null;
    if (!e) return;
    const hit = this.trackAt(e);
    if (!hit) {
      this.ctx.setMarks([]);
      this.ctx.setHud({ x: e.x, y: e.y, lines: ['Station'], notes: ['Point at track to place a station', '] changes layout, [ flips side'], tone: 'ok' });
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
    const def = net.roadTypeOf(hit.segmentId);
    const double = trackOffsets(def).length === 2;
    const atEnd = [seg.a, seg.b].map((n) => net.getNode(n)!).find((n) => n.segments.length === 1 && distXZ(n.pos, hit.pos) < 120);
    // A track running off the map edge takes a freight gateway by default.
    if (this.kind === 'auto' && atEnd && Math.max(Math.abs(atEnd.pos.x), Math.abs(atEnd.pos.z)) > 1700) kind = 'gateway';
    let layout = this.layoutAt(hit.lateral);
    if (layout === 'island' && !double) layout = 'both';
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
      const kindName = kind === 'underground' ? 'Subway station' : kind === 'elevated' ? 'Elevated station' : 'Station';
      const layoutName = layout === 'island' ? 'island platform' : layout === 'both' ? 'platforms both sides' : `platform on the ${layout}`;
      lines.push(`${kindName}, ${layoutName}, ${Math.round(L)} m`);
      // Lateral offsets of each platform's middle, looking a to b.
      const off = trackOffsets(def);
      const gap = off.length === 2 ? off[1] - off[0] : 0;
      const sides = platformSides(layout, off.length);
      const platforms: number[] = [];
      let left = 3;
      let right = 3;
      if (layout === 'island') {
        platforms.push(0);
        left = right = 4.65 + 3;
      } else {
        off.forEach((o, track) => {
          if (sides[track] & 1 && (off.length === 1 || track === 0)) {
            platforms.push(o - 4.15);
            left = Math.max(left, -(o - 7.3));
          }
          if (sides[track] & 2 && (off.length === 1 || track === 1)) {
            platforms.push(o + 4.15);
            right = Math.max(right, o + 7.3);
          }
        });
      }
      void gap;
      void left;
      void right;
      const reach = stationReach(def, layout, kind, this.building ? (this.flip ? 'left' : 'right') : null);
      const check = checkPlatform(net, hit.segmentId, hit.t, L, reach, kind, layout === 'island');
      const room = this.rail ? platformRoom(this.rail.trains.graph, hit.pos) : null;
      if (room && (room.back < L / 2 || room.ahead < L / 2)) check.problems.push(`Only ${Math.round(Math.min(room.back, room.ahead) * 2)} m of plain track here for a ${Math.round(L)} m platform`);
      if (check.problems.length) {
        ok = false;
        reason = check.problems[0];
        notes.push(...check.problems.slice(1));
      }
      const fits = platformFits(L);
      const yes = fits.filter((f) => f.fits).map((f) => `${TRAIN_TYPES[f.type].name} ${f.cars}`);
      const no = fits.filter((f) => !f.fits).map((f) => `${TRAIN_TYPES[f.type].name} ${f.cars} (${Math.round(f.length)} m)`);
      if (yes.length) lines.push(`Fits: ${yes.join(', ')}`);
      if (no.length) notes.push(`Too short for ${no.join(', ')}`);
      notes.push('] changes layout, [ flips side');
      // Ghost of each platform along the track.
      const c = net.cubicOf(hit.segmentId);
      const dir = cubicTangentXZ(c, hit.t);
      const half = L / 2;
      const rx = -dir.z;
      const rz = dir.x;
      const base = cubicPoint(c, hit.t);
      const p = (s: number, o: number): Vec3 => ({ x: base.x + dir.x * s + rx * o, y: base.y + 1, z: base.z + dir.z * s + rz * o });
      for (const o of platforms) marks.push({ kind: 'line', points: [p(-half, o), p(half, o)], color: ok ? COLORS.ok : COLORS.bad, width: layout === 'island' ? 5 : 4 });
    }
    if (reason) notes.unshift(reason);
    marks.push({ kind: 'point', pos: hit.pos, color: ok ? COLORS.ok : COLORS.bad, radius: 2 });
    this.ctx.setMarks(marks);
    this.ctx.setHud({ x: e.x, y: e.y, lines, notes: ok ? [...notes, 'Click to place'] : notes, tone: ok ? 'ok' : 'error' });
    this.hover = { segmentId: hit.segmentId, t, pos: hit.pos, ok, kind, layout, reason };
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
    const gateway = h.kind === 'gateway';
    net.addStation({
      name: gateway ? `${nextStationName(net)} yard` : nextStationName(net),
      kind: h.kind,
      segmentId: h.segmentId,
      t: h.t,
      platformLength: gateway ? 0 : this.platformLength,
      ...(gateway ? {} : { layout: h.layout }),
      ...(!gateway && this.building ? { building: this.flip ? ('left' as const) : ('right' as const) } : {}),
    });
    this.refresh();
    this.ctx.changed();
  }
}

/** Station tool keys, for the keymap. */
export const STATION_KEYS = [
  { id: 'station.layout', label: 'Next platform layout', key: ']' },
  { id: 'station.flip', label: 'Flip platform side', key: '[' },
] as const;

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
        if (check.fixType) notes.push(`Pick ${TRAIN_TYPES[check.fixType].name} as the train, or electrify the track`);
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

// ---------------------------------------------------------------------------
// Electrification
// ---------------------------------------------------------------------------

/**
 * Track segments joined end to end with this one, through nodes where the line
 * simply continues (two tracks meeting). Stops at junctions and dead ends.
 */
export function connectedTrack(net: RoadNetwork, id: Id): Id[] {
  const out = new Set<Id>([id]);
  const queue = [id];
  while (queue.length) {
    const s = net.getSegment(queue.pop()!);
    if (!s) continue;
    for (const nodeId of [s.a, s.b]) {
      const rails = (net.getNode(nodeId)?.segments ?? []).filter((x) => net.roadTypeOf(x).category === 'rail');
      if (rails.length !== 2) continue;
      for (const x of rails) {
        if (!out.has(x)) {
          out.add(x);
          queue.push(x);
        }
      }
    }
  }
  return [...out];
}

/** Set the power on track segments. Only writes an override where it differs from the default. */
export function setElectrification(net: RoadNetwork, ids: readonly Id[], on: boolean): number {
  let changed = 0;
  net.batch(() => {
    for (const id of ids) {
      const seg = net.getSegment(id);
      if (!seg) continue;
      const def = net.roadTypeOf(id);
      if (def.category !== 'rail') continue;
      const want: Electrification = on ? electrifiedKind(def) : 'none';
      if (segmentElectrification(def, seg.overrides) === want) continue;
      net.setSegmentOverrides(id, { electrification: want === defaultElectrification(def) ? undefined : want });
      changed++;
    }
  });
  return changed;
}

/** Whether a segment of track is powered. */
export function isElectrified(net: RoadNetwork, id: Id): boolean {
  const seg = net.getSegment(id);
  if (!seg) return false;
  return segmentElectrification(net.roadTypeOf(id), seg.overrides) !== 'none';
}

/** The track segment under the pointer, at any height. */
export function trackUnder(ctx: ToolContext, e: ToolPointer): Id | null {
  const hit = pickRoad(ctx, e, 3);
  if (!hit || ctx.net.roadTypeOf(hit.segmentId).category !== 'rail') return null;
  return hit.segmentId;
}

/**
 * Toggle power on the track under the cursor, from any tool. One undo step.
 * Returns true when it did something, so the key is used up.
 */
export function toggleWiresAt(ctx: ToolContext, e: ToolPointer, wholeLine: boolean): boolean {
  const id = trackUnder(ctx, e);
  if (id === null) return false;
  const ids = wholeLine ? connectedTrack(ctx.net, id) : [id];
  const on = !isElectrified(ctx.net, id);
  ctx.history.hint(on ? 'Electrify track' : 'Remove overhead wires');
  setElectrification(ctx.net, ids, on);
  ctx.toast(`${on ? 'Electrified' : 'Took the wires off'} ${ids.length} piece${ids.length === 1 ? '' : 's'} of track`);
  return true;
}

/** Sweep along track to put up or take down overhead wires (third rail on metro). */
export class ElectrifyTool extends Tool {
  readonly id: ToolId = 'electrify';
  /** True puts power up, false takes it away. */
  electrify = false;
  wholeLine = false;
  private painting = false;
  private done = new Set<Id>();

  private targets(id: Id): Id[] {
    return this.wholeLine ? connectedTrack(this.ctx.net, id) : [id];
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.painting = true;
    this.done.clear();
    this.ctx.history.begin(this.electrify ? 'Electrify track' : 'Remove overhead wires');
    this.paint(e);
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    if (this.painting) this.paint(e);
    this.refresh();
  }

  pointerUp(): void {
    if (!this.painting) return;
    this.painting = false;
    this.done.clear();
    this.ctx.history.end();
    this.refresh();
  }

  deactivate(): void {
    if (this.painting) this.ctx.history.end();
    this.painting = false;
  }

  settingsChanged(): void {
    this.refresh();
  }

  keyDown(e: ToolKey): boolean {
    // Shift flips between putting wires up and taking them down while held.
    if (e.key === 'Shift') {
      this.refresh();
      return false;
    }
    return false;
  }

  private paint(e: ToolPointer): void {
    const id = trackUnder(this.ctx, e);
    if (id === null || this.done.has(id)) return;
    const ids = this.targets(id);
    for (const x of ids) this.done.add(x);
    setElectrification(this.ctx.net, ids, this.electrify);
  }

  refresh(): void {
    const e = this.pointer;
    if (!e) return;
    const id = trackUnder(this.ctx, e);
    const verb = this.electrify ? 'Electrify' : 'De-electrify';
    if (id === null) {
      this.ctx.view.setHighlight(null);
      this.ctx.setHud({ x: e.x, y: e.y, lines: [verb], notes: ['Click or drag along track'], tone: 'ok' });
      return;
    }
    const ids = this.targets(id);
    this.ctx.view.setHighlight({ segments: ids, color: this.electrify ? COLORS.ok : COLORS.warn });
    const now = isElectrified(this.ctx.net, id);
    this.ctx.setHud({
      x: e.x,
      y: e.y,
      lines: [`${verb}${this.wholeLine ? ' whole line' : ''}`, now ? 'Has power now' : 'No power now: diesel only'],
      notes: ['Click or drag along track. O toggles the track under the cursor from any tool'],
      tone: 'ok',
    });
  }
}
