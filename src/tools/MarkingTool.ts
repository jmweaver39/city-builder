/**
 * Markings: one tool for every mark on the road (key P, K too).
 *
 * What the pointer is over decides what a click does, so there are no modes:
 *   - over a road: marking along it (two clicks following the curve, snapping to the
 *     road's own line positions, across transitions and junction surfaces), or a
 *     crossing, stop line, area or stamp laid on it (PaintTool);
 *   - over a junction, or the open junction's anchors and markings: junction design
 *     (anchors on cuts and kerbs, lines between arms, crossings and stop slots,
 *     areas: NodeMarkingTool);
 *   - Pick and Erase work on whatever is under the pointer, Paint marks, junction and
 *     road markings and automatic ones alike.
 * Storage stays as it was (decals, segment and node markings); this tool presents
 * them as one.
 */
import type { NetworkChange } from '../core/RoadNetwork';
import type { DecalKind, Id, LineStyleSpec } from '../core/types';
import { lineStandard } from '../core/paintStandard';
import { NodeMarkingTool } from './NodeMarkingTool';
import { PaintTool, defaultDecalWidth } from './PaintTool';
import { Tool } from './Tool';
import { decalOutline, hitLabel, hitOutline, markingAt, removeAutoItem, removeAutoLine } from './markingOps';
import { pickDecal, pickNodeHit, pickRoad } from './pick';
import { COLORS, type MarkingDraw, type ToolContext, type ToolId, type ToolKey, type ToolPointer } from './types';

/** The Paint kinds a stamp can be. */
export const STAMP_KINDS: readonly DecalKind[] = ['arrowStraight', 'arrowLeft', 'arrowRight', 'arrowStraightLeft', 'arrowStraightRight', 'text'];

export class MarkingTool extends Tool {
  readonly id: ToolId = 'paint';
  readonly paint: PaintTool;
  readonly node: NodeMarkingTool;
  /** Which part took the last pointer event. */
  private route: 'paint' | 'node' | 'own' = 'paint';
  /** A Paint tool mark picked with Pick. */
  selectedDecal: Id | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
    this.paint = new PaintTool(ctx);
    this.node = new NodeMarkingTool(ctx);
  }

  get draw(): MarkingDraw {
    return this.ctx.settings.nodeMarking.draw;
  }

  /** Pick a draw tool: Pick, Line, Crossing, Stop, Area, Stamp or Erase. */
  setDraw(draw: MarkingDraw): void {
    const s = this.ctx.settings;
    this.node.setDraw(draw);
    // Along a road the same choice is a Paint kind, with the look of that draw.
    const p = s.paint;
    const nm = s.nodeMarking;
    if (draw === 'line') {
      p.kind = 'line';
      p.look = { ...nm.lineExtra, style: nm.style, color: nm.color, width: nm.width };
    } else if (draw === 'crosswalk') {
      p.kind = 'crosswalk';
      p.look = { ...nm.crosswalk };
    } else if (draw === 'stop') {
      p.kind = nm.stop.style === 'sharkTeeth' ? 'yieldTriangles' : 'stopLine';
      p.look = { ...nm.stop };
    } else if (draw === 'filler') {
      p.kind = nm.fill === 'solid' ? 'fill' : 'hatch';
    } else if (draw === 'stamp') {
      if (!STAMP_KINDS.includes(p.kind)) p.kind = 'arrowStraight';
    }
    if (draw === 'stamp' || draw === 'filler') {
      // Stamps and areas take their own size: an arrow at scale 1 is 5 m long.
      p.width = defaultDecalWidth(p.kind);
    } else if (p.look) {
      p.color = p.look.color;
      p.width = p.look.width;
    }
    this.paint.settingsChanged();
    this.ctx.changed();
  }

  /** The look the next mark of the current draw takes. */
  currentLook(): LineStyleSpec | null {
    const nm = this.ctx.settings.nodeMarking;
    switch (this.draw) {
      case 'line':
        return { ...nm.lineExtra, style: nm.style, color: nm.color, width: nm.width };
      case 'crosswalk':
        return nm.crosswalk;
      case 'stop':
        return nm.stop;
      default:
        return null;
    }
  }

  /** Give the next marks of the current draw (or the selection) a look. */
  applyLook(spec: LineStyleSpec): void {
    const s = this.ctx.settings;
    const nm = s.nodeMarking;
    const sel = this.selectedDecal !== null ? this.ctx.net.decals.find((d) => d.id === this.selectedDecal) : undefined;
    if (sel && sel.style) {
      this.ctx.history.hint('Restyle marking', `decal-${sel.id}`);
      this.ctx.net.updateDecal(sel.id, { style: { ...spec }, color: spec.color, width: spec.width });
    }
    if (this.node.selection.length) this.node.applyPreset({ id: 'look', name: 'look', kind: 'line', style: spec });
    if (this.draw === 'crosswalk' || spec.style.startsWith('crosswalk')) nm.crosswalk = { ...spec };
    else if (spec.style === 'stopLine' || spec.style === 'sharkTeeth' || spec.style.startsWith('stopLine')) nm.stop = { ...spec };
    else {
      const { style, color, width, ...extra } = spec;
      nm.style = style;
      nm.color = color;
      nm.width = width;
      nm.lineExtra = extra;
    }
    this.setDraw(this.draw);
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  private pick(e: ToolPointer): 'paint' | 'node' | 'own' {
    if (this.paint.startPoint) return 'paint';
    if (this.node.busy) return 'node';
    if (this.node.wantsPointer(e)) return 'node';
    if (this.draw === 'select' || this.draw === 'erase') return 'own';
    return 'paint';
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    const was = this.route;
    this.route = this.pick(e);
    if (was !== this.route) this.ctx.setMarks([]);
    if (this.route === 'paint') this.paint.pointerMove(e);
    else if (this.route === 'node') this.node.pointerMove(e);
    else this.hoverOwn(e);
  }

  pointerDown(e: ToolPointer): void {
    this.pointer = e;
    this.route = this.pick(e);
    if (this.route === 'paint') this.paint.pointerDown(e);
    else if (this.route === 'node') this.node.pointerDown(e);
    else if (e.button === 0) this.clickOwn(e);
  }

  pointerUp(e: ToolPointer): void {
    if (this.route === 'paint') this.paint.pointerUp(e);
    else if (this.route === 'node') this.node.pointerUp(e);
  }

  doubleClick(e: ToolPointer): void {
    if (this.route === 'paint') this.paint.doubleClick(e);
    else if (this.route === 'node') this.node.doubleClick(e);
  }

  wheel(delta: number, e: ToolPointer): boolean {
    return this.route === 'paint' ? this.paint.wheel(delta, e) : this.node.wheel(delta, e);
  }

  // -------------------------------------------------------------------------
  // Pick and Erase along roads: Paint marks, road markings, automatic lines
  // -------------------------------------------------------------------------

  /** What Pick or Erase would take under the pointer, away from the open junction. */
  private targetAt(e: ToolPointer) {
    const decal = pickDecal(this.ctx, e);
    if (decal !== null) return { kind: 'decal' as const, id: decal };
    const ground = pickRoad(this.ctx, e)?.raw ?? pickNodeHit(this.ctx, e)?.point ?? null;
    if (!ground) return null;
    const hit = markingAt(this.ctx.net, ground, { lineReach: this.lineReach(ground) });
    return hit ? { kind: 'marking' as const, hit } : null;
  }

  /** A few pixels round an automatic road line, when zoomed in enough to aim at it. */
  private lineReach(p: { x: number; y: number; z: number }): number | undefined {
    const a = this.ctx.view.project(p);
    const b = this.ctx.view.project({ x: p.x + 1, y: p.y, z: p.z });
    if (!a || !b) return undefined;
    const pxPerMetre = Math.hypot(b.x - a.x, b.y - a.y);
    return pxPerMetre < 18 ? undefined : 5 / pxPerMetre;
  }

  private hoverOwn(e: ToolPointer): void {
    const t = this.targetAt(e);
    const erase = this.draw === 'erase';
    const color = erase ? COLORS.bad : COLORS.snap;
    const marks = [];
    if (this.selectedDecal !== null) {
      const o = decalOutline(this.ctx.net, this.selectedDecal);
      if (o.length > 1) marks.push({ kind: 'line' as const, points: o, color: COLORS.ok, width: 0.35 });
    }
    let note = erase ? 'Click a marking to remove it' : 'Click a marking to pick it';
    if (t?.kind === 'decal') {
      const o = decalOutline(this.ctx.net, t.id);
      if (o.length > 1) marks.push({ kind: 'line' as const, points: o, color, width: 0.35 });
      note = erase ? 'Click to remove this mark' : 'Click to pick this mark';
    } else if (t?.kind === 'marking') {
      const o = hitOutline(this.ctx.net, t.hit);
      if (o.length > 1) marks.push({ kind: 'line' as const, points: o, color, width: 0.35 });
      note = `${erase ? 'Click to remove' : 'Click to pick'} ${hitLabel(this.ctx.net, t.hit)}`;
    }
    this.ctx.setMarks(marks);
    this.ctx.setHud({ x: e.x, y: e.y, lines: [erase ? 'Markings: Erase' : 'Markings: Pick'], notes: [note], tone: erase && t ? 'error' : 'ok' });
  }

  private clickOwn(e: ToolPointer): void {
    const { net, history } = this.ctx;
    const t = this.targetAt(e);
    if (this.draw === 'erase') {
      if (t?.kind === 'decal') {
        history.hint('Remove marking');
        net.removeDecal(t.id);
        if (this.selectedDecal === t.id) this.selectedDecal = null;
      } else if (t?.kind === 'marking') {
        const hit = t.hit;
        history.hint('Remove marking');
        if (hit.kind === 'user') net.removeMarking(hit.host, hit.id);
        else if (hit.kind === 'autoLine') removeAutoLine(net, hit.segmentId, hit.key);
        else removeAutoItem(net, hit.nodeId, hit.item.ref);
      }
    } else {
      this.selectedDecal = t?.kind === 'decal' ? t.id : null;
      // Pick on a plain stretch of road opens its road markings, to draw between its ends.
      if (!t) {
        const road = pickRoad(this.ctx, e);
        if (road) this.node.openSegment(road.segmentId);
      }
      // A road marking opens its road for editing, picked.
      if (t?.kind === 'marking' && t.hit.kind === 'user') {
        const host = t.hit.host;
        if (host.kind === 'node') this.node.open(host.id);
        else this.node.openSegment(host.id);
        this.node.select(t.hit.id);
      }
    }
    this.hoverOwn(e);
    this.ctx.changed();
  }

  /** Remove the picked Paint mark. */
  removeSelectedDecal(): boolean {
    const id = this.selectedDecal;
    if (id === null || !this.ctx.net.decals.some((d) => d.id === id)) return false;
    this.ctx.history.hint('Remove marking');
    this.ctx.net.removeDecal(id);
    this.selectedDecal = null;
    this.ctx.changed();
    return true;
  }

  // -------------------------------------------------------------------------
  // Keys and the rest
  // -------------------------------------------------------------------------

  keyDown(e: ToolKey): boolean {
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrl && this.removeSelectedDecal()) return true;
    // Draw keys work everywhere in the tool, not only with a junction open.
    const draws: Record<string, MarkingDraw> = { v: 'select', l: 'line', c: 'crosswalk', x: 'stop', f: 'filler', t: 'stamp', e: 'erase' };
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!e.ctrl && !e.alt && !e.shift && draws[k]) {
      this.setDraw(draws[k]);
      if (this.pointer) this.pointerMove(this.pointer);
      return true;
    }
    if (this.node.keyDown(e)) return true;
    return this.paint.keyDown(e);
  }

  keyUp(e: ToolKey): boolean {
    return this.node.keyUp(e) || this.paint.keyUp(e);
  }

  back(): boolean {
    if (this.paint.back()) return true;
    // Right-click on the picked Paint mark removes it, as on a picked junction marking.
    if (this.selectedDecal !== null && this.pointer) {
      const t = this.targetAt(this.pointer);
      if (t?.kind === 'decal' && t.id === this.selectedDecal) return this.removeSelectedDecal();
      this.selectedDecal = null;
      this.ctx.changed();
      return true;
    }
    return this.node.back();
  }

  activate(): void {
    this.paint.activate();
    this.node.activate();
  }

  deactivate(): void {
    this.paint.deactivate();
    this.node.deactivate();
    this.selectedDecal = null;
  }

  networkChanged(change: NetworkChange): void {
    this.paint.networkChanged(change);
    this.node.networkChanged(change);
    if (this.selectedDecal !== null && !this.ctx.net.decals.some((d) => d.id === this.selectedDecal)) this.selectedDecal = null;
  }

  settingsChanged(): void {
    this.paint.settingsChanged();
    this.node.settingsChanged();
  }
}

/** The standard a new Line starts as. */
export const DEFAULT_LINE = lineStandard('lane').spec;
