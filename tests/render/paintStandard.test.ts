/**
 * One marking standard: automatic and hand-placed paint are the same geometry and
 * material, dash in one phase, never double-paint, stack in one order; old saves
 * move to the standard without moving; one marking per place; simple removal; and
 * all of it on highways and ramp junctions too.
 */
import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core/RoadNetwork';
import { makeAttach } from '../../src/core/ramps';
import type { Decal, Id, RampAttach, Vec3 } from '../../src/core/types';
import { DASH, EXIT_ONLY, FAST_W, GORE, LINE_STANDARDS, LINE_W, PAINT_HEX, dashFor, lineStandard, matchStandard, standardWidth } from '../../src/core/paintStandard';
import { autoLinesOf, cleanStacked, stackedWith, userRoadLines } from '../../src/core/paintCoherence';
import { migrateMarkingLooks } from '../../src/core/markingMigrate';
import { markingPath } from '../../src/core/nodeMarkings';
import { resolveDecal } from '../../src/core/roadPaint';
import { PaintBuf } from '../../src/render/batch';
import { armEndLayout, buildSegmentPaint, laneEndLines, segmentDashPhase } from '../../src/render/markings';
import { decalPaint } from '../../src/render/decals';
import { buildRampJunctionPaint, isRampJunction } from '../../src/render/gore';
import { PAINT_ORDER } from '../../src/render/paint';
import { PAINT_COL, strokesOf } from '../../src/render/constants';
import { removeAutoLine, autoRoadLineAt } from '../../src/tools/markingOps';
import { rig } from '../tools/helpers';

const v = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });
const free = (x: number, z: number) => ({ kind: 'free' as const, pos: v(x, z) });

/** A street-4 along x between two dead ends: its automatic lines run its whole length. */
function street(type = 'street-4') {
  const net = new RoadNetwork();
  const seg = net.drawRoad({ start: free(-100, 0), end: free(100, 0), roadType: type }).segments[0];
  return { net, seg };
}

type Vert = number[];

/** Vertices of one layer of a buffer, as tuples, rounded, sorted. */
function verts(buf: PaintBuf, layer: 'fill' | 'line' | 'bar' | 'symbol'): Vert[] {
  const piece = buf.toLayerPieces()[['fill', 'line', 'bar', 'symbol'].indexOf(layer)];
  if (!piece) return [];
  const [pos, side, line, dash, col] = piece.attrs;
  const out: Vert[] = [];
  for (let i = 0; i < piece.vertexCount; i++) {
    out.push([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], side[i * 2], side[i * 2 + 1], line[i * 3], line[i * 3 + 1], line[i * 3 + 2], dash[i * 2], dash[i * 2 + 1], col[i * 3], col[i * 3 + 1], col[i * 3 + 2]].map((x) => Math.round(x * 1e4) / 1e4));
  }
  return out.sort((a, b) => {
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] - b[k];
    return 0;
  });
}

function laneLineOf(net: RoadNetwork, seg: Id) {
  const l = autoLinesOf(net, seg).find((x) => x.role === 'lane');
  if (!l) throw new Error('no lane line');
  return l;
}

/** A road-paint line along the whole of a segment at an offset, in a look. */
function lineDecal(seg: Id, offset: number, style = lineStandard('lane').spec, t0 = 0, t1 = 1): Omit<Decal, 'id'> {
  return { kind: 'line', points: [], road: { pieces: [{ segmentId: seg, t0, t1 }], offset }, style, color: style.color, width: style.width, rotation: 0 };
}

describe('one standard for automatic and hand-placed paint', () => {
  it('a user lane line on an automatic one is the very same geometry and paint', () => {
    const a = street();
    const before = new PaintBuf();
    buildSegmentPaint(a.net, a.seg, before);

    const b = street();
    const lane = laneLineOf(b.net, b.seg);
    const id = b.net.addDecal(lineDecal(b.seg, lane.offset));
    const auto = new PaintBuf();
    buildSegmentPaint(b.net, b.seg, auto);
    const user = decalPaint(b.net, b.net.decals.find((d) => d.id === id)!);

    // The automatic lane line left the road's paint and the user's paint has exactly it.
    const lost = verts(before, 'line').filter((x) => !verts(auto, 'line').some((y) => y.every((k, i) => k === x[i])));
    expect(lost.length).toBeGreaterThan(0);
    expect(verts(user, 'line')).toEqual(lost);
    // Width, dash period and duty, colour: the measures of the standard.
    const u = verts(user, 'line')[0];
    expect(u[6] * 2).toBeCloseTo(LINE_W.lane, 4);
    expect(u[8]).toBeGreaterThan(0);
    expect(u[9]).toBeCloseTo(1 / 3, 4);
    expect(u.slice(10)).toEqual(PAINT_COL.white.map((x) => Math.round(x * 1e4) / 1e4));
  });

  it('every paint layer stacks fills under lines under bars under symbols, for everyone', () => {
    expect(PAINT_ORDER.fill).toBeLessThan(PAINT_ORDER.line);
    expect(PAINT_ORDER.line).toBeLessThan(PAINT_ORDER.bar);
    expect(PAINT_ORDER.bar).toBeLessThan(PAINT_ORDER.symbol);
    // A road's own arrows go in the symbol layer, its lines in the line layer.
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-150, 0), end: free(150, 0), roadType: 'avenue-4' });
    net.drawRoad({ start: free(0, -150), end: free(0, 150), roadType: 'avenue-4' });
    const buf = new PaintBuf();
    for (const s of net.segments) buildSegmentPaint(net, s.id, buf);
    expect(buf.layerSize('symbol')).toBeGreaterThan(0);
    expect(buf.layerSize('line')).toBeGreaterThan(0);
    expect(buf.layerSize('bar')).toBeGreaterThan(0);
  });

  it('a user line continuing an automatic one is dashed in the same phase', () => {
    const { net, seg } = street();
    const lane = laneLineOf(net, seg);
    const phase = segmentDashPhase(net, seg)!;
    const id = net.addDecal(lineDecal(seg, lane.offset, lineStandard('lane').spec, 0.5, 1));
    const user = verts(decalPaint(net, net.decals.find((d) => d.id === id)!), 'line');
    const before = new PaintBuf();
    const plain = street();
    buildSegmentPaint(plain.net, plain.seg, before);
    const auto = verts(before, 'line').filter((x) => Math.abs(x[2] - lane.offset) < 0.2 && x[8] > 0);
    // Same period, and every user vertex has the u an automatic vertex at that place has.
    expect(user.every((x) => Math.abs(x[8] - auto[0][8]) < 1e-3)).toBe(true);
    for (const x of user) {
      const twin = auto.find((y) => Math.abs(y[0] - x[0]) < 0.05 && Math.abs(y[2] - x[2]) < 0.05);
      if (twin) expect(x[7]).toBeCloseTo(twin[7], 3);
    }
    expect(phase.origin).toBeCloseTo(net.segmentGeom(seg)!.stations[0].s, 6);
  });

  it('the automatic line is left off where a user line holds it, and only there', () => {
    const { net, seg } = street();
    const lane = laneLineOf(net, seg);
    net.addDecal(lineDecal(seg, lane.offset, lineStandard('laneSolid').spec, 0.3, 0.7));
    const buf = new PaintBuf();
    buildSegmentPaint(net, seg, buf);
    const at = verts(buf, 'line').filter((x) => Math.abs(x[2] - lane.offset) < 0.2);
    expect(at.length).toBeGreaterThan(0);
    // Nothing of the automatic line inside the held stretch (x from -40 to 40 or so).
    expect(at.filter((x) => x[0] > -35 && x[0] < 35)).toEqual([]);
    expect(userRoadLines(net, seg)).toHaveLength(1);
  });

  it('a user crosswalk where the road paints one takes its place', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-150, 0), end: free(150, 0), roadType: 'street-2' });
    net.drawRoad({ start: free(0, -150), end: free(0, 150), roadType: 'street-2' });
    const node = net.nodes.find((n) => n.segments.length === 4)!;
    const seg = node.segments[0];
    const s = net.getSegment(seg)!;
    const end = s.b === node.id ? 1 : -1;
    const lay = armEndLayout(net, seg, end)!;
    expect(lay.crosswalk).not.toBeNull();
    // A Paint tool zebra across the road right where the automatic one is.
    const st = net.segmentGeom(seg)!.stations;
    const t = end > 0 ? st[st.length - 1].t - 0.02 : st[0].t + 0.02;
    const half = net.roadTypeOf(seg).halfWidth;
    net.addDecal({ kind: 'crosswalk', points: [], road: { pieces: [{ segmentId: seg, t0: t, t1: t }], offset: -half, offset2: half, dir: 1 }, style: lineStandard('zebra').spec, color: 'white', width: 3, rotation: 0 });
    expect(armEndLayout(net, seg, end)!.crosswalk).toBeNull();
  });
});

describe('old saves move to the standard without moving', () => {
  it('migrates decals and junction markings, keeps every placement, and is idempotent', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-150, 0), end: free(150, 0), roadType: 'street-2' });
    net.drawRoad({ start: free(0, -150), end: free(0, 150), roadType: 'street-2' });
    const node = net.nodes.find((n) => n.segments.length === 4)!;
    const seg = net.segments[0].id;
    const old = JSON.parse(net.serialize());
    delete old.paintStandard;
    const road = { pieces: [{ segmentId: seg, t0: 0.2, t1: 0.8 }], offset: 0 };
    old.decals = [
      { id: 900, kind: 'dashedLine', points: [], road, color: 'white', width: 0.2, rotation: 0 },
      { id: 901, kind: 'line', lineStyle: 'double', points: [], road: { ...road, offset: 1.75 }, color: 'yellow', width: 0.5, rotation: 0 },
      { id: 902, kind: 'crosswalk', points: [v(5, 5)], color: 'white', width: 3, rotation: 0.3 },
      { id: 903, kind: 'hatch', points: [v(0, 0), v(4, 0), v(4, 4)], color: 'white', width: 0.4, rotation: 0 },
    ];
    const n = old.nodes.find((x: { id: Id }) => x.id === node.id);
    n.control.markings = [{ id: 904, kind: 'line', from: { segmentId: node.segments[0], boundary: 1 }, to: { segmentId: node.segments[2], boundary: 1 }, style: 'dashed', color: 'white', width: 0.15, dash: 3, space: 3, straight: false }];
    old.nextId = 1000;
    const back = new RoadNetwork(JSON.stringify(old));
    const d = back.decals;
    // Placement untouched.
    expect(d.find((x) => x.id === 900)!.road).toEqual(road);
    expect(d.find((x) => x.id === 902)!.points).toEqual([v(5, 5)]);
    expect(d.find((x) => x.id === 902)!.rotation).toBe(0.3);
    const m = back.getNode(node.id)!.control.markings![0];
    expect(m.kind === 'line' && m.from).toEqual({ segmentId: node.segments[0], boundary: 1 });
    // Looks: old defaults become the standard, chosen measures stay.
    expect(matchStandard(d.find((x) => x.id === 900)!.style!)?.id).toBe('lane');
    const dbl = d.find((x) => x.id === 901)!.style!;
    expect(dbl).toMatchObject({ style: 'double', color: 'yellow', width: 0.5 });
    expect(dbl.gap! + dbl.width).toBeCloseTo((0.32 / 0.14) * 0.5, 6);
    expect(matchStandard(d.find((x) => x.id === 902)!.style!)?.id).toBe('zebra');
    expect(d.find((x) => x.id === 903)!.fill).toMatchObject({ fill: 'hatch' });
    expect(m).toMatchObject({ style: 'dashed', width: LINE_W.lane });
    expect('dash' in m).toBe(false);
    expect(back.project.paintStandard).toBe(1);
    // Saved and loaded again: nothing moves on.
    const again = new RoadNetwork(back.serialize());
    expect(again.signature()).toBe(back.signature());
    const p = structuredClone(back.project);
    migrateMarkingLooks(p);
    expect(JSON.stringify(p)).toBe(JSON.stringify(back.project));
  });
});

describe('one marking per place', () => {
  it('a new line on a taken lane line replaces the old one, and names it', () => {
    const { net, seg } = street();
    const lane = laneLineOf(net, seg);
    const first = net.addDecal(lineDecal(seg, lane.offset, lineStandard('lane').spec, 0.1, 0.6));
    expect(net.lastReplaced).toEqual(['lane line']);
    const draft = lineDecal(seg, lane.offset, lineStandard('laneSolid').spec, 0.4, 0.9);
    expect(stackedWith(net, { kind: 'decal', decal: draft }).labels[0]).toBe('lane line');
    const second = net.addDecal(draft);
    expect(net.decals.map((d) => d.id)).toEqual([second]);
    expect(net.decals.some((d) => d.id === first)).toBe(false);
    expect(net.lastReplaced).toContain('lane line');
    // Lines down the middle of a lane are not a place: any number may run there.
    const centre = net.roadTypeOf(seg).lanes[0].offset;
    net.addDecal(lineDecal(seg, centre, lineStandard('laneSolid').spec, 0.1, 0.9));
    net.addDecal(lineDecal(seg, centre, lineStandard('laneSolid').spec, 0.2, 0.8));
    expect(net.decals).toHaveLength(3);
  });

  it('areas never overlap: a new area over an old one replaces it', () => {
    const { net, seg } = street();
    const area = (t0: number, t1: number): Omit<Decal, 'id'> => ({ kind: 'hatch', points: [], road: { pieces: [{ segmentId: seg, t0, t1 }], offset: -3, offset2: 3 }, fill: { fill: 'hatch', color: 'white', width: 0.3 }, color: 'white', width: 0.3, rotation: 0 });
    net.addDecal(area(0.2, 0.5));
    const b = net.addDecal(area(0.4, 0.7));
    expect(net.decals.map((d) => d.id)).toEqual([b]);
    net.addDecal(area(0.75, 0.9));
    expect(net.decals).toHaveLength(2);
  });

  it('an old save with stacked duplicates keeps only the newest', () => {
    const { net, seg } = street();
    const lane = laneLineOf(net, seg);
    const raw = JSON.parse(net.serialize());
    const style = lineStandard('lane').spec;
    raw.decals = [
      { id: 500, kind: 'line', points: [], road: { pieces: [{ segmentId: seg, t0: 0.1, t1: 0.9 }], offset: lane.offset }, style, color: 'white', width: style.width, rotation: 0 },
      { id: 501, kind: 'line', points: [], road: { pieces: [{ segmentId: seg, t0: 0.2, t1: 0.8 }], offset: lane.offset }, style, color: 'white', width: style.width, rotation: 0 },
    ];
    raw.nextId = 600;
    const back = new RoadNetwork(JSON.stringify(raw));
    expect(back.decals.map((d) => d.id)).toEqual([501]);
    expect(cleanStacked(back, back.project)).toBe(0);
  });

  it('a new marking replacing an old one is one undo step', () => {
    const r = rig();
    const seg = r.net.drawRoad({ start: free(-100, 0), end: free(100, 0), roadType: 'street-4' }).segments[0];
    const lane = laneLineOf(r.net, seg);
    r.tools.setTool('paint');
    r.click(-60, lane.offset);
    r.click(20, lane.offset);
    expect(r.net.decals).toHaveLength(1);
    const after1 = r.net.signature();
    r.click(-20, lane.offset);
    r.click(60, lane.offset);
    expect(r.net.decals).toHaveLength(1);
    expect(r.toasts.some((t) => t.startsWith('Replaced the lane line'))).toBe(true);
    r.history.undo();
    expect(r.net.signature()).toBe(after1);
  });
});

describe('simple removal', () => {
  it('Bulldoze takes an automatic road line with one click when zoomed in, restorable and undoable', () => {
    const r = rig();
    const seg = r.net.drawRoad({ start: free(-100, 0), end: free(100, 0), roadType: 'street-4' }).segments[0];
    const lane = laneLineOf(r.net, seg);
    // Zoomed in: 40 px per metre.
    (r.view as unknown as { project: (p: Vec3) => { x: number; y: number } }).project = (p) => ({ x: p.x * 40, y: p.z * 40 });
    const before = r.net.signature();
    r.tools.setTool('bulldoze');
    r.hover(10, lane.offset);
    expect(r.view.marks.some((m) => m.kind === 'line')).toBe(true);
    r.click(10, lane.offset);
    expect(r.net.getSegment(seg)).toBeDefined();
    expect(r.net.getSegment(seg)!.overrides.paintOff).toEqual([lane.key]);
    expect(autoLinesOf(r.net, seg).find((l) => l.key === lane.key)!.off).toBe(true);
    r.history.undo();
    expect(r.net.signature()).toBe(before);
  });

  it('far out, a click on a road is for the road, not its lines', () => {
    const r = rig();
    const seg = r.net.drawRoad({ start: free(-100, 0), end: free(100, 0), roadType: 'street-4' }).segments[0];
    const lane = laneLineOf(r.net, seg);
    r.tools.setTool('bulldoze');
    // One pixel a metre: too far out to aim at a 14 cm line. The click cuts the road instead.
    const before = r.net.signature();
    r.click(10, lane.offset);
    expect(r.net.segments.every((s) => !s.overrides.paintOff)).toBe(true);
    expect(r.net.signature()).not.toBe(before);
  });

  it('removing a road line takes it out of the paint; bringing it back restores it', () => {
    const { net, seg } = street();
    const lane = laneLineOf(net, seg);
    const hit = autoRoadLineAt(net, v(0, lane.offset));
    expect(hit?.key).toBe(lane.key);
    removeAutoLine(net, seg, lane.key);
    const buf = new PaintBuf();
    buildSegmentPaint(net, seg, buf);
    expect(verts(buf, 'line').filter((x) => Math.abs(x[2] - lane.offset) < 0.1)).toEqual([]);
    expect(autoRoadLineAt(net, v(0, lane.offset))).toBeNull();
  });
});

describe('highways', () => {
  it('dash and width follow speed: long dashes and wide lines at highway speed', () => {
    expect(dashFor(110)).toEqual(DASH.fast);
    expect(DASH.fast.dash).toBeGreaterThan(DASH.urban.dash);
    expect(DASH.fast.gap).toBeGreaterThan(DASH.urban.gap);
    const k = strokesOf('dashed', 110)[0];
    expect(k.period).toBeCloseTo(DASH.fast.dash + DASH.fast.gap, 6);
    expect(k.duty).toBeCloseTo(DASH.fast.dash / (DASH.fast.dash + DASH.fast.gap), 6);
    expect(standardWidth(LINE_W.lane, 110)).toBe(FAST_W.lane);
    expect(standardWidth(LINE_W.lane, 50)).toBe(LINE_W.lane);
    expect(standardWidth(0.5, 110)).toBe(0.5);
  });

  it('a highway has solid edges both sides, the left one yellow, and wide lane lines', () => {
    const net = new RoadNetwork();
    const seg = net.drawRoad({ start: free(-300, 0), end: free(300, 0), roadType: 'highway-3' }).segments[0];
    const lines = autoLinesOf(net, seg);
    const edges = lines.filter((l) => l.role === 'edge');
    expect(edges.map((e) => e.style)).toEqual(['solid', 'solid']);
    expect(edges.find((e) => e.key === 'L')!.color).toBe('yellow');
    expect(edges.find((e) => e.key === 'R')!.color).toBe('white');
    const buf = new PaintBuf();
    buildSegmentPaint(net, seg, buf);
    const lane = lines.find((l) => l.role === 'lane')!;
    const at = verts(buf, 'line').filter((x) => Math.abs(x[2] - lane.offset) < 0.2);
    expect(at[0][6] * 2).toBeCloseTo(FAST_W.lane, 4);
    // A hand-drawn lane line on a highway is drawn as wide and as long-dashed as the highway's.
    const id = net.addDecal(lineDecal(seg, lane.offset));
    const u = verts(decalPaint(net, net.decals.find((d) => d.id === id)!), 'line');
    expect(u[0][6] * 2).toBeCloseTo(FAST_W.lane, 4);
    expect(u[0][8]).toBeCloseTo(at[0][8], 3);
  });

  /** Highway-3 along x with an off-ramp leaving its rightmost lane at x = 0. */
  function exit() {
    const net = new RoadNetwork();
    const hw = net.drawRoad({ start: free(-600, 0), end: free(600, 0), roadType: 'highway-3' }).segments[0];
    const near = net.nearestSegment(v(0, 0))!;
    const attach: RampAttach = makeAttach(0, v(1, 0), v(1, 0), 1);
    const r = net.drawRoad({ start: { kind: 'segment', id: near.segmentId, t: near.t }, end: free(260, 150), c1: v(100, 10), c2: v(190, 60), roadType: 'ramp-1', startAttach: attach });
    return { net, hw, node: r.nodes[0], ramp: r.segments[0] };
  }

  it('the gore and the lines through an exit use the shared standard', () => {
    const { net, node } = exit();
    expect(isRampJunction(net, node)).toBe(true);
    const buf = new PaintBuf();
    buildRampJunctionPaint(net, node, buf);
    const fill = verts(buf, 'fill');
    expect(fill.length).toBeGreaterThan(0);
    // Gore chevrons: the standard stripe width.
    expect(fill.every((x) => Math.abs(x[6] * 2 - GORE.stripe) < 1e-3)).toBe(true);
    // Edge lines through it: highway width.
    expect(verts(buf, 'line').some((x) => Math.abs(x[6] * 2 - FAST_W.edge) < 1e-3)).toBe(true);
    // No crosswalks or stop lines at a free-flowing junction.
    for (const s of net.getNode(node)!.segments) {
      const seg = net.getSegment(s)!;
      const lay = armEndLayout(net, s, seg.b === node ? 1 : -1);
      expect(lay?.crosswalk ?? null).toBeNull();
      expect(lay?.stop ?? null).toBeNull();
    }
  });

  it('highway presets are in the standard, and an exit-only lane gets the exit-only line', () => {
    const names = LINE_STANDARDS.map((s) => s.name);
    for (const n of ['Exit-only dotted line', 'Lane drop', 'Solid no lane change']) expect(names).toContain(n);
    expect(lineStandard('exitOnly').spec).toMatchObject({ width: EXIT_ONLY.width, dash: EXIT_ONLY.dash, space: EXIT_ONLY.gap });
    // Every lane-end line reported belongs to a real boundary of that road.
    const { net } = exit();
    for (const s of net.segments) {
      const keys = new Set(autoLinesOf(net, s.id).map((l) => l.key));
      for (const k of laneEndLines(net, s.id).keys()) expect(keys.has(k)).toBe(true);
    }
  });

  it('hand-placed markings work at a ramp junction, one per place, with no crossings offered', () => {
    const r = rig();
    const net = r.net;
    net.drawRoad({ start: free(-600, 0), end: free(600, 0), roadType: 'highway-3' });
    const near = net.nearestSegment(v(0, 0))!;
    const rr = net.drawRoad({ start: { kind: 'segment', id: near.segmentId, t: near.t }, end: free(260, 150), c1: v(100, 10), c2: v(190, 60), roadType: 'ramp-1', startAttach: makeAttach(0, v(1, 0), v(1, 0), 1) });
    const node = rr.nodes[0];
    const segs = net.getNode(node)!.segments;
    const line = { kind: 'line' as const, from: { segmentId: segs[0], boundary: 1 }, to: { segmentId: segs[1], boundary: 1 }, ...lineStandard('laneSolid').spec, straight: false };
    net.addNodeMarking(node, line);
    net.addNodeMarking(node, { ...line, ...lineStandard('exitOnly').spec });
    expect(net.getNode(node)!.control.markings).toHaveLength(1);
    expect(net.lastReplaced).toEqual(['line']);
    const tool = r.tools.nodeMarkings;
    r.tools.setTool('nodeMarkings');
    tool.open(node);
    expect(tool.freeFlow).toBe(true);
    tool.setDraw('crosswalk');
    const p = net.getNode(node)!.pos;
    r.click(p.x, p.z);
    expect(r.toasts.some((t) => t.includes('No crosswalks'))).toBe(true);
  });

  it('a ramp slipping onto the side of an avenue gets no crosswalks', () => {
    const net = new RoadNetwork();
    const host = net.drawRoad({ start: free(-400, 0), end: free(400, 0), roadType: 'avenue-4' }).segments[0];
    const near = net.nearestSegment(v(0, 0))!;
    const attach: RampAttach = { lane: 0, hostSide: 1 };
    const r = net.drawRoad({ start: free(-200, 120), end: { kind: 'segment', id: near.segmentId, t: near.t }, c1: v(-120, 60), c2: v(-60, 10), roadType: 'ramp-1', endAttach: attach });
    const node = r.nodes[r.nodes.length - 1];
    expect(host).toBeDefined();
    expect(isRampJunction(net, node)).toBe(true);
    for (const s of net.getNode(node)!.segments) {
      const seg = net.getSegment(s)!;
      expect(armEndLayout(net, s, seg.b === node ? 1 : -1)?.crosswalk ?? null).toBeNull();
    }
  });
});

describe('marking tool removal and IMT looks', () => {
  it('right-click on a selected junction marking removes it, as one undo step', () => {
    const r = rig();
    r.net.drawRoad({ start: free(-150, 0), end: free(150, 0), roadType: 'street-2' });
    r.net.drawRoad({ start: free(0, -150), end: free(0, 150), roadType: 'street-2' });
    const node = r.net.nodes.find((n) => n.segments.length === 4)!;
    const segs = node.segments;
    const id = r.net.addNodeMarking(node.id, { kind: 'line', from: { segmentId: segs[0], boundary: 1 }, to: { segmentId: segs[2], boundary: 1 }, ...lineStandard('lane').spec, straight: true });
    const before = r.net.signature();
    r.tools.setTool('nodeMarkings');
    const tool = r.tools.nodeMarkings;
    tool.open(node.id);
    tool.select(id);
    const path = (r.net.getNode(node.id)!.control.markings![0]);
    expect(path.id).toBe(id);
    // Hover the middle of the line and right-click it.
    const pts = markingPath(r.net, node.id, path as never)!;
    const a = pts[Math.floor(pts.length / 2)];
    r.hover(a.x, a.z);
    r.rightClick();
    expect(r.net.getNode(node.id)!.control.markings ?? []).toHaveLength(0);
    r.history.undo();
    expect(r.net.getNode(node.id)!.control.markings).toHaveLength(1);
    expect(before).toBe(r.net.signature());
  });

  it('paints the IMT stop line and crossing variants, the second colour and inverted chevrons', async () => {
    const { paintCrossing, paintSpecAlong, paintArea } = await import('../../src/render/paint');
    const count = (f: (b: PaintBuf) => void) => {
      const b = new PaintBuf();
      f(b);
      return b.vertexCount;
    };
    const a = v(0, -4);
    const b = v(0, 4);
    for (const style of ['stopLineDashed', 'stopLineDouble', 'stopLineSolidDashed', 'crosswalkDashedLines'] as const) {
      expect(count((buf) => paintCrossing(buf, a, b, { style, color: 'white', width: 0.45 })), style).toBeGreaterThan(0);
    }
    expect(count((buf) => paintCrossing(buf, a, b, { style: 'stopLineDouble', color: 'white', width: 0.3 }))).toBe(2 * count((buf) => paintCrossing(buf, a, b, { style: 'stopLine', color: 'white', width: 0.3 })));
    const two = new PaintBuf();
    paintSpecAlong(two, [v(-5, 0), v(5, 0)], { style: 'double', color: 'white', width: 0.14, color2: 'yellow' });
    const cols = new Set<string>();
    for (let i = 0; i < two.vertexCount; i++) cols.add(two.col.slice(i * 3, i * 3 + 3).map((x) => x.toFixed(3)).join());
    expect(cols.size).toBe(2);
    const poly = [v(-5, -2), v(5, -2), v(5, 2), v(-5, 2)];
    const one = new PaintBuf();
    paintArea(one, poly, 0.06, { fill: 'chevron', color: 'white', width: 0.4, step: 2.6, noOutline: true });
    const inv = new PaintBuf();
    paintArea(inv, poly, 0.06, { fill: 'chevron', color: 'white', width: 0.4, step: 2.6, noOutline: true, invert: true });
    expect(inv.vertexCount).toBeGreaterThan(0);
    expect(inv.pos).not.toEqual(one.pos);
  });
});

describe('colours and names', () => {
  it('one white and one yellow everywhere', () => {
    expect(PAINT_HEX.white).toBe('#f2f1ec');
    expect(PAINT_HEX.yellow).toBe('#e2b33c');
  });
});

describe('transitions: markings from one road to the other', () => {
  /** A 2+2 street narrowing into a 1+1 street end to end, over a tapered transition surface. */
  function taper() {
    const net = new RoadNetwork();
    const a = net.drawRoad({ start: free(-200, 0), end: free(0, 0), roadType: 'street-4' });
    const b = net.drawRoad({ start: { kind: 'node', id: a.nodes[a.nodes.length - 1] }, end: free(200, 0), roadType: 'street-2' });
    const node = a.nodes[a.nodes.length - 1];
    return { net, node, wide: a.segments[0], narrow: b.segments[0] };
  }

  it('automatic lines carry on across the transition, with no bare gap', async () => {
    const { net, node, wide, narrow } = taper();
    const g = net.nodeGeom(node)!;
    expect(g.kind).toBe('junction');
    expect(g.arms).toHaveLength(2);
    const { transitionLines } = await import('../../src/render/markings');
    const lines = transitionLines(net, node);
    const centre = lines.find((l) => l.spec.style === 'double');
    expect(centre).toBeDefined();
    // It starts exactly where each road's centre line ends: at the cut, on the line.
    const cutOf = (seg: Id) => {
      const st = net.segmentGeom(seg)!.stations;
      const s = net.getSegment(seg)!;
      return s.b === node ? st[st.length - 1] : st[0];
    };
    const ca = cutOf(wide);
    const cb = cutOf(narrow);
    const p0 = centre!.pts[0];
    const p1 = centre!.pts[centre!.pts.length - 1];
    const near = (p: Vec3, q: Vec3) => Math.hypot(p.x - q.x, p.z - q.z) < 0.05;
    expect(near(p0, ca.pos) || near(p1, ca.pos)).toBe(true);
    expect(near(p0, cb.pos) || near(p1, cb.pos)).toBe(true);
    // The two lane lines of the wide road end there: lane-drop lines, one each side.
    const drops = lines.filter((l) => l.spec.dash === lineStandard('laneDrop').spec.dash && l.spec.width === lineStandard('laneDrop').spec.width);
    expect(drops).toHaveLength(2);
    // And it is painted: the node's paint has lines.
    const { buildJunctionGuides } = await import('../../src/render/markings');
    const buf = new PaintBuf();
    buildJunctionGuides(net, node, buf);
    expect(buf.layerSize('line')).toBeGreaterThan(0);
    // The roads' own lines run right up to the cut (no setback at a transition).
    expect(segmentDashPhase(net, narrow)!.origin).toBeCloseTo(net.segmentGeom(narrow)!.stations[0].s, 6);
  });

  it('the Paint tool draws a line from one road across the transition to the other', async () => {
    const r = rig();
    const a = r.net.drawRoad({ start: free(-200, 0), end: free(0, 0), roadType: 'street-4' });
    r.net.drawRoad({ start: { kind: 'node', id: a.nodes[a.nodes.length - 1] }, end: free(200, 0), roadType: 'street-2' });
    const node = a.nodes[a.nodes.length - 1];
    const { transitionLines } = await import('../../src/render/markings');
    const before = transitionLines(r.net, node).length;
    r.tools.setTool('paint');
    // The centre line, from the wide road to the narrow one.
    r.click(-60, 0);
    r.click(60, 0);
    expect(r.net.decals).toHaveLength(1);
    const d = r.net.decals[0];
    expect(d.road!.pieces.length).toBeGreaterThanOrEqual(2);
    const pts = resolveDecal(r.net, d).points;
    expect(Math.hypot(pts[0].x + 60, pts[0].z)).toBeLessThan(0.5);
    expect(Math.hypot(pts[pts.length - 1].x - 60, pts[pts.length - 1].z)).toBeLessThan(0.5);
    // It crosses without a jump, and the automatic centre line through the taper steps aside.
    for (let i = 1; i < pts.length; i++) expect(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)).toBeLessThan(8);
    for (let i = 2; i < pts.length; i++) {
      const ax = pts[i - 1].x - pts[i - 2].x;
      const az = pts[i - 1].z - pts[i - 2].z;
      const bx = pts[i].x - pts[i - 1].x;
      const bz = pts[i].z - pts[i - 1].z;
      const la = Math.hypot(ax, az);
      const lb = Math.hypot(bx, bz);
      if (la > 1e-3 && lb > 1e-3) expect((ax * bx + az * bz) / (la * lb)).toBeGreaterThan(Math.cos((30 * Math.PI) / 180));
    }
    expect(transitionLines(r.net, node).length).toBe(before - 1);
    expect(transitionLines(r.net, node).some((l) => l.spec.style === 'double')).toBe(false);
  });

  it('a line from a lane boundary of the wide road to the kerb of the narrow one keeps its place on each', () => {
    const r = rig();
    const a = r.net.drawRoad({ start: free(-200, 0), end: free(0, 0), roadType: 'street-4' });
    const b = r.net.drawRoad({ start: { kind: 'node', id: a.nodes[a.nodes.length - 1] }, end: free(200, 0), roadType: 'street-2' });
    const wideLane = autoLinesOf(r.net, a.segments[0]).find((l) => l.role === 'lane' && l.offset > 0)!;
    const kerb = r.net.roadTypeOf(b.segments[0]).halfWidth;
    r.tools.setTool('paint');
    r.click(-60, wideLane.offset);
    r.click(60, kerb - 0.05);
    const d = r.net.decals[0];
    const pts = resolveDecal(r.net, d).points;
    expect(pts[0].z).toBeCloseTo(wideLane.offset, 3);
    expect(pts[pts.length - 1].z).toBeCloseTo(kerb, 1);
    expect(d.road!.pieces.some((p) => p.offset !== undefined)).toBe(true);
  });

  it('hovering the transition surface gives a cursor on the nearest arm cut', async () => {
    const { net, node, narrow } = taper();
    const { junctionCursor } = await import('../../src/tools/roadAnchors');
    const g = net.nodeGeom(node)!;
    const arm = g.arms.find((x) => x.segmentId === narrow)!;
    const p = { x: arm.centre.x - arm.dir.x * 0.5, y: 0, z: arm.centre.z - arm.dir.z * 0.5 + 1 };
    const c = junctionCursor(net, node, p)!;
    expect(c.segmentId).toBe(narrow);
    expect(c.atEnd).toBe(true);
    expect(c.nodeId).toBe(node);
    expect(Math.abs(c.lateral)).toBeLessThan(2);
  });

  it('junction markings work on a two-armed transition node, and hide the automatic line they duplicate', async () => {
    const { net, node, wide, narrow } = taper();
    const frames = (await import('../../src/core/nodeMarkings')).framesOf(net, node);
    expect(frames).toHaveLength(2);
    const fa = frames.find((f) => f.segmentId === wide)!;
    const fb = frames.find((f) => f.segmentId === narrow)!;
    const ba = fa.offsets.findIndex((o) => Math.abs(o) < 0.01);
    const bb = fb.offsets.findIndex((o) => Math.abs(o) < 0.01);
    const { transitionLines } = await import('../../src/render/markings');
    expect(transitionLines(net, node).some((l) => l.spec.style === 'double')).toBe(true);
    net.addNodeMarking(node, { kind: 'line', from: { segmentId: wide, boundary: ba }, to: { segmentId: narrow, boundary: bb }, ...lineStandard('centreDouble').spec, straight: false });
    expect(net.getNode(node)!.control.markings).toHaveLength(1);
    expect(transitionLines(net, node).some((l) => l.spec.style === 'double')).toBe(false);
  });
});
