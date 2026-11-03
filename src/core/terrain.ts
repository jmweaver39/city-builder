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

/** The untouched land: river channel and far hills, before any landscaping. */
export function baseTerrainHeight(x: number, z: number): number {
  const d = riverDistance(x, z);
  const channel = RIVER_DEPTH * (smoothstep(BANK_INNER, BANK_OUTER, d) - 1);
  const hills = hillHeight(x, z);
  if (hills === 0) return channel;
  return channel + hills * smoothstep(BANK_OUTER, VALLEY_OUTER, d);
}

/**
 * Landscaping (core/terrainEdit.ts) installs its height offsets here. Null while
 * nothing is bound, so tests and tools that never edit terrain see the old land.
 */
let editSampler: ((x: number, z: number) => number) | null = null;

/** Install or remove the edit layer's sampler. Only core/terrainEdit.ts calls this. */
export function setTerrainEditSampler(fn: ((x: number, z: number) => number) | null): void {
  editSampler = fn;
}

let editVersion = 0;

/**
 * Changes whenever committed landscaping changes (stroke end, load, undo, roads
 * re-conforming it). Caches of anything derived from terrainHeight key on this.
 */
export function terrainEditVersion(): number {
  return editVersion;
}

/** Only core/terrainEdit.ts calls this. */
export function bumpTerrainEditVersion(): void {
  editVersion++;
}

/** True while any landscaping is in force (the sampler is only installed then). */
export function hasTerrainEdits(): boolean {
  return editSampler !== null;
}

/** Landscaping offset at a point: 0 where the land is as generated. */
export function terrainEditDelta(x: number, z: number): number {
  return editSampler === null ? 0 : editSampler(x, z);
}

/**
 * Ground height in metres at a plan position: the land plus landscaping. Roads'
 * embankments, cuts and quays go on top in core/terrainMods.ts (groundHeight).
 */
export function terrainHeight(x: number, z: number): number {
  const h = baseTerrainHeight(x, z);
  return editSampler === null ? h : h + editSampler(x, z);
}

/**
 * Landscaping's water: 1 wet, 0 dry, -1 where it has nothing to say (unedited
 * land, so the generated river decides). Installed by core/terrainEdit.ts.
 */
let waterSampler: ((x: number, z: number) => number) | null = null;

/** Only core/terrainEdit.ts calls this. */
export function setTerrainWaterSampler(fn: ((x: number, z: number) => number) | null): void {
  waterSampler = fn;
}

/**
 * True where the surface is water. Water reaches only ground below WATER_LEVEL
 * that connects to the river (or that the player let water into), and never a
 * road, trench or tunnel; pits dug elsewhere stay dry. River bed raised above the
 * level is dry land.
 */
export function isWater(x: number, z: number): boolean {
  if (editSampler === null) return riverDistance(x, z) < RIVER_HALF_WIDTH;
  if (terrainHeight(x, z) >= WATER_LEVEL) return false;
  const w = waterSampler === null ? -1 : waterSampler(x, z);
  return w === -1 ? riverDistance(x, z) < RIVER_HALF_WIDTH : w === 1;
}

/**
 * The level things are built on and tunnels are measured from: the ground, with
 * the river's dip counted as 0 (as before landscaping) unless the land was dug
 * deeper. Without edits this is max(terrainHeight, 0).
 */
export function surfaceLevel(x: number, z: number): number {
  const base = baseTerrainHeight(x, z);
  if (editSampler === null) return Math.max(base, 0);
  const d = editSampler(x, z);
  return Math.max(base + d, Math.min(0, d));
}

export function isInsideMap(x: number, z: number): boolean {
  return Math.abs(x) <= MAP_HALF_SIZE && Math.abs(z) <= MAP_HALF_SIZE;
}

export type RoadLevel = 'ground' | 'bridge' | 'tunnel';

/** How a road surface at this position is built, per the elevation conventions. */
export function roadLevel(pos: Vec3): RoadLevel {
  if (pos.y < surfaceLevel(pos.x, pos.z) - 1.5) return 'tunnel';
  if (pos.y - terrainHeight(pos.x, pos.z) > 1) return 'bridge';
  return 'ground';
}
