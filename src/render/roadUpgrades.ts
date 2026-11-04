/**
 * Road upgrades drawn: street lights, street and median trees, hedges and grass
 * verges, guard rails, bus stops and bike racks. Placement comes from
 * core/roadUpgrades.ts (upgradeItems), the same data the Upgrade tool's ghost
 * shows. Sound barriers and walls are drawn by walls.ts from their own fields.
 *
 * Pieces are keyed per segment and merged per map chunk (batch.ts) in the shared
 * surface material, so only roads a change touched rebuild. Level of detail: small
 * street clutter goes first with distance, then greenery at the quality level's
 * tree distance; lamps and rails stay.
 */
import * as THREE from 'three';
import type { NetworkChange, RoadNetwork } from '../core/RoadNetwork';
import { upgradeItems, type UpgradePoint, type UpgradeStrip } from '../core/roadUpgrades';
import { sidewalkOn } from '../core/roadTypes';
import { groundFn } from '../core/terrainMods';
import type { Id } from '../core/types';
import { ChunkBatch, SURF_SCHEMA, SurfBuf, type SurfStyle } from './batch';
import { KERB_HEIGHT, KIND_CONCRETE, KIND_GRASS, KIND_STEEL, KIND_UNTINTED, ROAD_LIFT, hexRGB, type RGB } from './constants';
import type { RenderContext, RenderLayer } from './context';
import { makeSurfaceMaterial } from './materials';
import type { QualitySettings } from './quality';

const style = (hex: number, kind = KIND_UNTINTED): SurfStyle => ({ color: hexRGB(hex), kind, slot: 0, bias: 0 });

const POLE = style(0x5d646b, KIND_STEEL);
const DARK_POLE = style(0x24302b);
const HOUSING = style(0x2a2e33);
const GALV = style(0xb9bec3, KIND_STEEL);
const JERSEY = style(0xc9c4b8, KIND_CONCRETE);
const TRUNK = style(0x5b4632);
const HEDGE = style(0x3f6a2c);
const GRASS: SurfStyle = { color: hexRGB(0x6f9a4a), kind: KIND_GRASS, slot: 0, bias: 0 };
const SHELTER_FRAME = style(0x39434d, KIND_STEEL);
const SHELTER_GLASS = style(0x9fb7c4);
const SHELTER_ROOF = style(0x2f3a44);
const SIGN = style(0x2c6fd1);
const BENCH = style(0x7a5a3a);
const RACK = style(0x9aa1a8, KIND_STEEL);
const LEAVES: RGB[] = [0x4f7f35, 0x5c8a3a, 0x46752f, 0x6a9443, 0x557c38].map(hexRGB);
const HEAD_COLOUR = hexRGB(0xffffff);

/** Unlit, for lamp heads that brighten at night. */
const HEAD: SurfStyle = { color: HEAD_COLOUR, kind: KIND_UNTINTED, slot: 0, bias: 0 };

/** Beyond these, in metres from the camera, the greenery and the clutter are hidden. */
const DETAIL_FAR = 650;

function hash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A rough ball of leaves: rings of quads, flat shaded. */
function crown(buf: SurfBuf, cx: number, cy: number, cz: number, r: number, h: number, colour: RGB): void {
  const s: SurfStyle = { color: colour, kind: KIND_UNTINTED, slot: 0, bias: 0 };
  const rings = 4;
  const segs = 7;
  const pt = (i: number, j: number): number[] => {
    const v = (i / rings) * Math.PI;
    const u = (j / segs) * Math.PI * 2 + (i % 2) * 0.4;
    const k = Math.sin(v);
    return [cx + Math.cos(u) * r * k, cy - Math.cos(v) * h, cz + Math.sin(u) * r * k];
  };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = pt(i, j);
      const b = pt(i, j + 1);
      const c = pt(i + 1, j + 1);
      const d = pt(i + 1, j);
      // Wound so the normal faces out; the poles are triangles.
      if (i === 0) buf.flatQuad(a, d, c, c, s);
      else buf.flatQuad(a, d, c, b, s);
    }
  }
}

interface Out {
  solid: SurfBuf;
  detail: SurfBuf;
  green: SurfBuf;
  heads: SurfBuf;
}

/** Road surface height plus the kerb when the point is on a sidewalk; the ground beyond. */
function baseHeight(net: RoadNetwork, id: Id, p: { pos: { x: number; y: number; z: number }; offset: number; place: string }, ground: (x: number, z: number) => number): number {
  const def = net.roadTypeOf(id);
  if (p.place === 'median') return p.pos.y + ROAD_LIFT + (def.median.kind === 'grass' ? KERB_HEIGHT : 0.02);
  const side = p.offset < 0 ? -1 : 1;
  const walk = sidewalkOn(def, side);
  const d = Math.abs(p.offset);
  if (d <= def.halfWidth + 0.01) return p.pos.y + ROAD_LIFT;
  if (d <= def.halfWidth + walk + 0.01) return p.pos.y + ROAD_LIFT + KERB_HEIGHT;
  // Beyond the road: the ground, unless that is far off (a bridge or a cut), then the road.
  const g = ground(p.pos.x, p.pos.z);
  return Math.abs(g - p.pos.y) < 2.5 ? Math.max(g, p.pos.y - 0.4) + 0.02 : p.pos.y + ROAD_LIFT;
}

function buildLamp(out: Out, p: UpgradePoint, y: number): void {
  const ox = Math.sin(p.yaw);
  const oz = Math.cos(p.yaw);
  // Toward the road, and along it.
  const ix = -ox;
  const iz = -oz;
  const ax = -iz;
  const az = ix;
  const { x, z } = p.pos;
  const arm = (dir: 1 | -1, top: number, reach: number) => {
    const dx = ix * dir;
    const dz = iz * dir;
    out.solid.box(x + dx * reach * 0.5, top, z + dz * reach * 0.5, 0.05, 0.05, reach * 0.5, ax, az, dx, dz, POLE);
    out.heads.box(x + dx * (reach + 0.1), top - 0.08, z + dz * (reach + 0.1), 0.2, 0.06, 0.4, ax, az, dx, dz, HEAD);
    out.solid.box(x + dx * (reach + 0.1), top + 0.02, z + dz * (reach + 0.1), 0.22, 0.06, 0.44, ax, az, dx, dz, HOUSING);
  };
  switch (p.style) {
    case 'decorative': {
      out.solid.prism(x, z, y, y + 0.5, 0.16, 8, DARK_POLE);
      out.solid.prism(x, z, y + 0.5, y + 4.2, 0.07, 8, DARK_POLE);
      out.heads.prism(x, z, y + 4.2, y + 4.75, 0.2, 6, HEAD);
      out.solid.prism(x, z, y + 4.75, y + 4.95, 0.28, 6, DARK_POLE);
      out.solid.prism(x, z, y + 4.95, y + 5.15, 0.08, 6, DARK_POLE);
      if (p.both) {
        // A twin lantern on the median.
        for (const d of [1, -1]) {
          const cx = x + ix * d * 0.6;
          const cz = z + iz * d * 0.6;
          out.solid.box(x + ix * d * 0.3, y + 4.1, z + iz * d * 0.3, 0.04, 0.04, 0.3, ax, az, ix * d, iz * d, DARK_POLE);
          out.heads.prism(cx, cz, y + 3.6, y + 4.1, 0.17, 6, HEAD);
          out.solid.prism(cx, cz, y + 4.1, y + 4.25, 0.23, 6, DARK_POLE);
        }
      }
      break;
    }
    case 'highmast': {
      const top = y + 22;
      out.solid.prism(x, z, y, y + 0.6, 0.6, 8, JERSEY);
      out.solid.prism(x, z, y + 0.6, y + 11, 0.32, 8, POLE);
      out.solid.prism(x, z, y + 11, top, 0.2, 8, POLE);
      out.solid.prism(x, z, top, top + 0.25, 1.1, 10, HOUSING);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + p.yaw;
        const hx = x + Math.cos(a) * 0.95;
        const hz = z + Math.sin(a) * 0.95;
        out.heads.box(hx, top - 0.12, hz, 0.25, 0.12, 0.25, Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), HEAD);
      }
      break;
    }
    case 'double': {
      const top = y + 9;
      out.solid.prism(x, z, y, top + 0.2, 0.11, 8, POLE);
      arm(1, top, 2);
      arm(-1, top, 2);
      break;
    }
    default: {
      const top = y + 8.2;
      out.solid.prism(x, z, y, top + 0.1, 0.1, 8, POLE);
      arm(1, top, 1.8);
      if (p.both) arm(-1, top, 1.8);
    }
  }
}

function buildTree(out: Out, p: UpgradePoint, y: number, seed: number): void {
  const r = hash(seed);
  const scale = 0.85 + r * 0.35;
  const trunk = 2.2 * scale;
  out.green.prism(p.pos.x, p.pos.z, y, y + trunk + 0.4, 0.13 * scale, 6, TRUNK);
  const colour = LEAVES[Math.floor(hash(seed * 7 + 3) * LEAVES.length)];
  crown(out.green, p.pos.x, y + trunk + 1.9 * scale, p.pos.z, 2.1 * scale, 2.2 * scale, colour);
  if (p.style === 'trees' && p.place !== 'median') {
    // A tree pit: a dark square in the paving.
    const ox = Math.sin(p.yaw);
    const oz = Math.cos(p.yaw);
    out.green.box(p.pos.x, y + 0.01, p.pos.z, 0.6, 0.012, 0.6, ox, oz, -oz, ox, style(0x4a3d2e));
  }
}

function buildShelter(out: Out, p: UpgradePoint, y: number): void {
  const ox = Math.sin(p.yaw);
  const oz = Math.cos(p.yaw);
  const ax = -oz;
  const az = ox;
  const { x, z } = p.pos;
  // Back panel away from the road, roof, two posts and a bench.
  const bx = x + ox * 0.7;
  const bz = z + oz * 0.7;
  out.detail.box(bx, y + 1.2, bz, 2, 1.05, 0.04, ax, az, ox, oz, SHELTER_GLASS);
  out.detail.box(x, y + 2.35, z, 2.2, 0.06, 0.95, ax, az, ox, oz, SHELTER_ROOF);
  for (const d of [-1, 1]) {
    out.detail.box(bx + ax * d * 2, y + 1.2, bz + az * d * 2, 0.05, 1.15, 0.05, ax, az, ox, oz, SHELTER_FRAME);
    out.detail.box(x - ox * 0.7 + ax * d * 2, y + 1.2, z - oz * 0.7 + az * d * 2, 0.05, 1.15, 0.05, ax, az, ox, oz, SHELTER_FRAME);
  }
  out.detail.box(x + ox * 0.35, y + 0.45, z + oz * 0.35, 1.4, 0.05, 0.22, ax, az, ox, oz, BENCH);
  // The stop sign on a pole by the kerb.
  const sx = x - ox * 1.1 + ax * 3;
  const sz = z - oz * 1.1 + az * 3;
  out.detail.prism(sx, sz, y, y + 2.8, 0.04, 6, SHELTER_FRAME);
  out.detail.box(sx, y + 2.6, sz, 0.3, 0.3, 0.03, ax, az, ox, oz, SIGN);
}

function buildRack(out: Out, p: UpgradePoint, y: number): void {
  const ox = Math.sin(p.yaw);
  const oz = Math.cos(p.yaw);
  const ax = -oz;
  const az = ox;
  // An inverted U standing across the sidewalk.
  for (const d of [-0.35, 0.35]) out.detail.box(p.pos.x + ox * d, y + 0.42, p.pos.z + oz * d, 0.025, 0.42, 0.025, ax, az, ox, oz, RACK);
  out.detail.box(p.pos.x, y + 0.84, p.pos.z, 0.025, 0.025, 0.38, ax, az, ox, oz, RACK);
}

/** A ribbon between two heights along a strip, seen from both sides. */
function band(buf: SurfBuf, pts: readonly number[][], rights: readonly number[][], off: number, y0: number, y1: number, s: SurfStyle): void {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const ra = rights[i];
    const rb = rights[i + 1];
    const p = (q: number[], r: number[], y: number) => [q[0] + r[0] * off, q[1] + y, q[2] + r[1] * off];
    buf.flatQuad(p(a, ra, y0), p(b, rb, y0), p(b, rb, y1), p(a, ra, y1), s);
    buf.flatQuad(p(b, rb, y0), p(a, ra, y0), p(a, ra, y1), p(b, rb, y1), s);
  }
}

/** Evenly spaced points along a polyline. */
function every(points: readonly number[][], step: number, fn: (x: number, y: number, z: number) => void): void {
  let carry = step / 2;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    let t = carry;
    while (t <= len) {
      const f = t / Math.max(len, 1e-6);
      fn(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
      t += step;
    }
    carry = t - len;
  }
}

function buildStrip(out: Out, net: RoadNetwork, id: Id, st: UpgradeStrip, ground: (x: number, z: number) => number): void {
  const pts = st.points.map((q) => [q.x, baseHeight(net, id, { pos: q, offset: st.offset, place: st.place }, ground), q.z]);
  const rights = st.rights.map((r) => [r.x, r.z]);
  const hw = st.width / 2;
  switch (st.kind) {
    case 'grass': {
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const ra = rights[i];
        const rb = rights[i + 1];
        const q = (p: number[], r: number[], d: number) => [p[0] + r[0] * d, p[1] + 0.03, p[2] + r[1] * d];
        out.green.ru = 0;
        out.green.flatQuad(q(a, ra, -hw), q(a, ra, hw), q(b, rb, hw), q(b, rb, -hw), GRASS);
      }
      break;
    }
    case 'hedge': {
      const h = 1.1;
      band(out.green, pts, rights, -hw, 0, h, HEDGE);
      band(out.green, pts, rights, hw, 0, h, HEDGE);
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const ra = rights[i];
        const rb = rights[i + 1];
        const q = (p: number[], r: number[], d: number) => [p[0] + r[0] * d, p[1] + h, p[2] + r[1] * d];
        out.green.flatQuad(q(a, ra, -hw), q(a, ra, hw), q(b, rb, hw), q(b, rb, -hw), HEDGE);
      }
      break;
    }
    case 'rail': {
      if (st.style === 'jersey') {
        // A safety-shape section: wide foot, narrow top.
        for (const side of [-1, 1]) {
          band(out.solid, pts, rights, side * 0.3, 0, 0.08, JERSEY);
          for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i];
            const b = pts[i + 1];
            const ra = rights[i];
            const rb = rights[i + 1];
            const q = (p: number[], r: number[], d: number, y: number) => [p[0] + r[0] * d, p[1] + y, p[2] + r[1] * d];
            const quad = side < 0 ? [q(a, ra, -0.3, 0.08), q(a, ra, -0.1, 0.82), q(b, rb, -0.1, 0.82), q(b, rb, -0.3, 0.08)] : [q(b, rb, 0.3, 0.08), q(b, rb, 0.1, 0.82), q(a, ra, 0.1, 0.82), q(a, ra, 0.3, 0.08)];
            out.solid.flatQuad(quad[0], quad[1], quad[2], quad[3], JERSEY);
            if (side > 0) out.solid.flatQuad(q(a, ra, -0.1, 0.82), q(a, ra, 0.1, 0.82), q(b, rb, 0.1, 0.82), q(b, rb, -0.1, 0.82), JERSEY);
          }
        }
      } else if (st.style === 'cable') {
        every(pts, 3, (x, y, z) => out.solid.prism(x, z, y, y + 0.9, 0.035, 5, GALV));
        for (const h of [0.5, 0.65, 0.8]) band(out.solid, pts, rights, 0, h, h + 0.025, GALV);
      } else {
        every(pts, 2, (x, y, z) => out.solid.prism(x, z, y, y + 0.72, 0.06, 4, POLE, Math.PI / 4));
        const faces = st.place === 'median' ? [-0.09, 0.09] : [0];
        for (const f of faces) band(out.solid, pts, rights, f, 0.5, 0.8, GALV);
      }
      break;
    }
  }
}

function buildSegment(net: RoadNetwork, id: Id, out: Out, ground: (x: number, z: number) => number): void {
  const items = upgradeItems(net, id);
  for (const p of items.points) {
    const y = baseHeight(net, id, p, ground);
    switch (p.kind) {
      case 'lamp':
        buildLamp(out, p, y);
        break;
      case 'tree':
        buildTree(out, p, y, Math.round(p.pos.x * 13 + p.pos.z * 7));
        break;
      case 'busStop':
        buildShelter(out, p, y);
        break;
      case 'bikeRack':
        buildRack(out, p, y);
        break;
    }
  }
  for (const st of items.strips) buildStrip(out, net, id, st, ground);
}

export class RoadUpgradeLayer implements RenderLayer {
  readonly group = new THREE.Group();
  private material: THREE.MeshStandardMaterial;
  private headMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  private solid: ChunkBatch;
  private detail: ChunkBatch;
  private green: ChunkBatch;
  private heads: ChunkBatch;
  private dirty = new Set<Id>();
  private keys = new Set<Id>();
  private all = true;
  private greenFar = 1600;
  private off: () => void;

  constructor(private readonly net: RoadNetwork, ctx: RenderContext) {
    this.material = makeSurfaceMaterial(ctx.shared);
    this.solid = new ChunkBatch(SURF_SCHEMA, this.material, { castShadow: true, receiveShadow: true });
    this.detail = new ChunkBatch(SURF_SCHEMA, this.material, { castShadow: true, receiveShadow: true });
    this.green = new ChunkBatch(SURF_SCHEMA, this.material, { castShadow: true, receiveShadow: true });
    this.heads = new ChunkBatch(SURF_SCHEMA, this.headMat, {});
    this.group.add(this.solid.group, this.detail.group, this.green.group, this.heads.group);
    this.off = net.onChange((e) => this.onChange(e));
  }

  /** Add to a renderer's scene and frame loop. */
  static install(ctx: RenderContext): RoadUpgradeLayer {
    const layer = new RoadUpgradeLayer(ctx.net, ctx);
    ctx.scene.add(layer.group);
    ctx.addLayer(layer);
    return layer;
  }

  private onChange(e: NetworkChange): void {
    if (e.reset) {
      this.all = true;
      return;
    }
    for (const id of e.dirtySegments) this.dirty.add(id);
    for (const id of e.removedSegments) this.dirty.add(id);
    // A junction moving retrims the roads at it.
    for (const id of e.dirtyNodes) for (const s of this.net.getNode(id)?.segments ?? []) this.dirty.add(s);
  }

  setQuality(q: QualitySettings): void {
    this.greenFar = Math.max(900, q.treeFar * 0.6);
  }

  update(_dt: number, ctx: RenderContext): void {
    this.flush();
    // Day to night: heads light up.
    const night = ctx.night;
    this.headMat.color.setRGB(0.55 + night * 3.6, 0.55 + night * 2.9, 0.55 + night * 1.7);
    // Level of detail by chunk distance.
    const cam = ctx.camera.position;
    const cull = (batch: ChunkBatch, far: number) => {
      for (const m of batch.group.children as THREE.Mesh[]) {
        const s = m.geometry.boundingSphere;
        if (!s) continue;
        const d = Math.hypot(s.center.x - cam.x, s.center.y - cam.y, s.center.z - cam.z) - s.radius;
        m.visible = d < far;
      }
    };
    cull(this.detail, DETAIL_FAR);
    cull(this.green, this.greenFar);
  }

  private batches(): ChunkBatch[] {
    return [this.solid, this.detail, this.green, this.heads];
  }

  /** Rebuild what changed. */
  flush(): void {
    const net = this.net;
    if (this.all) {
      for (const b of this.batches()) b.clear();
      this.keys.clear();
      this.dirty.clear();
      for (const s of net.segments) if (s.overrides.upgrades) this.dirty.add(s.id);
      this.all = false;
    }
    if (!this.dirty.size) return;
    const ground = groundFn(net);
    for (const id of this.dirty) {
      const seg = net.getSegment(id);
      if (!seg?.overrides.upgrades) {
        if (this.keys.delete(id)) for (const b of this.batches()) b.set(id, null);
        continue;
      }
      const out: Out = { solid: new SurfBuf(), detail: new SurfBuf(), green: new SurfBuf(), heads: new SurfBuf() };
      buildSegment(net, id, out, ground);
      this.solid.set(id, out.solid.toPiece());
      this.detail.set(id, out.detail.toPiece());
      this.green.set(id, out.green.toPiece());
      this.heads.set(id, out.heads.toPiece());
      this.keys.add(id);
    }
    this.dirty.clear();
    for (const b of this.batches()) b.flush();
  }

  dispose(): void {
    this.off();
    for (const b of this.batches()) b.dispose();
    this.material.dispose();
    this.headMat.dispose();
    this.group.clear();
  }
}
