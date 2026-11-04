import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core/RoadNetwork';
import { makeCustomRoadType } from '../../src/core/roadTypes';
import type { Id, NodeArm, Vec3 } from '../../src/core/types';
import { CROSSWALK_DEPTH, STOP_WIDTH, StationPath, armEndLayout, buildSegmentPaint, fitDashes, junctionGuides, junctionSetback, medianNoseBack, transitionLines } from '../../src/render/markings';
import { PaintBuf } from '../../src/render/batch';
import { autoMarkingItems } from '../../src/render/autoItems';
import { applyJunctionShape } from '../../src/core/junctionShape';
import { effectiveControl } from '../../src/core/signals';
import { effectiveLanes } from '../../src/core/roadTypes';

const v = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });
const free = (p: Vec3) => ({ kind: 'free' as const, pos: p });

/** Plan distance from a point to the arm's cut line. */
function fromCut(arm: NodeArm, p: { x: number; z: number }): number {
  const dx = arm.rightEdge.x - arm.leftEdge.x;
  const dz = arm.rightEdge.z - arm.leftEdge.z;
  return Math.abs(dx * (p.z - arm.leftEdge.z) - dz * (p.x - arm.leftEdge.x)) / Math.hypot(dx, dz);
}

function junctionOf(net: RoadNetwork): Id {
  const n = net.nodes.find((q) => net.nodeGeom(q.id)?.kind === 'junction' && (net.nodeGeom(q.id)?.arms.length ?? 0) >= 3);
  if (!n) throw new Error('no junction');
  return n.id;
}

function layoutsAt(net: RoadNetwork, nodeId: Id) {
  return net.nodeGeom(nodeId)!.arms.map((arm) => ({ arm, layout: armEndLayout(net, arm.segmentId, arm.atStart ? -1 : 1)! }));
}

/** Every line end is square to the road and the same distance back on every arm. */
function expectSquareEnds(net: RoadNetwork, nodeId: Id): void {
  const setback = junctionSetback(net, nodeId);
  for (const { arm, layout } of layoutsAt(net, nodeId)) {
    expect(layout).not.toBeNull();
    expect(layout.setback).toBeCloseTo(setback, 6);
    for (const p of layout.lineEnds) expect(Math.abs(fromCut(arm, p) - setback)).toBeLessThan(0.01);
    if (layout.stop) {
      const d0 = fromCut(arm, layout.stop.a);
      const d1 = fromCut(arm, layout.stop.b);
      expect(Math.abs(d0 - d1)).toBeLessThan(0.01);
    }
    if (layout.crosswalk) expect(Math.abs(fromCut(arm, layout.crosswalk.a) - fromCut(arm, layout.crosswalk.b))).toBeLessThan(0.01);
  }
}

/** Guides start and end on a cut line. */
function expectGuidesOnCuts(net: RoadNetwork, nodeId: Id): number {
  const arms = net.nodeGeom(nodeId)!.arms;
  const guides = junctionGuides(net, nodeId);
  for (const g of guides) {
    for (const p of [g.pts[0], g.pts[g.pts.length - 1]]) {
      const best = Math.min(...arms.map((a) => fromCut(a, p)));
      expect(best).toBeLessThan(0.01);
    }
  }
  return guides.length;
}

describe('junction paint lines up', () => {
  it('plain 4-way of matching streets', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(v(-150, 0)), end: free(v(150, 0)), roadType: 'street-2' });
    net.drawRoad({ start: free(v(0, -150)), end: free(v(0, 150)), roadType: 'street-2' });
    const node = junctionOf(net);
    expectSquareEnds(net, node);
    const lay = layoutsAt(net, node);
    // Opposite arms: the centre line ends at the same lateral position.
    const north = lay.find((l) => l.arm.dir.z < -0.9)!.layout;
    const south = lay.find((l) => l.arm.dir.z > 0.9)!.layout;
    const centreX = (ls: Vec3[]) => ls.map((p) => p.x).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
    expect(Math.abs(centreX(north.lineEnds) - centreX(south.lineEnds))).toBeLessThan(0.05);
    const east = lay.find((l) => l.arm.dir.x > 0.9)!.layout;
    const west = lay.find((l) => l.arm.dir.x < -0.9)!.layout;
    const centreZ = (ls: Vec3[]) => ls.map((p) => p.z).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
    expect(Math.abs(centreZ(east.lineEnds) - centreZ(west.lineEnds))).toBeLessThan(0.05);
    expectGuidesOnCuts(net, node);
  });

  it('avenue crossing a street: stop lines run centre to kerb, crosswalks span the road', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(v(-200, 0)), end: free(v(200, 0)), roadType: 'avenue-4' });
    net.drawRoad({ start: free(v(0, -200)), end: free(v(0, 200)), roadType: 'street-2' });
    const node = junctionOf(net);
    expectSquareEnds(net, node);
    for (const { arm, layout } of layoutsAt(net, node)) {
      const def = net.roadTypeOf(arm.segmentId);
      if (layout.crosswalk) {
        const w = Math.hypot(layout.crosswalk.a.x - layout.crosswalk.b.x, layout.crosswalk.a.z - layout.crosswalk.b.z);
        expect(w).toBeCloseTo(def.halfWidth * 2, 2);
      }
      if (layout.stop && def.id === 'street-2') {
        const w = Math.hypot(layout.stop.a.x - layout.stop.b.x, layout.stop.a.z - layout.stop.b.z);
        // Centre line to kerb on a two-lane street.
        expect(w).toBeCloseTo(def.halfWidth, 2);
      }
    }
  });

  it('skewed 3-way', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(v(-200, 0)), end: free(v(200, 0)), roadType: 'street-4' });
    net.drawRoad({ start: free(v(0, 0)), end: free(v(140, 160)), roadType: 'street-2' });
    const node = junctionOf(net);
    expectSquareEnds(net, node);
    expectGuidesOnCuts(net, node);
  });

  it('junction on a slope', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(v(-200, 0, 0)), end: free(v(200, 0, 16)), roadType: 'avenue-4' });
    net.drawRoad({ start: free(v(0, -200, 8)), end: free(v(0, 200, 8)), roadType: 'street-2' });
    const node = junctionOf(net);
    expectSquareEnds(net, node);
    expectGuidesOnCuts(net, node);
  });

  it('uneven custom road through a junction: lines stop at the arms, none carried across the type change', () => {
    const net = new RoadNetwork();
    const uneven = makeCustomRoadType({ id: 'uneven', forwardLanes: 2, backwardLanes: 1, sidewalkWidth: 2 });
    net.setCustomRoadType(uneven);
    const west = net.drawRoad({ start: free(v(-200, 0)), end: free(v(0, 0)), roadType: 'uneven' });
    const mid = { kind: 'node' as const, id: west.nodes[west.nodes.length - 1] };
    net.drawRoad({ start: mid, end: free(v(200, 0)), roadType: 'street-4' });
    net.drawRoad({ start: mid, end: free(v(0, 200)), roadType: 'street-2' });
    const node = junctionOf(net);
    expectSquareEnds(net, node);
    expectGuidesOnCuts(net, node);
    // A small junction: no guides at all, through or turning.
    expect(junctionGuides(net, node)).toHaveLength(0);
  });

  it('dashes fit a run exactly, with a dash at each end', () => {
    for (const L of [12.3, 40, 77.7, 150.2]) {
      const p = fitDashes(L, 9, 1 / 3);
      const periods = L / p - 1 / 3;
      expect(Math.abs(periods - Math.round(periods))).toBeLessThan(1e-9);
      expect(Math.abs(p - 9)).toBeLessThan(4.6);
    }
    expect(fitDashes(2, 9, 1 / 3)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Clean junction paint: arm ends alike, nothing in the box but left-turn guides
// ---------------------------------------------------------------------------

type P = { x: number; z: number };

function segmentsCross(p: readonly P[], q: readonly P[]): boolean {
  for (let i = 0; i + 1 < p.length; i++) {
    for (let j = 0; j + 1 < q.length; j++) {
      const [a, b, c, d] = [p[i], p[i + 1], q[j], q[j + 1]];
      const d1 = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
      const d2 = (b.x - a.x) * (d.z - a.z) - (b.z - a.z) * (d.x - a.x);
      const d3 = (d.x - c.x) * (a.z - c.z) - (d.z - c.z) * (a.x - c.x);
      const d4 = (d.x - c.x) * (b.z - c.z) - (d.z - c.z) * (b.x - c.x);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

function inside(p: P, poly: readonly P[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}

function distToRing(p: P, poly: readonly P[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t));
  }
  return best;
}

function band(a: Vec3, b: Vec3, depth: number): P[] {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz);
  const nx = (-dz / l) * (depth / 2);
  const nz = (dx / l) * (depth / 2);
  return [
    { x: a.x + nx, z: a.z + nz },
    { x: b.x + nx, z: b.z + nz },
    { x: b.x - nx, z: b.z - nz },
    { x: a.x - nx, z: a.z - nz },
    { x: a.x + nx, z: a.z + nz },
  ];
}

/** World positions of every vertex a paint buffer holds. */
function paintVerts(buf: PaintBuf): P[] {
  const out: P[] = [];
  for (let i = 0; i < buf.vertexCount; i++) {
    const s = buf.line[i * 3];
    const hw = buf.line[i * 3 + 1];
    out.push({ x: buf.pos[i * 3] + buf.side[i * 2] * s * hw, z: buf.pos[i * 3 + 2] + buf.side[i * 2 + 1] * s * hw });
  }
  return out;
}

function crossing(a: string, b: string, skew = 0): RoadNetwork {
  const net = new RoadNetwork();
  net.drawRoad({ start: free(v(0, -200)), end: free(v(0, 200)), roadType: a });
  const t = (skew * Math.PI) / 180;
  net.drawRoad({ start: free(v(-200 * Math.cos(t), -200 * Math.sin(t))), end: free(v(200 * Math.cos(t), 200 * Math.sin(t))), roadType: b });
  return net;
}

const CASES: { name: string; build: () => RoadNetwork }[] = [
  { name: 'boulevard-8 x avenue-6', build: () => crossing('boulevard-8', 'avenue-6') },
  { name: 'avenue-6 x avenue-4', build: () => crossing('avenue-6', 'avenue-4') },
  { name: 'street-4 x avenue-4', build: () => crossing('street-4', 'avenue-4') },
  { name: 'skewed avenue-4 x street-4', build: () => crossing('avenue-4', 'street-4', 25) },
  {
    name: 'shaped boulevard-8 x avenue-6',
    build: () => {
      const net = crossing('boulevard-8', 'avenue-6');
      const node = junctionOf(net);
      const segs = net.nodeGeom(node)!.arms.map((a) => a.segmentId);
      const res = applyJunctionShape(net, node, { arms: { [segs[0]]: { trim: 4, edgeLeft: -1.5 }, [segs[1]]: { edgeRight: -1 } } });
      expect(res.ok).toBe(true);
      return net;
    },
  },
  { name: 'dual-6 crossing avenue-6 at grade', build: () => crossing('dual-6', 'avenue-6') },
];

describe('clean junction paint', () => {
  for (const { name, build } of CASES) {
    it(name, () => {
      const net = build();
      const node = junctionOf(net);
      const g = net.nodeGeom(node)!;
      const ctl = effectiveControl(net, node);
      const setback = junctionSetback(net, node);
      const lay = layoutsAt(net, node);

      // Every arm ends the same way: one crosswalk where there are footways, the same setback, square ends.
      expectSquareEnds(net, node);
      const items = autoMarkingItems(net, node);
      const crosswalks: Vec3[][] = [];
      for (const { arm, layout } of lay) {
        const def = net.roadTypeOf(arm.segmentId);
        expect(items.filter((it) => it.ref.kind === 'crosswalk' && it.segmentId === arm.segmentId)).toHaveLength(def.sidewalk > 0 ? 1 : 0);
        expect(items.filter((it) => it.ref.kind === 'stop' && it.segmentId === arm.segmentId).length).toBeLessThanOrEqual(1);
        if (layout.crosswalk) {
          const { a, b } = layout.crosswalk;
          // Square across the road, to a degree.
          crosswalks.push([a, b]);
          const cut = { x: arm.rightEdge.x - arm.leftEdge.x, z: arm.rightEdge.z - arm.leftEdge.z };
          const ab = { x: b.x - a.x, z: b.z - a.z };
          const sin = Math.abs(cut.x * ab.z - cut.z * ab.x) / (Math.hypot(cut.x, cut.z) * Math.hypot(ab.x, ab.z));
          expect(sin).toBeLessThan(Math.sin(Math.PI / 180));
        }
        // Every approach with lanes coming in has its stop line (or teeth), unless it has priority.
        const seg = net.getSegment(arm.segmentId)!;
        const dir = arm.atStart ? -1 : 1;
        const incoming = effectiveLanes(def, seg.overrides).some((l) => l.dir === dir);
        const sign = ctl.signs[arm.segmentId] ?? 'none';
        if (incoming && ctl.kind === 'signal') expect(layout.stop?.kind).toBe('bar');
        if (incoming && ctl.kind !== 'signal' && sign !== 'priority') expect(layout.stop).not.toBeNull();
        if (layout.stop?.kind === 'bar') {
          // Lane lines end at the back of the stop line, to a centimetre.
          const back = fromCut(arm, layout.stop.a) + STOP_WIDTH / 2;
          expect(Math.abs(back - setback)).toBeLessThan(0.01);
          for (const p of layout.lineEnds) expect(Math.abs(fromCut(arm, p) - back)).toBeLessThan(0.01);
        }
      }
      // Crosswalks and stop lines the same distance back on every arm, to 5 cm.
      const backs = lay.filter((l) => l.layout.crosswalk).map((l) => fromCut(l.arm, l.layout.crosswalk!.a));
      for (const d of backs) expect(Math.abs(d - backs[0])).toBeLessThan(0.05);
      const stops = lay.filter((l) => l.layout.stop?.kind === 'bar').map((l) => fromCut(l.arm, l.layout.stop!.a));
      for (const d of stops) expect(Math.abs(d - stops[0])).toBeLessThan(0.05);

      // Nothing in the box but left-turn guides: no transition lines, no lane line carried through.
      expect(transitionLines(net, node)).toHaveLength(0);
      const guides = junctionGuides(net, node);
      for (const gl of guides) expect(gl.part.startsWith('T')).toBe(true);
      // Guides never cross each other or a crosswalk.
      for (let i = 0; i < guides.length; i++) {
        for (let j = i + 1; j < guides.length; j++) expect(segmentsCross(guides[i].pts, guides[j].pts)).toBe(false);
        for (const [a, b] of crosswalks) {
          const ring = band(a, b, CROSSWALK_DEPTH);
          expect(segmentsCross(ring, guides[i].pts)).toBe(false);
          expect(guides[i].pts.some((p) => inside(p, ring))).toBe(false);
        }
      }
      // The roads' own paint stays out of the junction box.
      const box = g.outline;
      for (const arm of g.arms) {
        const buf = new PaintBuf();
        buildSegmentPaint(net, arm.segmentId, buf);
        for (const p of paintVerts(buf)) if (inside(p, box)) expect(distToRing(p, box)).toBeLessThan(0.3);
      }
    });
  }

  it('big junctions get a few left-turn guides, small ones none', () => {
    const big = crossing('boulevard-8', 'avenue-6');
    const bg = junctionGuides(big, junctionOf(big));
    expect(bg.length).toBeGreaterThan(0);
    expect(bg.length).toBeLessThanOrEqual(4);
    // The main road's turns win where two would cross.
    expect(bg.some((gl) => big.roadTypeOf(gl.from).id === 'boulevard-8')).toBe(true);
    const small = crossing('street-4', 'avenue-4');
    expect(junctionGuides(small, junctionOf(small))).toHaveLength(0);
  });

  it('median edge lines end at the nose and turn round its tip', () => {
    const net = crossing('boulevard-8', 'avenue-6');
    const node = junctionOf(net);
    for (const arm of net.nodeGeom(node)!.arms) {
      if (net.roadTypeOf(arm.segmentId).id !== 'boulevard-8') continue;
      const def = net.roadTypeOf(arm.segmentId);
      const path = new StationPath(net.segmentGeom(arm.segmentId)!.stations);
      const end = arm.atStart ? -1 : 1;
      const cutS = end > 0 ? path.s1 : path.s0;
      // The tip of the nose, just in front of the kerb.
      const tip = path.at(cutS - end * (medianNoseBack(net, node) - 0.16), def.median.offset ?? 0);
      expect(medianNoseBack(net, node)).toBeGreaterThan(junctionSetback(net, node));
      const buf = new PaintBuf();
      buildSegmentPaint(net, arm.segmentId, buf);
      const near = paintVerts(buf).filter((p) => Math.hypot(p.x - tip.x, p.z - tip.z) < 0.25);
      expect(near.length).toBeGreaterThan(0);
    }
  });

  it('a signalised highway crossing gives the highway its stop lines', () => {
    const net = crossing('highway-3', 'avenue-4');
    const node = junctionOf(net);
    expect(effectiveControl(net, node).kind).toBe('signal');
    const highwayIn = layoutsAt(net, node).filter(({ arm }) => net.roadTypeOf(arm.segmentId).category === 'highway' && arm.atStart === false);
    expect(highwayIn.length).toBe(1);
    for (const { layout } of highwayIn) expect(layout.stop?.kind).toBe('bar');
  });
});
