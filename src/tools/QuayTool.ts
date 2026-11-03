/**
 * Quay tool: click along the river bank to build a quay wall. Points snap to the
 * wall line on the bank and the wall follows the river's curve between them, so
 * there is no freeform drawing. Each click carries on from the last, and a stretch
 * that continues a matching quay extends it.
 */
import type { RoadNetwork } from '../core/RoadNetwork';
import { bankParam, QUAY_LAND, QUAY_LINE, quayLength, quayProblem, quaySamples, snapToBank, type BankSnap } from '../core/quays';
import type { Id, Vec3 } from '../core/types';
import { QUAY_STYLES, QUAY_TOPS, type Quay } from '../core/wallTypes';
import type { ToolMark } from '../render/api';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolKey, type ToolPointer } from './types';

/** The quay at a ground point: on its wall or the land behind it. */
export function pickQuay(net: RoadNetwork, x: number, z: number): Id | null {
  if (!net.quays.length) return null;
  const p = bankParam(x, z);
  for (const q of net.quays) {
    if (p.bank !== q.bank || p.x < q.x0 - 2 || p.x > q.x1 + 2) continue;
    if (p.d >= QUAY_LINE - 5 && p.d <= QUAY_LAND) return q.id;
  }
  return null;
}

/** Outline of a quay stretch for marks: the wall line and the back of the land it holds. */
export function quayOutline(q: Pick<Quay, 'bank' | 'x0' | 'x1'>): { wall: Vec3[]; back: Vec3[] } {
  const sm = quaySamples(q, 4);
  const back = QUAY_LAND - QUAY_LINE;
  return {
    wall: sm.map((s) => ({ x: s.x, y: 0.4, z: s.z })),
    back: sm.map((s) => ({ x: s.x + s.nx * back, y: 0.4, z: s.z + s.nz * back })),
  };
}

export class QuayTool extends Tool {
  readonly id: ToolId = 'quay';
  private start: BankSnap | null = null;
  private hover: BankSnap | null = null;

  activate(): void {
    this.refresh();
  }

  deactivate(): void {
    this.start = null;
    this.hover = null;
  }

  settingsChanged(): void {
    this.refresh();
  }

  networkChanged(change: { reset: boolean }): void {
    if (change.reset) this.start = null;
    this.refresh();
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    this.refresh();
  }

  back(): boolean {
    if (!this.start) return false;
    this.start = null;
    this.refresh();
    this.ctx.changed();
    return true;
  }

  keyDown(_e: ToolKey): boolean {
    return false;
  }

  /** The stretch from the start to the hover point, ordered along the river. */
  private stretch(): Omit<Quay, 'id'> | null {
    const a = this.start;
    const b = this.hover;
    if (!a || !b) return null;
    const w = this.ctx.settings.walls;
    return { bank: a.bank, x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), style: w.quayStyle, top: w.quayTop };
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    this.refresh();
    const hit = this.hover;
    if (!hit) {
      this.ctx.toast('Click along the river bank to build a quay.', 'warning');
      return;
    }
    if (!this.start) {
      this.start = hit;
      this.refresh();
      this.ctx.changed();
      return;
    }
    const q = this.stretch();
    if (!q) return;
    const { net, history, toast } = this.ctx;
    const problem = quayProblem(q, net.quays);
    if (problem) {
      toast(problem, 'error');
      return;
    }
    history.hint('Build quay');
    // A stretch carrying straight on from a matching quay makes it longer.
    const joins = net.quays.find((o) => o.bank === q.bank && o.style === q.style && o.top === q.top && (Math.abs(o.x1 - q.x0) < 0.5 || Math.abs(o.x0 - q.x1) < 0.5));
    if (joins) net.updateQuay(joins.id, { x0: Math.min(joins.x0, q.x0), x1: Math.max(joins.x1, q.x1) });
    else net.addQuay(q);
    // Carry on from the point just placed.
    this.start = hit;
    this.refresh();
    this.ctx.changed();
  }

  refresh(): void {
    const e = this.pointer;
    const { view, settings } = this.ctx;
    view.setPreview([]);
    if (!e) {
      this.ctx.setMarks([]);
      this.ctx.setHud(null);
      return;
    }
    const ground = view.pickPlane(e.x, e.y, 0);
    this.hover = ground ? snapToBank(ground.x, ground.z, this.start?.bank) : null;
    const marks: ToolMark[] = [];
    const style = QUAY_STYLES.find((s) => s.value === settings.walls.quayStyle)?.label ?? '';
    const top = QUAY_TOPS.find((s) => s.value === settings.walls.quayTop)?.label ?? '';
    if (!this.hover) {
      this.ctx.setMarks(marks);
      this.ctx.setHud({ x: e.x, y: e.y, lines: [`Quay: ${style}, ${top}`], notes: ['Point at the river bank'], tone: 'warning' });
      return;
    }
    marks.push({ kind: 'ring', pos: this.hover.pos, color: COLORS.snap, radius: 3 });
    marks.push({ kind: 'point', pos: this.hover.pos, color: COLORS.snap, radius: 1 });
    const q = this.stretch();
    if (!q || !this.start) {
      this.ctx.setMarks(marks);
      this.ctx.setHud({ x: e.x, y: e.y, lines: [`Quay: ${style}, ${top}`, 'Snap: river bank'], notes: ['Click to start the quay wall'], tone: 'ok' });
      return;
    }
    const problem = quayProblem(q, this.ctx.net.quays);
    const color = problem ? COLORS.bad : COLORS.ok;
    const outline = quayOutline(q);
    marks.push({ kind: 'line', points: outline.wall, color, width: 0.9 });
    marks.push({ kind: 'line', points: outline.back, color: COLORS.guide, width: 0.3, dashed: true });
    marks.push({ kind: 'point', pos: this.start.pos, color: COLORS.guide, radius: 1.2 });
    this.ctx.setMarks(marks);
    this.ctx.setHud({
      x: e.x,
      y: e.y,
      lines: [`Quay: ${style}, ${top}`, `Length ${quayLength(q).toFixed(0)} m`],
      notes: problem ? [problem] : ['Click to build. Right click to stop'],
      tone: problem ? 'error' : 'ok',
    });
  }
}
