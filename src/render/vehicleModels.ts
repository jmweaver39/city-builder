/**
 * Vehicle models built from primitives. Bodies are lofted: a side profile and a
 * cross section swept nose to tail. The section has a rocker, a rounded lower
 * body, a belt crease, framed glass set in from the paint with tumblehome, and a
 * rounded roof rail; the sills lift around each wheel so the arches read, and the
 * plan rounds off at the corners. Door seams, handles, mirrors, light clusters,
 * bumpers, grilles and plates go on top. Wheels are tyres with a shoulder and a
 * spoked rim set into a dish.
 *
 * Front is -Z, origin is on the ground under the middle of the model. Each model
 * comes at three levels of detail: near (full), mid (coarse loft, plain wheels)
 * and far (boxes).
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
/** Truck boxes and bus upper bodies: white or the body colour, by livery. */
export const PART_LIVERY = 8;

type C = readonly number[];

const WHITE: C = [1, 1, 1];
const GLASS: C = hexRGB(0x2c3a46);
const TRIM: C = hexRGB(0x141518);
const SEAM: C = hexRGB(0x0c0d0e);
const RUBBER: C = hexRGB(0x101113);
const RIM: C = hexRGB(0xb4b8bc);
const RIM_DARK: C = hexRGB(0x2a2c30);
const LAMP: C = hexRGB(0x6a1210);
const REFLECTOR: C = hexRGB(0x8a1a12);
const INDICATOR: C = hexRGB(0x9a6210);
const HEAD: C = hexRGB(0xdfe3e2);
const BEZEL: C = hexRGB(0x3a3e44);
const PLATE: C = hexRGB(0xe0ded2);
const CHROME: C = hexRGB(0xc8ccd0);

type V = number[];

class Builder {
  pos: number[] = [];
  col: number[] = [];
  part: number[] = [];

  tri(a: V, b: V, c: V, color: C, part: number): void {
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.col.push(color[0], color[1], color[2]);
      this.part.push(part);
    }
  }

  /** Counter-clockwise from the normal side. */
  quad(a: V, b: V, c: V, d: V, color: C, part: number): void {
    this.tri(a, b, c, color, part);
    this.tri(a, c, d, color, part);
  }

  /** Quad wound so its normal agrees with `out`. */
  facing(a: V, b: V, c: V, d: V, out: V, color: C, part: number): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] >= 0) this.quad(a, b, c, d, color, part);
    else this.quad(a, d, c, b, color, part);
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

  /** Round tube from p to q with flat ends. */
  tube(p: V, q: V, r: number, sides: number, color: C, part: number, caps = true): void {
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    const t = [d[0] / l, d[1] / l, d[2] / l];
    const ref = Math.abs(t[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    let a = [t[1] * ref[2] - t[2] * ref[1], t[2] * ref[0] - t[0] * ref[2], t[0] * ref[1] - t[1] * ref[0]];
    const al = Math.hypot(a[0], a[1], a[2]) || 1;
    a = [a[0] / al, a[1] / al, a[2] / al];
    const b = [t[1] * a[2] - t[2] * a[1], t[2] * a[0] - t[0] * a[2], t[0] * a[1] - t[1] * a[0]];
    const ring = (o: V, i: number): V => {
      const ang = (i / sides) * Math.PI * 2;
      const c = Math.cos(ang) * r;
      const s = Math.sin(ang) * r;
      return [o[0] + a[0] * c + b[0] * s, o[1] + a[1] * c + b[1] * s, o[2] + a[2] * c + b[2] * s];
    };
    for (let i = 0; i < sides; i++) {
      const ang = ((i + 0.5) / sides) * Math.PI * 2;
      const out = [a[0] * Math.cos(ang) + b[0] * Math.sin(ang), a[1] * Math.cos(ang) + b[1] * Math.sin(ang), a[2] * Math.cos(ang) + b[2] * Math.sin(ang)];
      this.facing(ring(p, i), ring(p, i + 1), ring(q, i + 1), ring(q, i), out, color, part);
      if (caps) {
        this.facing(p, p, ring(p, i + 1), ring(p, i), [-t[0], -t[1], -t[2]], color, part);
        this.facing(q, q, ring(q, i), ring(q, i + 1), t, color, part);
      }
    }
  }

  /**
   * Tyre with a rounded shoulder, and a spoked rim in a dish. x is the outer face;
   * the wheel stands on the ground at z.
   */
  wheel(x: number, z: number, r: number, w: number, sides: number, rimR = 0.64, spokes = 5): void {
    const sign = x > 0 ? 1 : -1;
    const at = (a: number, rho: number, i: number): V => {
      const ang = (i / sides) * Math.PI * 2;
      return [x - sign * a, r + Math.cos(ang) * rho, z + Math.sin(ang) * rho];
    };
    const axial = [sign, 0, 0];
    // Tyre: sidewall, shoulder, tread. Each ring of the profile to the next.
    const tyre: [number, number][] = sides > 8 ? [[0.012, rimR * r], [0.004, r * 0.9], [0.03, r], [w - 0.03, r]] : [[0.006, rimR * r], [0.006, r], [w, r]];
    for (let i = 0; i < sides; i++) {
      const ang = ((i + 0.5) / sides) * Math.PI * 2;
      const radial = [0, Math.cos(ang), Math.sin(ang)];
      for (let j = 0; j + 1 < tyre.length; j++) {
        const [a0, r0] = tyre[j];
        const [a1, r1] = tyre[j + 1];
        // Mostly axial where the radius grows, radial where the tyre runs across.
        const out = Math.abs(r1 - r0) > Math.abs(a1 - a0) ? axial : radial;
        this.facing(at(a0, r0, i), at(a0, r0, i + 1), at(a1, r1, i + 1), at(a1, r1, i), out, RUBBER, PART_FIXED);
      }
      // Rim: lip, then a dish to the hub, spokes standing proud of dark gaps.
      const spoke = sides > 8 ? Math.floor((i * spokes * 2) / sides) % 2 === 0 : true;
      const rimC = spoke ? RIM : RIM_DARK;
      this.facing(at(0.012, rimR * r, i), at(0.012, rimR * r, i + 1), at(0.03, rimR * r * 0.9, i + 1), at(0.03, rimR * r * 0.9, i), axial, RIM, PART_CHROME);
      const dish = spoke ? 0.035 : 0.07;
      this.facing(at(0.03, rimR * r * 0.9, i), at(0.03, rimR * r * 0.9, i + 1), at(dish, r * 0.2, i + 1), at(dish, r * 0.2, i), axial, rimC, spoke ? PART_CHROME : PART_FIXED);
      this.facing(at(dish, r * 0.2, i), at(dish, r * 0.2, i + 1), at(0.03, 0, i + 1), at(0.03, 0, i), axial, RIM, PART_CHROME);
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
    // Smooth within a part, across edges gentler than the limit. Paint and the
    // livery panel smooth together, so a two-tone body stays one surface.
    const groupOf = (p: number) => (p === PART_LIVERY ? PART_BODY : p);
    const keyOf = (i: number) => `${Math.round(pos[i * 3] * 500)},${Math.round(pos[i * 3 + 1] * 500)},${Math.round(pos[i * 3 + 2] * 500)},${groupOf(this.part[i])}`;
    const groups = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const key = keyOf(i);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(i);
    }
    const limit = Math.cos((smoothDeg * Math.PI) / 180);
    for (let i = 0; i < n; i++) {
      const own = face[Math.floor(i / 3)];
      let x = 0;
      let y = 0;
      let z = 0;
      for (const j of groups.get(keyOf(i))!) {
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
  /** Plan rounding at the nose and tail, metres in from full width. */
  taper: number;
  /** Door shut lines, as z. */
  seams?: number[];
  /** Where the top is a dark cover (a pickup's bed). */
  topTrim?: [number, number];
  /** Paint above the belt in this colour, not the body's (bus liveries). */
  upper?: { color: C; part: number };
  /** Where the side above the belt is the upper colour even inside the glass range. */
  sidePanels?: [number, number][];
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

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Sweep the body. Detail 2: arches, seams, framed and inset glass. Detail 1: coarse. */
function loft(b: Builder, s: LoftSpec, detail: 1 | 2): void {
  const prof = detail === 2 ? chaikin(s.profile, 2) : s.profile;
  const zF = prof[0][0];
  const zB = prof[prof.length - 1][0];
  const archR = s.wheelR * 1.16;
  const set = new Set(prof.map((p) => Math.round(p[0] * 1000) / 1000));
  const add = (z: number) => {
    if (z > zF + 0.005 && z < zB - 0.005) set.add(Math.round(z * 1000) / 1000);
  };
  const seams = detail === 2 ? (s.seams ?? []) : [];
  if (detail === 2) {
    for (const zw of s.wheelsZ) for (let i = 0; i <= 10; i++) add(zw - archR + (i / 10) * archR * 2);
    // Frames at the ends of the side glass, seams as thin dark bands.
    for (const z of [s.sideGlass[0], s.sideGlass[1]]) {
      add(z);
      add(z + 0.035);
      add(z - 0.035);
    }
    for (const z of seams) {
      add(z - 0.006);
      add(z + 0.006);
    }
    for (const r of [s.windscreen, s.rearGlass, s.topTrim]) if (r) for (const z of r) add(z);
    for (const p of s.sidePanels ?? []) for (const z of p) add(z);
  } else {
    for (const z of [s.sideGlass[0], s.sideGlass[1], s.windscreen[0], s.windscreen[1]]) add(z);
    if (s.rearGlass) for (const z of s.rearGlass) add(z);
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
  // Plan: full width, rounding off over the last half metre at each end.
  const plan = (z: number) => {
    const e = Math.min(z - zF, zB - z);
    const t = clamp01(e / 0.55);
    return s.hw - s.taper * (1 - Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t))));
  };
  const beltAt = (z: number) => s.belt[0] + (s.belt[1] - s.belt[0]) * ((z - zF) / (zB - zF));
  const inRange = (z: number, r: [number, number] | null | undefined) => !!r && z >= r[0] - 1e-3 && z <= r[1] + 1e-3;
  const inner = (z: number, r: [number, number], m: number) => z >= r[0] + m - 1e-3 && z <= r[1] - m + 1e-3;
  // Cross section, right side, bottom to crown.
  const section = (z: number): V[] => {
    const top = topAt(prof, z);
    const w = plan(z);
    const belt = Math.min(beltAt(z), top);
    const sy = Math.min(sillY(z), belt - 0.05);
    const gh = clamp01((top - belt) / 0.3);
    const roofW = mix(w * 0.86, w * s.roofHw, gh);
    const glassSide = detail === 2 && inner(z, s.sideGlass, 0.03) && !(s.sidePanels ?? []).some((p) => inRange(z, p));
    const inset = glassSide ? 0.016 * gh : 0;
    if (detail === 1) {
      return [
        [w * 0.95, sy, z],
        [w, mix(sy, belt, 0.5), z],
        [w * 0.98, belt, z],
        [mix(w * 0.98, roofW * 1.02, gh), mix(belt, top - 0.04, gh), z],
        [mix(w * 0.6, roofW * 0.85, gh), top, z],
        [0, top + 0.015, z],
      ];
    }
    return [
      [w * 0.92, sy, z],
      [w * 0.985, sy + Math.min(0.07, (belt - sy) * 0.2), z],
      [w, mix(sy, belt, 0.45), z],
      [w * 0.994, belt - Math.min(0.05, (belt - sy) * 0.15), z],
      [w * 0.976, belt, z],
      [mix(w * 0.976, w * 0.962, gh) - inset, belt + 0.03 * gh, z],
      [mix(w * 0.976, roofW * 1.035, gh) - inset, mix(belt, top - 0.075, gh), z],
      [mix(w * 0.93, roofW, gh), top - 0.022 * gh, z],
      [mix(w * 0.62, roofW * 0.84, gh), top + 0.004, z],
      [0, top + 0.018, z],
    ];
  };
  const kGlassBottom = detail === 2 ? 4 : 2;
  const kGlass = detail === 2 ? 5 : 2;
  const kGlassTop = detail === 2 ? 6 : 3;
  const kRoof = detail === 2 ? 7 : 3;
  const upper = s.upper;
  for (let i = 0; i + 1 < zs.length; i++) {
    const a = section(zs[i]);
    const c = section(zs[i + 1]);
    const mid = (zs[i] + zs[i + 1]) / 2;
    const sideGlass = inRange(mid, s.sideGlass) && !(s.sidePanels ?? []).some((p) => inRange(mid, p));
    const framed = detail === 2 && sideGlass && !inner(mid, s.sideGlass, 0.035);
    const seam = seams.some((sz) => Math.abs(mid - sz) < 0.007);
    for (let k = 0; k + 1 < a.length; k++) {
      let color: C = WHITE;
      let part = PART_BODY;
      if (upper && k >= kGlassBottom) {
        color = upper.color;
        part = upper.part;
      }
      if (seam && k >= 1 && k <= kGlassBottom) {
        color = SEAM;
        part = PART_FIXED;
      }
      if (sideGlass && detail === 2) {
        if (k === kGlass) {
          color = framed ? TRIM : GLASS;
          part = framed ? PART_FIXED : PART_GLASS;
        } else if (k === kGlassBottom || k === kGlassTop) {
          color = TRIM;
          part = PART_FIXED;
        }
      } else if (sideGlass && k === kGlass) {
        color = GLASS;
        part = PART_GLASS;
      }
      if (k >= kRoof && (inRange(mid, s.windscreen) || inRange(mid, s.rearGlass))) {
        color = GLASS;
        part = PART_GLASS;
      }
      if (k >= kRoof && inRange(mid, s.topTrim)) {
        color = TRIM;
        part = PART_FIXED;
      }
      const p = a[k];
      const q = c[k];
      const r = c[k + 1];
      const t = a[k + 1];
      b.quad(p, t, r, q, color, part);
      const m = (v: V) => [-v[0], v[1], v[2]];
      b.quad(m(p), m(q), m(r), m(t), color, part);
    }
  }
  // Nose and tail caps.
  const cap = (z: number, sign: number) => {
    const sec = section(z);
    const top = sec[sec.length - 1];
    const c = [0, (sec[0][1] + top[1]) / 2, z];
    const bottom = [0, sec[0][1], z];
    const pts = [bottom, ...sec];
    for (let k = 0; k + 1 < pts.length; k++) {
      const p = pts[k];
      const q = pts[k + 1];
      const color = upper && k > kGlassBottom ? upper.color : WHITE;
      const part = upper && k > kGlassBottom ? upper.part : PART_BODY;
      if (sign < 0) {
        b.tri(c, q, p, color, part);
        b.tri(c, [-p[0], p[1], p[2]], [-q[0], q[1], q[2]], color, part);
      } else {
        b.tri(c, p, q, color, part);
        b.tri(c, [-q[0], q[1], q[2]], [-p[0], p[1], p[2]], color, part);
      }
    }
  };
  cap(zF, -1);
  cap(zB, 1);
  // Dark underbody fills the wheel wells.
  b.box(-s.hw + 0.14, s.hw - 0.14, s.sill - 0.04, s.sill + 0.55, zF + 0.12, zB - 0.12, TRIM, PART_FIXED, { bottom: true });
}

function wheels(b: Builder, zs: number[], x: number, r: number, w: number, sides: number, spokes = 5): void {
  for (const z of zs) {
    b.wheel(x, z, r, w, sides, 0.64, spokes);
    b.wheel(-x, z, r, w, sides, 0.64, spokes);
  }
}

/** Head lamp clusters with bezels, indicators at the outer corners. */
function frontLamps(b: Builder, hw: number, z: number, y: number, h: number, near: boolean): void {
  const inner = hw * 0.5;
  if (near) {
    b.front(-hw - 0.01, -inner + 0.01, y - 0.015, y + h + 0.015, z + 0.004, BEZEL, PART_FIXED);
    b.front(inner - 0.01, hw + 0.01, y - 0.015, y + h + 0.015, z + 0.004, BEZEL, PART_FIXED);
  }
  b.front(-hw + 0.1, -inner, y, y + h, z, HEAD, PART_HEAD);
  b.front(inner, hw - 0.1, y, y + h, z, HEAD, PART_HEAD);
  b.front(-hw, -hw + 0.1, y, y + h, z, INDICATOR, PART_BLINK_L);
  b.front(hw - 0.1, hw, y, y + h, z, INDICATOR, PART_BLINK_R);
}

/** Tail lamp clusters: brake lamp, indicator, a reflector in the bumper. */
function rearLamps(b: Builder, hw: number, z: number, y: number, h: number, near: boolean, bumperY = -1): void {
  const inner = hw * 0.52;
  if (near) {
    b.back(-hw - 0.01, -inner + 0.01, y - 0.015, y + h + 0.015, z - 0.004, BEZEL, PART_FIXED);
    b.back(inner - 0.01, hw + 0.01, y - 0.015, y + h + 0.015, z - 0.004, BEZEL, PART_FIXED);
  }
  b.back(-hw, -inner, y + h * 0.35, y + h, z, LAMP, PART_BRAKE);
  b.back(inner, hw, y + h * 0.35, y + h, z, LAMP, PART_BRAKE);
  b.back(-hw, -inner, y, y + h * 0.33, z, INDICATOR, PART_BLINK_L);
  b.back(inner, hw, y, y + h * 0.33, z, INDICATOR, PART_BLINK_R);
  if (near && bumperY > 0) {
    b.back(-hw + 0.02, -hw + 0.16, bumperY, bumperY + 0.04, z, REFLECTOR, PART_FIXED);
    b.back(hw - 0.16, hw - 0.02, bumperY, bumperY + 0.04, z, REFLECTOR, PART_FIXED);
  }
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
  mirrorZ: number;
  /** Grille height and width share. */
  grille?: [number, number];
}

function car(spec: CarSpec): ModelSet {
  const s = spec.loft;
  const hw = s.hw;
  const wheelX = hw - 0.02;
  const zF = -spec.hl;
  const zB = spec.hl;
  const noseTop = s.profile[0][1];
  const tailTop = s.profile[s.profile.length - 1][1];
  const hwF = hw - s.taper;
  const lampY = noseTop - 0.16;
  const tailY = tailTop - 0.2;
  const ends = (b: Builder, near: boolean) => {
    frontLamps(b, hwF - 0.04, zF - 0.012, lampY, 0.12, near);
    rearLamps(b, hwF - 0.03, zB + 0.012, tailY, 0.15, near, s.sill + 0.12);
    // Grille between the lamps, intake and bumper strip below, number plates.
    const [gh, gw] = spec.grille ?? [0.16, 0.42];
    b.front(-hwF * gw, hwF * gw, lampY - gh * 0.25, lampY + gh * 0.75, zF - 0.01, TRIM, PART_FIXED);
    b.front(-hwF * 0.72, hwF * 0.72, s.sill + 0.04, s.sill + 0.16, zF - 0.012, TRIM, PART_FIXED);
    b.back(-hwF * 0.85, hwF * 0.85, s.sill, s.sill + 0.1, zB + 0.012, TRIM, PART_FIXED);
    if (near) {
      b.front(-0.26, 0.26, s.sill + 0.18, s.sill + 0.29, zF - 0.016, PLATE, PART_FIXED);
      b.back(-0.26, 0.26, tailY - 0.2, tailY - 0.09, zB + 0.016, PLATE, PART_FIXED);
      // A chrome strip over the grille.
      b.front(-hwF * gw, hwF * gw, lampY + gh * 0.75, lampY + gh * 0.75 + 0.018, zF - 0.014, CHROME, PART_CHROME);
    }
  };
  const near = new Builder();
  loft(near, s, 2);
  wheels(near, s.wheelsZ, wheelX, s.wheelR, 0.22, 16);
  ends(near, true);
  // Door mirrors on stalks, body-coloured caps.
  const my = s.belt[0] + 0.04;
  for (const side of [1, -1]) {
    const x0 = side * (hw - 0.02);
    const x1 = side * (hw + 0.17);
    near.box(Math.min(x0, x1), Math.max(x0, x1), my, my + 0.13, spec.mirrorZ, spec.mirrorZ + 0.12, WHITE, PART_BODY, { bottom: true, side: 0.01 });
    near.side(side * (hw + 0.172), spec.mirrorZ + 0.02, spec.mirrorZ + 0.1, my + 0.02, my + 0.11, GLASS, PART_GLASS);
    // Door handles behind each seam.
    for (const sz of s.seams ?? []) {
      if (sz < s.sideGlass[0] + 0.3 || sz > s.sideGlass[1]) continue;
      const hz = sz - 0.32;
      near.side(side * (hw * 0.995 + 0.012), hz - 0.09, hz + 0.09, s.belt[0] - 0.12, s.belt[0] - 0.08, CHROME, PART_CHROME);
    }
  }
  // B pillar breaks up the side glass.
  const bSeam = (s.seams ?? []).find((z) => z > s.sideGlass[0] + 0.5 && z < s.sideGlass[1] - 0.4);
  const bz = bSeam ?? (s.sideGlass[0] + s.sideGlass[1]) / 2;
  near.side(hw * 0.968 + 0.004, bz - 0.05, bz + 0.05, s.belt[0] + 0.03, s.belt[0] + 0.42, TRIM, PART_FIXED);
  near.side(-hw * 0.968 - 0.004, bz - 0.05, bz + 0.05, s.belt[0] + 0.03, s.belt[0] + 0.42, TRIM, PART_FIXED);

  const mid = new Builder();
  loft(mid, s, 1);
  wheels(mid, s.wheelsZ, wheelX, s.wheelR, 0.22, 7);
  ends(mid, false);

  const far = new Builder();
  const belt = s.belt[0];
  far.box(-hw, hw, s.sill * 0.6, belt, -spec.hl, spec.hl, WHITE, PART_BODY);
  far.box(-hw + 0.1, hw - 0.1, belt, spec.height, s.windscreen[0] + 0.1, s.sideGlass[1] + 0.2, GLASS, PART_GLASS, { front: 0.3, back: 0.25, side: 0.12 });
  far.back(-hw + 0.05, hw - 0.05, tailY, tailY + 0.15, spec.hl + 0.02, LAMP, PART_BRAKE);
  far.front(-hw + 0.05, hw - 0.05, lampY, lampY + 0.12, -spec.hl - 0.02, HEAD, PART_HEAD);
  return { near: near.build(36), mid: mid.build(38), far: far.build(1), size: [spec.hl, hw, spec.height] };
}

function sedan(): ModelSet {
  return car({
    hl: 2.36,
    height: 1.45,
    mirrorZ: -0.74,
    loft: {
      profile: [[-2.36, 0.68], [-2.3, 0.78], [-1.6, 0.88], [-0.86, 0.96], [-0.1, 1.41], [0.72, 1.45], [1.5, 1.05], [2.22, 1.0], [2.36, 0.8]],
      hw: 0.91,
      roofHw: 0.72,
      sill: 0.2,
      belt: [0.9, 0.98],
      wheelsZ: [-1.42, 1.4],
      wheelR: 0.33,
      windscreen: [-0.86, -0.1],
      rearGlass: [0.72, 1.5],
      sideGlass: [-0.78, 1.4],
      taper: 0.2,
      seams: [-0.82, 0.32, 1.32],
    },
  });
}

function hatchback(): ModelSet {
  return car({
    hl: 2.05,
    height: 1.5,
    mirrorZ: -0.66,
    grille: [0.12, 0.36],
    loft: {
      profile: [[-2.05, 0.72], [-1.99, 0.82], [-1.3, 0.96], [-0.78, 1.03], [-0.05, 1.47], [1.1, 1.49], [1.92, 1.12], [2.05, 0.84]],
      hw: 0.88,
      roofHw: 0.73,
      sill: 0.21,
      belt: [0.96, 1.05],
      wheelsZ: [-1.28, 1.3],
      wheelR: 0.31,
      windscreen: [-0.78, -0.05],
      rearGlass: [1.1, 1.92],
      sideGlass: [-0.7, 1.5],
      taper: 0.2,
      seams: [-0.74, 0.5, 1.62],
    },
  });
}

function estate(): ModelSet {
  return car({
    hl: 2.42,
    height: 1.47,
    mirrorZ: -0.78,
    loft: {
      profile: [[-2.42, 0.68], [-2.36, 0.78], [-1.66, 0.88], [-0.9, 0.96], [-0.14, 1.42], [1.9, 1.45], [2.32, 1.12], [2.42, 0.82]],
      hw: 0.91,
      roofHw: 0.74,
      sill: 0.2,
      belt: [0.9, 0.99],
      wheelsZ: [-1.44, 1.46],
      wheelR: 0.33,
      windscreen: [-0.9, -0.14],
      rearGlass: [1.9, 2.32],
      sideGlass: [-0.82, 2.05],
      taper: 0.2,
      seams: [-0.86, 0.3, 1.36, 2.26],
    },
  });
}

function suv(): ModelSet {
  return car({
    hl: 2.42,
    height: 1.82,
    mirrorZ: -0.7,
    grille: [0.24, 0.5],
    loft: {
      profile: [[-2.42, 0.96], [-2.35, 1.04], [-1.3, 1.17], [-0.86, 1.22], [-0.14, 1.76], [1.7, 1.8], [2.3, 1.34], [2.42, 1.0]],
      hw: 0.98,
      roofHw: 0.8,
      sill: 0.34,
      belt: [1.13, 1.2],
      wheelsZ: [-1.48, 1.48],
      wheelR: 0.39,
      windscreen: [-0.86, -0.14],
      rearGlass: [1.7, 2.3],
      sideGlass: [-0.76, 2.0],
      taper: 0.18,
      seams: [-0.8, 0.42, 1.55, 2.32],
    },
  });
}

function pickup(): ModelSet {
  return car({
    hl: 2.7,
    height: 1.84,
    mirrorZ: -0.98,
    grille: [0.28, 0.6],
    loft: {
      profile: [[-2.7, 1.0], [-2.62, 1.08], [-1.6, 1.2], [-1.05, 1.26], [-0.35, 1.82], [0.5, 1.84], [0.58, 1.26], [2.62, 1.24], [2.7, 1.02]],
      hw: 1.0,
      roofHw: 0.8,
      sill: 0.4,
      belt: [1.2, 1.24],
      wheelsZ: [-1.75, 1.62],
      wheelR: 0.4,
      windscreen: [-1.05, -0.35],
      rearGlass: null,
      sideGlass: [-0.96, 0.44],
      taper: 0.14,
      seams: [-1.0, 0.52, 2.56],
      topTrim: [0.66, 2.6],
    },
  });
}

function van(): ModelSet {
  return car({
    hl: 2.75,
    height: 2.34,
    mirrorZ: -1.5,
    grille: [0.2, 0.5],
    loft: {
      profile: [[-2.75, 0.94], [-2.66, 1.02], [-2.15, 1.16], [-1.35, 2.2], [-0.9, 2.34], [2.66, 2.34], [2.75, 2.12]],
      hw: 1.0,
      roofHw: 0.92,
      sill: 0.36,
      belt: [1.18, 1.22],
      wheelsZ: [-1.75, 1.75],
      wheelR: 0.36,
      windscreen: [-2.15, -1.35],
      rearGlass: null,
      sideGlass: [-2.0, -0.8],
      taper: 0.14,
      seams: [-1.95, -0.75, 1.3, 2.68],
    },
  });
}

/** City bus: white upper body over the body colour, a long glazed band, two doors. */
function bus(): ModelSet {
  const hw = 1.27;
  const hl = 6;
  const spec: LoftSpec = {
    profile: [[-6, 1.0], [-5.97, 2.4], [-5.8, 3.0], [-5.4, 3.12], [5.7, 3.12], [5.97, 2.96], [6, 1.0]],
    hw,
    roofHw: 0.94,
    sill: 0.32,
    belt: [1.2, 1.2],
    wheelsZ: [-3.4, 3.3],
    wheelR: 0.5,
    windscreen: [-5.97, -5.8],
    rearGlass: null,
    sideGlass: [-5.6, 5.4],
    taper: 0.08,
    seams: [-5.35, -4.05, -1.0, 0.3],
    upper: { color: WHITE, part: PART_LIVERY },
    sidePanels: [[3.9, 5.0]],
  };
  const dressing = (b: Builder, near: boolean) => {
    // Raked windscreen in one sheet, destination display over it.
    b.front(-hw + 0.08, hw - 0.08, 1.3, 2.62, -6.012, GLASS, PART_GLASS);
    b.front(-hw + 0.2, hw - 0.2, 2.68, 2.92, -6.014, TRIM, PART_FIXED);
    frontLamps(b, hw - 0.06, -6.016, 0.62, 0.16, near);
    rearLamps(b, hw - 0.06, 6.016, 0.95, 0.3, near, 0.42);
    b.back(-hw + 0.2, hw - 0.2, 1.7, 2.75, 6.014, GLASS, PART_GLASS);
    if (!near) return;
    b.front(-hw + 0.3, hw - 0.3, 2.72, 2.88, -6.016, INDICATOR, PART_HEAD);
    b.front(-hw + 0.06, hw - 0.06, 0.32, 0.52, -6.016, TRIM, PART_FIXED);
    b.back(-hw + 0.06, hw - 0.06, 0.32, 0.52, 6.016, TRIM, PART_FIXED);
    b.back(-0.7, 0.7, 1.28, 1.5, 6.018, TRIM, PART_FIXED);
    // Door leaves on the kerb side: glass to the floor, a dark centre joint.
    for (const [z0, z1] of [[-5.35, -4.05], [-1.0, 0.3]]) {
      b.side(hw * 0.975 + 0.012, z0 + 0.04, z1 - 0.04, 0.42, 2.66, GLASS, PART_GLASS);
      b.side(hw * 0.975 + 0.016, (z0 + z1) / 2 - 0.025, (z0 + z1) / 2 + 0.025, 0.42, 2.66, TRIM, PART_FIXED);
    }
    // Window pillars along the glazed band.
    for (let z = -3.6; z < 5.4; z += 1.5) {
      if (z > 3.8 && z < 5.1) continue;
      b.side(hw * 0.96 + 0.006, z - 0.05, z + 0.05, 1.25, 2.7, TRIM, PART_FIXED);
      b.side(-hw * 0.96 - 0.006, z - 0.05, z + 0.05, 1.25, 2.7, TRIM, PART_FIXED);
    }
    // Roof pods: air conditioning and the battery or engine cover at the back.
    b.box(-0.85, 0.85, 3.1, 3.34, -2.6, 0.6, hexRGB(0xd8d8d4), PART_FIXED, { side: 0.08, front: 0.2, back: 0.2 });
    b.box(-0.7, 0.7, 3.1, 3.3, 2.0, 4.2, hexRGB(0xd0d0cc), PART_FIXED, { side: 0.06, front: 0.15, back: 0.15 });
    // Mirrors on arms ahead of the windscreen.
    for (const side of [1, -1]) {
      b.tube([side * (hw - 0.05), 2.5, -5.8], [side * (hw + 0.28), 2.55, -6.15], 0.025, 5, TRIM, PART_FIXED);
      b.box(side > 0 ? hw + 0.2 : -hw - 0.36, side > 0 ? hw + 0.36 : -hw - 0.2, 2.0, 2.6, -6.25, -6.12, TRIM, PART_FIXED, { bottom: true });
    }
    b.side(hw + 0.002, -5.6, 5.6, 0.32, 0.4, TRIM, PART_FIXED);
    b.side(-hw - 0.002, -5.6, 5.6, 0.32, 0.4, TRIM, PART_FIXED);
  };
  const near = new Builder();
  loft(near, spec, 2);
  wheels(near, spec.wheelsZ, hw - 0.04, 0.5, 0.3, 16, 8);
  dressing(near, true);
  const mid = new Builder();
  loft(mid, spec, 1);
  wheels(mid, spec.wheelsZ, hw - 0.04, 0.5, 0.3, 7);
  dressing(mid, false);
  const far = new Builder();
  far.box(-hw, hw, 0.3, 1.2, -hl, hl, WHITE, PART_BODY);
  far.box(-hw, hw, 1.2, 3.1, -hl, hl, WHITE, PART_LIVERY);
  far.side(hw + 0.01, -5.6, 5.6, 1.3, 2.7, GLASS, PART_GLASS);
  far.side(-hw - 0.01, -5.6, 5.6, 1.3, 2.7, GLASS, PART_GLASS);
  far.back(-hw + 0.05, hw - 0.05, 1, 1.2, hl + 0.02, LAMP, PART_BRAKE);
  far.front(-hw + 0.05, hw - 0.05, 0.62, 0.78, -hl - 0.02, HEAD, PART_HEAD);
  return { near: near.build(35), mid: mid.build(35), far: far.build(1), size: [hl, hw, 3.12] };
}

/**
 * Cab-over truck cab, lofted: bumper, a steep windscreen, sleeper roof, side
 * windows, steps, grille and mirrors. zF is the front, zB the back of the cab.
 */
function cab(b: Builder, zF: number, zB: number, hw: number, wheelZ: number, near: boolean, roof = 3.0): void {
  const spec: LoftSpec = {
    profile: [[zF, 1.1], [zF + 0.05, 1.62], [zF + 0.16, 1.72], [zF + 0.34, roof - 0.12], [zF + 0.62, roof], [zB, roof]],
    hw,
    roofHw: 0.9,
    sill: 0.62,
    belt: [1.72, 1.72],
    wheelsZ: [wheelZ],
    wheelR: 0.5,
    windscreen: [zF + 0.16, zF + 0.34],
    rearGlass: null,
    sideGlass: [zF + 0.36, zF + 1.25],
    taper: 0.1,
    seams: [zF + 0.3, zF + 1.35],
  };
  loft(b, spec, near ? 2 : 1);
  // Windscreen glass on the front face, raked a little.
  b.quad([hw - 0.12, 1.76, zF + 0.165], [-hw + 0.12, 1.76, zF + 0.165], [-hw + 0.16, roof - 0.2, zF + 0.33], [hw - 0.16, roof - 0.2, zF + 0.33], GLASS, PART_GLASS);
  frontLamps(b, hw - 0.04, zF - 0.012, 0.74, 0.18, near);
  b.front(-hw + 0.32, hw - 0.32, 1.0, 1.58, zF + 0.035, TRIM, PART_FIXED);
  b.front(-hw, hw, 0.44, 0.7, zF - 0.014, TRIM, PART_FIXED);
  if (!near) return;
  // Grille slats, sun visor, steps and mirrors.
  for (let y = 1.06; y < 1.56; y += 0.1) b.front(-hw + 0.34, hw - 0.34, y, y + 0.025, zF + 0.03, CHROME, PART_CHROME);
  b.box(-hw + 0.06, hw - 0.06, roof - 0.14, roof - 0.06, zF + 0.1, zF + 0.4, WHITE, PART_BODY, { bottom: true });
  for (const side of [1, -1]) {
    const x0 = side * (hw - 0.12);
    const x1 = side * (hw + 0.01);
    b.box(Math.min(x0, x1), Math.max(x0, x1), 0.5, 0.56, zF + 0.6, zF + 1.15, TRIM, PART_FIXED, { bottom: true });
    b.tube([side * (hw - 0.02), 2.2, zF + 0.4], [side * (hw + 0.22), 2.25, zF + 0.3], 0.02, 5, TRIM, PART_FIXED);
    b.box(side > 0 ? hw + 0.18 : -hw - 0.3, side > 0 ? hw + 0.3 : -hw - 0.18, 1.7, 2.4, zF + 0.2, zF + 0.34, TRIM, PART_FIXED, { bottom: true });
  }
}

const BOX_PANEL = hexRGB(0xe4e2dc);
const BOX_RIB = hexRGB(0xb8b6ae);

/** Rigid box truck. The box is white or the body colour by livery, with a band. */
function boxTruck(): ModelSet {
  const hw = 1.24;
  const hl = 5.2;
  const body = (b: Builder, near: boolean) => {
    b.box(-0.5, 0.5, 0.45, 0.75, -3.0, 5.0, TRIM, PART_FIXED);
    b.box(-hw - 0.03, hw + 0.03, 0.78, 3.6, -2.75, 5.2, WHITE, PART_LIVERY, { bottom: true });
    if (near) {
      for (let z = -2.4; z < 5.1; z += 1.2) {
        b.side(hw + 0.045, z - 0.04, z + 0.04, 0.82, 3.56, BOX_RIB, PART_FIXED);
        b.side(-hw - 0.045, z - 0.04, z + 0.04, 0.82, 3.56, BOX_RIB, PART_FIXED);
      }
      // Rear doors: hinge rails and lock bars.
      b.back(-0.02, 0.02, 0.85, 3.5, 5.215, TRIM, PART_FIXED);
      for (const x of [-0.6, 0.6]) b.back(x - 0.025, x + 0.025, 0.9, 3.45, 5.22, CHROME, PART_CHROME);
      b.back(-hw, hw, 0.6, 0.78, 5.21, TRIM, PART_FIXED);
      // Side skirts between the axles.
      b.side(hw - 0.05, -2.2, 1.9, 0.5, 0.78, TRIM, PART_FIXED);
      b.side(-hw + 0.05, -2.2, 1.9, 0.5, 0.78, TRIM, PART_FIXED);
      // Coloured band in the body colour.
      b.side(hw + 0.05, -2.6, 5.1, 1.0, 1.3, WHITE, PART_BODY);
      b.side(-hw - 0.05, -2.6, 5.1, 1.0, 1.3, WHITE, PART_BODY);
    }
    rearLamps(b, hw - 0.04, 5.225, 0.62, 0.14, near);
    wheels(b, [-3.75], hw - 0.02, 0.5, 0.3, near ? 16 : 7, 8);
    wheels(b, [2.5, 3.72], hw - 0.02, 0.5, 0.34, near ? 16 : 7, 8);
  };
  const near = new Builder();
  cab(near, -5.2, -2.8, hw, -3.75, true);
  body(near, true);
  const mid = new Builder();
  cab(mid, -5.2, -2.8, hw, -3.75, false);
  body(mid, false);
  const far = new Builder();
  far.box(-hw, hw, 0.5, 3.0, -5.2, -2.85, WHITE, PART_BODY);
  far.box(-hw, hw, 0.6, 3.6, -2.75, 5.2, WHITE, PART_LIVERY);
  far.back(-hw + 0.05, hw - 0.05, 0.62, 0.8, 5.22, LAMP, PART_BRAKE);
  far.front(-hw + 0.05, hw - 0.05, 0.74, 0.92, -5.22, HEAD, PART_HEAD);
  return { near: near.build(25), mid: mid.build(25), far: far.build(1), size: [hl, hw, 3.6] };
}

/**
 * Where the semi-trailer hangs on the tractor, and the distance from there back
 * to the middle of its axles. vehicles.ts swings the trailer about this pin.
 */
export const KINGPIN_Z = -2.35;
export const TRAILER_AXLES = 7.1;

/** Tractor unit of an articulated lorry: cab, sleeper fairing, tanks, fifth wheel. */
function tractor(): ModelSet {
  const hw = 1.24;
  const hl = 6;
  const chassis = (b: Builder, near: boolean) => {
    b.box(-0.5, 0.5, 0.48, 0.8, -4.0, -1.5, TRIM, PART_FIXED);
    b.box(-0.6, 0.6, 0.98, 1.08, -2.9, -1.8, hexRGB(0x3c3e42), PART_CHROME);
    if (near) {
      // Fuel tanks, exhaust stacks, mudguards over the drive axle.
      for (const side of [1, -1]) {
        b.tube([side * (hw - 0.3), 0.72, -3.7], [side * (hw - 0.3), 0.72, -3.0], 0.28, 10, CHROME, PART_CHROME);
        b.tube([side * (hw - 0.12), 1.9, -3.75], [side * (hw - 0.12), 3.5, -3.75], 0.07, 8, CHROME, PART_CHROME);
        b.box(side > 0 ? hw - 0.4 : -hw - 0.02, side > 0 ? hw + 0.02 : -hw + 0.4, 1.08, 1.14, -2.95, -1.75, TRIM, PART_FIXED, { bottom: true });
      }
      // Roof fairing over the cab, in the body colour.
      b.box(-hw + 0.08, hw - 0.08, 3.0, 3.5, -5.3, -3.85, WHITE, PART_BODY, { front: 0.65, side: 0.06 });
    }
    wheels(b, [-2.4, -1.4], hw - 0.02, 0.5, 0.34, near ? 16 : 7, 8);
  };
  const near = new Builder();
  cab(near, -6, -3.85, hw, -5.0, true);
  chassis(near, true);
  const mid = new Builder();
  cab(mid, -6, -3.85, hw, -5.0, false);
  chassis(mid, false);
  const far = new Builder();
  far.box(-hw, hw, 0.5, 3.1, -6, -3.8, WHITE, PART_BODY);
  far.box(-0.5, 0.5, 0.5, 1.0, -3.8, -1.4, TRIM, PART_FIXED);
  far.front(-hw + 0.05, hw - 0.05, 0.74, 0.92, -6.02, HEAD, PART_HEAD);
  return { near: near.build(25), mid: mid.build(25), far: far.build(1), size: [hl, hw, 3.5] };
}

/**
 * Semi-trailer, its origin on the kingpin: a box from just ahead of the pin back
 * to the tail, landing legs, side guards and a tandem axle.
 */
function trailer(): ModelSet {
  const hw = 1.25;
  const front = -0.95;
  const tail = 6 - KINGPIN_Z;
  const axles = [TRAILER_AXLES - 0.5, TRAILER_AXLES + 0.5];
  const build = (b: Builder, near: boolean) => {
    b.box(-hw, hw, 1.12, 3.75, front, tail, WHITE, PART_LIVERY, { bottom: true });
    b.box(-0.5, 0.5, 0.92, 1.12, front + 0.2, tail - 0.4, TRIM, PART_FIXED);
    if (near) {
      for (let z = front + 0.5; z < tail - 0.2; z += 0.9) {
        b.side(hw + 0.012, z - 0.025, z + 0.025, 1.14, 3.73, BOX_RIB, PART_FIXED);
        b.side(-hw - 0.012, z - 0.025, z + 0.025, 1.14, 3.73, BOX_RIB, PART_FIXED);
      }
      // A band along the trailer in the body colour.
      b.side(hw + 0.02, front + 0.3, tail - 0.3, 2.2, 2.75, WHITE, PART_BODY);
      b.side(-hw - 0.02, front + 0.3, tail - 0.3, 2.2, 2.75, WHITE, PART_BODY);
      // Landing legs, side guards, rear doors.
      for (const side of [1, -1]) b.box(side * 0.75 - 0.06, side * 0.75 + 0.06, 0.15, 1.0, 1.4, 1.52, TRIM, PART_FIXED, { bottom: true });
      b.side(hw - 0.06, 1.8, axles[0] - 0.7, 0.55, 0.95, hexRGB(0x8a8c8e), PART_FIXED);
      b.side(-hw + 0.06, 1.8, axles[0] - 0.7, 0.55, 0.95, hexRGB(0x8a8c8e), PART_FIXED);
      b.back(-0.02, 0.02, 1.2, 3.65, tail + 0.012, TRIM, PART_FIXED);
      for (const x of [-0.62, 0.62]) b.back(x - 0.025, x + 0.025, 1.25, 3.6, tail + 0.016, CHROME, PART_CHROME);
      b.back(-hw + 0.1, hw - 0.1, 0.62, 0.78, tail - 0.25, TRIM, PART_FIXED);
    } else {
      b.box(-hw + 0.1, hw - 0.1, 0.62, 0.78, tail - 0.4, tail - 0.25, TRIM, PART_FIXED);
    }
    rearLamps(b, hw - 0.05, tail + 0.014, 0.95, 0.14, near);
    wheels(b, axles, hw - 0.02, 0.48, 0.34, near ? 16 : 7, 8);
  };
  const near = new Builder();
  build(near, true);
  const mid = new Builder();
  build(mid, false);
  const far = new Builder();
  far.box(-hw, hw, 0.8, 3.75, front, tail, WHITE, PART_LIVERY);
  far.back(-hw + 0.05, hw - 0.05, 1.0, 1.14, tail + 0.02, LAMP, PART_BRAKE);
  return { near: near.build(25), mid: mid.build(25), far: far.build(1), size: [(tail - front) / 2, hw, 3.75] };
}

/** Rider and bicycle: spoked wheels, a diamond frame of tubes. The body colour goes on the jersey. */
function bicycle(): ModelSet {
  const skin = hexRGB(0xc89070);
  const legs = hexRGB(0x24262c);
  const frame = hexRGB(0x30343a);
  const hl = 0.9;
  const build = (b: Builder, near: boolean) => {
    const sides = near ? 16 : 7;
    const r = 0.34;
    const wheel = (z: number) => {
      // Tyre as a thin band with both walls, then spokes to the hub.
      for (let i = 0; i < sides; i++) {
        const a0 = (i / sides) * Math.PI * 2;
        const a1 = ((i + 1) / sides) * Math.PI * 2;
        const at = (a: number, rr: number, x: number) => [x, r + Math.cos(a) * rr, z + Math.sin(a) * rr];
        const mid = ((i + 0.5) / sides) * Math.PI * 2;
        const radial = [0, Math.cos(mid), Math.sin(mid)];
        b.facing(at(a0, r, -0.016), at(a1, r, -0.016), at(a1, r, 0.016), at(a0, r, 0.016), radial, RUBBER, PART_FIXED);
        b.facing(at(a0, r * 0.88, 0.016), at(a1, r * 0.88, 0.016), at(a1, r, 0.016), at(a0, r, 0.016), [1, 0, 0], RUBBER, PART_FIXED);
        b.facing(at(a0, r * 0.88, -0.016), at(a1, r * 0.88, -0.016), at(a1, r, -0.016), at(a0, r, -0.016), [-1, 0, 0], RUBBER, PART_FIXED);
      }
      if (near) for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        b.tube([0, r, z], [0, r + Math.cos(a) * r * 0.86, z + Math.sin(a) * r * 0.86], 0.004, 3, RIM, PART_CHROME, false);
      }
    };
    wheel(-0.56);
    wheel(0.56);
    const tr = near ? 0.018 : 0.025;
    const ts = near ? 6 : 4;
    const bb = [0, 0.32, 0.02];
    const seat = [0, 0.86, 0.14];
    const head = [0, 0.86, -0.42];
    const rearHub = [0, r, 0.56];
    const frontHub = [0, r, -0.56];
    for (const [p, q] of [[bb, seat], [seat, head], [bb, head], [bb, rearHub], [seat, rearHub], [head, frontHub]]) b.tube(p, q, tr, ts, frame, PART_FIXED);
    b.tube([0, 0.86, -0.42], [0, 1.0, -0.46], tr, ts, frame, PART_FIXED);
    b.tube([-0.24, 1.0, -0.46], [0.24, 1.0, -0.46], 0.014, ts, TRIM, PART_FIXED);
    b.box(-0.06, 0.06, 0.92, 0.96, 0.06, 0.26, TRIM, PART_FIXED, { bottom: true });
    // Rider, leaning to the bars: legs to the pedals, torso, arms, head and helmet.
    const hip = [0, 0.98, 0.12];
    for (const side of [1, -1]) {
      const knee = [side * 0.1, 0.72, -0.12 + side * 0.06];
      const foot = [side * 0.12, 0.3 + side * 0.08, 0.02 - side * 0.06];
      b.tube([side * 0.09, hip[1], hip[2]], knee, 0.06, ts, legs, PART_FIXED);
      b.tube(knee, foot, 0.045, ts, legs, PART_FIXED);
      b.tube([side * 0.17, 1.42, -0.06], [side * 0.22, 1.02, -0.44], 0.04, ts, WHITE, PART_BODY);
    }
    b.tube([0, 0.98, 0.14], [0, 1.44, -0.08], 0.15, near ? 8 : 5, WHITE, PART_BODY);
    b.tube([0, 1.5, -0.14], [0, 1.68, -0.2], 0.095, near ? 8 : 5, skin, PART_FIXED);
    b.box(-0.12, 0.12, 1.64, 1.76, -0.32, 0.0, hexRGB(0xe8e4dc), PART_FIXED, { front: 0.06, back: 0.06, side: 0.03 });
    b.back(-0.04, 0.04, 0.84, 0.9, 0.62, LAMP, PART_BRAKE);
    b.front(-0.04, 0.04, 0.94, 0.99, -0.5, HEAD, PART_HEAD);
  };
  const near = new Builder();
  build(near, true);
  const mid = new Builder();
  build(mid, false);
  const far = new Builder();
  far.box(-0.03, 0.03, 0.05, 0.7, -0.88, 0.88, RUBBER, PART_FIXED);
  far.box(-0.17, 0.17, 0.7, 1.72, -0.14, 0.24, WHITE, PART_BODY);
  return { near: near.build(30), mid: mid.build(30), far: far.build(1), size: [hl, 0.3, 1.76] };
}

/**
 * Model order. The first eight keep their old places (tests and the blob tables
 * index them); new body styles go on the end.
 */
export const MODEL_NAMES = ['sedan', 'hatchback', 'suv', 'van', 'boxTruck', 'tractor', 'bus', 'bicycle', 'estate', 'pickup', 'trailer'] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

export function buildModels(): ModelSet[] {
  return [sedan(), hatchback(), suv(), van(), boxTruck(), tractor(), bus(), bicycle(), estate(), pickup(), trailer()];
}
