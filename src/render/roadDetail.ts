/**
 * The road detail setting: how much procedural texture road surfaces get, on
 * its own scale beside the overall graphics quality. Pure, no DOM or Three.js.
 *
 *   low     one small texture, flat shading: no normal map, no wear decals
 *   medium  1024 asphalt with a normal map, wheel paths, seams and slab joints
 *   high    2048: everything, sealed cracks, patches, oil and tyre marks
 *   ultra   4096 asphalt, 2048 concrete
 *
 * 'auto' follows the graphics quality. The governor can still step an explicit
 * choice down when frames run long (see resolveRoadDetail).
 */
import type { QualityName } from './quality';

export type RoadDetailName = 'low' | 'medium' | 'high' | 'ultra';
export type RoadDetailPref = RoadDetailName | 'auto';

export const ROAD_DETAIL_ORDER: readonly RoadDetailName[] = ['low', 'medium', 'high', 'ultra'];

export interface RoadDetailSpec {
  name: RoadDetailName;
  /** Shader level, the ROAD_DETAIL define. */
  level: 0 | 1 | 2 | 3;
  /** Asphalt texture size in pixels. */
  asphalt: number;
  /** Concrete texture size, 0 for none (low reuses the asphalt texture). */
  concrete: number;
  /** Anisotropic filtering wanted; clamped to what the GPU offers. */
  anisotropy: number;
}

export const ROAD_DETAIL: Record<RoadDetailName, RoadDetailSpec> = {
  low: { name: 'low', level: 0, asphalt: 256, concrete: 0, anisotropy: 2 },
  medium: { name: 'medium', level: 1, asphalt: 1024, concrete: 512, anisotropy: 8 },
  high: { name: 'high', level: 2, asphalt: 2048, concrete: 1024, anisotropy: 16 },
  ultra: { name: 'ultra', level: 3, asphalt: 4096, concrete: 2048, anisotropy: 16 },
};

/** Road detail that goes with each graphics quality level. */
export const ROAD_DETAIL_FOR_QUALITY: Record<QualityName, RoadDetailName> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  ultra: 'ultra',
};

export const ROAD_DETAIL_LABEL: Record<RoadDetailPref, string> = {
  auto: 'Auto (follow graphics quality)',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  ultra: 'Ultra',
};

const rank = (n: RoadDetailName) => ROAD_DETAIL_ORDER.indexOf(n);

/**
 * The level actually drawn. `cap` is set by the frame-time governor when it steps
 * down; null means no cap. A cap only ever lowers the result.
 */
export function resolveRoadDetail(pref: RoadDetailPref, quality: QualityName, cap: RoadDetailName | null): RoadDetailName {
  const base = pref === 'auto' ? ROAD_DETAIL_FOR_QUALITY[quality] : pref;
  return cap !== null && rank(cap) < rank(base) ? cap : base;
}

/**
 * The governor's new cap after it changes the graphics quality. Stepping down
 * takes road detail one step below what is drawn now; stepping up lifts the cap a
 * step, and removes it once it no longer limits anything.
 */
export function nextRoadDetailCap(
  pref: RoadDetailPref,
  quality: QualityName,
  cap: RoadDetailName | null,
  down: boolean,
): RoadDetailName | null {
  const now = resolveRoadDetail(pref, quality, cap);
  if (down) return ROAD_DETAIL_ORDER[Math.max(0, rank(now) - 1)];
  if (cap === null) return null;
  const lifted = ROAD_DETAIL_ORDER[Math.min(ROAD_DETAIL_ORDER.length - 1, rank(cap) + 1)];
  const base = pref === 'auto' ? ROAD_DETAIL_FOR_QUALITY[quality] : pref;
  return rank(lifted) >= rank(base) ? null : lifted;
}

export const ROAD_DETAIL_STORAGE_KEY = 'cloverleaf.roadDetail';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** The saved choice, or 'auto'. Never throws: blocked storage reads as 'auto'. */
export function loadRoadDetailPref(storage: StorageLike | null | undefined): RoadDetailPref {
  try {
    const v = storage?.getItem(ROAD_DETAIL_STORAGE_KEY);
    if (v === 'auto' || (v && (ROAD_DETAIL_ORDER as readonly string[]).includes(v))) return v as RoadDetailPref;
  } catch {
    // Storage blocked.
  }
  return 'auto';
}

export function saveRoadDetailPref(storage: StorageLike | null | undefined, pref: RoadDetailPref): void {
  try {
    storage?.setItem(ROAD_DETAIL_STORAGE_KEY, pref);
  } catch {
    // Storage full or blocked: the choice lasts this session only.
  }
}

/** GPU bytes of the road textures at a level, mipmaps included. */
export function roadDetailBytes(name: RoadDetailName): number {
  const s = ROAD_DETAIL[name];
  const bytes = (n: number) => (n ? Math.round((n * n * 4 * 4) / 3) : 0);
  return bytes(s.asphalt) + bytes(s.concrete);
}
