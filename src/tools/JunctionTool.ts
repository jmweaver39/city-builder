/** Traffic control: click a junction to open its control panel. */
import { isJunctionNode, pickNode } from './pick';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolPointer } from './types';
import type { Id } from '../core/types';

export class JunctionTool extends Tool {
  readonly id: ToolId = 'junction';
  private hover: Id | null = null;
  private selected: Id | null = null;

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
    const id = pickNode(this.ctx, e, (n) => isJunctionNode(this.ctx.net, n));
    if (id === null) return;
    this.selected = id;
    this.ctx.view.setHighlight(null);
    this.ctx.inspect({ kind: 'junction', id });
    this.show();
  }

  deactivate(): void {
    this.hover = null;
    this.selected = null;
  }

  networkChanged(change: { reset: boolean }): void {
    if (change.reset) {
      this.hover = null;
      this.selected = null;
    }
  }
}
