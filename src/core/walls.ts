/**
 * Road structures: embankments, retaining walls, trenches and sloped cuts, and
 * the sound barriers along road edges.
 *
 * Everything here is a pure function of the network. A side section says, at one
 * station, where the road's edge is, whether a wall stands there and how high,
 * and the earth slope beside it. The renderer sweeps walls and slopes from the same
 * sections that terrainMods.ts turns into ground height, so walls, slopes and the
 * ground always meet.
 */
import { buildSegmentCurve } from './geometry';
import type { Cubic } from './bezier';
import { closestPointOnCubic } from './bezier';
import type { DraftIssue, RoadNetwork } from './RoadNetwork';
import { sidewalkOn, totalHalfWidth } from './roadTypes';
import { terrainHeight } from './terrain';
import type { Id, RoadTypeDef, SegmentOverrides, Station, Vec3 } from './types';
import type { BarrierSide, BarrierSpec, StructureMode, StructureSpec, WallSide } from './wallTypes';

/** Road surfaces sit this far above their curve height. Same as render's ROAD_LIFT. */
export const SURFACE_LIFT = 0.06;
const KERB = 0.15;
const VERGE = 0.9;
const VERGE_DROP = 0.22;
/** Earth slopes run this far out per metre of height (1 in 1.5). */
export const SLOPE_RUN = 1.5;
export const WALL_THICKNESS = 0.45;
/** Below this height a wall is not worth building: the side is a short slope. */
export const WALL_MIN_HEIGHT = 0.45;
/** A raised wall stands this far above the edge it holds, as a parapet. */
export const PARAPET = 0.35;
/** Under this rise or depth the road is at grade and no structure is needed. */
const AT_GRADE = 0.1;
/** Longest gap between sampled sections, so slopes follow the ground. */
export const SECTION_STEP = 4;

export const DEFAULT_WALL: Required<Omit<WallSide, 'height' | 'on'>> = { style: 'concrete', top: 'coping' };

export function structureOf(o: SegmentOverrides | undefined): StructureSpec {
  return o?.structure ?? { mode: 'auto' };
}

export function isRaisedEarth(mode: StructureMode): boolean {
  return mode === 'embankment' || mode === 'retaining';
}

export function isSunkEarth(mode: StructureMode): boolean {
  return mode === 'trench' || mode === 'cut';
}

/** Modes that put earth or walls beside the road, and so take extra width. */
export function isEarthwork(mode: StructureMode): boolean {
  return isRaisedEarth(mode) || isSunkEarth(mode);
}

/** The settings of one side, with defaults filled in. */
export function wallSide(spec: StructureSpec, side: -1 | 1): WallSide & { on: boolean } {
  const own = side < 0 ? spec.left : spec.right;
  const on = own?.on ?? (spec.mode === 'retaining' || spec.mode === 'trench');
  return { style: own?.style ?? DEFAULT_WALL.style, top: own?.top ?? DEFAULT_WALL.top, height: own?.height, on };
}

/** Left becomes right, for a road turned round. */
export function mirrorStructure(spec: StructureSpec): StructureSpec {
  const out: StructureSpec = { mode: spec.mode };
  if (spec.right) out.left = { ...spec.right };
  if (spec.left) out.right = { ...spec.left };
  return out;
}

export function mirrorBarriers(spec: BarrierSpec): BarrierSpec {
  const out: BarrierSpec = {};
  if (spec.right) out.left = { ...spec.right };
  if (spec.left) out.right = { ...spec.left };
  return out;
}

export function barrierOn(spec: BarrierSpec | undefined, side: -1 | 1): BarrierSide | null {
  const b = side < 0 ? spec?.left : spec?.right;
  return b && b.kind !== 'none' ? b : null;
}

/** Where the road's own cross section ends on one side, and its height there over the surface. */
export function roadEdge(def: RoadTypeDef, side: -1 | 1): { offset: number; lift: number } {
  const walk = sidewalkOn(def, side);
  return walk > 0 ? { offset: def.halfWidth + walk, lift: KERB } : { offset: def.halfWidth + VERGE, lift: -VERGE_DROP };
}

export interface Pt {
  o: number;
  y: number;
}

export interface SideSection {
  side: -1 | 1;
  kind: 'raised' | 'sunk';
  /** Outer edge of the road's own section, from the centreline, and its height. */
  edge: number;
  edgeY: number;
  /** A vertical wall: faces at `inner` and `outer`, from `bottom` to `top`. */
  wall: { inner: number; outer: number; top: number; bottom: number } | null;
  /** An earth slope between two points. */
  slope: { o0: number; y0: number; o1: number; y1: number } | null;
  /** Ground across the section, four points outward from the edge. */
  profile: [Pt, Pt, Pt, Pt];
  /** Outermost offset the structure takes. */
  extent: number;
}

/**
 * The section on one side at one station.
 * surfaceY: the road surface height. natural(o): untouched ground at lateral
 * offset o (unsigned, measured on this side). Null when the road is at grade here
 * or the mode puts nothing beside it.
 */
export function sideSection(spec: StructureSpec, side: -1 | 1, def: RoadTypeDef, surfaceY: number, natural: (o: number) => number): SideSection | null {
  const raised = isRaisedEarth(spec.mode);
  if (!raised && !isSunkEarth(spec.mode)) return null;
  const { offset: E, lift } = roadEdge(def, side);
  const eY = surfaceY + lift;
  const ws = wallSide(spec, side);
  const cap = ws.height !== undefined && ws.height > 0 ? ws.height : Infinity;
  const T = WALL_THICKNESS;
  const K = SLOPE_RUN;
  // The road's own kerb and verge already meet the ground when its curve sits on it.
  const curveRise = surfaceY - SURFACE_LIFT - natural(E);
  if (raised) {
    const r0 = eY - natural(E);
    if (curveRise <= AT_GRADE || r0 <= AT_GRADE) return null;
    if (ws.on && r0 > WALL_MIN_HEIGHT) {
      let inner = E;
      let natW = natural(E + T);
      let h = 0;
      for (let k = 0; k < 3; k++) {
        const r = Math.max(0, eY - natW);
        h = Math.min(r, cap);
        inner = E + (r - h) * K;
        natW = natural(inner + T);
      }
      const top = eY - Math.max(0, eY - natW - h);
      const outer = inner + T;
      return {
        side,
        kind: 'raised',
        edge: E,
        edgeY: eY,
        wall: { inner, outer, top, bottom: natW },
        slope: inner - E > 0.01 ? { o0: E, y0: eY, o1: inner, y1: top } : null,
        profile: [
          { o: E, y: eY },
          { o: inner, y: top },
          { o: outer, y: top },
          { o: outer, y: natW },
        ],
        extent: outer,
      };
    }
    let toe = E + r0 * K;
    let natT = natural(toe);
    for (let k = 0; k < 3; k++) {
      toe = E + Math.max(0, eY - natT) * K;
      natT = natural(toe);
    }
    const p = { o: toe, y: Math.min(natT, eY) };
    return {
      side,
      kind: 'raised',
      edge: E,
      edgeY: eY,
      wall: null,
      slope: { o0: E, y0: eY, o1: toe, y1: p.y },
      profile: [{ o: E, y: eY }, p, { ...p }, { ...p }],
      extent: toe,
    };
  }
  const d0 = natural(E) - eY;
  if (-curveRise <= AT_GRADE || d0 <= AT_GRADE) return null;
  if (ws.on && d0 > WALL_MIN_HEIGHT) {
    const natW = natural(E + T);
    const d = Math.max(0, natW - eY);
    const h = Math.min(d, cap);
    const top = eY + h;
    let extent = E + T + (d - h) * K;
    let natX = natural(extent);
    if (d - h > 0.01) {
      for (let k = 0; k < 2; k++) {
        extent = E + T + Math.max(0, natX - top) * K;
        natX = natural(extent);
      }
    } else {
      natX = top;
    }
    return {
      side,
      kind: 'sunk',
      edge: E,
      edgeY: eY,
      wall: { inner: E, outer: E + T, top, bottom: eY - 0.1 },
      slope: extent - (E + T) > 0.01 ? { o0: E + T, y0: top, o1: extent, y1: natX } : null,
      profile: [
        { o: E, y: eY },
        { o: E, y: top },
        { o: E + T, y: top },
        { o: extent, y: Math.max(natX, top) },
      ],
      extent,
    };
  }
  let top = E + d0 * K;
  let natT = natural(top);
  for (let k = 0; k < 3; k++) {
    top = E + Math.max(0, natT - eY) * K;
    natT = natural(top);
  }
  const p = { o: top, y: Math.max(natT, eY) };
  return {
    side,
    kind: 'sunk',
    edge: E,
    edgeY: eY,
    wall: null,
    slope: { o0: E, y0: eY, o1: top, y1: p.y },
    profile: [{ o: E, y: eY }, p, { ...p }, { ...p }],
    extent: top,
  };
}

/** Ground height across a section at unsigned offset o, or null outside it. */
export function profileHeight(profile: readonly Pt[], o: number): number | null {
  if (o <= profile[0].o) return profile[0].y;
  for (let i = 0; i + 1 < profile.length; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    if (b.o - a.o < 1e-6) continue;
    if (o <= b.o) return a.y + ((b.y - a.y) * (o - a.o)) / (b.o - a.o);
  }
  return o <= profile[profile.length - 1].o + 1e-6 ? profile[profile.length - 1].y : null;
}

/** Wall height above the ground it stands on (raised) or the road (sunk). */
export function wallHeight(s: SideSection | null): number {
  if (!s?.wall) return 0;
  return s.kind === 'raised' ? s.wall.top - s.wall.bottom + PARAPET : s.wall.top - s.edgeY;
}

// ---------------------------------------------------------------------------
// Sections along a curve
// ---------------------------------------------------------------------------

export interface SectionSample {
  x: number;
  z: number;
  /** Road curve height (no surface lift). */
  y: number;
  rx: number;
  rz: number;
  s: number;
  left: SideSection | null;
  right: SideSection | null;
}

function naturalBeside(x: number, z: number, rx: number, rz: number, side: -1 | 1): (o: number) => number {
  return (o) => terrainHeight(x + rx * o * side, z + rz * o * side);
}

/** One sample's sections. */
export function sectionAt(spec: StructureSpec, def: RoadTypeDef, x: number, y: number, z: number, rx: number, rz: number, s = 0): SectionSample {
  const surface = y + SURFACE_LIFT;
  return {
    x,
    z,
    y,
    rx,
    rz,
    s,
    left: sideSection(spec, -1, def, surface, naturalBeside(x, z, rx, rz, -1)),
    right: sideSection(spec, 1, def, surface, naturalBeside(x, z, rx, rz, 1)),
  };
}

/** Sections along stations, refined to SECTION_STEP. */
export function sectionsAlong(stations: readonly Station[], spec: StructureSpec, def: RoadTypeDef): SectionSample[] {
  const out: SectionSample[] = [];
  if (stations.length < 2 || !isEarthwork(spec.mode)) return out;
  for (let i = 0; i + 1 < stations.length; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    const parts = Math.max(1, Math.ceil((b.s - a.s) / SECTION_STEP));
    for (let k = 0; k < parts; k++) {
      const f = k / parts;
      out.push(lerpSample(a, b, f, spec, def));
    }
  }
  const n = stations.length;
  out.push(lerpSample(stations[n - 2], stations[n - 1], 1, spec, def));
  return out;
}

function lerpSample(a: Station, b: Station, f: number, spec: StructureSpec, def: RoadTypeDef): SectionSample {
  const x = a.pos.x + (b.pos.x - a.pos.x) * f;
  const y = a.pos.y + (b.pos.y - a.pos.y) * f;
  const z = a.pos.z + (b.pos.z - a.pos.z) * f;
  let rx = a.right.x + (b.right.x - a.right.x) * f;
  let rz = a.right.z + (b.right.z - a.right.z) * f;
  const l = Math.hypot(rx, rz) || 1;
  rx /= l;
  rz /= l;
  return sectionAt(spec, def, x, y, z, rx, rz, a.s + (b.s - a.s) * f);
}

/** The sections of a built segment over its visible span. Empty when it has no earthworks. */
export function segmentSections(net: RoadNetwork, id: Id): SectionSample[] {
  const seg = net.getSegment(id);
  const geom = net.segmentGeom(id);
  if (!seg || !geom || geom.stations.length < 2) return [];
  return sectionsAlong(geom.stations, structureOf(seg.overrides), net.roadTypeOf(id));
}

/** Widest the structure reaches on each side, from the centreline. */
export function structureExtents(net: RoadNetwork, id: Id): { left: number; right: number } {
  const def = net.roadTypeOf(id);
  let left = totalHalfWidth(def);
  let right = left;
  for (const s of segmentSections(net, id)) {
    if (s.left) left = Math.max(left, s.left.extent);
    if (s.right) right = Math.max(right, s.right.extent);
  }
  return { left, right };
}

// ---------------------------------------------------------------------------
// Sound barrier runs
// ---------------------------------------------------------------------------

/** Barriers stop this far short of a junction mouth, and further where a ramp leaves. */
export const BARRIER_JUNCTION_GAP = 3;
export const BARRIER_RAMP_GAP = 14;

/**
 * Where a segment's barriers run, as arc lengths along the full curve. They stop
 * before junction mouths, further before ramps, and run on through plain joints.
 */
export function barrierSpan(net: RoadNetwork, id: Id): { s0: number; s1: number } | null {
  const seg = net.getSegment(id);
  const geom = net.segmentGeom(id);
  if (!seg || !geom || geom.stations.length < 2) return null;
  const st = geom.stations;
  const gap = (nodeId: Id, atStart: boolean): number => {
    const g = net.nodeGeom(nodeId);
    const node = net.getNode(nodeId);
    if (!g || !node) return 0;
    const attach = atStart ? seg.overrides.attachA : seg.overrides.attachB;
    const rampHere =
      !!attach ||
      node.segments.some((other) => {
        if (other === id) return false;
        const o = net.getSegment(other);
        if (!o) return false;
        const cat = net.roadTypeOf(other).category;
        return cat === 'ramp' || (o.a === nodeId ? !!o.overrides.attachA : o.b === nodeId ? !!o.overrides.attachB : false);
      });
    if (g.kind === 'junction') return rampHere ? BARRIER_RAMP_GAP : BARRIER_JUNCTION_GAP;
    if (g.kind === 'deadEnd') return 0.6;
    // A plain joint joins the same road type end to end, as between the pieces of a
    // fitted curve (core/curveChain.ts), so a ramp's barrier runs straight through it.
    if (g.kind === 'plain') return 0;
    return rampHere ? BARRIER_RAMP_GAP : 0;
  };
  const s0 = st[0].s + gap(seg.a, true);
  const s1 = st[st.length - 1].s - gap(seg.b, false);
  return s1 - s0 > 2 ? { s0, s1 } : null;
}

// ---------------------------------------------------------------------------
// Validation: the extra width a structure takes
// ---------------------------------------------------------------------------

export interface FootprintCheck {
  cubic: Cubic;
  roadType: string;
  structure: StructureSpec;
  /** Segments the draft joins or splits, which it may touch. */
  ignoreSegments?: readonly Id[];
  ignoreNodes?: readonly Id[];
}

export interface FootprintResult {
  issues: DraftIssue[];
  /** Outer outline on each side, for the preview. Empty when the mode adds none. */
  left: Vec3[];
  right: Vec3[];
}

/**
 * Embankments and cuts take ground beside the road. Another road in the walled
 * part is refused; one under a slope is a warning, since walls would fit.
 */
export function structureFootprint(net: RoadNetwork, check: FootprintCheck): FootprintResult {
  const out: FootprintResult = { issues: [], left: [], right: [] };
  const def = net.roadType(check.roadType);
  if (!def || !isEarthwork(check.structure.mode)) return out;
  const curve = buildSegmentCurve(check.cubic);
  const samples = sectionsAlong(curve.stations, check.structure, def);
  if (!samples.length) return out;
  const ignore = new Set(check.ignoreSegments ?? []);
  for (const n of check.ignoreNodes ?? []) for (const s of net.getNode(n)?.segments ?? []) ignore.add(s);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let reach = 0;
  for (const s of samples) {
    for (const side of [-1, 1] as const) {
      const sec = side < 0 ? s.left : s.right;
      const o = (sec?.extent ?? roadEdge(def, side).offset) * side;
      const p = { x: s.x + s.rx * o, y: s.y, z: s.z + s.rz * o };
      (side < 0 ? out.left : out.right).push(p);
      if (sec) reach = Math.max(reach, sec.extent);
    }
    minX = Math.min(minX, s.x);
    minZ = Math.min(minZ, s.z);
    maxX = Math.max(maxX, s.x);
    maxZ = Math.max(maxZ, s.z);
  }
  if (reach === 0) {
    out.left = [];
    out.right = [];
    return out;
  }
  const pad = reach + 20;
  const near = net.segmentsInRegion({ minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad }, true);
  const wallHits: Vec3[] = [];
  const slopeHits: Vec3[] = [];
  for (const other of near) {
    if (ignore.has(other)) continue;
    const g = net.segmentGeom(other);
    if (!g || g.stations.length < 2) continue;
    const half = totalHalfWidth(net.roadTypeOf(other));
    const mine: { p: Vec3; wall: boolean }[] = [];
    const sides = new Set<number>();
    for (const st of g.stations) {
      const hit = closestPointOnCubic(check.cubic, st.pos);
      if (hit.t <= 0.001 || hit.t >= 0.999) continue;
      const s = nearestSample(samples, hit.point);
      const dx = st.pos.x - s.x;
      const dz = st.pos.z - s.z;
      const lateral = dx * s.rx + dz * s.rz;
      const side: -1 | 1 = lateral < 0 ? -1 : 1;
      if (Math.abs(lateral) < reach + half) sides.add(side);
      const sec = side < 0 ? s.left : s.right;
      if (!sec) continue;
      const o = Math.abs(lateral) - half;
      if (o > sec.extent) continue;
      // Grade separated: the other road passes well above or below the earthwork.
      const ground = profileHeight(sec.profile, Math.max(o, sec.edge)) ?? sec.edgeY;
      const nat = terrainHeight(st.pos.x, st.pos.z);
      if (st.pos.y > Math.max(ground, nat) + 5 || st.pos.y < Math.min(ground, nat) - 4) continue;
      mine.push({ p: { ...st.pos }, wall: !!sec.wall && o <= sec.wall.outer });
    }
    // A road crossing over or under this one passes the structure by.
    if (sides.size > 1) continue;
    for (const h of mine) (h.wall ? wallHits : slopeHits).push(h.p);
  }
  const mode = check.structure.mode;
  if (wallHits.length) {
    out.issues.push({
      code: 'structureFootprint',
      severity: 'error',
      message: isRaisedEarth(mode) ? 'The retaining wall would stand in another road.' : 'The trench wall would cut into another road.',
      at: wallHits[0],
      stretch: wallHits.length > 1 ? wallHits : undefined,
    });
  } else if (slopeHits.length) {
    out.issues.push({
      code: 'structureFootprint',
      severity: isRaisedEarth(mode) || isSunkEarth(mode) ? 'warning' : 'error',
      message: isRaisedEarth(mode)
        ? 'Embankment slopes spill onto another road. Retaining walls would fit.'
        : 'Cut slopes reach another road. Trench walls would fit.',
      at: slopeHits[0],
      stretch: slopeHits.length > 1 ? slopeHits : undefined,
    });
  }
  return out;
}

function nearestSample(samples: readonly SectionSample[], p: Vec3): SectionSample {
  let best = samples[0];
  let bd = Infinity;
  for (const s of samples) {
    const d = (s.x - p.x) ** 2 + (s.z - p.z) ** 2;
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

/** Footprint check of an existing segment with a different structure, as Upgrade and the inspector apply. */
export function segmentFootprintIssues(net: RoadNetwork, id: Id, structure: StructureSpec): DraftIssue[] {
  const seg = net.getSegment(id);
  if (!seg) return [];
  return structureFootprint(net, {
    cubic: net.cubicOf(id),
    roadType: seg.roadType,
    structure,
    ignoreSegments: [id],
    ignoreNodes: [seg.a, seg.b],
  }).issues;
}
