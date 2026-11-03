/**
 * Grid Align: click a road and the grid turns (and, with "Origin on road
 * centreline", shifts) so grid lines run along it there. Used to lay a grid off a
 * straight stretch of a curved road. The manager returns to the last tool after.
 */
import { gridAlignedTo, type GridSettings } from './grid';
import { pickRoad } from './pick';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolKey, type ToolPointer } from './types';

export class GridAlignTool extends Tool {
  readonly id: ToolId = 'gridAlign';
  /** The grid the hovered road would give, shown instead of the current one. */
  preview: GridSettings | null = null;
  /** Called when aligning is done or cancelled. The manager returns to the last tool. */
  onDone: () => void = () => {};

  activate(): void {
    this.refresh();
  }

  deactivate(): void {
    this.preview = null;
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    this.refresh();
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    const hit = pickRoad(this.ctx, e);
    if (!hit) {
      this.ctx.toast('Click a road to line the grid up with it.', 'info');
      return;
    }
    const g = this.ctx.settings.grid;
    Object.assign(g, gridAlignedTo(this.ctx.net, hit.segmentId, hit.t, g));
    this.preview = null;
    this.ctx.toast(`Grid aligned to the road, turned ${((g.rotation * 180) / Math.PI).toFixed(1)}°.`, 'info');
    this.ctx.changed();
    this.onDone();
  }

  back(): boolean {
    this.preview = null;
    this.onDone();
    return true;
  }

  keyDown(e: ToolKey): boolean {
    if (e.key === 'Escape') {
      this.back();
      return true;
    }
    return false;
  }

  refresh(): void {
    const e = this.pointer;
    const { view } = this.ctx;
    this.ctx.setMarks([]);
    if (!e) {
      this.preview = null;
      view.setHighlight(null);
      this.ctx.setHud(null);
      return;
    }
    const hit = pickRoad(this.ctx, e);
    if (!hit) {
      this.preview = null;
      view.setHighlight(null);
      this.ctx.setHud({ x: e.x, y: e.y, lines: ['Align grid'], notes: ['Click a road. Right click cancels'], tone: 'ok' });
      return;
    }
    this.preview = gridAlignedTo(this.ctx.net, hit.segmentId, hit.t, this.ctx.settings.grid);
    view.setHighlight({ segments: [hit.segmentId], color: COLORS.snap });
    this.ctx.setMarks([{ kind: 'ring', pos: hit.point, color: COLORS.snap, radius: 4 }]);
    const deg = (this.preview.rotation * 180) / Math.PI;
    this.ctx.setHud({ x: e.x, y: e.y, lines: ['Align grid', `Rotation ${deg.toFixed(1)}°`], notes: ['Click to line the grid up with this road'], tone: 'ok' });
  }
}
