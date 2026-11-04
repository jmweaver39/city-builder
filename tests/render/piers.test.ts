/**
 * Bridge supports never stand in what passes below: lanes, shoulders, track beds,
 * platforms or junction surfaces, for every kind of elevated road and track.
 * The checks here are independent of the planner's own footprints: they sample
 * each road's curve and measure where a column stands across it.
 */
import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core/RoadNetwork';
import { cubicPoint } from '../../src/core/bezier';
import { placedStationFootprint } from '../../src/core/footprint';
import { segmentElectrification } from '../../src/core/railTypes';
import type { Id, Vec3 } from '../../src/core/types';
import { buildFrames } from '../../src/render/frames';
import { groundFn } from '../../src/core/terrainMods';
import { planNodeSupport, planSupports, polyDistance, type PierPlan } from '../../src/render/piers';
import { planPiers } from '../../src/render/structures';
import { DECK_DEPTH } from '../../src/render/constants';
import { RoadLayer } from '../../src/render/RoadLayer';
import type { Shared } from '../../src/render/materials';

const v = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });

function road(net: RoadNetwork, type: string, a: Vec3, b: Vec3): Id {
  const r = net.drawRoad({ start: { kind: 'free', pos: a }, end: { kind: 'free', pos: b }, roadType: type });
  return r.segments[0];
}

/** A raw segment with no junction-making, as a later edit underneath might add. */
function addRaw(net: RoadNetwork, type: string, a: Vec3, b: Vec3): Id {
  return net.addSegment(net.addNode(a), net.addNode(b), { roadType: type });
}

function plan(net: RoadNetwork, id: Id): PierPlan {
  return planPiers(net, id, net.roadTypeOf(id), buildFrames(net.segmentGeom(id)!.stations, [], groundFn(net)));
}

/** Hard bands across a road: carriageway (split at a raised median) or track bed with mast room. */
function hardBands(net: RoadNetwork, id: Id): [number, number][] {
  const def = net.roadTypeOf(id);
  const H = def.halfWidth;
  if (def.category === 'rail') {
    const m = segmentElectrification(def, net.getSegment(id)!.overrides) === 'overhead' ? 1.8 : 0;
    return [[-H - m, H + m]];
  }
  const med = def.median;
  if (med.width > 0 && (med.kind === 'grass' || med.kind === 'barrier')) {
    const o = med.offset ?? 0;
    return [
      [-H, o - med.width / 2],
      [o + med.width / 2, H],
    ];
  }
  return [[-H, H]];
}

/** Every reason a column of plan radius r at (x, z), under a deck at deckY, is in something below. */
function hitsAt(net: RoadNetwork, deck: Id | null, x: number, z: number, r: number, deckY: number, outside: boolean): string[] {
  const out: string[] = [];
  const self = deck !== null ? net.getSegment(deck) : undefined;
  for (const s of net.segments) {
    if (s.id === deck) continue;
    const joined = !!self && (s.a === self.a || s.a === self.b || s.b === self.a || s.b === self.b);
    const c = net.cubicOf(s.id);
    const geom = net.segmentGeom(s.id);
    if (!geom || geom.stations.length < 2) continue;
    // Only the visible span counts; the trimmed ends are junction surface.
    const t0 = geom.stations[0].t;
    const t1 = geom.stations[geom.stations.length - 1].t;
    for (let i = 0; i <= 400; i++) {
      const t = t0 + ((t1 - t0) * i) / 400;
      const p = cubicPoint(c, t);
      const q = cubicPoint(c, Math.min(1, t + 0.001));
      const pr = cubicPoint(c, Math.max(0, t - 0.001));
      const tx = q.x - pr.x;
      const tz = q.z - pr.z;
      const l = Math.hypot(tx, tz) || 1;
      // Right of travel.
      const rx = -tz / l;
      const rz = tx / l;
      const along = ((x - p.x) * tx + (z - p.z) * tz) / l;
      if (Math.abs(along) > 2) continue;
      if (p.y >= deckY - (outside && !joined ? -0.5 : 2)) continue;
      const lat = (x - p.x) * rx + (z - p.z) * rz;
      for (const [lo, hi] of hardBands(net, s.id)) {
        if (lat > lo - r && lat < hi + r) {
          out.push(`${net.roadTypeOf(s.id).id} #${s.id}`);
          break;
        }
      }
      if (out.length) break;
    }
  }
  for (const n of net.nodes) {
    const g = net.nodeGeom(n.id);
    if (!g || g.kind !== 'junction' || n.pos.y >= deckY - 2) continue;
    if (self && (n.id === self.a || n.id === self.b)) continue;
    if (polyDistance(g.outline, x, z) < r) out.push(`junction #${n.id}`);
  }
  for (const st of net.rail.stations) {
    const fp = placedStationFootprint(net, st);
    if (!fp || fp.y0 >= deckY) continue;
    for (const b of fp.boxes) {
      const dx = x - b.cx;
      const dz = z - b.cz;
      const u = Math.abs(dx * b.ax + dz * b.az) - b.hl;
      const w = Math.abs(-dx * b.az + dz * b.ax) - b.hw;
      if (Math.hypot(Math.max(u, 0), Math.max(w, 0)) + Math.min(Math.max(u, w), 0) < r) {
        out.push(`station ${st.name}`);
        break;
      }
    }
  }
  return out;
}

function columnHits(net: RoadNetwork, deck: Id, p: PierPlan = plan(net, deck)): string[] {
  const hw = net.roadTypeOf(deck).halfWidth + net.roadTypeOf(deck).sidewalk;
  const out: string[] = [];
  for (const pier of p.piers) {
    for (const c of pier.columns) {
      for (const h of hitsAt(net, deck, c.x, c.z, c.r, pier.f.y, Math.abs(c.o) > hw - 0.5)) out.push(`${pier.kind} at s=${Math.round(pier.f.s)}: ${h}`);
    }
  }
  return out;
}

/** Lowest headroom left under any cap beam over a road: cap bottom minus road surface. */
function capHeadroom(net: RoadNetwork, deck: Id, p: PierPlan): number {
  let worst = Infinity;
  for (const pier of p.piers) {
    if (pier.capDepth <= 0) continue;
    const bottom = pier.f.y - DECK_DEPTH - 0.12 - pier.capDepth;
    for (let u = pier.capL; u <= pier.capR; u += 0.5) {
      const x = pier.f.x + pier.f.rx * u;
      const z = pier.f.z + pier.f.rz * u;
      for (const s of net.segments) {
        if (s.id === deck) continue;
        const near = net.nearestSegment(v(x, z), 30);
        if (!near || near.segmentId !== s.id) continue;
        const def = net.roadTypeOf(s.id);
        if (Math.abs(near.lateral) > def.halfWidth) continue;
        const y = cubicPoint(net.cubicOf(s.id), near.t).y;
        if (y < pier.f.y - 2) worst = Math.min(worst, bottom - y);
      }
    }
  }
  return worst;
}

describe('pier placement clear of everything below', () => {
  it('a rail viaduct over a skewed six-lane avenue', () => {
    for (const skew of [0, 25, 40, 55]) {
      const net = new RoadNetwork();
      road(net, 'avenue-6', v(-600, 0), v(600, 0));
      const a = (skew * Math.PI) / 180;
      const dx = Math.sin(a) * 400;
      const dz = Math.cos(a) * 400;
      const deck = road(net, 'rail-double', v(-dx, -dz, 10), v(dx, dz, 10));
      const p = plan(net, deck);
      expect(columnHits(net, deck, p), `skew ${skew}`).toEqual([]);
      expect(p.piers.length).toBeGreaterThan(10);
      expect(capHeadroom(net, deck, p), `skew ${skew}`).toBeGreaterThanOrEqual(4.7);
    }
  });

  it('a highway under a rail viaduct, square and skewed', () => {
    for (const skew of [0, 180, 320]) {
      const net = new RoadNetwork();
      addRaw(net, 'dual-6', v(-800, 0), v(800, 0));
      const deck = road(net, 'rail-double', v(-skew, -500, 9), v(skew, 500, 9));
      const p = plan(net, deck);
      expect(columnHits(net, deck, p), `skew ${skew}`).toEqual([]);
      expect(p.piers.length + p.girders.length).toBeGreaterThan(0);
    }
  });

  it('a viaduct running along above an avenue stands its hammerheads in the median', () => {
    const net = new RoadNetwork();
    addRaw(net, 'avenue-6', v(-600, 0), v(600, 0));
    const deck = road(net, 'rail-double', v(-400, 0, 10), v(400, 0, 10));
    const p = plan(net, deck);
    expect(columnHits(net, deck, p)).toEqual([]);
    expect(p.piers.length).toBeGreaterThan(15);
    for (const pier of p.piers) {
      expect(pier.kind).toBe('hammer');
      // Median is 4 m wide: the column is within it.
      expect(Math.abs(pier.columns[0].z)).toBeLessThan(2);
    }
    // And the caps over the lanes leave the traffic its headroom.
    expect(capHeadroom(net, deck, p)).toBeGreaterThanOrEqual(4.7);
  });

  it('a road flyover over another road, and a multi-level stack', () => {
    const net = new RoadNetwork();
    addRaw(net, 'avenue-4', v(-600, 0), v(600, 0));
    const mid = road(net, 'highway-3', v(-20, -400, 9), v(20, 400, 9));
    const top = road(net, 'ramp-2', v(-300, -300, 18), v(300, 300, 18));
    expect(columnHits(net, mid)).toEqual([]);
    expect(columnHits(net, top)).toEqual([]);
    expect(plan(net, top).piers.length).toBeGreaterThan(10);
  });

  it('a skewed avenue flyover over a street grid with junctions below', () => {
    const net = new RoadNetwork();
    road(net, 'avenue-4', v(-400, 0), v(400, 0));
    road(net, 'street-4', v(0, -400), v(0, 400));
    road(net, 'street-2', v(-400, 60), v(400, 60));
    const deck = road(net, 'avenue-4', v(-300, -250, 9), v(300, 250, 9));
    expect(net.nodes.some((n) => net.nodeGeom(n.id)?.kind === 'junction')).toBe(true);
    expect(columnHits(net, deck)).toEqual([]);
  });

  it('piers miss a station platform below', () => {
    const net = new RoadNetwork();
    const seg = addRaw(net, 'rail-double', v(-800, 0), v(800, 0));
    net.addStation({ name: 'Under', kind: 'surface', segmentId: seg, t: 0.5, platformLength: 300, layout: 'both' });
    const deck = road(net, 'street-2', v(-300, 30, 8), v(300, -30, 8));
    expect(columnHits(net, deck)).toEqual([]);
  });

  it('picks a portal frame where no column fits under the deck', () => {
    const net = new RoadNetwork();
    // A wide highway with no median, the viaduct right along above it: nowhere to stand under.
    addRaw(net, 'highway-5', v(-600, 0), v(600, 0));
    const deck = road(net, 'rail-double', v(-400, 0, 10), v(400, 0, 10));
    const p = plan(net, deck);
    expect(columnHits(net, deck, p)).toEqual([]);
    expect(p.piers.length).toBeGreaterThan(10);
    for (const pier of p.piers) {
      expect(pier.kind).toBe('portal');
      expect(pier.columns).toHaveLength(2);
      for (const c of pier.columns) expect(Math.abs(c.z)).toBeGreaterThan(11.875);
    }
    expect(capHeadroom(net, deck, p)).toBeGreaterThanOrEqual(4.7);
  });

  it('falls back to a long girder span where nothing can stand', () => {
    const net = new RoadNetwork();
    // Three wide highways side by side under the whole stretch, wider than a portal reaches.
    for (const z of [-24, 0, 24]) addRaw(net, 'highway-5', v(-600, z), v(600, z));
    const deck = road(net, 'rail-double', v(-300, 0, 12), v(300, 0, 12));
    const p = plan(net, deck);
    expect(columnHits(net, deck, p)).toEqual([]);
    expect(p.girders.length).toBeGreaterThan(0);
  });

  it('re-plans when a road is added or removed underneath after the bridge', () => {
    const net = new RoadNetwork();
    const deck = road(net, 'rail-double', v(-400, 0, 10), v(400, 0, 10));
    const before = plan(net, deck);
    expect(before.piers.every((p) => p.kind === 'hammer' && Math.abs(p.columns[0].z) < 0.01)).toBe(true);
    // An avenue built along under it afterwards: the centred columns would stand in its lanes.
    const below = addRaw(net, 'highway-4', v(-600, 0), v(600, 0));
    expect(columnHits(net, deck, before).length).toBeGreaterThan(0);
    const after = plan(net, deck);
    expect(columnHits(net, deck, after)).toEqual([]);
    expect(after.piers.every((p) => p.kind === 'portal')).toBe(true);
    // A crossing street added later too.
    addRaw(net, 'street-4', v(15, -300), v(15, 300));
    expect(columnHits(net, deck)).toEqual([]);
    // Removing the road below brings the plain hammerheads back.
    net.removeSegment(below);
    expect(plan(net, deck).piers.some((p) => p.kind === 'hammer')).toBe(true);
  });

  it('the road layer re-plans an elevated deck when a road is added or removed under it', () => {
    const net = new RoadNetwork();
    const deck = road(net, 'rail-double', v(-400, 0, 10), v(400, 0, 10));
    const layer = new RoadLayer(net, {} as Shared);
    layer.flush();
    const piece = () => (layer as unknown as { surf: { pieces: Map<Id, { piece: unknown }> } }).surf.pieces.get(deck)?.piece;
    const first = piece();
    expect(first).toBeTruthy();
    // Unrelated far away: no rebuild.
    addRaw(net, 'street-2', v(-900, 900), v(-800, 900));
    layer.flush();
    expect(piece()).toBe(first);
    const below = addRaw(net, 'avenue-4', v(30, -300), v(30, 300));
    layer.flush();
    const second = piece();
    expect(second).not.toBe(first);
    net.removeSegment(below);
    layer.flush();
    expect(piece()).not.toBe(second);
    layer.dispose();
  });

  it('a draft preview plans the same supports the built deck gets', () => {
    const net = new RoadNetwork();
    addRaw(net, 'avenue-6', v(-600, 0), v(600, 0));
    const draft = { start: { kind: 'free' as const, pos: v(-200, -300, 10) }, end: { kind: 'free' as const, pos: v(200, 300, 10) }, roadType: 'rail-double' };
    // The same network before the deck is built, as the draw preview sees it.
    const before = new RoadNetwork();
    addRaw(before, 'avenue-6', v(-600, 0), v(600, 0));
    const deck = road(net, draft.roadType, draft.start.pos, draft.end.pos);
    const geom = net.segmentGeom(deck)!;
    const asDraft = planSupports(before, { frames: buildFrames(geom.stations, [], groundFn(before)), def: net.roadTypeOf(deck), self: null });
    const built = plan(net, deck);
    expect(built.piers.length).toBeGreaterThan(5);
    expect(asDraft.piers.map((p) => Math.round(p.f.s))).toEqual(built.piers.map((p) => Math.round(p.f.s)));
  });

  it('an elevated junction stands its column clear of the road below', () => {
    const net = new RoadNetwork();
    addRaw(net, 'avenue-4', v(-400, 0), v(400, 0));
    road(net, 'street-4', v(-300, 0, 10), v(300, 0, 10));
    road(net, 'street-4', v(0, -300, 10), v(0, 300, 10));
    const node = net.nodes.find((n) => n.pos.y > 9 && net.nodeGeom(n.id)?.kind === 'junction');
    expect(node).toBeTruthy();
    const s = planNodeSupport(net, node!.id);
    if (s) expect(hitsAt(net, null, s.x, s.z, s.rc + 0.25, node!.pos.y, false)).toEqual([]);
  });

  it('planning stays quick', () => {
    const net = new RoadNetwork();
    for (let i = -4; i <= 4; i++) addRaw(net, 'avenue-4', v(-1000, i * 90), v(1000, i * 90));
    for (let i = -4; i <= 4; i++) addRaw(net, 'street-4', v(i * 110, -1000), v(i * 110, 1000));
    const deck = road(net, 'rail-double', v(-900, -700, 12), v(900, 700, 12));
    const frames = buildFrames(net.segmentGeom(deck)!.stations, [], groundFn(net));
    const t0 = performance.now();
    const p = planSupports(net, { frames, def: net.roadTypeOf(deck), self: deck, nodes: [] });
    const ms = performance.now() - t0;
    expect(columnHits(net, deck, p)).toEqual([]);
    expect(ms).toBeLessThan(400);
  });
});
