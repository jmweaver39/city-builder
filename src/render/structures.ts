/** Pillars, barriers and tunnel portals, swept or placed along road frames. */
import type { Id, RoadTypeDef } from '../core/types';
import type { RoadNetwork } from '../core/RoadNetwork';
import { sidewalkOn, totalHalfWidth } from '../core/roadTypes';
import { COL, DECK_DEPTH, ELEVATED_CLEARANCE, KIND_CONCRETE, KIND_PLAIN, KIND_STEEL, TUNNEL_CLEARANCE, TUNNEL_Y, ROAD_LIFT, hexRGB } from './constants';
import type { SurfBuf, SurfStyle } from './batch';
import { isTunnelFrame, type Frame } from './frames';
import { ribbon, runsOf, type RoadOutputs } from './roads';
import { FOOTING, frameAt, planNodeSupport, planSupports, soffitLayout, type PierPlan, type PlannedPier } from './piers';
import { beam, column } from './pierKit';

export type { PierPlan, PlannedPier } from './piers';

/** Pier concrete: clean, the underside of caps a shade darker, and a weathered foot. */
const PIER: SurfStyle = { color: COL.concrete, kind: KIND_CONCRETE, slot: 0, bias: 0 };
const PIER_UNDER: SurfStyle = { color: COL.concreteDark, kind: KIND_CONCRETE, slot: 0, bias: 0 };
const PIER_STAIN: SurfStyle = { color: hexRGB(0x8c887f), kind: KIND_CONCRETE, slot: 0, bias: 0 };
const BEARING: SurfStyle = { color: hexRGB(0x5d6266), kind: KIND_STEEL, slot: 0, bias: 0 };
/** Gap between a cap's top and the deck soffit, where the bearings sit. */
const BEARING_GAP = 0.12;
const COLUMN_SIDES = 18;

/** A tapered column on a footing pad, from the ground up to `top`. */
function addColumn(buf: SurfBuf, x: number, z: number, ax: number, az: number, ground: number, top: number, rc: number, stretch: number, taper = 0.86): void {
  column(buf, { x, z, ax, az, y0: ground - 0.6, y1: top, ground, r0: rc, r1: rc * taper, stretch, sides: COLUMN_SIDES }, PIER, PIER_STAIN);
  // Footing pad, flush with the ground, rounded like the column.
  const pad = rc + FOOTING;
  column(buf, { x, z, ax, az, y0: ground - 0.3, y1: ground + 0.08, ground: ground - 0.3, r0: pad, r1: pad - 0.04, stretch, sides: COLUMN_SIDES, top: true }, PIER_STAIN, PIER_STAIN);
}

/**
 * One planned support in the shared style: tapered round or rounded-rectangle
 * columns with a weathered foot, a hammerhead or portal cap beam with rounded ends
 * (cut back to sit inside the deck where what passes under needs the headroom),
 * and bearings between cap and soffit.
 */
function addSupport(buf: SurfBuf, detail: SurfBuf, p: PlannedPier, def: RoadTypeDef): void {
  const f = p.f;
  const soffit = f.y - DECK_DEPTH;
  const lay = soffitLayout(def);
  const fx = f.rz;
  const fz = -f.rx;
  let colTop = soffit + 0.05;
  if (p.capDepth > 0) {
    const top = soffit - BEARING_GAP;
    const d = p.capDepth;
    const cols = p.columns.map((c) => c.o);
    let depth: (u: number) => number;
    const breaks: number[] = [];
    if (p.kind === 'hammer') {
      // Deep over the column, thinning towards the rounded ends.
      const c = cols[0];
      const core = p.columns[0].rc * 1.15 + p.columns[0].stretch + 0.25;
      const reach = Math.max(0.5, Math.max(c - p.capL, p.capR - c) - core);
      depth = (u) => d * (0.48 + 0.52 * Math.max(0, Math.min(1, 1 - (Math.abs(u - c) - core) / reach)));
      breaks.push(c - core, c + core);
    } else {
      // Even depth with a gentle haunch over each leg.
      depth = (u) => {
        let h = 0;
        for (const c of cols) h = Math.max(h, 1 - Math.abs(u - c) / 2.4);
        return d * (0.88 + 0.12 * Math.max(0, h));
      };
      for (const c of cols) breaks.push(c - 2.4, c, c + 2.4);
    }
    for (let u = Math.ceil(p.capL); u < p.capR; u += 1.5) breaks.push(u);
    beam(buf, { x: f.x, z: f.z, ux: f.rx, uz: f.rz, u0: p.capL, u1: p.capR, thick: p.capThick, top, depth, breaks, endSteps: 5 }, PIER, PIER_UNDER);
    // Bearings under each girder web (or along the trough), on the cap.
    const at = lay.kind === 'box' ? lay.boxes.flatMap((b) => [b.c - b.bottom * 0.7, b.c + b.bottom * 0.7]) : [lay.centre - lay.capHalf * 0.7, lay.centre + lay.capHalf * 0.7];
    for (const o of at) detail.box(f.x + f.rx * o, top + BEARING_GAP / 2, f.z + f.rz * o, 0.32, BEARING_GAP / 2, 0.28, f.rx, f.rz, fx, fz, BEARING);
    colTop = top - depth(0) + 0.05;
    for (const c of p.columns) {
      addColumn(buf, c.x, c.z, f.rx, f.rz, c.ground, top - depth(c.o) + 0.05, c.rc, c.stretch);
    }
    return;
  }
  // Cap built into the deck: a portal still needs its cross beam, inside the deck depth.
  if (p.kind === 'portal') {
    const top = f.y - 0.45;
    const dd = top - soffit;
    beam(buf, { x: f.x, z: f.z, ux: f.rx, uz: f.rz, u0: p.capL, u1: p.capR, thick: p.capThick, top, depth: () => dd, endSteps: 5 }, PIER, PIER_UNDER);
    colTop = soffit + 0.05;
  }
  for (const c of p.columns) addColumn(buf, c.x, c.z, f.rx, f.rz, c.ground, colTop, c.rc, c.stretch);
}

/** The column under an elevated junction, with a flared head under its slab, clear of what is below. */
export function addNodePier(net: RoadNetwork, nodeId: Id, buf: SurfBuf): void {
  const s = planNodeSupport(net, nodeId);
  if (!s) return;
  const head = Math.min(1.1, (s.top - s.ground) * 0.25);
  addColumn(buf, s.x, s.z, 1, 0, s.ground, s.top - head + 0.02, s.rc, 0, 0.9);
  column(buf, { x: s.x, z: s.z, ax: 1, az: 0, y0: s.top - head, y1: s.top + 0.05, ground: s.top - head, r0: s.rc * 0.9, r1: s.rc * 1.7, stretch: 0, sides: COLUMN_SIDES }, PIER, PIER);
}

/** A placed segment's supports (planSupports in piers.ts does the work). */
export function planPiers(net: RoadNetwork, id: Id, def: RoadTypeDef, frames: readonly Frame[]): PierPlan {
  return planSupports(net, { frames, def, self: id });
}

function pillars(net: RoadNetwork, id: Id, def: RoadTypeDef, frames: readonly Frame[], out: RoadOutputs): void {
  const halfWidth = totalHalfWidth(def);
  const plan = planPiers(net, id, def, frames);
  const detail = out.detail ?? out.surf;
  // Expansion joints: a steel strip across the deck over each support.
  const joint: SurfStyle = { color: COL.girder, kind: KIND_STEEL, slot: 0, bias: 0 };
  for (const p of plan.piers) {
    addSupport(out.surf, detail, p, def);
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
  const rail = def.category === 'rail';
  for (const [a, b] of runsOf(frames, (f) => f.c > ELEVATED_CLEARANCE, 1)) {
    for (const side of [1, -1] as const) {
      const W = sidewalkOn(def, side);
      if (rail) {
        // The trough's own walls, with a rounded top and a thin railing along it.
        troughWall(out.surf, frames, a, b, side, def.halfWidth, PIER);
        railing(out.surf, out.detail ?? out.surf, frames, a, b, side * (def.halfWidth - 0.16), TROUGH_WALL + 0.02);
        continue;
      }
      barrierStrip(out.surf, frames, a, b, side, () => def.halfWidth + W - 0.3, W > 0 ? 0.15 : 0, style);
      // Where people walk, a thin handrail rides on the barrier.
      if (W > 0) railing(out.surf, out.detail ?? out.surf, frames, a, b, side * (def.halfWidth + W - 0.18), 0.15 + 0.95);
    }
  }
}

/** Height of a rail trough's walls over the track bed. */
const TROUGH_WALL = 1.05;

/** One wall of a rail trough at offset H: inner face, rounded top, outer face down to the deck side. */
function troughWall(buf: SurfBuf, frames: readonly Frame[], a: number, b: number, side: -1 | 1, H: number, style: SurfStyle): void {
  const t = 0.32;
  const r = 0.12;
  const h = TROUGH_WALL;
  // Clockwise for the right wall (up the inner face, over the top, down the outside).
  const pts: [number, number][] = [[H - t, -0.02], [H - t, h - r]];
  for (let k = 1; k <= 3; k++) {
    const q = Math.PI - (k / 3) * (Math.PI / 2);
    pts.push([H - t + r + Math.cos(q) * r, h - r + Math.sin(q) * r]);
  }
  for (let k = 0; k <= 3; k++) {
    const q = Math.PI / 2 - (k / 3) * (Math.PI / 2);
    pts.push([H - r + Math.cos(q) * r, h - r + Math.sin(q) * r]);
  }
  // Down to the bed; the deck side carries on below it.
  pts.push([H, 0]);
  const path = side > 0 ? pts : pts.map(([o, y]) => [-o, y] as [number, number]).reverse();
  for (let k = 0; k + 1 < path.length; k++) {
    const p = path[k];
    const q = path[k + 1];
    ribbon(buf, frames, a, b, () => p, () => q, style);
  }
}

/** A thin steel railing: a top rail swept along, and posts in the detail buffer. */
function railing(buf: SurfBuf, detail: SurfBuf, frames: readonly Frame[], a: number, b: number, offset: number, base: number): void {
  const steel: SurfStyle = { color: COL.steel, kind: KIND_STEEL, slot: 0, bias: 0 };
  const top = base + 0.62;
  const w = 0.035;
  // A small square tube, faces listed clockwise.
  const sq: [number, number][] = [[offset - w, top - w], [offset - w, top + w], [offset + w, top + w], [offset + w, top - w], [offset - w, top - w]];
  for (let k = 0; k + 1 < sq.length; k++) {
    const p = sq[k];
    const q = sq[k + 1];
    ribbon(buf, frames, a, b, () => p, () => q, steel);
  }
  const mid: [number, number][] = [[offset - 0.02, base + 0.3], [offset - 0.02, base + 0.34], [offset + 0.02, base + 0.34], [offset + 0.02, base + 0.3], [offset - 0.02, base + 0.3]];
  for (let k = 0; k + 1 < mid.length; k++) {
    const p = mid[k];
    const q = mid[k + 1];
    ribbon(detail, frames, a, b, () => p, () => q, steel);
  }
  for (let k = Math.ceil(frames[a].s / 2); k * 2 < frames[b].s; k++) {
    const f = frameAt(frames, k * 2);
    if (!f) continue;
    detail.box(f.x + f.rx * offset, f.y + base + 0.31, f.z + f.rz * offset, 0.025, 0.31, 0.025, f.rx, f.rz, f.rz, -f.rx, steel);
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
