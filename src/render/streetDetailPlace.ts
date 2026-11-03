/**
 * Where close-up street detail goes. Pure TS (no Three.js), so placement can be
 * tested headlessly. Everything comes from a seeded hash of the segment, node, lot
 * or ground cell it belongs to, so props never jump when the view moves or the map
 * reloads, and an edit regenerates only the sources it touches.
 *
 * Placement follows context: furniture stands in the kerb-side band of town
 * sidewalks (what kind depends on the lots behind it), yard things inside lots,
 * highway furniture on highway verges, field things well out in the country, and
 * road things (manholes, drains, tyre marks, paint) on the road itself. Nothing
 * stands on a carriageway, track, water or a crosswalk.
 */
import { closestPointOnCubic, lengthAtT } from '../core/bezier';
import { segmentKerbShift } from '../core/junctionShape';
import type { RoadNetwork } from '../core/RoadNetwork';
import { effectiveLanes, sidewalkOn } from '../core/roadTypes';
import { groundFn } from '../core/terrainMods';
import { isInsideMap, isWater, terrainHeight } from '../core/terrain';
import type { Id, ZoneKind } from '../core/types';
import { footprintAt } from '../peds/footprint';
import { crosswalkOn, CROSSWALK_BACK, KERB_HEIGHT, ROAD_LIFT } from '../peds/graph';
import { busStopsOn, collectLots, hash32, LotIndex, rngFrom, stationPoint, walkableDef, type Lot } from '../peds/places';

// Prop types. Each has one model in streetDetail.ts.
export const P_BIN = 0;
export const P_BENCH = 1;
export const P_HYDRANT = 2;
export const P_MAILBOX = 3;
export const P_BIKE_RACK = 4;
export const P_PLANTER = 5;
export const P_BOLLARD = 6;
export const P_TREE = 7;
export const P_LITTER = 8;
export const P_LEAVES = 9;
export const P_DUMPSTER = 10;
export const P_PALLET = 11;
export const P_CAFE = 12;
export const P_SHOP_SIGN = 13;
export const P_WHEELIE_BIN = 14;
export const P_GARDEN_SET = 15;
export const P_SWING = 16;
export const P_CAR = 17;
export const P_CRATE = 18;
export const P_CONTAINER = 19;
export const P_PUDDLE = 20;
export const P_SOS_PHONE = 21;
export const P_KM_POST = 22;
export const P_DEBRIS = 23;
export const P_TYRE_MARK = 24;
export const P_FENCE = 25;
export const P_GATE = 26;
export const P_HAY_BALE = 27;
export const P_COW = 28;
export const P_SHEEP = 29;
export const P_ROCK = 30;
export const P_FLOWERS = 31;
export const P_MANHOLE = 32;
export const P_DRAIN = 33;
export const P_UTILITY_MARK = 34;
export const P_SHELTER = 35;
export const P_BUS_SIGN = 36;
export const P_DRIVEWAY = 37;
export const PROP_TYPES = 38;

/** Footprint radius of each type at scale 1, metres. */
export const PROP_RADIUS: readonly number[] = [
  0.3, 0.9, 0.2, 0.25, 1.0, 0.6, 0.12, 0.6, 0.2, 0.35, 1.1, 0.6, 1.0, 0.35, 0.35, 0.9, 1.3, 2.3, 0.5, 3.1, 1.2, 0.3, 0.08, 0.3, 0.3, 0.1, 0.1, 0.7, 1.1, 0.6, 0.6, 0.5, 0.35,
  0.3, 0.3, 1.5, 0.1, 2.6,
];

/** Paint and fittings that belong on the road surface itself. */
export const ROAD_DECALS: ReadonlySet<number> = new Set([P_MANHOLE, P_DRAIN, P_UTILITY_MARK, P_TYRE_MARK]);
/** Things that lie on a highway shoulder (paved, but never in a lane). */
export const ON_SHOULDER: ReadonlySet<number> = new Set([P_DEBRIS]);

export interface Prop {
  type: number;
  x: number;
  y: number;
  z: number;
  /** Radians about +Y; the model's +Z points to (sin yaw, cos yaw), away from the road. */
  yaw: number;
  /** Uniform scale, and an extra stretch along the model's x (fences, marks). */
  s: number;
  l: number;
  /** Colour variant, 0..15. */
  c: number;
}

export interface PlaceContext {
  net: RoadNetwork;
  lots: LotIndex;
  /** 0..~1.3, from the quality level. */
  density: number;
  seed: number;
  ground: (x: number, z: number) => number;
}

export function makeContext(net: RoadNetwork, density = 1, seed = 1): PlaceContext {
  return { net, lots: new LotIndex(collectLots(net)), density, seed, ground: groundFn(net) };
}

/** Yaw that turns a model's +Z toward (fx, fz). */
export const yawToward = (fx: number, fz: number): number => Math.atan2(fx, fz);

function push(out: Prop[], type: number, x: number, y: number, z: number, yaw: number, s = 1, c = 0, l = 1): void {
  out.push({ type, x, y, z, yaw, s, l, c });
}

/** Clear of carriageways, track, water and junction surfaces, with the prop's own radius. */
function clear(ctx: PlaceContext, x: number, y: number, z: number, r: number): boolean {
  return !footprintAt(ctx.net, x, y, z, { radius: r });
}

// ---------------------------------------------------------------------------
// Segments: sidewalk furniture, road fittings, highway verges
// ---------------------------------------------------------------------------

const FAST = new Set(['highway', 'ramp']);

export function segmentProps(ctx: PlaceContext, segId: Id): Prop[] {
  const net = ctx.net;
  const seg = net.getSegment(segId);
  const geom = net.segmentGeom(segId);
  const out: Prop[] = [];
  if (!seg || !geom || geom.stations.length < 2 || geom.length < 4) return out;
  const def = net.roadTypeOf(segId);
  if (def.category === 'rail') return out;
  const st = geom.stations;
  const s0 = st[0].s;
  const s1 = st[st.length - 1].s;
  const rnd = rngFrom(hash32(ctx.seed, segId, 11));
  const k = ctx.density;
  const level = (s: number) => {
    const p = stationPoint(st, s);
    const ground = terrainHeight(p.x, p.z);
    return { p, bridge: p.y - ground > 1, tunnel: p.y < ground - 1.5 };
  };
  if (FAST.has(def.category)) {
    highwayProps(ctx, segId, out, rnd);
    return out;
  }
  // Road fittings: manholes in lanes, drains at kerbs, now and then a utility mark.
  const lanes = effectiveLanes(def, seg.overrides).filter((l) => l.kind === 'drive' || l.kind === 'bus');
  const roadY = (y: number) => y + ROAD_LIFT + 0.014;
  for (let s = s0 + 12 + rnd() * 20; s < s1 - 12; s += 38 + rnd() * 30) {
    const { p, tunnel } = level(s);
    if (tunnel || !lanes.length) continue;
    const lane = lanes[Math.floor(rnd() * lanes.length)];
    const o = lane.offset + (rnd() - 0.5) * 0.6;
    push(out, P_MANHOLE, p.x + p.rx * o, roadY(p.y), p.z + p.rz * o, rnd() * 6.28, 1, 0);
  }
  for (const side of [1, -1] as const) {
    if (sidewalkOn(def, side) <= 0) continue;
    for (let s = s0 + 6 + rnd() * 10; s < s1 - 6; s += 26 + rnd() * 14) {
      const { p, tunnel } = level(s);
      if (tunnel) continue;
      const o = side * (def.halfWidth - 0.32);
      push(out, P_DRAIN, p.x + p.rx * o, roadY(p.y), p.z + p.rz * o, yawToward(p.rx * side, p.rz * side), 1, 0);
    }
  }
  if (rnd() < 0.22 * k) {
    const s = s0 + (s1 - s0) * (0.2 + rnd() * 0.6);
    const { p, tunnel } = level(s);
    const side = rnd() < 0.5 ? 1 : -1;
    const o = side * (def.halfWidth - 0.6 - rnd() * 0.8);
    if (!tunnel) push(out, P_UTILITY_MARK, p.x + p.rx * o, roadY(p.y), p.z + p.rz * o, yawToward(p.tx, p.tz), 0.8 + rnd() * 0.6, Math.floor(rnd() * 4), 1 + rnd() * 2);
  }
  // Sidewalk furniture, if this is a road people walk along.
  if (walkableDef(def)) for (const side of [1, -1] as const) sidewalkProps(ctx, segId, side, out);
  return out;
}

function sidewalkProps(ctx: PlaceContext, segId: Id, side: 1 | -1, out: Prop[]): void {
  const net = ctx.net;
  const seg = net.getSegment(segId)!;
  const geom = net.segmentGeom(segId)!;
  const def = net.roadTypeOf(segId);
  const W = sidewalkOn(def, side);
  if (W < 1.2) return;
  const st = geom.stations;
  const s0 = st[0].s;
  const s1 = st[st.length - 1].s;
  const shift = segmentKerbShift(net, segId);
  const rnd = rngFrom(hash32(ctx.seed, segId, side, 23));
  const k = ctx.density;
  // Ends at a junction or dead end keep clear: crosswalks, corners and kerb ramps.
  const endClear = (nodeId: Id) => {
    const g = net.nodeGeom(nodeId);
    if (!g || g.kind === 'plain') return 1;
    return g.kind === 'junction' && crosswalkOn(net, nodeId, segId) ? CROSSWALK_BACK + 5 : 6;
  };
  const lo = s0 + endClear(seg.a);
  const hi = s1 - endClear(seg.b);
  if (hi - lo < 3) return;
  // Paths from doors and bus stops cross here: keep them clear.
  const curve = net.curveOf(segId);
  const lots = ctx.lots.lots.filter((l) => l.segmentId === segId && l.side === side);
  const doorS = lots.map((l) => lengthAtT(curve.table, closestPointOnCubic(net.cubicOf(segId), l.door).t));
  const stops = busStopsOn(net, segId).filter((b) => b.side === side);
  const busy = (s: number, r: number) => doorS.some((d) => Math.abs(d - s) < r + 1.2) || stops.some((b) => Math.abs(b.s - s) < r + 5);
  const at = (s: number, fromKerb: number) => {
    const p = stationPoint(st, s);
    const kerb = def.halfWidth - (shift ? shift(side, s) : 0);
    const o = side * (kerb + fromKerb);
    return { x: p.x + p.rx * o, y: p.y + ROAD_LIFT + KERB_HEIGHT, z: p.z + p.rz * o, tx: p.tx, tz: p.tz, fx: p.rx * side, fz: p.rz * side, road: p.y, ground: terrainHeight(p.x, p.z) };
  };
  const kindAt = (s: number): ZoneKind | null => {
    const p = at(s, W);
    return ctx.lots.kindNear(p.x + p.fx * 18, p.z + p.fz * 18, 26);
  };
  const place = (type: number, s: number, fromKerb: number, yaw?: number, scale = 1, c = 0, l = 1): boolean => {
    const r = PROP_RADIUS[type] * scale;
    if (busy(s, r)) return false;
    const p = at(s, fromKerb);
    if (p.road < p.ground - 1.5) return false;
    if (!clear(ctx, p.x, p.y, p.z, r * 0.6)) return false;
    push(out, type, p.x, p.y, p.z, yaw ?? yawToward(p.fx, p.fz), scale, c, l);
    return true;
  };
  // Bus stops: a shelter at the back of the sidewalk and the stop sign at the kerb.
  for (const b of stops) {
    const p = at(b.s, W - 0.95);
    if (W >= 2.2 && clear(ctx, p.x, p.y, p.z, 0.8)) push(out, P_SHELTER, p.x, p.y, p.z, yawToward(p.fx, p.fz), 1, 0);
    const q = at(b.s + 3.5, 0.35);
    push(out, P_BUS_SIGN, q.x, q.y, q.z, yawToward(q.fx, q.fz), 1, 0);
    if (rnd() < 0.8) {
      const r = at(b.s - 3.2, 0.4);
      push(out, P_BIN, r.x, r.y, r.z, yawToward(r.fx, r.fz), 1, 0);
    }
  }
  const wide = W >= 2.9;
  const binDay = hash32(ctx.seed, segId, 5) % 3 === 0;
  // Bollards at a commercial or office corner.
  for (const [s, dir] of [
    [lo, 1],
    [hi, -1],
  ] as const) {
    const kind = kindAt(s);
    if ((kind === 'commercial' || kind === 'office') && rnd() < 0.7 * k) for (let i = 0; i < 3; i++) place(P_BOLLARD, s + dir * i * 1.3, 0.3);
  }
  let treeNext = lo + 4 + rnd() * 6;
  for (let s = lo + 2 + rnd() * 4; s < hi; ) {
    const kind = kindAt(s);
    const roll = rnd();
    let step = 30;
    if (wide && s >= treeNext) {
      place(P_TREE, s, 0.75, rnd() * 6.28, 0.85 + rnd() * 0.35, Math.floor(rnd() * 4));
      treeNext = s + 11 + rnd() * 5;
      s += 2.5;
      continue;
    }
    if (kind === 'commercial') {
      step = 7 + rnd() * 6;
      if (roll < 0.22) place(P_BIN, s, 0.35, undefined, 1, 0);
      else if (roll < 0.38) place(P_BENCH, s, 0.55, yawToward(-at(s, 0).fx, -at(s, 0).fz));
      else if (roll < 0.5) place(P_BIKE_RACK, s, 0.5, undefined, 1, Math.floor(rnd() * 16));
      else if (roll < 0.6) place(P_PLANTER, s, 0.5, rnd() * 6.28, 1, Math.floor(rnd() * 4));
      else if (roll < 0.72) place(P_SHOP_SIGN, s, W - 0.45, undefined, 1, Math.floor(rnd() * 8));
      else if (roll < 0.82 && W >= 2.9) place(P_CAFE, s, W - 1.05, rnd() * 6.28, 1, Math.floor(rnd() * 8));
      else if (roll < 0.92) place(P_LITTER, s, 0.2 + rnd() * (W - 0.6), rnd() * 6.28, 1, Math.floor(rnd() * 8));
    } else if (kind === 'office') {
      step = 9 + rnd() * 8;
      if (roll < 0.25) place(P_PLANTER, s, 0.55, rnd() * 6.28, 1.1, Math.floor(rnd() * 4));
      else if (roll < 0.45) place(P_BENCH, s, 0.55, yawToward(-at(s, 0).fx, -at(s, 0).fz));
      else if (roll < 0.6) place(P_BIKE_RACK, s, 0.5, undefined, 1, Math.floor(rnd() * 16));
      else if (roll < 0.72) place(P_BIN, s, 0.35);
      else if (roll < 0.8) for (let i = 0; i < 3; i++) place(P_BOLLARD, s + i * 1.4, 0.3);
    } else if (kind === 'residential') {
      step = 12 + rnd() * 10;
      if (roll < 0.14) place(P_HYDRANT, s, 0.3);
      else if (roll < 0.26) place(P_MAILBOX, s, 0.35, undefined, 1, Math.floor(rnd() * 3));
      else if (roll < 0.34) place(P_LEAVES, s, 0.25 + rnd() * 0.6, rnd() * 6.28, 0.8 + rnd() * 0.6, Math.floor(rnd() * 4));
      else if (roll < 0.4) place(P_BENCH, s, 0.55, yawToward(-at(s, 0).fx, -at(s, 0).fz));
      else if (roll < 0.45) place(P_LITTER, s, 0.3 + rnd() * (W - 0.6), rnd() * 6.28, 1, Math.floor(rnd() * 8));
    } else if (kind === 'industrial') {
      step = 18 + rnd() * 14;
      if (roll < 0.25) place(P_HYDRANT, s, 0.3);
      else if (roll < 0.45) place(P_BOLLARD, s, 0.3);
      else if (roll < 0.6) place(P_LITTER, s, 0.3 + rnd() * (W - 0.6), rnd() * 6.28, 1.2, Math.floor(rnd() * 8));
    } else {
      // A sidewalk with nobody near: a hydrant here and there, some leaves.
      step = 26 + rnd() * 20;
      if (roll < 0.16) place(P_HYDRANT, s, 0.3);
      else if (roll < 0.26) place(P_LEAVES, s, 0.3 + rnd() * 0.6, rnd() * 6.28, 1, Math.floor(rnd() * 4));
    }
    s += step / Math.max(0.35, k);
  }
  // Bin day: wheelie bins out at the kerb in front of homes.
  if (binDay) {
    lots.forEach((lot, i) => {
      if (lot.kind !== 'residential') return;
      const s = doorS[i] + (rnd() < 0.5 ? 2.2 : -2.2);
      if (s < lo || s > hi) return;
      const p = at(s, 0.4);
      if (!clear(ctx, p.x, p.y, p.z, 0.25)) return;
      const n = 1 + (rnd() < 0.45 ? 1 : 0);
      for (let j = 0; j < n; j++) push(out, P_WHEELIE_BIN, p.x + p.tx * j * 0.75, p.y, p.z + p.tz * j * 0.75, yawToward(p.fx, p.fz), 1, Math.floor(rnd() * 4));
    });
  }
}

function highwayProps(ctx: PlaceContext, segId: Id, out: Prop[], rnd: () => number): void {
  const net = ctx.net;
  const seg = net.getSegment(segId)!;
  const geom = net.segmentGeom(segId)!;
  const def = net.roadTypeOf(segId);
  const st = geom.stations;
  const s0 = st[0].s;
  const s1 = st[st.length - 1].s;
  const lanes = effectiveLanes(def, seg.overrides);
  const dirs = [...new Set(lanes.map((l) => l.dir))];
  const atGround = (s: number) => {
    const p = stationPoint(st, s);
    const g = terrainHeight(p.x, p.z);
    return { p, ok: Math.abs(p.y - g) < 1 };
  };
  // The outer edge of each carriageway: right of travel.
  for (const dir of dirs) {
    const side = dir as 1 | -1;
    const edge = def.halfWidth;
    // Kilometre posts every 100 m of the curve, emergency phones every kilometre or so.
    for (let s = Math.ceil(s0 / 100) * 100 + 10; s < s1 - 10; s += 100) {
      const { p, ok } = atGround(s);
      if (!ok) continue;
      const o = side * (edge + 0.9);
      const x = p.x + p.rx * o;
      const z = p.z + p.rz * o;
      if (!clear(ctx, x, p.y, z, 0.1)) continue;
      push(out, P_KM_POST, x, ctx.ground(x, z), z, yawToward(-p.rx * side, -p.rz * side), 1, 0);
      if (hash32(ctx.seed, segId, Math.round(s), side) % 9 === 0) {
        const q = side * (edge + 1.6);
        const qx = p.x + p.rx * q + p.tx * 6;
        const qz = p.z + p.rz * q + p.tz * 6;
        if (clear(ctx, qx, p.y, qz, 0.35)) push(out, P_SOS_PHONE, qx, ctx.ground(qx, qz), qz, yawToward(-p.rx * side, -p.rz * side), 1, 0);
      }
    }
    // Debris on the shoulder, never in a lane.
    const outer = lanes.filter((l) => l.dir === dir).reduce((m, l) => Math.max(m, side * l.offset + l.width / 2), 0);
    const shoulder = edge - outer;
    if (shoulder > 1.2) {
      for (let s = s0 + 20 + rnd() * 60; s < s1 - 20; s += 70 + rnd() * 140) {
        if (rnd() > 0.5 * ctx.density) continue;
        const { p } = atGround(s);
        const o = side * (outer + 0.35 + rnd() * (shoulder - 0.7));
        push(out, P_DEBRIS, p.x + p.rx * o, p.y + ROAD_LIFT + 0.02, p.z + p.rz * o, rnd() * 6.28, 0.6 + rnd() * 0.8, Math.floor(rnd() * 4));
      }
    }
    // Now and then skid marks in a lane.
    if (rnd() < 0.35 * ctx.density && s1 - s0 > 80) {
      const ln = lanes.filter((l) => l.dir === dir);
      if (ln.length) {
        const lane = ln[Math.floor(rnd() * ln.length)];
        const s = s0 + 30 + rnd() * (s1 - s0 - 60);
        const { p } = atGround(s);
        const o = lane.offset;
        const len = 8 + rnd() * 16;
        push(out, P_TYRE_MARK, p.x + p.rx * o, p.y + ROAD_LIFT + 0.014, p.z + p.rz * o, Math.atan2(-p.tz, p.tx), 1, 0, len);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Junctions: tyre marks where cars turn
// ---------------------------------------------------------------------------

export function nodeProps(ctx: PlaceContext, nodeId: Id): Prop[] {
  const net = ctx.net;
  const g = net.nodeGeom(nodeId);
  const node = net.getNode(nodeId);
  const out: Prop[] = [];
  if (!g || !node || g.kind !== 'junction' || g.outline.length < 3) return out;
  if (g.arms.some((a) => net.roadTypeOf(a.segmentId).category === 'rail')) return out;
  const rnd = rngFrom(hash32(ctx.seed, nodeId, 41));
  const n = Math.floor(rnd() * 3.2 * ctx.density);
  const cx = g.outline.reduce((a, p) => a + p.x, 0) / g.outline.length;
  const cz = g.outline.reduce((a, p) => a + p.z, 0) / g.outline.length;
  for (let i = 0; i < n; i++) {
    const a = rnd() * 6.28;
    const r = rnd() * 3;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    push(out, P_TYRE_MARK, x, node.pos.y + ROAD_LIFT + 0.014, z, rnd() * 6.28, 0.8, 1, 3 + rnd() * 5);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lots: yards, back lots and work yards
// ---------------------------------------------------------------------------

export function lotProps(ctx: PlaceContext, lot: Lot): Prop[] {
  const out: Prop[] = [];
  const rnd = rngFrom(hash32(ctx.seed, Math.round(lot.centre.x * 4), Math.round(lot.centre.z * 4), 67));
  const { tx, tz, fx, fz, w, d } = lot;
  const at = (u: number, v: number) => ({ x: lot.centre.x + tx * u + fx * v, z: lot.centre.z + tz * u + fz * v });
  const put = (type: number, u: number, v: number, yaw: number, s = 1, c = 0, l = 1): void => {
    const p = at(u, v);
    const y = Math.max(ctx.ground(p.x, p.z), 0) + 0.08;
    if (isWater(p.x, p.z) || !clear(ctx, p.x, y, p.z, PROP_RADIUS[type] * s)) return;
    push(out, type, p.x, y, p.z, yaw, s, c, l);
  };
  const faceRoad = yawToward(-fx, -fz);
  const alongRoad = yawToward(tx, tz);
  const k = ctx.density;
  if (!lot.region) {
    // Zone endpoint lots draw their own yards; only an industrial yard gets clutter.
    if (lot.kind !== 'industrial') return out;
  }
  if (lot.kind === 'residential') {
    if (lot.density === 'low') {
      // Back garden, behind the house.
      const back = d * 0.08 + 5.4;
      const room = d / 2 - 1.2 - back;
      if (room > 1.2) {
        if (rnd() < 0.55 * k) put(P_GARDEN_SET, (rnd() - 0.5) * w * 0.5, back + room * 0.5, rnd() * 6.28, 1, Math.floor(rnd() * 4));
        if (rnd() < 0.3 * k) put(P_SWING, (rnd() < 0.5 ? -1 : 1) * w * 0.28, back + room * 0.55, alongRoad, 1, Math.floor(rnd() * 4));
      }
      // A car on a drive at the side of the front yard.
      if (rnd() < 0.5 * k) {
        const u = (rnd() < 0.5 ? -1 : 1) * (w / 2 - 1.6);
        const v = -d / 2 + 4.2;
        put(P_DRIVEWAY, u, v, faceRoad, 1, 0);
        put(P_CAR, u, v, alongRoad + Math.PI / 2, 1, Math.floor(rnd() * 16));
      }
    } else if (rnd() < 0.5 * k) {
      put(P_BIKE_RACK, (rnd() - 0.5) * w * 0.4, -d / 2 + 2, faceRoad, 1, Math.floor(rnd() * 16));
    }
  } else if (lot.kind === 'commercial') {
    // Bins and pallets out the back.
    const v = d / 2 - 1.8;
    const u = (rnd() - 0.5) * w * 0.6;
    if (rnd() < 0.85) put(P_DUMPSTER, u, v, faceRoad, 1, Math.floor(rnd() * 4));
    if (rnd() < 0.6 * k) put(P_PALLET, u + 2.6, v, rnd() * 6.28, 1, 0);
    if (rnd() < 0.4 * k) put(P_PALLET, u - 2.5, v + 0.1, rnd() * 6.28, 1, 1);
  } else if (lot.kind === 'office') {
    const dv = -d * 0.22 - 1.6;
    if (rnd() < 0.7 * k) put(P_PLANTER, -3.2, dv, 0, 1.2, Math.floor(rnd() * 4));
    if (rnd() < 0.7 * k) put(P_PLANTER, 3.2, dv, 0, 1.2, Math.floor(rnd() * 4));
    if (rnd() < 0.4 * k) put(P_BENCH, 5.5, dv, faceRoad + Math.PI);
  } else if (lot.kind === 'industrial') {
    // A work yard: crates, pallets, a container, puddles.
    const yard = lot.region ? d / 2 - 3.5 : d * 0.38;
    const n = Math.round((2 + rnd() * 4) * k);
    for (let i = 0; i < n; i++) put(i % 2 ? P_PALLET : P_CRATE, (rnd() - 0.5) * w * 0.7, yard - rnd() * 2.5, rnd() * 6.28, 0.8 + rnd() * 0.5, Math.floor(rnd() * 4));
    if (rnd() < 0.6) put(P_CONTAINER, (rnd() < 0.5 ? -1 : 1) * (w / 2 - 4), yard, alongRoad, 1, Math.floor(rnd() * 16));
    const puddles = Math.floor(rnd() * 3);
    for (let i = 0; i < puddles; i++) put(P_PUDDLE, (rnd() - 0.5) * w * 0.6, -d / 2 + 3 + rnd() * 4, rnd() * 6.28, 0.6 + rnd() * 0.9, 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Country: fields with fences, gates, hay and animals, rocks and wildflowers
// ---------------------------------------------------------------------------

export const COUNTRY_CELL = 96;

/** Distance from (x, z) to the nearest road carriageway edge (any road), capped at `max`. */
function roadDistance(ctx: PlaceContext, x: number, z: number, max: number): number {
  const hit = ctx.net.nearestSegment({ x, y: 0, z }, max + 30);
  if (!hit) return max;
  return Math.min(max, hit.distance - ctx.net.roadTypeOf(hit.segmentId).halfWidth);
}

export function countryProps(ctx: PlaceContext, ix: number, iz: number): Prop[] {
  const out: Prop[] = [];
  const C = COUNTRY_CELL;
  const cx = (ix + 0.5) * C;
  const cz = (iz + 0.5) * C;
  if (!isInsideMap(cx, cz)) return out;
  // Town: lots nearby, or a street with sidewalks running past.
  if (ctx.lots.near(cx, cz, C * 0.9).length) return out;
  const hit = ctx.net.nearestSegment({ x: cx, y: 0, z: cz }, C * 0.75);
  if (hit && sidewalkOn(ctx.net.roadTypeOf(hit.segmentId), 1) + sidewalkOn(ctx.net.roadTypeOf(hit.segmentId), -1) > 0 && hit.distance < C * 0.6) return out;
  const rnd = rngFrom(hash32(ctx.seed, ix, iz, 97));
  const k = ctx.density;
  const ground = (x: number, z: number) => ctx.ground(x, z);
  const okGround = (x: number, z: number, r: number) => isInsideMap(x, z) && !isWater(x, z) && roadDistance(ctx, x, z, r + 1) > r;
  // A field: try a fenced rectangle, smaller each time it meets a road or the river.
  const roll = rnd();
  if (roll < 0.5) {
    const yaw = rnd() * Math.PI;
    const ux = Math.cos(yaw);
    const uz = Math.sin(yaw);
    const vx = -uz;
    const vz = ux;
    let hw = 20 + rnd() * 14;
    let hd = 16 + rnd() * 12;
    const ox = cx + (rnd() - 0.5) * 16;
    const oz = cz + (rnd() - 0.5) * 16;
    let ok = false;
    for (let tries = 0; tries < 3 && !ok; tries++) {
      ok = true;
      for (let t = 0; t < 1 && ok; t += 0.125) {
        for (const [a, b] of [
          [-1 + 2 * t, -1],
          [1, -1 + 2 * t],
          [1 - 2 * t, 1],
          [-1, 1 - 2 * t],
        ]) {
          const x = ox + ux * a * hw + vx * b * hd;
          const z = oz + uz * a * hw + vz * b * hd;
          if (!okGround(x, z, 7)) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) {
        hw *= 0.72;
        hd *= 0.72;
      }
    }
    if (ok && hw > 8) {
      // Fence in 3 m panels; the gate on the side nearest a road.
      const sides: [number, number, number, number, number][] = [
        [-1, -1, 1, -1, hw * 2],
        [1, -1, 1, 1, hd * 2],
        [1, 1, -1, 1, hw * 2],
        [-1, 1, -1, -1, hd * 2],
      ];
      let gateSide = 0;
      let best = Infinity;
      sides.forEach(([a0, b0, a1, b1], i) => {
        const x = ox + ux * ((a0 + a1) / 2) * hw + vx * ((b0 + b1) / 2) * hd;
        const z = oz + uz * ((a0 + a1) / 2) * hw + vz * ((b0 + b1) / 2) * hd;
        const dd = roadDistance(ctx, x, z, 400);
        if (dd < best) {
          best = dd;
          gateSide = i;
        }
      });
      sides.forEach(([a0, b0, a1, b1, len], i) => {
        const n = Math.max(1, Math.round(len / 3));
        const x0 = ox + ux * a0 * hw + vx * b0 * hd;
        const z0 = oz + uz * a0 * hw + vz * b0 * hd;
        const x1 = ox + ux * a1 * hw + vx * b1 * hd;
        const z1 = oz + uz * a1 * hw + vz * b1 * hd;
        const dx = (x1 - x0) / n;
        const dz = (z1 - z0) / n;
        const panelYaw = Math.atan2(-dz, dx);
        const gateAt = i === gateSide ? Math.floor(n / 2) : -1;
        for (let j = 0; j < n; j++) {
          const x = x0 + dx * (j + 0.5);
          const z = z0 + dz * (j + 0.5);
          push(out, j === gateAt ? P_GATE : P_FENCE, x, ground(x, z), z, panelYaw, 1, 0, Math.hypot(dx, dz) / 3);
        }
      });
      const kind = rnd();
      if (kind < 0.62) {
        // Pasture: cows or sheep, all well away from any road.
        const sheep = rnd() < 0.45;
        const n = Math.round((sheep ? 6 + rnd() * 10 : 3 + rnd() * 6) * Math.max(0.4, k));
        for (let i = 0; i < n; i++) {
          const a = (rnd() * 2 - 1) * (hw - 3);
          const b = (rnd() * 2 - 1) * (hd - 3);
          const x = ox + ux * a + vx * b;
          const z = oz + uz * a + vz * b;
          if (!okGround(x, z, 30)) continue;
          push(out, sheep ? P_SHEEP : P_COW, x, ground(x, z), z, rnd() * 6.28, 0.9 + rnd() * 0.2, Math.floor(rnd() * 4));
        }
      } else {
        // Mown hay, baled in rows.
        const rows = 2 + Math.floor(rnd() * 3);
        for (let r = 0; r < rows; r++) {
          const b = -hd + ((r + 1) * 2 * hd) / (rows + 1);
          for (let a = -hw + 4 + rnd() * 4; a < hw - 4; a += 7 + rnd() * 6) {
            if (rnd() > 0.75) continue;
            const x = ox + ux * a + vx * b;
            const z = oz + uz * a + vz * b;
            push(out, P_HAY_BALE, x, ground(x, z), z, yaw + (rnd() - 0.5) * 0.6, 0.9 + rnd() * 0.2, 0);
          }
        }
      }
    }
  }
  // Rocks and wildflowers across the cell.
  const rocks = Math.floor(rnd() * 5 * k);
  for (let i = 0; i < rocks; i++) {
    const x = cx + (rnd() - 0.5) * C;
    const z = cz + (rnd() - 0.5) * C;
    const s = 0.6 + rnd() * 1.4;
    if (!okGround(x, z, 3 + s)) continue;
    push(out, P_ROCK, x, ground(x, z), z, rnd() * 6.28, s, Math.floor(rnd() * 4));
  }
  const flowers = Math.floor((3 + rnd() * 9) * k);
  for (let i = 0; i < flowers; i++) {
    const x = cx + (rnd() - 0.5) * C;
    const z = cz + (rnd() - 0.5) * C;
    if (!okGround(x, z, 2)) continue;
    push(out, P_FLOWERS, x, ground(x, z), z, rnd() * 6.28, 0.8 + rnd() * 0.8, Math.floor(rnd() * 6));
  }
  return out;
}
