/**
 * How hand-placed paint and automatic paint fit together.
 *
 * - Snapping: a hand-drawn line along a road sits on the same lateral position as
 *   the automatic line it is near (lane boundary, centre, edge line).
 * - Coverage: where a hand-placed line runs along an automatic one, the automatic
 *   one is left off there, so nothing is painted twice. The same holds for a
 *   crosswalk, stop line or arrow placed where the road paints one.
 * - Slots: a place on a road holds one marking of a role at a time. A new marking
 *   in a taken slot replaces the old one (stackedWith), and loading cleans up old
 *   saves with stacked duplicates, keeping the newest (cleanStacked).
 *
 * Pure reads of a RoadNetwork. No DOM or Three.js.
 */
import { lineStyleInfo, mirroredStyle, resolvedStyle } from './markingStyle';
import { legacyDecalFill, legacyDecalLook } from './markingMigrate';
import { acrossOneArm, boundaryOffsets, fillerPolygon, pointShift, segmentFrames } from './nodeMarkings';
import { boundaryLines, styleSpan, type AutoLineRole, type BoundaryLine } from './paintStandard';
import type { RoadNetwork } from './RoadNetwork';
import { resolveDecal } from './roadPaint';
import { effectiveLanes, effectiveMarkings, effectiveSpeedKmh } from './roadTypes';
import type { Decal, Id, LineStyleSpec, MarkingHost, NodeFillerMarking, NodeLineMarking, NodeMarking, Project, Station, Vec3 } from './types';

/** A hand-drawn line this close to an automatic one is drawn on it. */
export const SNAP_TOL = 0.25;
/** Lines closer than this across the road are in the same place. */
export const LINE_MATCH = 0.12;

const LINE_KINDS = new Set<Decal['kind']>(['line', 'dashedLine', 'doubleLine']);
const ARROW_KINDS = new Set<Decal['kind']>(['arrowStraight', 'arrowLeft', 'arrowRight', 'arrowStraightLeft', 'arrowStraightRight']);

// ---------------------------------------------------------------------------
// Automatic lines of a road
// ---------------------------------------------------------------------------

/** The automatic lines along a road (outline excluded), with whether each was taken away. */
export function autoLinesOf(net: RoadNetwork, segId: Id): (BoundaryLine & { off: boolean })[] {
  const seg = net.getSegment(segId);
  if (!seg) return [];
  const def = net.roadTypeOf(segId);
  const lanes = effectiveLanes(def, seg.overrides);
  const off = new Set(seg.overrides.paintOff ?? []);
  return boundaryLines(lanes, effectiveMarkings(def, seg.overrides), lanes.every((l) => l.dir === 1), def.median.kind, def.median.width, def.median.offset ?? 0, 0, roadSpeed(net, segId)).map((l) => ({
    ...l,
    off: off.has(l.key),
  }));
}

/** The automatic line nearest a lateral position, within `tol`. */
export function autoLineAt(net: RoadNetwork, segId: Id, offset: number, tol = SNAP_TOL): (BoundaryLine & { off: boolean }) | null {
  let best: (BoundaryLine & { off: boolean }) | null = null;
  for (const l of autoLinesOf(net, segId)) {
    if (Math.abs(l.offset - offset) <= tol && (!best || Math.abs(l.offset - offset) < Math.abs(best.offset - offset))) best = l;
  }
  return best;
}

/** Taken-away line keys of a road that turns round: lanes reverse, so do sides. */
export function mirrorPaintOff(keys: readonly string[], laneCount: number): string[] {
  return keys.map((k) => {
    if (k === 'L') return 'R';
    if (k === 'R') return 'L';
    const m = /^b(\d+)([LR]?)$/.exec(k);
    if (!m) return k;
    const side = m[2] === 'L' ? 'R' : m[2] === 'R' ? 'L' : '';
    return `b${laneCount - 2 - Number(m[1])}${side}`;
  });
}

/** Take one automatic line along a road away (`on` false) or bring it back. */
export function autoLinePatch(net: RoadNetwork, segId: Id, key: string, on: boolean): { paintOff: string[] | undefined } {
  const now = (net.getSegment(segId)?.overrides.paintOff ?? []).filter((k) => k !== key);
  if (!on) now.push(key);
  return { paintOff: now.length ? now : undefined };
}

/** A lateral position moved onto the automatic line it is near, if any. */
export function snapToAutoLine(net: RoadNetwork, segId: Id, offset: number): number {
  return autoLineAt(net, segId, offset)?.offset ?? offset;
}

export function roleName(role: AutoLineRole | null): string {
  return role === 'lane' ? 'lane line' : role === 'centre' ? 'centre line' : role === 'edge' ? 'edge line' : 'line';
}

/** Arc length at a curve parameter, from the stations' own t. */
export function sAtT(st: readonly Station[], t: number): number {
  if (!st.length) return 0;
  if (t <= st[0].t) return st[0].s;
  if (t >= st[st.length - 1].t) return st[st.length - 1].s;
  let i = 0;
  while (i + 2 < st.length && st[i + 1].t < t) i++;
  const a = st[i];
  const b = st[i + 1];
  return a.s + ((t - a.t) / Math.max(b.t - a.t, 1e-9)) * (b.s - a.s);
}

// ---------------------------------------------------------------------------
// Looks
// ---------------------------------------------------------------------------

/** A decal's look in the shared vocabulary, from its style or, for an older one, its kind. */
export function decalLook(d: Pick<Decal, 'kind' | 'style' | 'lineStyle' | 'color' | 'width'>): LineStyleSpec | null {
  return d.style ?? legacyDecalLook(d);
}

export function decalFill(d: Pick<Decal, 'kind' | 'fill' | 'color'>): Decal['fill'] | undefined {
  return d.fill ?? legacyDecalFill(d);
}

export function isLineDecal(d: Pick<Decal, 'kind'>): boolean {
  return LINE_KINDS.has(d.kind);
}

export function isArrowDecal(d: Pick<Decal, 'kind'>): boolean {
  return ARROW_KINDS.has(d.kind);
}

/** Metres right of its path the middle of a look sits. */
export function lookCentre(spec: LineStyleSpec): number {
  const r = resolvedStyle(spec);
  const span = styleSpan(r);
  return r.offset + (r.align === 'left' ? -span / 2 : r.align === 'right' ? span / 2 : 0);
}

// ---------------------------------------------------------------------------
// Hand-placed lines along a road
// ---------------------------------------------------------------------------

export type PaintRef = { kind: 'decal'; id: Id } | { kind: 'marking'; host: MarkingHost; id: Id };

export function samePaintRef(a: PaintRef, b: PaintRef): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;
  return a.kind === 'decal' || (b.kind === 'marking' && a.host.kind === b.host.kind && a.host.id === b.host.id);
}

/**
 * One stretch of a hand-placed line along one road, in that road's frame: the path
 * at `offset` right of a-to-b (already snapped), from s0 to s1 (s0 below s1), in a
 * look turned to the a-to-b direction.
 */
export interface RoadLineRun {
  segmentId: Id;
  offset: number;
  s0: number;
  s1: number;
  look: LineStyleSpec;
  /** Where the middle of the paint sits across the road. */
  centre: number;
  ref: PaintRef;
  /** Drawn some other way (parts in other styles): it still holds its place. */
  ownPath?: true;
}

function decalRuns(net: RoadNetwork, d: Pick<Decal, 'kind' | 'road' | 'style' | 'lineStyle' | 'color' | 'width'>, ref: PaintRef, only?: Id): RoadLineRun[] {
  if (!isLineDecal(d) || !d.road || d.road.offsetEnd !== undefined) return [];
  const look = decalLook(d);
  if (!look) return [];
  const out: RoadLineRun[] = [];
  for (const piece of d.road.pieces) {
    if (only !== undefined && piece.segmentId !== only) continue;
    const st = net.segmentGeom(piece.segmentId)?.stations;
    if (!st || st.length < 2) continue;
    const forward = piece.t0 <= piece.t1;
    const sA = sAtT(st, piece.t0);
    const sB = sAtT(st, piece.t1);
    if (Math.abs(sB - sA) < 0.05) continue;
    const segLook = forward ? look : mirroredStyle(look);
    const own = piece.offset ?? d.road.offset;
    const offset = snapToAutoLine(net, piece.segmentId, forward ? own : -own);
    out.push({ segmentId: piece.segmentId, offset, s0: Math.min(sA, sB), s1: Math.max(sA, sB), look: segLook, centre: offset + lookCentre(segLook), ref });
  }
  return out;
}

function markingRun(net: RoadNetwork, segId: Id, m: NodeLineMarking, ref: PaintRef): RoadLineRun | null {
  if (lineStyleInfo(m.style).family !== 'line' || acrossOneArm(m.from, m.to)) return null;
  if (m.from.boundary !== m.to.boundary || m.from.corner !== undefined || m.to.corner !== undefined) return null;
  const frames = segmentFrames(net, segId);
  const fa = frames.find((f) => f.end === m.from.end);
  const fb = frames.find((f) => f.end === m.to.end);
  if (!fa || !fb) return null;
  const oa = fa.offsets[m.from.boundary];
  if (oa === undefined) return null;
  const shiftA = pointShift(fa, m.from.boundary);
  const shiftB = pointShift(fb, m.to.boundary);
  if (Math.abs(shiftA - shiftB) > 0.02) return null;
  const sa = fa.s + fa.backSign * (m.from.back ?? 0);
  const sb = fb.s + fb.backSign * (m.to.back ?? 0);
  if (Math.abs(sa - sb) < 0.5) return null;
  const forward = sa < sb;
  const look: LineStyleSpec = { style: m.style, color: m.color, width: m.width };
  for (const k of ['hex', 'dash', 'space', 'gap', 'offset', 'align'] as const) if (m[k] !== undefined) (look as unknown as Record<string, unknown>)[k] = m[k];
  const segLook = forward ? look : mirroredStyle(look);
  const offset = snapToAutoLine(net, segId, oa + shiftA);
  return { segmentId: segId, offset, s0: Math.min(sa, sb), s1: Math.max(sa, sb), look: segLook, centre: offset + lookCentre(segLook), ref, ...(m.rules?.length ? { ownPath: true as const } : {}) };
}

/** The run of a segment marking that lies along its road, or null for any other marking. */
export function segmentMarkingRun(net: RoadNetwork, segId: Id, m: NodeLineMarking): RoadLineRun | null {
  return markingRun(net, segId, m, { kind: 'marking', host: { kind: 'segment', id: segId }, id: m.id });
}

/** The runs of a road-paint line decal, one per road it crosses. */
export function decalLineRuns(net: RoadNetwork, d: Decal): RoadLineRun[] {
  return decalRuns(net, d, { kind: 'decal', id: d.id });
}

/** Every hand-placed line running along a road. */
export function userRoadLines(net: RoadNetwork, segId: Id): RoadLineRun[] {
  const out: RoadLineRun[] = [];
  for (const d of net.decals) out.push(...decalRuns(net, d, { kind: 'decal', id: d.id }, segId));
  for (const m of net.markingsOf({ kind: 'segment', id: segId })) {
    if (m.kind !== 'line') continue;
    const r = segmentMarkingRun(net, segId, m);
    if (r) out.push(r);
  }
  return out;
}

/** Stretches [s0, s1] of an automatic line at `offset` that hand-placed lines hold. */
export function coveredStretches(runs: readonly RoadLineRun[], offset: number): [number, number][] {
  return runs.filter((r) => Math.abs(r.centre - offset) < LINE_MATCH).map((r) => [r.s0, r.s1] as [number, number]);
}

/** [a, b] minus every interval in `cuts`. */
export function subtractIntervals(a: number, b: number, cuts: readonly [number, number][]): [number, number][] {
  let parts: [number, number][] = [[a, b]];
  for (const [c0, c1] of cuts) {
    const next: [number, number][] = [];
    for (const [p0, p1] of parts) {
      if (c1 <= p0 || c0 >= p1) next.push([p0, p1]);
      else {
        if (c0 > p0) next.push([p0, c0]);
        if (c1 < p1) next.push([c1, p1]);
      }
    }
    parts = next;
  }
  return parts.filter(([p0, p1]) => p1 - p0 > 0.05);
}

// ---------------------------------------------------------------------------
// Stamps on a road and marks across an arm
// ---------------------------------------------------------------------------

export interface RoadStamp {
  kind: 'crossing' | 'stop' | 'arrow';
  /** Arc length along the road. */
  s: number;
  /** Lateral range, right of a-to-b. Arrows: lo = hi = the lane. */
  lo: number;
  hi: number;
  /** 1 faces a-to-b. */
  dir: 1 | -1;
  depth: number;
  ref: PaintRef;
}

function decalStamp(net: RoadNetwork, d: Pick<Decal, 'kind' | 'road' | 'style' | 'lineStyle' | 'color' | 'width'>, ref: PaintRef): RoadStamp | null {
  const r = d.road;
  if (!r || r.pieces.length !== 1) return null;
  const p = r.pieces[0];
  const st = net.segmentGeom(p.segmentId)?.stations;
  if (!st || st.length < 2) return null;
  const s = sAtT(st, p.t0);
  const lo = Math.min(r.offset, r.offset2 ?? r.offset);
  const hi = Math.max(r.offset, r.offset2 ?? r.offset);
  const dir = r.dir ?? 1;
  if (d.kind === 'crosswalk') return { kind: 'crossing', s, lo, hi, dir, depth: decalLook(d)?.width ?? 3, ref };
  if (d.kind === 'stopLine' || d.kind === 'yieldTriangles') return { kind: 'stop', s, lo, hi, dir, depth: decalLook(d)?.width ?? 0.45, ref };
  if (ARROW_KINDS.has(d.kind)) return { kind: 'arrow', s, lo, hi, dir, depth: 5 * (d.width > 0 ? d.width : 1), ref };
  return null;
}

/** Hand-placed crosswalks, stop lines and arrows stamped on a road. */
export function userRoadStamps(net: RoadNetwork, segId: Id): RoadStamp[] {
  const out: RoadStamp[] = [];
  for (const d of net.decals) {
    if (d.road?.pieces[0]?.segmentId !== segId) continue;
    const st = decalStamp(net, d, { kind: 'decal', id: d.id });
    if (st) out.push(st);
  }
  return out;
}

/** Hand-placed crosswalk and stop marks laid across one arm of a node. */
export function userArmMarks(net: RoadNetwork, nodeId: Id, segId: Id): { crossing: boolean; stop: boolean } {
  const out = { crossing: false, stop: false };
  for (const m of net.markingsOf({ kind: 'node', id: nodeId })) {
    if (m.kind !== 'line' || !acrossOneArm(m.from, m.to) || m.from.segmentId !== segId) continue;
    const f = lineStyleInfo(m.style).family;
    if ((m.from.back ?? 0) > 12) continue;
    if (f === 'crosswalk') out.crossing = true;
    if (f === 'stop' || f === 'teeth') out.stop = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Slots: one marking of a role per place
// ---------------------------------------------------------------------------

export type Slot =
  | { kind: 'line'; segmentId: Id; centre: number; s0: number; s1: number }
  | { kind: 'crossing'; segmentId: Id; s: number; depth: number }
  | { kind: 'stop'; segmentId: Id; s: number; lo: number; hi: number }
  | { kind: 'arrow'; segmentId: Id; s: number; lane: number; dir: 1 | -1 }
  | { kind: 'area'; poly: Vec3[] }
  | { kind: 'chord'; host: string; a: string; b: string };

/** Something placed, or about to be: a decal, or a marking on a host. */
export type PaintItem =
  | { kind: 'decal'; decal: Omit<Decal, 'id'> & { id?: Id } }
  | { kind: 'marking'; host: MarkingHost; marking: (Omit<NodeLineMarking, 'id'> | Omit<NodeFillerMarking, 'id'>) & { id?: Id } };

function anchorKey(a: NodeLineMarking['from']): string {
  return `${a.segmentId}:${a.boundary}:${a.corner ?? ''}:${a.back ?? 0}:${a.end ?? ''}`;
}

function segmentOfMarking(host: MarkingHost, m: Pick<NodeLineMarking, 'from'>): Id {
  return host.kind === 'segment' ? host.id : m.from.segmentId;
}

/** The slots an item takes. Text takes none. */
export function slotsOf(net: RoadNetwork, item: PaintItem): Slot[] {
  if (item.kind === 'decal') {
    const d = item.decal;
    const ref: PaintRef = { kind: 'decal', id: d.id ?? -1 };
    if (isLineDecal(d)) return decalRuns(net, d, ref).filter((r) => onBoundary(net, r.segmentId, r.centre)).map((r) => ({ kind: 'line', segmentId: r.segmentId, centre: r.centre, s0: r.s0, s1: r.s1 }));
    if (d.kind === 'hatch' || d.kind === 'fill') {
      const pts = resolveDecal(net, { ...d, id: d.id ?? -1 } as Decal).points;
      return pts.length >= 3 ? [{ kind: 'area', poly: pts }] : [];
    }
    const st = decalStamp(net, d, ref);
    if (!st) return [];
    const segmentId = d.road!.pieces[0].segmentId;
    if (st.kind === 'crossing') return [{ kind: 'crossing', segmentId, s: st.s, depth: st.depth }];
    if (st.kind === 'stop') return [{ kind: 'stop', segmentId, s: st.s, lo: st.lo, hi: st.hi }];
    return [{ kind: 'arrow', segmentId, s: st.s, lane: st.lo, dir: st.dir }];
  }
  const { host, marking: m } = item;
  if (m.kind === 'filler') {
    const poly = fillerPolygon(net, host, m);
    return poly && poly.length >= 3 ? [{ kind: 'area', poly }] : [];
  }
  const family = lineStyleInfo(m.style).family;
  if (host.kind === 'segment') {
    const run = markingRun(net, host.id, { ...m, id: m.id ?? -1 } as NodeLineMarking, { kind: 'marking', host, id: m.id ?? -1 });
    if (run) return onBoundary(net, host.id, run.centre) ? [{ kind: 'line', segmentId: host.id, centre: run.centre, s0: run.s0, s1: run.s1 }] : [];
  }
  if (acrossOneArm(m.from, m.to) && (family === 'crosswalk' || family === 'stop' || family === 'teeth')) {
    const segmentId = segmentOfMarking(host, m);
    const back = m.from.back ?? 0;
    // On a segment, a place along it. At a node, a place along one arm: the arm's id
    // spreads arms 1000 m apart on one key, so only marks on the same arm meet.
    const frame = host.kind === 'segment' ? segmentFrames(net, host.id).find((f) => f.end === m.from.end) : undefined;
    const key = host.kind === 'node' ? -host.id - 1 : segmentId;
    const s = frame ? frame.s + frame.backSign * back : segmentId * 1000 + back;
    if (family === 'crosswalk') return [{ kind: 'crossing', segmentId: key, s, depth: m.width }];
    return [{ kind: 'stop', segmentId: key, s, lo: -1e3, hi: 1e3 }];
  }
  const a = anchorKey(m.from);
  const b = anchorKey(m.to);
  return [{ kind: 'chord', host: `${host.kind}:${host.id}`, a: a < b ? a : b, b: a < b ? b : a }];
}

/**
 * True where a line across a road is one of its line places: a lane boundary, the
 * centre, an edge (or the automatic line there). A line down the middle of a lane
 * is not a slot: any number may run there, as lines turning off one lane do.
 */
export function onBoundary(net: RoadNetwork, segId: Id, centre: number): boolean {
  if (autoLinesOf(net, segId).some((l) => Math.abs(l.offset - centre) < LINE_MATCH)) return true;
  const seg = net.getSegment(segId);
  if (!seg) return false;
  return boundaryOffsets(net.roadTypeOf(segId), seg.overrides).some((o) => Math.abs(o - centre) < LINE_MATCH);
}

function segIntersect(p: Vec3, q: Vec3, r: Vec3, s: Vec3): boolean {
  const d = (a: Vec3, b: Vec3, c: Vec3) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const d1 = d(r, s, p);
  const d2 = d(r, s, q);
  const d3 = d(p, q, r);
  const d4 = d(p, q, s);
  const eps = 1e-3;
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

function inPoly(p: Vec3, poly: readonly Vec3[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}

function centroid(poly: readonly Vec3[]): Vec3 {
  let x = 0;
  let z = 0;
  for (const p of poly) {
    x += p.x;
    z += p.z;
  }
  return { x: x / poly.length, y: 0, z: z / poly.length };
}

/** Two areas overlap: one's middle inside the other, or edges properly crossing. Touching is not overlapping. */
export function areasOverlap(a: readonly Vec3[], b: readonly Vec3[]): boolean {
  if (inPoly(centroid(a), b) || inPoly(centroid(b), a)) return true;
  // Points just inside each area near its corners and edge middles: inside the other means overlap.
  // Nudged in, so two areas sharing an edge only touch.
  const probe = (p: readonly Vec3[], q: readonly Vec3[]) => {
    const c = centroid(p);
    const pts: Vec3[] = [];
    for (let i = 0; i < p.length; i++) {
      const n = p[(i + 1) % p.length];
      pts.push(p[i], { x: (p[i].x + n.x) / 2, y: 0, z: (p[i].z + n.z) / 2 });
    }
    return pts.some((x) => inPoly({ x: x.x + (c.x - x.x) * 0.03, y: 0, z: x.z + (c.z - x.z) * 0.03 }, q));
  };
  if (probe(a, b) || probe(b, a)) return true;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

export function slotsConflict(x: Slot, y: Slot): boolean {
  if (x.kind !== y.kind) return false;
  switch (x.kind) {
    case 'line': {
      const o = y as typeof x;
      if (o.segmentId !== x.segmentId || Math.abs(o.centre - x.centre) >= LINE_MATCH) return false;
      return Math.min(x.s1, o.s1) - Math.max(x.s0, o.s0) > 0.5;
    }
    case 'crossing': {
      const o = y as typeof x;
      return o.segmentId === x.segmentId && Math.abs(o.s - x.s) < (o.depth + x.depth) / 2 + 0.5;
    }
    case 'stop': {
      const o = y as typeof x;
      return o.segmentId === x.segmentId && Math.abs(o.s - x.s) < 1.5 && Math.min(x.hi, o.hi) - Math.max(x.lo, o.lo) > 0.3;
    }
    case 'arrow': {
      const o = y as typeof x;
      return o.segmentId === x.segmentId && o.dir === x.dir && Math.abs(o.lane - x.lane) < 1 && Math.abs(o.s - x.s) < 10;
    }
    case 'area':
      return areasOverlap(x.poly, (y as typeof x).poly);
    case 'chord': {
      const o = y as typeof x;
      return o.host === x.host && o.a === x.a && o.b === x.b;
    }
  }
}

function slotLabel(net: RoadNetwork, slot: Slot): string {
  switch (slot.kind) {
    case 'line':
      return roleName(autoLineAt(net, slot.segmentId, slot.centre, LINE_MATCH)?.role ?? null);
    case 'crossing':
      return 'crosswalk';
    case 'stop':
      return 'stop line';
    case 'arrow':
      return 'arrow';
    case 'area':
      return 'area';
    case 'chord':
      return 'line';
  }
}

/** Every placed item that could share a slot with something on these hosts and roads. */
function candidates(net: RoadNetwork): { ref: PaintRef; item: PaintItem }[] {
  const out: { ref: PaintRef; item: PaintItem }[] = [];
  for (const d of net.decals) out.push({ ref: { kind: 'decal', id: d.id }, item: { kind: 'decal', decal: d } });
  const hosts: MarkingHost[] = [];
  for (const n of net.nodes) if (n.control.markings) hosts.push({ kind: 'node', id: n.id });
  for (const s of net.segments) if (s.overrides.handMarkings) hosts.push({ kind: 'segment', id: s.id });
  for (const host of hosts) {
    for (const m of net.markingsOf(host)) out.push({ ref: { kind: 'marking', host, id: m.id }, item: { kind: 'marking', host, marking: m } });
  }
  return out;
}

/** Whether an automatic marking holds a slot, and what it is called. */
function autoInSlot(net: RoadNetwork, slot: Slot): string | null {
  if (slot.kind === 'line') {
    const l = autoLineAt(net, slot.segmentId, slot.centre, LINE_MATCH);
    return l && !l.off ? roleName(l.role) : null;
  }
  if ((slot.kind === 'crossing' || slot.kind === 'stop') && slot.segmentId < 0) {
    // A mark across one arm at a node: the arm is in `s` (see slotsOf).
    const node = net.getNode(-slot.segmentId - 1);
    const segId = Math.round(slot.s / 1000);
    const seg = net.getSegment(segId);
    if (!node || !seg || (net.nodeGeom(node.id)?.arms.length ?? 0) < 3) return null;
    const m = effectiveMarkings(net.roadTypeOf(segId), seg.overrides);
    const crosswalk = node.control.crosswalks[segId] ?? m.crosswalk;
    if (slot.kind === 'crossing' && crosswalk !== 'none' && !node.control.hideAutoMarkings) return 'crosswalk';
    if (slot.kind === 'stop' && m.stopLines && !node.control.hideAutoMarkings) return 'stop line';
    return null;
  }
  if (slot.kind === 'crossing' || slot.kind === 'stop' || slot.kind === 'arrow') {
    const seg = net.getSegment(slot.segmentId);
    const geom = net.segmentGeom(slot.segmentId);
    if (!seg || !geom || geom.stations.length < 2) return null;
    const m = effectiveMarkings(net.roadTypeOf(slot.segmentId), seg.overrides);
    const s0 = geom.stations[0].s;
    const s1 = geom.stations[geom.stations.length - 1].s;
    const nearEnd = Math.min(Math.abs(slot.s - s0), Math.abs(s1 - slot.s));
    const junctionAt = (id: Id) => (net.nodeGeom(id)?.arms.length ?? 0) >= 3;
    const atJunction = (Math.abs(slot.s - s0) < Math.abs(s1 - slot.s) ? junctionAt(seg.a) : junctionAt(seg.b));
    if (!atJunction) return null;
    if (slot.kind === 'crossing' && m.crosswalk !== 'none' && nearEnd < 6) return 'crosswalk';
    if (slot.kind === 'stop' && m.stopLines && nearEnd < 8) return 'stop line';
    if (slot.kind === 'arrow' && m.turnArrows && nearEnd < 22) return 'arrow';
  }
  return null;
}

/**
 * What placing `item` would replace: the placed markings in its slots (to remove),
 * and a name for each thing replaced, automatic ones included (those are left off
 * by the renderer while the new one holds the slot). `self` is skipped.
 */
export function stackedWith(net: RoadNetwork, item: PaintItem, self?: PaintRef): { refs: PaintRef[]; labels: string[] } {
  const slots = slotsOf(net, item);
  const refs: PaintRef[] = [];
  const labels: string[] = [];
  if (!slots.length) return { refs, labels };
  for (const c of candidates(net)) {
    if (self && samePaintRef(c.ref, self)) continue;
    // Areas only clash with areas, lines only with lines and so on: slotsConflict checks kinds.
    const theirs = slotsOf(net, c.item);
    const hit = slots.find((s) => theirs.some((t) => slotsConflict(s, t)));
    if (hit) {
      refs.push(c.ref);
      labels.push(slotLabel(net, hit));
    }
  }
  for (const s of slots) {
    const auto = autoInSlot(net, s);
    if (auto && !labels.includes(auto)) labels.push(auto);
  }
  return { refs, labels };
}

/**
 * Remove stacked duplicates from a loaded project, keeping the newest (highest id)
 * in each slot. Returns how many were removed. Writes the project directly: call
 * only while loading.
 */
export function cleanStacked(net: RoadNetwork, p: Project): number {
  const all = candidates(net).sort((a, b) => b.ref.id - a.ref.id);
  const kept: Slot[][] = [];
  const drop: PaintRef[] = [];
  for (const c of all) {
    const slots = slotsOf(net, c.item);
    if (slots.some((s) => kept.some((k) => k.some((t) => slotsConflict(s, t))))) drop.push(c.ref);
    else kept.push(slots);
  }
  if (!drop.length) return 0;
  const dropDecals = new Set(drop.filter((r) => r.kind === 'decal').map((r) => r.id));
  if (dropDecals.size) p.decals = p.decals.filter((d) => !dropDecals.has(d.id));
  const gone = (host: MarkingHost, m: NodeMarking) => drop.some((r) => r.kind === 'marking' && r.id === m.id && r.host.kind === host.kind && r.host.id === host.id);
  for (const n of p.nodes) {
    if (!n.control.markings) continue;
    const list = n.control.markings.filter((m) => !gone({ kind: 'node', id: n.id }, m));
    if (list.length) n.control.markings = list;
    else delete n.control.markings;
  }
  for (const s of p.segments) {
    if (!s.overrides.handMarkings) continue;
    const list = s.overrides.handMarkings.filter((m) => !gone({ kind: 'segment', id: s.id }, m));
    if (list.length) s.overrides.handMarkings = list;
    else delete s.overrides.handMarkings;
  }
  return drop.length;
}

/**
 * The speed a road is painted for: its own, but highway ramps are painted as the
 * highways they serve (long dashes, wide lines, yellow left edge).
 */
export function roadSpeed(net: RoadNetwork, segId: Id): number {
  const seg = net.getSegment(segId);
  if (!seg) return 50;
  const def = net.roadTypeOf(segId);
  const v = effectiveSpeedKmh(def, seg.overrides);
  return def.category === 'ramp' || def.category === 'highway' ? Math.max(v, 80) : v;
}
