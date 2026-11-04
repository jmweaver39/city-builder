/**
 * Junction markings editor. Click a junction (or a plain stretch of road) and every
 * marking on it, automatic and hand-placed, is outlined and can be hovered, picked
 * and deleted. A draw tool is always armed (Line by default), and its anchors
 * appear on the arm under the cursor as soon as you go to draw. Lines go between
 * any two anchors, on one arm or across the junction; crosswalks and stop lines go
 * across an arm with one click; areas go round anchors. A selected marking has
 * handles: drag a line's end to another anchor, a crosswalk along its arm or by its
 * edges, an area's corners between anchors. Everything is stored by arm and
 * boundary, never by position, so it follows the roads.
 */
import { stackedWith } from '../core/paintCoherence';
import { isRampJunction } from '../render/gore';
import { distXZ } from '../core/math';
import { lineStyleInfo, isPathStyle, LINE_STYLE_INFO, fillPatch, stylePatch, styleOf, fillOf } from '../core/markingStyle';
import { applyTemplate, captureTemplate, fitTemplate, type TemplateFit } from '../core/markingTemplates';
import {
  acrossOneArm,
  anchorCurve,
  armRow,
  fillerPolygon,
  framesOf,
  lanePath,
  markingPath,
  nodeAnchors,
  outlineAnchors,
  outlinePath,
  resolveAnchor,
  sameAnchor,
  sameHost,
  sampleCurve,
  type AnchorPoint,
  type ArmFrame,
} from '../core/nodeMarkings';
import { effectiveLanes } from '../core/roadTypes';
import type { NetworkChange, RoadNetwork } from '../core/RoadNetwork';
import type {
  Id,
  LineStyleSpec,
  MarkingAnchor,
  MarkingHost,
  MarkingPointSetting,
  MarkingPreset,
  MarkingTemplate,
  NodeFillerMarking,
  NodeLineMarking,
  NodeLineStyle,
  NodeMarking,
  Vec3,
} from '../core/types';
import type { ToolMark } from '../render/api';
import type { AutoItem } from '../render/autoItems';
import { cachedAutoItems, convertAutoItem, removeAutoItem, restoreAutoItem, userMarkingAt } from './markingOps';
import { autoItemAt } from '../render/autoItems';
import { nodeReach, pickNode, pickRoad } from './pick';
import { Tool } from './Tool';
import { COLORS, type MarkingDraw, type ToolId, type ToolKey, type ToolPointer } from './types';

const ANCHOR_REACH = 1.4;
const HANDLE_REACH = 1.1;
/** How far back along an arm a row of anchors can be laid. */
const ROW_REACH = 40;
const ROW_STEP = 0.5;
/** Anchors show on an arm once the cursor is this close to its cut line or a row on it. */
const SHOW_REACH = 7;
/**
 * Distances back from the cut line where the automatic paint sits: the middle of a
 * crosswalk and its stop line, from src/render/markings.ts. Rows catch on them so
 * hand-placed lines meet the drawn ones.
 */
const AUTO_STOPS = [0.5 + 3 / 2, 0.5 + 3 + 0.9 + 0.45 / 2];
const STOP_CATCH = 0.6;
const CROSSWALK_BACK = AUTO_STOPS[0];
const STOP_BACK = AUTO_STOPS[1];

/** The visual language: selected in the accent colour, hovered in a light outline, automatic paint with a quiet badge. */
export const MARK_COLORS = {
  selected: COLORS.snap,
  hover: '#f4f7fb',
  user: 'rgba(255,255,255,0.55)',
  auto: '#9aa4b2',
  badge: '#9aa4b2',
  handle: COLORS.snap,
  anchor: COLORS.neutral,
  enter: '#7ee0a5',
  exit: '#8fb8ff',
  kerb: COLORS.warn,
};

/** Line styles offered for lines between anchors, in panel order. Kept for older imports. */
export const NODE_LINE_STYLES: readonly { value: NodeLineStyle; label: string }[] = LINE_STYLE_INFO.filter((s) => s.value !== 'empty').map((s) => ({ value: s.value, label: s.label }));

type Drag =
  | { kind: 'end'; id: Id; which: 'from' | 'to' }
  | { kind: 'corner'; id: Id; index: number }
  | { kind: 'across'; id: Id; segmentId: Id; end?: 'a' | 'b' }
  | { kind: 'depth'; id: Id; segmentId: Id; end?: 'a' | 'b' };

interface Handle {
  pos: Vec3;
  drag: Drag;
}

export class NodeMarkingTool extends Tool {
  readonly id: ToolId = 'nodeMarkings';
  private hostRef: MarkingHost | null = null;
  private selectedIds: Id[] = [];
  private autoKey: string | null = null;
  private first: MarkingAnchor | null = null;
  private corners: MarkingAnchor[] = [];
  private hover: AnchorPoint | null = null;
  /** The row of anchors across an arm under the cursor, if any. */
  private row: AnchorPoint[] = [];
  private rowFrame: { segmentId: Id; end?: 'a' | 'b'; back: number } | null = null;
  private hoverUser: Id | null = null;
  private hoverAuto: AutoItem | null = null;
  private drag: Drag | null = null;
  private dragMoved = false;
  /** Copied markings, as a template. The UI keeps it across sessions through `onClipboard`. */
  clipboard: MarkingTemplate | null = null;
  onClipboard: ((tpl: MarkingTemplate) => void) | null = null;
  /** The template last applied here and the fits it had, for Rotate and Mirror. */
  private lastFit: { tpl: MarkingTemplate; fits: TemplateFit[]; index: number } | null = null;

  /** The node being edited, when it is a node. */
  get node(): Id | null {
    return this.hostRef?.kind === 'node' ? this.hostRef.id : null;
  }

  get host(): MarkingHost | null {
    return this.hostRef;
  }

  get selected(): Id | null {
    return this.selectedIds[0] ?? null;
  }

  get selection(): readonly Id[] {
    return this.selectedIds;
  }

  /** The key of the automatic marking selected, if one is. */
  get selectedAuto(): AutoItem | null {
    if (this.node === null || !this.autoKey) return null;
    return cachedAutoItems(this.ctx.net, this.node).find((i) => i.key === this.autoKey) ?? null;
  }

  get pendingCorners(): number {
    return this.corners.length;
  }

  get pendingFirst(): MarkingAnchor | null {
    return this.first;
  }

  get templateFit(): { fits: TemplateFit[]; index: number } | null {
    return this.lastFit ? { fits: this.lastFit.fits, index: this.lastFit.index } : null;
  }

  get draw(): MarkingDraw {
    return this.ctx.settings.nodeMarking.draw;
  }

  private get markings(): readonly NodeMarking[] {
    return this.hostRef ? this.ctx.net.markingsOf(this.hostRef) : [];
  }

  private get drawing(): boolean {
    return this.first !== null || this.corners.length > 0;
  }

  /** Mid-gesture: a drag, a line's first anchor, or an area's corners. */
  get busy(): boolean {
    return this.drag !== null || this.drawing;
  }

  /**
   * Whether junction design should take this pointer (the merged Markings tool asks):
   * mid-gesture, over the open host's anchors, handles or markings, over a junction
   * or transition surface, or over the open road while drawing crossings, stop lines
   * or areas on it.
   */
  wantsPointer(e: ToolPointer): boolean {
    if (this.busy) return true;
    const raw = this.updateHover(e);
    const host = this.hostRef;
    if (host) {
      if (this.hover || this.hoverUser !== null || this.hoverAuto) return true;
      // A crossing or stop line laid across one of the open host's arms.
      if ((this.draw === 'crosswalk' || this.draw === 'stop') && this.acrossAnchors(this.draw)) return true;
      if (this.handleAt(raw)) return true;
      if (host.kind === 'node') {
        const node = this.ctx.net.getNode(host.id);
        if (node && raw && (pickNode(this.ctx, e, (n) => n === node.id) !== null || distXZ(raw, node.pos) <= nodeReach(this.ctx.net, node.id) * 1.4)) return true;
      } else if (this.draw !== 'line' && this.draw !== 'stamp' && pickRoad(this.ctx, e)?.segmentId === host.id) return true;
    }
    if (this.draw === 'stamp') return false;
    // A junction, transition, merge or joint; not a dead end's cap.
    const id = pickNode(this.ctx, e);
    const g = id === null ? null : this.ctx.net.nodeGeom(id);
    return !!g && g.arms.length >= 2 && g.kind !== 'deadEnd' && g.kind !== 'empty';
  }

  private get anchorDraw(): boolean {
    const d = this.draw;
    return d === 'line' || d === 'filler';
  }

  // -------------------------------------------------------------------------
  // Anchors
  // -------------------------------------------------------------------------

  /** Anchors of the host: cut lines, the kerb outline at a node, and the row under the cursor. */
  private allAnchors(): AnchorPoint[] {
    if (!this.hostRef) return [];
    const { net } = this.ctx;
    const out = [...nodeAnchors(net, this.hostRef), ...this.row];
    if (this.hostRef.kind === 'node') out.push(...outlineAnchors(net, this.hostRef.id));
    return out;
  }

  /** Anchors worth showing now: all of them while drawing, or those near the cursor once it goes to draw. */
  private shownAnchors(raw: Vec3 | null): AnchorPoint[] {
    if (!this.anchorDraw && !this.drag) return [];
    const all = this.allAnchors();
    if (this.drawing || this.drag) return all;
    if (!raw) return [];
    // The arm under the cursor: any of its anchors close by brings in the whole arm.
    const near = new Set<string>();
    for (const a of all) {
      if (distXZ(a.pos, raw) <= SHOW_REACH) near.add(`${a.anchor.segmentId}:${a.anchor.end ?? ''}:${a.anchor.corner === undefined ? 'cut' : 'kerb'}`);
    }
    return all.filter((a) => near.has(`${a.anchor.segmentId}:${a.anchor.end ?? ''}:${a.anchor.corner === undefined ? 'cut' : 'kerb'}`));
  }

  /** The row across whichever arm the cursor is over, back from its cut line. */
  private updateRow(raw: Vec3 | null): void {
    this.row = [];
    this.rowFrame = null;
    if (!this.hostRef || !raw) return;
    const { net } = this.ctx;
    const segHost = this.hostRef.kind === 'segment';
    for (const frame of framesOf(net, this.hostRef)) {
      const back = (raw.x - frame.pos.x) * frame.backDir.x + (raw.z - frame.pos.z) * frame.backDir.z;
      const across = (raw.x - frame.pos.x) * frame.right.x + (raw.z - frame.pos.z) * frame.right.z;
      const half = Math.max(...frame.offsets.map(Math.abs));
      const reach = segHost ? (net.segmentGeom(frame.segmentId)?.length ?? 0) / 2 : ROW_REACH;
      if (back < 0.75 || back > reach || Math.abs(across) > half + 1) continue;
      let at = Math.round(back / ROW_STEP) * ROW_STEP;
      if (!segHost) for (const stop of AUTO_STOPS) if (Math.abs(back - stop) < STOP_CATCH) at = stop;
      this.row = armRow(net, this.hostRef, frame.segmentId, at, frame.end);
      this.rowFrame = { segmentId: frame.segmentId, end: frame.end, back: at };
      return;
    }
  }

  private anchorAt(raw: Vec3 | null): AnchorPoint | null {
    if (!this.hostRef || !raw) return null;
    let best: AnchorPoint | null = null;
    let bestD = ANCHOR_REACH;
    for (const a of this.allAnchors()) {
      if (a.off) continue;
      const d = distXZ(raw, a.pos);
      if (d <= bestD) {
        best = a;
        bestD = d;
      }
    }
    return best;
  }

  private ground(e: Pick<ToolPointer, 'x' | 'y'>): Vec3 | null {
    const { net, view } = this.ctx;
    const y = this.hostRef?.kind === 'node' ? (net.getNode(this.hostRef.id)?.pos.y ?? 0) : this.hostRef ? net.cubicOf(this.hostRef.id).p0.y : 0;
    return view.pickPlane(e.x, e.y, y);
  }

  private frameOf(segmentId: Id, end?: 'a' | 'b'): ArmFrame | undefined {
    return this.hostRef ? framesOf(this.ctx.net, this.hostRef).find((f) => f.segmentId === segmentId && f.end === end) : undefined;
  }

  // -------------------------------------------------------------------------
  // Paths and styles of new markings
  // -------------------------------------------------------------------------

  /** The look a new line gets from the settings. */
  lineSpec(): LineStyleSpec {
    const s = this.ctx.settings.nodeMarking;
    return { ...s.lineExtra, style: s.style, color: s.color, width: s.width };
  }

  /** The path a new line between two anchors takes. */
  private pathFor(a: MarkingAnchor, b: MarkingAnchor, style: NodeLineStyle = this.ctx.settings.nodeMarking.style): Pick<NodeLineMarking, 'straight' | 'path'> {
    const { net, settings } = this.ctx;
    const host = this.hostRef;
    if (host?.kind === 'node' && isPathStyle(style)) {
      if (outlinePath(net, host.id, a, b)) return { straight: false, path: 'outline' };
      if (settings.nodeMarking.followLanes && !acrossOneArm(a, b) && lanePath(net, host.id, a, b)) return { straight: false, path: 'lanes' };
    }
    return { straight: acrossOneArm(a, b) || !settings.nodeMarking.curved || !isPathStyle(style) };
  }

  private previewPath(first: MarkingAnchor, hover: AnchorPoint): Vec3[] {
    const { net } = this.ctx;
    const host = this.hostRef!;
    const p = resolveAnchor(net, host, first)!;
    const choice = this.pathFor(first, hover.anchor);
    const path = markingPath(net, host, { from: first, to: hover.anchor, ...choice });
    return path ?? sampleCurve(anchorCurve(p, hover, choice.straight), 1);
  }

  /** Boundaries of an arm spanning the lanes that run into the junction: kerb to centre line. */
  private incomingSpan(frame: ArmFrame): [number, number] {
    const { net } = this.ctx;
    const seg = net.getSegment(frame.segmentId)!;
    const lanes = effectiveLanes(net.roadTypeOf(frame.segmentId), seg.overrides);
    // Lanes heading into the host: towards a when the arm's back runs towards b.
    const inDir = this.hostRef?.kind === 'segment' ? 1 : frame.backSign === 1 ? -1 : 1;
    const inc = lanes.filter((l) => l.dir === inDir && l.kind !== 'bike');
    if (!inc.length) return [0, frame.offsets.length - 1];
    const lo = Math.min(...inc.map((l) => l.offset - l.width / 2));
    const hi = Math.max(...inc.map((l) => l.offset + l.width / 2));
    const nearest = (x: number) => {
      let best = 0;
      frame.offsets.forEach((o, i) => {
        if (Math.abs(o - x) < Math.abs(frame.offsets[best] - x)) best = i;
      });
      return best;
    };
    return [nearest(lo), nearest(hi)];
  }

  /** The anchors a one-click crosswalk or stop line takes on the arm under the cursor. */
  private acrossAnchors(kind: 'crosswalk' | 'stop'): { from: MarkingAnchor; to: MarkingAnchor } | null {
    const rf = this.rowFrame;
    if (!rf) return null;
    const frame = this.frameOf(rf.segmentId, rf.end);
    if (!frame) return null;
    const s = this.ctx.settings.nodeMarking;
    const depth = kind === 'crosswalk' ? s.crosswalk.width : s.stop.width;
    let back = rf.back;
    // Near the junction, catch on where the automatic paint would be.
    if (this.hostRef?.kind === 'node') {
      const auto = kind === 'crosswalk' ? CROSSWALK_BACK : STOP_BACK;
      if (Math.abs(back - auto) < 1.2) back = auto;
    }
    back = Math.max(back, depth / 2 + 0.1);
    const [lo, hi] = kind === 'crosswalk' ? [0, frame.offsets.length - 1] : this.incomingSpan(frame);
    const end = frame.end ? { end: frame.end } : {};
    return {
      from: { segmentId: frame.segmentId, boundary: lo, back, ...end },
      to: { segmentId: frame.segmentId, boundary: hi, back, ...end },
    };
  }

  // -------------------------------------------------------------------------
  // Handles
  // -------------------------------------------------------------------------

  private handles(): Handle[] {
    if (!this.hostRef || this.selectedIds.length !== 1) return [];
    const { net } = this.ctx;
    const m = this.markings.find((x) => x.id === this.selectedIds[0]);
    if (!m) return [];
    const host = this.hostRef;
    if (m.kind === 'filler') {
      return m.anchors.flatMap((a, index) => {
        const p = resolveAnchor(net, host, a);
        return p ? [{ pos: p.pos, drag: { kind: 'corner', id: m.id, index } as Drag }] : [];
      });
    }
    const p = resolveAnchor(net, host, m.from);
    const q = resolveAnchor(net, host, m.to);
    if (!p || !q) return [];
    const family = lineStyleInfo(m.style).family;
    if (acrossOneArm(m.from, m.to) && (family === 'crosswalk' || family === 'stop' || family === 'teeth')) {
      const frame = this.frameOf(m.from.segmentId, m.from.end);
      if (frame) {
        const mid = { x: (p.pos.x + q.pos.x) / 2, y: p.pos.y, z: (p.pos.z + q.pos.z) / 2 };
        const out: Handle[] = [
          { pos: p.pos, drag: { kind: 'end', id: m.id, which: 'from' } },
          { pos: q.pos, drag: { kind: 'end', id: m.id, which: 'to' } },
          { pos: mid, drag: { kind: 'across', id: m.id, segmentId: frame.segmentId, end: frame.end } },
        ];
        if (family === 'crosswalk') {
          const h = m.width / 2;
          out.push({ pos: { x: mid.x + frame.backDir.x * h, y: mid.y, z: mid.z + frame.backDir.z * h }, drag: { kind: 'depth', id: m.id, segmentId: frame.segmentId, end: frame.end } });
          out.push({ pos: { x: mid.x - frame.backDir.x * h, y: mid.y, z: mid.z - frame.backDir.z * h }, drag: { kind: 'depth', id: m.id, segmentId: frame.segmentId, end: frame.end } });
        }
        return out;
      }
    }
    return [
      { pos: p.pos, drag: { kind: 'end', id: m.id, which: 'from' } },
      { pos: q.pos, drag: { kind: 'end', id: m.id, which: 'to' } },
    ];
  }

  private handleAt(raw: Vec3 | null): Handle | null {
    if (!raw) return null;
    let best: Handle | null = null;
    let bestD = HANDLE_REACH;
    for (const h of this.handles()) {
      const d = distXZ(raw, h.pos);
      if (d <= bestD) {
        best = h;
        bestD = d;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Showing
  // -------------------------------------------------------------------------

  private outlineOf(m: NodeMarking): Vec3[] | null {
    const { net } = this.ctx;
    const host = this.hostRef!;
    if (m.kind === 'filler') {
      const poly = fillerPolygon(net, host, m);
      return poly ? [...poly, poly[0]] : null;
    }
    return markingPath(net, host, m);
  }

  private show(e: ToolPointer | null): void {
    const { net, view, settings } = this.ctx;
    const marks: ToolMark[] = [];
    const host = this.hostRef;
    const raw = e ? this.ground(e) : null;
    if (host) {
      // Every marking outlined, so the whole junction reads at a glance.
      for (const m of this.markings) {
        const pts = this.outlineOf(m);
        if (!pts || pts.length < 2) continue;
        const sel = this.selectedIds.includes(m.id);
        const hot = this.hoverUser === m.id;
        marks.push({ kind: 'line', points: pts, color: sel ? MARK_COLORS.selected : hot ? MARK_COLORS.hover : MARK_COLORS.user, width: sel ? Math.max(0.35, m.width + 0.2) : hot ? 0.3 : 0.12 });
      }
      if (host.kind === 'node') {
        for (const it of cachedAutoItems(net, host.id)) {
          if (it.outline.length < 2) continue;
          const pts = it.closed ? [...it.outline, it.outline[0]] : it.outline;
          const sel = it.key === this.autoKey;
          const hot = this.hoverAuto?.key === it.key;
          marks.push({ kind: 'line', points: pts, color: sel ? MARK_COLORS.selected : hot ? MARK_COLORS.hover : MARK_COLORS.auto, width: sel ? 0.3 : hot ? 0.25 : 0.08, dashed: !sel && !hot });
          // The badge: a small ring marks paint that is automatic.
          const c = it.outline.reduce((acc, p) => ({ x: acc.x + p.x / it.outline.length, y: p.y, z: acc.z + p.z / it.outline.length }), { x: 0, y: 0, z: 0 });
          marks.push({ kind: 'ring', pos: c, color: MARK_COLORS.badge, radius: 0.25 });
        }
      }
      for (const a of this.shownAnchors(raw)) {
        const hot = this.hover && sameAnchor(this.hover.anchor, a.anchor);
        const color = hot ? COLORS.ok : a.off ? '#555b66' : a.anchor.corner !== undefined ? MARK_COLORS.kerb : a.flow === 'enter' ? MARK_COLORS.enter : a.flow === 'exit' ? MARK_COLORS.exit : MARK_COLORS.anchor;
        marks.push({ kind: 'point', pos: a.pos, color, radius: hot ? 0.6 : a.anchor.corner !== undefined ? 0.3 : 0.4 });
      }
      for (const h of this.handles()) marks.push({ kind: 'ring', pos: h.pos, color: MARK_COLORS.handle, radius: 0.7 });
      if (this.first) {
        const p = resolveAnchor(net, host, this.first);
        if (p) {
          marks.push({ kind: 'ring', pos: p.pos, color: COLORS.ok, radius: 0.9 });
          if (this.hover && !sameAnchor(this.hover.anchor, this.first)) {
            const path = this.previewPath(this.first, this.hover);
            marks.push({ kind: 'line', points: path, color: settings.nodeMarking.color, width: 0.3, dashed: settings.nodeMarking.style !== 'solid' });
          }
        }
      }
      if (this.corners.length) {
        const pts: Vec3[] = [];
        for (const a of this.corners) {
          const p = resolveAnchor(net, host, a);
          if (p) pts.push(p.pos);
        }
        if (this.hover) pts.push(this.hover.pos);
        for (const p of pts) marks.push({ kind: 'ring', pos: p, color: COLORS.ok, radius: 0.7 });
        if (pts.length > 1) marks.push({ kind: 'line', points: pts.length > 2 ? [...pts, pts[0]] : pts, color: settings.nodeMarking.color, width: 0.3, dashed: true });
      }
      // One-click crosswalk or stop line: a ghost across the arm.
      if ((this.draw === 'crosswalk' || this.draw === 'stop') && !this.drag) {
        const across = this.acrossAnchors(this.draw);
        const p = across && resolveAnchor(net, host, across.from);
        const q = across && resolveAnchor(net, host, across.to);
        if (p && q) {
          const depth = this.draw === 'crosswalk' ? settings.nodeMarking.crosswalk.width : settings.nodeMarking.stop.width;
          const frame = this.frameOf(across!.from.segmentId, across!.from.end)!;
          const h = depth / 2;
          const off = (v: Vec3, k: number) => ({ x: v.x + frame.backDir.x * h * k, y: v.y, z: v.z + frame.backDir.z * h * k });
          marks.push({ kind: 'line', points: [off(p.pos, 1), off(q.pos, 1), off(q.pos, -1), off(p.pos, -1), off(p.pos, 1)], color: COLORS.ok, width: 0.2 });
        }
      }
      view.setHighlight(null);
    }
    this.ctx.setMarks(marks);
    if (!e) return;
    this.ctx.setHud({ x: e.x, y: e.y, lines: [this.hudTitle()], notes: [this.hudNote()], tone: 'ok' });
  }

  private hudTitle(): string {
    const names: Record<MarkingDraw, string> = { select: 'Pick', line: 'Line', crosswalk: 'Crosswalk', stop: 'Stop line', filler: 'Area', stamp: 'Stamp', erase: 'Eraser' };
    return this.hostRef ? `Markings: ${names[this.draw]}` : 'Markings';
  }

  private hudNote(): string {
    if (!this.hostRef) return 'Click a junction, or a stretch of road';
    if (this.drag) return 'Drop it on an anchor';
    if (this.hoverAuto && !this.hover) return this.draw === 'erase' ? `Click to remove: ${this.hoverAuto.label}` : `${this.hoverAuto.label} (automatic). Click to pick it`;
    if (this.hoverUser !== null && !this.hover) return this.draw === 'erase' ? 'Click to remove this marking' : 'Click to pick it; drag its handles to change it';
    switch (this.draw) {
      case 'select':
        return 'Click a marking to pick it';
      case 'erase':
        return 'Click a marking to remove it';
      case 'crosswalk':
      case 'stop': {
        // One marking per place: a taken slot says what the click replaces.
        const kind = this.draw;
        const across = this.acrossAnchors(kind);
        const spec = kind === 'crosswalk' ? this.ctx.settings.nodeMarking.crosswalk : this.ctx.settings.nodeMarking.stop;
        const taken = across ? this.replaces({ kind: 'line', ...cleanSpec(spec), from: across.from, to: across.to, straight: true } as Omit<NodeLineMarking, 'id'>) : '';
        if (taken) return `Click to replace the ${taken}`;
        return kind === 'crosswalk' ? 'Click on an arm to lay a crosswalk across it' : 'Click on an arm to lay a stop line across its incoming lanes';
      }
      case 'filler':
        return this.corners.length >= 3 ? 'Click the first anchor or press Enter to close' : 'Click anchors around the area';
      default: {
        if (this.first && this.hover && !sameAnchor(this.first, this.hover.anchor)) {
          const spec = this.lineSpec();
          const taken = this.replaces({ kind: 'line', ...cleanSpec(spec), from: this.first, to: this.hover.anchor, ...this.pathFor(this.first, this.hover.anchor, spec.style) } as Omit<NodeLineMarking, 'id'>);
          if (taken) return `Click to replace the ${taken}`;
        }
        return this.first ? 'Click the second anchor, on any arm' : 'Click an anchor to start a line, or a marking to pick it';
      }
    }
  }

  // -------------------------------------------------------------------------
  // Pointer
  // -------------------------------------------------------------------------

  private updateHover(e: ToolPointer): Vec3 | null {
    const raw = this.ground(e);
    this.updateRow(raw);
    this.hover = this.anchorDraw || this.drag ? this.anchorAt(raw) : null;
    this.hoverUser = null;
    this.hoverAuto = null;
    if (this.hostRef && raw && !this.hover && !this.drag) {
      this.hoverUser = userMarkingAt(this.ctx.net, this.hostRef, raw);
      if (this.hoverUser === null && this.hostRef.kind === 'node') this.hoverAuto = autoItemAt(cachedAutoItems(this.ctx.net, this.hostRef.id), raw);
    }
    return raw;
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    const raw = this.updateHover(e);
    if (this.drag && raw) {
      this.dragMoved = true;
      // The anchor under the cursor while dragging, even outside the drawing tools.
      this.hover = this.anchorAt(raw);
      this.dragTo(raw);
    }
    if (!this.hostRef) {
      const hover = pickNode(this.ctx, e);
      this.ctx.view.setHighlight(hover === null ? null : { nodes: [hover], color: COLORS.snap });
    }
    this.show(e);
  }

  open(id: Id): void {
    this.openHost({ kind: 'node', id });
  }

  openSegment(id: Id): void {
    this.openHost({ kind: 'segment', id });
  }

  openHost(host: MarkingHost): void {
    this.hostRef = host;
    this.first = null;
    this.corners = [];
    this.selectedIds = [];
    this.autoKey = null;
    this.lastFit = null;
    this.ctx.inspect(host.kind === 'node' ? { kind: 'nodeMarkings', id: host.id } : { kind: 'segmentMarkings', id: host.id });
    this.show(this.pointer);
    this.ctx.changed();
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    const { net, settings } = this.ctx;
    const raw = this.updateHover(e);
    if (this.hostRef) {
      const handle = this.handleAt(raw);
      if (handle && !this.drawing) {
        this.drag = handle.drag;
        this.dragMoved = false;
        this.ctx.history.begin('Change marking');
        this.show(e);
        return;
      }
      const draw = settings.nodeMarking.draw;
      if (draw === 'erase') {
        if (this.hoverUser !== null) this.remove(this.hoverUser);
        else if (this.hoverAuto) this.removeAuto(this.hoverAuto);
        this.show(e);
        return;
      }
      if ((draw === 'crosswalk' || draw === 'stop') && this.hoverUser === null && !this.hoverAuto) {
        if (this.placeAcross(draw)) return;
      }
      if (this.hover && this.anchorDraw) {
        if (draw === 'filler') this.clickCorner(this.hover.anchor);
        else this.clickLine(this.hover.anchor);
        this.show(e);
        this.ctx.changed();
        return;
      }
      if (this.hoverUser !== null) {
        this.select(this.hoverUser, e.shift || e.ctrl);
        return;
      }
      if (this.hoverAuto) {
        this.selectAuto(this.hoverAuto.key);
        return;
      }
      const near = this.hostRef.kind === 'node' ? net.getNode(this.hostRef.id) : null;
      const insideCurrent =
        (near && raw && (pickNode(this.ctx, e, (n) => n === near.id) !== null || distXZ(raw, near.pos) <= nodeReach(net, near.id) * 2)) ||
        (this.hostRef.kind === 'segment' && pickRoad(this.ctx, e)?.segmentId === this.hostRef.id);
      if (insideCurrent) {
        if (this.selectedIds.length || this.autoKey) this.select(null);
        return;
      }
    }
    const id = pickNode(this.ctx, e);
    if (id !== null && id !== this.node) {
      this.open(id);
      return;
    }
    // A plain stretch of road takes markings too.
    if (id === null) {
      const road = pickRoad(this.ctx, e);
      if (road && !(this.hostRef?.kind === 'segment' && this.hostRef.id === road.segmentId)) this.openSegment(road.segmentId);
    }
  }

  pointerUp(e: ToolPointer): void {
    if (!this.drag) return;
    const moved = this.dragMoved;
    this.drag = null;
    if (moved) this.ctx.history.end();
    else {
      // A click on a handle that did not move is a click on what lies under it, often an anchor.
      this.ctx.history.abort();
      if (this.hover && this.anchorDraw) {
        if (this.draw === 'filler') this.clickCorner(this.hover.anchor);
        else this.clickLine(this.hover.anchor);
      }
    }
    this.show(e);
    this.ctx.changed();
  }

  private dragTo(raw: Vec3): void {
    const d = this.drag!;
    const { net } = this.ctx;
    const host = this.hostRef!;
    const m = this.markings.find((x) => x.id === d.id);
    if (!m) return;
    if (d.kind === 'end' && m.kind === 'line' && this.hover) {
      const other = d.which === 'from' ? m.to : m.from;
      if (sameAnchor(this.hover.anchor, other)) return;
      const next = d.which === 'from' ? { from: this.hover.anchor } : { to: this.hover.anchor };
      const from = d.which === 'from' ? this.hover.anchor : m.from;
      const to = d.which === 'to' ? this.hover.anchor : m.to;
      const cur = d.which === 'from' ? m.from : m.to;
      if (sameAnchor(cur, this.hover.anchor)) return;
      const route = this.pathFor(from, to, m.style);
      // Clear a path that no longer applies, as when the end leaves the kerb.
      net.updateMarking(host, m.id, { ...next, straight: route.straight, path: route.path });
    } else if (d.kind === 'corner' && m.kind === 'filler' && this.hover) {
      if (m.anchors.some((a, i) => i !== d.index && sameAnchor(a, this.hover!.anchor))) return;
      if (sameAnchor(m.anchors[d.index], this.hover.anchor)) return;
      const anchors = m.anchors.map((a, i) => (i === d.index ? this.hover!.anchor : a));
      net.updateMarking(host, m.id, { anchors });
    } else if ((d.kind === 'across' || d.kind === 'depth') && m.kind === 'line') {
      const frame = this.frameOf(d.segmentId, d.end);
      if (!frame) return;
      const back = (raw.x - frame.pos.x) * frame.backDir.x + (raw.z - frame.pos.z) * frame.backDir.z;
      if (d.kind === 'across') {
        const b = Math.round(Math.max(m.width / 2 + 0.1, back) * 20) / 20;
        if (Math.abs((m.from.back ?? 0) - b) < 1e-6) return;
        net.updateMarking(host, m.id, { from: { ...m.from, back: b }, to: { ...m.to, back: b } });
      } else {
        const centre = m.from.back ?? 0;
        const width = Math.round(Math.max(0.5, Math.abs(back - centre) * 2) * 20) / 20;
        if (Math.abs(width - m.width) < 1e-6) return;
        net.updateMarking(host, m.id, { width });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Placing
  // -------------------------------------------------------------------------

  /** Free-flow junctions (highway ramps, slip merges) take no crosswalks or stop lines. */
  get freeFlow(): boolean {
    return this.hostRef?.kind === 'node' && isRampJunction(this.ctx.net, this.hostRef.id);
  }

  private placeAcross(kind: 'crosswalk' | 'stop'): boolean {
    if (this.freeFlow) {
      this.ctx.toast('No crosswalks or stop lines at a free-flowing junction.', 'warning');
      return true;
    }
    const across = this.acrossAnchors(kind);
    if (!across || !this.hostRef) return false;
    const s = this.ctx.settings.nodeMarking;
    const spec = kind === 'crosswalk' ? s.crosswalk : s.stop;
    this.ctx.history.hint(kind === 'crosswalk' ? 'Add crosswalk' : 'Add stop line');
    const id = this.ctx.net.addMarking(this.hostRef, { kind: 'line', ...stylePatch(spec), style: spec.style, color: spec.color, width: spec.width, from: across.from, to: across.to, straight: true } as Omit<NodeLineMarking, 'id'>);
    this.noteReplaced();
    this.selectedIds = [id];
    this.autoKey = null;
    this.show(this.pointer);
    this.ctx.changed();
    return true;
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
    const { net, history } = this.ctx;
    const spec = this.lineSpec();
    history.hint('Add marking');
    this.selectedIds = [
      net.addMarking(this.hostRef!, {
        kind: 'line',
        ...cleanSpec(spec),
        from: this.first,
        to: anchor,
        ...this.pathFor(this.first, anchor, spec.style),
      } as Omit<NodeLineMarking, 'id'>),
    ];
    this.noteReplaced();
    this.autoKey = null;
    this.first = null;
  }

  /** One marking per place: say what the one just placed replaced. */
  private noteReplaced(): void {
    const what = this.ctx.net.lastReplaced[0];
    if (what) this.ctx.toast(`Replaced the ${what}.`, 'info');
  }

  /** What placing this would replace, named, or '' when the place is free. */
  private replaces(init: Omit<NodeLineMarking, 'id'> | Omit<NodeFillerMarking, 'id'>): string {
    if (!this.hostRef) return '';
    try {
      return stackedWith(this.ctx.net, { kind: 'marking', host: this.hostRef, marking: init })["labels"][0] ?? '';
    } catch {
      return '';
    }
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
    if (!this.hostRef || this.corners.length < 3) return false;
    const { net, settings, history } = this.ctx;
    const { fill, color, fillWidth, fillExtra } = settings.nodeMarking;
    history.hint('Add filler');
    const init = { kind: 'filler' as const, anchors: this.corners, fill, color, width: fillWidth, ...dropEmpty(fillExtra) };
    this.selectedIds = [net.addMarking(this.hostRef, init)];
    this.noteReplaced();
    this.autoKey = null;
    this.corners = [];
    this.show(this.pointer);
    this.ctx.changed();
    return true;
  }

  // -------------------------------------------------------------------------
  // Selection and editing
  // -------------------------------------------------------------------------

  setDraw(draw: MarkingDraw): void {
    const s = this.ctx.settings.nodeMarking;
    s.draw = draw;
    s.mode = draw === 'filler' ? 'filler' : 'line';
    this.first = null;
    this.corners = [];
    this.show(this.pointer);
    this.ctx.changed();
  }

  /** Pick a marking. With `additive`, add it to the selection or take it out. */
  select(id: Id | null, additive = false): void {
    this.autoKey = null;
    if (id === null) this.selectedIds = [];
    else if (additive) this.selectedIds = this.selectedIds.includes(id) ? this.selectedIds.filter((x) => x !== id) : [...this.selectedIds, id];
    else this.selectedIds = [id];
    this.show(this.pointer);
    this.ctx.changed();
  }

  selectAuto(key: string | null): void {
    this.selectedIds = [];
    this.autoKey = key;
    this.show(this.pointer);
    this.ctx.changed();
  }

  selectAll(): void {
    this.selectedIds = this.markings.map((m) => m.id);
    this.autoKey = null;
    this.show(this.pointer);
    this.ctx.changed();
  }

  /** Step the selection through the markings. */
  cycle(step: 1 | -1): void {
    const list = this.markings;
    if (!list.length) return;
    const at = list.findIndex((m) => m.id === this.selected);
    // From nothing, Tab starts at the first and Shift+Tab at the last.
    const next = at < 0 ? (step > 0 ? list[0] : list[list.length - 1]) : list[(at + step + list.length) % list.length];
    this.select(next.id);
  }

  /** Remove the selection, or `id`. */
  remove(id: Id | null = null): void {
    if (!this.hostRef) return;
    const ids = id !== null ? [id] : [...this.selectedIds];
    if (!ids.length) {
      const auto = this.selectedAuto;
      if (auto) this.removeAuto(auto);
      return;
    }
    const host = this.hostRef;
    this.ctx.history.hint(ids.length > 1 ? 'Delete markings' : 'Delete marking');
    this.ctx.net.batch(() => {
      for (const x of ids) if (this.ctx.net.markingsOf(host).some((m) => m.id === x)) this.ctx.net.removeMarking(host, x);
    });
    this.selectedIds = this.selectedIds.filter((x) => !ids.includes(x));
    this.show(this.pointer);
    this.ctx.changed();
  }

  /** Copies of the selection, beside the originals in the list. */
  duplicate(): void {
    if (!this.hostRef || !this.selectedIds.length) return;
    const host = this.hostRef;
    const chosen = this.markings.filter((m) => this.selectedIds.includes(m.id));
    this.ctx.history.hint('Duplicate markings');
    const copies = this.ctx.net.freshMarkingIds(chosen);
    // A copy sits on the same anchors; nudge lines back along their arm so both show.
    for (const c of copies) {
      if (c.kind === 'line' && acrossOneArm(c.from, c.to) && !isPathStyle(c.style)) {
        const shift = Math.max(c.width, 1) + 0.5;
        c.from = { ...c.from, back: (c.from.back ?? 0) + shift };
        c.to = { ...c.to, back: (c.to.back ?? 0) + shift };
      }
    }
    this.ctx.net.setMarkings(host, [...this.markings, ...copies]);
    this.selectedIds = copies.map((c) => c.id);
    this.show(this.pointer);
    this.ctx.changed();
  }

  /** Edit the selected markings of a kind. Repeated edits merge, as a slider's do. */
  update(patch: Partial<Omit<NodeLineMarking, 'id' | 'kind'>> | Partial<Omit<NodeFillerMarking, 'id' | 'kind'>>, key: string): void {
    if (!this.hostRef || !this.selectedIds.length) return;
    const host = this.hostRef;
    const lineKeys = ['style', 'straight', 'path', 'dash', 'space', 'gap', 'offset', 'align', 'border', 'rules', 'from', 'to'];
    const fillKeys = ['fill', 'angle', 'step', 'anchors', 'noOutline'];
    const keys = Object.keys(patch);
    const forLines = !keys.some((k) => fillKeys.includes(k));
    const forFills = !keys.some((k) => lineKeys.includes(k));
    this.ctx.history.hint('Edit marking', `marking-${this.selectedIds.join(',')}-${key}`);
    this.ctx.net.batch(() => {
      for (const id of this.selectedIds) {
        const m = this.ctx.net.markingsOf(host).find((x) => x.id === id);
        if (!m || (m.kind === 'line' && !forLines) || (m.kind === 'filler' && !forFills)) continue;
        this.ctx.net.updateMarking(host, id, patch);
      }
    });
    this.show(this.pointer);
  }

  /** Give the selection a preset's look; with nothing selected, make it the look of new markings. */
  applyPreset(preset: MarkingPreset): void {
    const s = this.ctx.settings.nodeMarking;
    if (!this.selectedIds.length) {
      if (preset.kind === 'line') {
        const fam = lineStyleInfo(preset.style.style).family;
        if (fam === 'crosswalk') {
          s.crosswalk = { ...preset.style };
          this.setDraw('crosswalk');
        } else if (fam === 'stop' || fam === 'teeth') {
          s.stop = { ...preset.style };
          this.setDraw('stop');
        } else {
          s.style = preset.style.style;
          s.color = preset.style.color;
          s.width = preset.style.width;
          const { style: _s, color: _c, width: _w, ...extra } = preset.style;
          s.lineExtra = extra;
          this.setDraw('line');
        }
      } else {
        s.fill = preset.style.fill;
        s.color = preset.style.color;
        s.fillWidth = preset.style.width;
        const { fill: _f, color: _c, width: _w, ...extra } = preset.style;
        s.fillExtra = extra;
        this.setDraw('filler');
      }
      return;
    }
    this.ctx.net.batch(() => {
      if (preset.kind === 'line') this.update(stylePatch(preset.style), `preset-${preset.id}`);
      else this.update(fillPatch(preset.style), `preset-${preset.id}`);
      // A preset in use travels with the map.
      if (!preset.id.startsWith('builtin-')) this.ctx.net.saveToLibrary({ preset });
    });
    this.ctx.changed();
  }

  /** The look of the single selected marking, to save as a preset. */
  selectedLook(): MarkingPreset['style'] | null {
    const m = this.markings.find((x) => x.id === this.selected);
    if (!m) return null;
    return m.kind === 'line' ? styleOf(m) : fillOf(m);
  }

  // -------------------------------------------------------------------------
  // Points
  // -------------------------------------------------------------------------

  /** Change one point's settings. */
  setPoint(setting: MarkingPointSetting): void {
    if (!this.hostRef) return;
    this.ctx.history.hint('Move point', `point-${setting.segmentId}-${setting.boundary}-${setting.end ?? ''}`);
    this.ctx.net.setMarkingPoint(this.hostRef, setting);
    this.show(this.pointer);
    this.ctx.changed();
  }

  pointSetting(segmentId: Id, boundary: number, end?: 'a' | 'b'): MarkingPointSetting {
    const found = this.hostRef ? this.ctx.net.pointsOf(this.hostRef).find((p) => p.segmentId === segmentId && p.boundary === boundary && p.end === end) : undefined;
    return found ? { ...found } : { segmentId, boundary, ...(end ? { end } : {}) };
  }

  /** Nudge the point under the cursor sideways. */
  private nudgeHovered(step: number): boolean {
    const a = this.hover?.anchor;
    if (!a || a.corner !== undefined) return false;
    const cur = this.pointSetting(a.segmentId, a.boundary, a.end);
    this.setPoint({ ...cur, offset: Math.round(((cur.offset ?? 0) + step) * 100) / 100 });
    return true;
  }

  // -------------------------------------------------------------------------
  // Automatic markings
  // -------------------------------------------------------------------------

  removeAuto(item: AutoItem): void {
    if (this.node === null) return;
    this.ctx.history.hint(`Remove ${item.label.toLowerCase()}`);
    removeAutoItem(this.ctx.net, this.node, item.ref);
    if (this.autoKey === item.key) this.autoKey = null;
    this.show(this.pointer);
    this.ctx.changed();
  }

  restoreAuto(item: AutoItem): void {
    if (this.node === null) return;
    this.ctx.history.hint(`Bring back ${item.label.toLowerCase()}`);
    restoreAutoItem(this.ctx.net, this.node, item.ref);
    this.show(this.pointer);
    this.ctx.changed();
  }

  restoreAllAuto(): void {
    if (this.node === null) return;
    this.ctx.history.hint('Bring back automatic markings');
    this.ctx.net.restoreAutoMarkings(this.node);
    this.show(this.pointer);
    this.ctx.changed();
  }

  /** Turn the selected automatic marking into an editable one. */
  convertAuto(item: AutoItem | null = this.selectedAuto): boolean {
    if (this.node === null || !item) return false;
    this.ctx.history.hint(`Make ${item.label.toLowerCase()} editable`);
    const out = convertAutoItem(this.ctx.net, this.node, item);
    if (!out) return false;
    this.autoKey = null;
    this.selectedIds = out.marking !== undefined ? [out.marking] : [];
    if (out.decal !== undefined) this.ctx.toast('The arrow is now road paint: edit it with the Paint tool.', 'info');
    this.show(this.pointer);
    this.ctx.changed();
    return true;
  }

  // -------------------------------------------------------------------------
  // Copy, paste, templates
  // -------------------------------------------------------------------------

  copy(): boolean {
    if (!this.hostRef) return false;
    this.clipboard = captureTemplate(this.ctx.net, this.hostRef, 'Copied markings', 'clipboard');
    this.onClipboard?.(this.clipboard);
    this.ctx.toast(`Copied ${this.markings.length} marking${this.markings.length === 1 ? '' : 's'}.`, 'info');
    return true;
  }

  paste(): boolean {
    if (!this.hostRef || !this.clipboard) return false;
    return this.useTemplate(this.clipboard, 'Paste markings', false);
  }

  /** Put a template here, best fit first. Says when another fit is about as good. */
  useTemplate(tpl: MarkingTemplate, label = `Apply ${tpl.name}`, keepInMap = true): boolean {
    if (!this.hostRef) return false;
    const fits = fitTemplate(this.ctx.net, this.hostRef, tpl);
    if (!fits.length) {
      this.ctx.toast(tpl.host === this.hostRef.kind ? `${tpl.name} is for a junction with ${tpl.arms.length} arms.` : `${tpl.name} is for a ${tpl.host === 'node' ? 'junction' : 'stretch of road'}.`, 'warning');
      return false;
    }
    this.ctx.history.hint(label);
    const host = this.hostRef;
    // One undo step: the markings, and the template kept in the map so it travels with it.
    this.ctx.net.batch(() => {
      applyTemplate(this.ctx.net, host, tpl, fits[0]);
      if (keepInMap) this.ctx.net.saveToLibrary({ template: tpl });
    });
    this.lastFit = { tpl, fits, index: 0 };
    this.selectedIds = [];
    this.autoKey = null;
    if (fits.length > 1 && fits[1].score - fits[0].score < 0.2) this.ctx.toast('More than one way round fits. Use Rotate or Mirror to choose.', 'info');
    this.show(this.pointer);
    this.ctx.changed();
    return true;
  }

  /** Turn the last applied template to the next arm, or mirror it. */
  refit(change: 'rotate' | 'mirror'): void {
    const last = this.lastFit;
    if (!last || !this.hostRef) return;
    const cur = last.fits[last.index];
    const n = last.tpl.arms.length;
    const want = change === 'rotate' ? { shift: (cur.shift + 1) % n, mirror: cur.mirror } : { shift: cur.shift, mirror: !cur.mirror };
    const index = last.fits.findIndex((f) => f.shift === want.shift && f.mirror === want.mirror);
    if (index < 0) return;
    this.ctx.history.hint(change === 'rotate' ? 'Rotate template' : 'Mirror template');
    applyTemplate(this.ctx.net, this.hostRef, last.tpl, last.fits[index]);
    this.lastFit = { ...last, index };
    this.show(this.pointer);
    this.ctx.changed();
  }

  clearAll(): void {
    if (!this.hostRef) return;
    this.ctx.history.hint('Clear markings');
    this.ctx.net.setMarkings(this.hostRef, []);
    this.selectedIds = [];
    this.show(this.pointer);
    this.ctx.changed();
  }

  setHideAuto(hide: boolean): void {
    if (this.node === null) return;
    this.ctx.history.hint('Toggle automatic markings');
    this.ctx.net.setHideAutoMarkings(this.node, hide);
    this.ctx.changed();
  }

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  /** Step the style of the selection, or of the armed draw tool, within its kind. */
  private stepStyle(step: 1 | -1): void {
    const sel = this.markings.find((m) => m.id === this.selected);
    const s = this.ctx.settings.nodeMarking;
    const cur: NodeLineStyle = sel?.kind === 'line' ? sel.style : this.draw === 'crosswalk' ? s.crosswalk.style : this.draw === 'stop' ? s.stop.style : s.style;
    const fam = lineStyleInfo(cur).family;
    const list = LINE_STYLE_INFO.filter((x) => (fam === 'teeth' || fam === 'stop' ? x.family === 'stop' || x.family === 'teeth' : x.family === fam) && x.value !== 'empty');
    const at = list.findIndex((x) => x.value === cur);
    const next = list[(at + step + list.length) % list.length];
    if (sel?.kind === 'line') this.update({ style: next.value, ...next.defaults }, 'style');
    else if (this.draw === 'crosswalk') s.crosswalk = { ...s.crosswalk, style: next.value, ...next.defaults };
    else if (this.draw === 'stop') s.stop = { ...s.stop, style: next.value, ...next.defaults };
    else {
      s.style = next.value;
      s.width = next.defaults.width;
      const { width: _w, ...extra } = next.defaults;
      s.lineExtra = extra;
    }
    this.ctx.changed();
  }

  private stepWidth(factor: number): void {
    const sel = this.markings.find((m) => m.id === this.selected);
    if (sel) this.update({ width: Math.max(0.05, Math.round(sel.width * factor * 100) / 100) }, 'width');
    else {
      const s = this.ctx.settings.nodeMarking;
      s.width = Math.max(0.05, Math.round(s.width * factor * 100) / 100);
    }
    this.ctx.changed();
  }

  keyDown(e: ToolKey): boolean {
    if (!this.hostRef || e.ctrl) return false;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'Enter') return this.closeFiller();
    if ((k === 'Delete' || k === 'Backspace') && (this.selectedIds.length || this.autoKey)) {
      this.remove();
      return true;
    }
    const draws: Record<string, MarkingDraw> = { v: 'select', l: 'line', c: 'crosswalk', x: 'stop', f: 'filler', e: 'erase' };
    if (!e.alt && !e.shift && draws[k]) {
      this.setDraw(draws[k]);
      return true;
    }
    if (k === 'Tab') {
      this.cycle(e.shift ? -1 : 1);
      return true;
    }
    if (k === '[' || k === ']') {
      this.stepStyle(k === ']' ? 1 : -1);
      return true;
    }
    if (k === '-' || k === '=') {
      this.stepWidth(k === '=' ? 1.1 : 1 / 1.1);
      return true;
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight') return this.nudgeHovered((k === 'ArrowRight' ? 1 : -1) * (e.shift ? 0.25 : 0.05));
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      const m = this.markings.find((x) => x.id === this.selected);
      if (m?.kind !== 'line' || !acrossOneArm(m.from, m.to)) return false;
      const step = (k === 'ArrowUp' ? 1 : -1) * (e.shift ? 1 : 0.25);
      const b = Math.max(m.width / 2 + 0.1, (m.from.back ?? 0) + step);
      this.update({ from: { ...m.from, back: b }, to: { ...m.to, back: b } }, 'back');
      return true;
    }
    return false;
  }

  back(): boolean {
    if (this.drag) {
      this.drag = null;
      this.ctx.history.abort();
    } else if (this.first) this.first = null;
    else if (this.corners.length) this.corners.pop();
    else if (this.pointer && this.rightClickRemoves()) {
      // Right-click on a selected marking removes it (Remove), one undo step.
    } else if (this.selectedIds.length || this.autoKey) {
      this.selectedIds = [];
      this.autoKey = null;
    } else if (this.hostRef) {
      this.hostRef = null;
      this.ctx.inspect(null);
      this.ctx.view.setHighlight(null);
    } else return false;
    this.show(this.pointer);
    this.ctx.changed();
    return true;
  }

  /** A right-click over a selected marking: remove it. True when something went. */
  private rightClickRemoves(): boolean {
    if (!this.pointer || !this.hostRef) return false;
    // What is under the pointer, whether or not an anchor is there too.
    const raw = this.ground(this.pointer);
    if (!raw) return false;
    const user = userMarkingAt(this.ctx.net, this.hostRef, raw);
    if (user !== null && this.selectedIds.includes(user)) {
      this.remove(user);
      return true;
    }
    const auto = user === null && this.hostRef.kind === 'node' ? autoItemAt(cachedAutoItems(this.ctx.net, this.hostRef.id), raw) : null;
    if (auto && this.autoKey === auto.key) {
      this.removeAuto(auto);
      this.autoKey = null;
      return true;
    }
    return false;
  }

  activate(): void {
    this.show(null);
  }

  settingsChanged(): void {
    const s = this.ctx.settings.nodeMarking;
    // The older switch between lines and areas still works.
    if (s.mode === 'filler' && s.draw !== 'filler') s.draw = 'filler';
    if (s.mode === 'line' && s.draw === 'filler') s.draw = 'line';
    if (s.draw === 'filler') this.first = null;
    else this.corners = [];
    this.show(this.pointer);
  }

  networkChanged(_change: NetworkChange): void {
    const { net } = this.ctx;
    const host = this.hostRef;
    if (host && !(host.kind === 'node' ? net.getNode(host.id) : net.getSegment(host.id))) {
      this.hostRef = null;
      this.ctx.inspect(null);
    }
    this.selectedIds = this.selectedIds.filter((id) => this.markings.some((m) => m.id === id));
    if (this.autoKey && !this.selectedAuto) this.autoKey = null;
    const live = (a: MarkingAnchor) => !!this.hostRef && !!resolveAnchor(net, this.hostRef, a);
    if (this.first && !live(this.first)) this.first = null;
    this.corners = this.corners.filter(live);
    if (this.lastFit && this.hostRef && !sameHost(this.hostRef, host ?? this.hostRef)) this.lastFit = null;
    this.show(this.pointer);
  }

  deactivate(): void {
    if (this.drag) {
      this.drag = null;
      this.ctx.history.end();
    }
    this.hostRef = null;
    this.selectedIds = [];
    this.autoKey = null;
    this.first = null;
    this.corners = [];
    this.hover = null;
    this.ctx.inspect(null);
  }
}

/** A style without unset fields, for a new marking. */
function cleanSpec(spec: LineStyleSpec): LineStyleSpec {
  const out = { ...spec } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as unknown as LineStyleSpec;
}

function dropEmpty<T extends object>(o: T): Partial<T> {
  const out = { ...o } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as Partial<T>;
}

/** Read-only helper for panels: the markings of a host grouped by the arm they start on. */
export function markingsByArm(net: RoadNetwork, host: MarkingHost): Map<string, NodeMarking[]> {
  const out = new Map<string, NodeMarking[]>();
  for (const m of net.markingsOf(host)) {
    const a = m.kind === 'line' ? m.from : m.anchors[0];
    const key = m.kind === 'filler' ? 'areas' : `${a.segmentId}:${a.end ?? ''}`;
    const list = out.get(key) ?? [];
    list.push(m);
    out.set(key, list);
  }
  return out;
}
