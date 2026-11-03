import { describe, expect, it } from 'vitest';
import { RoadNetwork, checkNetworkInvariants, distXZ, type Vec3 } from '../../src/core';
import { snapRoadPoint, type SnapQuery } from '../../src/tools/snap';
import {
  defaultGrid,
  gridAlignedTo,
  gridViewFor,
  loadGridPrefs,
  normalizeGridRotation,
  sanitizeGrid,
  saveGridPrefs,
  snapGridAt,
  toGrid,
  type GridSettings,
} from '../../src/tools/grid';
import { GRID_FINEST, GRID_SNAP_PX, gridLevels, levelOpacity, metresPerPixel, visibleSnapSpacing } from '../../src/render/gridLevels';
import { rig } from './helpers';

const v = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });
const on = { nodes: true, segments: true, angle: true, length: true };
const query = (raw: Vec3, extra: Partial<SnapQuery> = {}): SnapQuery => ({
  picks: [{ level: 0, pos: raw }],
  raw,
  from: null,
  toggles: on,
  disabled: false,
  ...extra,
});
const grid = (patch: Partial<GridSettings> = {}): GridSettings => ({ ...defaultGrid(), enabled: true, ...patch });

/** True when p lies on a grid intersection. */
function onPoint(g: GridSettings, p: Vec3): boolean {
  const { a, b } = toGrid(g, p);
  const s = g.spacing;
  return Math.abs(a / s - Math.round(a / s)) < 1e-6 && Math.abs(b / s - Math.round(b / s)) < 1e-6;
}
function onLine(g: GridSettings, p: Vec3): boolean {
  const { a, b } = toGrid(g, p);
  const s = g.spacing;
  return Math.abs(a / s - Math.round(a / s)) < 1e-6 || Math.abs(b / s - Math.round(b / s)) < 1e-6;
}

function crossNet(): RoadNetwork {
  const net = new RoadNetwork();
  net.drawRoad({ start: { kind: 'free', pos: v(-150, 7) }, end: { kind: 'free', pos: v(150, 7) }, roadType: 'street-2' });
  net.drawRoad({ start: { kind: 'free', pos: v(41, -150) }, end: { kind: 'free', pos: v(41, 150) }, roadType: 'street-2' });
  return net;
}

describe('grid snapping off', () => {
  it('gives exactly the same result as before for many cursor positions', () => {
    const net = crossNet();
    const from = { pos: v(-60, -60), ref: { x: 1, y: 0, z: 0 } };
    for (let i = 0; i < 400; i++) {
      const raw = v(Math.sin(i * 1.7) * 140, Math.cos(i * 2.3) * 140);
      for (const f of [null, from]) {
        const base = snapRoadPoint(net, query(raw, { from: f }));
        expect(snapRoadPoint(net, query(raw, { from: f, grid: null }))).toEqual(base);
        expect(snapRoadPoint(net, query(raw, { from: f, grid: { ...grid(), enabled: false } }))).toEqual(base);
      }
    }
  });
});

describe('grid snapping on', () => {
  const empty = new RoadNetwork();

  it('snaps to a nearby intersection', () => {
    const g = grid({ spacing: 32 });
    const hit = snapRoadPoint(empty, query(v(66, -30), { grid: g }));
    expect(hit.kind).toBe('grid');
    expect(hit.pos).toMatchObject({ x: 64, z: -32 });
    expect(hit.anchor).toEqual({ kind: 'free', pos: hit.pos });
  });

  it('snaps to a line when far from any intersection', () => {
    const g = grid({ spacing: 64 });
    const hit = snapRoadPoint(empty, query(v(64 + 2, 30), { grid: g }));
    expect(hit.kind).toBe('gridLine');
    expect(hit.pos.x).toBeCloseTo(64, 9);
    expect(hit.pos.z).toBeCloseTo(30, 9);
  });

  it('leaves the middle of a big cell free', () => {
    const g = grid({ spacing: 128, enabled: true });
    const hit = snapRoadPoint(empty, query(v(64, 64), { grid: g, toggles: { ...on, angle: false, length: false } }));
    expect(hit.kind).toBe('free');
  });

  it('keeps nodes and roads ahead of the grid', () => {
    const net = crossNet();
    const g = grid({ spacing: 32 });
    // Near the end node at (150, 7): the node wins over grid point (160, 0) and (128, 0).
    const node = snapRoadPoint(net, query(v(152, 5), { grid: g }));
    expect(node.kind).toBe('node');
    // Close to the road at z = 7: stays on the road, moved to where grid line x = 96 crosses it.
    const seg = snapRoadPoint(net, query(v(94, 9), { grid: g }));
    expect(seg.kind).toBe('segment');
    expect(seg.pos.z).toBeCloseTo(7, 6);
    expect(seg.pos.x).toBeCloseTo(96, 3);
    // Far from the crossing, the road point is left alone.
    const g2 = grid({ spacing: 128 });
    const plain = snapRoadPoint(net, query(v(-40, 9), { grid: g2 }));
    expect(plain.kind).toBe('segment');
    expect(plain.pos.x).toBeCloseTo(-40, 1);
  });

  it('turns the angle guides to the grid axes', () => {
    const g = grid({ spacing: 64, rotation: (20 * Math.PI) / 180 });
    const from = { pos: v(0, 0), ref: { x: 1, y: 0, z: 0 } };
    // Mid cell, about 20 degrees: the axis guide catches, not the world 15 degree step.
    const dir = { x: Math.cos(0.36), z: Math.sin(0.36) };
    const raw = v(dir.x * 100, dir.z * 100);
    const hit = snapRoadPoint(empty, query(raw, { from, grid: g }));
    expect(hit.guide).not.toBeNull();
    const ang = Math.atan2(hit.pos.z, hit.pos.x);
    expect(ang).toBeCloseTo(g.rotation, 6);
    // Without the grid there is no guide at 20 degrees.
    const free = snapRoadPoint(empty, query(raw, { from }));
    expect(Math.atan2(free.pos.z, free.pos.x)).not.toBeCloseTo(g.rotation, 3);
  });

  it('lands on a grid line where an angle guide crosses it', () => {
    const g = grid({ spacing: 64 });
    const from = { pos: v(0, 0), ref: { x: 1, y: 0, z: 0 } };
    // 45 degrees, cursor near where the diagonal meets x = 128 (and z = 128).
    const hit = snapRoadPoint(empty, query(v(131, 125), { from, grid: g }));
    expect(['grid', 'gridLine']).toContain(hit.kind);
    expect(onLine(g, hit.pos)).toBe(true);
  });

  it('works on a rotated grid with a shifted origin', () => {
    const g = grid({ spacing: 32, rotation: 0.5, originX: 13, originZ: -7 });
    for (let i = 0; i < 100; i++) {
      const raw = v(Math.sin(i * 1.3) * 300, Math.cos(i * 0.7) * 300);
      const hit = snapRoadPoint(empty, query(raw, { grid: g }));
      if (hit.kind === 'grid') {
        expect(onPoint(g, hit.pos)).toBe(true);
        expect(distXZ(hit.pos, raw)).toBeLessThanOrEqual(8 + 1e-9);
      } else if (hit.kind === 'gridLine') {
        expect(onLine(g, hit.pos)).toBe(true);
      }
    }
    // The origin itself is a grid point.
    const at = snapRoadPoint(empty, query(v(14, -6), { grid: g }));
    expect(at.kind).toBe('grid');
    expect(at.pos.x).toBeCloseTo(13, 9);
    expect(at.pos.z).toBeCloseTo(-7, 9);
  });

  it('Ctrl still turns every snap off', () => {
    const g = grid();
    const raw = v(31, 1);
    expect(snapRoadPoint(empty, query(raw, { grid: g, disabled: true })).pos).toEqual(raw);
  });
});

describe('grid settings', () => {
  it('folds rotation into a quarter turn', () => {
    expect(normalizeGridRotation(Math.PI / 2 + 0.1)).toBeCloseTo(0.1, 9);
    expect(normalizeGridRotation(-0.1)).toBeCloseTo(Math.PI / 2 - 0.1, 9);
    expect(normalizeGridRotation(Math.PI)).toBeCloseTo(0, 9);
  });

  it('sanitizes stored preferences and round trips them', () => {
    const map = new Map<string, string>();
    const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, s: string) => void map.set(k, s) };
    expect(loadGridPrefs(store)).toEqual(defaultGrid());
    const g = grid({ spacing: 48, rotation: 0.3, originX: 5, originZ: 6, majorEvery: 5, alignOrigin: false });
    saveGridPrefs(store, g);
    expect(loadGridPrefs(store)).toEqual(g);
    map.set('cloverleaf.grid', '{not json');
    expect(loadGridPrefs(store)).toEqual(defaultGrid());
    expect(sanitizeGrid({ spacing: -4, majorEvery: 9 } as Partial<GridSettings>)).toMatchObject({ spacing: 2, majorEvery: 4, alignOrigin: true });
  });

  it('shows the grid only for road tools, and only when on for drawing', () => {
    const g = grid();
    const c = { x: 1, z: 2 };
    expect(gridViewFor('road', 'straight', { ...g, enabled: false }, null, c, 0)).toBeNull();
    expect(gridViewFor('road', 'straight', g, null, c, 0)).not.toBeNull();
    expect(gridViewFor('road', 'upgrade', g, null, c, 0)).toBeNull();
    expect(gridViewFor('select', 'straight', g, null, c, 0)).toBeNull();
    expect(gridViewFor('gridAlign', 'straight', { ...g, enabled: false }, null, c, 0)).not.toBeNull();
  });
});

describe('align to road', () => {
  it('turns and shifts the grid onto a diagonal road', () => {
    const net = new RoadNetwork();
    const ang = (37 * Math.PI) / 180;
    const r = net.drawRoad({ start: { kind: 'free', pos: v(-100, -50) }, end: { kind: 'free', pos: v(-100 + Math.cos(ang) * 300, -50 + Math.sin(ang) * 300) }, roadType: 'street-2' });
    const g = gridAlignedTo(net, r.segments[0], 0.4, grid({ spacing: 32 }));
    expect(g.rotation).toBeCloseTo(ang, 6);
    // Points along the road all sit on one grid line now.
    for (const t of [0.1, 0.5, 0.9]) {
      const p = { x: -100 + Math.cos(ang) * 300 * t, y: 0, z: -50 + Math.sin(ang) * 300 * t };
      expect(toGrid(g, p).b).toBeCloseTo(0, 3);
    }
    // And snapping across it lands on grid points along the road.
    const hit = snapRoadPoint(new RoadNetwork(), query({ x: -100 + Math.cos(ang) * 152 + 1, y: 0, z: -50 + Math.sin(ang) * 152 }, { grid: g }));
    expect(hit.kind).toBe('grid');
    expect(onPoint(g, hit.pos)).toBe(true);
  });

  it('folds a road heading the other way to the same grid', () => {
    const net = new RoadNetwork();
    const r = net.drawRoad({ start: { kind: 'free', pos: v(100, 100) }, end: { kind: 'free', pos: v(-100, -50) }, roadType: 'street-2' });
    const g = gridAlignedTo(net, r.segments[0], 0.5, grid());
    expect(g.rotation).toBeGreaterThanOrEqual(0);
    expect(g.rotation).toBeLessThan(Math.PI / 2);
    expect(g.rotation).toBeCloseTo(Math.atan2(150, 200), 6);
  });
});

describe('grid in the road tool', () => {
  it('draws roads that land on grid points and connect', () => {
    const r = rig();
    const s = r.tools.settings;
    Object.assign(s.grid, { enabled: true, spacing: 32 });
    r.tools.setTool('road');
    r.click(2, 3);
    r.click(95, -2);
    r.rightClick();
    r.click(66, 61);
    r.click(63, 2); // onto the first road: a grid point on it
    const net = r.net;
    expect(checkNetworkInvariants(net)).toEqual([]);
    for (const n of net.nodes) expect(onPoint(s.grid, n.pos)).toBe(true);
    const joint = net.nearestNode(v(64, 0), 0.01);
    expect(joint).not.toBeNull();
    expect(net.getNode(joint!.nodeId)!.segments.length).toBe(3);
  });

  it('draws exactly as before with the grid off', () => {
    const a = rig();
    const b = rig();
    for (const x of [a, b]) x.tools.setTool('road');
    Object.assign(b.tools.settings.grid, { enabled: false, spacing: 8, rotation: 0.3 });
    for (const x of [a, b]) {
      x.click(3.3, 5.1);
      x.click(97.2, 41.7);
      x.click(150.4, -20.2);
    }
    expect(b.net.signature()).toBe(a.net.signature());
  });

  it('aligns through the Align tool and returns to the road tool', () => {
    const r = rig();
    r.net.drawRoad({ start: { kind: 'free', pos: v(0, 0) }, end: { kind: 'free', pos: v(200, 150) }, roadType: 'street-2' });
    r.tools.setTool('road');
    r.tools.alignGrid();
    expect(r.tools.active.id).toBe('gridAlign');
    r.click(100, 75);
    expect(r.tools.active.id).toBe('road');
    expect(r.tools.settings.grid.rotation).toBeCloseTo(Math.atan2(150, 200), 4);
  });
});

describe('adaptive grid levels', () => {
  const FOV = 40;
  const H = 900;
  const spacingAt = (distance: number, base = 64, subdivisions = true) =>
    visibleSnapSpacing(base, 4, metresPerPixel(distance, FOV, H), subdivisions);

  it('splits the base down to half a metre and builds coarse levels up to map size', () => {
    const levels = gridLevels(64, 4).map((l) => l.spacing);
    expect(levels).toEqual([0.5, 1, 2, 4, 8, 16, 32, 64, 256, 1024, 4096]);
    expect(Math.min(...gridLevels(3, 5).map((l) => l.spacing))).toBeGreaterThanOrEqual(GRID_FINEST);
    // Major and coarser are brightest.
    const w = gridLevels(32, 4);
    const base = w.find((l) => l.kind === 'base')!.weight;
    for (const l of w) {
      if (l.kind === 'fine') expect(l.weight).toBeLessThan(base);
      if (l.kind === 'major' || l.kind === 'super') expect(l.weight).toBeGreaterThan(base);
    }
  });

  it('snaps finer as the camera closes in, never below 0.5 m, coarse map-wide', () => {
    const distances = [7, 15, 30, 60, 120, 250, 500, 1000, 2000, 4000, 6800];
    const spacings = distances.map((d) => spacingAt(d));
    for (let i = 1; i < spacings.length; i++) expect(spacings[i]).toBeGreaterThanOrEqual(spacings[i - 1]);
    expect(spacings[0]).toBe(0.5);
    expect(spacingAt(60)).toBeLessThanOrEqual(1);
    expect(spacingAt(250)).toBe(2);
    expect(spacingAt(1000)).toBe(8);
    expect(spacingAt(6800)).toBeGreaterThanOrEqual(64);
    // The chosen level is always at least the snap density on screen, and the next finer one is not.
    for (const d of distances) {
      const mpp = metresPerPixel(d, FOV, H);
      const s = spacingAt(d);
      if (s > 0.5) {
        expect(s / mpp).toBeGreaterThanOrEqual(GRID_SNAP_PX);
        expect(s / 2 / mpp).toBeLessThan(GRID_SNAP_PX);
      }
    }
  });

  it('uses the base spacing only when subdivisions are off', () => {
    for (const d of [7, 100, 3000]) expect(spacingAt(d, 64, false)).toBe(64);
  });

  it('fades levels in smoothly by screen density', () => {
    expect(levelOpacity(1)).toBe(0);
    expect(levelOpacity(100)).toBe(1);
    let last = 0;
    for (let px = 0; px <= 20; px += 0.5) {
      const o = levelOpacity(px);
      expect(o).toBeGreaterThanOrEqual(last);
      expect(o - last).toBeLessThan(0.15);
      last = o;
    }
  });

  it('keeps subdivisions on the rotated, shifted base grid', () => {
    const g = grid({ spacing: 32, rotation: 0.4, originX: 11, originZ: -5 });
    const close = snapGridAt(g, metresPerPixel(20, FOV, H));
    expect(close.spacing).toBeLessThan(4);
    const empty = new RoadNetwork();
    for (let i = 0; i < 50; i++) {
      const raw = v(Math.sin(i) * 40, Math.cos(i * 1.3) * 40);
      const hit = snapRoadPoint(empty, query(raw, { grid: close, gridMetresPerPixel: metresPerPixel(20, FOV, H) }));
      // Close up, a fine level catches every cursor position: never free.
      expect(['grid', 'gridLine']).toContain(hit.kind);
      expect(onLine(close, hit.pos)).toBe(true);
      if (hit.kind === 'grid') expect(onPoint(close, hit.pos)).toBe(true);
      expect(distXZ(hit.pos, raw)).toBeLessThanOrEqual(close.spacing * 0.75);
    }
    // Base grid points are still points of the fine grid.
    expect(onPoint(close, { x: 11, y: 0, z: -5 })).toBe(true);
  });

  it('shows the snap spacing in the road tool readout, from the view zoom', () => {
    const r = rig();
    Object.assign(r.tools.settings.grid, { enabled: true, spacing: 32 });
    r.tools.setTool('road');
    // The fake view is 1 m per pixel: 16 m cells are the finest at least 9.5 px.
    r.hover(17, 1);
    expect(r.tools.hud?.lines.join(' ')).toContain('Grid 16 m');
    r.tools.settings.grid.snapSubdivisions = false;
    r.tools.settingsChanged();
    r.hover(17, 1);
    expect(r.tools.hud?.lines.join(' ')).toContain('Grid 32 m');
    r.tools.settings.grid.enabled = false;
    r.tools.settingsChanged();
    r.hover(17, 1);
    expect(r.tools.hud?.lines.join(' ')).not.toContain('Grid');
  });
});
