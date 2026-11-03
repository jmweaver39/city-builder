/**
 * Traffic endpoints: gateway markers at dead ends, and building clusters for
 * zones, sized by rate and set back from the road. The buildings themselves,
 * their buffer and facade material live in buildings.ts.
 */
import * as THREE from 'three';
import type { EndpointKind, Id, TrafficEndpoint, ZoneDensity, ZoneKind, ZoneRegion } from '../core/types';
import { zoneCoverage, zonePolygon, ZONE_STEP } from '../core/zones';
import type { RoadNetwork } from '../core/RoadNetwork';
import { cubicPoint, cubicTangentXZ } from '../core/bezier';
import { totalHalfWidth } from '../core/roadTypes';
import { surfaceLevel } from '../core/terrain';
import { ChunkBatch } from './batch';
import { BUILDING_SCHEMA, BuildingBuf, MAT, WIN, buildingMaterial, disposeBuildingMaterial, facadeColour, midrise, parapetRoof, rooftop, shed, tower, type Footing } from './buildings';
import { ROAD_LIFT, hexRGB, type RGB } from './constants';
import type { Shared } from './materials';
import { BUILDING_COLOURS, PALETTE } from './style';

export { BuildingBuf };

const P = PALETTE;

const ZONE_PALETTE: Record<Exclude<EndpointKind, 'gateway'>, { walls: number[]; roofs: number[]; win: number }> = {
  residential: { walls: [P.wallCream, P.wallWhite, P.wallPeach, P.wallBrick, P.wallSage, P.wallSky], roofs: [P.roofRed, P.roofTerracotta, P.roofSlate], win: 1 },
  commercial: { walls: [P.wallWhite, P.wallCream, P.wallSky, P.wallPeach], roofs: [P.roofDark, P.roofSlate], win: 3 },
  industrial: { walls: [P.wallGrey, P.wallSage, P.wallCream, 0xb8c4cc], roofs: [P.roofSlate, P.roofDark], win: 2 },
  office: { walls: [P.wallSky, P.wallGrey, 0x9cb8d0, P.wallWhite], roofs: [P.roofDark, P.roofSlate], win: 3 },
};

function rngOf(seed: number): () => number {
  let s = seed * 2654435761 + 1;
  return () => {
    s = Math.imul(s ^ (s >>> 15), 1 | s);
    s = (s + Math.imul(s ^ (s >>> 7), 61 | s)) ^ s;
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ZoneFootprint {
  x: number;
  z: number;
  r: number;
}

const ASPHALT = hexRGB(0x5d6168);
const CONCRETE_PAD = hexRGB(0xd8d2c4);
const STRIPE = hexRGB(0xf4f2ec);
const HEDGE = hexRGB(0x46663a);
const GRASS_PAD = hexRGB(0x84b266);
/** Close to the terrain's own grass, a touch fresher, so a lawn reads but does not stand out. */
const LAWN = hexRGB(0x6a7a44);
const PARKED = [0xe8e8e4, 0x9a2a24, 0x2a4a7a, 0x1e2024, 0x8c939a, 0x5a5e62, 0xc8c8c4].map(hexRGB);
const GLASS_DARK = hexRGB(0x30445a);
/** Silos and tanks: pale galvanised or painted steel. */
const SILO = [0xc4c8ca, 0xd0ccc0, 0xaab4b0, 0xb8bcbe];
const STEEL = hexRGB(0xb8c0c6);

/** Rows of bays with a few parked cars. */
function parking(buf: BuildingBuf, cx: number, y: number, cz: number, hw: number, hd: number, fx: number, fz: number, rng: () => number): void {
  const rx = -fz;
  const rz = fx;
  buf.pad(cx, y, cz, hw, hd, fx, fz, ASPHALT);
  const bays = Math.floor((hw * 2) / 2.8);
  for (const row of [-1, 1]) {
    const lineZ = row * (hd - 2.6);
    for (let i = 0; i <= bays; i++) {
      const u = -hw + 0.3 + i * 2.8;
      const px = cx + rx * u + fx * lineZ;
      const pz = cz + rz * u + fz * lineZ;
      buf.block(px, y + 0.08, pz, 0.06, 2.4, 0.01, fx, fz, STRIPE, STRIPE, 0, 0);
      if (i < bays && rng() < 0.55) {
        const cu = u + 1.4;
        const qx = cx + rx * cu + fx * lineZ;
        const qz = cz + rz * cu + fz * lineZ;
        const c = PARKED[Math.floor(rng() * PARKED.length) % PARKED.length];
        buf.block(qx, y + 0.3, qz, 0.88, 2.2, 0.6, fx, fz, c, c, 0, 0, {});
        buf.block(qx, y + 0.9, qz, 0.78, 1.2, 0.45, fx, fz, GLASS_DARK, c, 0, 0, { wall: MAT.glass });
      }
    }
  }
}

type Pick = <T>(a: T[]) => T;

/**
 * One house on its lot. (tx, tz) runs along the street and (fx, fz) away from it.
 * Walls in render, siding or brick on a stone plinth, a tiled or slate roof with
 * a chimney; the door, path and drive are on the street side.
 */
function house(buf: BuildingBuf, x: number, ground: number, z: number, lot: number, tx: number, tz: number, fx: number, fz: number, _pal: { walls: number[]; roofs: number[]; win: number }, rng: () => number, pick: Pick, toStreet: number): void {
  const C = BUILDING_COLOURS;
  const style = rng();
  const wallMat = style < 0.55 ? MAT.stucco : style < 0.8 ? MAT.siding : MAT.brick;
  const wall = facadeColour(rng, wallMat === MAT.stucco ? C.stucco : wallMat === MAT.siding ? C.siding : C.brick);
  const roof = facadeColour(rng, rng() < 0.62 ? C.roofTile : C.roofSlate);
  const plinth = facadeColour(rng, C.stone);
  const mats = { wall: wallMat, roof: MAT.roofTile };
  const seed = rng() * 40;
  buf.ground = ground;
  // Half sizes across the street (hw) and along it (hd). Ridge runs along the street.
  const hd = Math.min(lot * 0.32, 4.6 + rng() * 2.6);
  const hw = 3.6 + rng() * 1.6;
  const floors = rng() < 0.6 ? 2 : 1;
  const h = floors * 2.9;
  const rise = 2 + rng() * 1.6;
  buf.block(x, ground - 0.25, z, hw + 0.1, hd + 0.1, 0.55, tx, tz, plinth, plinth, 0, 0, { wall: MAT.stone, roof: MAT.stone });
  buf.block(x, ground + 0.3, z, hw, hd, h, tx, tz, wall, roof, WIN.house, seed, mats);
  buf.gable(x, ground + 0.3 + h, z, hw, hd, rise, tx, tz, roof, wall, 0.45, mats);
  // Chimney through one slope, near an end.
  const cs = rng() < 0.5 ? -1 : 1;
  const chx = x + tx * hd * 0.6 * cs - fx * hw * 0.35;
  const chz = z + tz * hd * 0.6 * cs - fz * hw * 0.35;
  const brick = facadeColour(rng, C.brick);
  buf.block(chx, ground + 0.3 + h + rise * 0.3, chz, 0.38, 0.5, rise * 0.75 + 0.8, tx, tz, brick, brick, 0, 0, { wall: MAT.brick, roof: MAT.stone });
  // A wing toward the street turns some houses into an L.
  if (rng() < 0.45) {
    const off = hd * 0.55 * (rng() < 0.5 ? -1 : 1);
    const ww = 2.4 + rng() * 0.8;
    const wd = 2.6 + rng() * 1;
    const wx = x + tx * off - fx * (hw + wd - 0.2);
    const wz = z + tz * off - fz * (hw + wd - 0.2);
    const wh = Math.min(h, 2.9);
    buf.block(wx, ground - 0.25, wz, wd + 0.1, ww + 0.1, 0.55, tx, tz, plinth, plinth, 0, 0, { wall: MAT.stone, roof: MAT.stone });
    buf.block(wx, ground + 0.3, wz, wd, ww, wh, tx, tz, wall, roof, WIN.house, seed + 7, mats);
    buf.gable(wx, ground + 0.3 + wh, wz, ww, wd, 1.5, fx, fz, roof, wall, 0.3, mats);
  }
  // Front door with a canopy, and a step.
  const front = hw + 0.03;
  const doorX = x - fx * front + tx * hd * 0.25;
  const doorZ = z - fz * front + tz * hd * 0.25;
  const doorC = hexRGB(pick([0x3a2a20, 0x24406a, 0x6a2a22, 0x2c4a34, 0xe8e4da]));
  buf.block(doorX, ground + 0.3, doorZ, 0.06, 0.5, 2.1, tx, tz, doorC, wall, 0, 0);
  buf.block(doorX - fx * 0.5, ground + 2.55, doorZ - fz * 0.5, 0.55, 0.8, 0.1, tx, tz, roof, roof, 0, 0);
  buf.block(doorX - fx * 0.6, ground, doorZ - fz * 0.6, 0.6, 0.8, 0.3, tx, tz, plinth, plinth, 0, 0, { wall: MAT.stone, roof: MAT.stone });
  // Path to the street, hedge along it with a gap at the path.
  const pathLen = Math.max(1, (toStreet - hw) / 2);
  const pathX = doorX - fx * pathLen;
  const pathZ = doorZ - fz * pathLen;
  buf.pad(pathX, ground + 0.02, pathZ, 0.7, pathLen, fx, fz, CONCRETE_PAD, MAT.stone);
  const hedgeBack = toStreet - 0.8;
  for (const dir of [-1, 1]) {
    const len = lot * 0.22;
    const hx = x - fx * hedgeBack + tx * (hd * 0.25 + dir * (len + 1));
    const hz = z - fz * hedgeBack + tz * (hd * 0.25 + dir * (len + 1));
    buf.block(hx, ground, hz, 0.45, len, 0.9 + rng() * 0.4, tx, tz, HEDGE, HEDGE, WIN.hedge, 0, { wall: MAT.hedge, roof: MAT.hedge });
  }
  // Garage and drive on some lots, a shed behind on others.
  if (rng() < 0.55) {
    const gOff = -(hd + 2.2);
    const gx = x + tx * gOff;
    const gz = z + tz * gOff;
    buf.block(gx, ground, gz, 3, 1.8, 2.6, tx, tz, wall, hexRGB(0x5a5a58), 0, 0, { wall: wallMat, roof: MAT.flatRoof });
    buf.block(gx - fx * 3.03, ground + 0.04, gz - fz * 3.03, 0.05, 1.45, 2.1, tx, tz, hexRGB(0xd8d6ce), wall, 0, 0, { wall: MAT.siding });
    const driveLen = Math.max(1, (toStreet - 3) / 2);
    buf.pad(gx - fx * (3 + driveLen), ground + 0.02, gz - fz * (3 + driveLen), 1.6, driveLen, fx, fz, ASPHALT);
  } else if (rng() < 0.6) {
    const shedC = hexRGB(0x7a5e44);
    buf.block(x + fx * (hw + 3.2), ground, z + fz * (hw + 3.2), 1.3, 1.6, 2.1, tx, tz, shedC, roof, 0, 0, { wall: MAT.siding });
    buf.gable(x + fx * (hw + 3.2), ground + 2.1, z + fz * (hw + 3.2), 1.3, 1.6, 0.6, tx, tz, roof, shedC, 0.15, { roof: MAT.roofTile, wall: MAT.siding });
  }
}

/** A footing from the old block-style arguments: centre, half sizes, f along hd. */
function footing(x: number, z: number, ground: number, hw: number, hd: number, fx: number, fz: number): Footing {
  return { x, z, ground, hw, hd, fx, fz };
}

/** One or two storeys of shops under a flat roof, with a canopy over the pavement. */
function shopStrip(buf: BuildingBuf, f: Footing, floors: number, rng: () => number, canopyAt: { x: number; z: number } | null): void {
  const C = BUILDING_COLOURS;
  const wallMat = rng() < 0.5 ? MAT.brick : MAT.stucco;
  const wall = facadeColour(rng, wallMat === MAT.brick ? C.brick : C.stucco);
  const stone = facadeColour(rng, C.stone);
  const roof = facadeColour(rng, C.flatRoof);
  const seed = rng() * 40;
  buf.ground = f.ground;
  buf.block(f.x, f.ground - 0.3, f.z, f.hw + 0.06, f.hd + 0.06, 0.31, f.fx, f.fz, stone, stone, 0, 0, { wall: MAT.stone, roof: MAT.stone });
  buf.block(f.x, f.ground, f.z, f.hw, f.hd, 4.5, f.fx, f.fz, wall, roof, WIN.shop, seed, { wall: wallMat });
  let y = f.ground + 4.5;
  if (floors > 1) {
    buf.block(f.x, y, f.z, f.hw, f.hd, 3.4, f.fx, f.fz, wall, roof, WIN.apartment, seed + 2, { wall: wallMat });
    y += 3.4;
  }
  buf.block(f.x, y, f.z, f.hw + 0.25, f.hd + 0.25, 0.35, f.fx, f.fz, stone, stone, 0, 0, { wall: MAT.stone, roof: MAT.stone });
  parapetRoof(buf, f, y + 0.35, wall, wallMat, roof, 0.8);
  rooftop(buf, f, y + 0.35, rng, { units: 1 + Math.floor(rng() * 3) });
  if (canopyAt) {
    const awning = hexRGB([0x6a2a22, 0x22324a, 0x2a4a3a, 0x3a3c3e][Math.floor(rng() * 4)]);
    buf.block(canopyAt.x, f.ground + 3.2, canopyAt.z, 1.4, f.hd * 0.9, 0.18, f.fx, f.fz, awning, awning, 0, 0, { wall: MAT.siding, roof: MAT.siding });
  }
}

export function buildZone(net: RoadNetwork, ep: TrafficEndpoint, buf: BuildingBuf): ZoneFootprint | null {
  if (ep.segmentId === null || ep.kind === 'gateway') return null;
  const seg = net.getSegment(ep.segmentId);
  if (!seg) return null;
  const c = net.cubicOf(seg.id);
  const def = net.roadTypeOf(seg.id);
  const p = cubicPoint(c, ep.t);
  const tan = cubicTangentXZ(c, ep.t);
  const side = ep.side;
  const rx = -tan.z * side;
  const rz = tan.x * side;
  const scale = Math.min(2.2, 0.7 + Math.sqrt(Math.max(ep.ratePerHour, 40)) / 26);
  const setback = totalHalfWidth(def) + 6;
  const depth = 34 * scale;
  const width = 62 * scale;
  const cx = p.x + rx * (setback + depth / 2);
  const cz = p.z + rz * (setback + depth / 2);
  const ground = surfaceLevel(cx, cz) + 0.08;
  const pal = ZONE_PALETTE[ep.kind];
  const rng = rngOf(ep.id + 1);
  const pick = <T,>(a: T[]): T => a[Math.floor(rng() * a.length) % a.length];
  // Building plot faces the road. v runs from the road (-1) to the back of the plot (1).
  const fx = rx;
  const fz = rz;
  const tx = tan.x;
  const tz = tan.z;
  const place = (u: number, v: number) => ({ x: cx + tx * u * (width / 2) + fx * v * (depth / 2), z: cz + tz * u * (width / 2) + fz * v * (depth / 2) });
  // A driveway from the road edge to the plot.
  const roadEdge = totalHalfWidth(def);
  const drive = { x: p.x + rx * (roadEdge + (setback - roadEdge + 8) / 2), z: p.z + rz * (roadEdge + (setback - roadEdge + 8) / 2) };
  buf.pad(drive.x, ground, drive.z, 3.2, (setback - roadEdge + 8) / 2, fx, fz, ASPHALT);
  const count = Math.round(2 + scale * 2);
  if (ep.kind === 'residential') {
    buf.flat(cx, surfaceLevel(cx, cz) + 0.03, cz, width / 2, depth / 2, fx, fz, LAWN);
    // Lots of different widths, so a street is not a row of copies.
    let walk = -width / 2 + 2;
    let guard = 0;
    while (walk < width / 2 - 12 && guard++ < 12) {
      const lot = 15 + rng() * 9;
      const along = walk + lot / 2;
      walk += lot;
      const back = -depth * 0.12 + rng() * depth * 0.2;
      const hx = cx + tx * along + fx * back;
      const hz = cz + tz * along + fz * back;
      house(buf, hx, ground, hz, lot, tx, tz, fx, fz, pal, rng, pick, depth / 2 + back);
    }
    } else if (ep.kind === 'commercial') {
    const lot = place(0, -0.56);
    parking(buf, lot.x, ground, lot.z, width * 0.46, depth * 0.24, fx, fz, rng);
    for (let i = 0; i < count; i++) {
      const u = ((i + 0.5) / count) * 2 - 1;
      const at = place(u, 0.42);
      const hw = (width / count) * (0.36 + rng() * 0.1);
      const hd = depth * (0.2 + rng() * 0.08);
      const floors = 1 + Math.floor(rng() * 3);
      const f = footing(at.x, at.z, ground, hw, hd, tx, tz);
      if (floors <= 2) shopStrip(buf, f, floors, rng, place(u, 0.42 - (hd + 1.4) / (depth / 2)));
      else midrise(buf, f, floors + 1, 'mixed', rng);
    }
  } else if (ep.kind === 'industrial') {
    buf.pad(cx, ground - 0.01, cz, width / 2, depth / 2, fx, fz, CONCRETE_PAD, MAT.concrete);
    const n = Math.max(2, count - 1);
    for (let i = 0; i < n; i++) {
      const u = ((i + 0.5) / n) * 2 - 1;
      const at = place(u, 0.24);
      const hw = (width / n) * (0.32 + rng() * 0.1);
      const hd = depth * (0.26 + rng() * 0.1);
      shed(buf, footing(at.x, at.z, ground, hd, hw, fx, fz), 6.5 + rng() * 4, rng, rng() < 0.5);
      if (rng() < 0.7) {
        const t = place(u + 0.3, 0.84);
        buf.drum(t.x, ground, t.z, 2.2 + rng() * 1.8, 6 + rng() * 5, facadeColour(rng, SILO), hexRGB(0x8a8c8a), MAT.metal);
      }
    }
    const stack = place(-0.8, 0.7);
    buf.drum(stack.x, ground, stack.z, 0.9, 24 + rng() * 10, hexRGB(0x8a7a6c), hexRGB(0x302c28), MAT.brick, 0.05);
  } else {
    const lot = place(0, -0.62);
    parking(buf, lot.x, ground, lot.z, width * 0.46, depth * 0.2, fx, fz, rng);
    const towers = Math.max(1, count - 1);
    for (let i = 0; i < towers; i++) {
      const u = ((i + 0.5) / towers) * 2 - 1;
      const at = place(u * 0.8, 0.4);
      const hw = Math.min((width / towers) * (0.26 + rng() * 0.1), 15);
      const hd = Math.min(depth * (0.22 + rng() * 0.08), 13);
      const floors = 6 + Math.floor(rng() * (2 + scale * 3));
      tower(buf, footing(at.x, at.z, ground, hw, hd, tx, tz), floors, rng);
    }
  }
  return { x: cx, z: cz, r: Math.hypot(width, depth) / 2 };
}

// ---------------------------------------------------------------------------
// Zoned regions: lots facing the nearest road
// ---------------------------------------------------------------------------

/** Lot width along the road and depth away from it, by kind and density. */
const LOTS: Record<ZoneKind, Record<ZoneDensity, [number, number]>> = {
  residential: { low: [17, 26], medium: [22, 22], high: [30, 30] },
  commercial: { low: [24, 28], medium: [28, 30], high: [32, 32] },
  industrial: { low: [36, 40], medium: [38, 40], high: [40, 42] },
  office: { low: [28, 30], medium: [30, 32], high: [34, 34] },
};
const MAX_LOTS = 400;

/** Changes whenever the region, or a road it could see, changes shape. */
function regionKey(net: RoadNetwork, region: ZoneRegion): string {
  const poly = zonePolygon(net, region);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxZ = Math.max(maxZ, p.z);
  }
  const roads = net
    .segmentsInRegion({ minX: minX - 40, minZ: minZ - 40, maxX: maxX + 40, maxZ: maxZ + 40 }, true)
    .map((id) => {
      const c = net.cubicOf(id);
      return `${id}:${c.p0.x.toFixed(1)},${c.p0.z.toFixed(1)},${c.p3.x.toFixed(1)},${c.p3.z.toFixed(1)},${c.p1.x.toFixed(1)},${c.p2.z.toFixed(1)}`;
    })
    .sort()
    .join('|');
  const later = (net.project.zones ?? []).map((z) => z.id).join(',');
  return JSON.stringify([region.kind, region.density, region.enabled, poly.map((p) => [Math.round(p.x * 10), Math.round(p.z * 10)]), roads, later]);
}

/** One building on a lot. (tx, tz) runs along the road, (fx, fz) away from it. */
function lotBuilding(buf: BuildingBuf, kind: ZoneKind, density: ZoneDensity, x: number, ground: number, z: number, w: number, d: number, tx: number, tz: number, fx: number, fz: number, rng: () => number): void {
  const pal = ZONE_PALETTE[kind as Exclude<EndpointKind, 'gateway'>];
  const pick = <T,>(a: T[]): T => a[Math.floor(rng() * a.length) % a.length];
  // Half sizes across the road (hw) and along it (hd), kept inside the lot.
  const hd = w * (0.3 + rng() * 0.08);
  const hw = d * (0.26 + rng() * 0.08);
  const back = d * 0.08;
  const bx = x + fx * back;
  const bz = z + fz * back;
  const f = footing(bx, bz, ground, hw, hd, tx, tz);
  if (kind === 'residential') {
    if (density === 'low') {
      buf.flat(x, surfaceLevel(x, z) + 0.03, z, w / 2, d / 2, tx, tz, LAWN);
      house(buf, bx, ground, bz, w, tx, tz, fx, fz, pal, rng, pick, d / 2 + back);
      return;
    }
    if (density === 'medium') {
      const floors = 3 + Math.floor(rng() * 2);
      if (rng() < 0.45) {
        // A gabled block of flats.
        const C = BUILDING_COLOURS;
        const wallMat = rng() < 0.6 ? MAT.brick : MAT.stucco;
        const wall = facadeColour(rng, wallMat === MAT.brick ? C.brick : C.stucco);
        const roof = facadeColour(rng, rng() < 0.5 ? C.roofTile : C.roofSlate);
        const stone = facadeColour(rng, C.stone);
        buf.ground = ground;
        buf.block(bx, ground - 0.3, bz, hw + 0.06, hd + 0.06, 0.31, tx, tz, stone, stone, 0, 0, { wall: MAT.stone, roof: MAT.stone });
        buf.block(bx, ground, bz, hw, hd, floors * 3, tx, tz, wall, roof, WIN.apartment, rng() * 40, { wall: wallMat });
        buf.gable(bx, ground + floors * 3, bz, hw, hd, 2.6, tx, tz, roof, wall, 0.4, { roof: MAT.roofTile, wall: wallMat });
        return;
      }
      midrise(buf, f, floors, 'flats', rng);
      return;
    }
    midrise(buf, f, 6 + Math.floor(rng() * 8), 'flats', rng);
    return;
  }
  if (kind === 'industrial') {
    const h = (density === 'high' ? 10 : density === 'medium' ? 8 : 6.5) + rng() * 3;
    buf.pad(x, ground - 0.01, z, w / 2, d / 2, fx, fz, CONCRETE_PAD, MAT.concrete);
    shed(buf, f, h, rng, false);
    if (rng() < 0.5) {
      const r = 2 + rng() * 1.5;
      buf.drum(x + fx * (d / 2 - r - 1) + tx * (w / 2 - r - 1), ground, z + fz * (d / 2 - r - 1) + tz * (w / 2 - r - 1), r, 6 + rng() * 5, facadeColour(rng, SILO), hexRGB(0x8a8c8a), MAT.metal);
    }
    return;
  }
  const floorsBy: Record<ZoneDensity, [number, number]> =
    kind === 'commercial' ? { low: [1, 2], medium: [3, 5], high: [8, 16] } : { low: [3, 4], medium: [6, 10], high: [14, 28] };
  const [lo, hi] = floorsBy[density];
  const floors = lo + Math.floor(rng() * (hi - lo + 1));
  if (density === 'low') parking(buf, x - fx * (d * 0.3), ground, z - fz * (d * 0.3), w * 0.42, d * 0.16, fx, fz, rng);
  if (kind === 'commercial' && floors <= 2) {
    shopStrip(buf, f, floors, rng, { x: bx - fx * (hw + 1.4), z: bz - fz * (hw + 1.4) });
    return;
  }
  if (density === 'high' && (kind === 'office' || rng() < 0.6)) {
    tower(buf, { ...f, hw: f.hw * 0.86, hd: f.hd * 0.86 }, floors, rng);
    return;
  }
  midrise(buf, f, floors, kind === 'office' ? 'offices' : 'mixed', rng);
}

/**
 * Buildings over a region's zoned cells, on lots facing the nearest road. Lots go
 * nearest the road first, so frontage fills before the back of a deep block.
 */
export function buildRegion(net: RoadNetwork, region: ZoneRegion, buf: BuildingBuf): ZoneFootprint[] {
  if (region.kind === 'none') return [];
  const kind = region.kind;
  const cells = zoneCoverage(net, region.id).cells;
  if (!cells.length) return [];
  const cellKey = (x: number, z: number) => `${Math.floor(x / ZONE_STEP)},${Math.floor(z / ZONE_STEP)}`;
  const have = new Set(cells.map((c) => cellKey(c.x, c.z)));
  const zoned = (x: number, z: number) => have.has(cellKey(x, z));
  const [w, d] = LOTS[kind][region.density];
  const rng = rngOf(region.id + 7);
  const scored = cells.map((c) => {
    const hit = net.nearestSegment({ x: c.x, y: 0, z: c.z }, 120);
    return { c, hit, d: hit ? hit.distance : 1e9 };
  });
  scored.sort((a, b) => a.d - b.d);
  const placed: ZoneFootprint[] = [];
  const r = Math.min(w, d) / 2;
  for (const { c, hit } of scored) {
    if (placed.length >= MAX_LOTS) break;
    let tx = 1;
    let tz = 0;
    let fx = 0;
    let fz = 1;
    if (hit) {
      const t = cubicTangentXZ(net.cubicOf(hit.segmentId), hit.t);
      tx = t.x;
      tz = t.z;
      // Away from the road, on whichever side the lot is.
      const side = hit.lateral >= 0 ? 1 : -1;
      fx = -t.z * side;
      fz = t.x * side;
    }
    // Put the lot's front at this cell, so it backs away from the road.
    const cx = c.x + fx * (d / 2 - ZONE_STEP / 2);
    const cz = c.z + fz * (d / 2 - ZONE_STEP / 2);
    if (placed.some((p) => Math.hypot(p.x - cx, p.z - cz) < (p.r + r) * 0.98)) continue;
    let ok = true;
    for (const [su, sv] of [[0, 0], [-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45], [0, 0.45], [0, -0.45]]) {
      if (!zoned(cx + tx * su * w + fx * sv * d, cz + tz * su * w + fz * sv * d)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const ground = surfaceLevel(cx, cz) + 0.08;
    lotBuilding(buf, kind, region.density, cx, ground, cz, w, d, tx, tz, fx, fz, rng);
    placed.push({ x: cx, z: cz, r });
  }
  return placed;
}

/** Gantry over a dead end: a sign bridging the road, with a big arrow pointing the way out. */
function buildGateway(net: RoadNetwork, ep: TrafficEndpoint, nodeId: Id, bars: number[]): void {
  const g = net.nodeGeom(nodeId);
  const arm = g?.arms[0];
  if (!arm) return;
  const def = net.roadTypeOf(arm.segmentId);
  const hw = totalHalfWidth(def) + 0.8;
  const oy = arm.centre.y + ROAD_LIFT;
  const fx = -arm.dir.x; // Off the map.
  const fz = -arm.dir.z;
  bars.push(arm.centre.x, oy, arm.centre.z, fx, fz, hw, ep.enabled ? 1 : 0);
}

export class EndpointLayer {
  readonly group = new THREE.Group();
  private batch: ChunkBatch;
  /** Rooftop plant and other small parts, dropped beyond `detailRange`. */
  private detailBatch: ChunkBatch;
  private material: THREE.MeshStandardMaterial;
  /** Metres from the camera within which small building parts are drawn. 0 hides them. */
  detailRange = 900;
  private known = new Set<Id>();
  private gateways: THREE.Mesh | null = null;
  private gatewayMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.55, metalness: 0.4 });
  private arrowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.92, side: THREE.DoubleSide, depthWrite: false });
  private arrows: THREE.Mesh | null = null;
  footprints: ZoneFootprint[] = [];
  private regionCache = new Map<Id, { key: string; footprints: ZoneFootprint[] }>();

  constructor(
    private readonly net: RoadNetwork,
    shared: Shared,
  ) {
    this.material = buildingMaterial(shared);
    this.batch = new ChunkBatch(BUILDING_SCHEMA, this.material, { castShadow: true, receiveShadow: true, chunkSize: 500 });
    this.detailBatch = new ChunkBatch(BUILDING_SCHEMA, this.material, { castShadow: true, receiveShadow: true, chunkSize: 160 });
    this.group.add(this.batch.group, this.detailBatch.group);
  }

  rebuild(): void {
    const seen = new Set<Id>();
    this.footprints = [];
    const bars: number[] = [];
    for (const ep of this.net.endpoints) {
      seen.add(ep.id);
      if (ep.kind === 'gateway') {
        this.batch.set(ep.id, null);
        if (ep.nodeId !== null) buildGateway(this.net, ep, ep.nodeId, bars);
        continue;
      }
      // A region draws its own buildings, so its access points draw none.
      if (ep.regionId !== undefined) {
        this.batch.set(ep.id, null);
        this.detailBatch.set(ep.id, null);
        continue;
      }
      const buf = new BuildingBuf();
      buf.detail = new BuildingBuf();
      const fp = buildZone(this.net, ep, buf);
      if (fp) this.footprints.push(fp);
      this.batch.set(ep.id, buf.toPiece());
      this.detailBatch.set(ep.id, buf.detail.toPiece());
    }
    for (const region of this.net.project.zones ?? []) {
      if (region.kind === 'none') continue;
      seen.add(region.id);
      const key = regionKey(this.net, region);
      const cached = this.regionCache.get(region.id);
      if (cached && cached.key === key) {
        this.footprints.push(...cached.footprints);
        continue;
      }
      const buf = new BuildingBuf();
      buf.detail = new BuildingBuf();
      const footprints = buildRegion(this.net, region, buf);
      this.regionCache.set(region.id, { key, footprints });
      this.footprints.push(...footprints);
      this.batch.set(region.id, buf.toPiece());
      this.detailBatch.set(region.id, buf.detail.toPiece());
    }
    for (const id of this.regionCache.keys()) if (!seen.has(id)) this.regionCache.delete(id);
    for (const id of this.known) {
      if (seen.has(id)) continue;
      this.batch.set(id, null);
      this.detailBatch.set(id, null);
    }
    this.known = seen;
    this.batch.flush();
    this.detailBatch.flush();
    this.rebuildGateways(bars);
  }

  private rebuildGateways(bars: number[]): void {
    for (const m of [this.gateways, this.arrows]) {
      if (m) {
        m.geometry.dispose();
        this.group.remove(m);
      }
    }
    this.gateways = this.arrows = null;
    if (!bars.length) return;
    const pos: number[] = [];
    const nor: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const box = (cx: number, y0: number, cz: number, hr: number, hu: number, hf: number, rx: number, rz: number, fx: number, fz: number, color: RGB) => {
      const p = (sr: number, su: number, sf: number) => [cx + rx * sr * hr + fx * sf * hf, y0 + hu + su * hu, cz + rz * sr * hr + fz * sf * hf];
      const faces: number[][][] = [
        [p(-1, 1, -1), p(1, 1, -1), p(1, 1, 1), p(-1, 1, 1)],
        [p(1, 1, -1), p(1, -1, -1), p(1, -1, 1), p(1, 1, 1)],
        [p(-1, -1, -1), p(-1, 1, -1), p(-1, 1, 1), p(-1, -1, 1)],
        [p(-1, -1, 1), p(-1, 1, 1), p(1, 1, 1), p(1, -1, 1)],
        [p(1, -1, -1), p(1, 1, -1), p(-1, 1, -1), p(-1, -1, -1)],
      ];
      for (const q of faces) {
        const [a, b, , d] = q;
        const ux = b[0] - a[0];
        const uy = b[1] - a[1];
        const uz = b[2] - a[2];
        const vx = d[0] - a[0];
        const vy = d[1] - a[1];
        const vz = d[2] - a[2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        const v = pos.length / 3;
        for (const c of q) {
          pos.push(c[0], c[1], c[2]);
          nor.push(nx / l, ny / l, nz / l);
          col.push(color[0], color[1], color[2]);
        }
        idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      }
    };
    const steel = hexRGB(0x5c6268);
    const panel = hexRGB(0x1f6a48);
    const off = hexRGB(0x5b5d60);
    const arrowPos: number[] = [];
    const arrowCol: number[] = [];
    for (let i = 0; i < bars.length; i += 7) {
      const [x, y, z, fx, fz, hw, on] = bars.slice(i, i + 7);
      const rx = -fz;
      const rz = fx;
      const h = 7;
      box(x + rx * hw, y - 0.3, z + rz * hw, 0.16, (h + 0.3) / 2 + 0.2, 0.16, rx, rz, fx, fz, steel);
      box(x - rx * hw, y - 0.3, z - rz * hw, 0.16, (h + 0.3) / 2 + 0.2, 0.16, rx, rz, fx, fz, steel);
      box(x, y + h - 0.3, z, hw, 0.12, 0.12, rx, rz, fx, fz, steel);
      box(x, y + h - 2.1, z, Math.min(hw * 0.7, 6), 0.9, 0.08, rx, rz, fx, fz, on ? panel : off);
      // Ground arrow, floating chevrons out of the map.
      const c = on ? [0.3, 0.85, 1] : [0.6, 0.6, 0.6];
      for (let k = 0; k < 3; k++) {
        const d = 2 + k * 3.4;
        const w = Math.min(hw, 3.2);
        const ax = x + fx * d;
        const az = z + fz * d;
        const ay = y + 0.1;
        const tipX = ax + fx * 2.4;
        const tipZ = az + fz * 2.4;
        const lx = ax - rx * w;
        const lz = az - rz * w;
        const qx = ax + rx * w;
        const qz = az + rz * w;
        const t = 1.1;
        arrowPos.push(lx, ay, lz, tipX, ay, tipZ, tipX - fx * t, ay, tipZ - fz * t);
        arrowPos.push(lx, ay, lz, tipX - fx * t, ay, tipZ - fz * t, lx - fx * t, ay, lz - fz * t);
        arrowPos.push(qx, ay, qz, tipX, ay, tipZ, tipX - fx * t, ay, tipZ - fz * t);
        arrowPos.push(qx, ay, qz, tipX - fx * t, ay, tipZ - fz * t, qx - fx * t, ay, qz - fz * t);
        for (let v = 0; v < 12; v++) arrowCol.push(c[0], c[1], c[2]);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    this.gateways = new THREE.Mesh(geo, this.gatewayMat);
    this.gateways.castShadow = true;
    this.group.add(this.gateways);
    const ag = new THREE.BufferGeometry();
    ag.setAttribute('position', new THREE.Float32BufferAttribute(arrowPos, 3));
    ag.setAttribute('color', new THREE.Float32BufferAttribute(arrowCol, 3));
    this.arrows = new THREE.Mesh(ag, this.arrowMat);
    this.arrows.renderOrder = 7;
    this.group.add(this.arrows);
  }

  /** Show small parts only near the camera. Cheap: one distance test per chunk. */
  update(camera: THREE.Vector3): boolean {
    const r2 = this.detailRange * this.detailRange;
    let changed = false;
    for (const child of this.detailBatch.group.children) {
      const mesh = child as THREE.Mesh;
      const s = mesh.geometry.boundingSphere;
      if (!s) continue;
      const d = Math.max(0, camera.distanceTo(s.center) - s.radius);
      const show = d * d < r2;
      if (mesh.visible !== show) {
        mesh.visible = show;
        changed = true;
      }
    }
    return changed;
  }

  dispose(): void {
    this.batch.dispose();
    this.detailBatch.dispose();
    disposeBuildingMaterial(this.material);
    this.gatewayMat.dispose();
    this.arrowMat.dispose();
    this.gateways?.geometry.dispose();
    this.arrows?.geometry.dispose();
    this.group.clear();
  }
}
