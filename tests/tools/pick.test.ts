import { describe, expect, it } from 'vitest';
import { RoadNetwork, type Vec3 } from '../../src/core';
import { nodeReach, pickNode, pickRoad } from '../../src/tools/pick';
import type { ToolContext, ToolView } from '../../src/tools/types';
import { ToolManager } from '../../src/tools/ToolManager';
import { History } from '../../src/app/History';

/**
 * A parallel-projection camera looking down at `pitch` above the horizon, from
 * the direction `yaw`. Client point (sx, sy) is the ground point (sx, 0, sy).
 */
class TiltView {
  readonly dir: Vec3;
  constructor(pitch: number, yaw: number, private underground = false) {
    const c = Math.cos(pitch);
    this.dir = { x: c * Math.cos(yaw), y: -Math.sin(pitch), z: c * Math.sin(yaw) };
  }
  pickPlane(x: number, y: number, h: number): Vec3 {
    const s = h / this.dir.y;
    return { x: x + this.dir.x * s, y: h, z: y + this.dir.z * s };
  }
  pickRay(x: number, y: number) {
    const s = -2000;
    return { origin: { x: x + this.dir.x * s, y: this.dir.y * s, z: y + this.dir.z * s }, dir: this.dir };
  }
  getUnderground() {
    return this.underground;
  }
  /** The client point that sees world point p. */
  screen(p: Vec3): { x: number; y: number } {
    const s = p.y / this.dir.y;
    return { x: p.x - this.dir.x * s, y: p.z - this.dir.z * s };
  }
  pickVehicle() {
    return null;
  }
  project(p: Vec3) {
    return this.screen(p);
  }
  setPreview() {}
  setMarks() {}
  setHighlight() {}
  setLaneDebug() {}
}

const ctxOf = (net: RoadNetwork, view: TiltView) => ({ net, view }) as unknown as ToolContext;
const free = (x: number, y: number, z: number) => ({ kind: 'free' as const, pos: { x, y, z } });

/** Two roads crossing at height y, making a junction at the origin. */
function raisedCross(y: number): { net: RoadNetwork; node: number } {
  const net = new RoadNetwork();
  net.drawRoad({ start: free(-150, y, 0), end: free(150, y, 0), roadType: 'avenue-4' });
  net.drawRoad({ start: free(0, y, -150), end: free(0, y, 150), roadType: 'avenue-4' });
  const node = net.nodes.find((n) => n.segments.length === 4)!;
  return { net, node: node.id };
}

const DIRECTIONS = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

describe('ray picking', () => {
  for (const y of [10, 24]) {
    for (const [name, pitch] of [
      ['low', (14 * Math.PI) / 180],
      ['high', (80 * Math.PI) / 180],
    ] as const) {
      it(`picks a junction at ${y} m from a ${name} camera in four directions`, () => {
        const { net, node } = raisedCross(y);
        for (const yaw of DIRECTIONS) {
          const view = new TiltView(pitch, yaw);
          const ctx = ctxOf(net, view);
          // Points across the junction surface, including near its corners.
          for (const [dx, dz] of [
            [0, 0],
            [4, 3],
            [-5, 4],
            [5, -5],
          ]) {
            const s = view.screen({ x: node === undefined ? 0 : dx, y, z: dz });
            expect(pickNode(ctx, s), `yaw ${yaw} at ${dx},${dz}`).toBe(node);
          }
          // Ground well away from the junction, but where the plane y=0 meets the ray
          // near it, is not a hit.
          const off = view.screen({ x: 60, y, z: 60 });
          expect(pickNode(ctx, off)).toBeNull();
        }
      });
    }
  }

  it('picks a road on a slope where the cursor really is', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-200, 0, 0), end: free(200, 20, 0), roadType: 'street-2' });
    const view = new TiltView((20 * Math.PI) / 180, Math.PI / 4);
    const ctx = ctxOf(net, view);
    const seg = net.segments[0];
    const p = net.segmentGeom(seg.id)!.stations;
    const mid = p[Math.floor(p.length * 0.7)].pos;
    const hit = pickRoad(ctx, view.screen(mid));
    expect(hit?.segmentId).toBe(seg.id);
    expect(Math.abs(hit!.raw.y - mid.y)).toBeLessThan(0.5);
    // Beside the road by a few metres misses.
    expect(pickRoad(ctx, view.screen({ x: mid.x, y: mid.y, z: mid.z + 14 }))).toBeNull();
  });

  it('lets a bridge hide a junction under it, and picks the junction beside it', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-150, 0, 0), end: free(150, 0, 0), roadType: 'avenue-4' });
    net.drawRoad({ start: free(0, 0, -150), end: free(0, 0, 150), roadType: 'avenue-4' });
    const junction = net.nodes.find((n) => n.segments.length === 4)!.id;
    net.drawRoad({ start: free(-150, 12, 8), end: free(150, 12, 8), roadType: 'street-2' });
    const bridge = net.segments.find((s) => net.getNode(s.a)!.pos.y > 6)!.id;
    expect(net.getNode(junction)!.segments.length).toBe(4);
    for (const pitch of [(25 * Math.PI) / 180, (70 * Math.PI) / 180]) {
      for (const yaw of DIRECTIONS) {
        const view = new TiltView(pitch, yaw);
        const ctx = ctxOf(net, view);
        // On the bridge deck right over the junction.
        const over = view.screen({ x: 0, y: 12, z: 8 });
        expect(pickNode(ctx, over)).toBeNull();
        expect(pickRoad(ctx, over)?.segmentId).toBe(bridge);
        // The other half of the junction, which the bridge does not cover.
        const beside = view.screen({ x: 2, y: 0, z: -6 });
        expect(pickNode(ctx, beside), `yaw ${yaw}`).toBe(junction);
      }
    }
  });

  it('picks a ramp junction near the far end of its long outline', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-400, 0, 0), end: free(400, 0, 0), roadType: 'highway-3' });
    const main = net.segments[0].id;
    net.drawRoad({ start: { kind: 'segment', id: main, t: 0.5 }, end: free(260, 0, 40), roadType: 'ramp-1' });
    const node = net.nodes.find((n) => n.segments.length === 3)!;
    const outline = net.nodeGeom(node.id)!.outline;
    expect(outline.length).toBeGreaterThan(2);
    // The outline vertex furthest from the node, pulled 1.5 m back inside.
    let far = outline[0];
    for (const p of outline) if (Math.hypot(p.x - node.pos.x, p.z - node.pos.z) > Math.hypot(far.x - node.pos.x, far.z - node.pos.z)) far = p;
    const d = Math.hypot(far.x - node.pos.x, far.z - node.pos.z);
    expect(d).toBeGreaterThan(nodeReach(net, node.id) * 2);
    const inside = { x: far.x + ((node.pos.x - far.x) * 1.5) / d, y: far.y, z: far.z + ((node.pos.z - far.z) * 1.5) / d };
    const view = new TiltView((35 * Math.PI) / 180, 0.3);
    expect(pickNode(ctxOf(net, view), view.screen(inside))).toBe(node.id);
  });

  it('prefers a bridge over the road below, and picks the road where nothing covers it', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-150, 0, 0), end: free(150, 0, 0), roadType: 'street-2' });
    const ground = net.segments[0].id;
    net.drawRoad({ start: free(0, 10, -150), end: free(0, 10, 150), roadType: 'street-2' });
    const bridge = net.segments.find((s) => s.id !== ground)!.id;
    expect(net.nodes.some((n) => n.segments.length > 2)).toBe(false);
    for (const yaw of DIRECTIONS) {
      const view = new TiltView((30 * Math.PI) / 180, yaw);
      const ctx = ctxOf(net, view);
      expect(pickRoad(ctx, view.screen({ x: 0, y: 10, z: 0 }))?.segmentId).toBe(bridge);
      expect(pickRoad(ctx, view.screen({ x: 60, y: 0, z: 0 }))?.segmentId).toBe(ground);
      expect(pickRoad(ctx, view.screen({ x: 0, y: 10, z: 60 }))?.segmentId).toBe(bridge);
    }
  });

  it('snaps a new road to a raised junction while the elevation setting is ground', () => {
    const { net, node } = raisedCross(24);
    const view = new TiltView((20 * Math.PI) / 180, 2.2);
    const history = new History(net);
    const tools = new ToolManager({ net, sim: null, view: view as unknown as ToolView, history });
    tools.setTool('road');
    expect(tools.settings.elevation).toBe(0);
    const ptr = (p: { x: number; y: number }) => ({ ...p, button: 0, shift: false, ctrl: false, alt: false });
    const click = (p: { x: number; y: number }) => {
      tools.pointerMove(ptr(p));
      tools.pointerDown(ptr(p));
      tools.pointerUp(ptr(p));
    };
    click(view.screen({ x: 6, y: 24, z: 5 }));
    click(view.screen({ x: 120, y: 24, z: 120 }));
    expect(net.getNode(node)!.segments.length).toBe(5);
  });

  it('only picks tunnels in the underground view', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-150, -12, 0), end: free(150, -12, 0), roadType: 'street-2' });
    const id = net.segments[0].id;
    const above = new TiltView(1, 0.4, false);
    const below = new TiltView(1, 0.4, true);
    const at = { x: 20, y: -12, z: 0 };
    expect(pickRoad(ctxOf(net, above), above.screen(at))).toBeNull();
    expect(pickRoad(ctxOf(net, below), below.screen(at))?.segmentId).toBe(id);
  });
});
