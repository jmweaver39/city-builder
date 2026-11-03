/**
 * The shared look, used by every module that draws into the world, including
 * rail: a clean top-down map in a dry summer palette, in the spirit of
 * Highways & Co. (made procedurally here, nothing copied).
 *
 * Rules of the style:
 * - Colours come from this palette. Ground and roads carry fine, high-resolution
 *   generated texture; models are smooth shaded with flat colour.
 * - Lit materials are MeshStandardMaterial, matte, smooth shaded. Ambient light
 *   comes from the scene environment.
 * - `facet` and `paintFacets` remain for anything that wants hard edges.
 */
import * as THREE from 'three';
import type { RoadTypeDef } from '../core/types';
import { hexRGB, type RGB } from './constants';

/** sRGB hex values, so they can be read and tuned by eye. Convert with `rgb`. */
export const PALETTE = {
  // Ground: dry summer grassland, olive to khaki, muted.
  grass: 0x7e8258,
  grassLight: 0x898a60,
  grassDark: 0x767c52,
  meadow: 0x99956a,
  groundPatch: 0x646f40,
  fieldTan: 0x9a9168,
  soil: 0x9a8a62,
  sand: 0xb1a57c,
  rock: 0x9a978a,
  rockDark: 0x84826f,
  hill: 0x878458,
  water: 0x7c919a,
  waterDeep: 0x677e89,
  foam: 0xd6dcda,
  leaf: 0x4a6533,
  leafLight: 0x55703a,
  leafAutumn: 0x8a7a3c,
  pine: 0x3f5a2c,
  pineDark: 0x36502a,
  trunk: 0x6a5038,
  birchTrunk: 0xd8d2c4,
  // Roads: clean charcoal, pale outlines.
  asphaltStreet: 0x3a3d42,
  asphaltAvenue: 0x36393e,
  asphaltHighway: 0x2e3136,
  asphaltRamp: 0x323539,
  shoulder: 0x3f4247,
  sidewalk: 0x8e8d82,
  kerb: 0xc9c9c4,
  concrete: 0xbab6ac,
  concreteDark: 0xa29e95,
  barrier: 0xd0cec8,
  steel: 0xa8adb2,
  girder: 0x6f7c84,
  busLane: 0x8a4a40,
  bikeLane: 0x4f7a58,
  median: 0x8a8858,
  // Buildings
  wallCream: 0xe8dcc2,
  wallWhite: 0xeeebe4,
  wallPeach: 0xe2bf9c,
  wallBrick: 0xb87a60,
  wallSage: 0xb4c0a4,
  wallSky: 0xa8bccc,
  wallGrey: 0xbcc0c2,
  roofRed: 0xa8574a,
  roofTerracotta: 0xb8704e,
  roofSlate: 0x5a626c,
  roofDark: 0x484e56,
  window: 0x3c5268,
  windowLit: 0xffd98a,
  door: 0x5a4030,
  // Sky
  skyDay: 0x86c0e6,
  skyHorizon: 0xdcecf2,
  skyDusk: 0xf0a670,
  skyNight: 0x16224a,
  sun: 0xfff2d8,
  moon: 0xe8eefc,
  cloud: 0xffffff,
} as const;

/**
 * Facade, roof and trim colours for buildings, sRGB hex, by material. Realistic
 * and muted: the facade textures carry the detail, these set the colour.
 */
export const BUILDING_COLOURS = {
  brick: [0x8a4a36, 0x9c5a40, 0x7a3e30, 0x6e4a3a, 0xa86a4a, 0xc2a27a, 0x8e5a48],
  stone: [0xcfc6b2, 0xbdb5a2, 0xd9d2c2, 0xc4b89c, 0xb0a894],
  concrete: [0xb5b2ab, 0xa7a59f, 0xc4c0b6, 0x9c9a94, 0xbab4a6],
  stucco: [0xe6dccb, 0xd9c7a8, 0xe9e4da, 0xc9b79a, 0xd8cfc0, 0xb8b4a4, 0xe0c9b0],
  siding: [0xe8e6df, 0xa9b7bf, 0xc7b896, 0x8a9a88, 0xd8d4c8, 0x9aa4ac],
  glass: [0x5d7a8a, 0x6e8696, 0x7a6e60, 0x8f9aa2, 0x4f6a78, 0x6a7f7a],
  roofTile: [0xa0523e, 0x8c4a3a, 0xb06a4c, 0x7a4636],
  roofSlate: [0x4e535a, 0x5a5550, 0x45484c, 0x605c58],
  flatRoof: [0x8e8d88, 0x6f6e6a, 0xc9c8c2, 0x9a958a, 0x7c7a74],
  metal: [0xb8bcbe, 0x8c9498, 0xc4c0b4, 0x6a7a84, 0x9aa4a0, 0x7c6a5c],
  trim: [0xe8e4da, 0xd6d0c2, 0x3a3c3e],
  frame: [0xeeeeea, 0x2e3034, 0x5a5e62, 0x6a4e3a],
  sign: [0x2a4a3a, 0x6a2a2a, 0x22324a, 0x1e1e20, 0xd8cfb8, 0x7a5a2a],
  hvac: 0xb8bbbd,
  tank: 0x6a5240,
  door: 0x3a2c22,
} as const;

export type PaletteKey = keyof typeof PALETTE;

/** Palette entry as linear RGB, for vertex colours. */
export function rgb(key: PaletteKey): RGB {
  return hexRGB(PALETTE[key]);
}

/** Palette entry as a THREE.Color. */
export function color(key: PaletteKey): THREE.Color {
  return new THREE.Color(PALETTE[key]);
}

/**
 * Car paint as real traffic has it: mostly white, silver, grey and black, then
 * dark blues and reds, a few brighter colours. Linear RGB, 16 entries.
 */
export const BODY_COLOURS: RGB[] = [
  0xeeeeea, 0xe4e4e0, 0xb8bcc0, 0x9aa0a6, 0x6a6e72, 0x2a2c30, 0x1a1b1e, 0xc4c6c8, 0x8a1e1e, 0xa8302a, 0x1e3456, 0x2a4a7a, 0x3a4a3a, 0x5a4a3a,
  0xd8c8a0, 0x2f6ec8,
].map(hexRGB);

/** Asphalt varies a little by road class, so the hierarchy reads from above. */
export function asphaltFor(def: RoadTypeDef): RGB {
  switch (def.category) {
    case 'highway':
      return rgb('asphaltHighway');
    case 'ramp':
      return rgb('asphaltRamp');
    case 'avenue':
      return rgb('asphaltAvenue');
    default:
      return rgb('asphaltStreet');
  }
}

/** The standard lit material for world geometry: smooth shaded, matte, environment-lit. */
export function worldMaterial(params: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, ...params });
}

/** Older name, kept so existing imports work. Now smooth shaded. */
export const lowPolyMaterial = worldMaterial;

/**
 * Give geometry per-face normals: every triangle gets its own vertices, so light
 * breaks at each edge. Keeps colour and other attributes.
 */
export function facet(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.computeVertexNormals();
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  // computeVertexNormals on non-indexed geometry already gives face normals, but
  // make it exact in case a caller merged triangles.
  for (let i = 0; i < pos.count; i += 3) {
    const ax = pos.getX(i);
    const ay = pos.getY(i);
    const az = pos.getZ(i);
    const ux = pos.getX(i + 1) - ax;
    const uy = pos.getY(i + 1) - ay;
    const uz = pos.getZ(i + 1) - az;
    const vx = pos.getX(i + 2) - ax;
    const vy = pos.getY(i + 2) - ay;
    const vz = pos.getZ(i + 2) - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    for (let k = 0; k < 3; k++) nor.setXYZ(i + k, nx, ny, nz);
  }
  nor.needsUpdate = true;
  return g;
}

/**
 * Paint a whole geometry one colour, with a small per-face tint so the facets
 * read. `jitter` is the largest change in brightness, as a fraction.
 */
export function paintFacets(geometry: THREE.BufferGeometry, base: RGB, jitter = 0.06, seed = 1): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  let s = seed * 9301 + 49297;
  for (let i = 0; i < n; i += 3) {
    s = (s * 9301 + 49297) % 233280;
    const k = 1 + (s / 233280 - 0.5) * 2 * jitter;
    for (let v = 0; v < 3 && i + v < n; v++) {
      col[(i + v) * 3] = base[0] * k;
      col[(i + v) * 3 + 1] = base[1] * k;
      col[(i + v) * 3 + 2] = base[2] * k;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** GLSL: a stable per-facet hash from the flat-interpolated provoking vertex. */
export const FACET_HASH = /* glsl */ `
float facetHash(vec3 p) { return fract(sin(dot(floor(p * 4.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
`;

// ---------------------------------------------------------------------------
// Rail. Moved here from tracks.ts and trains.ts so rail matches the rest.
// ---------------------------------------------------------------------------

/** Track, platform and station colours, linear RGB. */
export const RAIL = {
  ballast: hexRGB(0x8c7e6a),
  ballastDark: hexRGB(0x786c5a),
  railSide: hexRGB(0x6e5a48),
  concrete: hexRGB(PALETTE.concrete),
  concreteDark: hexRGB(PALETTE.concreteDark),
  steel: hexRGB(0xc4c8cc),
  galv: hexRGB(PALETTE.steel),
  white: hexRGB(0xf2f0ea),
  yellow: hexRGB(0xf0c040),
  red: hexRGB(0xd8443a),
  black: hexRGB(0x1a1c20),
  roof: hexRGB(PALETTE.roofSlate),
  glass: hexRGB(PALETTE.window),
  tile: hexRGB(PALETTE.sidewalk),
  grass: hexRGB(PALETTE.grass),
  lamp: hexRGB(PALETTE.windowLit),
  dark: hexRGB(0x2a2e34),
  wood: hexRGB(PALETTE.trunk),
  bench: hexRGB(0x3a78d0),
} as const;

/** Body and accent per freight locomotive owner. */
export const LOCO_LIVERIES: [RGB, RGB][] = [
  [0xf0803a, 0x2a2c30],
  [0x2a64c0, 0xf6c444],
  [0x3a9a58, 0xf2ead2],
  [0xd8443a, 0xd0d4d8],
].map(([a, b]) => [hexRGB(a), hexRGB(b)]);

/** Freight wagon colours, 16. Muted but clean, in the style's range. */
export const WAGON_COLOURS: RGB[] = [
  0xa85a44, 0x8a6650, 0xb07e58, 0x5e8a70, 0x4a6e96, 0x8c939a, 0xa8b0b8, 0x4a4e56, 0xc4b08a, 0x9a4a42, 0x5e7e96, 0xc8c2b4, 0x786e5c, 0xa8906c, 0x7c8a90,
  0x5a5e66,
].map(hexRGB);

/** Container colours, bright and varied, 16. */
export const CONTAINER_COLOURS: RGB[] = [
  0x3a78d0, 0xe24a3a, 0x3aa070, 0xf0943a, 0xa8b0b8, 0x2a5a9c, 0xf6c444, 0x8a4a9c, 0xd8d2c4, 0x3ab0c8, 0xc84040, 0x5a6878, 0xf07850, 0x3a7a50, 0x6a90d0,
  0xa8744e,
].map(hexRGB);

export const TRAIN_SILVER = hexRGB(0xd0d4d8);
export const TRAIN_IVORY = hexRGB(0xf2f0ea);
export const TRAIN_RED = hexRGB(0xd03a3a);
export const TRAIN_GREY = hexRGB(0xdcdedc);
