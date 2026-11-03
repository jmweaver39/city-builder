/** Pillars, barriers and tunnel portals, swept or placed along road frames. */
import type { Id, RoadTypeDef } from '../core/types';
import type { RoadNetwork } from '../core/RoadNetwork';
import { closestPointOnCubic } from '../core/bezier';
import { sidewalkOn, totalHalfWidth } from '../core/roadTypes';
import { terrainHeight } from '../core/terrain';
import { COL, DECK_DEPTH, ELEVATED_CLEARANCE, KIND_CONCRETE, KIND_PLAIN, KIND_STEEL, TUNNEL_CLEARANCE, TUNNEL_Y, ROAD_LIFT } from './constants';
import type { SurfBuf, SurfStyle } from './batch';
import { isTunnelFrame, type Frame } from './frames';
import { ribbon, runsOf, type RoadOutputs } from './roads';
import { belowDeck, columnClear } from './piers';

const PILLAR_SPACING = 34;
/** Below this clearance a span needs no pier. */
const MIN_PIER_CLEARANCE = 3.2;

function frameAt(frames: readonly Frame[], s: number): Frame | null {
  if (s < frames[0].s || s > frames[frames.length - 1].s) return null;
  for (let i = 0; i + 1 < frames.length; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    if (s > b.s) continue;
    const f = (s - a.s) / Math.max(b.s - a.s, 1e-6);
    const x = a.x + (b.x - a.x) * f;
    const y = a.y + (b.y - a.y) * f;
    const z = a.z + (b.z - a.z) * f;
    const rx = a.rx + (b.rx - a.rx) * f;
    const rz = a.rz + (b.rz - a.rz) * f;
    const rl = Math.hypot(rx, rz) || 1;
    // The frames' own ground, which knows about embankments and cuts.
    const ground = a.ground + (b.ground - a.ground) * f;
    return { ...a, x, y, z, rx: rx / rl, rz: rz / rl, s, ground, c: y - ROAD_LIFT - ground };
  }
  return null;
}

/** True when a column at this spot would stand in another road. */
function hitsLowerRoad(net: RoadNetwork, selfId: Id, x: number, z: number, y: number, radius: number): boolean {
  const r = 26;
  const near = net.segmentsInRegion({ minX: x - r, minZ: z - r, maxX: x + r, maxZ: z + r }, true);
  for (const id of near) {
    if (id === selfId) continue;
    const seg = net.getSegment(id);
    if (!seg) continue;
    const hit = closestPointOnCubic(net.cubicOf(id), { x, y: 0, z });
    const dx = hit.point.x - x;
    const dz = hit.point.z - z;
    const reach = totalHalfWidth(net.roadTypeOf(id)) + radius + 0.6;
    if (dx * dx + dz * dz < reach * reach && hit.point.y < y - 2) return true;
  }
  return false;
}

/** One bridge pier: footing, column or columns, a flared cap and bearings. */
function addPier(buf: SurfBuf, f: Frame, halfWidth: number, style: SurfStyle): void {
  const fx = f.rz;
  const fz = -f.rx;
  const top = f.y - DECK_DEPTH;
  const capH = 1.1;
  const base = f.ground - 1;
  const capHalf = Math.max(1.8, halfWidth * 0.86);
  const dark: SurfStyle = { ...style, color: COL.concreteDark };
  buf.taperBeam(f.x, top - capH, top, f.z, capHalf, capHalf * 0.42, 0.95, f.rx, f.rz, fx, fz, style);
  const count = Math.max(2, Math.round((halfWidth * 2) / 3.4));
  for (let g = 0; g < count; g++) {
    const o = -halfWidth * 0.8 + (halfWidth * 1.6 * g) / (count - 1);
    buf.box(f.x + f.rx * o, top + 0.04, f.z + f.rz * o, 0.32, 0.05, 0.3, f.rx, f.rz, fx, fz, dark);
  }
  const col = (x: number, z: number, r: number) => {
    buf.prism(x, z, base, top - capH + 0.05, r, 12, style);
    buf.prism(x, z, top - capH - 0.5, top - capH + 0.05, r * 1.16, 12, style);
    const g = terrainHeight(x, z);
    buf.box(x, g + 0.1, z, r * 1.7, 0.3, r * 1.7, f.rx, f.rz, fx, fz, dark);
  };
  if (halfWidth > 13) {
    const off = halfWidth * 0.46;
    col(f.x + f.rx * off, f.z + f.rz * off, 1.05);
    col(f.x - f.rx * off, f.z - f.rz * off, 1.05);
  } else {
    col(f.x, f.z, Math.min(1.5, 0.8 + halfWidth * 0.07));
  }
}

export function addPierAt(buf: SurfBuf, x: number, y: number, z: number, radius: number, style: SurfStyle): void {
  buf.prism(x, z, terrainHeight(x, z) - 1, y - DECK_DEPTH + 0.1, radius, 12, style);
}

/** Columns of a pier at frame f, as addPier places them. */
function pierColumns(f: Frame, halfWidth: number): { x: number; z: number; r: number }[] {
  if (halfWidth > 13) {
    const off = halfWidth * 0.46;
    return [
      { x: f.x + f.rx * off, z: f.z + f.rz * off, r: 1.05 * 1.7 },
      { x: f.x - f.rx * off, z: f.z - f.rz * off, r: 1.05 * 1.7 },
    ];
  }
  const r = Math.min(1.5, 0.8 + halfWidth * 0.07);
  return [{ x: f.x, z: f.z, r: r * 1.7 }];
}

/** A portal frame: two legs outside the deck edges and a cross beam, straddling what is below. */
function addPortal(buf: SurfBuf, f: Frame, halfWidth: number, legOff: number, style: SurfStyle): void {
  const fx = f.rz;
  const fz = -f.rx;
  const top = f.y - DECK_DEPTH;
  for (const side of [-1, 1]) {
    const x = f.x + f.rx * side * legOff;
    const z = f.z + f.rz * side * legOff;
    buf.prism(x, z, terrainHeight(x, z) - 1, top - 1.2, 0.9, 12, style);
  }
  buf.box(f.x, top - 0.6, f.z, legOff + 0.9, 0.6, 1.0, f.rx, f.rz, fx, fz, style, { bottom: true });
  void halfWidth;
}

export interface PierPlan {
  piers: { f: Frame; kind: 'pier' | 'portal'; columns: { x: number; z: number; r: number }[]; legOff: number }[];
  /** Spans with nowhere to stand, carried by steel girders: [from s, to s]. */
  girders: [number, number][];
}

/**
 * Where a deck's supports go: regular spacing, shifted along the span to miss
 * whatever is below, a portal frame straddling it where a pier cannot stand, and
 * a long girder span where neither fits.
 */
export function planPiers(net: RoadNetwork, id: Id, def: RoadTypeDef, frames: readonly Frame[]): PierPlan {
  const halfWidth = totalHalfWidth(def);
  // Rail viaducts have regular, shorter spans than road bridges.
  const spacing = def.category === 'rail' ? 30 : PILLAR_SPACING;
  const s0 = frames[0].s;
  const s1 = frames[frames.length - 1].s;
  const plan: PierPlan = { piers: [], girders: [] };
  const missed: number[] = [];
  for (let k = Math.ceil((s0 + 4) / spacing); k * spacing < s1 - 4; k++) {
    const home = k * spacing;
    let done = false;
    for (const nudge of [0, 4, -4, 8, -8, 12, -12, 16, -16]) {
      const f = frameAt(frames, home + nudge);
      if (!f || f.c < (f.viaduct ? 1.4 : MIN_PIER_CLEARANCE)) continue;
      const below = belowDeck(net, id, { minX: f.x - halfWidth - 3, minZ: f.z - halfWidth - 3, maxX: f.x + halfWidth + 3, maxZ: f.z + halfWidth + 3 }, f.y);
      const columns = pierColumns(f, halfWidth);
      if (columns.every((c) => columnClear(below, c.x, c.z, c.r))) {
        plan.piers.push({ f, kind: 'pier', columns, legOff: 0 });
        done = true;
        break;
      }
      // Straddle it: legs outside the deck edges.
      const legOff = halfWidth + 1.4;
      const legs = [-1, 1].map((side) => ({ x: f.x + f.rx * side * legOff, z: f.z + f.rz * side * legOff, r: 1.4 }));
      if (legs.every((l) => columnClear(below, l.x, l.z, l.r))) {
        plan.piers.push({ f, kind: 'portal', columns: legs, legOff });
        done = true;
        break;
      }
    }
    if (!done) {
      const f = frameAt(frames, home);
      if (f && f.c >= MIN_PIER_CLEARANCE) missed.push(home);
    }
  }
  const stops = [s0, ...plan.piers.map((p) => p.f.s), s1].sort((a, b) => a - b);
  for (let i = 0; i + 1 < stops.length; i++) {
    if (missed.some((m) => m > stops[i] && m < stops[i + 1])) plan.girders.push([stops[i], stops[i + 1]]);
  }
  return plan;
}

function pillars(net: RoadNetwork, id: Id, def: RoadTypeDef, frames: readonly Frame[], out: RoadOutputs): void {
  const style: SurfStyle = { color: COL.concrete, kind: KIND_CONCRETE, slot: 0, bias: 0 };
  const halfWidth = totalHalfWidth(def);
  const plan = planPiers(net, id, def, frames);
  // Expansion joints: a steel strip across the deck over each support.
  const joint: SurfStyle = { color: COL.girder, kind: KIND_STEEL, slot: 0, bias: 0 };
  for (const p of plan.piers) {
    if (p.kind === 'pier') addPier(out.surf, p.f, halfWidth, style);
    else addPortal(out.surf, p.f, halfWidth, p.legOff, style);
    if (def.category !== 'rail') out.surf.box(p.f.x, p.f.y + 0.012, p.f.z, def.halfWidth, 0.012, 0.11, p.f.rx, p.f.rz, p.f.rz, -p.f.rx, joint);
  }
  // Nowhere to stand: a longer steel girder span carries the deck over, edge girders below it.
  const steel: SurfStyle = { color: COL.steel, kind: KIND_STEEL, slot: 0, bias: 0 };
  for (const [a, b] of plan.girders) {
    const i0 = frames.findIndex((f) => f.s >= a);
    let i1 = frames.length - 1;
    while (i1 > 0 && frames[i1].s > b) i1--;
    if (i0 < 0 || i1 <= i0) continue;
    const depth = Math.min(3, 1.2 + (b - a) / 40);
    for (const side of [-1, 1] as const) {
      const o = side * (halfWidth - 0.6);
      const bottom = (f: Frame) => -DECK_DEPTH - depth * Math.max(0.35, Math.sin(Math.PI * Math.min(1, Math.max(0, (f.s - a) / (b - a)))));
      if (side > 0) ribbon(out.surf, frames, i0, i1, () => [o, -DECK_DEPTH], (f) => [o, bottom(f)], steel);
      else ribbon(out.surf, frames, i0, i1, (f) => [o, bottom(f)], () => [o, -DECK_DEPTH], steel);
    }
  }
}

/**
 * Safety barrier strip along a run of frames. offset is measured from the
 * centreline to the barrier's inner foot, on `side`.
 */
export function barrierStrip(
  buf: SurfBuf,
  frames: readonly Frame[],
  a: number,
  b: number,
  side: -1 | 1,
  offset: (f: Frame) => number,
  base: number,
  style: SurfStyle,
): void {
  // Concrete F-shape: a steep foot, a kick, then a near-vertical face.
  const h = 0.95;
  const foot = 0.08;
  const kick = 0.26;
  const crown = 0.09;
  const wide = 0.3;
  const o = (f: Frame, x: number) => side * (offset(f) + x);
  const face: [number, number, number, number][] = [
    [-0.16, 0, -0.14, foot],
    [-0.14, foot, -0.02, kick],
    [-0.02, kick, crown - 0.02, h],
  ];
  for (const [x0, y0, x1, y1] of face) {
    if (side > 0) ribbon(buf, frames, a, b, (f) => [o(f, x0), base + y0], (f) => [o(f, x1), base + y1], style);
    else ribbon(buf, frames, a, b, (f) => [o(f, x1), base + y1], (f) => [o(f, x0), base + y0], style);
  }
  if (side > 0) {
    ribbon(buf, frames, a, b, (f) => [o(f, crown - 0.02), base + h], (f) => [o(f, wide), base + h], style);
    ribbon(buf, frames, a, b, (f) => [o(f, wide), base + h], (f) => [o(f, wide), base - 0.1], style);
  } else {
    ribbon(buf, frames, a, b, (f) => [o(f, wide), base + h], (f) => [o(f, crown - 0.02), base + h], style);
    ribbon(buf, frames, a, b, (f) => [o(f, wide), base - 0.1], (f) => [o(f, wide), base + h], style);
  }
}

/** W-beam rail on posts, along fast roads at ground level. */
function guardRails(def: RoadTypeDef, frames: readonly Frame[], out: RoadOutputs, plain: { a: boolean; b: boolean }): void {
  if (def.category !== 'highway' && def.category !== 'ramp') return;
  const steel: SurfStyle = { color: COL.steel, kind: KIND_STEEL, slot: 0, bias: 0 };
  const H = def.halfWidth + 0.62;
  const buf = out.surf;
  const atGrade = (f: Frame) => f.c > -0.04 && f.c <= ELEVATED_CLEARANCE && f.y - ROAD_LIFT > -0.3;
  for (const [a, b] of runsOf(frames, atGrade, 0)) {
    // The rail tapers into the ground where it ends, but runs on through a plain
    // joint into the next piece of the same road (core/curveChain.ts) without a break.
    const openA = plain.a && a === 0;
    const openB = plain.b && b === frames.length - 1;
    for (const side of [1, -1] as const) {
      const ramp = (f: Frame) =>
        Math.min(1, Math.min(openA ? Infinity : f.s - frames[a].s, openB ? Infinity : frames[b].s - f.s) / 5);
      const y = (f: Frame, h: number) => (h * ramp(f)) - 0.1 * (1 - ramp(f)) + vergeDrop(f);
      const strip = (h0: number, h1: number, out0: number, out1: number) => {
        if (side > 0) ribbon(buf, frames, a, b, (f) => [H + out1, y(f, h1)], (f) => [H + out0, y(f, h0)], steel);
        else ribbon(buf, frames, a, b, (f) => [-H - out0, y(f, h0)], (f) => [-H - out1, y(f, h1)], steel);
      };
      // Three ribs of the W, seen from the road side.
      strip(0.48, 0.56, 0, 0.05);
      strip(0.56, 0.64, 0.05, 0);
      strip(0.64, 0.72, 0, 0.05);
      for (let k = Math.ceil(frames[a].s / 3.8); k * 3.8 < frames[b].s; k++) {
        const f = frameAt(frames, k * 3.8);
        if (!f) continue;
        const px = f.x + f.rx * side * (H + 0.11);
        const pz = f.z + f.rz * side * (H + 0.11);
        buf.box(px, f.y + 0.26, pz, 0.05, 0.42, 0.07, f.rx, f.rz, f.rz, -f.rx, steel);
      }
    }
  }
}

/** Ground sits this far under the road surface along the verge. */
function vergeDrop(f: Frame): number {
  return -0.1 * Math.max(0, 1 - Math.abs(f.c) / 0.6);
}

function barriers(def: RoadTypeDef, frames: readonly Frame[], out: RoadOutputs): void {
  const style: SurfStyle = { color: COL.barrier, kind: KIND_PLAIN, slot: 0, bias: 0 };
  for (const [a, b] of runsOf(frames, (f) => f.c > ELEVATED_CLEARANCE, 1)) {
    for (const side of [1, -1] as const) {
      const W = sidewalkOn(def, side);
      barrierStrip(out.surf, frames, a, b, side, () => def.halfWidth + W - 0.3, W > 0 ? 0.15 : 0, style);
    }
  }
}

function portal(buf: SurfBuf, a: Frame, b: Frame, def: RoadTypeDef): void {
  // a is on the open side, b in the tunnel. Interpolate to the crossing itself.
  const ya = a.y - ROAD_LIFT;
  const yb = b.y - ROAD_LIFT;
  const k = b.covered && !a.covered ? 0.5 : Math.min(1, Math.max(0, (ya - TUNNEL_Y) / (ya - yb || 1)));
  const x = a.x + (b.x - a.x) * k;
  const z = a.z + (b.z - a.z) * k;
  const y = a.y + (b.y - a.y) * k;
  const O = def.halfWidth + def.sidewalk + 0.1;
  const fx = b.x - a.x;
  const fz = b.z - a.z;
  const l = Math.hypot(fx, fz) || 1;
  const dx = fx / l;
  const dz = fz / l;
  const style: SurfStyle = { color: COL.concrete, kind: KIND_CONCRETE, slot: 0, bias: 0 };
  const dark: SurfStyle = { color: COL.concreteDark, kind: KIND_CONCRETE, slot: 0, bias: 0 };
  const rx = -dz;
  const rz = dx;
  const H = TUNNEL_CLEARANCE;
  const post = 0.7;
  const depth = 0.9;
  const px = x - dx * depth;
  const pz = z - dz * depth;
  const mid = H / 2 + 0.2;
  buf.box(px + rx * (O + post), y + mid, pz + rz * (O + post), post, mid + 0.4, depth, rx, rz, dx, dz, style);
  buf.box(px - rx * (O + post), y + mid, pz - rz * (O + post), post, mid + 0.4, depth, rx, rz, dx, dz, style);
  buf.box(px, y + H + 0.55, pz, O + post * 2, 0.6, depth, rx, rz, dx, dz, style, { bottom: true });
  // A brow over the opening reads as a portal from the air.
  buf.box(px - dx * (depth + 0.15), y + H + 1.25, pz - dz * (depth + 0.15), O + post * 2 + 0.3, 0.14, 0.3, rx, rz, dx, dz, dark);
}

function portals(def: RoadTypeDef, frames: readonly Frame[], out: RoadOutputs): void {
  const under = isTunnelFrame;
  for (let i = 0; i + 1 < frames.length; i++) {
    const p = frames[i];
    const q = frames[i + 1];
    if (under(p) === under(q)) continue;
    if (under(q)) portal(out.surf, p, q, def);
    else portal(out.surf, q, p, def);
  }
}

export function addSegmentStructures(net: RoadNetwork, id: Id, def: RoadTypeDef, frames: readonly Frame[], out: RoadOutputs): void {
  pillars(net, id, def, frames, out);
  barriers(def, frames, out);
  const seg = net.getSegment(id);
  const plainAt = (node: Id | undefined) => node !== undefined && net.nodeGeom(node)?.kind === 'plain';
  guardRails(def, frames, out, { a: plainAt(seg?.a), b: plainAt(seg?.b) });
  portals(def, frames, out);
}
