/**
 * The optional drawing grid. Off by default: roads are free and curved, and the
 * grid is only an aid for laying out straight street blocks.
 *
 * A grid is a spacing, a rotation and an origin in plan. Its lines run along
 * axis u = (cos r, 0, sin r) and axis v = right of u = (-sin r, 0, cos r), and
 * one line of each family passes through the origin. Everything here is a pure
 * function, so it runs headless under Vitest.
 *
 * Snapping with the grid on keeps the existing order where it matters: nodes and
 * roads come first, because they are what make connections. Then grid
 * intersections, then grid lines, with the angle guides turned to the grid axes.
 */
import { closestPointOnCubic, cubicPoint, cubicTangentXZ, type Cubic } from '../core/bezier';
import { distXZ, normalizeXZ, signedTurn, sub } from '../core/math';
import type { RoadAnchor, RoadNetwork } from '../core/RoadNetwork';
import { totalHalfWidth } from '../core/roadTypes';
import { isWater, MAP_HALF_SIZE } from '../core/terrain';
import type { Id, Vec3 } from '../core/types';
import type { GridView } from '../render/api';
import { visibleSnapSpacing } from '../render/gridLevels';
import type { SnapFrom, SnapHit, SnapQuery } from './snap';

export interface GridSettings {
  /** Snap road points to the grid. Off by default. */
  enabled: boolean;
  /** Metres between lines. */
  spacing: number;
  /** Radians, kept in [0, PI/2) because the grid looks the same every quarter turn. */
  rotation: number;
  /** A point where two grid lines cross. */
  originX: number;
  originZ: number;
  /** Every this many lines is drawn as a major line. */
  majorEvery: number;
  /** Grid Block tool: grid cells per block side. */
  blockCells: number;
  /** Snap to the finest subdivision visible at the current zoom. Off: base spacing only. */
  snapSubdivisions: boolean;
}

export const GRID_SPACINGS: readonly number[] = [8, 16, 32, 64, 128];
export const GRID_MIN_SPACING = 2;
export const GRID_MAX_SPACING = 512;
export const GRID_MAX_BLOCK_CELLS = 16;
/** Most blocks along one side of a Grid Block drag. */
export const GRID_MAX_BLOCKS = 16;
const QUARTER = Math.PI / 2;

export function defaultGrid(): GridSettings {
  return { enabled: false, spacing: 32, rotation: 0, originX: 0, originZ: 0, majorEvery: 4, blockCells: 2, snapSubdivisions: true };
}

/** Rotation folded into [0, PI/2). */
export function normalizeGridRotation(r: number): number {
  if (!Number.isFinite(r)) return 0;
  let out = r % QUARTER;
  if (out < 0) out += QUARTER;
  // Fold values a hair under a quarter turn back to 0 so the stored value is stable.
  if (QUARTER - out < 1e-9) out = 0;
  return out;
}

/** Clean up settings from a panel or a stored preference. */
export function sanitizeGrid(raw: Partial<GridSettings> | null | undefined): GridSettings {
  const d = defaultGrid();
  if (!raw || typeof raw !== 'object') return d;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const spacing = Math.min(GRID_MAX_SPACING, Math.max(GRID_MIN_SPACING, num(raw.spacing, d.spacing)));
  const major = Math.round(num(raw.majorEvery, d.majorEvery));
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : d.enabled,
    spacing,
    rotation: normalizeGridRotation(num(raw.rotation, d.rotation)),
    originX: Math.min(MAP_HALF_SIZE, Math.max(-MAP_HALF_SIZE, num(raw.originX, d.originX))),
    originZ: Math.min(MAP_HALF_SIZE, Math.max(-MAP_HALF_SIZE, num(raw.originZ, d.originZ))),
    majorEvery: major === 5 ? 5 : 4,
    blockCells: Math.min(GRID_MAX_BLOCK_CELLS, Math.max(1, Math.round(num(raw.blockCells, d.blockCells)))),
    snapSubdivisions: typeof raw.snapSubdivisions === 'boolean' ? raw.snapSubdivisions : d.snapSubdivisions,
  };
}

/** Back to the defaults, keeping whether snapping is on. */
export function resetGrid(g: GridSettings): void {
  Object.assign(g, { ...defaultGrid(), enabled: g.enabled });
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

export interface GridAxes {
  u: Vec3;
  v: Vec3;
}

export function gridAxes(g: Pick<GridSettings, 'rotation'>): GridAxes {
  const c = Math.cos(g.rotation);
  const s = Math.sin(g.rotation);
  return { u: { x: c, y: 0, z: s }, v: { x: -s, y: 0, z: c } };
}

/** Plan position in grid metres: a along u, b along v, from the origin. */
export function toGrid(g: GridSettings, p: Pick<Vec3, 'x' | 'z'>): { a: number; b: number } {
  const { u, v } = gridAxes(g);
  const dx = p.x - g.originX;
  const dz = p.z - g.originZ;
  return { a: dx * u.x + dz * u.z, b: dx * v.x + dz * v.z };
}

export function fromGrid(g: GridSettings, a: number, b: number, y: number): Vec3 {
  const { u, v } = gridAxes(g);
  return { x: g.originX + a * u.x + b * v.x, y, z: g.originZ + a * u.z + b * v.z };
}

/** The grid intersection nearest a point, at height y. */
export function nearestGridPoint(g: GridSettings, p: Vec3, y = p.y): Vec3 {
  const { a, b } = toGrid(g, p);
  const s = g.spacing;
  return fromGrid(g, Math.round(a / s) * s, Math.round(b / s) * s, y);
}

/** The point on the nearest grid line. */
export function nearestGridLinePoint(g: GridSettings, p: Vec3, y = p.y): Vec3 {
  const { a, b } = toGrid(g, p);
  const s = g.spacing;
  const ra = Math.round(a / s) * s;
  const rb = Math.round(b / s) * s;
  return Math.abs(a - ra) <= Math.abs(b - rb) ? fromGrid(g, ra, b, y) : fromGrid(g, a, rb, y);
}

/**
 * Catch radius of an intersection, metres. With the ground size of a screen
 * pixel, it is at least a few pixels, so fine subdivisions catch the cursor
 * everywhere, but never more than half a cell.
 */
export function gridPointCatch(g: Pick<GridSettings, 'spacing'>, metresPerPixel = 0): number {
  return Math.min(g.spacing * 0.5, Math.max(Math.min(g.spacing * 0.3, 8), metresPerPixel * 10));
}

/** Catch distance of a line, metres. */
export function gridLineCatch(g: Pick<GridSettings, 'spacing'>, metresPerPixel = 0): number {
  return Math.min(g.spacing * 0.5, Math.max(Math.min(g.spacing * 0.2, 5), metresPerPixel * 7));
}

/**
 * The grid snapping uses at this zoom: the base grid with its spacing swapped
 * for the finest subdivision currently shown (unless subdivisions are off).
 */
export function snapGridAt(g: GridSettings, metresPerPixel: number): SnapGrid {
  const spacing = visibleSnapSpacing(g.spacing, g.majorEvery, metresPerPixel, g.snapSubdivisions);
  return { ...g, spacing, subdivided: spacing < g.spacing };
}

/** A grid as snapping sees it. On a subdivision, every cursor position lands on a line. */
export interface SnapGrid extends GridSettings {
  subdivided?: boolean;
}

/** The grid axis direction (u, v, -u or -v) closest to `ref`, or u. */
export function gridAxisNear(g: GridSettings, ref: Vec3 | null): Vec3 {
  const { u, v } = gridAxes(g);
  if (!ref) return u;
  const cands = [u, v, { x: -u.x, y: 0, z: -u.z }, { x: -v.x, y: 0, z: -v.z }];
  let best = u;
  let bestDot = -Infinity;
  for (const c of cands) {
    const d = c.x * ref.x + c.z * ref.z;
    if (d > bestDot) {
      bestDot = d;
      best = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

function turnFrom(from: SnapFrom | null, pos: Vec3): number | null {
  if (!from) return null;
  if (distXZ(from.pos, pos) < 1e-6) return null;
  return signedTurn(from.ref ?? { x: 1, y: 0, z: 0 }, normalizeXZ(sub(pos, from.pos)));
}

function freeHit(pos: Vec3, kind: 'grid' | 'gridLine', from: SnapFrom | null, guide: SnapHit['guide'] = null): SnapHit {
  return { pos: { ...pos }, anchor: { kind: 'free', pos: { ...pos } }, kind, angle: turnFrom(from, pos), guide };
}

/**
 * Where the angle guide ray, from `from` along `dir`, crosses a grid line close
 * to where the cursor projects onto it. Null when no crossing is within catch.
 */
function guideCrossing(g: GridSettings, from: Vec3, dir: Vec3, raw: Vec3, reach: number): Vec3 | null {
  const s = g.spacing;
  const f = toGrid(g, from);
  const { u, v } = gridAxes(g);
  const da = dir.x * u.x + dir.z * u.z;
  const db = dir.x * v.x + dir.z * v.z;
  const sRaw = (raw.x - from.x) * dir.x + (raw.z - from.z) * dir.z;
  let best: number | null = null;
  const consider = (origin: number, rate: number) => {
    if (Math.abs(rate) < 1e-6) return;
    const at = origin + sRaw * rate;
    const k0 = Math.round(at / s);
    for (let k = k0 - 1; k <= k0 + 1; k++) {
      const t = (k * s - origin) / rate;
      if (t <= 1) continue;
      if (Math.abs(t - sRaw) <= reach && (best === null || Math.abs(t - sRaw) < Math.abs(best - sRaw))) best = t;
    }
  };
  consider(f.a, da);
  consider(f.b, db);
  if (best === null) return null;
  return { x: from.x + dir.x * best, y: raw.y, z: from.z + dir.z * best };
}

/**
 * Snap with the grid on, after nodes and roads found nothing. `guides` is the
 * angle and length snapping of snap.ts, called with the reference turned to the
 * grid axes so the 0 and 90 degree guides run along the grid.
 */
export function snapWithGrid(q: SnapQuery, guides: (q: SnapQuery) => SnapHit): SnapHit {
  const g = q.grid!;
  const raw = q.raw;
  const point = nearestGridPoint(g, raw, raw.y);
  const mpp = q.gridMetresPerPixel ?? 0;
  if (distXZ(point, raw) <= gridPointCatch(g, mpp)) return freeHit(point, 'grid', q.from);

  const from: SnapFrom | null = q.from ? { pos: q.from.pos, ref: gridAxisNear(g, q.from.ref) } : null;
  const guided = guides({ ...q, from });
  if (from && guided.guide && (guided.kind === 'angle' || guided.kind === 'angleLength')) {
    const dir = normalizeXZ(sub(guided.pos, from.pos));
    const cross = guideCrossing(g, from.pos, dir, raw, gridLineCatch(g, mpp));
    if (cross) return freeHit(cross, 'gridLine', q.from, guided.guide);
    return { ...guided, angle: turnFrom(q.from, guided.pos) };
  }
  const line = nearestGridLinePoint(g, raw, raw.y);
  const lineReach = (g as SnapGrid).subdivided ? g.spacing / 2 : gridLineCatch(g, mpp);
  if (distXZ(line, raw) <= lineReach + 1e-9) return freeHit(line, 'gridLine', q.from);
  return { ...guided, angle: turnFrom(q.from, guided.pos) };
}

/** Grid coordinate of a cubic point relative to a family of lines. */
function lineValue(g: GridSettings, c: Cubic, t: number, family: 'a' | 'b'): number {
  const p = toGrid(g, cubicPoint(c, t));
  return family === 'a' ? p.a : p.b;
}

/**
 * A snap onto a road moves to where that road crosses a grid line, when one is
 * close, so a new street meets the old road on the grid. The road still wins:
 * the hit stays on it.
 */
export function refineSegmentHit(net: RoadNetwork, hit: SnapHit, g: GridSettings, minEndGap: number): SnapHit {
  if (hit.anchor.kind !== 'segment') return hit;
  const segId = hit.anchor.id;
  const c = net.cubicOf(segId);
  const length = net.segmentGeom(segId)?.fullLength ?? 0;
  if (length <= 0) return hit;
  const reach = gridPointCatch(g);
  const t0 = hit.anchor.t;
  const span = Math.min(0.5, (reach * 1.5) / length);
  const lo = Math.max(0, t0 - span);
  const hi = Math.min(1, t0 + span);
  const s = g.spacing;
  let bestT: number | null = null;
  let bestD = Infinity;
  const steps = 16;
  for (const family of ['a', 'b'] as const) {
    const centre = lineValue(g, c, t0, family);
    const k0 = Math.round(centre / s);
    for (let k = k0 - 1; k <= k0 + 1; k++) {
      const target = k * s;
      let prevT = lo;
      let prev = lineValue(g, c, lo, family) - target;
      for (let i = 1; i <= steps; i++) {
        const t = lo + ((hi - lo) * i) / steps;
        const cur = lineValue(g, c, t, family) - target;
        // A road lying along a line of this family touches it everywhere: no crossing.
        const along = Math.abs(prev) < 1e-6 && Math.abs(cur) < 1e-6;
        if (!along && prev * cur <= 0) {
          // Bisect the bracket.
          let a = prevT;
          let b = t;
          let fa = prev;
          for (let n = 0; n < 30; n++) {
            const m = (a + b) / 2;
            const fm = lineValue(g, c, m, family) - target;
            if (fa * fm <= 0) b = m;
            else {
              a = m;
              fa = fm;
            }
          }
          const tc = (a + b) / 2;
          const d = distXZ(cubicPoint(c, tc), hit.pos);
          if (d < bestD) {
            bestD = d;
            bestT = tc;
          }
        }
        prevT = t;
        prev = cur;
      }
    }
  }
  if (bestT === null || bestD > reach) return hit;
  if (bestT * length < minEndGap || (1 - bestT) * length < minEndGap) return hit;
  const pos = cubicPoint(c, bestT);
  return { ...hit, pos, anchor: { kind: 'segment', id: segId, t: bestT } };
}

// ---------------------------------------------------------------------------
// Align to a road
// ---------------------------------------------------------------------------

/** Grid settings turned and shifted so a grid line runs along the road at `t`. */
export function gridAlignedTo(net: RoadNetwork, segmentId: Id, t: number, g: GridSettings): GridSettings {
  const c = net.cubicOf(segmentId);
  const p = cubicPoint(c, t);
  const dir = cubicTangentXZ(c, t);
  return {
    ...g,
    rotation: normalizeGridRotation(Math.atan2(dir.z, dir.x)),
    originX: Math.round(p.x * 1000) / 1000,
    originZ: Math.round(p.z * 1000) / 1000,
  };
}

// ---------------------------------------------------------------------------
// Grid Block: a rectangle of street blocks
// ---------------------------------------------------------------------------

export interface BlockEdge {
  /** Lattice indices of the two ends. */
  i0: number;
  j0: number;
  i1: number;
  j1: number;
  from: Vec3;
  to: Vec3;
}

export interface BlockPlan {
  /** Blocks along u and along v. */
  ni: number;
  nj: number;
  /** Block side, metres. */
  block: number;
  /** Lattice point (i, j), i along u from the start corner, j along v. */
  point(i: number, j: number): Vec3;
  /** Row edges first (along u), then column edges (along v). */
  edges: BlockEdge[];
  /** Corners, for drawing the outline. */
  corners: [Vec3, Vec3, Vec3, Vec3];
}

/**
 * Plan the street grid dragged from `start` to `cursor`. The start corner lands
 * on the nearest grid intersection, and each side is a whole number of blocks,
 * at least one, on the side of the start the cursor is on.
 */
export function planGridBlock(g: GridSettings, start: Vec3, cursor: Vec3, y: number): BlockPlan {
  const s = g.spacing;
  const block = s * Math.max(1, Math.round(g.blockCells));
  const st = toGrid(g, start);
  const a0 = Math.round(st.a / s) * s;
  const b0 = Math.round(st.b / s) * s;
  const cur = toGrid(g, cursor);
  const da = cur.a - a0;
  const db = cur.b - b0;
  const ni = Math.min(GRID_MAX_BLOCKS, Math.max(1, Math.round(Math.abs(da) / block)));
  const nj = Math.min(GRID_MAX_BLOCKS, Math.max(1, Math.round(Math.abs(db) / block)));
  const sa = da < 0 ? -block : block;
  const sb = db < 0 ? -block : block;
  const point = (i: number, j: number) => fromGrid(g, a0 + i * sa, b0 + j * sb, y);
  const edges: BlockEdge[] = [];
  for (let j = 0; j <= nj; j++) {
    for (let i = 0; i < ni; i++) edges.push({ i0: i, j0: j, i1: i + 1, j1: j, from: point(i, j), to: point(i + 1, j) });
  }
  for (let i = 0; i <= ni; i++) {
    for (let j = 0; j < nj; j++) edges.push({ i0: i, j0: j, i1: i, j1: j + 1, from: point(i, j), to: point(i, j + 1) });
  }
  return { ni, nj, block, point, edges, corners: [point(0, 0), point(ni, 0), point(ni, nj), point(0, nj)] };
}

const ATTACH_SLACK = 1;

/**
 * The existing node or road a lattice point lands on, or a free point. Within a
 * road's half width counts, so a block dragged up to a road joins it.
 */
export function resolveLatticeAnchor(net: RoadNetwork, p: Vec3, block: number, ignore?: ReadonlySet<Id>): RoadAnchor {
  const nodeReach = Math.min(4, block * 0.2);
  const near = net.nearestNode(p, nodeReach);
  const node = near ? net.getNode(near.nodeId) : undefined;
  if (node && Math.abs(node.pos.y - p.y) < 1.5) return { kind: 'node', id: node.id };
  const reach = 30;
  const box = { minX: p.x - reach, minZ: p.z - reach, maxX: p.x + reach, maxZ: p.z + reach };
  let best: { id: Id; t: number; d: number } | null = null;
  for (const id of net.segmentsInRegion(box, true)) {
    if (ignore?.has(id)) continue;
    const c = net.cubicOf(id);
    const hit = closestPointOnCubic(c, p);
    if (Math.abs(hit.point.y - p.y) > 1.5) continue;
    const tol = Math.min(totalHalfWidth(net.roadTypeOf(id)) + ATTACH_SLACK, block * 0.25);
    if (hit.distance > tol || (best && hit.distance >= best.d)) continue;
    best = { id, t: hit.t, d: hit.distance };
  }
  if (best) {
    const seg = net.getSegment(best.id)!;
    const len = net.segmentGeom(best.id)?.fullLength ?? 0;
    if (best.t * len < 6) return { kind: 'node', id: seg.a };
    if ((1 - best.t) * len < 6) return { kind: 'node', id: seg.b };
    return { kind: 'segment', id: best.id, t: best.t };
  }
  return { kind: 'free', pos: { ...p } };
}

/** True when an existing road already runs along this edge, so it is not drawn again. */
export function edgeCovered(net: RoadNetwork, e: BlockEdge): boolean {
  const n = 6;
  for (let k = 0; k <= n; k++) {
    const f = k / n;
    const p = { x: e.from.x + (e.to.x - e.from.x) * f, y: e.from.y, z: e.from.z + (e.to.z - e.from.z) * f };
    const hit = net.nearestSegment(p, 1.5);
    if (!hit || Math.abs(hit.point.y - p.y) > 1.5) return false;
    // A road crossing the edge passes one sample; it must also run along it.
    if (k > 0 && k < n) {
      const along = cubicTangentXZ(net.cubicOf(hit.segmentId), hit.t);
      const dir = normalizeXZ(sub(e.to, e.from));
      if (Math.abs(along.x * dir.x + along.z * dir.z) < 0.97) return false;
    }
  }
  return true;
}

function roadsAt(net: RoadNetwork, a: RoadAnchor): readonly Id[] {
  if (a.kind === 'segment') return [a.id];
  if (a.kind === 'node') return net.getNode(a.id)?.segments ?? [];
  return [];
}

/**
 * Both ends of the edge landed on the same existing road, which runs along the
 * edge: drawing it would lay a second road over the first.
 */
function sharedRoad(net: RoadNetwork, a: RoadAnchor, b: RoadAnchor, e: BlockEdge, block: number): boolean {
  const other = new Set(roadsAt(net, b));
  const mid = { x: (e.from.x + e.to.x) / 2, y: e.from.y, z: (e.from.z + e.to.z) / 2 };
  const dir = normalizeXZ(sub(e.to, e.from));
  for (const id of roadsAt(net, a)) {
    if (!other.has(id)) continue;
    const c = net.cubicOf(id);
    const hit = closestPointOnCubic(c, mid);
    if (hit.distance > block * 0.25) continue;
    const along = cubicTangentXZ(c, hit.t);
    if (Math.abs(along.x * dir.x + along.z * dir.z) > 0.9) return true;
  }
  return false;
}

export interface BlockCheck {
  /** Per edge: drawn, or skipped because a road is already there. */
  covered: boolean[];
  /** Per edge: the worst validation severity. */
  state: ('ok' | 'warning' | 'error')[];
  /** Reasons that stop the build. */
  errors: string[];
  warnings: string[];
  /** Expected new segments and lattice junctions, before splits of existing roads. */
  segments: number;
  junctions: number;
}

function sampleEdge(e: BlockEdge, step: number): Vec3[] {
  const len = distXZ(e.from, e.to);
  const n = Math.max(1, Math.ceil(len / step));
  const out: Vec3[] = [];
  for (let k = 0; k <= n; k++) {
    const f = k / n;
    out.push({ x: e.from.x + (e.to.x - e.from.x) * f, y: e.from.y, z: e.from.z + (e.to.z - e.from.z) * f });
  }
  return out;
}

/** Smallest block side this road type makes sensible junctions with. */
export function minBlockFor(net: RoadNetwork, roadType: string): number {
  const def = net.roadType(roadType);
  return Math.max(24, (def ? totalHalfWidth(def) : 6) * 2 + 16);
}

/** Check a plan against the network without changing anything. */
export function checkGridBlock(net: RoadNetwork, plan: BlockPlan, roadType: string): BlockCheck {
  const errors = new Set<string>();
  const warnings = new Set<string>();
  const covered: boolean[] = [];
  const state: BlockCheck['state'] = [];
  const minBlock = minBlockFor(net, roadType);
  if (plan.block < minBlock - 1e-6) {
    errors.add(`Blocks of ${plan.block.toFixed(0)} m are too small for this road, it needs ${minBlock.toFixed(0)} m. Raise the block size.`);
  }
  for (const c of plan.corners) {
    if (Math.abs(c.x) > MAP_HALF_SIZE || Math.abs(c.z) > MAP_HALF_SIZE) errors.add('The street grid leaves the map.');
  }
  let water = false;
  const ground = plan.corners[0].y <= 1;
  for (const e of plan.edges) {
    if (ground && !water) {
      for (const p of sampleEdge(e, 4)) {
        if (isWater(p.x, p.z)) {
          water = true;
          break;
        }
      }
    }
  }
  if (water) errors.add('A street grid cannot be built over water.');
  const anchorCache = new Map<string, RoadAnchor>();
  const anchorAt = (i: number, j: number) => {
    const key = `${i},${j}`;
    let a = anchorCache.get(key);
    if (!a) anchorCache.set(key, (a = resolveLatticeAnchor(net, plan.point(i, j), plan.block)));
    return a;
  };
  let segments = 0;
  const degree = new Map<string, number>();
  for (const e of plan.edges) {
    const isCovered = errors.size === 0 && (edgeCovered(net, e) || sharedRoad(net, anchorAt(e.i0, e.j0), anchorAt(e.i1, e.j1), e, plan.block));
    covered.push(isCovered);
    for (const k of [`${e.i0},${e.j0}`, `${e.i1},${e.j1}`]) degree.set(k, (degree.get(k) ?? 0) + 1);
    if (isCovered) {
      state.push('ok');
      continue;
    }
    segments++;
    if (errors.size) {
      state.push('error');
      continue;
    }
    const issues = net.validateDraft({ start: anchorAt(e.i0, e.j0), end: anchorAt(e.i1, e.j1), roadType });
    let worst: 'ok' | 'warning' | 'error' = 'ok';
    for (const issue of issues) {
      if (issue.severity === 'error') {
        worst = 'error';
        errors.add(issue.message);
      } else {
        if (worst === 'ok') worst = 'warning';
        warnings.add(issue.message);
      }
    }
    state.push(worst);
  }
  if (errors.size) for (let k = 0; k < state.length; k++) if (!covered[k]) state[k] = 'error';
  let junctions = 0;
  for (const d of degree.values()) if (d >= 3) junctions++;
  return { covered, state, errors: [...errors], warnings: [...warnings], segments, junctions };
}

export interface BlockBuildResult {
  segments: Id[];
  /** Node at each lattice point that got one, keyed "i,j". */
  lattice: Map<string, Id>;
}

/**
 * Build the plan. Call inside one `net.batch` so it is one undo step. Edges an
 * existing road already covers are skipped, and lattice points on existing
 * roads split them, so the new streets join the old ones at junctions.
 */
export function buildGridBlock(net: RoadNetwork, plan: BlockPlan, roadType: string, covered?: readonly boolean[]): BlockBuildResult {
  const lattice = new Map<string, Id>();
  const segments: Id[] = [];
  const own = new Set<Id>();
  const anchorAt = (i: number, j: number): RoadAnchor => {
    const id = lattice.get(`${i},${j}`);
    if (id !== undefined && net.getNode(id)) return { kind: 'node', id };
    return resolveLatticeAnchor(net, plan.point(i, j), plan.block, own);
  };
  plan.edges.forEach((e, k) => {
    if (covered?.[k]) return;
    const start = anchorAt(e.i0, e.j0);
    const end = anchorAt(e.i1, e.j1);
    if (start.kind === 'node' && end.kind === 'node' && start.id === end.id) return;
    const r = net.drawRoad({ start, end, roadType });
    for (const s of r.segments) {
      segments.push(s);
      own.add(s);
    }
    if (r.nodes.length) {
      lattice.set(`${e.i0},${e.j0}`, r.nodes[0]);
      lattice.set(`${e.i1},${e.j1}`, r.nodes[r.nodes.length - 1]);
    }
  });
  return { segments, lattice };
}

// ---------------------------------------------------------------------------
// What the renderer shows
// ---------------------------------------------------------------------------

/**
 * The grid to draw for the active tool: with snapping on while drawing roads,
 * and always in the grid tools. Null hides it.
 */
export function gridViewFor(
  toolId: string,
  drawMode: string,
  g: GridSettings,
  preview: GridSettings | null,
  center: { x: number; z: number } | null,
  elevation: number,
): GridView | null {
  const show = toolId === 'gridBlock' || toolId === 'gridAlign' || (toolId === 'road' && g.enabled && drawMode !== 'upgrade');
  if (!show || !center) return null;
  const s = preview ?? g;
  return {
    spacing: s.spacing,
    rotation: s.rotation,
    originX: s.originX,
    originZ: s.originZ,
    majorEvery: s.majorEvery,
    center: { x: center.x, z: center.z },
    elevation,
  };
}

const PREF_KEY = 'cloverleaf.grid';

/** Storage-like, so preferences load under Vitest too. */
export interface GridPrefStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Grid settings saved as a local preference, or the defaults. */
export function loadGridPrefs(store: GridPrefStore | null): GridSettings {
  try {
    const text = store?.getItem(PREF_KEY);
    return sanitizeGrid(text ? (JSON.parse(text) as Partial<GridSettings>) : null);
  } catch {
    return defaultGrid();
  }
}

export function saveGridPrefs(store: GridPrefStore | null, g: GridSettings): void {
  try {
    store?.setItem(PREF_KEY, JSON.stringify(g));
  } catch {
    // Storage full or blocked: the grid still works for this session.
  }
}

/** Ground metres covered by one screen pixel at the cursor, on the plane y = planeY. */
export function groundPixelSize(
  view: { pickPlane(x: number, y: number, planeY: number): Vec3 | null },
  x: number,
  y: number,
  planeY: number,
): number {
  const p = view.pickPlane(x, y, planeY);
  const px = view.pickPlane(x + 1, y, planeY);
  const py = view.pickPlane(x, y + 1, planeY);
  if (!p || !px || !py) return 0;
  return Math.max(distXZ(p, px), distXZ(p, py));
}
