import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { roadLevel, terrainHeight, totalHalfWidth, type Vec3 } from '../../src/core';
import { cubicPoint } from '../../src/core/bezier';
import { bindTerrainEdits, unbindTerrainEdits, type TerrainEditor } from '../../src/core/terrainEdit';
import type { TerrainTool } from '../../src/tools/TerrainTool';
import { rig, type Rig } from './helpers';

const Z = -1200;
let r: Rig;
let ed: TerrainEditor;
let tool: TerrainTool;

beforeEach(() => {
  r = rig();
  ed = bindTerrainEdits(r.net);
  r.tools.setTool('terrain');
  tool = r.tools.terrain;
});
afterEach(() => unbindTerrainEdits());

/** Hold a button at (x, z) for `ticks` frames. */
function hold(x: number, z: number, ticks: number, opts: { button?: number; alt?: boolean } = {}): void {
  const e = { x, y: z, button: opts.button ?? 0, shift: false, ctrl: false, alt: !!opts.alt };
  r.tools.pointerMove(e);
  r.tools.pointerDown(e);
  for (let i = 0; i < ticks; i++) tool.tick(1 / 60);
  r.tools.pointerUp(e);
}

describe('terrain tool', () => {
  it('left raises, right and Option+click lower, one undo step per stroke', () => {
    tool.brush.strength = 1;
    hold(0, Z, 30);
    const up = terrainHeight(0, Z);
    expect(up).toBeGreaterThan(8);
    hold(0, Z, 10, { button: 2 });
    const down = terrainHeight(0, Z);
    expect(down).toBeLessThan(up - 2);
    hold(0, Z, 10, { alt: true });
    expect(terrainHeight(0, Z)).toBeLessThan(down - 2);
    expect(r.history.size).toBe(3);
    expect(r.history.undoLabel).toBe('Lower land');
    r.history.undo();
    expect(terrainHeight(0, Z)).toBeCloseTo(down, 5);
  });

  it('brush size and strength from keys and Shift+wheel, modes from keys', () => {
    const r0 = tool.brush.radius;
    expect(r.key(']')).toBe(true);
    expect(tool.brush.radius).toBeGreaterThan(r0);
    r.key('[');
    r.key('[');
    expect(tool.brush.radius).toBeLessThan(r0);
    const s0 = tool.brush.strength;
    r.key('}');
    expect(tool.brush.strength).toBeCloseTo(s0 + 0.05, 5);
    const before = tool.brush.radius;
    expect(r.tools.wheel(-100, { x: 0, y: Z, button: 0, shift: true, ctrl: false, alt: false })).toBe(true);
    expect(tool.brush.radius).toBeGreaterThan(before);
    expect(r.tools.wheel(-100, { x: 0, y: Z, button: 0, shift: false, ctrl: false, alt: false })).toBe(false);
    r.key('x');
    expect(tool.brush.mode).toBe('level');
    r.key('c');
    expect(tool.brush.mode).toBe('soften');
    r.key('y');
    expect(tool.brush.mode).toBe('slope');
    r.key('z');
    expect(tool.brush.mode).toBe('shift');
  });

  it('shows a ring draped on the ground with the falloff', () => {
    tool.brush.strength = 1;
    hold(0, Z, 30);
    r.hover(0, Z);
    const lines = r.view.marks.filter((m) => m.kind === 'line') as { points: Vec3[] }[];
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const p of lines[0].points) expect(p.y).toBeCloseTo(terrainHeight(p.x, p.z) + 0.35, 3);
  });

  it('level samples at the first click, right click samples again', () => {
    tool.brush.strength = 1;
    hold(0, Z, 40);
    r.key('x');
    tool.brush.shape = 'hard';
    const h = terrainHeight(20, Z);
    hold(20, Z, 120);
    expect(tool.brush.target).toBeCloseTo(h, 5);
    expect(terrainHeight(10, Z)).toBeCloseTo(h, 1);
    hold(300, Z, 1, { button: 2 });
    expect(tool.brush.target).toBeCloseTo(0, 5);
  });

  it('slope takes two clicks, then paints between them', () => {
    tool.brush.strength = 1;
    tool.brush.radius = 60;
    hold(100, Z, 60);
    r.key('y');
    tool.brush.shape = 'hard';
    tool.brush.radius = 24;
    r.click(60, Z);
    r.click(140, Z);
    expect(tool.brush.from).not.toBeNull();
    expect(tool.brush.to).not.toBeNull();
    const a = tool.brush.from!.y;
    const b = tool.brush.to!.y;
    for (let x = 60; x <= 140; x += 10) hold(x, Z, 90);
    expect(terrainHeight(100, Z)).toBeCloseTo((a + b) / 2, 0);
  });
});

describe('roads on landscaped land', () => {
  it('a ground road follows the hill and bridges a steep valley', () => {
    tool.brush.strength = 0.6;
    tool.brush.radius = 200;
    hold(-60, Z, 40); // a broad hill about 9 m high, gentle enough to drive over
    tool.brush.radius = 50;
    tool.brush.strength = 1;
    tool.brush.shape = 'hard';
    hold(260, Z, 60, { button: 2 }); // a steep valley about 24 m deep
    expect(terrainHeight(-60, Z)).toBeGreaterThan(8);
    expect(terrainHeight(260, Z)).toBeLessThan(-15);
    r.tools.setTool('road');
    r.tools.settings.drawMode = 'straight';
    r.tools.settings.roadType = 'street-2';
    r.tools.settingsChanged();
    r.click(-140, Z);
    r.click(400, Z);
    expect(r.toasts).toEqual([]);
    const segs = r.net.segments;
    expect(segs.length).toBeGreaterThan(2);
    // Along the hill the road is on the ground; over the valley it is a bridge.
    const surfaceAt = (x: number): number => {
      for (const s of segs) {
        const c = r.net.cubicOf(s.id);
        if (x < Math.min(c.p0.x, c.p3.x) || x > Math.max(c.p0.x, c.p3.x)) continue;
        let lo = 0;
        let hi = 1;
        const dir = c.p3.x > c.p0.x ? 1 : -1;
        for (let k = 0; k < 40; k++) {
          const m = (lo + hi) / 2;
          if ((cubicPoint(c, m).x - x) * dir < 0) lo = m;
          else hi = m;
        }
        return cubicPoint(c, lo).y;
      }
      throw new Error(`no road at ${x}`);
    };
    for (const x of [-120, -90, -60, -30, 0]) {
      const y = surfaceAt(x);
      expect(Math.abs(y - terrainHeight(x, Z))).toBeLessThan(1);
      expect(roadLevel({ x, y, z: Z })).toBe('ground');
    }
    const mid = surfaceAt(260);
    expect(mid - terrainHeight(260, Z)).toBeGreaterThan(5);
    expect(roadLevel({ x: 260, y: mid, z: Z })).toBe('bridge');
    // The ground meets the road's edges on the hill, where the road is drawn: along its stations.
    const w = totalHalfWidth(r.net.roadType('street-2')!);
    const drawnAt = (x: number): number => {
      for (const sg of segs) {
        const st = r.net.curveOf(sg.id).stations;
        for (let i = 0; i + 1 < st.length; i++) {
          const a = st[i].pos;
          const b = st[i + 1].pos;
          if ((x - a.x) * (x - b.x) > 0) continue;
          return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
        }
      }
      throw new Error(`no road at ${x}`);
    };
    for (const x of [-100, -76, -72, -68, -60, -20, -8, -4, 0]) for (const side of [-1, 1]) expect(Math.abs(terrainHeight(x, Z + side * w) - drawnAt(x))).toBeLessThan(0.05);
    // Grade within the limit everywhere.
    for (const s of segs) {
      const c = r.net.cubicOf(s.id);
      for (let k = 0; k < 20; k++) {
        const a = cubicPoint(c, k / 20);
        const b = cubicPoint(c, (k + 1) / 20);
        expect(Math.abs(b.y - a.y) / Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(0.12);
      }
    }
  });

  it('roads far from any landscaping are drawn as before', () => {
    hold(0, Z, 20);
    r.tools.setTool('road');
    r.click(-100, 0);
    r.click(100, 0);
    expect(r.net.segments.length).toBe(1);
    const c = r.net.cubicOf(r.net.segments[0].id);
    expect(c.p0.y).toBe(0);
    expect(c.p3.y).toBe(0);
  });
});
