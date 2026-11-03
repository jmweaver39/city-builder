/**
 * Move: drag nodes in plan, Shift-drag or PageUp and PageDown to change height,
 * and drag a segment's curve handles. Each drag is one undo step.
 */
import type { NetworkChange } from '../core/RoadNetwork';
import { add, clamp, length, normalize, scale, sub } from '../core/math';
import { ELEVATION_STEP, MAP_HALF_SIZE, MAX_ELEVATION, MIN_ELEVATION } from '../core/terrain';
import type { Id, Vec3 } from '../core/types';
import type { ToolMark } from '../render/api';
import { pickNode, pickRoad } from './pick';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolKey, type ToolPointer } from './types';

/** Screen distance that catches a handle. */
const HANDLE_PX = 12;
/** Metres of height per pixel of Shift-drag. */
const HEIGHT_PER_PX = 0.12;

type Grab =
  | { kind: 'node'; id: Id; plane: number; startY: number; startScreenY: number }
  | { kind: 'handle'; seg: Id; which: 'c1' | 'c2'; plane: number };

export class MoveTool extends Tool {
  readonly id: ToolId = 'move';
  private grab: Grab | null = null;
  private hoverNode: Id | null = null;
  /** The segment showing handles. Stays while the cursor heads to a handle. */
  private activeSeg: Id | null = null;
  private hoverHandle: 'c1' | 'c2' | null = null;

  private handleAt(e: ToolPointer): 'c1' | 'c2' | null {
    const { net, view } = this.ctx;
    if (this.activeSeg === null) return null;
    const seg = net.getSegment(this.activeSeg);
    if (!seg) return null;
    for (const which of ['c1', 'c2'] as const) {
      const p = view.project(seg[which]);
      if (p && Math.hypot(p.x - e.x, p.y - e.y) <= HANDLE_PX) return which;
    }
    return null;
  }

  private updateHover(e: ToolPointer): void {
    const { net } = this.ctx;
    this.hoverHandle = this.handleAt(e);
    if (this.hoverHandle) {
      this.hoverNode = null;
    } else {
      this.hoverNode = pickNode(this.ctx, e);
      const road = pickRoad(this.ctx, e);
      if (road) this.activeSeg = road.segmentId;
      else if (this.hoverNode !== null) this.activeSeg = net.getNode(this.hoverNode)?.segments[0] ?? this.activeSeg;
    }
    this.show(e);
  }

  private show(e: ToolPointer | null): void {
    const { net, view } = this.ctx;
    const marks: ToolMark[] = [];
    const seg = this.activeSeg === null ? undefined : net.getSegment(this.activeSeg);
    if (seg) {
      const a = net.getNode(seg.a)!.pos;
      const b = net.getNode(seg.b)!.pos;
      marks.push({ kind: 'line', points: [a, seg.c1], color: COLORS.guide, width: 0.3, dashed: true });
      marks.push({ kind: 'line', points: [b, seg.c2], color: COLORS.guide, width: 0.3, dashed: true });
      for (const which of ['c1', 'c2'] as const) {
        const hot = this.hoverHandle === which || (this.grab?.kind === 'handle' && this.grab.which === which);
        marks.push({ kind: 'point', pos: seg[which], color: hot ? COLORS.ok : COLORS.snap, radius: 1.6 });
      }
      for (const n of [seg.a, seg.b]) marks.push({ kind: 'ring', pos: net.getNode(n)!.pos, color: COLORS.snap, radius: 3 });
    }
    const nodeId = this.grab?.kind === 'node' ? this.grab.id : this.hoverNode;
    const node = nodeId === null ? undefined : net.getNode(nodeId);
    if (node) marks.push({ kind: 'ring', pos: node.pos, color: COLORS.ok, radius: 5 });
    this.ctx.setMarks(marks);
    view.setHighlight(seg ? { segments: [seg.id], color: COLORS.snap } : null);
    if (!e) return;
    if (node) {
      this.ctx.setHud({
        x: e.x,
        y: e.y,
        lines: [`Node height ${node.pos.y.toFixed(1)} m`],
        notes: ['Drag to move. Shift-drag or PageUp and PageDown for height'],
        tone: 'ok',
      });
    } else if (this.hoverHandle) {
      this.ctx.setHud({ x: e.x, y: e.y, lines: ['Curve handle'], notes: ['Drag to bend. Ctrl leaves the joint unsmoothed'], tone: 'ok' });
    } else {
      this.ctx.setHud({ x: e.x, y: e.y, lines: ['Move'], notes: seg ? [] : ['Hover a road or node'], tone: 'ok' });
    }
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    if (this.grab) {
      this.dragTo(e);
      this.show(e);
      return;
    }
    this.updateHover(e);
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    this.updateHover(e);
    const { net } = this.ctx;
    if (this.hoverHandle && this.activeSeg !== null) {
      const seg = net.getSegment(this.activeSeg)!;
      this.grab = { kind: 'handle', seg: seg.id, which: this.hoverHandle, plane: seg[this.hoverHandle].y };
      this.ctx.history.begin('Bend road');
    } else if (this.hoverNode !== null) {
      const y = net.getNode(this.hoverNode)!.pos.y;
      this.grab = { kind: 'node', id: this.hoverNode, plane: y, startY: y, startScreenY: e.y };
      this.ctx.history.begin('Move node');
    }
  }

  private dragTo(e: ToolPointer): void {
    const { net, view } = this.ctx;
    const grab = this.grab!;
    if (grab.kind === 'node') {
      const node = net.getNode(grab.id);
      if (!node) return;
      if (e.shift) {
        const y = clamp(grab.startY + (grab.startScreenY - e.y) * HEIGHT_PER_PX, MIN_ELEVATION, MAX_ELEVATION);
        net.moveNode(grab.id, { ...node.pos, y });
        return;
      }
      const hit = view.pickPlane(e.x, e.y, node.pos.y);
      if (!hit) return;
      net.moveNode(grab.id, {
        x: clamp(hit.x, -MAP_HALF_SIZE, MAP_HALF_SIZE),
        y: node.pos.y,
        z: clamp(hit.z, -MAP_HALF_SIZE, MAP_HALF_SIZE),
      });
      return;
    }
    const seg = net.getSegment(grab.seg);
    if (!seg) return;
    const hit = view.pickPlane(e.x, e.y, grab.plane);
    if (!hit) return;
    net.batch(() => {
      if (!e.ctrl) this.mirrorJoint(grab.seg, grab.which, hit);
      net.setSegmentControls(grab.seg, grab.which === 'c1' ? hit : seg.c1, grab.which === 'c2' ? hit : seg.c2);
    });
  }

  /** Keep a two-road joint smooth by turning the neighbour's handle to match. */
  private mirrorJoint(segId: Id, which: 'c1' | 'c2', handle: Vec3): void {
    const { net } = this.ctx;
    const seg = net.getSegment(segId)!;
    const nodeId = which === 'c1' ? seg.a : seg.b;
    const node = net.getNode(nodeId)!;
    if (node.segments.length !== 2) return;
    const otherId = node.segments[0] === segId ? node.segments[1] : node.segments[0];
    const other = net.getSegment(otherId)!;
    const atA = other.a === nodeId;
    const theirs = atA ? other.c1 : other.c2;
    const reach = length(sub(theirs, node.pos));
    if (reach < 1e-6) return;
    const dir = normalize(sub(node.pos, handle));
    if (length(dir) < 0.5) return;
    const mirrored = add(node.pos, scale(dir, reach));
    net.setSegmentControls(otherId, atA ? mirrored : other.c1, atA ? other.c2 : mirrored);
  }

  pointerUp(e: ToolPointer): void {
    if (!this.grab) return;
    const grab = this.grab;
    this.grab = null;
    this.ctx.history.end();
    this.warnCrossings(grab);
    this.updateHover(e);
  }

  /** Core only makes junctions when drawing, so moved roads can run through others. */
  private warnCrossings(grab: Grab): void {
    const { net } = this.ctx;
    const ids = grab.kind === 'node' ? net.getNode(grab.id)?.segments ?? [] : [grab.seg];
    for (const id of ids) {
      const seg = net.getSegment(id);
      if (!seg) continue;
      const hits = net.findCrossings(net.cubicOf(id), [seg.a, seg.b]).filter((h) => h.atGrade && h.segmentId !== id);
      const attached = (other: Id) => {
        const o = net.getSegment(other)!;
        return o.a === seg.a || o.a === seg.b || o.b === seg.a || o.b === seg.b;
      };
      const real = hits.filter((h) => !(attached(h.segmentId) && Math.min(h.t, 1 - h.t) < 0.02));
      if (real.length) {
        this.ctx.toast('This road now crosses another without a junction. Redraw it to connect them.', 'warning');
        return;
      }
    }
  }

  keyDown(e: ToolKey): boolean {
    if (e.key !== 'PageUp' && e.key !== 'PageDown') return false;
    const { net } = this.ctx;
    const id = this.grab?.kind === 'node' ? this.grab.id : this.hoverNode;
    const node = id === null ? undefined : net.getNode(id);
    if (!node || id === null) return true;
    const step = e.key === 'PageUp' ? ELEVATION_STEP : -ELEVATION_STEP;
    net.moveNode(id, { ...node.pos, y: clamp(node.pos.y + step, MIN_ELEVATION, MAX_ELEVATION) });
    if (this.grab?.kind === 'node') {
      this.grab.plane = node.pos.y;
      this.grab.startY = net.getNode(id)!.pos.y;
      this.grab.startScreenY = this.pointer?.y ?? 0;
    }
    this.show(this.pointer);
    return true;
  }

  back(): boolean {
    if (this.grab) {
      this.grab = null;
      this.ctx.history.abort();
      this.show(this.pointer);
      return true;
    }
    return false;
  }

  deactivate(): void {
    if (this.grab) {
      this.grab = null;
      this.ctx.history.end();
    }
    this.activeSeg = null;
    this.hoverNode = null;
    this.hoverHandle = null;
  }

  networkChanged(change: NetworkChange): void {
    if (change.reset) {
      this.grab = null;
      this.hoverNode = null;
      this.activeSeg = null;
      this.hoverHandle = null;
      this.ctx.setMarks([]);
    } else if (this.activeSeg !== null && !this.ctx.net.getSegment(this.activeSeg)) {
      this.activeSeg = null;
    }
  }

}
