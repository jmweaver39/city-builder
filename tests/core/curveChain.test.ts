import { describe, expect, it } from 'vitest';
import { RoadNetwork, checkNetworkInvariants, cubicTangentXZ, signedTurn, type GLane, type Id } from '../../src/core';
import { fitCurve } from '../../src/core/curveFit';
import { drawChain, hardMinRadius, smoothSegment } from '../../src/core/curveChain';
import { atNode, degreesBetween, endDir, firstPoint, free, lastPoint, startDir, v } from './helpers';

/** A highway running east to a dead end at (300, 0). */
function highway(): { net: RoadNetwork; end: Id } {
  const net = new RoadNetwork();
  const r = net.drawRoad({ start: free(0, 0), end: free(300, 0), roadType: 'highway-3' });
  return { net, end: r.nodes[1] };
}

/** Largest turn between neighbouring chords of a lane polyline, degrees. */
function maxChordTurn(lane: GLane): number {
  const n = lane.cum.length;
  let worst = 0;
  for (let i = 1; i + 1 < n; i++) {
    const p = (k: number) => v(lane.pts[k * 3], lane.pts[k * 3 + 2], lane.pts[k * 3 + 1]);
    const a = p(i - 1);
    const b = p(i);
    const c = p(i + 1);
    const d1 = v(b.x - a.x, b.z - a.z);
    const d2 = v(c.x - b.x, c.z - b.z);
    const l1 = Math.hypot(d1.x, d1.z);
    const l2 = Math.hypot(d2.x, d2.z);
    worst = Math.max(worst, degreesBetween(v(d1.x / l1, d1.z / l1), v(d2.x / l2, d2.z / l2)));
  }
  return worst;
}

function expectPlainChain(net: RoadNetwork, segments: Id[]): void {
  const graph = net.laneGraph;
  for (let i = 0; i + 1 < segments.length; i++) {
    const a = net.getSegment(segments[i])!;
    const b = net.getSegment(segments[i + 1])!;
    expect(a.b).toBe(b.a);
    const g = net.nodeGeom(a.b)!;
    expect(g.kind, `joint ${i}`).toBe('plain');
    expect(g.isPlainJoint).toBe(true);
    expect(g.outline).toHaveLength(0);
    expect(g.outerOutline).toHaveLength(0);
    const ga = net.segmentGeom(a.id)!;
    const gb = net.segmentGeom(b.id)!;
    expect(ga.trimB).toBe(0);
    expect(gb.trimA).toBe(0);
    // Centrelines meet with one tangent and one right vector, so the surfaces share an edge.
    const sa = ga.stations.at(-1)!;
    const sb = gb.stations[0];
    expect(Math.hypot(sa.pos.x - sb.pos.x, sa.pos.y - sb.pos.y, sa.pos.z - sb.pos.z)).toBeLessThan(1e-9);
    expect(degreesBetween(sa.tangent, sb.tangent)).toBeLessThan(0.01);
    expect(Math.hypot(sa.right.x - sb.right.x, sa.right.z - sb.right.z)).toBeLessThan(1e-9);
    // Lanes run straight through, with no connector in between.
    expect(graph.connectorsAt.get(a.b) ?? []).toHaveLength(0);
    const lanesA = graph.roadLanes.get(a.id)!;
    const lanesB = graph.roadLanes.get(b.id)!;
    for (const idx of lanesA) {
      const lane = graph.lanes[idx];
      const fwd = net.roadTypeOf(a.id).lanes[lane.laneIndex].dir === 1;
      // A forward lane on a hands over to a lane on b, and a backward lane on b to one on a.
      const from = fwd ? lane : graph.lanes[lanesB[lane.laneIndex]];
      expect(from.next.length, `${from.key} continues`).toBeGreaterThan(0);
      for (const n of from.next) {
        const to = graph.lanes[n];
        expect(to.kind).toBe('road');
        expect(Math.hypot(lastPoint(from).x - firstPoint(to).x, lastPoint(from).z - firstPoint(to).z), `${from.key} gap`).toBeLessThan(0.01);
        // Polylines turn at each station on a bend; the joint turns no more than they do inside.
        const inner = Math.max(maxChordTurn(from), maxChordTurn(to));
        expect(degreesBetween(endDir(from), startDir(to)), `${from.key} kink`).toBeLessThan(inner + 0.5);
      }
    }
  }
}

describe('placing a fitted chain', () => {
  it('a 270 degree ramp loop from a highway end is plain joints only', () => {
    const { net, end } = highway();
    const fit = fitCurve({ start: v(300, 0), startDir: v(1, 0), end: v(240, 60), minRadius: hardMinRadius(net.roadType('ramp-1')!) });
    expect(fit.ok).toBe(true);
    expect(fit.cubics.length).toBeGreaterThanOrEqual(6);
    const r = drawChain(net, { start: atNode(end), end: free(240, 60), cubics: fit.cubics, roadType: 'ramp-1' });
    expect(r.segments).toHaveLength(fit.cubics.length);
    expect(r.junctions).toHaveLength(0);
    expect(r.nodes).toHaveLength(fit.cubics.length + 1);
    expectPlainChain(net, r.segments);
    // Every piece is valid and the tightest radius matches the fitted arc.
    for (const id of r.segments) {
      const g = net.segmentGeom(id)!;
      expect(g.valid).toBe(true);
      expect(g.minRadius).toBeGreaterThan(fit.radius * 0.97);
    }
    expect(checkNetworkInvariants(net)).toEqual([]);
  });

  it('is one undo step', async () => {
    const { History } = await import('../../src/app/History');
    const { net, end } = highway();
    const history = new History(net);
    const before = net.segments.length;
    const fit = fitCurve({ start: v(300, 0), startDir: v(1, 0), end: v(240, 60) });
    drawChain(net, { start: atNode(end), end: free(240, 60), cubics: fit.cubics, roadType: 'ramp-1' });
    expect(net.segments.length).toBe(before + fit.cubics.length);
    history.undo();
    expect(net.segments.length).toBe(before);
  });

  it('an S-curve chain between two roads joins both with plain joints in between', () => {
    const net = new RoadNetwork();
    const a = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: 'street-2' });
    const b = net.drawRoad({ start: free(300, 50), end: free(400, 50), roadType: 'street-2' });
    const fit = fitCurve({ start: v(100, 0), startDir: v(1, 0), end: v(300, 50), endDir: v(1, 0), minRadius: 10 });
    expect(fit.kind).toBe('reverse');
    const r = drawChain(net, { start: atNode(a.nodes[1]), end: atNode(b.nodes[0]), cubics: fit.cubics, roadType: 'street-2' });
    // Both old ends are now plain joints too: the whole road is one smooth run.
    expectPlainChain(net, [a.segments[0], ...r.segments, b.segments[0]]);
    expect(checkNetworkInvariants(net)).toEqual([]);
  });

  it('crossing a road at grade still makes a junction', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(150, -200), end: free(150, 200), roadType: 'street-2' });
    const fit = fitCurve({ start: v(0, 0), startDir: v(1, 0), end: v(200, 150), minRadius: 10 });
    const r = drawChain(net, { start: free(0, 0), end: free(200, 150), cubics: fit.cubics, roadType: 'street-2' });
    expect(r.junctions).toHaveLength(1);
    expect(checkNetworkInvariants(net)).toEqual([]);
  });
});

describe('Smooth curve', () => {
  it('refits a lopsided loop, keeping ends and end tangents', () => {
    const net = new RoadNetwork();
    // The ends of a round 270 degree loop, joined by one lopsided cubic as the old
    // Freeform mode drew it: long handle at the start, short at the end.
    const ideal = fitCurve({ start: v(0, 0), startDir: v(1, 0), end: v(-70, -70), spirals: false });
    const endDir = cubicTangentXZ(ideal.cubics.at(-1)!, 1);
    const r = net.drawRoad({
      start: free(0, 0),
      end: free(-70, -70),
      c1: v(190, 0),
      c2: v(-70 - endDir.x * 50, -70 - endDir.z * 50),
      roadType: 'ramp-1',
    });
    const id = r.segments[0];
    const before = net.cubicOf(id);
    const tightBefore = net.segmentGeom(id)!.minRadius;
    const [na, nb] = [net.getSegment(id)!.a, net.getSegment(id)!.b];
    const res = smoothSegment(net, id);
    expect(res.changed, res.message).toBe(true);
    expect(res.segments[0]).toBe(id);
    // Much gentler than the cramped cubic, and about the size of the round loop.
    expect(res.fit!.radius).toBeGreaterThan(2 * tightBefore);
    expect(res.fit!.length).toBeLessThan(ideal.length * 1.4);
    expect(res.segments.length).toBeGreaterThanOrEqual(5);
    const first = net.cubicOf(res.segments[0]);
    const last = net.cubicOf(res.segments.at(-1)!);
    expect(net.getSegment(res.segments[0])!.a).toBe(na);
    expect(net.getSegment(res.segments.at(-1)!)!.b).toBe(nb);
    expect(Math.abs(signedTurn(cubicTangentXZ(first, 0), cubicTangentXZ(before, 0)))).toBeLessThan(1e-6);
    expect(Math.abs(signedTurn(cubicTangentXZ(last, 1), cubicTangentXZ(before, 1)))).toBeLessThan(1e-6);
    expectPlainChain(net, res.segments);
    expect(checkNetworkInvariants(net)).toEqual([]);
    // Smoothing again does nothing more.
    for (const piece of res.segments) expect(smoothSegment(net, piece).changed, `piece ${piece}`).toBe(false);
  });

  it('refuses a refit that would need far more room than the road had', () => {
    const net = new RoadNetwork();
    const r = net.drawRoad({ start: free(0, 0), end: free(-40, 40), c1: v(140, 0), c2: v(-110, 160), roadType: 'ramp-1' });
    const res = smoothSegment(net, r.segments[0]);
    expect(res.changed).toBe(false);
    expect(res.message).toMatch(/Redraw/);
    expect(net.segments).toHaveLength(1);
  });

  it('leaves a straight road alone', () => {
    const net = new RoadNetwork();
    const r = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: 'street-2' });
    expect(smoothSegment(net, r.segments[0]).changed).toBe(false);
  });
});
