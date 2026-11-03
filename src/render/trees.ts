/**
 * Forests. Trees are full leaf-card models near the camera, simple models further
 * out and single billboards at a distance. Every tree sorts into one of the three
 * as the camera moves, so a forest costs a few hundred thousand triangles at most.
 * A coarse grid of road footprints says which trees are hidden.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { RoadNetwork } from '../core/RoadNetwork';
import { totalHalfWidth } from '../core/roadTypes';
import { isWater, riverDistance, terrainHeight } from '../core/terrain';
import { keepNormals } from './materials';
import type { QualitySettings } from './quality';
import { makeBillboardAtlas, makeLeafAtlas, BILLBOARD_COUNT } from './textures';

const WORLD = 3200;
const TILE = 800;
const MASK_CELL = 4;
const MASK_SIZE = Math.ceil((2 * WORLD) / MASK_CELL);
/** Roads higher than this over the ground pass above the treetops. */
const CLEAR_OVER = 16;
/** Camera movement that triggers a re-sort. */
const RESORT_MOVE = 18;

const CELL_BROAD = 0;
const CELL_NEEDLE = 1;
const CELL_BARK = 2;
const CELL_PALE_BARK = 3;

function rngFrom(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Foliage {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  idx: number[] = [];

  private v(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: number, u: number, w: number): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    const l = Math.hypot(nx, ny, nz) || 1;
    this.nor.push(nx / l, ny / l, nz / l);
    this.col.push(c, c, c);
    this.uv.push(u, w);
    return i;
  }

  /** A card centred at c, spanned by half vectors a and b. */
  card(c: number[], a: number[], b: number[], n: number[], shade: number, cell: number): void {
    const u0 = cell * 0.25;
    const u1 = u0 + 0.25;
    const i0 = this.v(c[0] - a[0] - b[0], c[1] - a[1] - b[1], c[2] - a[2] - b[2], n[0], n[1], n[2], shade, u0, 0);
    const i1 = this.v(c[0] + a[0] - b[0], c[1] + a[1] - b[1], c[2] + a[2] - b[2], n[0], n[1], n[2], shade, u1, 0);
    const i2 = this.v(c[0] + a[0] + b[0], c[1] + a[1] + b[1], c[2] + a[2] + b[2], n[0], n[1], n[2], shade, u1, 1);
    const i3 = this.v(c[0] - a[0] + b[0], c[1] - a[1] + b[1], c[2] - a[2] + b[2], n[0], n[1], n[2], shade, u0, 1);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  /** Tapered prism from p to q. */
  limb(p: number[], q: number[], r0: number, r1: number, sides: number, cell: number): void {
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    const t = [d[0] / l, d[1] / l, d[2] / l];
    const ref = Math.abs(t[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const a = [t[1] * ref[2] - t[2] * ref[1], t[2] * ref[0] - t[0] * ref[2], t[0] * ref[1] - t[1] * ref[0]];
    const al = Math.hypot(a[0], a[1], a[2]) || 1;
    a[0] /= al;
    a[1] /= al;
    a[2] /= al;
    const b = [t[1] * a[2] - t[2] * a[1], t[2] * a[0] - t[0] * a[2], t[0] * a[1] - t[1] * a[0]];
    const base = this.pos.length / 3;
    const u0 = cell * 0.25 + 0.01;
    for (let i = 0; i <= sides; i++) {
      const ang = (i / sides) * Math.PI * 2;
      const nx = a[0] * Math.cos(ang) + b[0] * Math.sin(ang);
      const ny = a[1] * Math.cos(ang) + b[1] * Math.sin(ang);
      const nz = a[2] * Math.cos(ang) + b[2] * Math.sin(ang);
      const u = u0 + (i / sides) * 0.23;
      this.v(p[0] + nx * r0, p[1] + ny * r0, p[2] + nz * r0, nx, ny, nz, 1, u, 0);
      this.v(q[0] + nx * r1, q[1] + ny * r1, q[2] + nz * r1, nx, ny, nz, 1, u, Math.min(1, l / 6));
    }
    for (let i = 0; i < sides; i++) {
      const v = base + i * 2;
      this.idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    return g;
  }
}

interface Lobe {
  c: number[];
  r: number[];
}

/** Leaf cards scattered over a set of ellipsoids. */
function crown(f: Foliage, lobes: Lobe[], cardsPerLobe: number, size: number, seed: number): void {
  const rng = rngFrom(seed);
  for (const lobe of lobes) {
    for (let i = 0; i < cardsPerLobe; i++) {
      // Point on the shell, kept off the very top and bottom poles.
      const y = rng() * 1.7 - 0.85;
      const ring = Math.sqrt(1 - y * y);
      const a = rng() * Math.PI * 2;
      const nx = Math.cos(a) * ring;
      const nz = Math.sin(a) * ring;
      const k = 0.68 + rng() * 0.32;
      const c = [lobe.c[0] + nx * lobe.r[0] * k, lobe.c[1] + y * lobe.r[1] * k, lobe.c[2] + nz * lobe.r[2] * k];
      const roll = rng() * Math.PI * 2;
      // Card lies across the outward direction, with some random tilt.
      const tx = -nz;
      const tz = nx;
      const s = size * (0.8 + rng() * 0.5);
      const cr = Math.cos(roll) * s;
      const sr = Math.sin(roll) * s;
      const ax = tx * cr - nx * y * sr;
      const ay = ring * sr;
      const az = tz * cr - nz * y * sr;
      const bx = -tx * sr - nx * y * cr;
      const by = ring * cr;
      const bz = -tz * sr - nz * y * cr;
      // Underside and inside of the crown fall into shade.
      const shade = 0.62 + 0.42 * (y * 0.5 + 0.5) * (0.7 + 0.3 * k) + (rng() - 0.5) * 0.1;
      f.card(c, [ax, ay, az], [bx, by, bz], [nx, y * 0.8 + 0.35, nz], shade, CELL_BROAD);
    }
  }
}

function broadleaf(lobes: Lobe[], height: number, trunkR: number, near: number, nearSize: number, bark: number, seed: number): { near: THREE.BufferGeometry; mid: THREE.BufferGeometry } {
  const n = new Foliage();
  const fork = height * 0.5;
  n.limb([0, -0.3, 0], [0, fork, 0], trunkR, trunkR * 0.68, 7, bark);
  const rng = rngFrom(seed + 5);
  for (const l of lobes) n.limb([0, fork * 0.8, 0], [l.c[0] * 0.75, l.c[1] * 0.9, l.c[2] * 0.75], trunkR * 0.5, trunkR * 0.16, 4, bark);
  void rng;
  crown(n, lobes, near, nearSize, seed);
  const m = new Foliage();
  m.limb([0, -0.3, 0], [0, fork, 0], trunkR, trunkR * 0.6, 4, bark);
  crown(m, lobes, Math.max(3, Math.round(near / 7)), nearSize * 2.7, seed + 9);
  return { near: n.build(), mid: m.build() };
}

function conifer(height: number, radius: number, trunkR: number, baseFrac: number, seed: number): { near: THREE.BufferGeometry; mid: THREE.BufferGeometry } {
  const n = new Foliage();
  n.limb([0, -0.3, 0], [0, height * 0.96, 0], trunkR, 0.03, 7, CELL_BARK);
  const rng = rngFrom(seed);
  const rows = 11;
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const y = height * (baseFrac + (0.96 - baseFrac) * t);
    const reach = radius * (1 - t) * (1 - t * 0.2) + 0.25;
    const count = Math.max(3, Math.round(7 - t * 3));
    const start = rng() * 6.28;
    for (let i = 0; i < count; i++) {
      const a = start + (i / count) * Math.PI * 2 + (rng() - 0.5) * 0.4;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const droop = -0.32 - rng() * 0.2;
      const half = reach * 0.55;
      const c = [dx * half, y + droop * half, dz * half];
      const w = 0.42 + reach * 0.33;
      const shade = 0.72 + 0.34 * t + (rng() - 0.5) * 0.1;
      n.card(c, [-dz * w, 0, dx * w], [dx * half, droop * half, dz * half], [dx * 0.6, 0.8, dz * 0.6], shade, CELL_NEEDLE);
    }
  }
  const parts: THREE.BufferGeometry[] = [];
  const tiers = 4;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const y0 = height * (baseFrac + (1 - baseFrac) * t * 0.82);
    const h = height * (1 - baseFrac) * 0.42;
    const r = radius * (1 - t) * 0.95 + 0.2;
    const cone = new THREE.ConeGeometry(r, h, 6, 1, true).translate(0, y0 + h / 2, 0);
    const count = cone.getAttribute('position').count;
    const col = new Float32Array(count * 3).fill(0.66 + t * 0.3);
    cone.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const uv = cone.getAttribute('uv') as THREE.BufferAttribute;
    // All in the solid middle of the needle cell, so alpha test keeps the whole cone.
    for (let k = 0; k < uv.count; k++) uv.setXY(k, CELL_NEEDLE * 0.25 + 0.125, 0.5);
    parts.push(cone);
  }
  const trunkMid = new Foliage();
  trunkMid.limb([0, -0.3, 0], [0, height * baseFrac + 1, 0], trunkR, trunkR * 0.7, 4, CELL_BARK);
  parts.push(trunkMid.build());
  const flat = parts.map((p) => (p.index ? p : p));
  const mid = mergeGeometries(flat, false)!;
  return { near: n.build(), mid };
}

interface SpeciesModel {
  near: THREE.BufferGeometry;
  mid: THREE.BufferGeometry;
  /** Height at unit scale, sets the billboard size. */
  height: number;
  width: number;
  /** Cell in the billboard atlas. */
  cell: number;
  /** Base foliage colour. */
  tint: [number, number, number];
}

function buildSpecies(): SpeciesModel[] {
  const lobes = (list: number[][]) => list.map(([x, y, z, rx, ry, rz]) => ({ c: [x, y, z], r: [rx, ry, rz] }));
  const oak = broadleaf(lobes([[0, 8.6, 0, 4.6, 3.6, 4.6], [2.7, 7.4, 1.4, 3, 2.6, 3], [-2.6, 7.6, -1.6, 3.1, 2.7, 3], [0.6, 11.2, -0.6, 3.2, 2.5, 3.2], [-1, 6.6, 2.8, 2.6, 2.1, 2.6]]), 13, 0.42, 16, 1.2, CELL_BARK, 11);
  const maple = broadleaf(lobes([[0, 7.6, 0, 3.5, 4.4, 3.5], [1.4, 9.8, 0.7, 2.5, 2.7, 2.5], [-1.5, 6.2, -0.8, 2.6, 2.4, 2.6]]), 12.5, 0.3, 22, 1.05, CELL_BARK, 23);
  const birch = broadleaf(lobes([[0, 8.3, 0, 2.2, 3.9, 2.2], [0.5, 11.2, 0.3, 1.6, 2.5, 1.6], [-0.6, 6, -0.4, 1.9, 2.3, 1.9]]), 13.5, 0.15, 22, 0.8, CELL_PALE_BARK, 37);
  const poplar = broadleaf(lobes([[0, 9.5, 0, 1.8, 7.2, 1.8], [0.2, 14.8, 0.1, 1.1, 3.3, 1.1]]), 18, 0.26, 38, 0.8, CELL_BARK, 41);
  const pine = conifer(16, 2.6, 0.26, 0.56, 53);
  const spruce = conifer(15, 3, 0.25, 0.12, 67);
  const bush = broadleaf(lobes([[0, 0.9, 0, 1.5, 1.05, 1.5], [0.9, 0.7, 0.4, 0.9, 0.75, 0.9], [-0.8, 0.8, -0.5, 1, 0.85, 1]]), 0.3, 0.05, 12, 0.5, CELL_BARK, 71);
  return [
    { ...oak, height: 15, width: 13, cell: 0, tint: [0.095, 0.165, 0.042] },
    { ...maple, height: 14, width: 9.5, cell: 1, tint: [0.13, 0.19, 0.045] },
    { ...birch, height: 15, width: 6.5, cell: 2, tint: [0.16, 0.21, 0.06] },
    { ...poplar, height: 19, width: 5, cell: 3, tint: [0.09, 0.15, 0.05] },
    { ...pine, height: 16, width: 7, cell: 4, tint: [0.05, 0.1, 0.05] },
    { ...spruce, height: 15, width: 8, cell: 5, tint: [0.04, 0.085, 0.05] },
    { ...bush, height: 2.2, width: 4.4, cell: 6, tint: [0.1, 0.16, 0.05] },
  ];
}

function sinNoise(x: number, z: number): number {
  return (
    Math.sin(x * 0.0041 + 1.3) * Math.cos(z * 0.0037 - 0.7) +
    0.6 * Math.sin(x * 0.0096 - z * 0.0083 + 2.2) +
    0.4 * Math.cos(x * 0.0211 + z * 0.0173 + 0.4)
  );
}

/**
 * Forest density from -1 to 1. Positive inside a clump. The domain is warped so
 * the sine waves underneath do not line up into a lattice. Mirrored in terrain.ts.
 */
function forestDensity(x: number, z: number): number {
  const wx = x + 260 * Math.sin(z * 0.0013 + 0.7) + 120 * Math.sin(z * 0.0041 + 2.1);
  const wz = z + 260 * Math.cos(x * 0.0011 - 0.4) + 120 * Math.cos(x * 0.0037 + 1.3);
  return sinNoise(wx, wz) / 2;
}

interface Bucket {
  mesh: THREE.InstancedMesh;
  matrix: Float32Array;
  colour: Float32Array;
  count: number;
  capacity: number;
}

function billboardPatch(m: THREE.MeshStandardMaterial, atlasCells: number): void {
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */ `
// Stand up and turn about Y to face the camera.
vec3 wCentre = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
float wScale = length(instanceMatrix[1].xyz);
vec3 toCam = cameraPosition - wCentre;
vec3 wRight = normalize(vec3(toCam.z, 0.0, -toCam.x));
vec3 wPos = wCentre + wRight * transformed.x * length(instanceMatrix[0].xyz) + vec3(0.0, transformed.y * wScale, 0.0);
vec4 mvPosition = viewMatrix * vec4(wPos, 1.0);
gl_Position = projectionMatrix * mvPosition;
`,
    );
    s.vertexShader = s.vertexShader.replace(
      '#include <worldpos_vertex>',
      `vec4 worldPosition = vec4(wPos, 1.0);`,
    );
    s.vertexShader = s.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `vec3 objectNormal = vec3(0.0, 1.0, 0.0);`,
    );
    s.fragmentShader = keepNormals(s.fragmentShader);
  };
  m.customProgramCacheKey = () => `cl-billboard-${atlasCells}`;
}

export class TreeLayer {
  readonly group = new THREE.Group();
  /** Road and water footprints, 1 byte per 4 m cell. Non-zero means blocked. */
  readonly maskTexture: THREE.DataTexture;
  static readonly WORLD = WORLD;

  private species: SpeciesModel[];
  private leafAtlas: THREE.Texture;
  private billboardAtlas: THREE.Texture;
  private leafMat: THREE.MeshStandardMaterial;
  private billboardMat: THREE.MeshStandardMaterial;
  private billboardGeo: THREE.BufferGeometry[] = [];
  private near: Bucket[] = [];
  private mid: Bucket[] = [];
  private far: Bucket[] = [];

  // One entry per tree. Random order, so a density cut takes a fair sample.
  private count = 0;
  private x!: Float32Array;
  private y!: Float32Array;
  private z!: Float32Array;
  private scale!: Float32Array;
  private rot!: Float32Array;
  private colR!: Float32Array;
  private colG!: Float32Array;
  private colB!: Float32Array;
  private kind!: Uint8Array;
  private hidden!: Uint8Array;
  private tileTrees = new Map<number, number[]>();
  private stale = new Set<number>();
  private staleTimer = 0;

  private mask = new Uint8Array(MASK_SIZE * MASK_SIZE);
  private quality: QualitySettings | null = null;
  private lastX = Infinity;
  private lastZ = Infinity;
  private lastY = Infinity;
  private dirtySort = true;

  /** Extra blockers such as zone buildings: x, z, radius. */
  blockers: () => Iterable<{ x: number; z: number; r: number }> = () => [];

  constructor(
    private readonly net: RoadNetwork,
    anisotropy: number,
  ) {
    this.species = buildSpecies();
    this.leafAtlas = makeLeafAtlas(anisotropy);
    this.billboardAtlas = makeBillboardAtlas(anisotropy);
    this.leafMat = new THREE.MeshStandardMaterial({ map: this.leafAtlas, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true, roughness: 0.78, metalness: 0 });
    this.billboardMat = new THREE.MeshStandardMaterial({ map: this.billboardAtlas, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
    billboardPatch(this.billboardMat, BILLBOARD_COUNT);
    this.leafMat.onBeforeCompile = (sh) => {
      sh.fragmentShader = keepNormals(sh.fragmentShader);
    };
    this.leafMat.customProgramCacheKey = () => 'cl-leaf';
    this.species.forEach((sp) => {
      const q = new THREE.PlaneGeometry(sp.width, sp.height).translate(0, sp.height / 2 - 0.15, 0);
      const uv = q.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, (sp.cell + uv.getX(i)) / BILLBOARD_COUNT);
      this.billboardGeo.push(q);
    });
    this.scatter();
    this.rasteriseWater();
    this.maskTexture = new THREE.DataTexture(this.mask, MASK_SIZE, MASK_SIZE, THREE.RedFormat, THREE.UnsignedByteType);
    this.maskTexture.minFilter = THREE.LinearFilter;
    this.maskTexture.magFilter = THREE.LinearFilter;
    this.maskTexture.needsUpdate = true;
    this.markAll();
  }

  private scatter(): void {
    const rng = rngFrom(7321);
    const rows: number[] = [];
    const tries = 170000;
    for (let i = 0; i < tries; i++) {
      const x = (rng() * 2 - 1) * WORLD;
      const z = (rng() * 2 - 1) * WORLD;
      const d = forestDensity(x, z);
      const inMap = Math.abs(x) < 2000 && Math.abs(z) < 2000;
      const threshold = inMap ? 0.2 : 0;
      const rim = d < threshold + 0.06;
      // Soft clump edges, with a few loners out in the open.
      if (d < threshold - 0.1 * rng() && rng() > 0.012) continue;
      if (!inMap && rng() > 0.4) continue;
      if (isWater(x, z) || riverDistance(x, z) < 42) continue;
      const y = terrainHeight(x, z);
      if (y > 520) continue;
      // Mixed woods: pine stands on one side of the map, broadleaf on the other,
      // bushes along the rims and on their own in the fields.
      const conifers = 0.45 + 0.4 * Math.sin(x * 0.0017 + z * 0.0011);
      const r = rng();
      let kind: number;
      if (rim && r < 0.32) kind = 6;
      else if (rng() < conifers) kind = rng() < 0.55 ? 4 : 5;
      else kind = r < 0.5 ? 0 : r < 0.72 ? 1 : r < 0.9 ? 2 : 3;
      const s = kind === 6 ? 0.7 + rng() * 0.8 : 0.72 + rng() * 0.62;
      const shade = 0.82 + rng() * 0.36;
      const warm = rng();
      rows.push(x, y - 0.05, z, s, rng() * Math.PI * 2, kind, shade, warm);
    }
    const n = rows.length / 8;
    this.count = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    this.scale = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.colR = new Float32Array(n);
    this.colG = new Float32Array(n);
    this.colB = new Float32Array(n);
    this.kind = new Uint8Array(n);
    this.hidden = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 8;
      this.x[i] = rows[o];
      this.y[i] = rows[o + 1];
      this.z[i] = rows[o + 2];
      this.scale[i] = rows[o + 3];
      this.rot[i] = rows[o + 4];
      const kind = rows[o + 5];
      this.kind[i] = kind;
      const tint = this.species[kind].tint;
      const shade = rows[o + 6];
      const warm = rows[o + 7];
      // Tint is applied on a mid-grey leaf texture, so scale up to compensate.
      this.colR[i] = tint[0] * 1.55 * shade * (1 + warm * 0.45);
      this.colG[i] = tint[1] * 1.75 * shade * (1 + warm * 0.1);
      this.colB[i] = tint[2] * 1.5 * shade;
      const key = this.tileOf(this.x[i], this.z[i]);
      let list = this.tileTrees.get(key);
      if (!list) this.tileTrees.set(key, (list = []));
      list.push(i);
    }
  }

  private tileOf(x: number, z: number): number {
    return Math.floor((x + WORLD) / TILE) + Math.floor((z + WORLD) / TILE) * 64;
  }

  private rasteriseWater(): void {
    // Value 2 is permanent, so a road refresh leaves water marked.
    for (let j = 0; j < MASK_SIZE; j++) {
      for (let i = 0; i < MASK_SIZE; i++) {
        const x = i * MASK_CELL - WORLD;
        const z = j * MASK_CELL - WORLD;
        if (riverDistance(x, z) < 39) this.mask[i + j * MASK_SIZE] = 2;
      }
    }
  }

  private makeBucket(geo: THREE.BufferGeometry, material: THREE.Material, capacity: number, castShadow: boolean): Bucket {
    const mesh = new THREE.InstancedMesh(geo, material, capacity);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = false;
    mesh.count = 0;
    this.group.add(mesh);
    return { mesh, matrix: mesh.instanceMatrix.array as Float32Array, colour: mesh.instanceColor.array as Float32Array, count: 0, capacity };
  }

  setQuality(q: QualitySettings): void {
    this.quality = q;
    for (const b of [...this.near, ...this.mid, ...this.far]) {
      this.group.remove(b.mesh);
      b.mesh.dispose();
    }
    const nearCap = 1600;
    const midCap = 9000;
    this.near = this.species.map((s) => this.makeBucket(s.near, this.leafMat, nearCap, true));
    this.mid = this.species.map((s) => this.makeBucket(s.mid, this.leafMat, midCap, true));
    const totals = new Array(this.species.length).fill(0);
    for (let i = 0; i < this.count; i++) totals[this.kind[i]]++;
    this.far = this.species.map((_, k) => this.makeBucket(this.billboardGeo[k], this.billboardMat, Math.max(1, totals[k]), false));
    this.dirtySort = true;
  }

  /** Total trees placed, shown or not. */
  get total(): number {
    return this.count;
  }

  /** Trees currently drawn at each level of detail. */
  counts(): { near: number; mid: number; far: number } {
    const sum = (b: Bucket[]) => b.reduce((n, x) => n + x.count, 0);
    return { near: sum(this.near), mid: sum(this.mid), far: sum(this.far) };
  }

  markAll(): void {
    for (const key of this.tileTrees.keys()) this.stale.add(key);
  }

  /** Flag tiles touching a box for refresh. */
  markRegion(minX: number, minZ: number, maxX: number, maxZ: number): void {
    const i0 = Math.max(0, Math.floor((minX - 40 + WORLD) / TILE));
    const i1 = Math.min(63, Math.floor((maxX + 40 + WORLD) / TILE));
    const j0 = Math.max(0, Math.floor((minZ - 40 + WORLD) / TILE));
    const j1 = Math.min(63, Math.floor((maxZ + 40 + WORLD) / TILE));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.stale.add(i + j * 64);
  }

  private stampLine(ax: number, az: number, bx: number, bz: number, r: number, minX: number, minZ: number): void {
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(len / 2));
    const reach = Math.ceil(r / MASK_CELL);
    const lo = (v: number) => Math.floor((v + WORLD) / MASK_CELL);
    const iMin = Math.max(0, lo(minX) - 1);
    const iMax = Math.min(MASK_SIZE - 1, lo(minX + TILE) + 1);
    const jMin = Math.max(0, lo(minZ) - 1);
    const jMax = Math.min(MASK_SIZE - 1, lo(minZ + TILE) + 1);
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const ci = lo(ax + (bx - ax) * f);
      const cj = lo(az + (bz - az) * f);
      if (ci + reach < iMin || ci - reach > iMax || cj + reach < jMin || cj - reach > jMax) continue;
      for (let j = Math.max(jMin, cj - reach); j <= Math.min(jMax, cj + reach); j++) {
        for (let i = Math.max(iMin, ci - reach); i <= Math.min(iMax, ci + reach); i++) {
          if (this.mask[i + j * MASK_SIZE] === 0) this.mask[i + j * MASK_SIZE] = 1;
        }
      }
    }
  }

  private refreshTile(key: number): void {
    const ti = key % 64;
    const tj = Math.floor(key / 64);
    const minX = ti * TILE - WORLD;
    const minZ = tj * TILE - WORLD;
    const lo = (v: number) => Math.floor((v + WORLD) / MASK_CELL);
    for (let j = Math.max(0, lo(minZ)); j <= Math.min(MASK_SIZE - 1, lo(minZ + TILE)); j++) {
      for (let i = Math.max(0, lo(minX)); i <= Math.min(MASK_SIZE - 1, lo(minX + TILE)); i++) {
        if (this.mask[i + j * MASK_SIZE] === 1) this.mask[i + j * MASK_SIZE] = 0;
      }
    }
    const net = this.net;
    const region = { minX: minX - 40, minZ: minZ - 40, maxX: minX + TILE + 40, maxZ: minZ + TILE + 40 };
    for (const id of net.segmentsInRegion(region, true)) {
      const stations = net.curveOf(id).stations;
      const r = totalHalfWidth(net.roadTypeOf(id)) + 4.5;
      for (let i = 0; i + 1 < stations.length; i++) {
        const a = stations[i].pos;
        const b = stations[i + 1].pos;
        const clear = a.y - terrainHeight(a.x, a.z);
        if (clear > CLEAR_OVER || clear < -9) continue;
        this.stampLine(a.x, a.z, b.x, b.z, r, minX, minZ);
      }
    }
    for (const b of this.blockers()) {
      if (b.x < region.minX || b.x > region.maxX || b.z < region.minZ || b.z > region.maxZ) continue;
      this.stampLine(b.x, b.z, b.x, b.z, b.r, minX, minZ);
    }
    for (const i of this.tileTrees.get(key) ?? []) {
      const ci = lo(this.x[i]);
      const cj = lo(this.z[i]);
      const inside = ci >= 0 && cj >= 0 && ci < MASK_SIZE && cj < MASK_SIZE;
      this.hidden[i] = inside && this.mask[ci + cj * MASK_SIZE] === 1 ? 1 : 0;
    }
  }

  private place(b: Bucket, i: number): void {
    const k = b.count++;
    const s = this.scale[i];
    const c = Math.cos(this.rot[i]) * s;
    const q = Math.sin(this.rot[i]) * s;
    const m = b.matrix;
    const o = k * 16;
    m[o] = c;
    m[o + 1] = 0;
    m[o + 2] = -q;
    m[o + 3] = 0;
    m[o + 4] = 0;
    m[o + 5] = s;
    m[o + 6] = 0;
    m[o + 7] = 0;
    m[o + 8] = q;
    m[o + 9] = 0;
    m[o + 10] = c;
    m[o + 11] = 0;
    m[o + 12] = this.x[i];
    m[o + 13] = this.y[i];
    m[o + 14] = this.z[i];
    m[o + 15] = 1;
    const col = b.colour;
    col[k * 3] = this.colR[i];
    col[k * 3 + 1] = this.colG[i];
    col[k * 3 + 2] = this.colB[i];
  }

  private sort(camX: number, camY: number, camZ: number): void {
    const q = this.quality;
    if (!q) return;
    const near2 = q.treeNear * q.treeNear;
    const mid2 = q.treeMid * q.treeMid;
    for (const set of [this.near, this.mid, this.far]) for (const b of set) b.count = 0;
    const limit = Math.floor(this.count * q.treeDensity);
    const { x, y, z, kind, hidden } = this;
    for (let i = 0; i < limit; i++) {
      if (hidden[i]) continue;
      const dx = x[i] - camX;
      const dy = y[i] - camY;
      const dz = z[i] - camZ;
      const d2 = dx * dx + dy * dy + dz * dz;
      const k = kind[i];
      const nb = this.near[k];
      const mb = this.mid[k];
      if (d2 < near2 && nb.count < nb.capacity) this.place(nb, i);
      else if (d2 < mid2 && mb.count < mb.capacity) this.place(mb, i);
      else this.place(this.far[k], i);
    }
    for (const set of [this.near, this.mid, this.far]) {
      for (const b of set) {
        b.mesh.count = b.count;
        b.mesh.visible = b.count > 0;
        b.mesh.instanceMatrix.clearUpdateRanges();
        b.mesh.instanceMatrix.addUpdateRange(0, b.count * 16);
        b.mesh.instanceMatrix.needsUpdate = true;
        const ic = b.mesh.instanceColor!;
        ic.clearUpdateRanges();
        ic.addUpdateRange(0, b.count * 3);
        ic.needsUpdate = true;
      }
    }
  }

  update(dt: number, camX: number, camY: number, camZ: number): void {
    this.staleTimer += dt;
    // Editing drags can dirty roads every frame, so tree work is held to a trickle.
    if (this.stale.size && (this.staleTimer > 0.1 || this.dirtySort)) {
      this.staleTimer = 0;
      let budget = this.dirtySort ? Infinity : 6;
      for (const key of this.stale) {
        if (budget-- <= 0) break;
        this.refreshTile(key);
        this.stale.delete(key);
      }
      this.maskTexture.needsUpdate = true;
      this.dirtySort = true;
    }
    const moved = Math.hypot(camX - this.lastX, camZ - this.lastZ, camY - this.lastY);
    if (moved > RESORT_MOVE || this.dirtySort) {
      this.lastX = camX;
      this.lastY = camY;
      this.lastZ = camZ;
      this.dirtySort = false;
      this.sort(camX, camY, camZ);
    }
  }

  dispose(): void {
    for (const b of [...this.near, ...this.mid, ...this.far]) b.mesh.dispose();
    for (const s of this.species) {
      s.near.dispose();
      s.mid.dispose();
    }
    for (const g of this.billboardGeo) g.dispose();
    this.leafMat.dispose();
    this.billboardMat.dispose();
    this.leafAtlas.dispose();
    this.billboardAtlas.dispose();
    this.maskTexture.dispose();
    this.group.clear();
  }
}
