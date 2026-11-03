/**
 * Trains: one InstancedMesh per vehicle kind, plus bogies and couplers, filled
 * every frame from the train sim's typed arrays. Liveries come from the train type
 * and the line colour; wagons are tinted from a weathered palette. Far away, cars
 * drop to plain bodies and the bogies and couplers stop drawing.
 */
import * as THREE from 'three';
import { CAR, CAR_KINDS } from '../rail/consists';
import { RAIL_TOP } from '../rail/constants';
import { FLAG_BRAKING, FLAG_DOORS, FLAG_DOORS_R, FLAG_HIDDEN, type TrainSim } from '../rail/TrainSim';
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Shared } from './materials';
import { CONTAINER_COLOURS, LOCO_LIVERIES as STYLE_LIVERIES, TRAIN_GREY, TRAIN_IVORY, TRAIN_RED, TRAIN_SILVER, WAGON_COLOURS } from './style';
import { buildBogie, buildCarModels, buildFarModels, P_BODY, P_DOOR, P_GLASS, P_LAMP, P_STRIPE } from './railModels';

function lin(hex: number): [number, number, number] {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [c((hex >> 16) & 255), c((hex >> 8) & 255), c(hex & 255)];
}

// Colours live in the shared style palette.
const LOCO_LIVERIES = STYLE_LIVERIES;
const WAGON = WAGON_COLOURS;
const BOXES = CONTAINER_COLOURS;
const SILVER = TRAIN_SILVER;
const IVORY = TRAIN_IVORY;
const IC_RED = TRAIN_RED;
const GREY = TRAIN_GREY;

const LOD_DISTANCE = 1100;
const BOGIE_DISTANCE = 700;
/** Freight wagons drop to plain bodies and lose bogies much sooner: there are hundreds. */
const FREIGHT_DETAIL = 320;

interface KindLayer {
  near: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
  mesh: THREE.InstancedMesh;
  body: THREE.InstancedBufferAttribute;
  stripe: THREE.InstancedBufferAttribute;
  state: THREE.InstancedBufferAttribute;
  count: number;
}

function trainMaterial(shared: Shared): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uNight = shared.uNight;
    s.uniforms.uTime = shared.uTime;
    s.vertexShader = s.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
attribute float aPart;
attribute vec3 aBody;
attribute vec3 aStripe;
attribute vec4 aState;
uniform float uNight;
varying vec3 vGlow;
varying float vShine;
`,
      )
      .replace(
        '#include <color_vertex>',
        /* glsl */ `#include <color_vertex>
{
  float part = aPart;
  vec3 glow = vec3(0.0);
  vShine = 0.0;
  if (part < ${P_BODY}.5) { vColor.rgb *= aBody; vShine = 1.0; }
  else if (part < ${P_STRIPE}.5) { vColor.rgb *= aStripe; vShine = 1.0; }
  else if (part > ${P_GLASS - 1}.5 && part < ${P_GLASS}.5) {
    // Lit interiors at night on passenger stock.
    glow = vec3(1.0, 0.86, 0.62) * uNight * 1.6 * aState.w;
    vShine = 2.0;
  } else if (part > ${P_LAMP - 1}.5 && part < ${P_LAMP}.5) {
    if (aState.x > 1.5) { vColor.rgb = vec3(0.3, 0.02, 0.02); glow = vec3(3.0, 0.08, 0.05) * (0.6 + uNight); }
    else if (aState.x > 0.5) glow = vec3(1.0, 0.96, 0.85) * (1.2 + uNight * 5.0);
    else vColor.rgb *= 0.35;
  } else if (part > ${P_DOOR - 1}.5 && part < ${P_DOOR}.5) {
    vColor.rgb *= aBody * 0.82;
    // Open doors show the lit vestibule.
    // Open only on the platform side: bit 1 is the car's left (x < 0), bit 2 its right.
    float doorBit = position.x < 0.0 ? 1.0 : 2.0;
    if (mod(floor(aState.y / doorBit), 2.0) > 0.5) { vColor.rgb = vec3(0.55, 0.5, 0.42); glow = vec3(1.0, 0.85, 0.6) * (0.25 + uNight * 1.4); }
  }
  vGlow = glow;
}
`,
      );
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vGlow;\nvarying float vShine;`)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\nif (vShine > 1.5) roughnessFactor = 0.2; else if (vShine > 0.5) roughnessFactor = 0.5;`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow;');
  };
  m.customProgramCacheKey = () => 'cl-train';
  return m;
}

export class TrainLayer {
  readonly group = new THREE.Group();
  private material: THREE.MeshStandardMaterial;
  private plainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.1 });
  private kinds: KindLayer[] = [];
  private bogieGeo: THREE.BufferGeometry[];
  private bogies: THREE.InstancedMesh[] = [];
  private couplerGeo = new THREE.BoxGeometry(0.28, 0.28, 1);
  private coupler: THREE.InstancedMesh;
  private capacity = 0;
  private planes = new Float32Array(24);
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private lod = false;
  private lineColors = new Map<number, [number, number, number]>();
  private lineKey = '';

  constructor(
    private readonly net: RoadNetwork,
    shared: Shared,
  ) {
    this.material = trainMaterial(shared);
    this.bogieGeo = [buildBogie(0.46, 2.6, false), buildBogie(0.42, 1.8, true)];
    for (const g of this.bogieGeo) {
      for (const name of ['aBody', 'aStripe', 'aState']) g.deleteAttribute(name);
    }
    this.coupler = new THREE.InstancedMesh(this.couplerGeo, new THREE.MeshStandardMaterial({ color: 0x1d1e20, roughness: 0.8 }), 1);
    this.ensure(1024);
  }

  private ensure(n: number): void {
    if (n <= this.capacity) return;
    const cap = Math.ceil(n * 1.3);
    for (const k of this.kinds) {
      this.group.remove(k.mesh);
      k.mesh.dispose();
      k.near.dispose();
      k.far.dispose();
    }
    for (const b of this.bogies) {
      this.group.remove(b);
      b.dispose();
    }
    this.group.remove(this.coupler);
    this.coupler.dispose();
    const near = buildCarModels();
    const far = buildFarModels();
    this.kinds = near.map((g, i) => {
      const body = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const stripe = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const state = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
      for (const geo of [g, far[i]]) {
        geo.setAttribute('aBody', body);
        geo.setAttribute('aStripe', stripe);
        geo.setAttribute('aState', state);
      }
      const mesh = new THREE.InstancedMesh(g, this.material, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      this.group.add(mesh);
      return { near: g, far: far[i], mesh, body, stripe, state, count: 0 };
    });
    this.bogies = this.bogieGeo.map((g) => {
      const m = new THREE.InstancedMesh(g, this.plainMat, cap * 2);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = true;
      m.count = 0;
      this.group.add(m);
      return m;
    });
    this.coupler = new THREE.InstancedMesh(this.couplerGeo, this.coupler.material, cap);
    this.coupler.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.coupler.frustumCulled = false;
    this.coupler.count = 0;
    this.group.add(this.coupler);
    this.capacity = cap;
  }

  private refreshLineColors(): void {
    const key = this.net.rail.lines.map((l) => `${l.id}${l.color}`).join();
    if (key === this.lineKey) return;
    this.lineKey = key;
    this.lineColors.clear();
    for (const l of this.net.rail.lines) this.lineColors.set(l.id, lin(parseInt(l.color.replace('#', ''), 16) || 0x46d0ff));
  }

  update(trains: TrainSim | null, camera: THREE.PerspectiveCamera, cameraDistance: number): void {
    if (!trains) return;
    this.refreshLineColors();
    const v = trains.view;
    if (v.count > this.capacity) this.ensure(v.count);
    const alpha = Math.min(1, Math.max(0, trains.renderAlpha));
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const pl = this.planes;
    this.frustum.planes.forEach((p, i) => {
      pl[i * 4] = p.normal.x;
      pl[i * 4 + 1] = p.normal.y;
      pl[i * 4 + 2] = p.normal.z;
      pl[i * 4 + 3] = p.constant;
    });
    for (const k of this.kinds) k.count = 0;
    const showBogies = cameraDistance < BOGIE_DISTANCE;
    let bogieCounts = [0, 0];
    let couplers = 0;
    const cx = camera.position.x;
    const cz = camera.position.z;
    for (let i = 0; i < v.count; i++) {
      if (v.flags[i] & FLAG_HIDDEN) continue;
      const kind = v.kind[i];
      const def = CAR_KINDS[kind];
      const x = v.prevX[i] + (v.x[i] - v.prevX[i]) * alpha;
      const y = v.prevY[i] + (v.y[i] - v.prevY[i]) * alpha + RAIL_TOP;
      const z = v.prevZ[i] + (v.z[i] - v.prevZ[i]) * alpha;
      let culled = false;
      const r = def.length / 2 + 4;
      for (let p = 0; p < 24; p += 4) {
        if (pl[p] * x + pl[p + 1] * y + pl[p + 2] * z + pl[p + 3] < -r) {
          culled = true;
          break;
        }
      }
      if (culled) continue;
      const layer = this.kinds[kind];
      const k = layer.count++;
      let dyaw = v.yaw[i] - v.prevYaw[i];
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      else if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      const yaw = v.prevYaw[i] + dyaw * alpha;
      writeMatrix(layer.mesh.instanceMatrix.array as Float32Array, k * 16, x, y, z, yaw, v.pitch[i]);
      this.livery(layer, k, i, trains);
      const st = layer.state.array as Float32Array;
      st[k * 4] = v.lamp[i];
      // 1 left doors, 2 right doors, 3 both, in the car's own frame.
      st[k * 4 + 1] = (v.flags[i] & FLAG_DOORS ? 1 : 0) + (v.flags[i] & FLAG_DOORS_R ? 2 : 0);
      st[k * 4 + 2] = v.flags[i] & FLAG_BRAKING ? 1 : 0;
      st[k * 4 + 3] = kind <= CAR.hsCar || kind >= CAR.bilevel ? 1 : 0;

      const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      const wagon = kind > CAR.dieselLoco && kind < CAR.bilevel;
      const near = d2 < (wagon ? FREIGHT_DETAIL * FREIGHT_DETAIL : BOGIE_DISTANCE * BOGIE_DISTANCE * 1.4);
      if (showBogies && near) {
        const freight = kind > CAR.dieselLoco && kind < CAR.bilevel ? 1 : 0;
        const bm = this.bogies[freight];
        for (const b of [i * 8, i * 8 + 4]) {
          const bx = v.prevBogie[b] + (v.bogie[b] - v.prevBogie[b]) * alpha;
          const by = v.prevBogie[b + 1] + (v.bogie[b + 1] - v.prevBogie[b + 1]) * alpha + RAIL_TOP;
          const bz = v.prevBogie[b + 2] + (v.bogie[b + 2] - v.prevBogie[b + 2]) * alpha;
          writeMatrix(bm.instanceMatrix.array as Float32Array, bogieCounts[freight] * 16, bx, by, bz, v.bogie[b + 3], v.pitch[i]);
          bogieCounts[freight]++;
        }
        // Coupler to the next car of the same train.
        const j = i + 1;
        if (j < v.count && v.train[j] === v.train[i] && !(v.flags[j] & FLAG_HIDDEN)) {
          const fa = this.carEnd(v, i, -1, alpha, def.length / 2);
          const fb = this.carEnd(v, j, 1, alpha, CAR_KINDS[v.kind[j]].length / 2);
          this.couplerBetween(couplers++, fa, fb);
        }
      }
    }
    for (const l of this.kinds) {
      l.mesh.count = l.count;
      for (const a of [l.mesh.instanceMatrix, l.body, l.stripe, l.state]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, l.count * a.itemSize);
        a.needsUpdate = true;
      }
    }
    if (!showBogies) bogieCounts = [0, 0];
    this.bogies.forEach((b, i) => {
      b.count = bogieCounts[i];
      b.instanceMatrix.clearUpdateRanges();
      b.instanceMatrix.addUpdateRange(0, bogieCounts[i] * 16);
      b.instanceMatrix.needsUpdate = true;
    });
    this.coupler.count = showBogies ? couplers : 0;
    this.coupler.instanceMatrix.needsUpdate = true;
    const lod = cameraDistance > LOD_DISTANCE;
    if (lod !== this.lod) {
      this.lod = lod;
      for (const l of this.kinds) l.mesh.geometry = lod ? l.far : l.near;
    }
  }

  private endTmp = [new THREE.Vector3(), new THREE.Vector3()];

  /** Coupling face of car i, at the rear (-1 means toward the consist rear) or front. */
  private carEnd(v: TrainSim['view'], i: number, which: number, alpha: number, half: number): THREE.Vector3 {
    const out = this.endTmp[which < 0 ? 0 : 1];
    const x = v.prevX[i] + (v.x[i] - v.prevX[i]) * alpha;
    const y = v.prevY[i] + (v.y[i] - v.prevY[i]) * alpha + RAIL_TOP + 0.95;
    const z = v.prevZ[i] + (v.z[i] - v.prevZ[i]) * alpha;
    // Consist forward from the bogies: front bogie minus rear bogie.
    const b = i * 8;
    let fx = v.bogie[b] - v.bogie[b + 4];
    let fz = v.bogie[b + 2] - v.bogie[b + 6];
    const l = Math.hypot(fx, fz) || 1;
    fx /= l;
    fz /= l;
    const d = which < 0 ? -half : half;
    out.set(x + fx * d, y, z + fz * d);
    return out;
  }

  private couplerM = new THREE.Matrix4();
  private couplerQ = new THREE.Quaternion();
  private couplerS = new THREE.Vector3();
  private couplerP = new THREE.Vector3();
  private zAxis = new THREE.Vector3(0, 0, 1);
  private dir = new THREE.Vector3();

  private couplerBetween(k: number, a: THREE.Vector3, b: THREE.Vector3): void {
    if (k >= this.capacity) return;
    this.dir.subVectors(b, a);
    const len = this.dir.length();
    if (len < 0.01 || len > 4) return;
    this.dir.divideScalar(len);
    this.couplerQ.setFromUnitVectors(this.zAxis, this.dir);
    this.couplerP.addVectors(a, b).multiplyScalar(0.5);
    this.couplerS.set(1, 1, len);
    this.couplerM.compose(this.couplerP, this.couplerQ, this.couplerS);
    this.couplerM.toArray(this.coupler.instanceMatrix.array as Float32Array, k * 16);
  }

  private livery(layer: KindLayer, k: number, i: number, trains: TrainSim): void {
    const v = trains.view;
    const kind = v.kind[i];
    const tint = v.tint[i];
    const line = this.lineColors.get(v.line[i]) ?? lin(0x46d0ff);
    let body: readonly number[] = SILVER;
    let stripe: readonly number[] = line;
    switch (kind) {
      case CAR.metroCab:
      case CAR.metroCar:
        body = SILVER;
        break;
      case CAR.emuCab:
      case CAR.emuCar:
        body = IVORY;
        break;
      case CAR.electricLoco:
        body = IC_RED;
        stripe = IVORY;
        break;
      case CAR.coach:
      case CAR.cabCar:
        body = GREY;
        stripe = IC_RED;
        break;
      case CAR.hsNose:
      case CAR.hsCar:
        body = IVORY;
        break;
      case CAR.dieselLoco: {
        // Tints 4 and up are passenger diesels: silver commuter, ivory intercity, in the line colour.
        if (tint >= 4) {
          body = tint === 4 ? SILVER : IVORY;
          stripe = line;
          break;
        }
        const l = LOCO_LIVERIES[tint % LOCO_LIVERIES.length];
        body = l[0];
        stripe = l[1];
        break;
      }
      case CAR.bilevel:
      case CAR.bilevelCab:
        body = SILVER;
        break;
      case CAR.flatcar:
      case CAR.doubleStack:
        body = BOXES[tint & 15];
        stripe = BOXES[(tint * 7 + 3) & 15];
        break;
      case CAR.tanker:
        body = [WAGON[7], WAGON[6], WAGON[11], WAGON[2]][tint & 3];
        stripe = lin(0xc24a2a);
        break;
      case CAR.autorack:
        body = [lin(0xd8d8d4), lin(0xa9adb2), WAGON[9], WAGON[4]][tint & 3];
        stripe = body;
        break;
      default:
        body = WAGON[tint & 15];
        stripe = WAGON[(tint + 5) & 15];
    }
    const b = layer.body.array as Float32Array;
    const s = layer.stripe.array as Float32Array;
    b[k * 3] = body[0];
    b[k * 3 + 1] = body[1];
    b[k * 3 + 2] = body[2];
    s[k * 3] = stripe[0];
    s[k * 3 + 1] = stripe[1];
    s[k * 3 + 2] = stripe[2];
  }

  /** The train under a ray, by oriented boxes. */
  pick(trains: TrainSim | null, ray: THREE.Ray): number | null {
    if (!trains) return null;
    const v = trains.view;
    let best: number | null = null;
    let bestT = Infinity;
    const o = ray.origin;
    const d = ray.direction;
    for (let i = 0; i < v.count; i++) {
      if (v.flags[i] & FLAG_HIDDEN) continue;
      const def = CAR_KINDS[v.kind[i]];
      const px = o.x - v.x[i];
      const py = o.y - (v.y[i] + RAIL_TOP);
      const pz = o.z - v.z[i];
      const s = Math.sin(v.yaw[i]);
      const c = Math.cos(v.yaw[i]);
      const lx = c * px - s * pz;
      const lz = s * px + c * pz;
      const ldx = c * d.x - s * d.z;
      const ldz = s * d.x + c * d.z;
      let t0 = 0;
      let t1 = Infinity;
      const slab = (p: number, q: number, lo: number, hi: number): boolean => {
        if (Math.abs(q) < 1e-9) return p >= lo && p <= hi;
        let a = (lo - p) / q;
        let b = (hi - p) / q;
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
        return t0 <= t1;
      };
      if (!slab(lx, ldx, -def.width / 2 - 0.3, def.width / 2 + 0.3)) continue;
      if (!slab(lz, ldz, -def.length / 2, def.length / 2)) continue;
      if (!slab(py, d.y, 0, def.height + 0.3)) continue;
      if (t0 < bestT) {
        bestT = t0;
        best = v.train[i];
      }
    }
    return best;
  }

  dispose(): void {
    for (const k of this.kinds) {
      k.mesh.dispose();
      k.near.dispose();
      k.far.dispose();
    }
    for (const b of this.bogies) b.dispose();
    for (const g of this.bogieGeo) g.dispose();
    this.coupler.dispose();
    this.couplerGeo.dispose();
    this.material.dispose();
    this.plainMat.dispose();
    this.group.clear();
  }
}

/** Ry(yaw) * Rx(pitch) and a translation, written out with no allocation. */
function writeMatrix(m: Float32Array, o: number, x: number, y: number, z: number, yaw: number, pitch: number): void {
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
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
}
