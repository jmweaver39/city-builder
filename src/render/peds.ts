/**
 * Draws the pedestrian sim (src/peds): one instanced mesh of simple people with a
 * walk cycle done in the vertex shader (legs and arms swing about hip and shoulder),
 * clothing colours per person, and one of dogs on leads. Visible only close up,
 * and the sim it draws is switched off (and emptied) when the camera pulls back.
 */
import * as THREE from 'three';
import { P_DOG, P_JOGGER, type PedSim } from '../peds/PedSim';
import type { CameraPose } from './api';
import type { RenderContext, RenderLayer } from './context';
import type { QualitySettings } from './quality';
import { C, PropGeo, propMaterial, type FadeUniforms } from './propKit';
import type { RGB } from './constants';

/** Camera distance beyond which nobody is drawn or simulated. */
export const PEDS_ON_DISTANCE = 300;

const WHITE: RGB = [1, 1, 1];

/** Parts, read by the shader: which way each piece swings and what colour it takes. */
const SHIRT = 0;
const LEG_L = 1;
const LEG_R = 2;
const ARM_L = 3;
const ARM_R = 4;
const SKIN = 5;
const HAIR = 6;
const SHOE_L = 7;
const SHOE_R = 8;

function personGeometry(): THREE.BufferGeometry {
  const g = new PropGeo();
  // Facing -z. Hips at 0.92, shoulders at 1.42.
  g.setPart(LEG_L).box(-0.09, 0.47, 0, 0.075, 0.45, 0.08, WHITE);
  g.setPart(LEG_R).box(0.09, 0.47, 0, 0.075, 0.45, 0.08, WHITE);
  g.setPart(SHOE_L).box(-0.09, 0.04, -0.04, 0.07, 0.04, 0.12, WHITE);
  g.setPart(SHOE_R).box(0.09, 0.04, -0.04, 0.07, 0.04, 0.12, WHITE);
  g.setPart(SHIRT).box(0, 1.17, 0, 0.19, 0.27, 0.11, WHITE, 1);
  g.setPart(ARM_L).box(-0.25, 1.15, 0, 0.055, 0.27, 0.06, WHITE, 1);
  g.setPart(ARM_R).box(0.25, 1.15, 0, 0.055, 0.27, 0.06, WHITE, 1);
  g.setPart(SKIN).box(0, 1.47, 0, 0.05, 0.04, 0.05, WHITE);
  g.setPart(SKIN).blob(0, 1.6, 0, 0.11, 0.13, 0.12, WHITE, 0, 3, 6);
  g.setPart(HAIR).blob(0, 1.66, 0.015, 0.118, 0.085, 0.125, WHITE, 0, 2, 6);
  return g.toGeometry();
}

function dogGeometry(): THREE.BufferGeometry {
  const g = new PropGeo();
  // Facing -z.
  g.setPart(SHIRT).box(0, 0.42, 0, 0.11, 0.12, 0.3, WHITE, 1);
  g.setPart(SHIRT).box(0, 0.55, -0.34, 0.08, 0.08, 0.1, WHITE, 1);
  g.setPart(SHIRT).box(0, 0.52, -0.45, 0.045, 0.045, 0.06, C(0x2a2826));
  g.setPart(SHIRT).box(0, 0.5, 0.33, 0.025, 0.025, 0.12, WHITE, 1);
  g.setPart(LEG_L).box(-0.07, 0.17, -0.2, 0.03, 0.17, 0.03, WHITE, 1);
  g.setPart(LEG_R).box(0.07, 0.17, -0.2, 0.03, 0.17, 0.03, WHITE, 1);
  g.setPart(LEG_R).box(-0.07, 0.17, 0.2, 0.03, 0.17, 0.03, WHITE, 1);
  g.setPart(LEG_L).box(0.07, 0.17, 0.2, 0.03, 0.17, 0.03, WHITE, 1);
  return g.toGeometry();
}

const toVec = (hex: number) => {
  const c = C(hex);
  return new THREE.Vector3(c[0], c[1], c[2]);
};
const SHIRTS = [0xe8e4dc, 0x2a4a7a, 0xc8463a, 0x3a7a5a, 0xe8b830, 0x5a5e66, 0x8a4a8a, 0x2a2c30, 0x7ab0d8, 0xd87a4a, 0xf2f0ea, 0x4a6a3a, 0xb84a6a, 0x3a8aa8, 0xc8b8a0, 0x6a3a2a].map(C);
const JOG_SHIRTS = [0xf0603a, 0x3ac8e8, 0xd8e83a, 0xe83a8a, 0xf2f0ea].map(C);
const PANTS = [0x2a3a5a, 0x2a2c30, 0x5a5e66, 0x8a7a5a, 0x3a4a6a, 0xc8bca8].map(toVec);
const SKINS = [0xf0d0b0, 0xe0b090, 0xc08a60, 0x8a5a3a, 0x5a3a2a].map(toVec);
const HAIRS = [0x2a1e16, 0x5a3a20, 0xa87a40, 0xd8c890, 0x8a8a8a].map(toVec);
const DOGS = [0x8a5a2e, 0x2a2622, 0xe8dcc0, 0xb8864a, 0x6a6a6a].map(C);

const PERSON_VERTEX = /* glsl */ `
attribute vec4 aLook;
attribute vec2 aWalk;
uniform vec3 uPants[6];
uniform vec3 uSkin[5];
uniform vec3 uHair[5];
`;

/** Swing legs and arms, bob, and pick the colour of each part. */
const PERSON_MAIN = /* glsl */ `
{
  float part = aPart;
  float a = sin( aWalk.x ) * 0.5 * aWalk.y;
  float swing = 0.0;
  float pivot = 0.92;
  if ( ( part > 0.5 && part < 1.5 ) || ( part > 6.5 && part < 7.5 ) ) swing = a;
  else if ( ( part > 1.5 && part < 2.5 ) || part > 7.5 ) swing = -a;
  else if ( part > 2.5 && part < 3.5 ) { swing = -a * 0.8; pivot = 1.42; }
  else if ( part > 3.5 && part < 4.5 ) { swing = a * 0.8; pivot = 1.42; }
  if ( swing != 0.0 ) {
    float c = cos( swing );
    float s = sin( swing );
    float yy = transformed.y - pivot;
    float zz = transformed.z;
    transformed.y = pivot + yy * c - zz * s;
    transformed.z = yy * s + zz * c;
  }
  transformed.y += abs( sin( aWalk.x ) ) * 0.035 * aWalk.y;
#ifdef USE_COLOR
  if ( part > 0.5 && part < 2.5 ) vColor.rgb = uPants[ int( aLook.x + 0.5 ) ];
  else if ( part > 4.5 && part < 5.5 ) vColor.rgb = uSkin[ int( aLook.y + 0.5 ) ];
  else if ( part > 5.5 && part < 6.5 ) vColor.rgb = uHair[ int( aLook.z + 0.5 ) ];
  else if ( part > 6.5 ) vColor.rgb = vec3( 0.03 );
#endif
}
`;

/** Dogs: all four legs swing, in pairs. */
const DOG_MAIN = /* glsl */ `
{
  float part = aPart;
  float a = sin( aWalk.x * 1.6 ) * 0.6 * aWalk.y;
  float swing = part > 0.5 && part < 1.5 ? a : part > 1.5 && part < 2.5 ? -a : 0.0;
  if ( swing != 0.0 ) {
    float c = cos( swing );
    float s = sin( swing );
    float yy = transformed.y - 0.34;
    float zz = transformed.z - sign( transformed.z ) * 0.2;
    transformed.y = 0.34 + yy * c - zz * s;
    transformed.z = sign( transformed.z ) * 0.2 + yy * s + zz * c;
  }
}
`;

const QUALITY_PEDS: Record<string, { max: number; density: number }> = {
  low: { max: 250, density: 0.35 },
  medium: { max: 700, density: 0.65 },
  high: { max: 1500, density: 1 },
  ultra: { max: 2500, density: 1.25 },
};

export class PedLayer implements RenderLayer {
  readonly group = new THREE.Group();
  enabled = true;
  private fade: FadeUniforms = { uFadeNear: { value: 160 }, uFadeFar: { value: 230 } };
  private people: THREE.InstancedMesh;
  private dogs: THREE.InstancedMesh;
  private walk: THREE.InstancedBufferAttribute;
  private look: THREE.InstancedBufferAttribute;
  private dogWalk: THREE.InstancedBufferAttribute;
  private mats: THREE.Material[] = [];
  private capacity = 0;
  private dogCapacity = 0;
  /** People drawn last frame and the time the layer took, for the readout and perf checks. */
  readonly stats = { drawn: 0, updateMs: 0, stepMs: 0 };

  constructor(
    private readonly peds: PedSim,
    ctx: RenderContext,
    private readonly pose: () => CameraPose,
    /** Advance the sim by this frame's real seconds; the app scales by sim speed. */
    private readonly drive: (dt: number) => void,
  ) {
    const uniforms = { uPants: { value: PANTS }, uSkin: { value: SKINS }, uHair: { value: HAIRS } };
    const personMat = propMaterial(this.fade, { extraVertex: PERSON_VERTEX, extraVertexMain: PERSON_MAIN, key: 'person', uniforms });
    const dogMat = propMaterial(this.fade, { extraVertex: 'attribute vec2 aWalk;', extraVertexMain: DOG_MAIN, key: 'dog' });
    this.mats.push(personMat, dogMat);
    this.people = new THREE.InstancedMesh(personGeometry(), personMat, 1);
    this.dogs = new THREE.InstancedMesh(dogGeometry(), dogMat, 1);
    this.walk = new THREE.InstancedBufferAttribute(new Float32Array(2), 2);
    this.look = new THREE.InstancedBufferAttribute(new Float32Array(4), 4);
    this.dogWalk = new THREE.InstancedBufferAttribute(new Float32Array(2), 2);
    this.grow(512);
    this.growDogs(64);
    for (const m of [this.people, this.dogs]) {
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = true;
    }
    this.people.name = 'pedestrians';
    this.dogs.name = 'dogs';
    this.group.add(this.people, this.dogs);
    this.group.name = 'street-life';
    ctx.scene.add(this.group);
  }

  private grow(n: number): void {
    if (n <= this.capacity) return;
    const cap = Math.max(n, this.capacity * 2);
    const next = new THREE.InstancedMesh(this.people.geometry, this.people.material, cap);
    next.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.walk = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    this.look = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.walk.setUsage(THREE.DynamicDrawUsage);
    this.look.setUsage(THREE.DynamicDrawUsage);
    next.geometry = this.people.geometry.clone();
    next.geometry.setAttribute('aWalk', this.walk);
    next.geometry.setAttribute('aLook', this.look);
    next.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    next.instanceColor.setUsage(THREE.DynamicDrawUsage);
    next.frustumCulled = false;
    next.receiveShadow = true;
    next.name = 'pedestrians';
    if (this.capacity > 0) {
      this.group.remove(this.people);
      this.people.geometry.dispose();
      this.people.dispose();
      this.group.add(next);
    }
    this.people = next;
    this.capacity = cap;
  }

  private growDogs(n: number): void {
    if (n <= this.dogCapacity) return;
    const cap = Math.max(n, this.dogCapacity * 2);
    const next = new THREE.InstancedMesh(this.dogs.geometry, this.dogs.material, cap);
    next.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dogWalk = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    this.dogWalk.setUsage(THREE.DynamicDrawUsage);
    next.geometry = this.dogs.geometry.clone();
    next.geometry.setAttribute('aWalk', this.dogWalk);
    next.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    next.frustumCulled = false;
    next.receiveShadow = true;
    next.name = 'dogs';
    if (this.dogCapacity > 0) {
      this.group.remove(this.dogs);
      this.dogs.geometry.dispose();
      this.dogs.dispose();
      this.group.add(next);
    }
    this.dogs = next;
    this.dogCapacity = cap;
  }

  setQuality(q: QualitySettings): void {
    const p = QUALITY_PEDS[q.name] ?? QUALITY_PEDS.high;
    this.peds.maxPeds = p.max;
    this.peds.density = p.density;
  }

  update(dt: number): void {
    const t0 = performance.now();
    const pose = this.pose();
    const on = this.enabled && pose.distance < PEDS_ON_DISTANCE;
    this.group.visible = on;
    if (!on) {
      // Zoomed out: nobody to simulate or draw.
      if (this.peds.focusR > 0) this.peds.setFocus(0, 0, 0);
      this.stats.drawn = 0;
      this.stats.updateMs = 0;
      this.stats.stepMs = 0;
      return;
    }
    const R = Math.min(360, Math.max(150, pose.distance * 1.3 + 90));
    this.fade.uFadeNear.value = R * 0.6;
    this.fade.uFadeFar.value = R * 0.88;
    this.peds.setFocus(pose.target.x, pose.target.z, R);
    const s0 = performance.now();
    this.drive(dt);
    this.stats.stepMs = performance.now() - s0;
    this.fill();
    this.stats.updateMs = performance.now() - t0;
  }

  private fill(): void {
    const p = this.peds;
    const n = p.count;
    this.grow(n);
    let dogs = 0;
    for (let i = 0; i < n; i++) if (p.kind[i] === P_DOG) dogs++;
    this.growDogs(dogs);
    const people = this.people;
    const mat = people.instanceMatrix.array as Float32Array;
    const col = people.instanceColor!.array as Float32Array;
    const walk = this.walk.array as Float32Array;
    const look = this.look.array as Float32Array;
    const dmat = this.dogs.instanceMatrix.array as Float32Array;
    const dcol = this.dogs.instanceColor!.array as Float32Array;
    const dwalk = this.dogWalk.array as Float32Array;
    let d = 0;
    for (let i = 0; i < n; i++) {
      const lk = p.look[i];
      const h = (0.92 + ((lk >>> 4) % 17) / 100) * Math.max(0.001, p.fade[i]);
      const yaw = p.yaw[i];
      const c = Math.cos(yaw) * h;
      const s = Math.sin(yaw) * h;
      const o = i * 16;
      // Rotation about y, uniform scale, then translation (column-major).
      mat[o] = c;
      mat[o + 1] = 0;
      mat[o + 2] = -s;
      mat[o + 3] = 0;
      mat[o + 4] = 0;
      mat[o + 5] = h;
      mat[o + 6] = 0;
      mat[o + 7] = 0;
      mat[o + 8] = s;
      mat[o + 9] = 0;
      mat[o + 10] = c;
      mat[o + 11] = 0;
      mat[o + 12] = p.x[i];
      mat[o + 13] = p.y[i];
      mat[o + 14] = p.z[i];
      mat[o + 15] = 1;
      const shirt = p.kind[i] === P_JOGGER ? JOG_SHIRTS[lk % JOG_SHIRTS.length] : SHIRTS[lk % SHIRTS.length];
      col[i * 3] = shirt[0];
      col[i * 3 + 1] = shirt[1];
      col[i * 3 + 2] = shirt[2];
      walk[i * 2] = p.phase[i];
      walk[i * 2 + 1] = p.stride[i];
      look[i * 4] = (lk >>> 9) % PANTS.length;
      look[i * 4 + 1] = (lk >>> 13) % SKINS.length;
      look[i * 4 + 2] = (lk >>> 17) % HAIRS.length;
      look[i * 4 + 3] = 1;
      if (p.kind[i] === P_DOG) {
        // On a lead, a step ahead and to the side.
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        const k = Math.max(0.001, p.fade[i]) * (0.8 + ((lk >>> 21) % 5) * 0.12);
        const dc = Math.cos(yaw) * k;
        const ds = Math.sin(yaw) * k;
        const q = d * 16;
        dmat[q] = dc;
        dmat[q + 1] = 0;
        dmat[q + 2] = -ds;
        dmat[q + 3] = 0;
        dmat[q + 4] = 0;
        dmat[q + 5] = k;
        dmat[q + 6] = 0;
        dmat[q + 7] = 0;
        dmat[q + 8] = ds;
        dmat[q + 9] = 0;
        dmat[q + 10] = dc;
        dmat[q + 11] = 0;
        dmat[q + 12] = p.x[i] + fx * 0.9 - fz * 0.45;
        dmat[q + 13] = p.y[i];
        dmat[q + 14] = p.z[i] + fz * 0.9 + fx * 0.45;
        dmat[q + 15] = 1;
        const dogC = DOGS[(lk >>> 25) % DOGS.length];
        dcol[d * 3] = dogC[0];
        dcol[d * 3 + 1] = dogC[1];
        dcol[d * 3 + 2] = dogC[2];
        dwalk[d * 2] = p.phase[i];
        dwalk[d * 2 + 1] = p.stride[i];
        d++;
      }
    }
    people.count = n;
    people.instanceMatrix.needsUpdate = true;
    people.instanceColor!.needsUpdate = true;
    this.walk.needsUpdate = true;
    this.look.needsUpdate = true;
    this.dogs.count = d;
    this.dogs.instanceMatrix.needsUpdate = true;
    this.dogs.instanceColor!.needsUpdate = true;
    this.dogWalk.needsUpdate = true;
    this.stats.drawn = n;
  }

  dispose(): void {
    this.people.geometry.dispose();
    this.dogs.geometry.dispose();
    this.people.dispose();
    this.dogs.dispose();
    for (const m of this.mats) m.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
