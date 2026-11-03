import { beforeEach, describe, expect, it } from 'vitest';
import { RoadNetwork, zoneCoverage, zoneRates, type Vec3 } from '../../src/core';
import { Simulation } from '../../src/sim/Simulation';
import { placeZones, pruneZones, syncAllZoneAccess, zoneAt, zoneStats } from '../../src/tools/zoneOps';
import { rig, type Rig } from './helpers';

const free = (x: number, z: number) => ({ kind: 'free' as const, pos: { x, y: 0, z } });

function grid(r: Rig, type = 'street-2'): void {
  for (const k of [0, 200, 400]) {
    r.net.drawRoad({ start: free(0, k), end: free(400, k), roadType: type });
    r.net.drawRoad({ start: free(k, 0), end: free(k, 400), roadType: type });
  }
}

let r: Rig;
beforeEach(() => {
  r = rig();
  r.tools.setTool('zone');
});

const zones = () => r.net.project.zones ?? [];

describe('Zone tool', () => {
  it('shows a ghost with area and traffic, then zones a block on a click', () => {
    grid(r);
    r.hover(100, 100);
    expect(r.view.ghosts).toHaveLength(1);
    expect(r.view.zoneOverlay).toBe(true);
    expect(r.tools.hud!.lines.join()).toMatch(/m²/);
    expect(r.tools.hud!.lines.join()).toMatch(/vehicles an hour/);
    r.click(100, 100);
    expect(zones()).toHaveLength(1);
    expect(zones()[0]).toMatchObject({ kind: 'residential', density: 'medium', source: 'block' });
  });

  it('gives a region access points on its roads, sharing its traffic', () => {
    grid(r);
    r.click(100, 100);
    const id = zones()[0].id;
    const access = r.net.endpoints.filter((e) => e.regionId === id);
    expect(access.length).toBeGreaterThan(1);
    const stats = zoneStats(r.net, id);
    expect(stats.area).toBeGreaterThan(25000);
    const total = access.reduce((s, e) => s + e.ratePerHour, 0);
    expect(Math.abs(total - zoneRates('residential', 'medium', stats.area).ratePerHour)).toBeLessThanOrEqual(access.length);
  });

  it('never puts access on a highway', () => {
    r.net.drawRoad({ start: free(0, 0), end: free(400, 0), roadType: 'highway-3' });
    r.net.drawRoad({ start: free(0, 200), end: free(400, 200), roadType: 'street-2' });
    r.net.drawRoad({ start: free(0, -20), end: free(0, 220), roadType: 'street-2' });
    r.net.drawRoad({ start: free(400, -20), end: free(400, 220), roadType: 'street-2' });
    r.click(200, 100);
    const id = zones()[0]?.id;
    expect(id).toBeDefined();
    const access = r.net.endpoints.filter((e) => e.regionId === id);
    expect(access.length).toBeGreaterThan(0);
    for (const e of access) expect(r.net.roadTypeOf(e.segmentId!).category).not.toBe('highway');
  });

  it('frontage by dragging along a road zones the side the drag is on', () => {
    r.net.drawRoad({ start: free(0, 0), end: free(400, 0), roadType: 'street-2' });
    r.tools.settings.zone.mode = 'frontage';
    r.tools.settings.zone.kind = 'commercial';
    r.tools.settingsChanged();
    r.drag([[50, 9], [150, 9], [300, 9]]);
    expect(zones()).toHaveLength(1);
    const z = zones()[0];
    expect(z).toMatchObject({ kind: 'commercial', source: 'frontage' });
    const cells = zoneCoverage(r.net, z.id).cells;
    expect(cells.every((c) => c.z > 0)).toBe(true);
    expect(Math.max(...cells.map((c) => c.z))).toBeGreaterThan(35);
  });

  it('rectangle snaps its corners to road edges', () => {
    r.net.drawRoad({ start: free(0, 0), end: free(400, 0), roadType: 'street-2' });
    r.tools.settings.zone.mode = 'rect';
    r.tools.settingsChanged();
    r.drag([[50, 9], [150, 60]]);
    const z = zones()[0];
    expect(z.anchors!.filter(Boolean).length).toBeGreaterThanOrEqual(2);
  });

  it('polygon closes on the first corner and on Enter', () => {
    r.tools.settings.zone.mode = 'polygon';
    r.tools.settingsChanged();
    r.click(0, 0);
    r.click(100, 0);
    r.click(100, 100);
    r.click(1, 1);
    expect(zones()).toHaveLength(1);
    r.click(200, 0);
    r.click(300, 0);
    r.click(300, 100);
    expect(r.key('Enter')).toBe(true);
    expect(zones()).toHaveLength(2);
  });

  it('red ghost and no zone where it is all road or water', () => {
    r.net.drawRoad({ start: free(0, 450), end: free(400, 450), roadType: 'street-2' });
    r.tools.settings.zone.mode = 'polygon';
    r.tools.settingsChanged();
    // In the river, which runs near z = 564 here.
    r.click(-30, 552);
    r.click(30, 552);
    r.click(30, 576);
    r.hover(-30, 576);
    expect(r.view.ghosts[0].color).toBe('#ff4d4d');
    r.key('Enter');
    expect(zones()).toHaveLength(0);
  });

  it('rezoning an area replaces the region under it, dezone removes it', () => {
    grid(r);
    r.click(100, 100);
    r.tools.settings.zone.kind = 'office';
    r.tools.settingsChanged();
    r.click(100, 100);
    expect(zones().map((z) => z.kind)).toEqual(['office']);
    r.tools.settings.zone.kind = 'none';
    r.tools.settingsChanged();
    r.click(100, 100);
    expect(zones()).toEqual([]);
    expect(r.net.endpoints.filter((e) => e.regionId !== undefined)).toEqual([]);
  });

  it('dezoning part of a region keeps the rest', () => {
    grid(r);
    r.click(100, 100);
    r.tools.settings.zone.kind = 'none';
    r.tools.settings.zone.mode = 'rect';
    r.tools.settingsChanged();
    const before = zoneStats(r.net, zones()[0].id).area;
    r.drag([[30, 30], [90, 90]]);
    expect(zones().map((z) => z.kind)).toEqual(['residential', 'none']);
    expect(zoneStats(r.net, zones()[0].id).area).toBeLessThan(before - 2000);
  });

  it('undo takes a zoning back to an identical signature', () => {
    grid(r);
    const sig = r.net.signature();
    r.click(100, 100);
    r.history.undo();
    expect(r.net.signature()).toBe(sig);
  });

  it('select finds a region, and a road on top of it first', () => {
    grid(r);
    r.click(100, 100);
    r.tools.setTool('select');
    r.click(100, 100);
    expect(r.inspected.at(-1)).toEqual({ kind: 'zone', id: zones()[0].id });
    expect(zoneAt(r.net, 200, 100)).toBeNull();
  });

  it('bulldozing a fronting road removes its frontage and refits access', () => {
    r.net.drawRoad({ start: free(0, 0), end: free(400, 0), roadType: 'street-2' });
    r.tools.settings.zone.mode = 'frontage';
    r.tools.settingsChanged();
    r.drag([[50, 9], [300, 9]]);
    expect(zones()).toHaveLength(1);
    r.tools.setTool('bulldoze');
    r.click(200, 0, { shift: true });
    expect(zones()).toHaveLength(0);
    expect(r.net.endpoints).toHaveLength(0);
  });
});

describe('Traffic from regions', () => {
  it('the simulation generates and absorbs traffic through a region', () => {
    const net = new RoadNetwork();
    for (const k of [0, 200, 400]) {
      net.drawRoad({ start: free(0, k), end: free(400, k), roadType: 'street-2' });
      net.drawRoad({ start: free(k, 0), end: free(k, 400), roadType: 'street-2' });
    }
    net.setTraffic({ autoGateways: false });
    const t = rig(null, net);
    t.tools.setTool('zone');
    t.tools.settings.zone.density = 'high';
    t.click(100, 100);
    t.tools.settings.zone.kind = 'commercial';
    t.tools.settingsChanged();
    t.click(300, 300);
    expect(net.project.zones).toHaveLength(2);
    const sim = new Simulation(net);
    for (let i = 0; i < 6000; i++) sim.step();
    const s = sim.stats();
    expect(s.spawnedTotal).toBeGreaterThan(20);
    expect(s.arrivedTotal).toBeGreaterThan(5);
    const owned = net.endpoints.filter((e) => e.regionId !== undefined).map((e) => sim.endpointStats?.(e.id)?.spawned ?? 0);
    expect(owned.reduce((a, b) => a + b, 0)).toBeGreaterThan(10);
  });

  it('pruning keeps regions that still show, and sync is idempotent', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(0, 0), end: free(400, 0), roadType: 'street-2' });
    const poly: Vec3[] = [{ x: 0, y: 0, z: 10 }, { x: 200, y: 0, z: 10 }, { x: 200, y: 0, z: 60 }, { x: 0, y: 0, z: 60 }];
    const [id] = placeZones(net, [{ kind: 'residential', density: 'low', enabled: true, name: '', polygon: poly, source: 'shape', settings: { depth: 40, setback: 2, snap: true, snapDistance: 8, excludeFast: true } }]);
    expect(pruneZones(net)).toEqual([]);
    const ids = net.endpoints.map((e) => e.id);
    syncAllZoneAccess(net);
    expect(net.endpoints.filter((e) => e.regionId === id)).toHaveLength(ids.length);
  });
});
