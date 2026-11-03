/**
 * Buildings: the mesh buffer, the facade material and the generators for
 * apartment blocks, offices, towers, shops, houses and sheds.
 *
 * Geometry stays simple (boxes, bands, roofs and rooftop plant) and the facade
 * shader does the rest: brick, stone, precast, render, siding, tile and metal
 * from a generated atlas with normals and roughness, window grids with frames,
 * reveals, sills, blinds and reflective glass, curtain walls, shopfronts, rain
 * streaks and grime. Small rooftop plant goes in a separate buffer so it can be
 * dropped at a distance.
 */
import * as THREE from 'three';
import { hexRGB, type RGB } from './constants';
import type { Shared } from './materials';
import { BUILDING_COLOURS, PALETTE } from './style';
import { FACADE_CELL, FACADE_TILE, makeFacadeAtlas } from './textures';

/** Surface materials, stored per vertex. */
export const MAT = {
  plain: 0,
  brick: 1,
  stone: 2,
  concrete: 3,
  stucco: 4,
  siding: 5,
  roofTile: 6,
  flatRoof: 7,
  metal: 8,
  glass: 9,
  hvac: 10,
  hedge: 11,
} as const;

/** Atlas cell for each material, -1 where the shader draws it alone. */
const MAT_CELL = [-1, FACADE_CELL.brick, FACADE_CELL.stone, FACADE_CELL.concrete, FACADE_CELL.stucco, FACADE_CELL.siding, FACADE_CELL.roofTile, FACADE_CELL.flatRoof, FACADE_CELL.metal, -1, FACADE_CELL.metal, -1];

/** Window patterns. */
export const WIN = { none: 0, house: 1, industrial: 2, shop: 3, office: 4, curtain: 5, apartment: 6, hedge: -1 } as const;

/** Window bay width and floor height in metres, by pattern. */
const WIN_CELL: Record<number, [number, number]> = {
  1: [3.0, 2.9],
  2: [5.2, 4.6],
  3: [3.2, 3.6],
  4: [3.0, 3.6],
  5: [1.5, 3.6],
  6: [3.2, 3.0],
};

const SCHEMA_NAMES = ['position', 'normal', 'color', 'aWin', 'aMat'] as const;
export const BUILDING_SCHEMA = [
  { name: SCHEMA_NAMES[0], size: 3 },
  { name: SCHEMA_NAMES[1], size: 3 },
  { name: SCHEMA_NAMES[2], size: 3 },
  // Along the wall, height (metres), window pattern, random seed.
  { name: SCHEMA_NAMES[3], size: 4 },
  // Material, height of the face's base above the ground.
  { name: SCHEMA_NAMES[4], size: 2 },
];

export interface Mats {
  wall?: number;
  roof?: number;
}

export class BuildingBuf {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  win: number[] = [];
  mat: number[] = [];
  idx: number[] = [];
  /** Ground level under what is being built, for grime and streaks. */
  ground = NaN;
  /** Where small rooftop plant goes; itself when unset. */
  detail: BuildingBuf | null = null;

  /**
   * One quad. uv is in metres; when left out it is laid flat on the quad, from
   * its first corner along its first and last edges.
   */
  quad(p: number[][], color: RGB, uv: number[][] | null, winKind: number, seed: number, mat: number = MAT.plain): void {
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
    let coords = uv;
    if (!coords) {
      const ul = Math.hypot(ux, uy, uz) || 1;
      const e = [ux / ul, uy / ul, uz / ul];
      // Second axis: the last edge with its share along the first removed.
      const along = vx * e[0] + vy * e[1] + vz * e[2];
      const w = [vx - e[0] * along, vy - e[1] * along, vz - e[2] * along];
      const wl = Math.hypot(w[0], w[1], w[2]) || 1;
      const f = [w[0] / wl, w[1] / wl, w[2] / wl];
      coords = p.map((q) => {
        const dx = q[0] - a[0];
        const dy = q[1] - a[1];
        const dz = q[2] - a[2];
        return [dx * e[0] + dy * e[1] + dz * e[2], dx * f[0] + dy * f[1] + dz * f[2]];
      });
    }
    const minY = Math.min(p[0][1], p[1][1], p[2][1], p[3][1]);
    const base = Number.isFinite(this.ground) ? Math.max(0, minY - this.ground) : 0;
    const v0 = this.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      this.pos.push(p[i][0], p[i][1], p[i][2]);
      this.nor.push(nx, ny, nz);
      this.col.push(color[0], color[1], color[2]);
      this.win.push(coords[i][0], coords[i][1], winKind, seed);
      this.mat.push(mat, base);
    }
    this.idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
  }

  /**
   * Box with windows on its walls. fx, fz is a horizontal unit vector; hw is the
   * half size across it and hd along it. Each wall's window grid is stretched a
   * little so it holds a whole number of bays.
   */
  block(cx: number, y0: number, cz: number, hw: number, hd: number, h: number, fx: number, fz: number, wall: RGB, roof: RGB, winKind: number, seed: number, mats: Mats = {}): void {
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
    const cell = WIN_CELL[winKind];
    const wallMat = mats.wall ?? MAT.plain;
    // Corners run anticlockwise seen from above, so each wall faces outward.
    for (const [ax, af, bx, bf, width] of corners) {
      const u = cell ? Math.max(1, Math.round(width / cell[0])) * cell[0] : width;
      this.quad([c(ax, af, y0), c(bx, bf, y0), c(bx, bf, y1), c(ax, af, y1)], wall, [[0, 0], [u, 0], [u, h], [0, h]], winKind, seed + width, wallMat);
    }
    this.quad([c(-1, -1, y1), c(1, -1, y1), c(1, 1, y1), c(-1, 1, y1)], roof, null, 0, seed, mats.roof ?? MAT.plain);
  }

  /** Upright cylinder, for tanks and silos, with a low cone on top. */
  drum(cx: number, y0: number, cz: number, r: number, h: number, wall: RGB, roof: RGB, mat: number = MAT.plain, cone = 0.15): void {
    const n = 14;
    const at = (i: number, y: number): number[] => {
      const a = (i / n) * Math.PI * 2;
      return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
    };
    const arc = (Math.PI * 2 * r) / n;
    const top = [cx, y0 + h + r * cone, cz];
    for (let i = 0; i < n; i++) {
      const u0 = i * arc;
      this.quad([at(i, y0), at(i, y0 + h), at(i + 1, y0 + h), at(i + 1, y0)], wall, [[u0, 0], [u0, h], [u0 + arc, h], [u0 + arc, 0]], 0, 0, mat);
      this.quad([at(i, y0 + h), top, top, at(i + 1, y0 + h)], roof, null, 0, 0, mat);
    }
  }

  /**
   * Ground cover lying on the terrain: one upward face, no edges, so a lawn blends
   * into the grass around it instead of standing on a slab.
   */
  flat(cx: number, y: number, cz: number, hw: number, hd: number, fx: number, fz: number, color: RGB): void {
    const rx = -fz;
    const rz = fx;
    const c = (sr: number, sf: number): number[] => [cx + rx * sr * hw + fx * sf * hd, y, cz + rz * sr * hw + fz * sf * hd];
    // Same corner order as a block's roof, which faces up.
    this.quad([c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)], color, [[0, 0], [0, 0], [0, 0], [0, 0]], 0, 0);
  }

  /** Flat ground patch, as a thin slab. */
  pad(cx: number, y: number, cz: number, hw: number, hd: number, fx: number, fz: number, color: RGB, mat: number = MAT.plain): void {
    this.block(cx, y - 0.2, cz, hw, hd, 0.28, fx, fz, color, color, 0, 0, { wall: mat, roof: mat });
  }

  /**
   * Pitched roof over a block of the same half sizes, with its ridge along f.
   * A closed solid: slopes with thickness, soffits, fascias, verges, and wall-coloured
   * gable ends set back to the wall line under the overhang.
   */
  gable(cx: number, y: number, cz: number, hw: number, hd: number, rise: number, fx: number, fz: number, roof: RGB, wall: RGB, over = 0.45, mats: Mats = {}): void {
    const rx = -fz;
    const rz = fx;
    const none = [[0, 0], [0, 0], [0, 0], [0, 0]];
    const thick = 0.2;
    const roofMat = mats.roof ?? MAT.plain;
    const wallMat = mats.wall ?? MAT.plain;
    const p = (r: number, up: number, f: number): number[] => [cx + rx * r + fx * f, y + up, cz + rz * r + fz * f];
    const eave = hw + over;
    const end = hd + over;
    const drop = (over / hw) * rise;
    // Top of the roof: u runs up the slope, v along the ridge.
    this.quad([p(-eave, -drop, -end), p(0, rise, -end), p(0, rise, end), p(-eave, -drop, end)], roof, null, 0, 0, roofMat);
    this.quad([p(eave, -drop, end), p(0, rise, end), p(0, rise, -end), p(eave, -drop, -end)], roof, null, 0, 0, roofMat);
    // Underside, seen from below the eaves.
    const under = -thick;
    const soffit = hexRGB(0x8a8278);
    this.quad([p(-eave, -drop + under, -end), p(0, rise + under, -end), p(0, rise + under, end), p(-eave, -drop + under, end)].reverse(), soffit, none, 0, 0);
    this.quad([p(eave, -drop + under, end), p(0, rise + under, end), p(0, rise + under, -end), p(eave, -drop + under, -end)].reverse(), soffit, none, 0, 0);
    // Fascia boards along the eaves.
    const fascia = hexRGB(0xe4e0d6);
    this.quad([p(-eave, -drop + under, end), p(-eave, -drop, end), p(-eave, -drop, -end), p(-eave, -drop + under, -end)].reverse(), fascia, none, 0, 0);
    this.quad([p(eave, -drop + under, -end), p(eave, -drop, -end), p(eave, -drop, end), p(eave, -drop + under, end)].reverse(), fascia, none, 0, 0);
    // Verges closing the roof at each end.
    for (const sf of [-1, 1]) {
      const e = sf * end;
      const left = [p(-eave, -drop + under, e), p(0, rise + under, e), p(0, rise, e), p(-eave, -drop, e)];
      const right = [p(0, rise + under, e), p(eave, -drop + under, e), p(eave, -drop, e), p(0, rise, e)];
      this.quad(sf > 0 ? left.reverse() : left, fascia, none, 0, 0);
      this.quad(sf > 0 ? right.reverse() : right, fascia, none, 0, 0);
      // Gable wall, under the overhang.
      const g = sf * hd;
      const tri = [p(-hw, 0, g), p(hw, 0, g), p(0, rise - thick, g), p(0, rise - thick, g)];
      this.quad(sf > 0 ? [tri[1], tri[0], tri[2], tri[3]] : tri, wall, null, 0, 0, wallMat);
    }
  }

  toPiece(): { attrs: Float32Array[]; index: Uint32Array; vertexCount: number; cx: number; cz: number } | null {
    const n = this.pos.length / 3;
    if (!n) return null;
    return {
      attrs: [new Float32Array(this.pos), new Float32Array(this.nor), new Float32Array(this.col), new Float32Array(this.win), new Float32Array(this.mat)],
      index: new Uint32Array(this.idx),
      vertexCount: n,
      cx: this.pos[0],
      cz: this.pos[2],
    };
  }
}

// ---------------------------------------------------------------------------
// Facade material
// ---------------------------------------------------------------------------

const glsl = (hex: number) => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};
const floatList = (a: readonly number[]) => a.map((v) => v.toFixed(3)).join(', ');

const FACADE_GLSL = /* glsl */ `
uniform float uNight;
uniform sampler2D uNoise;
uniform sampler2D uFacadeColor;
uniform sampler2D uFacadeData;
varying vec2 vWinUv;
flat varying float vWinKind;
flat varying float vSeed;
flat varying float vMat;
varying float vBase;
varying vec3 vPos;
varying vec3 vObjN;
vec3 gWinGlow = vec3(0.0);
float gRough = 0.85;
float gMetal = 0.0;
float gAO = 1.0;
vec3 gNTS = vec3(0.0, 0.0, 1.0);
bool gBump = false;
const float MAT_CELL[12] = float[12](${floatList(MAT_CELL)});
const float TILE[8] = float[8](${floatList(FACADE_TILE)});
float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// 1 inside the box of half size h around the origin, softened by a pixel.
float boxMask(vec2 p, vec2 h, vec2 aa) {
  vec2 e = smoothstep(-aa, aa, h - abs(p));
  return e.x * e.y;
}
vec3 frameColour(float s) {
  float k = fract(s * 3.17);
  return k < 0.45 ? ${glsl(BUILDING_COLOURS.frame[0])} : k < 0.7 ? ${glsl(BUILDING_COLOURS.frame[1])} : k < 0.9 ? ${glsl(BUILDING_COLOURS.frame[2])} : ${glsl(BUILDING_COLOURS.frame[3])};
}
vec3 signColour(float s) {
  float k = fract(s * 5.31);
  return k < 0.2 ? ${glsl(BUILDING_COLOURS.sign[0])} : k < 0.4 ? ${glsl(BUILDING_COLOURS.sign[1])} : k < 0.55 ? ${glsl(BUILDING_COLOURS.sign[2])} : k < 0.75 ? ${glsl(BUILDING_COLOURS.sign[3])} : k < 0.9 ? ${glsl(BUILDING_COLOURS.sign[4])} : ${glsl(BUILDING_COLOURS.sign[5])};
}
`;

const FACADE_FRAGMENT = /* glsl */ `
{
  vec2 uvm = vWinUv;
  int mat = int(vMat + 0.5);
  vec2 aa = max(fwidth(uvm), vec2(1e-4));
  float px = max(aa.x, aa.y);
  float hBase = vBase + uvm.y;
  bool wall = abs(vObjN.y) < 0.5 && mat != 0;
  // Atlas surface: colour, normal, roughness and cavity.
  float cell = mat < 12 ? MAT_CELL[mat] : -1.0;
  if (cell >= 0.0) {
    int ci = int(cell + 0.5);
    vec2 t = uvm / TILE[ci];
    vec2 org = vec2(mod(cell, 4.0), floor(cell / 4.0));
    vec2 a = (org + clamp(fract(t), vec2(0.002), vec2(0.998))) * vec2(0.25, 0.5);
    vec2 gx = dFdx(t) * vec2(0.25, 0.5);
    vec2 gy = dFdy(t) * vec2(0.25, 0.5);
    vec4 c = textureGrad(uFacadeColor, a, gx, gy);
    vec4 d = textureGrad(uFacadeData, a, gx, gy);
    diffuseColor.rgb = mix(c.rgb, diffuseColor.rgb * c.rgb * 2.0, c.a);
    gNTS = vec3(d.xy * 2.0 - 1.0, 0.0);
    gNTS.z = sqrt(max(0.0, 1.0 - dot(gNTS.xy, gNTS.xy)));
    gBump = true;
    gRough = d.b;
    gAO = mix(1.0, d.a, 1.0 - smoothstep(0.02, 0.2, px));
    if (mat == 8) gMetal = 0.2;
  }
  if (mat == 10) {
    // Rooftop plant: louvres on the sides, a fan in a grille on top.
    gMetal = 0.3;
    gRough = 0.5;
    if (vObjN.y > 0.5) {
      vec2 f = fract(uvm / 1.3) - 0.5;
      float r = length(f);
      diffuseColor.rgb *= 1.0 - 0.55 * smoothstep(0.42, 0.38, r) * (0.6 + 0.4 * step(0.5, fract(r * 12.0)));
    } else {
      diffuseColor.rgb *= 0.82 + 0.18 * step(0.5, fract(uvm.y * 9.0));
    }
  } else if (mat == 11) {
    // Hedge: leafy clumps, with a bumped normal from the noise.
    vec4 n = texture2D(uNoise, uvm * 0.35);
    vec4 m = texture2D(uNoise, uvm * 1.7 + 0.3);
    diffuseColor.rgb *= 0.7 + 0.5 * n.g * (0.6 + 0.4 * m.r);
    gNTS = normalize(vec3((m.rg - 0.5) * 1.6, 1.0));
    gBump = true;
    gRough = 0.95;
    gAO = 0.75 + 0.25 * m.b;
  } else if (mat == 9) {
    gRough = 0.08;
    gMetal = 0.6;
  }
  // Grime at the foot of the building, a little noise in it.
  if (wall) {
    float grime = (1.0 - smoothstep(0.0, 1.6, hBase)) * (0.7 + 0.3 * texture2D(uNoise, vPos.xz * 0.21 + vPos.y * 0.13).g);
    diffuseColor.rgb *= 1.0 - 0.22 * grime;
  }
  if (vWinKind > 0.5 && wall) {
    float kind = vWinKind;
    vec2 cs = kind > 5.5 ? vec2(${WIN_CELL[6][0].toFixed(2)}, ${WIN_CELL[6][1].toFixed(2)}) : kind > 4.5 ? vec2(${WIN_CELL[5][0].toFixed(2)}, ${WIN_CELL[5][1].toFixed(2)}) : kind > 3.5 ? vec2(${WIN_CELL[4][0].toFixed(2)}, ${WIN_CELL[4][1].toFixed(2)}) : kind > 2.5 ? vec2(${WIN_CELL[3][0].toFixed(2)}, ${WIN_CELL[3][1].toFixed(2)}) : kind > 1.5 ? vec2(${WIN_CELL[2][0].toFixed(2)}, ${WIN_CELL[2][1].toFixed(2)}) : vec2(${WIN_CELL[1][0].toFixed(2)}, ${WIN_CELL[1][1].toFixed(2)});
    // Opening half size and centre within its bay, in metres.
    vec2 hs = kind > 5.5 ? vec2(0.75, 0.8) : kind > 4.5 ? vec2(0.75, 1.8) : kind > 3.5 ? vec2(1.15, 1.05) : kind > 2.5 ? vec2(0.85, 1.0) : kind > 1.5 ? vec2(1.8, 0.45) : vec2(0.62, 0.72);
    vec2 oc = kind > 4.5 && kind < 5.5 ? vec2(0.0) : kind > 1.5 && kind < 2.5 ? vec2(0.0, 1.2) : vec2(0.0, 0.15);
    float frameW = kind > 4.5 && kind < 5.5 ? 0.035 : 0.06;
    vec2 q = uvm / cs;
    vec2 id = floor(q);
    vec2 l = (fract(q) - 0.5) * cs;
    bool shop = kind > 2.5 && kind < 3.5 && uvm.y < 4.2;
    if (shop) {
      // Shopfront: piers between bays, a fascia with a sign, glass to the floor.
      hs = vec2(cs.x * 0.5 - 0.22, 1.45);
      l = vec2((fract(q.x) - 0.5) * cs.x, uvm.y);
      oc = vec2(0.0, 1.75);
      frameW = 0.05;
      id = vec2(floor(q.x / 3.0), 0.0);
    }
    vec2 p = l - oc;
    float vis = 1.0 - smoothstep(0.35, 1.1, px);
    float fine = 1.0 - smoothstep(0.025, 0.09, px);
    // Glass, frame, reveal and sill.
    float open = boxMask(p, hs, aa);
    float glassM = boxMask(p, hs - frameW, aa);
    float mull = 0.0;
    if (kind < 1.5 || (kind > 5.5)) {
      mull = max(boxMask(vec2(p.x, p.y - hs.y * 0.38), vec2(hs.x, frameW * 0.5), aa), boxMask(p, vec2(frameW * 0.5, hs.y), aa));
    } else if (kind > 3.5 && kind < 4.5) {
      mull = boxMask(p, vec2(frameW * 0.5, hs.y), aa);
    } else if (shop) {
      mull = boxMask(vec2(p.x, p.y - 0.9), vec2(hs.x, frameW * 0.5), aa);
    }
    glassM *= 1.0 - mull;
    float frameM = clamp(open - glassM, 0.0, 1.0);
    vec3 frameC = kind > 4.5 && kind < 5.5 ? vec3(0.2, 0.22, 0.24) : shop ? vec3(0.12) : frameColour(vSeed);
    // Sill under the opening, lintel above it on masonry.
    float sill = (kind < 4.5 || kind > 5.5) && !shop ? boxMask(p - vec2(0.0, -hs.y - 0.05), vec2(hs.x + 0.07, 0.05), aa) : 0.0;
    float underSill = (kind < 4.5 || kind > 5.5) && !shop ? boxMask(p - vec2(0.0, -hs.y - 0.14), vec2(hs.x + 0.05, 0.04), aa) : 0.0;
    float lintel = (mat == 1 || mat == 2) && !shop && kind != 5.0 ? boxMask(p - vec2(0.0, hs.y + 0.1), vec2(hs.x + 0.12, 0.1), aa) : 0.0;
    vec3 stoneC = vec3(0.78, 0.75, 0.69);
    diffuseColor.rgb = mix(diffuseColor.rgb, stoneC, max(sill, lintel) * fine);
    gAO *= 1.0 - 0.3 * underSill * fine;
    // Rain streaks below the sill corners.
    if (!shop && kind != 5.0) {
      float below = -(p.y + hs.y);
      float streak = smoothstep(0.0, 0.3, below) * (1.0 - smoothstep(0.3, 2.4, below)) * step(abs(p.x), hs.x);
      float s = texture2D(uNoise, vec2(uvm.x * 0.9, 0.5)).r;
      diffuseColor.rgb *= 1.0 - 0.14 * streak * smoothstep(0.45, 0.8, s) * vis;
    }
    // Reveal: inside the opening edge the wall turns in; top in shadow, bottom lit.
    float rev = 0.09;
    vec2 inner = hs - abs(p);
    float revealM = open * (1.0 - boxMask(p, hs - rev, aa)) * fine;
    // Inside the window: an interior, sometimes blinds; reflections take over at an angle.
    vec3 V = normalize(vViewPosition);
    float fres = pow(1.0 - clamp(abs(dot(V, normalize(vNormal))), 0.0, 1.0), 2.5);
    float r1 = rnd(id + vSeed);
    float r2 = rnd(id * 1.7 + vSeed + 3.1);
    vec3 interior = mix(vec3(0.035, 0.038, 0.042), vec3(0.11, 0.09, 0.07), r2);
    // Shops are lit inside by day.
    if (shop) interior = mix(vec3(0.16, 0.14, 0.11), vec3(0.28, 0.24, 0.18), r2);
    bool curtain = kind > 4.5 && kind < 5.5;
    float blinds = step(curtain ? 0.9 : 0.72, r1) * step(hs.y - (0.3 + r2 * 1.4 * hs.y), p.y);
    interior = mix(interior, vec3(0.34, 0.33, 0.3), blinds * (curtain ? 0.35 : 0.8));
    // Reflectance: curtain glass takes the building's tint, brightened; plain glass a cool grey.
    vec3 tint = curtain ? clamp(diffuseColor.rgb * 2.4 + 0.12, 0.0, 1.0) : vec3(0.5, 0.56, 0.62);
    float metal = curtain ? mix(0.72, 1.0, fres) : mix(0.22, 0.85, fres) * (1.0 - blinds * 0.6);
    vec3 glassC = mix(interior, tint, metal);
    // Curtain walls: an opaque spandrel at each floor slab, panes not quite flat.
    float spandrel = 0.0;
    if (kind > 4.5 && kind < 5.5) {
      spandrel = boxMask(vec2(p.x, fract(q.y) * cs.y - 0.45), vec2(hs.x, 0.45), aa);
      glassC = mix(glassC, tint * 0.42, spandrel);
      metal = mix(metal, 0.5, spandrel);
    }
    // Far away the grid is too fine to draw: blend to the average of glass and wall.
    float cover = (hs.x * hs.y * 4.0) / (cs.x * cs.y);
    vec3 wallC = diffuseColor.rgb;
    vec3 near = mix(wallC, frameC, frameM * fine);
    near = mix(near, wallC * (p.y > 0.0 ? 0.55 : 0.95), revealM * (1.0 - glassM));
    near = mix(near, glassC, glassM);
    vec3 farC = mix(wallC, glassC, kind > 4.5 && kind < 5.5 ? 0.9 : cover * 0.9);
    diffuseColor.rgb = mix(farC, near, vis);
    float g = mix(kind > 4.5 && kind < 5.5 ? 0.9 : cover, glassM, vis);
    gRough = mix(gRough, mix(0.05 + r2 * 0.06, 0.6, blinds) , g);
    gMetal = mix(gMetal, metal, g);
    gAO = mix(gAO, 1.0, g);
    if (glassM * vis > 0.5) {
      // Panes tilt by a hair each, so reflections break up the way real glass does.
      gNTS = normalize(vec3((r1 - 0.5) * 0.03, (r2 - 0.5) * 0.03, 1.0));
      gBump = true;
    } else if (revealM > 0.5) {
      vec2 sgn = sign(p);
      gNTS = inner.x < inner.y ? normalize(vec3(-sgn.x * 0.8, 0.0, 0.6)) : normalize(vec3(0.0, -sgn.y * 0.8, 0.6));
      gBump = true;
    } else if (sill > 0.5) {
      gNTS = normalize(vec3(0.0, 0.5, 0.86));
      gBump = true;
    }
    // Shop sign band above the glass.
    if (shop) {
      float band = boxMask(vec2(l.x, uvm.y - 3.65), vec2(cs.x * 0.5, 0.32), aa);
      vec3 sc = signColour(vSeed + id.x * 0.37);
      float letters = step(0.45, rnd(floor(vec2(uvm.x * 3.0, uvm.y * 4.0)))) * boxMask(vec2(l.x, uvm.y - 3.65), vec2(cs.x * 0.36, 0.14), aa);
      diffuseColor.rgb = mix(diffuseColor.rgb, mix(sc, vec3(0.92, 0.9, 0.84), letters * fine), band);
      gRough = mix(gRough, 0.5, band);
      gWinGlow += vec3(1.0, 0.86, 0.6) * letters * band * uNight * 2.0;
    }
    // About a third of windows lit at night, each its own brightness, warm in
    // homes and a cooler white in offices.
    float lr = rnd(id + vSeed * 1.3 + 7.0);
    float lit = step(0.64, lr) * (0.45 + 0.9 * fract(lr * 13.7));
    vec3 lamp = mix(${glsl(PALETTE.windowLit)}, vec3(0.85, 0.9, 1.0), (kind > 3.5 && kind < 5.5) ? 0.6 * step(0.4, r2) : 0.15 * r2);
    gWinGlow += lamp * (glassM * lit * (1.0 - spandrel) * vis + (1.0 - vis) * cover * 0.3) * uNight * (shop ? 2.2 : 1.4);
  }
  diffuseColor.rgb *= gAO;
}
`;

/** The shared building material. Textures are made once per renderer. */
export function buildingMaterial(shared: Shared, anisotropy = 8): THREE.MeshStandardMaterial {
  const atlas = makeFacadeAtlas(anisotropy);
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  m.userData.atlas = atlas;
  m.onBeforeCompile = (s) => {
    s.uniforms.uNight = shared.uNight;
    s.uniforms.uNoise = shared.uNoise;
    s.uniforms.uFacadeColor = { value: atlas.color };
    s.uniforms.uFacadeData = { value: atlas.data };
    s.vertexShader = s.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nattribute vec4 aWin;\nattribute vec2 aMat;\nvarying vec2 vWinUv;\nflat varying float vWinKind;\nflat varying float vSeed;\nflat varying float vMat;\nvarying float vBase;\nvarying vec3 vPos;\nvarying vec3 vObjN;`,
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvWinUv = aWin.xy;\nvWinKind = aWin.z;\nvSeed = aWin.w;\nvMat = aMat.x;\nvBase = aMat.y;\nvPos = position;\nvObjN = normal;`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\n${FACADE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FACADE_FRAGMENT}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = gRough;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\nmetalnessFactor = gMetal;`)
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
if (gBump) {
  // Tangent frame from the screen derivatives of position and the metre UVs.
  vec3 dp1 = dFdx(-vViewPosition);
  vec3 dp2 = dFdy(-vViewPosition);
  vec2 duv1 = dFdx(vWinUv);
  vec2 duv2 = dFdy(vWinUv);
  vec3 N = normal;
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float det = max(dot(T, T), dot(B, B));
  if (det > 0.0) {
    float inv = inversesqrt(det);
    normal = normalize(mat3(T * inv, B * inv, N) * gNTS);
  }
}`,
      )
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += gWinGlow;`);
  };
  m.customProgramCacheKey = () => 'cl-building-facade';
  return m;
}

export function disposeBuildingMaterial(m: THREE.MeshStandardMaterial): void {
  const atlas = m.userData.atlas as { color: THREE.Texture; data: THREE.Texture } | undefined;
  atlas?.color.dispose();
  atlas?.data.dispose();
  m.dispose();
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

type Rng = () => number;

const C = BUILDING_COLOURS;
const pickHex = (rng: Rng, list: readonly number[]): number => list[Math.floor(rng() * list.length) % list.length];

/** A colour from a list, nudged a few percent so no two buildings match. */
export function facadeColour(rng: Rng, list: readonly number[]): RGB {
  const c = hexRGB(pickHex(rng, list));
  const k = 0.92 + rng() * 0.16;
  const warm = (rng() - 0.5) * 0.04;
  return [Math.min(1, c[0] * k * (1 + warm)), Math.min(1, c[1] * k), Math.min(1, c[2] * k * (1 - warm))];
}

/** Placement of one building: centre, ground, half sizes, and axes (f along hd). */
export interface Footing {
  x: number;
  z: number;
  ground: number;
  hw: number;
  hd: number;
  fx: number;
  fz: number;
}

const ROOF_TRIM = hexRGB(0x8a8a86);

/** A band all round a building: string course, cornice, ledge. */
function band(buf: BuildingBuf, f: Footing, y: number, out: number, h: number, color: RGB, mat: number = MAT.stone): void {
  buf.block(f.x, y, f.z, f.hw + out, f.hd + out, h, f.fx, f.fz, color, color, 0, 0, { wall: mat, roof: mat });
}

/** Parapet with coping round a flat roof, and the roof itself. */
export function parapetRoof(buf: BuildingBuf, f: Footing, y: number, wall: RGB, wallMat: number, roof: RGB, h = 0.9): void {
  const t = 0.25;
  const { x, z, hw, hd, fx, fz } = f;
  const rx = -fz;
  const rz = fx;
  const coping = hexRGB(0xc8c4ba);
  buf.block(x + fx * (hd - t), y, z + fz * (hd - t), hw, t, h, fx, fz, wall, coping, 0, 0, { wall: wallMat, roof: MAT.stone });
  buf.block(x - fx * (hd - t), y, z - fz * (hd - t), hw, t, h, fx, fz, wall, coping, 0, 0, { wall: wallMat, roof: MAT.stone });
  buf.block(x + rx * (hw - t), y, z + rz * (hw - t), t, hd - t * 2, h, fx, fz, wall, coping, 0, 0, { wall: wallMat, roof: MAT.stone });
  buf.block(x - rx * (hw - t), y, z - rz * (hw - t), t, hd - t * 2, h, fx, fz, wall, coping, 0, 0, { wall: wallMat, roof: MAT.stone });
  buf.block(x, y - 0.02, z, hw - t, hd - t, 0.1, fx, fz, roof, roof, 0, 0, { wall: MAT.plain, roof: MAT.flatRoof });
}

/**
 * Rooftop plant: air handlers with ducts, a water tank on legs, a stair and lift
 * housing, an antenna. Placed in a loose grid so units do not overlap.
 */
export function rooftop(buf: BuildingBuf, f: Footing, y: number, rng: Rng, opts: { tank?: boolean; stair?: boolean; units?: number; antenna?: boolean; wall?: RGB; wallMat?: number } = {}): void {
  const out = buf.detail ?? buf;
  const { x, z, fx, fz } = f;
  const rx = -fz;
  const rz = fx;
  const hw = f.hw - 1.2;
  const hd = f.hd - 1.2;
  if (hw < 1 || hd < 1) return;
  const ground = out.ground;
  out.ground = y;
  const at = (u: number, v: number) => ({ x: x + rx * u + fx * v, z: z + rz * u + fz * v });
  // Slots on a 3 by 3 grid of the roof, taken in random order.
  const slots: [number, number][] = [];
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) slots.push([i * hw * 0.62, j * hd * 0.62]);
  for (let i = slots.length - 1; i > 0; i--) {
    const k = Math.floor(rng() * (i + 1));
    [slots[i], slots[k]] = [slots[k], slots[i]];
  }
  const hvac = hexRGB(C.hvac);
  const take = () => slots.pop();
  if (opts.stair) {
    const s = take();
    if (s) {
      const p = at(s[0], s[1]);
      const w = opts.wall ?? hexRGB(0xb0aca2);
      out.block(p.x, y, p.z, 1.4, 1.8, 3.0, fx, fz, w, hexRGB(0x7a7872), 0, 0, { wall: opts.wallMat ?? MAT.concrete, roof: MAT.flatRoof });
      const d = at(s[0] - 1.42, s[1]);
      out.block(d.x, y, d.z, 0.04, 0.5, 2.1, fx, fz, hexRGB(C.door), hexRGB(C.door), 0, 0, { wall: MAT.metal });
    }
  }
  if (opts.tank) {
    const s = take();
    if (s) {
      const p = at(s[0], s[1]);
      const r = 1.3 + rng() * 0.6;
      const legs = 1.6;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const l = at(s[0] + a * r * 0.62, s[1] + b * r * 0.62);
        out.block(l.x, y, l.z, 0.08, 0.08, legs, fx, fz, hexRGB(0x3c3c3a), hexRGB(0x3c3c3a), 0, 0, { wall: MAT.metal });
      }
      out.block(p.x, y + legs, p.z, r * 0.9, r * 0.9, 0.12, fx, fz, hexRGB(0x4a4846), hexRGB(0x4a4846), 0, 0);
      out.drum(p.x, y + legs + 0.12, p.z, r, 2.4 + rng() * 0.8, hexRGB(C.tank), hexRGB(0x4a3e34), MAT.metal, 0.55);
    }
  }
  const units = opts.units ?? 2;
  for (let i = 0; i < units; i++) {
    const s = take();
    if (!s) break;
    const p = at(s[0] + (rng() - 0.5), s[1] + (rng() - 0.5));
    const uw = 0.7 + rng() * 0.9;
    const ud = 0.9 + rng() * 1.1;
    const uh = 0.9 + rng() * 0.8;
    out.block(p.x, y, p.z, uw, ud, uh, fx, fz, hvac, hvac, 0, 0, { wall: MAT.hvac, roof: MAT.hvac });
    // A duct to the nearest edge.
    if (rng() < 0.6) {
      const len = Math.max(0.5, (hd - Math.abs(s[1])) * 0.5);
      const sgn = s[1] >= 0 ? 1 : -1;
      const q = at(s[0], s[1] + sgn * (ud + len));
      out.block(q.x, y + 0.15, q.z, 0.28, len, 0.5, fx, fz, hexRGB(0xa4a8aa), hexRGB(0xa4a8aa), 0, 0, { wall: MAT.metal, roof: MAT.metal });
    }
  }
  if (opts.antenna) {
    const p = at(hw * 0.3, -hd * 0.3);
    out.block(p.x, y, p.z, 0.09, 0.09, 6 + rng() * 8, fx, fz, hexRGB(0x707478), hexRGB(0x707478), 0, 0, { wall: MAT.metal });
  }
  out.ground = ground;
}

/**
 * Mid-rise block of flats or offices: a ground floor (shops or a stone base), a
 * string course, the floors above with their window grid, a cornice, a parapet
 * and plant on the roof.
 */
export function midrise(buf: BuildingBuf, f: Footing, floors: number, kind: 'flats' | 'offices' | 'mixed', rng: Rng): number {
  const style = rng();
  let wallMat: number;
  let wall: RGB;
  if (kind === 'offices') {
    wallMat = style < 0.5 ? MAT.concrete : MAT.stone;
    wall = facadeColour(rng, wallMat === MAT.concrete ? C.concrete : C.stone);
  } else {
    wallMat = style < 0.55 ? MAT.brick : style < 0.85 ? MAT.stucco : MAT.concrete;
    wall = facadeColour(rng, wallMat === MAT.brick ? C.brick : wallMat === MAT.stucco ? C.stucco : C.concrete);
  }
  const stone = facadeColour(rng, C.stone);
  const roof = facadeColour(rng, C.flatRoof);
  const seed = rng() * 40;
  buf.ground = f.ground;
  const shops = kind !== 'flats' || rng() < 0.4;
  const groundH = shops ? 4.5 : 3.4;
  const upperWin = kind === 'offices' ? WIN.office : WIN.apartment;
  const floorH = kind === 'offices' ? 3.6 : 3.0;
  // Plinth and ground floor.
  buf.block(f.x, f.ground - 0.3, f.z, f.hw + 0.06, f.hd + 0.06, 0.3 + 0.01, f.fx, f.fz, stone, stone, 0, 0, { wall: MAT.stone, roof: MAT.stone });
  buf.block(f.x, f.ground, f.z, f.hw, f.hd, groundH, f.fx, f.fz, shops ? stone : wall, roof, shops ? WIN.shop : upperWin, seed, { wall: shops ? MAT.stone : wallMat });
  let y = f.ground + groundH;
  band(buf, f, y - 0.1, 0.12, 0.3, stone);
  // Upper floors, with a setback top floor on some offices.
  const upper = Math.max(1, floors - 1);
  const setback = kind === 'offices' && upper > 4 && rng() < 0.5;
  const mainFloors = setback ? upper - 1 : upper;
  buf.block(f.x, y, f.z, f.hw, f.hd, mainFloors * floorH, f.fx, f.fz, wall, roof, upperWin, seed + 3, { wall: wallMat });
  y += mainFloors * floorH;
  // Cornice: a deep band with a shallower one under it.
  band(buf, f, y - 0.35, 0.18, 0.35, stone);
  band(buf, f, y, 0.4, 0.42, stone);
  y += 0.42;
  if (setback) {
    const s: Footing = { ...f, hw: f.hw - 2.2, hd: f.hd - 2.2 };
    parapetRoof(buf, f, y, wall, wallMat, roof, 1.0);
    buf.block(f.x, y, f.z, s.hw, s.hd, floorH, f.fx, f.fz, wall, roof, upperWin, seed + 5, { wall: wallMat });
    y += floorH;
    parapetRoof(buf, s, y, stone, MAT.stone, roof, 0.6);
    rooftop(buf, s, y, rng, { units: 2 + Math.floor(rng() * 3), stair: true });
    return y;
  }
  parapetRoof(buf, f, y, wall, wallMat, roof, 0.9);
  rooftop(buf, f, y, rng, { units: 1 + Math.floor(rng() * 4), stair: true, tank: wallMat === MAT.brick && rng() < 0.6, wall, wallMat });
  return y;
}

/**
 * Office tower: a stone podium with shopfronts, a shaft in one to three tiers of
 * curtain wall (or punched precast on some), ledges between tiers, a crown of
 * plant screen and a penthouse, antenna on the tallest.
 */
export function tower(buf: BuildingBuf, f: Footing, floors: number, rng: Rng): number {
  const glass = rng() < 0.7;
  const shaftMat = glass ? MAT.glass : rng() < 0.5 ? MAT.concrete : MAT.stone;
  const shaft = glass ? facadeColour(rng, C.glass) : facadeColour(rng, shaftMat === MAT.concrete ? C.concrete : C.stone);
  const stone = facadeColour(rng, C.stone);
  const roof = facadeColour(rng, C.flatRoof);
  const metal = facadeColour(rng, C.metal);
  const seed = rng() * 40;
  buf.ground = f.ground;
  // Podium: shops, then a floor or two of offices.
  const podiumFloors = 1 + Math.floor(rng() * 2);
  const podium: Footing = { ...f, hw: f.hw * 1.12, hd: f.hd * 1.12 };
  buf.block(f.x, f.ground - 0.3, f.z, podium.hw + 0.06, podium.hd + 0.06, 0.31, f.fx, f.fz, stone, stone, 0, 0, { wall: MAT.stone, roof: MAT.stone });
  buf.block(f.x, f.ground, f.z, podium.hw, podium.hd, 5, f.fx, f.fz, stone, roof, WIN.shop, seed, { wall: MAT.stone });
  let y = f.ground + 5;
  if (podiumFloors > 1) {
    buf.block(f.x, y, f.z, podium.hw, podium.hd, 3.6, f.fx, f.fz, stone, roof, WIN.office, seed + 1, { wall: MAT.stone });
    y += 3.6;
  }
  band(buf, podium, y, 0.15, 0.5, stone);
  parapetRoof(buf, podium, y + 0.5, stone, MAT.stone, roof, 0.8);
  // Shaft in tiers.
  const shaftFloors = Math.max(4, floors - podiumFloors);
  const tiers = shaftFloors > 24 ? 3 : shaftFloors > 12 ? 2 : 1;
  let left = shaftFloors;
  let tier: Footing = { ...f };
  for (let t = 0; t < tiers; t++) {
    const n = t === tiers - 1 ? left : Math.round(shaftFloors * (t === 0 ? 0.55 : 0.3));
    left -= n;
    const h = n * 3.6;
    buf.block(f.x, y, f.z, tier.hw, tier.hd, h, f.fx, f.fz, shaft, roof, glass ? WIN.curtain : WIN.office, seed + 7 + t, { wall: shaftMat });
    // Corner piers on precast towers.
    y += h;
    if (t < tiers - 1) {
      band(buf, tier, y, 0.08, 0.6, glass ? metal : stone, glass ? MAT.metal : MAT.stone);
      y += 0.6;
      parapetRoof(buf, tier, y, glass ? metal : stone, glass ? MAT.metal : MAT.stone, roof, 1.1);
      const k = 0.82 + rng() * 0.08;
      tier = { ...tier, hw: tier.hw * k, hd: tier.hd * k };
    }
  }
  // Crown: a screened plant floor, then the roof.
  band(buf, tier, y, 0.05, 0.4, metal, MAT.metal);
  y += 0.4;
  buf.block(f.x, y, f.z, tier.hw - 0.3, tier.hd - 0.3, 3.2, f.fx, f.fz, metal, roof, 0, seed, { wall: MAT.metal, roof: MAT.flatRoof });
  parapetRoof(buf, tier, y, glass ? shaft : stone, glass ? MAT.glass : MAT.stone, roof, 3.6);
  y += 3.2;
  const pent: Footing = { ...tier, hw: tier.hw * 0.45, hd: tier.hd * 0.45 };
  buf.block(f.x, y, f.z, pent.hw, pent.hd, 3.4, f.fx, f.fz, metal, roof, 0, seed, { wall: MAT.metal, roof: MAT.flatRoof });
  rooftop(buf, { ...tier, hw: tier.hw - 0.4, hd: tier.hd - 0.4 }, y, rng, { units: 3 + Math.floor(rng() * 3), antenna: floors > 22 });
  return y + 3.4;
}

/** Corrugated shed with a concrete dado, roller doors and roof lights. */
export function shed(buf: BuildingBuf, f: Footing, h: number, rng: Rng, roofAlong: boolean): void {
  const wall = facadeColour(rng, C.metal);
  const roofC = facadeColour(rng, C.metal);
  const conc = facadeColour(rng, C.concrete);
  buf.ground = f.ground;
  buf.block(f.x, f.ground, f.z, f.hw + 0.05, f.hd + 0.05, 1.4, f.fx, f.fz, conc, conc, 0, 0, { wall: MAT.concrete, roof: MAT.concrete });
  buf.block(f.x, f.ground + 1.4, f.z, f.hw, f.hd, h - 1.4, f.fx, f.fz, wall, roofC, WIN.industrial, rng() * 40, { wall: MAT.metal, roof: MAT.metal });
  const top = f.ground + h;
  if (roofAlong) buf.gable(f.x, top, f.z, f.hw * 1.02, f.hd * 1.02, 1.4, f.fx, f.fz, roofC, wall, 0.3, { roof: MAT.metal, wall: MAT.metal });
  else buf.gable(f.x, top, f.z, f.hd * 1.02, f.hw * 1.02, 1.4, -f.fz, f.fx, roofC, wall, 0.3, { roof: MAT.metal, wall: MAT.metal });
  // Roller doors along the front (the -r side).
  const rx = -f.fz;
  const rz = f.fx;
  const doors = Math.max(1, Math.floor((f.hd * 2) / 9));
  const door = facadeColour(rng, [0x8a8e90, 0x5a6a74, 0xa89a6a, 0x6a5040]);
  for (let k = 0; k < doors; k++) {
    const v = -f.hd + ((k + 0.5) / doors) * f.hd * 2;
    const dx = f.x - rx * (f.hw + 0.06) + f.fx * v;
    const dz = f.z - rz * (f.hw + 0.06) + f.fz * v;
    buf.block(dx, f.ground, dz, 0.06, 1.8, 4.2, f.fx, f.fz, door, door, 0, 0, { wall: MAT.metal });
    buf.block(dx - rx * 0.8, f.ground + 4.4, dz - rz * 0.8, 0.8, 2.2, 0.12, f.fx, f.fz, hexRGB(0x5a5e62), hexRGB(0x5a5e62), 0, 0);
  }
  void ROOF_TRIM;
}
