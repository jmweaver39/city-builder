/**
 * Where bridge supports may stand, for every elevated road and track.
 *
 * Everything under or beside a deck gets a plan footprint, kept apart by what it
 * is: carriageway (lanes and shoulders, split at a raised median), track bed with
 * room for catenary masts, platforms and station buildings, junction surfaces,
 * shallow tunnels, and the softer things a column may stand on but should rather
 * not: sidewalks, zoned lots (buildings) and water. Each also carries the height
 * that must stay clear above it, so a cap beam reaching over a road never comes
 * down into its traffic.
 *
 * `planSupports` places a deck's piers in the gaps: a single column (a hammerhead)
 * where one fits under the deck, two columns under a wide deck, a portal frame with
 * its legs on the sidewalks or verges straddling what is below where nothing fits
 * under, each shifted along the span within limits, and a long girder span as the
 * last resort. Pure: it reads the network and returns positions, so the renderer,
 * the draw preview and the tests share it.
 */
import { placedStationFootprint, kioskFootprints, type PlanBox } from '../core/footprint';
import { segmentElectrification } from '../core/railTypes';
import type { RoadNetwork } from '../core/RoadNetwork';
import { sidewalkOn, totalHalfWidth } from '../core/roadTypes';
import { isWater, surfaceLevel, terrainEditVersion } from '../core/terrain';
import { groundHeight } from '../core/terrainMods';
import type { Id, RoadTypeDef } from '../core/types';
import { zonePolygon } from '../core/zones';
import { DECK_DEPTH, ROAD_LIFT } from './constants';
import type { Frame } from './frames';

/** Room either side of wired track for its masts. */
const MAST_ZONE = 1.8;
/** Gap kept between a column (with its footing) and anything a column may not stand in. */
export const PIER_MARGIN = 0.3;
/** Headroom kept over a road, over track with wires, and over a sidewalk. */
const HEAD_ROAD = 4.8;
const HEAD_WIRES = 5.8;
const HEAD_WALK = 2.6;
/** Furthest a portal leg stands from the deck's centreline. */
export const PORTAL_REACH = 24;
/** Below this clearance a span needs no pier. */
export const MIN_PIER_CLEARANCE = 3.2;
/** Under a deck this far down, a tunnel is too deep for a footing to matter. */
const DEEP_TUNNEL = 14;
/** Footing pad radius beyond the column. */
export const FOOTING = 0.25;

export type ObstacleKind = 'carriageway' | 'track' | 'platform' | 'junction' | 'tunnel' | 'sidewalk' | 'junctionWalk' | 'zone';

/** Extra cost of a column standing on soft ground of each kind. */
const SOFT_COST: Partial<Record<ObstacleKind, number>> = { sidewalk: 1.2, junctionWalk: 1.2, zone: 2.5 };

export interface Obstacle {
  kind: ObstacleKind;
  /** Hard: no column may stand in it. Soft: costs extra. */
  hard: boolean;
  /** Surface height of what is there. */
  y: number;
  /** Height that must stay clear above y. */
  headroom: number;
  /** A road joined to the deck at one of its own nodes: its approach, never beside it. */
  joined: boolean;
  box?: PlanBox;
  poly?: { x: number; z: number }[];
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Segment or node it came from, for messages. */
  source: Id;
}

export interface Region {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

function boxObstacle(kind: ObstacleKind, hard: boolean, y: number, headroom: number, joined: boolean, box: PlanBox, source: Id): Obstacle {
  const ex = Math.abs(box.ax) * box.hl + Math.abs(box.az) * box.hw;
  const ez = Math.abs(box.az) * box.hl + Math.abs(box.ax) * box.hw;
  return { kind, hard, y, headroom, joined, box, minX: box.cx - ex, maxX: box.cx + ex, minZ: box.cz - ez, maxZ: box.cz + ez, source };
}

function polyObstacle(kind: ObstacleKind, hard: boolean, y: number, headroom: number, poly: { x: number; z: number }[], source: Id): Obstacle | null {
  if (poly.length < 3) return null;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { kind, hard, y, headroom, joined: false, poly, minX, minZ, maxX, maxZ, source };
}

/** Signed distance from a point to an oriented plan box: negative inside. */
export function boxDistance(b: PlanBox, x: number, z: number): number {
  const dx = x - b.cx;
  const dz = z - b.cz;
  const u = Math.abs(dx * b.ax + dz * b.az) - b.hl;
  const v = Math.abs(-dx * b.az + dz * b.ax) - b.hw;
  return Math.hypot(Math.max(u, 0), Math.max(v, 0)) + Math.min(Math.max(u, v), 0);
}

/** Signed distance from a point to a simple polygon in plan: negative inside. */
export function polyDistance(poly: readonly { x: number; z: number }[], x: number, z: number): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    if (b.z > z !== a.z > z && x < ((a.x - b.x) * (z - b.z)) / (a.z - b.z) + b.x) inside = !inside;
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const l2 = ex * ex + ez * ez || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / l2));
    best = Math.min(best, Math.hypot(x - a.x - ex * t, z - a.z - ez * t));
  }
  return inside ? -best : best;
}

export function obstacleDistance(o: Obstacle, x: number, z: number): number {
  return o.box ? boxDistance(o.box, x, z) : polyDistance(o.poly!, x, z);
}

/** Lateral bands of a road, across from the centreline: [lo, hi, kind, hard]. */
function roadBands(def: RoadTypeDef, wired: boolean): [number, number, ObstacleKind, boolean][] {
  const H = def.halfWidth;
  if (def.category === 'rail') {
    const m = wired ? MAST_ZONE : 0;
    return [[-H - m, H + m, 'track', true]];
  }
  const out: [number, number, ObstacleKind, boolean][] = [];
  const med = def.median;
  // A raised median is a gap a column can stand in; painted ones are carriageway.
  if (med.width > 0 && (med.kind === 'grass' || med.kind === 'barrier')) {
    const o = med.offset ?? 0;
    out.push([-H, o - med.width / 2, 'carriageway', true], [o + med.width / 2, H, 'carriageway', true]);
  } else {
    out.push([-H, H, 'carriageway', true]);
  }
  const wl = sidewalkOn(def, -1);
  const wr = sidewalkOn(def, 1);
  if (wl > 0) out.push([-H - wl, -H, 'sidewalk', false]);
  if (wr > 0) out.push([H, H + wr, 'sidewalk', false]);
  return out;
}

export interface GatherOptions {
  /** The deck itself, left out. */
  self?: Id | null;
  /** Nodes at the deck's ends: roads at them are its approaches, their junctions its own. */
  nodes?: readonly Id[];
  /** Highest point of the deck: anything well above it is not in the way. */
  topY: number;
}

/**
 * Footprints of everything a support near `region` could stand in: every road and
 * track (by band), junction surface, platform, station, shallow tunnel and zoned lot.
 */
export function gatherObstacles(net: RoadNetwork, region: Region, opts: GatherOptions): Obstacle[] {
  const out: Obstacle[] = [];
  const self = opts.self ?? null;
  const ends = new Set<Id>(opts.nodes ?? []);
  const selfSeg = self !== null ? net.getSegment(self) : undefined;
  if (selfSeg) {
    ends.add(selfSeg.a);
    ends.add(selfSeg.b);
  }
  const limit = opts.topY + 1;
  for (const id of net.segmentsInRegion(region, true)) {
    if (id === self) continue;
    const seg = net.getSegment(id);
    const geom = net.segmentGeom(id);
    if (!seg || !geom || geom.stations.length < 2) continue;
    const def = net.roadTypeOf(id);
    const joined = ends.has(seg.a) || ends.has(seg.b);
    const wired = def.category === 'rail' && segmentElectrification(def, seg.overrides) === 'overhead';
    const bands = roadBands(def, wired);
    const head = def.category === 'rail' ? (wired ? HEAD_WIRES : HEAD_ROAD) : HEAD_ROAD;
    const st = geom.stations;
    for (let i = 0; i + 1 < st.length; i++) {
      const a = st[i];
      const b = st[i + 1];
      const y = Math.min(a.pos.y, b.pos.y);
      if (y > limit) continue;
      const mx = (a.pos.x + b.pos.x) / 2;
      const mz = (a.pos.z + b.pos.z) / 2;
      const surface = surfaceLevel(mx, mz);
      const tunnel = Math.max(a.pos.y, b.pos.y) < surface - 1.5;
      if (tunnel && Math.max(a.pos.y, b.pos.y) < surface - DEEP_TUNNEL) continue;
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const l = Math.hypot(dx, dz);
      if (l < 1e-4) continue;
      const ax = dx / l;
      const az = dz / l;
      const rx = (a.right.x + b.right.x) / 2;
      const rz = (a.right.z + b.right.z) / 2;
      const rl = Math.hypot(rx, rz) || 1;
      const push = (lo: number, hi: number, kind: ObstacleKind, hard: boolean, headroom: number) => {
        const c = (lo + hi) / 2;
        const box: PlanBox = { cx: mx + (rx / rl) * c, cz: mz + (rz / rl) * c, ax, az, hl: l / 2 + 0.05, hw: (hi - lo) / 2 };
        out.push(boxObstacle(kind, hard, y, headroom, joined, box, id));
      };
      if (tunnel) {
        const lo = Math.min(...bands.map((q) => q[0]));
        const hi = Math.max(...bands.map((q) => q[1]));
        push(lo, hi, 'tunnel', true, 0);
        continue;
      }
      for (const [lo, hi, kind, hard] of bands) push(lo, hi, kind, hard, kind === 'sidewalk' ? HEAD_WALK : head);
    }
  }
  for (const id of net.nodesInRegion({ minX: region.minX - 40, minZ: region.minZ - 40, maxX: region.maxX + 40, maxZ: region.maxZ + 40 })) {
    if (ends.has(id)) continue;
    const node = net.getNode(id);
    const g = net.nodeGeom(id);
    if (!node || !g || g.kind !== 'junction' || node.pos.y > limit) continue;
    if (node.pos.y < surfaceLevel(node.pos.x, node.pos.z) - DEEP_TUNNEL) continue;
    const rail = node.segments.length > 0 && node.segments.every((s) => net.roadTypeOf(s).category === 'rail');
    const inner = polyObstacle('junction', true, node.pos.y, rail ? HEAD_WIRES : HEAD_ROAD, g.outline, id);
    if (inner) out.push(inner);
    if (g.outerOutline.length >= 3 && g.outerOutline !== g.outline) {
      const walk = polyObstacle('junctionWalk', false, node.pos.y, HEAD_WALK, g.outerOutline, id);
      if (walk) out.push(walk);
    }
  }
  for (const st of net.rail.stations) {
    const fp = placedStationFootprint(net, st);
    if (fp && fp.boxes.length && fp.y0 < limit && fp.y1 > surfaceLevel(fp.boxes[0].cx, fp.boxes[0].cz) - DEEP_TUNNEL) {
      for (const b of fp.boxes) out.push(boxObstacle('platform', true, fp.y0, fp.y1 - fp.y0, false, b, st.segmentId));
    }
    for (const k of kioskFootprints(net, st)) for (const b of k.boxes) out.push(boxObstacle('platform', true, k.y0, k.y1 - k.y0, false, b, st.segmentId));
  }
  for (const z of net.project.zones ?? []) {
    const o = polyObstacle('zone', false, 0, 0, zonePolygon(net, z), z.id);
    if (o) out.push(o);
  }
  return out.filter((o) => o.maxX > region.minX - 2 && o.minX < region.maxX + 2 && o.maxZ > region.minZ - 2 && o.minZ < region.maxZ + 2);
}

/** Whether an obstacle is in the way of a column reaching up to a deck at deckY. */
function relevant(o: Obstacle, deckY: number, outside: boolean): boolean {
  // Under the deck, only what is clearly below it. Beside it, a leg rises past
  // anything up to the deck's own height, except the deck's own approaches.
  return o.y < deckY - (outside && !o.joined ? -0.5 : 2);
}

/**
 * Cost of a column with plan radius r (footing included) at (x, z): Infinity where
 * it would stand in something hard, otherwise the soft costs of where it stands.
 */
export function columnCost(net: RoadNetwork | null, obs: readonly Obstacle[], x: number, z: number, r: number, deckY: number, outside: boolean): number {
  let cost = 0;
  const reach = r + PIER_MARGIN;
  for (const o of obs) {
    if (x + reach < o.minX || x - reach > o.maxX || z + reach < o.minZ || z - reach > o.maxZ) continue;
    if (!relevant(o, deckY, outside)) continue;
    const d = obstacleDistance(o, x, z);
    if (o.hard) {
      if (d < reach) return Infinity;
    } else if (d < r) {
      cost += SOFT_COST[o.kind] ?? 1;
    }
  }
  // Water, and the bank's edge, only where avoidable.
  if (isWater(x, z)) cost += 4;
  else if (isWater(x + r + 1.5, z) || isWater(x - r - 1.5, z) || isWater(x, z + r + 1.5) || isWater(x, z - r - 1.5)) cost += 1.5;
  if (net) {
    // Room under the deck for a column at all, on a hill or an embankment.
    const g = groundHeight(net, x, z);
    if (g > deckY - DECK_DEPTH - 1.2) return Infinity;
  }
  return cost;
}

/** Highest clearance envelope (surface plus headroom) of anything under a cap beam. */
function envelopeUnder(obs: readonly Obstacle[], x0: number, z0: number, ux: number, uz: number, u0: number, u1: number, halfThick: number, deckY: number): number {
  let top = -Infinity;
  const n = Math.max(2, Math.ceil(u1 - u0) + 1);
  for (const o of obs) {
    if (o.kind === 'zone' || o.headroom <= 0) continue;
    if (!relevant(o, deckY, true)) continue;
    for (let i = 0; i < n; i++) {
      const u = u0 + ((u1 - u0) * i) / (n - 1);
      const x = x0 + ux * u;
      const z = z0 + uz * u;
      if (x + halfThick < o.minX || x - halfThick > o.maxX || z + halfThick < o.minZ || z - halfThick > o.maxZ) continue;
      if (obstacleDistance(o, x, z) < halfThick) {
        top = Math.max(top, o.y + o.headroom);
        break;
      }
    }
  }
  return top;
}

/** Where the deck's girders bear, shared by the girder sweep and the pier caps. */
export interface SoffitLayout {
  kind: 'trough' | 'box';
  /** Deck centre across, from the centreline (uneven sidewalks move it). */
  centre: number;
  /** Outer edges, from the centreline. */
  left: number;
  right: number;
  /** Box centres and their top and bottom half widths (box decks). */
  boxes: { c: number; top: number; bottom: number }[];
  /** Half length of a hammerhead cap, about `centre`. */
  capHalf: number;
}

export function soffitLayout(def: RoadTypeDef): SoffitLayout {
  const right = def.halfWidth + sidewalkOn(def, 1);
  const left = def.halfWidth + sidewalkOn(def, -1);
  const total = right + left;
  const centre = (right - left) / 2;
  if (def.category === 'rail') return { kind: 'trough', centre, left, right, boxes: [], capHalf: (total / 2) * 0.9 };
  const twin = total > 22;
  const bw = twin ? total * 0.5 : total;
  const top = bw * 0.36;
  const bottom = bw * 0.28;
  const boxes = (twin ? [centre - total * 0.25, centre + total * 0.25] : [centre]).map((c) => ({ c, top, bottom }));
  const capHalf = (twin ? total * 0.25 : 0) + bottom + 0.6;
  return { kind: 'box', centre, left, right, boxes, capHalf };
}

export interface PierColumn {
  x: number;
  z: number;
  /** Plan radius, footing included: what must stand clear. */
  r: number;
  /** Column radius at its foot. */
  rc: number;
  /** Offset across the deck from the frame centre, right positive. */
  o: number;
  ground: number;
  /** Half length of a rounded-rectangle section's straight part, along the cap. */
  stretch: number;
}

export interface PlannedPier {
  f: Frame;
  /** hammer: one column under a cap. twin: two under the deck. portal: legs outside the deck carry a long cap over what is below. */
  kind: 'hammer' | 'twin' | 'portal';
  columns: PierColumn[];
  /** Cap beam extent across, offsets from the frame centre. */
  capL: number;
  capR: number;
  /** How far the cap hangs below the deck soffit; 0 is a cap built into the deck. */
  capDepth: number;
  /** Half thickness of the cap along the deck. */
  capThick: number;
  /** Furthest leg from the centreline, 0 for a hammerhead. */
  legOff: number;
  cost: number;
}

export interface PierPlan {
  piers: PlannedPier[];
  /** Spans with nowhere to stand, carried by long steel girders: [from s, to s]. */
  girders: [number, number][];
}

/** Interpolated frame at arc length s, or null outside the frames. */
export function frameAt(frames: readonly Frame[], s: number): Frame | null {
  if (frames.length < 2 || s < frames[0].s || s > frames[frames.length - 1].s) return null;
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

export interface DeckInput {
  frames: readonly Frame[];
  def: RoadTypeDef;
  /** The deck's segment, or null for a draft. */
  self: Id | null;
  /** Nodes at its ends, for a draft whose segment does not exist yet. */
  nodes?: readonly Id[];
}

const NUDGE_STEP = 2;
const NUDGE_COST = 0.22;
/** Closest two piers of one deck may stand. */
const MIN_PIER_GAP = 12;

/** Column radius at the foot for a deck of this half width; the slender one fits a narrow median. */
function columnRadius(hw: number): { normal: number; slender: number } {
  return { normal: Math.min(1.25, Math.max(0.8, 0.62 + hw * 0.06)), slender: 0.62 };
}

/** The cheapest support at frame f, or null when nothing can stand there. */
function bestAt(net: RoadNetwork | null, f: Frame, def: RoadTypeDef, obs: readonly Obstacle[]): PlannedPier | null {
  const hw = totalHalfWidth(def);
  const wide = hw > 13;
  const lay = soffitLayout(def);
  const radii = columnRadius(hw);
  const at = (o: number) => ({ x: f.x + f.rx * o, z: f.z + f.rz * o });
  const groundAt = (x: number, z: number) => (net ? groundHeight(net, x, z) : f.ground);
  let best: PlannedPier | null = null;
  const consider = (p: PlannedPier) => {
    if (!best || p.cost < best.cost) best = p;
  };
  const col = (o: number, rc: number, stretch: number): PierColumn => {
    const p = at(o);
    return { x: p.x, z: p.z, r: rc + FOOTING + stretch, rc, o, ground: groundAt(p.x, p.z), stretch };
  };
  // One column under the deck: a hammerhead, centred if it can be.
  const singleMax = wide ? (hw <= 16.5 ? 2 : -1) : Math.min(hw * 0.55, 4);
  for (const [rc, extra] of [
    [radii.normal, 0],
    [radii.slender, 0.8],
  ] as const) {
    if (singleMax < 0) break;
    for (let k = 0; k * 0.25 <= singleMax; k++) {
      const base = (wide ? 4 : 0) + extra + k * 0.25 * 0.5;
      if (best && base >= (best as PlannedPier).cost) break;
      for (const o of k === 0 ? [lay.centre] : [lay.centre + k * 0.25, lay.centre - k * 0.25]) {
        const p = at(o);
        // A rounded-rectangle column where there is room for it, round otherwise.
        const stretch = rc * 0.55;
        let c = columnCost(net, obs, p.x, p.z, rc + FOOTING + stretch, f.y, false);
        let s = stretch;
        if (!Number.isFinite(c)) {
          c = columnCost(net, obs, p.x, p.z, rc + FOOTING, f.y, false);
          s = 0;
        }
        if (!Number.isFinite(c)) continue;
        consider({ f, kind: 'hammer', columns: [col(o, rc, s)], capL: lay.centre - lay.capHalf, capR: lay.centre + lay.capHalf, capDepth: 0, capThick: rc + 0.4, legOff: 0, cost: base + c });
      }
    }
  }
  // Two columns, under the deck or straddling what is below as a portal frame.
  const rc = wide ? radii.normal * 0.9 : Math.max(radii.slender, radii.normal * 0.8);
  const ideal = wide ? hw * 0.46 : hw * 0.5;
  const inner = wide ? hw * 0.25 : Math.max(1.6, hw * 0.3);
  const legCost = (u: number) => Math.abs(u - ideal) * 0.12 + (u > hw ? 0.6 + (u - hw) * 0.1 : 0);
  const base2 = wide ? 0 : 2.4;
  const tries: number[] = [];
  for (let u = inner; u <= PORTAL_REACH; u += 0.25) tries.push(u);
  tries.sort((p, q) => legCost(p) - legCost(q));
  const legs: { o: number; c: number }[] = [];
  for (const side of [-1, 1] as const) {
    let pick: { o: number; c: number } | null = null;
    // Cheapest spots first: out from the ideal one both ways.
    for (const u of tries) {
      const pen = legCost(u);
      if (pick && pen >= pick.c) break;
      if (best && base2 + pen * 2 >= (best as PlannedPier).cost) break;
      const o = lay.centre + side * u;
      const p = at(o);
      const c = columnCost(net, obs, p.x, p.z, rc + FOOTING, f.y, u > hw - 0.5);
      if (!Number.isFinite(c)) continue;
      if (!pick || pen + c < pick.c) pick = { o, c: pen + c };
    }
    if (!pick) break;
    legs.push(pick);
  }
  if (legs.length === 2) {
    const [l, r] = legs;
    const cost = base2 + l.c + r.c;
    const outside = Math.max(Math.abs(l.o - lay.centre), Math.abs(r.o - lay.centre)) > hw + 0.25;
    consider({
      f,
      kind: outside ? 'portal' : 'twin',
      columns: [col(l.o, rc, 0), col(r.o, rc, 0)],
      capL: Math.min(l.o - rc - 0.35, lay.centre - lay.capHalf),
      capR: Math.max(r.o + rc + 0.35, lay.centre + lay.capHalf),
      capDepth: 0,
      capThick: outside ? 0.85 : rc + 0.35,
      legOff: Math.max(Math.abs(l.o), Math.abs(r.o)),
      cost,
    });
  }
  if (!best) return null;
  const p = best as PlannedPier;
  // Cap depth: as deep as wanted, but clear of whatever passes under it.
  const span = p.capR - p.capL;
  const want = p.kind === 'portal' ? Math.min(1.8, 1.1 + span * 0.02) : 1.0 + Math.min(0.6, lay.capHalf * 0.05);
  const soffit = f.y - DECK_DEPTH;
  const env = envelopeUnder(obs, f.x, f.z, f.rx, f.rz, p.capL, p.capR, p.capThick + 0.2, f.y);
  const room = soffit - env - 0.1;
  p.capDepth = room >= want ? want : room >= 0.45 ? room : 0;
  // The columns' own height: under the cap, with a little room at least.
  for (const c of p.columns) if (soffit - p.capDepth - c.ground < 1) return null;
  return p;
}

/**
 * Where a deck's supports go: one slot every span, each shifted along the deck to
 * the cheapest spot within reach, a portal frame where no column fits under the
 * deck, and a long girder span over slots where nothing can stand.
 */
export function planSupports(net: RoadNetwork | null, deck: DeckInput): PierPlan {
  // A placed deck is planned once per network version: the joint pass in roads.ts
  // and the pier pass here ask for the same plan.
  if (net && deck.self !== null && deck.frames.length >= 2) {
    let cache = planCache.get(net);
    const key = `${net.version}:${terrainEditVersion()}`;
    if (!cache || cache.key !== key) {
      cache = { key, plans: new Map() };
      planCache.set(net, cache);
    }
    const sig = `${deck.def.id}:${deck.frames[0].s.toFixed(2)}:${deck.frames[deck.frames.length - 1].s.toFixed(2)}`;
    const hit = cache.plans.get(deck.self);
    if (hit && hit.sig === sig) return hit.plan;
    const plan = planUncached(net, deck);
    cache.plans.set(deck.self, { sig, plan });
    return plan;
  }
  return planUncached(net, deck);
}

const planCache = new WeakMap<RoadNetwork, { key: string; plans: Map<Id, { sig: string; plan: PierPlan }> }>();

function planUncached(net: RoadNetwork | null, deck: DeckInput): PierPlan {
  const { frames, def } = deck;
  const plan: PierPlan = { piers: [], girders: [] };
  if (frames.length < 2) return plan;
  const raised = frames.filter((f) => f.c >= (f.viaduct ? 1.4 : MIN_PIER_CLEARANCE));
  if (raised.length === 0) return plan;
  const hw = totalHalfWidth(def);
  // Rail viaducts have regular, shorter spans than road bridges.
  const spacing = def.category === 'rail' ? 30 : 34;
  const maxNudge = spacing * 0.45;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let topY = -Infinity;
  for (const f of raised) {
    minX = Math.min(minX, f.x);
    maxX = Math.max(maxX, f.x);
    minZ = Math.min(minZ, f.z);
    maxZ = Math.max(maxZ, f.z);
    topY = Math.max(topY, f.y);
  }
  const pad = PORTAL_REACH + hw + 4;
  const obs = net ? gatherObstacles(net, { minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad }, { self: deck.self, nodes: deck.nodes, topY }) : [];
  const s0 = frames[0].s;
  const s1 = frames[frames.length - 1].s;
  const missed: number[] = [];
  let prev = -Infinity;
  const nudges: number[] = [0];
  for (let d = NUDGE_STEP; d <= maxNudge; d += NUDGE_STEP) nudges.push(d, -d);
  for (let k = Math.ceil((s0 + 4) / spacing); k * spacing < s1 - 4; k++) {
    const home = k * spacing;
    let best: PlannedPier | null = null;
    for (const nudge of nudges) {
      const along = Math.abs(nudge) * NUDGE_COST;
      if (best && along >= best.cost) break;
      const s = home + nudge;
      if (s < s0 + 4 || s > s1 - 4 || s < prev + MIN_PIER_GAP) continue;
      const f = frameAt(frames, s);
      if (!f || f.c < (f.viaduct ? 1.4 : MIN_PIER_CLEARANCE)) continue;
      const near = obs.filter((o) => o.maxX > f.x - pad && o.minX < f.x + pad && o.maxZ > f.z - pad && o.minZ < f.z + pad);
      const p = bestAt(net, f, def, near);
      if (!p) continue;
      p.cost += along;
      if (!best || p.cost < best.cost) best = p;
    }
    if (best) {
      plan.piers.push(best);
      prev = best.f.s;
    } else {
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

/** The single column under an elevated junction, clear of what is below; null when none fits. */
export function planNodeSupport(net: RoadNetwork, nodeId: Id): { x: number; z: number; rc: number; ground: number; top: number } | null {
  const node = net.getNode(nodeId);
  const g = net.nodeGeom(nodeId);
  if (!node || !g || g.outline.length < 3) return null;
  const y = node.pos.y + ROAD_LIFT;
  const ground0 = groundHeight(net, node.pos.x, node.pos.z);
  if (node.pos.y - ground0 < MIN_PIER_CLEARANCE) return null;
  let reach = 0;
  for (const p of g.outline) reach = Math.max(reach, Math.hypot(p.x - node.pos.x, p.z - node.pos.z));
  const own = new Set(node.segments);
  const obs = gatherObstacles(
    net,
    { minX: node.pos.x - reach - 4, minZ: node.pos.z - reach - 4, maxX: node.pos.x + reach + 4, maxZ: node.pos.z + reach + 4 },
    { nodes: [nodeId], topY: y },
  ).filter((o) => !own.has(o.source) || o.poly !== undefined || o.kind === 'platform');
  const rc = 1.15;
  const r = rc + FOOTING;
  let best: { x: number; z: number; cost: number } | null = null;
  for (let ring = 0; ring * 1.5 <= reach; ring++) {
    const d = ring * 1.5;
    if (best && d * 0.3 >= best.cost) break;
    const n = ring === 0 ? 1 : Math.max(8, Math.round(d * 2.5));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = node.pos.x + Math.cos(a) * d;
      const z = node.pos.z + Math.sin(a) * d;
      // Under the junction deck itself, well inside its edge.
      if (polyDistance(g.outline, x, z) > -(r + 0.5)) continue;
      const c = columnCost(net, obs, x, z, r, y, false);
      if (!Number.isFinite(c)) continue;
      const cost = c + d * 0.3;
      if (!best || cost < best.cost) best = { x, z, cost };
    }
  }
  if (!best) return null;
  const b = best as { x: number; z: number; cost: number };
  return { x: b.x, z: b.z, rc, ground: groundHeight(net, b.x, b.z), top: y - DECK_DEPTH };
}
