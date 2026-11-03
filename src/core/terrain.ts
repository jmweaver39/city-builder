/**
 * Terrain height. The only source of ground elevation in the project.
 *
 * Flat 0 across the buildable map, except one meandering river channel crossing
 * it from west to east. Beyond the map edge the land rises into hills, with the
 * river valley continuing through them. Everything here is a pure function of
 * (x, z), so renderers, tools and tests always agree.
 */
import type { Vec3 } from './types';
import { smoothstep } from './math';

export const MAP_HALF_SIZE = 2000;

/** Half the channel width at the water line. */
export const RIVER_HALF_WIDTH = 30;
export const RIVER_DEPTH = 5;
/** Surface height of the water, halfway down the banks. */
export const WATER_LEVEL = -RIVER_DEPTH / 2;

/** Road surface heights outside these are not allowed. */
export const MIN_ELEVATION = -24;
export const MAX_ELEVATION = 48;
export const ELEVATION_STEP = 4;
/** Clearance between road surfaces needed to cross without a junction. */
export const GRADE_CLEARANCE = 6;

const BANK_INNER = 20;
const BANK_OUTER = 40;
const VALLEY_OUTER = 220;

/** z of the river centreline at x. */
export function riverCentreZ(x: number): number {
  return (
    420 +
    170 * Math.sin(x / 470 + 0.6) +
    80 * Math.sin(x / 183 + 2.1) +
    24 * Math.sin(x / 71 + 4.2)
  );
}

function riverCentreSlope(x: number): number {
  return (
    (170 / 470) * Math.cos(x / 470 + 0.6) +
    (80 / 183) * Math.cos(x / 183 + 2.1) +
    (24 / 71) * Math.cos(x / 71 + 4.2)
  );
}

/** Approximate plan distance from (x, z) to the river centreline. */
export function riverDistance(x: number, z: number): number {
  const m = riverCentreSlope(x);
  return Math.abs(z - riverCentreZ(x)) / Math.sqrt(1 + m * m);
}

function hillHeight(x: number, z: number): number {
  const out = Math.max(Math.abs(x), Math.abs(z)) - MAP_HALF_SIZE;
  if (out <= 0) return 0;
  // Quadratic start so the slope is continuous at the map edge, then roughly linear.
  const rise = (out * out) / (out + 260);
  const roll =
    1 +
    0.22 * Math.sin(x / 310 + 1.3) * Math.cos(z / 270 + 0.4) +
    0.12 * Math.sin((x + z) / 130 + 2.2);
  return 0.32 * rise * roll;
}

/** Ground height in metres at a plan position. Deterministic. */
export function terrainHeight(x: number, z: number): number {
  const d = riverDistance(x, z);
  const channel = RIVER_DEPTH * (smoothstep(BANK_INNER, BANK_OUTER, d) - 1);
  const hills = hillHeight(x, z);
  if (hills === 0) return channel;
  return channel + hills * smoothstep(BANK_OUTER, VALLEY_OUTER, d);
}

/** True where the surface is river. */
export function isWater(x: number, z: number): boolean {
  return riverDistance(x, z) < RIVER_HALF_WIDTH;
}

export function isInsideMap(x: number, z: number): boolean {
  return Math.abs(x) <= MAP_HALF_SIZE && Math.abs(z) <= MAP_HALF_SIZE;
}

export type RoadLevel = 'ground' | 'bridge' | 'tunnel';

/** How a road surface at this position is built, per the elevation conventions. */
export function roadLevel(pos: Vec3): RoadLevel {
  if (pos.y < -1.5) return 'tunnel';
  if (pos.y - terrainHeight(pos.x, pos.z) > 1) return 'bridge';
  return 'ground';
}
