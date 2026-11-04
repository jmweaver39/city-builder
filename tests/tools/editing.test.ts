import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkNetworkInvariants,
  curveMidpoint,
  defaultSignalPlan,
  armFrames,
  lineCurve,
  nodeAnchors,
  outlineAnchors,
  resolveDecal,
  RoadNetwork,
  rotationFacing,
  type DecalKind,
  type NodeLineMarking,
  type Vec3,
} from '../../src/core';
import { History } from '../../src/app/History';
import { SaveStore, type KeyValueStore } from '../../src/app/storage';
import { buildStarterScene } from '../../src/app/starter';
import { activeLinks, laneDots, toggleLink } from '../../src/tools/LaneTool';
import { connectedRoad } from '../../src/tools/roadOps';
import { addPhase, cycleLength, cycleMove, movePhase, moveState, removePhase } from '../../src/tools/signalEdit';
import { layoutDiagram, moveAt } from '../../src/tools/junctionDiagram';
import { lateralStops } from '../../src/tools/roadAnchors';
import { fakeTemplates, rig, type Rig } from './helpers';

let r: Rig;
beforeEach(() => {
  r = rig();
});

function cross(rg: Rig = r, roadType = 'street-2'): number {
  const a = rg.net.drawRoad({ start: { kind: 'free', pos: { x: -100, y: 0, z: 0 } }, end: { kind: 'free', pos: { x: 100, y: 0, z: 0 } }, roadType });
  const b = rg.net.drawRoad({ start: { kind: 'free', pos: { x: 0, y: 0, z: -100 } }, end: { kind: 'free', pos: { x: 0, y: 0, z: 100 } }, roadType });
  expect(a.segments).toHaveLength(1);
  return b.junctions[0];
}

describe('Bulldoze', () => {
  beforeEach(() => r.tools.setTool('bulldoze'));

  it('hover previews the arm in red and a click deletes that arm, junction to dead end', () => {
    cross();
    r.hover(50, 0);
    expect(r.view.previews).toHaveLength(1);
    expect(r.view.previews[0].state).toBe('error');
    const before = r.net.segments.length;
    r.click(50, 0);
    expect(r.net.segments).toHaveLength(before - 1);
  });

  it('a drag along a road through a junction is one undo step', () => {
    cross();
    const sig = r.net.signature();
    r.history.clear();
    r.drag([[-50, 0], [0, 0], [50, 0]]);
    expect(r.net.segments.length).toBeGreaterThan(0);
    expect(r.history.size).toBe(1);
    r.history.undo();
    expect(r.net.signature()).toBe(sig);
  });

  it('a drag across a road, not along it, removes nothing', () => {
    r.net.drawRoad({ start: { kind: 'free', pos: { x: 0, y: 0, z: -50 } }, end: { kind: 'free', pos: { x: 0, y: 0, z: 50 } }, roadType: 'street-2' });
    r.drag([[-80, 0], [80, 0]]);
    expect(r.net.segments).toHaveLength(1);
    expect(r.net.curveOf(r.net.segments[0].id).length).toBeCloseTo(100, 6);
  });

  it('deletes endpoints and decals under it', () => {
    r.net.drawRoad({ start: { kind: 'free', pos: { x: 0, y: 0, z: 0 } }, end: { kind: 'free', pos: { x: 100, y: 0, z: 0 } }, roadType: 'street-2' });
    const ep = r.net.addEndpoint({ kind: 'gateway', nodeId: r.net.segments[0].a });
    r.net.addDecal({ kind: 'arrowLeft', points: [{ x: 50, y: 0, z: 0 }], color: 'white', width: 2, rotation: 0 });
    r.click(0, 0);
    expect(r.net.endpoints.find((e) => e.id === ep)).toBeUndefined();
    expect(r.net.segments).toHaveLength(1);
    r.click(50, 0);
    expect(r.net.decals).toHaveLength(0);
    expect(r.net.segments).toHaveLength(1);
  });
});

describe('Roads stacked at a grade separation', () => {
  function stack(): { low: number; high: number } {
    const low = r.net.drawRoad({ start: { kind: 'free', pos: { x: -100, y: 0, z: 0 } }, end: { kind: 'free', pos: { x: 100, y: 0, z: 0 } }, roadType: 'street-2' });
    const high = r.net.drawRoad({ start: { kind: 'free', pos: { x: 0, y: 12, z: -300 } }, end: { kind: 'free', pos: { x: 0, y: 12, z: 300 } }, roadType: 'street-2' });
    expect(high.junctions).toEqual([]);
    return { low: low.segments[0], high: high.segments[0] };
  }

  it('bulldoze takes the upper road first, then the one beneath it', () => {
    const { low, high } = stack();
    const level = (y: number) => r.net.segments.filter((s) => Math.abs(r.net.cubicOf(s.id).p0.y - y) < 1).reduce((t, s) => t + r.net.curveOf(s.id).length, 0);
    r.tools.setTool('bulldoze');
    r.click(1, 1);
    // A section of the 600 m bridge road goes; the road below is untouched.
    expect(level(12)).toBeCloseTo(540, 0);
    expect(r.net.getSegment(low)).toBeDefined();
    expect(r.net.curveOf(low).length).toBeCloseTo(200, 6);
    void high;
    r.click(1, 1);
    expect(level(0)).toBeCloseTo(140, 0);
  });

  it('paint lands on the bridge deck, not on the road below', () => {
    const { high } = stack();
    r.tools.setTool('paint');
    r.tools.settings.paint.kind = 'arrowStraight';
    r.tools.settingsChanged();
    r.click(1, 40);
    expect(resolveDecal(r.net, r.net.decals[0]).points[0].y).toBeCloseTo(12, 6);
    expect(r.net.getSegment(high)).toBeDefined();
  });
});

describe('Move', () => {
  beforeEach(() => r.tools.setTool('move'));

  it('drags a node in plan as one undo step', () => {
    r.net.drawRoad({ start: { kind: 'free', pos: { x: 0, y: 0, z: 0 } }, end: { kind: 'free', pos: { x: 100, y: 0, z: 0 } }, roadType: 'street-2' });
    const sig = r.net.signature();
    const id = r.net.segments[0].b;
    r.history.clear();
    r.drag([[100, 0], [110, 10], [130, 30]]);
    expect(r.net.getNode(id)!.pos).toMatchObject({ x: 130, z: 30 });
    expect(r.history.size).toBe(1);
    r.history.undo();
    expect(r.net.signature()).toBe(sig);
  });

  it('Shift-drag changes height, PageUp steps it', () => {
    r.net.drawRoad({ start: { kind: 'free', pos: { x: 0, y: 0, z: 0 } }, end: { kind: 'free', pos: { x: 200, y: 0, z: 0 } }, roadType: 'street-2' });
    const id = r.net.segments[0].b;
    r.drag([[200, 0], [200, -40]], { shift: true });
    const y = r.net.getNode(id)!.pos.y;
    expect(y).toBeGreaterThan(4);
    expect(r.net.getNode(id)!.pos.x).toBe(200);
    r.hover(200, 0);
    r.key('PageUp');
    expect(r.net.getNode(id)!.pos.y).toBeCloseTo(y + 4, 6);
  });

  it('drags a curve handle', () => {
    r.net.drawRoad({ start: { kind: 'free', pos: { x: 0, y: 0, z: 0 } }, end: { kind: 'free', pos: { x: 300, y: 0, z: 0 } }, roadType: 'street-2' });
    r.hover(150, 0); // Shows the handles.
    r.drag([[100, 0], [100, 60]]);
    expect(r.net.segments[0].c1).toMatchObject({ x: 100, z: 60 });
  });

  it('keeps a two-road joint smooth when bending, and Ctrl leaves it alone', () => {
    r.net.drawRoad({ start: { kind: 'free', pos: { x: 0, y: 0, z: 0 } }, end: { kind: 'free', pos: { x: 300, y: 0, z: 0 } }, roadType: 'street-2' });
    r.net.splitSegment(r.net.segments[0].id, 0.5);
    const [left, right] = r.net.segments;
    r.hover(75, 0);
    r.drag([[left.c2.x, left.c2.z], [100, 30]]);
    const l = r.net.getSegment(left.id)!;
    const n = r.net.getNode(l.b)!.pos;
    const rr = r.net.getSegment(right.id)!;
    const cross = (l.c2.x - n.x) * (rr.c1.z - n.z) - (l.c2.z - n.z) * (rr.c1.x - n.x);
    expect(Math.abs(cross)).toBeLessThan(1e-6);
  });

  it('warns when a moved road runs through another', () => {
    cross();
    const stray = r.net.drawRoad({ start: { kind: 'free', pos: { x: 300, y: 0, z: 40 } }, end: { kind: 'free', pos: { x: 300, y: 0, z: 200 } }, roadType: 'street-2' });
    expect(stray.segments).toHaveLength(1);
    r.drag([[300, 40], [50, -40]]);
    expect(r.toasts.at(-1)).toMatch(/without a junction/);
  });
});

describe('Select', () => {
  it('opens the right inspector', () => {
    const junction = cross();
    r.click(0, 0);
    expect(r.inspected.at(-1)).toEqual({ kind: 'junction', id: junction });
    r.click(50, 0);
    expect(r.inspected.at(-1)).toMatchObject({ kind: 'segment' });
    r.view.vehicleAt = 7;
    r.click(50, 0);
    expect(r.inspected.at(-1)).toEqual({ kind: 'vehicle', id: 7 });
    r.view.vehicleAt = null;
    r.click(500, 500);
    expect(r.inspected.at(-1)).toBeNull();
  });
});

describe('Lane connector', () => {
  it('links and unlinks, stores laneLinks, and resets to auto', () => {
    const junction = cross();
    r.tools.setTool('lanes');
    r.click(0, 0);
    expect(r.tools.lanes.node).toBe(junction);
    const dots = laneDots(r.net, junction);
    expect(dots.filter((d) => d.side === 'in')).toHaveLength(4);
    expect(dots.filter((d) => d.side === 'out')).toHaveLength(4);
    const auto = activeLinks(r.net, junction);
    expect(r.net.getNode(junction)!.control.laneLinks).toBeNull();

    const from = dots.find((d) => d.side === 'in')!;
    r.click(from.pos.x, from.pos.z);
    expect(r.tools.lanes.selectedLane).toBe(from.ref);
    const target = auto.find((l) => l.from === from.ref)!;
    const to = dots.find((d) => d.side === 'out' && d.ref === target.to)!;
    r.click(to.pos.x, to.pos.z);
    const after = r.net.getNode(junction)!.control.laneLinks!;
    expect(after).toHaveLength(auto.length - 1);
    expect(after.some((l) => l.from === from.ref && l.to === target.to)).toBe(false);
    expect(activeLinks(r.net, junction)).toHaveLength(auto.length - 1);

    r.click(to.pos.x, to.pos.z);
    expect(r.net.getNode(junction)!.control.laneLinks!).toHaveLength(auto.length);

    r.tools.lanes.resetToAuto();
    expect(r.net.getNode(junction)!.control.laneLinks).toBeNull();
    expect(checkNetworkInvariants(r.net)).toEqual([]);
  });

  it('toggleLink adds a link that was not active', () => {
    const junction = cross();
    const link = r.net.connectionsAt(junction).find((c) => c.active)!;
    toggleLink(r.net, junction, link.from, link.to);
    const same = () => r.net.connectionsAt(junction).find((c) => c.from === link.from && c.to === link.to)?.active;
    expect(same()).toBe(false);
    toggleLink(r.net, junction, link.from, link.to);
    expect(same()).toBe(true);
  });
});

describe('Paint', () => {
  /** A curve between two junctions, plus a second road at a tangent. */
  beforeEach(() => {
    r.tools.setTool('paint');
    r.net.drawRoad({ start: { kind: 'free', pos: { x: 0, y: 0, z: 0 } }, end: { kind: 'free', pos: { x: 200, y: 0, z: 0 } }, roadType: 'avenue-4' });
  });
  const setKind = (kind: DecalKind) => {
    r.tools.settings.paint.kind = kind;
    r.tools.settingsChanged();
  };

  it('a line is two clicks on the road and stores no world points', () => {
    r.tools.settings.paint.lineStyle = 'dashed';
    r.click(20, 6.6);
    expect(r.net.decals).toHaveLength(0);
    r.hover(150, 6.6);
    expect(r.view.marks.some((m) => m.kind === 'line')).toBe(true);
    r.click(150, 6.6);
    const d = r.net.decals[0];
    expect(d.points).toEqual([]);
    // The look is stored in the shared marking vocabulary (core/paintStandard.ts).
    expect(d.style?.style).toBe('dashed');
    expect(d.road!.pieces).toHaveLength(1);
    const pts = resolveDecal(r.net, d).points;
    expect(pts[0].x).toBeCloseTo(20, 0);
    expect(pts[pts.length - 1].x).toBeCloseTo(150, 0);
    for (const p of pts) expect(p.z).toBeCloseTo(6.75, 5);
  });

  it('snaps to edges and lane boundaries as well as centres', () => {
    const stops = lateralStops(r.net, r.net.segments[0].id);
    expect(stops.filter((s) => s.kind === 'edge').map((s) => s.offset)).toEqual([-8.5, 8.5]);
    expect(stops.filter((s) => s.kind === 'centre')).toHaveLength(4);
    // The boundary between two lanes is where the road paints its lane line: a 'line' stop.
    expect(stops.some((s) => (s.kind === 'boundary' || s.kind === 'line') && s.offset === 5)).toBe(true);
    // Near the kerb the road paints an edge line 0.18 m in: a line drawn there lands on it.
    r.click(50, 8.3);
    r.click(120, 0);
    expect(resolveDecal(r.net, r.net.decals[0]).points[0].z).toBeCloseTo(8.32, 5);
  });

  it('clicking near the end of the road reaches its edge exactly', () => {
    r.click(4, 3.2);
    r.click(197, 3.2);
    const d = r.net.decals[0];
    expect(d.road!.pieces[0]).toMatchObject({ t0: 0, t1: 1 });
  });

  it('the second click takes its place along the road, keeping the first offset', () => {
    r.click(30, 3.2);
    r.click(100, -8);
    const pts = resolveDecal(r.net, r.net.decals[0]).points;
    for (const p of pts) expect(p.z).toBeCloseTo(3.25, 5);
  });

  it('runs through a plain joint', () => {
    const seg = r.net.segments[0].id;
    r.net.splitSegment(seg, 0.5);
    r.click(30, 3.2);
    r.click(170, 3.2);
    expect(r.net.decals[0].road!.pieces).toHaveLength(2);
    const pts = resolveDecal(r.net, r.net.decals[0]).points;
    for (const p of pts) expect(p.z).toBeCloseTo(3.25, 5);
  });

  it('refuses an end on another road, and paint off the road altogether', () => {
    r.net.drawRoad({ start: { kind: 'free', pos: { x: 0, y: 0, z: 200 } }, end: { kind: 'free', pos: { x: 200, y: 0, z: 200 } }, roadType: 'street-2' });
    r.click(0 + 30, 3.2);
    r.click(100, 200);
    expect(r.net.decals).toHaveLength(0);
    expect(r.toasts.at(-1)).toMatch(/not further along/);
    r.rightClick();
    r.click(100, 80);
    expect(r.net.decals).toHaveLength(0);
    expect(r.toasts.at(-1)).toMatch(/on a road/);
  });

  it('Ctrl does not turn snapping off', () => {
    r.click(30, 2.2, { ctrl: true });
    r.click(120, 2.2, { ctrl: true });
    // It lands on the line the road paints beside the median (1.5 m lane edge, 0.16 m in), so the two meet.
    expect(r.net.decals[0].road!.offset).toBeCloseTo(1.66, 5);
  });

  it('right click drops the start', () => {
    r.click(30, 3.2);
    expect(r.tools.paint.startPoint).not.toBeNull();
    r.rightClick();
    expect(r.tools.paint.startPoint).toBeNull();
  });

  it('an area takes its two sides from the two clicks, on the road', () => {
    setKind('hatch');
    r.click(40, 0.2);
    r.click(120, 6.8);
    const d = r.net.decals[0];
    expect(d.road).toMatchObject({ offset2: 6.75 });
    const pts = resolveDecal(r.net, d).points;
    expect(Math.min(...pts.map((p) => p.z))).toBeCloseTo(d.road!.offset, 5);
    expect(Math.max(...pts.map((p) => p.z))).toBeCloseTo(6.75, 5);
  });

  it('refuses an area with no width', () => {
    setKind('fill');
    r.click(40, 3.2);
    r.click(120, 3.2);
    expect(r.net.decals).toHaveLength(0);
    expect(r.toasts.at(-1)).toMatch(/far side/);
  });

  it('stamps sit on lane centres and take their direction from the lane', () => {
    setKind('arrowStraight');
    r.click(100, 6);
    const forward = resolveDecal(r.net, r.net.decals[0]);
    expect(forward.points[0].z).toBeCloseTo(6.75, 5);
    expect(forward.rotation).toBeCloseTo(rotationFacing({ x: 1, y: 0, z: 0 }), 5);
    r.click(100, -6);
    const backward = resolveDecal(r.net, r.net.decals[1]);
    expect(backward.rotation).toBeCloseTo(rotationFacing({ x: -1, y: 0, z: 0 }), 5);
  });

  it('a crosswalk spans the road, and a stop line its lane', () => {
    setKind('crosswalk');
    r.click(100, 6);
    const walk = resolveDecal(r.net, r.net.decals[0]);
    expect(Math.abs(walk.points[0].z - walk.points[1].z)).toBeCloseTo(17, 5);
    setKind('stopLine');
    r.click(120, 6);
    const stop = resolveDecal(r.net, r.net.decals[1]);
    expect(Math.abs(stop.points[0].z - stop.points[1].z)).toBeCloseTo(3.5, 5);
  });

  it('text uses the input and refuses an empty one', () => {
    r.tools.settings.paint.text = '';
    setKind('text');
    r.click(100, 6);
    expect(r.net.decals).toHaveLength(0);
    r.tools.settings.paint.text = 'BUS';
    r.click(100, 6);
    expect(r.net.decals[0].text).toBe('BUS');
  });

  it('paint moves with the road, and bulldoze can still find it', () => {
    r.click(30, 3.2);
    r.click(170, 3.2);
    r.net.moveNode(r.net.segments[0].b, { x: 200, y: 0, z: 60 });
    const pts = resolveDecal(r.net, r.net.decals[0]).points;
    expect(pts[pts.length - 1].z).toBeGreaterThan(30);
    r.tools.setTool('bulldoze');
    r.click(pts[10].x, pts[10].z);
    expect(r.net.decals).toHaveLength(0);
    expect(r.net.segments).toHaveLength(1);
  });

  it('undo removes a line and goes back to an identical signature', () => {
    const sig = r.net.signature();
    r.click(30, 3.2);
    r.click(170, 3.2);
    r.history.undo();
    expect(r.net.signature()).toBe(sig);
  });
});

describe('Node markings tool', () => {
  beforeEach(() => r.tools.setTool('nodeMarkings'));

  const dot = (i: number) => nodeAnchors(r.net, r.tools.nodeMarkings.node!)[i];
  const clickDot = (i: number) => r.click(dot(i).pos.x, dot(i).pos.z);

  it('enters a junction, or any node, and shows anchors only once you go to draw', () => {
    const j = cross();
    r.click(0, 0);
    expect(r.tools.nodeMarkings.node).toBe(j);
    expect(r.inspected.at(-1)).toEqual({ kind: 'nodeMarkings', id: j });
    const points = () => r.view.marks.filter((m) => m.kind === 'point').length;
    // Away from every arm: markings outlined, no anchors.
    r.hover(40, 40);
    expect(points()).toBe(0);
    // Near an arm, that arm's anchors.
    const a = nodeAnchors(r.net, j)[1];
    r.hover(a.pos.x, a.pos.z);
    expect(points()).toBeGreaterThan(0);
    // Drawing: every anchor.
    r.click(a.pos.x, a.pos.z);
    r.hover(40, 40);
    expect(points()).toBe(nodeAnchors(r.net, j).length + outlineAnchors(r.net, j).length);
  });

  it('also enters a plain joint', () => {
    const seg = r.net.drawRoad({ start: { kind: 'free', pos: { x: 0, y: 0, z: 0 } }, end: { kind: 'free', pos: { x: 200, y: 0, z: 0 } }, roadType: 'street-2' }).segments[0];
    const { node } = r.net.splitSegment(seg, 0.5);
    r.click(100, 0);
    expect(r.tools.nodeMarkings.node).toBe(node);
  });

  it('two anchors make a curve between arms, previewed first', () => {
    const j = cross();
    r.click(0, 0);
    clickDot(1);
    const q = dot(7);
    r.hover(q.pos.x, q.pos.z);
    expect(r.view.marks.some((m) => m.kind === 'line')).toBe(true);
    r.click(q.pos.x, q.pos.z);
    const m = r.net.getNode(j)!.control.markings![0];
    expect(m).toMatchObject({ kind: 'line', style: 'dashed', straight: false });
    expect(r.tools.nodeMarkings.selected).toBe(m.id);
  });

  it('two anchors on one arm draw straight across it', () => {
    const j = cross();
    r.click(0, 0);
    clickDot(0);
    clickDot(2);
    expect(r.net.getNode(j)!.control.markings![0]).toMatchObject({ straight: true });
  });

  it('a crosswalk style is always straight, and Follow lanes off draws straight', () => {
    const j = cross();
    r.tools.settings.nodeMarking.style = 'crosswalkZebra';
    r.click(0, 0);
    clickDot(1);
    clickDot(7);
    expect(r.net.getNode(j)!.control.markings![0]).toMatchObject({ straight: true, style: 'crosswalkZebra' });
    r.tools.settings.nodeMarking.style = 'dashed';
    r.tools.settings.nodeMarking.curved = false;
    clickDot(2);
    clickDot(8);
    expect(r.net.getNode(j)!.control.markings![1]).toMatchObject({ straight: true });
  });

  it('two anchors on one corner draw a line along the kerb', () => {
    const j = cross();
    r.click(0, 0);
    const corner = outlineAnchors(r.net, j).filter((a) => a.anchor.segmentId === outlineAnchors(r.net, j)[0].anchor.segmentId);
    const p = corner[0].pos;
    const q = corner[corner.length - 1].pos;
    r.click(p.x, p.z);
    r.click(q.x, q.z);
    expect(r.net.getNode(j)!.control.markings![0]).toMatchObject({ path: 'outline' });
  });

  it('with Follow lane paths, a line between arms follows the lanes', () => {
    const j = cross();
    r.tools.settings.nodeMarking.followLanes = true;
    r.click(0, 0);
    clickDot(1);
    clickDot(7);
    expect(r.net.getNode(j)!.control.markings![0]).toMatchObject({ path: 'lanes' });
  });

  it('hovering back along an arm offers a row, caught at the stop line distance', () => {
    const j = cross();
    r.tools.settings.nodeMarking.style = 'stopLine';
    r.click(0, 0);
    const frame = armFrames(r.net, j)[0];
    const at = (lateral: number, back: number) => ({
      x: frame.pos.x + frame.right.x * lateral - frame.inward.x * back,
      z: frame.pos.z + frame.right.z * lateral - frame.inward.z * back,
    });
    const a = at(frame.offsets[0], 4.5);
    const b = at(frame.offsets[2], 4.5);
    r.click(a.x, a.z);
    r.click(b.x, b.z);
    const m = r.net.getNode(j)!.control.markings![0] as NodeLineMarking;
    expect(m.from.back).toBeCloseTo(0.5 + 3 + 0.9 + 0.225, 6);
    expect(m.from.boundary).toBe(0);
    expect(m.to.boundary).toBe(2);
  });

  it('has no way to bend a marking by hand', () => {
    const j = cross();
    r.click(0, 0);
    clickDot(1);
    clickDot(7);
    const before = r.net.signature();
    const mid = lineCurve(r.net, j, r.net.getNode(j)!.control.markings![0] as NodeLineMarking)!;
    r.drag([[mid.p1.x, mid.p1.z], [mid.p1.x + 5, mid.p1.z + 5]]);
    expect(r.net.signature()).toBe(before);
  });

  it('a filler closes on the first anchor or Enter, and needs three', () => {
    const j = cross();
    r.tools.settings.nodeMarking.mode = 'filler';
    r.tools.settingsChanged();
    r.click(0, 0);
    clickDot(0);
    clickDot(5);
    expect(r.key('Enter')).toBe(false);
    clickDot(10);
    expect(r.tools.nodeMarkings.pendingCorners).toBe(3);
    clickDot(0);
    expect(r.net.getNode(j)!.control.markings![0]).toMatchObject({ kind: 'filler', fill: 'hatch' });
    const first = r.net.getNode(j)!.control.markings![0].id;
    clickDot(1);
    clickDot(6);
    clickDot(11);
    expect(r.key('Enter')).toBe(true);
    // Areas never overlap: the new one replaces the one it lies over.
    const list = r.net.getNode(j)!.control.markings!;
    expect(list).toHaveLength(1);
    expect(list[0].id).not.toBe(first);
  });

  it('selects by clicking a marking, edits, deletes with the key, undoes', () => {
    const j = cross();
    r.click(0, 0);
    clickDot(1);
    clickDot(7);
    const id = r.tools.nodeMarkings.selected!;
    const m = r.net.getNode(j)!.control.markings![0] as NodeLineMarking;
    r.tools.nodeMarkings.select(null);
    const mid = curveMidpoint(lineCurve(r.net, j, m)!);
    r.click(mid.x, mid.z);
    expect(r.tools.nodeMarkings.selected).toBe(id);
    r.tools.nodeMarkings.update({ color: 'yellow' }, 'color');
    expect(r.net.getNode(j)!.control.markings![0].color).toBe('yellow');
    expect(r.key('Delete')).toBe(true);
    expect(r.net.getNode(j)!.control.markings).toBeUndefined();
    r.history.undo();
    expect(r.net.getNode(j)!.control.markings).toHaveLength(1);
  });

  it('clears all, hides automatic markings, and steps back with right clicks', () => {
    const j = cross();
    r.click(0, 0);
    clickDot(1);
    clickDot(7);
    r.tools.nodeMarkings.setHideAuto(true);
    expect(r.net.getNode(j)!.control.hideAutoMarkings).toBe(true);
    r.tools.nodeMarkings.clearAll();
    expect(r.net.getNode(j)!.control.markings).toBeUndefined();
    clickDot(0);
    r.rightClick();
    expect(r.tools.nodeMarkings.pendingFirst).toBeNull();
    r.rightClick();
    expect(r.tools.nodeMarkings.node).toBeNull();
  });

  it('copes with the node going away under undo', () => {
    r.history.clear();
    cross();
    r.click(0, 0);
    while (r.history.undo());
    expect(r.tools.nodeMarkings.node).toBeNull();
  });
});

describe('Reverse tool', () => {
  beforeEach(() => {
    r.tools.setTool('reverse');
  });
  const oneway = (x0: number, x1: number) =>
    r.net.drawRoad({ start: { kind: 'free', pos: { x: x0, y: 0, z: 0 } }, end: { kind: 'free', pos: { x: x1, y: 0, z: 0 } }, roadType: 'street-2-oneway' });

  it('shows the new direction on hover and flips on a click, keeping the id', () => {
    const id = oneway(0, 100).segments[0];
    const a = r.net.getSegment(id)!.a;
    r.hover(50, 0);
    expect(r.view.previews[0].curves[0].p0.x).toBeCloseTo(100, 6);
    r.click(50, 0);
    expect(r.net.getSegment(id)!.b).toBe(a);
  });

  it('a drag flips several as one undo step', () => {
    const s = oneway(0, 300).segments[0];
    const { right } = r.net.splitSegment(s, 0.5);
    const sig = r.net.signature();
    r.history.clear();
    r.drag([[50, 0], [150, 0], [250, 0]]);
    expect(r.history.size).toBe(1);
    expect(r.net.getSegment(s)!.a).not.toBe(sig);
    expect(r.net.getSegment(right!)!.b).toBeDefined();
    r.history.undo();
    expect(r.net.signature()).toBe(sig);
  });

  it('whole road follows connected roads of the same type', () => {
    const s = oneway(0, 300).segments[0];
    r.net.splitSegment(s, 0.5);
    r.tools.settings.reverseWholeRoad = true;
    const before = r.net.segments.map((x) => x.a);
    r.click(50, 0);
    expect(r.net.segments.map((x) => x.b)).toEqual(before);
    expect(r.history.size).toBeGreaterThan(0);
  });

  it('says when a road looks the same', () => {
    r.net.drawRoad({ start: { kind: 'free', pos: { x: 0, y: 0, z: 0 } }, end: { kind: 'free', pos: { x: 100, y: 0, z: 0 } }, roadType: 'street-2' });
    r.click(50, 0);
    expect(r.toasts.at(-1)).toMatch(/looks the same/);
  });

  it('warns with a toast and a mark when lanes are stranded, without blocking', () => {
    const a = oneway(0, 100);
    const b = r.net.drawRoad({ start: { kind: 'node', id: a.nodes[1] }, end: { kind: 'free', pos: { x: 200, y: 0, z: 0 } }, roadType: 'street-2-oneway' });
    const c = r.net.drawRoad({ start: { kind: 'node', id: b.nodes[1] }, end: { kind: 'free', pos: { x: 300, y: 0, z: 0 } }, roadType: 'street-2-oneway' });
    r.click(150, 0);
    expect(r.toasts.at(-1)).toMatch(/no way out/);
    expect(r.view.marks.filter((m) => m.kind === 'ring')).toHaveLength(2);
    expect(c.segments).toHaveLength(1);
  });
});

describe('Traffic', () => {
  beforeEach(() => {
    r.tools.setTool('traffic');
    r.net.drawRoad({ start: { kind: 'free', pos: { x: 0, y: 0, z: 0 } }, end: { kind: 'free', pos: { x: 200, y: 0, z: 0 } }, roadType: 'street-2' });
  });

  it('places a gateway on a dead end and opens it', () => {
    r.tools.settings.trafficKind = 'gateway';
    r.click(4, 4);
    expect(r.net.endpoints).toHaveLength(1);
    expect(r.net.endpoints[0]).toMatchObject({ kind: 'gateway', nodeId: r.net.segments[0].a });
    expect(r.inspected.at(-1)).toMatchObject({ kind: 'endpoint' });
  });

  it('refuses a gateway away from a dead end', () => {
    r.tools.settings.trafficKind = 'gateway';
    r.click(100, 0);
    expect(r.net.endpoints).toHaveLength(0);
    expect(r.toasts.at(-1)).toMatch(/dead ends/);
  });

  it('places a zone on the side the cursor is on', () => {
    r.tools.settings.trafficKind = 'commercial';
    r.tools.settingsChanged();
    r.click(100, 12);
    expect(r.net.endpoints[0]).toMatchObject({ kind: 'commercial', side: 1, segmentId: r.net.segments[0].id });
    expect(r.net.endpoints[0].t).toBeCloseTo(0.5, 3);
    r.click(100, -12);
    expect(r.net.endpoints[1].side).toBe(-1);
  });

  it('clicking an existing endpoint opens it instead of adding another', () => {
    r.tools.settings.trafficKind = 'gateway';
    r.click(0, 0);
    r.click(0, 0);
    expect(r.net.endpoints).toHaveLength(1);
  });
});

describe('Template', () => {
  it('ghosts, rotates, changes height and stamps with one undo step', () => {
    const t = rig(fakeTemplates);
    t.tools.settings.template.id = 'bar';
    t.tools.setTool('template');
    t.hover(100, 100);
    expect(t.view.previews).toHaveLength(1);
    t.key(']');
    expect(t.tools.settings.template.rotation).toBeCloseTo(Math.PI / 12, 6);
    t.tools.settings.template.rotation = 0;
    t.key('PageUp');
    t.key('PageUp');
    expect(t.tools.settings.template.elevation).toBe(8);
    t.hover(100, 100);
    expect(t.view.previews[0].curves[0].p0.y).toBe(8);
    t.history.clear();
    t.click(100, 100);
    expect(t.net.segments).toHaveLength(1);
    expect(t.net.cubicOf(t.net.segments[0].id).p0.y).toBe(8);
    expect(t.history.size).toBe(1);
  });

  it('reports a failed stamp', () => {
    const bad = { ...fakeTemplates, stampTemplate: () => { throw new Error('nope'); } };
    const t = rig(bad);
    t.tools.settings.template.id = 'bar';
    t.tools.setTool('template');
    t.click(0, 0);
    expect(t.toasts.at(-1)).toMatch(/nope/);
  });

  it('shows why a template cannot go here, and reports a refused stamp', () => {
    const refused = {
      ...fakeTemplates,
      placementProblems: () => ['Leaves the map.'],
      stampTemplate: () => ({ segments: [], problems: ['Leaves the map.'] }),
    };
    const t = rig(refused);
    t.tools.settings.template.id = 'bar';
    t.tools.setTool('template');
    t.hover(0, 0);
    expect(t.view.previews[0].state).toBe('error');
    expect(t.tools.hud?.notes).toEqual(['Leaves the map.']);
    t.click(0, 0);
    expect(t.toasts.at(-1)).toMatch(/Leaves the map/);
    expect(t.history.size).toBe(0);
  });

  it('copes with no templates', () => {
    r.tools.setTool('template');
    r.click(0, 0);
    expect(r.tools.hud?.tone).toBe('warning');
  });
});

describe('roadOps', () => {
  it('reverseSegment keeps overrides, zones, signs and the invariants', () => {
    const j = cross(r);
    const seg = r.net.getNode(j)!.segments[0];
    r.net.setSegmentOverrides(seg, { name: 'Oak' });
    r.net.setSign(j, seg, 'stop');
    r.net.addEndpoint({ kind: 'office', segmentId: seg, t: 0.25, side: 1 });
    r.net.reverseSegment(seg);
    expect(r.net.getSegment(seg)!.overrides.name).toBe('Oak');
    expect(r.net.getNode(j)!.control.signs[seg]).toBe('stop');
    expect(r.net.endpoints[0]).toMatchObject({ segmentId: seg, t: 0.75, side: -1 });
    expect(checkNetworkInvariants(r.net)).toEqual([]);
  });

  it('connectedRoad follows joints and goes straight on through junctions', () => {
    const j = cross(r);
    const ids = r.net.getNode(j)!.segments;
    const geom = r.net.nodeGeom(j)!;
    const east = geom.arms.find((a) => a.dir.x > 0.9)!.segmentId;
    const west = geom.arms.find((a) => a.dir.x < -0.9)!.segmentId;
    expect(ids).toHaveLength(4);
    expect(connectedRoad(r.net, east).sort()).toEqual([east, west].sort());
  });

  it('connectedRoad stops at a change of road type', () => {
    const a = r.net.drawRoad({ start: { kind: 'free', pos: { x: 0, y: 0, z: 0 } }, end: { kind: 'free', pos: { x: 100, y: 0, z: 0 } }, roadType: 'street-2' });
    r.net.drawRoad({ start: { kind: 'node', id: a.nodes[1] }, end: { kind: 'free', pos: { x: 200, y: 0, z: 0 } }, roadType: 'avenue-4' });
    expect(connectedRoad(r.net, a.segments[0])).toEqual(a.segments);
  });
});

describe('Signal editing', () => {
  it('edits phases purely', () => {
    const j = cross(r);
    const plan = defaultSignalPlan(r.net, j, 'opposing');
    const key = Object.keys(plan.phases[0].moves)[0];
    const start = moveState(plan.phases[0], key);
    let p = cycleMove(plan, 0, key);
    p = cycleMove(p, 0, key);
    p = cycleMove(p, 0, key);
    expect(moveState(p.phases[0], key)).toBe(start);
    expect(moveState(plan.phases[0], key)).toBe(start);
    const added = addPhase(plan);
    expect(added.phases).toHaveLength(plan.phases.length + 1);
    expect(new Set(added.phases.map((x) => x.id)).size).toBe(added.phases.length);
    const swapped = movePhase(added, added.phases.length - 1, -1);
    expect(swapped.phases[added.phases.length - 2].id).toBe(added.phases.at(-1)!.id);
    expect(movePhase(plan, 0, -1)).toBe(plan);
    expect(removePhase(added, 0).phases).toHaveLength(plan.phases.length);
    expect(removePhase({ ...plan, phases: [plan.phases[0]] }, 0).phases).toHaveLength(1);
    expect(cycleLength(plan)).toBeGreaterThan(0);
  });

  it('the diagram has one arm per road, one arrow per movement, and arrows click', () => {
    const j = cross(r);
    const d = layoutDiagram(r.net, j, 240)!;
    expect(d.arms).toHaveLength(4);
    expect(d.moves.length).toBe(12);
    const m = d.moves[3];
    const mid = m.points[7];
    expect(moveAt(d, mid.x, mid.y)).not.toBeNull();
    expect(moveAt(d, 2, 2)).toBeNull();
    // Every point stays on the canvas.
    for (const move of d.moves) for (const p of move.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(240);
    }
  });

  it('keeps traffic on the right in the diagram', () => {
    const j = cross(r);
    const d = layoutDiagram(r.net, j, 240)!;
    // A road arriving from the west (world -x) travels +x, so its right is +z (canvas down).
    const west = d.arms.find((a) => a.dir.x < -0.9)!;
    const east = d.arms.find((a) => a.dir.x > 0.9)!;
    const through = d.moves.find((m) => m.fromSegment === west.segmentId && m.toSegment === east.segmentId)!;
    expect(through.points[0].y).toBeGreaterThan(120);
    expect(through.points.at(-1)!.y).toBeGreaterThan(120);
  });
});

describe('History', () => {
  it('undo and redo restore identical signatures through a mixed session', () => {
    r.tools.setTool('road');
    const sigs = [r.net.signature()];
    r.click(0, 0);
    r.click(100, 0);
    sigs.push(r.net.signature());
    r.click(200, 40);
    sigs.push(r.net.signature());
    r.tools.setTool('bulldoze');
    r.click(50, 0);
    sigs.push(r.net.signature());
    r.tools.setTool('paint');
    r.click(130, 12);
    r.click(170, 28);
    sigs.push(r.net.signature());
    r.tools.setTool('move');
    r.drag([[200, 40], [220, 60]]);
    sigs.push(r.net.signature());

    for (let i = sigs.length - 2; i >= 0; i--) {
      expect(r.history.undo()).toBe(true);
      expect(r.net.signature()).toBe(sigs[i]);
      expect(checkNetworkInvariants(r.net)).toEqual([]);
    }
    expect(r.history.undo()).toBe(false);
    for (let i = 1; i < sigs.length; i++) {
      expect(r.history.redo()).toBe(true);
      expect(r.net.signature()).toBe(sigs[i]);
    }
    expect(r.history.redo()).toBe(false);
  });

  it('a new edit clears redo', () => {
    r.net.addNode({ x: 0, y: 0, z: 0 });
    r.history.undo();
    expect(r.history.canRedo).toBe(true);
    r.net.addNode({ x: 5, y: 0, z: 0 });
    expect(r.history.canRedo).toBe(false);
  });

  it('caps at 100 levels', () => {
    for (let i = 0; i < 130; i++) r.net.addNode({ x: i, y: 0, z: 0 });
    expect(r.history.size).toBe(100);
    while (r.history.undo());
    expect(r.net.nodes).toHaveLength(30);
  });

  it('merges edits with the same key that come quickly', () => {
    let t = 0;
    const net = new RoadNetwork();
    const h = new History(net, 100, () => t);
    for (let i = 0; i < 5; i++) {
      h.hint('Speed', 'speed');
      net.setTraffic({ multiplier: i });
      t += 100;
    }
    expect(h.size).toBe(1);
    t += 5000;
    h.hint('Speed', 'speed');
    net.setTraffic({ multiplier: 9 });
    expect(h.size).toBe(2);
    h.undo();
    expect(net.traffic.multiplier).toBe(4);
    h.undo();
    expect(net.traffic.multiplier).toBe(1);
  });

  it('abort rolls a drag back with no step', () => {
    const sig = r.net.signature();
    const steps = r.history.size;
    r.history.begin('x');
    r.net.addNode({ x: 1, y: 0, z: 1 });
    r.history.abort();
    expect(r.net.signature()).toBe(sig);
    expect(r.history.size).toBe(steps);
  });

  it('a drag with no effect leaves no step', () => {
    r.history.begin('x');
    r.history.end();
    expect(r.history.size).toBe(0);
  });

  it('falls back when undo removes the selected custom road type', () => {
    r.tools.setTool('road');
    r.net.setCustomRoadType({ ...r.net.roadType('street-2')!, id: 'custom-x', name: 'X', category: 'custom' });
    r.tools.settings.roadType = 'custom-x';
    r.click(0, 0);
    r.hover(100, 0);
    r.history.undo();
    expect(() => r.hover(50, 0)).not.toThrow();
    expect(r.tools.settings.roadType).toBe('street-2');
    r.click(0, 0);
    r.click(100, 0);
    expect(r.net.segments[0].roadType).toBe('street-2');
  });

  it('tools drop stale state when undo removes what they held', () => {
    r.tools.setTool('road');
    r.click(0, 0);
    r.click(100, 0);
    r.history.undo();
    expect(r.tools.road.stage).toBe('start');
    r.click(0, 50);
    r.click(100, 50);
    expect(r.net.segments).toHaveLength(1);
  });
});

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('Saving', () => {
  it('round trips a project through a slot with the same signature', () => {
    cross();
    r.net.addDecal({ kind: 'line', points: [{ x: 1, y: 0, z: 1 } as Vec3, { x: 2, y: 0, z: 2 }], color: 'red', width: 1, rotation: 0 });
    const sig = r.net.signature();
    const saves = new SaveStore(memoryStore());
    const camera = { target: { x: 1, y: 0, z: 2 }, distance: 300, yaw: 1, pitch: 0.6 };
    expect(saves.saveSlot(2, r.net, camera, 123)).toBe(true);
    expect(saves.slots()).toEqual([{ slot: 2, name: 'Untitled', savedAt: 123 }]);
    const net = new RoadNetwork();
    const rec = saves.loadSlot(2)!;
    net.load(rec.project);
    expect(net.signature()).toBe(sig);
    expect(rec.camera).toEqual(camera);
    saves.deleteSlot(2);
    expect(saves.slots()).toEqual([]);
    expect(saves.loadSlot(2)).toBeNull();
  });

  it('autosave round trips, and bad data is ignored', () => {
    cross();
    const store = memoryStore();
    const saves = new SaveStore(store);
    saves.autosave(r.net, null);
    const net = new RoadNetwork();
    net.load(saves.loadAutosave()!.project);
    expect(net.signature()).toBe(r.net.signature());
    store.data.set('cloverleaf.autosave', '{nonsense');
    expect(saves.loadAutosave()).toBeNull();
  });

  it('survives a storage that throws', () => {
    const saves = new SaveStore({
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('full'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(saves.autosave(r.net, null)).toBe(false);
    expect(saves.loadAutosave()).toBeNull();
    expect(saves.seenHints).toBe(false);
  });
});

describe('Starter scene', () => {
  const net = new RoadNetwork();
  buildStarterScene(net);

  it('builds a clean network', () => {
    expect(checkNetworkInvariants(net)).toEqual([]);
    expect(net.segments.length).toBeGreaterThan(12);
    expect(net.endpoints.filter((e) => e.kind === 'gateway')).toHaveLength(4);
    expect(net.segments.every((s) => net.segmentGeom(s.id)!.valid)).toBe(true);
  });

  it('has a highway, ramps, and streets all connected', () => {
    const types = new Set(net.segments.map((s) => s.roadType));
    expect(types).toEqual(new Set(['highway-3', 'ramp-1', 'street-2', 'avenue-4']));
    const graph = net.laneGraph;
    // From the highway's west gateway, traffic can reach the east gateway and the grid.
    const west = net.endpoints.find((e) => e.name === 'Highway west')!;
    const start = graph.roadLanes.get(net.getNode(west.nodeId!)!.segments[0])!.filter((i) => i >= 0);
    const seen = new Set<number>(start);
    const stack = [...start];
    while (stack.length) {
      const lane = graph.lanes[stack.pop()!];
      for (const n of [...lane.next, ...(lane.left >= 0 ? [lane.left] : []), ...(lane.right >= 0 ? [lane.right] : [])]) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    const reachedSegs = new Set([...seen].map((i) => graph.lanes[i].segmentId));
    const east = net.endpoints.find((e) => e.name === 'Highway east')!;
    expect(reachedSegs.has(net.getNode(east.nodeId!)!.segments[0])).toBe(true);
    const shops = net.endpoints.find((e) => e.name === 'Main Street shops')!;
    expect(reachedSegs.has(shops.segmentId!)).toBe(true);
  });

  it('every ramp would pass validation as drawn', () => {
    for (const s of net.segments.filter((x) => x.roadType === 'ramp-1')) {
      const geom = net.segmentGeom(s.id)!;
      expect(geom.minRadius).toBeGreaterThan(30);
    }
  });
});
