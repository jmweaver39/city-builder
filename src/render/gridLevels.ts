/**
 * Levels of the adaptive drawing grid, shared by the renderer (which lines to
 * draw, and how brightly) and the tools (which spacing to snap to), so both
 * agree on what is visible. Pure, no Three.js.
 *
 * Around the base spacing S: finer levels S/2, S/4, ... down to the smallest grid
 * (GRID_FINEST unless the player sets a larger one), each splitting the one
 * above, and coarser levels S*M, S*M*M, ... (M = major every) so the grid still
 * reads from map-wide zoom. A level fades in as its cells grow
 * from GRID_FADE_PX[0] to GRID_FADE_PX[1] screen pixels, so zooming crossfades
 * smoothly instead of popping, and lines never get dense enough to shimmer.
 */

/** Finest subdivision, metres. */
export const GRID_FINEST = 0.5;
/** Coarsest level, metres: the map is 4000 m across. */
export const GRID_COARSEST = 4096;
/** A level fades in between these cell sizes, in CSS pixels. */
export const GRID_FADE_PX: readonly [number, number] = [5, 14];
/** Snapping uses a level once it is at least half faded in. */
export const GRID_SNAP_PX = (GRID_FADE_PX[0] + GRID_FADE_PX[1]) / 2;
/** Most levels the shader loops over. */
export const GRID_MAX_LEVELS = 16;

export type GridLevelKind = 'fine' | 'base' | 'major' | 'super';

export interface GridLevel {
  spacing: number;
  /** Peak brightness, 0 to 1. Major and coarser lines are brightest. */
  weight: number;
  kind: GridLevelKind;
}

/**
 * All levels for a grid, finest first. Subdivisions stop at `minSpacing` (the
 * player's smallest grid, never below GRID_FINEST): the finest level is the last
 * halving of the base that is still at least that big.
 */
export function gridLevels(spacing: number, majorEvery: number, minSpacing = GRID_FINEST): GridLevel[] {
  const out: GridLevel[] = [];
  const fine: number[] = [];
  const floor = Math.max(GRID_FINEST, Number.isFinite(minSpacing) ? minSpacing : GRID_FINEST);
  for (let s = spacing / 2; s >= floor - 1e-9 && fine.length < 10; s /= 2) fine.push(s);
  for (let i = fine.length - 1; i >= 0; i--) out.push({ spacing: fine[i], weight: 0.42, kind: 'fine' });
  out.push({ spacing, weight: 0.5, kind: 'base' });
  const m = Math.max(2, majorEvery);
  let s = spacing * m;
  out.push({ spacing: s, weight: 0.85, kind: 'major' });
  while (s * m <= GRID_COARSEST && out.length < GRID_MAX_LEVELS) {
    s *= m;
    out.push({ spacing: s, weight: 0.95, kind: 'super' });
  }
  return out.slice(0, GRID_MAX_LEVELS);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** How far a level is faded in when its cells are this many pixels wide. */
export function levelOpacity(cellPx: number): number {
  return smoothstep(GRID_FADE_PX[0], GRID_FADE_PX[1], cellPx);
}

/**
 * The spacing to snap to: the finest level at least half faded in at this zoom.
 * With `subdivisions` off, the base spacing whatever the zoom. Never finer than
 * `minSpacing`, so the drawn lines and the snap agree.
 */
export function visibleSnapSpacing(spacing: number, majorEvery: number, metresPerPixel: number, subdivisions = true, minSpacing = GRID_FINEST): number {
  if (!subdivisions || !(metresPerPixel > 0) || !Number.isFinite(metresPerPixel)) return spacing;
  const levels = gridLevels(spacing, majorEvery, minSpacing);
  for (const l of levels) if (l.spacing / metresPerPixel >= GRID_SNAP_PX) return l.spacing;
  return levels[levels.length - 1].spacing;
}

/** Ground metres per CSS pixel at the centre of a perspective view looking at a point `distance` away. */
export function metresPerPixel(distance: number, fovDegrees: number, viewportHeightPx: number): number {
  return (2 * distance * Math.tan((fovDegrees * Math.PI) / 360)) / Math.max(1, viewportHeightPx);
}

/** "4 m", "0.5 m". */
export function formatSpacing(s: number): string {
  return `${Number.isInteger(s) ? s : Number(s.toFixed(2))} m`;
}
