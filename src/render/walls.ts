/**
 * Retaining walls, embankment and cut slopes, sound barriers and quay walls.
 *
 * Geometry comes from core/walls.ts sections and core/quays.ts, the same data the
 * terrain modifiers use, so walls, slopes and ground meet. Pieces are keyed per
 * segment, node and quay and merged per chunk (batch.ts), and only what a network
 * change touched is rebuilt. Wall faces carry along-and-up coordinates in metres,
 * so the procedural brick, stone, board-formed concrete, gabion and panel patterns
 * keep their real size on any wall, with no stretching.
 */
import * as THREE from 'three';
import type { NetworkChange, RoadNetwork } from '../core/RoadNetwork';
import { QUAY_LAND, QUAY_LINE, QUAY_THICKNESS, QUAY_TOP, bankPoint, quaySamples, type QuaySample } from '../core/quays';
import { sidewalkOn } from '../core/roadTypes';
import { WATER_LEVEL, terrainHeight } from '../core/terrain';
import { groundFn, terrainModsFor, type DiscMod } from '../core/terrainMods';
import type { Id, RoadTypeDef } from '../core/types';
import {
  PARAPET,
  WALL_THICKNESS,
  barrierOn,
  barrierSpan,
  roadEdge,
  sectionAt,
  segmentSections,
  structureOf,
  wallSide,
  type SectionSample,
  type SideSection,
} from '../core/walls';
import type { BarrierSide, Quay, QuayStyle, WallStyle, WallTop } from '../core/wallTypes';
import { ChunkBatch, HOLE_SCHEMA, HoleBuf, type AttrSpec, type Piece } from './batch';
import { ELEVATED_CLEARANCE, ROAD_LIFT, hexRGB, type RGB } from './constants';
import type { RenderContext, RenderLayer } from './context';
import { buildFrames, type Frame } from './frames';
import { CLOUD_SHADOW, makeHoleMaterial, type Shared } from './materials';
import { GROUND_COLOUR_GLSL } from './terrain';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/** Pattern ids read by the wall shader. */
const PAT = {
  board: 0,
  brick: 1,
  stone: 2,
  gabion: 3,
  precast: 4,
  coping: 5,
  steel: 6,
  timber: 7,
  acoustic: 8,
  barrier: 9,
  paving: 10,
  piles: 11,
  mesh: 12,
  plain: 13,
} as const;

interface Look {
  pattern: number;
  color: RGB;
}

const WALL_LOOK: Record<WallStyle, Look> = {
  concrete: { pattern: PAT.board, color: hexRGB(0xbcb7ac) },
  brick: { pattern: PAT.brick, color: hexRGB(0xa5583e) },
  stone: { pattern: PAT.stone, color: hexRGB(0xb3a993) },
  gabion: { pattern: PAT.gabion, color: hexRGB(0x9d978b) },
  precast: { pattern: PAT.precast, color: hexRGB(0xc9c5bb) },
};

const QUAY_LOOK: Record<QuayStyle, Look> = {
  concrete: { pattern: PAT.board, color: hexRGB(0xb9b4a9) },
  brick: { pattern: PAT.brick, color: hexRGB(0x9c5640) },
  stone: { pattern: PAT.stone, color: hexRGB(0xaaa08b) },
  timber: { pattern: PAT.piles, color: hexRGB(0x6f5539) },
};

const COPING: Look = { pattern: PAT.coping, color: hexRGB(0xd9d5cb) };
const RAIL: Look = { pattern: PAT.steel, color: hexRGB(0x56605e) };
const STEEL: Look = { pattern: PAT.steel, color: hexRGB(0x8e959b) };
const MESH: Look = { pattern: PAT.mesh, color: hexRGB(0x7d8784) };
const PAVING: Look = { pattern: PAT.paving, color: hexRGB(0xbab2a2) };
const BOLLARD: Look = { pattern: PAT.plain, color: hexRGB(0x2b2f33) };
const WALE: Look = { pattern: PAT.timber, color: hexRGB(0x5d4630) };

const BARRIER_LOOK: Record<Exclude<BarrierSide['kind'], 'none' | 'berm' | 'acrylic'>, Look> = {
  concrete: { pattern: PAT.barrier, color: hexRGB(0xbfbbb0) },
  timber: { pattern: PAT.timber, color: hexRGB(0x8c6743) },
  metal: { pattern: PAT.acoustic, color: hexRGB(0x6f8476) },
};
const PLINTH: Look = { pattern: PAT.barrier, color: hexRGB(0xb4b0a6) };
const GLASS_COL = hexRGB(0xd8eef2);

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

const WALL_SCHEMA: AttrSpec[] = [
  { name: 'position', size: 3 },
  { name: 'normal', size: 3 },
  { name: 'color', size: 3 },
  // along (m), up or across (m), pattern
  { name: 'aWall', size: 3 },
];

const EARTH_SCHEMA: AttrSpec[] = [
  { name: 'position', size: 3 },
  { name: 'normal', size: 3 },
];

type V3 = readonly [number, number, number];

function norm(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

class WallBuf {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uvp: number[] = [];
  idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  vert(p: V3, n: V3, look: Look, u: number, v: number): number {
    const i = this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.col.push(look.color[0], look.color[1], look.color[2]);
    this.uvp.push(u, v, look.pattern);
    return i;
  }

  /**
   * A strip between two edges sampled at the same stations. The face looks toward
   * `hint` (outward or up); winding follows it. `v` gives the second coordinate of
   * each point: world height for walls, distance across for tops.
   */
  strip(n: number, p0: (i: number) => V3, p1: (i: number) => V3, hint: (i: number) => V3, u: (i: number) => number, look: Look, v: (p: V3, i: number, which: 0 | 1) => number = (p) => p[1]): void {
    if (n < 2) return;
    const base = this.vertexCount;
    let flip = false;
    for (let i = 0; i < n; i++) {
      const a = p0(i);
      const b = p1(i);
      const prev0 = p0(Math.max(0, i - 1));
      const next0 = p0(Math.min(n - 1, i + 1));
      const along = [next0[0] - prev0[0], next0[1] - prev0[1], next0[2] - prev0[2]];
      const across = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      let nn = norm(along[1] * across[2] - along[2] * across[1], along[2] * across[0] - along[0] * across[2], along[0] * across[1] - along[1] * across[0]);
      const h = hint(i);
      if (i === 0) flip = nn[0] * h[0] + nn[1] * h[1] + nn[2] * h[2] < 0;
      if (flip) nn = [-nn[0], -nn[1], -nn[2]];
      if (!Number.isFinite(nn[0]) || (nn[0] === 0 && nn[1] === 0 && nn[2] === 0)) nn = norm(h[0], h[1], h[2]);
      const uu = u(i);
      this.vert(a, nn, look, uu, v(a, i, 0));
      this.vert(b, nn, look, uu, v(b, i, 1));
    }
    for (let i = 0; i + 1 < n; i++) {
      const a = base + i * 2;
      if (flip) this.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
      else this.idx.push(a, a + 3, a + 1, a, a + 2, a + 3);
    }
  }

  quad(a: V3, b: V3, c: V3, d: V3, hint: V3, look: Look, u0: number, u1: number): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    let n = norm(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const flip = n[0] * hint[0] + n[1] * hint[1] + n[2] * hint[2] < 0;
    if (flip) n = [-n[0], -n[1], -n[2]];
    const i0 = this.vert(a, n, look, u0, a[1]);
    const i1 = this.vert(b, n, look, u1, b[1]);
    const i2 = this.vert(c, n, look, u1, c[1]);
    const i3 = this.vert(d, n, look, u0, d[1]);
    if (flip) this.idx.push(i0, i2, i1, i0, i3, i2);
    else this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  /** Oriented box: centre, half extents along right, up, forward (right and forward horizontal). */
  box(cx: number, cy: number, cz: number, hr: number, hu: number, hf: number, rx: number, rz: number, look: Look): void {
    const fx = -rz;
    const fz = rx;
    const p = (sr: number, su: number, sf: number): V3 => [cx + rx * sr * hr + fx * sf * hf, cy + su * hu, cz + rz * sr * hr + fz * sf * hf];
    const u0 = 0;
    const u1 = hf * 2;
    this.quad(p(-1, 1, -1), p(1, 1, -1), p(1, 1, 1), p(-1, 1, 1), [0, 1, 0], look, u0, u1);
    this.quad(p(1, -1, -1), p(1, -1, 1), p(1, 1, 1), p(1, 1, -1), [rx, 0, rz], look, u0, u1);
    this.quad(p(-1, -1, -1), p(-1, 1, -1), p(-1, 1, 1), p(-1, -1, 1), [-rx, 0, -rz], look, u0, u1);
    this.quad(p(-1, -1, 1), p(-1, 1, 1), p(1, 1, 1), p(1, -1, 1), [fx, 0, fz], look, u0, hr * 2);
    this.quad(p(-1, -1, -1), p(1, -1, -1), p(1, 1, -1), p(-1, 1, -1), [-fx, 0, -fz], look, u0, hr * 2);
  }

  /** Upright prism (bollards, round posts). */
  prism(cx: number, cz: number, y0: number, y1: number, r: number, sides: number, look: Look): void {
    const base = this.vertexCount;
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      this.vert([cx + c * r, y0, cz + s * r], [c, 0, s], look, a * r, y0);
      this.vert([cx + c * r, y1, cz + s * r], [c, 0, s], look, a * r, y1);
    }
    for (let i = 0; i < sides; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    const top = this.vert([cx, y1 + r * 0.4, cz], [0, 1, 0], look, 0, 0);
    const ring = this.vertexCount;
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      this.vert([cx + Math.cos(a) * r, y1, cz + Math.sin(a) * r], norm(Math.cos(a), 1.2, Math.sin(a)), look, 0, 0);
    }
    for (let i = 0; i < sides; i++) this.idx.push(top, ring + i + 1, ring + i);
  }

  toPiece(): Piece | null {
    const n = this.vertexCount;
    if (!n) return null;
    let sx = 0;
    let sz = 0;
    const step = Math.max(1, n >> 6);
    let m = 0;
    for (let i = 0; i < n; i += step) {
      sx += this.pos[i * 3];
      sz += this.pos[i * 3 + 2];
      m++;
    }
    return {
      attrs: [new Float32Array(this.pos), new Float32Array(this.nor), new Float32Array(this.col), new Float32Array(this.uvp)],
      index: new Uint32Array(this.idx),
      vertexCount: n,
      cx: sx / m,
      cz: sz / m,
    };
  }
}

class EarthBuf {
  pos: number[] = [];
  nor: number[] = [];
  idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** Strip between two edges, normals facing up. */
  strip(n: number, p0: (i: number) => V3, p1: (i: number) => V3): void {
    if (n < 2) return;
    const base = this.vertexCount;
    let flip = false;
    for (let i = 0; i < n; i++) {
      const a = p0(i);
      const b = p1(i);
      const pa = p0(Math.max(0, i - 1));
      const na = p0(Math.min(n - 1, i + 1));
      const along = [na[0] - pa[0], na[1] - pa[1], na[2] - pa[2]];
      const across = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      let nn = norm(along[1] * across[2] - along[2] * across[1], along[2] * across[0] - along[0] * across[2], along[0] * across[1] - along[1] * across[0]);
      if (i === 0) flip = nn[1] < 0;
      if (flip) nn = [-nn[0], -nn[1], -nn[2]];
      if (!Number.isFinite(nn[0]) || Math.abs(nn[1]) < 1e-6) nn = [0, 1, 0];
      this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      this.nor.push(nn[0], nn[1], nn[2], nn[0], nn[1], nn[2]);
    }
    for (let i = 0; i + 1 < n; i++) {
      const a = base + i * 2;
      if (flip) this.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
      else this.idx.push(a, a + 3, a + 1, a, a + 2, a + 3);
    }
  }

  toPiece(): Piece | null {
    const n = this.vertexCount;
    if (!n) return null;
    return {
      attrs: [new Float32Array(this.pos), new Float32Array(this.nor)],
      index: new Uint32Array(this.idx),
      vertexCount: n,
      cx: this.pos[0],
      cz: this.pos[2],
    };
  }
}

interface Out {
  wall: WallBuf;
  glass: WallBuf;
  earth: EarthBuf;
  hole: HoleBuf;
}

function newOut(): Out {
  return { wall: new WallBuf(), glass: new WallBuf(), earth: new EarthBuf(), hole: new HoleBuf() };
}

// ---------------------------------------------------------------------------
// Segments: walls and slopes
// ---------------------------------------------------------------------------

const COPE_H = 0.14;
const COPE_OVER = 0.07;
/** A trench wall stands this far above the ground at its top. */
const TRENCH_LIP = 0.25;
const FOOT_DEPTH = 0.6;

/** Point at lateral offset o (signed by side) from a sample, at height y. */
function at(s: SectionSample, side: -1 | 1, o: number, y: number): V3 {
  return [s.x + s.rx * o * side, y, s.z + s.rz * o * side];
}

function outward(s: SectionSample, side: -1 | 1): V3 {
  return [s.rx * side, 0, s.rz * side];
}

/** Runs of consecutive samples passing pred. */
function runs<T>(items: readonly T[], pred: (t: T) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= items.length; i++) {
    const on = i < items.length && pred(items[i]);
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}

/**
 * A run of a side's sections, padded with the at-grade neighbour at each end so
 * slopes close onto the road edge instead of stopping in mid air.
 */
function sideRun(samples: readonly SectionSample[], side: -1 | 1, def: RoadTypeDef, a: number, b: number): { s: SectionSample; sec: SideSection }[] {
  const edge = roadEdge(def, side);
  const flat = (s: SectionSample): SideSection => {
    const eY = s.y + ROAD_LIFT + edge.lift;
    const p = { o: edge.offset, y: eY };
    return { side, kind: 'raised', edge: edge.offset, edgeY: eY, wall: null, slope: { o0: edge.offset, y0: eY, o1: edge.offset, y1: eY }, profile: [p, p, p, p], extent: edge.offset };
  };
  const out: { s: SectionSample; sec: SideSection }[] = [];
  if (a > 0) out.push({ s: samples[a - 1], sec: flat(samples[a - 1]) });
  for (let i = a; i <= b; i++) out.push({ s: samples[i], sec: (side < 0 ? samples[i].left : samples[i].right)! });
  if (b + 1 < samples.length) out.push({ s: samples[b + 1], sec: flat(samples[b + 1]) });
  return out;
}

function buildSlopes(out: Out, run: { s: SectionSample; sec: SideSection }[], side: -1 | 1): void {
  // Slopes: wherever a section has one, else collapsed onto its wall's foot.
  const pts = run.map(({ s, sec }) => {
    const sl = sec.slope ?? (sec.wall ? (sec.kind === 'raised' ? { o0: sec.wall.inner, y0: sec.wall.top, o1: sec.wall.inner, y1: sec.wall.top } : { o0: sec.wall.outer, y0: sec.wall.top, o1: sec.wall.outer, y1: sec.wall.top }) : null);
    return sl ? { a: at(s, side, sl.o0, sl.y0 + 0.005), b: at(s, side, sl.o1, sl.y1 + 0.02) } : null;
  });
  for (const [a, b] of runs(pts, (p) => p !== null)) {
    if (b <= a) continue;
    out.earth.strip(b - a + 1, (i) => pts[a + i]!.a, (i) => pts[a + i]!.b);
  }
  // Sunk stretches open the terrain over the whole cut.
}

interface WallRun {
  items: { s: SectionSample; sec: SideSection }[];
}

/** A wall's faces, coping, ends and top finish. */
function buildWall(out: Out, w: WallRun, side: -1 | 1, look: Look, top: WallTop | 'none'): void {
  const items = w.items;
  const n = items.length;
  if (n < 2) return;
  const wall = (i: number) => items[i].sec.wall!;
  const raised = items[0].sec.kind === 'raised';
  const u = (i: number) => items[i].s.s;
  const outV = (i: number) => outward(items[i].s, side);
  const inV = (i: number): V3 => {
    const o = outV(i);
    return [-o[0], 0, -o[2]];
  };
  const crest = (i: number) => (raised ? wall(i).top + PARAPET : wall(i).top + TRENCH_LIP);
  const foot = (i: number) => (raised ? wall(i).bottom - FOOT_DEPTH : wall(i).bottom);
  const P = (i: number, o: number, y: number) => at(items[i].s, side, o, y);
  // Exposed face: outer for a raised wall, inner (road side) for a trench wall.
  if (raised) {
    out.wall.strip(n, (i) => P(i, wall(i).outer, foot(i)), (i) => P(i, wall(i).outer, crest(i)), outV, u, look);
    // Parapet's road side, above the fill.
    out.wall.strip(n, (i) => P(i, wall(i).inner, wall(i).top - 0.05), (i) => P(i, wall(i).inner, crest(i)), inV, u, look);
  } else {
    out.wall.strip(n, (i) => P(i, wall(i).inner, foot(i)), (i) => P(i, wall(i).inner, crest(i)), inV, u, look);
    out.wall.strip(n, (i) => P(i, wall(i).outer, wall(i).top - 0.05), (i) => P(i, wall(i).outer, crest(i)), outV, u, look);
  }
  // Coping: a crisp, pale top line with a small overhang each side.
  const ci = (i: number) => wall(i).inner - COPE_OVER;
  const co = (i: number) => wall(i).outer + COPE_OVER;
  const cy = (i: number) => crest(i) + COPE_H;
  const vAcross = (p: V3, i: number, which: 0 | 1) => (which === 0 ? ci(i) : co(i));
  out.wall.strip(n, (i) => P(i, ci(i), cy(i)), (i) => P(i, co(i), cy(i)), () => [0, 1, 0], u, COPING, vAcross);
  out.wall.strip(n, (i) => P(i, co(i), crest(i) - 0.02), (i) => P(i, co(i), cy(i)), outV, u, COPING);
  out.wall.strip(n, (i) => P(i, ci(i), crest(i) - 0.02), (i) => P(i, ci(i), cy(i)), inV, u, COPING);
  // Ends: close the section and stand a pilaster there.
  for (const i of [0, n - 1]) {
    const s = items[i].s;
    const dir = i === 0 ? -1 : 1;
    const nb = items[i === 0 ? 1 : n - 2].s;
    let fx = (s.x - nb.x) * 1;
    let fz = (s.z - nb.z) * 1;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl;
    fz /= fl;
    const w0 = wall(i);
    const mid = (w0.inner + w0.outer) / 2;
    const c = P(i, mid, 0);
    const y0 = foot(i);
    const y1 = cy(i) + 0.12;
    const hr = (w0.outer - w0.inner) / 2 + 0.12;
    const rxw = s.rx * side;
    const rzw = s.rz * side;
    // Pilaster box, centred on the wall end, half a metre long.
    const cxp = c[0] - fx * 0.25;
    const czp = c[2] - fz * 0.25;
    out.wall.box(cxp, (y0 + y1) / 2, czp, hr, (y1 - y0) / 2, 0.3, rxw, rzw, look);
    out.wall.box(cxp, y1 + 0.05, czp, hr + 0.05, 0.05, 0.35, rxw, rzw, COPING);
    void dir;
  }
  if (top === 'railing') railing(out, items.map((it, i) => ({ s: it.s, o: (it.sec.wall!.inner + it.sec.wall!.outer) / 2, y: cy(i) })), side);
  else if (top === 'fence') fence(out, items.map((it, i) => ({ s: it.s, o: (it.sec.wall!.inner + it.sec.wall!.outer) / 2, y: cy(i) })), side);
}

interface RailPoint {
  s: SectionSample | QuayPoint;
  o: number;
  y: number;
}

/** A quay sample dressed as a section sample, so railings can follow either. */
interface QuayPoint {
  x: number;
  z: number;
  rx: number;
  rz: number;
  s: number;
}

function railAt(p: RailPoint, side: -1 | 1, dy: number): V3 {
  return [p.s.x + p.s.rx * p.o * side, p.y + dy, p.s.z + p.s.rz * p.o * side];
}

function postsAlong(pts: readonly RailPoint[], spacing: number, fn: (p: RailPoint, fx: number, fz: number) => void): void {
  if (pts.length < 2) return;
  const total = pts[pts.length - 1].s.s - pts[0].s.s;
  const count = Math.max(1, Math.round(total / spacing));
  let j = 0;
  for (let k = 0; k <= count; k++) {
    const s = pts[0].s.s + (total * k) / count;
    while (j + 2 < pts.length && pts[j + 1].s.s < s) j++;
    const a = pts[j];
    const b = pts[j + 1];
    const f = Math.min(1, Math.max(0, (s - a.s.s) / Math.max(b.s.s - a.s.s, 1e-6)));
    const lerp = (p: number, q: number) => p + (q - p) * f;
    const rx = lerp(a.s.rx, b.s.rx);
    const rz = lerp(a.s.rz, b.s.rz);
    const rl = Math.hypot(rx, rz) || 1;
    const p: RailPoint = { s: { x: lerp(a.s.x, b.s.x), z: lerp(a.s.z, b.s.z), rx: rx / rl, rz: rz / rl, s }, o: lerp(a.o, b.o), y: lerp(a.y, b.y) };
    fn(p, -rz / rl, rx / rl);
  }
}

function railing(out: Out, pts: RailPoint[], side: -1 | 1, height = 1.05): void {
  const n = pts.length;
  if (n < 2) return;
  const u = (i: number) => pts[i].s.s;
  for (const [h, t] of [
    [height, 0.06],
    [height * 0.5, 0.035],
  ] as const) {
    out.wall.strip(n, (i) => railAt(pts[i], side, h - t), (i) => railAt(pts[i], side, h), (i) => [pts[i].s.rx * side, 0, pts[i].s.rz * side], u, RAIL);
    out.wall.strip(n, (i) => railAt(pts[i], side, h - t), (i) => railAt(pts[i], side, h), (i) => [-pts[i].s.rx * side, 0, -pts[i].s.rz * side], u, RAIL);
    out.wall.strip(n, (i) => railAt({ ...pts[i], o: pts[i].o - 0.03 }, side, h), (i) => railAt({ ...pts[i], o: pts[i].o + 0.03 }, side, h), () => [0, 1, 0], u, RAIL);
  }
  postsAlong(pts, 2, (p) => {
    const c = railAt(p, side, height / 2);
    out.wall.box(c[0], c[1], c[2], 0.03, height / 2, 0.03, p.s.rx * side, p.s.rz * side, RAIL);
  });
}

function fence(out: Out, pts: RailPoint[], side: -1 | 1, height = 1.8): void {
  const n = pts.length;
  if (n < 2) return;
  const u = (i: number) => pts[i].s.s;
  out.wall.strip(n, (i) => railAt(pts[i], side, 0.02), (i) => railAt(pts[i], side, height), (i) => [pts[i].s.rx * side, 0, pts[i].s.rz * side], u, MESH);
  out.wall.strip(n, (i) => railAt(pts[i], side, 0.02), (i) => railAt(pts[i], side, height), (i) => [-pts[i].s.rx * side, 0, -pts[i].s.rz * side], u, MESH);
  out.wall.strip(n, (i) => railAt(pts[i], side, height - 0.04), (i) => railAt(pts[i], side, height), (i) => [pts[i].s.rx * side, 0, pts[i].s.rz * side], u, STEEL);
  postsAlong(pts, 2.5, (p) => {
    const c = railAt(p, side, height / 2 + 0.05);
    out.wall.box(c[0], c[1], c[2], 0.035, height / 2 + 0.05, 0.035, p.s.rx * side, p.s.rz * side, STEEL);
  });
}

function buildSegmentEarthworks(net: RoadNetwork, id: Id, out: Out): void {
  const seg = net.getSegment(id);
  if (!seg) return;
  const samples = segmentSections(net, id);
  if (samples.length < 2) return;
  const spec = structureOf(seg.overrides);
  const def = net.roadTypeOf(id);
  for (const side of [-1, 1] as const) {
    const ws = wallSide(spec, side);
    const has = (s: SectionSample) => !!(side < 0 ? s.left : s.right);
    for (const [a, b] of runs(samples, has)) {
      const run = sideRun(samples, side, def, a, b);
      buildSlopes(out, run, side);
      const look = WALL_LOOK[ws.style];
      // Sound barriers on top replace the finish on that side.
      const barrier = barrierOn(seg.overrides.barriers, side);
      const top = barrier ? 'none' : ws.top;
      for (const [wa, wb] of runs(run, (r) => !!r.sec.wall)) {
        if (wb <= wa) continue;
        buildWall(out, { items: run.slice(wa, wb + 1) }, side, look, top);
      }
    }
  }
  // Open the terrain over sunk stretches, wall to wall or slope top to slope top.
  const sunk = (s: SectionSample) => s.left?.kind === 'sunk' || s.right?.kind === 'sunk';
  for (const [a0, b0] of runs(samples, sunk)) {
    const a = Math.max(0, a0 - 1);
    const b = Math.min(samples.length - 1, b0 + 1);
    const strip: number[] = [];
    for (let i = a; i <= b; i++) {
      const s = samples[i];
      const ext = (side: -1 | 1) => {
        const sec = side < 0 ? s.left : s.right;
        if (!sec) return roadEdge(def, side).offset;
        return sec.wall && !sec.slope ? sec.wall.outer : sec.extent;
      };
      const l = ext(-1);
      const r = ext(1);
      const y = terrainHeight(s.x, s.z) + 0.02;
      strip.push(s.x - s.rx * l, y, s.z - s.rz * l, s.x + s.rx * r, y, s.z + s.rz * r);
    }
    out.hole.strip(strip);
  }
}

// ---------------------------------------------------------------------------
// Sound barriers
// ---------------------------------------------------------------------------

const POST_SPACING = 4;

interface BarrierPoint {
  s: QuayPoint;
  o: number;
  base: number;
  bridge: boolean;
}

function barrierPoints(net: RoadNetwork, id: Id, side: -1 | 1, frames: readonly Frame[], s0: number, s1: number): BarrierPoint[] {
  const seg = net.getSegment(id)!;
  const def = net.roadTypeOf(id);
  const spec = structureOf(seg.overrides);
  const walk = sidewalkOn(def, side);
  const edge = roadEdge(def, side);
  const mods = terrainModsFor(net);
  const pts: BarrierPoint[] = [];
  const push = (f: Frame) => {
    const sample = { x: f.x, z: f.z, rx: f.rx, rz: f.rz, s: f.s };
    if (f.c > ELEVATED_CLEARANCE) {
      // On the bridge parapet.
      pts.push({ s: sample, o: def.halfWidth + walk - 0.3 + 0.16, base: f.y + (walk > 0 ? 0.15 : 0) + 0.95, bridge: true });
      return;
    }
    const sec = sectionAt(spec, def, f.x, f.y - ROAD_LIFT, f.z, f.rx, f.rz, f.s);
    const ss = side < 0 ? sec.left : sec.right;
    if (ss?.wall && (ss.kind === 'sunk' || ss.wall.inner - ss.edge < 0.05)) {
      // On the wall's coping.
      const crest = ss.kind === 'raised' ? ss.wall.top + PARAPET : ss.wall.top + TRENCH_LIP;
      pts.push({ s: sample, o: (ss.wall.inner + ss.wall.outer) / 2, base: crest + COPE_H, bridge: false });
      return;
    }
    const o = edge.offset + 0.45;
    const px = f.x + f.rx * o * side;
    const pz = f.z + f.rz * o * side;
    pts.push({ s: sample, o, base: Math.min(mods.groundAt(px, pz), f.y + edge.lift), bridge: false });
  };
  const inside = frames.filter((f) => f.s > s0 && f.s < s1);
  const interp = (s: number): Frame | null => {
    for (let i = 0; i + 1 < frames.length; i++) {
      const a = frames[i];
      const b = frames[i + 1];
      if (s < a.s || s > b.s) continue;
      const t = (s - a.s) / Math.max(b.s - a.s, 1e-6);
      const l = (p: number, q: number) => p + (q - p) * t;
      const rx = l(a.rx, b.rx);
      const rz = l(a.rz, b.rz);
      const rl = Math.hypot(rx, rz) || 1;
      return { ...a, x: l(a.x, b.x), y: l(a.y, b.y), z: l(a.z, b.z), rx: rx / rl, rz: rz / rl, s, c: l(a.c, b.c), ground: l(a.ground, b.ground) };
    }
    return null;
  };
  const first = interp(s0);
  const last = interp(s1);
  if (first) push(first);
  // Keep panels between posts no longer than the spacing, so they follow bends.
  let prevS = s0;
  for (const f of inside) {
    while (f.s - prevS > POST_SPACING) {
      prevS += POST_SPACING;
      const g = interp(prevS);
      if (g) push(g);
    }
    push(f);
    prevS = f.s;
  }
  while (s1 - prevS > POST_SPACING) {
    prevS += POST_SPACING;
    const g = interp(prevS);
    if (g) push(g);
  }
  if (last) push(last);
  return pts;
}

function buildBarrier(out: Out, pts: BarrierPoint[], side: -1 | 1, b: BarrierSide): void {
  const H = Math.min(6, Math.max(2, b.height));
  if (b.kind === 'berm') {
    // Earth mound beside the road: inner toe, crest, outer toe. Not on bridges.
    for (const [a0, b0] of runs(pts, (p) => !p.bridge)) {
      if (b0 <= a0) continue;
      const sub = pts.slice(a0, b0 + 1);
      const n = sub.length;
      const P = (i: number, o: number, dy: number): V3 => {
        const p = sub[i];
        return [p.s.x + p.s.rx * o * side, p.base + dy, p.s.z + p.s.rz * o * side];
      };
      const k = 1.3;
      const ramp = (i: number) => Math.min(1, Math.min(sub[i].s.s - sub[0].s.s, sub[n - 1].s.s - sub[i].s.s) / (H * 1.5));
      const h = (i: number) => H * ramp(i);
      out.earth.strip(n, (i) => P(i, sub[i].o - 0.2, 0.02), (i) => P(i, sub[i].o + h(i) * k, h(i)));
      out.earth.strip(n, (i) => P(i, sub[i].o + h(i) * k, h(i)), (i) => P(i, sub[i].o + h(i) * k * 2 + 0.2, 0.02));
    }
    return;
  }
  const n = pts.length;
  if (n < 2) return;
  const u = (i: number) => pts[i].s.s;
  const T = 0.07;
  const P = (i: number, dOff: number, dy: number): V3 => {
    const p = pts[i];
    const o = p.o + dOff;
    return [p.s.x + p.s.rx * o * side, p.base + dy, p.s.z + p.s.rz * o * side];
  };
  const outV = (i: number): V3 => [pts[i].s.rx * side, 0, pts[i].s.rz * side];
  const inV = (i: number): V3 => [-pts[i].s.rx * side, 0, -pts[i].s.rz * side];
  let panelFrom = 0;
  if (b.kind === 'acrylic') {
    const plinth = 0.55;
    out.wall.strip(n, (i) => P(i, -0.12, -0.3), (i) => P(i, -0.12, plinth), inV, u, PLINTH);
    out.wall.strip(n, (i) => P(i, 0.12, -0.3), (i) => P(i, 0.12, plinth), outV, u, PLINTH);
    out.wall.strip(n, (i) => P(i, -0.12, plinth), (i) => P(i, 0.12, plinth), () => [0, 1, 0], u, PLINTH, (p, i, w) => (w ? 0.24 : 0));
    out.glass.strip(n, (i) => P(i, -0.012, plinth), (i) => P(i, -0.012, H - 0.08), inV, u, { pattern: P_GLASS, color: GLASS_COL });
    out.glass.strip(n, (i) => P(i, 0.012, plinth), (i) => P(i, 0.012, H - 0.08), outV, u, { pattern: P_GLASS, color: GLASS_COL });
    // Top rail.
    out.wall.strip(n, (i) => P(i, -0.05, H - 0.12), (i) => P(i, -0.05, H), inV, u, STEEL);
    out.wall.strip(n, (i) => P(i, 0.05, H - 0.12), (i) => P(i, 0.05, H), outV, u, STEEL);
    out.wall.strip(n, (i) => P(i, -0.05, H), (i) => P(i, 0.05, H), () => [0, 1, 0], u, STEEL, (p, i, w) => (w ? 0.1 : 0));
    panelFrom = -1;
  } else {
    const look = BARRIER_LOOK[b.kind === 'timber' || b.kind === 'metal' ? b.kind : 'concrete'];
    out.wall.strip(n, (i) => P(i, -T, -0.3), (i) => P(i, -T, H), inV, u, look);
    out.wall.strip(n, (i) => P(i, T, -0.3), (i) => P(i, T, H), outV, u, look);
    out.wall.strip(n, (i) => P(i, -T - 0.02, H), (i) => P(i, T + 0.02, H), () => [0, 1, 0], u, b.kind === 'concrete' ? COPING : STEEL, (p, i, w) => (w ? 0.18 : 0));
  }
  void panelFrom;
  // Posts at even spacing, and a stouter one at each end for a clean finish.
  const post = b.kind === 'concrete' ? PLINTH : b.kind === 'timber' ? WALE : STEEL;
  const total = pts[n - 1].s.s - pts[0].s.s;
  const count = Math.max(1, Math.round(total / POST_SPACING));
  let j = 0;
  for (let k = 0; k <= count; k++) {
    const s = pts[0].s.s + (total * k) / count;
    while (j + 2 < n && pts[j + 1].s.s < s) j++;
    const a = pts[j];
    const c = pts[j + 1];
    const f = Math.min(1, Math.max(0, (s - a.s.s) / Math.max(c.s.s - a.s.s, 1e-6)));
    const l = (p: number, q: number) => p + (q - p) * f;
    const rx = l(a.s.rx, c.s.rx);
    const rz = l(a.s.rz, c.s.rz);
    const o = l(a.o, c.o);
    const base = l(a.base, c.base);
    const x = l(a.s.x, c.s.x) + rx * o * side;
    const z = l(a.s.z, c.s.z) + rz * o * side;
    const end = k === 0 || k === count;
    const hw = end ? 0.16 : 0.1;
    out.wall.box(x, base + (H + 0.1 - 0.3) / 2, z, hw, (H + 0.4) / 2, hw, rx * side, rz * side, post);
  }
}

const P_GLASS = 99;

function buildSegmentBarriers(net: RoadNetwork, id: Id, out: Out): void {
  const seg = net.getSegment(id);
  const geom = net.segmentGeom(id);
  if (!seg?.overrides.barriers || !geom || geom.stations.length < 2) return;
  const span = barrierSpan(net, id);
  if (!span) return;
  const frames = buildFrames(geom.stations, [span.s0, span.s1], groundFn(net));
  for (const side of [-1, 1] as const) {
    const b = barrierOn(seg.overrides.barriers, side);
    if (!b) continue;
    const pts = barrierPoints(net, id, side, frames, span.s0, span.s1);
    buildBarrier(out, pts, side, b);
  }
}

// ---------------------------------------------------------------------------
// Junction pads
// ---------------------------------------------------------------------------

function buildDisc(out: Out, d: DiscMod): void {
  const sides = 40;
  const ring = (r: number, raise: boolean) => {
    const pts: V3[] = [];
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const x = d.x + Math.cos(a) * r;
      const z = d.z + Math.sin(a) * r;
      pts.push([x, raise ? d.y + ROAD_LIFT - 0.03 : terrainHeight(x, z) + 0.02, z]);
    }
    return pts;
  };
  const inner = ring(d.r0, true);
  const outer = ring(d.r1, false);
  out.earth.strip(sides + 1, (i) => inner[i], (i) => outer[i]);
  // The flat pad itself: a fan, under the junction surface.
  const c: V3 = [d.x, d.y + ROAD_LIFT - 0.04, d.z];
  out.earth.strip(sides + 1, () => c, (i) => [inner[i][0], c[1], inner[i][2]]);
  if (!d.raised) {
    const pts: number[] = [];
    const idx: number[] = [];
    pts.push(d.x, 0, d.z);
    for (let i = 0; i <= sides; i++) pts.push(outer[i][0], outer[i][1], outer[i][2]);
    for (let i = 1; i <= sides; i++) idx.push(0, i, i + 1);
    out.hole.polygon(pts, idx);
  }
}

// ---------------------------------------------------------------------------
// Quays
// ---------------------------------------------------------------------------

function quayPoint(q: QuaySample, o: number): QuayPoint {
  // Right vector points toward the land, so side 1 is landward.
  return { x: q.x + q.nx * o, z: q.z + q.nz * o, rx: q.nx, rz: q.nz, s: q.s };
}

function buildQuay(out: Out, quay: Quay): void {
  const sm = quaySamples(quay, 2);
  const n = sm.length;
  if (n < 2) return;
  const look = QUAY_LOOK[quay.style];
  const top = QUAY_TOP;
  const crest = top + 0.12;
  const u = (i: number) => sm[i].s;
  const P = (i: number, o: number, y: number): V3 => [sm[i].x + sm[i].nx * o, y, sm[i].z + sm[i].nz * o];
  const water = (i: number): V3 => [-sm[i].nx, 0, -sm[i].nz];
  const land = (i: number): V3 => [sm[i].nx, 0, sm[i].nz];
  // Water face, from below the bed up to the coping.
  out.wall.strip(n, (i) => P(i, 0, sm[i].bed - 0.8), (i) => P(i, 0, crest), water, u, look);
  if (quay.style === 'timber') {
    // A waling beam along the piles, just above the water.
    out.wall.strip(n, (i) => P(i, -0.18, WATER_LEVEL + 0.6), (i) => P(i, -0.18, WATER_LEVEL + 1.0), water, u, WALE);
    out.wall.strip(n, (i) => P(i, -0.18, WATER_LEVEL + 1.0), (i) => P(i, 0, WATER_LEVEL + 1.0), () => [0, 1, 0], u, WALE, (p, i, w) => (w ? 0.18 : 0));
  }
  // Coping and a paved edge, then the held-up land.
  const cope = quay.style === 'timber' ? WALE : COPING;
  out.wall.strip(n, (i) => P(i, -0.08, crest + 0.1), (i) => P(i, QUAY_THICKNESS, crest + 0.1), () => [0, 1, 0], u, cope, (p, i, w) => (w ? QUAY_THICKNESS + 0.08 : 0));
  out.wall.strip(n, (i) => P(i, -0.08, crest - 0.05), (i) => P(i, -0.08, crest + 0.1), water, u, cope);
  out.wall.strip(n, (i) => P(i, QUAY_THICKNESS, top + 0.03), (i) => P(i, QUAY_THICKNESS, crest + 0.1), land, u, cope);
  const paveTo = QUAY_THICKNESS + 3.2;
  out.wall.strip(n, (i) => P(i, QUAY_THICKNESS, top + 0.03), (i) => P(i, paveTo, top + 0.03), () => [0, 1, 0], u, PAVING, (p, i, w) => (w ? paveTo : QUAY_THICKNESS));
  const back = QUAY_LAND - QUAY_LINE - 0.5;
  out.earth.strip(n, (i) => P(i, paveTo, top + 0.02), (i) => P(i, back, top + 0.015));
  // Return walls closing the fill at each end.
  for (const end of [0, n - 1]) {
    const q = sm[end];
    const along = end === 0 ? -1 : 1;
    const t = sm[end === 0 ? 1 : n - 2];
    let fx = (q.x - t.x) * 1;
    let fz = (q.z - t.z) * 1;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl;
    fz /= fl;
    const steps = 8;
    const ps: V3[] = [];
    const qs: V3[] = [];
    for (let k = 0; k <= steps; k++) {
      const o = (back * k) / steps;
      const p = bankPoint(q.cx, quay.bank, QUAY_LINE + o);
      const bed = terrainHeight(p.x, p.z);
      ps.push([p.x, Math.min(bed, top) - 0.6, p.z]);
      qs.push([p.x, crest + 0.1, p.z]);
    }
    out.wall.strip(steps + 1, (k) => ps[k], (k) => qs[k], () => [fx, 0, fz], (k) => (back * k) / steps, look);
    out.wall.strip(steps + 1, (k) => [qs[k][0], qs[k][1], qs[k][2]], (k) => [qs[k][0] - fx * 0.5, qs[k][1], qs[k][2] - fz * 0.5], () => [0, 1, 0], (k) => (back * k) / steps, cope, (p, k, w) => (w ? 0.5 : 0));
    void along;
  }
  // Top finish.
  const rp = sm.map((q) => ({ s: quayPoint(q, 0), o: 0.3, y: crest + 0.1 }));
  if (quay.top === 'railing') railing(out, rp, 1, 1.0);
  else if (quay.top === 'bollards') {
    postsAlong(rp, 12, (p) => {
      const x = p.s.x + p.s.rx * 0.55;
      const z = p.s.z + p.s.rz * 0.55;
      out.wall.prism(x, z, crest + 0.1, crest + 0.62, 0.17, 10, BOLLARD);
    });
  }
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

const PATTERN_GLSL = /* glsl */ `
float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// 1 on the joints of a unit grid in q, with joint half widths hw (in cells), faded once sub-pixel.
float wJoints(vec2 q, vec2 hw, out float fade) {
  vec2 w = fwidth(q);
  vec2 d = abs(fract(q) - 0.5);
  vec2 j = smoothstep(0.5 - hw - w, 0.5 - hw, d) * step(0.0001, hw);
  fade = 1.0 - smoothstep(0.12, 0.4, max(w.x, w.y));
  return max(j.x, j.y) * fade;
}
vec3 wallPattern(vec3 base, vec2 uv, float pat, vec3 world) {
  float fade;
  vec3 c = base;
  float grain = texture2D(uDetail, uv / 3.3 + world.xz / 41.0).g;
  if (pat < 0.5) {
    // Board-formed concrete: 150 mm boards, lifts every 3 m, tie holes.
    float row = floor(uv.y / 0.15);
    vec2 q = vec2(uv.x / 2.4 + 0.5 * mod(row, 2.0), uv.y / 0.15);
    float j = wJoints(q, vec2(0.004, 0.05), fade);
    float tone = 0.95 + 0.08 * (wHash(floor(q)) - 0.5) * fade;
    c *= tone * (1.0 - 0.12 * j);
    float lift = wJoints(vec2(0.5, uv.y / 3.0), vec2(0.0, 0.01), fade);
    c *= 1.0 - 0.18 * lift;
    vec2 th = fract(uv / vec2(0.6, 0.6)) - 0.5;
    c *= 1.0 - 0.35 * (1.0 - smoothstep(0.03, 0.05, length(th))) * fade;
    c *= 0.94 + 0.12 * grain;
  } else if (pat < 1.5) {
    // Brick: 215 x 65 mm stretcher bond, 10 mm mortar.
    float row = floor(uv.y / 0.075);
    vec2 q = vec2(uv.x / 0.225 + 0.5 * mod(row, 2.0), uv.y / 0.075);
    float j = wJoints(q, vec2(0.022, 0.067), fade);
    float h = wHash(floor(q));
    vec3 brick = base * (0.8 + 0.4 * h * fade + 0.2 * (1.0 - fade) * 0.5);
    brick = mix(brick, brick * vec3(0.78, 0.7, 0.72), step(0.9, h) * fade);
    vec3 mortar = vec3(0.5, 0.47, 0.42);
    c = mix(brick, mortar, j);
    c = mix(c, mix(base, mortar, 0.16), 1.0 - fade);
    c *= 0.92 + 0.16 * grain;
  } else if (pat < 2.5) {
    // Cut stone: 450 mm courses of random length.
    float row = floor(uv.y / 0.45);
    float w = 0.75 + 0.5 * wHash(vec2(row, 7.0));
    vec2 q = vec2(uv.x / w + wHash(vec2(row, 3.0)), uv.y / 0.45);
    float j = wJoints(q, vec2(0.016 / w, 0.03), fade);
    float h = wHash(floor(q));
    c = base * (0.82 + 0.3 * h * fade + 0.15 * (1.0 - fade));
    c = mix(c, c * vec3(1.05, 0.98, 0.9), step(0.7, h) * fade);
    c = mix(c, vec3(0.32, 0.31, 0.29), j * 0.85);
    c *= 0.86 + 0.28 * grain;
  } else if (pat < 3.5) {
    // Gabion: wire baskets a metre square, packed with rubble.
    float row = floor(uv.y / 0.17);
    vec2 q = vec2(uv.x / 0.24 + 0.5 * mod(row, 2.0) + 0.3 * wHash(vec2(row, 1.0)), uv.y / 0.17);
    float j = wJoints(q, vec2(0.1, 0.12), fade);
    float h = wHash(floor(q));
    vec3 stone = base * (0.65 + 0.55 * h);
    stone = mix(stone, stone * vec3(1.1, 0.98, 0.85), step(0.6, wHash(floor(q) + 3.1)));
    c = mix(stone, base * 0.28, j);
    c = mix(c, base * 0.85, 1.0 - fade);
    float f2;
    float wire = wJoints(uv / 1.0, vec2(0.012, 0.012), f2);
    c = mix(c, vec3(0.62, 0.64, 0.64), wire * 0.9);
  } else if (pat < 4.5) {
    // Precast panels 3 x 1.5 m with dark joints.
    vec2 q = uv / vec2(3.0, 1.5);
    float j = wJoints(q, vec2(0.008, 0.016), fade);
    c *= (0.95 + 0.1 * (wHash(floor(q)) - 0.5) * fade) * (1.0 - 0.45 * j);
    c *= 0.95 + 0.1 * texture2D(uDetail, uv / vec2(6.0, 1.2)).g;
  } else if (pat < 5.5) {
    // Coping stones, 1.8 m long.
    float j = wJoints(vec2(uv.x / 1.8, 0.5), vec2(0.004, 0.0), fade);
    c *= (1.0 - 0.3 * j) * (0.96 + 0.08 * grain);
  } else if (pat < 6.5) {
    c *= 0.95 + 0.1 * grain;
  } else if (pat < 7.5) {
    // Timber boards with grain.
    vec2 q = vec2(uv.x / 3.6 + 0.5 * mod(floor(uv.y / 0.14), 2.0), uv.y / 0.14);
    float j = wJoints(q, vec2(0.003, 0.05), fade);
    float g = texture2D(uNoise, vec2(uv.x / 9.0, uv.y * 1.6)).g;
    c *= (0.85 + 0.25 * wHash(floor(q)) * fade) * (0.85 + 0.3 * g) * (1.0 - 0.5 * j);
  } else if (pat < 8.5) {
    // Metal acoustic cassettes: horizontal ribs, panel joints at the posts.
    float r = fract(uv.y / 0.5);
    float w = fwidth(uv.y / 0.5);
    float rib = mix(0.82 + 0.3 * smoothstep(0.0, 0.5, r) * (1.0 - smoothstep(0.85, 1.0, r)), 0.98, smoothstep(0.1, 0.4, w));
    float j = wJoints(vec2(uv.x / 4.0, 0.5), vec2(0.005, 0.0), fade);
    c *= rib * (1.0 - 0.4 * j);
  } else if (pat < 9.5) {
    // Concrete noise wall panels: 4 m bays, fluted.
    float fl = fract(uv.y / 0.3);
    float w = fwidth(uv.y / 0.3);
    float flute = mix(0.9 + 0.12 * sin(fl * 6.2832), 0.96, smoothstep(0.1, 0.4, w));
    float j = wJoints(vec2(uv.x / 4.0, 0.5), vec2(0.006, 0.0), fade);
    c *= flute * (1.0 - 0.4 * j) * (0.9 + 0.2 * texture2D(uDetail, uv / 1.7).r);
  } else if (pat < 10.5) {
    // Paving flags 600 mm.
    vec2 q = uv / 0.6;
    float j = wJoints(q, vec2(0.012, 0.012), fade);
    c *= (0.92 + 0.14 * wHash(floor(q)) * fade) * (1.0 - 0.25 * j);
  } else if (pat < 11.5) {
    // Timber piles, 350 mm, rounded.
    float a = fract(uv.x / 0.36);
    float w = fwidth(uv.x / 0.36);
    float round_ = mix(0.45 + 0.6 * sin(a * 3.14159), 0.8, smoothstep(0.1, 0.4, w));
    float g = texture2D(uNoise, vec2(uv.x * 0.7, uv.y / 7.0)).g;
    c *= round_ * (0.8 + 0.35 * g) * (0.9 + 0.2 * wHash(vec2(floor(uv.x / 0.36), 1.0)));
  } else if (pat < 12.5) {
    // Chain-link mesh: wire diamonds, see-through between.
    vec2 q = vec2(uv.x + uv.y, uv.x - uv.y) / 0.07;
    float j = wJoints(q, vec2(0.09, 0.09), fade);
    float keep = mix(0.35, j, fade);
    float d = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
    if (keep < d) discard;
  }
  // Wet below the water line.
  float wet = 1.0 - smoothstep(${(WATER_LEVEL + 0.1).toFixed(2)}, ${(WATER_LEVEL + 0.55).toFixed(2)}, world.y);
  c = mix(c, c * vec3(0.55, 0.6, 0.56), wet);
  return c;
}
`;

function wallMaterial(shared: Shared): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, side: THREE.FrontSide });
  m.onBeforeCompile = (s) => {
    s.uniforms.uNoise = shared.uNoise;
    s.uniforms.uDetail = shared.uDetail;
    s.uniforms.uCloud = shared.uCloud;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec3 aWall;\nvarying vec3 vWall;\nvarying vec3 vWorldW;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvWall = aWall;\nvWorldW = position;`);
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform sampler2D uNoise;\nuniform sampler2D uDetail;\nuniform vec3 uCloud;\nvarying vec3 vWall;\nvarying vec3 vWorldW;\n${PATTERN_GLSL}\n${CLOUD_SHADOW}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>\ndiffuseColor.rgb = wallPattern(diffuseColor.rgb, vWall.xy, vWall.z, vWorldW);\nfloat wMetal = (vWall.z > 5.5 && vWall.z < 6.5) ? 1.0 : 0.0;`,
      )
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = mix(0.88, 0.5, wMetal);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\nmetalnessFactor = 0.25 * wMetal;`)
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>\n{ float cs = cloudShade(uNoise, uCloud, vWorldW.xz); reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs; }`,
      );
  };
  m.customProgramCacheKey = () => 'cl-walls-1';
  return m;
}

function earthMaterial(shared: Shared): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uNoise = shared.uNoise;
    s.uniforms.uDetail = shared.uDetail;
    s.uniforms.uUnder = shared.uUnder;
    s.uniforms.uCloud = shared.uCloud;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorldE;\nvarying float vUpE;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvWorldE = position;\nvUpE = normal.y;`);
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform sampler2D uNoise;\nuniform sampler2D uDetail;\nuniform float uUnder;\nuniform vec3 uCloud;\nvarying vec3 vWorldE;\nvarying float vUpE;\nconst float MAP_EDGE = 2000.0;\n${GROUND_COLOUR_GLSL}\n${CLOUD_SHADOW}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec3 c = groundColour(vWorldE.xz, 0.0, 0.0, length(vViewPosition));
  // Banks read a touch darker and greener than the flat, with mown stripes along them.
  float steep = 1.0 - clamp(vUpE, 0.0, 1.0);
  c *= 1.0 - 0.12 * smoothstep(0.1, 0.6, steep);
  if (uUnder > 0.5) c = vec3(dot(c, vec3(0.3, 0.6, 0.1))) * vec3(0.5, 0.62, 0.8);
  diffuseColor.rgb = c;
}`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>\n{ float cs = cloudShade(uNoise, uCloud, vWorldE.xz); reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs; }`,
      );
  };
  m.customProgramCacheKey = () => 'cl-earthworks-1';
  return m;
}

function glassMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 0.3,
    roughness: 0.06,
    metalness: 0.1,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

const NODE_BASE = 1 << 27;
const QUAY_BASE = 1 << 28;

export class WallLayer implements RenderLayer {
  readonly group = new THREE.Group();
  private wallMat: THREE.MeshStandardMaterial;
  private earthMat: THREE.MeshStandardMaterial;
  private glassMat: THREE.MeshStandardMaterial;
  private holeMat: THREE.MeshBasicMaterial;
  private walls: ChunkBatch;
  private glass: ChunkBatch;
  private earth: ChunkBatch;
  private holes: ChunkBatch;
  private dirtySegs = new Set<Id>();
  private dirtyNodes = new Set<Id>();
  private quaysDirty = true;
  private all = true;
  private nodeKeys = new Set<Id>();
  private quayKeys = new Set<Id>();
  private off: () => void;

  constructor(private readonly net: RoadNetwork, shared: Shared) {
    this.wallMat = wallMaterial(shared);
    this.earthMat = earthMaterial(shared);
    this.glassMat = glassMaterial();
    this.holeMat = makeHoleMaterial();
    this.walls = new ChunkBatch(WALL_SCHEMA, this.wallMat, { castShadow: true, receiveShadow: true });
    this.glass = new ChunkBatch(WALL_SCHEMA, this.glassMat, { renderOrder: 4 });
    this.earth = new ChunkBatch(EARTH_SCHEMA, this.earthMat, { castShadow: true, receiveShadow: true });
    this.holes = new ChunkBatch(HOLE_SCHEMA, this.holeMat, { renderOrder: -10 });
    this.group.add(this.holes.group, this.earth.group, this.walls.group, this.glass.group);
    this.off = net.onChange((e) => this.onChange(e));
  }

  /** Add to a renderer's scene and frame loop. */
  static install(ctx: RenderContext): WallLayer {
    const layer = new WallLayer(ctx.net, ctx.shared);
    ctx.scene.add(layer.group);
    ctx.addLayer(layer);
    return layer;
  }

  private onChange(e: NetworkChange): void {
    if (e.reset) {
      this.all = true;
      return;
    }
    for (const id of e.dirtySegments) this.dirtySegs.add(id);
    for (const id of e.removedSegments) this.dirtySegs.add(id);
    for (const id of e.dirtyNodes) this.dirtyNodes.add(id);
    for (const id of e.removedNodes) this.dirtyNodes.add(id);
    if (e.quaysChanged) this.quaysDirty = true;
  }

  update(): void {
    this.flush();
  }

  setUnderground(on: boolean): void {
    this.earthMat.transparent = on;
    this.earthMat.opacity = on ? 0.28 : 1;
    this.earthMat.depthWrite = !on;
    this.earthMat.needsUpdate = true;
  }

  private set(key: number, out: Out): void {
    this.walls.set(key, out.wall.toPiece());
    this.glass.set(key, out.glass.toPiece());
    this.earth.set(key, out.earth.toPiece());
    this.holes.set(key, out.hole.toPiece());
  }

  private clearKey(key: number): void {
    for (const b of [this.walls, this.glass, this.earth, this.holes]) b.set(key, null);
  }

  /** Rebuild what changed. Returns true when anything did. */
  flush(): boolean {
    const net = this.net;
    if (!this.all && !this.dirtySegs.size && !this.dirtyNodes.size && !this.quaysDirty) return false;
    if (this.all) {
      for (const b of [this.walls, this.glass, this.earth, this.holes]) b.clear();
      this.nodeKeys.clear();
      this.quayKeys.clear();
      this.dirtySegs.clear();
      this.dirtyNodes.clear();
      for (const s of net.segments) this.dirtySegs.add(s.id);
      for (const n of net.nodes) this.dirtyNodes.add(n.id);
      this.quaysDirty = true;
      this.all = false;
    }
    // A segment's ends depend on its nodes, and pads on their arms.
    for (const id of [...this.dirtySegs]) {
      const s = net.getSegment(id);
      if (s) {
        this.dirtyNodes.add(s.a);
        this.dirtyNodes.add(s.b);
      }
    }
    for (const id of [...this.dirtyNodes]) {
      for (const s of net.getNode(id)?.segments ?? []) this.dirtySegs.add(s);
    }
    for (const id of this.dirtySegs) {
      if (!net.getSegment(id)) {
        this.clearKey(id);
        continue;
      }
      const out = newOut();
      buildSegmentEarthworks(net, id, out);
      buildSegmentBarriers(net, id, out);
      this.set(id, out);
    }
    const mods = terrainModsFor(net);
    const discs = new Map(mods.discs.map((d) => [d.nodeId, d]));
    for (const id of this.dirtyNodes) {
      const d = discs.get(id);
      if (!d) {
        if (this.nodeKeys.delete(id)) this.clearKey(NODE_BASE + id);
        continue;
      }
      const out = newOut();
      buildDisc(out, d);
      this.set(NODE_BASE + id, out);
      this.nodeKeys.add(id);
    }
    if (this.quaysDirty) {
      for (const id of this.quayKeys) this.clearKey(QUAY_BASE + id);
      this.quayKeys.clear();
      for (const q of net.quays) {
        const out = newOut();
        buildQuay(out, q);
        this.set(QUAY_BASE + q.id, out);
        this.quayKeys.add(q.id);
      }
      this.quaysDirty = false;
    }
    this.dirtySegs.clear();
    this.dirtyNodes.clear();
    for (const b of [this.walls, this.glass, this.earth, this.holes]) b.flush();
    return true;
  }

  dispose(): void {
    this.off();
    for (const b of [this.walls, this.glass, this.earth, this.holes]) b.dispose();
    this.wallMat.dispose();
    this.earthMat.dispose();
    this.glassMat.dispose();
    this.holeMat.dispose();
    this.group.clear();
  }
}
