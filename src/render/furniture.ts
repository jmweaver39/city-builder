/**
 * Street furniture: signal poles with lit lamps, stop and yield signs, and
 * street lamps with their night glow. Poles rebuild when the set of heads or
 * nodes changes. Lamp state is the only thing touched per frame.
 */
import * as THREE from 'three';
import type { Id, SignKind, Vec3 } from '../core/types';
import type { RoadNetwork } from '../core/RoadNetwork';
import { closestPointOnCubic } from '../core/bezier';
import { totalHalfWidth } from '../core/roadTypes';
import { effectiveControl } from '../core/signals';
import { autoLampSide } from '../core/roadUpgrades';
import { surfaceLevel, terrainHeight } from '../core/terrain';
import type { LightState, SignalHead, SimApi } from '../sim/api';
import { ChunkBatch, SURF_SCHEMA, SurfBuf, type SurfStyle } from './batch';
import { COL, KIND_UNTINTED, ROAD_LIFT, hexRGB } from './constants';
import type { Shared } from './materials';
import { makeSignAtlas } from './textures';

const POLE: SurfStyle = { color: hexRGB(0x3a3f44), kind: KIND_UNTINTED, slot: 0, bias: 0 };
const HOUSING: SurfStyle = { color: hexRGB(0x17191c), kind: KIND_UNTINTED, slot: 0, bias: 0 };
const LAMP_POST: SurfStyle = { color: hexRGB(0x5a6066), kind: KIND_UNTINTED, slot: 0, bias: 0 };

const LAMP_COLOURS: Record<Exclude<LightState, 'off'>, THREE.Color> = {
  red: new THREE.Color(1, 0.06, 0.04),
  yellow: new THREE.Color(1, 0.62, 0.05),
  green: new THREE.Color(0.12, 1, 0.28),
};
const DIM = new THREE.Color(0.03, 0.03, 0.03);
const LAMP_ORDER: Exclude<LightState, 'off'>[] = ['red', 'yellow', 'green'];

const LAMP_SPACING = 40;

function sideOfRoad(net: RoadNetwork, segId: Id): number {
  const def = net.roadTypeOf(segId);
  return def.halfWidth + (def.sidewalk > 0 ? Math.min(0.6, def.sidewalk / 2) : 1);
}

export class FurnitureLayer {
  readonly group = new THREE.Group();
  private polesBatch: ChunkBatch;
  private signalSig = '';

  /** Three lamps per head, in order red, yellow, green. */
  private lamps: THREE.InstancedMesh | null = null;
  private lampGeo = new THREE.SphereGeometry(0.2, 8, 6).rotateX(Math.PI / 2);
  private lampMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  private halo: THREE.Points;
  private haloGeo = new THREE.BufferGeometry();
  private haloMat: THREE.PointsMaterial;
  private haloCount = 0;
  /** First lamp of each head, by index in signalHeads(). */
  private headBase: number[] = [];

  private signAtlas: THREE.CanvasTexture;
  private signMat: THREE.MeshStandardMaterial;
  private signMesh: THREE.Mesh | null = null;

  private lampPost: THREE.InstancedMesh | null = null;
  private lampHead: THREE.InstancedMesh | null = null;
  private lampPool: THREE.InstancedMesh | null = null;
  private lampHeadMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private postMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(...COL.steel), roughness: 0.5, metalness: 0.7 });
  private lampPoolMat: THREE.MeshBasicMaterial;
  private poolGeo = new THREE.PlaneGeometry(30, 30).rotateX(-Math.PI / 2);
  private postGeo: THREE.BufferGeometry;
  private headGeo = new THREE.BoxGeometry(0.34, 0.12, 0.8).translate(0, 0, 0);

  constructor(
    private readonly net: RoadNetwork,
    private readonly shared: Shared,
    surfaceMaterial: THREE.Material,
    private readonly glow: THREE.Texture,
    anisotropy: number,
  ) {
    this.polesBatch = new ChunkBatch(SURF_SCHEMA, surfaceMaterial, { castShadow: true, receiveShadow: true, chunkSize: 500 });
    this.group.add(this.polesBatch.group);

    this.haloMat = new THREE.PointsMaterial({
      map: glow,
      size: 3.2,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      toneMapped: false,
    });
    this.haloGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.haloGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.halo = new THREE.Points(this.haloGeo, this.haloMat);
    this.halo.frustumCulled = false;
    this.halo.renderOrder = 9;
    this.group.add(this.halo);

    this.signAtlas = makeSignAtlas(anisotropy);
    this.signMat = new THREE.MeshStandardMaterial({ map: this.signAtlas, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.1 });

    this.lampPoolMat = new THREE.MeshBasicMaterial({
      map: glow,
      color: new THREE.Color(1, 0.62, 0.3),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
    });
    const post = new THREE.CylinderGeometry(0.07, 0.11, 8.2, 6).translate(0, 4.1, 0);
    const arm = new THREE.BoxGeometry(0.07, 0.07, 1.8).translate(0, 8.15, -0.85);
    post.deleteAttribute('uv');
    arm.deleteAttribute('uv');
    this.postGeo = mergeSimple([post.toNonIndexed(), arm.toNonIndexed()]);
    post.dispose();
    arm.dispose();
    this.headGeo.translate(0, 8.1, -1.7);
  }

  // -------------------------------------------------------------------------
  // Signals
  // -------------------------------------------------------------------------

  /** Identify the set of heads, so poles only rebuild when it changes. */
  private headSignature(heads: readonly SignalHead[]): string {
    let h = heads.length * 31;
    for (const a of heads) {
      h = (Math.imul(h, 33) + a.nodeId * 7 + a.segmentId * 131 + a.laneIndex * 17 + Math.round(a.pos.x * 10) + Math.round(a.pos.z * 10) * 3) | 0;
    }
    return `${heads.length}:${h}`;
  }

  private rebuildSignals(heads: readonly SignalHead[]): void {
    const groups = new Map<string, SignalHead[]>();
    for (const h of heads) {
      const key = `${h.nodeId}:${h.segmentId}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(h);
    }
    const buf = new SurfBuf();
    this.headBase = new Array(heads.length).fill(0);
    const headIndex = new Map(heads.map((h, i) => [h, i]));
    const lampMatrices: THREE.Matrix4[] = [];
    const dummy = new THREE.Object3D();
    for (const g of groups.values()) {
      const f = g[0].facing;
      const rx = -f.z;
      const rz = f.x;
      // Rightmost lane of the group, by position across the drivers' view.
      let maxR = -Infinity;
      let minR = Infinity;
      let origin: Vec3 = g[0].pos;
      for (const h of g) {
        const r = h.pos.x * rx + h.pos.z * rz;
        if (r > maxR) {
          maxR = r;
          origin = h.pos;
        }
        if (r < minR) minR = r;
      }
      const seg = g[0].segmentId;
      const def = this.net.getSegment(seg) ? this.net.roadTypeOf(seg) : null;
      const laneW = def?.lanes[g[0].laneIndex]?.width ?? 3.5;
      const out = laneW / 2 + (def && def.sidewalk > 0 ? 0.7 : 1.1);
      const px = origin.x + rx * out;
      const pz = origin.z + rz * out;
      const baseY = origin.y + ROAD_LIFT;
      const armY = baseY + 6.4;
      buf.prism(px, pz, baseY - 0.3, armY + 0.5, 0.13, 8, POLE);
      const span = maxR - minR + out + 0.6;
      const cx = px - (rx * span) / 2;
      const cz = pz - (rz * span) / 2;
      buf.box(cx, armY, cz, span / 2, 0.06, 0.06, rx, rz, f.x, f.z, POLE);
      for (const h of g) {
        this.headBase[headIndex.get(h)!] = lampMatrices.length;
        const lx = h.pos.x;
        const lz = h.pos.z;
        buf.box(lx, armY - 0.72, lz, 0.25, 0.68, 0.13, rx, rz, f.x, f.z, HOUSING, { bottom: true });
        // Back plate gives the head an outline against the sky.
        buf.box(lx + f.x * 0.17, armY - 0.72, lz + f.z * 0.17, 0.42, 0.84, 0.015, rx, rz, f.x, f.z, HOUSING);
        for (let i = 0; i < 3; i++) {
          dummy.position.set(lx - f.x * 0.14, armY - 0.28 - i * 0.44, lz - f.z * 0.14);
          dummy.rotation.set(0, Math.atan2(f.x, f.z), 0);
          dummy.updateMatrix();
          lampMatrices.push(dummy.matrix.clone());
        }
      }
    }
    this.polesBatch.set(0, buf.toPiece());
    this.polesBatch.flush();

    if (this.lamps) {
      this.group.remove(this.lamps);
      this.lamps.dispose();
      this.lamps = null;
    }
    if (lampMatrices.length) {
      const mesh = new THREE.InstancedMesh(this.lampGeo, this.lampMat, lampMatrices.length);
      lampMatrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(lampMatrices.length * 3), 3);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      this.lamps = mesh;
      this.group.add(mesh);
      // Halos match lamps one to one.
      const n = lampMatrices.length;
      const pos = new Float32Array(n * 3);
      const v = new THREE.Vector3();
      lampMatrices.forEach((m, i) => {
        v.setFromMatrixPosition(m);
        pos[i * 3] = v.x;
        pos[i * 3 + 1] = v.y;
        pos[i * 3 + 2] = v.z;
      });
      this.haloGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.haloGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      this.haloCount = n;
    } else {
      this.haloCount = 0;
    }
    this.halo.visible = this.haloCount > 0;
    this.haloGeo.setDrawRange(0, this.haloCount);
  }

  updateSignals(sim: SimApi | null): void {
    const heads = sim ? sim.signalHeads() : [];
    const sig = this.headSignature(heads);
    if (sig !== this.signalSig) {
      this.signalSig = sig;
      this.rebuildSignals(heads);
    }
    const mesh = this.lamps;
    if (!mesh || !mesh.instanceColor) return;
    const arr = mesh.instanceColor.array as Float32Array;
    const halo = this.haloGeo.getAttribute('color') as THREE.BufferAttribute;
    const ha = halo.array as Float32Array;
    const night = this.shared.uNight.value;
    const haloK = 0.18 + 0.6 * night;
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i];
      let k = this.headBase[i];
      for (const lamp of LAMP_ORDER) {
        const on = h.state === lamp;
        const c = on ? LAMP_COLOURS[lamp] : DIM;
        arr[k * 3] = c.r * (on ? 3 : 1);
        arr[k * 3 + 1] = c.g * (on ? 3 : 1);
        arr[k * 3 + 2] = c.b * (on ? 3 : 1);
        const g = on ? haloK : 0;
        ha[k * 3] = c.r * g;
        ha[k * 3 + 1] = c.g * g;
        ha[k * 3 + 2] = c.b * g;
        k++;
      }
    }
    mesh.instanceColor.needsUpdate = true;
    halo.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Signs and street lamps
  // -------------------------------------------------------------------------

  /** Rebuild stop, yield and priority signs from each node's control. */
  rebuildSigns(): void {
    const net = this.net;
    const positions: number[] = [];
    const uvs: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const poles = new SurfBuf();
    for (const node of net.nodes) {
      const g = net.nodeGeom(node.id);
      if (!g || g.kind !== 'junction') continue;
      const ctl = effectiveControl(net, node.id);
      for (const arm of g.arms) {
        const sign = ctl.signs[arm.segmentId] as SignKind | undefined;
        if (!sign || sign === 'none') continue;
        const cell = sign === 'stop' ? 0 : sign === 'yield' ? 1 : 2;
        // A driver arriving faces against the outward direction.
        const fx = -arm.cutDir.x;
        const fz = -arm.cutDir.z;
        const rx = -fz;
        const rz = fx;
        const side = sideOfRoad(net, arm.segmentId);
        const back = 1.5;
        const px = arm.centre.x + rx * side + arm.cutDir.x * back;
        const pz = arm.centre.z + rz * side + arm.cutDir.z * back;
        const base = arm.centre.y + ROAD_LIFT;
        const top = base + 2.8;
        poles.prism(px, pz, base, top, 0.045, 6, POLE);
        const hw = 0.42;
        const v = positions.length / 3;
        const nx = -fx;
        const nz = -fz;
        const fy = 0.04;
        const cx = px - fx * fy;
        const cz = pz - fz * fy;
        positions.push(cx - rx * hw, top - 0.1, cz - rz * hw, cx + rx * hw, top - 0.1, cz + rz * hw, cx + rx * hw, top + 0.74, cz + rz * hw, cx - rx * hw, top + 0.74, cz - rz * hw);
        // The driver looks along f, so their left is at -r. u runs left to right for them.
        const u0 = cell / 3;
        const u1 = (cell + 1) / 3;
        uvs.push(u1, 0, u0, 0, u0, 1, u1, 1);
        for (let i = 0; i < 4; i++) normals.push(nx, 0, nz);
        indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
      }
    }
    if (this.signMesh) {
      this.signMesh.geometry.dispose();
      this.group.remove(this.signMesh);
      this.signMesh = null;
    }
    if (positions.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      this.signMesh = new THREE.Mesh(geo, this.signMat);
      this.signMesh.castShadow = true;
      this.group.add(this.signMesh);
    }
    this.polesBatch.set(1, poles.toPiece());
    this.polesBatch.flush();
  }

  /** True when a post here would stand on a neighbouring road surface. */
  private inAnotherRoad(self: Id, x: number, y: number, z: number): boolean {
    const net = this.net;
    const r = 18;
    for (const id of net.segmentsInRegion({ minX: x - r, minZ: z - r, maxX: x + r, maxZ: z + r }, true)) {
      if (id === self) continue;
      const hit = closestPointOnCubic(net.cubicOf(id), { x, y: 0, z });
      const dx = hit.point.x - x;
      const dz = hit.point.z - z;
      const reach = totalHalfWidth(net.roadTypeOf(id)) + 0.3;
      if (dx * dx + dz * dz < reach * reach && Math.abs(hit.point.y - y) < 4) return true;
    }
    return false;
  }

  /** Rebuild street lamps. Spacing is fixed per road, so a road edit keeps the others. */
  rebuildLamps(): void {
    const net = this.net;
    const spots: { x: number; y: number; z: number; yaw: number }[] = [];
    for (const seg of net.segments) {
      const geom = net.segmentGeom(seg.id);
      if (!geom || geom.stations.length < 2) continue;
      const def = net.roadTypeOf(seg.id);
      const useSide = def.sidewalk > 0;
      const isFast = def.category === 'highway' || def.category === 'ramp';
      if (!useSide && !isFast) continue;
      const st = geom.stations;
      const spacing = isFast ? LAMP_SPACING * 1.6 : LAMP_SPACING;
      const reach = useSide ? def.halfWidth + 0.5 : def.halfWidth + 0.5;
      let i = 0;
      const s0 = st[0].s;
      const s1 = st[st.length - 1].s;
      let k = Math.ceil((s0 + 6) / spacing);
      for (; k * spacing < s1 - 6; k++) {
        const s = k * spacing;
        while (i + 2 < st.length && st[i + 1].s < s) i++;
        const a = st[i];
        const b = st[i + 1];
        const f = (s - a.s) / Math.max(b.s - a.s, 1e-6);
        const y = a.pos.y + (b.pos.y - a.pos.y) * f;
        if (y < surfaceLevel(a.pos.x, a.pos.z) - 1.5) continue;
        const x = a.pos.x + (b.pos.x - a.pos.x) * f;
        const z = a.pos.z + (b.pos.z - a.pos.z) * f;
        // Alternate sides on streets. Fast roads keep to the right edge.
        const side = isFast || k % 2 === 0 ? 1 : -1;
        // Street lights set by the Upgrade cards replace the automatic ones on that side.
        if (!autoLampSide(seg.overrides, side)) continue;
        const rx = a.right.x * side;
        const rz = a.right.z * side;
        const px = x + rx * reach;
        const pz = z + rz * reach;
        if (this.inAnotherRoad(seg.id, px, y, pz)) continue;
        // Arm reaches toward the road, along local -Z of the model.
        const yaw = Math.atan2(rx, rz);
        const ground = terrainHeight(px, pz);
        const baseY = Math.max(y, ground) + ROAD_LIFT + (useSide ? 0.15 : 0);
        spots.push({ x: px, y: baseY, z: pz, yaw });
      }
    }
    for (const m of [this.lampPost, this.lampHead, this.lampPool]) {
      if (m) {
        this.group.remove(m);
        m.dispose();
      }
    }
    this.lampPost = this.lampHead = this.lampPool = null;
    const n = spots.length;
    if (!n) return;
    const post = new THREE.InstancedMesh(this.postGeo, this.postMat, n);
    const head = new THREE.InstancedMesh(this.headGeo, this.lampHeadMat, n);
    const pool = new THREE.InstancedMesh(this.poolGeo, this.lampPoolMat, n);
    const d = new THREE.Object3D();
    spots.forEach((p, i) => {
      d.position.set(p.x, p.y, p.z);
      d.rotation.set(0, p.yaw, 0);
      d.updateMatrix();
      post.setMatrixAt(i, d.matrix);
      head.setMatrixAt(i, d.matrix);
      // Pool lands under the lamp head, over the road.
      const fx = -Math.sin(p.yaw);
      const fz = -Math.cos(p.yaw);
      d.position.set(p.x + fx * 2.2, p.y + 0.09, p.z + fz * 2.2);
      d.updateMatrix();
      pool.setMatrixAt(i, d.matrix);
    });
    post.castShadow = true;
    for (const m of [post, head, pool]) {
      m.instanceMatrix.needsUpdate = true;
      m.frustumCulled = false;
      this.group.add(m);
    }
    pool.renderOrder = 8;
    pool.visible = false;
    this.lampPost = post;
    this.lampHead = head;
    this.lampPool = pool;
  }

  /** Day to night: lamp heads light up and pools fade in. */
  updateNight(): void {
    const night = this.shared.uNight.value;
    this.lampHeadMat.color.setRGB(0.5 + night * 4, 0.5 + night * 3.2, 0.5 + night * 1.8);
    this.lampPoolMat.opacity = night * 0.42;
    if (this.lampPool) this.lampPool.visible = night > 0.02;
  }

  dispose(): void {
    this.polesBatch.dispose();
    for (const m of [this.lamps, this.lampPost, this.lampHead, this.lampPool]) m?.dispose();
    this.lampGeo.dispose();
    this.lampMat.dispose();
    this.haloGeo.dispose();
    this.haloMat.dispose();
    this.signAtlas.dispose();
    this.signMat.dispose();
    this.signMesh?.geometry.dispose();
    this.lampHeadMat.dispose();
    this.postMat.dispose();
    this.lampPoolMat.dispose();
    this.poolGeo.dispose();
    this.postGeo.dispose();
    this.headGeo.dispose();
    this.group.clear();
  }
}

function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.getAttribute('position').array as Float32Array, o * 3);
    nor.set(p.getAttribute('normal').array as Float32Array, o * 3);
    o += p.getAttribute('position').count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}
