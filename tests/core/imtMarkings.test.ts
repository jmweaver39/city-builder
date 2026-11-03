/**
 * The Intersection Marking Tool feature set at the core and drawing level: every
 * style's geometry, parts of lines, point settings, templates across arm layouts,
 * segment markings, automatic marking overrides, and persistence.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  LINE_STYLE_INFO,
  RoadNetwork,
  applyTemplate,
  captureTemplate,
  checkNetworkInvariants,
  fitTemplate,
  isAmbiguous,
  lineCrossings,
  lineStretches,
  markingPath,
  nodeAnchors,
  resolveAnchor,
  segmentFrames,
  slicePolyline,
  cumulative,
  type Id,
  type LineStyleSpec,
  type NodeLineMarking,
  type Vec3,
} from '../../src/core';
import { PaintBuf } from '../../src/render/batch';
import { insetPolygon, paintAlong, paintCrossing } from '../../src/render/nodeMarkings';
import { autoMarkingItems } from '../../src/render/autoItems';
import { armEndLayout, junctionGuides } from '../../src/render/markings';

const free = (x: number, z: number) => ({ kind: 'free' as const, pos: { x, y: 0, z } });

function star(net: RoadNetwork, degrees: number[], roadType = 'street-2', length = 120): Id {
  const dirs = degrees.map((d) => ({ x: Math.cos((d * Math.PI) / 180), z: Math.sin((d * Math.PI) / 180) }));
  const first = net.drawRoad({ start: free(0, 0), end: free(dirs[0].x * length, dirs[0].z * length), roadType });
  const node = first.nodes[0];
  for (const d of dirs.slice(1)) net.drawRoad({ start: { kind: 'node', id: node }, end: free(d.x * length, d.z * length), roadType });
  return node;
}

const straight: Vec3[] = Array.from({ length: 21 }, (_, i) => ({ x: i, y: 0, z: 0 }));

/** Vertex positions a buffer holds, in plan. */
function verts(buf: PaintBuf): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < buf.pos.length; i += 3) out.push({ x: buf.pos[i], z: buf.pos[i + 2] });
  return out;
}

/** Ribbon centre offsets across +x travel (z), one per ribbon of the buffer. */
function ribbonShifts(buf: PaintBuf): number[] {
  const zs = new Set<number>();
  for (let i = 0; i < buf.pos.length; i += 3) zs.add(Math.round(buf.pos[i + 2] * 1000) / 1000);
  return [...zs].sort((a, b) => a - b);
}

const spec = (s: Partial<LineStyleSpec> & Pick<LineStyleSpec, 'style'>): LineStyleSpec => ({ color: 'white', width: 0.15, ...s });

describe('Line styles', () => {
  it('every style in the catalogue draws something, except no paint', () => {
    for (const info of LINE_STYLE_INFO) {
      const buf = new PaintBuf();
      if (info.family === 'crosswalk' || info.family === 'stop') paintCrossing(buf, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, spec({ style: info.value, ...info.defaults }));
      else paintAlong(buf, straight, spec({ style: info.value, ...info.defaults }));
      if (info.value === 'empty') expect(buf.vertexCount, info.value).toBe(0);
      else expect(buf.vertexCount, info.value).toBeGreaterThan(0);
    }
  });

  it('a double line puts two ribbons a gap apart, centred, left or right of the points', () => {
    const at = (align?: 'left' | 'right') => {
      const buf = new PaintBuf();
      paintAlong(buf, straight, spec({ style: 'double', width: 0.1, gap: 0.2, align }));
      // Ribbon centres are the vertex positions: the line widths are applied in the shader.
      return ribbonShifts(buf);
    };
    expect(at()).toEqual([-0.15, 0.15]);
    // Right of the points: the paint runs from the points out to 0.4 m, so the line centres sit at 0.05 and 0.35.
    expect(at('right')).toEqual([0.05, 0.35]);
    expect(at('left')).toEqual([-0.35, -0.05]);
  });

  it('offset moves the whole line sideways', () => {
    const buf = new PaintBuf();
    paintAlong(buf, straight, spec({ style: 'solid', offset: 1.5 }));
    expect(ribbonShifts(buf)).toEqual([1.5]);
  });

  it('dashes take the dash and space lengths', () => {
    const buf = new PaintBuf();
    paintAlong(buf, straight, spec({ style: 'dashed', dash: 2, space: 1 }));
    expect(buf.dash[0]).toBeCloseTo(3, 9);
    expect(buf.dash[1]).toBeCloseTo(2 / 3, 9);
  });

  it('solid and dashed puts the solid line on the left, and the other way round', () => {
    const s = new PaintBuf();
    paintAlong(s, straight, spec({ style: 'solidDashed', width: 0.1, gap: 0.2 }));
    // The first ribbon written is the left one (negative z is left of +x travel in this frame).
    expect(s.pos[2]).toBeLessThan(0);
    expect(s.dash[0]).toBe(0);
    const d = new PaintBuf();
    paintAlong(d, straight, spec({ style: 'dashedSolid', width: 0.1, gap: 0.2 }));
    expect(d.dash[0]).toBeGreaterThan(0);
  });

  it('a zigzag swings evenly to both sides', () => {
    const buf = new PaintBuf();
    paintAlong(buf, straight, spec({ style: 'zigzag', width: 0.1, dash: 1, gap: 0.5 }));
    const zs = ribbonShifts(buf);
    expect(Math.min(...zs)).toBeCloseTo(-0.5, 1);
    expect(Math.max(...zs)).toBeCloseTo(0.5, 1);
  });

  it("shark's teeth: one triangle per base and space, tips to one side", () => {
    const buf = new PaintBuf();
    paintAlong(buf, straight, spec({ style: 'sharkTeeth', width: 0.6, dash: 0.5, space: 0.5 }), 1);
    // 20 m of path, 1 m per tooth: 20 teeth of three corners each.
    expect(buf.vertexCount).toBe(20 * 3);
    const tips = verts(buf).filter((v) => Math.abs(v.z) > 0.3);
    expect(tips).toHaveLength(20);
    expect(tips.every((v) => v.z > 0)).toBe(true);
  });

  it('a lane is a filled band of its width', () => {
    const buf = new PaintBuf();
    paintAlong(buf, straight, spec({ style: 'lane', width: 3 }));
    const zs = verts(buf).map((v) => v.z);
    expect(Math.min(...zs)).toBeCloseTo(-1.5, 6);
    expect(Math.max(...zs)).toBeCloseTo(1.5, 6);
  });
});

describe('Crosswalks', () => {
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 10, y: 0, z: 0 };
  /** Stripe bars of a crossing: their centres along it. */
  const stripes = (s: LineStyleSpec) => {
    const buf = new PaintBuf();
    paintCrossing(buf, a, b, s);
    return buf;
  };

  it('zebra fits whole stripes, centred, from the stripe and space', () => {
    const buf = stripes(spec({ style: 'crosswalkZebra', width: 3, dash: 0.5, space: 0.5 }));
    // 10 m: 10 stripes of 0.5 m at a 1 m period, each a bar of four vertices.
    expect(buf.vertexCount).toBe(10 * 4);
    const xs = verts(buf).map((v) => v.x);
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(10, 6);
  });

  it('double zebra makes two rows with a gap between', () => {
    const buf = stripes(spec({ style: 'crosswalkDoubleZebra', width: 5, dash: 0.5, space: 0.5, gap: 1 }));
    const zs = verts(buf).map((v) => v.z);
    expect(zs.some((z) => Math.abs(z) < 0.4)).toBe(false);
    expect(Math.max(...zs)).toBeCloseTo(2.5, 6);
  });

  it('ladder has two rails and rungs, parallel lines just the two lines', () => {
    expect(stripes(spec({ style: 'crosswalkLadder', width: 3, dash: 0.5, space: 0.5 })).vertexCount).toBe(10 * 4 + 2 * 4);
    expect(stripes(spec({ style: 'crosswalkLines', width: 3, dash: 0.3 })).vertexCount).toBe(2 * 4);
  });

  it('chessboard fills every other cell', () => {
    const buf = stripes(spec({ style: 'crosswalkChessboard', width: 3, dash: 1 }));
    // 3 rows by 10 columns, half filled, two triangles a cell.
    expect(buf.vertexCount).toBe(15 * 6);
  });

  it('a border adds an edge line on both sides, dashed when asked', () => {
    const plain = stripes(spec({ style: 'crosswalkSolid', width: 3 }));
    const solid = stripes(spec({ style: 'crosswalkSolid', width: 3, border: 'solid' }));
    const dashed = stripes(spec({ style: 'crosswalkSolid', width: 3, border: 'dashed' }));
    expect(solid.vertexCount).toBe(plain.vertexCount + 8);
    expect(dashed.dash.some((d, i) => i % 2 === 0 && d > 0)).toBe(true);
  });

  it('offset slides the crossing along the arm', () => {
    const buf = stripes(spec({ style: 'crosswalkSolid', width: 2, offset: 3 }));
    const zs = verts(buf).map((v) => v.z);
    expect(Math.min(...zs)).toBeCloseTo(2, 6);
    expect(Math.max(...zs)).toBeCloseTo(4, 6);
  });
});

describe('Areas', () => {
  it('inset moves every edge in by the distance', () => {
    const square: Vec3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 0, z: 10 },
      { x: 0, y: 0, z: 10 },
    ];
    const inner = insetPolygon(square, 1);
    for (const p of inner) {
      expect(p.x).toBeGreaterThan(0.99);
      expect(p.x).toBeLessThan(9.01);
      expect(p.z).toBeGreaterThan(0.99);
      expect(p.z).toBeLessThan(9.01);
    }
  });
});

describe('Parts of a line', () => {
  it('splits a line where it crosses another, and later parts win', () => {
    const net = new RoadNetwork();
    const node = star(net, [0, 90, 180, 270], 'street-4');
    const anchors = nodeAnchors(net, node);
    const arms = [...new Set(anchors.map((a) => a.anchor.segmentId))];
    const on = (arm: Id, i: number) => anchors.filter((a) => a.anchor.segmentId === arm)[i].anchor;
    // East to west through the middle, and north to south across it.
    const ew = net.addNodeMarking(node, { kind: 'line', from: on(arms[0], 2), to: on(arms[2], 2), style: 'solid', color: 'white', width: 0.15, straight: true });
    const ns = net.addNodeMarking(node, { kind: 'line', from: on(arms[1], 2), to: on(arms[3], 2), style: 'solid', color: 'white', width: 0.15, straight: true });
    const m = net.getNode(node)!.control.markings!.find((x) => x.id === ew) as NodeLineMarking;
    const crossings = lineCrossings(net, node, m);
    expect(crossings.map((c) => c.markingId)).toEqual([ns]);
    const path = markingPath(net, node, m)!;
    const total = cumulative(path).at(-1)!;
    const parts = lineStretches(total, [{ from: { cross: ns }, to: { end: 1 }, style: spec({ style: 'dashed' }) }], crossings);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ s0: 0, rule: -1 });
    expect(parts[0].s1).toBeCloseTo(crossings[0].s, 6);
    expect(parts[1]).toMatchObject({ rule: 0 });
    expect(parts[1].s1).toBeCloseTo(total, 6);
    // A part naming a line that has gone is dropped, not misplaced.
    expect(lineStretches(total, [{ from: { cross: 99999 }, to: { end: 1 }, style: spec({ style: 'dashed' }) }], crossings)).toEqual([{ s0: 0, s1: total, rule: -1 }]);
    const slice = slicePolyline(path, 0, crossings[0].s);
    expect(cumulative(slice).at(-1)).toBeCloseTo(crossings[0].s, 6);
  });
});

describe('Point settings', () => {
  it('an offset moves every anchor on the boundary, a turned-off point is not offered, and both survive a reverse', () => {
    const net = new RoadNetwork();
    const node = star(net, [0, 90, 180], 'street-2');
    const a = nodeAnchors(net, node)[1];
    const before = a.pos;
    net.setMarkingPoint({ kind: 'node', id: node }, { segmentId: a.anchor.segmentId, boundary: a.anchor.boundary, offset: 0.5 });
    const after = resolveAnchor(net, node, a.anchor)!.pos;
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeCloseTo(0.5, 6);
    net.setMarkingPoint({ kind: 'node', id: node }, { segmentId: a.anchor.segmentId, boundary: 0, off: true });
    expect(nodeAnchors(net, node).some((p) => p.anchor.segmentId === a.anchor.segmentId && p.anchor.boundary === 0)).toBe(false);
    expect(nodeAnchors(net, node, true).length).toBe(nodeAnchors(net, node).length + 1);
    // Turning the road round keeps the point where it is in the world.
    net.reverseSegment(a.anchor.segmentId);
    const moved = nodeAnchors(net, node).find((p) => Math.hypot(p.pos.x - after.x, p.pos.z - after.z) < 1e-6);
    expect(moved).toBeDefined();
    expect(checkNetworkInvariants(net)).toEqual([]);
  });
});

describe('Templates', () => {
  function marked(net: RoadNetwork, node: Id): void {
    const anchors = nodeAnchors(net, node);
    const arms = [...new Set(anchors.map((a) => a.anchor.segmentId))];
    const first = anchors.filter((a) => a.anchor.segmentId === arms[0]);
    net.addNodeMarking(node, { kind: 'line', from: first[0].anchor, to: first[first.length - 1].anchor, style: 'crosswalkLadder', color: 'white', width: 3, straight: true });
    const second = anchors.filter((a) => a.anchor.segmentId === arms[1]);
    net.addNodeMarking(node, { kind: 'line', from: first[1].anchor, to: second[1].anchor, style: 'solidDashed', color: 'yellow', width: 0.12, straight: false, gap: 0.12 });
    net.addNodeMarking(node, { kind: 'filler', anchors: [first[0].anchor, second[0].anchor, second[second.length - 1].anchor], fill: 'chevron', color: 'white', width: 0.4, angle: 10 });
  }

  it('fits a junction with the same arms turned round, matching arms by angle', () => {
    const a = new RoadNetwork();
    const na = star(a, [0, 90, 180, 270]);
    marked(a, na);
    const tpl = captureTemplate(a, na, 'Test', 't1');
    const b = new RoadNetwork();
    const nb = star(b, [30, 120, 210, 300]);
    const fits = fitTemplate(b, nb, tpl);
    expect(fits[0].score).toBeLessThan(0.01);
    // A plain cross fits four ways round, and its mirror images.
    expect(isAmbiguous(fits)).toBe(true);
    expect(applyTemplate(b, nb, tpl, fits[0])).toBe(true);
    const list = b.getNode(nb)!.control.markings!;
    expect(list).toHaveLength(3);
    expect(list.every((m) => (m.kind === 'line' ? [m.from, m.to] : m.anchors).every((x) => resolveAnchor(b, nb, x)))).toBe(true);
    expect(checkNetworkInvariants(b)).toEqual([]);
  });

  it('on a T it picks the one rotation that fits, and mirroring swaps the sides of a line', () => {
    const a = new RoadNetwork();
    const na = star(a, [0, 90, 180]);
    marked(a, na);
    const tpl = captureTemplate(a, na, 'T', 't2');
    const b = new RoadNetwork();
    const nb = star(b, [45, 135, 225]);
    const fits = fitTemplate(b, nb, tpl);
    expect(fits[0].score).toBeLessThan(0.01);
    expect(isAmbiguous(fits.filter((f) => !f.mirror))).toBe(false);
    const mirrored = fits.find((f) => f.mirror)!;
    applyTemplate(b, nb, tpl, mirrored);
    const line = b.getNode(nb)!.control.markings!.find((m) => m.kind === 'line' && m.style !== 'crosswalkLadder') as NodeLineMarking;
    expect(line.style).toBe('dashedSolid');
  });

  it('refuses a junction with a different number of arms, and maps lane counts that differ', () => {
    const a = new RoadNetwork();
    const na = star(a, [0, 90, 180, 270]);
    marked(a, na);
    const tpl = captureTemplate(a, na, 'X', 't3');
    const t = new RoadNetwork();
    expect(fitTemplate(t, star(t, [0, 90, 180]), tpl)).toEqual([]);
    const wide = new RoadNetwork();
    const nw = star(wide, [0, 90, 180, 270], 'street-4');
    expect(applyTemplate(wide, nw, tpl)).toBe(true);
    const ladder = wide.getNode(nw)!.control.markings![0] as NodeLineMarking;
    // Kerb to kerb stays kerb to kerb on the wider road.
    const count = nodeAnchors(wide, nw).filter((p) => p.anchor.segmentId === ladder.from.segmentId).length;
    expect([ladder.from.boundary, ladder.to.boundary].sort()).toEqual([0, count - 1]);
  });

  it('travels with the map when used, and every built-in preset is a valid look', () => {
    const net = new RoadNetwork();
    const node = star(net, [0, 90, 180]);
    marked(net, node);
    const tpl = captureTemplate(net, node, 'Kept', 't4');
    net.saveToLibrary({ template: tpl });
    net.saveToLibrary({ preset: BUILTIN_PRESETS[0] });
    const again = new RoadNetwork();
    again.load(net.serialize());
    expect(again.markingLibrary.templates?.[0].name).toBe('Kept');
    expect(again.markingLibrary.presets?.[0].id).toBe(BUILTIN_PRESETS[0].id);
    for (const p of BUILTIN_PRESETS) expect(p.style.width).toBeGreaterThan(0);
  });
});

describe('Segment markings', () => {
  function road(): { net: RoadNetwork; seg: Id } {
    const net = new RoadNetwork();
    const r = net.drawRoad({ start: free(0, 0), end: free(200, 0), c1: { x: 60, y: 0, z: 60 }, c2: { x: 140, y: 0, z: 60 }, roadType: 'street-2' });
    return { net, seg: r.segments[0] };
  }

  it('lines between its ends follow the road, and survive split, reverse and a save', () => {
    const { net, seg } = road();
    const host = { kind: 'segment' as const, id: seg };
    const frames = segmentFrames(net, seg);
    expect(frames.map((f) => f.end)).toEqual(['a', 'b']);
    const id = net.addMarking(host, { kind: 'line', from: { segmentId: seg, boundary: 1, end: 'a' }, to: { segmentId: seg, boundary: 1, end: 'b' }, style: 'dashed', color: 'white', width: 0.15, straight: false });
    const m = net.markingsOf(host)[0] as NodeLineMarking;
    const path = markingPath(net, host, m)!;
    // It bows with the curve, not straight across.
    expect(Math.max(...path.map((p) => p.z))).toBeGreaterThan(30);
    expect(checkNetworkInvariants(net)).toEqual([]);
    const sig = net.signature();
    const again = new RoadNetwork();
    again.load(net.serialize());
    expect(again.signature()).toBe(sig);
    // Split: both halves carry the line, each with its own id.
    const cut = net.splitSegment(seg, 0.5);
    const left = net.markingsOf({ kind: 'segment', id: cut.left });
    const right = net.markingsOf({ kind: 'segment', id: cut.right! });
    expect(left.map((x) => x.id)).toEqual([id]);
    expect(right).toHaveLength(1);
    expect(right[0].id).not.toBe(id);
    expect(checkNetworkInvariants(net)).toEqual([]);
    // Reverse: the line stays where it is in the world.
    const before = markingPath(net, { kind: 'segment', id: cut.left }, left[0] as NodeLineMarking)!;
    net.reverseSegment(cut.left);
    const after = markingPath(net, { kind: 'segment', id: cut.left }, net.markingsOf({ kind: 'segment', id: cut.left })[0] as NodeLineMarking)!;
    expect(Math.hypot(before[0].x - after[0].x, before[0].z - after[0].z)).toBeLessThan(1e-6);
    expect(checkNetworkInvariants(net)).toEqual([]);
  });
});

describe('Automatic markings one by one', () => {
  function signalled(): { net: RoadNetwork; node: Id } {
    const net = new RoadNetwork();
    const node = star(net, [0, 90, 180, 270], 'avenue-4');
    net.setJunctionControl(node, { mode: 'signals' as never });
    return { net, node };
  }

  it('lists each crosswalk, stop line, arrow and guide, and takes away exactly one', () => {
    const net = new RoadNetwork();
    const node = star(net, [0, 90, 180, 270], 'street-4');
    const items = autoMarkingItems(net, node);
    const kinds = new Set(items.map((i) => i.ref.kind));
    expect(kinds.has('crosswalk')).toBe(true);
    const arrows = items.filter((i) => i.ref.kind === 'arrow');
    if (arrows.length) {
      const one = arrows[0].ref as { kind: 'arrow'; segmentId: Id; lane: number };
      net.setAutoMarking(node, one, false);
      const seg = net.getSegment(one.segmentId)!;
      const layout = armEndLayout(net, one.segmentId, seg.b === node ? 1 : -1)!;
      expect(layout.arrows.some((a) => a.laneIndex === one.lane)).toBe(false);
      expect(autoMarkingItems(net, node).filter((i) => i.ref.kind === 'arrow')).toHaveLength(arrows.length - 1);
      net.setAutoMarking(node, one, true);
      expect(autoMarkingItems(net, node).filter((i) => i.ref.kind === 'arrow')).toHaveLength(arrows.length);
    }
    const guides = junctionGuides(net, node);
    if (guides.length) {
      net.setAutoMarking(node, { kind: 'guide', from: guides[0].from, to: guides[0].to, part: guides[0].part }, false);
      expect(junctionGuides(net, node)).toHaveLength(guides.length - 1);
    }
    void signalled;
  });

  it('a taken-away marking survives save, load and a split of its road, and old saves load unchanged', () => {
    const net = new RoadNetwork();
    const node = star(net, [0, 90, 180, 270], 'street-4');
    const oldSig = net.signature();
    const old = new RoadNetwork();
    old.load(net.serialize());
    expect(old.signature()).toBe(oldSig);
    const seg = net.getNode(node)!.segments[0];
    net.setAutoMarking(node, { kind: 'stop', segmentId: seg }, false);
    const again = new RoadNetwork();
    again.load(net.serialize());
    expect(again.getNode(node)!.control.autoOff).toEqual([{ kind: 'stop', segmentId: seg }]);
    // Splitting the road renames the reference to the piece at the junction.
    const s = net.getSegment(seg)!;
    const cut = net.splitSegment(seg, 0.5);
    const atNode = s.a === node ? cut.left : cut.right!;
    expect(net.getNode(node)!.control.autoOff).toEqual([{ kind: 'stop', segmentId: atNode }]);
    expect(checkNetworkInvariants(net)).toEqual([]);
  });
});
