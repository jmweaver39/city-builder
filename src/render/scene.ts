/** Scene, physical sky, sun, image-based ambient and the time-of-day cycle. */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { Shared } from './materials';

/** Stars, a moon and a faint night gradient, added on top of the day sky. */
const NIGHT_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const NIGHT_FRAGMENT = /* glsl */ `
uniform float uNight;
uniform vec3 uMoonDir;
uniform vec3 uTop;
uniform vec3 uHorizon;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 0.5, pow(h, 0.7)));
  vec3 cell = floor(d * 900.0);
  float s = fract(sin(dot(cell, vec3(12.98, 78.23, 37.72))) * 43758.5453);
  col += vec3(0.75, 0.8, 1.0) * step(0.9992, s) * smoothstep(0.02, 0.3, d.y) * fract(s * 91.7) * 1.6;
  float m = dot(d, uMoonDir);
  col += vec3(0.9, 0.93, 1.0) * (smoothstep(0.99975, 0.99985, m) * 2.2 + pow(max(m, 0.0), 600.0) * 0.12);
  gl_FragColor = vec4(col * uNight, 1.0);
  #include <colorspace_fragment>
}
`;

interface Keyframe {
  /** sin(sun elevation) at which this applies. */
  at: number;
  top: THREE.Color;
  horizon: THREE.Color;
  sun: THREE.Color;
  sunI: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiI: number;
}

const c = (hex: number) => new THREE.Color(hex);
const UNDERGROUND_BG = c(0x0c1420);
const SKY_GAIN = 0.5;
const ENV_INTENSITY = 0.36;

const KEYS: Keyframe[] = [
  { at: -0.35, top: c(0x08101f), horizon: c(0x1b2a45), sun: c(0xa8bce8), sunI: 1.25, hemiSky: c(0x5a74b0), hemiGround: c(0x20283a), hemiI: 1.5 },
  { at: -0.08, top: c(0x141c3a), horizon: c(0x46395a), sun: c(0xa4a8d0), sunI: 0.9, hemiSky: c(0x5d6ca0), hemiGround: c(0x22222c), hemiI: 1.35 },
  { at: 0.03, top: c(0x2f4a80), horizon: c(0xe8976a), sun: c(0xff9050), sunI: 2.6, hemiSky: c(0xb0a8b8), hemiGround: c(0x4a3e34), hemiI: 0.6 },
  { at: 0.2, top: c(0x4f86c6), horizon: c(0xf2d8bc), sun: c(0xffd6a0), sunI: 4.0, hemiSky: c(0xd8d4c8), hemiGround: c(0x6f6a50), hemiI: 0.62 },
  { at: 0.55, top: c(0x4a8ad0), horizon: c(0xc9dfee), sun: c(0xfff0dc), sunI: 4.8, hemiSky: c(0xdcdcd4), hemiGround: c(0x77725a), hemiI: 0.62 },
  { at: 1, top: c(0x3f82cc), horizon: c(0xc4dcee), sun: c(0xfff4e6), sunI: 5.0, hemiSky: c(0xdcdcd4), hemiGround: c(0x77725a), hemiI: 0.62 },
];

export class SceneRig {
  readonly scene = new THREE.Scene();
  /** Drawn straight to the screen, after tone mapping. */
  readonly overlayScene = new THREE.Scene();
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.3);
  readonly fog = new THREE.Fog(0xc9dfee, 1500, 8000);
  /** Colour of the haze for the current hour, linear. */
  readonly haze = new THREE.Color();
  readonly skyTop = new THREE.Color();
  private sky: Sky;
  private night: THREE.Mesh;
  private nightMat: THREE.ShaderMaterial;
  private envScene = new THREE.Scene();
  private envSky: Sky;
  private pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envHour = NaN;
  private envAge = 0;
  private hours = 11;
  private shadowRadius = 0;
  private shadowsOn = true;
  private shadowMin = 110;
  private underground = false;
  /** Unit vector toward the sun or, at night, the moon. */
  readonly lightDir = new THREE.Vector3(0.4, 0.8, 0.3);
  readonly sunVector = new THREE.Vector3();

  constructor(
    private readonly shared: Shared,
    gl: THREE.WebGLRenderer,
  ) {
    this.scene.add(this.hemi);
    const sun = this.sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.00025;
    sun.shadow.normalBias = 0.5;
    sun.shadow.radius = 2;
    sun.shadow.camera.near = 50;
    sun.shadow.camera.far = 7000;
    this.scene.add(sun, sun.target);

    this.sky = this.makeSky();
    this.sky.renderOrder = -100;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.envSky = this.makeSky();
    this.envScene.add(this.envSky);
    // The world below the horizon, so reflections and ambient are not lit from under.
    const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x39452c }));
    ground.position.y = -1;
    this.envScene.add(ground);

    this.nightMat = new THREE.ShaderMaterial({
      vertexShader: NIGHT_VERTEX,
      fragmentShader: NIGHT_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: {
        uNight: shared.uNight,
        uMoonDir: { value: new THREE.Vector3(0.35, 0.8, -0.45).normalize() },
        uTop: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
      },
    });
    this.night = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 12), this.nightMat);
    this.night.frustumCulled = false;
    this.night.renderOrder = -99;
    this.scene.add(this.night);

    this.pmrem = new THREE.PMREMGenerator(gl);
    this.setTimeOfDay(this.hours);
  }

  private makeSky(): Sky {
    const sky = new Sky();
    sky.scale.setScalar(20);
    sky.material.toneMapped = false;
    // The addon's radiance is scaled for a low exposure. Bring it to the sun's scale.
    sky.material.fragmentShader = sky.material.fragmentShader.replace('#include <tonemapping_fragment>', `gl_FragColor.rgb *= ${SKY_GAIN.toFixed(2)};\n#include <tonemapping_fragment>`);
    const u = sky.material.uniforms;
    u.cloudCoverage.value = 0.34;
    u.cloudDensity.value = 0.45;
    u.cloudElevation.value = 0.55;
    return sky;
  }

  getTimeOfDay(): number {
    return this.hours;
  }

  setTimeOfDay(hours: number): void {
    const h = ((hours % 24) + 24) % 24;
    this.hours = h;
    const dayPhase = ((h - 6) / 12) * Math.PI;
    const elev = Math.sin(dayPhase);
    // Sun swings east to west, a little south of overhead.
    const sunVec = new THREE.Vector3(-Math.cos(dayPhase), elev * 0.86, 0.5).normalize();
    const k = Math.max(-0.35, Math.min(1, sunVec.y));
    let i = 0;
    while (i + 2 < KEYS.length && KEYS[i + 1].at < k) i++;
    const a = KEYS[i];
    const b = KEYS[i + 1];
    const t = (k - a.at) / (b.at - a.at);
    const mix = (x: THREE.Color, y: THREE.Color, out: THREE.Color) => out.copy(x).lerp(y, t);
    const u = this.nightMat.uniforms;
    mix(a.top, b.top, u.uTop.value);
    mix(a.horizon, b.horizon, u.uHorizon.value);
    this.haze.copy(u.uHorizon.value);
    this.skyTop.copy(u.uTop.value);
    this.fog.color.copy(this.haze);
    mix(a.sun, b.sun, this.sun.color);
    this.sun.intensity = a.sunI + (b.sunI - a.sunI) * t;
    mix(a.hemiSky, b.hemiSky, this.hemi.color);
    mix(a.hemiGround, b.hemiGround, this.hemi.groundColor);
    this.hemi.intensity = a.hemiI + (b.hemiI - a.hemiI) * t;

    const isDay = sunVec.y > 0.02;
    this.sunVector.copy(sunVec);
    // Dust and low sun warm the air; clear noon keeps it blue.
    const low = 1 - THREE.MathUtils.smoothstep(sunVec.y, 0.02, 0.45);
    for (const sky of [this.sky, this.envSky]) {
      const su = sky.material.uniforms;
      su.sunPosition.value.copy(sunVec);
      su.turbidity.value = 2.4 + low * 5;
      su.rayleigh.value = 1.9 + low * 1.2;
      su.mieCoefficient.value = 0.004 + low * 0.004;
      su.mieDirectionalG.value = 0.8;
      su.cloudCoverage.value = 0.34 * (1 - 0.6 * (1 - THREE.MathUtils.smoothstep(sunVec.y, -0.1, 0.1)));
    }
    // Below the horizon the key light turns into a high moon.
    if (isDay) this.lightDir.copy(sunVec);
    else this.lightDir.set(0.35, 0.8, -0.45).normalize();
    if (sunVec.y < 0.1 && sunVec.y > 0.02) this.lightDir.y = Math.max(this.lightDir.y, 0.1);
    this.lightDir.normalize();
    this.shared.uNight.value = 1 - THREE.MathUtils.smoothstep(sunVec.y, -0.08, 0.12);
  }

  /** The sky gives way to a dark void so buried roads stand out. */
  setUnderground(on: boolean): void {
    this.underground = on;
    this.sky.visible = !on;
    this.night.visible = !on;
    this.scene.background = on ? UNDERGROUND_BG : null;
  }

  /** Fog is drawn by the post pipeline when there is one, and by materials when not. */
  setMaterialFog(on: boolean): void {
    this.scene.fog = on ? this.fog : null;
  }

  /** Recapture the sky into the environment when the hour has moved. Returns the map. */
  updateEnvironment(dt: number): THREE.Texture | null {
    this.envAge += dt;
    const fresh = this.envTarget && Math.abs(this.hours - this.envHour) < 0.05;
    // A dragged time slider should not capture every frame.
    if (fresh || (this.envTarget && this.envAge < 0.2)) return this.envTarget?.texture ?? null;
    this.envAge = 0;
    this.envHour = this.hours;
    const old = this.envTarget;
    const nightGain = this.shared.uNight.value;
    // Night sky adds to nothing, so give the capture a little moonlit air.
    this.envScene.background = nightGain > 0.01 ? _nightAir.copy(this.haze).multiplyScalar(0.55 * nightGain) : null;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0.015, 0.1, 100);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = ENV_INTENSITY;
    old?.dispose();
    return this.envTarget.texture;
  }

  setShadowSize(size: number): void {
    const s = this.sun.shadow;
    if (s.mapSize.x === size) return;
    s.mapSize.set(size, size);
    s.map?.dispose();
    (s as { map: THREE.WebGLRenderTarget | null }).map = null;
    this.shadowMin = size >= 4096 ? 110 : 170;
  }

  setShadows(on: boolean): void {
    this.shadowsOn = on;
    this.sun.castShadow = on;
  }

  /** Keep the sky on the camera, and the shadow box around what is in view. */
  update(camera: THREE.PerspectiveCamera, focus: THREE.Vector3, distance: number): void {
    this.sky.position.copy(camera.position);
    this.night.position.copy(camera.position);
    for (const sky of [this.sky, this.envSky]) sky.material.uniforms.time.value = this.shared.uTime.value;
    const sun = this.sun;
    if (!this.shadowsOn) return;
    // Quantise the box so it does not rescale, and shimmer, on every zoom step.
    const want = Math.min(1900, Math.max(this.shadowMin, distance * 1.25));
    const radius = Math.pow(1.2, Math.ceil(Math.log(want) / Math.log(1.2)));
    const cam = sun.shadow.camera;
    if (radius !== this.shadowRadius) {
      this.shadowRadius = radius;
      cam.left = cam.bottom = -radius;
      cam.right = cam.top = radius;
      cam.updateProjectionMatrix();
    }
    // Snap to whole shadow texels along the light's own axes.
    const size = sun.shadow.mapSize.x;
    const texel = (2 * radius) / size;
    const dir = this.lightDir;
    const right = _r.set(0, 1, 0).cross(dir).normalize();
    const up = _u.copy(dir).cross(right).normalize();
    const px = Math.round(focus.dot(right) / texel) * texel;
    const py = Math.round(focus.dot(up) / texel) * texel;
    const pz = focus.dot(dir);
    _t.copy(right).multiplyScalar(px).addScaledVector(up, py).addScaledVector(dir, pz);
    sun.target.position.copy(_t);
    sun.position.copy(_t).addScaledVector(dir, 3200);
    sun.target.updateMatrixWorld();
  }

  /** Fog stays out of the map at any zoom, and always swallows the mesh edge. */
  updateFog(distance: number): void {
    const near = 900 + distance * 1.15;
    this.fog.near = near;
    this.fog.far = near * 1.5 + 3400;
  }

  dispose(): void {
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.envSky.geometry.dispose();
    this.envSky.material.dispose();
    this.night.geometry.dispose();
    this.nightMat.dispose();
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.sun.shadow.map?.dispose();
  }
}

const _nightAir = new THREE.Color();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _t = new THREE.Vector3();
