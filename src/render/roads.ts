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
import { buildFrames, type Frame } from './frames';
import { addSegmentStructures } from './structures';

export interface RoadOutputs {
  surf: SurfBuf;
  /** Visible only in the underground view. */
  tube: SurfBuf;
  /** Visible only in the normal view: caps that stop you seeing out of a tunnel. */
  plug: SurfBuf;
  hole: HoleBuf;
}

type Prof = (f: Frame, i: number) => readonly [number, number];

const LAMP_TINT = hexRGB(0xffe2b0);

/** Sweep two profile points along frames i0..i1 as one smooth strip. */
export function ribbon(buf: SurfBuf, frames: readonly Frame[], i0: number, i1: number, left: Prof, right: Prof, style: SurfStyle, centre: number | null = null): void {
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
    buf.vert(lx, ly, lz, nx, ny, nz, style);
    buf.ru = centre === null ? or : or - centre;
    buf.vert(rx, ry, rz, nx, ny, nz, style);
  }
  buf.ru = 0;
  buf.rv = 0;
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

export function surfaceColour(seg: Segment | undefined): RGB {
  return seg?.overrides.surface ? SURFACE_COL[seg.overrides.surface] : COL.asphalt;
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
}

function laneZones(def: RoadTypeDef, lanes: readonly LaneDef[], main: RGB): Zone[] {
  const H = def.halfWidth;
  const shoulder = lerpRGB(main, COL.shoulder, 0.6);
  const zones: Zone[] = [];
  const push = (a: number, b: number, color: RGB, centre = -1000) => {
    if (b - a < 0.01) return;
    zones.push({ a, b, color, centre });
  };
  let x = -H;
  for (const lane of lanes) {
    const lo = lane.offset - lane.width / 2;
    const hi = lane.offset + lane.width / 2;
    push(x, lo, x === -H ? shoulder : main);
    const c = lane.kind === 'bus' ? COL.busLane : lane.kind === 'bike' ? COL.bikeLane : main;
    push(lo, hi, c, lane.kind === 'bike' ? -1000 : lane.offset);
    x = hi;
  }
  push(x, H, shoulder);
  return zones;
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
function roadside(buf: SurfBuf, frames: readonly Frame[], def: RoadTypeDef, side: -1 | 1, slot: number, bias: number): void {
  const H = def.halfWidth;
  const W = sidewalkOn(def, side);
  const n = frames.length - 1;
  const swap = (p: Prof, q: Prof): [Prof, Prof] => (side > 0 ? [p, q] : [q, p]);
  if (W > 0) {
    const kerb: SurfStyle = { color: COL.kerb, kind: KIND_PLAIN, slot, bias };
    const walk: SurfStyle = { color: COL.sidewalk, kind: KIND_SIDEWALK, slot, bias };
    // Kerb face looks at the road.
    if (side > 0) ribbon(buf, frames, 0, n, () => [H, 0], () => [H, KERB_HEIGHT], kerb);
    else ribbon(buf, frames, 0, n, () => [-H, KERB_HEIGHT], () => [-H, 0], kerb);
    const [l, r] = swap(
      () => [side * H, KERB_HEIGHT],
      () => [side * (H + W), KERB_HEIGHT],
    );
    ribbon(buf, frames, 0, n, l, r, walk);
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
  const under: SurfStyle = { color: COL.concreteDark, kind: KIND_CONCRETE, slot, bias: 0 };
  const raised = (f: Frame) => f.c > 0.08;
  const showWall = def.sidewalk > 0 ? (f: Frame) => f.c > -0.05 : raised;
  for (const [a, b] of runsOf(frames, showWall)) {
    ribbon(buf, frames, a, b, (f) => [outerOffset(def, f, 1), outerHeight(def, f, 1)], (f) => [outerOffset(def, f, 1), deckBottom(f)], side);
    ribbon(buf, frames, a, b, (f) => [-outerOffset(def, f, -1), deckBottom(f)], (f) => [-outerOffset(def, f, -1), outerHeight(def, f, -1)], side);
  }
  for (const [a, b] of runsOf(frames, raised)) {
    ribbon(buf, frames, a, b, (f) => [outerOffset(def, f, 1), deckBottom(f)], (f) => [-outerOffset(def, f, -1), deckBottom(f)], under);
  }
}

function isOpenCut(f: Frame): boolean {
  return f.c < -0.03 && f.y - ROAD_LIFT > TUNNEL_Y;
}

function isTunnel(f: Frame): boolean {
  return f.y - ROAD_LIFT <= TUNNEL_Y;
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
  const noseBack = 2.4;
  const startS = atJunction(seg.a) ? s0 + noseBack : s0 - 1;
  const endS = atJunction(seg.b) ? s1 - noseBack : s1 + 1;
  const extras: number[] = [];
  if (hasMedian) {
    const hw = Math.max(def.median.width / 2, 0.6);
    for (const k of [0, 0.15, 0.4, 0.7, 1]) {
      if (atJunction(seg.a)) extras.push(startS + hw * k);
      if (atJunction(seg.b)) extras.push(endS - hw * k);
    }
  }
  const frames = buildFrames(st, extras);
  if (frames.length < 2) return;

  const bias = rankBias(def);
  const main = surfaceColour(seg);
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
  for (const z of laneZones(def, lanes, main)) {
    ribbon(out.surf, frames, 0, n, () => [z.a, 0], () => [z.b, 0], { color: z.color, kind: KIND_ASPHALT, slot, bias }, z.centre);
  }
  if (hasMedian) median(out.surf, frames, def, slot, bias, startS, endS);
  roadside(out.surf, frames, def, 1, slot, bias);
  roadside(out.surf, frames, def, -1, slot, bias);
  deck(out.surf, frames, def, slot);
  cutting(out, frames, def, slot);
  hoodAndTube(out, frames, def, slot);
  addSegmentStructures(net, id, def, frames, out);
}
