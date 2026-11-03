/**
 * Ground and water. The grid is warped to follow the river, so the banks get
 * fine triangles without paying for them across the flat map.
 */
import * as THREE from 'three';
import { MAP_HALF_SIZE, RIVER_DEPTH, WATER_LEVEL, riverCentreZ, terrainHeight } from '../core/terrain';
import type { Shared } from './materials';
import { PALETTE, type PaletteKey } from './style';

/** A palette colour as a linear GLSL vec3 literal. */
function glslColour(key: PaletteKey): string {
  const c = new THREE.Color(PALETTE[key]);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
}

const EXTENT = 9000;

function stepsTo(out: number[], from: number, to: number, step: number): void {
  for (let v = from; v < to - 1e-6; v += step) out.push(v);
}

function rowOffsets(): number[] {
  const half: number[] = [];
  stepsTo(half, 0, 56, 3);
  stepsTo(half, 56, 248, 12);
  stepsTo(half, 248, 1500, 60);
  stepsTo(half, 1500, MAP_HALF_SIZE, 60);
  stepsTo(half, MAP_HALF_SIZE, 3000, 40);
  stepsTo(half, 3000, 6000, 100);
  stepsTo(half, 6000, EXTENT, 300);
  half.push(EXTENT);
  const rows = half.slice(1).reverse().map((v) => -v);
  return rows.concat(half);
}

function columnOffsets(): number[] {
  const half: number[] = [];
  stepsTo(half, 0, MAP_HALF_SIZE, 8);
  stepsTo(half, MAP_HALF_SIZE, 3000, 40);
  stepsTo(half, 3000, 6000, 100);
  stepsTo(half, 6000, EXTENT, 300);
  half.push(EXTENT);
  const cols = half.slice(1).reverse().map((v) => -v);
  return cols.concat(half);
}

/** Rows bend with the river near it and straighten by the map's edge. */
function rowZ(v: number, x: number): number {
  const a = Math.abs(v);
  if (a <= 300) return v + riverCentreZ(x);
  const f = THREE.MathUtils.smoothstep(a, 300, 1400);
  return v + riverCentreZ(x) * (1 - f);
}

/**
 * Far hills are capped on display only. terrainHeight keeps climbing with
 * distance, which would stand a fogged wall against the sky.
 */
function displayHeight(h: number): number {
  const knee = 340;
  return h <= knee ? h : knee + 260 * (1 - Math.exp(-(h - knee) / 260));
}

function buildGround(): THREE.BufferGeometry {
  const rows = rowOffsets();
  const cols = columnOffsets();
  const nx = cols.length;
  const nz = rows.length;
  const pos = new Float32Array(nx * nz * 3);
  const nor = new Float32Array(nx * nz * 3);
  const e = 2;
  let k = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = cols[i];
      const z = rowZ(rows[j], x);
      const y = displayHeight(terrainHeight(x, z));
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      const dx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
      const dz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
      const l = Math.hypot(dx, 2 * e, dz);
      nor[k * 3] = -dx / l;
      nor[k * 3 + 1] = (2 * e) / l;
      nor[k * 3 + 2] = -dz / l;
      k++;
    }
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let t = 0;
  for (let j = 0; j + 1 < nz; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const a = i + j * nx;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx[t++] = a;
      idx[t++] = c;
      idx[t++] = b;
      idx[t++] = b;
      idx[t++] = c;
      idx[t++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), EXTENT * 2);
  return geo;
}

/**
 * Terrain height in GLSL, a straight port of core/terrain.ts plus the display cap,
 * so the camera patch can be displaced on the GPU and match the base mesh.
 */
const HEIGHT_GLSL = /* glsl */ `
float tRiverZ(float x) { return 420.0 + 170.0 * sin(x / 470.0 + 0.6) + 80.0 * sin(x / 183.0 + 2.1) + 24.0 * sin(x / 71.0 + 4.2); }
float tRiverSlope(float x) { return (170.0 / 470.0) * cos(x / 470.0 + 0.6) + (80.0 / 183.0) * cos(x / 183.0 + 2.1) + (24.0 / 71.0) * cos(x / 71.0 + 4.2); }
float tHeight(vec2 p) {
  float m = tRiverSlope(p.x);
  float d = abs(p.y - tRiverZ(p.x)) / sqrt(1.0 + m * m);
  float channel = ${RIVER_DEPTH.toFixed(1)} * (smoothstep(20.0, 40.0, d) - 1.0);
  float out_ = max(abs(p.x), abs(p.y)) - ${MAP_HALF_SIZE.toFixed(1)};
  if (out_ <= 0.0) return channel;
  float rise = (out_ * out_) / (out_ + 260.0);
  float roll = 1.0 + 0.22 * sin(p.x / 310.0 + 1.3) * cos(p.y / 270.0 + 0.4) + 0.12 * sin((p.x + p.y) / 130.0 + 2.2);
  float h = channel + 0.32 * rise * roll * smoothstep(40.0, 220.0, d);
  return h <= 340.0 ? h : 340.0 + 260.0 * (1.0 - exp(-(h - 340.0) / 260.0));
}
`;

/**
 * Painted ground colour. Palette layers blended softly by large-scale fields, with
 * detail that fades in as the camera comes close and macro variation far out,
 * every scale rotated and warped so no tiling lines up.
 */
const GROUND_COLOUR_GLSL = /* glsl */ `
// Dry summer grassland seen from above: olive and khaki, dense fine speckle,
// mottled darker patches, faint field plots and diagonal boundary strips.
vec3 groundColour(vec2 p, float h, float slope, float dist) {
  vec2 warp = 70.0 * vec2(sin(p.y * 0.0031 + 1.1) + 0.5 * sin(p.y * 0.0083), cos(p.x * 0.0027 - 0.4) + 0.5 * cos(p.x * 0.0071));
  vec2 p1 = mat2(0.8, 0.6, -0.6, 0.8) * p;
  vec2 p2 = mat2(0.5, -0.866, 0.866, 0.5) * (p + warp);
  vec2 p3 = mat2(-0.28, 0.96, -0.96, -0.28) * (p + warp * 2.0);
  float macro = texture2D(uNoise, p3 / 2400.0).b;
  float broad = texture2D(uNoise, p2 / 360.0).g;
  float mott = texture2D(uNoise, p1 / 47.0).g * 0.6 + texture2D(uNoise, p2 / 140.0).g * 0.4;

  // Olive to khaki base, drifting slowly over the map.
  vec3 c = mix(${glslColour('grass')}, ${glslColour('grassLight')}, smoothstep(0.3, 0.7, macro * 0.7 + broad * 0.3));
  c = mix(c, ${glslColour('grassDark')}, smoothstep(0.55, 0.25, broad) * 0.5);

  // Field plots on a skewed grid, some a shade tan, some a shade greener, with a
  // faint line along their edges like an old boundary or drainage ditch.
  vec2 fdir = normalize(vec2(1.0, 0.58));
  vec2 fq = vec2(dot(p + warp * 0.4, fdir), dot(p + warp * 0.4, vec2(-fdir.y, fdir.x))) / vec2(260.0, 190.0);
  vec2 cell = floor(fq);
  float pick = fract(sin(dot(cell, vec2(41.3, 289.1))) * 43758.5453);
  vec2 inCell = abs(fract(fq) - 0.5) * vec2(260.0, 190.0);
  float edgeDist = min(130.0 - inCell.x, 95.0 - inCell.y);
  float plot = smoothstep(0.0, 6.0, edgeDist);
  // Fields read up close and fade from map height, so the grid never shows as a lattice.
  float fieldFade = 1.0 - smoothstep(900.0, 2600.0, dist);
  c = mix(c, ${glslColour('fieldTan')}, step(0.72, pick) * plot * 0.45 * fieldFade);
  c = mix(c, ${glslColour('grassDark')}, step(pick, 0.14) * plot * 0.3 * fieldFade);
  float strip = 1.0 - smoothstep(0.8, 3.2, edgeDist);
  c = mix(c, ${glslColour('groundPatch')} * 0.82, strip * step(0.3, fract(pick * 7.0)) * 0.7 * fieldFade);

  // Mottled darker green patches with soft, ragged edges.
  float patchy = smoothstep(0.64, 0.74, mott + (texture2D(uDetail, p / 31.0).b - 0.5) * 0.22);
  c = mix(c, ${glslColour('groundPatch')}, patchy * 0.45);
  // Low scrub: small dark dots, denser in the patches, scattered thinly elsewhere.
  float scrub = texture2D(uDetail, p1 / 23.0).b * 0.65 + texture2D(uDetail, p2 / 7.0).b * 0.35;
  float dots = smoothstep(0.66 - patchy * 0.12, 0.72 - patchy * 0.12, scrub);
  c = mix(c, ${glslColour('groundPatch')} * 0.78, dots * 0.6);

  // Forest floor, under the same density field the trees use.
  vec2 fw = vec2(p.x + 260.0 * sin(p.y * 0.0013 + 0.7) + 120.0 * sin(p.y * 0.0041 + 2.1), p.y + 260.0 * cos(p.x * 0.0011 - 0.4) + 120.0 * cos(p.x * 0.0037 + 1.3));
  float forest = (sin(fw.x * 0.0041 + 1.3) * cos(fw.y * 0.0037 - 0.7) + 0.6 * sin(fw.x * 0.0096 - fw.y * 0.0083 + 2.2) + 0.4 * cos(fw.x * 0.0211 + fw.y * 0.0173 + 0.4)) * 0.5;
  float inMap = step(max(abs(p.x), abs(p.y)), MAP_EDGE);
  float fe = mix(0.02, 0.08, inMap);
  c = mix(c, ${glslColour('groundPatch')} * 0.92, smoothstep(fe - 0.05, fe + 0.08, forest) * 0.55);

  // Speckle: three octaves of the high-resolution detail, each fading in as it
  // becomes resolvable, so it stays crisp and never shows its repeat.
  // Coarse octaves keep a grain at map zoom; fine ones take over as the camera nears.
  float sA = texture2D(uDetail, p3 / 610.0).r;
  float sB = texture2D(uDetail, p2 / 160.0).r;
  float s0 = texture2D(uDetail, p1 / 37.0).r;
  float s1 = texture2D(uDetail, p / 9.5).r;
  float s2 = texture2D(uDetail, p2 / 2.6).r;
  float w0 = 1.0 - smoothstep(250.0, 900.0, dist);
  float w1 = 1.0 - smoothstep(60.0, 320.0, dist);
  float w2 = 1.0 - smoothstep(12.0, 70.0, dist);
  float speck = (sA - 0.5) * 0.9 + (sB - 0.5) * 0.9 + (s0 - 0.5) * 0.9 * w0 + (s1 - 0.5) * 0.8 * w1 + (s2 - 0.5) * 0.7 * w2;
  c *= 1.0 + speck * 0.36;

  // Banks: pale dry sand, then a blue-grey bed under the shallows.
  float wob = (s0 - 0.5) * 0.4 + (mott - 0.5) * 0.3;
  c = mix(c, ${glslColour('sand')}, 1.0 - smoothstep(-0.9 + wob, -0.15 + wob, h));
  c = mix(c, mix(${glslColour('sand')}, ${glslColour('water')}, 0.55), 1.0 - smoothstep(-3.2, -2.3, h));
  // Hills past the map: the same grassland, darker, with rock on slopes and peaks.
  float hill = smoothstep(2.0, 40.0, h);
  c = mix(c, ${glslColour('hill')} * (0.95 + 0.1 * broad), hill * 0.6);
  float rock = smoothstep(0.22, 0.4, slope + (mott - 0.5) * 0.1) * hill + smoothstep(240.0, 360.0, h + (broad - 0.5) * 80.0);
  c = mix(c, mix(${glslColour('rock')}, ${glslColour('rockDark')}, mott), clamp(rock, 0.0, 1.0));
  return c;
}
`;

/**
 * Ground material. With `patch` set, the mesh is the camera-following high
 * resolution grid, displaced on the GPU. Without it, it is the base mesh, which
 * leaves a hole where the patch draws.
 */
function groundMaterial(shared: Shared, patch: boolean, patchRect: { value: THREE.Vector4 }, patchOrigin: { value: THREE.Vector2 }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  m.stencilWrite = true;
  m.stencilFunc = THREE.NotEqualStencilFunc;
  m.stencilRef = 1;
  m.stencilZPass = THREE.KeepStencilOp;
  m.onBeforeCompile = (s) => {
    s.uniforms.uNoise = shared.uNoise;
    s.uniforms.uDetail = shared.uDetail;
    s.uniforms.uDim = shared.uDim;
    s.uniforms.uUnder = shared.uUnder;
    s.uniforms.uPatchRect = patchRect;
    s.uniforms.uPatchOrigin = patchOrigin;
    s.vertexShader = s.vertexShader.replace(
      '#include <common>',
      `#include <common>\nvarying vec3 vWorld;\nvarying float vSlope;\nuniform vec2 uPatchOrigin;\n${HEIGHT_GLSL}`,
    );
    if (patch) {
      s.vertexShader = s.vertexShader
        .replace(
          '#include <beginnormal_vertex>',
          /* glsl */ `
vec2 gp = position.xz + uPatchOrigin;
float gh = tHeight(gp);
float ge = 0.6;
vec3 objectNormal = normalize(vec3(tHeight(gp - vec2(ge, 0.0)) - tHeight(gp + vec2(ge, 0.0)), 2.0 * ge, tHeight(gp - vec2(0.0, ge)) - tHeight(gp + vec2(0.0, ge))));
`,
        )
        .replace('#include <begin_vertex>', `vec3 transformed = vec3(gp.x, gh, gp.y);\nvWorld = transformed;\nvSlope = 1.0 - objectNormal.y;`);
    } else {
      s.vertexShader = s.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\nvWorld = position;\nvSlope = 1.0 - normal.y;`);
    }
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform sampler2D uNoise;
uniform sampler2D uDetail;
uniform float uDim;
uniform float uUnder;
uniform vec4 uPatchRect;
varying vec3 vWorld;
varying float vSlope;
const float MAP_EDGE = ${MAP_HALF_SIZE.toFixed(1)};
${GROUND_COLOUR_GLSL}
`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
{
  ${patch ? '' : 'if (vWorld.x > uPatchRect.x && vWorld.x < uPatchRect.z && vWorld.z > uPatchRect.y && vWorld.z < uPatchRect.w) discard;'}
  vec3 c = groundColour(vWorld.xz, vWorld.y, vSlope, length(vViewPosition));
  float out_ = max(abs(vWorld.x), abs(vWorld.z)) - MAP_EDGE;
  if (out_ > 0.0) c *= 0.95;
  float w = max(fwidth(out_) * 1.2, 1.0);
  c = mix(c, vec3(0.9), (1.0 - smoothstep(w * 0.5, w * 1.5, abs(out_))) * 0.2);
  if (uDim > 0.0) {
    float l = dot(c, vec3(0.3, 0.6, 0.1));
    c = mix(c, vec3(l) * 0.75 + vec3(0.02, 0.025, 0.03), uDim);
  }
  if (uUnder > 0.5) c = vec3(dot(c, vec3(0.3, 0.6, 0.1))) * vec3(0.5, 0.62, 0.8);
  diffuseColor.rgb = c;
}
`,
      );
  };
  m.customProgramCacheKey = () => (patch ? 'cl-ground-patch-hc' : 'cl-ground-base-hc');
  return m;
}

const WATER_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute float aEdge;
uniform float uTime;
varying vec3 vWorld;
varying float vEdge;
void main() {
  vEdge = aEdge;
  vec3 p = position;
  // Slow swell, so the facets catch the light in turn.
  vWorld = p;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const WATER_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform sampler2D uNoise;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSkyCol;
uniform vec3 uSkyTop;
uniform vec3 uSunCol;
uniform vec3 uSunDir;
uniform vec3 uFoam;
uniform float uOpacity;
varying vec3 vWorld;
varying float vEdge;
void main() {
  #include <logdepthbuf_fragment>
  vec2 ra = texture2D(uNoise, vWorld.xz / 30.0 + vec2(uTime * 0.01, uTime * 0.006)).rg;
  vec2 rb = texture2D(uNoise, vWorld.xz / 9.0 + vec2(-uTime * 0.016, uTime * 0.012)).rg;
  vec3 n = normalize(vec3((ra.x - 0.5) * 0.12 + (rb.x - 0.5) * 0.08, 1.0, (ra.y - 0.5) * 0.12 + (rb.y - 0.5) * 0.08));
  vec3 v = normalize(cameraPosition - vWorld);
  float fromShore = 30.0 - (1.0 - vEdge) * 42.0;
  vec3 col = mix(uShallow, uDeep, smoothstep(2.0, 18.0, fromShore));
  float diffuse = 0.62 + 0.38 * max(dot(n, uSunDir), 0.0);
  col *= diffuse;
  float fres = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0);
  col = mix(col, uSkyTop, fres * 0.35);
  vec3 h = normalize(v + uSunDir);
  col += uSunCol * pow(max(dot(n, h), 0.0), 120.0) * 0.8;
  // Soft foam band along the bank, breathing slowly.
  float band = 1.2 + 0.5 * sin(uTime * 0.8 + vWorld.x * 0.04);
  float foam = 1.0 - smoothstep(band * 0.4, band, fromShore);
  col = mix(col, uFoam * max(diffuse, 0.4), foam * 0.85);
  float alpha = smoothstep(0.0, 0.1, vEdge) * mix(0.78, 0.92, smoothstep(0.0, 10.0, fromShore)) * uOpacity;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

function buildWater(): THREE.BufferGeometry {
  const halfWidth = 42;
  const pos: number[] = [];
  const edge: number[] = [];
  const idx: number[] = [];
  const across = 6;
  const xs: number[] = [];
  for (let x = -EXTENT; x <= EXTENT; x += Math.abs(x) < MAP_HALF_SIZE + 200 ? 14 : 80) xs.push(x);
  for (const x of xs) {
    const cz = riverCentreZ(x);
    for (let j = -across; j <= across; j++) {
      pos.push(x, WATER_LEVEL, cz + (j / across) * halfWidth);
      edge.push(1 - Math.abs(j) / across);
    }
  }
  const row = across * 2 + 1;
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < row; j++) {
      const a = i * row + j;
      idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), EXTENT * 2);
  return geo;
}

export class Terrain {
  readonly group = new THREE.Group();
  private ground: THREE.Mesh;
  private groundMat: THREE.MeshStandardMaterial;
  private patch: THREE.Mesh | null = null;
  private patchMat: THREE.MeshStandardMaterial;
  private patchSize = 0;
  private patchStep = 1;
  private patchRect = { value: new THREE.Vector4(1e9, 1e9, -1e9, -1e9) };
  private patchOrigin = { value: new THREE.Vector2() };
  private water: THREE.Mesh;
  private waterMat: THREE.ShaderMaterial;

  constructor(private readonly shared: Shared) {
    this.groundMat = groundMaterial(shared, false, this.patchRect, this.patchOrigin);
    this.patchMat = groundMaterial(shared, true, this.patchRect, this.patchOrigin);
    this.ground = new THREE.Mesh(buildGround(), this.groundMat);
    this.ground.receiveShadow = true;
    this.ground.renderOrder = -5;
    this.ground.matrixAutoUpdate = false;
    this.group.add(this.ground);

    this.waterMat = new THREE.ShaderMaterial({
      vertexShader: WATER_VERTEX,
      fragmentShader: WATER_FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uShallow: { value: new THREE.Color(PALETTE.water) },
          uDeep: { value: new THREE.Color(PALETTE.waterDeep) },
          uFoam: { value: new THREE.Color(PALETTE.foam) },
          uSkyCol: { value: new THREE.Color(0x9dc4dc) },
          uSkyTop: { value: new THREE.Color(0x4a8ad0) },
          uSunCol: { value: new THREE.Color(0xffffff) },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uOpacity: { value: 0.93 },
        },
      ]),
    });
    this.waterMat.uniforms.uNoise = shared.uNoise;
    this.waterMat.uniforms.uTime = shared.uTime;
    this.water = new THREE.Mesh(buildWater(), this.waterMat);
    this.water.renderOrder = 1;
    this.water.matrixAutoUpdate = false;
    this.group.add(this.water);
  }

  /** Match the water to the sky and light. */
  setLighting(sky: THREE.Color, skyTop: THREE.Color, sunColor: THREE.Color, sunIntensity: number, sunDir: THREE.Vector3, night: number): void {
    const u = this.waterMat.uniforms;
    u.uSkyCol.value.copy(sky).multiplyScalar(0.9);
    u.uSkyTop.value.copy(skyTop);
    u.uSunCol.value.copy(sunColor).multiplyScalar(Math.min(1, sunIntensity / 3));
    u.uSunDir.value.copy(sunDir);
    const dim = 1 - 0.82 * night;
    u.uShallow.value.set(PALETTE.water).multiplyScalar(dim);
    u.uDeep.value.set(PALETTE.waterDeep).multiplyScalar(dim);
    u.uFoam.value.set(PALETTE.foam).multiplyScalar(dim);
  }

  /**
   * High and ultra get a fine grid that follows the camera, displaced on the GPU
   * from the same height function. size 0 removes it.
   */
  setPatch(size: number, step: number): void {
    if (this.patch) {
      this.group.remove(this.patch);
      this.patch.geometry.dispose();
      this.patch = null;
    }
    this.patchSize = size;
    this.patchStep = step;
    this.patchRect.value.set(1e9, 1e9, -1e9, -1e9);
    if (!size) return;
    const n = Math.round(size / step);
    const geo = new THREE.PlaneGeometry(size, size, n, n).rotateX(-Math.PI / 2);
    geo.deleteAttribute('uv');
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.patch = new THREE.Mesh(geo, this.patchMat);
    this.patch.frustumCulled = false;
    this.patch.receiveShadow = true;
    this.patch.renderOrder = -5;
    this.patch.matrixAutoUpdate = false;
    this.group.add(this.patch);
  }

  /** Move the fine patch under the camera's target, snapped so it does not swim. */
  update(focusX: number, focusZ: number, cameraHeight: number): void {
    if (!this.patch) return;
    // Only worth drawing while the camera is close enough to see the detail.
    const show = cameraHeight < this.patchSize * 0.9;
    this.patch.visible = show;
    if (!show) {
      this.patchRect.value.set(1e9, 1e9, -1e9, -1e9);
      return;
    }
    const snap = this.patchStep * 2;
    const ox = Math.round(focusX / snap) * snap;
    const oz = Math.round(focusZ / snap) * snap;
    this.patchOrigin.value.set(ox, oz);
    const h = this.patchSize / 2 - this.patchStep * 1.5;
    this.patchRect.value.set(ox - h, oz - h, ox + h, oz + h);
  }

  setUnderground(on: boolean): void {
    for (const m of [this.groundMat, this.patchMat]) {
      m.transparent = on;
      m.opacity = on ? 0.28 : 1;
      m.depthWrite = !on;
      m.needsUpdate = true;
    }
    this.shared.uUnder.value = on ? 1 : 0;
    this.ground.renderOrder = on ? 3 : -5;
    if (this.patch) this.patch.renderOrder = on ? 3 : -5;
    this.waterMat.uniforms.uOpacity.value = on ? 0.25 : 0.93;
  }

  dispose(): void {
    this.ground.geometry.dispose();
    this.groundMat.dispose();
    this.patch?.geometry.dispose();
    this.patchMat.dispose();
    this.water.geometry.dispose();
    this.waterMat.dispose();
  }
}
