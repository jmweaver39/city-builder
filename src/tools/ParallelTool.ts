/**
 * Parallel Road tool: hover beside a road to see a copy of it at the chosen
 * offset on that side, then click to build it. A click takes the whole road
 * through its plain joints; a drag takes just the pieces dragged over. The copy
 * follows curves (offset fitted within a few centimetres), uses the same road
 * type or the one selected, and for a one-way road runs the opposite way by
 * default, so a highway carriageway gets its partner. One undo step. Refused
 * with the reason where it would overlap other roads.
 */
import type { Id } from '../core/types';
import type { RoadPreview } from '../render/api';
import {
  buildParallel,
  orderChain,
  PARALLEL_PRESETS,
  planParallel,
  roadChain,
  type ChainStep,
  type ParallelPlan,
} from './parallel';
import { pickRoad } from './pick';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolKey, type ToolPointer, type Tone } from './types';

/** How far beside a road the cursor may be to pick it, metres. */
const PICK_SLACK = 45;

export class ParallelTool extends Tool {
  readonly id: ToolId = 'parallel';
  private dragging = false;
  private dragSet = new Set<Id>();
  private chain: ChainStep[] | null = null;
  private side: 1 | -1 = 1;
  private plan: ParallelPlan | null = null;
  private planKey = '';

  get currentPlan(): ParallelPlan | null {
    return this.plan;
  }

  activate(): void {
    this.refresh();
  }

  deactivate(): void {
    this.dragging = false;
    this.dragSet.clear();
    this.chain = null;
    this.plan = null;
    this.planKey = '';
    this.ctx.view.setHighlight(null);
  }

  settingsChanged(): void {
    this.planKey = '';
    this.refresh();
  }

  networkChanged(): void {
    this.planKey = '';
    this.refresh();
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    if (this.dragging) {
      const hit = pickRoad(this.ctx, e, 1.5);
      if (hit) this.dragSet.add(hit.segmentId);
    }
    this.refresh();
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    this.dragging = true;
    this.dragSet.clear();
    const hit = pickRoad(this.ctx, e, 1.5);
    if (hit) this.dragSet.add(hit.segmentId);
    this.refresh();
  }

  pointerUp(e: ToolPointer): void {
    if (e.button !== 0 || !this.dragging) return;
    this.pointer = e;
    this.refresh();
    this.dragging = false;
    const plan = this.plan;
    this.dragSet.clear();
    if (!plan) {
      this.ctx.toast('Point beside a road, on the side the new road should go.', 'info');
      this.refresh();
      return;
    }
    this.build(plan);
    this.planKey = '';
    this.refresh();
    this.ctx.changed();
  }

  /** Build a planned copy as one undo step. */
  build(plan: ParallelPlan): boolean {
    const { net, history, toast } = this.ctx;
    if (plan.errors.length) {
      toast(plan.errors[0], 'error');
      return false;
    }
    history.begin('Parallel road');
    try {
      net.batch(() => buildParallel(net, plan));
      history.end();
      return true;
    } catch (err) {
      history.abort();
      toast(`Could not build the parallel road: ${(err as Error).message}`, 'error');
      return false;
    }
  }

  back(): boolean {
    if (!this.dragging) return false;
    this.dragging = false;
    this.dragSet.clear();
    this.refresh();
    return true;
  }

  keyDown(e: ToolKey): boolean {
    if (e.key === '[' || e.key === ']') {
      const p = this.ctx.settings.parallel;
      const i = Math.max(0, PARALLEL_PRESETS.indexOf(p.offset));
      const n = PARALLEL_PRESETS.length;
      p.offset = PARALLEL_PRESETS[(i + (e.key === ']' ? 1 : n - 1)) % n];
      this.planKey = '';
      this.refresh();
      this.ctx.changed();
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------

  refresh(): void {
    const { view, net, settings } = this.ctx;
    const e = this.pointer;
    if (!e) {
      this.clear();
      return;
    }
    const hit = pickRoad(this.ctx, e, PICK_SLACK);
    if (!hit && !this.dragSet.size) {
      this.clear();
      this.ctx.setHud({ x: e.x, y: e.y, lines: ['Parallel road'], notes: ['Point beside a road, on the side the new road should go'], tone: 'ok' });
      return;
    }
    const ids = this.dragging && this.dragSet.size > 1 ? [...this.dragSet] : hit ? roadChain(net, hit.segmentId) : [...this.dragSet];
    const chain = orderChain(net, ids);
    if (!chain) {
      this.clear();
      this.ctx.setHud({ x: e.x, y: e.y, lines: ['Parallel road'], notes: ['Those pieces do not make one road'], tone: 'warning' });
      return;
    }
    let side: 1 | -1 = this.side;
    if (hit) {
      const step = chain.find((s) => s.segmentId === hit.segmentId);
      const lateral = step?.reversed ? -hit.lateral : hit.lateral;
      side = lateral >= 0 ? 1 : -1;
    }
    this.side = side;
    const key = `${chain.map((s) => `${s.segmentId}${s.reversed ? 'r' : ''}`).join(',')}|${side}|${JSON.stringify(settings.parallel)}|${settings.roadType}|${net.version}`;
    if (key !== this.planKey) {
      this.planKey = key;
      this.chain = chain;
      this.plan = planParallel(net, chain, side, settings.parallel, settings.roadType);
    }
    const plan = this.plan!;
    const groups: Record<Tone, RoadPreview> = {
      ok: { curves: [], roadType: plan.roadType, state: 'ok' },
      warning: { curves: [], roadType: plan.roadType, state: 'warning' },
      error: { curves: [], roadType: plan.roadType, state: 'error' },
    };
    plan.pieces.forEach((p, i) => groups[plan.state[i] ?? 'error'].curves.push(p));
    view.setPreview([groups.ok, groups.warning, groups.error].filter((g) => g.curves.length));
    view.setHighlight({ segments: chain.map((s) => s.segmentId), color: COLORS.snap });
    this.ctx.setMarks([]);
    const tone: Tone = plan.errors.length ? 'error' : plan.warnings.length ? 'warning' : 'ok';
    const typeName = net.roadType(plan.roadType)?.name ?? plan.roadType;
    const offsetText = settings.parallel.offset === null ? `kerb to kerb, ${plan.offset.toFixed(1)} m` : `${plan.offset} m`;
    const lines = [`Parallel · ${offsetText}`, `${typeName}${plan.opposite ? ', opposite direction' : ''}`, `${side > 0 ? 'Right' : 'Left'} side, ${chain.length} piece${chain.length === 1 ? '' : 's'}`];
    const notes = [...plan.errors, ...plan.warnings].slice(0, 3);
    if (!notes.length) notes.push(this.dragging ? 'Release to build' : 'Click to build. [ and ] change the offset');
    this.ctx.setHud({ x: e.x, y: e.y, lines, notes, tone });
  }

  private clear(): void {
    this.plan = null;
    this.chain = null;
    this.ctx.view.setPreview([]);
    this.ctx.view.setHighlight(null);
    this.ctx.setMarks([]);
    this.ctx.setHud(null);
  }
}
