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
import { GRID_FINEST, visibleSnapSpacing } from '../render/gridLevels';
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
  /** Align to road puts the origin on the road's centreline, so grid lines run at exact multiples of the spacing from it. */
  alignOrigin: boolean;
  /** Snap to the finest subdivision visible at the current zoom. Off: base spacing only. */
  snapSubdivisions: boolean;
  /**
   * Smallest grid, metres: neither drawn lines nor snapping subdivide below it,
   * so squares stay this big however close the camera. Never above the spacing.
   */
  minSpacing: number;
}

export const GRID_SPACINGS: readonly number[] = [8, 16, 32, 64, 128];
export const GRID_MIN_SPACING = 2;
export const GRID_MAX_SPACING = 512;
/** Presets for the smallest grid. */
export const GRID_MIN_SPACINGS: readonly number[] = [0.5, 1, 2, 4, 8, 16, 32];
const QUARTER = Math.PI / 2;

export function defaultGrid(): GridSettings {
  return { enabled: false, spacing: 32, rotation: 0, originX: 0, originZ: 0, majorEvery: 4, alignOrigin: true, snapSubdivisions: true, minSpacing: GRID_FINEST };
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
    alignOrigin: typeof raw.alignOrigin === 'boolean' ? raw.alignOrigin : d.alignOrigin,
    snapSubdivisions: typeof raw.snapSubdivisions === 'boolean' ? raw.snapSubdivisions : d.snapSubdivisions,
    minSpacing: clampMinSpacing(num(raw.minSpacing, d.minSpacing), spacing),
  };
}

/** A smallest grid kept between GRID_FINEST and the base spacing. */
export function clampMinSpacing(min: number, spacing: number): number {
  const m = Number.isFinite(min) ? min : GRID_FINEST;
  return Math.min(Math.max(GRID_FINEST, spacing), Math.max(GRID_FINEST, m));
}

/** The smallest grid in effect: the setting, never above the base spacing. */
export function gridMinSpacing(g: Pick<GridSettings, 'spacing'> & Partial<Pick<GridSettings, 'minSpacing'>>): number {
  return clampMinSpacing(g.minSpacing ?? GRID_FINEST, g.spacing);
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
 * for the finest subdivision currently shown (unless subdivisions are off),
 * never below the smallest grid.
 */
export function snapGridAt(g: GridSettings, metresPerPixel: number): SnapGrid {
  const spacing = visibleSnapSpacing(g.spacing, g.majorEvery, metresPerPixel, g.snapSubdivisions, gridMinSpacing(g));
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

/**
 * Grid settings turned to run along the road at `t`. With `alignOrigin`, the
 * origin moves onto the road's centreline there, so grid lines run along it and
 * at exact multiples of the spacing from it: roads drawn on grid lines come out
 * evenly parallel to it. Otherwise only the rotation changes.
 */
export function gridAlignedTo(net: RoadNetwork, segmentId: Id, t: number, g: GridSettings): GridSettings {
  const c = net.cubicOf(segmentId);
  const p = cubicPoint(c, t);
  const dir = cubicTangentXZ(c, t);
  const rotation = normalizeGridRotation(Math.atan2(dir.z, dir.x));
  if (!g.alignOrigin) return { ...g, rotation };
  return { ...g, rotation, originX: p.x, originZ: p.z };
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
  const show = toolId === 'gridAlign' || (toolId === 'road' && g.enabled && drawMode !== 'upgrade');
  if (!show || !center) return null;
  const s = preview ?? g;
  return {
    spacing: s.spacing,
    rotation: s.rotation,
    originX: s.originX,
    originZ: s.originZ,
    majorEvery: s.majorEvery,
    minSpacing: gridMinSpacing(s),
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
