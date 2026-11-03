/**
 * The road tool: Straight, Curved, Freeform and Upgrade.
 *
 * A placement walks through stages: pick a start, for Curved pick a control, then
 * pick an end. Placing continues from the new end. Right click steps back one
 * stage at a time.
 */
import { cubicPoint, type Cubic } from '../core/bezier';
import type { CrossingInfo, DraftIssue, RoadAnchor } from '../core/RoadNetwork';
import { addScaled, clamp, distXZ, dotXZ, normalizeXZ, sub } from '../core/math';
import { isOneWay } from '../core/roadTypes';
import { ELEVATION_STEP, hasTerrainEdits, MAX_ELEVATION, MIN_ELEVATION, surfaceLevel, terrainEditDelta } from '../core/terrain';
import { followTerrain, pickGround, roadBed } from './terrainFollow';
import type { Id, RampAttach, Vec3 } from '../core/types';
import type { RoadPreview, ToolMark } from '../render/api';
import { buildCubic, endState, formatReadout, readout, usableEndDir } from './draft';
import { castRay, chooseHit, nodesNearRay, pickRoad } from './pick';
import { upgradeSegment } from './roadOps';
import { groundPixelSize, snapGridAt, type GridSettings } from './grid';
import { parallelDistanceInfo, type GuideContext } from './guides';
import { formatSpacing } from '../render/gridLevels';
import { continuationAt, NODE_CATCH, referenceDirection, snapRoadPoint, type SnapHit } from './snap';
import { attachFor, flipAttach, laneChoiceAt, reverseCubic, travelChevrons, type LaneChoice } from './laneSnap';
import { drawChain } from '../core/curveChain';
import type { FitResult } from '../core/curveFit';
import { chainLines, chainReadout, checkChain, fitDraft, reverseChain } from './curveDraft';
import { Tool } from './Tool';
import { MOD_KEY } from './platform';
import { applyBarriers, applyStructure, barriersFromSettings, drawOverrides, structureFromSettings } from './wallOps';
import { isEarthwork, mirrorStructure, structureFootprint } from '../core/walls';
import { BARRIER_KINDS, STRUCTURE_MODES } from '../core/wallTypes';
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
  /** The first piece. A fitted curve has more, in `cubics`. */
  cubic: Cubic;
  /** Every piece, start to end. Curved and Freeform fit a chain (core/curveFit.ts). */
  cubics: Cubic[];
  /** The fitted alignment behind `cubics`, when there is one. */
  fit?: FitResult | null;
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
  /** Outer edge of an embankment or cut on each side, for the preview. */
  footprint?: { left: Vec3[]; right: Vec3[] };
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
      this.sweepFrom = null;
      this.sweepDir = null;
      this.sweepPending = null;
      const what = this.ctx.settings.walls.upgrade;
      this.ctx.history.begin(what === 'barriers' ? 'Add sound barriers' : what === 'structure' ? 'Change road structure' : 'Upgrade road');
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
      // A click with no sweep paints what it pressed, the road's own way round.
      if (this.sweepPending !== null) this.paintWallOn(this.sweepPending);
      this.sweepPending = null;
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

  usesElevationKeys(): boolean {
    return this.ctx.settings.drawMode !== 'upgrade';
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
    if (e.key === 'Shift') {
      // Shift locks the current guide direction while held.
      if (this.pointer) this.pointer = { ...this.pointer, shift: true };
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
    if (e.key === 'Shift') {
      if (this.pointer) this.pointer = { ...this.pointer, shift: false };
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
    // On landscaped land the elevation is above the ground under the cursor (terrainFollow.ts).
    const landscaped = hasTerrainEdits();
    const raw = (landscaped ? pickGround(this.ctx, e, settings.elevation) : null) ?? view.pickPlane(e.x, e.y, settings.elevation);
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
    if (!picks.length) picks.push({ level: raw.y, pos: raw });
    const start = this.start;
    const ignoreNodes = start?.anchor.kind === 'node' ? [start.anchor.id] : [];
    let ref: Vec3 | null = null;
    if (start) ref = start.dir ?? start.ref;
    const hit = snapRoadPoint(net, {
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
      guides: this.guideContext(e, start?.anchor ?? null),
    });
    if (hit && landscaped && hit.anchor.kind === 'free' && terrainEditDelta(hit.pos.x, hit.pos.z) !== 0) {
      // A free end stands on the landscaped ground where it snapped, not where the cursor ray met it.
      const pos = { ...hit.pos, y: clamp(roadBed(hit.pos.x, hit.pos.z) + settings.elevation, MIN_ELEVATION, MAX_ELEVATION) };
      return { ...hit, pos, anchor: { kind: 'free', pos: { ...pos } } };
    }
    return hit;
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
    const above = hasTerrainEdits() ? hit.pos.y - surfaceLevel(hit.pos.x, hit.pos.z) : hit.pos.y;
    if (hit.anchor.kind !== 'free' && Math.abs(above) > 1) {
      this.ctx.settings.elevation = clamp(
        Math.round(above / ELEVATION_STEP) * ELEVATION_STEP,
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
    // Curved and Freeform fit tangents, spirals and an arc, as a chain of pieces.
    // A parallel guide gives the exact offset shape (guides.ts).
    const follow = !ctrl && mode !== 'curved' && !startLane && !endLane ? (hit.guides?.cubic ?? null) : null;
    const fit =
      mode === 'straight' || follow
        ? null
        : fitDraft(
            net,
            {
              start: start.pos,
              end: endPos,
              startDir: mode === 'curved' ? null : startDir,
              endDir: usableEndDir(start.pos, endPos, endDir) ? endDir : null,
              startSlope: ctrl ? null : start.slope,
              endSlope,
              control: mode === 'curved' ? this.control : null,
            },
            settings.roadType,
          );
    const plan = follow ? [follow] : fit && fit.cubics.length ? fit.cubics : [cubic];
    // On landscaped land the road follows the ground within its grade, bridging what it cannot follow.
    const category = net.roadType(settings.roadType)?.category;
    const chain = followTerrain(plan, { elevation: settings.elevation, grade: category === 'highway' || category === 'rail' ? 0.06 : 0.09 });
    const evaluate = (cs: Cubic[], a: RoadAnchor, b: RoadAnchor, sa: RampAttach | undefined, ea: RampAttach | undefined, flipped: boolean): DraftState => {
      const c = cs[0];
      if (cs.length > 1 || fit) {
        const check = checkChain(net, cs, a, b, settings.roadType, sa, ea, fit);
        return { cubic: c, cubics: cs, fit, start: a, end: b, ...check, startAttach: sa, endAttach: ea, flipped };
      }
      const params = { start: a, end: b, c1: c.p1, c2: c.p2, roadType: settings.roadType, startAttach: sa, endAttach: ea };
      const issues = net.validateDraft(params);
      const ignore = [a, b].flatMap((x) => (x.kind === 'node' ? [x.id] : []));
      const crossings = net.findCrossings(c, ignore, settings.roadType).filter((x) => !this.isEndHit(x, c, a, b));
      const state: Tone = issues.some((i) => i.severity === 'error') ? 'error' : issues.length ? 'warning' : 'ok';
      return { cubic: c, cubics: cs, start: a, end: b, issues, crossings, state, startAttach: sa, endAttach: ea, flipped };
    };
    const drawn = evaluate(chain, start.anchor, hit.anchor, startAttach, endAttach, false);
    const def = net.roadType(settings.roadType);
    if (def && isOneWay(def) && drawn.issues.some((i) => i.code === 'wrongWay')) {
      // Drawn against the traffic it meets: the same road the other way round may work.
      const back = chain.length > 1 ? reverseChain(chain) : [reverseCubic(chain[0])];
      const flipped = evaluate(back, hit.anchor, start.anchor, flipAttach(endAttach), flipAttach(startAttach), true);
      if (!flipped.issues.some((i) => i.code === 'wrongWay')) return flipped;
    }
    return drawn;
  }

  /** Embankments and cuts take ground beside the road: check it and outline it. */
  private withFootprint(draft: DraftState | null): DraftState | null {
    if (!draft) return draft;
    const { net, settings } = this.ctx;
    const spec = structureFromSettings(settings.walls);
    if (!isEarthwork(spec.mode)) return draft;
    const ignoreSegments = [draft.start, draft.end].flatMap((a) => (a.kind === 'segment' ? [a.id] : []));
    const ignoreNodes = [draft.start, draft.end].flatMap((a) => (a.kind === 'node' ? [a.id] : []));
    const left: Vec3[] = [];
    const right: Vec3[] = [];
    const issues = [...draft.issues];
    for (const cubic of draft.cubics) {
      const f = structureFootprint(net, { cubic, roadType: settings.roadType, structure: draft.flipped ? mirrorStructure(spec) : spec, ignoreSegments, ignoreNodes });
      left.push(...f.left);
      right.push(...f.right);
      for (const i of f.issues) if (!issues.some((x) => x.code === i.code && x.severity === i.severity)) issues.push(i);
    }
    const state: Tone = issues.some((i) => i.severity === 'error') ? 'error' : issues.length ? 'warning' : 'ok';
    return { ...draft, issues, state, footprint: { left, right } };
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
    // A fitted curve is several pieces joined by plain joints, drawn as one step.
    const result = drawChain(net, {
      start: draft.start,
      end: draft.end,
      cubics: draft.cubics,
      roadType: settings.roadType,
      startAttach: draft.startAttach,
      endAttach: draft.endAttach,
      overrides: this.drawnOverrides(draft),
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
    const carry = endState(draft.cubics[draft.cubics.length - 1]);
    this.start = {
      anchor: { kind: 'node', id: last },
      pos: { ...node.pos },
      dir: carry.dir,
      slope: carry.slope,
      ref: carry.dir,
    };
    this.control = null;
  }

  /** The structure the road panel asks for, sides swapped when the road is built the other way. */
  private drawnOverrides(draft: DraftState) {
    const o = drawOverrides(this.ctx.settings.walls);
    if (o?.structure && draft.flipped) o.structure = mirrorStructure(o.structure);
    return o;
  }

  /** Last drag position on the ground, so Upgrade's left and right follow the sweep. */
  private sweepFrom: Vec3 | null = null;

  /** The segment under the press, held until the sweep shows which way it runs. */
  private sweepPending: Id | null = null;
  private sweepDir: Vec3 | null = null;

  /** Upgrade painting structure or barriers: left and right are as swept. */
  private paintWalls(e: ToolPointer): void {
    const hit = pickRoad(this.ctx, e);
    const ground = this.ctx.view.pickPlane(e.x, e.y, hit?.point.y ?? 0);
    if (ground && this.sweepFrom && distXZ(ground, this.sweepFrom) > 1.5) {
      this.sweepDir = sub(ground, this.sweepFrom);
      this.sweepFrom = ground;
    } else if (ground && !this.sweepFrom) {
      this.sweepFrom = ground;
    }
    if (!this.sweepDir) {
      // No direction yet: remember what was pressed, and paint it once there is one.
      if (hit && this.sweepPending === null) this.sweepPending = hit.segmentId;
      return;
    }
    if (this.sweepPending !== null) {
      this.paintWallOn(this.sweepPending);
      this.sweepPending = null;
    }
    if (hit) this.paintWallOn(hit.segmentId);
  }

  private paintWallOn(id: Id): void {
    const { net, settings, toast } = this.ctx;
    if (!net.getSegment(id) || this.painted.has(id)) return;
    this.painted.add(id);
    // Left and right follow the sweep. A click on its own takes the road's own way.
    let flipped = false;
    if (this.sweepDir) {
      const t = net.cubicOf(id);
      flipped = dotXZ(this.sweepDir, sub(t.p3, t.p0)) < 0;
    }
    if (settings.walls.upgrade === 'barriers') {
      applyBarriers(net, id, barriersFromSettings(settings.walls), flipped);
    } else {
      const problem = applyStructure(net, id, structureFromSettings(settings.walls), flipped);
      if (problem) toast(problem.message, 'error');
    }
  }

  private paintAt(e: ToolPointer): void {
    const { net, settings } = this.ctx;
    if (settings.walls.upgrade !== 'road') {
      this.paintWalls(e);
      return;
    }
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
      this.draft = this.withFootprint(this.buildDraft(this.hit, e.ctrl));
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
    if (hit.guides) marks.push(...hit.guides.marks);
    return marks;
  }

  private snapLabel(hit: SnapHit): string {
    switch (hit.kind) {
      case 'node':
        return 'Snap: node';
      case 'segment':
        return hit.guides ? `On road: ${hit.guides.label}` : 'Snap: on road, splits it';
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
      case 'guide':
        return hit.guides?.label ?? 'Guide';
      default:
        return 'No snap';
    }
  }

  private elevationLine(hit: SnapHit | null): string {
    const y = hit ? hit.pos.y : this.ctx.settings.elevation;
    // On landscaped land: height above the ground, then the absolute height.
    const above = hit && hasTerrainEdits() && terrainEditDelta(hit.pos.x, hit.pos.z) !== 0 ? Math.round((y - surfaceLevel(hit.pos.x, hit.pos.z)) * 10) / 10 : null;
    const elevation = above === null ? formatElevation(Math.round(y * 10) / 10) : `${formatElevation(above)}${above === 0 ? '' : ' from ground'} · ${y.toFixed(1)} m`;
    return this.gridSpacing === null ? elevation : `${elevation} · Grid ${formatSpacing(this.gridSpacing)}`;
  }

  /** Shift held while drawing: the direction locked to (guides.ts). */
  private lockDir: Vec3 | null = null;

  /** Smart guides for this cursor, with Shift locking the current direction. */
  private guideContext(e: ToolPointer, fromAnchor: RoadAnchor | null): GuideContext | null {
    const { view, settings } = this.ctx;
    const start = this.start;
    if (!e.shift || !start) this.lockDir = null;
    else if (!this.lockDir && this.hit) {
      const draft = sub(this.hit.pos, start.pos);
      let dir = this.hit.guides?.dir ?? (Math.hypot(draft.x, draft.z) > 1e-6 ? normalizeXZ(draft) : null);
      if (dir && dir.x * draft.x + dir.z * draft.z < 0) dir = { x: -dir.x, y: 0, z: -dir.z };
      this.lockDir = dir;
    }
    const g = settings.guides;
    if (!this.lockDir && !Object.values(g).some(Boolean)) return null;
    const mpp = groundPixelSize(view, e.x, e.y, settings.elevation);
    return {
      toggles: g,
      mpp,
      roadType: settings.roadType,
      grid: settings.grid.enabled ? settings.grid : null,
      snapGrid: settings.grid.enabled ? snapGridAt(settings.grid, mpp) : null,
      lock: this.lockDir,
      fromAnchor,
    };
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
      notes: [lane ? `Click to start a ramp from this lane. ${MOD_KEY} snaps to the centreline` : 'Click to start the road'],
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
    const feeds = c.fromEdge === 0 ? 'it feeds the ramp' : `it and the ${c.fromEdge === 1 ? 'lane' : `${c.fromEdge} lanes`} outside it feed the ramp`;
    return `Snap: ${name}, ${feeds}`;
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
      notes: [start.dir ? `Click to set the curve, tangent kept. ${MOD_KEY} frees it` : 'Click to set the curve'],
      tone: 'ok',
    });
  }

  private showDraft(e: ToolPointer): void {
    const { view, settings, net } = this.ctx;
    const draft = this.draft;
    const hit = this.hit!;
    const start = this.start!;
    if (!draft) return;
    const previews: RoadPreview[] = [{ curves: draft.cubics, roadType: settings.roadType, state: draft.state }];
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
      // Clearance to whatever it passes over or under, red when there is not enough.
      const rail = c.overRail || this.ctx.net.roadType(settings.roadType)?.category === 'rail';
      if (!c.atGrade || bad) {
        const under = c.point.y > cubicPoint(draft.cubic, c.t).y;
        const what = c.overRail ? 'rail' : 'road';
        const text = rail ? `Clearance ${c.clearance.toFixed(1)} m ${under ? 'under' : 'over'} ${what}${bad ? `, needs ${c.required} m` : ''}` : `${c.clearance.toFixed(1)} m clear`;
        marks.push({ kind: 'label', pos: c.point, text, color });
      }
    }
    for (const issue of draft.issues) {
      const color = issue.severity === 'error' ? COLORS.bad : COLORS.warn;
      if (issue.at) marks.push({ kind: 'point', pos: issue.at, color, radius: 1.5 });
      // The stretch that overlaps another road, in red along the draft.
      if (issue.stretch && issue.stretch.length > 1) {
        marks.push({ kind: 'line', points: issue.stretch.map((p) => ({ ...p, y: p.y + 0.5 })), color, width: 2.2 });
      }
    }
    if (draft.footprint) {
      const color = draft.state === 'error' ? COLORS.bad : draft.state === 'warning' ? COLORS.warn : COLORS.guide;
      for (const side of [draft.footprint.left, draft.footprint.right]) {
        if (side.length > 1) marks.push({ kind: 'line', points: side.map((p) => ({ ...p, y: p.y + 0.3 })), color, width: 0.35, dashed: true });
      }
    }
    const endLane = this.laneChoiceFor(hit);
    if (endLane) marks.push(...this.laneMarks(endLane));
    const def = net.roadType(settings.roadType);
    if (def && isOneWay(def)) {
      // Travel arrows, the way the road will be built.
      for (const piece of draft.cubics) {
        for (const pts of travelChevrons(piece)) {
          marks.push({ kind: 'line', points: pts, color: draft.flipped ? COLORS.warn : COLORS.neutral, width: 0.5 });
        }
      }
    }
    this.ctx.setMarks(marks);
    // A fitted curve reads its radius from the true arc, not from the pieces.
    const chainInfo = draft.fit ? chainReadout(draft.cubics, draft.fit) : null;
    // A road split to follow landscaped ground reads as one: total length, tightest radius, steepest grade.
    const pieces = draft.cubics.map(readout);
    const whole = pieces.length > 1 ? { length: pieces.reduce((n, r) => n + r.length, 0), radius: Math.min(...pieces.map((r) => r.radius)), grade: Math.max(...pieces.map((r) => r.grade)) } : pieces[0];
    const lines = formatReadout(chainInfo ?? whole ?? readout(draft.cubic), hit.angle);
    if (chainInfo) lines.push(...chainLines(chainInfo));
    lines.push(this.elevationLine(hit));
    const parallelInfo = this.ctx.settings.guides.parallel && !e.ctrl ? parallelDistanceInfo(this.ctx.net, hit.pos, { pos: start.pos, ref: null }, start.anchor) : null;
    if (hit.guides?.label) lines.unshift(hit.guides.label);
    else if (parallelInfo) lines.push(parallelInfo);
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
    const what = settings.walls.upgrade;
    if (what !== 'road') {
      const label = (list: readonly { value: string; label: string }[], v: string) => list.find((o) => o.value === v)?.label ?? v;
      const seg = net.getSegment(hit.segmentId)!;
      const lines =
        what === 'barriers'
          ? [`Sound barriers: ${label(BARRIER_KINDS, settings.walls.barrier)}`, settings.walls.barrier === 'none' ? 'Removes them' : `${settings.walls.barrierHeight} m, ${settings.walls.barrierSides === 'both' ? 'both sides' : `${settings.walls.barrierSides} side`}`]
          : [`${label(STRUCTURE_MODES, seg.overrides.structure?.mode ?? 'auto')} to ${label(STRUCTURE_MODES, settings.walls.mode)}`];
      this.ctx.setHud({ x: e.x, y: e.y, lines, notes: ['Drag along roads. Left and right follow the sweep'], tone: 'ok' });
      return;
    }
    const now = net.roadTypeOf(hit.segmentId).name;
    const next = net.roadType(settings.roadType)?.name ?? settings.roadType;
    view.setPreview([{ curves: [net.cubicOf(hit.segmentId)], roadType: settings.roadType, state: 'ok' }]);
    this.ctx.setHud({ x: e.x, y: e.y, lines: [now, `to ${next}`], notes: [], tone: 'ok' });
  }
}

