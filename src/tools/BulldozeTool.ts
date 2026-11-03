/** Bulldoze: hover highlights, click deletes, drag sweeps. One drag is one undo step. */
import type { Id } from '../core/types';
import { pickDecal, pickEndpoint, pickRoad } from './pick';
import { pruneZones, syncAllZoneAccess } from './zoneOps';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolPointer } from './types';

export type BulldozeTarget =
  | { kind: 'segment'; id: Id }
  | { kind: 'endpoint'; id: Id }
  | { kind: 'decal'; id: Id };

/** Sweep samples per this many pixels, so a fast drag misses nothing. */
const SWEEP_STEP_PX = 6;

export class BulldozeTool extends Tool {
  readonly id: ToolId = 'bulldoze';
  private sweeping = false;
  private last: ToolPointer | null = null;
  private removed = 0;

  private targetAt(e: Pick<ToolPointer, 'x' | 'y'>): BulldozeTarget | null {
    const ep = pickEndpoint(this.ctx, e, 7);
    if (ep !== null) return { kind: 'endpoint', id: ep };
    const decal = pickDecal(this.ctx, e);
    if (decal !== null) return { kind: 'decal', id: decal };
    const road = pickRoad(this.ctx, e);
    if (road) return { kind: 'segment', id: road.segmentId };
    return null;
  }

  private remove(target: BulldozeTarget): void {
    const { net } = this.ctx;
    if (target.kind === 'segment' && net.getSegment(target.id)) net.removeSegment(target.id);
    else if (target.kind === 'endpoint' && net.endpoints.some((x) => x.id === target.id)) net.removeEndpoint(target.id);
    else if (target.kind === 'decal' && net.decals.some((x) => x.id === target.id)) net.removeDecal(target.id);
    else return;
    this.removed++;
  }

  private show(e: ToolPointer): void {
    const { net, view } = this.ctx;
    const target = this.targetAt(e);
    view.setHighlight(target?.kind === 'segment' ? { segments: [target.id], color: COLORS.bad } : null);
    if (!target) {
      this.ctx.setMarks([]);
      this.ctx.setHud({ x: e.x, y: e.y, lines: ['Bulldoze'], notes: ['Click a road, marking or endpoint'], tone: 'ok' });
      return;
    }
    let name = '';
    if (target.kind === 'segment') name = net.roadTypeOf(target.id).name;
    if (target.kind === 'endpoint') name = `Traffic ${net.endpoints.find((x) => x.id === target.id)?.kind ?? ''}`;
    if (target.kind === 'decal') name = 'Marking';
    this.ctx.setHud({ x: e.x, y: e.y, lines: [`Remove ${name}`], notes: [], tone: 'error' });
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    if (this.sweeping && this.last) {
      const span = Math.hypot(e.x - this.last.x, e.y - this.last.y);
      const steps = Math.max(1, Math.ceil(span / SWEEP_STEP_PX));
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        const target = this.targetAt({ x: this.last.x + (e.x - this.last.x) * k, y: this.last.y + (e.y - this.last.y) * k });
        if (target) this.remove(target);
      }
      this.last = e;
    }
    this.show(e);
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    this.sweeping = true;
    this.removed = 0;
    this.last = e;
    this.ctx.history.begin('Bulldoze');
    const target = this.targetAt(e);
    if (target) this.remove(target);
    this.show(e);
  }

  pointerUp(e: ToolPointer): void {
    if (!this.sweeping) return;
    this.sweeping = false;
    this.last = null;
    // Roads gone may have been some region's access, or its edge.
    if (this.removed && this.ctx.net.project.zones?.length) {
      pruneZones(this.ctx.net);
      syncAllZoneAccess(this.ctx.net);
    }
    this.ctx.history.end();
    this.show(e);
  }

  deactivate(): void {
    if (this.sweeping) {
      this.sweeping = false;
      this.ctx.history.end();
    }
  }
}

