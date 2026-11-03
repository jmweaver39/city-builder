/**
 * Procedural rolling stock in low-poly style: chunky faceted shapes, flat colour
 * per part, simple window bands. Every vehicle is built from swept profiles, boxes and
 * cylinders, with a part code per vertex so one shader can paint the livery, light
 * the lamps and windows, and show open doors. Local frame: forward is -Z, x right,
 * y up from the top of the rail, origin halfway along the body.
 */
import * as THREE from 'three';
import { CAR, CAR_KINDS } from '../rail/consists';

export const P_BODY = 0;
export const P_STRIPE = 1;
export const P_FIXED = 2;
export const P_GLASS = 3;
export const P_LAMP = 4;
export const P_DOOR = 5;
export const P_DARK = 6;

type V3 = [number, number, number];
type Col = readonly [number, number, number];

function lin(hex: number): Col {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [c((hex >> 16) & 255), c((hex >> 8) & 255), c(hex & 255)];
}

const WHITE: Col = [1, 1, 1];
const GLASS = lin(0x1a2430);
const DARK = lin(0x1c1d20);
const UNDER = lin(0x2a2b2e);
const ROOF = lin(0x6e7276);
const STEEL = lin(0x8a9096);
const RUST = lin(0x5a3a2a);
const LAMP = lin(0xd9dcd6);
const BLACK = lin(0x0f1012);

export class ModelBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  part: number[] = [];

  private push(p: V3, n: V3, c: Col, part: number): void {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2]);
    this.part.push(part);
  }

  tri(a: V3, b: V3, c: V3, color: Col, part: number): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const n: V3 = [nx, ny, nz];
    this.push(a, n, color, part);
    this.push(b, n, color, part);
    this.push(c, n, color, part);
  }

  /** Quad a b c d, counter-clockwise seen from outside. */
  quad(a: V3, b: V3, c: V3, d: V3, color: Col, part: number): void {
    this.tri(a, b, c, color, part);
    this.tri(a, c, d, color, part);
  }

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: Col, part: number, bottom = false): void {
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], color, part);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], color, part);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], color, part);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], color, part);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], color, part);
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], color, part);
  }

  /**
   * Sweep a closed profile (x, y, counter-clockwise looking toward -Z) from z0 to z1.
   * `shape(t)` scales and lifts the profile along the way, for noses and tapers.
   */
  sweep(
    profile: [number, number][],
    z0: number,
    z1: number,
    color: Col | ((i: number) => Col),
    part: number | ((i: number) => number),
    opts: { steps?: number; shape?: (t: number) => { sx: number; sy: number; dy: number }; capFront?: boolean; capBack?: boolean } = {},
  ): void {
    const steps = opts.steps ?? 1;
    const shape = opts.shape ?? (() => ({ sx: 1, sy: 1, dy: 0 }));
    const ring = (k: number): V3[] => {
      const t = k / steps;
      const z = z0 + (z1 - z0) * t;
      const s = shape(t);
      return profile.map(([x, y]) => [x * s.sx, y * s.sy + s.dy, z]);
    };
    const n = profile.length;
    const colorOf = typeof color === 'function' ? color : () => color;
    const partOf = typeof part === 'function' ? part : () => part;
    let prev = ring(0);
    for (let k = 1; k <= steps; k++) {
      const cur = ring(k);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        // Profile runs counter-clockwise seen from -Z, so outward faces wind this way.
        this.quad(prev[i], prev[j], cur[j], cur[i], colorOf(i), partOf(i));
      }
      prev = cur;
    }
    const first = ring(0);
    const last = ring(steps);
    if (opts.capFront !== false) {
      // z0 end faces -Z.
      for (let i = 1; i + 1 < n; i++) this.tri(first[0], first[i + 1], first[i], colorOf(0), partOf(0));
    }
    if (opts.capBack !== false) {
      for (let i = 1; i + 1 < n; i++) this.tri(last[0], last[i], last[i + 1], colorOf(0), partOf(0));
    }
  }

  /** Cylinder along Z. */
  cylZ(cx: number, cy: number, r: number, z0: number, z1: number, color: Col, part: number, sides = 8, caps = true): void {
    const prof: [number, number][] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      prof.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    this.sweep(prof, z0, z1, color, part, { capFront: caps, capBack: caps });
  }

  /** Cylinder along X, for wheels and axles. */
  cylX(x0: number, x1: number, cy: number, cz: number, r: number, color: Col, part: number, sides = 6): void {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const p = (x: number, a: number): V3 => [x, cy + Math.cos(a) * r, cz + Math.sin(a) * r];
      this.quad(p(x0, a0), p(x0, a1), p(x1, a1), p(x1, a0), color, part);
      this.tri([x1, cy, cz], p(x1, a0), p(x1, a1), color, part);
      this.tri([x0, cy, cz], p(x0, a1), p(x0, a0), color, part);
    }
  }

  /** A flat plate on both sides of a body of half width hw. */
  sides(hw: number, z0: number, z1: number, y0: number, y1: number, color: Col, part: number, inset = 0.015): void {
    const x = hw + inset;
    this.quad([x, y0, z1], [x, y0, z0], [x, y1, z0], [x, y1, z1], color, part);
    this.quad([-x, y0, z0], [-x, y0, z1], [-x, y1, z1], [-x, y1, z0], color, part);
  }

  /** A plate facing -Z at z, or +Z when back. */
  end(z: number, x0: number, x1: number, y0: number, y1: number, color: Col, part: number, back = false): void {
    if (back) this.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], color, part);
    else this.quad([x1, y0, z], [x0, y0, z], [x0, y1, z], [x1, y1, z], color, part);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    return g;
  }
}

/** Passenger car section: straight sides, tumblehome below the windows, a curved roof. */
function carProfile(hw: number, floor: number, top: number): [number, number][] {
  const eave = top - 0.55;
  const pts: [number, number][] = [
    [-hw + 0.12, floor],
    [hw - 0.12, floor],
    [hw, floor + 0.5],
    [hw, eave],
  ];
  for (let i = 1; i <= 2; i++) {
    const a = (i / 3) * Math.PI;
    pts.push([Math.cos(a) * hw * 0.98, eave + Math.sin(a) * (top - eave)]);
  }
  pts.push([-hw, eave], [-hw, floor + 0.5]);
  return pts;
}

function bandColour(i: number, n: number, lowBand: boolean): number {
  void n;
  return lowBand && (i === 1 || i === 2) ? P_STRIPE : P_BODY;
}

/** Doors as dark-edged panels; window band; roof kit. */
function passengerSides(m: ModelBuilder, hw: number, L: number, floor: number, top: number, doors: number[], doorW: number, cab: boolean, cabLen: number): void {
  const z0 = -L / 2 + (cab ? cabLen : 0.6);
  const z1 = L / 2 - 0.6;
  const winLo = floor + 0.95;
  const winHi = floor + 1.75;
  // Windows between doors.
  const cuts = [...doors.map((d) => [d - doorW / 2 - 0.2, d + doorW / 2 + 0.2])].sort((a, b) => a[0] - b[0]);
  let at = z0;
  for (const [a, b] of [...cuts, [z1, z1]]) {
    if (a - at > 0.8) m.sides(hw, at + 0.25, a - 0.15, winLo, winHi, GLASS, P_GLASS);
    at = b;
  }
  for (const d of doors) {
    m.sides(hw, d - doorW / 2, d + doorW / 2, floor + 0.05, floor + 2.0, WHITE, P_DOOR, 0.02);
    m.sides(hw, d - 0.02, d + 0.02, floor + 0.05, floor + 2.0, BLACK, P_DARK, 0.03);
    m.sides(hw, d - doorW / 2 + 0.12, d + doorW / 2 - 0.12, floor + 1.0, floor + 1.75, GLASS, P_GLASS, 0.03);
  }
  void top;
}

function cabFront(m: ModelBuilder, hw: number, zf: number, floor: number, top: number, slope: number): void {
  // Raked windscreen and a lamp cluster low on the front.
  const yWin0 = floor + 1.05;
  const yWin1 = top - 0.35;
  m.quad([hw - 0.25, yWin0, zf - 0.02], [-hw + 0.25, yWin0, zf - 0.02], [-hw + 0.3, yWin1, zf + slope - 0.02], [hw - 0.3, yWin1, zf + slope - 0.02], GLASS, P_GLASS);
  for (const s of [-1, 1]) {
    m.box(s * (hw - 0.55) - 0.2, s * (hw - 0.55) + 0.2, floor + 0.35, floor + 0.55, zf - 0.04, zf, LAMP, P_LAMP);
  }
  m.box(-0.5, 0.5, top - 0.32, top - 0.12, zf + slope - 0.05, zf + slope, lin(0xf0a020), P_FIXED);
}

function roofKit(m: ModelBuilder, L: number, top: number, units: number): void {
  for (let i = 0; i < units; i++) {
    const z = -L / 2 + ((i + 0.5) * L) / units;
    m.box(-0.8, 0.8, top - 0.05, top + 0.28, z - 1.4, z + 1.4, ROOF, P_FIXED);
    m.box(-0.5, 0.5, top + 0.28, top + 0.32, z - 0.7, z + 0.7, DARK, P_DARK);
  }
}

function underframe(m: ModelBuilder, hw: number, L: number, floor: number, spacing: number): void {
  m.box(-hw + 0.25, hw - 0.25, floor - 0.45, floor, -spacing / 2 + 1.8, spacing / 2 - 1.8, UNDER, P_DARK);
  // Buffers or couplers at each end.
  for (const z of [-L / 2 - 0.35, L / 2]) m.box(-0.18, 0.18, 0.85, 1.05, z, z + 0.35, DARK, P_DARK);
}

function pantograph(m: ModelBuilder, z: number, top: number): void {
  const y = top + 0.05;
  m.box(-0.5, 0.5, y, y + 0.18, z - 0.6, z + 0.6, STEEL, P_FIXED);
  // Single-arm pantograph raised to the wire.
  const knee: V3 = [0, y + 0.9, z + 0.9];
  const head: V3 = [0, y + 1.55, z - 0.2];
  const bar = (a: V3, b: V3, r: number) => {
    m.quad([a[0] - r, a[1], a[2]], [a[0] + r, a[1], a[2]], [b[0] + r, b[1], b[2]], [b[0] - r, b[1], b[2]], DARK, P_DARK);
    m.quad([a[0] + r, a[1], a[2]], [a[0] - r, a[1], a[2]], [b[0] - r, b[1], b[2]], [b[0] + r, b[1], b[2]], DARK, P_DARK);
  };
  bar([0, y + 0.18, z - 0.3], knee, 0.06);
  bar(knee, head, 0.05);
  m.box(-0.95, 0.95, head[1], head[1] + 0.06, head[2] - 0.1, head[2] + 0.1, STEEL, P_FIXED);
}

function passengerCar(kind: number, opts: { cab: boolean; doors: number; doorW: number; panto: boolean; nose?: boolean; roofUnits: number; lowBand: boolean }): THREE.BufferGeometry {
  const k = CAR_KINDS[kind];
  const m = new ModelBuilder();
  const hw = k.width / 2;
  const L = k.length;
  const floor = 1.1;
  const top = k.height;
  const prof = carProfile(hw, floor, top);
  const n = prof.length;
  const colour = (i: number): Col => (i === 0 ? UNDER : WHITE);
  const partOf = (i: number) => (i === 0 ? P_DARK : bandColour(i, n, opts.lowBand));
  const cabLen = opts.nose ? 9 : opts.cab ? 2.2 : 0;
  if (opts.nose) {
    // A long pointed nose lofted down from the full section.
    m.sweep(prof, -L / 2, -L / 2 + cabLen, colour, partOf, {
      steps: 8,
      capBack: false,
      shape: (t) => {
        const e = 1 - Math.pow(1 - t, 2.2);
        return { sx: 0.25 + 0.75 * e, sy: 0.38 + 0.62 * Math.sqrt(e), dy: (1 - Math.sqrt(e)) * 0.6 };
      },
    });
    m.sweep(prof, -L / 2 + cabLen, L / 2, colour, partOf, { capFront: false });
    // Cockpit glazing on the upper nose.
    const zg = -L / 2 + 3.6;
    m.quad([hw * 0.55, top - 0.75, zg], [-hw * 0.55, top - 0.75, zg], [-hw * 0.7, top - 0.22, zg + 2.6], [hw * 0.7, top - 0.22, zg + 2.6], GLASS, P_GLASS);
    for (const s of [-1, 1]) m.box(s * 0.55 - 0.18, s * 0.55 + 0.18, 1.55, 1.7, -L / 2 + 0.6, -L / 2 + 0.95, LAMP, P_LAMP);
  } else {
    m.sweep(prof, -L / 2, L / 2, colour, partOf);
    if (opts.cab) cabFront(m, hw, -L / 2, floor, top, 0.35);
    else {
      m.end(-L / 2 - 0.01, -0.5, 0.5, floor + 0.1, floor + 2.0, DARK, P_DARK);
    }
    m.end(L / 2 + 0.01, -0.5, 0.5, floor + 0.1, floor + 2.0, DARK, P_DARK, true);
  }
  const doors: number[] = [];
  const usable = L - cabLen - 2;
  for (let i = 0; i < opts.doors; i++) doors.push(-L / 2 + cabLen + 1 + (usable * (i + 0.5)) / opts.doors);
  passengerSides(m, hw, L, floor, top, doors, opts.doorW, opts.cab || !!opts.nose, cabLen);
  if (opts.cab && !opts.nose) m.sides(hw, -L / 2 + 0.3, -L / 2 + 1.6, floor + 1.0, top - 0.6, GLASS, P_GLASS);
  roofKit(m, L - cabLen, top, opts.roofUnits);
  underframe(m, hw, L, floor, k.bogieSpacing);
  if (opts.panto) pantograph(m, opts.cab ? 2 : -L / 4, top);
  return m.build();
}

function electricLoco(): THREE.BufferGeometry {
  const k = CAR_KINDS[CAR.electricLoco];
  const m = new ModelBuilder();
  const hw = k.width / 2;
  const L = k.length;
  const floor = 1.2;
  const top = k.height - 0.15;
  const prof: [number, number][] = [
    [-hw + 0.1, floor],
    [hw - 0.1, floor],
    [hw, floor + 0.4],
    [hw, top - 0.35],
    [hw - 0.35, top],
    [-hw + 0.35, top],
    [-hw, top - 0.35],
    [-hw, floor + 0.4],
  ];
  m.sweep(prof, -L / 2 + 0.6, L / 2 - 0.6, (i) => (i === 0 ? UNDER : WHITE), (i) => (i === 0 ? P_DARK : i === 2 || i === 7 ? P_STRIPE : P_BODY));
  // Sloped cab noses at both ends.
  for (const s of [-1, 1]) {
    const z = s * (L / 2 - 0.6);
    const zt = s * (L / 2);
    const fr = (x: number, y: number): V3 => [x, y, zt];
    const bk = (x: number, y: number): V3 => [x, y, z];
    if (s < 0) {
      m.quad(fr(hw, floor), fr(-hw, floor), fr(-hw, floor + 1.4), fr(hw, floor + 1.4), WHITE, P_BODY);
      m.quad(fr(hw, floor + 1.4), fr(-hw, floor + 1.4), bk(-hw + 0.35, top), bk(hw - 0.35, top), WHITE, P_BODY);
      m.quad([hw - 0.3, floor + 1.55, zt + 0.12], [-hw + 0.3, floor + 1.55, zt + 0.12], [-hw + 0.5, top - 0.2, z - 0.05], [hw - 0.5, top - 0.2, z - 0.05], GLASS, P_GLASS);
      for (const x of [-0.95, 0.95]) m.box(x - 0.18, x + 0.18, floor + 0.55, floor + 0.72, zt - 0.03, zt, LAMP, P_LAMP);
    } else {
      m.quad(fr(-hw, floor), fr(hw, floor), fr(hw, floor + 1.4), fr(-hw, floor + 1.4), WHITE, P_BODY);
      m.quad(fr(-hw, floor + 1.4), fr(hw, floor + 1.4), bk(hw - 0.35, top), bk(-hw + 0.35, top), WHITE, P_BODY);
      m.quad([-hw + 0.3, floor + 1.55, zt - 0.12], [hw - 0.3, floor + 1.55, zt - 0.12], [hw - 0.5, top - 0.2, z + 0.05], [-hw + 0.5, top - 0.2, z + 0.05], GLASS, P_GLASS);
      for (const x of [-0.95, 0.95]) m.box(x - 0.18, x + 0.18, floor + 0.55, floor + 0.72, zt, zt + 0.03, lin(0x701010), P_FIXED);
    }
  }
  // Grilles, cab side windows, roof equipment.
  m.sides(hw, -L / 2 + 3.5, L / 2 - 3.5, floor + 1.3, top - 0.6, DARK, P_DARK);
  m.sides(hw, -L / 2 + 1.0, -L / 2 + 2.0, floor + 1.4, top - 0.55, GLASS, P_GLASS);
  m.sides(hw, L / 2 - 2.0, L / 2 - 1.0, floor + 1.4, top - 0.55, GLASS, P_GLASS);
  m.box(-0.6, 0.6, top, top + 0.35, -2, 2, ROOF, P_FIXED);
  pantograph(m, -L / 2 + 4, top);
  pantograph(m, L / 2 - 4, top);
  underframe(m, hw, L, floor, k.bogieSpacing);
  return m.build();
}

function dieselLoco(): THREE.BufferGeometry {
  const k = CAR_KINDS[CAR.dieselLoco];
  const m = new ModelBuilder();
  const hw = k.width / 2;
  const L = k.length;
  const deck = 1.55;
  // Frame and walkways.
  m.box(-hw, hw, deck - 0.35, deck, -L / 2, L / 2, DARK, P_DARK);
  m.sides(hw, -L / 2, L / 2, deck - 0.3, deck - 0.05, WHITE, P_STRIPE);
  // Cab at the front with a short nose.
  const cabZ0 = -L / 2 + 1.6;
  const cabZ1 = cabZ0 + 3.4;
  m.box(-hw + 0.1, hw - 0.1, deck, deck + 1.3, -L / 2 + 0.2, cabZ0, WHITE, P_BODY);
  m.box(-hw + 0.05, hw - 0.05, deck, k.height - 0.15, cabZ0, cabZ1, WHITE, P_BODY);
  m.box(-hw + 0.25, hw - 0.25, k.height - 0.15, k.height, cabZ0 + 0.2, cabZ1 - 0.2, ROOF, P_FIXED);
  m.end(cabZ0 - 0.02, -hw + 0.3, hw - 0.3, deck + 1.75, k.height - 0.55, GLASS, P_GLASS);
  m.sides(hw - 0.05, cabZ0 + 0.5, cabZ1 - 0.5, deck + 1.6, k.height - 0.6, GLASS, P_GLASS);
  for (const x of [-0.7, 0.7]) m.box(x - 0.15, x + 0.15, deck + 0.9, deck + 1.1, -L / 2 + 0.17, -L / 2 + 0.2, LAMP, P_LAMP);
  m.box(-0.2, 0.2, k.height - 0.35, k.height - 0.15, cabZ0 - 0.03, cabZ0, LAMP, P_LAMP);
  // Long hood with radiator grilles and roof fans.
  const hoodTop = k.height - 0.55;
  const hw2 = hw - 0.45;
  m.box(-hw2, hw2, deck, hoodTop, cabZ1, L / 2 - 0.4, WHITE, P_BODY);
  m.sides(hw2, cabZ1 + 0.6, L / 2 - 4.4, deck + 0.5, hoodTop - 0.3, DARK, P_DARK);
  m.sides(hw2, L / 2 - 4, L / 2 - 0.8, deck + 0.3, hoodTop - 0.15, lin(0x2d2f33), P_DARK);
  for (const z of [L / 2 - 1.6, L / 2 - 3.0]) m.cylZ(0, hoodTop + 0.02, 0.6, z - 0.1, z + 0.1, DARK, P_DARK, 6);
  m.cylZ(0, hoodTop + 0.25, 0.12, cabZ1 + 2.4, cabZ1 + 2.7, BLACK, P_DARK, 6);
  // Fuel tank between the trucks.
  m.cylZ(0, deck - 0.9, 0.62, -3.5, 3.5, DARK, P_DARK, 6);
  // Handrails along the walkway.
  for (const s of [-1, 1]) m.box(s * (hw - 0.05) - 0.02, s * (hw - 0.05) + 0.02, deck + 0.95, deck + 1.0, cabZ1, L / 2 - 0.3, lin(0xe0c020), P_FIXED);
  m.box(-0.2, 0.2, 0.85, 1.05, -L / 2 - 0.4, -L / 2, DARK, P_DARK);
  m.box(-0.2, 0.2, 0.85, 1.05, L / 2, L / 2 + 0.4, DARK, P_DARK);
  return m.build();
}

function wagonFrame(m: ModelBuilder, hw: number, L: number, deck: number): void {
  m.box(-hw + 0.1, hw - 0.1, deck - 0.3, deck, -L / 2, L / 2, DARK, P_DARK);
  m.box(-0.2, 0.2, 0.85, 1.05, -L / 2 - 0.35, -L / 2, DARK, P_DARK);
  m.box(-0.2, 0.2, 0.85, 1.05, L / 2, L / 2 + 0.35, DARK, P_DARK);
}

function boxcar(): THREE.BufferGeometry {
  const k = CAR_KINDS[CAR.boxcar];
  const m = new ModelBuilder();
  const hw = k.width / 2;
  const L = k.length;
  const deck = 1.25;
  wagonFrame(m, hw, L, deck);
  m.box(-hw, hw, deck, k.height - 0.12, -L / 2 + 0.25, L / 2 - 0.25, WHITE, P_BODY);
  m.box(-hw + 0.08, hw - 0.08, k.height - 0.12, k.height, -L / 2 + 0.3, L / 2 - 0.3, WHITE, P_BODY);
  // Ribs, sliding door with its track, end ladders.
  m.sides(hw, -L / 2 + 0.25, L / 2 - 0.25, k.height - 0.55, k.height - 0.35, RUST, P_STRIPE, 0.03);
  m.sides(hw, -1.6, 1.6, deck + 0.1, k.height - 0.35, WHITE, P_DOOR, 0.05);
  m.sides(hw, -1.8, 1.8, k.height - 0.35, k.height - 0.28, DARK, P_DARK, 0.06);
  for (const z of [-L / 2 + 0.24, L / 2 - 0.24]) m.box(-0.5, 0.5, deck + 0.2, k.height - 0.4, z - 0.02, z + 0.02, DARK, P_DARK);
  return m.build();
}

function tanker(): THREE.BufferGeometry {
  const k = CAR_KINDS[CAR.tanker];
  const m = new ModelBuilder();
  const hw = k.width / 2;
  const L = k.length;
  const deck = 1.2;
  wagonFrame(m, hw, L, deck);
  const r = 1.45;
  const cy = deck + r + 0.05;
  m.cylZ(0, cy, r, -L / 2 + 1.0, L / 2 - 1.0, WHITE, P_BODY, 8, false);
  // Dished heads.
  m.cylZ(0, cy, r * 0.82, -L / 2 + 0.6, -L / 2 + 1.0, WHITE, P_BODY, 8);
  m.cylZ(0, cy, r * 0.82, L / 2 - 1.0, L / 2 - 0.6, WHITE, P_BODY, 8);
  m.cylZ(0, cy + r, 0.45, -0.4, 0.4, WHITE, P_BODY, 6);
  m.box(-0.7, 0.7, cy + r - 0.05, cy + r + 0.02, -2.5, 2.5, DARK, P_DARK);
  // Hazard band around the barrel.
  m.cylZ(0, cy, r + 0.01, -0.8, 0.8, lin(0xd04020), P_STRIPE, 8, false);
  return m.build();
}

function hopper(): THREE.BufferGeometry {
  const k = CAR_KINDS[CAR.hopper];
  const m = new ModelBuilder();
  const hw = k.width / 2;
  const L = k.length;
  const top = k.height;
  // Open top with sloping ends and bays below.
  m.box(-hw, hw, 1.9, top, -L / 2 + 0.6, L / 2 - 0.6, WHITE, P_BODY);
  m.sides(hw, -L / 2 + 0.6, L / 2 - 0.6, top - 0.35, top - 0.1, RUST, P_STRIPE, 0.03);
  for (const z of [-L / 4, 0, L / 4]) {
    m.quad([hw - 0.3, 1.9, z + 1.3], [-hw + 0.3, 1.9, z + 1.3], [-0.4, 0.9, z + 0.3], [0.4, 0.9, z + 0.3], WHITE, P_BODY);
    m.quad([-hw + 0.3, 1.9, z - 1.3], [hw - 0.3, 1.9, z - 1.3], [0.4, 0.9, z - 0.3], [-0.4, 0.9, z - 0.3], WHITE, P_BODY);
  }
  // Coal heaped in the top.
  m.quad([hw - 0.08, top - 0.1, L / 2 - 0.7], [hw - 0.08, top - 0.1, -L / 2 + 0.7], [0, top + 0.45, -L / 2 + 1.5], [0, top + 0.45, L / 2 - 1.5], lin(0x1b1a19), P_DARK);
  m.quad([-hw + 0.08, top - 0.1, -L / 2 + 0.7], [-hw + 0.08, top - 0.1, L / 2 - 0.7], [0, top + 0.45, L / 2 - 1.5], [0, top + 0.45, -L / 2 + 1.5], lin(0x22201e), P_DARK);
  m.box(-0.2, 0.2, 0.85, 1.05, -L / 2 - 0.35, -L / 2 + 0.6, DARK, P_DARK);
  m.box(-0.2, 0.2, 0.85, 1.05, L / 2 - 0.6, L / 2 + 0.35, DARK, P_DARK);
  m.box(-hw + 0.2, hw - 0.2, 1.1, 1.9, -L / 2 + 0.5, -L / 2 + 0.9, DARK, P_DARK);
  m.box(-hw + 0.2, hw - 0.2, 1.1, 1.9, L / 2 - 0.9, L / 2 - 0.5, DARK, P_DARK);
  return m.build();
}

function container(m: ModelBuilder, hw: number, y0: number, h: number, z0: number, z1: number, part: number): void {
  m.box(-hw, hw, y0, y0 + h, z0, z1, WHITE, part);
  m.end(z1 + 0.01, -hw + 0.1, hw - 0.1, y0 + 0.1, y0 + h - 0.1, DARK, P_DARK, true);
}

function flatcar(): THREE.BufferGeometry {
  const k = CAR_KINDS[CAR.flatcar];
  const m = new ModelBuilder();
  const hw = k.width / 2;
  const L = k.length;
  const deck = 1.25;
  wagonFrame(m, hw, L, deck);
  m.box(-hw, hw, deck, deck + 0.1, -L / 2, L / 2, lin(0x3b3c3f), P_DARK);
  // Two twenty-foot boxes.
  container(m, 1.22, deck + 0.1, 2.6, -L / 2 + 0.6, -0.15, P_BODY);
  container(m, 1.22, deck + 0.1, 2.6, 0.15, L / 2 - 0.6, P_STRIPE);
  return m.build();
}

function doubleStack(): THREE.BufferGeometry {
  const k = CAR_KINDS[CAR.doubleStack];
  const m = new ModelBuilder();
  const hw = k.width / 2;
  const L = k.length;
  // Well car: low deck between the trucks.
  m.box(-hw, -hw + 0.2, 0.55, 1.45, -L / 2 + 2, L / 2 - 2, DARK, P_DARK);
  m.box(hw - 0.2, hw, 0.55, 1.45, -L / 2 + 2, L / 2 - 2, DARK, P_DARK);
  m.box(-hw, hw, 1.0, 1.5, -L / 2, -L / 2 + 2, DARK, P_DARK);
  m.box(-hw, hw, 1.0, 1.5, L / 2 - 2, L / 2, DARK, P_DARK);
  container(m, 1.22, 0.6, 2.6, -L / 2 + 2.1, L / 2 - 2.1, P_BODY);
  container(m, 1.24, 3.2, 2.85, -L / 2 + 0.6, L / 2 - 0.6, P_STRIPE);
  m.box(-0.2, 0.2, 0.85, 1.05, -L / 2 - 0.35, -L / 2, DARK, P_DARK);
  m.box(-0.2, 0.2, 0.85, 1.05, L / 2, L / 2 + 0.35, DARK, P_DARK);
  return m.build();
}

function autorack(): THREE.BufferGeometry {
  const k = CAR_KINDS[CAR.autorack];
  const m = new ModelBuilder();
  const hw = k.width / 2;
  const L = k.length;
  const deck = 1.2;
  wagonFrame(m, hw, L, deck);
  m.box(-hw, hw, deck, k.height - 0.1, -L / 2 + 0.2, L / 2 - 0.2, WHITE, P_BODY);
  m.box(-hw + 0.1, hw - 0.1, k.height - 0.1, k.height, -L / 2 + 0.3, L / 2 - 0.3, lin(0xa8acb0), P_FIXED);
  // Perforated side panels: rows of dark slots.
  for (const y of [deck + 1.2, deck + 2.7]) m.sides(hw, -L / 2 + 0.8, L / 2 - 0.8, y, y + 0.5, DARK, P_DARK, 0.02);
  m.end(-L / 2 + 0.19, -hw + 0.15, hw - 0.15, deck + 0.2, k.height - 0.3, lin(0x8d9297), P_FIXED);
  return m.build();
}

/** Near models, indexed like CAR_KINDS. */
export function buildCarModels(): THREE.BufferGeometry[] {
  return [
    passengerCar(CAR.metroCab, { cab: true, doors: 3, doorW: 1.4, panto: false, roofUnits: 2, lowBand: true }),
    passengerCar(CAR.metroCar, { cab: false, doors: 4, doorW: 1.4, panto: false, roofUnits: 2, lowBand: true }),
    passengerCar(CAR.emuCab, { cab: true, doors: 2, doorW: 1.3, panto: false, roofUnits: 2, lowBand: true }),
    passengerCar(CAR.emuCar, { cab: false, doors: 2, doorW: 1.3, panto: true, roofUnits: 2, lowBand: true }),
    electricLoco(),
    passengerCar(CAR.coach, { cab: false, doors: 2, doorW: 0.9, panto: false, roofUnits: 1, lowBand: true }),
    passengerCar(CAR.cabCar, { cab: true, doors: 2, doorW: 0.9, panto: false, roofUnits: 1, lowBand: true }),
    passengerCar(CAR.hsNose, { cab: true, nose: true, doors: 1, doorW: 0.9, panto: true, roofUnits: 1, lowBand: true }),
    passengerCar(CAR.hsCar, { cab: false, doors: 1, doorW: 0.9, panto: false, roofUnits: 1, lowBand: true }),
    dieselLoco(),
    boxcar(),
    tanker(),
    hopper(),
    flatcar(),
    doubleStack(),
    autorack(),
  ];
}

/** A plain body with a window band and lamps, for distant trains. */
export function buildFarModels(): THREE.BufferGeometry[] {
  return CAR_KINDS.map((k, i) => {
    const m = new ModelBuilder();
    const hw = k.width / 2;
    const L = k.length / 2;
    m.box(-hw, hw, 1.0, k.height, -L, L, WHITE, P_BODY);
    if (i <= CAR.hsCar) {
      m.sides(hw, -L + 1, L - 1, 1.95, 2.75, GLASS, P_GLASS, 0.02);
      m.sides(hw, -L + 0.5, L - 0.5, 1.15, 1.6, WHITE, P_STRIPE, 0.02);
    }
    m.end(-L - 0.02, -hw + 0.3, hw - 0.3, 1.4, 1.7, LAMP, P_LAMP);
    return m.build();
  });
}

/** A two-axle bogie, origin on the rail top at its centre. */
export function buildBogie(wheelR: number, wheelbase: number, freight: boolean): THREE.BufferGeometry {
  const m = new ModelBuilder();
  const gauge = 0.7175;
  const frame = freight ? lin(0x26231f) : lin(0x2a2c30);
  m.box(-1.05, -0.85, wheelR - 0.15, wheelR + 0.3, -wheelbase / 2 - 0.5, wheelbase / 2 + 0.5, frame, P_DARK);
  m.box(0.85, 1.05, wheelR - 0.15, wheelR + 0.3, -wheelbase / 2 - 0.5, wheelbase / 2 + 0.5, frame, P_DARK);
  m.box(-0.9, 0.9, wheelR + 0.05, wheelR + 0.35, -0.35, 0.35, frame, P_DARK);
  for (const z of [-wheelbase / 2, wheelbase / 2]) {
    m.cylX(-gauge - 0.07, -gauge + 0.07, wheelR, z, wheelR, lin(0x3a3632), P_DARK);
    m.cylX(gauge - 0.07, gauge + 0.07, wheelR, z, wheelR, lin(0x3a3632), P_DARK);
    m.cylX(-gauge, gauge, wheelR, z, 0.08, lin(0x55524e), P_DARK, 6);
    // Axle boxes and springs on the frame.
    for (const s of [-1, 1]) m.box(s * 1.1 - 0.12, s * 1.1 + 0.12, wheelR - 0.12, wheelR + 0.12, z - 0.18, z + 0.18, lin(0x5f5a52), P_FIXED);
  }
  for (const s of [-1, 1]) {
    for (const z of [-0.25, 0.25]) m.cylZ(s * 0.95, wheelR + 0.45, 0.1, z - 0.1, z + 0.1, lin(0x6a6e72), P_FIXED, 6);
  }
  return m.build();
}
