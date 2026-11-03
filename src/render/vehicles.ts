/**
 * Vehicles. Each model has three levels of detail and each level is an
 * InstancedMesh, filled every frame from the sim's typed arrays with no
 * allocation. A vehicle picks its level from its own distance to the camera.
 */
import * as THREE from 'three';
import type { SimApi, VehicleView } from '../sim/api';
import { VEHICLE_TYPES } from '../sim/api';
import { ROAD_LIFT, hexRGB } from './constants';
import type { Shared } from './materials';
import type { QualitySettings } from './quality';
import { makeBeamTexture, makeBlobTexture } from './textures';
import { buildModels, type ModelSet } from './vehicleModels';
import { BODY_COLOURS } from './style';

/** Half length, half width, height, for picking. */
const DIMENSIONS: Record<string, [number, number, number]> = {
  car: [2.3, 0.95, 1.5],
  van: [2.7, 1.02, 2.3],
  truck: [5.6, 1.25, 3.6],
  bus: [6, 1.27, 3.1],
  bike: [0.9, 0.3, 1.76],
};

/** Length of the contact shadow, per model. Same order as buildModels. */
const BLOB_SCALE = [2.75, 2.4, 2.85, 3.2, 5.9, 6.6, 6.6, 1.1];
const BLOB_WIDTH = [1.28, 1.24, 1.36, 1.42, 1.72, 1.74, 1.74, 0.5];

const MODEL_SEDAN = 0;
const MODEL_HATCH = 1;
const MODEL_SUV = 2;
const MODEL_VAN = 3;
const MODEL_BOX = 4;
const MODEL_ARTIC = 5;
const MODEL_BUS = 6;
const MODEL_BIKE = 7;

function modelFor(type: number, id: number): number {
  switch (VEHICLE_TYPES[type]) {
    case 'car': {
      const k = id % 10;
      return k < 5 ? MODEL_SEDAN : k < 8 ? MODEL_HATCH : MODEL_SUV;
    }
    case 'van':
      return MODEL_VAN;
    case 'truck':
      return id % 3 === 0 ? MODEL_ARTIC : MODEL_BOX;
    case 'bus':
      return MODEL_BUS;
    case 'bike':
      return MODEL_BIKE;
    default:
      return MODEL_SEDAN;
  }
}

function patchVehicle(m: THREE.MeshStandardMaterial, shared: Shared, clearcoat: boolean): void {
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = shared.uTime;
    s.uniforms.uNight = shared.uNight;
    s.vertexShader = s.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
attribute float aPart;
attribute vec3 aInstColor;
attribute vec2 aState;
uniform float uTime;
uniform float uNight;
varying vec3 vGlow;
varying vec2 vPbr;
varying float vPaint;
`,
      )
      .replace(
        '#include <color_vertex>',
        /* glsl */ `#include <color_vertex>
{
  float part = aPart;
  vec2 pbr = vec2(0.7, 0.0);
  vPaint = 0.0;
  if (part < 0.5) {
    vColor.rgb *= aInstColor;
    // Metallic flake reads as a higher metalness on mid and dark colours.
    pbr = vec2(0.38, 0.3);
    vPaint = 1.0;
  } else if (part > 5.5 && part < 6.5) {
    pbr = vec2(0.08, 0.85);
  } else if (part > 6.5) {
    pbr = vec2(0.24, 1.0);
  } else if (part > 1.5) {
    pbr = vec2(0.22, 0.0);
  }
  vPbr = pbr;
  vec3 glow = vec3(0.0);
  float brake = aState.x;
  float blink = aState.y;
  // Running at 1.5 Hz, with a phase per vehicle so a queue does not flash in step.
  float phase = fract(uTime * 1.5 + aInstColor.r * 3.7 + aInstColor.g * 5.1);
  float flash = step(phase, 0.5);
  if (part > 1.5 && part < 2.5) glow = vec3(1.0, 0.03, 0.02) * (max(brake * 7.0, uNight * 1.6));
  else if (part > 2.5 && part < 3.5) glow = vec3(1.0, 0.5, 0.04) * (blink < -0.5 ? flash * 6.0 : 0.0);
  else if (part > 3.5 && part < 4.5) glow = vec3(1.0, 0.5, 0.04) * (blink > 0.5 ? flash * 6.0 : 0.0);
  else if (part > 4.5 && part < 5.5) glow = vec3(1.0, 0.93, 0.78) * uNight * 9.0;
  vGlow = glow;
}
`,
      );
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vGlow;\nvarying vec2 vPbr;\nvarying float vPaint;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = vPbr.x;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\nmetalnessFactor = vPbr.y;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow;`);
    if (clearcoat) {
      s.fragmentShader = s.fragmentShader.replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>\nmaterial.clearcoat *= vPaint;`,
      );
    }
  };
  m.customProgramCacheKey = () => (clearcoat ? 'cl-vehicle-coat-lp' : 'cl-vehicle-lp');
}

interface Bucket {
  geo: THREE.BufferGeometry;
  mesh: THREE.InstancedMesh | null;
  matrix: Float32Array;
  colour: Float32Array;
  state: Float32Array;
  colourAttr: THREE.InstancedBufferAttribute | null;
  stateAttr: THREE.InstancedBufferAttribute | null;
  count: number;
  capacity: number;
  castShadow: boolean;
  material: THREE.Material;
}

/** Upload only the first n floats of an instanced attribute this frame. */
function markRange(attr: THREE.BufferAttribute, n: number): void {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, n);
  attr.needsUpdate = true;
}

const BEAM_OPACITY = 0.3;
const START_CAPACITY = 256;

export class VehicleLayer {
  readonly group = new THREE.Group();
  private models: ModelSet[] = buildModels();
  /** Index by model * 3 + level. */
  private buckets: Bucket[] = [];
  private coat: THREE.MeshPhysicalMaterial;
  private plain: THREE.MeshStandardMaterial;
  private beams!: THREE.InstancedMesh;
  private beamMat: THREE.MeshBasicMaterial;
  private beamGeo: THREE.BufferGeometry;
  private beamTex: THREE.Texture;
  private blobs!: THREE.InstancedMesh;
  private blobGeo: THREE.BufferGeometry;
  private blobMat: THREE.MeshBasicMaterial;
  private blobTex: THREE.Texture;
  private fxCapacity = 0;
  private planes = new Float32Array(24);
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private nearRange = 110;
  private midRange = 480;

  constructor(private readonly shared: Shared) {
    this.coat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08 });
    this.plain = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.2 });
    patchVehicle(this.coat, shared, true);
    patchVehicle(this.plain, shared, false);
    this.beamTex = makeBeamTexture();
    this.beamGeo = new THREE.PlaneGeometry(5, 22).rotateX(-Math.PI / 2).translate(0, 0.14, -12.6);
    this.beamMat = new THREE.MeshBasicMaterial({
      map: this.beamTex,
      color: new THREE.Color(1, 0.86, 0.6),
      transparent: true,
      opacity: BEAM_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.blobTex = makeBlobTexture();
    this.blobGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2).translate(0, 0.045, 0);
    this.blobMat = new THREE.MeshBasicMaterial({ map: this.blobTex, transparent: true, depthWrite: false, color: 0x000000, polygonOffset: true, polygonOffsetFactor: -3 });
    this.models.forEach((m) => {
      const levels: [THREE.BufferGeometry, THREE.Material, boolean][] = [
        [m.near, this.coat, true],
        [m.mid, this.plain, true],
        [m.far, this.plain, false],
      ];
      for (const [geo, material, castShadow] of levels) {
        this.buckets.push({ geo, material, castShadow, mesh: null, matrix: new Float32Array(0), colour: new Float32Array(0), state: new Float32Array(0), colourAttr: null, stateAttr: null, count: 0, capacity: 0 });
      }
    });
    for (const b of this.buckets) this.grow(b, START_CAPACITY);
    this.growFx(START_CAPACITY * 4);
  }

  setQuality(q: QualitySettings): void {
    this.nearRange = q.vehicleNear;
    this.midRange = q.vehicleMid;
    // Without sun shadows a vehicle still sits on its contact shadow, and the shadow map
    // holds only still things, so it can be cached (scene.ts).
    this.buckets.forEach((b, i) => {
      b.castShadow = q.vehicleShadows && i % 3 < 2;
      if (b.mesh) b.mesh.castShadow = b.castShadow;
    });
  }

  private grow(b: Bucket, capacity: number): void {
    if (b.mesh) {
      this.group.remove(b.mesh);
      b.mesh.dispose();
    }
    const colour = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const state = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
    b.geo.setAttribute('aInstColor', colour);
    b.geo.setAttribute('aState', state);
    const mesh = new THREE.InstancedMesh(b.geo, b.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = b.castShadow;
    mesh.receiveShadow = true;
    mesh.count = 0;
    b.mesh = mesh;
    b.matrix = mesh.instanceMatrix.array as Float32Array;
    b.colour = colour.array as Float32Array;
    b.state = state.array as Float32Array;
    b.colourAttr = colour;
    b.stateAttr = state;
    b.capacity = capacity;
    b.count = 0;
    this.group.add(mesh);
  }

  private growFx(capacity: number): void {
    if (capacity <= this.fxCapacity) return;
    this.fxCapacity = capacity;
    const make = (geo: THREE.BufferGeometry, material: THREE.Material, order: number, old?: THREE.InstancedMesh) => {
      if (old) {
        this.group.remove(old);
        old.dispose();
      }
      const m = new THREE.InstancedMesh(geo, material, capacity);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.renderOrder = order;
      m.visible = false;
      this.group.add(m);
      return m;
    };
    this.beams = make(this.beamGeo, this.beamMat, 8, this.beams);
    this.blobs = make(this.blobGeo, this.blobMat, 4, this.blobs);
  }

  update(sim: SimApi | null, camera: THREE.PerspectiveCamera, cameraDistance: number): void {
    if (!sim) {
      for (const b of this.buckets) if (b.mesh) b.mesh.count = 0;
      return;
    }
    const view = sim.vehicles;
    this.growFx(view.count);
    for (const b of this.buckets) b.count = 0;
    const alpha = Math.min(1, Math.max(0, sim.renderAlpha));
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const pl = this.planes;
    const fp = this.frustum.planes;
    for (let i = 0; i < 6; i++) {
      const p = fp[i];
      pl[i * 4] = p.normal.x;
      pl[i * 4 + 1] = p.normal.y;
      pl[i * 4 + 2] = p.normal.z;
      pl[i * 4 + 3] = p.constant;
    }
    const night = this.shared.uNight.value;
    const showBeams = night > 0.05 && cameraDistance < 1500;
    const beamArr = this.beams.instanceMatrix.array as Float32Array;
    const blobArr = this.blobs.instanceMatrix.array as Float32Array;
    let beams = 0;
    let blobs = 0;
    const camX = camera.position.x;
    const camY = camera.position.y;
    const camZ = camera.position.z;
    const near2 = this.nearRange * this.nearRange;
    const mid2 = this.midRange * this.midRange;

    const n = view.count;
    const { id, prevX, prevY, prevZ, prevYaw, x: xs, y: ys, z: zs, yaw: yaws, pitch: pitches, type, color, braking, blinker } = view;
    for (let i = 0; i < n; i++) {
      const x = prevX[i] + (xs[i] - prevX[i]) * alpha;
      const y = prevY[i] + (ys[i] - prevY[i]) * alpha + ROAD_LIFT;
      const z = prevZ[i] + (zs[i] - prevZ[i]) * alpha;
      let culled = false;
      for (let p = 0; p < 24; p += 4) {
        if (pl[p] * x + pl[p + 1] * y + pl[p + 2] * z + pl[p + 3] < -14) {
          culled = true;
          break;
        }
      }
      if (culled) continue;
      const dx = x - camX;
      const dy = y - camY;
      const dz = z - camZ;
      const d2 = dx * dx + dy * dy + dz * dz;
      const model = modelFor(type[i], id[i]);
      const level = d2 < near2 ? 0 : d2 < mid2 ? 1 : 2;
      let bucket = this.buckets[model * 3 + level];
      if (bucket.count >= bucket.capacity) this.grow(bucket, bucket.capacity * 2);
      bucket = this.buckets[model * 3 + level];
      const k = bucket.count++;
      let dyaw = yaws[i] - prevYaw[i];
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      else if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      const yaw = prevYaw[i] + dyaw * alpha;
      const sy = Math.sin(yaw);
      const cy = Math.cos(yaw);
      const sp = Math.sin(pitches[i]);
      const cp = Math.cos(pitches[i]);
      // Ry(yaw) * Rx(pitch), written out to stay allocation free.
      const m = bucket.matrix;
      const o = k * 16;
      m[o] = cy;
      m[o + 1] = 0;
      m[o + 2] = -sy;
      m[o + 3] = 0;
      m[o + 4] = sy * sp;
      m[o + 5] = cp;
      m[o + 6] = cy * sp;
      m[o + 7] = 0;
      m[o + 8] = sy * cp;
      m[o + 9] = -sp;
      m[o + 10] = cy * cp;
      m[o + 11] = 0;
      m[o + 12] = x;
      m[o + 13] = y;
      m[o + 14] = z;
      m[o + 15] = 1;
      const c = BODY_COLOURS[color[i] & 15];
      bucket.colour[k * 3] = c[0];
      bucket.colour[k * 3 + 1] = c[1];
      bucket.colour[k * 3 + 2] = c[2];
      bucket.state[k * 2] = braking[i];
      bucket.state[k * 2 + 1] = blinker[i];
      if (showBeams) {
        const b = beams * 16;
        for (let q = 0; q < 16; q++) beamArr[b + q] = m[o + q];
        beams++;
      }
      if (level < 2) {
        const b = blobs * 16;
        const wide = BLOB_WIDTH[model];
        const long = BLOB_SCALE[model];
        blobArr[b] = cy * wide;
        blobArr[b + 1] = 0;
        blobArr[b + 2] = -sy * wide;
        blobArr[b + 3] = 0;
        blobArr[b + 4] = 0;
        blobArr[b + 5] = 1;
        blobArr[b + 6] = 0;
        blobArr[b + 7] = 0;
        blobArr[b + 8] = sy * long;
        blobArr[b + 9] = 0;
        blobArr[b + 10] = cy * long;
        blobArr[b + 11] = 0;
        blobArr[b + 12] = x;
        blobArr[b + 13] = y;
        blobArr[b + 14] = z;
        blobArr[b + 15] = 1;
        blobs++;
      }
    }
    for (const b of this.buckets) {
      const mesh = b.mesh!;
      const c = b.count;
      mesh.count = c;
      mesh.visible = c > 0;
      if (!c) continue;
      markRange(mesh.instanceMatrix, c * 16);
      markRange(b.colourAttr!, c * 3);
      markRange(b.stateAttr!, c * 2);
    }
    this.blobs.count = blobs;
    this.blobs.visible = blobs > 0;
    if (blobs) {
      const im = this.blobs.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, blobs * 16);
      im.needsUpdate = true;
    }
    this.beams.visible = showBeams && beams > 0;
    if (showBeams) {
      this.beams.count = beams;
      this.beamMat.opacity = BEAM_OPACITY * night;
      const im = this.beams.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, beams * 16);
      im.needsUpdate = true;
    }
  }

  /** Closest vehicle crossed by a ray, by an oriented box test. */
  pick(view: VehicleView, ray: THREE.Ray, alpha: number): number | null {
    let best: number | null = null;
    let bestT = Infinity;
    const ox = ray.origin.x;
    const oy = ray.origin.y;
    const oz = ray.origin.z;
    const dx = ray.direction.x;
    const dy = ray.direction.y;
    const dz = ray.direction.z;
    for (let i = 0; i < view.count; i++) {
      const x = view.prevX[i] + (view.x[i] - view.prevX[i]) * alpha;
      const y = view.prevY[i] + (view.y[i] - view.prevY[i]) * alpha;
      const z = view.prevZ[i] + (view.z[i] - view.prevZ[i]) * alpha;
      const [hl, hw, h] = DIMENSIONS[VEHICLE_TYPES[view.type[i]] ?? 'car'] ?? DIMENSIONS.car;
      const px = ox - x;
      const py = oy - y;
      const pz = oz - z;
      // Quick reject on the bounding sphere around the middle of the vehicle.
      const cy = py - h / 2;
      const b = px * dx + cy * dy + pz * dz;
      const c = px * px + cy * cy + pz * pz - (hl * hl + hw * hw + h * h);
      if (b > 0 && c > 0) continue;
      if (b * b - c < 0) continue;
      const s = Math.sin(view.yaw[i]);
      const q = Math.cos(view.yaw[i]);
      // Ray in vehicle space: x right, z back.
      const lx = q * px - s * pz;
      const lz = s * px + q * pz;
      const ldx = q * dx - s * dz;
      const ldz = s * dx + q * dz;
      let t0 = 0;
      let t1 = Infinity;
      const slab = (o: number, d: number, lo: number, hi: number): boolean => {
        if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
        let a = (lo - o) / d;
        let e = (hi - o) / d;
        if (a > e) [a, e] = [e, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, e);
        return t0 <= t1;
      };
      if (!slab(lx, ldx, -hw, hw) || !slab(lz, ldz, -hl, hl) || !slab(py, dy, 0, h)) continue;
      if (t0 < bestT) {
        bestT = t0;
        best = view.id[i];
      }
    }
    return best;
  }

  dispose(): void {
    for (const b of this.buckets) b.mesh?.dispose();
    for (const m of this.models) {
      m.near.dispose();
      m.mid.dispose();
      m.far.dispose();
    }
    this.beams.dispose();
    this.blobs.dispose();
    this.beamGeo.dispose();
    this.beamMat.dispose();
    this.beamTex.dispose();
    this.blobGeo.dispose();
    this.blobMat.dispose();
    this.blobTex.dispose();
    this.coat.dispose();
    this.plain.dispose();
    this.group.clear();
  }
}
