/**
 * Node Markings: annotate one node by clicking anchors on its arms. Lines between
 * arms take a computed curve, tangent to the lanes at both ends. Nothing is drawn
 * or shaped by hand, and everything is stored by arm and boundary, not by position.
 */
import { distXZ } from '../core/math';
import {
  acrossOneArm,
  anchorCurve,
  armFrames,
  armRow,
  fillerPolygon,
  lanePath,
  markingPath,
  nodeAnchors,
  outlineAnchors,
  outlinePath,
  resolveAnchor,
  sameAnchor,
  sampleCurve,
  type AnchorPoint,
} from '../core/nodeMarkings';
import type { NodeLineMarking } from '../core/types';
import type { NetworkChange, RoadNetwork } from '../core/RoadNetwork';
import type { Id, MarkingAnchor, NodeLineStyle, NodeMarking, Vec3 } from '../core/types';
import type { ToolMark } from '../render/api';
import { nodeReach, pickNode } from './pick';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolKey, type ToolPointer } from './types';

const ANCHOR_REACH = 1.4;
const PICK_LINE = 1.2;
/** How far back along an arm a row of anchors can be laid. */
const ROW_REACH = 40;
const ROW_STEP = 0.5;
/**
 * Distances back from the cut line where the automatic paint sits: the middle of a
 * crosswalk and its stop line, from src/render/markings.ts. Rows catch on them so
 * hand-placed lines meet the drawn ones.
 */
const AUTO_STOPS = [0.5 + 3 / 2, 0.5 + 3 + 0.9 + 0.45 / 2];
const STOP_CATCH = 0.6;

export const NODE_LINE_STYLES: readonly { value: NodeLineStyle; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'double', label: 'Double' },
  { value: 'solidDashed', label: 'Solid and dashed' },
  { value: 'dotted', label: 'Dotted' },
  { value: 'stopLine', label: 'Stop line' },
  { value: 'crosswalkZebra', label: 'Crosswalk, zebra' },
  { value: 'crosswalkLadder', label: 'Crosswalk, ladder' },
  { value: 'crosswalkLines', label: 'Crosswalk, lines' },
];

function pointInPolygon(p: Vec3, poly: readonly Vec3[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Points no further apart than a metre, so picking can test distance to points. */
function dense(path: readonly Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z)));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y, z: a.z + ((b.z - a.z) * k) / n });
  }
  if (path.length) out.push(path[path.length - 1]);
  return out;
}

export class NodeMarkingTool extends Tool {
  readonly id: ToolId = 'nodeMarkings';
  private nodeId: Id | null = null;
  private selectedId: Id | null = null;
  private first: MarkingAnchor | null = null;
  private corners: MarkingAnchor[] = [];
  private hover: AnchorPoint | null = null;
  /** The row of anchors across an arm under the cursor, if any. */
  private row: AnchorPoint[] = [];

  get node(): Id | null {
    return this.nodeId;
  }

  get selected(): Id | null {
    return this.selectedId;
  }

  get pendingCorners(): number {
    return this.corners.length;
  }

  get pendingFirst(): MarkingAnchor | null {
    return this.first;
  }

  private get markings(): readonly NodeMarking[] {
    return this.nodeId === null ? [] : (this.ctx.net.getNode(this.nodeId)?.control.markings ?? []);
  }

  /** Anchors at this node: cut lines, the outline, and the row under the cursor. */
  private allAnchors(): AnchorPoint[] {
    if (this.nodeId === null) return [];
    const { net } = this.ctx;
    return [...nodeAnchors(net, this.nodeId), ...outlineAnchors(net, this.nodeId), ...this.row];
  }

  /** A row across whichever arm the cursor is over, back from its cut line. */
  private updateRow(e: ToolPointer): void {
    this.row = [];
    if (this.nodeId === null) return;
    const { net, view } = this.ctx;
    for (const frame of armFrames(net, this.nodeId)) {
      const raw = view.pickPlane(e.x, e.y, frame.pos.y);
      if (!raw) continue;
      const back = -((raw.x - frame.pos.x) * frame.inward.x + (raw.z - frame.pos.z) * frame.inward.z);
      const across = (raw.x - frame.pos.x) * frame.right.x + (raw.z - frame.pos.z) * frame.right.z;
      const half = Math.max(...frame.offsets.map(Math.abs));
      if (back < 0.75 || back > ROW_REACH || Math.abs(across) > half + 1) continue;
      let at = Math.round(back / ROW_STEP) * ROW_STEP;
      for (const stop of AUTO_STOPS) if (Math.abs(back - stop) < STOP_CATCH) at = stop;
      this.row = armRow(net, this.nodeId, frame.segmentId, at);
      return;
    }
  }

  private anchorAt(e: ToolPointer): AnchorPoint | null {
    if (this.nodeId === null) return null;
    const { view } = this.ctx;
    let best: AnchorPoint | null = null;
    let bestD = ANCHOR_REACH;
    for (const a of this.allAnchors()) {
      const raw = view.pickPlane(e.x, e.y, a.pos.y);
      if (!raw) continue;
      const d = distXZ(raw, a.pos);
      if (d <= bestD) {
        best = a;
        bestD = d;
      }
    }
    return best;
  }

  private markingAt(e: ToolPointer): Id | null {
    if (this.nodeId === null) return null;
    const { net, view } = this.ctx;
    const y = net.getNode(this.nodeId)?.pos.y ?? 0;
    const raw = view.pickPlane(e.x, e.y, y);
    if (!raw) return null;
    for (const m of [...this.markings].reverse()) {
      if (m.kind === 'filler') {
        const poly = fillerPolygon(net, this.nodeId, m);
        if (poly && pointInPolygon(raw, poly)) return m.id;
        continue;
      }
      const path = markingPath(net, this.nodeId, m);
      if (path && dense(path).some((p) => distXZ(p, raw) <= PICK_LINE)) return m.id;
    }
    return null;
  }

  /** The path a new line between two anchors takes. */
  private pathFor(a: MarkingAnchor, b: MarkingAnchor): Pick<NodeLineMarking, 'straight' | 'path'> {
    const { net, settings } = this.ctx;
    const lineLike = ['solid', 'dashed', 'double', 'solidDashed', 'dotted'].includes(settings.nodeMarking.style);
    if (this.nodeId !== null && lineLike) {
      if (outlinePath(net, this.nodeId, a, b)) return { straight: false, path: 'outline' };
      if (settings.nodeMarking.followLanes && a.segmentId !== b.segmentId && lanePath(net, this.nodeId, a, b)) {
        return { straight: false, path: 'lanes' };
      }
    }
    return { straight: this.isStraight(a, b) };
  }

  /** Both anchors on one arm make a line across it, which is never a curve. */
  private isStraight(a: MarkingAnchor, b: MarkingAnchor): boolean {
    const { nodeMarking } = this.ctx.settings;
    return acrossOneArm(a, b) || !nodeMarking.curved || !['solid', 'dashed', 'double', 'solidDashed', 'dotted'].includes(nodeMarking.style);
  }

  private show(e: ToolPointer | null): void {
    const { net, view, settings } = this.ctx;
    const marks: ToolMark[] = [];
    const nodeId = this.nodeId;
    if (nodeId !== null) {
      for (const a of this.allAnchors()) {
        const hot = this.hover && sameAnchor(this.hover.anchor, a.anchor);
        const color = hot ? COLORS.ok : a.anchor.corner !== undefined ? COLORS.warn : a.edge ? COLORS.snap : COLORS.neutral;
        marks.push({ kind: 'point', pos: a.pos, color, radius: hot ? 0.6 : a.anchor.corner !== undefined ? 0.3 : 0.4 });
      }
      const selected = this.markings.find((m) => m.id === this.selectedId);
      if (selected?.kind === 'line') {
        const path = markingPath(net, nodeId, selected);
        if (path) marks.push({ kind: 'line', points: path, color: COLORS.ok, width: Math.max(0.35, selected.width + 0.2) });
      } else if (selected?.kind === 'filler') {
        const poly = fillerPolygon(net, nodeId, selected);
        if (poly) marks.push({ kind: 'line', points: [...poly, poly[0]], color: COLORS.ok, width: 0.3 });
      }
      if (this.first) {
        const p = resolveAnchor(net, nodeId, this.first);
        if (p) {
          marks.push({ kind: 'ring', pos: p.pos, color: COLORS.ok, radius: 0.9 });
          if (this.hover && !sameAnchor(this.hover.anchor, this.first)) {
            const path = this.previewPath(this.first, this.hover);
            marks.push({ kind: 'line', points: path, color: settings.nodeMarking.color, width: 0.3, dashed: settings.nodeMarking.style === 'dashed' });
          }
        }
      }
      if (this.corners.length) {
        const pts: Vec3[] = [];
        for (const a of this.corners) {
          const p = resolveAnchor(net, nodeId, a);
          if (p) pts.push(p.pos);
        }
        if (this.hover) pts.push(this.hover.pos);
        for (const p of pts) marks.push({ kind: 'ring', pos: p, color: COLORS.ok, radius: 0.7 });
        if (pts.length > 1) marks.push({ kind: 'line', points: pts.length > 2 ? [...pts, pts[0]] : pts, color: settings.nodeMarking.color, width: 0.3, dashed: true });
      }
      // No tint on the node being edited, so the markings stay visible.
      view.setHighlight(null);
    }
    this.ctx.setMarks(marks);
    if (!e) return;
    let note = 'Click a node';
    if (nodeId !== null) {
      if (settings.nodeMarking.mode === 'filler') {
        note = this.corners.length >= 3 ? 'Click the first anchor or press Enter to close' : 'Click anchors around the area';
      } else {
        note = this.first ? 'Click the second anchor' : 'Click the first anchor, or a marking to edit it';
      }
    }
    this.ctx.setHud({ x: e.x, y: e.y, lines: ['Node markings'], notes: [note], tone: 'ok' });
  }

  private previewPath(first: MarkingAnchor, hover: AnchorPoint): Vec3[] {
    const { net } = this.ctx;
    const p = resolveAnchor(net, this.nodeId!, first)!;
    const choice = this.pathFor(first, hover.anchor);
    if (choice.path === 'outline') return outlinePath(net, this.nodeId!, first, hover.anchor) ?? [p.pos, hover.pos];
    if (choice.path === 'lanes') return lanePath(net, this.nodeId!, first, hover.anchor) ?? [p.pos, hover.pos];
    return sampleCurve(anchorCurve(p, hover, choice.straight), 1);
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    this.updateRow(e);
    this.hover = this.anchorAt(e);
    if (this.nodeId === null) {
      const hover = pickNode(this.ctx, e);
      this.ctx.view.setHighlight(hover === null ? null : { nodes: [hover], color: COLORS.snap });
    }
    this.show(e);
  }

  open(id: Id): void {
    this.nodeId = id;
    this.first = null;
    this.corners = [];
    this.selectedId = null;
    this.ctx.inspect({ kind: 'nodeMarkings', id });
    this.show(this.pointer);
    this.ctx.changed();
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    const { net, settings } = this.ctx;
    this.updateRow(e);
    this.hover = this.anchorAt(e);
    const anchor = this.hover;
    if (anchor) {
      if (settings.nodeMarking.mode === 'filler') this.clickCorner(anchor.anchor);
      else this.clickLine(anchor.anchor);
      this.show(e);
      this.ctx.changed();
      return;
    }
    const marking = this.markingAt(e);
    if (marking !== null) {
      this.select(marking);
      return;
    }
    const near = this.nodeId === null ? null : net.getNode(this.nodeId);
    const raw = near ? this.ctx.view.pickPlane(e.x, e.y, near.pos.y) : null;
    const insideCurrent =
      near && raw && (pickNode(this.ctx, e, (n) => n === near.id) !== null || distXZ(raw, near.pos) <= nodeReach(net, near.id) * 2);
    if (insideCurrent) return;
    const id = pickNode(this.ctx, e);
    if (id !== null && id !== this.nodeId) this.open(id);
  }

  private clickLine(anchor: MarkingAnchor): void {
    if (!this.first) {
      this.first = anchor;
      return;
    }
    if (sameAnchor(this.first, anchor)) {
      this.first = null;
      return;
    }
    const { net, settings, history } = this.ctx;
    const { style, color, width } = settings.nodeMarking;
    history.hint('Add marking');
    this.selectedId = net.addNodeMarking(this.nodeId!, {
      kind: 'line',
      from: this.first,
      to: anchor,
      style,
      color,
      width,
      ...this.pathFor(this.first, anchor),
    });
    this.first = null;
  }

  private clickCorner(anchor: MarkingAnchor): void {
    if (this.corners.length >= 3 && sameAnchor(this.corners[0], anchor)) {
      this.closeFiller();
      return;
    }
    if (this.corners.some((c) => sameAnchor(c, anchor))) return;
    this.corners.push(anchor);
  }

  /** Finish the area being clicked. Returns false with fewer than three corners. */
  closeFiller(): boolean {
    if (this.nodeId === null || this.corners.length < 3) return false;
    const { net, settings, history } = this.ctx;
    const { fill, color, fillWidth } = settings.nodeMarking;
    history.hint('Add filler');
    this.selectedId = net.addNodeMarking(this.nodeId, { kind: 'filler', anchors: this.corners, fill, color, width: fillWidth });
    this.corners = [];
    this.show(this.pointer);
    this.ctx.changed();
    return true;
  }

  select(id: Id | null): void {
    this.selectedId = id;
    this.show(this.pointer);
    this.ctx.changed();
  }

  /** Remove the selected marking, or `id`. */
  remove(id: Id | null = this.selectedId): void {
    if (this.nodeId === null || id === null) return;
    this.ctx.history.hint('Delete marking');
    this.ctx.net.removeNodeMarking(this.nodeId, id);
    if (this.selectedId === id) this.selectedId = null;
    this.show(this.pointer);
    this.ctx.changed();
  }

  clearAll(): void {
    if (this.nodeId === null) return;
    this.ctx.history.hint('Clear markings');
    this.ctx.net.clearNodeMarkings(this.nodeId);
    this.selectedId = null;
    this.show(this.pointer);
    this.ctx.changed();
  }

  setHideAuto(hide: boolean): void {
    if (this.nodeId === null) return;
    this.ctx.history.hint('Toggle automatic markings');
    this.ctx.net.setHideAutoMarkings(this.nodeId, hide);
    this.ctx.changed();
  }

  /** Edit the selected marking. Repeated edits merge, as a slider's do. */
  update(patch: Parameters<RoadNetwork['updateNodeMarking']>[2], key: string): void {
    if (this.nodeId === null || this.selectedId === null) return;
    this.ctx.history.hint('Edit marking', `marking-${this.selectedId}-${key}`);
    this.ctx.net.updateNodeMarking(this.nodeId, this.selectedId, patch);
    this.show(this.pointer);
  }

  keyDown(e: ToolKey): boolean {
    if (e.key === 'Enter') return this.closeFiller();
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedId !== null) {
      this.remove();
      return true;
    }
    return false;
  }

  back(): boolean {
    if (this.first) this.first = null;
    else if (this.corners.length) this.corners.pop();
    else if (this.selectedId !== null) this.selectedId = null;
    else if (this.nodeId !== null) {
      this.nodeId = null;
      this.ctx.inspect(null);
      this.ctx.view.setHighlight(null);
    } else return false;
    this.show(this.pointer);
    this.ctx.changed();
    return true;
  }

  activate(): void {
    this.show(null);
  }

  settingsChanged(): void {
    if (this.ctx.settings.nodeMarking.mode === 'filler') this.first = null;
    else this.corners = [];
    this.show(this.pointer);
  }

  networkChanged(_change: NetworkChange): void {
    const { net } = this.ctx;
    if (this.nodeId !== null && !net.getNode(this.nodeId)) {
      this.nodeId = null;
      this.ctx.inspect(null);
    }
    if (this.selectedId !== null && !this.markings.some((m) => m.id === this.selectedId)) this.selectedId = null;
    const live = (a: MarkingAnchor) => this.nodeId !== null && !!resolveAnchor(net, this.nodeId, a);
    if (this.first && !live(this.first)) this.first = null;
    this.corners = this.corners.filter(live);
    this.show(this.pointer);
  }

  deactivate(): void {
    this.nodeId = null;
    this.selectedId = null;
    this.first = null;
    this.corners = [];
    this.hover = null;
    this.ctx.inspect(null);
  }
}
