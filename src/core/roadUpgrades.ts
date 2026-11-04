/**
 * Road upgrades: what the Modify > Upgrade cards put on a road, per side or on
 * the median, and where each lamp, tree, rail and shelter stands.
 *
 * Data lives in `SegmentOverrides.upgrades` (upgradeTypes.ts), plus the existing
 * `barriers` and `structure` fields, which the barrier and structure cards edit.
 * Left and right are as seen along segment a to b. Split copies the overrides, so
 * both halves keep them; reverse swaps sides (mirrorUpgrades) so they stay put in
 * the world. Old saves have no `upgrades` and load unchanged.
 *
 * Pure: no DOM or Three.js. The renderer, the tool's ghost and the tests all read
 * placements from upgradeItems.
 */
import type { RoadNetwork } from './RoadNetwork';
import { sidewalkOn } from './roadTypes';
import { surfaceLevel, terrainHeight } from './terrain';
import type { Id, RoadTypeDef, SegmentOverrides, Station, Vec3 } from './types';
import { mirrorBarriers, wallSide } from './walls';
import type { BarrierKind, BarrierSpec, StructureMode, StructureSpec, WallSide, WallStyle, WallTop } from './wallTypes';
import type { LightStyle, MedianUpgrades, RailStyle, RoadUpgrades, SideUpgrades, TreeStyle, UpgradeCardId, UpgradePlace } from './upgradeTypes';
import { upgradeCard } from './upgradeTypes';

// ---------------------------------------------------------------------------
// Where a click lands
// ---------------------------------------------------------------------------

/** The middle of a road, or one side. */
export type UpgradeZone = 'centre' | 'left' | 'right';

/** True when the road has a physical median wide enough to hold lamps, trees or a rail. */
export function hasMedian(def: RoadTypeDef): boolean {
  return def.median.kind !== 'none' && def.median.width >= 1;
}

/** The median's centre from the centreline, or the centreline itself. */
export function medianOffset(def: RoadTypeDef): number {
  return def.median.offset ?? 0;
}

/** Half the width of the band, around the middle of the road, that counts as a centre click. */
export function centreBand(def: RoadTypeDef): number {
  if (hasMedian(def)) return Math.max(def.median.width / 2 + 1, def.halfWidth * 0.3);
  return Math.max(1.2, def.halfWidth * 0.35);
}

/** Which part of the road a point `lateral` metres right of the centreline is on. */
export function upgradeZone(def: RoadTypeDef, lateral: number): UpgradeZone {
  const d = lateral - medianOffset(def);
  if (Math.abs(d) <= centreBand(def)) return 'centre';
  return d < 0 ? 'left' : 'right';
}

/** The places a card covers for a click in `zone`. */
export function placesFor(card: UpgradeCardId, def: RoadTypeDef, zone: UpgradeZone): UpgradePlace[] {
  if (zone !== 'centre') return [zone];
  if (card === 'remove') return hasMedian(def) ? ['left', 'right', 'median'] : ['left', 'right'];
  if (upgradeCard(card).median && hasMedian(def)) return ['median'];
  return ['left', 'right'];
}

export function canUpgrade(net: RoadNetwork, id: Id): boolean {
  const seg = net.getSegment(id);
  return !!seg && net.roadTypeOf(id).category !== 'rail';
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

const BARRIER_STYLES: readonly BarrierKind[] = ['concrete', 'acrylic', 'timber', 'metal', 'berm'];
const STRUCTURE_STYLES: readonly StructureMode[] = ['embankment', 'retaining', 'trench'];

function sideKey(place: UpgradePlace): 'left' | 'right' {
  return place === 'left' ? 'left' : 'right';
}

function sideNum(place: 'left' | 'right'): -1 | 1 {
  return place === 'left' ? -1 : 1;
}

function hasWalls(mode: StructureMode): boolean {
  return mode === 'retaining' || mode === 'trench';
}

/** The style a card has at a place, or undefined when it has none. */
export function readUpgrade(o: SegmentOverrides, card: UpgradeCardId, place: UpgradePlace): string | undefined {
  const u = o.upgrades;
  const at: SideUpgrades | MedianUpgrades | undefined = place === 'median' ? u?.median : u?.[place];
  switch (card) {
    case 'lights':
      return at?.lights;
    case 'trees':
      return at?.trees;
    case 'rails':
      return at?.rail;
    case 'stops': {
      if (place === 'median') return undefined;
      const s = at as SideUpgrades | undefined;
      return s?.busStop ? 'bus' : s?.bikeRacks ? 'bike' : undefined;
    }
    case 'barriers': {
      if (place === 'median') return undefined;
      const b = o.barriers?.[place];
      return b && b.kind !== 'none' ? b.kind : undefined;
    }
    case 'structure': {
      if (place === 'median') return undefined;
      const s = o.structure;
      if (!s || s.mode === 'auto' || !STRUCTURE_STYLES.includes(s.mode)) return undefined;
      // A retaining wall or trench reads as that side's wall.
      if (hasWalls(s.mode) && !wallSide(s, sideNum(place)).on) return undefined;
      return s.mode;
    }
    case 'remove':
      return upgradesAt(o, place).length ? 'all' : undefined;
  }
}

/** Has a card a given style, for a stops card: does the side have that stop. */
export function hasUpgrade(o: SegmentOverrides, card: UpgradeCardId, place: UpgradePlace, style: string): boolean {
  if (card === 'stops' && place !== 'median') {
    const s = o.upgrades?.[place];
    return style === 'bike' ? !!s?.bikeRacks : !!s?.busStop;
  }
  return readUpgrade(o, card, place) === style;
}

/** Names of what a place holds, for the ghost and the inspector. */
export function upgradesAt(o: SegmentOverrides, place: UpgradePlace): string[] {
  const out: string[] = [];
  const at = place === 'median' ? o.upgrades?.median : o.upgrades?.[place];
  if (at?.lights) out.push(at.lights === 'none' ? 'no lights' : 'lights');
  if (at?.trees) out.push(at.trees === 'hedge' ? 'hedge' : 'trees');
  if (at?.rail) out.push('guard rail');
  if (place !== 'median') {
    const s = at as SideUpgrades | undefined;
    if (s?.busStop) out.push('bus stop');
    if (s?.bikeRacks) out.push('bike racks');
    const b = o.barriers?.[place];
    if (b && b.kind !== 'none') out.push('sound barrier');
    const st = o.structure;
    if (st && st.mode !== 'auto' && (!hasWalls(st.mode) || wallSide(st, sideNum(place)).on)) out.push(st.mode === 'retaining' ? 'wall' : st.mode);
  }
  return out;
}

/** Wall finish and barrier height the structure and barrier cards use. */
export interface UpgradeExtras {
  wallStyle?: WallStyle;
  wallTop?: WallTop;
  barrierHeight?: number;
}

function cleanSide<T extends object>(s: T | undefined): T | undefined {
  if (!s) return undefined;
  const out = { ...s } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === false) delete out[k];
  return Object.keys(out).length ? (out as T) : undefined;
}

function cleanUpgrades(u: RoadUpgrades): RoadUpgrades | undefined {
  const out: RoadUpgrades = {};
  const l = cleanSide(u.left);
  const r = cleanSide(u.right);
  const m = cleanSide(u.median);
  if (l) out.left = l;
  if (r) out.right = r;
  if (m) out.median = m;
  return out.left || out.right || out.median ? out : undefined;
}

/**
 * The overrides patch that sets (`on`) or clears a card's style at some places.
 * `style` is ignored for the remove card, which always clears. Pass the patch to
 * `net.setSegmentOverrides`. Structure patches must still be checked against the
 * footprint of the road (walls.segmentFootprintIssues) before they are applied.
 */
export function upgradePatch(
  o: SegmentOverrides,
  card: UpgradeCardId,
  style: string,
  places: readonly UpgradePlace[],
  on: boolean,
  extras: UpgradeExtras = {},
): SegmentOverrides {
  const sidePlaces = places.filter((p): p is 'left' | 'right' => p !== 'median');
  if (card === 'barriers') {
    const next: BarrierSpec = { ...(o.barriers ?? {}) };
    for (const p of sidePlaces) {
      if (on && BARRIER_STYLES.includes(style as BarrierKind)) next[p] = { kind: style as BarrierKind, height: extras.barrierHeight ?? next[p]?.height ?? 3 };
      else delete next[p];
    }
    return { barriers: next.left || next.right ? next : undefined };
  }
  if (card === 'structure') return { structure: structurePatch(o.structure, style as StructureMode, sidePlaces, on, extras) };
  if (card === 'remove') {
    const patch: SegmentOverrides = {};
    const u: RoadUpgrades = structuredClone(o.upgrades ?? {});
    for (const p of places) delete u[p];
    patch.upgrades = cleanUpgrades(u);
    const b: BarrierSpec = { ...(o.barriers ?? {}) };
    for (const p of sidePlaces) delete b[p];
    patch.barriers = b.left || b.right ? b : undefined;
    // From the middle the whole road goes back to automatic structure; from a side only that wall.
    if (o.structure) {
      if (sidePlaces.length >= 2) patch.structure = undefined;
      else if (sidePlaces.length === 1 && hasWalls(o.structure.mode)) patch.structure = structurePatch(o.structure, o.structure.mode, sidePlaces, false, extras);
      else patch.structure = o.structure;
    }
    return patch;
  }
  const u: RoadUpgrades = structuredClone(o.upgrades ?? {});
  for (const p of places) {
    if (card === 'stops' && p === 'median') continue;
    const at: SideUpgrades & MedianUpgrades = { ...(p === 'median' ? u.median : u[p]) };
    switch (card) {
      case 'lights':
        at.lights = on ? (style as LightStyle) : undefined;
        break;
      case 'trees':
        at.trees = on ? (style as TreeStyle) : undefined;
        break;
      case 'rails':
        at.rail = on ? (style as RailStyle) : undefined;
        break;
      case 'stops':
        if (style === 'bike') at.bikeRacks = on || undefined;
        else at.busStop = on || undefined;
        break;
    }
    if (p === 'median') u.median = at;
    else u[p] = at;
  }
  return { upgrades: cleanUpgrades(u) };
}

function structurePatch(
  cur: StructureSpec | undefined,
  mode: StructureMode,
  sides: readonly ('left' | 'right')[],
  on: boolean,
  extras: UpgradeExtras,
): StructureSpec | undefined {
  const both = sides.length >= 2;
  const finish = (base?: WallSide): WallSide => {
    const out: WallSide = { ...(base ?? {}), style: extras.wallStyle ?? base?.style ?? 'concrete', top: extras.wallTop ?? base?.top ?? 'coping' };
    delete out.on;
    return out;
  };
  if (!on) {
    if (both || !cur || !hasWalls(cur.mode)) return undefined;
    const next: StructureSpec = { ...cur };
    for (const p of sides) next[p] = { ...wallSide(cur, sideNum(p)), on: false };
    const anyOn = wallSide(next, -1).on || wallSide(next, 1).on;
    return anyOn ? next : undefined;
  }
  if (both || !hasWalls(mode)) {
    return { mode, left: finish(cur?.left), right: finish(cur?.right) };
  }
  // One side gets a wall. The other keeps its wall if the road already had this mode, else none.
  const next: StructureSpec = { mode };
  for (const p of ['left', 'right'] as const) {
    const keep = cur?.mode === mode && wallSide(cur, sideNum(p)).on;
    const side = finish(cur?.[p]);
    side.on = sides.includes(p) || keep;
    next[p] = side;
  }
  return next;
}

/** Left becomes right, for a road turned round. */
export function mirrorUpgrades(u: RoadUpgrades): RoadUpgrades {
  const out: RoadUpgrades = {};
  if (u.right) out.left = { ...u.right };
  if (u.left) out.right = { ...u.left };
  if (u.median) out.median = { ...u.median };
  return out;
}

/** Mirror everything the upgrade cards set, for a piece drawn the other way. */
export function mirrorUpgradeOverrides(o: SegmentOverrides): SegmentOverrides {
  return {
    ...o,
    upgrades: o.upgrades && mirrorUpgrades(o.upgrades),
    barriers: o.barriers && mirrorBarriers(o.barriers),
  };
}

/**
 * Whether the automatic lamp posts may stand on a side (1 right, -1 left). Any
 * lights setting on that side, or on the median, replaces them.
 */
export function autoLampSide(o: SegmentOverrides | undefined, side: -1 | 1): boolean {
  const u = o?.upgrades;
  if (!u) return true;
  if (u.median?.lights) return false;
  return !(side < 0 ? u.left?.lights : u.right?.lights);
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Distance between lamps of a style on a road, chosen from the road type. */
export function lightSpacing(def: RoadTypeDef, style: LightStyle): number {
  if (style === 'highmast') return 110;
  const fast = def.category === 'highway' || def.category === 'ramp';
  const base = fast ? 54 : def.category === 'avenue' ? 34 : 30;
  return style === 'decorative' ? Math.round(base * 0.75) : base;
}

export const TREE_SPACING = 10;

export type UpgradePointKind = 'lamp' | 'tree' | 'busStop' | 'bikeRack';
export type UpgradeStripKind = 'rail' | 'hedge' | 'grass';

/** One lamp, tree, shelter or rack. `yaw` turns the model's -Z toward the road. */
export interface UpgradePoint {
  kind: UpgradePointKind;
  style: string;
  place: UpgradePlace;
  pos: Vec3;
  yaw: number;
  /** Along the segment from node a, metres. */
  s: number;
  /** Right of the centreline, metres. */
  offset: number;
  /** A double-arm lamp reaches both ways. */
  both?: boolean;
}

/** A continuous run along the road: rail, hedge or grass verge. */
export interface UpgradeStrip {
  kind: UpgradeStripKind;
  style: string;
  place: UpgradePlace;
  offset: number;
  width: number;
  /** Points along the run, and the right vector at each. */
  points: Vec3[];
  rights: Vec3[];
}

export interface UpgradeItems {
  points: UpgradePoint[];
  strips: UpgradeStrip[];
}

const END_CLEAR = 5;

/** Station position interpolated at arc length s, or null outside the span. */
function frameAt(st: readonly Station[], s: number, hint: { i: number }): { pos: Vec3; right: Vec3 } | null {
  if (st.length < 2 || s < st[0].s || s > st[st.length - 1].s) return null;
  let i = Math.min(hint.i, st.length - 2);
  if (st[i].s > s) i = 0;
  while (i + 2 < st.length && st[i + 1].s < s) i++;
  hint.i = i;
  const a = st[i];
  const b = st[i + 1];
  const f = (s - a.s) / Math.max(b.s - a.s, 1e-6);
  let rx = a.right.x + (b.right.x - a.right.x) * f;
  let rz = a.right.z + (b.right.z - a.right.z) * f;
  const l = Math.hypot(rx, rz) || 1;
  rx /= l;
  rz /= l;
  return {
    pos: { x: a.pos.x + (b.pos.x - a.pos.x) * f, y: a.pos.y + (b.pos.y - a.pos.y) * f, z: a.pos.z + (b.pos.z - a.pos.z) * f },
    right: { x: rx, y: 0, z: rz },
  };
}

interface Offsets {
  kerb: number;
  walk: number;
}

function sideInfo(def: RoadTypeDef, side: -1 | 1): Offsets {
  return { kerb: def.halfWidth, walk: sidewalkOn(def, side) };
}

/** Lateral position of an item kind at a place, as a positive distance out from the centreline (median: signed). */
function placeOffset(def: RoadTypeDef, place: UpgradePlace, what: 'lamp' | 'tree' | 'grass' | 'hedge' | 'rail' | 'busStop' | 'bikeRack'): number {
  if (place === 'median') return medianOffset(def);
  const side = sideNum(place);
  const { kerb, walk } = sideInfo(def, side);
  let d: number;
  switch (what) {
    case 'lamp':
      d = walk > 0 ? kerb + Math.min(0.6, walk / 2) : kerb + 0.9;
      break;
    case 'tree':
      d = walk >= 2 ? kerb + walk * 0.55 : kerb + walk + 1.8;
      break;
    case 'grass':
      d = kerb + walk + 1.3;
      break;
    case 'hedge':
      d = kerb + walk + 0.6;
      break;
    case 'rail':
      d = walk > 0 ? kerb + 0.25 : kerb + 0.45;
      break;
    case 'busStop':
      d = walk >= 2 ? kerb + walk * 0.65 : kerb + walk + 1.4;
      break;
    case 'bikeRack':
      d = walk >= 2 ? kerb + walk * 0.4 : kerb + walk + 1;
      break;
  }
  return d * side;
}

/**
 * Everything the upgrades put along a segment, in world space. `overrides`
 * stands in for the segment's own, for a preview of an edit.
 */
export function upgradeItems(net: RoadNetwork, id: Id, overrides?: SegmentOverrides): UpgradeItems {
  const out: UpgradeItems = { points: [], strips: [] };
  const seg = net.getSegment(id);
  const u = (overrides ?? seg?.overrides)?.upgrades;
  if (!seg || !u) return out;
  const geom = net.segmentGeom(id);
  const st = geom?.stations;
  if (!st || st.length < 2) return out;
  const def = net.roadTypeOf(id);
  const s0 = st[0].s + END_CLEAR;
  const s1 = st[st.length - 1].s - END_CLEAR;
  if (s1 <= s0) return out;
  const hint = { i: 0 };

  const underground = (p: Vec3) => p.y < surfaceLevel(p.x, p.z) - 1.5;
  const raised = (p: Vec3) => p.y - terrainHeight(p.x, p.z) > 1.5;

  const point = (kind: UpgradePointKind, style: string, place: UpgradePlace, s: number, offset: number, extra: Partial<UpgradePoint> = {}): void => {
    const f = frameAt(st, s, hint);
    if (!f) return;
    if (underground(f.pos)) return;
    if ((kind === 'tree' || kind === 'busStop' || kind === 'bikeRack') && raised(f.pos)) return;
    const pos = { x: f.pos.x + f.right.x * offset, y: f.pos.y, z: f.pos.z + f.right.z * offset };
    // Face the road: -Z of the model points back toward the centreline.
    const toward = place === 'median' ? 1 : offset >= 0 ? 1 : -1;
    const yaw = Math.atan2(f.right.x * toward, f.right.z * toward);
    out.points.push({ kind, style, place, pos, yaw, s, offset, ...extra });
  };

  const strip = (kind: UpgradeStripKind, style: string, place: UpgradePlace, offset: number, width: number): void => {
    const points: Vec3[] = [];
    const rights: Vec3[] = [];
    const flush = () => {
      if (points.length >= 2) out.strips.push({ kind, style, place, offset, width, points: points.splice(0), rights: rights.splice(0) });
      else {
        points.length = 0;
        rights.length = 0;
      }
    };
    const sa = st[0].s + 0.5;
    const sb = st[st.length - 1].s - 0.5;
    const samples: number[] = [];
    for (const x of st) if (x.s > sa && x.s < sb) samples.push(x.s);
    samples.unshift(sa);
    samples.push(sb);
    const h = { i: 0 };
    for (const s of samples) {
      const f = frameAt(st, s, h);
      if (!f) continue;
      if (underground(f.pos) || (kind !== 'rail' && raised(f.pos))) {
        flush();
        continue;
      }
      points.push({ x: f.pos.x + f.right.x * offset, y: f.pos.y, z: f.pos.z + f.right.z * offset });
      rights.push(f.right);
    }
    flush();
  };

  const places: UpgradePlace[] = ['left', 'right', 'median'];
  for (const place of places) {
    if (place === 'median' && !hasMedian(def)) continue;
    const at: (SideUpgrades & MedianUpgrades) | undefined = place === 'median' ? u.median : u[place];
    if (!at) continue;
    const mw = def.median.width;
    const lampAt: number[] = [];
    if (at.lights && at.lights !== 'none') {
      const spacing = lightSpacing(def, at.lights);
      // Lamps on the left sit halfway between those on the right, so both sides read as one row.
      const phase = place === 'left' ? spacing / 2 : 0;
      const off = placeOffset(def, place, 'lamp');
      for (let s = s0 + ((spacing - ((s0 - phase) % spacing)) % spacing); s <= s1; s += spacing) {
        lampAt.push(s);
        point('lamp', at.lights, place, s, off, place === 'median' && at.lights !== 'highmast' ? { both: true } : {});
      }
    }
    if (at.trees) {
      if (at.trees === 'hedge') strip('hedge', 'hedge', place, placeOffset(def, place, 'hedge'), place === 'median' ? Math.max(0.6, Math.min(1.2, mw - 0.4)) : 0.9);
      else {
        if (at.trees === 'grass') strip('grass', 'grass', place, placeOffset(def, place, 'grass'), place === 'median' ? Math.max(0.4, mw - 0.3) : 2.4);
        const off = placeOffset(def, place, at.trees === 'grass' ? 'grass' : 'tree');
        const phase = place === 'left' ? TREE_SPACING / 2 : 0;
        for (let s = s0 + ((TREE_SPACING - ((s0 - phase) % TREE_SPACING)) % TREE_SPACING); s <= s1; s += TREE_SPACING) {
          // Leave room round lamps on the same side.
          if (lampAt.some((l) => Math.abs(l - s) < 2.5)) continue;
          point('tree', at.trees, place, s, off);
        }
      }
    }
    if (at.rail) strip('rail', at.rail, place, placeOffset(def, place, 'rail'), at.rail === 'jersey' ? 0.6 : 0.3);
    if (place !== 'median') {
      const side = at as SideUpgrades;
      const len = s1 - s0;
      if (side.busStop && len > 12) point('busStop', 'bus', place, s0 + len / 2, placeOffset(def, place, 'busStop'));
      if (side.bikeRacks && len > 8) {
        const off = placeOffset(def, place, 'bikeRack');
        const n = Math.max(1, Math.min(4, Math.floor(len / 30)));
        for (let k = 0; k < n; k++) {
          const sc = s0 + (len * (k + 0.5)) / n + (side.busStop ? 8 : 0);
          for (let j = 0; j < 3; j++) point('bikeRack', 'bike', place, Math.min(s1, sc + j * 0.9), off);
        }
      }
    }
  }
  return out;
}
