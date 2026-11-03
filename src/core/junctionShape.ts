/**
 * Junction shape: hand edits to a junction's physical layout, the Node Controller
 * side of node editing. Corner kerb radii, sidewalk widths at corners and arm ends,
 * arm trims and raised islands are stored in `JunctionControl.shape`, keyed by arm
 * segment ids and lane boundaries, never by world position, so they follow the
 * roads when anything moves.
 *
 * junction.ts calls the two layout hooks here (applyShapeTrims, shapeOutlineHooks)
 * so that NodeGeom.outline, the trims, and everything built on them honour the
 * edits. laneGraph.ts drops connectors that would run through an island. The rest
 * is reads of a RoadNetwork for the editor: handles, limits and validation.
 */
import type { ArmLayout } from './junction';
import type { ConnectorProto } from './connectors';
import type { Cubic } from './bezier';
import type { RoadNetwork } from './RoadNetwork';
import type {
  Id,
  JunctionControl,
  JunctionShape,
  NodeArm,
  NodeGeom,
  RoadTypeDef,
  SegmentGeom,
  SegmentOverrides,
  ShapeArm,
  ShapeCorner,
  ShapeIsland,
  Station,
  Vec3,
} from './types';
import { clamp, crossXZ, dotXZ, normalizeXZ, rightOf, wrapAngle, wrapPositive } from './math';
import { effectiveLanes, sidewalkOn } from './roadTypes';
import { boundaryOffsets } from './nodeMarkings';
import { stationAt } from './geometry';

// ---------------------------------------------------------------------------
// Limits and snapping. Everything is parameter based and snaps to these steps.
// ---------------------------------------------------------------------------

export const RADIUS_MIN = 0.5;
export const RADIUS_MAX = 40;
export const RADIUS_STEP = 0.5;
export const KERB_STEP = 0.25;
export const EDGE_STEP = 0.25;
export const TRIM_STEP = 0.5;
export const ISLAND_STEP = 0.5;
/** Largest kerb extension into the road at a corner. */
export const KERB_MAX = 6;
/** How close a connector's centreline may come to a kerb or island. */
export const KERB_CLEARANCE = 1;

/** Clearance a connector of this width needs: a narrow bike lane rides closer to the kerb. */
export function clearanceNeed(width: number): number {
  return Math.min(KERB_CLEARANCE, 0.85 * (width / 2));
}
/** Island edges sit this far inside the lane boundaries they are drawn between. */
const ISLAND_INSET = 0.1;
export const ISLAND_MIN_WIDTH = 0.8;
export const ISLAND_DEFAULT_BACK = 6;
/** A shifted kerb at an arm end holds for this long, then tapers back to the road edge. */
export const EDGE_HOLD = 1.5;
export const EDGE_TAPER = 6;
/** Visible road that must be left after an arm trim. */
const MIN_VISIBLE = 2;

export const snapTo = (v: number, step: number): number => Math.round(v / step) * step;

export function cornerKey(a: Id, b: Id): string {
  return `${a}>${b}`;
}

export function parseCornerKey(key: string): [Id, Id] | null {
  const parts = key.split('>').map(Number);
  return parts.length === 2 && parts.every(Number.isInteger) ? [parts[0], parts[1]] : null;
}

// ---------------------------------------------------------------------------
// Data upkeep
// ---------------------------------------------------------------------------

function cleanCorner(c: ShapeCorner | undefined): ShapeCorner | undefined {
  if (!c) return undefined;
  const out: ShapeCorner = {};
  if (c.radius !== undefined && Number.isFinite(c.radius)) out.radius = clamp(c.radius, RADIUS_MIN, RADIUS_MAX);
  if (c.kerb !== undefined && Number.isFinite(c.kerb) && Math.abs(c.kerb) > 1e-6) out.kerb = c.kerb;
  if (c.sidewalk === false) out.sidewalk = false;
  return Object.keys(out).length ? out : undefined;
}

function cleanArm(a: ShapeArm | undefined): ShapeArm | undefined {
  if (!a) return undefined;
  const out: ShapeArm = {};
  for (const k of ['trim', 'edgeLeft', 'edgeRight'] as const) {
    const v = a[k];
    if (v !== undefined && Number.isFinite(v) && Math.abs(v) > 1e-6) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A copy without empty entries, or undefined when nothing is left. */
export function normaliseShape(shape: JunctionShape | null | undefined): JunctionShape | undefined {
  if (!shape) return undefined;
  const out: JunctionShape = {};
  const corners: Record<string, ShapeCorner> = {};
  for (const [key, c] of Object.entries(shape.corners ?? {})) {
    const clean = cleanCorner(c);
    if (clean && parseCornerKey(key)) corners[key] = clean;
  }
  if (Object.keys(corners).length) out.corners = corners;
  const arms: Record<number, ShapeArm> = {};
  for (const [key, a] of Object.entries(shape.arms ?? {})) {
    const clean = cleanArm(a);
    if (clean && Number.isInteger(Number(key))) arms[Number(key)] = clean;
  }
  if (Object.keys(arms).length) out.arms = arms;
  const islands = (shape.islands ?? []).filter(
    (i) => Number.isInteger(i.id) && Number.isInteger(i.segmentId) && Number.isInteger(i.from) && Number.isInteger(i.to) && i.from !== i.to,
  );
  if (islands.length) {
    out.islands = islands.map((i) => ({
      id: i.id,
      segmentId: i.segmentId,
      from: Math.min(i.from, i.to),
      to: Math.max(i.from, i.to),
      back: Math.max(0, Number.isFinite(i.back) ? i.back : ISLAND_DEFAULT_BACK),
      reach: Math.max(0, Number.isFinite(i.reach) ? i.reach : 0),
    }));
  }
  return Object.keys(out).length ? out : undefined;
}

export function hasShape(shape: JunctionShape | null | undefined): boolean {
  return !!shape && !!(shape.corners || shape.arms || shape.islands?.length);
}

/** Carry the shape over when a road at the node changes id, as in a split. */
export function renameShapeSegment(control: JunctionControl, from: Id, to: Id): void {
  const s = control.shape;
  if (!s) return;
  if (s.arms?.[from]) {
    s.arms[to] = s.arms[from];
    delete s.arms[from];
  }
  if (s.corners) {
    const next: Record<string, ShapeCorner> = {};
    for (const [key, c] of Object.entries(s.corners)) {
      const ids = parseCornerKey(key);
      next[ids ? cornerKey(ids[0] === from ? to : ids[0], ids[1] === from ? to : ids[1]) : key] = c;
    }
    s.corners = next;
  }
  for (const i of s.islands ?? []) if (i.segmentId === from) i.segmentId = to;
}

/** Drop everything that belongs to a road leaving the node. */
export function stripShapeSegment(control: JunctionControl, id: Id): void {
  const s = control.shape;
  if (!s) return;
  if (s.arms) delete s.arms[id];
  if (s.corners) {
    for (const key of Object.keys(s.corners)) if (parseCornerKey(key)?.includes(id)) delete s.corners[key];
  }
  if (s.islands) s.islands = s.islands.filter((i) => i.segmentId !== id);
  const clean = normaliseShape(s);
  if (clean) control.shape = clean;
  else delete control.shape;
}

/** Keep only what refers to roads at the node, as a loaded file might not. */
export function shapeOnNode(shape: JunctionShape | undefined, segments: readonly Id[]): JunctionShape | undefined {
  if (!shape) return undefined;
  const on = new Set(segments);
  const s = structuredClone(shape);
  if (s.arms) for (const key of Object.keys(s.arms)) if (!on.has(Number(key))) delete s.arms[Number(key)];
  if (s.corners) {
    for (const key of Object.keys(s.corners)) {
      const ids = parseCornerKey(key);
      if (!ids || !on.has(ids[0]) || !on.has(ids[1])) delete s.corners[key];
    }
  }
  if (s.islands) s.islands = s.islands.filter((i) => on.has(i.segmentId));
  return normaliseShape(s);
}

// ---------------------------------------------------------------------------
// Plan geometry helpers
// ---------------------------------------------------------------------------

/** A kerb line: a point on a cut line and the arm's outward direction there. */
interface Ray {
  p: Vec3;
  dir: Vec3;
}

/** Where two kerb lines carried inward from their cut points meet, and how far in. */
function meet(a: Ray, b: Ray): { u: number; v: number; x: Vec3 } | null {
  const denom = crossXZ(a.dir, b.dir);
  if (Math.abs(denom) < 0.01) return null;
  const dx = a.p.x - b.p.x;
  const dz = a.p.z - b.p.z;
  const u = (dx * b.dir.z - dz * b.dir.x) / denom;
  const v = (dx * a.dir.z - dz * a.dir.x) / denom;
  return { u, v, x: { x: a.p.x - a.dir.x * u, y: (a.p.y + b.p.y) / 2, z: a.p.z - a.dir.z * u } };
}

/** Angle between the two kerb lines' outward directions. */
function openingOf(a: Ray, b: Ray): number {
  return Math.acos(clamp(dotXZ(a.dir, b.dir), -1, 1));
}

/** Heights along a chain, blended by distance between the two ends. */
function blendHeights(from: Vec3, pts: Vec3[], to: Vec3): Vec3[] {
  const chain = [from, ...pts, to];
  const cum = [0];
  for (let i = 1; i < chain.length; i++) cum.push(cum[i - 1] + Math.hypot(chain[i].x - chain[i - 1].x, chain[i].z - chain[i - 1].z));
  const total = cum[cum.length - 1] || 1;
  return pts.map((p, i) => ({ x: p.x, y: from.y + (to.y - from.y) * (cum[i + 1] / total), z: p.z }));
}

export interface FilletResult {
  /** Points strictly between the two cut points. */
  pts: Vec3[];
  /** Radius used, after fitting it between the cut points. */
  radius: number;
  /** Radius wanted did not fit the junction box. */
  clamped: boolean;
}

/**
 * A circular kerb of radius r tangent to both kerb lines, joined to the cut points
 * by straight kerb where the tangent points fall short of them. Null when the
 * lines do not make a corner, as on a straight-through side or a capped trim.
 */
export function filletCorner(a: Ray, b: Ray, r: number): FilletResult | null {
  const m = meet(a, b);
  if (!m || m.u <= 1e-3 || m.v <= 1e-3) return null;
  const alpha = openingOf(a, b);
  if (alpha < 0.05 || alpha > Math.PI - 0.05) return null;
  const tanH = Math.tan(alpha / 2);
  const want = Math.max(0, r) / tanH;
  const t = Math.min(want, m.u, m.v);
  const radius = t * tanH;
  const clamped = want > t + 1e-6;
  const out: Vec3[] = [];
  const ta = { x: m.x.x + a.dir.x * t, y: 0, z: m.x.z + a.dir.z * t };
  const tb = { x: m.x.x + b.dir.x * t, y: 0, z: m.x.z + b.dir.z * t };
  if (radius < 0.05) {
    out.push(m.x);
    return { pts: blendHeights(a.p, out, b.p), radius: 0, clamped };
  }
  const bis = normalizeXZ({ x: a.dir.x + b.dir.x, y: 0, z: a.dir.z + b.dir.z });
  const k = radius / Math.sin(alpha / 2);
  const c = { x: m.x.x + bis.x * k, z: m.x.z + bis.z * k };
  const a0 = Math.atan2(ta.z - c.z, ta.x - c.x);
  const a1 = Math.atan2(tb.z - c.z, tb.x - c.x);
  const sweep = wrapAngle(a1 - a0);
  const steps = Math.max(3, Math.ceil(Math.abs(sweep) / 0.14));
  if (m.u - t > 0.02) out.push(ta);
  for (let i = 1; i < steps; i++) {
    const ang = a0 + (sweep * i) / steps;
    out.push({ x: c.x + Math.cos(ang) * radius, y: 0, z: c.z + Math.sin(ang) * radius });
  }
  if (m.v - t > 0.02) out.push(tb);
  return { pts: blendHeights(a.p, out, b.p), radius, clamped };
}

/** The automatic corner: a quadratic through the kerb lines' meeting point. */
function quadraticCorner(a: Ray, b: Ray): Vec3[] {
  const m = meet(a, b);
  const chord = Math.hypot(a.p.x - b.p.x, a.p.z - b.p.z);
  if (!m || m.u <= 1e-3 || m.v <= 1e-3 || m.u > chord * 1.5 + 10 || m.v > chord * 1.5 + 10) return [];
  const out: Vec3[] = [];
  const cy = (a.p.y + b.p.y) / 2;
  for (let i = 1; i < 5; i++) {
    const t = i / 5;
    const s = 1 - t;
    out.push({
      x: s * s * a.p.x + 2 * s * t * m.x.x + t * t * b.p.x,
      y: s * s * a.p.y + 2 * s * t * cy + t * t * b.p.y,
      z: s * s * a.p.z + 2 * s * t * m.x.z + t * t * b.p.z,
    });
  }
  return out;
}

/** 0 at both ends, 1 through the middle third, so a moved kerb still meets the road edges. */
function plateau(s: number, total: number): number {
  const ease = total * 0.33;
  const ramp = (x: number) => {
    const t = clamp(x / ease, 0, 1);
    return t * t * (3 - 2 * t);
  };
  return ramp(s) * ramp(total - s);
}

/**
 * Points strictly between two ends, no more than `step` apart along the chain, so
 * the renderer's even resampling of a corner keeps its shape.
 */
export function evenCorner(from: Vec3, pts: readonly Vec3[], to: Vec3, step = 0.5): Vec3[] {
  const chain = [from, ...pts, to];
  const out: Vec3[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const p = chain[i];
    const q = chain[i + 1];
    if (i > 0) out.push(p);
    const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / step));
    for (let k = 1; k < n; k++) {
      const f = k / n;
      out.push({ x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f, z: p.z + (q.z - p.z) * f });
    }
  }
  return out;
}

/**
 * Push a corner's kerb into the road by `kerb` metres through the middle, easing
 * to nothing at the cut points. Into the road is to the right of the outline's
 * clockwise walk.
 */
export function bulgeCorner(from: Vec3, pts: readonly Vec3[], to: Vec3, kerb: number): Vec3[] {
  const chain = [from, ...evenCorner(from, pts, to, 0.4), to];
  const cum = [0];
  for (let i = 1; i < chain.length; i++) cum.push(cum[i - 1] + Math.hypot(chain[i].x - chain[i - 1].x, chain[i].z - chain[i - 1].z));
  const total = cum[cum.length - 1] || 1;
  const out: Vec3[] = [];
  // Normals from points about a metre either side, so the kinks of a coarse curve do not fold the offset.
  let lo = 0;
  let hi = 0;
  for (let i = 1; i + 1 < chain.length; i++) {
    while (lo < i - 1 && cum[i] - cum[lo + 1] >= 1) lo++;
    while (hi < chain.length - 1 && (hi <= i || cum[hi] - cum[i] < 1)) hi++;
    const prev = chain[Math.min(lo, i - 1)];
    const next = chain[Math.max(hi, i + 1)];
    const right = rightOf({ x: next.x - prev.x, y: 0, z: next.z - prev.z });
    const k = kerb * plateau(cum[i], total);
    out.push({ x: chain[i].x + right.x * k, y: chain[i].y, z: chain[i].z + right.z * k });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layout hooks, called from junction.ts
// ---------------------------------------------------------------------------

/** Sidewalk on each side of an arm, looking at the node. */
export function armWalks(def: RoadTypeDef, atStart: boolean): { left: number; right: number } {
  return { left: sidewalkOn(def, atStart ? 1 : -1), right: sidewalkOn(def, atStart ? -1 : 1) };
}

/** Kerb widths from the centreline, looking at the node, after any arm-end shift. */
export function kerbWidths(def: RoadTypeDef, arm: ShapeArm | undefined): { left: number; right: number } {
  return { left: def.halfWidth - (arm?.edgeLeft ?? 0), right: def.halfWidth - (arm?.edgeRight ?? 0) };
}

/**
 * Trims after the shape: each arm's own trim delta, then whatever a corner's kerb
 * radius needs so its tangent points land inside the junction box. `kerbMeet`
 * finds where arm i's left kerb and arm j's right kerb cross, in arc length out
 * from the node along each.
 */
export function applyShapeTrims(
  arms: ArmLayout[],
  shape: JunctionShape,
  kerbMeet: (i: number, j: number, wi: number, wj: number) => { sa: number; sb: number } | null,
  minTrim: number,
  maxTrim: number,
): void {
  const n = arms.length;
  for (const arm of arms) {
    const delta = shape.arms?.[arm.segmentId]?.trim;
    if (delta) arm.rawTrim = clamp(arm.rawTrim + delta, minTrim, maxTrim);
  }
  if (!shape.corners || n < 2) return;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (n === 2 && i === 1 && arms[0].segmentId === arms[1].segmentId) continue;
    const c = shape.corners[cornerKey(arms[i].segmentId, arms[j].segmentId)];
    if (!c?.radius) continue;
    const theta = wrapPositive(arms[j].angle - arms[i].angle);
    if (theta < 0.05 || theta > Math.PI - 0.05) continue;
    const wi = kerbWidths(arms[i].source.def, shape.arms?.[arms[i].segmentId]).left;
    const wj = kerbWidths(arms[j].source.def, shape.arms?.[arms[j].segmentId]).right;
    const hit = kerbMeet(i, j, wi, wj);
    if (!hit) continue;
    const t = c.radius / Math.tan(theta / 2) + 0.3;
    arms[i].rawTrim = clamp(Math.max(arms[i].rawTrim, hit.sa + t), 0, maxTrim);
    arms[j].rawTrim = clamp(Math.max(arms[j].rawTrim, hit.sb + t), 0, maxTrim);
  }
}

export interface ShapeCut {
  centre: Vec3;
  cutDir: Vec3;
  outRight: Vec3;
  angle: number;
}

export interface ShapeArmInfo {
  segmentId: Id;
  atStart: boolean;
  def: RoadTypeDef;
}

type CornerHook = (i: number, j: number, a: Ray, b: Ray, base: Vec3[]) => Vec3[] | null;

export interface OutlineHooks {
  /** Kerb widths per arm for the carriageway outline. */
  innerSides: { left: number; right: number }[];
  innerCorner: CornerHook;
  outerCorner: CornerHook;
  /** Kerb points on each cut line, where they moved off the road edges. */
  kerbs: ({ left?: Vec3; right?: Vec3 } | null)[];
}

/** The hooks buildNodeGeom passes to buildOutline when a node has a shape. */
export function shapeOutlineHooks(arms: ShapeArmInfo[], cuts: ShapeCut[], shape: JunctionShape): OutlineHooks {
  const n = arms.length;
  const armShape = (i: number) => shape.arms?.[arms[i].segmentId];
  const innerSides = arms.map((a, i) => kerbWidths(a.def, armShape(i)));
  const walks = arms.map((a) => armWalks(a.def, a.atStart));
  const kerbs = arms.map((a, i) => {
    const s = armShape(i);
    if (!s?.edgeLeft && !s?.edgeRight) return null;
    const c = cuts[i];
    const out: { left?: Vec3; right?: Vec3 } = {};
    const at = (w: number): Vec3 => ({ x: c.centre.x + c.outRight.x * w, y: c.centre.y, z: c.centre.z + c.outRight.z * w });
    if (s.edgeLeft) out.left = at(innerSides[i].left);
    if (s.edgeRight) out.right = at(-innerSides[i].right);
    return out;
  });
  const cornerOf = (i: number, j: number): ShapeCorner | undefined => (n < 2 ? undefined : shape.corners?.[cornerKey(arms[i].segmentId, arms[j].segmentId)]);
  const outerRay = (i: number, side: 'left' | 'right'): Ray => {
    const c = cuts[i];
    const w = arms[i].def.halfWidth + walks[i][side];
    const sgn = side === 'left' ? 1 : -1;
    return { p: { x: c.centre.x + c.outRight.x * w * sgn, y: c.centre.y, z: c.centre.z + c.outRight.z * w * sgn }, dir: c.cutDir };
  };
  // Radius actually used by each inner corner, so the outer one stays concentric.
  const usedRadius = new Map<string, number>();
  const outerFor = (i: number, j: number, a: Ray, b: Ray, base: Vec3[]): Vec3[] | null => {
    const c = cornerOf(i, j);
    if (c?.radius === undefined) return null;
    const key = `${i}:${j}`;
    const inner = usedRadius.get(key);
    const r = (inner ?? c.radius) - (walks[i].left + walks[j].right) / 2;
    const fit = filletCorner(a, b, Math.max(0, r < 0.3 ? 0 : r));
    return evenCorner(a.p, fit ? fit.pts : base, b.p);
  };
  const innerCorner: CornerHook = (i, j, a, b, base) => {
    const c = cornerOf(i, j);
    if (!c) return null;
    if (c.sidewalk === false && (walks[i].left > 0 || walks[j].right > 0)) {
      // No sidewalk: the asphalt runs out along the cut to the back edge and round it.
      const oa = outerRay(i, 'left');
      const ob = outerRay(j, 'right');
      const outer = outerFor(i, j, oa, ob, []) ?? quadraticCorner(oa, ob);
      return evenCorner(a.p, [oa.p, ...outer, ob.p], b.p);
    }
    let pts = base;
    if (c.radius !== undefined) {
      const fit = filletCorner(a, b, c.radius);
      if (fit) {
        pts = fit.pts;
        usedRadius.set(`${i}:${j}`, fit.radius);
      }
    }
    if (c.kerb) pts = bulgeCorner(a.p, pts, b.p, c.kerb);
    return pts === base ? null : evenCorner(a.p, pts, b.p);
  };
  return { innerSides, innerCorner, outerCorner: outerFor, kerbs };
}

// ---------------------------------------------------------------------------
// Arm ends: the kerb shift along a road near a shaped junction
// ---------------------------------------------------------------------------

function edgeProfile(d: number, room: number): number {
  const hold = Math.min(EDGE_HOLD, room * 0.25);
  const taper = Math.min(EDGE_TAPER, Math.max(0.5, room * 0.45 - hold));
  if (d <= hold) return 1;
  if (d >= hold + taper) return 0;
  const t = (d - hold) / taper;
  return 1 - t * t * (3 - 2 * t);
}

/**
 * The kerb shift along a segment from shaped arm ends, as a function of side
 * (1 right of a-to-b, -1 left) and arc length along the full curve. Positive moves
 * the kerb into the road. Null when neither end is shaped.
 */
export function segmentKerbShift(net: RoadNetwork, segId: Id): ((side: 1 | -1, s: number) => number) | null {
  const seg = net.getSegment(segId);
  const geom = net.segmentGeom(segId);
  if (!seg || !geom || geom.stations.length < 2) return null;
  const ends: { e: ShapeArm; atStart: boolean }[] = [];
  for (const [nodeId, atStart] of [[seg.a, true], [seg.b, false]] as const) {
    if (net.nodeGeom(nodeId)?.kind !== 'junction') continue;
    const e = net.getNode(nodeId)?.control.shape?.arms?.[segId];
    if (e && (e.edgeLeft || e.edgeRight)) ends.push({ e, atStart });
  }
  if (!ends.length) return null;
  const s0 = geom.trimA;
  const s1 = geom.fullLength - geom.trimB;
  const room = s1 - s0;
  return (side, s) => {
    let out = 0;
    for (const { e, atStart } of ends) {
      // Looking at node a from the road, its left is the road's right.
      const v = atStart ? (side === 1 ? e.edgeLeft : e.edgeRight) : side === 1 ? e.edgeRight : e.edgeLeft;
      if (!v) continue;
      out += v * edgeProfile(atStart ? s - s0 : s1 - s, room);
    }
    return out;
  };
}

/** Where the taper of a shaped arm end needs cross sections, as arc lengths. */
export function kerbShiftStations(net: RoadNetwork, segId: Id): number[] {
  const seg = net.getSegment(segId);
  const geom = net.segmentGeom(segId);
  if (!seg || !geom || !segmentKerbShift(net, segId)) return [];
  const s0 = geom.trimA;
  const s1 = geom.fullLength - geom.trimB;
  const room = s1 - s0;
  const hold = Math.min(EDGE_HOLD, room * 0.25);
  const taper = Math.min(EDGE_TAPER, Math.max(0.5, room * 0.45 - hold));
  const out: number[] = [];
  for (let k = 0; k <= 8; k++) {
    const d = k === 0 ? 0 : hold + (taper * (k - 1)) / 7;
    out.push(s0 + d, s1 - d);
  }
  return out.filter((s) => s > s0 - 1e-6 && s < s1 + 1e-6);
}

/** Road edges of a segment with shaped arm ends applied: the kerb lines, a to b. */
export function shapedKerbLines(net: RoadNetwork, segId: Id): { left: Vec3[]; right: Vec3[] } | null {
  const geom = net.segmentGeom(segId);
  if (!geom || geom.stations.length < 2) return null;
  const H = net.roadTypeOf(segId).halfWidth;
  const shift = segmentKerbShift(net, segId);
  const curve = net.curveOf(segId);
  const sts: Station[] = [...geom.stations];
  for (const s of kerbShiftStations(net, segId)) {
    if (sts.every((st) => Math.abs(st.s - s) > 0.05)) sts.push({ ...stationAt(curve, s), right: geom.stations[0].right });
  }
  sts.sort((a, b) => a.s - b.s);
  // Keep each station's own right vector where it has one; the added ones take the curve's.
  for (let i = 0; i < sts.length; i++) {
    if (!geom.stations.includes(sts[i])) sts[i] = stationAt(curve, sts[i].s);
  }
  const at = (st: Station, side: 1 | -1) => {
    const w = H - (shift ? shift(side, st.s) : 0);
    return { x: st.pos.x + st.right.x * w * side, y: st.pos.y, z: st.pos.z + st.right.z * w * side };
  };
  return { left: sts.map((st) => at(st, -1)), right: sts.map((st) => at(st, 1)) };
}

// ---------------------------------------------------------------------------
// Islands
// ---------------------------------------------------------------------------

/** Offsets of an arm's boundaries counted from its left edge looking at the node. */
export function islandBoundaryOffsets(def: RoadTypeDef, overrides: SegmentOverrides | undefined, atStart: boolean): number[] {
  const offs = boundaryOffsets(def, overrides);
  return atStart ? [...offs].reverse() : offs;
}

/** Turn an a-to-b boundary index (as node markings store) into the island's count. */
export function islandIndexOf(boundary: number, count: number, atStart: boolean): number {
  return atStart ? count - 1 - boundary : boundary;
}

interface ArmLine {
  pos: Vec3;
  /** Right of a-to-b travel. */
  right: Vec3;
}

/** A point on an arm's centreline: d metres into the junction, or back along the road when negative. */
function armLineAt(arm: NodeArm, stations: readonly Station[] | undefined, d: number): ArmLine {
  const forward = arm.atStart ? arm.cutDir : { x: -arm.cutDir.x, y: 0, z: -arm.cutDir.z };
  const cutRight = rightOf(forward);
  if (d >= 0 || !stations || stations.length < 2) {
    return { pos: { x: arm.centre.x - arm.cutDir.x * d, y: arm.centre.y, z: arm.centre.z - arm.cutDir.z * d }, right: cutRight };
  }
  const back = -d;
  const n = stations.length;
  const st = (k: number) => (arm.atStart ? stations[k] : stations[n - 1 - k]);
  const base = st(0).s;
  const dist = (k: number) => Math.abs(st(k).s - base);
  for (let k = 1; k < n; k++) {
    if (dist(k) >= back) {
      const a = st(k - 1);
      const b = st(k);
      const span = dist(k) - dist(k - 1);
      const f = span > 1e-9 ? (back - dist(k - 1)) / span : 0;
      const right = normalizeXZ({ x: a.right.x + (b.right.x - a.right.x) * f, y: 0, z: a.right.z + (b.right.z - a.right.z) * f });
      return { pos: { x: a.pos.x + (b.pos.x - a.pos.x) * f, y: a.pos.y + (b.pos.y - a.pos.y) * f, z: a.pos.z + (b.pos.z - a.pos.z) * f }, right };
    }
  }
  const last = st(n - 1);
  return { pos: last.pos, right: last.right };
}

/** Twice the signed plan area, positive clockwise viewed from above, as in junction.ts. */
function signedArea(poly: readonly Vec3[]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area;
}

/** The island's plan outline, clockwise, or null when it has no room. */
export function islandPolygon(
  arm: NodeArm,
  def: RoadTypeDef,
  overrides: SegmentOverrides | undefined,
  stations: readonly Station[] | undefined,
  island: ShapeIsland,
): Vec3[] | null {
  const offs = islandBoundaryOffsets(def, overrides, arm.atStart);
  const oa = offs[island.from];
  const ob = offs[island.to];
  if (oa === undefined || ob === undefined) return null;
  // The list is ordered looking at the node, but the values are a-to-b offsets.
  const lo = Math.min(oa, ob) + ISLAND_INSET;
  const hi = Math.max(oa, ob) - ISLAND_INSET;
  const hw = (hi - lo) / 2;
  const mid = (lo + hi) / 2;
  const L = island.back + island.reach;
  if (hw < 0.15 || L < 0.4) return null;
  const nose = Math.min(hw, L / 2);
  const ds: number[] = [];
  const steps = Math.max(2, Math.ceil(L / 1));
  for (let k = 0; k <= steps; k++) ds.push(-island.back + (L * k) / steps);
  for (let k = 1; k < 8; k++) {
    const f = 1 - Math.cos(((k / 8) * Math.PI) / 2);
    ds.push(-island.back + nose * f, island.reach - nose * f);
  }
  ds.sort((a, b) => a - b);
  const halfAt = (d: number) => {
    const e = Math.min(d + island.back, island.reach - d);
    if (e >= nose) return hw;
    const q = (nose - Math.max(0, e)) / nose;
    return hw * Math.sqrt(Math.max(0, 1 - q * q));
  };
  const side1: Vec3[] = [];
  const side2: Vec3[] = [];
  let lastD = -Infinity;
  for (const d of ds) {
    if (d - lastD < 0.02) continue;
    lastD = d;
    const line = armLineAt(arm, stations, d);
    const w = halfAt(d);
    const c = mid;
    side1.push({ x: line.pos.x + line.right.x * (c - w), y: line.pos.y, z: line.pos.z + line.right.z * (c - w) });
    side2.push({ x: line.pos.x + line.right.x * (c + w), y: line.pos.y, z: line.pos.z + line.right.z * (c + w) });
  }
  const poly = [...side1, ...side2.reverse()];
  const clean: Vec3[] = [];
  for (const p of poly) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.z - p.z) > 0.01) clean.push(p);
  }
  if (clean.length > 2 && Math.hypot(clean[0].x - clean[clean.length - 1].x, clean[0].z - clean[clean.length - 1].z) <= 0.01) clean.pop();
  if (clean.length < 3) return null;
  return signedArea(clean) < 0 ? clean.reverse() : clean;
}

/** Every island at a node with its outline. */
export function islandPolygons(net: RoadNetwork, nodeId: Id): { island: ShapeIsland; poly: Vec3[] }[] {
  const node = net.getNode(nodeId);
  const geom = net.nodeGeom(nodeId);
  if (!node?.control.shape?.islands || !geom || geom.kind !== 'junction') return [];
  const out: { island: ShapeIsland; poly: Vec3[] }[] = [];
  for (const island of node.control.shape.islands) {
    const arm = geom.arms.find((a) => a.segmentId === island.segmentId);
    const seg = net.getSegment(island.segmentId);
    if (!arm || !seg) continue;
    const poly = islandPolygon(arm, net.roadTypeOf(seg.id), seg.overrides, net.segmentGeom(seg.id)?.stations, island);
    if (poly) out.push({ island, poly });
  }
  return out;
}

function pointInPoly(x: number, z: number, poly: readonly Vec3[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function distToSegment(x: number, z: number, a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 1e-12 ? clamp(((x - a.x) * dx + (z - a.z) * dz) / l2, 0, 1) : 0;
  return Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
}

function distToPolyline(x: number, z: number, pts: readonly Vec3[], closed: boolean): number {
  let best = Infinity;
  const n = pts.length;
  for (let i = 0; i + 1 < n + (closed ? 1 : 0); i++) best = Math.min(best, distToSegment(x, z, pts[i], pts[(i + 1) % n]));
  return best;
}

/** Points of a polyline no more than `step` metres apart, with arc length. */
function densify(pts: Float32Array, cum: Float32Array, step: number): { x: number; z: number; s: number }[] {
  const out: { x: number; z: number; s: number }[] = [];
  const n = cum.length;
  for (let i = 0; i + 1 < n; i++) {
    const ax = pts[i * 3];
    const az = pts[i * 3 + 2];
    const bx = pts[i * 3 + 3];
    const bz = pts[i * 3 + 5];
    const span = cum[i + 1] - cum[i];
    const k = Math.max(1, Math.ceil(span / step));
    for (let j = 0; j < k; j++) out.push({ x: ax + ((bx - ax) * j) / k, z: az + ((bz - az) * j) / k, s: cum[i] + (span * j) / k });
  }
  if (n) out.push({ x: pts[n * 3 - 3], z: pts[n * 3 - 1], s: cum[n - 1] });
  return out;
}

/** True when a connector runs through, or within clearance of, any of the islands. */
export function crossesIslands(pts: Float32Array, cum: Float32Array, islands: readonly Vec3[][], clearance = KERB_CLEARANCE): boolean {
  if (!islands.length) return false;
  for (const p of densify(pts, cum, 0.5)) {
    for (const poly of islands) {
      if (pointInPoly(p.x, p.z, poly) || distToPolyline(p.x, p.z, poly, true) < clearance) return true;
    }
  }
  return false;
}

/**
 * For laneGraph.buildNodeLanes: a test for connectors that run through an island,
 * which are left out so traffic splits either side of it. Null when there are none.
 */
export function islandBlocker(
  geom: NodeGeom,
  shape: JunctionShape | undefined,
  defOf: (id: Id) => RoadTypeDef,
  geomOf: (id: Id) => SegmentGeom | undefined,
  overridesOf?: (id: Id) => SegmentOverrides | undefined,
): ((c: ConnectorProto) => boolean) | null {
  if (!shape?.islands?.length || geom.kind !== 'junction') return null;
  const polys: Vec3[][] = [];
  for (const island of shape.islands) {
    const arm = geom.arms.find((a) => a.segmentId === island.segmentId);
    if (!arm) continue;
    const poly = islandPolygon(arm, defOf(arm.segmentId), overridesOf?.(arm.segmentId), geomOf(arm.segmentId)?.stations, island);
    if (poly) polys.push(poly);
  }
  if (!polys.length) return null;
  return (c) => crossesIslands(c.poly.pts, c.poly.cum, polys);
}

// ---------------------------------------------------------------------------
// Kerbs and connectors
// ---------------------------------------------------------------------------

/** The kerb of each corner, from an arm's left kerb point to the next arm's right one. */
export function kerbChainsOf(geom: NodeGeom): Vec3[][] {
  if (geom.kind !== 'junction' || geom.outline.length < 3) return [];
  const out: Vec3[][] = [];
  const n = geom.arms.length;
  for (let i = 0; i < n; i++) {
    const a = geom.arms[i];
    const b = geom.arms[(i + 1) % n];
    const chain = walkOutline(geom.outline, nearestIndex(geom.outline, a.kerbLeft ?? a.leftEdge), nearestIndex(geom.outline, b.kerbRight ?? b.rightEdge));
    if (chain && chain.length >= 2) out.push(chain);
  }
  return out;
}

interface KerbScene {
  outline: readonly Vec3[];
  kerbs: readonly Vec3[][];
  cuts: readonly Vec3[][];
  islands: readonly Vec3[][];
}

function sceneOf(geom: NodeGeom, islands: readonly Vec3[][]): KerbScene {
  return {
    outline: geom.outline,
    kerbs: kerbChainsOf(geom),
    cuts: geom.arms.map((a) => [a.kerbLeft ?? a.leftEdge, a.leftEdge, a.rightEdge, a.kerbRight ?? a.rightEdge]),
    islands,
  };
}

/**
 * How close a connector comes to a kerb or island, past its first and last metre:
 * negative when it runs through one, or off the asphalt away from the cut lines.
 */
function clearanceIn(scene: KerbScene, pts: Float32Array, cum: Float32Array, length: number): number {
  let worst = Infinity;
  const skip = Math.min(1, length * 0.2);
  for (const p of densify(pts, cum, 0.5)) {
    if (p.s < skip || p.s > length - skip) continue;
    let d = Infinity;
    for (const k of scene.kerbs) d = Math.min(d, distToPolyline(p.x, p.z, k, false));
    for (const poly of scene.islands) {
      const e = distToPolyline(p.x, p.z, poly, true);
      d = Math.min(d, pointInPoly(p.x, p.z, poly) ? -e : e);
    }
    if (!pointInPoly(p.x, p.z, scene.outline)) {
      let dc = Infinity;
      for (const c of scene.cuts) dc = Math.min(dc, distToPolyline(p.x, p.z, c, false));
      if (dc > 0.3) d = Math.min(d, -dc);
    }
    worst = Math.min(worst, d);
  }
  return worst;
}

function slopeOf(v: Vec3): number {
  const l = Math.hypot(v.x, v.z);
  return l < 1e-9 ? 0 : clamp(v.y / l, -1, 1);
}

/** A connector curve with handles k times the distance to where the lane lines meet: larger swings wider. */
export function swungCubic(from: { pos: Vec3; tan: Vec3 }, to: { pos: Vec3; tan: Vec3 }, k: number): Cubic | null {
  const d0 = normalizeXZ(from.tan);
  const d3 = normalizeXZ(to.tan);
  const denom = crossXZ(d0, d3);
  if (Math.abs(denom) < 0.05) return null;
  const dx = to.pos.x - from.pos.x;
  const dz = to.pos.z - from.pos.z;
  // Solve p0 + d0 u = p3 - d3 v for where the two lane lines meet.
  const u = (dx * d3.z - dz * d3.x) / denom;
  const v = (d0.x * dz - dx * d0.z) / denom;
  if (!(u > 0 && v > 0)) return null;
  const h0 = k * u;
  const h3 = k * v;
  const p0 = from.pos;
  const p3 = to.pos;
  return {
    p0,
    p1: { x: p0.x + d0.x * h0, y: p0.y + slopeOf(from.tan) * h0, z: p0.z + d0.z * h0 },
    p2: { x: p3.x - d3.x * h3, y: p3.y - slopeOf(to.tan) * h3, z: p3.z - d3.z * h3 },
    p3,
  };
}

/**
 * For laneGraph.buildNodeLanes at a junction whose kerbs were moved: a turn that
 * would cut across a kerb swings wider instead, as a driver would round a tight
 * corner. Null when the node has no kerb edits, so nothing changes elsewhere.
 */
export function kerbFitter(
  geom: NodeGeom,
  shape: JunctionShape | undefined,
): ((link: { from: { pos: Vec3; tan: Vec3 }; to: { pos: Vec3; tan: Vec3 } }, build: (cubic?: Cubic) => ConnectorProto | null) => ConnectorProto | null) | null {
  if (!shape || geom.kind !== 'junction') return null;
  const moved = Object.values(shape.corners ?? {}).some((c) => c.radius !== undefined || c.kerb) || Object.values(shape.arms ?? {}).some((a) => a.edgeLeft || a.edgeRight);
  if (!moved) return null;
  const scene = sceneOf(geom, []);
  if (!scene.kerbs.length) return null;
  return (link, build) => {
    const c = build();
    if (!c) return c;
    let best = c;
    const need = clearanceNeed(c.width);
    let bestClear = clearanceIn(scene, c.poly.pts, c.poly.cum, c.poly.length);
    if (bestClear >= need) return c;
    for (const k of [0.75, 0.9, 1.05, 1.2, 1.35]) {
      const cubic = swungCubic(link.from, link.to, k);
      if (!cubic) break;
      const alt = build(cubic);
      if (!alt) continue;
      const clear = clearanceIn(scene, alt.poly.pts, alt.poly.cum, alt.poly.length);
      if (clear > bestClear + 1e-6) {
        best = alt;
        bestClear = clear;
      }
      if (clear >= need) break;
    }
    return best;
  };
}

// ---------------------------------------------------------------------------
// Reading a node for the editor
// ---------------------------------------------------------------------------

export const kerbLeftOf = (arm: NodeArm): Vec3 => arm.kerbLeft ?? arm.leftEdge;
export const kerbRightOf = (arm: NodeArm): Vec3 => arm.kerbRight ?? arm.rightEdge;

function nearestIndex(poly: readonly Vec3[], p: Vec3, tol = 0.05): number {
  let best = -1;
  let bestD = tol * tol;
  for (let i = 0; i < poly.length; i++) {
    const d = (poly[i].x - p.x) ** 2 + (poly[i].z - p.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Outline points from one index forward to another, inclusive. */
function walkOutline(poly: readonly Vec3[], from: number, to: number): Vec3[] | null {
  if (from < 0 || to < 0) return null;
  const out: Vec3[] = [];
  for (let k = 0; k <= poly.length; k++) {
    const i = (from + k) % poly.length;
    out.push(poly[i]);
    if (i === to && k > 0) return out;
  }
  return null;
}

export interface CornerInfo {
  key: string;
  /** Index of the arm whose left edge starts the corner. */
  arm: number;
  next: number;
  segmentId: Id;
  nextSegmentId: Id;
  /** The kerb, from one cut point to the other. */
  kerb: Vec3[];
  /** The sidewalk's back edge, when the outer outline could be followed. */
  back: Vec3[] | null;
  /** Middle of the kerb by length. */
  apex: Vec3;
  /** Unit direction from the apex into the road. */
  inward: Vec3;
  /** Where the two kerb lines meet, and the angle between them. */
  meetPoint: Vec3 | null;
  opening: number;
  /** Kerb radius now: the one set, or the automatic corner's equivalent. */
  radius: number;
  /** Sidewalk widths at the two ends of the corner. */
  walkA: number;
  walkB: number;
  hasSidewalk: boolean;
  setting: ShapeCorner;
}

function pointAlong(pts: readonly Vec3[], u: number): { p: Vec3; dir: Vec3 } {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const s = clamp(u, 0, 1) * cum[cum.length - 1];
  let k = 1;
  while (k < cum.length - 1 && cum[k] < s) k++;
  const a = pts[k - 1];
  const b = pts[k];
  const span = cum[k] - cum[k - 1];
  const f = span > 1e-9 ? (s - cum[k - 1]) / span : 0;
  return {
    p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f },
    dir: normalizeXZ({ x: b.x - a.x, y: 0, z: b.z - a.z }),
  };
}

/** Every corner of a junction, with what the editor needs to put handles on it. */
export function cornerInfos(net: RoadNetwork, nodeId: Id): CornerInfo[] {
  const geom = net.nodeGeom(nodeId);
  const node = net.getNode(nodeId);
  if (!geom || !node || geom.kind !== 'junction' || geom.outline.length < 3) return [];
  const n = geom.arms.length;
  const out: CornerInfo[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const A = geom.arms[i];
    const B = geom.arms[j];
    const kerb = walkOutline(geom.outline, nearestIndex(geom.outline, kerbLeftOf(A)), nearestIndex(geom.outline, kerbRightOf(B)));
    if (!kerb || kerb.length < 2) continue;
    const defA = net.roadTypeOf(A.segmentId);
    const defB = net.roadTypeOf(B.segmentId);
    const walkA = armWalks(defA, A.atStart).left;
    const walkB = armWalks(defB, B.atStart).right;
    const outerA = { x: A.centre.x + (A.leftEdge.x - A.centre.x) * ((defA.halfWidth + walkA) / defA.halfWidth), y: A.centre.y, z: A.centre.z + (A.leftEdge.z - A.centre.z) * ((defA.halfWidth + walkA) / defA.halfWidth) };
    const outerB = { x: B.centre.x + (B.rightEdge.x - B.centre.x) * ((defB.halfWidth + walkB) / defB.halfWidth), y: B.centre.y, z: B.centre.z + (B.rightEdge.z - B.centre.z) * ((defB.halfWidth + walkB) / defB.halfWidth) };
    const back = walkOutline(geom.outerOutline, nearestIndex(geom.outerOutline, outerA), nearestIndex(geom.outerOutline, outerB));
    const mid = pointAlong(kerb, 0.5);
    const inward = rightOf(mid.dir);
    const ra: Ray = { p: kerbLeftOf(A), dir: A.cutDir };
    const rb: Ray = { p: kerbRightOf(B), dir: B.cutDir };
    const m = meet(ra, rb);
    const opening = openingOf(ra, rb);
    const key = cornerKey(A.segmentId, B.segmentId);
    const setting = node.control.shape?.corners?.[key] ?? {};
    let radius = setting.radius ?? NaN;
    if (!Number.isFinite(radius)) radius = m && m.u > 0 && m.v > 0 ? Math.min(m.u, m.v) * Math.tan(opening / 2) : NaN;
    out.push({
      key,
      arm: i,
      next: j,
      segmentId: A.segmentId,
      nextSegmentId: B.segmentId,
      kerb,
      back,
      apex: mid.p,
      inward,
      meetPoint: m && m.u > 0 && m.v > 0 ? m.x : null,
      opening,
      radius,
      walkA,
      walkB,
      hasSidewalk: walkA > 0 || walkB > 0,
      setting,
    });
  }
  return out;
}

/** True when a corner can take a kerb radius: its kerb lines meet in front of the cuts. */
export function cornerTakesRadius(c: CornerInfo): boolean {
  return !!c.meetPoint && c.opening > 0.05 && c.opening < Math.PI - 0.05;
}

/** Kerb radius from how far the apex sits from where the kerb lines meet. */
export function radiusFromApexDistance(d: number, opening: number): number {
  const k = 1 / Math.sin(opening / 2) - 1;
  return k > 1e-6 ? Math.max(0, d) / k : RADIUS_MAX;
}

export function apexDistanceFromRadius(r: number, opening: number): number {
  return r * (1 / Math.sin(opening / 2) - 1);
}

export interface ArmInfo {
  segmentId: Id;
  arm: NodeArm;
  /** Centre of the cut line and the unit direction out along the road. */
  centre: Vec3;
  out: Vec3;
  /** Unit direction to the arm's left looking at the node. */
  left: Vec3;
  kerbLeft: Vec3;
  kerbRight: Vec3;
  walkLeft: number;
  walkRight: number;
  /** Width of road edge not taken by a lane on each side, where a bulb-out may go. */
  spareLeft: number;
  spareRight: number;
  setting: ShapeArm;
  /** Boundary offsets left to right looking at the node, for islands. */
  boundaries: number[];
}

/** Lane-free width at each road edge, looking at the node. */
function spareWidths(def: RoadTypeDef, overrides: SegmentOverrides | undefined, atStart: boolean): { left: number; right: number } {
  const lanes = effectiveLanes(def, overrides);
  if (!lanes.length) return { left: 0, right: 0 };
  const lo = Math.min(...lanes.map((l) => l.offset - l.width / 2));
  const hi = Math.max(...lanes.map((l) => l.offset + l.width / 2));
  const minus = Math.max(0, lo + def.halfWidth);
  const plus = Math.max(0, def.halfWidth - hi);
  // Looking at the node, the left of an arm leaving from a is the road's right.
  return atStart ? { left: plus, right: minus } : { left: minus, right: plus };
}

export function armInfos(net: RoadNetwork, nodeId: Id): ArmInfo[] {
  const geom = net.nodeGeom(nodeId);
  const node = net.getNode(nodeId);
  if (!geom || !node || geom.kind !== 'junction') return [];
  return geom.arms.map((arm) => {
    const seg = net.getSegment(arm.segmentId)!;
    const def = net.roadTypeOf(arm.segmentId);
    const walks = armWalks(def, arm.atStart);
    const spare = spareWidths(def, seg?.overrides, arm.atStart);
    const left = normalizeXZ({ x: arm.leftEdge.x - arm.centre.x, y: 0, z: arm.leftEdge.z - arm.centre.z });
    return {
      segmentId: arm.segmentId,
      arm,
      centre: arm.centre,
      out: arm.cutDir,
      left,
      kerbLeft: kerbLeftOf(arm),
      kerbRight: kerbRightOf(arm),
      walkLeft: walks.left,
      walkRight: walks.right,
      spareLeft: spare.left,
      spareRight: spare.right,
      setting: node.control.shape?.arms?.[arm.segmentId] ?? {},
      boundaries: islandBoundaryOffsets(def, seg?.overrides, arm.atStart),
    };
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ShapeTarget = { kind: 'corner'; key: string } | { kind: 'arm'; segmentId: Id } | { kind: 'island'; id: Id } | { kind: 'node' };

export interface ShapeProblem {
  code: 'coversLane' | 'noSidewalk' | 'tooNarrow' | 'tooTight' | 'tooShort' | 'folds' | 'kerbHit' | 'stranded' | 'noRoom';
  message: string;
  target: ShapeTarget;
}

function laneName(i: number): string {
  return `lane ${i + 1}`;
}

/** Problems that can be seen from the numbers alone, before trying the shape. */
export function shapeParamProblems(net: RoadNetwork, nodeId: Id, shape: JunctionShape | undefined): ShapeProblem[] {
  const out: ShapeProblem[] = [];
  const node = net.getNode(nodeId);
  const geom = net.nodeGeom(nodeId);
  if (!node || !geom || !shape) return out;
  if (geom.kind !== 'junction' && hasShape(shape)) {
    out.push({ code: 'noRoom', message: 'Only a junction has a shape to edit.', target: { kind: 'node' } });
    return out;
  }
  const arms = armInfos(net, nodeId);
  for (const a of arms) {
    const s = shape.arms?.[a.segmentId];
    if (!s) continue;
    for (const side of ['Left', 'Right'] as const) {
      const v = s[`edge${side}`] ?? 0;
      const walk = side === 'Left' ? a.walkLeft : a.walkRight;
      const spare = side === 'Left' ? a.spareLeft : a.spareRight;
      if (v !== 0 && walk <= 0) {
        out.push({ code: 'noSidewalk', message: 'There is no sidewalk on this side to move.', target: { kind: 'arm', segmentId: a.segmentId } });
      } else if (v < -walk - 1e-6) {
        out.push({ code: 'tooNarrow', message: `The sidewalk is only ${walk.toFixed(1)} m wide here.`, target: { kind: 'arm', segmentId: a.segmentId } });
      } else if (v > spare + 1e-6) {
        out.push({
          code: 'coversLane',
          message: spare > 0 ? `A bulb-out here can take at most the ${spare.toFixed(1)} m beside the lanes.` : 'The kerb would cover a lane: this road has no parking or shoulder width to build out over.',
          target: { kind: 'arm', segmentId: a.segmentId },
        });
      }
    }
  }
  for (const c of cornerInfos(net, nodeId)) {
    const s = shape.corners?.[c.key];
    if (!s?.kerb) continue;
    const walk = Math.min(c.walkA, c.walkB);
    if (!c.hasSidewalk) out.push({ code: 'noSidewalk', message: 'This corner has no sidewalk to widen or narrow.', target: { kind: 'corner', key: c.key } });
    else if (s.kerb < -walk - 1e-6) out.push({ code: 'tooNarrow', message: `The sidewalk is only ${walk.toFixed(1)} m wide here.`, target: { kind: 'corner', key: c.key } });
    else if (s.kerb > KERB_MAX + 1e-6) out.push({ code: 'tooNarrow', message: `A kerb extension is at most ${KERB_MAX} m.`, target: { kind: 'corner', key: c.key } });
  }
  for (const island of shape.islands ?? []) {
    const a = arms.find((x) => x.segmentId === island.segmentId);
    const seg = net.getSegment(island.segmentId);
    if (!a || !seg) continue;
    const target: ShapeTarget = { kind: 'island', id: island.id };
    const oa = a.boundaries[island.from];
    const ob = a.boundaries[island.to];
    if (oa === undefined || ob === undefined) {
      out.push({ code: 'noRoom', message: 'That lane boundary no longer exists.', target });
      continue;
    }
    // The values are a-to-b offsets, whatever order the list is in.
    const lo = Math.min(oa, ob);
    const hi = Math.max(oa, ob);
    if (hi - lo - 2 * ISLAND_INSET < ISLAND_MIN_WIDTH - 1e-6) {
      out.push({ code: 'tooNarrow', message: `An island needs ${ISLAND_MIN_WIDTH} m between the boundaries.`, target });
      continue;
    }
    const lanes = effectiveLanes(net.roadTypeOf(seg.id), seg.overrides);
    const hit = lanes.findIndex((l) => Math.min(hi, l.offset + l.width / 2) - Math.max(lo, l.offset - l.width / 2) > 0.05);
    if (hit >= 0) out.push({ code: 'coversLane', message: `The island would cover ${laneName(hit)}.`, target });
    const visible = net.segmentGeom(seg.id)?.length ?? 0;
    if (island.back > visible - 1) out.push({ code: 'tooShort', message: 'The island runs past the end of the road.', target });
    if (island.back + island.reach < 1) out.push({ code: 'tooShort', message: 'The island is too short.', target });
  }
  return out;
}

/**
 * Per connector key at a node: how much more room it has from the nearest kerb or
 * island than it needs (clearanceNeed). Negative means it scrapes or crosses one.
 */
export function connectorClearances(net: RoadNetwork, nodeId: Id): Map<string, number> {
  const out = new Map<string, number>();
  const geom = net.nodeGeom(nodeId);
  if (!geom || geom.kind !== 'junction' || geom.outline.length < 3) return out;
  const scene = sceneOf(geom, islandPolygons(net, nodeId).map((i) => i.poly));
  const graph = net.laneGraph;
  for (const idx of graph.connectorsAt.get(nodeId) ?? []) {
    const lane = graph.lanes[idx];
    out.set(lane.key, clearanceIn(scene, lane.pts, lane.cum, lane.length) - clearanceNeed(lane.width));
  }
  return out;
}

/** Incoming driving lanes at a node with nowhere to go. */
function strandedLanes(net: RoadNetwork, nodeId: Id): string[] {
  const graph = net.laneGraph;
  const node = net.getNode(nodeId);
  if (!node || node.segments.length < 2) return [];
  const out: string[] = [];
  for (const segId of node.segments) {
    const seg = net.getSegment(segId)!;
    const lanes = graph.roadLanes.get(segId) ?? [];
    const def = net.roadTypeOf(segId);
    lanes.forEach((idx, i) => {
      if (idx < 0) return;
      const l = graph.lanes[idx];
      if (l.vehicleKind !== 'drive' && l.vehicleKind !== 'bus') return;
      const arrives = (def.lanes[i]?.dir === 1 ? seg.b : seg.a) === nodeId;
      if (arrives && l.next.length === 0) out.push(`${segId}:${i}`);
    });
  }
  return out;
}

/** Problems with the shape as now applied to the network, measured against `before`. */
export function shapeResultProblems(
  net: RoadNetwork,
  nodeId: Id,
  before: { clearances: Map<string, number>; stranded: Set<string>; simplified: boolean },
): ShapeProblem[] {
  const out: ShapeProblem[] = [];
  const geom = net.nodeGeom(nodeId);
  const node = net.getNode(nodeId);
  if (!geom || !node || geom.kind !== 'junction') return out;
  if (geom.outlineSimplified && !before.simplified) {
    out.push({ code: 'folds', message: 'The junction outline would fold over itself.', target: { kind: 'node' } });
  }
  for (const arm of geom.arms) {
    const missing = nearestIndex(geom.outline, kerbLeftOf(arm)) < 0 || nearestIndex(geom.outline, kerbRightOf(arm)) < 0;
    if (missing && !before.simplified) out.push({ code: 'tooTight', message: 'Too tight: the roads would overlap.', target: { kind: 'arm', segmentId: arm.segmentId } });
    const g = net.segmentGeom(arm.segmentId);
    if (g && g.length < MIN_VISIBLE && node.control.shape?.arms?.[arm.segmentId]?.trim) {
      out.push({ code: 'tooShort', message: 'Not enough road would be left.', target: { kind: 'arm', segmentId: arm.segmentId } });
    }
  }
  for (const { island, poly } of islandPolygons(net, nodeId)) {
    const arm = geom.arms.find((a) => a.segmentId === island.segmentId);
    if (!arm) continue;
    const ahead = poly.filter((p) => -((p.x - arm.centre.x) * arm.cutDir.x + (p.z - arm.centre.z) * arm.cutDir.z) > 0.05);
    if (ahead.some((p) => !pointInPoly(p.x, p.z, geom.outline))) {
      out.push({ code: 'noRoom', message: 'The island would run out of the junction.', target: { kind: 'island', id: island.id } });
    }
  }
  const graph = net.laneGraph;
  const corners = cornerInfos(net, nodeId);
  for (const [key, d] of connectorClearances(net, nodeId)) {
    const was = before.clearances.get(key) ?? 0;
    if (d < 0 && d < was - 0.05) {
      const lane = graph.lanes[graph.byKey.get(key) ?? -1];
      const from = lane ? graph.lanes[lane.fromLane].segmentId : -1;
      const to = lane ? graph.lanes[lane.toLane].segmentId : -1;
      const corner = corners.find((c) => c.nextSegmentId === from && c.segmentId === to) ?? corners.find((c) => c.segmentId === from || c.nextSegmentId === to);
      out.push({
        code: 'kerbHit',
        message: d < -clearanceNeed(lane?.width ?? 3) ? 'Turning traffic would drive through the kerb.' : 'Turning traffic would scrape the kerb.',
        target: corner ? { kind: 'corner', key: corner.key } : { kind: 'node' },
      });
      break;
    }
  }
  const stranded = strandedLanes(net, nodeId).filter((k) => !before.stranded.has(k));
  if (stranded.length) {
    const [seg, lane] = stranded[0].split(':').map(Number);
    const island = node.control.shape?.islands?.find((i) => i.segmentId !== seg) ?? node.control.shape?.islands?.[0];
    out.push({
      code: 'stranded',
      message: `${laneName(lane)} of ${net.getSegment(seg)?.overrides.name || net.roadTypeOf(seg).name} would have no way out.`,
      target: island ? { kind: 'island', id: island.id } : { kind: 'node' },
    });
  }
  return out;
}

export interface ShapeAttempt {
  ok: boolean;
  problems: ShapeProblem[];
}

/**
 * Set a node's shape if it is valid, else leave the node as it was and say why.
 * Validity is judged against the shape it replaces, so a node that was already
 * odd can still be edited as long as nothing gets worse.
 */
export function applyJunctionShape(net: RoadNetwork, nodeId: Id, shape: JunctionShape | null | undefined): ShapeAttempt {
  const node = net.getNode(nodeId);
  if (!node) return { ok: false, problems: [{ code: 'noRoom', message: 'That node is gone.', target: { kind: 'node' } }] };
  const next = normaliseShape(shape);
  const prev = node.control.shape ? structuredClone(node.control.shape) : undefined;
  if (JSON.stringify(next ?? null) === JSON.stringify(normaliseShape(prev) ?? null)) return { ok: true, problems: [] };
  const params = shapeParamProblems(net, nodeId, next);
  if (params.length) return { ok: false, problems: params };
  const geom = net.nodeGeom(nodeId);
  const before = {
    clearances: connectorClearances(net, nodeId),
    stranded: new Set(strandedLanes(net, nodeId)),
    simplified: !!geom?.outlineSimplified,
  };
  // One batch, so a refused shape never reaches listeners or the undo history.
  return net.batch(() => {
    net.setJunctionShape(nodeId, next ?? null);
    if (!next) return { ok: true, problems: [] };
    const problems = shapeResultProblems(net, nodeId, before);
    if (problems.length) {
      net.setJunctionShape(nodeId, prev ?? null);
      return { ok: false, problems };
    }
    return { ok: true, problems: [] };
  });
}

/** A copy of a node's shape, ready to edit. */
export function editableShape(net: RoadNetwork, nodeId: Id): JunctionShape {
  return structuredClone(net.getNode(nodeId)?.control.shape ?? {});
}

/** Shape with one corner's settings merged in, or cleared when `patch` is null. */
export function withCorner(shape: JunctionShape, key: string, patch: Partial<ShapeCorner> | null): JunctionShape {
  const s = structuredClone(shape);
  const corners = { ...(s.corners ?? {}) };
  if (patch === null) delete corners[key];
  else {
    const next: ShapeCorner = { ...(corners[key] ?? {}), ...patch };
    for (const k of Object.keys(next) as (keyof ShapeCorner)[]) if (next[k] === undefined) delete next[k];
    corners[key] = next;
  }
  s.corners = corners;
  return normaliseShape(s) ?? {};
}

export function withArm(shape: JunctionShape, segmentId: Id, patch: Partial<ShapeArm> | null): JunctionShape {
  const s = structuredClone(shape);
  const arms = { ...(s.arms ?? {}) };
  if (patch === null) delete arms[segmentId];
  else {
    const next: ShapeArm = { ...(arms[segmentId] ?? {}), ...patch };
    for (const k of Object.keys(next) as (keyof ShapeArm)[]) if (next[k] === undefined) delete next[k];
    arms[segmentId] = next;
  }
  s.arms = arms;
  return normaliseShape(s) ?? {};
}

export function withIsland(shape: JunctionShape, island: ShapeIsland | Omit<ShapeIsland, 'id'>, remove = false): JunctionShape {
  const s = structuredClone(shape);
  const list = [...(s.islands ?? [])];
  if ('id' in island) {
    const i = list.findIndex((x) => x.id === island.id);
    if (remove) {
      if (i >= 0) list.splice(i, 1);
    } else if (i >= 0) list[i] = { ...island };
    else list.push({ ...island });
  } else {
    const id = list.reduce((m, x) => Math.max(m, x.id), 0) + 1;
    list.push({ ...island, id });
  }
  s.islands = list;
  return normaliseShape(s) ?? {};
}
