/**
 * Ground and water. The grid is warped to follow the river, so the banks get
 * fine triangles without paying for them across the flat map.
 */
import * as THREE from 'three';
import { MAP_HALF_SIZE, RIVER_DEPTH, WATER_LEVEL, riverCentreZ, terrainHeight } from '../core/terrain';
import { CLOUD_SHADOW, type Shared } from './materials';

const EXTENT = 9000;

function stepsTo(out: number[], from: number, to: number, step: number): void {
  for (let v = from; v < to - 1e-6; v += step) out.push(v);
}

function rowOffsets(): number[] {
  const half: number[] = [];
  stepsTo(half, 0, 56, 3.5);
  stepsTo(half, 56, 248, 16);
  stepsTo(half, 248, 1500, 150);
  stepsTo(half, 1500, MAP_HALF_SIZE, 100);
  stepsTo(half, MAP_HALF_SIZE, 3000, 30);
  stepsTo(half, 3000, 6000, 100);
  stepsTo(half, 6000, EXTENT, 300);
  half.push(EXTENT);
  const rows = half.slice(1).reverse().map((v) => -v);
  return rows.concat(half);
}

function columnOffsets(): number[] {
  const half: number[] = [];
  stepsTo(half, 0, MAP_HALF_SIZE, 8);
  stepsTo(half, MAP_HALF_SIZE, 3000, 30);
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

function groundMaterial(shared: Shared): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  m.stencilWrite = true;
  m.stencilFunc = THREE.NotEqualStencilFunc;
  m.stencilRef = 1;
  m.stencilZPass = THREE.KeepStencilOp;
  m.onBeforeCompile = (s) => {
    s.uniforms.uNoise = shared.uNoise;
    s.uniforms.uDim = shared.uDim;
    s.uniforms.uUnder = shared.uUnder;
    s.uniforms.uCloud = shared.uCloud;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorld;\nvarying float vSlope;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nvWorld = position;\nvSlope = 1.0 - normal.y;`,
      );
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform sampler2D uNoise;
uniform float uDim;
uniform float uUnder;
uniform vec3 uCloud;
${CLOUD_SHADOW}
float gRough = 0.95;
vec2 gBump = vec2(0.0);
varying vec3 vWorld;
varying float vSlope;
const float MAP_EDGE = ${MAP_HALF_SIZE.toFixed(1)};
`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
{
  vec2 p = vWorld.xz;
  float h = vWorld.y;
  // Each scale gets its own rotation, and the big ones a slow warp, so tiling never lines up.
  vec2 warp = 90.0 * vec2(sin(p.y * 0.0031 + 1.1) + 0.5 * sin(p.y * 0.0083), cos(p.x * 0.0027 - 0.4) + 0.5 * cos(p.x * 0.0071));
  vec2 p1 = mat2(0.8, 0.6, -0.6, 0.8) * p;
  vec2 p2 = mat2(0.5, -0.866, 0.866, 0.5) * (p + warp);
  vec2 p3 = mat2(-0.28, 0.96, -0.96, -0.28) * (p + warp * 3.0);
  float n0 = texture2D(uNoise, p / 7.0).r;
  float n1 = texture2D(uNoise, p1 / 61.0).g;
  float n2 = texture2D(uNoise, p2 / 337.0).g;
  float n3 = texture2D(uNoise, p3 / 2930.0).b;
  float n4 = texture2D(uNoise, p1 / 23.0).b;
  // Small scales repeat visibly from high up, so they hand over to the large ones.
  float distant = smoothstep(350.0, 1500.0, length(vViewPosition));
  n1 = mix(n1, 0.5, distant * 0.85);
  n4 = mix(n4, 0.5, distant * 0.85);

  // Three greens and a dry tone, laid out at four scales.
  vec3 meadow = vec3(0.105, 0.185, 0.052);
  vec3 lush = vec3(0.070, 0.135, 0.038);
  vec3 pale = vec3(0.150, 0.215, 0.070);
  vec3 dry = vec3(0.205, 0.215, 0.090);
  vec3 g = mix(meadow, lush, smoothstep(0.35, 0.68, n1 * 0.6 + n2 * 0.4));
  g = mix(g, pale, smoothstep(0.42, 0.72, n2 * 0.55 + n3 * 0.45) * 0.7);
  g = mix(g, dry, smoothstep(0.58, 0.82, n3 * 0.6 + n4 * 0.4) * 0.5);
  g *= 0.86 + 0.3 * n0;
  // Blades of grass only exist up close.
  float closeUp = 1.0 - smoothstep(30.0, 200.0, length(vViewPosition));
  if (closeUp > 0.0) {
    float blades = texture2D(uNoise, p / 1.9).r * 0.6 + texture2D(uNoise, p1 / 0.83).a * 0.4;
    g *= 1.0 + (blades - 0.5) * 0.6 * closeUp;
    // Bare soil showing through the turf.
    float soil = smoothstep(0.6, 0.78, texture2D(uNoise, p1 / 3.7).g * 0.7 + n1 * 0.3);
    g = mix(g, vec3(0.105, 0.078, 0.05) * (0.8 + 0.5 * n0), soil * 0.38 * closeUp);
    gBump = (vec2(n0, blades) - 0.5) * closeUp * 0.5;
  }
  // Larger worn patches, visible from further away.
  float worn = smoothstep(0.64, 0.82, n2 * 0.55 + n1 * 0.45);
  g = mix(g, vec3(0.135, 0.11, 0.07), worn * 0.45);

  // Under the trees: the same density field TreeLayer scatters with.
  vec2 fw = vec2(p.x + 260.0 * sin(p.y * 0.0013 + 0.7) + 120.0 * sin(p.y * 0.0041 + 2.1), p.y + 260.0 * cos(p.x * 0.0011 - 0.4) + 120.0 * cos(p.x * 0.0037 + 1.3));
  float forest = (sin(fw.x * 0.0041 + 1.3) * cos(fw.y * 0.0037 - 0.7) + 0.6 * sin(fw.x * 0.0096 - fw.y * 0.0083 + 2.2) + 0.4 * cos(fw.x * 0.0211 + fw.y * 0.0173 + 0.4)) * 0.5;
  float inMap = step(max(abs(p.x), abs(p.y)), MAP_EDGE);
  float canopy = smoothstep(mix(-0.08, 0.14, inMap), mix(0.1, 0.3, inMap), forest + (n1 - 0.5) * 0.18);
  g = mix(g, vec3(0.040, 0.075, 0.030) * (0.8 + 0.5 * n4), canopy * 0.85);

  // Banks go through sand to wet mud, broken up by noise.
  float wob = (n4 - 0.5) * 0.8;
  vec3 sand = vec3(0.34, 0.29, 0.19);
  vec3 mud = vec3(0.14, 0.13, 0.09);
  vec3 c = mix(g, sand, 1.0 - smoothstep(-1.9 + wob, -0.15 + wob, h));
  c = mix(c, mud, 1.0 - smoothstep(${(-RIVER_DEPTH * 0.72).toFixed(2)}, ${(-RIVER_DEPTH * 0.42).toFixed(2)}, h + wob * 0.4));

  // Hills past the map: forest dark low down, rock and scrub higher.
  float hill = smoothstep(4.0, 80.0, h);
  c = mix(c, c * vec3(0.72, 0.84, 0.72), hill);
  float rock = smoothstep(180.0, 420.0, h + (n3 - 0.5) * 160.0) + smoothstep(0.12, 0.3, vSlope) * hill;
  float rockMask = clamp(rock, 0.0, 1.0) * 0.85;
  vec3 strata = vec3(0.115, 0.118, 0.095) * (0.62 + 0.75 * texture2D(uNoise, vec2(p.x * 0.004, h * 0.02)).g) * (0.7 + 0.6 * n1);
  c = mix(c, strata, rockMask);
  gRough = mix(0.95, 0.82, rockMask);

  // Quietly mark the buildable edge.
  float out_ = max(abs(p.x), abs(p.y)) - MAP_EDGE;
  if (out_ > 0.0) c *= 0.93;
  float w = max(fwidth(out_) * 1.2, 1.0);
  float line = 1.0 - smoothstep(w * 0.5, w * 1.5, abs(out_));
  c = mix(c, vec3(0.75, 0.85, 0.8), line * 0.18);

  if (uDim > 0.0) {
    float l = dot(c, vec3(0.3, 0.6, 0.1));
    c = mix(c, vec3(l) * 0.75 + vec3(0.02, 0.025, 0.03), uDim);
  }
  c *= vec3(0.78, 0.86, 0.72);
  if (uUnder > 0.5) c = vec3(dot(c, vec3(0.3, 0.6, 0.1))) * vec3(0.5, 0.62, 0.8);
  diffuseColor.rgb = c;
}
`,
      )
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = gRough;`)
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\nif (gBump.x != 0.0) normal = normalize(normal + (viewMatrix * vec4(gBump.x, 0.0, gBump.y, 0.0)).xyz);`,
      )
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `#include <lights_fragment_end>
{
  float cs = cloudShade(uNoise, uCloud, vWorld.xz);
  reflectedLight.directDiffuse *= cs;
  reflectedLight.directSpecular *= cs;
}
`,
      );
  };
  m.customProgramCacheKey = () => 'cl-ground-2';
  return m;
}

const WATER_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute float aEdge;
varying vec3 vWorld;
varying float vEdge;
void main() {
  vEdge = aEdge;
  vWorld = position;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const WATER_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uNoise;
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSkyCol;
uniform vec3 uSkyTop;
uniform vec3 uSunCol;
uniform vec3 uSunDir;
uniform float uOpacity;
varying vec3 vWorld;
varying float vEdge;
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = vWorld.xz;
  vec2 a = texture2D(uNoise, p / 34.0 + vec2(uTime * 0.012, uTime * 0.007)).rg;
  vec2 b = texture2D(uNoise, p / 13.0 + vec2(-uTime * 0.018, uTime * 0.02)).rg;
  vec2 c = texture2D(uNoise, p / 4.0 + vec2(uTime * 0.03, -uTime * 0.026)).rg;
  vec2 e = texture2D(uNoise, p / 1.3 + vec2(-uTime * 0.05, uTime * 0.04)).rg;
  float distCam = length(cameraPosition - vWorld);
  float detail = 1.0 - smoothstep(60.0, 420.0, distCam);
  vec2 tilt = (a - 0.5) * 0.16 + (b - 0.5) * 0.14 + (c - 0.5) * 0.1 + (e - 0.5) * 0.09 * detail;
  vec3 n = normalize(vec3(tilt.x, 1.0, tilt.y));
  vec3 v = normalize(cameraPosition - vWorld);
  float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 5.0);
  // Distance from the waterline in metres. The banks meet the water at 30 m out.
  float fromShore = 30.0 - (1.0 - vEdge) * 42.0;
  vec3 body = mix(uShallow, uDeep, smoothstep(0.0, 22.0, fromShore));
  // Reflect a sky gradient, with the dark treeline along the far bank near the shore.
  vec3 r = reflect(-v, n);
  float up = clamp(r.y, 0.0, 1.0);
  vec3 sky = mix(uSkyCol, uSkyTop, smoothstep(0.0, 0.55, up));
  sky = mix(sky * vec3(0.5, 0.58, 0.46), sky, smoothstep(0.03, 0.2, up + smoothstep(0.0, 18.0, fromShore) * 0.12));
  vec3 col = mix(body, sky, fres);
  vec3 h = normalize(v + uSunDir);
  float spec = pow(max(dot(n, h), 0.0), 900.0) * 16.0 + pow(max(dot(n, h), 0.0), 90.0) * 0.5;
  col += uSunCol * spec;
  // Foam where the river laps the bank, drifting with the ripples.
  float lap = 0.5 + 0.5 * sin(uTime * 0.7 + p.x * 0.05 + a.x * 6.0);
  float foamBand = 1.0 - smoothstep(0.1, 1.3 + lap * 1.2, fromShore);
  float foamNoise = smoothstep(0.42, 0.68, texture2D(uNoise, p / 3.3 + vec2(uTime * 0.02, 0.0)).g + (b.x - 0.5) * 0.4);
  col = mix(col, vec3(0.8, 0.84, 0.82) * max(uSunCol.g * 0.6, 0.12), foamBand * foamNoise * 0.75);
  float alpha = smoothstep(0.0, 0.1, vEdge) * mix(0.82, 0.97, smoothstep(0.0, 8.0, fromShore)) * uOpacity;
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
  const across = 8;
  const xs: number[] = [];
  for (let x = -EXTENT; x <= EXTENT; x += Math.abs(x) < MAP_HALF_SIZE + 200 ? 10 : 80) xs.push(x);
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
  private water: THREE.Mesh;
  private waterMat: THREE.ShaderMaterial;

  constructor(private readonly shared: Shared) {
    this.groundMat = groundMaterial(shared);
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
          uShallow: { value: new THREE.Color(0x4b7a70) },
          uDeep: { value: new THREE.Color(0x1d4a55) },
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
    u.uShallow.value.set(0x4b7a70).multiplyScalar(dim);
    u.uDeep.value.set(0x1d4a55).multiplyScalar(dim);
  }

  setUnderground(on: boolean): void {
    const m = this.groundMat;
    m.transparent = on;
    m.opacity = on ? 0.28 : 1;
    m.depthWrite = !on;
    m.needsUpdate = true;
    this.shared.uUnder.value = on ? 1 : 0;
    this.ground.renderOrder = on ? 3 : -5;
    this.waterMat.uniforms.uOpacity.value = on ? 0.25 : 0.93;
  }

  dispose(): void {
    this.ground.geometry.dispose();
    this.groundMat.dispose();
    this.water.geometry.dispose();
    this.waterMat.dispose();
  }
}
