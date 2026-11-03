/**
 * Roundabout: a live ghost follows the cursor. Over a junction it snaps there and
 * replaces it, over open ground it stands alone or cuts the roads it lands on.
 * Roads it would join are marked; a ghost that will not fit turns red and says why.
 * Clicking an existing roundabout selects it, so the wheel, the panel or the keys
 * change it in place, and Delete removes it. Each build or change is one undo step.
 */
import { clamp } from '../core/math';
import {
  buildRoundabout,
  findRoundabouts,
  isRingNode,
  planRoundabout,
  RADIUS_MAX,
  RADIUS_MIN,
  removeRoundabout,
  roundaboutAt,
  roundaboutOfSegment,
  ringTypeId,
  updateProblems,
  updateRoundabout,
  type Roundabout,
  type RoundaboutPlan,
} from '../core/roundabout';
import { totalHalfWidth } from '../core/roadTypes';
import { isFreeFlowNode } from '../core/signals';
import type { Id, Vec3 } from '../core/types';
import type { NetworkChange } from '../core/RoadNetwork';
import type { ToolMark } from '../render/api';
import { castRay, chooseHit, isJunctionNode, metresPerPixel, pickNode } from './pick';
import { Tool } from './Tool';
import { MOD_KEY } from './platform';
import { COLORS, type ToolId, type ToolKey, type ToolPointer } from './types';

/** Wheel travel per metre of radius. A mouse notch is about 100. */
const WHEEL_PER_METRE = 50;

export class RoundaboutTool extends Tool {
  readonly id: ToolId = 'roundabout';
  private plan: RoundaboutPlan | null = null;
  private hoverRing: Roundabout | null = null;
  /** A ring segment of the selected roundabout. Ring ids survive edits. */
  private selectedSeg: Id | null = null;
  private wheelAcc = 0;
  private lastProblem: string | null = null;

  get selection(): Roundabout | null {
    return this.selectedSeg === null ? null : roundaboutOfSegment(this.ctx.net, this.selectedSeg);
  }

  /** The current plan, for tests and the panel. */
  get currentPlan(): RoundaboutPlan | null {
    return this.plan;
  }

  private locate(e: ToolPointer): void {
    const { net, view, settings } = this.ctx;
    this.plan = null;
    this.hoverRing = null;
    const top = chooseHit(castRay(this.ctx, e), () => true);
    const ground = top?.point ?? view.pickPlane(e.x, e.y, 0);
    if (!ground) return;
    const ring = roundaboutAt(net, ground, 2 * metresPerPixel(this.ctx, e, ground.y));
    if (ring) {
      this.hoverRing = ring;
      return;
    }
    const node = pickNode(this.ctx, e, (id) => isJunctionNode(net, id) && !isRingNode(net, id));
    const centre: Vec3 = node !== null ? { ...net.getNode(node)!.pos } : { x: ground.x, y: 0, z: ground.z };
    const plan = planRoundabout(net, centre, settings.roundabout, node);
    if (node !== null && isFreeFlowNode(net, node)) {
      plan.ok = false;
      plan.reasons.unshift('Highway merges and splits are free-flow. A roundabout cannot go here.');
    }
    this.plan = plan;
  }

  private show(e: ToolPointer | null): void {
    const { net, view, settings } = this.ctx;
    const marks: ToolMark[] = [];
    const sel = this.selection;
    // A thin dashed outline just outside the ring: no fill over a roundabout being edited.
    const ringMark = (rb: Roundabout, color: string) => {
      const r = rb.radius + totalHalfWidth(net.roadTypeOf(rb.segments[0])) + 2;
      const points = Array.from({ length: 73 }, (_, i) => {
        const a = (i / 72) * Math.PI * 2;
        return { x: rb.centre.x + Math.cos(a) * r, y: rb.centre.y, z: rb.centre.z + Math.sin(a) * r };
      });
      marks.push({ kind: 'line', points, color, width: 0.5, dashed: true });
    };
    if (sel) ringMark(sel, COLORS.neutral);
    view.setPreview([]);
    if (this.hoverRing && this.hoverRing !== sel && this.hoverRing.segments[0] !== sel?.segments[0]) ringMark(this.hoverRing, COLORS.snap);
    const p = this.plan;
    if (p) {
      const color = p.ok ? COLORS.ok : COLORS.bad;
      view.setPreview([{ curves: p.ring, roadType: ringTypeId(p.params.lanes), state: p.ok ? 'ok' : 'error' }]);
      for (const arm of p.arms) {
        const out = { x: Math.cos(arm.phi), y: 0, z: Math.sin(arm.phi) };
        const far = { x: arm.pos.x + out.x * 16, y: arm.pos.y, z: arm.pos.z + out.z * 16 };
        marks.push({ kind: 'line', points: [arm.pos, far], color, width: Math.max(1.2, arm.halfWidth * 0.5) });
        marks.push({ kind: 'point', pos: arm.pos, color, radius: 1.6 });
      }
      marks.push({ kind: 'point', pos: p.centre, color, radius: 1 });
    }
    this.ctx.setMarks(marks);
    if (!e) return;
    const r = settings.roundabout;
    const lanes = `${r.lanes} lane${r.lanes > 1 ? 's' : ''}`;
    if (this.hoverRing && (!sel || this.hoverRing.segments[0] !== sel.segments[0])) {
      const h = this.hoverRing;
      this.ctx.setHud({
        x: e.x,
        y: e.y,
        lines: ['Roundabout', `${Math.round(h.radius)} m radius, ${h.lanes} lane${h.lanes > 1 ? 's' : ''}, ${h.arms.length} arms`],
        notes: ['Click to edit it'],
        tone: 'ok',
      });
      return;
    }
    if (sel && this.hoverRing) {
      this.ctx.setHud({
        x: e.x,
        y: e.y,
        lines: ['Editing roundabout', `${Math.round(sel.radius)} m radius, ${sel.lanes} lane${sel.lanes > 1 ? 's' : ''}`],
        notes: [this.lastProblem ?? 'Wheel or [ ] radius. Delete removes it. Right click lets go'],
        tone: this.lastProblem ? 'warning' : 'ok',
      });
      return;
    }
    if (p) {
      const what = p.arms.length === 0 ? 'Standalone' : `Joins ${p.arms.length} road${p.arms.length > 1 ? 's' : ''}`;
      this.ctx.setHud({
        x: e.x,
        y: e.y,
        lines: ['Roundabout', `${Math.round(p.params.radius)} m radius, ${lanes}`, what],
        notes: p.ok ? [`Click to build. Wheel changes radius, ${MOD_KEY}+wheel zooms`] : p.reasons,
        tone: p.ok ? 'ok' : 'error',
      });
      return;
    }
    this.ctx.setHud({ x: e.x, y: e.y, lines: ['Roundabout'], notes: ['Move over a junction or open ground'], tone: 'ok' });
  }

  private refresh(): void {
    if (this.pointer) this.locate(this.pointer);
    this.show(this.pointer);
  }

  activate(): void {
    this.refresh();
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    this.locate(e);
    this.show(e);
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    this.locate(e);
    const { net, history, settings } = this.ctx;
    if (this.hoverRing) {
      this.select(this.hoverRing);
      return;
    }
    const p = this.plan;
    if (!p) return;
    if (!p.ok) {
      this.ctx.toast(p.reasons[0] ?? 'A roundabout does not fit here.', 'warning');
      return;
    }
    history.hint(p.arms.length ? 'Build roundabout' : 'Place roundabout');
    const rb = net.batch(() => buildRoundabout(net, p));
    this.selectedSeg = null;
    if (rb) {
      // Leave it unselected, so the next click can build another. Keep the settings.
      settings.roundabout = { ...p.params };
    }
    this.refresh();
    this.ctx.changed();
  }

  /** Select a roundabout and load its settings into the panel. */
  select(rb: Roundabout): void {
    this.selectedSeg = rb.segments[0];
    this.lastProblem = null;
    this.ctx.settings.roundabout = {
      radius: Math.round(rb.radius),
      lanes: rb.lanes,
      speedKmh: rb.speedKmh,
      priority: rb.priority,
    };
    this.show(this.pointer);
    this.ctx.changed();
  }

  deselect(): boolean {
    if (this.selectedSeg === null) return false;
    this.selectedSeg = null;
    this.lastProblem = null;
    this.refresh();
    this.ctx.changed();
    return true;
  }

  /** Apply the panel's settings to the selected roundabout. Returns why not, or []. */
  private applyToSelection(): string[] {
    const sel = this.selection;
    if (!sel) return [];
    const { net, history, settings } = this.ctx;
    const problems = updateProblems(net, sel, settings.roundabout);
    if (problems.length) {
      this.lastProblem = problems[0];
      return problems;
    }
    this.lastProblem = null;
    history.hint('Change roundabout', `roundabout-${this.selectedSeg}`);
    updateRoundabout(net, sel, settings.roundabout);
    return [];
  }

  deleteSelected(): void {
    const sel = this.selection;
    if (!sel) return;
    this.ctx.history.hint('Remove roundabout');
    removeRoundabout(this.ctx.net, sel);
    this.selectedSeg = null;
    this.refresh();
    this.ctx.changed();
  }

  /** Change the radius by `metres`, on the selection if there is one. */
  stepRadius(metres: number): void {
    const s = this.ctx.settings.roundabout;
    const next = clamp(Math.round(s.radius + metres), RADIUS_MIN, RADIUS_MAX);
    if (next === s.radius) return;
    const before = s.radius;
    s.radius = next;
    if (this.selection && this.applyToSelection().length) {
      // Keep what is built; say why in the readout.
      s.radius = before;
    }
    this.refresh();
    this.ctx.changed();
  }

  wheel(delta: number, e: ToolPointer): boolean {
    if (e.ctrl) return false;
    this.pointer = e;
    this.wheelAcc -= delta;
    const steps = Math.trunc(this.wheelAcc / WHEEL_PER_METRE);
    if (steps !== 0) {
      this.wheelAcc -= steps * WHEEL_PER_METRE;
      this.stepRadius(steps);
    }
    return true;
  }

  settingsChanged(): void {
    if (this.selection) {
      const problems = this.applyToSelection();
      if (problems.length) this.ctx.toast(problems[0], 'warning');
    }
    this.refresh();
  }

  keyDown(e: ToolKey): boolean {
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection) {
      this.deleteSelected();
      return true;
    }
    if (e.key === '[' || e.key === ']') {
      this.stepRadius(e.key === ']' ? 2 : -2);
      return true;
    }
    return false;
  }

  back(): boolean {
    return this.deselect();
  }

  networkChanged(change: NetworkChange): void {
    if (change.reset && this.selectedSeg !== null && !this.selection) this.selectedSeg = null;
    if (this.selectedSeg !== null && !this.ctx.net.getSegment(this.selectedSeg)) this.selectedSeg = null;
    this.refresh();
  }

  deactivate(): void {
    this.plan = null;
    this.hoverRing = null;
    this.selectedSeg = null;
    this.wheelAcc = 0;
  }

  /** Roundabouts in the network, for the panel. */
  count(): number {
    return findRoundabouts(this.ctx.net).length;
  }
}
