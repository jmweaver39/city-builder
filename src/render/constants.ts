/** Shared numbers and colours for the render module. Metres unless stated. */
import type { LineStyle, PaintColor, SegmentOverrides } from '../core/types';
import { autoLineSpec, DOUBLE_SPACING, LINE_W, PAINT_HEX, PAINT_MATERIAL, strokesOfSpec } from '../core/paintStandard';

/** Road surfaces float this far above the sampled height, so flat terrain never fights them. */
export const ROAD_LIFT = 0.06;
export const KERB_HEIGHT = 0.15;
/** Deck structure under an elevated road, from the surface down. */
export const DECK_DEPTH = 1.4;
/** Clearance over terrain above which a road counts as elevated. */
export const ELEVATED_CLEARANCE = 1;
/** Road surface height at which a tunnel starts. */
export const TUNNEL_Y = -1.5;
/** Inside height of a tunnel box. */
export const TUNNEL_CLEARANCE = 5.6;
/** Paint sits this far above the surface (core/paintStandard.ts). */
export const MARK_LIFT = PAINT_MATERIAL.lift;

/** gl_FragDepth bias per road rank. Higher ranks draw over lower ranks when coplanar. */
export const BIAS_PER_RANK = 2.5e-7;
export const BIAS_JUNCTION = 4.5e-6;
export const BIAS_MARKING = PAINT_MATERIAL.bias;
/** Hand-placed paint uses the very same bias as automatic paint: one material for all. */
export const BIAS_DECAL = PAINT_MATERIAL.bias;

export type RGB = readonly [number, number, number];

/** Surface kinds, read by the surface shader. */
export const KIND_ASPHALT = 0;
export const KIND_SIDEWALK = 1;
export const KIND_GRASS = 2;
export const KIND_CONCRETE = 3;
export const KIND_PLAIN = 4;
/** Like plain, but never takes road overlay or highlight colour. */
export const KIND_UNTINTED = 5;
/** Asphalt with no lanes: junction fills and dead-end caps. */
export const KIND_JUNCTION = 6;
/** Painted steel: guard rails, girders. Takes no overlay. */
export const KIND_STEEL = 7;
/** Self-lit, for tunnel lamps. */
export const KIND_LAMP = 8;
/** Concrete pavement: the 'concrete' surface override on lanes and junctions. Takes overlays. */
export const KIND_CONCRETE_ROAD = 9;
/** Kerb stones: faces and chamfers. Takes overlays like plain. */
export const KIND_KERB = 10;

/** sRGB hex to linear RGB, so vertex colours match Three.js colour management. */
export function hexRGB(hex: number): RGB {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [c((hex >> 16) & 255), c((hex >> 8) & 255), c(hex & 255)];
}

export const COL = {
  asphalt: hexRGB(0x3a3d42),
  shoulder: hexRGB(0x3f4247),
  busLane: hexRGB(0x8a4a40),
  bikeLane: hexRGB(0x4f7a58),
  kerb: hexRGB(0xc9c9c4),
  sidewalk: hexRGB(0x8e8d82),
  grass: hexRGB(0x8a8858),
  gravel: hexRGB(0x8c8270),
  concrete: hexRGB(0xbab6ac),
  concreteDark: hexRGB(0xa29e95),
  barrier: hexRGB(0xd0cec8),
  steel: hexRGB(0xa8adb2),
  girder: hexRGB(0x6f7c84),
  tunnelInner: hexRGB(0x2e3238),
  black: hexRGB(0x0b0c0e),
} as const;

export const SURFACE_COL: Record<NonNullable<SegmentOverrides['surface']>, RGB> = {
  asphalt: COL.asphalt,
  concrete: hexRGB(0xbab6ac),
  darkAsphalt: hexRGB(0x34363a),
  red: hexRGB(0x8a3b30),
  gravel: hexRGB(0x8c8270),
};

/** The paint colours, linear, from the one palette in core/paintStandard.ts. */
export const PAINT_COL: Record<PaintColor, RGB> = {
  white: hexRGB(parseInt(PAINT_HEX.white.slice(1), 16)),
  yellow: hexRGB(parseInt(PAINT_HEX.yellow.slice(1), 16)),
  blue: hexRGB(parseInt(PAINT_HEX.blue.slice(1), 16)),
  red: hexRGB(parseInt(PAINT_HEX.red.slice(1), 16)),
  green: hexRGB(parseInt(PAINT_HEX.green.slice(1), 16)),
};

export const LINE_WIDTH = LINE_W.lane;
/** Gap between the centres of the two lines of a double. */
export const DOUBLE_GAP = DOUBLE_SPACING;

export interface Stroke {
  /** Lateral shift from the boundary. */
  shift: number;
  /** Dash period in metres, 0 for solid. */
  period: number;
  /** Fraction of the period painted. */
  duty: number;
}

/** The strokes of an automatic line style on a road of the given speed. Left and right are as seen along segment forward. */
export function strokesOf(style: LineStyle, speedKmh = 50): Stroke[] {
  const spec = autoLineSpec(style, 'white', LINE_W.lane, speedKmh);
  if (!spec) return [];
  return (strokesOfSpec(spec) ?? []).map((k) => ({ shift: k.shift, period: k.period, duty: k.duty }));
}

export function lerpRGB(a: RGB, b: RGB, t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
