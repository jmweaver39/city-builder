/**
 * Vehicle models built from primitives. Bodies are lofted: a side profile and a
 * cross section swept nose to tail, with the sills lifted around each wheel so the
 * arches read. Front is -Z, origin is on the ground under the middle of the model.
 * Each model comes at three levels of detail.
 */
import * as THREE from 'three';
import { hexRGB } from './constants';

export const PART_BODY = 0;
export const PART_FIXED = 1;
export const PART_BRAKE = 2;
export const PART_BLINK_L = 3;
export const PART_BLINK_R = 4;
export const PART_HEAD = 5;
export const PART_GLASS = 6;
export const PART_CHROME = 7;

type C = readonly number[];

const WHITE: C = [1, 1, 1];
const GLASS: C = hexRGB(0x3c4c5c);
const TRIM: C = hexRGB(0x141518);
const RUBBER: C = hexRGB(0x0e0f11);
const RIM: C = hexRGB(0x9aa0a6);
const LAMP: C = hexRGB(0x5e1412);
const INDICATOR: C = hexRGB(0x8a5a10);
const HEAD: C = hexRGB(0xd8dcd8);
const PLATE: C = hexRGB(0xd8d6c8);

class Builder {
  pos: number[] = [];
  col: number[] = [];
  part: number[] = [];

  tri(a: number[], b: number[], c: number[], color: C, part: number): void {
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.col.push(color[0], color[1], color[2]);
      this.part.push(part);
    }
  }

  /** Counter-clockwise from the normal side. */
  quad(a: number[], b: number[], c: number[], d: number[], color: C, part: number): void {
    this.tri(a, b, c, color, part);
    this.tri(a, c, d, color, part);
  }

  /** Box, optionally tapered at the top. No bottom face unless asked. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: C, part: number, inset: { front?: number; back?: number; side?: number; bottom?: boolean } = {}): void {
    const f = inset.front ?? 0;
    const b = inset.back ?? 0;
    const s = inset.side ?? 0;
    const lb = [x0, y0, z1];
    const rb = [x1, y0, z1];
    const lf = [x0, y0, z0];
    const rf = [x1, y0, z0];
    const tlb = [x0 + s, y1, z1 - b];
    const trb = [x1 - s, y1, z1 - b];
    const tlf = [x0 + s, y1, z0 + f];
    const trf = [x1 - s, y1, z0 + f];
    this.quad(tlb, trb, trf, tlf, color, part);
    this.quad(rf, lf, tlf, trf, color, part);
    this.quad(lb, rb, trb, tlb, color, part);
    this.quad(rb, rf, trf, trb, color, part);
    this.quad(lf, lb, tlb, tlf, color, part);
    if (inset.bottom) this.quad(lb, lf, rf, rb, color, part);
  }

  front(x0: number, x1: number, y0: number, y1: number, z: number, color: C, part: number): void {
    this.quad([x1, y0, z], [x0, y0, z], [x0, y1, z], [x1, y1, z], color, part);
  }

  back(x0: number, x1: number, y0: number, y1: number, z: number, color: C, part: number): void {
    this.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], color, part);
  }

  side(x: number, z0: number, z1: number, y0: number, y1: number, color: C, part: number): void {
    if (x > 0) this.quad([x, y0, z1], [x, y0, z0], [x, y1, z0], [x, y1, z1], color, part);
    else this.quad([x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0], color, part);
  }

  /** Tyre, rim and hub on the outer face. x is the outer face. */
  wheel(x: number, z: number, r: number, w: number, sides: number, rimR = 0.62): void {
    const sign = x > 0 ? 1 : -1;
    const outer = x;
    const inner = x - sign * w;
    const ring = (k: number, i: number): number[] => {
      const a = (i / sides) * Math.PI * 2;
      return [outer - sign * 0.015 * (1 - k), r + Math.cos(a) * r * k, z + Math.sin(a) * r * k];
    };
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const y0 = r + Math.cos(a0) * r;
      const z0 = z + Math.sin(a0) * r;
      const y1 = r + Math.cos(a1) * r;
      const z1 = z + Math.sin(a1) * r;
      // Tread. Outward is along the radius whichever side the wheel is on.
      if (sign > 0) this.quad([outer, y0, z0], [inner, y0, z0], [inner, y1, z1], [outer, y1, z1], RUBBER, PART_FIXED);
      else this.quad([inner, y0, z0], [outer, y0, z0], [outer, y1, z1], [inner, y1, z1], RUBBER, PART_FIXED);
      const hub = [outer - sign * 0.02, r, z];
      const p0 = ring(rimR, i);
      const p1 = ring(rimR, i + 1);
      const q0 = ring(1, i);
      const q1 = ring(1, i + 1);
      if (sign > 0) {
        this.quad(p0, q0, q1, p1, RUBBER, PART_FIXED);
        this.tri(hub, p0, p1, RIM, PART_CHROME);
      } else {
        this.quad(p1, q1, q0, p0, RUBBER, PART_FIXED);
        this.tri(hub, p1, p0, RIM, PART_CHROME);
      }
    }
  }

  build(smoothDeg: number): THREE.BufferGeometry {
    const n = this.pos.length / 3;
    const pos = new Float32Array(this.pos);
    const nor = new Float32Array(n * 3);
    const face: number[][] = [];
    for (let t = 0; t < n; t += 3) {
      const a = t * 3;
      const ux = pos[a + 3] - pos[a];
      const uy = pos[a + 4] - pos[a + 1];
      const uz = pos[a + 5] - pos[a + 2];
      const vx = pos[a + 6] - pos[a];
      const vy = pos[a + 7] - pos[a + 1];
      const vz = pos[a + 8] - pos[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      face.push([nx / l, ny / l, nz / l, l]);
    }
    // Smooth within a part, across edges gentler than the limit.
    const groups = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const key = `${Math.round(pos[i * 3] * 500)},${Math.round(pos[i * 3 + 1] * 500)},${Math.round(pos[i * 3 + 2] * 500)},${this.part[i]}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(i);
    }
    const limit = Math.cos((smoothDeg * Math.PI) / 180);
    for (let i = 0; i < n; i++) {
      const own = face[Math.floor(i / 3)];
      const key = `${Math.round(pos[i * 3] * 500)},${Math.round(pos[i * 3 + 1] * 500)},${Math.round(pos[i * 3 + 2] * 500)},${this.part[i]}`;
      let x = 0;
      let y = 0;
      let z = 0;
      for (const j of groups.get(key)!) {
        const f = face[Math.floor(j / 3)];
        if (f[0] * own[0] + f[1] * own[1] + f[2] * own[2] < limit) continue;
        x += f[0] * f[3];
        y += f[1] * f[3];
        z += f[2] * f[3];
      }
      const l = Math.hypot(x, y, z) || 1;
      nor[i * 3] = x / l;
      nor[i * 3 + 1] = y / l;
      nor[i * 3 + 2] = z / l;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    return g;
  }
}

interface LoftSpec {
  /** Silhouette nose to tail as z, y. */
  profile: [number, number][];
  hw: number;
  /** Half width of the roof as a fraction of hw. */
  roofHw: number;
  sill: number;
  belt: [number, number];
  wheelsZ: number[];
  wheelR: number;
  /** Where the top surface is glass. */
  windscreen: [number, number];
  rearGlass: [number, number] | null;
  /** Where the side above the belt is glass. */
  sideGlass: [number, number];
  /** Plan taper at the nose and tail, metres in from full width. */
  taper: number;
}

function topAt(profile: readonly [number, number][], z: number): number {
  for (let i = 0; i + 1 < profile.length; i++) {
    const [z0, y0] = profile[i];
    const [z1, y1] = profile[i + 1];
    if (z <= z1) return y0 + (y1 - y0) * ((z - z0) / Math.max(z1 - z0, 1e-6));
  }
  return profile[profile.length - 1][1];
}

/** Corner cutting, so a profile drawn with a few points flows. */
function chaikin(p: [number, number][], rounds: number): [number, number][] {
  let out = p;
  for (let r = 0; r < rounds; r++) {
    const next: [number, number][] = [out[0]];
    for (let i = 0; i + 1 < out.length; i++) {
      const [a, b] = out[i];
      const [c, d] = out[i + 1];
      next.push([a * 0.75 + c * 0.25, b * 0.75 + d * 0.25], [a * 0.25 + c * 0.75, b * 0.25 + d * 0.75]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

/** Sweep the body. Detail 2 has arches and a smooth profile. Detail 1 has neither. */
function loft(b: Builder, s: LoftSpec, detail: 1 | 2): void {
  const prof = detail === 2 ? chaikin(s.profile, 2) : s.profile;
  const zF = prof[0][0];
  const zB = prof[prof.length - 1][0];
  const archR = s.wheelR * 1.14;
  const set = new Set(prof.map((p) => Math.round(p[0] * 1000) / 1000));
  if (detail === 2) {
    for (const zw of s.wheelsZ) {
      for (let i = 0; i <= 10; i++) set.add(Math.round((zw - archR + (i / 10) * archR * 2) * 1000) / 1000);
    }
  }
  const zs = [...set].sort((p, q) => p - q);
  const sillY = (z: number) => {
    if (detail === 1) return s.sill;
    let y = s.sill;
    for (const zw of s.wheelsZ) {
      const d = Math.abs(z - zw);
      if (d < archR) y = Math.max(y, s.wheelR + Math.sqrt(archR * archR - d * d));
    }
    return y;
  };
  const plan = (z: number) => {
    const e = Math.min(z - zF, zB - z);
    const t = Math.min(1, e / 0.5);
    return s.hw - s.taper * (1 - t) * (1 - t);
  };
  const beltAt = (z: number) => s.belt[0] + (s.belt[1] - s.belt[0]) * ((z - zF) / (zB - zF));
  // Cross section, right side, bottom to crown.
  const section = (z: number): number[][] => {
    const top = topAt(prof, z);
    const w = plan(z);
    const belt = Math.min(beltAt(z), top);
    const sy = Math.min(sillY(z), belt - 0.02);
    const greenhouse = top > belt + 0.04;
    const roofW = greenhouse ? w * s.roofHw : w * 0.84;
    return [
      [w * 0.95, sy, z],
      [w, sy + (belt - sy) * 0.55, z],
      [w * 0.985, belt, z],
      [roofW, top, z],
      [0, top + 0.015, z],
    ];
  };
  const inRange = (z: number, r: [number, number] | null) => r !== null && z >= r[0] - 1e-3 && z <= r[1] + 1e-3;
  for (let i = 0; i + 1 < zs.length; i++) {
    const a = section(zs[i]);
    const c = section(zs[i + 1]);
    const mid = (zs[i] + zs[i + 1]) / 2;
    for (let k = 0; k < 4; k++) {
      let color: C = WHITE;
      let part = PART_BODY;
      if (k === 2 && inRange(mid, s.sideGlass)) {
        color = GLASS;
        part = PART_GLASS;
      }
      if (k === 3 && (inRange(mid, s.windscreen) || inRange(mid, s.rearGlass))) {
        color = GLASS;
        part = PART_GLASS;
      }
      const p = a[k];
      const q = c[k];
      const r = c[k + 1];
      const t = a[k + 1];
      b.quad(p, t, r, q, color, part);
      const m = (v: number[]) => [-v[0], v[1], v[2]];
      b.quad(m(p), m(q), m(r), m(t), color, part);
    }
  }
  // Nose and tail caps.
  const cap = (z: number, sign: number) => {
    const sec = section(z);
    const c = [0, (sec[0][1] + sec[4][1]) / 2, z];
    const bottom = [0, sec[0][1], z];
    const pts = [bottom, ...sec.slice(0, 4), sec[4]];
    for (let k = 0; k + 1 < pts.length; k++) {
      const p = pts[k];
      const q = pts[k + 1];
      if (sign < 0) {
        b.tri(c, q, p, WHITE, PART_BODY);
        b.tri(c, [-p[0], p[1], p[2]], [-q[0], q[1], q[2]], WHITE, PART_BODY);
      } else {
        b.tri(c, p, q, WHITE, PART_BODY);
        b.tri(c, [-q[0], q[1], q[2]], [-p[0], p[1], p[2]], WHITE, PART_BODY);
      }
    }
  };
  cap(zF, -1);
  cap(zB, 1);
  // Dark underbody fills the wheel wells.
  b.box(-s.hw + 0.16, s.hw - 0.16, s.sill - 0.04, s.sill + 0.5, zF + 0.1, zB - 0.1, TRIM, PART_FIXED, { bottom: true });
}

function wheels(b: Builder, zs: number[], x: number, r: number, w: number, sides: number): void {
  for (const z of zs) {
    b.wheel(x, z, r, w, sides);
    b.wheel(-x, z, r, w, sides);
  }
}

function frontLamps(b: Builder, hw: number, z: number, y: number, h: number): void {
  const inner = hw * 0.42;
  b.front(-hw, -inner, y, y + h, z, HEAD, PART_HEAD);
  b.front(inner, hw, y, y + h, z, HEAD, PART_HEAD);
  b.front(-hw, -hw + 0.1, y - 0.12, y - 0.01, z, INDICATOR, PART_BLINK_L);
  b.front(hw - 0.1, hw, y - 0.12, y - 0.01, z, INDICATOR, PART_BLINK_R);
}

function rearLamps(b: Builder, hw: number, z: number, y: number, h: number): void {
  const inner = hw * 0.46;
  b.back(-hw, -inner, y, y + h, z, LAMP, PART_BRAKE);
  b.back(inner, hw, y, y + h, z, LAMP, PART_BRAKE);
  b.back(-hw, -hw + 0.12, y - 0.12, y - 0.01, z, INDICATOR, PART_BLINK_L);
  b.back(hw - 0.12, hw, y - 0.12, y - 0.01, z, INDICATOR, PART_BLINK_R);
}

export interface ModelSet {
  near: THREE.BufferGeometry;
  mid: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
  /** Half length, half width, height. */
  size: [number, number, number];
}

interface CarSpec {
  loft: LoftSpec;
  hl: number;
  height: number;
  lampY: number;
  tailY: number;
  mirrorZ: number;
}

function car(spec: CarSpec): ModelSet {
  const s = spec.loft;
  const hw = s.hw;
  const wheelX = hw + 0.005;
  const detail = (b: Builder) => {
    const hwF = hw - s.taper;
    const zF = -spec.hl;
    const zB = spec.hl;
    frontLamps(b, hwF - 0.02, zF - 0.012, spec.lampY, 0.14);
    b.front(-hwF * 0.42, hwF * 0.42, spec.lampY - 0.04, spec.lampY + 0.12, zF - 0.01, TRIM, PART_FIXED);
    b.front(-hwF * 0.9, hwF * 0.9, s.sill, s.sill + 0.17, zF - 0.012, TRIM, PART_FIXED);
    b.front(-0.24, 0.24, s.sill + 0.05, s.sill + 0.15, zF - 0.02, PLATE, PART_FIXED);
    rearLamps(b, hwF - 0.02, zB + 0.012, spec.tailY, 0.17);
    b.back(-hwF * 0.9, hwF * 0.9, s.sill, s.sill + 0.17, zB + 0.012, TRIM, PART_FIXED);
    b.back(-0.24, 0.24, s.sill + 0.2, s.sill + 0.31, zB + 0.015, PLATE, PART_FIXED);
    // Door mirrors.
    b.box(hw, hw + 0.18, spec.loft.belt[0] + 0.03, spec.loft.belt[0] + 0.13, spec.mirrorZ, spec.mirrorZ + 0.1, WHITE, PART_BODY, { bottom: true });
    b.box(-hw - 0.18, -hw, spec.loft.belt[0] + 0.03, spec.loft.belt[0] + 0.13, spec.mirrorZ, spec.mirrorZ + 0.1, WHITE, PART_BODY, { bottom: true });
    // A dark shadow line where doors meet the sill.
    b.side(hw + 0.002, s.sideGlass[0], s.sideGlass[1], s.sill, s.sill + 0.05, TRIM, PART_FIXED);
    b.side(-hw - 0.002, s.sideGlass[0], s.sideGlass[1], s.sill, s.sill + 0.05, TRIM, PART_FIXED);
  };
  const near = new Builder();
  loft(near, s, 2);
  wheels(near, s.wheelsZ, wheelX, s.wheelR, 0.24, 14);
  detail(near);
  // B pillar breaks up the side glass.
  const bz = (s.sideGlass[0] + s.sideGlass[1]) / 2;
  const by = spec.loft.belt[0];
  near.side(hw * 0.982, bz - 0.04, bz + 0.04, by, by + 0.42, TRIM, PART_FIXED);
  near.side(-hw * 0.982, bz - 0.04, bz + 0.04, by, by + 0.42, TRIM, PART_FIXED);

  const mid = new Builder();
  loft(mid, s, 1);
  wheels(mid, s.wheelsZ, wheelX, s.wheelR, 0.24, 6);
  frontLamps(mid, hw - s.taper - 0.02, -spec.hl - 0.012, spec.lampY, 0.14);
  rearLamps(mid, hw - s.taper - 0.02, spec.hl + 0.012, spec.tailY, 0.17);

  const far = new Builder();
  const belt = s.belt[0];
  far.box(-hw, hw, s.sill * 0.6, belt, -spec.hl, spec.hl, WHITE, PART_BODY);
  far.box(-hw + 0.1, hw - 0.1, belt, spec.height, s.windscreen[0] + 0.1, s.sideGlass[1] + 0.2, GLASS, PART_GLASS, { front: 0.3, back: 0.25, side: 0.12 });
  far.back(-hw + 0.05, hw - 0.05, spec.tailY, spec.tailY + 0.16, spec.hl + 0.02, LAMP, PART_BRAKE);
  far.front(-hw + 0.05, hw - 0.05, spec.lampY, spec.lampY + 0.14, -spec.hl - 0.02, HEAD, PART_HEAD);
  return { near: near.build(38), mid: mid.build(38), far: far.build(1), size: [spec.hl, hw, spec.height] };
}

function sedan(): ModelSet {
  return car({
    hl: 2.3,
    height: 1.45,
    lampY: 0.62,
    tailY: 0.72,
    mirrorZ: -0.68,
    loft: {
      profile: [[-2.3, 0.62], [-2.22, 0.76], [-1.1, 0.92], [-0.68, 0.96], [0.0, 1.42], [0.9, 1.45], [1.55, 1.02], [2.16, 0.98], [2.3, 0.72]],
      hw: 0.9,
      roofHw: 0.7,
      sill: 0.22,
      belt: [0.86, 0.94],
      wheelsZ: [-1.38, 1.36],
      wheelR: 0.33,
      windscreen: [-0.68, 0.0],
      rearGlass: [0.9, 1.55],
      sideGlass: [-0.55, 1.28],
      taper: 0.16,
    },
  });
}

function hatchback(): ModelSet {
  return car({
    hl: 2.0,
    height: 1.5,
    lampY: 0.68,
    tailY: 0.88,
    mirrorZ: -0.56,
    loft: {
      profile: [[-2.0, 0.66], [-1.93, 0.82], [-1.12, 0.98], [-0.72, 1.02], [-0.06, 1.47], [1.08, 1.5], [1.86, 1.08], [2.0, 0.76]],
      hw: 0.88,
      roofHw: 0.72,
      sill: 0.22,
      belt: [0.92, 1.02],
      wheelsZ: [-1.24, 1.26],
      wheelR: 0.32,
      windscreen: [-0.72, -0.06],
      rearGlass: [1.08, 1.86],
      sideGlass: [-0.6, 1.2],
      taper: 0.17,
    },
  });
}

function suv(): ModelSet {
  return car({
    hl: 2.4,
    height: 1.82,
    lampY: 0.86,
    tailY: 1.02,
    mirrorZ: -0.66,
    loft: {
      profile: [[-2.4, 0.84], [-2.3, 1.02], [-1.24, 1.16], [-0.82, 1.2], [-0.12, 1.78], [1.6, 1.82], [2.26, 1.34], [2.4, 0.9]],
      hw: 0.97,
      roofHw: 0.78,
      sill: 0.34,
      belt: [1.1, 1.18],
      wheelsZ: [-1.46, 1.46],
      wheelR: 0.39,
      windscreen: [-0.82, -0.12],
      rearGlass: [1.6, 2.26],
      sideGlass: [-0.72, 1.92],
      taper: 0.14,
    },
  });
}

function van(): ModelSet {
  return car({
    hl: 2.7,
    height: 2.3,
    lampY: 0.84,
    tailY: 0.92,
    mirrorZ: -1.4,
    loft: {
      profile: [[-2.7, 0.8], [-2.62, 1.0], [-2.08, 1.14], [-1.28, 2.2], [-0.8, 2.3], [2.62, 2.3], [2.7, 2.1]],
      hw: 1.0,
      roofHw: 0.9,
      sill: 0.36,
      belt: [1.16, 1.2],
      wheelsZ: [-1.72, 1.72],
      wheelR: 0.36,
      windscreen: [-2.08, -1.28],
      rearGlass: null,
      sideGlass: [-1.92, -0.72],
      taper: 0.1,
    },
  });
}

function bus(): ModelSet {
  const hw = 1.25;
  const hl = 6;
  const spec: LoftSpec = {
    profile: [[-6, 1.0], [-5.96, 2.2], [-5.7, 3.02], [-5.2, 3.1], [5.7, 3.1], [5.97, 2.95], [6, 1.0]],
    hw,
    roofHw: 0.93,
    sill: 0.34,
    belt: [1.3, 1.34],
    wheelsZ: [-3.4, 3.2],
    wheelR: 0.5,
    windscreen: [-5.96, -5.7],
    rearGlass: null,
    sideGlass: [-5.7, 5.5],
    taper: 0.06,
  };
  const dressing = (b: Builder, nearDetail: boolean) => {
    b.front(-hw + 0.1, hw - 0.1, 1.34, 2.74, -6.02, GLASS, PART_GLASS);
    frontLamps(b, hw - 0.08, -6.02, 0.72, 0.16);
    rearLamps(b, hw - 0.06, 6.02, 1.0, 0.24);
    b.back(-hw + 0.18, hw - 0.18, 1.62, 2.72, 6.02, GLASS, PART_GLASS);
    if (!nearDetail) return;
    b.back(-hw + 0.12, hw - 0.12, 0.34, 0.5, 6.03, TRIM, PART_FIXED);
    b.back(-0.7, 0.7, 1.28, 1.5, 6.03, TRIM, PART_FIXED);
    b.front(-hw + 0.1, hw - 0.1, 0.34, 0.5, -6.03, TRIM, PART_FIXED);
    // Door leaves on the kerb side and pillars along the glass.
    for (const z of [-4.7, -0.4]) {
      b.side(hw + 0.01, z - 0.65, z + 0.65, 0.45, 2.7, GLASS, PART_GLASS);
      b.side(hw + 0.015, z - 0.02, z + 0.02, 0.45, 2.7, TRIM, PART_FIXED);
    }
    for (let z = -4; z < 5.4; z += 1.9) {
      b.side(hw * 0.985 + 0.015, z - 0.04, z + 0.04, 1.34, 2.72, TRIM, PART_FIXED);
      b.side(-hw * 0.985 - 0.015, z - 0.04, z + 0.04, 1.34, 2.72, TRIM, PART_FIXED);
    }
    b.box(-0.8, 0.8, 3.1, 3.32, -2.4, 0.6, hexRGB(0xc8c8c4), PART_FIXED);
    b.box(-0.6, 0.6, 3.1, 3.26, 2.2, 4, hexRGB(0xc8c8c4), PART_FIXED);
    b.side(hw + 0.002, -5.6, 5.6, 0.34, 0.4, TRIM, PART_FIXED);
    b.side(-hw - 0.002, -5.6, 5.6, 0.34, 0.4, TRIM, PART_FIXED);
  };
  const near = new Builder();
  loft(near, spec, 2);
  wheels(near, spec.wheelsZ, hw + 0.005, 0.5, 0.3, 14);
  dressing(near, true);
  const mid = new Builder();
  loft(mid, spec, 1);
  wheels(mid, spec.wheelsZ, hw + 0.005, 0.5, 0.3, 6);
  dressing(mid, false);
  const far = new Builder();
  far.box(-hw, hw, 0.3, 3.1, -hl, hl, WHITE, PART_BODY);
  far.side(hw + 0.01, -5.6, 5.6, 1.4, 2.7, GLASS, PART_GLASS);
  far.side(-hw - 0.01, -5.6, 5.6, 1.4, 2.7, GLASS, PART_GLASS);
  far.back(-hw + 0.05, hw - 0.05, 1, 1.2, hl + 0.02, LAMP, PART_BRAKE);
  far.front(-hw + 0.05, hw - 0.05, 0.7, 0.86, -hl - 0.02, HEAD, PART_HEAD);
  return { near: near.build(35), mid: mid.build(35), far: far.build(1), size: [hl, hw, 3.1] };
}

function cab(b: Builder, zF: number, zB: number, hw: number, lowH: number, topH: number): void {
  b.box(-hw, hw, 0.62, lowH, zF, zB, WHITE, PART_BODY, { side: 0.02 });
  b.box(-hw + 0.03, hw - 0.03, lowH, topH, zF, zB, WHITE, PART_BODY, { front: 0.32, side: 0.1 });
  const y0 = lowH + 0.08;
  const y1 = topH - 0.16;
  const slope = (0.32 * (y1 - lowH)) / (topH - lowH);
  const f0 = zF + (0.32 * (y0 - lowH)) / (topH - lowH) - 0.012;
  b.quad([hw - 0.18, y0, f0], [-hw + 0.18, y0, f0], [-hw + 0.22, y1, zF + slope - 0.012], [hw - 0.22, y1, zF + slope - 0.012], GLASS, PART_GLASS);
  b.side(hw - 0.058, zF + 0.4, zB - 0.5, y0, y1, GLASS, PART_GLASS);
  b.side(-hw + 0.058, zF + 0.4, zB - 0.5, y0, y1, GLASS, PART_GLASS);
  frontLamps(b, hw - 0.04, zF - 0.012, 0.84, 0.16);
  b.front(-hw + 0.3, hw - 0.3, 0.92, 1.34, zF - 0.012, TRIM, PART_FIXED);
  b.front(-hw, hw, 0.46, 0.68, zF - 0.012, TRIM, PART_FIXED);
  b.box(hw, hw + 0.2, lowH + 0.1, lowH + 0.6, zF + 0.3, zF + 0.4, TRIM, PART_FIXED, { bottom: true });
  b.box(-hw - 0.2, -hw, lowH + 0.1, lowH + 0.6, zF + 0.3, zF + 0.4, TRIM, PART_FIXED, { bottom: true });
}

const BOX_PANEL = hexRGB(0xd2d0c8);
const BOX_RIB = hexRGB(0xb0aea6);

function boxTruck(): ModelSet {
  const hw = 1.22;
  const hl = 5.2;
  const body = (b: Builder, ribs: boolean, sides: number) => {
    b.box(-0.55, 0.55, 0.42, 0.72, -3.0, 5.0, TRIM, PART_FIXED);
    b.box(-hw - 0.03, hw + 0.03, 0.74, 3.6, -2.75, 5.2, BOX_PANEL, PART_FIXED, { bottom: true });
    if (ribs) {
      for (let z = -2.4; z < 5.1; z += 1.2) {
        b.side(hw + 0.045, z - 0.05, z + 0.05, 0.78, 3.56, BOX_RIB, PART_FIXED);
        b.side(-hw - 0.045, z - 0.05, z + 0.05, 0.78, 3.56, BOX_RIB, PART_FIXED);
      }
      b.back(-1, -0.03, 0.9, 3.4, 5.21, BOX_RIB, PART_FIXED);
      b.back(0.03, 1, 0.9, 3.4, 5.21, BOX_RIB, PART_FIXED);
    }
    rearLamps(b, hw, 5.215, 0.86, 0.14);
    wheels(b, [-3.75, 2.5, 3.72], hw + 0.005, 0.5, 0.32, sides);
  };
  const near = new Builder();
  cab(near, -5.2, -2.85, hw, 1.55, 2.95);
  body(near, true, 12);
  const mid = new Builder();
  cab(mid, -5.2, -2.85, hw, 1.55, 2.95);
  body(mid, false, 6);
  const far = new Builder();
  far.box(-hw, hw, 0.5, 2.95, -5.2, -2.85, WHITE, PART_BODY);
  far.box(-hw, hw, 0.6, 3.6, -2.75, 5.2, BOX_PANEL, PART_FIXED);
  far.back(-hw + 0.05, hw - 0.05, 0.86, 1, 5.22, LAMP, PART_BRAKE);
  far.front(-hw + 0.05, hw - 0.05, 0.84, 1, -5.22, HEAD, PART_HEAD);
  return { near: near.build(25), mid: mid.build(25), far: far.build(1), size: [hl, hw, 3.6] };
}

/** A tractor and semi-trailer, cut down to the 12 m the sim allows and kept rigid. */
function articulated(): ModelSet {
  const hw = 1.24;
  const hl = 6;
  const trailer = (b: Builder, ribs: boolean, sides: number) => {
    b.box(-0.5, 0.5, 0.5, 0.8, -6, -2.2, TRIM, PART_FIXED);
    b.box(-0.48, 0.48, 0.92, 1.05, -3.1, -2.1, hexRGB(0x3c3e42), PART_CHROME);
    b.box(-hw, hw, 1.1, 3.7, -2.6, 6, hexRGB(0xdcdad2), PART_FIXED, { bottom: true });
    b.box(-hw + 0.02, hw - 0.02, 0.9, 1.1, -2.5, 5.9, TRIM, PART_FIXED);
    if (ribs) {
      for (let z = -2.2; z < 6; z += 0.92) {
        b.side(hw + 0.012, z - 0.03, z + 0.03, 1.12, 3.68, BOX_RIB, PART_FIXED);
        b.side(-hw - 0.012, z - 0.03, z + 0.03, 1.12, 3.68, BOX_RIB, PART_FIXED);
      }
      // Coloured band along the trailer, in the body colour.
      b.side(hw + 0.02, -2.4, 5.8, 2.1, 2.7, WHITE, PART_BODY);
      b.side(-hw - 0.02, -2.4, 5.8, 2.1, 2.7, WHITE, PART_BODY);
    }
    rearLamps(b, hw, 6.012, 1.0, 0.14);
    wheels(b, [-4.4, 3.2, 4.3, 5.3], hw + 0.005, 0.48, 0.3, sides);
    wheels(b, [-3.2], hw + 0.005, 0.48, 0.3, sides);
  };
  const near = new Builder();
  cab(near, -6, -3.9, hw, 1.5, 3.05);
  near.box(-hw + 0.1, hw - 0.1, 3.05, 3.45, -5.2, -3.9, WHITE, PART_BODY, { front: 0.6, side: 0.06 });
  near.box(hw - 0.1, hw + 0.02, 0.62, 1.05, -3.8, -3.0, hexRGB(0x9aa0a6), PART_CHROME);
  near.box(-hw - 0.02, -hw + 0.1, 0.62, 1.05, -3.8, -3.0, hexRGB(0x9aa0a6), PART_CHROME);
  trailer(near, true, 12);
  const mid = new Builder();
  cab(mid, -6, -3.9, hw, 1.5, 3.05);
  trailer(mid, false, 6);
  const far = new Builder();
  far.box(-hw, hw, 0.5, 3.05, -6, -3.8, WHITE, PART_BODY);
  far.box(-hw, hw, 0.8, 3.7, -2.6, 6, hexRGB(0xdcdad2), PART_FIXED);
  far.back(-hw + 0.05, hw - 0.05, 1, 1.14, 6.02, LAMP, PART_BRAKE);
  far.front(-hw + 0.05, hw - 0.05, 0.84, 1, -6.02, HEAD, PART_HEAD);
  return { near: near.build(25), mid: mid.build(25), far: far.build(1), size: [hl, hw, 3.7] };
}

/** Rider and bicycle. The body colour goes on the jersey. */
function bicycle(): ModelSet {
  const skin = hexRGB(0xc89070);
  const legs = hexRGB(0x24262c);
  const frame = hexRGB(0x30343a);
  const hl = 0.9;
  const build = (b: Builder, sides: number) => {
    const wheel = (z: number) => {
      const r = 0.34;
      for (let i = 0; i < sides; i++) {
        const a0 = (i / sides) * Math.PI * 2;
        const a1 = ((i + 1) / sides) * Math.PI * 2;
        const p = [0, r + Math.cos(a0) * r, z + Math.sin(a0) * r];
        const q = [0, r + Math.cos(a1) * r, z + Math.sin(a1) * r];
        const inner = 0.88;
        const pi = [0, r + Math.cos(a0) * r * inner, z + Math.sin(a0) * r * inner];
        const qi = [0, r + Math.cos(a1) * r * inner, z + Math.sin(a1) * r * inner];
        b.quad(pi, p, q, qi, RUBBER, PART_FIXED);
        b.quad(qi, q, p, pi, RUBBER, PART_FIXED);
      }
    };
    wheel(-0.56);
    wheel(0.56);
    b.box(-0.025, 0.025, 0.36, 0.66, -0.5, 0.42, frame, PART_FIXED, { bottom: true });
    b.box(-0.025, 0.025, 0.66, 0.92, 0.1, 0.16, frame, PART_FIXED, { bottom: true });
    b.box(-0.025, 0.025, 0.66, 1.02, -0.5, -0.45, frame, PART_FIXED, { bottom: true });
    b.box(-0.24, 0.24, 1.02, 1.05, -0.5, -0.46, frame, PART_FIXED, { bottom: true });
    // Rider, leaning to the bars.
    b.box(-0.14, 0.14, 0.58, 0.96, 0.08, 0.24, legs, PART_FIXED, { bottom: true });
    b.box(-0.17, 0.17, 0.94, 1.5, -0.14, 0.26, WHITE, PART_BODY, { front: 0.08, back: 0.14, side: 0.03, bottom: true });
    b.box(-0.22, -0.16, 1.02, 1.44, -0.42, -0.08, WHITE, PART_BODY, { bottom: true });
    b.box(0.16, 0.22, 1.02, 1.44, -0.42, -0.08, WHITE, PART_BODY, { bottom: true });
    b.box(-0.1, 0.1, 1.5, 1.72, -0.17, 0.03, skin, PART_FIXED, { bottom: true });
    b.box(-0.12, 0.12, 1.66, 1.76, -0.2, 0.07, hexRGB(0xe8e4dc), PART_FIXED);
    b.back(-0.05, 0.05, 0.84, 0.92, 0.45, LAMP, PART_BRAKE);
    b.front(-0.05, 0.05, 0.92, 0.98, -0.52, HEAD, PART_HEAD);
  };
  const near = new Builder();
  build(near, 14);
  const mid = new Builder();
  build(mid, 7);
  const far = new Builder();
  far.box(-0.03, 0.03, 0.05, 0.7, -0.88, 0.88, RUBBER, PART_FIXED);
  far.box(-0.17, 0.17, 0.7, 1.72, -0.14, 0.24, WHITE, PART_BODY);
  return { near: near.build(25), mid: mid.build(25), far: far.build(1), size: [hl, 0.3, 1.76] };
}

export const MODEL_NAMES = ['sedan', 'hatchback', 'suv', 'van', 'boxTruck', 'articulated', 'bus', 'bicycle'] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

export function buildModels(): ModelSet[] {
  return [sedan(), hatchback(), suv(), van(), boxTruck(), articulated(), bus(), bicycle()];
}
