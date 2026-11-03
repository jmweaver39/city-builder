/**
 * Where people come from and go to, read off the network: building lots (zoned
 * regions and zone endpoints), bus stops and rail station platforms. Pure TS,
 * shared by the pedestrian graph and the street detail placer, so both agree on
 * where a door, a stop or a platform is.
 *
 * Lot positions follow render/endpoints.ts (buildZone and buildRegion) so doors
 * land on the buildings that are drawn. If those layouts change, change these.
 */
import { cubicPoint, cubicTangentXZ, lengthAtT } from '../core/bezier';
import type { RoadNetwork } from '../core/RoadNetwork';
import { effectiveLanes, sidewalkOn, totalHalfWidth } from '../core/roadTypes';
import { trackSpec } from '../core/railTypes';
import { surfaceLevel } from '../core/terrain';
import type { Id, RoadTypeDef, TrafficEndpoint, Vec3, ZoneDensity, ZoneKind } from '../core/types';
import { zoneCoverage, ZONE_STEP } from '../core/zones';

/** Road categories nobody walks along. */
export const NO_WALK: ReadonlySet<string> = new Set(['highway', 'ramp', 'rail']);

export function walkableDef(def: RoadTypeDef): boolean {
  return !NO_WALK.has(def.category);
}

// ---------------------------------------------------------------------------
// Seeded hashing: everything placed comes from these, never Math.random.
// ---------------------------------------------------------------------------

export function hash32(...xs: number[]): number {
  let h = 0x811c9dc5;
  for (const x of xs) {
    const v = Math.round(x * 64) | 0;
    h = Math.imul(h ^ (v & 0xffff), 0x01000193);
    h = Math.imul(h ^ (v >>> 16), 0x01000193);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Small seeded generator, mulberry32. */
export function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Lots
// ---------------------------------------------------------------------------

export interface Lot {
  /** Region or endpoint id the lot belongs to. */
  owner: Id;
  kind: ZoneKind;
  density: ZoneDensity;
  /** Lot centre on the ground. */
  centre: Vec3;
  /** Along the road (t) and away from it (f), unit horizontal vectors. */
  tx: number;
  tz: number;
  fx: number;
  fz: number;
  /** Width along the road, depth away from it. */
  w: number;
  d: number;
  /** The road the lot faces, and which side of it, 1 right of a-to-b. */
  segmentId: Id;
  side: 1 | -1;
  /** Where people go in and out: the front door of the building. */
  door: Vec3;
  /** Relative number of people living or working here. */
  weight: number;
  /** True for a lot of a zoned region (laid out as buildRegion does), false for a zone endpoint. */
  region: boolean;
}

const LOTS: Record<ZoneKind, Record<ZoneDensity, [number, number]>> = {
  residential: { low: [17, 26], medium: [22, 22], high: [30, 30] },
  commercial: { low: [24, 28], medium: [28, 30], high: [32, 32] },
  industrial: { low: [36, 40], medium: [38, 40], high: [40, 42] },
  office: { low: [28, 30], medium: [30, 32], high: [34, 34] },
};
const MAX_LOTS = 400;

const WEIGHT: Record<ZoneKind, Record<ZoneDensity, number>> = {
  residential: { low: 2, medium: 5, high: 10 },
  commercial: { low: 2, medium: 3.5, high: 6 },
  office: { low: 2, medium: 4, high: 8 },
  industrial: { low: 0.6, medium: 1, high: 1.4 },
};

/** Lots of the zoned regions, laid out as render/endpoints buildRegion lays them. */
function regionLots(net: RoadNetwork, out: Lot[]): void {
  for (const region of net.project.zones ?? []) {
    if (region.kind === 'none' || !region.enabled) continue;
    const kind = region.kind;
    const cells = zoneCoverage(net, region.id).cells;
    if (!cells.length) continue;
    const cellKey = (x: number, z: number) => `${Math.floor(x / ZONE_STEP)},${Math.floor(z / ZONE_STEP)}`;
    const have = new Set(cells.map((c) => cellKey(c.x, c.z)));
    const zoned = (x: number, z: number) => have.has(cellKey(x, z));
    const [w, d] = LOTS[kind][region.density];
    const scored = cells.map((c) => {
      const hit = net.nearestSegment({ x: c.x, y: 0, z: c.z }, 120);
      return { c, hit, d: hit ? hit.distance : 1e9 };
    });
    scored.sort((a, b) => a.d - b.d);
    const placed: { x: number; z: number; r: number }[] = [];
    const r = Math.min(w, d) / 2;
    let count = 0;
    for (const { c, hit } of scored) {
      if (count >= MAX_LOTS) break;
      let tx = 1;
      let tz = 0;
      let fx = 0;
      let fz = 1;
      let side: 1 | -1 = 1;
      if (hit) {
        const t = cubicTangentXZ(net.cubicOf(hit.segmentId), hit.t);
        tx = t.x;
        tz = t.z;
        side = hit.lateral >= 0 ? 1 : -1;
        fx = -t.z * side;
        fz = t.x * side;
      }
      const cx = c.x + fx * (d / 2 - ZONE_STEP / 2);
      const cz = c.z + fz * (d / 2 - ZONE_STEP / 2);
      if (placed.some((p) => Math.hypot(p.x - cx, p.z - cz) < (p.r + r) * 0.98)) continue;
      let ok = true;
      for (const [su, sv] of [[0, 0], [-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45], [0, 0.45], [0, -0.45]]) {
        if (!zoned(cx + tx * su * w + fx * sv * d, cz + tz * su * w + fz * sv * d)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      placed.push({ x: cx, z: cz, r });
      count++;
      if (!hit) continue;
      const ground = surfaceLevel(cx, cz) + 0.08;
      // Front of the building: houses sit a little back, others fill most of the lot.
      const front = kind === 'residential' && region.density === 'low' ? 4.4 - d * 0.08 : d * 0.22;
      const door = { x: cx - fx * front, y: ground, z: cz - fz * front };
      out.push({
        owner: region.id,
        kind,
        density: region.density,
        centre: { x: cx, y: ground, z: cz },
        tx,
        tz,
        fx,
        fz,
        w,
        d,
        segmentId: hit.segmentId,
        side,
        door,
        weight: WEIGHT[kind][region.density],
        region: true,
      });
    }
  }
}

/** Lots of a zone endpoint, laid out as render/endpoints buildZone lays them. */
function endpointLots(net: RoadNetwork, ep: TrafficEndpoint, out: Lot[]): void {
  if (ep.kind === 'gateway' || ep.segmentId === null || ep.regionId !== undefined || !ep.enabled) return;
  const seg = net.getSegment(ep.segmentId);
  if (!seg) return;
  const kind = ep.kind as ZoneKind;
  const c = net.cubicOf(seg.id);
  const def = net.roadTypeOf(seg.id);
  const p = cubicPoint(c, ep.t);
  const tan = cubicTangentXZ(c, ep.t);
  const side = ep.side;
  const fx = -tan.z * side;
  const fz = tan.x * side;
  const scale = Math.min(2.2, 0.7 + Math.sqrt(Math.max(ep.ratePerHour, 40)) / 26);
  const setback = totalHalfWidth(def) + 6;
  const depth = 34 * scale;
  const width = 62 * scale;
  const cx = p.x + fx * (setback + depth / 2);
  const cz = p.z + fz * (setback + depth / 2);
  const ground = surfaceLevel(cx, cz) + 0.08;
  const count = Math.round(2 + scale * 2);
  // Doors along the frontage: one per house, one per shop or block.
  const doors: { u: number; front: number }[] = [];
  if (kind === 'residential') {
    for (let along = -width / 2 + 10; along < width / 2 - 8; along += 19) doors.push({ u: along, front: setback + depth * 0.38 - 4.4 });
  } else if (kind === 'commercial') {
    for (let i = 0; i < count; i++) doors.push({ u: (((i + 0.5) / count) * 2 - 1) * (width / 2), front: setback + depth * 0.47 });
  } else if (kind === 'industrial') {
    const n = Math.max(2, count - 1);
    for (let i = 0; i < n; i++) doors.push({ u: (((i + 0.5) / n) * 2 - 1) * (width / 2), front: setback + depth * 0.31 });
  } else {
    const n = Math.max(1, count - 1);
    for (let i = 0; i < n; i++) doors.push({ u: (((i + 0.5) / n) * 2 - 1) * 0.8 * (width / 2), front: setback + depth * 0.41 });
  }
  const per = (Math.max(ep.ratePerHour, 40) / 120) * (kind === 'residential' ? 1.6 : 1.2);
  for (const dr of doors) {
    const x = p.x + tan.x * dr.u + fx * dr.front;
    const z = p.z + tan.z * dr.u + fz * dr.front;
    out.push({
      owner: ep.id,
      kind,
      density: 'medium',
      centre: { x: cx + tan.x * dr.u, y: ground, z: cz + tan.z * dr.u },
      tx: tan.x,
      tz: tan.z,
      fx,
      fz,
      w: width / doors.length,
      d: depth,
      segmentId: seg.id,
      side,
      door: { x, y: ground, z },
      weight: (per / doors.length) * 3,
      region: false,
    });
  }
}

const lotCache = new WeakMap<RoadNetwork, { version: number; lots: Lot[] }>();

/** Every building lot on the map, cached per network version. */
export function collectLots(net: RoadNetwork): Lot[] {
  const hit = lotCache.get(net);
  if (hit && hit.version === net.version) return hit.lots;
  const lots: Lot[] = [];
  regionLots(net, lots);
  for (const ep of net.endpoints) endpointLots(net, ep, lots);
  lotCache.set(net, { version: net.version, lots });
  return lots;
}

// ---------------------------------------------------------------------------
// Bus stops
// ---------------------------------------------------------------------------

export interface BusStop {
  segmentId: Id;
  side: 1 | -1;
  /** Arc length along the full curve. */
  s: number;
  /** Kerb point, sidewalk outer point, and the road direction there (a to b). */
  kerb: Vec3;
  back: Vec3;
  tx: number;
  tz: number;
  /** Outward from the road, toward the buildings. */
  fx: number;
  fz: number;
}

/** True where buses run: a bus lane, or an avenue (the trunk routes). */
export function busRoute(net: RoadNetwork, segId: Id): boolean {
  const seg = net.getSegment(segId);
  if (!seg) return false;
  const def = net.roadTypeOf(segId);
  if (!walkableDef(def)) return false;
  if (effectiveLanes(def, seg.overrides).some((l) => l.kind === 'bus')) return true;
  return def.category === 'avenue';
}

/** Bus stops on bus routes, deterministic per segment: mid-block, staggered by side. */
export function busStopsOn(net: RoadNetwork, segId: Id): BusStop[] {
  if (!busRoute(net, segId)) return [];
  const seg = net.getSegment(segId)!;
  const geom = net.segmentGeom(segId);
  if (!geom || geom.stations.length < 2) return [];
  const def = net.roadTypeOf(segId);
  const lanes = effectiveLanes(def, seg.overrides);
  const st = geom.stations;
  const s0 = st[0].s;
  const s1 = st[st.length - 1].s;
  const L = s1 - s0;
  if (L < 70) return [];
  const out: BusStop[] = [];
  for (const side of [1, -1] as const) {
    if (sidewalkOn(def, side) < 1.5) continue;
    // A stop serves the traffic on its own side.
    if (!lanes.some((l) => l.dir === side && (l.kind === 'drive' || l.kind === 'bus'))) continue;
    const n = Math.max(1, Math.floor(L / 320));
    for (let k = 0; k < n; k++) {
      const h = hash32(segId, side, k, 17) / 4294967296;
      if (n === 1 && L < 140 && h < 0.35) continue;
      const f = (k + (side > 0 ? 0.36 : 0.64)) / n;
      const s = s0 + Math.max(25, Math.min(L - 25, L * f));
      const pos = stationPoint(st, s);
      const W = sidewalkOn(def, side);
      const rx = pos.rx * side;
      const rz = pos.rz * side;
      out.push({
        segmentId: segId,
        side,
        s,
        kerb: { x: pos.x + rx * (def.halfWidth + 0.5), y: pos.y, z: pos.z + rz * (def.halfWidth + 0.5) },
        back: { x: pos.x + rx * (def.halfWidth + W - 0.9), y: pos.y, z: pos.z + rz * (def.halfWidth + W - 0.9) },
        tx: pos.tx,
        tz: pos.tz,
        fx: rx,
        fz: rz,
      });
    }
  }
  return out;
}

/** Point, tangent and right vector at arc length s between stations. */
export function stationPoint(st: readonly { pos: Vec3; tangent: Vec3; right: Vec3; s: number }[], s: number): { x: number; y: number; z: number; tx: number; tz: number; rx: number; rz: number } {
  let i = 0;
  while (i + 2 < st.length && st[i + 1].s < s) i++;
  const a = st[i];
  const b = st[Math.min(i + 1, st.length - 1)];
  const f = b.s > a.s ? Math.max(0, Math.min(1, (s - a.s) / (b.s - a.s))) : 0;
  let tx = a.tangent.x + (b.tangent.x - a.tangent.x) * f;
  let tz = a.tangent.z + (b.tangent.z - a.tangent.z) * f;
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl;
  tz /= tl;
  let rx = a.right.x + (b.right.x - a.right.x) * f;
  let rz = a.right.z + (b.right.z - a.right.z) * f;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  return {
    x: a.pos.x + (b.pos.x - a.pos.x) * f,
    y: a.pos.y + (b.pos.y - a.pos.y) * f,
    z: a.pos.z + (b.pos.z - a.pos.z) * f,
    tx,
    tz,
    rx,
    rz,
  };
}

// ---------------------------------------------------------------------------
// Station platforms
// ---------------------------------------------------------------------------

/** Mirrors render/tracks.ts platform layout. */
export const PLATFORM_EDGE = 1.65;
export const PLATFORM_WIDTH = 5;
/** Platform walking surface over the track's own height. */
export const PLATFORM_HEIGHT = 1.1;

export interface Platform {
  stationId: Id;
  name: string;
  underground: boolean;
  /** Walking line along the platform, centre of its width, in order. */
  line: Vec3[];
  /** Unit outward direction (away from the track) at each line point. */
  out: { x: number; z: number }[];
  centre: Vec3;
  length: number;
}

/** Platforms of every surface and underground station, one per side with a track. */
export function collectPlatforms(net: RoadNetwork): Platform[] {
  const out: Platform[] = [];
  for (const st of net.project.rail?.stations ?? []) {
    if (st.kind === 'gateway' || st.platformLength <= 0) continue;
    const seg = net.getSegment(st.segmentId);
    const geom = net.segmentGeom(st.segmentId);
    if (!seg || !geom || geom.stations.length < 2) continue;
    const def = net.roadTypeOf(st.segmentId);
    const spec = trackSpec(def.id);
    const offset = spec?.trackOffset ?? 0;
    const curve = net.curveOf(st.segmentId);
    const sc = lengthAtT(curve.table, st.t);
    const sts = geom.stations;
    const lo = Math.max(sts[0].s, sc - st.platformLength / 2);
    const hi = Math.min(sts[sts.length - 1].s, sc + st.platformLength / 2);
    if (hi - lo < 10) continue;
    const sides: (1 | -1)[] = offset > 0 ? [-1, 1] : [1];
    for (const side of sides) {
      const o = side * (offset + PLATFORM_EDGE + PLATFORM_WIDTH * 0.55);
      const line: Vec3[] = [];
      const outs: { x: number; z: number }[] = [];
      const n = Math.max(2, Math.ceil((hi - lo) / 8));
      for (let i = 0; i <= n; i++) {
        const p = stationPoint(sts, lo + ((hi - lo) * i) / n);
        line.push({ x: p.x + p.rx * o, y: p.y + PLATFORM_HEIGHT, z: p.z + p.rz * o });
        outs.push({ x: p.rx * side, z: p.rz * side });
      }
      const mid = stationPoint(sts, sc);
      out.push({
        stationId: st.id,
        name: st.name,
        underground: st.kind === 'underground',
        line,
        out: outs,
        centre: { x: mid.x + mid.rx * o, y: mid.y + PLATFORM_HEIGHT, z: mid.z + mid.rz * o },
        length: hi - lo,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// What is near a point: the street detail placer asks this to pick props.
// ---------------------------------------------------------------------------

export class LotIndex {
  private cells = new Map<string, Lot[]>();
  constructor(
    readonly lots: readonly Lot[],
    private readonly cell = 48,
  ) {
    for (const l of lots) {
      const r = Math.max(l.w, l.d) / 2;
      for (let x = Math.floor((l.centre.x - r) / cell); x <= Math.floor((l.centre.x + r) / cell); x++) {
        for (let z = Math.floor((l.centre.z - r) / cell); z <= Math.floor((l.centre.z + r) / cell); z++) {
          const k = `${x},${z}`;
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, (list = []));
          list.push(l);
        }
      }
    }
  }

  /** Lots whose footprint centre is within r of (x, z). */
  near(x: number, z: number, r: number): Lot[] {
    const out = new Set<Lot>();
    const c = this.cell;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
      for (let j = Math.floor((z - r) / c); j <= Math.floor((z + r) / c); j++) {
        for (const l of this.cells.get(`${i},${j}`) ?? []) {
          if (Math.hypot(l.centre.x - x, l.centre.z - z) <= r + Math.max(l.w, l.d) / 2) out.add(l);
        }
      }
    }
    return [...out];
  }

  /** The kind of the closest lot within r, or null where nobody lives or works. */
  kindNear(x: number, z: number, r: number): ZoneKind | null {
    let best: Lot | null = null;
    let bestD = Infinity;
    for (const l of this.near(x, z, r)) {
      const d = Math.hypot(l.centre.x - x, l.centre.z - z);
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    return best ? best.kind : null;
  }
}
