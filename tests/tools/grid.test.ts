import { describe, expect, it } from 'vitest';
import { RoadNetwork, checkNetworkInvariants, distXZ, type Vec3 } from '../../src/core';
import { snapRoadPoint, type SnapQuery } from '../../src/tools/snap';
import {
  buildGridBlock,
  checkGridBlock,
  defaultGrid,
  gridAlignedTo,
  gridViewFor,
  loadGridPrefs,
  normalizeGridRotation,
  planGridBlock,
  sanitizeGrid,
  saveGridPrefs,
  toGrid,
  type GridSettings,
} from '../../src/tools/grid';
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
    // Without the grid the guide stays on world 15 degree steps (here 15 or 30).
    const free = snapRoadPoint(empty, query(raw, { from }));
    const fa = (Math.atan2(free.pos.z, free.pos.x) * 180) / Math.PI;
    expect(Math.abs(fa / 15 - Math.round(fa / 15))).toBeLessThan(1e-6);
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
    const g = grid({ spacing: 48, rotation: 0.3, originX: 5, originZ: 6, majorEvery: 5, blockCells: 3 });
    saveGridPrefs(store, g);
    expect(loadGridPrefs(store)).toEqual(g);
    map.set('cloverleaf.grid', '{not json');
    expect(loadGridPrefs(store)).toEqual(defaultGrid());
    expect(sanitizeGrid({ spacing: -4, majorEvery: 9, blockCells: 99 } as Partial<GridSettings>)).toMatchObject({ spacing: 2, majorEvery: 4, blockCells: 16 });
  });

  it('shows the grid only for road tools, and only when on for drawing', () => {
    const g = grid();
    const c = { x: 1, z: 2 };
    expect(gridViewFor('road', 'straight', { ...g, enabled: false }, null, c, 0)).toBeNull();
    expect(gridViewFor('road', 'straight', g, null, c, 0)).not.toBeNull();
    expect(gridViewFor('road', 'upgrade', g, null, c, 0)).toBeNull();
    expect(gridViewFor('select', 'straight', g, null, c, 0)).toBeNull();
    expect(gridViewFor('gridBlock', 'straight', { ...g, enabled: false }, null, c, 0)).not.toBeNull();
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
    const hit = snapRoadPoint(new RoadNetwork(), query({ x: -100 + Math.cos(ang) * 96 + 1, y: 0, z: -50 + Math.sin(ang) * 96 }, { grid: g }));
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

describe('Grid Block', () => {
  it('plans whole blocks on the side the cursor is on', () => {
    const g = grid({ spacing: 32, blockCells: 2 });
    const plan = planGridBlock(g, v(3, -2), v(-250, 130), 0);
    expect(plan.block).toBe(64);
    expect(plan.ni).toBe(4);
    expect(plan.nj).toBe(2);
    expect(plan.corners[0]).toMatchObject({ x: 0, z: 0 });
    expect(plan.corners[2]).toMatchObject({ x: -256, z: 128 });
    expect(plan.edges.length).toBe(4 * 3 + 5 * 2);
  });

  it('builds a 4 by 4 block grid with junctions at every crossing, in one undo step', () => {
    const r = rig();
    const before = r.net.signature();
    const g = r.tools.settings.grid;
    Object.assign(g, { spacing: 32, blockCells: 2 });
    r.tools.setTool('gridBlock');
    r.drag([
      [1, 1],
      [100, 100],
      [258, 255],
    ]);
    const net = r.net;
    expect(net.segments.length).toBe(40);
    expect(net.nodes.length).toBe(25);
    const degrees = net.nodes.map((n) => n.segments.length).sort();
    expect(degrees.filter((d) => d === 4).length).toBe(9);
    expect(degrees.filter((d) => d === 3).length).toBe(12);
    expect(degrees.filter((d) => d === 2).length).toBe(4);
    const kinds = net.nodes.map((n) => net.nodeGeom(n.id)?.kind);
    expect(kinds.filter((k) => k === 'junction').length).toBeGreaterThanOrEqual(21);
    expect(checkNetworkInvariants(net)).toEqual([]);
    // All on the grid.
    for (const n of net.nodes) expect(onPoint(g, n.pos)).toBe(true);
    expect(r.history.undo()).toBe(true);
    expect(net.signature()).toBe(before);
    expect(net.segments.length).toBe(0);
  });

  it('connects to an existing road it touches and reuses a road along its edge', () => {
    const net = new RoadNetwork();
    // A road along the grid line z = 0 and one crossing the block at x = 100.
    net.drawRoad({ start: { kind: 'free', pos: v(-100, 0) }, end: { kind: 'free', pos: v(300, 0) }, roadType: 'street-2' });
    net.drawRoad({ start: { kind: 'free', pos: v(100, -50) }, end: { kind: 'free', pos: v(100, 200) }, roadType: 'street-2' });
    const before = net.signature();
    const g = grid({ spacing: 64, blockCells: 1 });
    const plan = planGridBlock(g, v(0, 0), v(192, 128), 0);
    const check = checkGridBlock(net, plan, 'street-2');
    expect(check.errors).toEqual([]);
    // The three edges along z = 0 are already there.
    expect(check.covered.filter(Boolean).length).toBe(3);
    net.batch(() => buildGridBlock(net, plan, 'street-2', check.covered));
    expect(checkNetworkInvariants(net)).toEqual([]);
    // Every lattice point has a node, joined to the old road along z = 0.
    for (let i = 0; i <= 3; i++) {
      for (let j = 0; j <= 2; j++) {
        const p = plan.point(i, j);
        const near = net.nearestNode(p, 0.5);
        expect(near, `lattice ${i},${j}`).not.toBeNull();
      }
    }
    const atOrigin = net.getNode(net.nearestNode(v(64, 0), 0.5)!.nodeId)!;
    expect(atOrigin.segments.length).toBe(3);
    // The crossing road at x = 100 got junctions with the rows at z = 64 and 128.
    for (const z of [64, 128]) {
      const n = net.nearestNode(v(100, z), 0.5);
      expect(n, `crossing at z ${z}`).not.toBeNull();
      expect(net.getNode(n!.nodeId)!.segments.length).toBe(4);
    }
    expect(net.signature()).not.toBe(before);
  });

  it('refuses over water and off the map', () => {
    const net = new RoadNetwork();
    const g = grid({ spacing: 64, blockCells: 1 });
    // The river crosses the map near z = 0 somewhere; find a point on it.
    let wet: Vec3 | null = null;
    for (let z = -2000; z <= 2000 && !wet; z += 8) {
      const p = v(0, z);
      const plan = planGridBlock(g, p, v(64, z + 64), 0);
      if (checkGridBlock(net, plan, 'street-2').errors.some((e) => e.includes('water'))) wet = p;
    }
    expect(wet).not.toBeNull();
    const edge = planGridBlock(g, v(1984, 0), v(2200, 64), 0);
    expect(checkGridBlock(net, edge, 'street-2').errors).toContain('The street grid leaves the map.');
  });

  it('refuses blocks too small for the road and a block overlapping a parallel road', () => {
    const net = new RoadNetwork();
    const small = planGridBlock(grid({ spacing: 8, blockCells: 1 }), v(0, 0), v(32, 32), 0);
    expect(checkGridBlock(net, small, 'street-2').errors[0]).toMatch(/too small/);
    // A road 4 m off a grid line, nearly parallel: the overlap rule rejects the edge.
    net.drawRoad({ start: { kind: 'free', pos: v(-50, 4) }, end: { kind: 'free', pos: v(250, 4) }, roadType: 'street-2' });
    const plan = planGridBlock(grid({ spacing: 64, blockCells: 1 }), v(0, 0), v(128, 128), 0);
    const check = checkGridBlock(net, plan, 'street-2');
    expect(check.errors.length).toBeGreaterThan(0);
    const r = rig(null, net);
    const sig = net.signature();
    Object.assign(r.tools.settings.grid, { spacing: 64, blockCells: 1 });
    r.tools.setTool('gridBlock');
    r.drag([
      [0, 0],
      [60, 60],
      [128, 128],
    ]);
    expect(net.signature()).toBe(sig);
    expect(r.toasts.length).toBeGreaterThan(0);
  });

  it('builds a block on a rotated, aligned grid', () => {
    const net = new RoadNetwork();
    const ang = 0.6;
    const r0 = net.drawRoad({ start: { kind: 'free', pos: v(-300, -300) }, end: { kind: 'free', pos: v(-300 + Math.cos(ang) * 200, -300 + Math.sin(ang) * 200) }, roadType: 'street-2' });
    const g = { ...gridAlignedTo(net, r0.segments[0], 0.5, grid({ spacing: 32, blockCells: 2 })) };
    const start = { x: 200, y: 0, z: 100 };
    const plan = planGridBlock(g, start, { x: start.x + 200, y: 0, z: start.z + 200 }, 0);
    const check = checkGridBlock(net, plan, 'street-2');
    expect(check.errors).toEqual([]);
    const segsBefore = net.segments.length;
    net.batch(() => buildGridBlock(net, plan, 'street-2', check.covered));
    expect(net.segments.length - segsBefore).toBe(plan.edges.length);
    for (const n of net.nodes.slice(2)) expect(onPoint(g, n.pos)).toBe(true);
    expect(checkNetworkInvariants(net)).toEqual([]);
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
