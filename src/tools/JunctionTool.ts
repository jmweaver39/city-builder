/**
 * Traffic control. With a control card picked, one click applies it to a junction,
 * or to one arm for the sign cards, and the tool stays active so you can click down
 * a street. Hovering shows a ghost of the result. With 'inspect' (the Advanced
 * card), a click opens the junction's detailed editor instead.
 */
import { applyControl, armTargetFromRoad, CONTROL_CARDS, controlCard, controlGhost, planControl, type ControlPlan, type ControlTarget } from './junctionControl';
import { castRay, chooseHit, isJunctionNode, metresPerPixel, pickNode, pickRoad } from './pick';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolKey, type ToolPointer } from './types';
import type { Id } from '../core/types';
import type { NetworkChange } from '../core/RoadNetwork';

/** An arm click counts this far from the junction's edge, in metres or 60 px, whichever is more. */
const ARM_REACH_M = 18;
const ARM_REACH_PX = 60;

export class JunctionTool extends Tool {
  readonly id: ToolId = 'junction';
  private hover: Id | null = null;
  private selected: Id | null = null;
  private target: ControlTarget | null = null;
  private plan: ControlPlan | null = null;
  /** The last junction a card was applied to, for the readout. */
  private applied: ControlTarget | null = null;

  /** Where a click would apply: the junction, or one of its arms. */
  targetAt(e: ToolPointer): ControlTarget | null {
    const { net } = this.ctx;
    const node = chooseHit(castRay(this.ctx, e), (h) => h.kind === 'node' && isJunctionNode(net, h.id));
    if (node && node.miss === 0) return { nodeId: node.id, armSeg: null };
    const road = pickRoad(this.ctx, e);
    if (road) {
      const reach = Math.max(ARM_REACH_M, ARM_REACH_PX * metresPerPixel(this.ctx, e, road.point.y));
      const arm = armTargetFromRoad(net, road.segmentId, road.t, reach);
      if (arm) return arm;
    }
    return node ? { nodeId: node.id, armSeg: null } : null;
  }

  private get kind() {
    const k = this.ctx.settings.junctionControl;
    return k === 'inspect' ? null : k;
  }

  private updateTarget(e: ToolPointer): void {
    const kind = this.kind;
    this.target = kind ? this.targetAt(e) : null;
    this.plan = kind && this.target ? planControl(this.ctx.net, this.target, kind) : null;
  }

  private showCard(e: ToolPointer | null): void {
    const { net } = this.ctx;
    const kind = this.kind!;
    const card = controlCard(kind);
    const t = this.target;
    const p = this.plan;
    if (!t || !p) {
      this.ctx.setMarks([]);
      if (e) this.ctx.setHud({ x: e.x, y: e.y, lines: [card.name], notes: [card.perArm ? 'Click a junction, or one of its arms' : 'Click a junction'], tone: 'ok' });
      return;
    }
    if (!p.ok) {
      const node = net.getNode(t.nodeId);
      this.ctx.setMarks(node ? [{ kind: 'ring', pos: node.pos, color: COLORS.bad, radius: 6 }] : []);
      if (e) this.ctx.setHud({ x: e.x, y: e.y, lines: [card.name], notes: [p.reason], tone: 'warning' });
      return;
    }
    this.ctx.setMarks(controlGhost(net, t, p.control, p.summary));
    if (!e) return;
    const justDone = this.applied && this.applied.nodeId === t.nodeId && this.applied.armSeg === t.armSeg;
    this.ctx.setHud({
      x: e.x,
      y: e.y,
      lines: [card.name, p.summary],
      notes: [p.changed ? (t.armSeg !== null && card.perArm ? 'Click to apply to this arm' : 'Click to apply') : justDone ? 'Applied. Click the next junction' : 'Already set'],
      tone: 'ok',
    });
  }

  private show(): void {
    const { net } = this.ctx;
    const marks = [];
    for (const id of [this.selected, this.hover]) {
      const node = id === null ? undefined : net.getNode(id);
      if (node) marks.push({ kind: 'ring' as const, pos: node.pos, color: id === this.selected ? COLORS.ok : COLORS.snap, radius: 8 });
    }
    this.ctx.setMarks(marks);
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    if (this.kind) {
      this.updateTarget(e);
      this.showCard(e);
      return;
    }
    this.hover = pickNode(this.ctx, e, (id) => isJunctionNode(this.ctx.net, id));
    const tint = this.hover !== null && this.hover !== this.selected;
    this.ctx.view.setHighlight(tint ? { nodes: [this.hover!], color: COLORS.snap } : null);
    this.ctx.setHud({
      x: e.x,
      y: e.y,
      lines: [this.hover === null ? 'Traffic control' : 'Junction'],
      notes: this.hover === null ? ['Click a junction'] : [],
      tone: 'ok',
    });
    this.show();
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    const kind = this.kind;
    if (kind) {
      this.pointer = e;
      this.updateTarget(e);
      const t = this.target;
      const p = this.plan;
      if (!t || !p) return;
      if (!p.ok) {
        this.ctx.toast(p.reason, 'warning');
        return;
      }
      if (p.changed) {
        this.ctx.history.hint(`Set ${controlCard(kind).name}`);
        applyControl(this.ctx.net, t, kind);
      }
      this.applied = t;
      this.updateTarget(e);
      this.showCard(e);
      return;
    }
    const id = pickNode(this.ctx, e, (n) => isJunctionNode(this.ctx.net, n));
    if (id === null) return;
    this.selected = id;
    this.ctx.view.setHighlight(null);
    this.ctx.inspect({ kind: 'junction', id });
    this.show();
  }

  /** Pick a card by its hotkey. */
  keyDown(e: ToolKey): boolean {
    if (e.ctrl || e.alt) return false;
    const card = CONTROL_CARDS.find((c) => c.key.toLowerCase() === e.key.toLowerCase());
    if (!card) return false;
    this.ctx.settings.junctionControl = card.kind;
    this.settingsChanged();
    this.ctx.changed();
    return true;
  }

  settingsChanged(): void {
    this.applied = null;
    if (!this.kind) {
      this.target = null;
      this.plan = null;
      this.show();
      return;
    }
    this.ctx.view.setHighlight(null);
    if (this.pointer) this.updateTarget(this.pointer);
    this.showCard(this.pointer);
  }

  deactivate(): void {
    this.hover = null;
    this.selected = null;
    this.target = null;
    this.plan = null;
    this.applied = null;
  }

  networkChanged(change: NetworkChange): void {
    if (change.reset) {
      this.hover = null;
      this.selected = null;
      this.applied = null;
    }
    if (this.kind && this.pointer) {
      this.updateTarget(this.pointer);
      this.showCard(this.pointer);
    }
  }
}
