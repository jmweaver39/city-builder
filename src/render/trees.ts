/**
 * Forests. Trees are full leaf-card models near the camera, simple models further
 * out and single billboards at a distance. Every tree sorts into one of the three
 * as the camera moves, so a forest costs a few hundred thousand triangles at most.
 * A coarse grid of road footprints says which trees are hidden.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { RoadNetwork } from '../core/RoadNetwork';
import { totalHalfWidth } from '../core/roadTypes';
import { isWater, riverDistance, terrainHeight } from '../core/terrain';
import type { QualitySettings } from './quality';
import { paintFacets, rgb, worldMaterial } from './style';

const WORLD = 3200;
const TILE = 800;
const MASK_CELL = 4;
const MASK_SIZE = Math.ceil((2 * WORLD) / MASK_CELL);
/** Roads higher than this over the ground pass above the treetops. */
const CLEAR_OVER = 16;
/** Camera movement that triggers a re-sort. */
const RESORT_MOVE = 18;


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

type Tint = readonly [number, number, number];

/** One faceted part of a tree. Foliage is painted pale so the instance colour sets it. */
function part(geo: THREE.BufferGeometry, colour: Tint, foliage: boolean, seed: number): THREE.BufferGeometry {
  geo.deleteAttribute('uv');
  // Smooth shaded: weld the vertices so normals average across faces.
  const welded = mergeVertices(geo.index ? geo.toNonIndexed() : geo, 1e-4);
  welded.computeVertexNormals();
  const g = paintFacets(welded, colour, foliage ? 0.05 : 0.03, seed);
  g.computeVertexNormals();
  const n = g.getAttribute('position').count;
  g.setAttribute('aFoliage', new THREE.BufferAttribute(new Float32Array(n).fill(foliage ? 1 : 0), 1));
  return g;
}

function join(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(parts, false)!;
}

const PALE: Tint = [0.95, 0.95, 0.95];

function trunk(h: number, r: number, sides: number, colour: Tint, seed: number): THREE.BufferGeometry {
  return part(new THREE.CylinderGeometry(r * 0.7, r, h, sides).translate(0, h / 2 - 0.2, 0), colour, false, seed);
}

function blob(r: number, detail: number, x: number, y: number, z: number, sy = 1, seed = 1): THREE.BufferGeometry {
  return part(new THREE.IcosahedronGeometry(r, detail).scale(1, sy, 1).translate(x, y, z), PALE, true, seed);
}

/** Eight-faced crown for distant broadleaf trees. */
function gem(r: number, y: number, sy: number, seed: number): THREE.BufferGeometry {
  return part(new THREE.OctahedronGeometry(r, 0).scale(1, sy, 1).translate(0, y, 0), PALE, true, seed);
}

function cone(r: number, h: number, sides: number, y: number, seed = 1): THREE.BufferGeometry {
  return part(new THREE.ConeGeometry(r, h, sides).translate(0, y + h / 2, 0), PALE, true, seed);
}

interface SpeciesModel {
  near: THREE.BufferGeometry;
  mid: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
  /** Foliage colour, multiplied with the pale foliage. */
  tint: Tint;
}

function buildSpecies(): SpeciesModel[] {
  const wood = rgb('trunk');
  const pale = rgb('birchTrunk');
  const oak = {
    near: join([trunk(5, 0.38, 6, wood, 1), blob(3.5, 2, 0, 7.4, 0, 0.9, 2), blob(2.4, 1, 1.9, 6.2, 1.1, 1, 3), blob(2.2, 1, -1.8, 6.5, -1, 1, 4)]),
    mid: join([trunk(5, 0.38, 4, wood, 5), blob(3.8, 1, 0, 7, 0, 0.9, 6)]),
    far: join([gem(3.8, 6.8, 1.1, 7)]),
    tint: rgb('leaf'),
  };
  const maple = {
    near: join([trunk(4.4, 0.3, 6, wood, 8), blob(3, 2, 0, 7.2, 0, 1.18, 9)]),
    mid: join([trunk(4.4, 0.3, 4, wood, 10), blob(3.1, 1, 0, 7.1, 0, 1.15, 11)]),
    far: join([gem(3.1, 7, 1.2, 12)]),
    tint: rgb('leafLight'),
  };
  const birch = {
    near: join([trunk(7, 0.17, 6, pale, 13), blob(1.8, 0, 0, 7.6, 0, 1.4, 14), blob(1.4, 0, 0.3, 10.2, 0.2, 1.3, 15)]),
    mid: join([trunk(7, 0.17, 4, pale, 16), blob(2, 0, 0, 8.6, 0, 1.8, 17)]),
    far: join([gem(2, 8.4, 2, 18)]),
    tint: rgb('leafLight'),
  };
  const poplar = {
    near: join([trunk(4, 0.25, 6, wood, 19), blob(1.9, 1, 0, 10, 0, 3.2, 20)]),
    mid: join([trunk(4, 0.25, 4, wood, 21), blob(1.9, 0, 0, 10, 0, 3.2, 22)]),
    far: join([gem(1.9, 10, 3.4, 23)]),
    tint: rgb('leaf'),
  };
  const pine = {
    near: join([trunk(3.2, 0.3, 6, wood, 24), cone(2.7, 4.4, 12, 2.2, 25), cone(2.1, 3.8, 12, 4.6, 26), cone(1.4, 3.4, 12, 7, 27)]),
    mid: join([trunk(2.6, 0.3, 4, wood, 28), cone(2.6, 8.6, 8, 2, 29)]),
    far: join([cone(2.6, 9, 3, 1.4, 30)]),
    tint: rgb('pine'),
  };
  const spruce = {
    near: join([trunk(2.4, 0.3, 6, wood, 31), cone(3.1, 7.4, 12, 1.2, 32), cone(2.1, 6, 12, 5.4, 33)]),
    mid: join([trunk(2, 0.3, 4, wood, 34), cone(3, 11.6, 8, 1, 35)]),
    far: join([cone(3, 12, 3, 0.6, 36)]),
    tint: rgb('pineDark'),
  };
  const bush = {
    near: join([blob(1.3, 1, 0, 0.9, 0, 0.8, 37), blob(0.9, 1, 0.9, 0.7, 0.4, 0.8, 38), blob(0.85, 1, -0.8, 0.75, -0.5, 0.8, 39)]),
    mid: join([blob(1.4, 1, 0, 0.9, 0, 0.75, 40)]),
    far: join([gem(1.4, 0.9, 0.75, 41)]),
    tint: rgb('leaf'),
  };
  return [oak, maple, birch, poplar, pine, spruce, bush];
}

/**
 * Distance to the nearest field boundary. Mirrors the field grid in terrain.ts,
 * where some boundaries are drawn as darker strips.
 */
function fieldEdgeDistance(x: number, z: number): number {
  const wx = 70 * (Math.sin(z * 0.0031 + 1.1) + 0.5 * Math.sin(z * 0.0083));
  const wz = 70 * (Math.cos(x * 0.0027 - 0.4) + 0.5 * Math.cos(x * 0.0071));
  const px = x + wx * 0.4;
  const pz = z + wz * 0.4;
  const l = Math.hypot(1, 0.58);
  const fx = 1 / l;
  const fz = 0.58 / l;
  const u = (px * fx + pz * fz) / 260;
  const v = (px * -fz + pz * fx) / 190;
  const cu = Math.floor(u);
  const cv = Math.floor(v);
  const h = Math.sin(cu * 41.3 + cv * 289.1) * 43758.5453;
  const pick = h - Math.floor(h);
  // Only boundaries the ground actually darkens get hedges.
  if ((pick * 7) % 1 < 0.3) return Infinity;
  const du = Math.abs(u - cu - 0.5) * 260;
  const dv = Math.abs(v - cv - 0.5) * 190;
  return Math.min(130 - du, 95 - dv);
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

export class TreeLayer {
  readonly group = new THREE.Group();
  /** Road and water footprints, 1 byte per 4 m cell. Non-zero means blocked. */
  readonly maskTexture: THREE.DataTexture;
  static readonly WORLD = WORLD;

  private species: SpeciesModel[];
  private leafMat: THREE.MeshStandardMaterial;
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
    void anisotropy;
    this.species = buildSpecies();
    this.leafMat = worldMaterial({ vertexColors: true, roughness: 0.9 });
    // Instance colour tints the foliage only, so trunks keep their own colour.
    this.leafMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\nattribute float aFoliage;`)
        .replace(
          '#include <color_vertex>',
          `vColor = vec4(1.0);\nvColor.rgb *= color.rgb;\n#ifdef USE_INSTANCING_COLOR\nvColor.rgb *= mix(vec3(1.0), instanceColor.rgb, aFoliage);\n#endif`,
        );
    };
    this.leafMat.customProgramCacheKey = () => 'cl-tree-smooth';
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
    const tries = 150000;
    for (let i = 0; i < tries; i++) {
      const x = (rng() * 2 - 1) * WORLD;
      const z = (rng() * 2 - 1) * WORLD;
      const d = forestDensity(x, z);
      const inMap = Math.abs(x) < 2000 && Math.abs(z) < 2000;
      const threshold = inMap ? 0.06 : 0;
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
      const s = kind === 6 ? 0.55 + rng() * 0.5 : 0.52 + rng() * 0.38;
      const shade = 0.82 + rng() * 0.36;
      const warm = rng();
      rows.push(x, y - 0.05, z, s, rng() * Math.PI * 2, kind, shade, warm);
    }
    // Loose clusters of round trees and bushes across the open country, as well as the groves.
    for (let c = 0; c < 9000; c++) {
      const cx = (rng() * 2 - 1) * WORLD;
      const cz = (rng() * 2 - 1) * WORLD;
      const inMap = Math.abs(cx) < 2000 && Math.abs(cz) < 2000;
      if (!inMap && rng() > 0.35) continue;
      const count = 2 + Math.floor(rng() * rng() * 10);
      const spread = 3 + count * 1.3;
      for (let k = 0; k < count; k++) {
        const x = cx + (rng() * 2 - 1) * spread;
        const z = cz + (rng() * 2 - 1) * spread;
        if (isWater(x, z) || riverDistance(x, z) < 42) continue;
        const y = terrainHeight(x, z);
        if (y > 520) continue;
        const kind = rng() < 0.35 ? 6 : rng() < 0.75 ? 0 : rng() < 0.6 ? 1 : 4;
        const s = kind === 6 ? 0.6 + rng() * 0.5 : 0.48 + rng() * 0.32;
        rows.push(x, y - 0.05, z, s, rng() * Math.PI * 2, kind, 0.86 + rng() * 0.28, rng());
      }
    }
    // Hedgerows: trees strung along the field boundaries the ground shader draws.
    for (let i = 0; i < 60000; i++) {
      const x = (rng() * 2 - 1) * 2100;
      const z = (rng() * 2 - 1) * 2100;
      if (fieldEdgeDistance(x, z) > 2.2 || rng() > 0.55) continue;
      if (isWater(x, z) || riverDistance(x, z) < 42) continue;
      const kind = rng() < 0.45 ? 6 : 0;
      rows.push(x, terrainHeight(x, z) - 0.05, z, kind === 6 ? 0.7 + rng() * 0.5 : 0.45 + rng() * 0.3, rng() * Math.PI * 2, kind, 0.86 + rng() * 0.28, rng());
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
      // A few maples turn: the rest vary a little in shade.
      const autumn = kind === 1 && warm > 0.82 ? rgb('leafAutumn') : tint;
      this.colR[i] = autumn[0] * shade;
      this.colG[i] = autumn[1] * shade;
      this.colB[i] = autumn[2] * shade;
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
    this.far = this.species.map((sp, k) => this.makeBucket(sp.far, this.leafMat, Math.max(1, totals[k]), false));
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
    // Fog hides trees past this, so they are not drawn at all.
    // From high up the whole map is in view, so the cutoff grows with the camera's height.
    const farR = Math.max(q.treeFar, camY * 1.7);
    const far2 = farR * farR;
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
      else if (d2 < far2) this.place(this.far[k], i);
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
      s.far.dispose();
    }
    this.leafMat.dispose();
    this.maskTexture.dispose();
    this.group.clear();
  }
}
