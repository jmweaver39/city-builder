/**
 * Mesh helpers for track, stations and rolling stock. A MeshBuf collects
 * positions, normals, colours and a material code per vertex; trackMaterial turns
 * the code into ballast, sleepers, steel and concrete in one draw call.
 */
import * as THREE from 'three';
import type { Shared } from './materials';

/** Material codes, read by the track shader from aExt.x. */
export const M_PLAIN = 0;
export const M_BALLAST = 1;
export const M_SLEEPERS = 2;
export const M_RAIL_HEAD = 3;
export const M_RAIL_SIDE = 4;
export const M_CONCRETE = 5;
export const M_STEEL = 6;
export const M_PAINT = 7;
export const M_LAMP = 8;
export const M_GLASS = 9;
export const M_TILE = 10;

export type RGB3 = readonly [number, number, number];

/** sRGB hex to linear. */
export function lin(hex: number): RGB3 {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [c((hex >> 16) & 255), c((hex >> 8) & 255), c(hex & 255)];
}

export class MeshBuf {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  ext: number[] = [];
  idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: RGB3, kind: number, u = 0, w = 0): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(c[0], c[1], c[2]);
    this.ext.push(kind, u, w);
    return i;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Flat quad, counter-clockwise seen from the front. */
  face(p: number[][], c: RGB3, kind: number): void {
    const [a, b, , d] = p;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const i = p.map((q) => this.vert(q[0], q[1], q[2], nx, ny, nz, c, kind));
    this.quad(i[0], i[1], i[2], i[3]);
  }

  /** Box from a centre, with half sizes along right (rx,rz), up and forward (fx,fz). */
  box(cx: number, cy: number, cz: number, hr: number, hu: number, hf: number, rx: number, rz: number, c: RGB3, kind: number, bottom = false): void {
    const fx = -rz;
    const fz = rx;
    const P = (sr: number, su: number, sf: number) => [cx + rx * sr * hr + fx * sf * hf, cy + su * hu, cz + rz * sr * hr + fz * sf * hf];
    const faces: [number, number, number][][] = [
      [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]],
      [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]],
      [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]],
      [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
      [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
    ];
    if (bottom) faces.push([[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]);
    for (const f of faces) {
      const pts = f.map(([a, b, d]) => P(a, b, d));
      // Winding depends on the handedness of right and forward.
      this.face(rx * fz - rz * fx < 0 ? pts : [pts[0], pts[3], pts[2], pts[1]], c, kind);
    }
  }

  /** Vertical cylinder. */
  post(x: number, z: number, y0: number, y1: number, r: number, c: RGB3, kind: number, sides = 8): void {
    const base = this.count;
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      this.vert(x + nx * r, y0, z + nz * r, nx, 0, nz, c, kind);
      this.vert(x + nx * r, y1, z + nz * r, nx, 0, nz, c, kind);
    }
    for (let i = 0; i < sides; i++) {
      const a = base + i * 2;
      this.quad(a, a + 1, a + 3, a + 2);
    }
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aExt', new THREE.Float32BufferAttribute(this.ext, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** A frame along a polyline: point, unit tangent and right vector, distance. */
export interface PFrame {
  x: number;
  y: number;
  z: number;
  tx: number;
  ty: number;
  tz: number;
  rx: number;
  rz: number;
  s: number;
}

/** Frames along a polyline, densified so long straights still bend with height changes. */
export function polyFrames(pts: ArrayLike<number>, maxStep = 20): PFrame[] {
  const n = pts.length / 3;
  const raw: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p: [number, number, number] = [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
    if (raw.length) {
      const q = raw[raw.length - 1];
      const d = Math.hypot(p[0] - q[0], p[2] - q[2]);
      if (d < 0.05) continue;
      const parts = Math.ceil(d / maxStep);
      for (let k = 1; k < parts; k++) {
        const f = k / parts;
        raw.push([q[0] + (p[0] - q[0]) * f, q[1] + (p[1] - q[1]) * f, q[2] + (p[2] - q[2]) * f]);
      }
    }
    raw.push(p);
  }
  const out: PFrame[] = [];
  let s = 0;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[Math.max(0, i - 1)];
    const b = raw[Math.min(raw.length - 1, i + 1)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    let tz = b[2] - a[2];
    const l = Math.hypot(tx, ty, tz) || 1;
    tx /= l;
    ty /= l;
    tz /= l;
    const h = Math.hypot(tx, tz) || 1;
    if (i > 0) s += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1], raw[i][2] - raw[i - 1][2]);
    out.push({ x: raw[i][0], y: raw[i][1], z: raw[i][2], tx, ty, tz, rx: -tz / h, rz: tx / h, s });
  }
  return out;
}

/** Sweep two profile points (lateral offset, height) along frames as one strip. */
export function sweep(
  buf: MeshBuf,
  frames: readonly PFrame[],
  left: readonly [number, number],
  right: readonly [number, number],
  c: RGB3,
  kind: number,
  i0 = 0,
  i1 = frames.length - 1,
): void {
  const base = buf.count;
  for (let i = i0; i <= i1; i++) {
    const f = frames[i];
    const lx = f.x + f.rx * left[0];
    const ly = f.y + left[1];
    const lz = f.z + f.rz * left[0];
    const rx = f.x + f.rx * right[0];
    const ry = f.y + right[1];
    const rz = f.z + f.rz * right[0];
    const px = rx - lx;
    const py = ry - ly;
    const pz = rz - lz;
    let nx = py * f.tz - pz * f.ty;
    let ny = pz * f.tx - px * f.tz;
    let nz = px * f.ty - py * f.tx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    buf.vert(lx, ly, lz, nx, ny, nz, c, kind, f.s, left[0]);
    buf.vert(rx, ry, rz, nx, ny, nz, c, kind, f.s, right[0]);
  }
  for (let i = 0; i < i1 - i0; i++) {
    const a = base + i * 2;
    buf.quad(a, a + 1, a + 3, a + 2);
  }
}

/** Material for everything built with MeshBuf. Lit, shadowed, fogged, with log depth. */
export function trackMaterial(shared: Shared): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uNoise = shared.uNoise;
    s.uniforms.uNight = shared.uNight;
    s.uniforms.uTime = shared.uTime;
    s.vertexShader = s.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
attribute vec3 aExt;
flat varying float vKind;
varying vec2 vUV;
varying vec3 vWorldPos;
`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
vKind = aExt.x;
vUV = aExt.yz;
vWorldPos = position;
`,
      );
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform sampler2D uNoise;
uniform float uNight;
uniform float uTime;
flat varying float vKind;
varying vec2 vUV;
varying vec3 vWorldPos;
float gRough;
float gMetal;
vec3 gGlow;
`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
{
  gRough = 0.9;
  gMetal = 0.0;
  gGlow = vec3(0.0);
  float k = vKind;
  vec2 p = vWorldPos.xz;
  vec4 n1 = texture2D(uNoise, p * 0.9);
  vec4 n2 = texture2D(uNoise, p / 7.0);
  if (k > 0.5 && k < 1.5) {
    // Ballast: coarse stones, a little lighter where it is fresh.
    float grit = n1.r * 0.6 + texture2D(uNoise, p * 3.1).g * 0.4;
    diffuseColor.rgb *= 0.62 + 0.62 * grit + 0.12 * (n2.b - 0.5);
    gRough = 1.0;
  } else if (k > 1.5 && k < 2.5) {
    // Concrete sleepers every 0.6 m, ballast between them.
    float u = vUV.x / 0.6;
    float w = fwidth(u);
    float f = fract(u);
    float tie = smoothstep(0.0, w * 1.5, f) * (1.0 - smoothstep(0.42 - w * 1.5, 0.42, f));
    tie = mix(tie, 0.42, smoothstep(0.25, 0.6, w));
    float grit = n1.r * 0.6 + texture2D(uNoise, p * 3.1).g * 0.4;
    vec3 stone = diffuseColor.rgb * (0.58 + 0.6 * grit);
    vec3 conc = vec3(0.42, 0.41, 0.39) * (0.9 + 0.2 * n2.g);
    float edge = 1.0 - 0.35 * smoothstep(1.1, 1.3, abs(vUV.y));
    diffuseColor.rgb = mix(stone, conc * edge, tie);
    gRough = 0.95;
  } else if (k > 2.5 && k < 3.5) {
    // Polished rail head.
    diffuseColor.rgb = vec3(0.62, 0.63, 0.64);
    gRough = 0.22;
    gMetal = 1.0;
  } else if (k > 3.5 && k < 4.5) {
    diffuseColor.rgb *= 0.8 + 0.4 * n1.g;
    gRough = 0.75;
    gMetal = 0.45;
  } else if (k > 4.5 && k < 5.5) {
    diffuseColor.rgb *= 0.88 + 0.22 * n2.g;
    gRough = 0.9;
  } else if (k > 5.5 && k < 6.5) {
    gRough = 0.5;
    gMetal = 0.7;
  } else if (k > 6.5 && k < 7.5) {
    gRough = 0.55;
  } else if (k > 7.5 && k < 8.5) {
    gGlow = diffuseColor.rgb * (0.4 + uNight * 5.0);
    gRough = 0.4;
  } else if (k > 8.5 && k < 9.5) {
    gRough = 0.08;
    gMetal = 0.2;
    gGlow = vec3(1.0, 0.82, 0.55) * uNight * 0.6;
  } else if (k > 9.5 && k < 10.5) {
    vec2 q = vWorldPos.xz / 0.6;
    vec2 d = abs(fract(q) - 0.5);
    float joint = smoothstep(0.46, 0.5, max(d.x, d.y));
    diffuseColor.rgb *= 1.0 - 0.25 * joint;
    gRough = 0.35;
  }
}
`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = gRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = gMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gGlow;');
  };
  m.customProgramCacheKey = () => 'cl-track';
  return m;
}
