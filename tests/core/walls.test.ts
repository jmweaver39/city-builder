import { describe, expect, it } from 'vitest';
import {
  QUAY_LINE,
  QUAY_TOP,
  RoadNetwork,
  SURFACE_LIFT,
  PARAPET,
  bankPoint,
  buildTerrainMods,
  groundHeight,
  profileHeight,
  quaySamples,
  roadEdge,
  segmentFootprintIssues,
  segmentSections,
  snapToBank,
  structureFootprint,
  terrainHeight,
  wallHeight,
  type Id,
  type StructureSpec,
} from '../../src/core';
import { History } from '../../src/app/History';
import { atNode, free } from './helpers';

/** Flat land well away from the river (river centre is near z = 400..700 here). */
const Z = -1200;

/** Ground, up a ramp to 8 m, along, and back down: three segments. */
function rampRoad(spec: StructureSpec, roadType = 'street-2'): { net: RoadNetwork; ids: Id[] } {
  const net = new RoadNetwork();
  const up = net.drawRoad({ start: free(-300, Z, 0), end: free(-100, Z, 8), roadType, overrides: { structure: spec } });
  const a = up.nodes[up.nodes.length - 1];
  const flat = net.drawRoad({ start: atNode(a), end: free(100, Z, 8), roadType, overrides: { structure: spec } });
  const b = flat.nodes[flat.nodes.length - 1];
  const down = net.drawRoad({ start: atNode(b), end: free(300, Z, 0), roadType, overrides: { structure: spec } });
  return { net, ids: [...up.segments, ...flat.segments, ...down.segments] };
}

function allSamples(net: RoadNetwork, ids: Id[]) {
  return ids.flatMap((id) => segmentSections(net, id));
}

describe('structure modes along a ramp up and back down', () => {
  it('retaining walls rise with the road and fall back to nothing at grade', () => {
    const { net, ids } = rampRoad({ mode: 'retaining' });
    const samples = allSamples(net, ids).sort((p, q) => p.x - q.x);
    expect(samples.length).toBeGreaterThan(40);
    const edge = roadEdge(net.roadType('street-2')!, 1);
    for (const s of samples) {
      const rise = s.y + SURFACE_LIFT + edge.lift - terrainHeight(s.x, s.z);
      const h = wallHeight(s.right);
      if (rise > 0.5) {
        // Wall reaches the edge it holds, plus its parapet.
        expect(s.right?.wall).toBeTruthy();
        expect(h).toBeCloseTo(rise + PARAPET, 2);
        expect(wallHeight(s.left)).toBeCloseTo(h, 2);
      } else if (rise < 0.04) {
        expect(s.right).toBeNull();
      }
    }
    // Highest along the flat top, none at the two ends.
    const top = samples.filter((s) => Math.abs(s.x) < 90);
    for (const s of top) expect(wallHeight(s.right)).toBeCloseTo(8 + SURFACE_LIFT + edge.lift + PARAPET, 1);
    expect(samples[0].right).toBeNull();
    expect(samples[samples.length - 1].right).toBeNull();
    // Monotonic up the ramp.
    const ramp = samples.filter((s) => s.x > -290 && s.x < -110 && s.right?.wall);
    for (let i = 1; i < ramp.length; i++) expect(wallHeight(ramp[i].right)).toBeGreaterThanOrEqual(wallHeight(ramp[i - 1].right) - 1e-6);
  });

  it('an embankment has 1 in 1.5 slopes, and a wall only on the side asked for', () => {
    const { net, ids } = rampRoad({ mode: 'embankment', right: { on: true, style: 'brick', top: 'railing' } });
    const s = allSamples(net, ids).find((p) => Math.abs(p.x) < 5)!;
    expect(s.left?.wall).toBeNull();
    expect(s.left?.slope).toBeTruthy();
    const sl = s.left!.slope!;
    expect((sl.o1 - sl.o0) / (sl.y0 - sl.y1)).toBeCloseTo(1.5, 2);
    expect(s.right?.wall).toBeTruthy();
    expect(s.right!.wall!.outer - s.right!.edge).toBeLessThan(0.6);
  });

  it('a height override caps the wall and puts a slope above it', () => {
    const { net, ids } = rampRoad({ mode: 'retaining', left: { style: 'stone', top: 'coping', height: 3 } });
    const s = allSamples(net, ids).find((p) => Math.abs(p.x) < 5)!;
    expect(s.left!.wall!.top - s.left!.wall!.bottom).toBeCloseTo(3, 2);
    expect(s.left!.slope).toBeTruthy();
    expect(s.right!.wall!.top - s.right!.wall!.bottom).toBeGreaterThan(7.5);
  });

  it('a trench has walls from the road up to the ground and no roof', () => {
    const net = new RoadNetwork();
    const down = net.drawRoad({ start: free(-300, Z, 0), end: free(-100, Z, -8), roadType: 'street-2', overrides: { structure: { mode: 'trench' } } });
    const s = segmentSections(net, down.segments[0]).find((p) => p.x > -105)!;
    expect(s.left!.kind).toBe('sunk');
    expect(s.left!.wall!.top).toBeCloseTo(0, 2);
    expect(s.left!.wall!.inner).toBeCloseTo(s.left!.edge, 5);
    expect(wallHeight(s.left)).toBeCloseTo(-(s.left!.edgeY), 2);
  });
});

describe('terrain modifiers', () => {
  it('ground meets the walls and slopes within a few centimetres', () => {
    const { net, ids } = rampRoad({ mode: 'embankment', right: { on: true, style: 'brick', top: 'coping' } });
    const mods = buildTerrainMods(net);
    const s = allSamples(net, ids).find((p) => Math.abs(p.x) < 5)!;
    const pt = (side: -1 | 1, o: number) => ({ x: s.x + s.rx * o * side, z: s.z + s.rz * o * side });
    // Under the road: the road itself.
    const c = pt(1, 0);
    expect(mods.groundAt(c.x, c.z)).toBeCloseTo(s.y, 2);
    // Right: the wall top just inside its outer face, natural ground just outside.
    const w = s.right!.wall!;
    const inside = pt(1, w.outer - 0.02);
    const outside = pt(1, w.outer + 0.05);
    expect(Math.abs(mods.groundAt(inside.x, inside.z) - w.top)).toBeLessThan(0.03);
    expect(Math.abs(mods.groundAt(outside.x, outside.z) - terrainHeight(outside.x, outside.z))).toBeLessThan(0.03);
    // Left: the slope from the road edge down to the toe.
    const sl = s.left!.slope!;
    const top = pt(-1, sl.o0 + 0.01);
    const toe = pt(-1, sl.o1 - 0.01);
    const mid = pt(-1, (sl.o0 + sl.o1) / 2);
    expect(Math.abs(mods.groundAt(top.x, top.z) - sl.y0)).toBeLessThan(0.03);
    expect(Math.abs(mods.groundAt(toe.x, toe.z) - sl.y1)).toBeLessThan(0.03);
    expect(Math.abs(mods.groundAt(mid.x, mid.z) - (sl.y0 + sl.y1) / 2)).toBeLessThan(0.03);
    expect(Math.abs(sl.y1 - terrainHeight(toe.x, toe.z))).toBeLessThan(0.03);
    // And the shared accessor agrees.
    expect(groundHeight(net, mid.x, mid.z)).toBeCloseTo(mods.groundAt(mid.x, mid.z), 6);
    // Far away nothing changed.
    expect(mods.groundAt(0, Z + 60)).toBe(terrainHeight(0, Z + 60));
  });

  it('a trench lowers the ground to the road, and the land is untouched past its walls', () => {
    const net = new RoadNetwork();
    const r = net.drawRoad({ start: free(-300, Z, 0), end: free(-100, Z, -8), roadType: 'street-2', overrides: { structure: { mode: 'trench' } } });
    const s = segmentSections(net, r.segments[0]).find((p) => p.x > -110)!;
    const mods = buildTerrainMods(net);
    expect(mods.groundAt(s.x, s.z)).toBeCloseTo(s.y, 2);
    const w = s.left!.wall!;
    const past = { x: s.x - s.rx * (w.outer + 0.05), z: s.z - s.rz * (w.outer + 0.05) };
    expect(mods.groundAt(past.x, past.z)).toBeCloseTo(terrainHeight(past.x, past.z), 2);
    expect(profileHeight(s.left!.profile, w.inner + 0.01)).toBeCloseTo(w.top, 2);
  });

  it('a junction on an embankment sits on a flat pad', () => {
    const { net } = rampRoad({ mode: 'embankment' });
    const mid = net.nodes.find((n) => Math.abs(n.pos.x + 100) < 1)!;
    // Add a third arm to make it a junction.
    net.drawRoad({ start: atNode(mid.id), end: free(-100, Z - 150, 8), roadType: 'street-2', overrides: { structure: { mode: 'embankment' } } });
    const mods = buildTerrainMods(net);
    expect(mods.discs.some((d) => d.nodeId === mid.id && d.raised)).toBe(true);
    expect(mods.groundAt(mid.pos.x, mid.pos.z)).toBeCloseTo(8, 2);
  });
});

describe('per-side settings persist', () => {
  const spec: StructureSpec = { mode: 'retaining', left: { on: false, style: 'gabion', top: 'fence' }, right: { on: true, style: 'brick', top: 'railing', height: 4 } };

  it('through split, reverse, save and undo', () => {
    const net = new RoadNetwork();
    const history = new History(net);
    const r = net.drawRoad({ start: free(-200, Z, 8), end: free(200, Z, 8), roadType: 'street-2', overrides: { structure: spec, barriers: { right: { kind: 'acrylic', height: 4 } } } });
    const id = r.segments[0];
    const right = net.splitSegment(id, 0.5).right!;
    for (const piece of [id, right]) {
      expect(net.getSegment(piece)!.overrides.structure).toEqual(spec);
      expect(net.getSegment(piece)!.overrides.barriers?.right?.kind).toBe('acrylic');
    }
    // Reverse: the same walls stay on the same side of the world, so they swap road sides.
    net.reverseSegment(right);
    const rev = net.getSegment(right)!.overrides;
    expect(rev.structure!.left).toEqual(spec.right);
    expect(rev.structure!.right).toEqual(spec.left);
    expect(rev.barriers?.left?.kind).toBe('acrylic');
    expect(rev.barriers?.right).toBeUndefined();
    // Walls in the world are where they were: the right wall of the unreversed piece and
    // the left wall of the reversed one are both on the same world side.
    const a = segmentSections(net, id).find((s) => s.left || s.right)!;
    const b = segmentSections(net, right).find((s) => s.left || s.right)!;
    expect(a.right!.wall).toBeTruthy();
    expect(b.left!.wall).toBeTruthy();
    expect(a.rx * b.rx + a.rz * b.rz).toBeLessThan(0); // they face opposite ways
    // Save and load.
    const copy = new RoadNetwork(net.serialize());
    expect(copy.getSegment(id)!.overrides.structure).toEqual(spec);
    expect(copy.getSegment(right)!.overrides.structure).toEqual(rev.structure);
    // Undo the reverse and the split.
    history.undo();
    expect(net.getSegment(right)!.overrides.structure).toEqual(spec);
    net.setSegmentOverrides(id, { structure: { mode: 'trench' } });
    expect(net.getSegment(id)!.overrides.structure!.mode).toBe('trench');
    history.undo();
    expect(net.getSegment(id)!.overrides.structure).toEqual(spec);
  });
});

describe('footprint validation', () => {
  it('warns when slopes spill onto a neighbouring road and refuses walls standing in it', () => {
    const net = new RoadNetwork();
    // A ground road running alongside, 14 m away.
    net.drawRoad({ start: free(-200, Z + 14, 0), end: free(200, Z + 14, 0), roadType: 'street-2' });
    const cubic = { p0: { x: -150, y: 8, z: Z }, p1: { x: -50, y: 8, z: Z }, p2: { x: 50, y: 8, z: Z }, p3: { x: 150, y: 8, z: Z } };
    const slopes = structureFootprint(net, { cubic, roadType: 'street-2', structure: { mode: 'embankment' } });
    expect(slopes.issues).toHaveLength(1);
    expect(slopes.issues[0].severity).toBe('warning');
    expect(slopes.left.length).toBeGreaterThan(5);
    const walls = structureFootprint(net, { cubic, roadType: 'street-2', structure: { mode: 'retaining' } });
    expect(walls.issues).toEqual([]);
    // Closer: the wall itself would stand in the road.
    const close = { ...cubic, p0: { ...cubic.p0, z: Z + 6 }, p1: { ...cubic.p1, z: Z + 6 }, p2: { ...cubic.p2, z: Z + 6 }, p3: { ...cubic.p3, z: Z + 6 } };
    const bad = structureFootprint(net, { cubic: close, roadType: 'street-2', structure: { mode: 'retaining' } });
    expect(bad.issues[0]?.severity).toBe('error');
    // Auto takes no extra width.
    expect(structureFootprint(net, { cubic, roadType: 'street-2', structure: { mode: 'auto' } }).issues).toEqual([]);
  });

  it('lets a road cross over a trench', () => {
    const net = new RoadNetwork();
    const t = net.drawRoad({ start: free(-200, Z, -8), end: free(200, Z, -8), roadType: 'street-2' });
    net.drawRoad({ start: free(0, Z - 100, 0), end: free(0, Z + 100, 0), roadType: 'street-2' });
    expect(segmentFootprintIssues(net, t.segments[0], { mode: 'trench' })).toEqual([]);
  });
});

describe('quays', () => {
  it('persist through save, load and undo, and old saves load unchanged', () => {
    const net = new RoadNetwork();
    const before = net.serialize();
    expect(JSON.parse(before).quays).toBeUndefined();
    const history = new History(net);
    const id = net.addQuay({ bank: 1, x0: -100, x1: 60, style: 'stone', top: 'bollards' });
    expect(net.quays).toHaveLength(1);
    const copy = new RoadNetwork(net.serialize());
    expect(copy.quays[0]).toEqual({ id, bank: 1, x0: -100, x1: 60, style: 'stone', top: 'bollards' });
    net.updateQuay(id, { style: 'brick' });
    expect(net.quays[0].style).toBe('brick');
    history.undo();
    expect(net.quays[0].style).toBe('stone');
    history.undo();
    expect(net.quays).toHaveLength(0);
    expect(net.serialize()).toBe(before);
    history.redo();
    net.removeQuay(id);
    expect(net.quays).toHaveLength(0);
  });

  it('holds the land at road level up to the wall, with the water beside it', () => {
    const net = new RoadNetwork();
    net.addQuay({ bank: -1, x0: -200, x1: 0, style: 'concrete', top: 'railing' });
    const x = -100;
    const behind = bankPoint(x, -1, QUAY_LINE + 2);
    const bank = bankPoint(x, -1, 34);
    const water = bankPoint(x, -1, QUAY_LINE - 2);
    expect(terrainHeight(behind.x, behind.z)).toBeLessThan(-2);
    expect(groundHeight(net, behind.x, behind.z)).toBeCloseTo(QUAY_TOP, 6);
    expect(groundHeight(net, bank.x, bank.z)).toBeCloseTo(QUAY_TOP, 6);
    expect(groundHeight(net, water.x, water.z)).toBe(terrainHeight(water.x, water.z));
    // The other bank and past the ends are untouched.
    const other = bankPoint(x, 1, QUAY_LINE + 2);
    expect(groundHeight(net, other.x, other.z)).toBe(terrainHeight(other.x, other.z));
    const past = bankPoint(50, -1, QUAY_LINE + 2);
    expect(groundHeight(net, past.x, past.z)).toBe(terrainHeight(past.x, past.z));
    // Snapping lands on the wall line and follows the bank.
    const snap = snapToBank(behind.x + 3, behind.z + 3)!;
    expect(snap.bank).toBe(-1);
    const line = bankPoint(snap.x, -1, QUAY_LINE);
    expect(Math.hypot(snap.pos.x - line.x, snap.pos.z - line.z)).toBeLessThan(1e-6);
    expect(snapToBank(0, -1500)).toBeNull();
    const samples = quaySamples({ bank: -1, x0: -200, x1: 0 });
    expect(samples[samples.length - 1].s).toBeGreaterThan(150);
  });

  it('turns a road along the bank into a ground road instead of a bridge', () => {
    const net = new RoadNetwork();
    const x = -100;
    const p0 = bankPoint(x - 40, -1, QUAY_LINE + 4);
    const p1 = bankPoint(x + 40, -1, QUAY_LINE + 4);
    net.drawRoad({ start: free(p0.x, p0.z, 0), end: free(p1.x, p1.z, 0), roadType: 'street-2' });
    const mid = bankPoint(x, -1, QUAY_LINE + 4);
    expect(groundHeight(net, mid.x, mid.z)).toBeLessThan(-1);
    net.addQuay({ bank: -1, x0: x - 80, x1: x + 80, style: 'stone', top: 'bollards' });
    expect(groundHeight(net, mid.x, mid.z)).toBeCloseTo(0, 6);
  });
});
