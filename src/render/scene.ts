/** Scene, physical sky, sun, image-based ambient and the time-of-day cycle. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE, paintFacets, rgb } from './style';
import type { Shared } from './materials';

/** Stylised day sky: banded gradient, a crisp sun disc with a soft halo. */
const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uDay;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 0.55, h));
  // Below the horizon, a slightly deeper band so hills sit on it.
  col = mix(col, uHorizon * 0.86, smoothstep(0.0, -0.08, h));
  float sun = dot(d, uSunDir);
  col += uSunCol * pow(max(sun, 0.0), 24.0) * 0.35 * uDay;
  col = mix(col, uSunCol * 2.4, smoothstep(0.9988, 0.9991, sun) * uDay);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

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
const ENV_INTENSITY = 0.55;

const KEYS: Keyframe[] = [
  { at: -0.35, top: c(0x0e1838), horizon: c(0x2a3a66), sun: c(0xb8c2dc), sunI: 1.0, hemiSky: c(0x5a6484), hemiGround: c(0x242830), hemiI: 1.1 },
  { at: -0.08, top: c(0x22305c), horizon: c(0x7a5a7c), sun: c(0xa4a8d0), sunI: 0.9, hemiSky: c(0x5d6ca0), hemiGround: c(0x22222c), hemiI: 1.35 },
  { at: 0.03, top: c(0x4a6ab0), horizon: c(0xf6a46a), sun: c(0xff9050), sunI: 2.6, hemiSky: c(0xb0a8b8), hemiGround: c(0x4a3e34), hemiI: 0.6 },
  { at: 0.2, top: c(0x5aa4e4), horizon: c(0xf6dcb4), sun: c(0xffd6a0), sunI: 4.0, hemiSky: c(0xe4e8f0), hemiGround: c(0x7a7a5a), hemiI: 0.95 },
  { at: 0.55, top: c(0x5fb0ec), horizon: c(0xcfeaf6), sun: c(0xfff0dc), sunI: 4.8, hemiSky: c(0xe4e8f0), hemiGround: c(0x7a7a5a), hemiI: 0.95 },
  { at: 1, top: c(0x58aaea), horizon: c(0xcdeaf6), sun: c(0xfff4e6), sunI: 5.0, hemiSky: c(0xe4e8f0), hemiGround: c(0x7a7a5a), hemiI: 0.95 },
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
  private sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private clouds: THREE.Mesh;
  private night: THREE.Mesh;
  private nightMat: THREE.ShaderMaterial;
  private envScene = new THREE.Scene();
  private envSky: THREE.Mesh;
  private pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envHour = NaN;
  private envAge = 0;
  private hours = 11;
  private shadowRadius = 0;
  private shadowsOn = true;
  private shadowMin = 110;
  private underground = false;
  private shadowKey = new Float64Array(8);
  private shadowEvery = 1;
  private shadowAge = 0;
  private shadowDirty = true;
  /** Unit vector toward the sun or, at night, the moon. */
  readonly lightDir = new THREE.Vector3(0.4, 0.8, 0.3);
  readonly sunVector = new THREE.Vector3();

  constructor(
    private readonly shared: Shared,
    private readonly gl: THREE.WebGLRenderer,
  ) {
    this.scene.add(this.hemi);
    const sun = this.sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.00025;
    sun.shadow.normalBias = 0.5;
    sun.shadow.radius = 3.2;
    sun.shadow.camera.near = 50;
    sun.shadow.camera.far = 7000;
    this.scene.add(sun, sun.target);

    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      uniforms: {
        uTop: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunCol: { value: new THREE.Color(PALETTE.sun) },
        uDay: { value: 1 },
      },
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), this.skyMat);
    this.sky.renderOrder = -100;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.envSky = new THREE.Mesh(new THREE.SphereGeometry(20, 24, 12), this.skyMat);
    this.envScene.add(this.envSky);
    this.clouds = makeClouds();
    // The map look is clear from above; clouds would sit between the camera and the land.
    this.clouds.visible = false;
    this.scene.add(this.clouds);
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

  getTimeOfDay(): number {
    return this.hours;
  }

  setTimeOfDay(hours: number): void {
    const h = ((hours % 24) + 24) % 24;
    this.hours = h;
    const dayPhase = ((h - 6) / 12) * Math.PI;
    const elev = Math.sin(dayPhase);
    // Sun swings east to west, a little south of overhead.
    const sunVec = new THREE.Vector3(-Math.cos(dayPhase), elev * 1.15, 0.42).normalize();
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
    const su = this.skyMat.uniforms;
    su.uTop.value.copy(u.uTop.value);
    su.uHorizon.value.copy(u.uHorizon.value);
    su.uSunDir.value.copy(sunVec);
    su.uSunCol.value.copy(this.sun.color);
    su.uDay.value = THREE.MathUtils.smoothstep(sunVec.y, -0.05, 0.05);
    // Clouds take the light of the hour: white by day, warm at dusk, dim blue at night.
    const cm = this.clouds.material as THREE.MeshStandardMaterial;
    cm.emissive.copy(u.uHorizon.value).multiplyScalar(0.25);
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
    this.shadowDirty = true;
    this.shadowMin = size >= 4096 ? 110 : 170;
  }

  setShadows(on: boolean): void {
    this.shadowsOn = on;
    this.sun.castShadow = on;
    this.shadowDirty = true;
  }

  /**
   * How far from the camera's focus, on the ground, the shadow map can show a caster:
   * the box's half size stretched along a low sun. 0 with shadows off.
   */
  get shadowReach(): number {
    if (!this.shadowsOn || !this.shadowRadius) return 0;
    return this.shadowRadius / Math.max(0.3, this.lightDir.y) + 30;
  }

  /** Keep the sky on the camera, and the shadow box around what is in view. */
  update(camera: THREE.PerspectiveCamera, focus: THREE.Vector3, distance: number): void {
    this.sky.position.copy(camera.position);
    this.night.position.copy(camera.position);
    // Clouds drift east, wrapping round the map.
    const drift = (this.shared.uTime.value * 4) % 12000;
    this.clouds.position.set(drift > 6000 ? drift - 12000 : drift, 0, 0);
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
    // Depth along the light is snapped coarsely too (near and far have metres to spare),
    // so a cached shadow map stays valid while the focus only rises or falls.
    const pz = Math.round(focus.dot(dir) / 4) * 4;
    _t.copy(right).multiplyScalar(px).addScaledVector(up, py).addScaledVector(dir, pz);
    sun.target.position.copy(_t);
    sun.position.copy(_t).addScaledVector(dir, 3200);
    sun.target.updateMatrixWorld();
    // Cached shadows: redraw when the box or the light moved, when told the scene
    // changed, and every shadowEvery frames regardless, for moving casters.
    const k = this.shadowKey;
    if (k[0] !== px || k[1] !== py || k[2] !== pz || k[3] !== radius || k[4] !== dir.x || k[5] !== dir.y || k[6] !== dir.z || k[7] !== size) {
      k[0] = px;
      k[1] = py;
      k[2] = pz;
      k[3] = radius;
      k[4] = dir.x;
      k[5] = dir.y;
      k[6] = dir.z;
      k[7] = size;
      this.shadowDirty = true;
    }
    if (this.shadowEvery > 1) {
      this.shadowAge++;
      if (this.shadowDirty || this.shadowAge >= this.shadowEvery) {
        this.gl.shadowMap.needsUpdate = true;
        this.shadowAge = 0;
        this.shadowDirty = false;
      }
    }
  }

  /** Something that casts shadows changed: redraw the shadow map on the next frame. */
  invalidateShadows(): void {
    this.shadowDirty = true;
  }

  /** Redraw the shadow map at least every n frames, and otherwise only when needed. 1 is every frame. */
  setShadowEvery(n: number): void {
    this.shadowEvery = Math.max(1, Math.round(n));
    this.gl.shadowMap.autoUpdate = this.shadowEvery <= 1;
    this.shadowDirty = true;
  }

  /** Fog stays out of the map at any zoom, and always swallows the mesh edge. */
  updateFog(distance: number): void {
    const near = 900 + distance * 1.15;
    this.fog.near = near;
    this.fog.far = near * 1.5 + 3400;
  }

  dispose(): void {
    this.sky.geometry.dispose();
    this.skyMat.dispose();
    this.envSky.geometry.dispose();
    this.clouds.geometry.dispose();
    (this.clouds.material as THREE.Material).dispose();
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

/** Low-poly cumulus: clusters of faceted blobs scattered high over the land. */
function makeClouds(): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  let seed = 7;
  const r = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const white = rgb('cloud');
  for (let i = 0; i < 46; i++) {
    const cx = (r() * 2 - 1) * 6000;
    const cz = (r() * 2 - 1) * 6000;
    const cy = 520 + r() * 260;
    const size = 40 + r() * 70;
    const puffs = 3 + Math.floor(r() * 4);
    for (let k = 0; k < puffs; k++) {
      const g = new THREE.IcosahedronGeometry(size * (0.55 + r() * 0.5), 0);
      g.scale(1.3, 0.62, 1);
      g.rotateY(r() * Math.PI);
      g.translate(cx + (k - puffs / 2) * size * 0.8 + r() * size * 0.3, cy + r() * size * 0.25, cz + (r() - 0.5) * size * 0.8);
      g.deleteAttribute('uv');
      parts.push(paintFacets(g, white, 0.02, i * 13 + k));
    }
  }
  const geo = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, emissive: new THREE.Color(0x202830), fog: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -50;
  return mesh;
}
