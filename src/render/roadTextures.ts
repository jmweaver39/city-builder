/**
 * Procedural road surface textures: asphalt and concrete, generated in code.
 * Pure TypeScript with no DOM or Three.js, so it runs in a worker and under Vitest.
 *
 * Each texture is one tiling RGBA8 image, linear data rather than colour:
 *   R  albedo, mean 0.5. The shader turns it into a brightness multiplier.
 *   G  normal x (along +u, world +x) as n * 0.5 + 0.5
 *   B  normal y (along +v, world +z)
 *   A  roughness
 *
 * The pattern is defined in tile space, not pixels, so every resolution shows the
 * same stones, only sharper: Low at 256 is the same road as Ultra at 4096.
 * Everything uses integer hashes and plain arithmetic, so a seed gives the same
 * bytes on every run.
 */

/** Metres of road one asphalt tile covers. */
export const ASPHALT_TILE = 4;
/** Metres one concrete tile covers. */
export const CONCRETE_TILE = 2;

export type RoadTexKind = 'asphalt' | 'concrete';

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(e0: number, e1: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Tiling value noise over a period of p lattice cells. */
function tileNoise(x: number, y: number, p: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % p) + p) % p;
  const y0 = ((yi % p) + p) % p;
  const x1 = (x0 + 1) % p;
  const y1 = (y0 + 1) % p;
  const a = hash(x0, y0, seed);
  const b = hash(x1, y0, seed);
  const c = hash(x0, y1, seed);
  const d = hash(x1, y1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** A coarse tiling fbm field, M by M, sampled bilinearly. Values roughly 0 to 1. */
class Field {
  private readonly v: Float32Array;
  private readonly m: number;
  constructor(m: number, base: number, octaves: number, seed: number) {
    this.m = m;
    this.v = new Float32Array(m * m);
    for (let y = 0; y < m; y++) {
      for (let x = 0; x < m; x++) {
        let sum = 0;
        let amp = 0.5;
        let tot = 0;
        let f = base;
        for (let o = 0; o < octaves; o++) {
          sum += amp * tileNoise((x / m) * f, (y / m) * f, f, seed + o * 31);
          tot += amp;
          amp *= 0.5;
          f *= 2;
        }
        this.v[x + y * m] = sum / tot;
      }
    }
  }

  /** u, v in tile units, any value (wraps). */
  at(u: number, v: number): number {
    const m = this.m;
    const gx = u * m - 0.5;
    const gy = v * m - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const tx = gx - x0;
    const ty = gy - y0;
    const xa = ((x0 % m) + m) % m;
    const ya = ((y0 % m) + m) % m;
    const xb = (xa + 1) % m;
    const yb = (ya + 1) % m;
    const r0 = ya * m;
    const r1 = yb * m;
    const a = this.v[xa + r0] + (this.v[xb + r0] - this.v[xa + r0]) * tx;
    const b = this.v[xa + r1] + (this.v[xb + r1] - this.v[xa + r1]) * tx;
    return a + (b - a) * ty;
  }
}

/**
 * Crushed stones on a jittered grid of c by c cells per tile. Each cell holds at
 * most one stone, an irregular hexagon (three facet directions, each with its own
 * reach) blended toward a disc for the rounder ones. Stones may reach into the
 * next cell, so neighbours overlap and pack like real aggregate.
 */
class Stones {
  readonly c: number;
  readonly cx: Float32Array;
  readonly cy: Float32Array;
  /** Radius in cells, 0 for an empty cell. */
  readonly r: Float32Array;
  readonly h: Float32Array;
  readonly tone: Float32Array;
  readonly rough: Float32Array;
  /** First facet direction, and the inverse reach of each of the three facets. */
  private readonly dx: Float32Array;
  private readonly dy: Float32Array;
  private readonly f: Float32Array;
  private readonly round: Float32Array;
  constructor(
    c: number,
    presence: number,
    rMin: number,
    rMax: number,
    hMin: number,
    hMax: number,
    tone: (k: number) => number,
    rough: (k: number) => number,
    seed: number,
  ) {
    this.c = c;
    const n = c * c;
    this.cx = new Float32Array(n);
    this.cy = new Float32Array(n);
    this.r = new Float32Array(n);
    this.h = new Float32Array(n);
    this.tone = new Float32Array(n);
    this.rough = new Float32Array(n);
    this.dx = new Float32Array(n);
    this.dy = new Float32Array(n);
    this.f = new Float32Array(n * 3);
    this.round = new Float32Array(n);
    for (let y = 0; y < c; y++) {
      for (let x = 0; x < c; x++) {
        const i = x + y * c;
        if (hash(x, y, seed) >= presence) continue;
        // Radius under one cell, so the 3 by 3 search always finds the stone.
        const r = Math.min(0.95, rMin + (rMax - rMin) * hash(x, y, seed + 1));
        this.cx[i] = hash(x, y, seed + 2);
        this.cy[i] = hash(x, y, seed + 3);
        this.r[i] = r;
        this.h[i] = hMin + (hMax - hMin) * hash(x, y, seed + 4);
        this.tone[i] = tone(hash(x, y, seed + 5));
        this.rough[i] = rough(hash(x, y, seed + 6));
        let ax = hash(x, y, seed + 7) - 0.5;
        let ay = hash(x, y, seed + 8) - 0.5;
        const al = Math.sqrt(ax * ax + ay * ay) || 1;
        ax /= al;
        ay /= al;
        this.dx[i] = ax;
        this.dy[i] = ay;
        for (let k = 0; k < 3; k++) this.f[i * 3 + k] = 1 / (0.72 + 0.4 * hash(x, y, seed + 9 + k));
        this.round[i] = hash(x, y, seed + 12) * hash(x, y, seed + 13);
      }
    }
  }

  /**
   * The highest stone covering (u, v), as its height, or -1 for none. Writes the
   * stone's index and its normalised distance from the centre (1 at the edge) into out.
   */
  sample(u: number, v: number, out: { i: number; d: number }): number {
    const c = this.c;
    const gx = u * c;
    const gy = v * c;
    const xi = Math.floor(gx);
    const yi = Math.floor(gy);
    let best = -1;
    // 60 and 120 degree turns of the first facet direction.
    const C = 0.5;
    const S = 0.8660254;
    for (let oy = -1; oy <= 1; oy++) {
      const cyi = yi + oy;
      const row = (((cyi % c) + c) % c) * c;
      for (let ox = -1; ox <= 1; ox++) {
        const cxi = xi + ox;
        const i = (((cxi % c) + c) % c) + row;
        const r = this.r[i];
        if (r === 0) continue;
        const px = (gx - (cxi + this.cx[i])) / r;
        const py = (gy - (cyi + this.cy[i])) / r;
        const circ = px * px + py * py;
        if (circ >= 1.8) continue;
        const ax = this.dx[i];
        const ay = this.dy[i];
        const p0 = Math.abs(px * ax + py * ay) * this.f[i * 3];
        const p1 = Math.abs(px * (ax * C - ay * S) + py * (ax * S + ay * C)) * this.f[i * 3 + 1];
        const p2 = Math.abs(px * (ax * C + ay * S) + py * (ay * C - ax * S)) * this.f[i * 3 + 2];
        const poly = Math.max(p0, p1, p2);
        const rd = this.round[i];
        const d = poly * (1 - rd) + Math.sqrt(circ) * rd;
        if (d >= 1) continue;
        // Worn flat top, steep sides.
        const d2 = d * d;
        const dome = this.h[i] * Math.sqrt(1 - d2 * d2);
        if (dome > best) {
          best = dome;
          out.i = i;
          out.d = d;
        }
      }
    }
    return best;
  }
}

interface Sample {
  h: number;
  albedo: number;
  rough: number;
}

type Shader = (u: number, v: number, px: number, py: number, out: Sample) => void;

interface Recipe {
  tile: number;
  /** Height units to metres. */
  heightScale: number;
  /** Target albedo standard deviation after normalising. */
  contrast: number;
  shader: Shader;
}

function asphaltRecipe(seed: number): Recipe {
  // Coarse aggregate about 12 mm, then 4 mm grit, in a dark bitumen binder.
  const big = new Stones(
    260,
    0.74,
    0.32,
    0.68,
    0.6,
    1,
    (k) => (k < 0.68 ? 0.55 + k * 0.3 : k < 0.9 ? 0.3 + (k - 0.68) * 0.6 : 0.82 + (k - 0.9) * 1.2),
    (k) => 0.58 + 0.24 * k,
    seed * 101 + 1,
  );
  const grit = new Stones(
    700,
    0.78,
    0.35,
    0.8,
    0.22,
    0.42,
    (k) => 0.38 + 0.34 * k,
    (k) => 0.7 + 0.18 * k,
    seed * 101 + 17,
  );
  const mottle = new Field(256, 6, 4, seed * 101 + 41);
  const fine = new Field(512, 64, 2, seed * 101 + 53);
  const hit = { i: 0, d: 0 };
  return {
    tile: ASPHALT_TILE,
    heightScale: 0.0028,
    contrast: 0.17,
    shader: (u, v, px, py, out) => {
      const m = mottle.at(u, v);
      const f = fine.at(u, v);
      const sand = hash(px, py, seed * 7 + 3);
      // Binder with fine sand.
      let h = -0.15 + 0.12 * f + 0.06 * (sand - 0.5);
      let albedo = 0.2 + 0.05 * (m - 0.5) + 0.07 * (sand - 0.5) + 0.04 * (f - 0.5);
      let rough = 0.9 + 0.06 * (sand - 0.5);
      const g = grit.sample(u, v, hit);
      if (g > h) {
        const rim = smooth(0.55, 1, hit.d);
        h = g;
        albedo = grit.tone[hit.i] * (1 - 0.3 * rim) + 0.05 * (sand - 0.5);
        rough = grit.rough[hit.i];
      }
      const b = big.sample(u, v, hit);
      if (b > h) {
        const rim = smooth(0.6, 1, hit.d);
        h = b + 0.04 * (f - 0.5);
        // Dust and binder film gather round the edge of each stone.
        albedo = big.tone[hit.i] * (1 - 0.35 * rim) + 0.03 * (sand - 0.5);
        rough = big.rough[hit.i] + 0.12 * rim;
      }
      out.h = h;
      out.albedo = albedo;
      out.rough = rough;
    },
  };
}

function concreteRecipe(seed: number): Recipe {
  // Fine sand in pale cement paste, an occasional exposed stone, small air pores.
  const sand = new Stones(
    1400,
    0.55,
    0.35,
    0.7,
    0.25,
    0.4,
    (k) => 0.5 + 0.32 * k,
    (k) => 0.78 + 0.12 * k,
    seed * 211 + 5,
  );
  const stone = new Stones(
    260,
    0.12,
    0.35,
    0.7,
    0.35,
    0.55,
    (k) => 0.5 + 0.2 * k,
    (k) => 0.7 + 0.15 * k,
    seed * 211 + 9,
  );
  const pores = new Stones(
    150,
    0.1,
    0.05,
    0.14,
    0.5,
    0.9,
    (k) => 0.44 + 0.08 * k,
    () => 0.95,
    seed * 211 + 13,
  );
  const mottle = new Field(256, 5, 4, seed * 211 + 21);
  const fine = new Field(512, 48, 2, seed * 211 + 33);
  const hit = { i: 0, d: 0 };
  return {
    tile: CONCRETE_TILE,
    heightScale: 0.0012,
    contrast: 0.09,
    shader: (u, v, px, py, out) => {
      const m = mottle.at(u, v);
      const f = fine.at(u, v);
      const grain = hash(px, py, seed * 13 + 1);
      let h = 0.1 * (f - 0.5) + 0.05 * (grain - 0.5);
      let albedo = 0.62 + 0.07 * (m - 0.5) + 0.04 * (f - 0.5) + 0.05 * (grain - 0.5);
      let rough = 0.86 + 0.05 * (grain - 0.5);
      const st = stone.sample(u, v, hit);
      if (st > 0) {
        h = Math.max(h, st * 0.6);
        albedo = stone.tone[hit.i] * (1 - 0.2 * smooth(0.6, 1, hit.d));
        rough = stone.rough[hit.i];
      } else {
        const sd = sand.sample(u, v, hit);
        if (sd > 0) {
          h = Math.max(h, sd * 0.5 + h);
          albedo = albedo * 0.5 + sand.tone[hit.i] * 0.5;
          rough = sand.rough[hit.i];
        }
      }
      const p = pores.sample(u, v, hit);
      if (p > 0) {
        h -= p;
        albedo = albedo * 0.4 + pores.tone[hit.i] * 0.6;
        rough = 0.95;
      }
      out.h = h;
      out.albedo = albedo;
      out.rough = rough;
    },
  };
}

function recipeFor(kind: RoadTexKind, seed: number): Recipe {
  return kind === 'asphalt' ? asphaltRecipe(seed) : concreteRecipe(seed);
}

/** A texture being generated, a band of rows at a time. */
export interface RoadTextureJob {
  readonly kind: RoadTexKind;
  readonly size: number;
  readonly seed: number;
  /** RGBA8, complete once done. */
  readonly data: Uint8Array;
  /** Rows finished, 0 to size. */
  readonly rows: number;
  readonly done: boolean;
  /** Work for about this many milliseconds (at least one row). Returns done. */
  step(budgetMs?: number): boolean;
}

/** Start generating one texture. size must be a power of two. */
export function createRoadTextureJob(kind: RoadTexKind, size: number, seed = 1): RoadTextureJob {
  const N = size;
  const rec = recipeFor(kind, seed);
  const s: Sample = { h: 0, albedo: 0, rough: 0 };
  // Albedo statistics from a fixed set of points, so every size normalises alike.
  let sum = 0;
  let sum2 = 0;
  const probes = 4096;
  for (let k = 0; k < probes; k++) {
    const u = hash(k, 1, seed + 977);
    const v = hash(k, 2, seed + 977);
    rec.shader(u, v, k, k * 7, s);
    sum += s.albedo;
    sum2 += s.albedo * s.albedo;
  }
  const mean = sum / probes;
  const std = Math.sqrt(Math.max(1e-6, sum2 / probes - mean * mean));
  const gain = rec.contrast / std;

  const out = new Uint8Array(N * N * 4);
  // Three rows in a ring, so memory stays small at 4096.
  const hRows = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  const aRows = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  const rRows = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  const fill = (y: number, slot: number) => {
    const yy = ((y % N) + N) % N;
    const v = (yy + 0.5) / N;
    const hr = hRows[slot];
    const ar = aRows[slot];
    const rr = rRows[slot];
    for (let x = 0; x < N; x++) {
      rec.shader((x + 0.5) / N, v, x, yy, s);
      hr[x] = s.h;
      ar[x] = s.albedo;
      rr[x] = s.rough;
    }
  };
  // Row y lives in slot (y + 1) % 3.
  fill(-1, 0);
  fill(0, 1);
  // Slope per unit of height difference across two texels.
  const k = rec.heightScale / ((2 * rec.tile) / N);
  let y = 0;
  const row = () => {
    const hp = hRows[y % 3];
    const sc = (y + 1) % 3;
    const sn = (y + 2) % 3;
    fill(y + 1, sn);
    const hc = hRows[sc];
    const hn = hRows[sn];
    const aRow = aRows[sc];
    const rRow = rRows[sc];
    const o = y * N * 4;
    for (let x = 0; x < N; x++) {
      const xl = x === 0 ? N - 1 : x - 1;
      const xr = x === N - 1 ? 0 : x + 1;
      let nx = -(hc[xr] - hc[xl]) * k;
      let ny = -(hn[x] - hp[x]) * k;
      const l = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= l;
      ny *= l;
      const i = o + x * 4;
      out[i] = clamp255((0.5 + (aRow[x] - mean) * gain) * 255);
      out[i + 1] = clamp255((nx * 0.5 + 0.5) * 255);
      out[i + 2] = clamp255((ny * 0.5 + 0.5) * 255);
      out[i + 3] = clamp255(rRow[x] * 255);
    }
    y++;
  };
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return {
    kind,
    size,
    seed,
    data: out,
    get rows() {
      return y;
    },
    get done() {
      return y >= N;
    },
    step(budgetMs = Infinity) {
      const t0 = now();
      while (y < N) {
        row();
        // Check the clock every few rows only.
        if ((y & 7) === 0 && now() - t0 >= budgetMs) break;
      }
      return y >= N;
    },
  };
}

/** Generate one texture in one go. size must be a power of two. */
export function generateRoadTexture(kind: RoadTexKind, size: number, seed = 1): Uint8Array {
  const job = createRoadTextureJob(kind, size, seed);
  job.step();
  return job.data;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Bytes a mipmapped RGBA8 texture of this size takes on the GPU. */
export function textureBytes(size: number): number {
  return Math.round((size * size * 4 * 4) / 3);
}
