/**
 * The image pipeline: scene into a linear HDR target with MSAA, then ambient
 * occlusion, aerial perspective, bloom, filmic tone mapping and sRGB output.
 *
 * Hand-written rather than EffectComposer because the depth buffer is
 * logarithmic. The stock AO passes assume ordinary depth and would be wrong, and
 * reading depth here lets one pass do AO and atmosphere cheaply.
 */
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { HdrEffect, PostPipelineApi } from './context';
import type { QualitySettings } from './quality';
import type { GpuPhase } from './profile';
import { AO_RECON_GLSL, aoPosScaleBias } from './aoMath';

const FAR_LOG = (far: number) => Math.log2(far + 1);

const VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const DEPTH_FN = /* glsl */ `
uniform highp sampler2D tDepth;
uniform float uLogFar;
float viewDepth(vec2 uv) {
  float d = texture2D(tDepth, uv).r;
  return pow(2.0, d * uLogFar) - 1.0;
}
`;

/*
 * Ambient occlusion runs at a fraction of the screen in three passes.
 *
 * 1. AO_DEPTH_FS: each AO texel takes the view depth of one full-resolution depth
 *    texel (aoSource) and stores it linear, as 32-bit float. Done once, so the
 *    taps below read a small float texture and never decode log depth.
 * 2. AO_FS: positions are rebuilt from the centre of that same full-resolution
 *    texel (aoViewPos). Rebuilding from the AO texel's own centre, as this pass
 *    once did, put each point up to half a full pixel off its surface; on ground at
 *    a low angle that tilted the normal, and the rounding of each row decided which
 *    way, so flat ground showed horizontal stripes (tests/render/aoDepth.test.ts).
 * 3. AO_BLUR_FS twice: a separable blur that keeps to one surface, which also
 *    removes the 4x4 rotation pattern of the taps.
 */
const AO_DEPTH_FS = /* glsl */ `
precision highp float;
uniform highp sampler2D tDepth;
uniform float uLogFar;
uniform vec2 uFull;
uniform vec2 uScale;
uniform vec2 uPosScale;
uniform vec2 uPosBias;
${AO_RECON_GLSL}
void main() {
  float d = texelFetch(tDepth, ivec2(aoSource(floor(gl_FragCoord.xy))), 0).r;
  gl_FragColor = vec4(exp2(d * uLogFar) - 1.0, 0.0, 0.0, 1.0);
}
`;

const AO_FS = /* glsl */ `
precision highp float;
precision highp int;
uniform highp sampler2D tLin;
uniform vec2 uFull;
uniform vec2 uScale;
uniform vec2 uPosScale;
uniform vec2 uPosBias;
uniform vec2 uAoMax;
uniform float uPx;
#ifndef SAMPLES
#define SAMPLES 10
#endif
${AO_RECON_GLSL}
// AO texel indices are floats holding whole numbers: cheaper than ints per tap.
float linZ(vec2 a) { return texelFetch(tLin, ivec2(a), 0).r; }
float linZc(vec2 a) { return linZ(clamp(a, vec2(0.0), uAoMax)); }
// Tangent along one axis, from the side whose next texel continues a plane through
// the centre: inverse depth is linear across the screen on a plane, so the side with
// the smaller extrapolation error is the same surface. Keeps kerb edges clean.
vec3 tangent(vec2 a, vec2 e, vec3 P, float iz) {
  float m1 = linZc(a - e), m2 = linZc(a - 2.0 * e);
  float p1 = linZc(a + e), p2 = linZc(a + 2.0 * e);
  float em = abs(2.0 / m1 - 1.0 / m2 - iz);
  float ep = abs(2.0 / p1 - 1.0 / p2 - iz);
  // At the screen edge only the side that exists will do.
  if (any(lessThan(a - 2.0 * e, vec2(0.0)))) em = 1e9;
  if (any(greaterThan(a + 2.0 * e, uAoMax))) ep = 1e9;
  return em < ep ? P - aoViewPos(a - e, m1) : aoViewPos(a + e, p1) - P;
}
void main() {
  vec2 a = floor(gl_FragCoord.xy);
  float z = linZ(a);
  if (z > 1500.0) { gl_FragColor = vec4(1.0); return; }
  vec3 P = aoViewPos(a, z);
  vec3 N = normalize(cross(tangent(a, vec2(1.0, 0.0), P, 1.0 / z), tangent(a, vec2(0.0, 1.0), P, 1.0 / z)));
  float radius = clamp(z * 0.012, 0.9, 7.0);
  float rPx = clamp(radius * uPx / z, 3.0, 64.0);
  // Bias grows with the size of a texel at this depth, so precision never reads as
  // occlusion near or far; the angle bias leaves flat ground at grazing angles open.
  float bias = 0.6 * z / uPx;
  const float ANGLE_BIAS = 0.12;
  // 4x4 Bayer rotation and radius jitter; the blur averages the pattern away.
  ivec2 ia = ivec2(a);
  int bx = ia.x & 3, by = ia.y & 3;
  int bayer = (((bx ^ by) & 1) << 3) | ((by & 1) << 2) | ((bx ^ by) & 2) | ((by >> 1) & 1);
  float rot = (float(bayer) + 0.5) * (6.2831853 / 16.0);
  float jit = fract(float(bayer) * 0.618034 + 0.25);
  // Taps step round a spiral by the golden angle, rotated rather than recomputed.
  vec2 dir = vec2(cos(rot), sin(rot));
  const mat2 GOLDEN = mat2(-0.7373688, 0.6754903, -0.6754903, -0.7373688);
  float fallK = 1.0 / (3.0 * radius * radius);
  float occ = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float t = (float(i) + jit) * (1.0 / float(SAMPLES));
    // Clamped here so the depth and the position come from the same texel.
    vec2 s = clamp(floor(a + 0.5 + dir * max(sqrt(t) * rPx, 1.5)), vec2(0.0), uAoMax);
    dir = GOLDEN * dir;
    float zs = linZ(s);
    vec3 v = aoViewPos(s, zs) - P;
    float len2 = dot(v, v) + 1e-8;
    float inv = inversesqrt(len2);
    float cosA = (dot(N, v) - bias) * inv;
    // Full weight out to one radius, none past two.
    float fall = clamp(4.0 / 3.0 - len2 * fallK, 0.0, 1.0);
    // Nearer occluders count for more, which keeps the dark line under cars and kerbs.
    float near = radius / (len2 * inv + 0.35 * radius);
    occ += max(cosA - ANGLE_BIAS, 0.0) * fall * near;
  }
  occ /= float(SAMPLES) * (1.0 - ANGLE_BIAS);
  float ao = clamp(1.0 - 1.6 * occ, 0.0, 1.0);
  ao = mix(ao, 1.0, smoothstep(600.0, 1500.0, z));
  gl_FragColor = vec4(ao, 0.0, 0.0, 1.0);
}
`;

const AO_BLUR_FS = /* glsl */ `
precision highp float;
uniform highp sampler2D tLin;
uniform sampler2D tAo;
uniform ivec2 uDir;
uniform ivec2 uAoMax;
float linZ(ivec2 a) { return texelFetch(tLin, clamp(a, ivec2(0), uAoMax), 0).r; }
void main() {
  ivec2 a = ivec2(gl_FragCoord.xy);
  float z = linZ(a);
  float iz = 1.0 / z;
  // Inverse depth along the blur line, predicted from the flatter neighbour, so ground
  // at a grazing angle (steep in depth, flat in inverse depth) still blurs as one surface.
  float sm = iz - 1.0 / linZ(a - uDir);
  float sp = 1.0 / linZ(a + uDir) - iz;
  float slope = abs(sm) < abs(sp) ? sm : sp;
  float sum = 0.0;
  float weight = 0.0;
  for (int i = -3; i <= 3; i++) {
    ivec2 s = clamp(a + uDir * i, ivec2(0), uAoMax);
    float err = abs(1.0 / linZ(s) - (iz + float(i) * slope)) * z;
    float w = exp(-0.125 * float(i * i)) * max(0.0, 1.0 - err * 50.0);
    sum += texelFetch(tAo, s, 0).r * w;
    weight += w;
  }
  gl_FragColor = vec4(sum / max(weight, 1e-4), 0.0, 0.0, 1.0);
}
`;

const DOWN_FS = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tMap;
uniform vec2 uTexel;
uniform float uThreshold;
void main() {
  vec2 t = uTexel;
  vec3 c = texture2D(tMap, vUv).rgb * 4.0;
  c += texture2D(tMap, vUv + t * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tMap, vUv + t * vec2(1.0, -1.0)).rgb;
  c += texture2D(tMap, vUv + t * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tMap, vUv + t * vec2(1.0, 1.0)).rgb;
  c /= 8.0;
  if (uThreshold > 0.0) {
    // Clamp first so one hot pixel cannot flicker across the whole bloom.
    c = min(c, vec3(24.0));
    float l = max(c.r, max(c.g, c.b));
    float knee = uThreshold * 0.5;
    float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    c *= max(soft, l - uThreshold) / max(l, 1e-4);
  }
  gl_FragColor = vec4(c, 1.0);
}
`;

const UP_FS = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tMap;
uniform sampler2D tBase;
uniform vec2 uTexel;
void main() {
  vec2 t = uTexel;
  vec3 c = texture2D(tMap, vUv + vec2(-t.x, 0.0)).rgb + texture2D(tMap, vUv + vec2(t.x, 0.0)).rgb;
  c += texture2D(tMap, vUv + vec2(0.0, -t.y)).rgb + texture2D(tMap, vUv + vec2(0.0, t.y)).rgb;
  c = c * 0.2 + texture2D(tMap, vUv).rgb * 0.2;
  gl_FragColor = vec4(texture2D(tBase, vUv).rgb + c, 1.0);
}
`;

const COMPOSITE_FS = /* glsl */ `
precision highp float;
varying vec2 vUv;
${DEPTH_FN}
uniform sampler2D tScene;
uniform sampler2D tAo;
uniform sampler2D tBloom;
uniform float uAo;
uniform float uBloom;
uniform vec2 uTan;
uniform mat3 uCamRot;
uniform vec3 uCamPos;
uniform vec3 uHaze;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uHazeDensity;
uniform float uDim;
void main() {
  vec3 col = texture2D(tScene, vUv).rgb;
  float z = viewDepth(vUv);
  if (uAo > 0.0) col *= mix(1.0, texture2D(tAo, vUv).r, uAo);
  vec3 rayV = vec3((vUv * 2.0 - 1.0) * uTan, -1.0);
  float len = length(rayV);
  vec3 dir = uCamRot * (rayV / len);
  if (z < 30000.0) {
    // Exponential height fog, integrated along the view ray.
    float dist = z * len;
    float k = 0.0011;
    float dy = abs(dir.y) < 1e-3 ? 1e-3 : dir.y;
    float atCam = exp(-k * max(uCamPos.y, 0.0));
    float optical = uHazeDensity * atCam * (1.0 - exp(-k * dist * dy)) / (k * dy);
    float T = exp(-optical);
    float sun = pow(max(dot(dir, uSunDir), 0.0), 7.0);
    vec3 scatter = uHaze + uSunCol * sun * 0.45;
    col = col * T + scatter * (1.0 - T);
  }
  col += texture2D(tBloom, vUv).rgb * uBloom;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  // Subtle lens falloff toward the corners.
  vec2 v = vUv - 0.5;
  gl_FragColor.rgb *= 1.0 - dot(v, v) * 0.06;
  // A touch of grade: filmic curves lift blacks and mute colour.
  float luma = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor.rgb = clamp(mix(vec3(luma), gl_FragColor.rgb, 1.02), 0.0, 1.0);
  gl_FragColor.rgb = clamp((gl_FragColor.rgb - 0.012) * 1.03, 0.0, 1.0);
  #include <colorspace_fragment>
}
`;

const BLOOM_LEVELS = 5;

function fsMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, opts: Partial<THREE.ShaderMaterialParameters> = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false, ...opts });
}

export class PostPipeline implements PostPipelineApi {
  sceneTarget: THREE.WebGLRenderTarget | null = null;
  private aoTarget: THREE.WebGLRenderTarget | null = null;
  private aoBlurTarget: THREE.WebGLRenderTarget | null = null;
  /** Linear view depth at AO resolution, 32-bit float. */
  private aoDepthTarget: THREE.WebGLRenderTarget | null = null;
  private bloomDown: THREE.WebGLRenderTarget[] = [];
  private bloomUp: THREE.WebGLRenderTarget[] = [];
  private fsq = new FullScreenQuad();
  private settings: QualitySettings | null = null;
  private width = 1;
  private height = 1;
  private effects: HdrEffect[] = [];
  private fallback = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  private black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);

  private aoDepthMat: THREE.ShaderMaterial;
  private aoMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private downMat: THREE.ShaderMaterial;
  private upMat: THREE.ShaderMaterial;
  readonly composite: THREE.ShaderMaterial;
  /** Multiplied into bloom. Raised at night, when lamps should glow. */
  bloomStrength = 0.12;
  /** Benchmark hook: told as the frame's GPU work moves between phases (render/profile.ts). */
  phase: ((p: GpuPhase | null) => void) | null = null;

  constructor(
    private readonly gl: THREE.WebGLRenderer,
    far: number,
  ) {
    // Clears are explicit: the overlay pass draws on top of the finished image.
    gl.autoClear = false;
    const depthUniforms = () => ({ tDepth: { value: null as THREE.Texture | null }, uLogFar: { value: FAR_LOG(far) } });
    // Shared uniform objects between the AO passes: set once per frame in runAo.
    const recon = {
      uFull: { value: new THREE.Vector2(1, 1) },
      uScale: { value: new THREE.Vector2(1, 1) },
      uPosScale: { value: new THREE.Vector2() },
      uPosBias: { value: new THREE.Vector2() },
    };
    const aoMax = { value: new THREE.Vector2() };
    const lin = { value: null as THREE.Texture | null };
    this.aoDepthMat = fsMaterial(AO_DEPTH_FS, { ...depthUniforms(), ...recon });
    this.aoMat = fsMaterial(AO_FS, { ...recon, tLin: lin, uAoMax: aoMax, uPx: { value: 1 } });
    this.blurMat = fsMaterial(AO_BLUR_FS, { tLin: lin, tAo: { value: null }, uDir: { value: new THREE.Vector2() }, uAoMax: aoMax });
    this.downMat = fsMaterial(DOWN_FS, { tMap: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0 } });
    this.upMat = fsMaterial(UP_FS, { tMap: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.composite = fsMaterial(
      COMPOSITE_FS,
      {
        ...depthUniforms(),
        tScene: { value: null },
        tAo: { value: this.fallback },
        tBloom: { value: this.black },
        uAo: { value: 0 },
        uBloom: { value: 0 },
        uTan: { value: new THREE.Vector2() },
        uCamRot: { value: new THREE.Matrix3() },
        uCamPos: { value: new THREE.Vector3() },
        uHaze: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3() },
        uSunCol: { value: new THREE.Color() },
        uHazeDensity: { value: 0.00016 },
        uDim: { value: 0 },
      },
      { toneMapped: true },
    );
    this.fallback.needsUpdate = true;
    this.black.needsUpdate = true;
  }

  addHdrEffect(effect: HdrEffect): () => void {
    this.effects.push(effect);
    return () => {
      this.effects = this.effects.filter((e) => e !== effect);
    };
  }

  private disposeTargets(): void {
    this.sceneTarget?.depthTexture?.dispose();
    this.sceneTarget?.dispose();
    this.aoTarget?.dispose();
    this.aoBlurTarget?.dispose();
    this.aoDepthTarget?.dispose();
    for (const t of [...this.bloomDown, ...this.bloomUp]) t.dispose();
    this.sceneTarget = this.aoTarget = this.aoBlurTarget = this.aoDepthTarget = null;
    this.bloomDown = [];
    this.bloomUp = [];
  }

  private rebuild(): void {
    this.disposeTargets();
    const q = this.settings;
    if (!q || !q.post) return;
    const w = this.width;
    const h = this.height;
    const depth = new THREE.DepthTexture(w, h, THREE.UnsignedInt248Type);
    depth.format = THREE.DepthStencilFormat;
    this.sceneTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      samples: q.msaa,
      depthBuffer: true,
      stencilBuffer: true,
      depthTexture: depth,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    // Linear depth needs a float colour target; without one, no AO rather than banded AO.
    if (q.ao > 0 && this.gl.extensions.has('EXT_color_buffer_float')) {
      const aw = Math.max(1, Math.round(w * q.ao));
      const ah = Math.max(1, Math.round(h * q.ao));
      const opts = { depthBuffer: false, format: THREE.RedFormat, type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
      this.aoTarget = new THREE.WebGLRenderTarget(aw, ah, opts);
      this.aoBlurTarget = new THREE.WebGLRenderTarget(aw, ah, opts);
      this.aoDepthTarget = new THREE.WebGLRenderTarget(aw, ah, { depthBuffer: false, format: THREE.RedFormat, type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    }
    if (q.bloom) {
      let bw = Math.max(2, w >> 1);
      let bh = Math.max(2, h >> 1);
      for (let i = 0; i < BLOOM_LEVELS; i++) {
        const opts = { depthBuffer: false, type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
        this.bloomDown.push(new THREE.WebGLRenderTarget(bw, bh, opts));
        this.bloomUp.push(new THREE.WebGLRenderTarget(bw, bh, opts));
        bw = Math.max(2, bw >> 1);
        bh = Math.max(2, bh >> 1);
      }
    }
    const depthTex = this.sceneTarget.depthTexture;
    this.aoDepthMat.uniforms.tDepth.value = depthTex;
    this.aoMat.uniforms.tLin.value = this.aoDepthTarget?.texture ?? null;
    this.composite.uniforms.tDepth.value = depthTex;
    this.composite.uniforms.tScene.value = this.sceneTarget.texture;
  }

  setQuality(q: QualitySettings): void {
    this.settings = q;
    const samples = Math.max(4, q.aoSamples || 10);
    if (this.aoMat.defines.SAMPLES !== samples) {
      this.aoMat.defines.SAMPLES = samples;
      this.aoMat.needsUpdate = true;
    }
    this.rebuild();
  }

  /** Size in device pixels. */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.rebuild();
  }

  private pass(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.fsq.material = material;
    this.gl.setRenderTarget(target);
    this.fsq.render(this.gl);
  }

  private runAo(camera: THREE.PerspectiveCamera): void {
    if (!this.aoTarget || !this.aoBlurTarget || !this.aoDepthTarget) return;
    const aw = this.aoTarget.width;
    const ah = this.aoTarget.height;
    const tanH = Math.tan((camera.fov * Math.PI) / 360);
    const u = this.aoMat.uniforms;
    // Shared with the depth and blur passes.
    const [sx, bx] = aoPosScaleBias(tanH * camera.aspect, this.width);
    const [sy, by] = aoPosScaleBias(tanH, this.height);
    u.uPosScale.value.set(sx, sy);
    u.uPosBias.value.set(bx, by);
    u.uFull.value.set(this.width, this.height);
    u.uScale.value.set(this.width / aw, this.height / ah);
    u.uAoMax.value.set(aw - 1, ah - 1);
    u.uPx.value = ah / (2 * tanH);
    this.pass(this.aoDepthMat, this.aoDepthTarget);
    this.pass(this.aoMat, this.aoTarget);
    const b = this.blurMat.uniforms;
    b.tAo.value = this.aoTarget.texture;
    b.uDir.value.set(1, 0);
    this.pass(this.blurMat, this.aoBlurTarget);
    b.tAo.value = this.aoBlurTarget.texture;
    b.uDir.value.set(0, 1);
    this.pass(this.blurMat, this.aoTarget);
  }

  private runBloom(): THREE.Texture | null {
    const down = this.bloomDown;
    if (!down.length || !this.sceneTarget) return null;
    const d = this.downMat.uniforms;
    let src: THREE.Texture = this.sceneTarget.texture;
    let w = this.width;
    let h = this.height;
    for (let i = 0; i < down.length; i++) {
      d.tMap.value = src;
      d.uTexel.value.set(1 / w, 1 / h);
      d.uThreshold.value = i === 0 ? 1.15 : 0;
      this.pass(this.downMat, down[i]);
      src = down[i].texture;
      w = down[i].width;
      h = down[i].height;
    }
    const up = this.upMat.uniforms;
    let last: THREE.Texture = down[down.length - 1].texture;
    for (let i = down.length - 2; i >= 0; i--) {
      up.tMap.value = last;
      up.tBase.value = down[i].texture;
      up.uTexel.value.set(1 / down[i + 1].width, 1 / down[i + 1].height);
      this.pass(this.upMat, this.bloomUp[i]);
      last = this.bloomUp[i].texture;
    }
    return last;
  }

  /** Draw the scene and finish the frame on screen. */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, overlay: THREE.Scene): void {
    const gl = this.gl;
    const target = this.sceneTarget;
    const phase = this.phase;
    phase?.('shadow');
    if (!target) {
      gl.setRenderTarget(null);
      gl.clear();
      gl.render(scene, camera);
    } else {
      gl.setRenderTarget(target);
      gl.clear();
      gl.render(scene, camera);
      phase?.('post');
      this.runAo(camera);
      // Bloom is scaled by night: by day it adds nothing, so its ten passes are skipped.
      const bloom = this.bloomStrength > 0.004 ? this.runBloom() : null;
      const c = this.composite.uniforms;
      const tanH = Math.tan((camera.fov * Math.PI) / 360);
      c.uTan.value.set(tanH * camera.aspect, tanH);
      c.uCamRot.value.setFromMatrix4(camera.matrixWorld);
      c.uCamPos.value.copy(camera.position);
      c.tAo.value = this.aoTarget ? this.aoTarget.texture : this.fallback;
      c.uAo.value = this.aoTarget ? 0.9 : 0;
      c.tBloom.value = bloom ?? this.black;
      c.uBloom.value = bloom ? this.bloomStrength : 0;
      this.pass(this.composite, null);
    }
    phase?.('overlay');
    gl.setRenderTarget(null);
    gl.render(overlay, camera);
    phase?.(null);
  }

  /** Atmosphere inputs, set when the time of day changes. */
  setAtmosphere(haze: THREE.Color, sunDir: THREE.Vector3, sunColour: THREE.Color, density: number): void {
    const c = this.composite.uniforms;
    c.uHaze.value.copy(haze);
    c.uSunDir.value.copy(sunDir);
    c.uSunCol.value.copy(sunColour);
    c.uHazeDensity.value = density;
  }

  dispose(): void {
    this.disposeTargets();
    this.fsq.dispose();
    for (const m of [this.aoDepthMat, this.aoMat, this.blurMat, this.downMat, this.upMat, this.composite]) m.dispose();
    this.fallback.dispose();
    this.black.dispose();
  }
}
