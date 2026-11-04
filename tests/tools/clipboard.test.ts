/**
 * The middle-click copy (an eyedropper) and Cmd+V paste: telling a middle click
 * from an orbit drag, what each kind of thing copies, pasting onto a road, a
 * marking and a junction as one undo step each, the Build and Markings tools
 * taking a copy, and the JSON form for the system clipboard, checked strictly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeAnchors, type Id, type NodeLineMarking, type Vec3 } from '../../src/core';
import { markingPath } from '../../src/core/nodeMarkings';
import { resolveDecal } from '../../src/core/roadPaint';
import { defaultSignalPlan } from '../../src/core/signals';
import { makeCustomRoadType } from '../../src/core/roadTypes';
import { autoLinesOf } from '../../src/core/paintCoherence';
import { CameraRig } from '../../src/render/camera';
import {
  ClipFormatError,
  copyAt,
  copyJunction,
  copyRoad,
  parseClip,
  pasteAt,
  serializeClip,
  targetAt,
  useClip,
  type Clip,
  type JunctionClip,
  type MarkingClip,
  type RoadClip,
} from '../../src/tools/clipboard';
import { FakeView, rig, type Rig } from './helpers';

const free = (x: number, z: number) => ({ kind: 'free' as const, pos: { x, y: 0, z } });

/** A view zoomed in 40 px to the metre, so automatic road lines can be aimed at. */
class ZoomView extends FakeView {
  project(p: { x: number; z: number }) {
    return { x: p.x * 40, y: p.z * 40 };
  }
}

let r: Rig;
beforeEach(() => {
  r = rig();
});

/** A street along z = `z` from x = 0 to 300. */
function street(z = -1200, type = 'street-2'): Id {
  return r.net.drawRoad({ start: free(0, z), end: free(300, z), roadType: type }).segments[0];
}

function cross(roadType = 'street-4', at = 0): Id {
  r.net.drawRoad({ start: free(at - 150, 0), end: free(at + 150, 0), roadType });
  return r.net.drawRoad({ start: free(at, -150), end: free(at, 150), roadType }).junctions[0];
}

const at = (x: number, z: number) => ({ x, y: z });
const roundTrip = (c: Clip) => parseClip(serializeClip(c, 1000))!.clip;

// ---------------------------------------------------------------------------
// Middle click versus middle drag
// ---------------------------------------------------------------------------

describe('middle click detection', () => {
  const saved = (globalThis as { window?: unknown }).window;
  let win: EventTarget;
  let dom: EventTarget & { clientHeight: number; getBoundingClientRect(): DOMRect };
  let cam: CameraRig;
  let clicks: [number, number][];

  const send = (target: EventTarget, type: string, props: Record<string, unknown>) => {
    const e = new Event(type, { cancelable: true });
    for (const [k, v] of Object.entries({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...props })) Object.defineProperty(e, k, { value: v });
    target.dispatchEvent(e);
  };
  const press = (button: number, x: number, y: number, alt = false) => send(dom, 'pointerdown', { button, clientX: x, clientY: y, altKey: alt });
  const move = (x: number, y: number) => send(win, 'pointermove', { clientX: x, clientY: y });
  const release = (button: number, x: number, y: number) => send(win, 'pointerup', { button, clientX: x, clientY: y });

  beforeEach(() => {
    win = new EventTarget();
    (globalThis as { window?: unknown }).window = win;
    dom = Object.assign(new EventTarget(), { clientHeight: 800, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }) as DOMRect });
    cam = new CameraRig(dom as unknown as HTMLElement, 1.5);
    clicks = [];
    cam.onMiddleClick((x, y) => clicks.push([x, y]));
  });
  afterEach(() => {
    cam.dispose();
    (globalThis as { window?: unknown }).window = saved;
  });

  it('a middle press and release that moves under 5 px is a click', () => {
    press(1, 300, 200);
    move(302, 203);
    release(1, 302, 203);
    expect(clicks).toEqual([[302, 203]]);
  });

  it('a middle drag orbits and is not a click', () => {
    const yaw = cam.getPose().yaw;
    press(1, 300, 200);
    move(320, 200);
    move(360, 210);
    release(1, 360, 210);
    expect(clicks).toEqual([]);
    expect(cam.isDragging).toBe(true);
    cam.update(1);
    expect(cam.getPose().yaw).not.toBeCloseTo(yaw, 3);
  });

  it('Option+click is a copy click, Option-drag still orbits', () => {
    press(0, 100, 100, true);
    release(0, 101, 100);
    expect(clicks).toEqual([[101, 100]]);
    press(0, 100, 100, true);
    move(140, 100);
    release(0, 140, 100);
    expect(clicks).toHaveLength(1);
  });

  it('a plain left click and a right click are not copy clicks', () => {
    press(0, 100, 100);
    release(0, 100, 100);
    press(2, 100, 100);
    release(2, 100, 100);
    expect(clicks).toEqual([]);
  });

  it('with a tool that keeps Option-drag (landscaping) only the middle button copies', () => {
    cam.toolButtons = true;
    press(0, 100, 100, true);
    release(0, 100, 100);
    expect(clicks).toEqual([]);
    press(1, 100, 100);
    release(1, 100, 100);
    expect(clicks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// What each thing copies
// ---------------------------------------------------------------------------

describe('copying a road', () => {
  it('takes its type, lane edits, surface, structure, barriers, upgrades and speed', () => {
    const id = street(-1200, 'avenue-4');
    r.net.setSegmentOverrides(id, {
      speedKmh: 40,
      laneSpeeds: { 1: 30 },
      laneKinds: { 3: 'bus' },
      laneBans: { 0: ['truck'] },
      surface: 'concrete',
      barriers: { left: { kind: 'acrylic', height: 3 } },
      upgrades: { left: { trees: 'trees', lights: 'decorative' }, right: { trees: 'trees' } },
      name: 'Main Street',
    });
    const got = copyAt(r.tools.ctx, at(150, -1200 + 2))!;
    expect(got.target).toEqual({ kind: 'road', segmentId: id });
    const clip = got.clip as RoadClip;
    expect(clip.kind).toBe('road');
    expect(clip.roadType).toBe('avenue-4');
    expect(clip.typeDef).toBeUndefined();
    expect(clip.style).toEqual({
      speedKmh: 40,
      laneSpeeds: { 1: 30 },
      laneKinds: { 3: 'bus' },
      laneBans: { 0: ['truck'] },
      surface: 'concrete',
      barriers: { left: { kind: 'acrylic', height: 3 } },
      upgrades: { left: { trees: 'trees', lights: 'decorative' }, right: { trees: 'trees' } },
    });
    // The name is not part of the look.
    expect(JSON.stringify(clip)).not.toContain('Main Street');
    expect(clip.name).toMatch(/^Avenue 4-lane.* with trees, lights, sound barriers, concrete surface, 40 km\/h and lane edits$/);
  });

  it('names a road with trees and lights the way the toast says it', () => {
    const id = street(-1200, 'avenue-4');
    r.net.setSegmentOverrides(id, { upgrades: { median: { trees: 'trees', lights: 'standard' } } });
    expect(copyRoad(r.net, id)!.name).toBe(`${r.net.roadTypeOf(id).name} with trees and lights`);
  });

  it('carries a custom road type with it', () => {
    const def = makeCustomRoadType({ id: 'custom-bus-street', name: 'Bus street', forwardLanes: 2, backwardLanes: 1, busLanes: true });
    r.net.setCustomRoadType(def);
    const id = street(-1200, def.id);
    const clip = copyRoad(r.net, id)!;
    expect(clip.roadType).toBe(def.id);
    expect(clip.typeDef).toEqual(def);
    expect(roundTrip(clip)).toEqual(clip);
  });
});

describe('copying a marking', () => {
  it('a painted line along a road: its style', () => {
    const id = street();
    const decal = r.net.addDecal({
      kind: 'line',
      points: [],
      road: { pieces: [{ segmentId: id, t0: 0.2, t1: 0.8 }], offset: 1.5 },
      style: { style: 'solidDashed', color: 'yellow', width: 0.2, dash: 2, space: 1, gap: 0.1 },
      color: 'yellow',
      width: 0.2,
      rotation: 0,
    });
    const pts = resolveDecal(r.net, r.net.decals.find((d) => d.id === decal)!).points;
    const mid = pts[Math.floor(pts.length / 2)];
    const got = copyAt(r.tools.ctx, at(mid.x, mid.z))!;
    expect(got.target).toEqual({ kind: 'decal', id: decal });
    expect((got.clip as MarkingClip).look).toEqual({ shape: 'line', spec: { style: 'solidDashed', color: 'yellow', width: 0.2, dash: 2, space: 1, gap: 0.1 } });
  });

  it('a hand-placed junction line: style, colour, width and its parts', () => {
    const node = cross();
    const a = nodeAnchors(r.net, node);
    const arms = [...new Set(a.map((x) => x.anchor.segmentId))];
    const id = r.net.addNodeMarking(node, {
      kind: 'line',
      from: a.find((x) => x.anchor.segmentId === arms[0])!.anchor,
      to: a.find((x) => x.anchor.segmentId === arms[2])!.anchor,
      style: 'dashed',
      color: 'blue',
      hex: '#3366ff',
      width: 0.3,
      dash: 1.2,
      space: 0.8,
      straight: true,
      rules: [{ from: { end: 0 }, to: { end: 1 }, style: { style: 'dotted', color: 'white', width: 0.1 } }],
    });
    const m = r.net.getNode(node)!.control.markings!.find((x) => x.id === id) as NodeLineMarking;
    const path = markingPath(r.net, node, m)!;
    const p = path[Math.floor(path.length / 3)];
    const got = copyAt(r.tools.ctx, at(p.x, p.z))!;
    expect(got.target.kind).toBe('marking');
    const look = (got.clip as MarkingClip).look;
    expect(look).toEqual({
      shape: 'line',
      spec: { style: 'dashed', color: 'blue', hex: '#3366ff', width: 0.3, dash: 1.2, space: 0.8 },
      parts: [{ from: 0, to: 1, style: { style: 'dotted', color: 'white', width: 0.1 } }],
    });
  });

  it('an automatic line along a road, when zoomed in to aim at it', () => {
    r = rig();
    const view = new ZoomView();
    Object.assign(r.tools.ctx, { view });
    const id = street();
    const centre = autoLinesOf(r.net, id).find((l) => l.role === 'centre')!;
    const got = copyAt(r.tools.ctx, at(150, -1200 + centre.offset))!;
    expect(got.target.kind).toBe('marking');
    const clip = got.clip as MarkingClip;
    expect(clip.look.shape).toBe('line');
    expect(clip.look.shape === 'line' && clip.look.spec.color).toBe(centre.color);
    expect(clip.look.shape === 'line' && clip.look.spec.style).toBe(centre.style);
  });
});

describe('copying a junction', () => {
  it('its control and shape, arms counted clockwise', () => {
    const node = cross();
    const arms = r.net.nodeGeom(node)!.arms.map((a) => a.segmentId);
    const plan = defaultSignalPlan(r.net, node);
    r.net.setJunctionControl(node, {
      mode: 'signal',
      signal: plan,
      signs: { [arms[1]]: 'yield' },
      rules: { arms: { [arms[0]]: { uturn: true } }, laneArrows: { [`${arms[2]}:1`]: ['straight'] } },
    });
    r.net.setJunctionShape(node, { corners: { [`${arms[0]}>${arms[1]}`]: { radius: 12 } }, arms: { [arms[3]]: { trim: 4 } }, scale: 1.2 });
    const got = copyAt(r.tools.ctx, at(0.4, 0.3))!;
    expect(got.target).toEqual({ kind: 'junction', nodeId: node });
    const clip = got.clip as JunctionClip;
    expect(clip.arms).toBe(4);
    expect(clip.mode).toBe('signal');
    expect(clip.signs).toEqual({ 1: 'yield' });
    expect(clip.signal!.phases.length).toBe(plan.phases.length);
    for (const p of clip.signal!.phases) for (const k of Object.keys(p.moves)) expect(k).toMatch(/^\d>\d$/);
    expect(clip.rules).toEqual({ arms: { 0: { uturn: true } }, laneArrows: { '2:1': ['straight'] } });
    expect(clip.shape?.corners).toEqual({ '0>1': { radius: 12 } });
    expect(clip.shape?.arms).toEqual({ 3: { trim: 4 } });
    expect(clip.shape?.scale).toBe(1.2);
    expect(Object.keys(clip.turns).length).toBeGreaterThan(4);
    expect(roundTrip(clip)).toEqual(clip);
  });

  it('a top-down click picks the junction over the roads under it, and the road beside it', () => {
    const node = cross();
    expect(targetAt(r.tools.ctx, at(0.4, 0.3))).toEqual({ kind: 'junction', nodeId: node });
    expect(targetAt(r.tools.ctx, at(80, 2))?.kind).toBe('road');
    expect(copyAt(r.tools.ctx, at(500, 500))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pasting, one undo step each
// ---------------------------------------------------------------------------

describe('pasting', () => {
  it('a road style onto another road', () => {
    const from = street(-1200, 'avenue-4');
    r.net.setSegmentOverrides(from, { surface: 'red', upgrades: { median: { trees: 'hedge' } }, laneSpeeds: { 0: 30 } });
    const to = street(-900, 'street-2');
    r.net.setSegmentOverrides(to, { speedKmh: 70, name: 'Keep me' });
    const clip = copyRoad(r.net, from)!;
    const steps = r.history.size;
    const res = pasteAt(r.tools.ctx, clip, at(150, -900 + 1));
    expect(res.ok).toBe(true);
    const seg = r.net.getSegment(to)!;
    expect(seg.roadType).toBe('avenue-4');
    expect(seg.overrides).toEqual({ surface: 'red', upgrades: { median: { trees: 'hedge' } }, laneSpeeds: { 0: 30 }, name: 'Keep me' });
    expect(r.history.size).toBe(steps + 1);
    r.history.undo();
    expect(r.net.getSegment(to)!.roadType).toBe('street-2');
    expect(r.net.getSegment(to)!.overrides).toEqual({ speedKmh: 70, name: 'Keep me' });
  });

  it('a road style with a custom type into a map without it adds the type in the same step', () => {
    const def = makeCustomRoadType({ id: 'custom-wide', name: 'Wide street', forwardLanes: 2, backwardLanes: 2 });
    const clip: RoadClip = { kind: 'road', name: def.name, roadType: def.id, typeDef: def, style: { surface: 'gravel' } };
    const to = street(-900);
    const steps = r.history.size;
    expect(pasteAt(r.tools.ctx, roundTrip(clip), at(150, -900)).ok).toBe(true);
    expect(r.net.getSegment(to)!.roadType).toBe(def.id);
    expect(r.history.size).toBe(steps + 1);
    r.history.undo();
    expect(r.net.roadType(def.id)).toBeUndefined();
  });

  it('a marking style onto a painted line, then onto an automatic line', () => {
    r = rig();
    Object.assign(r.tools.ctx, { view: new ZoomView() });
    const id = street();
    const decal = r.net.addDecal({ kind: 'line', points: [], road: { pieces: [{ segmentId: id, t0: 0.1, t1: 0.4 }], offset: 1.75 }, style: { style: 'solid', color: 'white', width: 0.15 }, color: 'white', width: 0.15, rotation: 0 });
    const clip: MarkingClip = { kind: 'marking', name: 'Zigzag', look: { shape: 'line', spec: { style: 'zigzag', color: 'yellow', width: 0.12, dash: 1, gap: 0.5 } } };
    const pts = resolveDecal(r.net, r.net.decals.find((d) => d.id === decal)!).points;
    const mid = pts[Math.floor(pts.length / 2)];
    let steps = r.history.size;
    expect(pasteAt(r.tools.ctx, clip, at(mid.x, mid.z)).ok).toBe(true);
    expect(r.net.decals.find((d) => d.id === decal)!.style).toEqual(clip.look.shape === 'line' && clip.look.spec);
    expect(r.history.size).toBe(steps + 1);
    r.history.undo();
    expect(r.net.decals.find((d) => d.id === decal)!.style?.style).toBe('solid');

    // The automatic centre line becomes a painted line with the copied look, in one step.
    const centre = autoLinesOf(r.net, id).find((l) => l.role === 'centre')!;
    steps = r.history.size;
    const before = r.net.decals.length;
    expect(pasteAt(r.tools.ctx, clip, at(250, -1200 + centre.offset)).ok).toBe(true);
    expect(r.net.decals.length).toBe(before + 1);
    expect(r.net.decals.at(-1)!.style?.style).toBe('zigzag');
    expect(r.net.getSegment(id)!.overrides.paintOff).toContain(centre.key);
    expect(r.history.size).toBe(steps + 1);
    r.history.undo();
    expect(r.net.decals.length).toBe(before);
    expect(r.net.getSegment(id)!.overrides.paintOff ?? []).not.toContain(centre.key);
  });

  it('a marking style onto a hand-placed junction line, refusing an area style', () => {
    const node = cross();
    const a = nodeAnchors(r.net, node);
    const arms = [...new Set(a.map((x) => x.anchor.segmentId))];
    const id = r.net.addNodeMarking(node, { kind: 'line', from: a.find((x) => x.anchor.segmentId === arms[0])!.anchor, to: a.find((x) => x.anchor.segmentId === arms[2])!.anchor, style: 'solid', color: 'white', width: 0.15, straight: true });
    const m = () => r.net.getNode(node)!.control.markings!.find((x) => x.id === id) as NodeLineMarking;
    const path = markingPath(r.net, node, m())!;
    const p = path[Math.floor(path.length / 3)];
    const sig = r.net.signature();
    const area: MarkingClip = { kind: 'marking', name: 'Hatched area', look: { shape: 'fill', fill: { fill: 'hatch', color: 'white', width: 0.3 } } };
    const refused = pasteAt(r.tools.ctx, area, at(p.x, p.z));
    expect(refused.ok).toBe(false);
    expect(r.net.signature()).toBe(sig);
    const steps = r.history.size;
    const line: MarkingClip = { kind: 'marking', name: 'Double', look: { shape: 'line', spec: { style: 'double', color: 'yellow', width: 0.12 }, parts: [{ from: 0, to: 1, style: { style: 'empty', color: 'white', width: 0.1 } }] } };
    expect(pasteAt(r.tools.ctx, line, at(p.x, p.z)).ok).toBe(true);
    expect(m().style).toBe('double');
    expect(m().color).toBe('yellow');
    expect(m().rules).toEqual([{ from: { end: 0 }, to: { end: 1 }, style: { style: 'empty', color: 'white', width: 0.1 } }]);
    expect(r.history.size).toBe(steps + 1);
    r.history.undo();
    expect(m().style).toBe('solid');
  });

  it("a junction's control and shape onto another junction", () => {
    const one = cross('street-4', 0);
    const two = cross('street-4', 600);
    const arms1 = r.net.nodeGeom(one)!.arms.map((a) => a.segmentId);
    r.net.setJunctionControl(one, { mode: 'priority', signs: { [arms1[1]]: 'stop', [arms1[3]]: 'stop' } });
    r.net.setJunctionShape(one, { scale: 1.3 });
    const clip = copyJunction(r.net, one)!;
    const steps = r.history.size;
    const res = pasteAt(r.tools.ctx, roundTrip(clip), at(600.3, 0.2));
    expect(res.ok).toBe(true);
    const c = r.net.getNode(two)!.control;
    expect(c.mode).toBe('priority');
    expect(Object.values(c.signs).filter((s) => s === 'stop')).toHaveLength(2);
    expect(c.shape?.scale).toBe(1.3);
    expect(r.history.size).toBe(steps + 1);
    r.history.undo();
    expect(r.net.getNode(two)!.control.mode).toBe('auto');
    expect(r.net.getNode(two)!.control.shape).toBeUndefined();
  });

  it('a signal plan onto another junction runs lights there', () => {
    const one = cross('street-4', 0);
    const two = cross('street-4', 600);
    r.net.setJunctionControl(one, { mode: 'signal', signal: defaultSignalPlan(r.net, one, 'protectedLefts') });
    const clip = copyJunction(r.net, one)!;
    expect(pasteAt(r.tools.ctx, clip, at(600.3, 0.2)).ok).toBe(true);
    const sig = r.net.getNode(two)!.control.signal!;
    expect(sig.phases.length).toBe(clip.signal!.phases.length);
    const arms2 = new Set(r.net.nodeGeom(two)!.arms.map((a) => a.segmentId));
    for (const p of sig.phases) for (const k of Object.keys(p.moves)) for (const s of k.split('>')) expect(arms2.has(Number(s))).toBe(true);
  });

  it('a clip pastes only onto its own kind of thing', () => {
    street(-900);
    const clip: JunctionClip = { kind: 'junction', name: 'J', arms: 4, turns: {}, mode: 'allStop', signs: {}, signal: null };
    const res = pasteAt(r.tools.ctx, clip, at(150, -900));
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Using a copy to build
// ---------------------------------------------------------------------------

describe('building with a copy', () => {
  it('the Build tool takes the road type and gives new roads its settings', () => {
    const from = street(-1200, 'avenue-4');
    r.net.setSegmentOverrides(from, { upgrades: { left: { trees: 'trees' }, right: { lights: 'double' } }, surface: 'concrete', speedKmh: 40 });
    const got = copyAt(r.tools.ctx, at(150, -1200 + 2))!;
    useClip(r.tools, got.clip);
    expect(r.tools.active.id).toBe('road');
    expect(r.tools.settings.roadType).toBe('avenue-4');
    const before = new Set(r.net.segments.map((s) => s.id));
    r.click(0, 400);
    r.click(200, 400);
    const made = r.net.segments.filter((s) => !before.has(s.id));
    expect(made).toHaveLength(1);
    expect(made[0].roadType).toBe('avenue-4');
    expect(made[0].overrides).toMatchObject({ upgrades: { left: { trees: 'trees' }, right: { lights: 'double' } }, surface: 'concrete', speedKmh: 40 });
    // Another road type draws plain.
    r.rightClick();
    r.tools.settings.roadType = 'street-2';
    r.tools.settingsChanged();
    r.click(0, 800);
    r.click(200, 800);
    const plain = r.net.segments.find((s) => !before.has(s.id) && s.id !== made[0].id)!;
    expect(plain.overrides.upgrades).toBeUndefined();
  });

  it("Upgrade's Paste style sweeps the copy over roads in one step", () => {
    const from = street(-1200, 'avenue-4');
    r.net.setSegmentOverrides(from, { surface: 'red' });
    const a = street(-900);
    const b = street(-600);
    r.tools.setTool('road');
    r.tools.settings.drawMode = 'upgrade';
    r.tools.settingsChanged();
    useClip(r.tools, copyRoad(r.net, from)!);
    expect(r.tools.settings.walls.upgrade).toBe('style');
    const steps = r.history.size;
    r.drag([[150, -900], [150, -750], [150, -600]]);
    expect(r.net.getSegment(a)!.overrides.surface).toBe('red');
    expect(r.net.getSegment(b)!.roadType).toBe('avenue-4');
    expect(r.history.size).toBe(steps + 1);
  });

  it('the Markings tool takes a copied style, ready to draw, leaving the selection alone', () => {
    const line: MarkingClip = { kind: 'marking', name: 'Dashed red', look: { shape: 'line', spec: { style: 'dashed', color: 'red', width: 0.25, dash: 3, space: 2 } } };
    useClip(r.tools, line);
    expect(r.tools.active.id).toBe('paint');
    const s = r.tools.settings;
    expect(s.nodeMarking.draw).toBe('line');
    expect(s.nodeMarking.style).toBe('dashed');
    expect(s.nodeMarking.color).toBe('red');
    expect(s.nodeMarking.width).toBe(0.25);
    expect(s.paint.kind).toBe('line');
    expect(s.paint.look).toMatchObject({ style: 'dashed', color: 'red', width: 0.25, dash: 3, space: 2 });

    const zebra: MarkingClip = { kind: 'marking', name: 'Ladder', look: { shape: 'line', spec: { style: 'crosswalkLadder', color: 'white', width: 4, dash: 0.5, space: 0.5 } } };
    useClip(r.tools, zebra);
    expect(s.nodeMarking.draw).toBe('crosswalk');
    expect(s.nodeMarking.crosswalk).toEqual(zebra.look.shape === 'line' && zebra.look.spec);

    const area: MarkingClip = { kind: 'marking', name: 'Chevrons', look: { shape: 'fill', fill: { fill: 'chevron', color: 'yellow', width: 0.4, step: 2.6, angle: 0 } } };
    useClip(r.tools, area);
    expect(s.nodeMarking.draw).toBe('filler');
    expect(s.nodeMarking.fill).toBe('chevron');
    expect(s.nodeMarking.fillWidth).toBe(0.4);

    const arrow: MarkingClip = { kind: 'marking', name: 'Arrow', look: { shape: 'stamp', stamp: 'arrowLeft', color: 'white', width: 1 } };
    useClip(r.tools, arrow);
    expect(s.nodeMarking.draw).toBe('stamp');
    expect(s.paint.kind).toBe('arrowLeft');
  });

  it('a middle-clicked marking paints with its style', () => {
    const id = street();
    const decal = r.net.addDecal({ kind: 'line', points: [], road: { pieces: [{ segmentId: id, t0: 0.2, t1: 0.8 }], offset: 1.5 }, style: { style: 'dotted', color: 'green', width: 0.2 }, color: 'green', width: 0.2, rotation: 0 });
    const pts = resolveDecal(r.net, r.net.decals.find((d) => d.id === decal)!).points;
    const mid: Vec3 = pts[Math.floor(pts.length / 2)];
    useClip(r.tools, copyAt(r.tools.ctx, at(mid.x, mid.z))!.clip);
    const s = r.tools.settings;
    expect(s.paint.look).toMatchObject({ style: 'dotted', color: 'green', width: 0.2 });
  });
});

// ---------------------------------------------------------------------------
// The JSON form
// ---------------------------------------------------------------------------

describe('system clipboard JSON', () => {
  const road: RoadClip = { kind: 'road', name: 'Street', roadType: 'street-2', style: { surface: 'concrete', laneSpeeds: { 0: 30 }, upgrades: { left: { lights: 'standard' } } } };
  const env = (clip: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ cloverleaf: 'clipboard', version: 1, at: 5, clip, ...extra });

  it('round trips every kind', () => {
    const marking: MarkingClip = { kind: 'marking', name: 'x', look: { shape: 'stamp', stamp: 'text', color: 'white', width: 1, text: 'BUS' } };
    const junction: JunctionClip = { kind: 'junction', name: 'J', arms: 3, turns: { '0>1': 'right' }, mode: 'allStop', signs: { 0: 'stop' }, signal: null, shape: { islands: [{ arm: 1, from: 1, to: 2, back: 3, reach: 1 }] } };
    for (const c of [road, marking, junction] as Clip[]) {
      const parsed = parseClip(serializeClip(c, 42))!;
      expect(parsed.at).toBe(42);
      expect(parsed.clip).toEqual(c);
    }
  });

  it('ignores text that is not a Cloverleaf copy', () => {
    expect(parseClip('hello')).toBeNull();
    expect(parseClip('{"a": 1}')).toBeNull();
    expect(parseClip('{"cloverleaf": "project"}')).toBeNull();
    expect(parseClip('{ broken "cloverleaf"')).toBeNull();
    expect(parseClip('x'.repeat(300_000))).toBeNull();
  });

  it('refuses a malformed copy strictly', () => {
    const bad = [
      env({ ...road, extra: 1 }),
      env(road, { extra: true }),
      env({ ...road, style: { ...road.style, surface: 'lava' } }),
      env({ ...road, style: { speedKmh: 9000 } }),
      env({ ...road, style: { laneSpeeds: { x: 30 } } }),
      env({ ...road, style: { laneBans: { 0: ['tank'] } } }),
      env({ ...road, style: { name: 'not a style field' } }),
      env({ ...road, roadType: '../evil' }),
      env({ kind: 'marking', name: 'x', look: { shape: 'line', spec: { style: 'neon', color: 'white', width: 0.1 } } }),
      env({ kind: 'marking', name: 'x', look: { shape: 'line', spec: { style: 'solid', color: 'white', width: 0.1, hex: 'red' } } }),
      env({ kind: 'marking', name: 'x', look: { shape: 'fill', fill: { fill: 'hatch', color: 'white', width: 0.3 }, spec: {} } }),
      env({ kind: 'junction', name: 'J', arms: 3, turns: {}, mode: 'signal', signs: { 5: 'stop' }, signal: null }),
      env({ kind: 'junction', name: 'J', arms: 3, turns: { '0>9': 'left' }, mode: 'auto', signs: {}, signal: null }),
      env({ kind: 'junction', name: 'J', arms: 3, turns: {}, mode: 'auto', signs: {}, signal: { kind: 'fixed', offsetSec: 0, phases: [{ id: 1, name: 'a', greenSec: 1e6, yellowSec: 3, allRedSec: 1, minGreenSec: 5, maxGreenSec: 30, moves: {} }] } }),
      env({ kind: 'road', name: 'x', roadType: 'mine', typeDef: { id: 'other' }, style: {} }),
      env({ kind: 'car', name: 'x' }),
      JSON.stringify({ cloverleaf: 'clipboard', version: 2, at: 1, clip: road }),
      JSON.stringify({ cloverleaf: 'clipboard', version: 1, clip: road }),
    ];
    for (const text of bad) expect(() => parseClip(text), text).toThrow(ClipFormatError);
  });

  it('checks a carried road type in full', () => {
    const def = makeCustomRoadType({ id: 'custom-mine', name: 'Mine', forwardLanes: 1, backwardLanes: 1 });
    const ok: RoadClip = { kind: 'road', name: 'Mine', roadType: def.id, typeDef: def, style: {} };
    expect(parseClip(serializeClip(ok))!.clip).toEqual(ok);
    // Lanes the wrong way round (traffic keeps right) are refused.
    const flipped = { ...def, lanes: def.lanes.map((l) => ({ ...l, dir: -l.dir })) };
    expect(() => parseClip(env({ ...ok, typeDef: flipped }))).toThrow(ClipFormatError);
  });
});
