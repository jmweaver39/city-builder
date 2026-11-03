/**
 * Reverse Direction: click a road to turn it round, drag to turn several in one
 * undo step. The hover ghost shows the direction it will end up with.
 */
import type { Cubic } from '../core/bezier';
import type { RoadNetwork } from '../core/RoadNetwork';
import type { ReverseReport } from '../core/reverse';
import type { Id, Vec3 } from '../core/types';
import type { RoadPreview, ToolMark } from '../render/api';
import { pickRoad } from './pick';
import { connectedRoad } from './roadOps';
import { Tool } from './Tool';
import { COLORS, type ToastKind, type ToolId, type ToolPointer } from './types';

const DRAG_STEP_PX = 6;

export function reversedCubic(c: Cubic): Cubic {
  return { p0: c.p3, p1: c.p2, p2: c.p1, p3: c.p0 };
}

/** Turn several roads as one edit. */
export function reverseRoads(net: RoadNetwork, ids: readonly Id[]): ReverseReport[] {
  return net.batch(() => ids.filter((id) => net.getSegment(id)).map((id) => net.reverseSegment(id)));
}

/** What to tell the player about a reversal. */
export function reverseMessages(reports: readonly ReverseReport[]): { text: string; kind: ToastKind }[] {
  const out: { text: string; kind: ToastKind }[] = [];
  const changes = [...new Set(reports.flatMap((r) => r.changes))];
  for (const text of changes.slice(0, 3)) out.push({ text, kind: 'warning' });
  if (changes.length > 3) out.push({ text: `And ${changes.length - 3} more changes at junctions.`, kind: 'warning' });
  const stranded = new Set(reports.flatMap((r) => r.stranded));
  if (stranded.size) {
    out.push({
      text: `This leaves lanes with no way out or no way in at ${stranded.size === 1 ? 'one node' : `${stranded.size} nodes`}, marked in red.`,
      kind: 'error',
    });
  }
  if (reports.length && reports.every((r) => r.looksTheSame)) {
    out.push({ text: 'Reversed. This road looks the same from both ends.', kind: 'info' });
  }
  return out;
}

/** Red rings at the nodes a reversal stranded. */
export function strandedMarks(net: RoadNetwork, reports: readonly ReverseReport[]): ToolMark[] {
  const marks: ToolMark[] = [];
  const nodes = new Set(reports.flatMap((r) => r.stranded));
  for (const id of nodes) {
    const pos: Vec3 | undefined = net.getNode(id)?.pos;
    if (!pos) continue;
    marks.push({ kind: 'ring', pos, color: COLORS.bad, radius: 9 }, { kind: 'label', pos, text: 'No way through', color: COLORS.bad });
  }
  return marks;
}

export class ReverseTool extends Tool {
  readonly id: ToolId = 'reverse';
  private dragging = false;
  private done = new Set<Id>();
  private reports: ReverseReport[] = [];
  private last: ToolPointer | null = null;
  private warnings: ToolMark[] = [];

  private targets(segmentId: Id): Id[] {
    return this.ctx.settings.reverseWholeRoad ? connectedRoad(this.ctx.net, segmentId) : [segmentId];
  }

  private flipAt(e: Pick<ToolPointer, 'x' | 'y'>): void {
    const hit = pickRoad(this.ctx, e);
    if (!hit || this.done.has(hit.segmentId)) return;
    const ids = this.targets(hit.segmentId);
    for (const id of ids) this.done.add(id);
    this.reports.push(...reverseRoads(this.ctx.net, ids));
  }

  private show(e: ToolPointer | null): void {
    const { net, view } = this.ctx;
    const hit = e ? pickRoad(this.ctx, e) : null;
    this.ctx.setMarks(this.warnings);
    if (!hit || !e) {
      view.setPreview([]);
      view.setHighlight(null);
      if (e) this.ctx.setHud({ x: e.x, y: e.y, lines: ['Reverse direction'], notes: ['Click a road, or drag across several'], tone: 'ok' });
      return;
    }
    const ids = this.targets(hit.segmentId);
    // The ghost is the road as it will be, so its arrows show the new direction.
    const previews: RoadPreview[] = this.dragging
      ? []
      : ids.map((id) => ({ curves: [reversedCubic(net.cubicOf(id))], roadType: net.getSegment(id)!.roadType, state: 'ok' }));
    view.setPreview(previews);
    view.setHighlight({ segments: ids, color: COLORS.snap });
    this.ctx.setHud({
      x: e.x,
      y: e.y,
      lines: ['Reverse direction', net.roadTypeOf(hit.segmentId).name],
      notes: ids.length > 1 ? [`${ids.length} pieces of road`] : [],
      tone: 'ok',
    });
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    if (this.dragging && this.last) {
      const span = Math.hypot(e.x - this.last.x, e.y - this.last.y);
      const steps = Math.max(1, Math.ceil(span / DRAG_STEP_PX));
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        this.flipAt({ x: this.last.x + (e.x - this.last.x) * k, y: this.last.y + (e.y - this.last.y) * k });
      }
      this.last = e;
    }
    this.show(e);
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    this.dragging = true;
    this.last = e;
    this.done.clear();
    this.reports = [];
    this.warnings = [];
    this.ctx.history.begin('Reverse road');
    this.flipAt(e);
    this.show(e);
  }

  pointerUp(e: ToolPointer): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.last = null;
    this.ctx.history.end();
    for (const m of reverseMessages(this.reports)) this.ctx.toast(m.text, m.kind);
    this.warnings = strandedMarks(this.ctx.net, this.reports);
    this.show(e);
  }

  settingsChanged(): void {
    this.show(this.pointer);
  }

  deactivate(): void {
    if (this.dragging) this.ctx.history.end();
    this.dragging = false;
    this.warnings = [];
  }
}
