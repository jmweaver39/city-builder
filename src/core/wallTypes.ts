/**
 * Persisted shapes for road structures (embankments, retaining walls, trenches),
 * sound barriers and quay walls. Logic lives in walls.ts and terrainMods.ts.
 */
import type { Id } from './types';

/**
 * How a segment is carried where it leaves the ground.
 * - auto: pillars when raised, tunnel when sunk (the original behaviour).
 * - embankment: raised on an earth bank, sloped sides unless a side has a wall.
 * - retaining: raised between vertical walls with infill, unless a side's wall is off.
 * - trench: sunk in an open cut between vertical walls, no roof.
 * - cut: sunk in an open cut with earth slopes, unless a side has a wall.
 * - pillars: a viaduct wherever raised, with piers even on low stretches.
 * - tunnel: covered wherever sunk, with no open cut stretch.
 */
export type StructureMode = 'auto' | 'embankment' | 'retaining' | 'trench' | 'cut' | 'pillars' | 'tunnel';

export type WallStyle = 'concrete' | 'brick' | 'stone' | 'gabion' | 'precast';
export type WallTop = 'coping' | 'railing' | 'fence';

/** One side of a road's structure. Left and right are as seen along segment a to b. */
export interface WallSide {
  /** Wall on this side. Absent means the mode's default (on for retaining and trench). */
  on?: boolean;
  style: WallStyle;
  top: WallTop;
  /**
   * Most visible wall height in metres. Where the road needs more, the rest is an
   * earth slope (above the wall when raised, above it in a trench). Absent follows
   * the road all the way.
   */
  height?: number;
}

export interface StructureSpec {
  mode: StructureMode;
  left?: WallSide;
  right?: WallSide;
}

export type BarrierKind = 'none' | 'concrete' | 'acrylic' | 'timber' | 'metal' | 'berm';

export interface BarrierSide {
  kind: BarrierKind;
  /** 2 to 6 m. */
  height: number;
}

/** Sound barriers along each road edge. Absent sides have none. */
export interface BarrierSpec {
  left?: BarrierSide;
  right?: BarrierSide;
}

export type QuayStyle = 'concrete' | 'brick' | 'stone' | 'timber';
export type QuayTop = 'coping' | 'railing' | 'bollards';

/**
 * A quay wall along one bank of the river. The wall follows the bank between two
 * points along the river's course, measured as x on the centreline, and holds the
 * land at road level right up to the water.
 */
export interface Quay {
  id: Id;
  /** 1 is the bank at larger z (south on the map), -1 the other. */
  bank: 1 | -1;
  /** Ends along the river, as centreline x. x0 < x1. */
  x0: number;
  x1: number;
  style: QuayStyle;
  top: QuayTop;
}

export const STRUCTURE_MODES: readonly { value: StructureMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'embankment', label: 'Embankment' },
  { value: 'retaining', label: 'Retaining wall' },
  { value: 'trench', label: 'Trench' },
  { value: 'cut', label: 'Sloped cut' },
  { value: 'pillars', label: 'Pillars' },
  { value: 'tunnel', label: 'Tunnel' },
];

export const WALL_STYLES: readonly { value: WallStyle; label: string }[] = [
  { value: 'concrete', label: 'Concrete' },
  { value: 'brick', label: 'Brick' },
  { value: 'stone', label: 'Stone' },
  { value: 'gabion', label: 'Gabion' },
  { value: 'precast', label: 'Precast panels' },
];

export const WALL_TOPS: readonly { value: WallTop; label: string }[] = [
  { value: 'coping', label: 'Plain coping' },
  { value: 'railing', label: 'Railing' },
  { value: 'fence', label: 'Fence' },
];

export const BARRIER_KINDS: readonly { value: BarrierKind; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'concrete', label: 'Concrete panels' },
  { value: 'acrylic', label: 'Transparent acrylic' },
  { value: 'timber', label: 'Timber' },
  { value: 'metal', label: 'Metal acoustic' },
  { value: 'berm', label: 'Earth berm' },
];

export const QUAY_STYLES: readonly { value: QuayStyle; label: string }[] = [
  { value: 'concrete', label: 'Concrete' },
  { value: 'brick', label: 'Brick' },
  { value: 'stone', label: 'Stone blocks' },
  { value: 'timber', label: 'Timber piles' },
];

export const QUAY_TOPS: readonly { value: QuayTop; label: string }[] = [
  { value: 'coping', label: 'Coping' },
  { value: 'railing', label: 'Railing' },
  { value: 'bollards', label: 'Bollards' },
];

export const BARRIER_MIN_HEIGHT = 2;
export const BARRIER_MAX_HEIGHT = 6;
