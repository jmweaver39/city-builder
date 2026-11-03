/**
 * Grid tools.
 *
 * Grid Block: drag a rectangle on the grid and get a whole street grid of the
 * selected road type, built in one undo step, every crossing a junction, joined
 * to the roads it touches.
 *
 * Grid Align: click a road and the grid turns and shifts so a grid line runs
 * along it there. Used to lay a grid off a straight stretch of a curved road.
 */
import { clamp, distXZ } from '../core/math';
import { ELEVATION_STEP, MAX_ELEVATION, MIN_ELEVATION } from '../core/terrain';
import type { Vec3 } from '../core/types';
import type { RoadPreview, ToolMark } from '../render/api';
import {
  buildGridBlock,
  checkGridBlock,
  GRID_MAX_BLOCK_CELLS,
  gridAlignedTo,
  nearestGridPoint,
  planGridBlock,
  type BlockCheck,
  type BlockPlan,
  type GridSettings,
} from './grid';
import { pickRoad } from './pick';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolKey, type ToolPointer, type Tone } from './types';

export class GridBlockTool extends Tool {
  readonly id: ToolId = 'gridBlock';
  private start: Vec3 | null = null;
  private moved = false;
  private plan: BlockPlan | null = null;
  private check: BlockCheck | null = null;
  private planKey = '';

  get dragging(): boolean {
    return this.start !== null;
  }

  get currentPlan(): BlockPlan | null {
    return this.plan;
  }

  get currentCheck(): BlockCheck | null {
    return this.check;
  }

  activate(): void {
    this.refresh();
  }

  deactivate(): void {
    this.cancel();
  }

  private cancel(): void {
    this.start = null;
    this.moved = false;
    this.plan = null;
    this.check = null;
    this.planKey = '';
  }

  settingsChanged(): void {
    this.planKey = '';
    this.refresh();
  }

  networkChanged(): void {
    this.planKey = '';
    this.refresh();
  }

  private cursor(e: ToolPointer): Vec3 | null {
    return this.ctx.view.pickPlane(e.x, e.y, this.ctx.settings.elevation);
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    this.refresh();
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    const p = this.cursor(e);
    if (!p) return;
    this.start = nearestGridPoint(this.ctx.settings.grid, p, this.ctx.settings.elevation);
    this.moved = false;
    this.planKey = '';
    this.refresh();
    this.ctx.changed();
  }

  pointerUp(e: ToolPointer): void {
    if (e.button !== 0 || !this.start) return;
    this.pointer = e;
    this.refresh();
    if (!this.moved || !this.plan || !this.check) {
      this.cancel();
      this.refresh();
      this.ctx.toast('Drag across the grid to lay out street blocks.', 'info');
      return;
    }
    this.build(this.plan, this.check);
    this.cancel();
    this.refresh();
    this.ctx.changed();
  }

  /** Build a checked plan as one undo step. */
  build(plan: BlockPlan, check: BlockCheck): boolean {
    const { net, settings, history, toast } = this.ctx;
    if (check.errors.length) {
      toast(check.errors[0], 'error');
      return false;
    }
    history.begin('Grid block');
    try {
      const result = net.batch(() => buildGridBlock(net, plan, settings.roadType, check.covered));
      history.end();
      if (!result.segments.length) toast('Those streets are already there.', 'info');
      return true;
    } catch (err) {
      history.abort();
      toast(`Could not build the street grid: ${(err as Error).message}`, 'error');
      return false;
    }
  }

  back(): boolean {
    if (!this.start) return false;
    this.cancel();
    this.refresh();
    this.ctx.changed();
    return true;
  }

  keyDown(e: ToolKey): boolean {
    const g = this.ctx.settings.grid;
    if (e.key === '[' || e.key === ']') {
      g.blockCells = clamp(g.blockCells + (e.key === ']' ? 1 : -1), 1, GRID_MAX_BLOCK_CELLS);
      this.planKey = '';
      this.refresh();
      this.ctx.changed();
      return true;
    }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      const s = this.ctx.settings;
      s.elevation = clamp(s.elevation + (e.key === 'PageUp' ? 1 : -1) * ELEVATION_STEP, MIN_ELEVATION, MAX_ELEVATION);
      if (this.start) this.start = { ...this.start, y: s.elevation };
      this.planKey = '';
      this.refresh();
      this.ctx.changed();
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------

  refresh(): void {
    const { view, settings } = this.ctx;
    const e = this.pointer;
    const g = settings.grid;
    const p = e ? this.cursor(e) : null;
    if (!e || !p) {
      view.setPreview([]);
      this.ctx.setMarks([]);
      this.ctx.setHud(null);
      return;
    }
    const block = g.spacing * g.blockCells;
    if (!this.start) {
      this.plan = null;
      this.check = null;
      const corner = nearestGridPoint(g, p, settings.elevation);
      view.setPreview([]);
      this.ctx.setMarks([
        { kind: 'ring', pos: corner, color: COLORS.snap, radius: 5 },
        { kind: 'point', pos: corner, color: COLORS.snap, radius: 1 },
      ]);
      this.ctx.setHud({
        x: e.x,
        y: e.y,
        lines: ['Grid block', `Block ${block.toFixed(0)} m (${g.blockCells} × ${g.spacing} m cells)`],
        notes: ['Drag a rectangle of street blocks. [ and ] change the block size'],
        tone: 'ok',
      });
      return;
    }
    if (distXZ(p, this.start) > block * 0.5) this.moved = true;
    const plan = planGridBlock(g, this.start, p, settings.elevation);
    const key = `${plan.ni}|${plan.nj}|${plan.corners[2].x.toFixed(2)}|${plan.corners[2].z.toFixed(2)}|${settings.roadType}|${this.ctx.net.version}`;
    if (key !== this.planKey || !this.check) {
      this.planKey = key;
      this.plan = plan;
      this.check = checkGridBlock(this.ctx.net, plan, settings.roadType);
    }
    this.show(e, this.plan!, this.check!);
  }

  private show(e: ToolPointer, plan: BlockPlan, check: BlockCheck): void {
    const { view, settings } = this.ctx;
    const byState: Record<Tone, RoadPreview> = {
      ok: { curves: [], roadType: settings.roadType, state: 'ok' },
      warning: { curves: [], roadType: settings.roadType, state: 'warning' },
      error: { curves: [], roadType: settings.roadType, state: 'error' },
    };
    plan.edges.forEach((edge, k) => {
      if (check.covered[k]) return;
      const a = edge.from;
      const b = edge.to;
      const p1 = { x: a.x + (b.x - a.x) / 3, y: a.y, z: a.z + (b.z - a.z) / 3 };
      const p2 = { x: a.x + ((b.x - a.x) * 2) / 3, y: a.y, z: a.z + ((b.z - a.z) * 2) / 3 };
      byState[check.state[k]].curves.push({ p0: a, p1, p2, p3: b });
    });
    view.setPreview([byState.ok, byState.warning, byState.error].filter((p) => p.curves.length));
    const tone: Tone = check.errors.length ? 'error' : check.warnings.length ? 'warning' : 'ok';
    const color = tone === 'error' ? COLORS.bad : tone === 'warning' ? COLORS.warn : COLORS.snap;
    const [c0, c1, c2, c3] = plan.corners;
    const marks: ToolMark[] = [
      { kind: 'line', points: [c0, c1, c2, c3, c0], color, width: 0.5, dashed: true },
      { kind: 'ring', pos: c0, color, radius: 5 },
    ];
    this.ctx.setMarks(marks);
    const w = plan.ni * plan.block;
    const h = plan.nj * plan.block;
    const lines = [
      `${plan.ni} × ${plan.nj} blocks of ${plan.block.toFixed(0)} m`,
      `${w.toFixed(0)} × ${h.toFixed(0)} m`,
      `Streets ${check.segments}, junctions ${check.junctions}`,
    ];
    const skipped = check.covered.filter(Boolean).length;
    if (skipped) lines.push(`Uses ${skipped} existing road piece${skipped === 1 ? '' : 's'}`);
    const notes = [...check.errors, ...check.warnings].slice(0, 3);
    if (!notes.length) notes.push(this.moved ? 'Release to build' : 'Keep dragging');
    this.ctx.setHud({ x: e.x, y: e.y, lines, notes, tone });
  }
}

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
