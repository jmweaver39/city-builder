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

const AO_FS = /* glsl */ `
precision highp float;
varying vec2 vUv;
${DEPTH_FN}
uniform vec2 uTan;
uniform vec2 uTexel;
uniform float uPx;
const int SAMPLES = 10;
vec3 viewPos(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0) * uTan * z, -z); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  float z = viewDepth(vUv);
  if (z > 1500.0) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPos(vUv, z);
  // Normal from whichever neighbour is closer on each axis, so edges stay clean.
  float zl = viewDepth(vUv - vec2(uTexel.x, 0.0));
  float zr = viewDepth(vUv + vec2(uTexel.x, 0.0));
  float zd = viewDepth(vUv - vec2(0.0, uTexel.y));
  float zu = viewDepth(vUv + vec2(0.0, uTexel.y));
  vec3 dx = abs(zl - z) < abs(zr - z) ? P - viewPos(vUv - vec2(uTexel.x, 0.0), zl) : viewPos(vUv + vec2(uTexel.x, 0.0), zr) - P;
  vec3 dy = abs(zd - z) < abs(zu - z) ? P - viewPos(vUv - vec2(0.0, uTexel.y), zd) : viewPos(vUv + vec2(0.0, uTexel.y), zu) - P;
  vec3 N = normalize(cross(dx, dy));
  float radius = clamp(z * 0.012, 0.9, 7.0);
  float rPx = clamp(radius * uPx / z, 2.5, 70.0);
  float phase = ign(gl_FragCoord.xy) * 6.2831853;
  float occ = 0.0;
  float bias = 0.012 * radius;
  for (int i = 0; i < SAMPLES; i++) {
    float t = (float(i) + 0.5) / float(SAMPLES);
    float a = phase + t * 24.0;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * sqrt(t) * rPx * uTexel;
    float zs = viewDepth(uv);
    vec3 v = viewPos(uv, zs) - P;
    float len2 = dot(v, v);
    float fall = 1.0 - smoothstep(0.25, 1.0, len2 / (radius * radius * 4.0));
    occ += max(dot(N, v) - bias, 0.0) / (len2 + 0.05 * radius * radius) * fall * radius;
  }
  occ /= float(SAMPLES);
  float ao = clamp(1.0 - 1.1 * occ, 0.0, 1.0);
  ao = mix(ao, 1.0, smoothstep(600.0, 1500.0, z));
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}
`;

const AO_BLUR_FS = /* glsl */ `
precision highp float;
varying vec2 vUv;
${DEPTH_FN}
uniform sampler2D tAo;
uniform vec2 uStep;
void main() {
  float z = viewDepth(vUv);
  float sum = 0.0;
  float weight = 0.0;
  for (int i = -3; i <= 3; i++) {
    vec2 uv = vUv + uStep * float(i);
    float zs = viewDepth(uv);
    float w = exp(-abs(zs - z) / (0.02 * z + 0.05)) * (1.0 - abs(float(i)) * 0.12);
    sum += texture2D(tAo, uv).r * w;
    weight += w;
  }
  float ao = sum / max(weight, 1e-4);
  gl_FragColor = vec4(ao, ao, ao, 1.0);
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
  private bloomDown: THREE.WebGLRenderTarget[] = [];
  private bloomUp: THREE.WebGLRenderTarget[] = [];
  private fsq = new FullScreenQuad();
  private settings: QualitySettings | null = null;
  private width = 1;
  private height = 1;
  private effects: HdrEffect[] = [];
  private fallback = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  private black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);

  private aoMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private downMat: THREE.ShaderMaterial;
  private upMat: THREE.ShaderMaterial;
  readonly composite: THREE.ShaderMaterial;
  /** Multiplied into bloom. Raised at night, when lamps should glow. */
  bloomStrength = 0.12;

  constructor(
    private readonly gl: THREE.WebGLRenderer,
    far: number,
  ) {
    // Clears are explicit: the overlay pass draws on top of the finished image.
    gl.autoClear = false;
    const depthUniforms = () => ({ tDepth: { value: null as THREE.Texture | null }, uLogFar: { value: FAR_LOG(far) } });
    this.aoMat = fsMaterial(AO_FS, { ...depthUniforms(), uTan: { value: new THREE.Vector2() }, uTexel: { value: new THREE.Vector2() }, uPx: { value: 1 } });
    this.blurMat = fsMaterial(AO_BLUR_FS, { ...depthUniforms(), tAo: { value: null }, uStep: { value: new THREE.Vector2() } });
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
    for (const t of [...this.bloomDown, ...this.bloomUp]) t.dispose();
    this.sceneTarget = this.aoTarget = this.aoBlurTarget = null;
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
    if (q.ao > 0) {
      const aw = Math.max(1, Math.round(w * q.ao));
      const ah = Math.max(1, Math.round(h * q.ao));
      const opts = { depthBuffer: false, format: THREE.RGBAFormat, type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
      this.aoTarget = new THREE.WebGLRenderTarget(aw, ah, opts);
      this.aoBlurTarget = new THREE.WebGLRenderTarget(aw, ah, opts);
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
    this.aoMat.uniforms.tDepth.value = depthTex;
    this.blurMat.uniforms.tDepth.value = depthTex;
    this.composite.uniforms.tDepth.value = depthTex;
    this.composite.uniforms.tScene.value = this.sceneTarget.texture;
  }

  setQuality(q: QualitySettings): void {
    this.settings = q;
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
    if (!this.aoTarget || !this.aoBlurTarget) return;
    const tanH = Math.tan((camera.fov * Math.PI) / 360);
    const u = this.aoMat.uniforms;
    u.uTan.value.set(tanH * camera.aspect, tanH);
    u.uTexel.value.set(1 / this.aoTarget.width, 1 / this.aoTarget.height);
    u.uPx.value = this.aoTarget.height / (2 * tanH);
    this.pass(this.aoMat, this.aoTarget);
    const b = this.blurMat.uniforms;
    b.tAo.value = this.aoTarget.texture;
    b.uStep.value.set(1 / this.aoTarget.width, 0);
    this.pass(this.blurMat, this.aoBlurTarget);
    b.tAo.value = this.aoBlurTarget.texture;
    b.uStep.value.set(0, 1 / this.aoTarget.height);
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
    if (!target) {
      gl.setRenderTarget(null);
      gl.clear();
      gl.render(scene, camera);
    } else {
      gl.setRenderTarget(target);
      gl.clear();
      gl.render(scene, camera);
      this.runAo(camera);
      const bloom = this.runBloom();
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
    gl.setRenderTarget(null);
    gl.render(overlay, camera);
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
    for (const m of [this.aoMat, this.blurMat, this.downMat, this.upMat, this.composite]) m.dispose();
    this.fallback.dispose();
    this.black.dispose();
  }
}
