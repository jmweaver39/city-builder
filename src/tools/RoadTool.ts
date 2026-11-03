/**
 * The road tool: Straight, Curved, Freeform and Upgrade.
 *
 * A placement walks through stages: pick a start, for Curved pick a control, then
 * pick an end. Placing continues from the new end. Right click steps back one
 * stage at a time.
 */
import type { Cubic } from '../core/bezier';
import type { CrossingInfo, DraftIssue, RoadAnchor } from '../core/RoadNetwork';
import { addScaled, clamp, distXZ, dotXZ, sub } from '../core/math';
import { isOneWay } from '../core/roadTypes';
import { ELEVATION_STEP, MAX_ELEVATION, MIN_ELEVATION } from '../core/terrain';
import type { Id, RampAttach, Vec3 } from '../core/types';
import type { RoadPreview, ToolMark } from '../render/api';
import { buildCubic, endState, formatReadout, readout } from './draft';
import { castRay, chooseHit, nodesNearRay, pickRoad } from './pick';
import { upgradeSegment } from './roadOps';
import { groundPixelSize, snapGridAt, type GridSettings } from './grid';
import { formatSpacing } from '../render/gridLevels';
import { continuationAt, NODE_CATCH, referenceDirection, snapRoadPoint, type SnapHit } from './snap';
import { attachFor, flipAttach, laneChoiceAt, reverseCubic, travelChevrons, type LaneChoice } from './laneSnap';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolKey, type ToolPointer, type Tone } from './types';

interface StartPoint {
  anchor: RoadAnchor;
  pos: Vec3;
  /** Direction the road must continue, or null when free to leave any way. */
  dir: Vec3 | null;
  slope: number | null;
  /** Angle guides measure from this. */
  ref: Vec3 | null;
  /** The highway lane a ramp leaves or joins here. */
  lane?: LaneChoice | null;
}

export interface DraftState {
  cubic: Cubic;
  start: RoadAnchor;
  end: RoadAnchor;
  issues: DraftIssue[];
  crossings: CrossingInfo[];
  state: Tone;
  /** Lane attaches at either end, for a ramp on a highway lane. */
  startAttach?: RampAttach;
  endAttach?: RampAttach;
  /** Drawn against the traffic it joins, so it will be built the other way round. */
  flipped?: boolean;
}

export function formatElevation(y: number): string {
  if (y === 0) return 'Ground 0 m';
  return `${y > 0 ? 'Elevated +' : 'Tunnel '}${y} m`;
}

export class RoadTool extends Tool {
  readonly id: ToolId = 'road';
  private start: StartPoint | null = null;
  private control: Vec3 | null = null;
  private hit: SnapHit | null = null;
  private draft: DraftState | null = null;
  // Upgrade drag.
  private painting = false;
  private painted = new Set<Id>();

  /** Stage of the placement, for the UI. */
  get stage(): 'start' | 'control' | 'end' {
    if (!this.start) return 'start';
    return this.ctx.settings.drawMode === 'curved' && !this.control ? 'control' : 'end';
  }

  get currentDraft(): DraftState | null {
    return this.draft;
  }

  activate(): void {
    this.refresh();
  }

  deactivate(): void {
    this.reset();
  }

  private reset(): void {
    this.start = null;
    this.control = null;
    this.hit = null;
    this.draft = null;
    this.painting = false;
    this.painted.clear();
  }

  settingsChanged(): void {
    const mode = this.ctx.settings.drawMode;
    if (mode === 'upgrade') {
      this.start = null;
      this.control = null;
    } else if (mode !== 'curved') {
      this.control = null;
    }
    this.refresh();
  }

  networkChanged(change: { reset: boolean }): void {
    if (change.reset) {
      this.reset();
      this.refresh();
    }
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    if (this.ctx.settings.drawMode === 'upgrade' && this.painting) this.paintAt(e);
    this.refresh();
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    if (this.ctx.settings.drawMode === 'upgrade') {
      this.painting = true;
      this.painted.clear();
      this.ctx.history.begin('Upgrade road');
      this.paintAt(e);
      this.refresh();
      return;
    }
    this.refresh();
    if (!this.hit) return;
    if (!this.start) {
      this.placeStart(this.hit);
    } else if (this.stage === 'control') {
      this.control = this.constrainedControl(this.hit.pos, e.ctrl);
    } else {
      this.placeEnd();
    }
    this.refresh();
    this.ctx.changed();
  }

  pointerUp(e: ToolPointer): void {
    if (this.painting) {
      this.painting = false;
      this.painted.clear();
      this.ctx.history.end();
      this.refresh();
    }
  }

  back(): boolean {
    let used = true;
    if (this.control) this.control = null;
    else if (this.start) this.start = null;
    else used = false;
    this.refresh();
    if (used) this.ctx.changed();
    return used;
  }

  keyDown(e: ToolKey): boolean {
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      this.stepElevation(e.key === 'PageUp' ? 1 : -1);
      return true;
    }
    if (e.key === 'Control' || e.key === 'Meta') {
      if (this.pointer) this.pointer = { ...this.pointer, ctrl: true };
      this.refresh();
      return false;
    }
    return false;
  }

  keyUp(e: ToolKey): boolean {
    if (e.key === 'Control' || e.key === 'Meta') {
      if (this.pointer) this.pointer = { ...this.pointer, ctrl: false };
      this.refresh();
    }
    return false;
  }

  stepElevation(direction: 1 | -1): void {
    const s = this.ctx.settings;
    s.elevation = clamp(s.elevation + direction * ELEVATION_STEP, MIN_ELEVATION, MAX_ELEVATION);
    this.refresh();
    this.ctx.changed();
  }

  // -------------------------------------------------------------------------

  private snapAt(e: ToolPointer): SnapHit | null {
    const { net, view, settings } = this.ctx;
    const raw = view.pickPlane(e.x, e.y, settings.elevation);
    if (!raw) return null;
    // Snap candidates come from a ray cast, at the true height of what is under the
    // cursor, so raised roads and junctions snap whatever the elevation setting.
    const picks: { level: number; pos: Vec3 }[] = [];
    const hits = castRay(this.ctx, e);
    const top = chooseHit(hits, () => true);
    if (top) picks.push({ level: top.point.y, pos: top.point });
    for (const near of nodesNearRay(this.ctx, e, NODE_CATCH)) {
      if (top && top.point.y > near.point.y + 1.5) continue;
      picks.push({ level: near.point.y, pos: near.point });
    }
    if (!picks.length) picks.push({ level: settings.elevation, pos: raw });
    const start = this.start;
    const ignoreNodes = start?.anchor.kind === 'node' ? [start.anchor.id] : [];
    let ref: Vec3 | null = null;
    if (start) ref = start.dir ?? start.ref;
    return snapRoadPoint(net, {
      picks,
      raw,
      from: start ? { pos: start.pos, ref } : null,
      toggles: {
        nodes: settings.snapNodes,
        segments: settings.snapSegments,
        angle: settings.snapAngle,
        length: settings.snapLength,
      },
      disabled: e.ctrl,
      ignoreNodes,
      ...this.gridQuery(e),
    });
  }

  private startFrom(hit: SnapHit): StartPoint {
    const { net } = this.ctx;
    const cont = hit.anchor.kind === 'node' ? continuationAt(net, hit.anchor.id) : null;
    const lane = this.laneChoiceFor(hit);
    return {
      anchor: hit.anchor,
      // A ramp leaves from the outer edge of the chosen lane's carriageway.
      pos: lane ? { ...lane.chosen.edge } : { ...hit.pos },
      dir: cont?.dir ?? null,
      slope: cont?.slope ?? null,
      ref: lane ? lane.chosen.travel : (cont?.dir ?? referenceDirection(net, hit.anchor, null)),
      lane,
    };
  }

  /** Lane snap points when a one-way road meets a highway here, unless Ctrl is held. */
  private laneChoiceFor(hit: SnapHit): LaneChoice | null {
    const { net, settings, view } = this.ctx;
    const def = net.roadType(settings.roadType);
    if (!def || !isOneWay(def) || def.category === 'rail' || this.pointer?.ctrl) return null;
    if (hit.anchor.kind !== 'segment' && hit.anchor.kind !== 'node') return null;
    const e = this.pointer;
    const cursor = (e && view.pickPlane(e.x, e.y, hit.pos.y)) ?? hit.pos;
    return laneChoiceAt(net, hit.anchor, cursor);
  }

  private placeStart(hit: SnapHit): void {
    this.start = this.startFrom(hit);
    this.control = null;
    // Picking up an elevated road carries on at its height until told otherwise.
    if (hit.anchor.kind !== 'free' && Math.abs(hit.pos.y) > 1) {
      this.ctx.settings.elevation = clamp(
        Math.round(hit.pos.y / ELEVATION_STEP) * ELEVATION_STEP,
        MIN_ELEVATION,
        MAX_ELEVATION,
      );
    }
  }

  /** With a tangent to honour, the control point slides along it. */
  private constrainedControl(pos: Vec3, free: boolean): Vec3 {
    const start = this.start!;
    if (free || !start.dir) return { ...pos };
    const along = Math.max(dotXZ(sub(pos, start.pos), start.dir), 4);
    return { ...addScaled(start.pos, start.dir, along), y: pos.y };
  }

  private buildDraft(hit: SnapHit, ctrl: boolean): DraftState | null {
    const { net, settings } = this.ctx;
    const start = this.start;
    if (!start) return null;
    const mode = settings.drawMode === 'upgrade' ? 'straight' : settings.drawMode;
    let endDir: Vec3 | null = null;
    let endSlope: number | null = null;
    if (!ctrl && mode !== 'straight' && hit.anchor.kind === 'node') {
      const cont = continuationAt(net, hit.anchor.id);
      if (cont) {
        // Arriving runs against the way that road would continue.
        endDir = { x: -cont.dir.x, y: 0, z: -cont.dir.z };
        endSlope = -cont.slope;
      }
    }
    let startDir = ctrl ? null : start.dir;
    let endPos = hit.pos;
    // A ramp on a highway lane leaves and joins aligned with its traffic. Heading
    // back against it draws the other kind of ramp, which is flipped below.
    const startLane = ctrl ? null : (start.lane ?? null);
    const endLane = this.laneChoiceFor(hit);
    if (startLane) {
      const ahead = dotXZ(sub(hit.pos, start.pos), startLane.chosen.travel) >= 0;
      startDir = ahead ? startLane.chosen.travel : { x: -startLane.chosen.travel.x, y: 0, z: -startLane.chosen.travel.z };
    }
    if (endLane) {
      endPos = endLane.chosen.edge;
      const travel = endLane.chosen.travel;
      endDir = dotXZ(sub(endPos, start.pos), travel) >= 0 ? travel : { x: -travel.x, y: 0, z: -travel.z };
    }
    const cubic = buildCubic(
      mode,
      {
        start: start.pos,
        end: endPos,
        startDir: mode === 'curved' ? null : startDir,
        endDir,
        startSlope: ctrl ? null : start.slope,
        endSlope,
      },
      this.control,
    );
    const startAttach = startLane ? attachFor(startLane, startDir ?? startLane.chosen.travel) : undefined;
    const endAttach = endLane && endDir ? attachFor(endLane, endDir) : undefined;
    const evaluate = (c: Cubic, a: RoadAnchor, b: RoadAnchor, sa: RampAttach | undefined, ea: RampAttach | undefined, flipped: boolean): DraftState => {
      const params = { start: a, end: b, c1: c.p1, c2: c.p2, roadType: settings.roadType, startAttach: sa, endAttach: ea };
      const issues = net.validateDraft(params);
      const ignore = [a, b].flatMap((x) => (x.kind === 'node' ? [x.id] : []));
      const crossings = net.findCrossings(c, ignore).filter((x) => !this.isEndHit(x, c, a, b));
      const state: Tone = issues.some((i) => i.severity === 'error') ? 'error' : issues.length ? 'warning' : 'ok';
      return { cubic: c, start: a, end: b, issues, crossings, state, startAttach: sa, endAttach: ea, flipped };
    };
    const drawn = evaluate(cubic, start.anchor, hit.anchor, startAttach, endAttach, false);
    const def = net.roadType(settings.roadType);
    if (def && isOneWay(def) && drawn.issues.some((i) => i.code === 'wrongWay')) {
      // Drawn against the traffic it meets: the same road the other way round may work.
      const flipped = evaluate(reverseCubic(cubic), hit.anchor, start.anchor, flipAttach(endAttach), flipAttach(startAttach), true);
      if (!flipped.issues.some((i) => i.code === 'wrongWay')) return flipped;
    }
    return drawn;
  }

  private isEndHit(c: CrossingInfo, cubic: Cubic, start: RoadAnchor, end: RoadAnchor): boolean {
    const near = (a: RoadAnchor, t: number) => a.kind === 'segment' && a.id === c.segmentId && Math.abs(c.t - t) < 0.02;
    return near(start, 0) || near(end, 1);
  }

  private placeEnd(): void {
    const { net, settings, toast } = this.ctx;
    const draft = this.draft;
    if (!draft) return;
    if (draft.state === 'error') {
      const reason = draft.issues.find((i) => i.severity === 'error');
      if (reason) toast(reason.message, 'error');
      return;
    }
    this.ctx.history.hint('Draw road');
    const result = net.drawRoad({
      start: draft.start,
      end: draft.end,
      c1: draft.cubic.p1,
      c2: draft.cubic.p2,
      roadType: settings.roadType,
      startAttach: draft.startAttach,
      endAttach: draft.endAttach,
    });
    if (draft.flipped) {
      // The far end is where this road begins, so there is nothing to carry on from.
      toast('Drawn against the traffic, so it was built the other way round.', 'warning');
      this.start = null;
      this.control = null;
      return;
    }
    const last = result.nodes[result.nodes.length - 1];
    const node = last === undefined ? undefined : net.getNode(last);
    if (!node) {
      this.start = null;
      this.control = null;
      return;
    }
    const carry = endState(draft.cubic);
    this.start = {
      anchor: { kind: 'node', id: last },
      pos: { ...node.pos },
      dir: carry.dir,
      slope: carry.slope,
      ref: carry.dir,
    };
    this.control = null;
  }

  private paintAt(e: ToolPointer): void {
    const { net, settings } = this.ctx;
    const hit = pickRoad(this.ctx, e);
    if (!hit || this.painted.has(hit.segmentId)) return;
    // Upgrade never turns track into road or road into track.
    const isRail = (id: string) => net.roadType(id)?.category === 'rail';
    if (isRail(net.getSegment(hit.segmentId)!.roadType) !== isRail(settings.roadType)) return;
    const id = upgradeSegment(net, hit.segmentId, settings.roadType, false);
    this.painted.add(hit.segmentId);
    this.painted.add(id);
  }

  // -------------------------------------------------------------------------
  // Showing the state
  // -------------------------------------------------------------------------

  /** Recompute the snap and ghost from the last pointer position. */
  refresh(): void {
    const { settings } = this.ctx;
    if (settings.drawMode === 'upgrade') {
      this.refreshUpgrade();
      return;
    }
    const e = this.pointer;
    if (!e) {
      this.showStart();
      return;
    }
    this.hit = this.snapAt(e);
    if (!this.hit) {
      this.draft = null;
      this.ctx.view.setPreview([]);
      this.ctx.setMarks([]);
      this.ctx.setHud(null);
      return;
    }
    if (!this.start) {
      this.draft = null;
      this.showStart();
    } else if (this.stage === 'control') {
      this.draft = null;
      this.showControl(e);
    } else {
      this.draft = this.buildDraft(this.hit, e.ctrl);
      this.showDraft(e);
    }
  }

  private snapMarks(hit: SnapHit): ToolMark[] {
    const marks: ToolMark[] = [];
    const color = hit.kind === 'free' ? COLORS.neutral : COLORS.snap;
    marks.push({ kind: 'ring', pos: hit.pos, color, radius: hit.kind === 'node' ? 6 : 3 });
    marks.push({ kind: 'point', pos: hit.pos, color, radius: 1 });
    if (hit.guide) {
      marks.push({ kind: 'line', points: [hit.guide.from, hit.guide.to], color: COLORS.guide, width: 0.4, dashed: true });
    }
    return marks;
  }

  private snapLabel(hit: SnapHit): string {
    switch (hit.kind) {
      case 'node':
        return 'Snap: node';
      case 'segment':
        return 'Snap: on road, splits it';
      case 'angle':
        return 'Snap: angle guide';
      case 'length':
        return 'Snap: length';
      case 'angleLength':
        return 'Snap: angle and length';
      case 'grid':
        return 'Snap: grid point';
      case 'gridLine':
        return 'Snap: grid line';
      default:
        return 'No snap';
    }
  }

  private elevationLine(hit: SnapHit | null): string {
    const y = hit ? hit.pos.y : this.ctx.settings.elevation;
    const elevation = formatElevation(Math.round(y * 10) / 10);
    return this.gridSpacing === null ? elevation : `${elevation} · Grid ${formatSpacing(this.gridSpacing)}`;
  }

  /** Spacing grid snapping uses at the current zoom, for the readout. Null with the grid off. */
  gridSpacing: number | null = null;

  /** The optional grid at this zoom: subdivisions follow what is drawn (grid.ts). */
  private gridQuery(e: ToolPointer): { grid: GridSettings | null; gridMetresPerPixel: number } {
    const { view, settings } = this.ctx;
    if (!settings.grid.enabled) {
      this.gridSpacing = null;
      return { grid: null, gridMetresPerPixel: 0 };
    }
    const mpp = groundPixelSize(view, e.x, e.y, settings.elevation);
    const grid = snapGridAt(settings.grid, mpp);
    this.gridSpacing = grid.spacing;
    return { grid, gridMetresPerPixel: mpp };
  }

  private showStart(): void {
    const hit = this.hit;
    this.ctx.view.setPreview([]);
    if (!hit) {
      this.ctx.setMarks([]);
      this.ctx.setHud(null);
      return;
    }
    const lane = this.laneChoiceFor(hit);
    const marks = lane ? this.laneMarks(lane) : this.snapMarks(hit);
    this.ctx.setMarks(marks);
    const e = this.pointer!;
    this.ctx.setHud({
      x: e.x,
      y: e.y,
      lines: [this.elevationLine(hit), lane ? this.laneLabel(lane) : this.snapLabel(hit)],
      notes: [lane ? 'Click to start a ramp from this lane. Ctrl snaps to the centreline' : 'Click to start the road'],
      tone: 'ok',
    });
  }

  /** Snap points on every lane, the outermost ones larger, and the chosen lane's ramp start. */
  private laneMarks(lane: LaneChoice): ToolMark[] {
    const marks: ToolMark[] = [];
    for (const s of lane.lanes) {
      const outer = s.fromEdge === 0;
      marks.push({ kind: 'point', pos: s.centre, color: outer ? COLORS.snap : COLORS.guide, radius: outer ? 1.1 : 0.6 });
      if (outer) marks.push({ kind: 'ring', pos: s.centre, color: COLORS.snap, radius: 1.8 });
    }
    const c = lane.chosen;
    marks.push({ kind: 'ring', pos: c.centre, color: COLORS.ok, radius: 2.4 });
    marks.push({ kind: 'point', pos: c.edge, color: COLORS.ok, radius: 1 });
    // Which way the lane's traffic runs, from the ramp start.
    const tip = addScaled(c.edge, c.travel, 14);
    const r = { x: -c.travel.z, y: 0, z: c.travel.x };
    marks.push({ kind: 'line', points: [c.edge, tip], color: COLORS.ok, width: 0.45 });
    marks.push({
      kind: 'line',
      points: [addScaled(addScaled(tip, c.travel, -3), r, 2), tip, addScaled(addScaled(tip, c.travel, -3), r, -2)],
      color: COLORS.ok,
      width: 0.45,
    });
    return marks;
  }

  private laneLabel(lane: LaneChoice): string {
    const c = lane.chosen;
    const name = c.fromEdge === 0 ? 'outside lane' : `lane ${c.fromEdge + 1} in from the edge`;
    return `Snap: ${name}, ${c.fromEdge + 1} of ${c.count} lanes feed the ramp`;
  }

  private showControl(e: ToolPointer): void {
    const { view, settings } = this.ctx;
    const start = this.start!;
    const hit = this.hit!;
    const pos = this.constrainedControl(hit.pos, e.ctrl);
    const cubic = buildCubic('straight', { start: start.pos, end: pos }, null);
    view.setPreview([{ curves: [cubic], roadType: settings.roadType, state: 'ok' }]);
    const marks = this.snapMarks({ ...hit, pos });
    marks.push({ kind: 'line', points: [start.pos, pos], color: COLORS.guide, width: 0.3, dashed: true });
    this.ctx.setMarks(marks);
    this.ctx.setHud({
      x: e.x,
      y: e.y,
      lines: [`Length ${distXZ(start.pos, pos).toFixed(1)} m`, this.elevationLine(hit)],
      notes: [start.dir ? 'Click to set the curve, tangent kept. Ctrl frees it' : 'Click to set the curve'],
      tone: 'ok',
    });
  }

  private showDraft(e: ToolPointer): void {
    const { view, settings, net } = this.ctx;
    const draft = this.draft;
    const hit = this.hit!;
    const start = this.start!;
    if (!draft) return;
    const previews: RoadPreview[] = [{ curves: [draft.cubic], roadType: settings.roadType, state: draft.state }];
    view.setPreview(previews);
    const marks = this.snapMarks(hit);
    if (this.control) {
      marks.push({ kind: 'point', pos: this.control, color: COLORS.guide, radius: 1.2 });
      marks.push({ kind: 'line', points: [start.pos, this.control, hit.pos], color: COLORS.guide, width: 0.25, dashed: true });
    }
    for (const c of draft.crossings) {
      const bad = c.atGrade && c.clearance > 1.5;
      const color = bad ? COLORS.bad : c.atGrade ? COLORS.warn : COLORS.ok;
      marks.push({ kind: 'ring', pos: c.point, color, radius: 5 });
      if (!c.atGrade) marks.push({ kind: 'label', pos: c.point, text: `${c.clearance.toFixed(1)} m clear`, color });
    }
    for (const issue of draft.issues) {
      const color = issue.severity === 'error' ? COLORS.bad : COLORS.warn;
      if (issue.at) marks.push({ kind: 'point', pos: issue.at, color, radius: 1.5 });
      // The stretch that overlaps another road, in red along the draft.
      if (issue.stretch && issue.stretch.length > 1) {
        marks.push({ kind: 'line', points: issue.stretch.map((p) => ({ ...p, y: p.y + 0.5 })), color, width: 2.2 });
      }
    }
    const endLane = this.laneChoiceFor(hit);
    if (endLane) marks.push(...this.laneMarks(endLane));
    const def = net.roadType(settings.roadType);
    if (def && isOneWay(def)) {
      // Travel arrows, the way the road will be built.
      for (const pts of travelChevrons(draft.cubic)) {
        marks.push({ kind: 'line', points: pts, color: draft.flipped ? COLORS.warn : COLORS.neutral, width: 0.5 });
      }
    }
    this.ctx.setMarks(marks);
    const lines = formatReadout(readout(draft.cubic), hit.angle);
    lines.push(this.elevationLine(hit));
    const atGrade = draft.crossings.filter((c) => c.atGrade).length;
    const over = draft.crossings.length - atGrade;
    if (atGrade) lines.push(`Junctions: ${atGrade}`);
    if (over) lines.push(`Grade separated: ${over}`);
    const notes = draft.issues.map((i) => i.message);
    if (draft.flipped) notes.unshift('Drawn against the traffic: it will be built the other way round.');
    if (draft.startAttach || draft.endAttach) {
      const a = draft.startAttach ?? draft.endAttach!;
      lines.push(`Ramp lane: ${a.lane === 0 ? 'outside lane' : `${a.lane + 1} outer lanes`}`);
    }
    const oneWayNote = this.oneWayClash(draft);
    if (oneWayNote) notes.push(oneWayNote);
    this.ctx.setHud({ x: e.x, y: e.y, lines, notes, tone: draft.state });
  }

  /** A one-way drawn out of the entry of another one-way runs head to head. */
  private oneWayClash(draft: DraftState): string | null {
    const { net, settings } = this.ctx;
    const def = net.roadType(settings.roadType);
    if (!def || !isOneWay(def) || draft.start.kind !== 'node') return null;
    const node = net.getNode(draft.start.id);
    if (!node || node.segments.length !== 1) return null;
    const seg = net.getSegment(node.segments[0])!;
    if (!isOneWay(net.roadTypeOf(seg.id)) || seg.a !== node.id) return null;
    return 'Starts where a one-way road begins, so no traffic can reach it.';
  }

  private refreshUpgrade(): void {
    const { view, settings, net } = this.ctx;
    const e = this.pointer;
    this.hit = null;
    this.draft = null;
    view.setPreview([]);
    this.ctx.setMarks([]);
    if (!e) {
      view.setHighlight(null);
      this.ctx.setHud(null);
      return;
    }
    const hit = pickRoad(this.ctx, e);
    if (!hit) {
      view.setHighlight(null);
      this.ctx.setHud({ x: e.x, y: e.y, lines: ['Upgrade'], notes: ['Click or drag over roads'], tone: 'ok' });
      return;
    }
    view.setHighlight({ segments: [hit.segmentId], color: COLORS.snap });
    const now = net.roadTypeOf(hit.segmentId).name;
    const next = net.roadType(settings.roadType)?.name ?? settings.roadType;
    view.setPreview([{ curves: [net.cubicOf(hit.segmentId)], roadType: settings.roadType, state: 'ok' }]);
    this.ctx.setHud({ x: e.x, y: e.y, lines: [now, `to ${next}`], notes: [], tone: 'ok' });
  }
}

