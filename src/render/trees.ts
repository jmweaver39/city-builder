/**
 * Forests. Trees are full leaf-card models near the camera, simple models further
 * out and single billboards at a distance. Every tree sorts into one of the three
 * as the camera moves, so a forest costs a few hundred thousand triangles at most.
 * A coarse grid of road footprints says which trees are hidden.
 */
import * as THREE from 'three';
import type { RoadNetwork } from '../core/RoadNetwork';
import { totalHalfWidth } from '../core/roadTypes';
import { isWater, riverDistance, terrainEditDelta, terrainHeight } from '../core/terrain';
import { terrainModsFor } from '../core/terrainMods';
import type { QualitySettings } from './quality';
import type { Shared } from './materials';
import { rgb } from './style';
import { displayGround, mountainRidge } from './terrain';
import { BILLBOARD_COUNT, makeBillboardAtlas, makeLeafAtlas } from './textures';

const WORLD = 3200;
const TILE = 800;
const MASK_CELL = 4;
const MASK_SIZE = Math.ceil((2 * WORLD) / MASK_CELL);
/** Roads higher than this over the ground pass above the treetops. */
const CLEAR_OVER = 16;
/** Camera movement that triggers a re-sort. */
const RESORT_MOVE = 18;
/** How far the shadow focus may drift before trees re-sort; the shadow reach is padded by as much. */
const SHADOW_SLACK = 20;
/** Share of each level's range over which it crossfades into the next. */
const FADE_BAND = 0.14;


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

const CELL_BROAD = 0;
const CELL_NEEDLE = 1;
const CELL_BARK = 2;
const CELL_PALE_BARK = 3;

/** Leaf cards, needle sprays and bark limbs in one geometry, all on the foliage atlas. */
class Foliage {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  fol: number[] = [];
  cen: number[] = [];
  cor: number[] = [];
  idx: number[] = [];

  private v(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: number, u: number, w: number, foliage: number): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    const l = Math.hypot(nx, ny, nz) || 1;
    this.nor.push(nx / l, ny / l, nz / l);
    this.col.push(c, c, c);
    this.uv.push(u, w);
    this.fol.push(foliage);
    this.cen.push(x, y, z);
    this.cor.push(0, 0);
    return i;
  }

  /** A card centred at c, spanned by half vectors a and b, lit with normal n. */
  card(c: number[], a: number[], b: number[], n: number[], shade: number, cell: number): void {
    const u0 = cell * 0.25 + 0.004;
    const u1 = u0 + 0.242;
    const i0 = this.v(c[0] - a[0] - b[0], c[1] - a[1] - b[1], c[2] - a[2] - b[2], n[0], n[1], n[2], shade, u0, 0, 1);
    const i1 = this.v(c[0] + a[0] - b[0], c[1] + a[1] - b[1], c[2] + a[2] - b[2], n[0], n[1], n[2], shade, u1, 0, 1);
    const i2 = this.v(c[0] + a[0] + b[0], c[1] + a[1] + b[1], c[2] + a[2] + b[2], n[0], n[1], n[2], shade, u1, 1, 1);
    const i3 = this.v(c[0] - a[0] + b[0], c[1] - a[1] + b[1], c[2] - a[2] + b[2], n[0], n[1], n[2], shade, u0, 1, 1);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  /**
   * A card that turns to face the camera, so a crown never shows a card edge-on.
   * Its geometry still lies along a and b, which is what the shadow pass sees.
   */
  sprite(c: number[], a: number[], b: number[], n: number[], shade: number, cell: number, size: number, roll: number): void {
    const first = this.pos.length / 3;
    this.card(c, a, b, n, shade, cell);
    const cs = Math.cos(roll) * size;
    const sn = Math.sin(roll) * size;
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (let k = 0; k < 4; k++) {
      const [x, y] = corners[k];
      const v = first + k;
      this.cen[v * 3] = c[0];
      this.cen[v * 3 + 1] = c[1];
      this.cen[v * 3 + 2] = c[2];
      this.cor[v * 2] = x * cs - y * sn;
      this.cor[v * 2 + 1] = x * sn + y * cs;
    }
  }

  /** Tapered round limb from p to q, with bark wrapped round it. */
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
      this.v(p[0] + nx * r0, p[1] + ny * r0, p[2] + nz * r0, nx, ny, nz, 1, u, 0, 0);
      this.v(q[0] + nx * r1, q[1] + ny * r1, q[2] + nz * r1, nx, ny, nz, 1, u, Math.min(1, l / 5), 0);
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
    g.setAttribute('aFoliage', new THREE.Float32BufferAttribute(this.fol, 1));
    g.setAttribute('aCentre', new THREE.Float32BufferAttribute(this.cen, 3));
    g.setAttribute('aCorner', new THREE.Float32BufferAttribute(this.cor, 2));
    g.setIndex(this.idx);
    return g;
  }
}

interface Lobe {
  c: number[];
  r: number[];
}

/**
 * Leaf cards scattered through ellipsoid lobes. Each card's normal bends out from
 * its lobe's centre and up, so the crown lights as one soft volume and its edge
 * breaks up irregularly.
 */
function crown(f: Foliage, lobes: Lobe[], cardsPerLobe: number, size: number, seed: number, cell = CELL_BROAD): void {
  const rng = rngFrom(seed);
  for (const lobe of lobes) {
    for (let i = 0; i < cardsPerLobe; i++) {
      const y = rng() * 1.8 - 0.9;
      const ring = Math.sqrt(1 - y * y);
      const ang = rng() * Math.PI * 2;
      const nx = Math.cos(ang) * ring;
      const nz = Math.sin(ang) * ring;
      // Most cards sit near the shell, some fill the inside so it never looks hollow.
      const k = rng() < 0.75 ? 0.72 + rng() * 0.3 : 0.25 + rng() * 0.4;
      const c = [lobe.c[0] + nx * lobe.r[0] * k, lobe.c[1] + y * lobe.r[1] * k, lobe.c[2] + nz * lobe.r[2] * k];
      const roll = rng() * Math.PI * 2;
      const tx = -nz;
      const tz = nx;
      const sz = size * (0.75 + rng() * 0.6);
      const cr = Math.cos(roll) * sz;
      const sr = Math.sin(roll) * sz;
      const ax = tx * cr - nx * y * sr;
      const ay = ring * sr;
      const az = tz * cr - nz * y * sr;
      const bx = -tx * sr - nx * y * cr;
      const by = ring * cr;
      const bz = -tz * sr - nz * y * cr;
      // Inside and underneath fall into shade, so depth reads even from above.
      const shade = 0.64 + 0.36 * (y * 0.5 + 0.5) * (0.6 + 0.4 * k) + (rng() - 0.5) * 0.08;
      f.sprite(c, [ax, ay, az], [bx, by, bz], [nx, y * 0.5 + 0.6, nz], shade, cell, sz, roll);
    }
  }
}

interface TreeShape {
  near: THREE.BufferGeometry;
  mid: THREE.BufferGeometry;
}

/** Broadleaf tree: tapered trunk, branches out to each lobe, a crown of leaf cards. */
function broadleaf(lobes: Lobe[], height: number, trunkR: number, near: number, nearSize: number, bark: number, seed: number): TreeShape {
  const n = new Foliage();
  const fork = height * 0.48;
  if (trunkR > 0.08) {
    n.limb([0, -0.3, 0], [0, fork, 0], trunkR, trunkR * 0.66, 8, bark);
    for (const l of lobes) {
      const end = [l.c[0] * 0.8, l.c[1] * 0.92, l.c[2] * 0.8];
      n.limb([0, fork * 0.82, 0], end, trunkR * 0.48, trunkR * 0.14, 5, bark);
      // A twig or two off each branch, so bare patches show structure.
      n.limb([end[0] * 0.6, fork + (end[1] - fork) * 0.6, end[2] * 0.6], [end[0] * 1.1 + 0.6, end[1] + 0.8, end[2] * 1.1 - 0.4], trunkR * 0.15, trunkR * 0.05, 3, bark);
    }
  }
  crown(n, lobes, near, nearSize, seed);
  const m = new Foliage();
  if (trunkR > 0.08) m.limb([0, -0.3, 0], [0, fork, 0], trunkR, trunkR * 0.6, 5, bark);
  crown(m, lobes, Math.max(4, Math.round(near / 4)), nearSize * 2.1, seed + 9);
  return { near: n.build(), mid: m.build() };
}

/** Conifer: a straight trunk with whorls of drooping needle sprays, narrowing to the tip. */
function conifer(height: number, radius: number, trunkR: number, baseFrac: number, rows: number, seed: number): TreeShape {
  const build = (rowCount: number, perRow: number, widthScale: number, seedOff: number) => {
    const f = new Foliage();
    f.limb([0, -0.3, 0], [0, height * 0.97, 0], trunkR, 0.04, rowCount > 6 ? 8 : 5, CELL_BARK);
    const rng = rngFrom(seed + seedOff);
    for (let r = 0; r < rowCount; r++) {
      const t = r / (rowCount - 1);
      const y = height * (baseFrac + (0.95 - baseFrac) * t);
      const reach = radius * (1 - t) * (1 - t * 0.15) + 0.3;
      const count = Math.max(3, Math.round(perRow * (1 - t * 0.5)));
      const start = rng() * 6.28;
      for (let i = 0; i < count; i++) {
        const a = start + (i / count) * Math.PI * 2 + (rng() - 0.5) * 0.5;
        const dx = Math.cos(a);
        const dz = Math.sin(a);
        const droop = -0.28 - rng() * 0.22;
        const half = reach * 0.55;
        const c = [dx * half, y + droop * half, dz * half];
        const w = (0.45 + reach * 0.35) * widthScale;
        const shade = 0.62 + 0.4 * t + (rng() - 0.5) * 0.08;
        f.card(c, [-dz * w, 0, dx * w], [dx * half, droop * half, dz * half], [dx * 0.7, 0.75, dz * 0.7], shade, CELL_NEEDLE);
        // A second, flatter spray on top of each branch fills the whorl.
        if (rowCount > 6) f.card([c[0] * 0.8, c[1] + 0.25, c[2] * 0.8], [-dz * w * 0.8, 0, dx * w * 0.8], [dx * half * 0.8, -0.05 * half, dz * half * 0.8], [dx * 0.5, 0.85, dz * 0.5], shade * 1.05, CELL_NEEDLE);
      }
      // Camera-facing needle clumps fill the body, so the tree never reads as a bare
      // trunk with fins, from the side or from above.
      const clumps = rowCount > 6 ? 2 : 3;
      for (let i = 0; i < clumps; i++) {
        const a = start + (i / clumps) * Math.PI * 2 + 0.6;
        const rr = reach * 0.35;
        const sz = (0.35 + reach * 0.32) * Math.sqrt(widthScale);
        const p = [Math.cos(a) * rr, y - 0.2, Math.sin(a) * rr];
        f.sprite(p, [sz, 0, 0], [0, sz, 0], [Math.cos(a) * 0.6, 0.8, Math.sin(a) * 0.6], 0.7 + 0.35 * t, CELL_NEEDLE, sz, rng() * 6.28);
      }
    }
    // Leader at the top.
    f.card([0, height * 0.98, 0], [0.5, 0, 0], [0, 0.9, 0], [0, 1, 0], 1, CELL_NEEDLE);
    f.card([0, height * 0.98, 0], [0, 0, 0.5], [0, 0.9, 0], [0, 1, 0], 1, CELL_NEEDLE);
    return f.build();
  };
  return { near: build(rows, 7, 1, 0), mid: build(Math.max(5, Math.round(rows / 2)), 5, 1.6, 3) };
}

interface SpeciesModel extends TreeShape {
  /** Billboard quad for far away. */
  far: THREE.BufferGeometry;
  /** Foliage colour, multiplied with the pale leaf texture. */
  tint: Tint;
}

/** Quad for a distant tree, its cell of the billboard atlas, sized to the model. */
function billboard(width: number, height: number, cell: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(width, height).translate(0, height / 2 - 0.2, 0);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setX(i, (cell + uv.getX(i)) / BILLBOARD_COUNT);
  const n = uv.count;
  g.setAttribute('aFoliage', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  g.setAttribute('aCentre', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

function buildSpecies(): SpeciesModel[] {
  const lobes = (list: number[][]) => list.map(([x, y, z, rx, ry, rz]) => ({ c: [x, y, z], r: [rx, ry, rz] }));
  // Oak or plane: broad and irregular.
  const oak = broadleaf(lobes([[0, 8.4, 0, 4.2, 3.2, 4.2], [2.6, 7.3, 1.3, 2.9, 2.4, 2.9], [-2.5, 7.5, -1.5, 3, 2.5, 2.9], [0.6, 10.6, -0.6, 3, 2.3, 3], [-1, 6.6, 2.7, 2.5, 2, 2.5], [1.4, 6.8, -2.6, 2.3, 1.9, 2.3]]), 12.5, 0.42, 30, 1.0, CELL_BARK, 11);
  // Round field tree, smaller.
  const round = broadleaf(lobes([[0, 7.2, 0, 3.4, 3.4, 3.4], [1.3, 9.2, 0.6, 2.4, 2.2, 2.4], [-1.4, 6.2, -0.8, 2.5, 2.2, 2.5]]), 11.5, 0.32, 36, 0.9, CELL_BARK, 23);
  const birch = broadleaf(lobes([[0, 8.3, 0, 2.1, 3.7, 2.1], [0.5, 11, 0.3, 1.5, 2.4, 1.5], [-0.6, 6, -0.4, 1.8, 2.2, 1.8]]), 13.5, 0.16, 32, 0.72, CELL_PALE_BARK, 37);
  const poplar = broadleaf(lobes([[0, 9.5, 0, 1.8, 6.8, 1.8], [0.2, 14.6, 0.1, 1.15, 3.2, 1.15], [-0.3, 6.6, 0.2, 1.4, 2.6, 1.4]]), 18, 0.27, 42, 0.72, CELL_BARK, 41);
  const pine = conifer(16, 2.7, 0.27, 0.5, 12, 53);
  const spruce = conifer(15, 3.1, 0.26, 0.1, 14, 67);
  const bush = broadleaf(lobes([[0, 0.95, 0, 1.5, 1.05, 1.5], [0.9, 0.75, 0.4, 0.95, 0.75, 0.95], [-0.8, 0.85, -0.5, 1, 0.85, 1]]), 0.3, 0.05, 20, 0.5, CELL_BARK, 71);
  return [
    { ...oak, far: billboard(12.5, 13.5, 0), tint: rgb('leaf') },
    { ...round, far: billboard(9.5, 12.5, 1), tint: rgb('leafLight') },
    { ...birch, far: billboard(6.5, 15, 2), tint: rgb('leafLight') },
    { ...poplar, far: billboard(5, 18.5, 3), tint: rgb('leaf') },
    { ...pine, far: billboard(7, 16.5, 4), tint: rgb('pine') },
    { ...spruce, far: billboard(8, 15.5, 5), tint: rgb('pineDark') },
    { ...bush, far: billboard(4.4, 2.3, 6), tint: rgb('leaf') },
  ];
}

const FADE_GLSL = /* glsl */ `
float treeDither(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

/**
 * Foliage material. uFade holds the distances over which this level fades in
 * (x to y) and out (z to w). Fragments are dithered away, so two levels crossfade
 * without popping or sorting. Leaves sway a little in the wind.
 */
function treeMaterial(shared: Shared, map: THREE.Texture, billboardMode: boolean): THREE.MeshStandardMaterial {
  // Alpha to coverage softens the leaf and needle edges through MSAA instead of a
  // hard, crawling alpha test.
  const m = new THREE.MeshStandardMaterial({ map, alphaTest: 0.45, alphaToCoverage: true, side: THREE.DoubleSide, vertexColors: true, roughness: 0.88, metalness: 0 });
  const fade = { value: new THREE.Vector4(-1, 0, 1e9, 1e9 + 1) };
  m.userData.fade = fade;
  m.onBeforeCompile = (s) => {
    s.uniforms.uFade = fade;
    s.uniforms.uTime = shared.uTime;
    s.vertexShader = s.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nattribute float aFoliage;\nattribute vec3 aCentre;\nattribute vec2 aCorner;\nuniform float uTime;\nvarying float vFadeDist;\nvarying vec2 vCell;\n`,
      )
      .replace(
        '#include <color_vertex>',
        `vColor = vec4(1.0);\nvColor.rgb *= color.rgb;\n#ifdef USE_INSTANCING_COLOR\nvColor.rgb *= mix(vec3(1.0), instanceColor.rgb, aFoliage);\n#endif`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
vec3 treeBase = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
vFadeDist = distance(treeBase, cameraPosition);
vCell = vec2(fract(uv.x * ${BILLBOARD_COUNT.toFixed(1)}), uv.y);
bool facing = dot(aCorner, aCorner) > 0.0;
if (facing) transformed = aCentre;
// Wind: the crown sways, more towards the top; trunks stay put.
float sway = aFoliage * max(transformed.y, 0.0) * 0.011;
transformed.x += sin(uTime * 1.5 + treeBase.x * 0.13 + treeBase.z * 0.07) * sway;
transformed.z += cos(uTime * 1.2 + treeBase.z * 0.11 - treeBase.x * 0.05) * sway * 0.7;
`,
      );
    if (!billboardMode) {
      s.vertexShader = s.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
if (facing) {
  mvPosition.xy += aCorner * length(instanceMatrix[0].xyz);
  gl_Position = projectionMatrix * mvPosition;
}`,
      );
    }
    if (billboardMode) {
      s.vertexShader = s.vertexShader
        .replace(
          '#include <project_vertex>',
          /* glsl */ `
// Stand up and turn about Y to face the camera.
float wScale = length(instanceMatrix[1].xyz);
vec3 toCam = cameraPosition - treeBase;
vec3 wRight = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-5, 0.0, 0.0));
vec3 wPos = treeBase + wRight * transformed.x * length(instanceMatrix[0].xyz) + vec3(0.0, transformed.y * wScale, 0.0);
vec4 mvPosition = viewMatrix * vec4(wPos, 1.0);
gl_Position = projectionMatrix * mvPosition;
`,
        )
        .replace('#include <worldpos_vertex>', `vec4 worldPosition = vec4(wPos, 1.0);`);
    }
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec4 uFade;\nvarying float vFadeDist;\nvarying vec2 vCell;\n${FADE_GLSL}`)
      .replace(
        '#include <alphatest_fragment>',
        /* glsl */ `#include <alphatest_fragment>
{
  // Fading in keeps the pixels below the dither value, fading out the ones above,
  // so the two levels in a band fill complementary pixels and leave no holes.
  float fadeIn = smoothstep(uFade.x, uFade.y, vFadeDist);
  float fadeOut = 1.0 - smoothstep(uFade.z, uFade.w, vFadeDist);
  float dither = treeDither(gl_FragCoord.xy);
  if (dither >= fadeIn || 1.0 - dither > fadeOut) discard;
}
`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        billboardMode
          ? /* glsl */ `#include <normal_fragment_begin>
// A billboard lights like the round crown it stands for.
normal = normalize(vec3((vCell.x - 0.5) * 1.5, (vCell.y - 0.42) * 1.1, 0.7));
nonPerturbedNormal = normal;`
          : /* glsl */ `#include <normal_fragment_begin>
// Bent crown normal, eased toward the sky so shaded cards still pick up skylight
// the way thin leaves pass light through.
normal = normalize(mix(normalize(vNormal), (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz, 0.3));
nonPerturbedNormal = normal;`,
      );
  };
  m.customProgramCacheKey = () => (billboardMode ? 'cl-tree-billboard' : 'cl-tree-cards');
  return m;
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
  /** The first this many instances stand where the sun's shadow map can see them. */
  shadowCount: number;
}

export class TreeLayer {
  readonly group = new THREE.Group();
  /** Road and water footprints, 1 byte per 4 m cell. Non-zero means blocked. */
  readonly maskTexture: THREE.DataTexture;
  static readonly WORLD = WORLD;

  private species: SpeciesModel[];
  private leafMat: THREE.MeshStandardMaterial;
  private nearMat: THREE.MeshStandardMaterial;
  private midMat: THREE.MeshStandardMaterial;
  private farMat: THREE.MeshStandardMaterial;
  private atlas: THREE.Texture;
  private billboardAtlas: THREE.Texture;
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
  private shadowX = 0;
  private shadowZ = 0;
  private shadowR = Infinity;
  private deferred = new Int32Array(0);

  /** Extra blockers such as zone buildings: x, z, radius. */
  blockers: () => Iterable<{ x: number; z: number; r: number }> = () => [];

  constructor(
    private readonly net: RoadNetwork,
    anisotropy: number,
    shared: Shared,
  ) {
    this.species = buildSpecies();
    this.atlas = makeLeafAtlas(anisotropy);
    this.billboardAtlas = makeBillboardAtlas(anisotropy);
    this.nearMat = treeMaterial(shared, this.atlas, false);
    this.midMat = treeMaterial(shared, this.atlas, false);
    this.farMat = treeMaterial(shared, this.billboardAtlas, true);
    this.leafMat = this.nearMat;

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
      // Stand on the ground as drawn, and keep off the rocky ridges.
      if (mountainRidge(x, z) > 30) continue;
      const y = displayGround(x, z);
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
        if (mountainRidge(x, z) > 30) continue;
        const y = displayGround(x, z);
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
    const bucket: Bucket = { mesh, matrix: mesh.instanceMatrix.array as Float32Array, colour: mesh.instanceColor.array as Float32Array, count: 0, capacity, shadowCount: 0 };
    if (castShadow) {
      // Trees sort with those inside the shadow box first, so the shadow pass draws only them.
      let drawn = 0;
      mesh.onBeforeShadow = () => {
        drawn = mesh.count;
        mesh.count = Math.min(drawn, bucket.shadowCount);
      };
      mesh.onAfterShadow = () => {
        mesh.count = drawn;
      };
    }
    return bucket;
  }

  /**
   * Where the sun's shadow map reaches on the ground: a circle round the camera's
   * focus. Trees outside it cast nothing visible, so they are left out of the shadow pass.
   */
  setShadowReach(x: number, z: number, r: number): void {
    const moved = Math.hypot(x - this.shadowX, z - this.shadowZ);
    // Small pans keep the old circle: the margin in sort() covers them.
    if (r === this.shadowR && moved < SHADOW_SLACK) return;
    this.shadowX = x;
    this.shadowZ = z;
    this.shadowR = r;
    this.dirtySort = true;
  }

  setQuality(q: QualitySettings): void {
    this.quality = q;
    // Alpha to coverage needs MSAA and costs fill rate on dense foliage; low uses a plain alpha test.
    for (const m of [this.nearMat, this.midMat, this.farMat]) {
      if (m.alphaToCoverage !== q.treeCoverage) {
        m.alphaToCoverage = q.treeCoverage;
        m.needsUpdate = true;
      }
    }
    for (const b of [...this.near, ...this.mid, ...this.far]) {
      this.group.remove(b.mesh);
      b.mesh.dispose();
    }
    const nearCap = 1600;
    const midCap = 9000;
    this.near = this.species.map((s) => this.makeBucket(s.near, this.nearMat, nearCap, true));
    this.mid = this.species.map((s) => this.makeBucket(s.mid, this.midMat, midCap, true));
    const totals = new Array(this.species.length).fill(0);
    for (let i = 0; i < this.count; i++) totals[this.kind[i]]++;
    this.far = this.species.map((sp, k) => this.makeBucket(sp.far, this.farMat, Math.max(1, totals[k]), false));
    // Crossfade bands, where a tree is drawn at both levels and dithered between them.
    const nb = q.treeNear * FADE_BAND;
    const mb = q.treeMid * FADE_BAND;
    (this.nearMat.userData.fade.value as THREE.Vector4).set(-1, 0, q.treeNear - nb, q.treeNear);
    (this.midMat.userData.fade.value as THREE.Vector4).set(q.treeNear - nb, q.treeNear, q.treeMid - mb, q.treeMid);
    (this.farMat.userData.fade.value as THREE.Vector4).set(q.treeMid - mb, q.treeMid, 1e9, 1e9 + 1);
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
    const mods = terrainModsFor(net);
    for (const id of net.segmentsInRegion(region, true)) {
      // Embankments, walls and cuts clear their whole footprint, at any height.
      const works = mods.segments.get(id);
      if (works) {
        for (let i = 0; i + 1 < works.length; i++) {
          const a = works[i];
          const b = works[i + 1];
          const reach = Math.max(a.left?.extent ?? 0, a.right?.extent ?? 0, b.left?.extent ?? 0, b.right?.extent ?? 0, totalHalfWidth(net.roadTypeOf(id))) + 2;
          this.stampLine(a.x, a.z, b.x, b.z, reach, minX, minZ);
        }
        continue;
      }
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
      // Landscaping (core/terrainEdit.ts): trees stand on the edited land, and are
      // cleared where it floods or where a steep edit has cut or heaped the ground.
      const x = this.x[i];
      const z = this.z[i];
      const d = terrainEditDelta(x, z);
      const y = terrainHeight(x, z) - 0.05;
      if (d !== 0 || Math.abs(this.y[i] - y) > 0.01) {
        this.y[i] = y;
        const steep = Math.hypot(terrainEditDelta(x + 2, z) - terrainEditDelta(x - 2, z), terrainEditDelta(x, z + 2) - terrainEditDelta(x, z - 2)) / 4;
        if (isWater(x, z) || d < -1 || steep > 0.9) this.hidden[i] = 1;
      }
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
    const nearIn = q.treeNear * (1 - FADE_BAND);
    const midIn = q.treeMid * (1 - FADE_BAND);
    const nearIn2 = nearIn * nearIn;
    const midIn2 = midIn * midIn;
    // Fog hides trees past this, so they are not drawn at all.
    // From high up the whole map is in view, so the cutoff grows with the camera's height.
    const farR = Math.max(q.treeFar, camY * 1.7);
    const far2 = farR * farR;
    for (const set of [this.near, this.mid, this.far]) for (const b of set) b.count = 0;
    const limit = Math.floor(this.count * q.treeDensity);
    const { x, y, z, kind, hidden } = this;
    // Near and mid trees outside the shadow reach are held back and placed after the
    // rest, so each near and mid bucket starts with its shadow casters. The slack covers
    // the focus drifting between re-sorts.
    const sx = this.shadowX;
    const sz = this.shadowZ;
    const sr = this.shadowR + SHADOW_SLACK;
    const sr2 = Number.isFinite(sr) ? sr * sr : Infinity;
    if (this.deferred.length < this.count) this.deferred = new Int32Array(this.count);
    const deferred = this.deferred;
    let held = 0;
    const placeTree = (i: number, d2: number) => {
      const k = kind[i];
      const nb = this.near[k];
      const mb = this.mid[k];
      // Inside a fade band a tree goes in both levels; the shaders dither between them.
      let placed = false;
      if (d2 < near2 && nb.count < nb.capacity) {
        this.place(nb, i);
        placed = d2 < nearIn2;
      }
      if (!placed && d2 < mid2 && mb.count < mb.capacity) {
        this.place(mb, i);
        placed = d2 < midIn2;
      }
      if (!placed && d2 < far2) this.place(this.far[k], i);
    };
    for (let i = 0; i < limit; i++) {
      if (hidden[i]) continue;
      const dx = x[i] - camX;
      const dy = y[i] - camY;
      const dz = z[i] - camZ;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < mid2) {
        const ex = x[i] - sx;
        const ez = z[i] - sz;
        if (ex * ex + ez * ez >= sr2) {
          deferred[held++] = i;
          continue;
        }
      }
      placeTree(i, d2);
    }
    for (const set of [this.near, this.mid]) for (const b of set) b.shadowCount = b.count;
    for (let j = 0; j < held; j++) {
      const i = deferred[j];
      const dx = x[i] - camX;
      const dy = y[i] - camY;
      const dz = z[i] - camZ;
      placeTree(i, dx * dx + dy * dy + dz * dz);
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

  /** Returns true when the trees drawn changed, so a cached shadow map is stale. */
  update(dt: number, camX: number, camY: number, camZ: number): boolean {
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
      return true;
    }
    return false;
  }

  dispose(): void {
    for (const b of [...this.near, ...this.mid, ...this.far]) b.mesh.dispose();
    for (const s of this.species) {
      s.near.dispose();
      s.mid.dispose();
      s.far.dispose();
    }
    this.nearMat.dispose();
    this.midMat.dispose();
    this.farMat.dispose();
    this.atlas.dispose();
    this.billboardAtlas.dispose();
    this.maskTexture.dispose();
    this.group.clear();
  }
}
