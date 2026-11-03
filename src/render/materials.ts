/**
 * Materials shared across the scene. Stock Three.js materials patched with
 * onBeforeCompile, so lights, shadows, fog and log depth keep working.
 */
import * as THREE from 'three';
import { makeNoiseTexture } from './textures';

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
  readonly slotData = new Uint8Array(SLOT_COLS * SLOT_ROWS * 4);
  readonly slotTex: THREE.DataTexture;
  readonly uSlots: { value: THREE.DataTexture };

  constructor(anisotropy: number) {
    this.uNoise = { value: makeNoiseTexture(256, anisotropy) };
    this.slotTex = new THREE.DataTexture(this.slotData, SLOT_COLS, SLOT_ROWS, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.slotTex.magFilter = THREE.NearestFilter;
    this.slotTex.minFilter = THREE.NearestFilter;
    this.slotTex.needsUpdate = true;
    this.uSlots = { value: this.slotTex };
  }

  dispose(): void {
    this.uNoise.value.dispose();
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
export function makeSurfaceMaterial(shared: Shared): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uSlots = shared.uSlots;
    s.uniforms.uNoise = shared.uNoise;
    s.uniforms.uTime = shared.uTime;
    s.uniforms.uNight = shared.uNight;
    s.uniforms.uCloud = shared.uCloud;
    s.vertexShader = s.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
attribute vec3 aExt;
attribute vec2 aRoad;
uniform highp sampler2D uSlots;
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
int slot = int(aExt.y + 0.5);
ivec2 st = ivec2(slot % ${SLOT_COLS}, (slot / ${SLOT_COLS}) * 2);
if (vKind < 4.5 || vKind == 6.0) {
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
`,
      )
      .replace('#include <logdepthbuf_fragment>', LOG_BIAS)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
{
  vec2 p = vWorld.xz;
  float dist = length(vViewPosition);
  float close = 1.0 - smoothstep(35.0, 170.0, dist);
  float mid = 1.0 - smoothstep(150.0, 700.0, dist);
  vec4 fine = texture2D(uNoise, p / 5.0);
  vec4 broad = texture2D(uNoise, p / 41.0);
  vec4 macro = texture2D(uNoise, p / 233.0);
  float k = vKind;
  if (k < 0.5 || k == 6.0) {
    // Asphalt: aggregate up close, wear and repairs further out.
    float grit = texture2D(uNoise, p / 0.71).a;
    float grit2 = texture2D(uNoise, p / 1.9).r;
    vec3 c = diffuseColor.rgb;
    c *= 0.84 + 0.26 * fine.r + 0.16 * (broad.g - 0.5) + 0.14 * (macro.b - 0.5);
    c *= 1.0 + close * (grit - 0.5) * 0.55;
    c += close * smoothstep(0.86, 0.97, grit) * 0.03;
    float rough = 0.86 + 0.08 * fine.g;
    vec2 bump = (vec2(grit, grit2) - 0.5) * close * 0.32;
    if (k < 0.5) {
      float u = vRoad.x;
      float s = vRoad.y;
      // Polished, darker wheel paths with a stained strip between them.
      float wob = (texture2D(uNoise, vec2(s / 37.0, u * 0.01 + 0.3)).g - 0.5) * 0.3;
      float d = abs(abs(u + wob) - 0.92);
      float track = exp(-d * d * 7.0) * mid * (0.6 + 0.6 * broad.r);
      c *= 1.0 - 0.17 * track;
      rough -= 0.2 * track;
      float drip = exp(-(u + wob) * (u + wob) * 5.0) * smoothstep(0.42, 0.72, fine.b) * mid;
      c *= 1.0 - 0.3 * drip;
      rough -= 0.2 * drip;
      // Repair patches, rectangular as a crew would cut them.
      float cell = floor(s / 29.0);
      float h = hash1(cell + floor(u * 0.02 + 40.0));
      if (h < 0.24 && abs(u) < 1.75) {
        float a = 6.0 + hash1(cell + 3.1) * 8.0;
        float l = 5.0 + hash1(cell + 7.7) * 12.0;
        float q = s - cell * 29.0;
        float e = min(min(q - a, a + l - q), 1.75 - abs(u));
        if (e > 0.0) {
          c = mix(c, c * (h < 0.12 ? 0.74 : 1.13), mid);
          rough += 0.04;
        }
        float seam = 1.0 - smoothstep(0.0, 0.05, abs(e));
        c = mix(c, vec3(0.012), seam * close * 0.8);
        rough = mix(rough, 0.42, seam * close);
      }
    } else {
      // Junctions take the turning traffic: darker, with oil spots.
      float spot = smoothstep(0.6, 0.75, texture2D(uNoise, p / 13.0).g) * smoothstep(0.4, 0.6, broad.b);
      c *= 1.0 - 0.22 * spot * mid;
      rough -= 0.25 * spot * mid;
      c *= 0.94;
    }
    // Sealed cracks: thin shiny tar lines wandering across the surface.
    float nCrack = texture2D(uNoise, p / 23.0).g + (fine.g - 0.5) * 0.06;
    float tar = (1.0 - smoothstep(0.0, 0.009, abs(nCrack - 0.5))) * smoothstep(0.42, 0.62, macro.g);
    c = mix(c, vec3(0.011, 0.011, 0.012), tar * mid * 0.85);
    rough = mix(rough, 0.4, tar * mid);
    diffuseColor.rgb = c;
    gRough = rough;
    gBump = bump;
  } else if (k < 1.5) {
    // Concrete sidewalk: bays along the road, with score lines between.
    bool hasRoad = abs(vRoad.y) > 0.001;
    vec2 q = hasRoad ? vec2(vRoad.x / 1.8, vRoad.y / 2.4) : p / 2.2;
    vec2 cellId = floor(q);
    vec2 d = abs(fract(q) - 0.5);
    float w = max(fwidth(q.x), fwidth(q.y));
    float joint = smoothstep(0.5 - 0.02 - w, 0.5 - 0.02, max(d.x, d.y));
    joint *= 1.0 - smoothstep(0.1, 0.4, w);
    float tone = 0.9 + 0.2 * hash2(cellId);
    float stain = smoothstep(0.5, 0.8, broad.g);
    diffuseColor.rgb *= tone * (0.92 + 0.16 * fine.g) * (1.0 - 0.15 * stain) * (1.0 - 0.45 * joint);
    gRough = 0.88;
    gBump = (texture2D(uNoise, p / 1.1).rg - 0.5) * close * 0.1;
  } else if (k < 2.5) {
    float g = texture2D(uNoise, p / 11.0).g * 0.6 + broad.b * 0.4;
    diffuseColor.rgb *= (0.82 + 0.36 * g) * (0.9 + 0.2 * close * texture2D(uNoise, p / 0.9).r);
    gRough = 0.96;
  } else if (k < 3.5) {
    // Cast concrete. Sampled in 3D so vertical faces do not streak.
    vec3 q = vWorld;
    float a = texture2D(uNoise, (q.xz + q.yy * 0.7) / 6.0).g;
    float b = texture2D(uNoise, (q.xz * 0.6 + q.yy * 1.3) / 31.0).b;
    float weather = smoothstep(0.35, 0.8, texture2D(uNoise, vec2(q.x * 0.03 + q.z * 0.03, q.y * 0.12)).g);
    diffuseColor.rgb *= (0.86 + 0.24 * a) * (0.9 + 0.2 * b) * (1.0 - 0.14 * weather);
    gRough = 0.9;
  } else if (k < 4.5) {
    diffuseColor.rgb *= 0.92 + 0.14 * fine.g;
    gRough = 0.82;
  } else if (k > 6.5 && k < 7.5) {
    gRough = 0.46 + 0.2 * fine.g;
    gMetal = 0.85;
  } else if (k > 7.5) {
    gGlow = diffuseColor.rgb * 4.0;
    gRough = 0.5;
  } else {
    gRough = 0.75;
  }
  if (vOverlay.a > 0.0) {
    if (k < 0.5 || k == 6.0) diffuseColor.rgb = mix(diffuseColor.rgb, vOverlay.rgb, vOverlay.a);
    else diffuseColor.rgb = mix(diffuseColor.rgb, vOverlay.rgb * 0.75 + 0.1, vOverlay.a * 0.6);
    gRough = max(gRough, 0.75);
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
  m.customProgramCacheKey = () => 'cl-surface-2';
  return m;
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
    roughness: 0.62,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: THREE.DoubleSide,
  });
  const key = `cl-paint-2-${opts.bias}-${opts.lift}-${opts.fade !== false}`;
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
vFade = aDash.x < -0.5 ? ${opts.fade === false ? '1.0' : '1.0 - smoothstep(600.0, 1500.0, dist)'} : 1.0;
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
  // Worn by tyres: rubbed thin in blotches, chipped through at the aggregate.
  float blot = texture2D(uNoise, vPlan / 9.0).g;
  float chip = texture2D(uNoise, vPlan / 1.3).r;
  float grit = texture2D(uNoise, vPlan / 0.47).a;
  float wear = smoothstep(0.26, 0.5, blot + (chip - 0.5) * 0.4) * (0.55 + 0.45 * smoothstep(0.12, 0.42, grit));
  diffuseColor.a *= cover * vFade * mix(0.42, 0.97, wear);
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
