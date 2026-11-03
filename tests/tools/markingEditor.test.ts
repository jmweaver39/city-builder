/**
 * The junction marking editor and Bulldoze at the level of single markings:
 * removing automatic ones one at a time and bringing them back, turning them into
 * editable markings, direct manipulation by handles, the draw tools and their
 * keys, copy and paste, templates on a second junction, and segment markings.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { captureTemplate, checkNetworkInvariants, markingPath, nodeAnchors, resolveAnchor, segmentFrames, type Id, type NodeLineMarking } from '../../src/core';
import { autoMarkingItems } from '../../src/render/autoItems';
import { rig, type Rig } from './helpers';

const free = (x: number, z: number) => ({ kind: 'free' as const, pos: { x, y: 0, z } });

let r: Rig;
beforeEach(() => {
  r = rig();
});

function cross(roadType = 'street-4', at = 0): Id {
  r.net.drawRoad({ start: free(at - 150, 0), end: free(at + 150, 0), roadType });
  return r.net.drawRoad({ start: free(at, -150), end: free(at, 150), roadType }).junctions[0];
}

const centre = (pts: readonly { x: number; z: number }[]) => ({
  x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
  z: pts.reduce((a, p) => a + p.z, 0) / pts.length,
});

const items = (node: Id, kind: string) => autoMarkingItems(r.net, node).filter((i) => i.ref.kind === kind);

describe('Bulldoze on single markings', () => {
  beforeEach(() => r.tools.setTool('bulldoze'));

  it('takes away one automatic crosswalk, outlined first, and undo brings it back', () => {
    const node = cross();
    const walks = items(node, 'crosswalk');
    expect(walks).toHaveLength(4);
    const c = centre(walks[0].outline);
    r.hover(c.x, c.z);
    expect(r.tools.hud?.lines[0]).toMatch(/^Remove crosswalk/);
    expect(r.view.marks.some((m) => m.kind === 'line')).toBe(true);
    const roads = r.net.segments.length;
    r.history.clear();
    r.click(c.x, c.z);
    expect(items(node, 'crosswalk')).toHaveLength(3);
    expect(r.net.segments).toHaveLength(roads);
    expect(r.history.size).toBe(1);
    r.history.undo();
    expect(items(node, 'crosswalk')).toHaveLength(4);
  });

  it('takes away one turn arrow and nothing else', () => {
    const node = cross();
    const arrows = items(node, 'arrow');
    const before = autoMarkingItems(r.net, node).length;
    const c = centre(arrows[0].outline);
    r.click(c.x, c.z);
    expect(items(node, 'arrow')).toHaveLength(arrows.length - 1);
    expect(autoMarkingItems(r.net, node).length).toBe(before - 1);
    expect(r.net.getNode(node)!.control.autoOff).toEqual([arrows[0].ref]);
  });

  it('removes a hand-placed line by itself, leaving the road', () => {
    const node = cross();
    const a = nodeAnchors(r.net, node);
    const arms = [...new Set(a.map((x) => x.anchor.segmentId))];
    r.net.addNodeMarking(node, { kind: 'line', from: a.find((x) => x.anchor.segmentId === arms[0])!.anchor, to: a.find((x) => x.anchor.segmentId === arms[2])!.anchor, style: 'solid', color: 'white', width: 0.15, straight: true });
    const m = r.net.getNode(node)!.control.markings![0] as NodeLineMarking;
    const path = markingPath(r.net, node, m)!;
    const mid = path[Math.floor(path.length / 2)];
    r.click(mid.x, mid.z);
    expect(r.net.getNode(node)!.control.markings).toBeUndefined();
    expect(checkNetworkInvariants(r.net)).toEqual([]);
  });
});

describe('Junction marking editor', () => {
  beforeEach(() => r.tools.setTool('nodeMarkings'));
  const tool = () => r.tools.nodeMarkings;

  it('outlines every marking as soon as a junction opens, automatic ones badged', () => {
    const node = cross();
    r.click(0, 0);
    expect(tool().node).toBe(node);
    const lines = r.view.marks.filter((m) => m.kind === 'line').length;
    const badges = r.view.marks.filter((m) => m.kind === 'ring').length;
    expect(lines).toBe(autoMarkingItems(r.net, node).length);
    expect(badges).toBe(autoMarkingItems(r.net, node).length);
  });

  it('the eraser takes away an automatic stop line; Delete takes a picked arrow; both come back', () => {
    const node = cross();
    r.click(0, 0);
    r.key('e');
    expect(tool().draw).toBe('erase');
    const stop = items(node, 'stop')[0];
    const c = centre(stop.outline);
    r.click(c.x, c.z);
    expect(items(node, 'stop')).toHaveLength(1);
    r.key('v');
    const arrow = items(node, 'arrow')[0];
    const ac = centre(arrow.outline);
    r.click(ac.x, ac.z);
    expect(tool().selectedAuto?.key).toBe(arrow.key);
    expect(r.key('Delete')).toBe(true);
    expect(items(node, 'arrow')).toHaveLength(7);
    const gone = autoMarkingItems(r.net, node, true).filter((i) => i.off);
    expect(gone).toHaveLength(2);
    tool().restoreAuto(gone[0]);
    expect(autoMarkingItems(r.net, node, true).filter((i) => i.off)).toHaveLength(1);
    tool().restoreAllAuto();
    expect(r.net.getNode(node)!.control.autoOff).toBeUndefined();
  });

  it('turns an automatic crosswalk into an editable one in the same place', () => {
    const node = cross();
    r.click(0, 0);
    const walk = items(node, 'crosswalk')[0];
    const c = centre(walk.outline);
    r.key('v');
    r.click(c.x, c.z);
    expect(tool().convertAuto()).toBe(true);
    const m = r.net.getNode(node)!.control.markings![0] as NodeLineMarking;
    expect(m.style).toBe('crosswalkZebra');
    const p = resolveAnchor(r.net, node, m.from)!.pos;
    const q = resolveAnchor(r.net, node, m.to)!.pos;
    const mid = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
    expect(Math.hypot(mid.x - c.x, mid.z - c.z)).toBeLessThan(0.6);
    expect(items(node, 'crosswalk')).toHaveLength(3);
    expect(tool().selected).toBe(m.id);
  });

  it("drags a line's end onto another arm, as one undo step", () => {
    const node = cross();
    r.click(0, 0);
    const a = nodeAnchors(r.net, node);
    const arms = [...new Set(a.map((x) => x.anchor.segmentId))];
    const on = (arm: Id, i: number) => a.filter((x) => x.anchor.segmentId === arm)[i];
    r.click(on(arms[0], 1).pos.x, on(arms[0], 1).pos.z);
    r.click(on(arms[1], 3).pos.x, on(arms[1], 3).pos.z);
    const id = tool().selected!;
    const sig = r.net.signature();
    r.history.clear();
    const end = on(arms[1], 3).pos;
    const target = on(arms[2], 3).pos;
    r.drag([[end.x, end.z], [(end.x + target.x) / 2, (end.z + target.z) / 2], [target.x, target.z]]);
    const m = r.net.getNode(node)!.control.markings!.find((x) => x.id === id) as NodeLineMarking;
    expect(m.to.segmentId).toBe(arms[2]);
    expect(r.history.size).toBe(1);
    r.history.undo();
    expect(r.net.signature()).toBe(sig);
  });

  it('lays a crosswalk with one click, then drags it along the arm and widens it by its edge', () => {
    const node = cross();
    r.click(0, 0);
    r.key('c');
    const frame = segmentFramesAt(node)[0];
    const at = (back: number) => ({ x: frame.pos.x + frame.backDir.x * back, z: frame.pos.z + frame.backDir.z * back });
    const p = at(8);
    r.click(p.x, p.z);
    const m = () => r.net.getNode(node)!.control.markings![0] as NodeLineMarking;
    expect(m().style).toBe('crosswalkZebra');
    expect(m().from.back).toBeCloseTo(8, 6);
    expect(m().to.boundary - m().from.boundary).toBe(frame.offsets.length - 1);
    // Drag its middle further back.
    r.key('v');
    r.drag([[p.x, p.z], [at(10).x, at(10).z], [at(12).x, at(12).z]]);
    expect(m().from.back).toBeCloseTo(12, 1);
    // Drag its far edge out to make it 5 m deep.
    const edge = at(12 + m().width / 2);
    r.drag([[edge.x, edge.z], [at(14).x, at(14).z], [at(14.5).x, at(14.5).z]]);
    expect(m().width).toBeCloseTo(5, 1);
  });

  it('a stop line goes across the incoming lanes only', () => {
    const node = cross('avenue-4');
    r.click(0, 0);
    r.key('x');
    const frame = segmentFramesAt(node)[0];
    const p = { x: frame.pos.x + frame.backDir.x * 6, z: frame.pos.z + frame.backDir.z * 6 };
    r.click(p.x, p.z);
    const m = r.net.getNode(node)!.control.markings![0] as NodeLineMarking;
    expect(m.style).toBe('stopLine');
    const span = Math.abs(m.to.boundary - m.from.boundary);
    expect(span).toBeGreaterThan(0);
    expect(span).toBeLessThan(frame.offsets.length - 1);
  });

  it("drags an area's corner to another anchor", () => {
    const node = cross();
    r.click(0, 0);
    r.key('f');
    const a = nodeAnchors(r.net, node);
    for (const i of [0, 5, 10]) r.click(a[i].pos.x, a[i].pos.z);
    expect(r.key('Enter')).toBe(true);
    const id = tool().selected!;
    r.drag([[a[10].pos.x, a[10].pos.z], [a[12].pos.x + 0.5, a[12].pos.z], [a[12].pos.x, a[12].pos.z]]);
    const m = r.net.getNode(node)!.control.markings!.find((x) => x.id === id)!;
    expect(m.kind === 'filler' && m.anchors[2]).toEqual(a[12].anchor);
  });

  it('picks several, duplicates them, and steps through with Tab', () => {
    const node = cross();
    r.click(0, 0);
    const a = nodeAnchors(r.net, node);
    r.click(a[1].pos.x, a[1].pos.z);
    r.click(a[7].pos.x, a[7].pos.z);
    r.click(a[2].pos.x, a[2].pos.z);
    r.click(a[8].pos.x, a[8].pos.z);
    tool().selectAll();
    expect(tool().selection).toHaveLength(2);
    tool().duplicate();
    expect(r.net.getNode(node)!.control.markings).toHaveLength(4);
    expect(tool().selection).toHaveLength(2);
    tool().select(null);
    r.key('Tab');
    const first = tool().selected;
    r.key('Tab');
    expect(tool().selected).not.toBe(first);
  });

  it('copies one junction and pastes onto another with the same arms', () => {
    const one = cross('street-4', 0);
    const two = cross('street-4', 600);
    r.click(0, 0);
    const a = nodeAnchors(r.net, one);
    r.click(a[1].pos.x, a[1].pos.z);
    r.click(a[7].pos.x, a[7].pos.z);
    r.key('v');
    expect(tool().copy()).toBe(true);
    tool().open(two);
    r.history.clear();
    expect(tool().paste()).toBe(true);
    expect(r.net.getNode(two)!.control.markings).toHaveLength(1);
    expect(r.history.size).toBe(1);
    expect(checkNetworkInvariants(r.net)).toEqual([]);
  });

  it('applies a saved template to a second junction, then rotates and mirrors it', () => {
    const one = cross('street-4', 0);
    r.net.drawRoad({ start: free(600, 0), end: free(750, 0), roadType: 'street-4' });
    const t = r.net.drawRoad({ start: { kind: 'node', id: r.net.getNode(r.net.segments.at(-1)!.a)!.id }, end: free(600, 150), roadType: 'street-4' });
    const tee = r.net.drawRoad({ start: { kind: 'node', id: r.net.getSegment(t.segments[0])!.a }, end: free(450, 0), roadType: 'street-4' });
    const node = r.net.getSegment(tee.segments[0])!.a;
    void one;
    // A template from a T, put on this T.
    const other = rig();
    other.net.drawRoad({ start: free(0, 0), end: free(150, 0), roadType: 'street-4' });
    const n0 = other.net.getSegment(other.net.segments[0].id)!.a;
    other.net.drawRoad({ start: { kind: 'node', id: n0 }, end: free(0, 150), roadType: 'street-4' });
    other.net.drawRoad({ start: { kind: 'node', id: n0 }, end: free(-150, 0), roadType: 'street-4' });
    const oa = nodeAnchors(other.net, n0);
    other.net.addNodeMarking(n0, { kind: 'line', from: oa[0].anchor, to: oa[4].anchor, style: 'solidDashed', color: 'yellow', width: 0.12, straight: false });
    const tpl = captureTemplate(other.net, n0, 'Tee', 'tee');
    tool().open(node);
    expect(tool().useTemplate(tpl)).toBe(true);
    expect(r.net.getNode(node)!.control.markings).toHaveLength(1);
    const before = JSON.stringify(r.net.getNode(node)!.control.markings);
    tool().refit('mirror');
    const mirrored = r.net.getNode(node)!.control.markings![0] as NodeLineMarking;
    expect(mirrored.style).toBe('dashedSolid');
    tool().refit('rotate');
    expect(JSON.stringify(r.net.getNode(node)!.control.markings)).not.toBe(before);
    expect(checkNetworkInvariants(r.net)).toEqual([]);
  });

  it('opens a plain stretch of road and draws a line from one end to the other', () => {
    const seg = r.net.drawRoad({ start: free(0, 0), end: free(200, 0), roadType: 'street-2' }).segments[0];
    r.click(100, 0);
    expect(tool().host).toEqual({ kind: 'segment', id: seg });
    expect(r.inspected.at(-1)).toEqual({ kind: 'segmentMarkings', id: seg });
    const [fa, fb] = segmentFrames(r.net, seg);
    const pa = { x: fa.pos.x + fa.right.x * fa.offsets[1], z: fa.pos.z + fa.right.z * fa.offsets[1] };
    const pb = { x: fb.pos.x + fb.right.x * fb.offsets[1], z: fb.pos.z + fb.right.z * fb.offsets[1] };
    r.click(pa.x, pa.z);
    r.click(pb.x, pb.z);
    const list = r.net.getSegment(seg)!.overrides.handMarkings!;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'line', from: { end: 'a' }, to: { end: 'b' } });
    expect(checkNetworkInvariants(r.net)).toEqual([]);
  });

  it('nudges the point under the cursor with the arrow keys', () => {
    const node = cross();
    r.click(0, 0);
    const a = nodeAnchors(r.net, node)[1];
    r.hover(a.pos.x, a.pos.z);
    expect(r.key('ArrowRight')).toBe(true);
    expect(r.key('ArrowRight', { shift: true })).toBe(true);
    expect(tool().pointSetting(a.anchor.segmentId, a.anchor.boundary).offset).toBeCloseTo(0.3, 6);
  });
});

function segmentFramesAt(node: Id) {
  // Arm frames of a node, imported lazily so the helper reads like the others.
  return nodeFrames(node);
}

import { framesOf } from '../../src/core';
function nodeFrames(node: Id) {
  return framesOf(r.net, node);
}
