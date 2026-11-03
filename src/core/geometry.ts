/**
 * Segment geometry: the arc-length parameterised curve with curvature-adaptive
 * stations, the trimmed SegmentGeom, and offset polylines for lanes and edges.
 */
import type { Id, LaneDef, RoadTypeDef, SegmentGeom, Station, Vec3 } from './types';
import {
  arcLengthTable,
  cubicPoint,
  cubicTangent,
  curvatureXZ,
  isStraightCubic,
  tAtLength,
  type ArcTable,
  type Cubic,
} from './bezier';
import { addScaled, angleBetween, clamp, dist, rightOf, sub } from './math';

/** Most lateral turn allowed between two stations. */
const MAX_STATION_TURN = 0.055;
const MAX_SPACING_CURVED = 16;
const MAX_SPACING_STRAIGHT = 48;
/** Less visible road than this means nothing is left. */
export const MIN_VISIBLE_LENGTH = 0.05;

/** Everything about a segment's full curve that does not depend on junctions. */
export interface SegmentCurve {
  cubic: Cubic;
  table: ArcTable;
  length: number;
  straight: boolean;
  /** Full-span stations, tighter on bends. Shared, do not mutate. */
  stations: Station[];
  /** |plan curvature| at each table entry. Null on a straight curve. */
  curvature: Float64Array | null;
}

function makeStation(c: Cubic, t: number, s: number, prevRight?: Vec3): Station {
  const pos = cubicPoint(c, t);
  const tangent = cubicTangent(c, t);
  const right = rightOf(tangent, prevRight);
  return { pos, tangent, right, s, t };
}

function tableSteps(c: Cubic): number {
  const polygon = dist(c.p0, c.p1) + dist(c.p1, c.p2) + dist(c.p2, c.p3);
  const a = sub(c.p1, c.p0);
  const b = sub(c.p2, c.p1);
  const d = sub(c.p3, c.p2);
  // Control polygon turning bounds the curve's total turning.
  const turn = angleBetween(a, b) + angleBetween(b, d);
  return clamp(Math.ceil(Math.max(polygon / 2.5, turn / 0.04)), 12, 480);
}

export function buildSegmentCurve(cubic: Cubic): SegmentCurve {
  const straight = isStraightCubic(cubic);
  const table = arcLengthTable(cubic, straight ? 16 : tableSteps(cubic));
  const n = table.ts.length - 1;
  const L = table.length;
  const stations: Station[] = [];

  if (straight) {
    const count = Math.max(1, Math.ceil(L / MAX_SPACING_STRAIGHT));
    const first = makeStation(cubic, 0, 0);
    stations.push(first);
    for (let i = 1; i < count; i++) {
      const s = (L * i) / count;
      stations.push(makeStation(cubic, tAtLength(table, s), s, first.right));
    }
    stations.push(makeStation(cubic, 1, L, first.right));
    return { cubic, table, length: L, straight, stations, curvature: null };
  }

  const curvature = new Float64Array(n + 1);
  let last = makeStation(cubic, 0, 0);
  stations.push(last);
  let prevT = last.tangent;
  let turned = 0;
  for (let i = 0; i <= n; i++) {
    const t = table.ts[i];
    curvature[i] = Math.abs(curvatureXZ(cubic, t));
    if (i === 0) continue;
    const tan = cubicTangent(cubic, t);
    turned += angleBetween(prevT, tan);
    prevT = tan;
    if (i === n) break;
    const s = table.ss[i];
    if (turned >= MAX_STATION_TURN || s - last.s >= MAX_SPACING_CURVED) {
      last = makeStation(cubic, t, s, last.right);
      stations.push(last);
      turned = 0;
    }
  }
  stations.push(makeStation(cubic, 1, L, last.right));
  return { cubic, table, length: L, straight, stations, curvature };
}

/** Exact station at arc length s along the full curve. */
export function stationAt(curve: SegmentCurve, s: number): Station {
  const clamped = clamp(s, 0, curve.length);
  return makeStation(curve.cubic, tAtLength(curve.table, clamped), clamped, curve.stations[0].right);
}

export interface GeomOptions {
  /** Replaces the right vector of the first or last station. Used at plain joints. */
  rightA?: Vec3 | null;
  rightB?: Vec3 | null;
  /** Half road width used to judge whether a bend is too tight. */
  halfWidth: number;
}

function visibleMinRadius(curve: SegmentCurve, s0: number, s1: number): number {
  if (!curve.curvature) return Infinity;
  const { ss } = curve.table;
  let k = 0;
  for (let i = 0; i < ss.length; i++) {
    if (ss[i] < s0) continue;
    if (ss[i] > s1) break;
    if (curve.curvature[i] > k) k = curve.curvature[i];
  }
  return k > 1e-9 ? 1 / k : Infinity;
}

/** The visible span of a segment between its two junction trims. */
export function buildSegmentGeom(
  segmentId: Id,
  curve: SegmentCurve,
  trimA: number,
  trimB: number,
  opts: GeomOptions,
): SegmentGeom {
  const L = curve.length;
  const visible = L - trimA - trimB;
  if (!(visible >= MIN_VISIBLE_LENGTH)) {
    return {
      segmentId,
      stations: [],
      fullLength: L,
      trimA,
      trimB,
      length: Math.max(0, visible),
      valid: false,
      minRadius: Infinity,
    };
  }
  const endS = L - trimB;
  const stations: Station[] = [];
  let first = trimA > 0 ? stationAt(curve, trimA) : curve.stations[0];
  if (opts.rightA) first = { ...first, right: opts.rightA };
  stations.push(first);
  const gap = Math.min(0.02, visible / 4);
  for (const st of curve.stations) {
    if (st.s > trimA + gap && st.s < endS - gap) stations.push(st);
  }
  let last = trimB > 0 ? stationAt(curve, endS) : curve.stations[curve.stations.length - 1];
  if (opts.rightB) last = { ...last, right: opts.rightB };
  stations.push(last);

  const minRadius = visibleMinRadius(curve, trimA, endS);
  return {
    segmentId,
    stations,
    fullLength: L,
    trimA,
    trimB,
    length: visible,
    valid: minRadius > opts.halfWidth,
    minRadius,
  };
}

/** Points offset from the stations, a to b. Positive offset is right of a-to-b. */
export function offsetPolyline(stations: readonly Station[], offset: number): Vec3[] {
  return stations.map((st) => addScaled(st.pos, st.right, offset));
}

export interface PolylineData {
  pts: Float32Array;
  cum: Float32Array;
  length: number;
}

/** Smallest step kept in a stored polyline, so cum is strictly increasing in float32. */
const MIN_POINT_GAP = 0.01;

/**
 * Compact a list of positions into typed arrays. Points closer than 1 cm are
 * dropped so cum stays strictly increasing. Null when the path has no length.
 */
export function toPolylineData(xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>): PolylineData | null {
  const n = xs.length;
  if (n < 2) return null;
  const keep: number[] = [0];
  let lx = xs[0];
  let ly = ys[0];
  let lz = zs[0];
  for (let i = 1; i < n; i++) {
    const dx = xs[i] - lx;
    const dy = ys[i] - ly;
    const dz = zs[i] - lz;
    if (dx * dx + dy * dy + dz * dz < MIN_POINT_GAP * MIN_POINT_GAP) continue;
    keep.push(i);
    lx = xs[i];
    ly = ys[i];
    lz = zs[i];
  }
  // The exact last point must survive: it is what connectors attach to.
  if (keep[keep.length - 1] !== n - 1) {
    if (keep.length === 1) keep.push(n - 1);
    else keep[keep.length - 1] = n - 1;
  }
  const m = keep.length;
  if (m < 2) return null;
  const pts = new Float32Array(m * 3);
  const cum = new Float32Array(m);
  let total = 0;
  let px = xs[keep[0]];
  let py = ys[keep[0]];
  let pz = zs[keep[0]];
  for (let k = 0; k < m; k++) {
    const i = keep[k];
    const x = xs[i];
    const y = ys[i];
    const z = zs[i];
    const dx = x - px;
    const dy = y - py;
    const dz = z - pz;
    total += Math.sqrt(dx * dx + dy * dy + dz * dz);
    pts[k * 3] = x;
    pts[k * 3 + 1] = y;
    pts[k * 3 + 2] = z;
    cum[k] = total;
    px = x;
    py = y;
    pz = z;
  }
  if (total < MIN_POINT_GAP) return null;
  return { pts, cum, length: cum[m - 1] };
}

/** One lane's path in its direction of travel. */
export function lanePolyline(geom: SegmentGeom, lane: Pick<LaneDef, 'offset' | 'dir'>): PolylineData | null {
  const st = geom.stations;
  const n = st.length;
  if (n < 2) return null;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const zs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = st[lane.dir === 1 ? i : n - 1 - i];
    xs[i] = s.pos.x + s.right.x * lane.offset;
    ys[i] = s.pos.y;
    zs[i] = s.pos.z + s.right.z * lane.offset;
  }
  return toPolylineData(xs, ys, zs);
}

export interface RoadEdges {
  /** Carriageway edges, a to b. Left and right of a-to-b travel. */
  left: Vec3[];
  right: Vec3[];
  /** Outer edge of the sidewalk. Same as left and right when there is none. */
  outerLeft: Vec3[];
  outerRight: Vec3[];
}

export function roadEdges(geom: SegmentGeom, def: RoadTypeDef): RoadEdges {
  const left = offsetPolyline(geom.stations, -def.halfWidth);
  const right = offsetPolyline(geom.stations, def.halfWidth);
  const walkLeft = def.sidewalkLeft ?? def.sidewalk;
  const walkRight = def.sidewalkRight ?? def.sidewalk;
  return {
    left,
    right,
    outerLeft: walkLeft > 0 ? offsetPolyline(geom.stations, -(def.halfWidth + walkLeft)) : left,
    outerRight: walkRight > 0 ? offsetPolyline(geom.stations, def.halfWidth + walkRight) : right,
  };
}

/** Largest grade |dy/dh| along a curve, for the steepness checks. */
export function maxGrade(cubic: Cubic, samples = 32): number {
  let worst = 0;
  for (let i = 0; i <= samples; i++) {
    const tan = cubicTangent(cubic, i / samples);
    const h = Math.sqrt(tan.x * tan.x + tan.z * tan.z);
    const grade = h < 1e-6 ? Infinity : Math.abs(tan.y) / h;
    if (grade > worst) worst = grade;
  }
  return worst;
}
