/**
 * Screen sizing of tool marks. Point and ring marks are given in metres, sized
 * for a normal drawing zoom; the renderer keeps them about that size on screen,
 * within clamps, so a snap ring doesn't fill the view at street level or vanish
 * map-wide. A mark can instead ask for an exact pixel radius. Line widths stay in
 * metres, because previews show real road features, with only a floor so a line
 * never thins below a pixel or so. Pure, no Three.js.
 */
import type { Vec3 } from '../core/types';

/** Ground metres per CSS pixel at which a mark's metre radius is drawn as given (about a 220 m camera). */
export const MARK_REF_MPP = 0.25;
/** At any zoom, a mark stays between these multiples of its size at the reference zoom. */
export const MARK_MIN_SCALE = 0.6;
export const MARK_MAX_SCALE = 1.6;
/** Smallest point or ring radius on screen, CSS pixels. */
export const MARK_MIN_PX = 2.5;
/** Thinnest line on screen, CSS pixels. */
export const LINE_MIN_PX = 1.5;

/**
 * Radius in metres to draw a mark of `radius` metres (or `px` pixels, when set)
 * at a spot where one CSS pixel covers `mpp` metres. Without a usable `mpp` the
 * metre radius is used as is.
 */
export function markRadius(radius: number, mpp: number, px?: number): number {
  if (!(mpp > 0) || !Number.isFinite(mpp)) return px !== undefined ? px * MARK_REF_MPP : radius;
  if (px !== undefined) return Math.max(MARK_MIN_PX, px) * mpp;
  const nominal = radius / MARK_REF_MPP;
  const onScreen = radius / mpp;
  const lo = Math.max(MARK_MIN_PX, nominal * MARK_MIN_SCALE);
  const hi = Math.max(lo, nominal * MARK_MAX_SCALE);
  return Math.min(hi, Math.max(lo, onScreen)) * mpp;
}

/** Ring band half-thickness in metres for a drawn radius. */
export function ringThickness(drawnRadius: number, mpp: number): number {
  const floor = mpp > 0 && Number.isFinite(mpp) ? 0.9 * mpp : 0.2;
  return Math.max(floor, drawnRadius * 0.08);
}

/** Line width in metres: as given, but never thinner than a pixel and a half. */
export function lineWidth(width: number, mpp: number): number {
  return mpp > 0 && Number.isFinite(mpp) ? Math.max(width, LINE_MIN_PX * mpp) : width;
}

/** Ground metres per CSS pixel at a world point, from a projection to client pixels. */
export function metresPerPixelAt(project: (p: Vec3) => { x: number; y: number } | null, pos: Vec3): number {
  const a = project(pos);
  const bx = project({ x: pos.x + 1, y: pos.y, z: pos.z });
  const bz = project({ x: pos.x, y: pos.y, z: pos.z + 1 });
  if (!a || !bx || !bz) return 0;
  // The less foreshortened direction gives the scale across the view.
  const px = Math.max(Math.hypot(bx.x - a.x, bx.y - a.y), Math.hypot(bz.x - a.x, bz.y - a.y));
  return px > 1e-9 ? 1 / px : 0;
}
