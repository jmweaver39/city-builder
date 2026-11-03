/** Inspect: click a road, junction, endpoint or vehicle to open its inspector. */
import { isJunctionNode, pickEndpoint, pickNode, pickRoad } from './pick';
import { Tool } from './Tool';
import { COLORS, type InspectTarget, type ToolId, type ToolPointer } from './types';

export class SelectTool extends Tool {
  readonly id: ToolId = 'select';

  /** What a click here would open. */
  targetAt(e: ToolPointer, withVehicles: boolean): InspectTarget | null {
    const { net, view } = this.ctx;
    if (withVehicles) {
      const vehicle = view.pickVehicle(e.x, e.y);
      if (vehicle !== null) return { kind: 'vehicle', id: vehicle };
    }
    const ep = pickEndpoint(this.ctx, e);
    if (ep !== null) return { kind: 'endpoint', id: ep };
    const node = pickNode(this.ctx, e, (id) => {
      const kind = net.nodeGeom(id)?.kind;
      return kind === 'junction' || kind === 'deadEnd';
    });
    if (node !== null) return { kind: 'junction', id: node };
    const road = pickRoad(this.ctx, e);
    if (road) return { kind: 'segment', id: road.segmentId };
    return null;
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    const { view, net } = this.ctx;
    const t = this.targetAt(e, false);
    if (t?.kind === 'segment') view.setHighlight({ segments: [t.id], color: COLORS.snap });
    else if (t?.kind === 'junction') view.setHighlight({ nodes: [t.id], color: COLORS.snap });
    else view.setHighlight(null);
    if (t?.kind === 'segment') {
      const def = net.roadTypeOf(t.id);
      this.ctx.setHud({ x: e.x, y: e.y, lines: [net.getSegment(t.id)?.overrides.name || def.name], notes: [], tone: 'ok' });
    } else if (t?.kind === 'junction') {
      this.ctx.setHud({ x: e.x, y: e.y, lines: [isJunctionNode(net, t.id) ? 'Junction' : 'Dead end'], notes: [], tone: 'ok' });
    } else {
      this.ctx.setHud(null);
    }
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.ctx.inspect(this.targetAt(e, true));
  }
}
