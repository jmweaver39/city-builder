/**
 * Road meshing: sweeps a cross section along the stations of a segment's
 * trimmed span. Everything here reads core data and writes into buffers; the
 * layer in RoadLayer.ts decides when to run it.
 */
import type { Id, LaneDef, RoadTypeDef, Segment } from '../core/types';
import type { RoadNetwork } from '../core/RoadNetwork';
import { effectiveLanes, sidewalkOn } from '../core/roadTypes';
import { HoleBuf, SurfBuf, type SurfStyle } from './batch';
import {
  BIAS_PER_RANK,
  COL,
  DECK_DEPTH,
  KERB_HEIGHT,
  KIND_ASPHALT,
  KIND_CONCRETE,
  KIND_GRASS,
  KIND_LAMP,
  KIND_CONCRETE_ROAD,
  KIND_KERB,
  KIND_PLAIN,
  KIND_STEEL,
  KIND_SIDEWALK,
  KIND_UNTINTED,
  ROAD_LIFT,
  SURFACE_COL,
  TUNNEL_CLEARANCE,
  TUNNEL_Y,
  hexRGB,
  lerpRGB,
  type RGB,
} from './constants';
import { buildFrames, isTunnelFrame, type Frame } from './frames';
import { groundFn } from '../core/terrainMods';
import { markStructureFrames } from './wallFrames';
import { armEndLayout, medianNoseBack } from './markings';
import { addSegmentStructures } from './structures';
import { planSupports, soffitLayout } from './piers';
import { asphaltFor } from './style';
import { kerbShiftStations, segmentKerbShift } from '../core/junctionShape';

export interface RoadOutputs {
  surf: SurfBuf;
  /** Visible only in the underground view. */
  tube: SurfBuf;
  /** Visible only in the normal view: caps that stop you seeing out of a tunnel. */
  plug: SurfBuf;
  hole: HoleBuf;
  /** Small parts dropped at a distance and at low quality (pier bearings, railing posts). Falls back to surf. */
  detail?: SurfBuf;
}

type Prof = (f: Frame, i: number) => readonly [number, number];

const LAMP_TINT = hexRGB(0xffe2b0);
const SOFFIT_COL = hexRGB(0xf2efe8);

/**
 * Sets the surface hints (SurfBuf.hx..hw, the aSurf attribute) for the next vertex.
 * Gets the frame, its index, the lateral offset and height of the vertex, and 0 for
 * the left edge of the strip or 1 for the right.
 *
 * What the surface shader reads, by kind:
 *   asphalt, concrete road (on segments)
 *     x  lane code: 8 * (zone index + 1) + lane half width (0 half width off the lanes)
 *     y  metres from the carriageway edge
 *     z  metres before the stop line this lane approaches, 999 when none
 *     w  metres from the nearest deck expansion joint, 999 when none
 *   junction, concrete road (on junctions): x 0, y 99, z 0, w 999; aRoad is the
 *     offset from the node centre
 *   sidewalk: x dropped kerb (0 to 1), y metres from the kerb edge
 *   kerb: x height up the kerb (0 foot, 1 top of the chamfer), y dropped kerb
 */
export type HintFn = (buf: SurfBuf, f: Frame, i: number, offset: number, height: number, edge: 0 | 1) => void;

/** Sweep two profile points along frames i0..i1 as one smooth strip. */
export function ribbon(
  buf: SurfBuf,
  frames: readonly Frame[],
  i0: number,
  i1: number,
  left: Prof,
  right: Prof,
  style: SurfStyle,
  centre: number | null = null,
  hint: HintFn | null = null,
): void {
  const base = buf.vertexCount;
  for (let i = i0; i <= i1; i++) {
    const f = frames[i];
    const [ol, hl] = left(f, i);
    const [or, hr] = right(f, i);
    const lx = f.x + f.rx * ol;
    const ly = f.y + hl;
    const lz = f.z + f.rz * ol;
    const rx = f.x + f.rx * or;
    const ry = f.y + hr;
    const rz = f.z + f.rz * or;
    const px = rx - lx;
    const py = ry - ly;
    const pz = rz - lz;
    // p x t: left-to-right across a road gives up.
    let nx = py * f.tz - pz * f.ty;
    let ny = pz * f.tx - px * f.tz;
    let nz = px * f.ty - py * f.tx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-6) {
      nx /= l;
      ny /= l;
      nz /= l;
    } else {
      // Width pinched to nothing, as at a median nose.
      nx = 0;
      ny = 1;
      nz = 0;
    }
    buf.rv = f.s;
    buf.ru = centre === null ? ol : ol - centre;
    hint?.(buf, f, i, ol, hl, 0);
    buf.vert(lx, ly, lz, nx, ny, nz, style);
    buf.ru = centre === null ? or : or - centre;
    hint?.(buf, f, i, or, hr, 1);
    buf.vert(rx, ry, rz, nx, ny, nz, style);
  }
  buf.ru = 0;
  buf.rv = 0;
  buf.hx = buf.hy = buf.hz = buf.hw = 0;
  for (let i = 0; i < i1 - i0; i++) {
    const a = base + i * 2;
    buf.quad(a, a + 1, a + 3, a + 2);
  }
}

/** Ranges of consecutive frames passing pred, widened by one frame each way. */
export function runsOf(frames: readonly Frame[], pred: (f: Frame) => boolean, widen = 1): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= frames.length; i++) {
    const on = i < frames.length && pred(frames[i]);
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      const a = Math.max(0, start - widen);
      const b = Math.min(frames.length - 1, i - 1 + widen);
      if (b > a) {
        const prev = out[out.length - 1];
        if (prev && prev[1] >= a) prev[1] = b;
        else out.push([a, b]);
      }
      start = -1;
    }
  }
  return out;
}

export function rankBias(def: RoadTypeDef): number {
  return Math.min(14, Math.max(0, def.rank)) * BIAS_PER_RANK;
}

export function surfaceColour(seg: Segment | undefined, def?: RoadTypeDef): RGB {
  if (seg?.overrides.surface) return SURFACE_COL[seg.overrides.surface];
  return def ? asphaltFor(def) : COL.asphalt;
}

/** Above this clearance a deck is a slab on girders, not a solid embankment edge. */
const GIRDER_CLEARANCE = 2.4;
const SLAB_DEPTH = 0.42;

/** Bottom of the road structure, relative to the surface. */
export function deckBottom(f: Frame): number {
  const solid = Math.min(DECK_DEPTH, Math.max(f.c, 0) + 0.35);
  const t = Math.min(1, Math.max(0, (f.c - GIRDER_CLEARANCE + 0.7) / 0.7));
  return -(solid + (SLAB_DEPTH - solid) * t);
}

/** Gravel verge width: full on flat ground, gone on a deck or in a cutting. */
export function vergeWidth(f: Frame): number {
  return 0.9 * Math.max(0, 1 - Math.abs(f.c) / 0.6);
}

interface Zone {
  a: number;
  b: number;
  color: RGB;
  /** Lane centre, for wheel tracks. Far away for shoulders and medians. */
  centre: number;
  /** Half width of a driven lane, 0 for shoulders, medians and bike lanes. */
  half: number;
  /** Travel direction of a driven lane, 0 otherwise. */
  dir: number;
}

function laneZones(def: RoadTypeDef, lanes: readonly LaneDef[], main: RGB): Zone[] {
  const H = def.halfWidth;
  const shoulder = lerpRGB(main, COL.shoulder, 0.6);
  const zones: Zone[] = [];
  const push = (a: number, b: number, color: RGB, centre = -1000, half = 0, dir = 0) => {
    if (b - a < 0.01) return;
    zones.push({ a, b, color, centre, half, dir });
  };
  let x = -H;
  for (const lane of lanes) {
    const lo = lane.offset - lane.width / 2;
    const hi = lane.offset + lane.width / 2;
    push(x, lo, x === -H ? shoulder : main);
    const c = lane.kind === 'bus' ? COL.busLane : lane.kind === 'bike' ? COL.bikeLane : main;
    const driven = lane.kind !== 'bike';
    push(lo, hi, c, driven ? lane.offset : -1000, driven ? lane.width / 2 : 0, driven ? lane.dir : 0);
    x = hi;
  }
  push(x, H, shoulder);
  return zones;
}

/** Where the kerb drops for a crosswalk, from the cut line: flank, flush run, flank. */
const DROP_IN = 0.3;
const DROP_FLUSH = 3.7;
const DROP_OUT = 4.5;
/** Kerb height left at a drop. */
const DROP_KERB = 0.025;
/** Chamfer on the kerb's top arris. */
const CHAMFER = 0.02;
/** Half width of the band a deck expansion joint cuts across the surface. */
const JOINT_BAND = 0.6;

/** Per-segment facts the surface hints need. */
interface SurfaceInfo {
  /** Stop line arc length at each end, null where the end is not at a junction. */
  stopA: number | null;
  stopB: number | null;
  /** Dropped kerb (0 to 1) at an arc length. */
  drop: (s: number) => number;
  /** Arc lengths of deck expansion joints. */
  joints: number[];
}

function dropProfile(d: number): number {
  if (d < 0 || d > DROP_OUT) return 0;
  if (d < DROP_IN) return d / DROP_IN;
  if (d <= DROP_FLUSH) return 1;
  return 1 - (d - DROP_FLUSH) / (DROP_OUT - DROP_FLUSH);
}

function nearestJoint(joints: readonly number[], s: number): number {
  let best = 999;
  for (const j of joints) best = Math.min(best, Math.abs(s - j));
  return best;
}

function median(buf: SurfBuf, frames: readonly Frame[], def: RoadTypeDef, slot: number, bias: number, startS: number, endS: number): void {
  const m = def.median;
  if (m.width <= 0 || (m.kind !== 'grass' && m.kind !== 'barrier')) return;
  const hw = m.width / 2;
  const o = m.offset ?? 0;
  const n = frames.length - 1;
  // Noses stop short of a junction so turning paths stay clear.
  const edgeDist = (f: Frame) => Math.min(f.s - startS, endS - f.s);
  const kerb: SurfStyle = { color: COL.kerb, kind: KIND_PLAIN, slot, bias };
  if (m.kind === 'grass') {
    const widthAt = (f: Frame) => {
      const d = edgeDist(f) / Math.max(hw, 0.6);
      if (d <= 0) return 0;
      if (d >= 1) return hw;
      return hw * Math.sqrt(1 - (1 - d) * (1 - d));
    };
    const h = (f: Frame) => (edgeDist(f) <= 0 ? 0 : KERB_HEIGHT);
    const grass: SurfStyle = { color: COL.grass, kind: KIND_GRASS, slot, bias };
    ribbon(buf, frames, 0, n, (f) => [o - widthAt(f), h(f)], (f) => [o + widthAt(f), h(f)], grass);
    ribbon(buf, frames, 0, n, (f) => [o - widthAt(f) - 0.02, 0], (f) => [o - widthAt(f), h(f)], kerb);
    ribbon(buf, frames, 0, n, (f) => [o + widthAt(f), h(f)], (f) => [o + widthAt(f) + 0.02, 0], kerb);
    return;
  }
  const barrier: SurfStyle = { color: COL.barrier, kind: KIND_PLAIN, slot, bias };
  const hTop = (f: Frame) => (edgeDist(f) <= 0 ? 0 : Math.min(0.85, 0.85 * (edgeDist(f) / 0.6)));
  const base = 0.3;
  const top = 0.09;
  ribbon(buf, frames, 0, n, (f) => [o - top, hTop(f)], (f) => [o + top, hTop(f)], barrier);
  ribbon(buf, frames, 0, n, () => [o - base, 0], (f) => [o - top, hTop(f)], barrier);
  ribbon(buf, frames, 0, n, (f) => [o + top, hTop(f)], () => [o + base, 0], barrier);
}

/** Sidewalk or verge on one side, for all frames. side -1 left, 1 right. */
function roadside(
  buf: SurfBuf,
  frames: readonly Frame[],
  def: RoadTypeDef,
  side: -1 | 1,
  slot: number,
  bias: number,
  /** Kerb moved into the road (+) near a shaped junction, and the asphalt to fill a narrowing. */
  shape?: { shift: (side: 1 | -1, s: number) => number; asphalt: SurfStyle } | null,
  info?: SurfaceInfo | null,
): void {
  const H = def.halfWidth;
  const W = sidewalkOn(def, side);
  const n = frames.length - 1;
  const swap = (p: Prof, q: Prof): [Prof, Prof] => (side > 0 ? [p, q] : [q, p]);
  if (W > 0) {
    const kerb: SurfStyle = { color: COL.kerb, kind: KIND_KERB, slot, bias };
    const walk: SurfStyle = { color: COL.sidewalk, kind: KIND_SIDEWALK, slot, bias };
    const K = shape ? (f: Frame) => H - shape.shift(side, f.s) : () => H;
    const drop = info ? (f: Frame) => info.drop(f.s) : () => 0;
    // Kerb height, lowered to almost flush at a crosswalk, and its chamfer.
    const KH = (f: Frame) => KERB_HEIGHT - (KERB_HEIGHT - DROP_KERB) * drop(f);
    const ch = (f: Frame) => Math.min(CHAMFER, KH(f) * 0.5);
    const kerbHint: HintFn = (b, f, _i, _o, h) => {
      b.hx = Math.min(1, Math.max(0, h / Math.max(0.001, KH(f))));
      b.hy = drop(f);
    };
    // Kerb face looks at the road, then the chamfer leans back to the sidewalk.
    if (side > 0) {
      ribbon(buf, frames, 0, n, (f) => [K(f), 0], (f) => [K(f), KH(f) - ch(f)], kerb, null, kerbHint);
      ribbon(buf, frames, 0, n, (f) => [K(f), KH(f) - ch(f)], (f) => [K(f) + ch(f), KH(f)], kerb, null, kerbHint);
    } else {
      ribbon(buf, frames, 0, n, (f) => [-K(f), KH(f) - ch(f)], (f) => [-K(f), 0], kerb, null, kerbHint);
      ribbon(buf, frames, 0, n, (f) => [-K(f) - ch(f), KH(f)], (f) => [-K(f), KH(f) - ch(f)], kerb, null, kerbHint);
    }
    const [l, r] = swap(
      (f) => [side * (K(f) + ch(f)), KH(f)],
      () => [side * (H + W), KERB_HEIGHT],
    );
    ribbon(buf, frames, 0, n, l, r, walk, null, (b, f, _i, o) => {
      b.hx = drop(f);
      b.hy = Math.max(0, Math.abs(o) - K(f));
    });
    if (shape) {
      // A narrowed sidewalk leaves road surface between the old and new kerb.
      const [al, ar] = swap(() => [side * H, 0], (f) => [side * Math.max(H, K(f)), 0]);
      for (const [a, b] of runsOf(frames, (f) => K(f) > H + 0.01)) ribbon(buf, frames, a, b, al, ar, shape.asphalt);
    }
    return;
  }
  const gravel: SurfStyle = { color: COL.gravel, kind: KIND_GRASS, slot, bias };
  const [l, r] = swap(
    () => [side * H, 0],
    (f) => [side * (H + vergeWidth(f)), (-0.22 * vergeWidth(f)) / 0.9],
  );
  for (const [a, b] of runsOf(frames, (f) => vergeWidth(f) > 0.01)) ribbon(buf, frames, a, b, l, r, gravel);
}

function outerOffset(def: RoadTypeDef, f: Frame, side: -1 | 1): number {
  const W = sidewalkOn(def, side);
  return def.halfWidth + (W > 0 ? W : vergeWidth(f));
}

function outerHeight(def: RoadTypeDef, f: Frame, side: -1 | 1): number {
  return sidewalkOn(def, side) > 0 ? KERB_HEIGHT : (-0.22 * vergeWidth(f)) / 0.9;
}

/** Deck sides and underside, wherever the road sits above the ground. */
function deck(buf: SurfBuf, frames: readonly Frame[], def: RoadTypeDef, slot: number): void {
  const side: SurfStyle = { color: COL.concrete, kind: KIND_CONCRETE, slot, bias: 0 };
  const under: SurfStyle = { color: SOFFIT_COL, kind: KIND_CONCRETE, slot, bias: 0 };
  const raised = (f: Frame) => f.c > 0.08;
  const showWall = def.sidewalk > 0 ? (f: Frame) => f.c > -0.05 : raised;
  for (const [a, b] of runsOf(frames, showWall)) {
    ribbon(buf, frames, a, b, (f) => [outerOffset(def, f, 1), outerHeight(def, f, 1)], (f) => [outerOffset(def, f, 1), deckBottom(f)], side);
    ribbon(buf, frames, a, b, (f) => [-outerOffset(def, f, -1), deckBottom(f)], (f) => [-outerOffset(def, f, -1), outerHeight(def, f, -1)], side);
  }
  for (const [a, b] of runsOf(frames, raised)) {
    ribbon(buf, frames, a, b, (f) => [outerOffset(def, f, 1), deckBottom(f)], (f) => [-outerOffset(def, f, -1), deckBottom(f)], under);
  }
  girders(buf, frames, def, slot);
}

/**
 * Beams under a raised deck, between the slab and the pier caps: one or two
 * trapezoid box girders under highways, ramps and wide roads, precast I-girders
 * under streets and railways. Faces wind outward (see ribbon).
 */
function girders(buf: SurfBuf, frames: readonly Frame[], def: RoadTypeDef, slot: number): void {
  const web: SurfStyle = { color: COL.concrete, kind: KIND_CONCRETE, slot, bias: 0 };
  // The soffit sees only light bounced off the ground below, which the scene lights
  // leave near black: a paler concrete stands in for that bounce.
  const soffit: SurfStyle = { color: SOFFIT_COL, kind: KIND_CONCRETE, slot, bias: 0 };
  const top = -SLAB_DEPTH + 0.02;
  const bot = -DECK_DEPTH;
  const lay = soffitLayout(def);
  /** Quarter round from angle a0 to a1 (degrees) about (cx, cy), radius r. */
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let k = 0; k <= 3; k++) {
      const t = ((a0 + ((a1 - a0) * k) / 3) * Math.PI) / 180;
      out.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
    }
    return out;
  };
  // A profile listed clockwise, looking along the road with right to the right, faces outward.
  const sweep = (a: number, b: number, pts: [number, number][], flat: (p: [number, number], q: [number, number]) => boolean) => {
    for (let k = 0; k + 1 < pts.length; k++) {
      const p = pts[k];
      const q = pts[k + 1];
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-4) continue;
      ribbon(buf, frames, a, b, () => p, () => q, flat(p, q) ? soffit : web);
    }
  };
  const level = (p: [number, number], q: [number, number]) => Math.abs(p[1] - q[1]) < 0.01 && Math.abs(p[1] - bot) < 0.2;
  const mirror = (pts: [number, number][]) => pts.map(([o, h]) => [-o, h] as [number, number]).reverse();
  for (const [a, b] of runsOf(frames, (f) => f.c > GIRDER_CLEARANCE - 0.7)) {
    if (b <= a) continue;
    if (lay.kind === 'trough') {
      // Rail viaduct: one smooth U-trough, the walls running down into a rounded soffit.
      const R = lay.right;
      const L = lay.left;
      const rr = 0.45;
      const tb = bot + 0.1;
      sweep(a, b, [[R, top - 0.02], [R, tb + rr], ...arc(R - rr, tb + rr, rr, 0, -90), ...arc(-L + rr, tb + rr, rr, -90, -180), [-L, top - 0.02]], level);
      continue;
    }
    // Road: smooth box girders with rounded bottom corners under the slab, and a
    // rounded edge beam under each fascia. The soffit stays clean.
    const edge = (O: number): [number, number][] => [[O, top - 0.02], [O, -0.6], ...arc(O - 0.2, -0.6, 0.2, 0, -90), [O - 0.45, -0.8], [O - 0.6, -0.66], [O - 0.6, top - 0.02]];
    sweep(a, b, edge(lay.right), () => false);
    sweep(a, b, mirror(edge(lay.left)), () => false);
    const rr = 0.35;
    for (const box of lay.boxes) {
      const c = box.c;
      sweep(a, b, [[c + box.top, top], [c + box.bottom, bot + rr], ...arc(c + box.bottom - rr, bot + rr, rr, 0, -90), ...arc(c - box.bottom + rr, bot + rr, rr, -90, -180), [c - box.bottom, bot + rr], [c - box.top, top]], level);
    }
  }
}

function isOpenCut(f: Frame): boolean {
  return f.c < -0.03 && !isTunnelFrame(f);
}

function isTunnel(f: Frame): boolean {
  return isTunnelFrame(f);
}

/** Tunnel with its roof still above the ground: the cut-and-cover stretch behind a portal. */
function isHooded(f: Frame): boolean {
  return isTunnel(f) && f.y + TUNNEL_CLEARANCE + 0.5 > f.ground;
}

/** Walls of the open cutting and the opening in the terrain. */
function cutting(out: RoadOutputs, frames: readonly Frame[], def: RoadTypeDef, slot: number): void {
  const wall: SurfStyle = { color: COL.concrete, kind: KIND_CONCRETE, slot, bias: 0 };
  const O = def.halfWidth + def.sidewalk;
  // Height of the wall top over the road surface.
  const top = (f: Frame) => Math.max(0, -f.c + ROAD_LIFT) + 0.45 * Math.min(1, Math.max(0, -f.c / 0.4));
  for (const [a, b] of runsOf(frames, isOpenCut)) {
    ribbon(out.surf, frames, a, b, () => [O, 0], (f) => [O, top(f)], wall);
    ribbon(out.surf, frames, a, b, (f) => [-O, top(f)], () => [-O, 0], wall);
    ribbon(out.surf, frames, a, b, (f) => [O, top(f)], (f) => [O + 0.35, top(f)], wall);
    ribbon(out.surf, frames, a, b, (f) => [-O - 0.35, top(f)], (f) => [-O, top(f)], wall);
  }
  for (const [a, b] of runsOf(frames, (f) => isOpenCut(f) || isHooded(f), 0)) {
    const strip: number[] = [];
    for (let i = a; i <= b; i++) {
      const f = frames[i];
      strip.push(f.x - f.rx * O, f.ground + 0.02, f.z - f.rz * O, f.x + f.rx * O, f.ground + 0.02, f.z + f.rz * O);
    }
    out.hole.strip(strip);
  }
}

/** Dark cap across the road, seen from either side. */
function plugAt(buf: SurfBuf, f: Frame, O: number, H: number): void {
  const cap: SurfStyle = { color: COL.black, kind: KIND_UNTINTED, slot: 0, bias: 0 };
  const l = [f.x - f.rx * O, f.z - f.rz * O];
  const r = [f.x + f.rx * O, f.z + f.rz * O];
  buf.flatQuad([l[0], f.y - 0.2, l[1]], [r[0], f.y - 0.2, r[1]], [r[0], f.y + H, r[1]], [l[0], f.y + H, l[1]], cap);
  buf.flatQuad([r[0], f.y - 0.2, r[1]], [l[0], f.y - 0.2, l[1]], [l[0], f.y + H, l[1]], [r[0], f.y + H, r[1]], cap);
}

/** Dark inner walls and ceiling, and the roof box over the shallow stretch. */
function hoodAndTube(out: RoadOutputs, frames: readonly Frame[], def: RoadTypeDef, slot: number): void {
  const O = def.halfWidth + def.sidewalk + 0.1;
  const OW = O + 0.6;
  const H = TUNNEL_CLEARANCE;
  const inner: SurfStyle = { color: COL.tunnelInner, kind: KIND_UNTINTED, slot, bias: 0 };
  const outer: SurfStyle = { color: COL.concrete, kind: KIND_CONCRETE, slot, bias: 0 };
  const bare: SurfStyle = { color: COL.tunnelInner, kind: KIND_UNTINTED, slot: 0, bias: 0 };
  const roof: SurfStyle = { color: COL.grass, kind: KIND_GRASS, slot: 0, bias: 0 };
  const s = out.surf;
  for (const [a, b] of runsOf(frames, isHooded, 0)) {
    ribbon(s, frames, a, b, () => [O, H], () => [-O, H], inner);
    ribbon(s, frames, a, b, () => [O, 0], () => [O, H], inner);
    ribbon(s, frames, a, b, () => [-O, H], () => [-O, 0], inner);
    ribbon(s, frames, a, b, () => [-OW, H + 0.5], () => [OW, H + 0.5], roof);
    ribbon(s, frames, a, b, () => [OW, H + 0.5], () => [OW, 0], outer);
    ribbon(s, frames, a, b, () => [-OW, 0], () => [-OW, H + 0.5], outer);
    // Strip lights down the middle of the ceiling.
    const lamp: SurfStyle = { color: LAMP_TINT, kind: KIND_LAMP, slot: 0, bias: 0 };
    for (let i = a; i <= b; i += 2) {
      const f = frames[i];
      for (const off of [-O * 0.5, O * 0.5]) {
        s.box(f.x + f.rx * off, f.y + H - 0.04, f.z + f.rz * off, 0.16, 0.04, 0.9, f.rx, f.rz, f.rz, -f.rx, lamp, { bottom: true });
      }
    }
    // Past the roof box there is only the terrain's underside, so end the view here.
    if (a === 0 || isTunnel(frames[a - 1])) plugAt(out.plug, frames[a], O, H);
    if (b === frames.length - 1 || isTunnel(frames[b + 1])) plugAt(out.plug, frames[b], O, H);
  }
  for (const [a, b] of runsOf(frames, isTunnel, 0)) {
    ribbon(out.tube, frames, a, b, () => [O, 0], () => [O, H], bare);
    ribbon(out.tube, frames, a, b, () => [O, H], () => [O, 0], bare);
    ribbon(out.tube, frames, a, b, () => [-O, H], () => [-O, 0], bare);
    ribbon(out.tube, frames, a, b, () => [-O, 0], () => [-O, H], bare);
  }
}

/** The level bed track sits on, with a verge where it meets the ground. */
function railFormation(buf: SurfBuf, frames: readonly Frame[], def: RoadTypeDef, slot: number): void {
  const n = frames.length - 1;
  const H = def.halfWidth;
  const bed: SurfStyle = { color: COL.gravel, kind: KIND_GRASS, slot, bias: 0 };
  ribbon(buf, frames, 0, n, () => [-H, -0.02], () => [H, -0.02], bed);
  for (const side of [-1, 1] as const) {
    const inner = () => [side * H, -0.02] as const;
    const outer = (f: Frame) => [side * (H + vergeWidth(f)), (-0.22 * vergeWidth(f)) / 0.9] as const;
    for (const [a, b] of runsOf(frames, (f) => vergeWidth(f) > 0.01)) {
      if (side > 0) ribbon(buf, frames, a, b, inner, outer, bed);
      else ribbon(buf, frames, a, b, outer, inner, bed);
    }
  }
}

/** Mesh one segment into the buffers. Slot indexes the overlay colour table. */
export function buildSegment(net: RoadNetwork, id: Id, slot: number, out: RoadOutputs): void {
  const seg = net.getSegment(id);
  const geom = net.segmentGeom(id);
  if (!seg || !geom || geom.stations.length < 2) return;
  const def = net.roadTypeOf(id);
  const lanes = effectiveLanes(def, seg.overrides);
  const st = geom.stations;
  const s0 = st[0].s;
  const s1 = st[st.length - 1].s;

  const atJunction = (nodeId: Id) => net.nodeGeom(nodeId)?.kind === 'junction';
  const hasMedian = def.median.width > 0 && (def.median.kind === 'grass' || def.median.kind === 'barrier');
  // Noses stand behind the crosswalk and stop line, which sit the same distance back on every arm.
  const noseBack = (nodeId: Id) => medianNoseBack(net, nodeId);
  const startS = atJunction(seg.a) ? s0 + noseBack(seg.a) : s0 - 1;
  const endS = atJunction(seg.b) ? s1 - noseBack(seg.b) : s1 + 1;
  const extras: number[] = [];
  if (hasMedian) {
    const hw = Math.max(def.median.width / 2, 0.6);
    for (const k of [0, 0.15, 0.4, 0.7, 1]) {
      if (atJunction(seg.a)) extras.push(startS + hw * k);
      if (atJunction(seg.b)) extras.push(endS - hw * k);
    }
  }
  // A shaped junction can move the kerb near this road's ends; give the taper cross sections.
  const kerbShift = segmentKerbShift(net, id);
  if (kerbShift) extras.push(...kerbShiftStations(net, id));
  // Stop lines and crosswalks at each end (read from the markings layout, never changed here).
  const rail = def.category === 'rail';
  const endA = rail ? null : armEndLayout(net, id, -1);
  const endB = rail ? null : armEndLayout(net, id, 1);
  const dropAt: ((s: number) => number)[] = [];
  if (def.sidewalk > 0) {
    if (endA?.crosswalk) {
      dropAt.push((s) => dropProfile(s - s0));
      for (const d of [0, DROP_IN, DROP_FLUSH, DROP_OUT]) extras.push(s0 + d);
    }
    if (endB?.crosswalk) {
      dropAt.push((s) => dropProfile(s1 - s));
      for (const d of [0, DROP_IN, DROP_FLUSH, DROP_OUT]) extras.push(s1 - d);
    }
  }
  const ground = groundFn(net);
  let frames = buildFrames(st, extras, ground);
  if (frames.length < 2) return;
  markStructureFrames(net, id, frames);
  // Deck expansion joints over the piers the structures module will place; frames at
  // each joint keep the band sharp.
  let joints: number[] = [];
  if (!rail && frames.some((f) => f.c > 1 || f.viaduct)) {
    joints = planSupports(net, { frames, def, self: id }).piers.map((p) => p.f.s);
    if (joints.length) {
      for (const j of joints) extras.push(j - JOINT_BAND, j, j + JOINT_BAND);
      frames = buildFrames(st, extras, ground);
      if (frames.length < 2) return;
      markStructureFrames(net, id, frames);
    }
  }
  const info: SurfaceInfo = {
    stopA: endA ? endA.cutS + endA.setback : null,
    stopB: endB ? endB.cutS - endB.setback : null,
    drop: (s) => {
      let d = 0;
      for (const fn of dropAt) d = Math.max(d, fn(s));
      return d;
    },
    joints,
  };

  const bias = rankBias(def);
  const main = surfaceColour(seg, def);
  const n = frames.length - 1;
  if (def.category === 'rail') {
    // Track: a gravel formation here, ballast, sleepers and rails come from render/tracks.
    railFormation(out.surf, frames, def, slot);
    deck(out.surf, frames, def, slot);
    cutting(out, frames, def, slot);
    hoodAndTube(out, frames, def, slot);
    addSegmentStructures(net, id, def, frames, out);
    return;
  }
  const kind = seg.overrides.surface === 'concrete' ? KIND_CONCRETE_ROAD : KIND_ASPHALT;
  const H = def.halfWidth;
  laneZones(def, lanes, main).forEach((z, k) => {
    const code = 8 * (k + 1) + z.half;
    const stopS = z.dir > 0 ? info.stopB : z.dir < 0 ? info.stopA : null;
    const hint: HintFn = (b, f, _i, o) => {
      b.hx = code;
      b.hy = Math.max(0, H - Math.abs(o));
      b.hz = stopS === null ? 999 : z.dir > 0 ? stopS - f.s : f.s - stopS;
      b.hw = joints.length ? nearestJoint(joints, f.s) : 999;
    };
    ribbon(out.surf, frames, 0, n, () => [z.a, 0], () => [z.b, 0], { color: z.color, kind, slot, bias }, z.centre, hint);
  });
  if (hasMedian) median(out.surf, frames, def, slot, bias, startS, endS);
  const shaped = kerbShift ? { shift: kerbShift, asphalt: { color: main, kind, slot, bias } } : null;
  roadside(out.surf, frames, def, 1, slot, bias, shaped, info);
  roadside(out.surf, frames, def, -1, slot, bias, shaped, info);
  deck(out.surf, frames, def, slot);
  cutting(out, frames, def, slot);
  hoodAndTube(out, frames, def, slot);
  addSegmentStructures(net, id, def, frames, out);
}
