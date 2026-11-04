/**
 * Modify > Upgrade with a card picked: street lights, sound barriers, walls,
 * trees, guard rails, stops, or Remove.
 *
 * A click in the middle of a road covers both sides (or the median, for lights,
 * trees and rails on a road that has one). A click near one edge covers that side.
 * A drag carries the same choice along every road it passes, through plain joints
 * it skipped over. Clicking a road that already has the style takes it off again.
 * One click or drag is one undo step.
 *
 * The road tool hands its Upgrade events here while a card is picked; with no
 * card it does its road-type upgrade as before.
 */
import type { RoadNetwork } from '../core/RoadNetwork';
import { canUpgrade, hasUpgrade, medianOffset, placesFor, upgradeItems, upgradePatch, upgradeZone, upgradesAt, type UpgradeExtras, type UpgradeZone } from '../core/roadUpgrades';
import { sidewalkOn } from '../core/roadTypes';
import { segmentFootprintIssues } from '../core/walls';
import { upgradeCard, type UpgradeCardId, type UpgradePlace } from '../core/upgradeTypes';
import type { Id, SegmentOverrides, Vec3 } from '../core/types';
import type { ToolMark } from '../render/api';
import { pickRoad } from './pick';
import { COLORS, type ToolContext, type ToolPointer } from './types';

/** Sides as the stroke carries them: the middle, or one edge in the world. */
type StrokeKind = 'centre' | 'side';

/** Do two segments meeting at a node run the same way through it? */
function runsOn(net: RoadNetwork, from: Id, to: Id): boolean | null {
  const a = net.getSegment(from);
  const b = net.getSegment(to);
  if (!a || !b) return null;
  if (a.b === b.a || a.a === b.b) return true;
  if (a.a === b.a || a.b === b.b) return false;
  return null;
}

/**
 * The plain-joint path from one segment to another, not counting either end, or
 * null when they are not joined that way within a few pieces.
 */
export function jointPath(net: RoadNetwork, from: Id, to: Id, maxPieces = 12): Id[] | null {
  if (from === to) return [];
  const prev = new Map<Id, Id>([[from, from]]);
  let frontier = [from];
  for (let depth = 0; depth < maxPieces && frontier.length; depth++) {
    const next: Id[] = [];
    for (const id of frontier) {
      const seg = net.getSegment(id);
      if (!seg) continue;
      for (const nodeId of [seg.a, seg.b]) {
        const node = net.getNode(nodeId);
        // Plain joints only: a road continuing, never across a junction.
        if (!node || node.segments.length !== 2) continue;
        for (const other of node.segments) {
          if (prev.has(other)) continue;
          prev.set(other, id);
          if (other === to) {
            const path: Id[] = [];
            for (let at = prev.get(to)!; at !== from; at = prev.get(at)!) path.unshift(at);
            return path;
          }
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * One click or drag of a card. Pure on the network, so tests drive it directly;
 * the tool feeds it picks and wraps it in one undo step.
 */
export class UpgradeStroke {
  /** Segments already done, so a drag back and forth does each once. */
  readonly done = new Set<Id>();
  /** True adds the style, false takes it off. Decided by the first road. */
  on: boolean | null = null;
  kind: StrokeKind | null = null;
  problems: string[] = [];
  private last: { id: Id; side: 'left' | 'right' | null } | null = null;

  constructor(
    private readonly net: RoadNetwork,
    readonly card: UpgradeCardId,
    readonly style: string,
    private readonly extras: UpgradeExtras = {},
  ) {}

  /** The zone a pointer `lateral` metres right of a segment's centreline gives in this stroke. */
  zoneOn(id: Id, lateral: number, carried: 'left' | 'right' | null = null): UpgradeZone {
    const def = this.net.roadTypeOf(id);
    if (this.kind === null) return upgradeZone(def, lateral);
    if (this.kind === 'centre') return 'centre';
    const d = lateral - medianOffset(def);
    if (Math.abs(d) > 0.5 || !carried) return d < 0 ? 'left' : 'right';
    return carried;
  }

  /** Apply to the segment under the pointer, filling plain joints skipped since the last one. */
  visit(id: Id, lateral: number): void {
    if (!canUpgrade(this.net, id)) return;
    if (this.last && this.last.id !== id) {
      const path = jointPath(this.net, this.last.id, id);
      let prev = this.last;
      for (const mid of path ?? []) {
        const side = this.carry(prev, mid);
        this.applyTo(mid, this.kind === 'centre' ? 'centre' : side ?? 'right');
        prev = { id: mid, side };
      }
      if (path) this.last = prev;
    }
    const carried = this.last ? this.carry(this.last, id) : null;
    const zone = this.zoneOn(id, lateral, carried);
    this.applyTo(id, zone);
    this.last = { id, side: zone === 'centre' ? null : zone };
  }

  /** The side a stroke on `prev` lands on in `next`, through the node they share. */
  private carry(prev: { id: Id; side: 'left' | 'right' | null }, next: Id): 'left' | 'right' | null {
    if (!prev.side) return null;
    const same = runsOn(this.net, prev.id, next);
    if (same === null || same) return prev.side;
    return prev.side === 'left' ? 'right' : 'left';
  }

  private applyTo(id: Id, zone: UpgradeZone): void {
    if (this.done.has(id) || !canUpgrade(this.net, id)) return;
    const seg = this.net.getSegment(id)!;
    const def = this.net.roadTypeOf(id);
    const places = placesFor(this.card, def, zone);
    if (this.kind === null) {
      this.kind = zone === 'centre' ? 'centre' : 'side';
      this.on = this.card === 'remove' ? false : !places.every((p) => hasUpgrade(seg.overrides, this.card, p, this.style));
    }
    this.done.add(id);
    const patch = upgradePatch(seg.overrides, this.card, this.style, places, this.on ?? true, this.extras);
    if (patch.structure && this.on) {
      const bad = segmentFootprintIssues(this.net, id, patch.structure).find((i) => i.severity === 'error');
      if (bad) {
        this.problems.push(bad.message);
        return;
      }
    }
    this.net.setSegmentOverrides(id, patch);
  }
}

const PLACE_NAME: Record<UpgradePlace, string> = { left: 'left side', right: 'right side', median: 'median' };

export class UpgradeCardTool {
  private stroke: UpgradeStroke | null = null;
  private pointer: ToolPointer | null = null;

  constructor(private readonly ctx: ToolContext) {}

  /** A card is picked, so Upgrade clicks come here. */
  get active(): boolean {
    return this.ctx.settings.upgradeCards.card !== null;
  }

  private get card(): UpgradeCardId {
    return this.ctx.settings.upgradeCards.card!;
  }

  private get style(): string {
    return this.ctx.settings.upgradeCards.styles[this.card] ?? upgradeCard(this.card).defaultStyle;
  }

  private extras(): UpgradeExtras {
    const w = this.ctx.settings.walls;
    return { wallStyle: w.style, wallTop: w.top, barrierHeight: w.barrierHeight };
  }

  down(e: ToolPointer): void {
    this.pointer = e;
    const def = upgradeCard(this.card);
    this.stroke = new UpgradeStroke(this.ctx.net, this.card, this.style, this.extras());
    this.ctx.history.begin(this.card === 'remove' ? 'Remove road upgrades' : def.label);
    this.visit(e);
    this.refresh(e);
  }

  move(e: ToolPointer): void {
    this.pointer = e;
    if (this.stroke) this.visit(e);
    this.refresh(e);
  }

  up(): void {
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    this.ctx.history.end();
    if (s.problems.length) this.ctx.toast(s.problems[0], 'error');
    this.refresh(this.pointer);
  }

  cancel(): void {
    if (this.stroke) {
      this.stroke = null;
      this.ctx.history.end();
    }
  }

  private visit(e: ToolPointer): void {
    const hit = pickRoad(this.ctx, e, 0, (id) => canUpgrade(this.ctx.net, id));
    if (hit) this.stroke!.visit(hit.segmentId, hit.lateral);
  }

  /** Hover: the ghost of the result, with the side it goes on picked out. */
  refresh(e: ToolPointer | null): void {
    const { net, view } = this.ctx;
    view.setPreview([]);
    if (!e) {
      view.setHighlight(null);
      this.ctx.setMarks([]);
      this.ctx.setHud(null);
      return;
    }
    const def = upgradeCard(this.card);
    const styleName = def.styles.find((s) => s.value === this.style)?.label ?? this.style;
    const title = this.card === 'remove' ? 'Remove upgrades' : `${def.label}: ${styleName}`;
    const hit = pickRoad(this.ctx, e, 0, (id) => canUpgrade(net, id));
    if (!hit) {
      view.setHighlight(null);
      this.ctx.setMarks([]);
      this.ctx.setHud({ x: e.x, y: e.y, lines: [title], notes: ['Middle of a road for both sides, near an edge for one. Drag along'], tone: 'ok' });
      return;
    }
    const id = hit.segmentId;
    const seg = net.getSegment(id)!;
    const road = net.roadTypeOf(id);
    const probe = this.stroke ?? new UpgradeStroke(net, this.card, this.style, this.extras());
    const zone = probe.zoneOn(id, hit.lateral);
    const places = placesFor(this.card, road, zone);
    const on = this.stroke?.on ?? (this.card !== 'remove' && !places.every((p) => hasUpgrade(seg.overrides, this.card, p, this.style)));
    const next: SegmentOverrides = { ...seg.overrides, ...upgradePatch(seg.overrides, this.card, this.style, places, on, this.extras()) };
    const colour = on ? COLORS.ok : COLORS.bad;
    const marks: ToolMark[] = [];
    for (const p of places) {
      const line = this.sideLine(id, p);
      if (line.length > 1) marks.push({ kind: 'line', points: line, color: COLORS.snap, width: 0.5 });
    }
    // The ghost: what will stand there afterwards, or what goes.
    const items = upgradeItems(net, id, on ? next : seg.overrides);
    for (const pt of items.points) {
      if (!places.includes(pt.place)) continue;
      const lift = pt.kind === 'lamp' ? 1.2 : 0.6;
      marks.push({ kind: 'point', pos: { ...pt.pos, y: pt.pos.y + lift }, color: colour, radius: pt.kind === 'tree' ? 0.9 : 0.7 });
    }
    for (const st of items.strips) {
      if (!places.includes(st.place)) continue;
      marks.push({ kind: 'line', points: st.points.map((q) => ({ ...q, y: q.y + 0.4 })), color: colour, width: Math.max(0.25, Math.min(st.width, 0.8)), dashed: !on });
    }
    view.setHighlight({ segments: [id], color: on ? COLORS.snap : COLORS.bad });
    this.ctx.setMarks(marks);
    const where = places.length === 2 && places.includes('left') && places.includes('right') ? 'both sides' : places.map((p) => PLACE_NAME[p]).join(', ');
    const lines = [title, `${on ? 'Adds to' : 'Removes from'} ${where === 'both sides' ? where : `the ${where}`}`];
    const notes: string[] = [];
    if (this.card === 'remove') {
      const has = places.flatMap((p) => upgradesAt(seg.overrides, p));
      notes.push(has.length ? `Clears ${[...new Set(has)].join(', ')}` : 'Nothing to clear here');
    } else if (!this.stroke) notes.push(on ? 'Drag along to carry on' : 'Already there: click to take it off');
    this.ctx.setHud({ x: e.x, y: e.y, lines, notes, tone: on ? 'ok' : 'warning' });
  }

  /** The edge a place is on, as a line along the visible road. */
  private sideLine(id: Id, place: UpgradePlace): Vec3[] {
    const net = this.ctx.net;
    const st = net.segmentGeom(id)?.stations ?? [];
    const def = net.roadTypeOf(id);
    let off: number;
    if (place === 'median') off = medianOffset(def);
    else {
      const side = place === 'left' ? -1 : 1;
      off = side * (def.halfWidth + sidewalkOn(def, side) * 0.5);
    }
    return st.map((s) => ({ x: s.pos.x + s.right.x * off, y: s.pos.y + 0.3, z: s.pos.z + s.right.z * off }));
  }
}
