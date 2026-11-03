import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROAD_TYPES,
  RIVER_DEPTH,
  arcLengthTable,
  builtinRoadType,
  closestPointOnCubic,
  cubicLength,
  cubicPoint,
  cubicTangent,
  curvatureXZ,
  dist,
  driveLaneCount,
  effectiveLanes,
  intersectCubicsXZ,
  isOneWay,
  isStraightCubic,
  isWater,
  lengthAtT,
  makeCustomRoadType,
  offsetPoint,
  riverCentreZ,
  riverDistance,
  rightOf,
  roadLevel,
  roadTypeProblems,
  signedTurn,
  splitCubic,
  straightCubic,
  subCubic,
  tAtLength,
  terrainHeight,
  wrapAngle,
  type Cubic,
} from '../../src/core';
import { v } from './helpers';

const arc: Cubic = { p0: v(0, 0), p1: v(55.23, 0), p2: v(100, 44.77), p3: v(100, 100) };

describe('math', () => {
  it('uses the right vector (-f.z, 0, f.x)', () => {
    expect(rightOf(v(1, 0))).toEqual({ x: -0, y: 0, z: 1 });
    expect(rightOf(v(0, 1))).toEqual({ x: -1, y: 0, z: 0 });
    const r = rightOf(v(3, 4));
    expect(r.x).toBeCloseTo(-0.8);
    expect(r.z).toBeCloseTo(0.6);
  });

  it('counts turns to the right as positive', () => {
    expect(signedTurn(v(1, 0), rightOf(v(1, 0)))).toBeCloseTo(Math.PI / 2);
    expect(signedTurn(v(1, 0), v(0, -1))).toBeCloseTo(-Math.PI / 2);
  });

  it('wraps angles', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-0.5 + 2 * Math.PI)).toBeCloseTo(-0.5);
  });
});

describe('bezier', () => {
  it('evaluates end points', () => {
    expect(cubicPoint(arc, 0)).toEqual(arc.p0);
    expect(dist(cubicPoint(arc, 1), arc.p3)).toBeLessThan(1e-12);
  });

  it('measures arc length close to a quarter circle', () => {
    expect(cubicLength(arc, 256)).toBeCloseTo((Math.PI * 100) / 2, 0);
  });

  it('round-trips arc length and t', () => {
    const table = arcLengthTable(arc, 128);
    for (const t of [0, 0.1, 0.37, 0.5, 0.91, 1]) {
      expect(tAtLength(table, lengthAtT(table, t))).toBeCloseTo(t, 6);
    }
    expect(tAtLength(table, -5)).toBe(0);
    expect(tAtLength(table, 1e9)).toBe(1);
  });

  it('measures curvature with the right sign', () => {
    expect(curvatureXZ(arc, 0.5)).toBeCloseTo(1 / 100, 3);
    const mirrored: Cubic = { p0: v(0, 0), p1: v(55.23, 0), p2: v(100, -44.77), p3: v(100, -100) };
    expect(curvatureXZ(mirrored, 0.5)).toBeCloseTo(-1 / 100, 3);
  });

  it('splits without moving the curve', () => {
    const [l, r] = splitCubic(arc, 0.3);
    for (let i = 0; i <= 50; i++) {
      const t = i / 50;
      expect(dist(cubicPoint(l, t), cubicPoint(arc, t * 0.3))).toBeLessThan(1e-9);
      expect(dist(cubicPoint(r, t), cubicPoint(arc, 0.3 + t * 0.7))).toBeLessThan(1e-9);
    }
    const mid = subCubic(arc, 0.2, 0.7);
    expect(dist(cubicPoint(mid, 0.5), cubicPoint(arc, 0.45))).toBeLessThan(1e-9);
  });

  it('finds the closest point', () => {
    const hit = closestPointOnCubic(arc, v(100, 100));
    expect(hit.t).toBe(1);
    const line = straightCubic(v(0, 0), v(100, 0));
    const onLine = closestPointOnCubic(line, v(37, 12));
    expect(onLine.point.x).toBeCloseTo(37, 6);
    expect(onLine.distance).toBeCloseTo(12, 6);
    // Plan distance ignores height unless asked.
    const high = closestPointOnCubic(line, v(50, 0, 30));
    expect(high.distance).toBeCloseTo(0, 6);
    expect(closestPointOnCubic(line, v(50, 0, 30), false).distance).toBeCloseTo(30, 6);
  });

  it('intersects curves in plan view', () => {
    const a = straightCubic(v(-100, 0), v(100, 0));
    const b = straightCubic(v(0, -100, 5), v(0, 100, 5));
    const hits = intersectCubicsXZ(a, b);
    expect(hits).toHaveLength(1);
    expect(hits[0].ta).toBeCloseTo(0.5, 6);
    expect(hits[0].tb).toBeCloseTo(0.5, 6);
  });

  it('finds both crossings of an arch', () => {
    const line = straightCubic(v(-100, 0), v(100, 0));
    const arch: Cubic = { p0: v(-60, -40), p1: v(-60, 90), p2: v(60, 90), p3: v(60, -40) };
    const hits = intersectCubicsXZ(line, arch);
    expect(hits).toHaveLength(2);
    expect(hits[0].point.x).toBeLessThan(0);
    expect(hits[1].point.x).toBeGreaterThan(0);
  });

  it('reports no crossing for apart curves', () => {
    expect(intersectCubicsXZ(straightCubic(v(0, 0), v(10, 0)), straightCubic(v(0, 5), v(10, 5)))).toEqual([]);
  });

  it('offsets to the right of travel', () => {
    const line = straightCubic(v(0, 0), v(100, 0));
    const p = offsetPoint(line, 0.5, 3);
    expect(p.z).toBeCloseTo(3);
    expect(p.x).toBeCloseTo(50);
  });

  it('survives a control point on its end point', () => {
    const c: Cubic = { p0: v(0, 0), p1: v(0, 0), p2: v(0, 0), p3: v(10, 0) };
    expect(cubicTangent(c, 0).x).toBeCloseTo(1);
    expect(isStraightCubic(straightCubic(v(0, 0), v(50, 7, 3)))).toBe(true);
    expect(isStraightCubic(arc)).toBe(false);
  });
});

describe('terrain', () => {
  it('is deterministic and flat away from the river', () => {
    expect(terrainHeight(123.4, -1500)).toBe(terrainHeight(123.4, -1500));
    expect(terrainHeight(0, 0)).toBe(0);
    expect(terrainHeight(-1900, -1900)).toBe(0);
    expect(isWater(0, 0)).toBe(false);
  });

  it('has a channel about 60 m wide and 5 m deep crossing the map', () => {
    for (const x of [-1990, -1200, -300, 0, 800, 1990]) {
      const z = riverCentreZ(x);
      expect(terrainHeight(x, z)).toBeCloseTo(-RIVER_DEPTH, 5);
      expect(isWater(x, z)).toBe(true);
      expect(isWater(x, z + 200)).toBe(false);
      expect(terrainHeight(x, z + 200)).toBe(0);
    }
    // Measure the width straight across the channel at a gentle spot.
    const x = 500;
    let wet = 0;
    for (let z = riverCentreZ(x) - 300; z < riverCentreZ(x) + 300; z += 0.5) if (isWater(x, z)) wet += 0.5;
    const m = (riverCentreZ(x + 1) - riverCentreZ(x - 1)) / 2;
    expect(wet / Math.sqrt(1 + m * m)).toBeGreaterThan(50);
    expect(wet / Math.sqrt(1 + m * m)).toBeLessThan(70);
  });

  it('has smooth banks', () => {
    const x = -700;
    let prev = terrainHeight(x, riverCentreZ(x) - 80);
    for (let z = riverCentreZ(x) - 80; z < riverCentreZ(x) + 80; z += 0.25) {
      const h = terrainHeight(x, z);
      expect(Math.abs(h - prev)).toBeLessThan(0.15);
      prev = h;
    }
  });

  it('raises hills past the map edge, continuously', () => {
    expect(terrainHeight(2000, -1500)).toBe(0);
    expect(terrainHeight(2010, -1500)).toBeLessThan(2);
    expect(terrainHeight(2800, -1500)).toBeGreaterThan(50);
    expect(terrainHeight(-1500, -3000)).toBeGreaterThan(50);
    expect(riverDistance(0, riverCentreZ(0))).toBe(0);
  });

  it('classifies road levels against terrain', () => {
    expect(roadLevel(v(0, 0, 0))).toBe('ground');
    expect(roadLevel(v(0, 0, 8))).toBe('bridge');
    expect(roadLevel(v(0, 0, -8))).toBe('tunnel');
    const z = riverCentreZ(0);
    expect(roadLevel(v(0, z, 0))).toBe('bridge');
  });
});

describe('road types', () => {
  it('provides the required catalogue', () => {
    for (const id of [
      'street-2', 'street-2-bike', 'street-2-oneway', 'street-4', 'avenue-4', 'avenue-6', 'avenue-4-bus',
      'boulevard-8', 'highway-2', 'highway-3', 'highway-4', 'highway-5', 'dual-4', 'dual-6', 'ramp-1', 'ramp-2',
    ]) {
      expect(builtinRoadType(id), id).toBeDefined();
    }
    expect(new Set(BUILTIN_ROAD_TYPES.map((t) => t.id)).size).toBe(BUILTIN_ROAD_TYPES.length);
  });

  it.each(BUILTIN_ROAD_TYPES.map((t) => [t.id, t] as const))('%s obeys the lane conventions', (_id, def) => {
    expect(roadTypeProblems(def)).toEqual([]);
    for (let i = 1; i < def.lanes.length; i++) expect(def.lanes[i].offset).toBeGreaterThan(def.lanes[i - 1].offset);
    const extent = Math.max(...def.lanes.map((l) => Math.abs(l.offset) + l.width / 2));
    expect(extent + def.shoulder).toBeCloseTo(def.halfWidth, 6);
    if (isOneWay(def)) expect(def.lanes.every((l) => l.dir === 1)).toBe(true);
    else {
      expect(def.lanes.every((l) => (l.dir === 1) === l.offset > 0)).toBe(true);
    }
  });

  it('has the right lane counts and features', () => {
    const count = (id: string) => driveLaneCount(builtinRoadType(id)!);
    expect(count('street-2')).toBe(2);
    expect(count('street-4')).toBe(4);
    expect(count('avenue-6')).toBe(6);
    expect(count('boulevard-8')).toBe(8);
    expect(count('highway-5')).toBe(5);
    expect(count('dual-6')).toBe(6);
    expect(count('ramp-2')).toBe(2);
    expect(builtinRoadType('street-2-bike')!.lanes.filter((l) => l.kind === 'bike')).toHaveLength(2);
    expect(builtinRoadType('avenue-4-bus')!.lanes.filter((l) => l.kind === 'bus')).toHaveLength(2);
    expect(builtinRoadType('highway-3')!.sidewalk).toBe(0);
    expect(builtinRoadType('highway-3')!.shoulder).toBeGreaterThan(0);
    expect(builtinRoadType('dual-4')!.median.kind).toBe('barrier');
    expect(builtinRoadType('avenue-4')!.median.kind).toBe('grass');
    expect(isOneWay(builtinRoadType('ramp-1')!)).toBe(true);
    expect(isOneWay(builtinRoadType('street-2-oneway')!)).toBe(true);
  });

  it('paints sensible default markings', () => {
    const street = builtinRoadType('street-2')!.markings;
    expect(street.centerLine).toBe('double');
    expect(street.centerColor).toBe('yellow');
    expect(street.crosswalk).toBe('zebra');
    const highway = builtinRoadType('highway-3')!.markings;
    expect(highway.laneLine).toBe('dashed');
    expect(highway.laneColor).toBe('white');
    expect(highway.edgeLine).toBe('solid');
    expect(highway.centerLine).toBe('none');
    expect(highway.stopLines).toBe(false);
  });

  it('puts the bike lane outside the bus lane, on the right of each direction', () => {
    const def = makeCustomRoadType({ forwardLanes: 2, backwardLanes: 2, busLanes: true, bikeLanes: true });
    const kinds = def.lanes.map((l) => l.kind);
    expect(kinds).toEqual(['bike', 'bus', 'drive', 'drive', 'drive', 'drive', 'bus', 'bike']);
    expect(roadTypeProblems(def)).toEqual([]);
  });

  it('builds a valid custom road, clamping nonsense', () => {
    const def = makeCustomRoadType({
      forwardLanes: 3,
      backwardLanes: 1,
      laneWidth: 99,
      medianWidth: 2,
      medianKind: 'paint',
      sidewalkWidth: -4,
      shoulder: Number.NaN,
      speedKmh: 9999,
    });
    expect(roadTypeProblems(def)).toEqual([]);
    expect(def.lanes.every((l) => l.width <= 5)).toBe(true);
    expect(def.sidewalk).toBe(0);
    expect(def.speedKmh).toBe(160);
    expect(driveLaneCount(def, 1)).toBe(3);
    expect(driveLaneCount(def, -1)).toBe(1);
  });

  it('normalises backward-only roads and refuses no lanes', () => {
    const def = makeCustomRoadType({ forwardLanes: 0, backwardLanes: 2 });
    expect(isOneWay(def)).toBe(true);
    expect(def.lanes).toHaveLength(2);
    expect(() => makeCustomRoadType({ forwardLanes: 0, backwardLanes: 0 })).toThrow(/lane/);
  });

  it('applies lane kind overrides', () => {
    const def = builtinRoadType('street-4')!;
    const lanes = effectiveLanes(def, { laneKinds: { 0: 'bus' } });
    expect(lanes[0].kind).toBe('bus');
    expect(def.lanes[0].kind).toBe('drive');
  });
});
