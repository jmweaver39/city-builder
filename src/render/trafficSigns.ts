/**
 * Road signs for the traffic rules: a speed-limit sign where a road's limit was
 * set by hand, and a no-entry sign for a vehicle class banned from every lane of
 * one direction. One post per direction of travel, on the kerb at the start of
 * the road, facing the drivers it is for. A RenderLayer, added by app/trafficRules.ts.
 */
import * as THREE from 'three';
import type { RoadNetwork } from '../core/RoadNetwork';
import { effectiveLanes, laneSpeedKmh } from '../core/roadTypes';
import { SPEED_SIGNS, isUnlimited } from '../core/trafficRules';
import type { VehicleClass } from '../core/trafficRuleTypes';
import type { Id } from '../core/types';
import type { RenderContext, RenderLayer } from './context';
import { ROAD_LIFT } from './constants';

const BAN_CELLS: VehicleClass[] = ['truck', 'van', 'car', 'bus'];
const CELL = 128;
/** Atlas cells: speed signs, then bans. */
const CELLS = SPEED_SIGNS.length + BAN_CELLS.length;
const POLE_H = 2.4;
const SIGN_R = 0.38;

function drawAtlas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = CELL * CELLS;
  c.height = CELL;
  const g = c.getContext('2d')!;
  const disc = (x: number, ring: string | null) => {
    g.beginPath();
    g.arc(x + CELL / 2, CELL / 2, 60, 0, Math.PI * 2);
    g.fillStyle = '#f4f2ec';
    g.fill();
    if (ring) {
      g.beginPath();
      g.arc(x + CELL / 2, CELL / 2, 51, 0, Math.PI * 2);
      g.lineWidth = 15;
      g.strokeStyle = ring;
      g.stroke();
    }
  };
  SPEED_SIGNS.forEach((kmh, i) => {
    const x = i * CELL;
    if (isUnlimited(kmh)) {
      disc(x, null);
      g.save();
      g.beginPath();
      g.arc(x + CELL / 2, CELL / 2, 58, 0, Math.PI * 2);
      g.clip();
      g.strokeStyle = '#222';
      g.lineWidth = 5;
      for (let k = -3; k <= 3; k++) {
        g.beginPath();
        g.moveTo(x + 20 + k * 14, 108 + k * 0);
        g.lineTo(x + 108 + k * 14, 20);
        g.stroke();
      }
      g.restore();
      return;
    }
    disc(x, '#c4281c');
    g.fillStyle = '#111';
    const text = String(kmh);
    g.font = `bold ${text.length > 2 ? 44 : 54}px Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x + CELL / 2, CELL / 2 + 3);
  });
  BAN_CELLS.forEach((cls, j) => {
    const x = (SPEED_SIGNS.length + j) * CELL;
    disc(x, '#c4281c');
    g.fillStyle = '#111';
    const cx = x + CELL / 2;
    const cy = CELL / 2 + 6;
    if (cls === 'truck') {
      g.fillRect(cx - 34, cy - 22, 40, 26);
      g.fillRect(cx + 8, cy - 12, 22, 16);
    } else if (cls === 'van') {
      g.fillRect(cx - 30, cy - 20, 46, 24);
      g.beginPath();
      g.moveTo(cx + 16, cy - 20);
      g.lineTo(cx + 30, cy - 6);
      g.lineTo(cx + 30, cy + 4);
      g.lineTo(cx + 16, cy + 4);
      g.fill();
    } else if (cls === 'car') {
      g.fillRect(cx - 32, cy - 8, 64, 14);
      g.fillRect(cx - 18, cy - 22, 34, 16);
    } else {
      g.fillRect(cx - 34, cy - 24, 68, 28);
      g.fillStyle = '#f4f2ec';
      g.fillRect(cx - 28, cy - 18, 56, 9);
      g.fillStyle = '#111';
    }
    for (const dx of [-20, 20]) {
      g.beginPath();
      g.arc(cx + dx, cy + 6, 7, 0, Math.PI * 2);
      g.fill();
    }
  });
  return c;
}

export class TrafficSignLayer implements RenderLayer {
  private readonly group = new THREE.Group();
  private readonly texture: THREE.CanvasTexture;
  private readonly signMat: THREE.MeshStandardMaterial;
  private readonly poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.6, metalness: 0.4 });
  private mesh: THREE.Mesh | null = null;
  private poles: THREE.Mesh | null = null;
  private dirty = true;
  private readonly off: () => void;

  constructor(private readonly net: RoadNetwork, ctx: RenderContext) {
    this.texture = new THREE.CanvasTexture(drawAtlas());
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.signMat = new THREE.MeshStandardMaterial({ map: this.texture, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.1 });
    this.group.name = 'traffic-signs';
    ctx.scene.add(this.group);
    this.off = net.onChange(() => {
      this.dirty = true;
    });
  }

  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.rebuild();
  }

  /** Signs per direction of a segment: [cell index...]. Exported shape for tests via signPlan. */
  rebuild(): void {
    for (const m of [this.mesh, this.poles]) {
      if (!m) continue;
      m.geometry.dispose();
      this.group.remove(m);
    }
    this.mesh = null;
    this.poles = null;
    const pos: number[] = [];
    const uv: number[] = [];
    const nor: number[] = [];
    const idx: number[] = [];
    const poles: THREE.BufferGeometry[] = [];
    for (const plan of signPlan(this.net)) {
      const { x, y, z, fx, fz, cells } = plan;
      const rx = -fz;
      const rz = fx;
      poles.push(new THREE.CylinderGeometry(0.045, 0.045, POLE_H + cells.length * SIGN_R * 2.1, 6).translate(x, y + (POLE_H + cells.length * SIGN_R * 2.1) / 2, z));
      cells.forEach((cell, k) => {
        const cy = y + POLE_H + SIGN_R + k * SIGN_R * 2.1;
        // Face the driver: the sign's front looks back along their travel.
        const cx = x - fx * 0.05;
        const cz = z - fz * 0.05;
        const v = pos.length / 3;
        pos.push(cx - rx * SIGN_R, cy - SIGN_R, cz - rz * SIGN_R, cx + rx * SIGN_R, cy - SIGN_R, cz + rz * SIGN_R, cx + rx * SIGN_R, cy + SIGN_R, cz + rz * SIGN_R, cx - rx * SIGN_R, cy + SIGN_R, cz - rz * SIGN_R);
        const u0 = cell / CELLS;
        const u1 = (cell + 1) / CELLS;
        // The driver looks along f, so their left is at -r.
        uv.push(u0, 0, u1, 0, u1, 1, u0, 1);
        for (let i = 0; i < 4; i++) nor.push(-fx, 0, -fz);
        idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      });
    }
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, this.signMat);
    this.mesh.castShadow = true;
    this.group.add(this.mesh);
    const merged = mergeCylinders(poles);
    if (merged) {
      this.poles = new THREE.Mesh(merged, this.poleMat);
      this.poles.castShadow = true;
      this.group.add(this.poles);
    }
    for (const p of poles) p.dispose();
  }

  dispose(): void {
    this.off();
    this.mesh?.geometry.dispose();
    this.poles?.geometry.dispose();
    this.texture.dispose();
    this.signMat.dispose();
    this.poleMat.dispose();
    this.group.removeFromParent();
  }
}

function mergeCylinders(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!list.length) return null;
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  for (const g of list) {
    const base = pos.length / 3;
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
    }
    const ix = g.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}

/** Metres in from where the road's visible span starts for its drivers. */
const SIGN_IN = 8;

/** Position, tangent and right at a distance along the visible span, between stations. */
function stationAt(st: { pos: { x: number; y: number; z: number }; tangent: { x: number; z: number }; right: { x: number; z: number }; s: number }[], d: number) {
  const s0 = st[0].s + Math.max(0, d);
  let i = 0;
  while (i < st.length - 2 && st[i + 1].s < s0) i++;
  const a = st[i];
  const b = st[i + 1];
  const f = Math.min(1, Math.max(0, (s0 - a.s) / Math.max(b.s - a.s, 1e-6)));
  return {
    pos: { x: a.pos.x + (b.pos.x - a.pos.x) * f, y: a.pos.y + (b.pos.y - a.pos.y) * f, z: a.pos.z + (b.pos.z - a.pos.z) * f },
    tangent: a.tangent,
    right: a.right,
  };
}

export interface SignPost {
  segmentId: Id;
  dir: 1 | -1;
  x: number;
  y: number;
  z: number;
  /** Direction of travel of the drivers it faces. */
  fx: number;
  fz: number;
  /** Atlas cells, bottom up. */
  cells: number[];
}

/** Where sign posts go and what they show. Pure over the network. */
export function signPlan(net: RoadNetwork): SignPost[] {
  const out: SignPost[] = [];
  for (const seg of net.segments) {
    const o = seg.overrides;
    if (o.speedKmh === undefined && !o.laneSpeeds && !o.laneBans) continue;
    const def = net.roadTypeOf(seg.id);
    if (def.category === 'rail') continue;
    const geom = net.segmentGeom(seg.id);
    if (!geom || geom.stations.length < 2 || geom.length < 12) continue;
    const lanes = effectiveLanes(def, o);
    // On the sidewalk by the kerb, or just off the edge where there is none.
    const half = def.halfWidth + (def.sidewalk > 0 ? Math.min(0.7, def.sidewalk / 2) : 1);
    for (const dir of [1, -1] as const) {
      const mine = lanes.map((l, i) => ({ l, i })).filter((x) => x.l.dir === dir && (x.l.kind === 'drive' || x.l.kind === 'bus'));
      if (!mine.length) continue;
      const cells: number[] = [];
      if (o.speedKmh !== undefined || o.laneSpeeds) {
        // The kerb lane's limit, which is what a driver arriving sees first.
        const kerb = dir === 1 ? mine[mine.length - 1] : mine[0];
        const kmh = laneSpeedKmh(def, o, kerb.i);
        let best = 0;
        SPEED_SIGNS.forEach((s, k) => {
          if (Math.abs(s - kmh) < Math.abs(SPEED_SIGNS[best] - kmh)) best = k;
        });
        cells.push(best);
      }
      BAN_CELLS.forEach((cls, j) => {
        if (mine.every((x) => (o.laneBans?.[x.i] ?? []).includes(cls))) cells.unshift(SPEED_SIGNS.length + j);
      });
      if (!cells.length) continue;
      // Near the start of travel, on the drivers' right.
      const st = stationAt(geom.stations, dir === 1 ? SIGN_IN : geom.length - SIGN_IN);
      const fx = st.tangent.x * dir;
      const fz = st.tangent.z * dir;
      const side = dir === 1 ? half : -half;
      out.push({
        segmentId: seg.id,
        dir,
        x: st.pos.x + st.right.x * side,
        y: st.pos.y + ROAD_LIFT,
        z: st.pos.z + st.right.z * side,
        fx,
        fz,
        cells,
      });
    }
  }
  return out;
}
