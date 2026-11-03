/**
 * Lane connector tool: click a junction, click a lane arriving at it, then click
 * lanes leaving it to link or unlink them. The result is `control.laneLinks`,
 * which replaces the automatic connectors at that node entirely.
 */
import type { NetworkChange, RoadNetwork } from '../core/RoadNetwork';
import { distXZ } from '../core/math';
import type { Id, LaneLink, Vec3 } from '../core/types';
import type { ToolMark } from '../render/api';
import { isJunctionNode, pickNode } from './pick';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolPointer } from './types';

export interface LaneDot {
  ref: string;
  pos: Vec3;
  side: 'in' | 'out';
}

const DOT_REACH = 2.2;
const LINK_COLOR = '#6fb7ff';
const ACTIVE_COLOR = '#ffffff';

/** Lane ends of every lane that can link at a node. */
export function laneDots(net: RoadNetwork, nodeId: Id): LaneDot[] {
  const graph = net.laneGraph;
  const seenIn = new Set<string>();
  const seenOut = new Set<string>();
  const out: LaneDot[] = [];
  const point = (ref: string, atEnd: boolean): Vec3 | null => {
    const idx = graph.byKey.get(`r${ref}`);
    if (idx === undefined) return null;
    const lane = graph.lanes[idx];
    const i = atEnd ? lane.cum.length - 1 : 0;
    return { x: lane.pts[i * 3], y: lane.pts[i * 3 + 1], z: lane.pts[i * 3 + 2] };
  };
  for (const c of net.connectionsAt(nodeId)) {
    if (!seenIn.has(c.from)) {
      seenIn.add(c.from);
      const pos = point(c.from, true);
      if (pos) out.push({ ref: c.from, pos, side: 'in' });
    }
    if (!seenOut.has(c.to)) {
      seenOut.add(c.to);
      const pos = point(c.to, false);
      if (pos) out.push({ ref: c.to, pos, side: 'out' });
    }
  }
  return out;
}

/** The links currently active at a node, as an explicit list. */
export function activeLinks(net: RoadNetwork, nodeId: Id): LaneLink[] {
  return net.connectionsAt(nodeId).filter((c) => c.active).map((c) => ({ from: c.from, to: c.to }));
}

/** Link or unlink two lanes at a node. */
export function toggleLink(net: RoadNetwork, nodeId: Id, from: string, to: string): void {
  const links = activeLinks(net, nodeId);
  const i = links.findIndex((l) => l.from === from && l.to === to);
  if (i >= 0) links.splice(i, 1);
  else links.push({ from, to });
  net.setJunctionControl(nodeId, { laneLinks: links });
}

export class LaneTool extends Tool {
  readonly id: ToolId = 'lanes';
  private nodeId: Id | null = null;
  private fromRef: string | null = null;
  private hoverDot: LaneDot | null = null;

  get node(): Id | null {
    return this.nodeId;
  }

  get selectedLane(): string | null {
    return this.fromRef;
  }

  activate(): void {
    this.ctx.view.setLaneDebug(false);
    this.show();
  }

  deactivate(): void {
    this.nodeId = null;
    this.fromRef = null;
    this.hoverDot = null;
  }

  /** Open a junction directly, as the inspector's Edit lanes button does. */
  openNode(id: Id): void {
    if (!isJunctionNode(this.ctx.net, id)) return;
    this.nodeId = id;
    this.fromRef = null;
    this.show();
    this.ctx.changed();
  }

  /** Back to automatic connectors. */
  resetToAuto(): void {
    if (this.nodeId === null) return;
    this.ctx.history.hint('Reset lanes');
    this.ctx.net.setJunctionControl(this.nodeId, { laneLinks: null });
    this.fromRef = null;
    this.show();
    this.ctx.changed();
  }

  private dotAt(e: ToolPointer): LaneDot | null {
    if (this.nodeId === null) return null;
    const { net, view } = this.ctx;
    let best: LaneDot | null = null;
    let bestD = DOT_REACH;
    for (const dot of laneDots(net, this.nodeId)) {
      const raw = view.pickPlane(e.x, e.y, dot.pos.y);
      if (!raw) continue;
      const d = distXZ(raw, dot.pos);
      if (d <= bestD) {
        best = dot;
        bestD = d;
      }
    }
    return best;
  }

  private connectorLines(): ToolMark[] {
    const { net } = this.ctx;
    if (this.nodeId === null) return [];
    const graph = net.laneGraph;
    const marks: ToolMark[] = [];
    for (const idx of graph.connectorsAt.get(this.nodeId) ?? []) {
      const lane = graph.lanes[idx];
      const from = graph.lanes[lane.fromLane];
      const active = this.fromRef !== null && `r${this.fromRef}` === from.key;
      const points: Vec3[] = [];
      const n = lane.cum.length;
      const stride = Math.max(1, Math.floor(n / 16));
      for (let i = 0; i < n; i += stride) points.push({ x: lane.pts[i * 3], y: lane.pts[i * 3 + 1], z: lane.pts[i * 3 + 2] });
      points.push({ x: lane.pts[n * 3 - 3], y: lane.pts[n * 3 - 2], z: lane.pts[n * 3 - 1] });
      marks.push({ kind: 'line', points, color: active ? ACTIVE_COLOR : LINK_COLOR, width: active ? 0.45 : 0.25 });
    }
    return marks;
  }

  private show(): void {
    const { net } = this.ctx;
    const marks = this.connectorLines();
    if (this.nodeId !== null) {
      for (const dot of laneDots(net, this.nodeId)) {
        const hot = this.hoverDot?.ref === dot.ref && this.hoverDot.side === dot.side;
        const picked = dot.side === 'in' && dot.ref === this.fromRef;
        const color = picked ? COLORS.ok : dot.side === 'in' ? COLORS.warn : COLORS.snap;
        marks.push({ kind: 'point', pos: dot.pos, color, radius: hot || picked ? 1.3 : 0.9 });
      }
      const node = net.getNode(this.nodeId);
      if (node) marks.push({ kind: 'ring', pos: node.pos, color: COLORS.ok, radius: 2 });
    }
    this.ctx.setMarks(marks);
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    this.hoverDot = this.dotAt(e);
    // The hover tint must not linger on the junction once it is being edited.
    if (this.nodeId !== null) this.ctx.view.setHighlight(null);
    if (this.nodeId === null) {
      const hover = pickNode(this.ctx, e, (id) => isJunctionNode(this.ctx.net, id));
      this.ctx.view.setHighlight(hover === null ? null : { nodes: [hover], color: COLORS.snap });
      this.ctx.setHud({ x: e.x, y: e.y, lines: ['Lane connector'], notes: ['Click a junction'], tone: 'ok' });
    } else if (this.fromRef === null) {
      this.ctx.setHud({ x: e.x, y: e.y, lines: ['Lane connector'], notes: ['Click an arriving lane (amber)'], tone: 'ok' });
    } else {
      this.ctx.setHud({ x: e.x, y: e.y, lines: ['Lane connector'], notes: ['Click a leaving lane (cyan) to link or unlink'], tone: 'ok' });
    }
    this.show();
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    const { net } = this.ctx;
    const dot = this.dotAt(e);
    if (dot) {
      if (dot.side === 'in') {
        this.fromRef = dot.ref;
      } else if (this.fromRef !== null && this.nodeId !== null) {
        this.ctx.history.hint('Edit lane links');
        toggleLink(net, this.nodeId, this.fromRef, dot.ref);
      }
      this.show();
      this.ctx.changed();
      return;
    }
    const id = pickNode(this.ctx, e, (n) => isJunctionNode(net, n));
    if (id !== null && id !== this.nodeId) {
      this.nodeId = id;
      this.fromRef = null;
      this.ctx.inspect({ kind: 'junction', id });
      this.show();
      this.ctx.changed();
    }
  }

  back(): boolean {
    if (this.fromRef !== null) this.fromRef = null;
    else if (this.nodeId !== null) this.nodeId = null;
    else return false;
    this.show();
    this.ctx.changed();
    return true;
  }

  networkChanged(change: NetworkChange): void {
    if (this.nodeId !== null && !this.ctx.net.getNode(this.nodeId)) {
      this.nodeId = null;
      this.fromRef = null;
    }
    if (change.reset) this.fromRef = null;
    this.show();
  }
}
