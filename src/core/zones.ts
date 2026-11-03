/**
 * Zoned regions: where they really are, what they generate, and the geometry the
 * zoning tools need. A region is cut by roads, water, the map edge and any region
 * placed after it, so the zoned area is sampled on a grid rather than stored.
 */
import { closestPointOnCubic, cubicTangentXZ, offsetPoint } from './bezier';
import type { RoadNetwork } from './RoadNetwork';
import { visibleSpan } from './roadPaint';
import { totalHalfWidth } from './roadTypes';
import { isWater, MAP_HALF_SIZE, terrainHeight } from './terrain';
import type { Id, Vec3, ZoneAnchor, ZoneDensity, ZoneKind, ZoneRegion, ZoneSettings } from './types';

/** Sampling grid for zoned area, in metres. */
export const ZONE_STEP = 4;
/** Grid for finding blocks. Finer, so narrow blocks are not lost. */
const BLOCK_STEP = 2;
const BLOCK_WINDOW = 720;
const MIN_AREA = 120;
const MAX_ACCESS = 8;
const ACCESS_SPACING = 60;

export const DEFAULT_ZONE_SETTINGS: ZoneSettings = { depth: 40, setback: 2, snap: true, snapDistance: 8, excludeFast: true };

export const FAST_CATEGORIES: ReadonlySet<string> = new Set(['highway', 'ramp', 'rail']);

export function isFastRoad(net: RoadNetwork, segmentId: Id): boolean {
  return FAST_CATEGORIES.has(net.roadTypeOf(segmentId).category);
}

/** Below ground roads leave the surface free. */
function tunnelAt(net: RoadNetwork, segmentId: Id, t: number): boolean {
  const p = offsetPoint(net.cubicOf(segmentId), t, 0);
  return p.y < terrainHeight(p.x, p.z) - 1.5;
}

export function anchorPoint(net: RoadNetwork, a: ZoneAnchor): Vec3 | null {
  if (!net.getSegment(a.segmentId)) return null;
  const p = offsetPoint(net.cubicOf(a.segmentId), Math.min(1, Math.max(0, a.t)), a.offset);
  return { x: p.x, y: terrainHeight(p.x, p.z), z: p.z };
}

/** The region's corners as they stand, with held corners following their roads. */
export function zonePolygon(net: RoadNetwork, region: Pick<ZoneRegion, 'polygon' | 'anchors'>): Vec3[] {
  return region.polygon.map((p, i) => {
    const a = region.anchors?.[i];
    return (a && anchorPoint(net, a)) || p;
  });
}

export function pointInPolygon(x: number, z: number, poly: readonly Vec3[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly: readonly Vec3[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j].x * poly[i].z - poly[i].x * poly[j].z;
  return Math.abs(s) / 2;
}

function bounds(poly: readonly Vec3[]): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX, minZ, maxX, maxZ };
}

/** True where a road, with a margin, covers the ground. */
export function onRoad(net: RoadNetwork, x: number, z: number, margin: number): boolean {
  const reach = 40;
  for (const id of net.segmentsInRegion({ minX: x - reach, minZ: z - reach, maxX: x + reach, maxZ: z + reach }, true)) {
    const hit = closestPointOnCubic(net.cubicOf(id), { x, y: 0, z });
    if (hit.distance > totalHalfWidth(net.roadTypeOf(id)) + margin) continue;
    if (tunnelAt(net, id, hit.t)) continue;
    return true;
  }
  return false;
}

export function groundUsable(x: number, z: number): boolean {
  return Math.abs(x) <= MAP_HALF_SIZE && Math.abs(z) <= MAP_HALF_SIZE && !isWater(x, z);
}

export interface Coverage {
  /** Centres of the grid cells really zoned. */
  cells: { x: number; z: number }[];
  area: number;
}

/** Cells inside a polygon that are free ground, not under any polygon in `above`. */
export function coverageOf(net: RoadNetwork, poly: readonly Vec3[], setback: number, above: readonly Vec3[][] = []): Coverage {
  const cells: { x: number; z: number }[] = [];
  if (poly.length < 3) return { cells, area: 0 };
  const box = bounds(poly);
  const aboveBoxes = above.map((p) => ({ p, b: bounds(p) }));
  const half = ZONE_STEP / 2;
  for (let x = Math.floor(box.minX / ZONE_STEP) * ZONE_STEP + half; x < box.maxX; x += ZONE_STEP) {
    for (let z = Math.floor(box.minZ / ZONE_STEP) * ZONE_STEP + half; z < box.maxZ; z += ZONE_STEP) {
      if (!pointInPolygon(x, z, poly) || !groundUsable(x, z)) continue;
      let hidden = false;
      for (const { p, b } of aboveBoxes) {
        if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
        if (pointInPolygon(x, z, p)) {
          hidden = true;
          break;
        }
      }
      if (hidden || onRoad(net, x, z, setback + half * 0.5)) continue;
      cells.push({ x, z });
    }
  }
  return { cells, area: cells.length * ZONE_STEP * ZONE_STEP };
}

const coverageCache = new WeakMap<RoadNetwork, { version: number; byId: Map<Id, Coverage> }>();

/** What a region really zones, given the roads and the regions placed after it. */
export function zoneCoverage(net: RoadNetwork, regionId: Id): Coverage {
  let cache = coverageCache.get(net);
  if (!cache || cache.version !== net.version) {
    cache = { version: net.version, byId: new Map() };
    coverageCache.set(net, cache);
  }
  const hit = cache.byId.get(regionId);
  if (hit) return hit;
  const zones = net.project.zones ?? [];
  const i = zones.findIndex((z) => z.id === regionId);
  if (i < 0) return { cells: [], area: 0 };
  const region = zones[i];
  const above = zones.slice(i + 1).map((z) => zonePolygon(net, z));
  const result = coverageOf(net, zonePolygon(net, region), region.settings.setback, above);
  cache.byId.set(regionId, result);
  return result;
}

const PER_SQM: Record<ZoneKind, number> = { residential: 0.004, commercial: 0.003, industrial: 0.0022, office: 0.003 };
const PULL: Record<ZoneKind, number> = { residential: 0.6, commercial: 3, industrial: 1.5, office: 2.4 };
const DENSITY: Record<ZoneDensity, number> = { low: 1, medium: 2, high: 4 };

/** Vehicles per hour generated, and pull as a destination, for an area. */
export function zoneRates(kind: ZoneKind, density: ZoneDensity, area: number): { ratePerHour: number; attraction: number } {
  const k = DENSITY[density];
  return {
    ratePerHour: Math.round(area * PER_SQM[kind] * k),
    attraction: Math.round(((area / 1000) * PULL[kind] * k) * 10) / 10,
  };
}

// ---------------------------------------------------------------------------
// Snapping to road edges
// ---------------------------------------------------------------------------

/** The line a zone keeps to beside a road: its kerb or sidewalk edge plus a setback. */
export function edgeOffset(net: RoadNetwork, segmentId: Id, setback: number): number {
  return totalHalfWidth(net.roadTypeOf(segmentId)) + setback;
}

export interface Snapped {
  pos: Vec3;
  anchor: ZoneAnchor | null;
}

/** Pull a point onto the nearest road edge line within the snap distance. */
export function snapToRoadEdge(net: RoadNetwork, p: Vec3, s: ZoneSettings): Snapped {
  const free = { pos: { x: p.x, y: terrainHeight(p.x, p.z), z: p.z }, anchor: null };
  if (!s.snap) return free;
  const reach = s.snapDistance + 40;
  let best: Snapped = free;
  let bestGap = s.snapDistance;
  for (const id of net.segmentsInRegion({ minX: p.x - reach, minZ: p.z - reach, maxX: p.x + reach, maxZ: p.z + reach }, true)) {
    if (s.excludeFast && isFastRoad(net, id)) continue;
    const c = net.cubicOf(id);
    const hit = closestPointOnCubic(c, p);
    const tan = cubicTangentXZ(c, hit.t);
    const lateral = (p.x - hit.point.x) * -tan.z + (p.z - hit.point.z) * tan.x;
    const side = lateral >= 0 ? 1 : -1;
    const edge = edgeOffset(net, id, s.setback);
    const gap = Math.abs(Math.abs(lateral) - edge);
    if (gap > bestGap) continue;
    const span = visibleSpan(net, id);
    if (span && (hit.t < span.lo || hit.t > span.hi)) continue;
    bestGap = gap;
    const anchor: ZoneAnchor = { segmentId: id, t: Math.round(hit.t * 1e6) / 1e6, offset: side * edge };
    best = { pos: anchorPoint(net, anchor)!, anchor };
  }
  return best;
}

/** Fill in corners along a road between two held corners on the same road edge. */
function densify(net: RoadNetwork, pts: Vec3[], anchors: (ZoneAnchor | null)[]): { polygon: Vec3[]; anchors: (ZoneAnchor | null)[] } {
  const outP: Vec3[] = [];
  const outA: (ZoneAnchor | null)[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    outP.push(pts[i]);
    outA.push(anchors[i]);
    const a = anchors[i];
    const b = anchors[(i + 1) % n];
    if (!a || !b || a.segmentId !== b.segmentId || Math.sign(a.offset) !== Math.sign(b.offset)) continue;
    const length = net.segmentGeom(a.segmentId)?.fullLength ?? 0;
    const steps = Math.floor((Math.abs(b.t - a.t) * length) / 5);
    for (let k = 1; k < steps; k++) {
      const anchor: ZoneAnchor = { segmentId: a.segmentId, t: a.t + ((b.t - a.t) * k) / steps, offset: (a.offset + b.offset) / 2 };
      outP.push(anchorPoint(net, anchor)!);
      outA.push(anchor);
    }
  }
  return { polygon: outP, anchors: outA };
}

/** Snap every corner of a shape, then follow the roads between snapped corners. */
export function snapShape(net: RoadNetwork, pts: readonly Vec3[], s: ZoneSettings): { polygon: Vec3[]; anchors: (ZoneAnchor | null)[] } {
  const snapped = pts.map((p) => snapToRoadEdge(net, p, s));
  return densify(net, snapped.map((x) => x.pos), snapped.map((x) => x.anchor));
}

// ---------------------------------------------------------------------------
// Fill block
// ---------------------------------------------------------------------------

export type ShapeResult = { polygon: Vec3[]; anchors: (ZoneAnchor | null)[] } | { error: string };

function simplify(pts: Vec3[], tolerance: number): Vec3[] {
  if (pts.length < 4) return pts;
  const keep = new Array<boolean>(pts.length).fill(false);
  const stack: [number, number][] = [[0, pts.length - 1]];
  keep[0] = keep[pts.length - 1] = true;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let at = -1;
    const ax = pts[a].x;
    const az = pts[a].z;
    const dx = pts[b].x - ax;
    const dz = pts[b].z - az;
    const l = Math.hypot(dx, dz) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i].x - ax) * dz - (pts[i].z - az) * dx) / l;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolerance && at > 0) {
      keep[at] = true;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** The outer boundary of a set of grid cells, as corner points. */
function traceOutline(mask: Uint8Array, n: number, origin: { x: number; z: number }): Vec3[] {
  // Directed cell edges with the filled side on the left, keyed by start corner.
  const next = new Map<number, number[]>();
  const key = (i: number, j: number) => i * (n + 1) + j;
  const push = (a: number, b: number) => {
    const list = next.get(a);
    if (list) list.push(b);
    else next.set(a, [b]);
  };
  const filled = (i: number, j: number) => i >= 0 && j >= 0 && i < n && j < n && mask[i * n + j] === 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (!filled(i, j)) continue;
      if (!filled(i, j - 1)) push(key(i, j), key(i + 1, j));
      if (!filled(i + 1, j)) push(key(i + 1, j), key(i + 1, j + 1));
      if (!filled(i, j + 1)) push(key(i + 1, j + 1), key(i, j + 1));
      if (!filled(i - 1, j)) push(key(i, j + 1), key(i, j));
    }
  }
  let best: number[] = [];
  const used = new Set<string>();
  for (const [start, ends] of next) {
    for (const first of ends) {
      if (used.has(`${start}>${first}`)) continue;
      const loop = [start];
      let a = start;
      let b = first;
      let guard = 0;
      while (guard++ < 200000) {
        used.add(`${a}>${b}`);
        loop.push(b);
        if (b === start) break;
        const options = (next.get(b) ?? []).filter((c) => !used.has(`${b}>${c}`));
        if (!options.length) break;
        a = b;
        b = options[0];
      }
      if (loop.length > best.length) best = loop;
    }
  }
  return best.slice(0, -1).map((k) => {
    const i = Math.floor(k / (n + 1));
    const j = k % (n + 1);
    const x = origin.x + i * BLOCK_STEP;
    const z = origin.z + j * BLOCK_STEP;
    return { x, y: terrainHeight(x, z), z };
  });
}

/**
 * The block of land around a point, between the road edges plus the setback.
 * Fails when the point is on a road, or the land is not enclosed by roads.
 */
export function fillBlock(net: RoadNetwork, at: Vec3, s: ZoneSettings): ShapeResult {
  const n = BLOCK_WINDOW / BLOCK_STEP;
  const origin = { x: Math.round(at.x / BLOCK_STEP) * BLOCK_STEP - BLOCK_WINDOW / 2, z: Math.round(at.z / BLOCK_STEP) * BLOCK_STEP - BLOCK_WINDOW / 2 };
  const blocked = new Uint8Array(n * n);
  const cellOf = (x: number, z: number) => [Math.floor((x - origin.x) / BLOCK_STEP), Math.floor((z - origin.z) / BLOCK_STEP)];
  const window = { minX: origin.x, minZ: origin.z, maxX: origin.x + BLOCK_WINDOW, maxZ: origin.z + BLOCK_WINDOW };
  for (const id of net.segmentsInRegion(window, true)) {
    const r = edgeOffset(net, id, s.setback);
    const rc = Math.ceil(r / BLOCK_STEP);
    const c = net.cubicOf(id);
    const length = net.segmentGeom(id)?.fullLength ?? 0;
    const samples = Math.max(2, Math.ceil(length));
    for (let k = 0; k <= samples; k++) {
      const t = k / samples;
      if (tunnelAt(net, id, t)) continue;
      const p = offsetPoint(c, t, 0);
      const [ci, cj] = cellOf(p.x, p.z);
      for (let di = -rc; di <= rc; di++) {
        for (let dj = -rc; dj <= rc; dj++) {
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          const cx = origin.x + (i + 0.5) * BLOCK_STEP;
          const cz = origin.z + (j + 0.5) * BLOCK_STEP;
          if (Math.hypot(cx - p.x, cz - p.z) <= r) blocked[i * n + j] = 1;
        }
      }
    }
  }
  const [si, sj] = cellOf(at.x, at.z);
  if (blocked[si * n + sj]) return { error: 'Click inside a block, not on a road.' };
  if (!groundUsable(at.x, at.z)) return { error: 'That is water or off the map.' };
  const mask = new Uint8Array(n * n);
  const queue = [si * n + sj];
  mask[si * n + sj] = 1;
  let open = false;
  while (queue.length) {
    const c = queue.pop()!;
    const i = Math.floor(c / n);
    const j = c % n;
    if (i === 0 || j === 0 || i === n - 1 || j === n - 1) open = true;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di;
      const b = j + dj;
      if (a < 0 || b < 0 || a >= n || b >= n) continue;
      const k = a * n + b;
      if (mask[k] || blocked[k]) continue;
      const x = origin.x + (a + 0.5) * BLOCK_STEP;
      const z = origin.z + (b + 0.5) * BLOCK_STEP;
      if (!groundUsable(x, z)) continue;
      mask[k] = 1;
      queue.push(k);
    }
  }
  if (open) return { error: 'This land is not enclosed by roads. Use frontage or a shape instead.' };
  const outline = simplify(traceOutline(mask, n, origin), 1.2);
  if (outline.length < 3 || polygonArea(outline) < MIN_AREA) return { error: 'This block is too small to zone.' };
  // Snap with a little more reach than the grid's staircase can stray.
  return snapShape(net, outline, { ...s, snap: s.snap, snapDistance: Math.max(s.snapDistance, BLOCK_STEP * 2) });
}

// ---------------------------------------------------------------------------
// Frontage
// ---------------------------------------------------------------------------

/** A strip of the given depth along one side of a road between two parameters. */
export function frontageStrip(net: RoadNetwork, segmentId: Id, t0: number, t1: number, side: 1 | -1, s: ZoneSettings): ShapeResult {
  if (!net.getSegment(segmentId)) return { error: 'No road there.' };
  if (s.excludeFast && isFastRoad(net, segmentId)) return { error: 'Highways, ramps and rail cannot have frontage.' };
  const span = visibleSpan(net, segmentId);
  const lo = Math.max(Math.min(t0, t1), span?.lo ?? 0);
  const hi = Math.min(Math.max(t0, t1), span?.hi ?? 1);
  const length = (net.segmentGeom(segmentId)?.fullLength ?? 0) * (hi - lo);
  if (length < 6) return { error: 'Drag further along the road.' };
  const near = side * edgeOffset(net, segmentId, s.setback);
  const far = side * (Math.abs(near) + s.depth);
  const steps = Math.max(2, Math.ceil(length / 5));
  const inner: ZoneAnchor[] = [];
  const outer: ZoneAnchor[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = Math.round((lo + ((hi - lo) * k) / steps) * 1e6) / 1e6;
    inner.push({ segmentId, t, offset: near });
    outer.push({ segmentId, t, offset: far });
  }
  const anchors = [...inner, ...outer.reverse()];
  return { polygon: anchors.map((a) => anchorPoint(net, a)!), anchors };
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export interface AccessSpot {
  segmentId: Id;
  t: number;
  side: 1 | -1;
}

/** Where a region's traffic joins its fronting roads. Never a highway, ramp or rail. */
export function accessSpots(net: RoadNetwork, region: ZoneRegion, area: number): AccessSpot[] {
  const poly = zonePolygon(net, region);
  const found: (AccessSpot & { x: number; z: number })[] = [];
  const reach = region.settings.setback + 6;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(len / 8));
    for (let k = 0; k < n; k++) {
      const x = a.x + ((b.x - a.x) * (k + 0.5)) / n;
      const z = a.z + ((b.z - a.z) * (k + 0.5)) / n;
      const hit = net.nearestSegment({ x, y: 0, z }, 40);
      if (!hit || isFastRoad(net, hit.segmentId)) continue;
      const p = offsetPoint(net.cubicOf(hit.segmentId), hit.t, 0);
      if (Math.abs(p.y - terrainHeight(p.x, p.z)) > 1.5) continue;
      if (hit.distance > totalHalfWidth(net.roadTypeOf(hit.segmentId)) + reach) continue;
      const span = visibleSpan(net, hit.segmentId);
      if (span && (hit.t < span.lo + 0.02 || hit.t > span.hi - 0.02)) continue;
      found.push({ segmentId: hit.segmentId, t: Math.round(hit.t * 1e6) / 1e6, side: hit.lateral >= 0 ? 1 : -1, x, z });
    }
  }
  const wanted = Math.max(1, Math.min(MAX_ACCESS, Math.ceil(area / 6000)));
  const chosen: typeof found = [];
  // Spread them out: take whichever candidate is furthest from those already chosen.
  while (chosen.length < wanted && found.length) {
    let best = -1;
    let bestD = -1;
    found.forEach((c, i) => {
      const d = chosen.length ? Math.min(...chosen.map((o) => Math.hypot(o.x - c.x, o.z - c.z))) : found.length - i;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    });
    if (chosen.length && bestD < ACCESS_SPACING) break;
    chosen.push(found.splice(best, 1)[0]);
  }
  return chosen.map(({ segmentId, t, side }) => ({ segmentId, t, side }));
}
