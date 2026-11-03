/**
 * Landscaping: the player's edits to the land, as a sparse grid of height offsets.
 *
 * Order of operations for ground height:
 *   1. baseTerrainHeight(x, z)  the generated land (core/terrain.ts)
 *   2. + editDelta(x, z)        this layer, bilinear over a 2 m grid
 *      = terrainHeight(x, z)    what every system reads
 *   3. terrainMods on top       embankments, cuts and quays (core/terrainMods.ts,
 *      = groundHeight(net, ..)  the walls module), which use terrainHeight as the land
 *
 * Two grids, both in 64 m tiles of 32 x 32 points allocated only where edited:
 *   raw  what the player painted. Saved in Project.terrain. Every brush tick is
 *        clamped against the roads standing at the time (see Constraints), so raw
 *        never buries a road or pokes through a bridge.
 *   eff  raw conformed to the roads standing now, so a road drawn later over edited
 *        land still has ground meeting its edges. Derived, never saved. This is what
 *        terrainHeight and the GPU sample (render/terrainEdits.ts uploads eff tiles
 *        to a float texture and the ground shader does the same bilinear lookup).
 *
 * Roads constrain the ground around them (see constrain()): a ground road holds the
 * ground at its own height across its width plus a 3 m shoulder, then lets it slope
 * away at 1:1.5 (the walls module's SLOPE_RUN) up to 60 m out. A bridge keeps the
 * ground DECK_CLEAR under its deck; a tunnel keeps COVER of ground over it. Roads
 * with walls-module earthworks hold the land at or below (raised) or at or above
 * (sunk) the road, and the walls module shapes the rest.
 *
 * Water: only ground below WATER_LEVEL connected to the river floods (a flood
 * fill from the river's own channel, computeWet). Pits, cuts and valleys dug
 * elsewhere stay dry; a channel dug through to the river lets it in. Points the
 * player painted with "Let water in" (`flags`, saved) seed water too, for ponds.
 * Roads, trenches and tunnels block water and are never covered by it. isWater,
 * the water shader and the ground's dug-earth colouring all read the same mask.
 */
import type { NetworkChange, RoadNetwork } from './RoadNetwork';
import { totalHalfWidth } from './roadTypes';
import { baseTerrainHeight, bumpTerrainEditVersion, MAP_HALF_SIZE, MAX_ELEVATION, MIN_ELEVATION, setTerrainEditSampler, setTerrainWaterSampler, terrainEditVersion as landVersion, WATER_LEVEL } from './terrain';
import type { Id, TerrainData, Vec3 } from './types';
import { isEarthwork, isRaisedEarth, SLOPE_RUN, structureExtents, structureOf } from './walls';

export const EDIT_CELL = 2;
export const EDIT_ORIGIN = -2048;
/** Grid points per side. Point i sits at EDIT_ORIGIN + i * EDIT_CELL. */
export const EDIT_POINTS = 2048;
/** Points per tile side. */
export const EDIT_TILE = 32;
/** Tiles per side. */
export const EDIT_TILES = EDIT_POINTS / EDIT_TILE;
const TILE_PTS = EDIT_TILE * EDIT_TILE;
const INV_CELL = 1 / EDIT_CELL;
/** Points on or past the map edge stay unedited, so the land meets the hills. */
const EDGE_LO = Math.floor((-MAP_HALF_SIZE - EDIT_ORIGIN) / EDIT_CELL) + 1;
const EDGE_HI = Math.ceil((MAP_HALF_SIZE - EDIT_ORIGIN) / EDIT_CELL) - 1;

/** Natural slope beside a road, rise per metre of run. */
export const SIDE_SLOPE = 1 / SLOPE_RUN;
/** Flat shoulder past a road's edge. More than a cell diagonal, so bilinear ground is exact at the edge. */
export const ROAD_SHOULDER = 3;
/** How far out a road's slopes can reach. */
export const ROAD_REACH = 60;
/** Ground stays this far under a bridge deck. */
export const DECK_CLEAR = 2.5;
/** Ground stays this far over a tunnel's road surface. */
export const TUNNEL_COVER = 2.5;

export interface EditBox {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export type ClampKind = 'road' | 'bridge' | 'tunnel';

export function tileKey(ti: number, tj: number): number {
  return tj * EDIT_TILES + ti;
}

export function tileBox(key: number): EditBox {
  const ti = key % EDIT_TILES;
  const tj = Math.floor(key / EDIT_TILES);
  const span = EDIT_TILE * EDIT_CELL;
  const minX = EDIT_ORIGIN + ti * span;
  const minZ = EDIT_ORIGIN + tj * span;
  return { minX, minZ, maxX: minX + span, maxZ: minZ + span };
}

function unionBox(a: EditBox | null, b: EditBox): EditBox {
  if (!a) return { ...b };
  return { minX: Math.min(a.minX, b.minX), minZ: Math.min(a.minZ, b.minZ), maxX: Math.max(a.maxX, b.maxX), maxZ: Math.max(a.maxZ, b.maxZ) };
}

function grow(b: EditBox, d: number): EditBox {
  return { minX: b.minX - d, minZ: b.minZ - d, maxX: b.maxX + d, maxZ: b.maxZ + d };
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

export class TerrainEditGrid {
  readonly raw: (Float32Array | null)[] = new Array(EDIT_TILES * EDIT_TILES).fill(null);
  readonly eff: (Float32Array | null)[] = new Array(EDIT_TILES * EDIT_TILES).fill(null);
  private readonly baseTiles: (Float32Array | null)[] = new Array(EDIT_TILES * EDIT_TILES).fill(null);
  /** "Let water in": points the player opened to water, saved. 1 open. */
  readonly flags: (Uint8Array | null)[] = new Array(EDIT_TILES * EDIT_TILES).fill(null);
  /** Derived water: 1 wet, 0 dry, for tiles in the water domain (computeWet). */
  wet: (Uint8Array | null)[] = new Array(EDIT_TILES * EDIT_TILES).fill(null);
  effCount = 0;
  rawCount = 0;

  /** Generated land height at a grid point, cached per tile. */
  base(i: number, j: number): number {
    const k = (j >> 5) * EDIT_TILES + (i >> 5);
    let t = this.baseTiles[k];
    if (!t) {
      t = new Float32Array(TILE_PTS);
      const i0 = (i >> 5) << 5;
      const j0 = (j >> 5) << 5;
      for (let b = 0; b < EDIT_TILE; b++) {
        for (let a = 0; a < EDIT_TILE; a++) t[(b << 5) | a] = baseTerrainHeight(EDIT_ORIGIN + (i0 + a) * EDIT_CELL, EDIT_ORIGIN + (j0 + b) * EDIT_CELL);
      }
      this.baseTiles[k] = t;
    }
    return t[((j & 31) << 5) | (i & 31)];
  }

  getRaw(i: number, j: number): number {
    if (i < 0 || j < 0 || i >= EDIT_POINTS || j >= EDIT_POINTS) return 0;
    const t = this.raw[(j >> 5) * EDIT_TILES + (i >> 5)];
    return t ? t[((j & 31) << 5) | (i & 31)] : 0;
  }

  setRaw(i: number, j: number, v: number): void {
    const k = (j >> 5) * EDIT_TILES + (i >> 5);
    let t = this.raw[k];
    if (!t) {
      if (v === 0) return;
      t = this.raw[k] = new Float32Array(TILE_PTS);
      this.rawCount++;
    }
    t[((j & 31) << 5) | (i & 31)] = v;
  }

  getEff(i: number, j: number): number {
    if (i < 0 || j < 0 || i >= EDIT_POINTS || j >= EDIT_POINTS) return 0;
    const t = this.eff[(j >> 5) * EDIT_TILES + (i >> 5)];
    return t ? t[((j & 31) << 5) | (i & 31)] : 0;
  }

  /** Store a whole eff tile, or free it when all zero. */
  putEff(k: number, t: Float32Array | null): void {
    let any = false;
    if (t) {
      for (let n = 0; n < TILE_PTS; n++) {
        if (t[n] !== 0) {
          any = true;
          break;
        }
      }
    }
    const had = this.eff[k] !== null;
    if (any) {
      this.eff[k] = t;
      if (!had) this.effCount++;
    } else if (had) {
      this.eff[k] = null;
      this.effCount--;
    }
  }

  /** Free raw tiles that are all zero. */
  pruneRaw(k: number): void {
    const t = this.raw[k];
    if (!t) return;
    for (let n = 0; n < TILE_PTS; n++) if (t[n] !== 0) return;
    this.raw[k] = null;
    this.rawCount--;
  }

  clear(): void {
    this.raw.fill(null);
    this.eff.fill(null);
    this.effCount = 0;
    this.rawCount = 0;
    this.flags.fill(null);
    this.wet = new Array(EDIT_TILES * EDIT_TILES).fill(null);
  }

  /** The landscaping offset at a plan point, bilinear between grid points. The hot path. */
  sample(x: number, z: number): number {
    const gx = (x - EDIT_ORIGIN) * INV_CELL;
    const gz = (z - EDIT_ORIGIN) * INV_CELL;
    if (!(gx >= 0 && gz >= 0 && gx < EDIT_POINTS - 1 && gz < EDIT_POINTS - 1)) return 0;
    const i = gx | 0;
    const j = gz | 0;
    const fx = gx - i;
    const fz = gz - j;
    const li = i & 31;
    const lj = j & 31;
    let a: number;
    let b: number;
    let c: number;
    let d: number;
    if (li < 31 && lj < 31) {
      const t = this.eff[(j >> 5) * EDIT_TILES + (i >> 5)];
      if (!t) return 0;
      const k = (lj << 5) | li;
      a = t[k];
      b = t[k + 1];
      c = t[k + 32];
      d = t[k + 33];
    } else {
      a = this.getEff(i, j);
      b = this.getEff(i + 1, j);
      c = this.getEff(i, j + 1);
      d = this.getEff(i + 1, j + 1);
    }
    // Same order of operations as the GLSL: mix(mix(a, b, fx), mix(c, d, fx), fz).
    const top = a + (b - a) * fx;
    const bot = c + (d - c) * fx;
    return top + (bot - top) * fz;
  }

  /** Bilinear raw offset, for classifying roads against the painted land. */
  sampleRaw(x: number, z: number): number {
    const gx = (x - EDIT_ORIGIN) * INV_CELL;
    const gz = (z - EDIT_ORIGIN) * INV_CELL;
    if (!(gx >= 0 && gz >= 0 && gx < EDIT_POINTS - 1 && gz < EDIT_POINTS - 1)) return 0;
    const i = gx | 0;
    const j = gz | 0;
    const fx = gx - i;
    const fz = gz - j;
    const top = this.getRaw(i, j) + (this.getRaw(i + 1, j) - this.getRaw(i, j)) * fx;
    const bot = this.getRaw(i, j + 1) + (this.getRaw(i + 1, j + 1) - this.getRaw(i, j + 1)) * fx;
    return top + (bot - top) * fz;
  }

  /** True when any raw tile touches the box. */
  anyRawIn(b: EditBox): boolean {
    if (this.rawCount === 0) return false;
    const r = tileRange(b);
    for (let tj = r.tj0; tj <= r.tj1; tj++) for (let ti = r.ti0; ti <= r.ti1; ti++) if (this.raw[tj * EDIT_TILES + ti]) return true;
    return false;
  }

  /** Keys of tiles with eff offsets. */
  effTiles(): number[] {
    const out: number[] = [];
    for (let k = 0; k < this.eff.length; k++) if (this.eff[k]) out.push(k);
    return out;
  }
}

function tileRange(b: EditBox): { ti0: number; ti1: number; tj0: number; tj1: number } {
  const span = EDIT_TILE * EDIT_CELL;
  const c = (v: number) => Math.max(0, Math.min(EDIT_TILES - 1, Math.floor((v - EDIT_ORIGIN) / span)));
  return { ti0: c(b.minX), ti1: c(b.maxX), tj0: c(b.minZ), tj1: c(b.maxZ) };
}

// ---------------------------------------------------------------------------
// Road constraints
// ---------------------------------------------------------------------------

const enum Kind {
  Ground = 0,
  Above = 1,
  Below = 2,
}

interface Piece {
  ax: number;
  az: number;
  ay: number;
  bx: number;
  bz: number;
  by: number;
  /** Half width, sidewalks included. */
  w: number;
  kind: Kind;
  /** Clearance under (Above) or cover over (Below) the road surface. */
  clear: number;
  /** Earthworks hold the land only under the road; the walls module does the rest. */
  reach: number;
  /**
   * The road carries on past this end in another piece, which answers for the
   * points beyond it, so this one does not cap them (a cap would hold them at
   * the joint's height and fight the next piece on a grade).
   */
  openA?: boolean;
  openB?: boolean;
  /** Half width water may not cross. 0: water passes (a bridge). */
  bar: number;
}

const CELL = 32;

/**
 * Where roads hold the ground: pieces of road between stations and pads under
 * junctions, in a coarse hash, covering only roads near edited land.
 */
export class Constraints {
  private readonly cells = new Map<number, Piece[]>();
  readonly segBoxes = new Map<Id, EditBox>();
  readonly nodeBoxes = new Map<Id, EditBox>();
  count = 0;
  /** What set the bound in the last constrain() call that clamped. */
  lastClamp: ClampKind | null = null;

  private key(ci: number, cj: number): number {
    return (ci + 512) * 1024 + (cj + 512);
  }

  add(p: Piece): void {
    const reach = p.w + p.reach;
    const i0 = Math.floor((Math.min(p.ax, p.bx) - reach) / CELL);
    const i1 = Math.floor((Math.max(p.ax, p.bx) + reach) / CELL);
    const j0 = Math.floor((Math.min(p.az, p.bz) - reach) / CELL);
    const j1 = Math.floor((Math.max(p.az, p.bz) + reach) / CELL);
    for (let ci = i0; ci <= i1; ci++) {
      for (let cj = j0; cj <= j1; cj++) {
        const k = this.key(ci, cj);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(p);
      }
    }
    this.count++;
  }

  /** True where a road, trench or tunnel stands, which water may not cover or cross. */
  blocksWater(x: number, z: number): boolean {
    const list = this.cells.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return false;
    for (let n = 0; n < list.length; n++) {
      const p = list[n];
      if (p.bar <= 0) continue;
      const dx = p.bx - p.ax;
      const dz = p.bz - p.az;
      const len2 = dx * dx + dz * dz;
      let f = len2 > 1e-9 ? ((x - p.ax) * dx + (z - p.az) * dz) / len2 : 0;
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      const ox = x - (p.ax + dx * f);
      const oz = z - (p.az + dz * f);
      if (ox * ox + oz * oz <= p.bar * p.bar) return true;
    }
    return false;
  }

  /**
   * The ground height g at (x, z) brought within what the roads allow. `base` is
   * the generated land there: where the river's own banks already sit below a
   * road's band, the band does not lift them.
   */
  constrain(x: number, z: number, g: number, base: number): number {
    const list = this.cells.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return g;
    let lo = -Infinity;
    let hi = Infinity;
    let loKind: ClampKind = 'road';
    let hiKind: ClampKind = 'road';
    for (let n = 0; n < list.length; n++) {
      const p = list[n];
      const dx = p.bx - p.ax;
      const dz = p.bz - p.az;
      const len2 = dx * dx + dz * dz;
      let f = len2 > 1e-9 ? ((x - p.ax) * dx + (z - p.az) * dz) / len2 : 0;
      if ((f < 0 && p.openA) || (f > 1 && p.openB)) continue;
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      const ox = x - (p.ax + dx * f);
      const oz = z - (p.az + dz * f);
      const o = Math.sqrt(ox * ox + oz * oz);
      if (o > p.w + p.reach) continue;
      const y = p.ay + (p.by - p.ay) * f;
      if (p.kind === Kind.Ground) {
        const e = p.w + ROAD_SHOULDER;
        const d = o <= e ? 0 : SIDE_SLOPE * (o - e);
        if (y - d > lo) {
          lo = y - d;
          loKind = 'road';
        }
        if (y + d < hi) {
          hi = y + d;
          hiKind = 'road';
        }
      } else {
        const e = p.w + 2;
        const d = o <= e ? 0 : SIDE_SLOPE * (o - e);
        if (p.kind === Kind.Above) {
          const h = y - p.clear + d;
          if (h < hi) {
            hi = h;
            hiKind = 'bridge';
          }
        } else {
          const h = y + p.clear - d;
          if (h > lo) {
            lo = h;
            loKind = 'tunnel';
          }
        }
      }
    }
    if (lo === -Infinity && hi === Infinity) return g;
    if (lo > hi) {
      // At an abutment or a portal the road on the ground wins, so it is never left hanging.
      const v = loKind === 'road' && hiKind !== 'road' ? lo : hiKind === 'road' && loKind !== 'road' ? hi : (lo + hi) / 2;
      lo = v;
      hi = v;
    }
    // The river's own banks beside a road stay as generated.
    if (base < 0 && base < lo) lo = base;
    if (g < lo) {
      this.lastClamp = loKind;
      return lo;
    }
    if (g > hi) {
      this.lastClamp = hiKind;
      return hi;
    }
    return g;
  }
}

/** Plan box of a run of stations, widened. */
function stationsBox(pts: readonly { pos: Vec3 }[], pad: number): EditBox {
  let b: EditBox = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const s of pts) b = { minX: Math.min(b.minX, s.pos.x), minZ: Math.min(b.minZ, s.pos.z), maxX: Math.max(b.maxX, s.pos.x), maxZ: Math.max(b.maxZ, s.pos.z) };
  return grow(b, pad);
}

/** How a road at height y sits on the painted land at (x, z). */
function classify(grid: TerrainEditGrid, x: number, z: number, y: number): Kind {
  const r = grid.sampleRaw(x, z);
  const g0 = baseTerrainHeight(x, z) + r;
  if (y - g0 > 1) return Kind.Above;
  if (y < Math.max(g0, Math.min(0, r)) - 1.5) return Kind.Below;
  return Kind.Ground;
}

function overlaps(a: EditBox, b: EditBox): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minZ <= b.maxZ && b.minZ <= a.maxZ;
}

/** Constraints from every road and junction near edited land, or near the `extra` areas about to be edited. */
export function buildConstraints(net: RoadNetwork, grid: TerrainEditGrid, extra: readonly EditBox[] = []): Constraints {
  const out = new Constraints();
  if (grid.rawCount === 0 && !extra.length) return out;
  const near = (b: EditBox) => grid.anyRawIn(b) || extra.some((e) => overlaps(e, b));
  // A node joining just two roads is a plain joint: the next road answers past it, with no pad.
  const joint = (id: Id) => (net.getNode(id)?.segments.length ?? 0) === 2;
  // How the road ends meeting each node sit, so a junction pad agrees with its roads.
  const endKinds = new Map<Id, Kind[]>();
  const endKind = (id: Id, k: Kind) => {
    const list = endKinds.get(id);
    if (list) list.push(k);
    else endKinds.set(id, [k]);
  };
  for (const seg of net.segments) {
    const stations = net.curveOf(seg.id).stations;
    if (stations.length < 2) continue;
    const def = net.roadTypeOf(seg.id);
    const w = totalHalfWidth(def);
    const box = stationsBox(stations, w + ROAD_REACH);
    if (!near(box)) continue;
    out.segBoxes.set(seg.id, box);
    const mode = structureOf(seg.overrides).mode;
    const earth = isEarthwork(mode);
    // Water never covers a road, a trench floor and its cut, or a tunnel's portal.
    let earthBar = 0;
    if (earth) {
      const ext = structureExtents(net, seg.id);
      earthBar = Math.max(ext.left, ext.right) + 1;
    }
    for (let i = 0; i + 1 < stations.length; i++) {
      const a = stations[i].pos;
      const b = stations[i + 1].pos;
      let kind: Kind;
      let clear = 0;
      let reach = ROAD_REACH;
      if (earth) {
        kind = isRaisedEarth(mode) ? Kind.Above : Kind.Below;
        reach = 0;
      } else if (mode === 'pillars') {
        kind = Kind.Above;
        clear = DECK_CLEAR;
      } else if (mode === 'tunnel') {
        kind = Kind.Below;
        clear = TUNNEL_COVER;
      } else {
        kind = classify(grid, (a.x + b.x) / 2, (a.z + b.z) / 2, (a.y + b.y) / 2);
        clear = kind === Kind.Above ? DECK_CLEAR : kind === Kind.Below ? TUNNEL_COVER : 0;
      }
      const bar = earth ? earthBar : kind === Kind.Above ? 0 : w + 1;
      out.add({ ax: a.x, az: a.z, ay: a.y, bx: b.x, bz: b.z, by: b.y, w, kind, clear, reach, openA: i > 0 || joint(seg.a), openB: i + 2 < stations.length || joint(seg.b), bar });
      if (i === 0) endKind(seg.a, kind);
      if (i + 2 === stations.length) endKind(seg.b, kind);
    }
  }
  for (const node of net.nodes) {
    if (!node.segments.length || node.segments.length === 2) continue;
    let r = 0;
    let earth = false;
    for (const id of node.segments) {
      const seg = net.getSegment(id);
      if (!seg) continue;
      r = Math.max(r, totalHalfWidth(net.roadTypeOf(id)));
      if (isEarthwork(structureOf(seg.overrides).mode)) earth = true;
    }
    if (earth) continue;
    const box = grow({ minX: node.pos.x, minZ: node.pos.z, maxX: node.pos.x, maxZ: node.pos.z }, r * 2 + ROAD_REACH + 40);
    if (!near(box)) continue;
    const g = node.segments.length > 2 ? net.nodeGeom(node.id) : undefined;
    if (g && g.kind === 'junction') {
      const outline = g.outerOutline.length ? g.outerOutline : g.arms.flatMap((a) => [a.leftEdge, a.rightEdge]);
      for (const p of outline) r = Math.max(r, Math.hypot(p.x - node.pos.x, p.z - node.pos.z));
    }
    out.nodeBoxes.set(node.id, box);
    const { x, y, z } = node.pos;
    const ends = endKinds.get(node.id);
    const kind = !ends ? classify(grid, x, z, y) : ends.includes(Kind.Ground) ? Kind.Ground : ends.every((k) => k === Kind.Above) ? Kind.Above : ends.every((k) => k === Kind.Below) ? Kind.Below : Kind.Ground;
    out.add({ ax: x, az: z, ay: y, bx: x, bz: z, by: y, w: r, kind, clear: kind === Kind.Above ? DECK_CLEAR : kind === Kind.Below ? TUNNEL_COVER : 0, reach: ROAD_REACH, bar: kind === Kind.Above ? 0 : r + 1 });
  }
  return out;
}

/**
 * Recompute eff from raw in every raw tile touching the box, conformed to the
 * roads. Returns the keys of tiles whose eff changed.
 */
export function conformRegion(grid: TerrainEditGrid, cons: Constraints, box: EditBox | null): number[] {
  const changed: number[] = [];
  const r = box ? tileRange(box) : { ti0: 0, ti1: EDIT_TILES - 1, tj0: 0, tj1: EDIT_TILES - 1 };
  for (let tj = r.tj0; tj <= r.tj1; tj++) {
    for (let ti = r.ti0; ti <= r.ti1; ti++) {
      const k = tj * EDIT_TILES + ti;
      const raw = grid.raw[k];
      const old = grid.eff[k];
      if (!raw) {
        if (old) {
          grid.putEff(k, null);
          changed.push(k);
        }
        continue;
      }
      const eff = new Float32Array(TILE_PTS);
      let diff = !old;
      for (let b = 0; b < EDIT_TILE; b++) {
        const j = (tj << 5) | b;
        const z = EDIT_ORIGIN + j * EDIT_CELL;
        for (let a = 0; a < EDIT_TILE; a++) {
          const n = (b << 5) | a;
          const v = raw[n];
          if (v === 0) continue;
          const i = (ti << 5) | a;
          const base = grid.base(i, j);
          let g = cons.constrain(EDIT_ORIGIN + i * EDIT_CELL, z, base + v, base);
          g = g < MIN_ELEVATION ? MIN_ELEVATION : g > MAX_ELEVATION ? MAX_ELEVATION : g;
          eff[n] = g - base;
          if (!diff && old![n] !== eff[n]) diff = true;
        }
      }
      if (!diff) continue;
      grid.putEff(k, eff);
      changed.push(k);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Brushes
// ---------------------------------------------------------------------------

export type BrushOp = 'raise' | 'lower' | 'level' | 'soften' | 'slope';
export type BrushShape = 'soft' | 'hard';

export interface BrushParams {
  op: BrushOp;
  x: number;
  z: number;
  radius: number;
  /** 0 to 1. */
  strength: number;
  /** Seconds this tick covers. */
  dt: number;
  shape: BrushShape;
  /** Level: the height to flatten to. */
  target?: number;
  /** "Let water in": open the painted ground to water even if it does not reach the river. */
  letWater?: boolean;
  /** Slope: the two ends, with their heights. */
  from?: Vec3;
  to?: Vec3;
}

export interface BrushResult {
  box: EditBox | null;
  /** Tiles whose eff changed. */
  tiles: number[];
  /** Set when a road, bridge or tunnel held the ground back somewhere in this tick. */
  clamped: ClampKind | null;
  /** "Let water in" opened new ground to water. */
  flagged?: boolean;
}

export const BRUSH_MIN_RADIUS = 4;
export const BRUSH_MAX_RADIUS = 240;
/** Raise and Lower at full strength, metres per second at the centre. */
export const SHIFT_RATE = 24;

function smooth01(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/** Brush weight at a fraction of the radius: 1 at the centre, 0 at the rim. */
export function brushWeight(u: number, shape: BrushShape): number {
  if (u >= 1) return 0;
  return shape === 'hard' ? 1 - smooth01((u - 0.82) / 0.18) : 1 - smooth01(u);
}

/** Box blur over a w x h array, radius r, both directions. */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        s += src[y * w + k];
        c++;
      }
      tmp[y * w + x] = s / c;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        s += tmp[k * w + x];
        c++;
      }
      out[y * w + x] = s / c;
    }
  }
  return out;
}

/**
 * One tick of a brush. Writes raw and eff together (the clamp bakes the roads in),
 * so it costs the brush's own area and nothing more.
 */
export function applyBrush(grid: TerrainEditGrid, cons: Constraints, p: BrushParams): BrushResult {
  const r = Math.max(BRUSH_MIN_RADIUS, Math.min(BRUSH_MAX_RADIUS, p.radius));
  const i0 = Math.max(EDGE_LO, Math.ceil((p.x - r - EDIT_ORIGIN) * INV_CELL));
  const i1 = Math.min(EDGE_HI, Math.floor((p.x + r - EDIT_ORIGIN) * INV_CELL));
  const j0 = Math.max(EDGE_LO, Math.ceil((p.z - r - EDIT_ORIGIN) * INV_CELL));
  const j1 = Math.min(EDGE_HI, Math.floor((p.z + r - EDIT_ORIGIN) * INV_CELL));
  if (i1 < i0 || j1 < j0) return { box: null, tiles: [], clamped: null };
  const strength = Math.max(0, Math.min(1, p.strength));
  const dt = Math.max(0, Math.min(0.1, p.dt));
  // Soften needs the neighbours, so it reads a padded window first.
  let blurred: Float32Array | null = null;
  let pad = 0;
  let ww = 0;
  if (p.op === 'soften') {
    pad = Math.max(1, Math.min(6, Math.round(r / 12 / EDIT_CELL)));
    ww = i1 - i0 + 1 + pad * 2;
    const hh = j1 - j0 + 1 + pad * 2;
    const win = new Float32Array(ww * hh);
    for (let b = 0; b < hh; b++) {
      for (let a = 0; a < ww; a++) {
        const i = Math.max(0, Math.min(EDIT_POINTS - 1, i0 - pad + a));
        const j = Math.max(0, Math.min(EDIT_POINTS - 1, j0 - pad + b));
        win[b * ww + a] = grid.base(i, j) + grid.getEff(i, j);
      }
    }
    blurred = boxBlur(win, ww, hh, pad);
  }
  let slopeDx = 0;
  let slopeDz = 0;
  let slopeLen2 = 0;
  if (p.op === 'slope' && p.from && p.to) {
    slopeDx = p.to.x - p.from.x;
    slopeDz = p.to.z - p.from.z;
    slopeLen2 = slopeDx * slopeDx + slopeDz * slopeDz;
  }
  const approach = (1 + 14 * strength) * dt;
  cons.lastClamp = null;
  let clamped: ClampKind | null = null;
  // eff equals raw inside the brush (the clamp is idempotent), so both are written together.
  const work = new Map<number, Float32Array>();
  let flagged = false;
  for (let j = j0; j <= j1; j++) {
    const z = EDIT_ORIGIN + j * EDIT_CELL;
    for (let i = i0; i <= i1; i++) {
      const x = EDIT_ORIGIN + i * EDIT_CELL;
      const u = Math.hypot(x - p.x, z - p.z) / r;
      const w = brushWeight(u, p.shape);
      if (w <= 0) continue;
      const base = grid.base(i, j);
      const before = base + grid.getEff(i, j);
      let g = before;
      switch (p.op) {
        case 'raise':
          g += SHIFT_RATE * strength * dt * w;
          break;
        case 'lower':
          g -= SHIFT_RATE * strength * dt * w;
          break;
        case 'level':
          if (p.target !== undefined) g += (p.target - g) * Math.min(1, w * approach);
          break;
        case 'slope': {
          if (!p.from || !p.to) break;
          let t = slopeLen2 > 1e-9 ? ((x - p.from.x) * slopeDx + (z - p.from.z) * slopeDz) / slopeLen2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const target = p.from.y + (p.to.y - p.from.y) * t;
          g += (target - g) * Math.min(1, w * approach);
          break;
        }
        case 'soften': {
          const bv = blurred![(j - j0 + pad) * ww + (i - i0 + pad)];
          g += (bv - g) * Math.min(1, w * (1 + 10 * strength) * dt * 2);
          break;
        }
      }
      if (p.letWater && w > 0.25) {
        const fk = (j >> 5) * EDIT_TILES + (i >> 5);
        let ft = grid.flags[fk];
        if (!ft) ft = grid.flags[fk] = new Uint8Array(TILE_PTS);
        if (!ft[((j & 31) << 5) | (i & 31)]) {
          ft[((j & 31) << 5) | (i & 31)] = 1;
          flagged = true;
        }
      }
      if (g === before) continue;
      g = g < MIN_ELEVATION ? MIN_ELEVATION : g > MAX_ELEVATION ? MAX_ELEVATION : g;
      const held = cons.constrain(x, z, g, base);
      if (Math.abs(held - g) > 0.02 && cons.lastClamp) clamped = cons.lastClamp;
      let v = held - base;
      if (Math.abs(v) < 1e-4) v = 0;
      const k = (j >> 5) * EDIT_TILES + (i >> 5);
      grid.setRaw(i, j, v);
      let eff = work.get(k);
      if (!eff) {
        const old = grid.eff[k];
        eff = old ? old.slice() : new Float32Array(TILE_PTS);
        work.set(k, eff);
      }
      eff[((j & 31) << 5) | (i & 31)] = v;
    }
  }
  const tiles: number[] = [];
  for (const [k, eff] of work) {
    grid.putEff(k, eff);
    grid.pruneRaw(k);
    tiles.push(k);
  }
  const x0 = EDIT_ORIGIN + i0 * EDIT_CELL;
  const z0 = EDIT_ORIGIN + j0 * EDIT_CELL;
  return { box: { minX: x0, minZ: z0, maxX: EDIT_ORIGIN + i1 * EDIT_CELL, maxZ: EDIT_ORIGIN + j1 * EDIT_CELL }, tiles, clamped, flagged };
}

/** The ground height at a point under this layer, for sampling targets. */
export function editedHeight(grid: TerrainEditGrid, x: number, z: number): number {
  return baseTerrainHeight(x, z) + grid.sample(x, z);
}

// ---------------------------------------------------------------------------
// Save format: tiles of centimetres, planar prediction, zero runs, varints, base64
// ---------------------------------------------------------------------------

function pushVarint(out: number[], v: number): void {
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Round raw offsets to the centimetre the save keeps, so a reload is exact. */
export function quantizeRaw(grid: TerrainEditGrid, keys: Iterable<number>): void {
  for (const k of keys) {
    const t = grid.raw[k];
    if (!t) continue;
    for (let n = 0; n < TILE_PTS; n++) t[n] = Math.round(t[n] * 100) / 100;
    grid.pruneRaw(k);
  }
}

/** Pack tiles of integers: tile skips, planar prediction, zero runs, varints, base64. */
function packTiles(tiles: readonly (ArrayLike<number> | null)[], scale: number): string | undefined {
  const out: number[] = [];
  let prev = -1;
  let count = 0;
  for (let k = 0; k < tiles.length; k++) {
    const t = tiles[k];
    if (!t) continue;
    let any = false;
    const q = new Int32Array(TILE_PTS);
    for (let n = 0; n < TILE_PTS; n++) {
      q[n] = Math.round(t[n] * scale);
      if (q[n] !== 0) any = true;
    }
    if (!any) continue;
    count++;
    pushVarint(out, k - prev - 1);
    prev = k;
    let run = 0;
    for (let n = 0; n < TILE_PTS; n++) {
      const a = n & 31;
      const b = n >> 5;
      const W = a > 0 ? q[n - 1] : 0;
      const N = b > 0 ? q[n - 32] : 0;
      const NW = a > 0 && b > 0 ? q[n - 33] : 0;
      const res = q[n] - (W + N - NW);
      if (res === 0) {
        run++;
        continue;
      }
      if (run) {
        out.push(0);
        pushVarint(out, run - 1);
        run = 0;
      }
      pushVarint(out, res > 0 ? res * 2 : -res * 2 - 1);
    }
    if (run) {
      out.push(0);
      pushVarint(out, run - 1);
    }
  }
  return count ? toBase64(Uint8Array.from(out)) : undefined;
}

/** Unpack what packTiles wrote, tile by tile. Throws on a malformed string. */
function unpackTiles(text: string, onTile: (k: number, q: Int32Array) => void): void {
  const bytes = fromBase64(text);
  let pos = 0;
  const varint = (): number => {
    let v = 0;
    let mul = 1;
    for (;;) {
      if (pos >= bytes.length) throw new Error('Landscaping data is cut short');
      const b = bytes[pos++];
      v += (b & 0x7f) * mul;
      if (b < 0x80) return v;
      mul *= 128;
    }
  };
  let k = -1;
  while (pos < bytes.length) {
    k += varint() + 1;
    if (k >= EDIT_TILES * EDIT_TILES) throw new Error('Landscaping tile out of range');
    const q = new Int32Array(TILE_PTS);
    let n = 0;
    const predict = (m: number) => {
      const a = m & 31;
      const b = m >> 5;
      return (a > 0 ? q[m - 1] : 0) + (b > 0 ? q[m - 32] : 0) - (a > 0 && b > 0 ? q[m - 33] : 0);
    };
    while (n < TILE_PTS) {
      const v = varint();
      if (v === 0) {
        const run = varint() + 1;
        for (let r = 0; r < run && n < TILE_PTS; r++, n++) q[n] = predict(n);
        continue;
      }
      q[n] = (v & 1 ? -(v + 1) / 2 : v / 2) + predict(n);
      n++;
    }
    onTile(k, q);
  }
}

export function encodeTerrain(grid: TerrainEditGrid): TerrainData | undefined {
  const tiles = packTiles(grid.raw, 100);
  const water = packTiles(grid.flags, 1);
  if (!tiles && !water) return undefined;
  return { v: 1, cell: EDIT_CELL, tiles: tiles ?? '', ...(water ? { water } : {}) };
}

/** Fill the grid's raw tiles and water flags from saved data. Throws on a malformed string. */
export function decodeTerrain(grid: TerrainEditGrid, data: TerrainData | undefined): void {
  grid.clear();
  if (!data) return;
  if (data.v !== 1 || data.cell !== EDIT_CELL) throw new Error('Unknown landscaping format');
  unpackTiles(data.tiles, (k, q) => {
    const t = new Float32Array(TILE_PTS);
    for (let m = 0; m < TILE_PTS; m++) t[m] = q[m] / 100;
    grid.raw[k] = t;
    grid.rawCount++;
    grid.pruneRaw(k);
  });
  if (data.water) {
    unpackTiles(data.water, (k, q) => {
      const t = new Uint8Array(TILE_PTS);
      for (let m = 0; m < TILE_PTS; m++) t[m] = q[m] ? 1 : 0;
      grid.flags[k] = t;
    });
  }
}

// ---------------------------------------------------------------------------
// Water: what connects to the river
// ---------------------------------------------------------------------------

/**
 * Tiles where landscaping decides water: edited tiles and the tiles before them
 * (whose cells reach their first points). Elsewhere the generated river decides.
 */
export function waterDomain(grid: TerrainEditGrid): Set<number> {
  const out = new Set<number>();
  const add = (k: number) => {
    out.add(k);
    const ti = k % EDIT_TILES;
    if (ti > 0) out.add(k - 1);
    if (k >= EDIT_TILES) out.add(k - EDIT_TILES);
    if (ti > 0 && k >= EDIT_TILES) out.add(k - EDIT_TILES - 1);
  };
  for (let k = 0; k < grid.eff.length; k++) if (grid.eff[k] || grid.flags[k]) add(k);
  return out;
}

/**
 * Flood fill from the river through ground below WATER_LEVEL, inside the water
 * domain. Seeds: the generated river channel, unedited river just outside the
 * domain, and ground opened with "Let water in". Roads, trenches and tunnels
 * block it. Returns the new wet tiles (1 wet, 0 dry) for the domain.
 */
export function computeWet(grid: TerrainEditGrid, cons: Constraints): (Uint8Array | null)[] {
  const wet: (Uint8Array | null)[] = new Array(EDIT_TILES * EDIT_TILES).fill(null);
  const domain = waterDomain(grid);
  if (!domain.size) return wet;
  const inDomain = (i: number, j: number) => i >= 0 && j >= 0 && i < EDIT_POINTS && j < EDIT_POINTS && domain.has((j >> 5) * EDIT_TILES + (i >> 5));
  for (const k of domain) wet[k] = new Uint8Array(TILE_PTS);
  // 0 unknown, 1 wet, 2 dry (seen and refused).
  const state = new Map<number, Uint8Array>();
  for (const k of domain) state.set(k, new Uint8Array(TILE_PTS));
  const low = (i: number, j: number) => grid.base(i, j) + grid.getEff(i, j) < WATER_LEVEL;
  const blocked = (i: number, j: number) => cons.blocksWater(EDIT_ORIGIN + i * EDIT_CELL, EDIT_ORIGIN + j * EDIT_CELL);
  const queue: number[] = [];
  const visit = (i: number, j: number) => {
    const k = (j >> 5) * EDIT_TILES + (i >> 5);
    const st = state.get(k)!;
    const n = ((j & 31) << 5) | (i & 31);
    if (st[n]) return;
    if (!low(i, j) || blocked(i, j)) {
      st[n] = 2;
      return;
    }
    st[n] = 1;
    wet[k]![n] = 1;
    queue.push(j * EDIT_POINTS + i);
  };
  const NB = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const k of domain) {
    const ti = k % EDIT_TILES;
    const tj = Math.floor(k / EDIT_TILES);
    const flags = grid.flags[k];
    for (let n = 0; n < TILE_PTS; n++) {
      const i = (ti << 5) | (n & 31);
      const j = (tj << 5) | (n >> 5);
      let seed = grid.base(i, j) < WATER_LEVEL || (flags !== null && flags[n] === 1);
      if (!seed) {
        // Unedited river right outside the domain flows in.
        for (const [di, dj] of NB) {
          const a = i + di;
          const b = j + dj;
          if (!inDomain(a, b) && a >= 0 && b >= 0 && a < EDIT_POINTS && b < EDIT_POINTS && grid.base(a, b) < WATER_LEVEL) {
            seed = true;
            break;
          }
        }
      }
      if (seed) visit(i, j);
    }
  }
  while (queue.length) {
    const p = queue.pop()!;
    const i = p % EDIT_POINTS;
    const j = (p - i) / EDIT_POINTS;
    for (const [di, dj] of NB) {
      const a = i + di;
      const b = j + dj;
      if (inDomain(a, b)) visit(a, b);
    }
  }
  return wet;
}

/** 1 wet, 0 dry, -1 not decided by landscaping, at a plan point: wet if any surrounding grid point is. */
export function wetAt(grid: TerrainEditGrid, x: number, z: number): number {
  const gx = (x - EDIT_ORIGIN) * INV_CELL;
  const gz = (z - EDIT_ORIGIN) * INV_CELL;
  if (!(gx >= 0 && gz >= 0 && gx < EDIT_POINTS - 1 && gz < EDIT_POINTS - 1)) return -1;
  const i = gx | 0;
  const j = gz | 0;
  let known = false;
  for (let b = 0; b < 2; b++) {
    for (let a = 0; a < 2; a++) {
      const t = grid.wet[((j + b) >> 5) * EDIT_TILES + ((i + a) >> 5)];
      if (!t) continue;
      known = true;
      if (t[(((j + b) & 31) << 5) | ((i + a) & 31)]) return 1;
    }
  }
  return known ? 0 : -1;
}

// ---------------------------------------------------------------------------
// The live layer, bound to the app's network
// ---------------------------------------------------------------------------

export interface TerrainEditEvent {
  /** Tiles whose eff changed: re-upload, re-mesh. */
  tiles: number[];
  /** Plan area that changed, or null with `full`. */
  box: EditBox | null;
  /** Everything may have changed (load, undo). */
  full: boolean;
  /** Fired during a stroke, before the change is committed to the project. */
  live: boolean;
}

function dataKey(d: TerrainData | undefined): string | undefined {
  return d ? `${d.tiles}|${d.water ?? ''}` : undefined;
}

export class TerrainEditor {
  readonly grid = new TerrainEditGrid();
  private cons: Constraints | null = null;
  private consVersion = -1;
  /** The packed string the grid holds, so our own commits are not decoded again. */
  private loaded: string | undefined = undefined;
  private listeners = new Set<(e: TerrainEditEvent) => void>();
  private off: () => void;
  private stroke: { box: EditBox | null; tiles: Set<number>; clamped: ClampKind | null } | null = null;
  /** Changes whenever committed ground changes, for caches keyed on it (terrainMods). */
  get version(): number {
    return landVersion();
  }
  private readonly sampler = (x: number, z: number) => this.grid.sample(x, z);

  constructor(readonly net: RoadNetwork) {
    this.off = net.onChange((c) => this.onNetChange(c));
    this.reload();
  }

  onEdit(fn: (e: TerrainEditEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: TerrainEditEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }

  private install(): void {
    const on = this.grid.effCount > 0 || this.grid.flags.some((f) => f !== null);
    setTerrainEditSampler(on ? this.sampler : null);
    setTerrainWaterSampler(on ? this.waterSampler : null);
    this.wetStale = true;
  }

  private wetStale = true;
  private wetTime = -Infinity;
  /** Changes whenever the water mask is recomputed, for the renderer's upload. */
  wetVersion = 0;
  private readonly waterSampler = (x: number, z: number) => {
    this.ensureWet();
    return wetAt(this.grid, x, z);
  };

  /**
   * Bring the water mask up to date. While a stroke is painting it refreshes at
   * most five times a second; `force` skips that.
   */
  ensureWet(force = false): void {
    if (!this.wetStale) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!force && this.stroke && now - this.wetTime < 200) return;
    this.wetStale = false;
    this.wetTime = now;
    this.grid.wet = computeWet(this.grid, this.constraints());
    this.wetVersion++;
  }

  /** Areas a stroke is about to edit, so roads there constrain it before any raw lands. */
  private consExtra: EditBox[] = [];

  /** Constraints for the network as it is now. */
  constraints(): Constraints {
    if (!this.cons || this.consVersion !== this.net.version) {
      this.cons = buildConstraints(this.net, this.grid, this.consExtra);
      this.consVersion = this.net.version;
    }
    return this.cons;
  }

  /** Make sure roads around a brush at (x, z) are in the constraints. */
  private cover(x: number, z: number, r: number): void {
    const want: EditBox = { minX: x - r, minZ: z - r, maxX: x + r, maxZ: z + r };
    const inside = (b: EditBox) => b.minX <= want.minX && b.minZ <= want.minZ && b.maxX >= want.maxX && b.maxZ >= want.maxZ;
    if (this.cons && this.consVersion === this.net.version && this.consExtra.some(inside)) return;
    // Generous, so a dragged brush rebuilds rarely.
    this.consExtra.push(grow(want, 160));
    this.cons = null;
  }

  private reload(): void {
    const data = this.net.project.terrain;
    try {
      decodeTerrain(this.grid, data);
      this.loaded = dataKey(data);
    } catch (err) {
      console.warn('Landscaping could not be read; the land is shown as generated.', err);
      this.grid.clear();
      this.loaded = dataKey(data);
    }
    this.cons = null;
    conformRegion(this.grid, this.constraints(), null);
    this.install();
    bumpTerrainEditVersion();
    this.emit({ tiles: this.grid.effTiles(), box: null, full: true, live: false });
  }

  private onNetChange(c: NetworkChange): void {
    const data = this.net.project.terrain;
    if (c.reset || c.terrainChanged) {
      if (dataKey(data) !== this.loaded) {
        this.reload();
        return;
      }
      if (c.reset) {
        if (this.grid.rawCount === 0) return;
        this.cons = null;
        const tiles = conformRegion(this.grid, this.constraints(), null);
        this.install();
        bumpTerrainEditVersion();
        this.emit({ tiles: [...new Set([...tiles, ...this.grid.effTiles()])], box: null, full: true, live: false });
        return;
      }
    }
    if (this.grid.rawCount === 0) return;
    if (!c.dirtySegments.length && !c.removedSegments.length && !c.dirtyNodes.length && !c.removedNodes.length) return;
    // Roads block water, so it may flow differently now.
    this.wetStale = true;
    this.wetVersion++;
    // Where roads were and are now: their slopes reach ROAD_REACH out.
    const old = this.cons;
    let box: EditBox | null = null;
    for (const id of [...c.dirtySegments, ...c.removedSegments]) {
      const b = old?.segBoxes.get(id);
      if (b) box = unionBox(box, b);
    }
    for (const id of [...c.dirtyNodes, ...c.removedNodes]) {
      const b = old?.nodeBoxes.get(id);
      if (b) box = unionBox(box, b);
    }
    const cons = this.constraints();
    for (const id of c.dirtySegments) {
      const b = cons.segBoxes.get(id);
      if (b) box = unionBox(box, b);
    }
    for (const id of c.dirtyNodes) {
      const b = cons.nodeBoxes.get(id);
      if (b) box = unionBox(box, b);
    }
    if (!box) return;
    const tiles = conformRegion(this.grid, cons, box);
    if (!tiles.length) return;
    this.install();
    bumpTerrainEditVersion();
    this.emit({ tiles, box, full: false, live: false });
  }

  get stroking(): boolean {
    return this.stroke !== null;
  }

  beginStroke(): void {
    this.stroke = { box: null, tiles: new Set(), clamped: null };
  }

  /** One brush tick. Live: the project is untouched until endStroke(). */
  tick(p: BrushParams): BrushResult {
    if (!this.stroke) this.beginStroke();
    this.cover(p.x, p.z, Math.min(BRUSH_MAX_RADIUS, p.radius) + ROAD_REACH + 40);
    const res = applyBrush(this.grid, this.constraints(), p);
    if (!res.box) return res;
    const s = this.stroke!;
    s.box = unionBox(s.box, res.box);
    for (const k of res.tiles) s.tiles.add(k);
    if (res.clamped) s.clamped = res.clamped;
    // The classes in the constraints came from the land before the stroke; a
    // stroke never moves a road across them, so they stay valid until it ends.
    this.install();
    this.emit({ tiles: res.tiles, box: res.box, full: false, live: true });
    return res;
  }

  /** Commit the stroke to the project as one undo step. Returns false when nothing changed. */
  endStroke(): boolean {
    const s = this.stroke;
    this.stroke = null;
    if (!s || !s.box) return false;
    quantizeRaw(this.grid, s.tiles);
    this.consExtra = [];
    this.cons = null;
    const cons = this.constraints();
    const tiles = conformRegion(this.grid, cons, s.box);
    this.install();
    const data = encodeTerrain(this.grid);
    if (dataKey(data) === this.loaded) return false;
    this.loaded = dataKey(data);
    bumpTerrainEditVersion();
    this.emit({ tiles: [...new Set([...tiles, ...s.tiles])], box: s.box, full: false, live: false });
    this.net.setTerrain(data, grow(s.box, ROAD_REACH));
    return true;
  }

  /** Throw the stroke away, back to the project's saved land. */
  cancelStroke(): void {
    if (!this.stroke) return;
    this.stroke = null;
    this.loaded = undefined;
    this.reload();
  }

  dispose(): void {
    this.off();
    setTerrainEditSampler(null);
    this.listeners.clear();
  }
}

let active: TerrainEditor | null = null;

/**
 * Bind landscaping to the app's network: its Project.terrain drives terrainHeight
 * from now on. One network at a time; binding another replaces it.
 */
export function bindTerrainEdits(net: RoadNetwork): TerrainEditor {
  active?.dispose();
  active = new TerrainEditor(net);
  return active;
}

export function unbindTerrainEdits(): void {
  active?.dispose();
  active = null;
}

export function terrainEditor(): TerrainEditor | null {
  return active;
}

