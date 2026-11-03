import { describe, expect, it } from 'vitest';
import { RoadNetwork, checkNetworkInvariants, closestPointOnCubic, cubicPoint, distXZ, type Cubic, type Vec3 } from '../../src/core';
import { snapRoadPoint, type SnapQuery } from '../../src/tools/snap';
import { defaultGuideToggles, type GuideContext } from '../../src/tools/guides';
import { defaultGrid, gridAlignedTo, toGrid } from '../../src/tools/grid';
import { buildParallel, insideRadius, offsetCubic, offsetPoint, orderChain, planParallel, roadChain, touchingOffset } from '../../src/tools/parallel';
import { rig } from './helpers';

const v = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });
const toggles = { nodes: true, segments: true, angle: false, length: false };
const ctx = (extra: Partial<GuideContext> = {}): GuideContext => ({ toggles: defaultGuideToggles(), mpp: 0.4, roadType: 'street-2', grid: null, ...extra });
const q = (raw: Vec3, extra: Partial<SnapQuery> = {}): SnapQuery => ({ picks: [{ level: 0, pos: raw }], raw, from: null, toggles, disabled: false, guides: ctx(), ...extra });
const only = (key: keyof ReturnType<typeof defaultGuideToggles>) => ({ ...Object.fromEntries(Object.keys(defaultGuideToggles()).map((k) => [k, false])), [key]: true }) as unknown as ReturnType<typeof defaultGuideToggles>;

function straight(net: RoadNetwork, a: Vec3, b: Vec3, roadType = 'street-2') {
  return net.drawRoad({ start: { kind: 'free', pos: a }, end: { kind: 'free', pos: b }, roadType });
}

/** A gentle S-free bend: a quarter-ish arc as one cubic. */
function bend(net: RoadNetwork, roadType = 'street-2') {
  return net.drawRoad({ start: { kind: 'free', pos: v(0, 0) }, end: { kind: 'free', pos: v(200, 120) }, c1: v(90, 0), c2: v(170, 40), roadType });
}

/** Largest error between a set of cubics and the true offset `d` of `c` (plan distance to c minus |d|). */
function offsetError(pieces: Cubic[], c: Cubic, d: number): number {
  let worst = 0;
  for (const p of pieces) {
    for (let i = 0; i <= 40; i++) {
      const pt = cubicPoint(p, i / 40);
      const hit = closestPointOnCubic(c, pt);
      if (hit.t < 1e-3 || hit.t > 1 - 1e-3) continue;
      worst = Math.max(worst, Math.abs(hit.distance - Math.abs(d)));
    }
  }
  return worst;
}

describe('offset geometry', () => {
  it('offsets a curve within a few centimetres on both sides', () => {
    const net = new RoadNetwork();
    const r = bend(net);
    const c = net.cubicOf(r.segments[0]);
    for (const d of [12, -12, 30, -30]) {
      const pieces = offsetCubic(c, d);
      expect(offsetError(pieces, c, d)).toBeLessThan(0.03);
      // Joined end to end.
      for (let i = 1; i < pieces.length; i++) expect(distXZ(pieces[i - 1].p3, pieces[i].p0)).toBeLessThan(1e-9);
    }
  });

  it('knows which side is inside a bend', () => {
    const net = new RoadNetwork();
    const c = net.cubicOf(bend(net).segments[0]);
    // The bend turns right (towards +z from +x), so the right side (+d) is inside.
    expect(insideRadius(c, 10)).toBeLessThan(Infinity);
    expect(insideRadius(c, -10)).toBe(Infinity);
  });
});

describe('parallel guides', () => {
  it('snaps the end onto a kerb-to-kerb or gap offset of a straight road', () => {
    const net = new RoadNetwork();
    straight(net, v(-100, 0), v(300, 0));
    const touch = touchingOffset(net, 'street-2', 'street-2');
    const hit = snapRoadPoint(net, q(v(150, touch + 1.2), { from: { pos: v(0, touch), ref: null }, guides: ctx({ toggles: only('parallel') }) }));
    expect(hit.kind).toBe('guide');
    expect(hit.pos.z).toBeCloseTo(touch, 6);
    expect(hit.guides?.label).toMatch(/^Parallel /);
  });

  it('follows a curved road: the draft is the offset curve', () => {
    const net = new RoadNetwork();
    const r = bend(net);
    const c = net.cubicOf(r.segments[0]);
    const d = touchingOffset(net, 'street-2', 'street-2') + 6;
    // Left of the curve (outside), start on the offset, cursor a little off it.
    const from = offsetPoint(c, 0.2, -d);
    const e = offsetPoint(c, 0.8, -d);
    const raw = { x: e.x + 1, y: 0, z: e.z + 0.8 };
    const hit = snapRoadPoint(net, q(raw, { from: { pos: from, ref: null }, guides: ctx({ toggles: only('parallel') }) }));
    expect(hit.kind).toBe('guide');
    expect(hit.guides?.cubic).toBeDefined();
    const cubic = hit.guides!.cubic!;
    expect(offsetError([cubic], c, d)).toBeLessThan(0.06);
  });

  it('follows the curve across a smooth joint where the road was split', () => {
    const net = new RoadNetwork();
    const r = bend(net);
    const c = net.cubicOf(r.segments[0]);
    net.splitSegment(r.segments[0], 0.45);
    const d = touchingOffset(net, 'street-2', 'street-2') + 6;
    const from = offsetPoint(c, 0.15, -d);
    const e = offsetPoint(c, 0.85, -d);
    const hit = snapRoadPoint(net, q({ x: e.x + 0.8, y: 0, z: e.z + 0.6 }, { from: { pos: from, ref: null }, guides: ctx({ toggles: only('parallel') }) }));
    expect(hit.kind).toBe('guide');
    expect(hit.guides?.cubic).toBeDefined();
    expect(offsetError([hit.guides!.cubic!], c, d)).toBeLessThan(0.15);
  });

  it('uses grid multiples when the grid is aligned to the road', () => {
    const net = new RoadNetwork();
    const r = straight(net, v(-100, 0), v(300, 0));
    const grid = { ...gridAlignedTo(net, r.segments[0], 0.5, { ...defaultGrid(), enabled: true, spacing: 32 }) };
    const hit = snapRoadPoint(net, q(v(100, 63), { from: { pos: v(0, 64), ref: null }, guides: ctx({ toggles: only('parallel'), grid }) }));
    expect(hit.kind).toBe('guide');
    expect(hit.pos.z).toBeCloseTo(64, 6);
  });
});

describe('perpendicular guides', () => {
  it('leaves a road at exactly 90 degrees', () => {
    const net = new RoadNetwork();
    const r = straight(net, v(0, 0), v(200, 0));
    const from = { pos: v(80, 0), ref: { x: 1, y: 0, z: 0 } };
    const hit = snapRoadPoint(net, q(v(83, 60), { from, guides: ctx({ toggles: only('perpendicular'), fromAnchor: { kind: 'segment', id: r.segments[0], t: 0.4 } }) }));
    expect(hit.kind).toBe('guide');
    expect(hit.pos.x).toBeCloseTo(80, 6);
    expect(hit.guides?.label).toMatch(/^90° to /);
    // A right-angle marker is drawn.
    expect(hit.guides!.marks.some((m) => m.kind === 'line' && m.points.length === 3 && !m.dashed)).toBe(true);
  });

  it('meets a road square on, short of it and on it', () => {
    const net = new RoadNetwork();
    straight(net, v(0, 0), v(200, 0));
    const from = { pos: v(100, 80), ref: null };
    const near = snapRoadPoint(net, q(v(103, 30), { from, guides: ctx({ toggles: only('perpendicular') }) }));
    expect(near.kind).toBe('guide');
    expect(near.pos.x).toBeCloseTo(100, 6);
    // On the road itself, the snap moves to the foot of the perpendicular.
    const on = snapRoadPoint(net, q(v(102.5, 1), { from, guides: ctx({ toggles: only('perpendicular') }) }));
    expect(on.kind).toBe('segment');
    expect(on.pos.x).toBeCloseTo(100, 3);
    expect(on.guides?.label).toMatch(/^90° to /);
  });
});

describe('extension lines', () => {
  it('lines up with a straight road end far away, and where two extensions cross', () => {
    const net = new RoadNetwork();
    straight(net, v(0, 0), v(100, 0));
    straight(net, v(500, -400), v(500, -300));
    const far = snapRoadPoint(net, q(v(900, 3), { guides: ctx({ toggles: only('extension') }) }));
    expect(far.kind).toBe('guide');
    expect(far.pos.z).toBeCloseTo(0, 6);
    expect(far.guides?.label).toMatch(/^In line with/);
    const cross = snapRoadPoint(net, q(v(502, 2), { guides: ctx({ toggles: only('extension') }) }));
    expect(cross.pos.x).toBeCloseTo(500, 4);
    expect(cross.pos.z).toBeCloseTo(0, 4);
    expect(cross.guides?.label).toContain(' · ');
  });
});

describe('line-up with points', () => {
  it('lines up with a nearby junction along the axes, or the aligned grid axes', () => {
    const net = new RoadNetwork();
    straight(net, v(300, 200), v(300, 260));
    straight(net, v(260, 200), v(340, 200));
    const hit = snapRoadPoint(net, q(v(50, 202), { guides: ctx({ toggles: only('lineup') }) }));
    expect(hit.kind).toBe('guide');
    expect(hit.pos.z).toBeCloseTo(200, 6);
    expect(hit.guides?.label).toBe('In line with junction');
    // On a turned grid the line-up runs along its axes.
    const grid = { ...defaultGrid(), enabled: true, rotation: Math.PI / 4 };
    const p = v(300 - 100, 200 - 100 + 2);
    const turned = snapRoadPoint(net, q(p, { guides: ctx({ toggles: only('lineup'), grid }) }));
    expect(turned.kind).toBe('guide');
    expect(Math.abs((turned.pos.x - 300) - (turned.pos.z - 200))).toBeLessThan(1e-6);
  });
});

describe('equal spacing', () => {
  it('offers the gap that matches two parallel roads, beyond and between them', () => {
    const net = new RoadNetwork();
    straight(net, v(-100, 0), v(300, 0));
    straight(net, v(-100, 30), v(300, 30));
    const beyond = snapRoadPoint(net, q(v(100, 58.5), { guides: ctx({ toggles: only('spacing') }) }));
    expect(beyond.kind).toBe('guide');
    expect(beyond.pos.z).toBeCloseTo(60, 6);
    expect(beyond.guides?.label).toBe('Equal spacing 30 m · 30 m');
    const between = snapRoadPoint(net, q(v(100, 16), { guides: ctx({ toggles: only('spacing') }) }));
    expect(between.pos.z).toBeCloseTo(15, 6);
  });
});

describe('midpoint, lock and priorities', () => {
  it('snaps onto a road at its midpoint', () => {
    const net = new RoadNetwork();
    straight(net, v(0, 0), v(200, 0));
    const hit = snapRoadPoint(net, q(v(101.5, 1), { guides: ctx({ toggles: only('midpoint') }) }));
    expect(hit.kind).toBe('segment');
    expect(hit.pos.x).toBeCloseTo(100, 2);
    expect(hit.guides?.label).toMatch(/^Midpoint of /);
  });

  it('holds a locked direction', () => {
    const net = new RoadNetwork();
    const lock = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 };
    const hit = snapRoadPoint(net, q(v(60, 40), { from: { pos: v(0, 0), ref: null }, guides: ctx({ lock }) }));
    expect(hit.kind).toBe('guide');
    expect(hit.pos.x).toBeCloseTo(hit.pos.z, 9);
    expect(hit.guides?.label).toBe('Locked direction');
  });

  it('keeps nodes ahead of guides, and Ctrl turns everything off', () => {
    const net = new RoadNetwork();
    straight(net, v(0, 0), v(100, 0));
    expect(snapRoadPoint(net, q(v(101, 2))).kind).toBe('node');
    const raw = v(600, 2);
    expect(snapRoadPoint(net, q(raw, { disabled: true })).pos).toEqual(raw);
  });

  it('changes nothing without guides', () => {
    const net = new RoadNetwork();
    straight(net, v(0, 0), v(100, 0));
    straight(net, v(0, 30), v(100, 30));
    for (let i = 0; i < 200; i++) {
      const raw = v(Math.sin(i) * 300, Math.cos(i * 1.7) * 300);
      const a = snapRoadPoint(net, q(raw, { guides: null }));
      const b = snapRoadPoint(net, q(raw, { guides: undefined }));
      expect(a).toEqual(b);
    }
  });
});

describe('Parallel Road tool', () => {
  it('copies a curved road at an exact offset, as one undo step', () => {
    const r = rig();
    const net = r.net;
    bend(net);
    const before = net.signature();
    const segs = net.segments.length;
    r.tools.settings.parallel.offset = 24;
    r.tools.setTool('parallel');
    // Hover on the outside (left) of the bend and click.
    r.click(100, -20);
    expect(net.segments.length).toBeGreaterThan(segs);
    const orig = net.cubicOf(net.segments[0].id);
    for (const s of net.segments.slice(1)) expect(offsetError([net.cubicOf(s.id)], orig, 24)).toBeLessThan(0.05);
    expect(checkNetworkInvariants(net)).toEqual([]);
    r.history.undo();
    expect(net.signature()).toBe(before);
  });

  it('gives a one-way highway its partner running the other way', () => {
    const net = new RoadNetwork();
    const road = straight(net, v(0, 0), v(400, 0), 'highway-3');
    const chain = orderChain(net, roadChain(net, road.segments[0]))!;
    const plan = planParallel(net, chain, -1, { offset: null, direction: 'auto', roadType: 'same' }, 'street-2');
    expect(plan.opposite).toBe(true);
    expect(plan.errors).toEqual([]);
    net.batch(() => buildParallel(net, plan));
    const copy = net.segments.find((s) => s.id !== road.segments[0])!;
    const a = net.getNode(copy.a)!.pos;
    const b = net.getNode(copy.b)!.pos;
    // Runs from high x to low x, on the left of the original (negative z).
    expect(a.x).toBeGreaterThan(b.x);
    expect(a.z).toBeLessThan(0);
    expect(checkNetworkInvariants(net)).toEqual([]);
  });

  it('refuses where the copy would overlap another road, and too tight inside a bend', () => {
    const net = new RoadNetwork();
    const road = straight(net, v(0, 0), v(300, 0));
    straight(net, v(0, 24), v(300, 24));
    const chain = orderChain(net, [road.segments[0]])!;
    const plan = planParallel(net, chain, 1, { offset: 24, direction: 'same', roadType: 'same' }, 'street-2');
    expect(plan.errors.length).toBeGreaterThan(0);
    const r = rig(null, net);
    const sig = net.signature();
    r.tools.settings.parallel.offset = 24;
    r.tools.setTool('parallel');
    r.click(150, 4);
    expect(net.signature()).toBe(sig);
    // A tight bend cannot be offset inside past its radius.
    const net2 = new RoadNetwork();
    const tight = net2.drawRoad({ start: { kind: 'free', pos: v(0, 0) }, end: { kind: 'free', pos: v(40, 40) }, c1: v(22, 0), c2: v(40, 18), roadType: 'street-2' });
    const p2 = planParallel(net2, orderChain(net2, tight.segments)!, 1, { offset: 48, direction: 'same', roadType: 'same' }, 'street-2');
    expect(p2.errors.join(' ')).toMatch(/too tightly/);
  });

  it('joins a road its end lands on', () => {
    const net = new RoadNetwork();
    const road = straight(net, v(0, 0), v(200, 0));
    straight(net, v(200, -80), v(200, 80));
    const plan = planParallel(net, orderChain(net, [road.segments[0]])!, 1, { offset: 24, direction: 'same', roadType: 'same' }, 'street-2');
    expect(plan.errors).toEqual([]);
    net.batch(() => buildParallel(net, plan));
    const n = net.nearestNode(v(200, 24), 1);
    expect(n).not.toBeNull();
    expect(net.getNode(n!.nodeId)!.segments.length).toBe(3);
  });
});

describe('drawing with guides in the road tool', () => {
  it('draws a road parallel to a curve that follows it', () => {
    const r = rig();
    const net = r.net;
    const c0 = net.cubicOf(bend(net).segments[0]);
    r.tools.setTool('road');
    const d = touchingOffset(net, 'street-2', 'street-2') + 6;
    const at = (t: number) => {
      const p = cubicPoint(c0, t);
      const a = cubicPoint(c0, t - 1e-4);
      const b = cubicPoint(c0, t + 1e-4);
      const l = Math.hypot(b.x - a.x, b.z - a.z);
      return { x: p.x + ((b.z - a.z) / l) * d, z: p.z - ((b.x - a.x) / l) * d };
    };
    const s = at(0.15);
    const e = at(0.85);
    r.click(s.x + 0.8, s.z + 0.5);
    r.click(e.x - 0.6, e.z + 0.7);
    expect(net.segments.length).toBe(2);
    expect(offsetError([net.cubicOf(net.segments[1].id)], c0, d)).toBeLessThan(0.1);
    expect(r.toasts).toEqual([]);
  });
});

describe('elevation keys and grid origin', () => {
  it('steps elevation with E and Q in tools that have one', () => {
    const r = rig();
    r.tools.setTool('road');
    expect(r.tools.elevationKeys).toBe(true);
    expect(r.key('e')).toBe(true);
    expect(r.tools.settings.elevation).toBe(4);
    expect(r.key('q')).toBe(true);
    expect(r.key('q')).toBe(true);
    expect(r.tools.settings.elevation).toBe(-4);
    // Alt+Q is left for the camera.
    expect(r.tools.keyDown({ key: 'q', shift: false, ctrl: false, alt: true })).toBe(false);
    r.tools.settings.drawMode = 'upgrade';
    r.tools.settingsChanged();
    expect(r.tools.elevationKeys).toBe(false);
    expect(r.key('e')).toBe(false);
    r.tools.setTool('select');
    expect(r.tools.elevationKeys).toBe(false);
    expect(r.key('q')).toBe(false);
    r.tools.setTool('move');
    expect(r.tools.elevationKeys).toBe(true);
  });

  it('puts the origin on the centreline only when asked', () => {
    const net = new RoadNetwork();
    const r = straight(net, v(10, 20), v(210, 120));
    const on = gridAlignedTo(net, r.segments[0], 0.3, { ...defaultGrid(), spacing: 32 });
    for (const t of [0.1, 0.6, 0.9]) {
      const p = cubicPoint(net.cubicOf(r.segments[0]), t);
      expect(toGrid(on, p).b).toBeCloseTo(0, 6);
    }
    const off = gridAlignedTo(net, r.segments[0], 0.3, { ...defaultGrid(), spacing: 32, alignOrigin: false, originX: 5, originZ: 7 });
    expect(off.originX).toBe(5);
    expect(off.originZ).toBe(7);
    expect(off.rotation).toBeCloseTo(on.rotation, 9);
  });
});

describe('guide keys in the keymap', () => {
  it('register without clashing', async () => {
    const { registerKeys, findConflicts } = await import('../../src/ui/keymap');
    const { GUIDE_KEYS } = await import('../../src/ui/guideKeys');
    const off = registerKeys(GUIDE_KEYS);
    const ids = GUIDE_KEYS.map((k) => k.id);
    const mine = findConflicts().filter((p) => ids.some((id) => p.includes(id)));
    off();
    expect(mine).toEqual([]);
  });
});
