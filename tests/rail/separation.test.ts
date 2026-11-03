import { describe, expect, it } from 'vitest';
import { RoadNetwork, crossingClearance } from '../../src/core';
import { buildFrames } from '../../src/render/frames';
import { planPiers } from '../../src/render/structures';
import { buildTrackGraph } from '../../src/rail';
import { setElectrification } from '../../src/tools/RailTools';
import { straightLine, v } from './helpers';

const errors = (net: RoadNetwork, d: Parameters<RoadNetwork['validateDraft']>[0]) =>
  net.validateDraft(d).filter((i) => i.severity === 'error');

/** A road from south to north over track running east to west, at a height in the middle. */
function overpass(net: RoadNetwork, y: number, roadType = 'street-2', x = 0) {
  return {
    start: { kind: 'free' as const, pos: v(x, -300, y) },
    end: { kind: 'free' as const, pos: v(x, 300, y) },
    roadType,
  };
}

describe('clearance between road and rail', () => {
  it('road over wired track needs 6 m, over unwired track 5 m', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-double', -800, 800);
    expect(errors(net, overpass(net, 6))).toEqual([]);
    const low = errors(net, overpass(net, 5.5));
    expect(low.map((i) => i.message).join()).toMatch(/5\.5 m clearance over track, 6 m is needed/);
    setElectrification(net, [seg], false);
    expect(errors(net, overpass(net, 5))).toEqual([]);
    expect(crossingClearance(net, net.roadType('street-2')!, 5, seg, 0)).toBe(5);
  });

  it('track over a road needs 5 m', () => {
    const net = new RoadNetwork();
    straightLine(net, 'avenue-4', -800, 800);
    const track = (y: number) => ({ start: { kind: 'free' as const, pos: v(0, -400, y) }, end: { kind: 'free' as const, pos: v(0, 400, y) }, roadType: 'rail-double' });
    expect(errors(net, track(5)).filter((i) => i.code !== 'tooSteep')).toEqual([]);
    expect(errors(net, track(4)).map((i) => i.message).join()).toMatch(/4\.0 m clearance over a road, 5 m is needed/);
  });

  it('main line can cross at grade, metro never', () => {
    const net = new RoadNetwork();
    straightLine(net, 'rail-double', -800, 800);
    expect(errors(net, overpass(net, 0))).toEqual([]);
    const metro = new RoadNetwork();
    straightLine(metro, 'metro-double', -800, 800);
    expect(errors(metro, overpass(metro, 0)).map((i) => i.code)).toContain('railCrossing');
    expect(errors(metro, overpass(metro, 3)).map((i) => i.code)).toContain('insufficientClearance');
  });

  it('a road may run along right above a subway, and a bridge over track makes no junction or connector', () => {
    const net = new RoadNetwork();
    net.addSegment(net.addNode(v(-800, 0, -12)), net.addNode(v(800, 0, -12)), { roadType: 'metro-double' });
    const along = { start: { kind: 'free' as const, pos: v(-600, 0) }, end: { kind: 'free' as const, pos: v(600, 0) }, roadType: 'avenue-4' };
    expect(errors(net, along)).toEqual([]);
    const r = net.drawRoad(along);
    expect(r.junctions).toEqual([]);

    const over = new RoadNetwork();
    straightLine(over, 'rail-double', -800, 800);
    const b = over.drawRoad(overpass(over, 6));
    expect(b.junctions).toEqual([]);
    const g = over.laneGraph;
    for (const lane of g.lanes) {
      if (lane.kind !== 'connector') continue;
      expect(g.lanes[lane.fromLane].vehicleKind === 'rail').toBe(g.lanes[lane.toLane].vehicleKind === 'rail');
    }
    expect(buildTrackGraph(over).crossings).toHaveLength(0);
    expect(over.nodes.every((n) => n.segments.every((s) => over.roadTypeOf(s).category === 'rail') || n.segments.every((s) => over.roadTypeOf(s).category !== 'rail'))).toBe(true);
  });

  it('roads pass over and under stations, never through them', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-double', -800, 800);
    net.addStation({ name: 'Mid', kind: 'surface', segmentId: seg, t: 0.5, platformLength: 200, layout: 'both' });
    // Along the platform at grade, beside the tracks: through the platform.
    const through = { start: { kind: 'free' as const, pos: v(-90, 10) }, end: { kind: 'free' as const, pos: v(90, 10) }, roadType: 'street-2' };
    expect(errors(net, through).map((i) => i.message).join()).toMatch(/through Mid station/);
    expect(errors(net, overpass(net, 8))).toEqual([]);
  });
});

/** Column circles against what lies below, with no margin: lanes, track beds, platforms. */
function columnsHitBelow(net: RoadNetwork, deck: number): string[] {
  const def = net.roadTypeOf(deck);
  const geom = net.segmentGeom(deck)!;
  const plan = planPiers(net, deck, def, buildFrames(geom.stations));
  const hits: string[] = [];
  for (const p of plan.piers) {
    for (const c of p.columns) {
      for (const s of net.segments) {
        if (s.id === deck) continue;
        const sd = net.roadTypeOf(s.id);
        const cu = net.cubicOf(s.id);
        if (Math.max(cu.p0.y, cu.p3.y) > p.f.y - 2) continue;
        for (let i = 0; i <= 200; i++) {
          const t = i / 200;
          const u = 1 - t;
          const x = u * u * u * cu.p0.x + 3 * u * u * t * cu.p1.x + 3 * u * t * t * cu.p2.x + t * t * t * cu.p3.x;
          const z = u * u * u * cu.p0.z + 3 * u * u * t * cu.p1.z + 3 * u * t * t * cu.p2.z + t * t * t * cu.p3.z;
          if (Math.hypot(x - c.x, z - c.z) < c.r + sd.halfWidth + sd.sidewalk) {
            hits.push(`${p.kind} at ${Math.round(p.f.s)} in ${sd.name}`);
            break;
          }
        }
      }
    }
  }
  return hits;
}

describe('supports clear of what is below', () => {
  it('a skewed road bridge over a double track', () => {
    const net = new RoadNetwork();
    straightLine(net, 'rail-double', -800, 800);
    const r = net.drawRoad({ start: { kind: 'free', pos: v(-260, -300, 8) }, end: { kind: 'free', pos: v(260, 300, 8) }, roadType: 'avenue-4' });
    expect(columnsHitBelow(net, r.segments[0])).toEqual([]);
  });

  it('a road bridge over three double tracks side by side', () => {
    const net = new RoadNetwork();
    for (const z of [-14, 0, 14]) net.addSegment(net.addNode(v(-800, z)), net.addNode(v(800, z)), { roadType: 'rail-double' });
    const r = net.drawRoad(overpass(net, 8, 'street-4'));
    expect(columnsHitBelow(net, r.segments[0])).toEqual([]);
  });

  it('a rail viaduct over a highway, square and skewed', () => {
    for (const skew of [0, 180]) {
      const net = new RoadNetwork();
      const h = net.addSegment(net.addNode(v(-800, 0)), net.addNode(v(800, 0)), { roadType: 'dual-6' });
      void h;
      const r = net.drawRoad({ start: { kind: 'free', pos: v(-skew, -500, 9) }, end: { kind: 'free', pos: v(skew, 500, 9) }, roadType: 'rail-double' });
      expect(columnsHitBelow(net, r.segments[0]), `skew ${skew}`).toEqual([]);
      // And something does hold the deck up near the highway: a pier, portal or girder.
      const plan = planPiers(net, r.segments[0], net.roadTypeOf(r.segments[0]), buildFrames(net.segmentGeom(r.segments[0])!.stations));
      expect(plan.piers.length + plan.girders.length).toBeGreaterThan(0);
    }
  });

  it('piers miss a platform below', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'rail-double', -800, 800);
    net.addStation({ name: 'Under', kind: 'surface', segmentId: seg, t: 0.5, platformLength: 300, layout: 'both' });
    // A road bridge running along above the platform, 8 m up, offset onto the platform side.
    const r = net.drawRoad({ start: { kind: 'free', pos: v(-300, 30, 8) }, end: { kind: 'free', pos: v(300, -30, 8) }, roadType: 'street-2' });
    const plan = planPiers(net, r.segments[0], net.roadTypeOf(r.segments[0]), buildFrames(net.segmentGeom(r.segments[0])!.stations));
    for (const p of plan.piers) for (const c of p.columns) expect(Math.abs(c.z) > 2.25 + 1.65 + 5 + c.r || Math.abs(c.x) > 150 + c.r, `column at ${c.x}, ${c.z}`).toBe(true);
  });
});
