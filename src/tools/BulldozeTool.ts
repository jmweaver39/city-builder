/**
 * Bulldoze. Over a road or track:
 *  - hover shows in red exactly what a click would take, with its length;
 *  - click takes the stretch between the junctions on either side, or a section
 *    round the cursor on a long one (the rule is in bulldozeSpan.ts);
 *  - drag along the road takes exactly the dragged stretch, cut clean at both ends;
 *  - Shift+click takes the whole connected road.
 * Endpoints and paint are removed by clicking them, or by sweeping a drag over
 * them that starts off the road. Every click or drag is one undo step.
 */
import type { Id } from '../core/types';
import {
  clickSpan,
  dragSpan,
  projectOnLine,
  railBefore,
  railMessages,
  removeSpan,
  roadLine,
  segmentsLength,
  spanCurves,
  spanCuts,
  spanLength,
  trimStations,
  type RoadLine,
  type Span,
} from './bulldozeSpan';
import { pickDecal, pickEndpoint, pickNodeHit, pickRoad } from './pick';
import { hitLabel, hitOutline, markingAt, removeAutoItem, type MarkingHit } from './markingOps';
import { pickQuay, quayOutline } from './QuayTool';
import { connectedRoad } from './roadOps';
import { pruneZones, syncAllZoneAccess } from './zoneOps';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolKey, type ToolPointer } from './types';
import type { RoadPreview, ToolMark } from '../render/api';

export type BulldozeTarget =
  | { kind: 'segment'; id: Id; t: number }
  | { kind: 'endpoint'; id: Id }
  | { kind: 'decal'; id: Id }
  | { kind: 'quay'; id: Id }
  /** One marking: hand-placed, or one automatic crosswalk, stop line, arrow, guide or gore. */
  | { kind: 'marking'; hit: MarkingHit };

/** Sweep samples per this many pixels, so a fast drag misses nothing. */
const SWEEP_STEP_PX = 6;
/** A press that moves further than this is a drag. */
const DRAG_PX = 6;
/** A drag cursor further than this from the road stops moving the cut. */
const DRAG_REACH = 40;

/** What will go: a stretch of road, or whole segments. */
type Plan = { kind: 'span'; span: Span } | { kind: 'whole'; segments: Id[] };

interface Press {
  start: ToolPointer;
  dragged: boolean;
  /** Set once the press, or the drag, is on a road. */
  line: RoadLine | null;
  from: number;
  /** Last line distance under the cursor. */
  to: number;
  /** A press that started off the road sweeps endpoints and paint. */
  sweeping: boolean;
  last: ToolPointer;
  /** The press opened an undo step at once, for markings and endpoints it removed. */
  ownStep: boolean;
}

const fmt = (m: number): string => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

export class BulldozeTool extends Tool {
  readonly id: ToolId = 'bulldoze';
  private press: Press | null = null;
  private removed = 0;
  private plan: Plan | null = null;

  private targetAt(e: Pick<ToolPointer, 'x' | 'y'>): BulldozeTarget | null {
    const ep = pickEndpoint(this.ctx, e, 7);
    if (ep !== null) return { kind: 'endpoint', id: ep };
    const decal = pickDecal(this.ctx, e);
    if (decal !== null) return { kind: 'decal', id: decal };
    const road = pickRoad(this.ctx, e);
    // A single marking under the cursor goes before the road it is painted on.
    const ground = road?.raw ?? pickNodeHit(this.ctx, e)?.point ?? null;
    if (ground) {
      const hit = markingAt(this.ctx.net, ground);
      if (hit) return { kind: 'marking', hit };
    }
    if (road) return { kind: 'segment', id: road.segmentId, t: road.t };
    const flat = this.ctx.view.pickPlane(e.x, e.y, 0);
    const quay = flat ? pickQuay(this.ctx.net, flat.x, flat.z) : null;
    if (quay !== null) return { kind: 'quay', id: quay };
    return null;
  }

  /** What a click with this pointer would remove. */
  planAt(e: ToolPointer): Plan | null {
    const target = this.targetAt(e);
    if (target?.kind !== 'segment') return null;
    if (e.shift) return { kind: 'whole', segments: connectedRoad(this.ctx.net, target.id) };
    return { kind: 'span', span: clickSpan(this.ctx.net, target.id, target.t) };
  }

  private planLength(plan: Plan): number {
    return plan.kind === 'span' ? spanLength(plan.span) : segmentsLength(this.ctx.net, plan.segments);
  }

  /** Red ghost over exactly what will go, and a line across each cut. */
  private showPlan(plan: Plan | null): void {
    const { net, view } = this.ctx;
    this.plan = plan;
    view.setHighlight(null);
    if (!plan) {
      view.setPreview([]);
      this.ctx.setMarks([]);
      return;
    }
    const byType = new Map<string, RoadPreview>();
    const curves =
      plan.kind === 'span'
        ? spanCurves(net, plan.span)
        : plan.segments.filter((id) => net.getSegment(id)).map((id) => ({ roadType: net.getSegment(id)!.roadType, cubic: net.cubicOf(id) }));
    for (const c of curves) {
      const p = byType.get(c.roadType) ?? { curves: [], roadType: c.roadType, state: 'error' as const };
      p.curves.push(c.cubic);
      byType.set(c.roadType, p);
    }
    view.setPreview([...byType.values()]);
    const marks: ToolMark[] = [];
    if (plan.kind === 'span') {
      for (const cut of spanCuts(net, plan.span)) {
        const rx = -cut.dir.z;
        const rz = cut.dir.x;
        const w = cut.halfWidth + 0.6;
        marks.push({
          kind: 'line',
          points: [
            { x: cut.pos.x - rx * w, y: cut.pos.y + 0.3, z: cut.pos.z - rz * w },
            { x: cut.pos.x + rx * w, y: cut.pos.y + 0.3, z: cut.pos.z + rz * w },
          ],
          color: COLORS.bad,
          width: 0.35,
        });
      }
    }
    this.ctx.setMarks(marks);
  }

  private nameOf(plan: Plan): string {
    const { net } = this.ctx;
    const id = plan.kind === 'span' ? plan.span.line.pieces[0]?.segmentId : plan.segments[0];
    return id !== undefined && net.getSegment(id) ? net.roadTypeOf(id).name : 'road';
  }

  private show(e: ToolPointer): void {
    const { net } = this.ctx;
    const press = this.press;
    if (press?.line && press.dragged) {
      const plan: Plan = { kind: 'span', span: dragSpan(net, press.line, press.from, press.to) };
      this.showPlan(plan);
      this.ctx.setHud({ x: e.x, y: e.y, lines: [`Remove ${fmt(this.planLength(plan))} of ${this.nameOf(plan)}`], notes: ['Release to cut it out'], tone: 'error' });
      return;
    }
    if (press?.sweeping) {
      this.showPlan(null);
      this.ctx.setHud({ x: e.x, y: e.y, lines: ['Bulldoze'], notes: ['Sweeping markings and endpoints'], tone: 'error' });
      return;
    }
    const target = this.targetAt(e);
    if (!target) {
      this.showPlan(null);
      this.ctx.setHud({ x: e.x, y: e.y, lines: ['Bulldoze'], notes: ['Click a road, track, marking or endpoint'], tone: 'ok' });
      return;
    }
    if (target.kind === 'segment') {
      const plan = this.planAt(e)!;
      this.showPlan(plan);
      const len = fmt(this.planLength(plan));
      const name = this.nameOf(plan);
      const lines = plan.kind === 'whole' ? [`Remove all ${len} of ${name}`] : [`Remove ${len} of ${name}`];
      const notes =
        plan.kind === 'whole'
          ? ['The whole connected road']
          : ['Junction to junction, or a 60 m section of a long road', 'Drag along it for an exact stretch; Shift for all of it'];
      this.ctx.setHud({ x: e.x, y: e.y, lines, notes, tone: 'error' });
      return;
    }
    this.showPlan(null);
    if (target.kind === 'marking') {
      const outline = hitOutline(net, target.hit);
      if (outline.length > 1) this.ctx.setMarks([{ kind: 'line', points: outline, color: COLORS.bad, width: 0.35 }]);
      this.ctx.setHud({ x: e.x, y: e.y, lines: [`Remove ${hitLabel(net, target.hit)}`], notes: target.hit.kind === 'auto' ? ['Only this one. Bring it back from the junction inspector'] : [], tone: 'error' });
      return;
    }
    if (target.kind === 'quay') {
      const q = net.quays.find((x) => x.id === target.id);
      if (q) {
        const o = quayOutline(q);
        this.ctx.setMarks([
          { kind: 'line', points: o.wall, color: COLORS.bad, width: 0.6 },
          { kind: 'line', points: o.back, color: COLORS.bad, width: 0.4, dashed: true },
        ]);
      }
    }
    const name =
      target.kind === 'endpoint' ? `Traffic ${net.endpoints.find((x) => x.id === target.id)?.kind ?? ''}` : target.kind === 'quay' ? 'Quay wall' : 'Marking';
    this.ctx.setHud({ x: e.x, y: e.y, lines: [`Remove ${name}`], notes: [], tone: 'error' });
  }

  private removeSmall(target: BulldozeTarget): void {
    const { net } = this.ctx;
    if (target.kind === 'endpoint' && net.endpoints.some((x) => x.id === target.id)) net.removeEndpoint(target.id);
    else if (target.kind === 'decal' && net.decals.some((x) => x.id === target.id)) net.removeDecal(target.id);
    else if (target.kind === 'quay' && net.quays.some((x) => x.id === target.id)) net.removeQuay(target.id);
    else if (target.kind === 'marking') {
      const hit = target.hit;
      if (hit.kind === 'user') {
        if (!net.markingsOf(hit.host).some((m) => m.id === hit.id)) return;
        net.removeMarking(hit.host, hit.id);
      } else removeAutoItem(net, hit.nodeId, hit.item.ref);
    } else return;
    this.removed++;
  }

  /** Carry out a plan as one undo step, then tidy what hung off the road. */
  private execute(plan: Plan, stepOpen = false): void {
    const { net, history } = this.ctx;
    const metres = this.planLength(plan);
    if (metres < 0.5) {
      if (stepOpen) history.end();
      return;
    }
    const rail = railBefore(net);
    if (!stepOpen) history.begin(`Bulldoze ${fmt(metres)} of ${this.nameOf(plan)}`);
    let trimmed: string[] = [];
    try {
      net.batch(() => {
        if (plan.kind === 'whole') {
          for (const id of plan.segments) if (net.getSegment(id)) net.removeSegment(id);
        } else {
          const report = removeSpan(net, plan.span);
          trimmed = trimStations(net, report.trimmed);
        }
        // Roads gone may have been some region's access, or its edge.
        if (net.project.zones?.length) {
          pruneZones(net);
          syncAllZoneAccess(net);
        }
      });
    } finally {
      history.end();
    }
    for (const message of railMessages(net, rail, trimmed)) this.ctx.toast(message, 'warning');
  }

  /** Where on the press's road line the cursor is, or the last good place. */
  private follow(e: ToolPointer): void {
    const press = this.press!;
    if (!press.line) return;
    const { net, view } = this.ctx;
    const y = net.cubicOf(press.line.pieces[0].segmentId).p0.y;
    const ground = view.pickPlane(e.x, e.y, y);
    if (!ground) return;
    const hit = projectOnLine(net, press.line, ground);
    if (hit.distance <= DRAG_REACH) press.to = hit.s;
  }

  /** Start a road drag at this point if it is on a road. */
  private grabLine(e: ToolPointer): boolean {
    const press = this.press!;
    const road = pickRoad(this.ctx, e);
    if (!road) return false;
    const line = roadLine(this.ctx.net, road.segmentId, true);
    press.line = line;
    press.sweeping = false;
    const hit = projectOnLine(this.ctx.net, line, road.point);
    press.from = hit.s;
    press.to = hit.s;
    return true;
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    const press = this.press;
    if (press) {
      if (!press.dragged && Math.hypot(e.x - press.start.x, e.y - press.start.y) > DRAG_PX) press.dragged = true;
      if (press.dragged) {
        if (press.line) this.follow(e);
        else if (press.sweeping) {
          const span = Math.hypot(e.x - press.last.x, e.y - press.last.y);
          const steps = Math.max(1, Math.ceil(span / SWEEP_STEP_PX));
          for (let i = 1; i <= steps; i++) {
            const k = i / steps;
            const at = { x: press.last.x + (e.x - press.last.x) * k, y: press.last.y + (e.y - press.last.y) * k };
            const target = this.targetAt(at);
            if (target && target.kind !== 'segment') this.removeSmall(target);
          }
        } else if (this.grabLine(e)) this.follow(e);
      }
      press.last = e;
    }
    this.show(e);
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    this.removed = 0;
    const target = this.targetAt(e);
    this.press = { start: e, dragged: false, line: null, from: 0, to: 0, sweeping: false, last: e, ownStep: false };
    if (target?.kind === 'segment') {
      this.grabLine(e);
    } else {
      // Markings and endpoints go at once; a drag from here sweeps more of them.
      this.press.sweeping = target !== null;
      this.press.ownStep = true;
      this.ctx.history.begin('Bulldoze');
      if (target) this.removeSmall(target);
    }
    this.show(e);
  }

  pointerUp(e: ToolPointer): void {
    const press = this.press;
    if (!press) return;
    this.press = null;
    if (press.line && press.dragged) {
      this.execute({ kind: 'span', span: dragSpan(this.ctx.net, press.line, press.from, press.to) }, press.ownStep);
    } else if (press.line) {
      const plan = this.planAt({ ...press.start, shift: e.shift || press.start.shift });
      if (plan) this.execute(plan, press.ownStep);
      else if (press.ownStep) this.ctx.history.end();
    } else if (press.ownStep) {
      this.ctx.history.end();
    }
    this.show(e);
  }

  keyDown(e: ToolKey): boolean {
    if (e.key === 'Shift' && this.pointer && !this.press) this.show({ ...this.pointer, shift: true });
    return false;
  }

  keyUp(e: ToolKey): boolean {
    if (e.key === 'Shift' && this.pointer && !this.press) this.show({ ...this.pointer, shift: false });
    return false;
  }

  /** Right click during a drag drops it. */
  back(): boolean {
    if (!this.press) return false;
    const press = this.press;
    this.press = null;
    if (press.ownStep) this.ctx.history.end();
    this.showPlan(null);
    return true;
  }

  networkChanged(): void {
    if (this.press?.line && !this.press.line.pieces.every((p) => this.ctx.net.getSegment(p.segmentId))) this.press = null;
  }

  deactivate(): void {
    if (this.press) {
      const press = this.press;
      this.press = null;
      if (press.ownStep) this.ctx.history.end();
    }
    this.plan = null;
  }
}
