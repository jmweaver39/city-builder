/**
 * Junction shape: the Node Controller side of node editing. Click a junction, then
 * drag its handles. Every handle sets a parameter that snaps (a kerb radius, a
 * sidewalk width, an arm trim, an island end), and nothing is drawn freehand:
 *
 *   ring at each corner's kerb    kerb radius, from a tight corner to a wide sweep
 *   square on each corner's walk  the kerb line pushed out (kerb extension) or back
 *   square at each arm-end kerb   sidewalk widened (bulb-out) or narrowed there
 *   arrow on each cut line        the arm's trim, a tighter or larger junction box
 *   dots on island ends           how far an island runs back and forward
 *
 * Islands are added by clicking two lane boundaries on one arm, the same anchors
 * Node Markings uses. A drag is one undo step. A shape that would put a kerb in
 * the way of traffic is refused: the handle turns red and says why.
 */
import { distXZ } from '../core/math';
import { nodeAnchors, type AnchorPoint } from '../core/nodeMarkings';
import {
  EDGE_STEP,
  ISLAND_DEFAULT_BACK,
  ISLAND_STEP,
  KERB_STEP,
  RADIUS_MAX,
  RADIUS_MIN,
  RADIUS_STEP,
  TRIM_STEP,
  applyJunctionShape,
  armInfos,
  cornerInfos,
  cornerTakesRadius,
  editableShape,
  islandIndexOf,
  islandPolygons,
  radiusFromApexDistance,
  snapTo,
  withArm,
  withCorner,
  withIsland,
  type ArmInfo,
  type CornerInfo,
  type ShapeProblem,
} from '../core/junctionShape';
import type { NetworkChange } from '../core/RoadNetwork';
import type { Id, JunctionShape, MarkingAnchor, ShapeIsland, Vec3 } from '../core/types';
import type { ToolMark } from '../render/api';
import { nodeReach, pickNode } from './pick';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolKey, type ToolPointer } from './types';

const HANDLE_REACH = 1.3;

export type ShapeHandleKind = 'radius' | 'kerb' | 'trim' | 'edgeLeft' | 'edgeRight' | 'islandBack' | 'islandReach';

export interface ShapeHandle {
  kind: ShapeHandleKind;
  /** Corner key, arm segment id or island id. */
  key: string;
  pos: Vec3;
  /** Unit plan direction a drag moves the value along, increasing. */
  axis: Vec3;
  /** Point on the axis where the value is zero, for absolute handles. */
  origin?: Vec3;
  label: string;
}

const add = (p: Vec3, d: Vec3, k: number): Vec3 => ({ x: p.x + d.x * k, y: p.y, z: p.z + d.z * k });
const neg = (d: Vec3): Vec3 => ({ x: -d.x, y: 0, z: -d.z });
const dotP = (a: Vec3, b: Vec3, d: Vec3): number => (a.x - b.x) * d.x + (a.z - b.z) * d.z;

/** Middle of one end of an island, on the cut line's straight extension. */
function islandEndPos(arm: ArmInfo, island: ShapeIsland, end: 'back' | 'reach'): Vec3 {
  const offs = arm.boundaries;
  const mid = ((offs[island.from] ?? 0) + (offs[island.to] ?? 0)) / 2;
  // Offsets are right of a-to-b travel.
  const right = arm.arm.atStart ? { x: -arm.out.z, y: 0, z: arm.out.x } : { x: arm.out.z, y: 0, z: -arm.out.x };
  const along = end === 'back' ? island.back : -island.reach;
  return { x: arm.centre.x + arm.out.x * along + right.x * mid, y: arm.centre.y, z: arm.centre.z + arm.out.z * along + right.z * mid };
}

export class JunctionShapeTool extends Tool {
  readonly id: ToolId = 'junctionShape';
  private nodeId: Id | null = null;
  private hover: ShapeHandle | null = null;
  private drag: { handle: ShapeHandle; start: Vec3; startShape: JunctionShape; startValue: number; last: string } | null = null;
  /** Problems from the last refused change, and which handle they belong to. */
  private refusal: { handleKey: string; kind: ShapeHandleKind | 'island'; problems: ShapeProblem[] } | null = null;
  /** Adding an island: the first boundary clicked. */
  private addingIsland = false;
  private firstAnchor: MarkingAnchor | null = null;
  private hoverAnchor: AnchorPoint | null = null;
  private selectedIsland: Id | null = null;

  get node(): Id | null {
    return this.nodeId;
  }

  get islandMode(): boolean {
    return this.addingIsland;
  }

  get selected(): Id | null {
    return this.selectedIsland;
  }

  /** The reason the last change was refused, if it was. */
  get problem(): string | null {
    return this.refusal?.problems[0]?.message ?? null;
  }

  open(id: Id): void {
    this.nodeId = id;
    this.hover = null;
    this.drag = null;
    this.refusal = null;
    this.firstAnchor = null;
    this.selectedIsland = null;
    this.ctx.inspect({ kind: 'junctionShape', id });
    this.show(this.pointer);
    this.ctx.changed();
  }

  close(): void {
    this.nodeId = null;
    this.addingIsland = false;
    this.firstAnchor = null;
    this.ctx.inspect(null);
    this.ctx.view.setHighlight(null);
    this.show(this.pointer);
    this.ctx.changed();
  }

  setIslandMode(on: boolean): void {
    this.addingIsland = on;
    this.firstAnchor = null;
    this.show(this.pointer);
    this.ctx.changed();
  }

  // -------------------------------------------------------------------------
  // Handles
  // -------------------------------------------------------------------------

  /** Every handle at the open node. */
  handles(): ShapeHandle[] {
    const nodeId = this.nodeId;
    if (nodeId === null) return [];
    const { net } = this.ctx;
    const out: ShapeHandle[] = [];
    for (const c of cornerInfos(net, nodeId)) {
      if (cornerTakesRadius(c) && c.meetPoint) {
        const bis = this.bisector(c);
        out.push({ kind: 'radius', key: c.key, pos: c.apex, axis: bis, origin: c.meetPoint, label: `Kerb radius ${c.radius.toFixed(1)} m` });
      }
      if (c.hasSidewalk && c.setting.sidewalk !== false) {
        const backMid = c.back ? this.midOf(c.back) : add(c.apex, c.inward, -Math.max(c.walkA, c.walkB));
        const pos = { x: (c.apex.x + backMid.x) / 2, y: c.apex.y, z: (c.apex.z + backMid.z) / 2 };
        out.push({ kind: 'kerb', key: c.key, pos, axis: c.inward, label: `Sidewalk ${(c.setting.kerb ?? 0) >= 0 ? '+' : ''}${(c.setting.kerb ?? 0).toFixed(2)} m` });
      }
    }
    for (const a of armInfos(net, nodeId)) {
      out.push({ kind: 'trim', key: String(a.segmentId), pos: add(a.centre, a.out, 0.8), axis: a.out, label: `Trim ${(a.setting.trim ?? 0) >= 0 ? '+' : ''}${(a.setting.trim ?? 0).toFixed(1)} m` });
      if (a.walkLeft > 0) {
        out.push({ kind: 'edgeLeft', key: String(a.segmentId), pos: add(add(a.kerbLeft, a.left, a.walkLeft / 2), a.out, 1.2), axis: neg(a.left), label: `Kerb ${(a.setting.edgeLeft ?? 0).toFixed(2)} m` });
      }
      if (a.walkRight > 0) {
        out.push({ kind: 'edgeRight', key: String(a.segmentId), pos: add(add(a.kerbRight, a.left, -a.walkRight / 2), a.out, 1.2), axis: a.left, label: `Kerb ${(a.setting.edgeRight ?? 0).toFixed(2)} m` });
      }
    }
    const arms = armInfos(net, nodeId);
    for (const island of net.getNode(nodeId)?.control.shape?.islands ?? []) {
      const arm = arms.find((a) => a.segmentId === island.segmentId);
      if (!arm) continue;
      out.push({ kind: 'islandBack', key: String(island.id), pos: islandEndPos(arm, island, 'back'), axis: arm.out, label: `Island back ${island.back.toFixed(1)} m` });
      out.push({ kind: 'islandReach', key: String(island.id), pos: islandEndPos(arm, island, 'reach'), axis: neg(arm.out), label: `Island nose ${island.reach.toFixed(1)} m` });
    }
    return out;
  }

  private bisector(c: CornerInfo): Vec3 {
    // From where the kerb lines meet, through the apex: the way a bigger radius moves it.
    const m = c.meetPoint!;
    const d = { x: c.apex.x - m.x, y: 0, z: c.apex.z - m.z };
    const l = Math.hypot(d.x, d.z);
    return l > 1e-6 ? { x: d.x / l, y: 0, z: d.z / l } : neg(c.inward);
  }

  private midOf(pts: readonly Vec3[]): Vec3 {
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += distXZ(pts[i], pts[i - 1]);
    let s = total / 2;
    for (let i = 1; i < pts.length; i++) {
      const d = distXZ(pts[i], pts[i - 1]);
      if (s <= d) {
        const f = d > 1e-9 ? s / d : 0;
        return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * f };
      }
      s -= d;
    }
    return pts[pts.length - 1];
  }

  private handleAt(e: ToolPointer): ShapeHandle | null {
    let best: ShapeHandle | null = null;
    let bestD = HANDLE_REACH;
    for (const h of this.handles()) {
      const raw = this.ctx.view.pickPlane(e.x, e.y, h.pos.y);
      if (!raw) continue;
      const d = distXZ(raw, h.pos);
      if (d < bestD) {
        best = h;
        bestD = d;
      }
    }
    return best;
  }

  private anchorAt(e: ToolPointer): AnchorPoint | null {
    if (this.nodeId === null) return null;
    let best: AnchorPoint | null = null;
    let bestD = HANDLE_REACH;
    for (const a of nodeAnchors(this.ctx.net, this.nodeId)) {
      const raw = this.ctx.view.pickPlane(e.x, e.y, a.pos.y);
      if (!raw) continue;
      const d = distXZ(raw, a.pos);
      if (d < bestD) {
        best = a;
        bestD = d;
      }
    }
    return best;
  }

  /** The value a handle sets, as stored now. */
  private valueOf(h: ShapeHandle, shape: JunctionShape): number {
    const { net } = this.ctx;
    switch (h.kind) {
      case 'radius': {
        const c = cornerInfos(net, this.nodeId!).find((x) => x.key === h.key);
        return shape.corners?.[h.key]?.radius ?? c?.radius ?? 0;
      }
      case 'kerb':
        return shape.corners?.[h.key]?.kerb ?? 0;
      case 'trim':
        return shape.arms?.[Number(h.key)]?.trim ?? 0;
      case 'edgeLeft':
        return shape.arms?.[Number(h.key)]?.edgeLeft ?? 0;
      case 'edgeRight':
        return shape.arms?.[Number(h.key)]?.edgeRight ?? 0;
      case 'islandBack':
        return shape.islands?.find((i) => i.id === Number(h.key))?.back ?? 0;
      case 'islandReach':
        return shape.islands?.find((i) => i.id === Number(h.key))?.reach ?? 0;
    }
  }

  /** The shape with one handle's value set. */
  shapeWith(h: Pick<ShapeHandle, 'kind' | 'key'>, value: number, base: JunctionShape): JunctionShape {
    const seg = Number(h.key);
    switch (h.kind) {
      case 'radius':
        return withCorner(base, h.key, { radius: Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, snapTo(value, RADIUS_STEP))) });
      case 'kerb':
        return withCorner(base, h.key, { kerb: snapTo(value, KERB_STEP) || undefined });
      case 'trim':
        return withArm(base, seg, { trim: snapTo(value, TRIM_STEP) || undefined });
      case 'edgeLeft':
        return withArm(base, seg, { edgeLeft: snapTo(value, EDGE_STEP) || undefined });
      case 'edgeRight':
        return withArm(base, seg, { edgeRight: snapTo(value, EDGE_STEP) || undefined });
      case 'islandBack':
      case 'islandReach': {
        const island = base.islands?.find((i) => i.id === seg);
        if (!island) return base;
        const v = Math.max(0, snapTo(value, ISLAND_STEP));
        return withIsland(base, h.kind === 'islandBack' ? { ...island, back: v } : { ...island, reach: v });
      }
    }
  }

  /** Try a shape. Refused shapes leave the network alone and record why. */
  private attempt(shape: JunctionShape, handleKey: string, kind: ShapeHandleKind | 'island'): boolean {
    const res = applyJunctionShape(this.ctx.net, this.nodeId!, shape);
    this.refusal = res.ok ? null : { handleKey, kind, problems: res.problems };
    return res.ok;
  }

  // -------------------------------------------------------------------------
  // Editing from the panel
  // -------------------------------------------------------------------------

  /** Set one value directly, as from the panel. One undo step. Returns false if refused. */
  setValue(kind: ShapeHandleKind, key: string, value: number): boolean {
    if (this.nodeId === null) return false;
    this.ctx.history.hint('Shape junction', `shape-${this.nodeId}-${kind}-${key}`);
    const ok = this.attempt(this.shapeWith({ kind, key }, value, editableShape(this.ctx.net, this.nodeId)), key, kind);
    this.show(this.pointer);
    this.ctx.changed();
    return ok;
  }

  setCornerSidewalk(key: string, on: boolean): boolean {
    if (this.nodeId === null) return false;
    this.ctx.history.hint('Corner sidewalk');
    const ok = this.attempt(withCorner(editableShape(this.ctx.net, this.nodeId), key, on ? { sidewalk: undefined } : { sidewalk: false, kerb: undefined }), key, 'kerb');
    this.show(this.pointer);
    this.ctx.changed();
    return ok;
  }

  resetCorner(key: string): void {
    if (this.nodeId === null) return;
    this.ctx.history.hint('Reset corner');
    this.attempt(withCorner(editableShape(this.ctx.net, this.nodeId), key, null), key, 'radius');
    this.show(this.pointer);
    this.ctx.changed();
  }

  resetArm(segmentId: Id): void {
    if (this.nodeId === null) return;
    this.ctx.history.hint('Reset arm');
    this.attempt(withArm(editableShape(this.ctx.net, this.nodeId), segmentId, null), String(segmentId), 'trim');
    this.show(this.pointer);
    this.ctx.changed();
  }

  removeIsland(id: Id): void {
    if (this.nodeId === null) return;
    const island = editableShape(this.ctx.net, this.nodeId).islands?.find((i) => i.id === id);
    if (!island) return;
    this.ctx.history.hint('Remove island');
    this.attempt(withIsland(editableShape(this.ctx.net, this.nodeId), island, true), String(id), 'island');
    if (this.selectedIsland === id) this.selectedIsland = null;
    this.show(this.pointer);
    this.ctx.changed();
  }

  resetAll(): void {
    if (this.nodeId === null) return;
    this.ctx.history.hint('Reset junction shape');
    this.attempt({}, '', 'radius');
    this.selectedIsland = null;
    this.show(this.pointer);
    this.ctx.changed();
  }

  /** Add an island between two boundaries of one arm, given as node-marking anchors. */
  addIsland(a: MarkingAnchor, b: MarkingAnchor): boolean {
    if (this.nodeId === null || a.segmentId !== b.segmentId || a.boundary === b.boundary) return false;
    const { net } = this.ctx;
    const arm = armInfos(net, this.nodeId).find((x) => x.segmentId === a.segmentId);
    if (!arm) return false;
    const count = arm.boundaries.length;
    const i = islandIndexOf(a.boundary, count, arm.arm.atStart);
    const j = islandIndexOf(b.boundary, count, arm.arm.atStart);
    const visible = net.segmentGeom(a.segmentId)?.length ?? 0;
    const back = Math.max(1, Math.min(ISLAND_DEFAULT_BACK, snapTo(visible * 0.4, ISLAND_STEP)));
    const base = editableShape(net, this.nodeId);
    const next = withIsland(base, { segmentId: a.segmentId, from: Math.min(i, j), to: Math.max(i, j), back, reach: 0 });
    this.ctx.history.hint('Add island');
    const ok = this.attempt(next, 'new', 'island');
    if (ok) this.selectedIsland = Math.max(...(next.islands ?? []).map((x) => x.id));
    return ok;
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private show(e: ToolPointer | null): void {
    const { net, view } = this.ctx;
    const marks: ToolMark[] = [];
    const nodeId = this.nodeId;
    let note = 'Click a junction to edit its shape';
    let tone: 'ok' | 'warning' | 'error' = 'ok';
    const lines = ['Junction shape'];
    if (nodeId !== null) {
      view.setHighlight(null);
      const bad = this.refusal;
      for (const c of cornerInfos(net, nodeId)) {
        const hot = bad?.handleKey === c.key;
        marks.push({ kind: 'line', points: c.kerb, color: hot ? COLORS.bad : COLORS.guide, width: 0.18, dashed: !c.setting.radius && !c.setting.kerb });
      }
      for (const { island, poly } of islandPolygons(net, nodeId)) {
        const sel = island.id === this.selectedIsland;
        marks.push({ kind: 'line', points: [...poly, poly[0]], color: sel ? COLORS.ok : COLORS.guide, width: sel ? 0.25 : 0.15 });
      }
      if (this.addingIsland) {
        for (const a of nodeAnchors(net, nodeId)) {
          const hot = this.hoverAnchor && this.hoverAnchor.anchor.segmentId === a.anchor.segmentId && this.hoverAnchor.anchor.boundary === a.anchor.boundary;
          const first = this.firstAnchor && this.firstAnchor.segmentId === a.anchor.segmentId && this.firstAnchor.boundary === a.anchor.boundary;
          marks.push({ kind: first ? 'ring' : 'point', pos: a.pos, color: first || hot ? COLORS.ok : COLORS.snap, radius: hot ? 0.6 : 0.4 });
        }
        note = this.firstAnchor ? 'Click the other side of the island, on the same arm' : 'Click a lane boundary where the island starts';
        if (bad?.kind === 'island') {
          note = bad.problems[0].message;
          tone = 'error';
        }
      } else {
        for (const h of this.handles()) {
          const active = this.drag?.handle.kind === h.kind && this.drag.handle.key === h.key;
          const hot = active || (this.hover?.kind === h.kind && this.hover.key === h.key);
          const refused = bad && bad.handleKey === h.key && (bad.kind === h.kind || (active && !!bad));
          const color = refused ? COLORS.bad : hot ? COLORS.ok : h.kind === 'radius' ? COLORS.snap : h.kind === 'trim' ? COLORS.warn : COLORS.neutral;
          marks.push({ kind: h.kind === 'radius' ? 'ring' : 'point', pos: h.pos, color, radius: hot ? 0.75 : 0.5 });
          if (h.kind === 'trim') marks.push({ kind: 'line', points: [h.pos, add(h.pos, h.axis, 2)], color, width: 0.2 });
          if (hot) marks.push({ kind: 'label', pos: add(h.pos, h.axis, -1.5), text: h.label, color });
        }
        const h = this.drag?.handle ?? this.hover;
        if (h) lines.push(h.label);
        note = this.drag ? 'Drag to reshape. Double-click a handle to reset it' : this.hover ? 'Drag to reshape, double-click to reset' : 'Drag a handle. Right click to leave this junction';
        if (bad) {
          note = bad.problems[0].message;
          tone = 'error';
        }
      }
    }
    this.ctx.setMarks(marks);
    if (e) this.ctx.setHud({ x: e.x, y: e.y, lines, notes: [note], tone });
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    if (this.drag && this.nodeId !== null) {
      const { handle, start, startShape, startValue } = this.drag;
      const raw = this.ctx.view.pickPlane(e.x, e.y, handle.pos.y);
      if (raw) {
        let value: number;
        if (handle.kind === 'radius' && handle.origin) {
          const c = cornerInfos(this.ctx.net, this.nodeId).find((x) => x.key === handle.key);
          const d = dotP(raw, handle.origin, handle.axis);
          value = c ? radiusFromApexDistance(d, c.opening) : startValue;
        } else {
          value = startValue + dotP(raw, start, handle.axis);
        }
        const next = this.shapeWith(handle, value, startShape);
        const sig = JSON.stringify(next);
        if (sig !== this.drag.last) {
          this.drag.last = sig;
          this.attempt(next, handle.key, handle.kind);
          this.refreshDragHandle();
        }
      }
      this.show(e);
      return;
    }
    if (this.nodeId === null) {
      const hover = pickNode(this.ctx, e, (id) => this.ctx.net.nodeGeom(id)?.kind === 'junction');
      this.ctx.view.setHighlight(hover === null ? null : { nodes: [hover], color: COLORS.snap });
    } else if (this.addingIsland) {
      this.hoverAnchor = this.anchorAt(e);
    } else {
      this.hover = this.handleAt(e);
    }
    this.show(e);
  }

  /** Keep the dragged handle's label in step with the network. */
  private refreshDragHandle(): void {
    if (!this.drag) return;
    const h = this.handles().find((x) => x.kind === this.drag!.handle.kind && x.key === this.drag!.handle.key);
    if (h) this.drag.handle = { ...h, axis: this.drag.handle.axis, origin: this.drag.handle.origin };
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    const { net } = this.ctx;
    if (this.nodeId !== null && this.addingIsland) {
      const a = this.anchorAt(e);
      if (a) {
        if (!this.firstAnchor || this.firstAnchor.segmentId !== a.anchor.segmentId) {
          this.firstAnchor = a.anchor;
          this.refusal = null;
        } else if (this.firstAnchor.boundary === a.anchor.boundary) {
          this.firstAnchor = null;
        } else {
          const ok = this.addIsland(this.firstAnchor, a.anchor);
          this.firstAnchor = null;
          if (ok) this.addingIsland = false;
        }
        this.show(e);
        this.ctx.changed();
        return;
      }
    }
    if (this.nodeId !== null && !this.addingIsland) {
      const h = this.handleAt(e);
      if (h) {
        const raw = this.ctx.view.pickPlane(e.x, e.y, h.pos.y) ?? h.pos;
        const startShape = editableShape(net, this.nodeId);
        this.ctx.history.begin('Shape junction');
        this.drag = { handle: h, start: raw, startShape, startValue: this.valueOf(h, startShape), last: JSON.stringify(startShape) };
        if (h.kind === 'islandBack' || h.kind === 'islandReach') this.selectedIsland = Number(h.key);
        this.refusal = null;
        this.show(e);
        return;
      }
      // Clicking an island selects it.
      const raw = net.getNode(this.nodeId) ? this.ctx.view.pickPlane(e.x, e.y, net.getNode(this.nodeId)!.pos.y) : null;
      if (raw) {
        const hit = islandPolygons(net, this.nodeId).find(({ poly }) => insidePoly(raw, poly));
        if (hit) {
          this.selectedIsland = hit.island.id;
          this.show(e);
          this.ctx.changed();
          return;
        }
      }
    }
    const near = this.nodeId === null ? null : net.getNode(this.nodeId);
    const raw = near ? this.ctx.view.pickPlane(e.x, e.y, near.pos.y) : null;
    if (near && raw && distXZ(raw, near.pos) <= nodeReach(net, near.id) * 2.5) return;
    const id = pickNode(this.ctx, e, (n) => net.nodeGeom(n)?.kind === 'junction');
    if (id !== null && id !== this.nodeId) this.open(id);
  }

  pointerUp(_e: ToolPointer): void {
    if (!this.drag) return;
    this.drag = null;
    this.ctx.history.end();
    this.show(this.pointer);
    this.ctx.changed();
  }

  doubleClick(e: ToolPointer): void {
    if (this.nodeId === null || this.addingIsland) return;
    const h = this.handleAt(e);
    if (!h) return;
    const shape = editableShape(this.ctx.net, this.nodeId);
    this.ctx.history.hint('Reset handle');
    let next: JunctionShape;
    switch (h.kind) {
      case 'radius':
        next = withCorner(shape, h.key, { radius: undefined });
        break;
      case 'kerb':
        next = withCorner(shape, h.key, { kerb: undefined });
        break;
      case 'trim':
        next = withArm(shape, Number(h.key), { trim: undefined });
        break;
      case 'edgeLeft':
        next = withArm(shape, Number(h.key), { edgeLeft: undefined });
        break;
      case 'edgeRight':
        next = withArm(shape, Number(h.key), { edgeRight: undefined });
        break;
      default: {
        const island = shape.islands?.find((i) => i.id === Number(h.key));
        next = island ? withIsland(shape, h.kind === 'islandBack' ? { ...island, back: ISLAND_DEFAULT_BACK } : { ...island, reach: 0 }) : shape;
      }
    }
    this.attempt(next, h.key, h.kind);
    this.show(e);
    this.ctx.changed();
  }

  keyDown(e: ToolKey): boolean {
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedIsland !== null) {
      this.removeIsland(this.selectedIsland);
      return true;
    }
    if (e.key === 'i' || e.key === 'I') {
      if (this.nodeId === null) return false;
      this.setIslandMode(!this.addingIsland);
      return true;
    }
    return false;
  }

  back(): boolean {
    if (this.drag) {
      this.drag = null;
      this.ctx.history.abort();
    } else if (this.firstAnchor) this.firstAnchor = null;
    else if (this.addingIsland) this.addingIsland = false;
    else if (this.selectedIsland !== null) this.selectedIsland = null;
    else if (this.refusal) this.refusal = null;
    else if (this.nodeId !== null) {
      this.close();
      return true;
    } else return false;
    this.show(this.pointer);
    this.ctx.changed();
    return true;
  }

  activate(): void {
    this.show(null);
  }

  networkChanged(_change: NetworkChange): void {
    if (this.nodeId !== null && this.ctx.net.nodeGeom(this.nodeId)?.kind !== 'junction') {
      this.nodeId = null;
      this.drag = null;
      this.ctx.inspect(null);
    }
    if (this.selectedIsland !== null && !this.ctx.net.getNode(this.nodeId ?? -1)?.control.shape?.islands?.some((i) => i.id === this.selectedIsland)) {
      this.selectedIsland = null;
    }
    if (!this.drag) this.show(this.pointer);
  }

  deactivate(): void {
    if (this.drag) this.ctx.history.end();
    this.drag = null;
    this.nodeId = null;
    this.hover = null;
    this.addingIsland = false;
    this.firstAnchor = null;
    this.refusal = null;
    this.ctx.inspect(null);
  }
}

function insidePoly(p: Vec3, poly: readonly Vec3[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

