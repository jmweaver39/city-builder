/**
 * Traffic endpoints: gateway markers at dead ends, and low-poly building
 * clusters for zones, sized by rate and set back from the road.
 */
import * as THREE from 'three';
import type { EndpointKind, Id, TrafficEndpoint } from '../core/types';
import type { RoadNetwork } from '../core/RoadNetwork';
import { cubicPoint, cubicTangentXZ } from '../core/bezier';
import { totalHalfWidth } from '../core/roadTypes';
import { terrainHeight } from '../core/terrain';
import type { AttrSpec, Piece } from './batch';
import { ChunkBatch } from './batch';
import { ROAD_LIFT, hexRGB, type RGB } from './constants';
import type { Shared } from './materials';

const SCHEMA: AttrSpec[] = [
  { name: 'position', size: 3 },
  { name: 'normal', size: 3 },
  { name: 'color', size: 3 },
  // Along the wall, height, window kind (0 none), random seed
  { name: 'aWin', size: 4 },
];

export class BuildingBuf {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  win: number[] = [];
  idx: number[] = [];

  quad(p: number[][], color: RGB, uv: number[][], winKind: number, seed: number): void {
    const [a, b, , d] = p;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const base = this.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      this.pos.push(p[i][0], p[i][1], p[i][2]);
      this.nor.push(nx, ny, nz);
      this.col.push(color[0], color[1], color[2]);
      this.win.push(uv[i][0], uv[i][1], winKind, seed);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Box with windows on its walls. fx, fz is a horizontal unit vector. */
  block(cx: number, y0: number, cz: number, hw: number, hd: number, h: number, fx: number, fz: number, wall: RGB, roof: RGB, winKind: number, seed: number): void {
    const rx = -fz;
    const rz = fx;
    const c = (sr: number, sf: number, y: number): number[] => [cx + rx * sr * hw + fx * sf * hd, y, cz + rz * sr * hw + fz * sf * hd];
    const y1 = y0 + h;
    const corners: [number, number, number, number, number][] = [
      [-1, -1, 1, -1, hw * 2],
      [1, -1, 1, 1, hd * 2],
      [1, 1, -1, 1, hw * 2],
      [-1, 1, -1, -1, hd * 2],
    ];
    // Corners run anticlockwise seen from above, so each wall faces outward.
    for (const [ax, af, bx, bf, width] of corners) {
      this.quad([c(ax, af, y0), c(bx, bf, y0), c(bx, bf, y1), c(ax, af, y1)], wall, [[0, 0], [width, 0], [width, h], [0, h]], winKind, seed + width);
    }
    this.quad([c(-1, -1, y1), c(1, -1, y1), c(1, 1, y1), c(-1, 1, y1)], roof, [[0, 0], [0, 0], [0, 0], [0, 0]], 0, seed);
  }

  /** Upright cylinder, for tanks and silos. */
  drum(cx: number, y0: number, cz: number, r: number, h: number, wall: RGB, roof: RGB): void {
    const n = 12;
    const none = [[0, 0], [0, 0], [0, 0], [0, 0]];
    const at = (i: number, y: number): number[] => {
      const a = (i / n) * Math.PI * 2;
      return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
    };
    for (let i = 0; i < n; i++) {
      this.quad([at(i, y0), at(i, y0 + h), at(i + 1, y0 + h), at(i + 1, y0)], wall, none, 0, 0);
      const top = [cx, y0 + h + r * 0.15, cz];
      this.quad([at(i, y0 + h), top, top, at(i + 1, y0 + h)], roof, none, 0, 0);
    }
  }

  /** Flat ground patch, as a thin slab. */
  pad(cx: number, y: number, cz: number, hw: number, hd: number, fx: number, fz: number, color: RGB): void {
    this.block(cx, y - 0.2, cz, hw, hd, 0.28, fx, fz, color, color, 0, 0);
  }

  /**
   * Pitched roof over a block of the same half sizes, with its ridge along f.
   * A closed solid: slopes with thickness, soffits, fascias, verges, and wall-coloured
   * gable ends set back to the wall line under the overhang.
   */
  gable(cx: number, y: number, cz: number, hw: number, hd: number, rise: number, fx: number, fz: number, roof: RGB, wall: RGB, over = 0.45): void {
    const rx = -fz;
    const rz = fx;
    const none = [[0, 0], [0, 0], [0, 0], [0, 0]];
    const thick = 0.2;
    const p = (r: number, up: number, f: number): number[] => [cx + rx * r + fx * f, y + up, cz + rz * r + fz * f];
    const eave = hw + over;
    const end = hd + over;
    const drop = (over / hw) * rise;
    // Top of the roof.
    this.quad([p(-eave, -drop, -end), p(0, rise, -end), p(0, rise, end), p(-eave, -drop, end)], roof, none, 0, 0);
    this.quad([p(eave, -drop, end), p(0, rise, end), p(0, rise, -end), p(eave, -drop, -end)], roof, none, 0, 0);
    // Underside, seen from below the eaves.
    const under = -thick;
    this.quad([p(-eave, -drop + under, -end), p(0, rise + under, -end), p(0, rise + under, end), p(-eave, -drop + under, end)].reverse(), roof, none, 0, 0);
    this.quad([p(eave, -drop + under, end), p(0, rise + under, end), p(0, rise + under, -end), p(eave, -drop + under, -end)].reverse(), roof, none, 0, 0);
    // Fascia boards along the eaves.
    this.quad([p(-eave, -drop + under, end), p(-eave, -drop, end), p(-eave, -drop, -end), p(-eave, -drop + under, -end)].reverse(), wall, none, 0, 0);
    this.quad([p(eave, -drop + under, -end), p(eave, -drop, -end), p(eave, -drop, end), p(eave, -drop + under, end)].reverse(), wall, none, 0, 0);
    // Verges closing the roof at each end.
    for (const sf of [-1, 1]) {
      const e = sf * end;
      const left = [p(-eave, -drop + under, e), p(0, rise + under, e), p(0, rise, e), p(-eave, -drop, e)];
      const right = [p(0, rise + under, e), p(eave, -drop + under, e), p(eave, -drop, e), p(0, rise, e)];
      this.quad(sf > 0 ? left.reverse() : left, roof, none, 0, 0);
      this.quad(sf > 0 ? right.reverse() : right, roof, none, 0, 0);
      // Gable wall, under the overhang.
      const g = sf * hd;
      const tri = [p(-hw, 0, g), p(hw, 0, g), p(0, rise - thick, g), p(0, rise - thick, g)];
      this.quad(sf > 0 ? [tri[1], tri[0], tri[2], tri[3]] : tri, wall, none, 0, 0);
    }
  }

  toPiece(): Piece | null {
    const n = this.pos.length / 3;
    if (!n) return null;
    return {
      attrs: [new Float32Array(this.pos), new Float32Array(this.nor), new Float32Array(this.col), new Float32Array(this.win)],
      index: new Uint32Array(this.idx),
      vertexCount: n,
      cx: this.pos[0],
      cz: this.pos[2],
    };
  }
}

function buildingMaterial(shared: Shared): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uNight = shared.uNight;
    s.uniforms.uNoise = shared.uNoise;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec4 aWin;\nvarying vec2 vWinUv;\nflat varying float vWinKind;\nflat varying float vSeed;\nvarying vec3 vPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvWinUv = aWin.xy;\nvWinKind = aWin.z;\nvSeed = aWin.w;\nvPos = position;`);
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform float uNight;
uniform sampler2D uNoise;
varying vec2 vWinUv;
flat varying float vWinKind;
flat varying float vSeed;
varying vec3 vPos;
vec3 gWinGlow = vec3(0.0);
float gRough = 0.82;
float gMetal = 0.0;
float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
{
  // Weathering: stains run down from the top of a wall, dirt collects at its foot.
  float n = texture2D(uNoise, (vPos.xz + vPos.yy * 0.4) / 9.0).g;
  diffuseColor.rgb *= 0.88 + 0.22 * n;
  if (vWinKind > 0.5) {
    float kind = vWinKind;
    vec2 cellSize = kind > 3.5 ? vec2(3.0, 3.6) : kind > 2.5 ? vec2(3.2, 3.6) : kind > 1.5 ? vec2(5.2, 4.6) : vec2(3.3, 3.0);
    vec2 q = vWinUv / cellSize;
    vec2 id = floor(q);
    vec2 f = abs(fract(q) - 0.5) * 2.0;
    vec2 size = kind > 3.5 ? vec2(0.94, 0.86) : kind > 2.5 ? vec2(0.8, 0.62) : kind > 1.5 ? vec2(0.7, 0.3) : vec2(0.54, 0.56);
    vec2 w = fwidth(q) * 2.0;
    vec2 e = smoothstep(size + w, size - w, f);
    float sharp = 1.0 - smoothstep(0.35, 0.7, max(w.x, w.y));
    float win = e.x * e.y * sharp;
    // A frame around each pane, darker than the wall.
    vec2 fr = smoothstep(size + w + 0.1, size + 0.06, f);
    diffuseColor.rgb *= 1.0 - 0.3 * fr.x * fr.y * sharp;
    // Shop fronts: the ground floor is one band of glass.
    float shop = (kind > 2.5 && kind < 3.5) ? (1.0 - step(0.62, vWinUv.y / 4.2)) * step(0.5, fract(vWinUv.x / 7.0) * 2.0 + 0.3) : 0.0;
    win = max(win, shop * sharp);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.5, 0.56) * (0.85 + 0.3 * rnd(id + 3.0)), win);
    gRough = mix(gRough, 0.1 + 0.12 * rnd(id), win);
    gMetal = mix(gMetal, 0.7, win);
    float lit = step(0.62, rnd(id + vSeed));
    float average = size.x * size.y * 0.4 * (1.0 - sharp);
    gWinGlow = vec3(1.0, 0.68, 0.34) * (win * lit + average) * uNight * 1.3;
  } else if (vWinKind < -0.5) {
    gRough = 0.92;
  }
}
`,
      )
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = gRough;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\nmetalnessFactor = gMetal;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += gWinGlow;`);
  };
  m.customProgramCacheKey = () => 'cl-building-2';
  return m;
}

const PALETTE: Record<Exclude<EndpointKind, 'gateway'>, { walls: number[]; roofs: number[]; win: number }> = {
  residential: { walls: [0xd8cdb8, 0xc9b49a, 0xb9c0c2, 0xd9bfa6, 0xa9a48f, 0xa26a52], roofs: [0x8a4a3a, 0x6f4034, 0x4f4d52], win: 1 },
  commercial: { walls: [0xd2cfc6, 0xbfc7cf, 0xc9b9a4, 0xa8b8b8], roofs: [0x65676b, 0x77787a], win: 3 },
  industrial: { walls: [0x9ca3a6, 0x8d8a7f, 0xa7a191, 0x7f8b8f], roofs: [0x6a6e72, 0x57595c], win: 2 },
  office: { walls: [0x7f97ab, 0x8ea6b5, 0x6f8799, 0x9aa8b2], roofs: [0x55595e, 0x4c5056], win: 3 },
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

const ASPHALT = hexRGB(0x3c3e42);
const CONCRETE_PAD = hexRGB(0x8e8c84);
const STRIPE = hexRGB(0xdedcd2);
const HEDGE = hexRGB(0x2e4a22);
const GRASS_PAD = hexRGB(0x4c6a34);
const PARKED = [0xc9ccd0, 0x24262a, 0x8e1a18, 0x2a64aa, 0xeeece6, 0x7c8086, 0xdc9e20].map(hexRGB);
const GLASS_DARK = hexRGB(0x20262c);
const STEEL = hexRGB(0x8a8f94);

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
        buf.block(qx, y + 0.3, qz, 0.88, 2.15, 0.6, fx, fz, c, c, 0, 0);
        buf.block(qx, y + 0.9, qz, 0.76, 1.15, 0.42, fx, fz, GLASS_DARK, c, 0, 0);
      }
    }
  }
}

/** Plant on a flat roof. */
function roofKit(buf: BuildingBuf, x: number, y: number, z: number, hw: number, hd: number, fx: number, fz: number, rng: () => number): void {
  const rx = -fz;
  const rz = fx;
  const n = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const u = (rng() - 0.5) * hw * 1.2;
    const v = (rng() - 0.5) * hd * 1.2;
    buf.block(x + rx * u + fx * v, y, z + rz * u + fz * v, 0.8 + rng(), 0.7 + rng() * 0.6, 1 + rng() * 0.8, fx, fz, STEEL, hexRGB(0x6c7074), 0, 0);
  }
}

/** Flat roof with a parapet, so the top reads as a roof and not a lid. */
function parapet(buf: BuildingBuf, x: number, y: number, z: number, hw: number, hd: number, fx: number, fz: number, wall: RGB, roof: RGB): void {
  const rx = -fz;
  const rz = fx;
  const t = 0.25;
  const h = 0.8;
  buf.block(x + fx * (hd - t), y, z + fz * (hd - t), hw, t, h, fx, fz, wall, wall, 0, 0);
  buf.block(x - fx * (hd - t), y, z - fz * (hd - t), hw, t, h, fx, fz, wall, wall, 0, 0);
  buf.block(x + rx * (hw - t), y, z + rz * (hw - t), t, hd, h, fx, fz, wall, wall, 0, 0);
  buf.block(x - rx * (hw - t), y, z - rz * (hw - t), t, hd, h, fx, fz, wall, wall, 0, 0);
  buf.block(x, y - 0.02, z, hw - t, hd - t, 0.1, fx, fz, roof, roof, 0, 0);
}

type Pick = <T>(a: T[]) => T;

/**
 * One house on its lot. (tx, tz) runs along the street and (fx, fz) away from it.
 * Walls sit on a plinth; the door, path and drive are on the street side.
 */
function house(buf: BuildingBuf, x: number, ground: number, z: number, lot: number, tx: number, tz: number, fx: number, fz: number, pal: { walls: number[]; roofs: number[]; win: number }, rng: () => number, pick: Pick, toStreet: number): void {
  const wall = hexRGB(pick(pal.walls));
  const roof = hexRGB(pick(pal.roofs));
  const seed = rng() * 40;
  // Half sizes across the street (hw) and along it (hd). Ridge runs along the street.
  const hd = Math.min(lot * 0.32, 4.6 + rng() * 2.6);
  const hw = 3.6 + rng() * 1.6;
  const floors = rng() < 0.6 ? 2 : 1;
  const h = floors * 2.9;
  const rise = 1.5 + rng() * 1.5;
  buf.block(x, ground - 0.25, z, hw + 0.14, hd + 0.14, 0.5, tx, tz, CONCRETE_PAD, CONCRETE_PAD, 0, 0);
  buf.block(x, ground + 0.25, z, hw, hd, h, tx, tz, wall, roof, pal.win, seed);
  buf.gable(x, ground + 0.25 + h, z, hw, hd, rise, tx, tz, roof, wall);
  // A wing toward the street turns some houses into an L.
  if (rng() < 0.45) {
    const off = hd * 0.55 * (rng() < 0.5 ? -1 : 1);
    const ww = 2.4 + rng() * 0.8;
    const wd = 2.6 + rng() * 1;
    const wx = x + tx * off - fx * (hw + wd - 0.2);
    const wz = z + tz * off - fz * (hw + wd - 0.2);
    const wh = Math.min(h, 2.9);
    buf.block(wx, ground - 0.25, wz, wd + 0.12, ww + 0.12, 0.5, tx, tz, CONCRETE_PAD, CONCRETE_PAD, 0, 0);
    buf.block(wx, ground + 0.25, wz, wd, ww, wh, tx, tz, wall, roof, pal.win, seed + 7);
    buf.gable(wx, ground + 0.25 + wh, wz, ww, wd, 1.2, fx, fz, roof, wall, 0.3);
  }
  // Front door and porch step, proud of the street-side wall.
  const front = hw + 0.03;
  const doorX = x - fx * front + tx * hd * 0.25;
  const doorZ = z - fz * front + tz * hd * 0.25;
  buf.block(doorX, ground + 0.25, doorZ, 0.06, 0.5, 2.1, tx, tz, hexRGB(pick([0x3a2a20, 0x24406a, 0x7a2a22, 0x2c4a34])), wall, 0, 0);
  buf.block(doorX - fx * 0.6, ground, doorZ - fz * 0.6, 0.6, 0.8, 0.26, tx, tz, CONCRETE_PAD, CONCRETE_PAD, 0, 0);
  // Path to the street, hedge along it with a gap at the path.
  const pathLen = Math.max(1, (toStreet - hw) / 2);
  const pathX = doorX - fx * pathLen;
  const pathZ = doorZ - fz * pathLen;
  buf.pad(pathX, ground + 0.02, pathZ, 0.7, pathLen, fx, fz, CONCRETE_PAD);
  const hedgeBack = toStreet - 0.8;
  for (const dir of [-1, 1]) {
    const len = lot * 0.22;
    const hx = x - fx * hedgeBack + tx * (hd * 0.25 + dir * (len + 1));
    const hz = z - fz * hedgeBack + tz * (hd * 0.25 + dir * (len + 1));
    buf.block(hx, ground, hz, 0.45, len, 0.9 + rng() * 0.4, tx, tz, HEDGE, HEDGE, -1, 0);
  }
  // Garage and drive on some lots, a shed behind on others.
  if (rng() < 0.55) {
    const gOff = -(hd + 2.2);
    const gx = x + tx * gOff;
    const gz = z + tz * gOff;
    buf.block(gx, ground, gz, 3, 1.8, 2.5, tx, tz, wall, hexRGB(0x55575a), 0, 0);
    buf.block(gx - fx * 3.03, ground + 0.04, gz - fz * 3.03, 0.05, 1.45, 2.05, tx, tz, hexRGB(0xc8c6be), wall, 0, 0);
    const driveLen = Math.max(1, (toStreet - 3) / 2);
    buf.pad(gx - fx * (3 + driveLen), ground + 0.02, gz - fz * (3 + driveLen), 1.6, driveLen, fx, fz, ASPHALT);
  } else if (rng() < 0.6) {
    buf.block(x + fx * (hw + 3.2), ground, z + fz * (hw + 3.2), 1.3, 1.6, 2.1, tx, tz, hexRGB(0x8a6a48), roof, 0, 0);
    buf.gable(x + fx * (hw + 3.2), ground + 2.1, z + fz * (hw + 3.2), 1.3, 1.6, 0.6, tx, tz, roof, hexRGB(0x8a6a48), 0.15);
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
  const ground = Math.max(terrainHeight(cx, cz), 0) + 0.08;
  const pal = PALETTE[ep.kind];
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
    buf.pad(cx, ground - 0.03, cz, width / 2, depth / 2, fx, fz, GRASS_PAD);
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
      const h = 4.4 + Math.floor(rng() * 3) * 3.6;
      const wall = hexRGB(pick(pal.walls));
      buf.block(at.x, ground - 0.2, at.z, hw + 0.15, hd + 0.15, 0.3, tx, tz, CONCRETE_PAD, CONCRETE_PAD, 0, 0);
      buf.block(at.x, ground, at.z, hw, hd, h, tx, tz, wall, hexRGB(0x5c5e62), pal.win, rng() * 40);
      parapet(buf, at.x, ground + h, at.z, hw, hd, tx, tz, wall, hexRGB(0x5c5e62));
      roofKit(buf, at.x, ground + h, at.z, hw * 0.7, hd * 0.7, tx, tz, rng);
      const canopy = place(u, 0.42 - (hd + 1.4) / (depth / 2));
      buf.block(canopy.x, ground + 3.2, canopy.z, hw * 0.9, 1.4, 0.22, tx, tz, hexRGB(pick([0x8e2a22, 0x1f5a7a, 0x2a6a44, 0xc8a030])), hexRGB(0x505256), 0, 0);
    }
  } else if (ep.kind === 'industrial') {
    buf.pad(cx, ground - 0.01, cz, width / 2, depth / 2, fx, fz, CONCRETE_PAD);
    for (let i = 0; i < Math.max(2, count - 1); i++) {
      const n = Math.max(2, count - 1);
      const u = ((i + 0.5) / n) * 2 - 1;
      const at = place(u, 0.24);
      const hw = (width / n) * (0.32 + rng() * 0.1);
      const hd = depth * (0.26 + rng() * 0.1);
      const h = 6.5 + rng() * 4;
      const wall = hexRGB(pick(pal.walls));
      const roof = hexRGB(pick(pal.roofs));
      buf.block(at.x, ground, at.z, hw, hd, h, tx, tz, wall, roof, pal.win, rng() * 40);
      buf.gable(at.x, ground + h, at.z, hw * 1.02, hd * 1.02, 1.7, fx, fz, roof, wall);
      // Loading docks along the front.
      for (let k = -1; k <= 1; k++) {
        const dock = place(u + k * 0.14, 0.24 - (hd + 0.1) / (depth / 2));
        buf.block(dock.x, ground, dock.z, 1.6, 0.12, 3.4, tx, tz, hexRGB(0x5e6468), hexRGB(0x5e6468), 0, 0);
      }
      if (rng() < 0.7) {
        const t = place(u + 0.3, 0.84);
        buf.drum(t.x, ground, t.z, 2.2 + rng() * 1.8, 6 + rng() * 5, hexRGB(0xb8bab6), hexRGB(0x8a8c8a));
      }
    }
    const stack = place(-0.8, 0.7);
    buf.drum(stack.x, ground, stack.z, 0.9, 24 + rng() * 10, hexRGB(0x8a7a6c), hexRGB(0x302c28));
  } else {
    const lot = place(0, -0.62);
    parking(buf, lot.x, ground, lot.z, width * 0.46, depth * 0.2, fx, fz, rng);
    const towers = Math.max(1, count - 1);
    for (let i = 0; i < towers; i++) {
      const u = ((i + 0.5) / towers) * 2 - 1;
      const at = place(u * 0.8, 0.4);
      const hw = Math.min((width / towers) * (0.26 + rng() * 0.1), 15);
      const hd = Math.min(depth * (0.22 + rng() * 0.08), 13);
      const h = 18 + Math.floor(rng() * (6 + scale * 8)) * 3.6;
      const wall = hexRGB(pick(pal.walls));
      // Plinth, shaft, plant level.
      buf.block(at.x, ground, at.z, hw * 1.12, hd * 1.12, 4.2, tx, tz, hexRGB(0x7a7c7e), hexRGB(0x5c5e62), 3, rng() * 40);
      buf.block(at.x, ground + 4.2, at.z, hw, hd, h, tx, tz, wall, hexRGB(0x4c5056), 4, rng() * 40);
      // Entrance canopy on the street side.
      buf.block(at.x - fx * (hd * 1.12 + 1.4), ground + 3.4, at.z - fz * (hd * 1.12 + 1.4), 4, 1.4, 0.25, fx, fz, hexRGB(0x50545a), hexRGB(0x50545a), 0, 0);
      parapet(buf, at.x, ground + 4.2 + h, at.z, hw, hd, tx, tz, hexRGB(0x62666c), hexRGB(0x4c5056));
      buf.block(at.x, ground + 4.2 + h, at.z, hw * 0.5, hd * 0.5, 3.2, tx, tz, hexRGB(0x62666c), hexRGB(0x50545a), 0, 0);
      roofKit(buf, at.x, ground + 7.4 + h, at.z, hw * 0.4, hd * 0.4, tx, tz, rng);
    }
  }
  return { x: cx, z: cz, r: Math.hypot(width, depth) / 2 };
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
  private material: THREE.MeshStandardMaterial;
  private known = new Set<Id>();
  private gateways: THREE.Mesh | null = null;
  private gatewayMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.55, metalness: 0.4 });
  private arrowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.92, side: THREE.DoubleSide, depthWrite: false });
  private arrows: THREE.Mesh | null = null;
  footprints: ZoneFootprint[] = [];

  constructor(
    private readonly net: RoadNetwork,
    shared: Shared,
  ) {
    this.material = buildingMaterial(shared);
    this.batch = new ChunkBatch(SCHEMA, this.material, { castShadow: true, receiveShadow: true, chunkSize: 500 });
    this.group.add(this.batch.group);
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
      const buf = new BuildingBuf();
      const fp = buildZone(this.net, ep, buf);
      if (fp) this.footprints.push(fp);
      this.batch.set(ep.id, buf.toPiece());
    }
    for (const id of this.known) if (!seen.has(id)) this.batch.set(id, null);
    this.known = seen;
    this.batch.flush();
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

  dispose(): void {
    this.batch.dispose();
    this.material.dispose();
    this.gatewayMat.dispose();
    this.arrowMat.dispose();
    this.gateways?.geometry.dispose();
    this.arrows?.geometry.dispose();
    this.group.clear();
  }
}
