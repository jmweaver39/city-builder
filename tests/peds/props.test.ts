import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { closestPointOnCubic, effectiveLanes, isWater, RoadNetwork, totalHalfWidth, type Id } from '../../src/core';
import { buildStarterScene } from '../../src/app/starter';
import { footprintAt } from '../../src/peds/footprint';
import { buildPedGraph } from '../../src/peds/graph';
import type { RenderContext } from '../../src/render/context';
import { StreetDetailLayer } from '../../src/render/streetDetail';
import {
  COUNTRY_CELL,
  countryProps,
  lotProps,
  makeContext,
  nodeProps,
  ON_SHOULDER,
  P_BENCH,
  P_BIN,
  P_COW,
  P_DEBRIS,
  P_HYDRANT,
  P_KM_POST,
  P_SHEEP,
  P_SHELTER,
  P_SOS_PHONE,
  P_TREE,
  P_TYRE_MARK,
  PROP_RADIUS,
  ROAD_DECALS,
  segmentProps,
  type PlaceContext,
  type Prop,
} from '../../src/render/streetDetailPlace';
import { free, town } from './scene';

function allProps(ctx: PlaceContext, box: { minX: number; minZ: number; maxX: number; maxZ: number }): Prop[] {
  const net = ctx.net;
  const out: Prop[] = [];
  for (const s of net.segments) out.push(...segmentProps(ctx, s.id));
  for (const n of net.nodes) out.push(...nodeProps(ctx, n.id));
  for (const l of ctx.lots.lots) out.push(...lotProps(ctx, l));
  for (let ix = Math.floor(box.minX / COUNTRY_CELL); ix <= Math.floor(box.maxX / COUNTRY_CELL); ix++)
    for (let iz = Math.floor(box.minZ / COUNTRY_CELL); iz <= Math.floor(box.maxZ / COUNTRY_CELL); iz++) out.push(...countryProps(ctx, ix, iz));
  return out;
}

const TOWN_ONLY = new Set([P_BENCH, P_BIN, P_HYDRANT, P_SHELTER, P_TREE]);

function checkProps(net: RoadNetwork, props: Prop[]): void {
  const g = buildPedGraph(net);
  for (const p of props) {
    const where = `${p.type} at ${p.x.toFixed(1)},${p.z.toFixed(1)}`;
    if (ROAD_DECALS.has(p.type) || ON_SHOULDER.has(p.type)) {
      const hit = footprintAt(net, p.x, p.y, p.z);
      if (hit === 'rail' || hit === 'water') throw new Error(`${where} on ${hit}`);
      // Never on a crosswalk.
      for (const c of g.crossings) {
        const ax = g.x[c.a];
        const az = g.z[c.a];
        const bx = g.x[c.b];
        const bz = g.z[c.b];
        const dx = bx - ax;
        const dz = bz - az;
        const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / (dx * dx + dz * dz)));
        const d = Math.hypot(ax + dx * t - p.x, az + dz * t - p.z);
        if (d < 1.6 && p.type !== P_TYRE_MARK) throw new Error(`${where} on a crosswalk`);
      }
      if (p.type === P_DEBRIS) {
        // On a shoulder, never in a lane.
        const hitSeg = net.nearestSegment({ x: p.x, y: 0, z: p.z }, 30)!;
        const def = net.roadTypeOf(hitSeg.segmentId);
        for (const l of effectiveLanes(def, net.getSegment(hitSeg.segmentId)!.overrides)) {
          if (Math.abs(hitSeg.lateral - l.offset) < l.width / 2) throw new Error(`${where} in a lane`);
        }
      }
      continue;
    }
    const hit = footprintAt(net, p.x, p.y + 0.05, p.z, { radius: Math.min(0.3, PROP_RADIUS[p.type] * p.s * 0.5) });
    if (hit) throw new Error(`${where} on ${hit}`);
    if (isWater(p.x, p.z)) throw new Error(`${where} in water`);
    if (p.type === P_COW || p.type === P_SHEEP) {
      const h = net.nearestSegment({ x: p.x, y: 0, z: p.z }, 60);
      if (h) expect(h.distance - net.roadTypeOf(h.segmentId).halfWidth).toBeGreaterThan(29);
    }
    // Highways get highway furniture only.
    for (const s of net.segments) {
      const def = net.roadTypeOf(s.id);
      if (def.category !== 'highway' && def.category !== 'ramp') continue;
      const d = closestPointOnCubic(net.cubicOf(s.id), { x: p.x, y: 0, z: p.z }).distance;
      if (d < totalHalfWidth(def) + 12 && TOWN_ONLY.has(p.type)) throw new Error(`${where} by a highway`);
    }
  }
}

describe('street detail placement', () => {
  it('keeps every prop off roads, track, water and crosswalks in a town', () => {
    const { net } = town();
    const ctx = makeContext(net);
    const t0 = performance.now();
    const props = allProps(ctx, { minX: -300, minZ: -600, maxX: 1100, maxZ: 700 });
    const ms = performance.now() - t0;
    console.log(`street detail: ${props.length} props in ${ms.toFixed(0)} ms`);
    expect(props.length).toBeGreaterThan(400);
    const types = new Set(props.map((p) => p.type));
    for (const t of [P_BENCH, P_BIN, P_KM_POST]) expect(types.has(t)).toBe(true);
    checkProps(net, props);
  });

  it('puts only highway furniture by the highways of the starter scene', () => {
    const net = new RoadNetwork();
    buildStarterScene(net);
    const ctx = makeContext(net);
    const props = allProps(ctx, { minX: -1000, minZ: -600, maxX: 1000, maxZ: 400 });
    expect(props.some((p) => p.type === P_KM_POST || p.type === P_SOS_PHONE)).toBe(true);
    checkProps(net, props);
  });

  it('places the same props for the same seed, and is not moved by edits elsewhere', () => {
    const a = town();
    const b = town();
    const pa = allProps(makeContext(a.net, 1, 3), { minX: 0, minZ: 0, maxX: 600, maxZ: 400 });
    const pb = allProps(makeContext(b.net, 1, 3), { minX: 0, minZ: 0, maxX: 600, maxZ: 400 });
    expect(JSON.stringify(pb)).toBe(JSON.stringify(pa));
    const other = allProps(makeContext(b.net, 1, 4), { minX: 0, minZ: 0, maxX: 600, maxZ: 400 });
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(pa));
    // A road far away changes nothing here.
    const seg = a.net.nearestSegment({ x: 100, y: 0, z: 0 }, 5)!.segmentId;
    const before = JSON.stringify(segmentProps(makeContext(a.net, 1, 3), seg));
    a.net.drawRoad({ start: free(-1500, 1500), end: free(-1200, 1500), roadType: 'street-2' });
    expect(JSON.stringify(segmentProps(makeContext(a.net, 1, 3), seg))).toBe(before);
  });

  it('clears props out of the way when a road is built through them, and fills in again', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-800, 0), end: free(800, 0), roadType: 'street-2' });
    const ctx = { scene: new THREE.Scene() } as unknown as RenderContext;
    let target = { x: 0, y: 0, z: 200 };
    const layer = new StreetDetailLayer(net, ctx, () => ({ target, distance: 150, yaw: 0, pitch: 1 }));
    for (let i = 0; i < 40; i++) layer.update(0.25);
    const before = layer.placed();
    expect(before.length).toBeGreaterThan(20);
    // A new road straight through the fields.
    const ids: Id[] = net.drawRoad({ start: free(-400, 200), end: free(400, 200), roadType: 'street-2' }).segments;
    for (let i = 0; i < 40; i++) layer.update(0.25);
    const after = layer.placed();
    for (const p of after) {
      if (ROAD_DECALS.has(p.type)) continue;
      for (const id of ids) {
        const d = closestPointOnCubic(net.cubicOf(id), { x: p.x, y: 0, z: p.z }).distance;
        if (d < net.roadTypeOf(id).halfWidth) throw new Error(`prop ${p.type} left on the new road`);
      }
    }
    // Zoomed out: hidden, and nothing done.
    target = { x: 0, y: 0, z: 200 };
    const far = new StreetDetailLayer(net, ctx, () => ({ target, distance: 900, yaw: 0, pitch: 1 }));
    far.update(0.25);
    expect(far.group.visible).toBe(false);
    expect(far.placed().length).toBe(0);
    layer.dispose();
    far.dispose();
  });
});
