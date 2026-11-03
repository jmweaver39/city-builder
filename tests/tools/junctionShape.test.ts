import { describe, expect, it } from 'vitest';
import { RoadNetwork, cornerInfos, islandPolygons, nodeAnchors, type Id } from '../../src/core';
import { COLORS } from '../../src/tools/types';
import { rig } from './helpers';

const free = (x: number, z: number) => ({ kind: 'free' as const, pos: { x, y: 0, z } });

function crossing(ew = 'street-2', ns = 'street-2'): { net: RoadNetwork; node: Id } {
  const net = new RoadNetwork();
  net.drawRoad({ start: free(-120, 0), end: free(120, 0), roadType: ew });
  const r = net.drawRoad({ start: free(0, -120), end: free(0, 120), roadType: ns });
  return { net, node: r.junctions[0] };
}

describe('Junction shape tool', () => {
  it('opens a junction on click and shows handles on every corner and arm', () => {
    const { net, node } = crossing();
    const r = rig(null, net);
    r.tools.setTool('junctionShape');
    r.click(0, 0);
    const tool = r.tools.junctionShape;
    expect(tool.node).toBe(node);
    expect(r.inspected.at(-1)).toEqual({ kind: 'junctionShape', id: node });
    const kinds = tool.handles().map((h) => h.kind);
    expect(kinds.filter((k) => k === 'radius')).toHaveLength(4);
    expect(kinds.filter((k) => k === 'kerb')).toHaveLength(4);
    expect(kinds.filter((k) => k === 'trim')).toHaveLength(4);
    expect(kinds.filter((k) => k === 'edgeLeft' || k === 'edgeRight')).toHaveLength(8);
    expect(r.view.marks.length).toBeGreaterThan(20);
  });

  it('drags a corner radius with snapping, as one undo step', () => {
    const { net, node } = crossing();
    const r = rig(null, net);
    r.tools.setTool('junctionShape');
    r.click(0, 0);
    const tool = r.tools.junctionShape;
    const h = tool.handles().find((x) => x.kind === 'radius')!;
    const steps = r.history.size;
    const path: [number, number][] = [[h.pos.x, h.pos.z]];
    for (let k = 1; k <= 6; k++) path.push([h.pos.x + h.axis.x * k * 0.5, h.pos.z + h.axis.z * k * 0.5]);
    r.drag(path);
    const radius = net.getNode(node)!.control.shape?.corners?.[h.key]?.radius;
    // From the automatic corner's 4.4 m, dragged 3 m out along the bisector.
    expect(radius).toBeGreaterThan(5);
    expect(radius! % 0.5).toBeCloseTo(0, 9);
    expect(r.history.size).toBe(steps + 1);
    r.history.undo();
    expect(net.getNode(node)!.control.shape).toBeUndefined();
    r.history.redo();
    expect(net.getNode(node)!.control.shape?.corners?.[h.key]?.radius).toBe(radius);
  });

  it('refuses a kerb that would block traffic, with a red handle and a reason', () => {
    const { net, node } = crossing();
    const r = rig(null, net);
    r.tools.setTool('junctionShape');
    r.click(0, 0);
    const tool = r.tools.junctionShape;
    const h = tool.handles().find((x) => x.kind === 'kerb')!;
    // Pull the sidewalk 4 m out into the road, past where right-turning traffic runs.
    const path: [number, number][] = [[h.pos.x, h.pos.z]];
    for (let k = 1; k <= 8; k++) path.push([h.pos.x + h.axis.x * k * 0.5, h.pos.z + h.axis.z * k * 0.5]);
    r.tools.pointerMove({ x: path[0][0], y: path[0][1], button: 0, shift: false, ctrl: false, alt: false });
    r.tools.pointerDown({ x: path[0][0], y: path[0][1], button: 0, shift: false, ctrl: false, alt: false });
    for (const [x, z] of path.slice(1)) r.tools.pointerMove({ x, y: z, button: 0, shift: false, ctrl: false, alt: false });
    expect(tool.problem).toMatch(/kerb/);
    expect(r.view.marks.some((m) => 'color' in m && m.color === COLORS.bad)).toBe(true);
    expect(r.tools.hud?.tone).toBe('error');
    r.tools.pointerUp({ x: path[8][0], y: path[8][1], button: 0, shift: false, ctrl: false, alt: false });
    // What stays is the last shape that worked: some extension, not the refused one.
    const kerb = net.getNode(node)!.control.shape?.corners?.[h.key]?.kerb ?? 0;
    expect(kerb).toBeGreaterThan(0);
    expect(kerb).toBeLessThan(4);
  });

  it('trims an arm with the cut line handle and resets it with a double-click', () => {
    const { net, node } = crossing();
    const r = rig(null, net);
    r.tools.setTool('junctionShape');
    r.click(0, 0);
    const tool = r.tools.junctionShape;
    const h = tool.handles().find((x) => x.kind === 'trim')!;
    const seg = Number(h.key);
    const before = net.nodeGeom(node)!.arms.find((a) => a.segmentId === seg)!.trim;
    r.drag([[h.pos.x, h.pos.z], [h.pos.x + h.axis.x * 2, h.pos.z + h.axis.z * 2], [h.pos.x + h.axis.x * 4.1, h.pos.z + h.axis.z * 4.1]]);
    expect(net.getNode(node)!.control.shape?.arms?.[seg]?.trim).toBe(4);
    expect(net.nodeGeom(node)!.arms.find((a) => a.segmentId === seg)!.trim).toBeCloseTo(before + 4, 5);
    const moved = tool.handles().find((x) => x.kind === 'trim' && x.key === h.key)!;
    r.tools.doubleClick({ x: moved.pos.x, y: moved.pos.z, button: 0, shift: false, ctrl: false, alt: false });
    expect(net.getNode(node)!.control.shape).toBeUndefined();
  });

  it('adds a refuge island by clicking two boundaries, and removes it with Delete', () => {
    const { net, node } = crossing('avenue-4', 'street-2');
    const r = rig(null, net);
    r.tools.setTool('junctionShape');
    r.click(0, 0);
    const tool = r.tools.junctionShape;
    expect(r.key('i')).toBe(true);
    expect(tool.islandMode).toBe(true);
    const avenue = net.getNode(node)!.segments.find((s) => net.roadTypeOf(s).id === 'avenue-4')!;
    const anchors = nodeAnchors(net, node).filter((a) => a.anchor.segmentId === avenue);
    // Boundaries 2 and 3 are the median's kerbs on avenue-4.
    const a = anchors.find((x) => x.anchor.boundary === 2)!;
    const b = anchors.find((x) => x.anchor.boundary === 3)!;
    r.click(a.pos.x, a.pos.z);
    r.click(b.pos.x, b.pos.z);
    expect(net.getNode(node)!.control.shape?.islands).toHaveLength(1);
    expect(islandPolygons(net, node)).toHaveLength(1);
    expect(tool.islandMode).toBe(false);
    expect(tool.selected).toBe(1);
    expect(r.key('Delete')).toBe(true);
    expect(net.getNode(node)!.control.shape).toBeUndefined();
  });

  it('refuses an island across a lane and says why', () => {
    const { net, node } = crossing();
    const r = rig(null, net);
    r.tools.setTool('junctionShape');
    r.click(0, 0);
    const tool = r.tools.junctionShape;
    tool.setIslandMode(true);
    const seg = net.getNode(node)!.segments[0];
    const anchors = nodeAnchors(net, node).filter((a) => a.anchor.segmentId === seg);
    r.click(anchors[0].pos.x, anchors[0].pos.z);
    r.click(anchors[1].pos.x, anchors[1].pos.z);
    expect(net.getNode(node)!.control.shape).toBeUndefined();
    expect(tool.problem).toMatch(/cover lane/);
  });

  it('resets everything at once', () => {
    const { net, node } = crossing();
    const r = rig(null, net);
    r.tools.setTool('junctionShape');
    r.click(0, 0);
    const tool = r.tools.junctionShape;
    const corner = cornerInfos(net, node)[0].key;
    expect(tool.setValue('radius', corner, 9)).toBe(true);
    expect(tool.setValue('trim', String(net.getNode(node)!.segments[1]), 3)).toBe(true);
    expect(net.getNode(node)!.control.shape).toBeDefined();
    tool.resetAll();
    expect(net.getNode(node)!.control.shape).toBeUndefined();
  });
});
