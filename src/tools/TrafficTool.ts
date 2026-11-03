/** Traffic: place gateways on dead ends and zones along road sides. */
import type { NetworkChange } from '../core/RoadNetwork';
import { cubicPoint, cubicTangentXZ } from '../core/bezier';
import { rightOf } from '../core/math';
import { totalHalfWidth } from '../core/roadTypes';
import type { EndpointKind, Id, Vec3 } from '../core/types';
import type { ToolMark } from '../render/api';
import { endpointPosition, pickEndpoint, pickRoad } from './pick';
import { Tool } from './Tool';
import { COLORS, type ToolId, type ToolPointer } from './types';

export const ENDPOINT_NAMES: Record<EndpointKind, string> = {
  gateway: 'Gateway',
  residential: 'Residential',
  commercial: 'Commercial',
  industrial: 'Industrial',
  office: 'Office',
};

export const ENDPOINT_COLORS: Record<EndpointKind, string> = {
  gateway: '#7fd8ff',
  residential: '#7fe08a',
  commercial: '#6da8ff',
  industrial: '#ffc857',
  office: '#c9a7ff',
};

const GATEWAY_REACH = 16;

export class TrafficTool extends Tool {
  readonly id: ToolId = 'traffic';
  private zoneGhost: { segmentId: Id; t: number; side: 1 | -1; pos: Vec3 } | null = null;
  private gatewayNode: Id | null = null;

  private show(e: ToolPointer | null): void {
    const { net, settings } = this.ctx;
    const marks: ToolMark[] = [];
    const occupied = new Set(net.endpoints.map((ep) => ep.nodeId));
    for (const ep of net.endpoints) {
      const pos = endpointPosition(net, ep);
      if (pos) marks.push({ kind: 'ring', pos, color: ep.enabled ? ENDPOINT_COLORS[ep.kind] : '#888888', radius: 6 });
    }
    if (settings.trafficKind === 'gateway') {
      for (const id of net.deadEnds()) {
        if (occupied.has(id)) continue;
        marks.push({ kind: 'ring', pos: net.getNode(id)!.pos, color: id === this.gatewayNode ? COLORS.ok : COLORS.neutral, radius: id === this.gatewayNode ? 8 : 5 });
      }
    }
    if (this.zoneGhost) marks.push({ kind: 'ring', pos: this.zoneGhost.pos, color: ENDPOINT_COLORS[settings.trafficKind], radius: 6 });
    this.ctx.setMarks(marks);
    if (!e) return;
    const name = ENDPOINT_NAMES[settings.trafficKind];
    const note =
      settings.trafficKind === 'gateway'
        ? this.gatewayNode !== null
          ? 'Click to add a gateway here'
          : 'Move to a dead end'
        : this.zoneGhost
          ? `Click to place on the ${this.zoneGhost.side === 1 ? 'right' : 'left'} side`
          : 'Move along a road';
    this.ctx.setHud({ x: e.x, y: e.y, lines: [name], notes: [note], tone: 'ok' });
  }

  private update(e: ToolPointer): void {
    const { net, settings, view } = this.ctx;
    this.zoneGhost = null;
    this.gatewayNode = null;
    if (settings.trafficKind === 'gateway') {
      for (const id of net.deadEnds()) {
        const node = net.getNode(id)!;
        const raw = view.pickPlane(e.x, e.y, node.pos.y);
        if (!raw) continue;
        if (Math.hypot(raw.x - node.pos.x, raw.z - node.pos.z) <= GATEWAY_REACH) {
          if (!net.endpoints.some((ep) => ep.nodeId === id)) this.gatewayNode = id;
          break;
        }
      }
      return;
    }
    const road = pickRoad(this.ctx, e, 12);
    if (!road) return;
    const c = net.cubicOf(road.segmentId);
    const side: 1 | -1 = road.lateral >= 0 ? 1 : -1;
    const p = cubicPoint(c, road.t);
    const right = rightOf(cubicTangentXZ(c, road.t));
    const off = (totalHalfWidth(net.roadTypeOf(road.segmentId)) + 6) * side;
    this.zoneGhost = {
      segmentId: road.segmentId,
      t: road.t,
      side,
      pos: { x: p.x + right.x * off, y: p.y, z: p.z + right.z * off },
    };
  }

  activate(): void {
    this.show(null);
  }

  settingsChanged(): void {
    if (this.pointer) this.update(this.pointer);
    this.show(this.pointer);
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    this.update(e);
    this.show(e);
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    this.update(e);
    const { net, settings } = this.ctx;
    const existing = pickEndpoint(this.ctx, e);
    if (existing !== null) {
      this.ctx.inspect({ kind: 'endpoint', id: existing });
      return;
    }
    const kind = settings.trafficKind;
    const name = `${ENDPOINT_NAMES[kind]} ${net.endpoints.filter((x) => x.kind === kind).length + 1}`;
    if (kind === 'gateway') {
      if (this.gatewayNode === null) {
        this.ctx.toast('Gateways go on dead ends.', 'warning');
        return;
      }
      const lanes = net.roadTypeOf(net.getNode(this.gatewayNode)!.segments[0]).lanes.length;
      this.ctx.history.hint('Add gateway');
      const id = net.addEndpoint({ kind, name, nodeId: this.gatewayNode, ratePerHour: 300 * lanes });
      this.ctx.inspect({ kind: 'endpoint', id });
    } else if (this.zoneGhost) {
      const z = this.zoneGhost;
      this.ctx.history.hint('Add zone');
      const id = net.addEndpoint({ kind, name, segmentId: z.segmentId, t: z.t, side: z.side, ratePerHour: 200, attraction: 1 });
      this.ctx.inspect({ kind: 'endpoint', id });
    } else {
      this.ctx.toast('Zones go along the side of a road.', 'warning');
      return;
    }
    this.update(e);
    this.show(e);
  }

  networkChanged(change: NetworkChange): void {
    if (change.reset) {
      this.zoneGhost = null;
      this.gatewayNode = null;
    }
    this.show(this.pointer);
  }

  deactivate(): void {
    this.zoneGhost = null;
    this.gatewayNode = null;
  }
}
