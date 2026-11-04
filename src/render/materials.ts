/**
 * Materials shared across the scene. Stock Three.js materials patched with
 * onBeforeCompile, so lights, shadows, fog and log depth keep working.
 */
import * as THREE from 'three';
import { makeDetailTexture, makeNoiseTexture } from './textures';
import { RoadSurfaces } from './roadSurface';
import { ROAD_SURFACE_MAIN, ROAD_SURFACE_PARS } from './roadShader';
import { ROAD_DETAIL, type RoadDetailName } from './roadDetail';
import { PAINT_MATERIAL } from '../core/paintStandard';

export const SLOT_COLS = 1024;
const SLOT_ROWS = 128;

/** Uniforms and textures every material shares. */
export class Shared {
  readonly uTime = { value: 0 };
  /** 0 by day, 1 at night. */
  readonly uNight = { value: 0 };
  /** 0 normal terrain, 1 desaturated for data overlays. */
  readonly uDim = { value: 0 };
  /** Cloud shadow: offset x, offset z, strength. */
  readonly uCloud = { value: new THREE.Vector3(0, 0, 0) };
  /** 1 in the underground view. */
  readonly uUnder = { value: 0 };
  /** Viewport height in pixels over 2 tan(fov/2): metres per pixel at distance d is d / uPxScale. */
  readonly uPxScale = { value: 1000 };
  readonly uNoise: { value: THREE.DataTexture };
  /**
   * Per road colours, 1024 wide. Rows come in pairs: even rows hold the overlay
   * colour, odd rows the highlight. Alpha is strength. Slot n sits at column
   * n % 1024 of row pair n / 1024.
   */
  /** High-resolution detail for ground and roads. See makeDetailTexture. */
  readonly uDetail: { value: THREE.DataTexture };
  readonly slotData = new Uint8Array(SLOT_COLS * SLOT_ROWS * 4);
  readonly slotTex: THREE.DataTexture;
  readonly uSlots: { value: THREE.DataTexture };
  /** Procedural road surface textures, sized by the road detail level (roadSurface.ts). */
  readonly roadTex: RoadSurfaces;

  constructor(anisotropy: number, maxAnisotropy = anisotropy) {
    this.roadTex = new RoadSurfaces(maxAnisotropy);
    this.uNoise = { value: makeNoiseTexture(256, anisotropy) };
    this.uDetail = { value: makeDetailTexture(2048, anisotropy) };
    this.slotTex = new THREE.DataTexture(this.slotData, SLOT_COLS, SLOT_ROWS, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.slotTex.magFilter = THREE.NearestFilter;
    this.slotTex.minFilter = THREE.NearestFilter;
    this.slotTex.needsUpdate = true;
    this.uSlots = { value: this.slotTex };
  }

  dispose(): void {
    this.uNoise.value.dispose();
    this.uDetail.value.dispose();
    this.roadTex.dispose();
    this.slotTex.dispose();
  }
}

const LOG_BIAS = /* glsl */ `
#include <logdepthbuf_fragment>
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
  gl_FragDepth -= vBias;
#endif
`;

/** Cloud shadow drifting over the ground. uCloud is offset x, offset z, strength. */
export const CLOUD_SHADOW = /* glsl */ `
float cloudShade(sampler2D noiseTex, vec3 cloud, vec2 p) {
  if (cloud.z <= 0.0) return 1.0;
  float n = texture2D(noiseTex, (p + cloud.xy) / 3100.0).b * 0.7 + texture2D(noiseTex, (p + cloud.xy * 1.3) / 1130.0).g * 0.3;
  return 1.0 - cloud.z * smoothstep(0.5, 0.68, n);
}
`;

/** For two-sided cards lit as a soft volume: the back of a card shades like the front. */
export function keepNormals(fragmentShader: string): string {
  return fragmentShader.replace(
    '#include <normal_fragment_begin>',
    `#include <normal_fragment_begin>\nnormal = normalize(vNormal);\nnonPerturbedNormal = normal;`,
  );
}

/** Shared GLSL helpers for surfaces. */
const SURFACE_PARS = /* glsl */ `
float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;

/** Roads, junctions, decks, pillars: everything in the surface batches. */
export function makeSurfaceMaterial(shared: Shared, detail: RoadDetailName = 'medium'): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  setSurfaceDetail(m, detail);
  m.onBeforeCompile = (s) => {
    s.uniforms.uAsphalt = shared.roadTex.uAsphalt;
    s.uniforms.uConcrete = shared.roadTex.uConcrete;
    s.uniforms.uSlots = shared.uSlots;
    s.uniforms.uNoise = shared.uNoise;
    s.uniforms.uDetail = shared.uDetail;
    s.uniforms.uTime = shared.uTime;
    s.uniforms.uNight = shared.uNight;
    s.uniforms.uCloud = shared.uCloud;
    s.vertexShader = s.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
attribute vec3 aExt;
attribute vec2 aRoad;
attribute vec4 aSurf;
uniform highp sampler2D uSlots;
varying vec4 vSurf;
flat varying float vSlot;
flat varying float vKind;
varying float vBias;
varying vec3 vWorld;
varying vec2 vRoad;
flat varying vec4 vOverlay;
flat varying vec4 vHigh;
`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
vKind = aExt.x;
vBias = aExt.z;
vWorld = position;
vRoad = aRoad;
vSurf = aSurf;
vSlot = aExt.y;
int slot = int(aExt.y + 0.5);
ivec2 st = ivec2(slot % ${SLOT_COLS}, (slot / ${SLOT_COLS}) * 2);
if (vKind < 4.5 || vKind == 6.0 || vKind == 9.0 || vKind == 10.0) {
  vOverlay = texelFetch(uSlots, st, 0);
  vHigh = texelFetch(uSlots, st + ivec2(0, 1), 0);
} else {
  vOverlay = vec4(0.0);
  vHigh = vec4(0.0);
}
`,
      );
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform sampler2D uNoise;
uniform sampler2D uDetail;
uniform float uTime;
uniform float uNight;
uniform vec3 uCloud;
flat varying float vKind;
varying float vBias;
varying vec3 vWorld;
varying vec2 vRoad;
flat varying vec4 vOverlay;
flat varying vec4 vHigh;
float gRough = 0.9;
float gMetal = 0.0;
vec2 gBump = vec2(0.0);
vec3 gGlow = vec3(0.0);
${SURFACE_PARS}
${CLOUD_SHADOW}
${ROAD_SURFACE_PARS}
`,
      )
      .replace('#include <logdepthbuf_fragment>', LOG_BIAS)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
{
  // Road surfaces by road detail level (roadShader.ts); the rest as before.
  float k = vKind;
  vec2 wp = vWorld.xz;
  float dist = length(vViewPosition);
${ROAD_SURFACE_MAIN}
  if (rsDone) {
  } else if (k > 0.5 && k < 1.5) {
    diffuseColor.rgb *= 0.95 + 0.08 * texture2D(uDetail, wp / 2.7).g;
    bool hasRoad = abs(vRoad.y) > 0.001;
    vec2 q = hasRoad ? vec2(vRoad.x / 1.8, vRoad.y / 2.4) : vWorld.xz / 2.2;
    vec2 d = abs(fract(q) - 0.5);
    float w = max(fwidth(q.x), fwidth(q.y));
    float joint = smoothstep(0.5 - 0.025 - w, 0.5 - 0.025, max(d.x, d.y));
    joint *= 1.0 - smoothstep(0.08, 0.3, w);
    diffuseColor.rgb *= 1.0 - 0.18 * joint;
    gRough = 0.9;
  } else if (k > 6.5 && k < 7.5) {
    gRough = 0.6;
    gMetal = 0.2;
  } else if (k > 7.5 && k < 8.5) {
    gGlow = diffuseColor.rgb * 4.0;
  } else {
    gRough = 0.88;
  }
  if (vOverlay.a > 0.0) {
    if (k < 0.5 || k == 6.0 || k == 9.0) diffuseColor.rgb = mix(diffuseColor.rgb, vOverlay.rgb, vOverlay.a);
    else diffuseColor.rgb = mix(diffuseColor.rgb, vOverlay.rgb * 0.75 + 0.1, vOverlay.a * 0.6);
  }
  if (vHigh.a > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, vHigh.rgb, vHigh.a * 0.75);
}
`,
      )
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = gRough;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\nmetalnessFactor = gMetal;`)
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
if (gBump.x != 0.0 || gBump.y != 0.0) normal = normalize(normal + (viewMatrix * vec4(gBump.x, 0.0, gBump.y, 0.0)).xyz);
`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
totalEmissiveRadiance += gGlow;
if (vOverlay.a > 0.0) totalEmissiveRadiance += vOverlay.rgb * vOverlay.a * 0.12;
if (vHigh.a > 0.0) totalEmissiveRadiance += vHigh.rgb * vHigh.a * (0.32 + 0.1 * sin(uTime * 4.0));
`,
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
  m.customProgramCacheKey = () => `cl-surface-lp-rd${m.defines?.ROAD_DETAIL ?? 1}`;
  return m;
}

/** Switch a surface material's road detail shader level. Recompiles once on the next draw. */
export function setSurfaceDetail(m: THREE.Material, detail: RoadDetailName): void {
  const level = ROAD_DETAIL[detail].level;
  if (m.defines?.ROAD_DETAIL === level) return;
  m.defines = { ...(m.defines ?? {}), ROAD_DETAIL: level };
  m.needsUpdate = true;
}

/**
 * Lane paint. Ribbons are drawn at their true width up close. Past a pixel the
 * vertex shader widens the geometry and the fragment shader box-filters both the
 * line and its dash pattern, so at a distance a dashed line settles into a faint
 * steady stroke with no crawl.
 */
export function makePaintMaterial(shared: Shared, opts: { bias: number; lift: number; fade?: boolean; lit?: boolean }): THREE.Material {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    roughness: PAINT_MATERIAL.roughness,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: THREE.DoubleSide,
  });
  const key = `cl-paint-lp-${opts.bias}-${opts.lift}-${opts.fade !== false}`;
  m.onBeforeCompile = (s) => {
    s.uniforms.uNoise = shared.uNoise;
    s.uniforms.uPxScale = shared.uPxScale;
    s.uniforms.uCloud = shared.uCloud;
    s.vertexShader = s.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
attribute vec2 aSide;
attribute vec3 aLine;
attribute vec2 aDash;
uniform float uPxScale;
varying float vEdge;
varying float vHalf;
varying float vU;
varying float vPeriod;
varying float vDuty;
varying float vFade;
varying vec2 vPlan;
`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
vec4 wp = modelMatrix * vec4(position, 1.0);
vec3 toCam = cameraPosition - wp.xyz;
float dist = length(toCam);
float grazing = max(abs(toCam.y) / max(dist, 0.001), 0.1);
float pad = 1.6 * dist / uPxScale / grazing;
float edge = aLine.x * (aLine.y + pad);
transformed.xz += aSide * edge;
transformed.y += ${opts.lift.toFixed(4)};
vEdge = edge;
vHalf = aLine.y;
vU = aLine.z;
vPeriod = aDash.x;
vDuty = aDash.y;
vPlan = transformed.xz;
vFade = aDash.x < -0.5 ? ${opts.fade === false ? '1.0' : `1.0 - smoothstep(${PAINT_MATERIAL.fadeNear.toFixed(1)}, ${PAINT_MATERIAL.fadeFar.toFixed(1)}, dist)`} : 1.0;
`,
      );
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform sampler2D uNoise;
uniform vec3 uCloud;
varying float vEdge;
varying float vHalf;
varying float vU;
varying float vPeriod;
varying float vDuty;
varying float vFade;
varying vec2 vPlan;
float dashIntegral(float x, float p, float d) {
  float c = floor(x / p);
  return c * d * p + min(x - c * p, d * p);
}
${CLOUD_SHADOW}
`,
      )
      .replace(
        '#include <logdepthbuf_fragment>',
        /* glsl */ `#include <logdepthbuf_fragment>
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
  gl_FragDepth -= ${opts.bias.toExponential(3)};
#endif
`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
{
  float cover = 1.0;
  if (vPeriod > -0.5) {
    float fe = max(fwidth(vEdge), 1e-5);
    cover = clamp((min(vEdge + 0.5 * fe, vHalf) - max(vEdge - 0.5 * fe, -vHalf)) / fe, 0.0, 1.0);
    if (vPeriod > 0.01) {
      float fu = max(fwidth(vU), 1e-5);
      float span = dashIntegral(vU + 0.5 * fu, vPeriod, vDuty) - dashIntegral(vU - 0.5 * fu, vPeriod, vDuty);
      cover *= clamp(span / fu, 0.0, 1.0);
    }
  }
  // Wear: the same faint mottling on every mark, from the shared noise.
  float wear = texture2D(uNoise, vPlan / 9.0).r;
  diffuseColor.a *= cover * vFade * mix(0.86, 1.0, smoothstep(0.25, 0.6, wear));
  if (diffuseColor.a < 0.004) discard;
}
`,
      )
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `#include <lights_fragment_end>
{
  float cs = cloudShade(uNoise, uCloud, vPlan);
  reflectedLight.directDiffuse *= cs;
  reflectedLight.directSpecular *= cs;
}
`,
      );
  };
  m.customProgramCacheKey = () => key;
  return m;
}

/** Terrain cutout: writes stencil only, drawn before the terrain. */
export function makeHoleMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilRef: 1,
    stencilZPass: THREE.ReplaceStencilOp,
  });
}
