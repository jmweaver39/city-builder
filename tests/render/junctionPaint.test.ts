import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core/RoadNetwork';
import { makeCustomRoadType } from '../../src/core/roadTypes';
import type { Id, NodeArm, Vec3 } from '../../src/core/types';
import { armEndLayout, fitDashes, junctionGuides, junctionSetback } from '../../src/render/markings';

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

  it('uneven custom road through a junction, with guides across the type change', () => {
    const net = new RoadNetwork();
    const uneven = makeCustomRoadType({ id: 'uneven', forwardLanes: 2, backwardLanes: 1, sidewalkWidth: 2 });
    net.setCustomRoadType(uneven);
    const west = net.drawRoad({ start: free(v(-200, 0)), end: free(v(0, 0)), roadType: 'uneven' });
    const mid = { kind: 'node' as const, id: west.nodes[west.nodes.length - 1] };
    net.drawRoad({ start: mid, end: free(v(200, 0)), roadType: 'street-4' });
    net.drawRoad({ start: mid, end: free(v(0, 200)), roadType: 'street-2' });
    const node = junctionOf(net);
    expectSquareEnds(net, node);
    expect(expectGuidesOnCuts(net, node)).toBeGreaterThan(0);
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
