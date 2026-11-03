/**
 * Smart guides for drawing roads, in the spirit of CAD and Figma: subtle lines
 * that appear only when the cursor is close to something worth lining up with,
 * and snap to it.
 *
 * - Parallel: offset curves of nearby roads at kerb-to-kerb, a standard gap, and
 *   grid multiples when the grid is aligned. They follow curves.
 * - Equal spacing: beside two parallel roads, the offset that makes both gaps equal.
 * - Perpendicular: 90 degrees off the road being drawn from, or meeting a road
 *   square on.
 * - Extension lines: the straight continuation of road ends and straight roads,
 *   however far away. Where two cross is a snap point.
 * - Line-up: in line with nearby nodes along the grid axes (or world axes).
 * - Midpoint: a road's midpoint, when snapping onto it.
 * - Angle lock: Shift holds the current direction.
 *
 * Guides come after node and road snaps, which make connections, and before the
 * grid and the 15 degree angle steps. Where two guides cross near the cursor, the
 * crossing wins. Pure functions over a RoadNetwork.
 */
import { closestPointOnCubic, cubicLength, cubicPoint, cubicTangentXZ, subCubic, type Cubic } from '../core/bezier';
import { distXZ, normalizeXZ, sub } from '../core/math';
import type { RoadAnchor, RoadNetwork } from '../core/RoadNetwork';
import { totalHalfWidth } from '../core/roadTypes';
import type { Id, Vec3 } from '../core/types';
import type { ToolMark } from '../render/api';
import { gridAxes, type GridSettings } from './grid';
import { fitOffset, offsetPoint, PARALLEL_GAP, touchingOffset } from './parallel';
import type { SnapFrom, SnapHit } from './snap';

export interface GuideToggles {
  parallel: boolean;
  perpendicular: boolean;
  extension: boolean;
  lineup: boolean;
  spacing: boolean;
  midpoint: boolean;
}

export function defaultGuideToggles(): GuideToggles {
  return { parallel: true, perpendicular: true, extension: true, lineup: true, spacing: true, midpoint: true };
}

export interface GuideContext {
  toggles: GuideToggles;
  /** Ground metres per screen pixel at the cursor. 0 when unknown. */
  mpp: number;
  /** Road type being drawn, for kerb-to-kerb offsets. */
  roadType: string;
  /** The grid when it is on, for aligned offsets and line-up axes. */
  grid: GridSettings | null;
  /** Shift held: the direction locked from the start point. */
  lock?: Vec3 | null;
  /** The start anchor of the road being drawn. */
  fromAnchor?: RoadAnchor | null;
}

/** What a guide snap adds to a SnapHit. */
export interface GuideResult {
  /** Short text for the readout, such as "Parallel 24 m". */
  label: string;
  /** Guide lines and markers to draw. */
  marks: ToolMark[];
  /** Direction of the guide at the snap, for Shift lock. */
  dir: Vec3 | null;
  /** A draft shape that follows the guide, for a parallel road. */
  cubic?: Cubic;
  /** Extra readout lines, such as the distance to a parallel road. */
  info?: string[];
}

export const GUIDE_COLOR = 'rgba(143, 227, 255, 0.75)';
const MARK_WIDTH = 0.02; // Floored to a pixel and a half by the renderer.
/** A road within this angle of the draft direction counts as parallel. */
export const PARALLEL_ANGLE = (10 * Math.PI) / 180;
/** How far around the cursor parallel and spacing guides look, metres. */
export const PARALLEL_REACH = 90;
/** How far line-up looks for nodes, metres. */
export const LINEUP_REACH = 700;
/** Extension lines reach this far past a road end, metres. */
export const EXTENSION_REACH = 2500;

/** Catch distance in metres for the zoom: about 8 pixels, within sane bounds. */
export function guideCatch(mpp: number): number {
  return mpp > 0 ? Math.min(8, Math.max(0.6, mpp * 8)) : 3;
}

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

interface Projection {
  pos: Vec3;
  dist: number;
  dir: Vec3;
}

interface Constraint {
  source: keyof GuideToggles | 'lock';
  label: string;
  /** Lower wins ties. */
  weight: number;
  project(p: Vec3): Projection | null;
  marks(pos: Vec3): ToolMark[];
  /** Draft shape ending at pos, when the guide can give one. */
  cubic?(pos: Vec3): Cubic | undefined;
}

function roadName(net: RoadNetwork, segId: Id): string {
  return net.roadTypeOf(segId).name;
}

function dashed(points: Vec3[]): ToolMark {
  return { kind: 'line', points, color: GUIDE_COLOR, width: MARK_WIDTH, dashed: true };
}

/** A straight guide through p along d. With `ray`, only ahead of p. */
function lineConstraint(
  source: Constraint['source'],
  label: string,
  weight: number,
  p: Vec3,
  d: Vec3,
  ray: boolean,
  reach: number,
  extra: (pos: Vec3) => ToolMark[] = () => [],
): Constraint {
  return {
    source,
    label,
    weight,
    project(q) {
      let s = (q.x - p.x) * d.x + (q.z - p.z) * d.z;
      if (ray && s < 0) return null;
      if (Math.abs(s) > reach) return null;
      const pos = { x: p.x + d.x * s, y: q.y, z: p.z + d.z * s };
      return { pos, dist: distXZ(pos, q), dir: d };
    },
    marks(pos) {
      return [dashed([{ ...p, y: pos.y }, pos]), ...extra(pos)];
    },
  };
}

/** A small square in the corner where two directions meet at a right angle. */
function rightAngleMarker(corner: Vec3, a: Vec3, b: Vec3, mpp: number): ToolMark {
  const s = mpp > 0 ? mpp * 10 : 2;
  const p1 = { x: corner.x + a.x * s, y: corner.y, z: corner.z + a.z * s };
  const p2 = { x: corner.x + (a.x + b.x) * s, y: corner.y, z: corner.z + (a.z + b.z) * s };
  const p3 = { x: corner.x + b.x * s, y: corner.y, z: corner.z + b.z * s };
  return { kind: 'line', points: [p1, p2, p3], color: GUIDE_COLOR, width: MARK_WIDTH };
}

/** A guide `offset` metres to the right of a road (negative is left), following its curve. */
function offsetConstraint(
  net: RoadNetwork,
  source: Constraint['source'],
  label: string,
  weight: number,
  segId: Id,
  offset: number,
  from: SnapFrom | null,
  extra: (pos: Vec3) => ToolMark[] = () => [],
): Constraint {
  const c = net.cubicOf(segId);
  const at = (q: Vec3) => {
    const hit = closestPointOnCubic(c, q);
    return hit.t;
  };
  return {
    source,
    label,
    weight,
    project(q) {
      const t = at(q);
      if (t <= 1e-4 || t >= 1 - 1e-4) return null;
      const o = offsetPoint(c, t, offset);
      const pos = { x: o.x, y: q.y, z: o.z };
      return { pos, dist: distXZ(pos, q), dir: cubicTangentXZ(c, t) };
    },
    marks(pos) {
      const t = at(pos);
      const len = net.segmentGeom(segId)?.fullLength ?? cubicLength(c, 24);
      const span = Math.min(0.5, 70 / Math.max(len, 1));
      const t0 = Math.max(0, Math.min(t, from ? at(from.pos) : t) - span);
      const t1 = Math.min(1, Math.max(t, from ? at(from.pos) : t) + span);
      const pts: Vec3[] = [];
      for (let i = 0; i <= 24; i++) {
        const o = offsetPoint(c, t0 + ((t1 - t0) * i) / 24, offset);
        pts.push({ x: o.x, y: pos.y, z: o.z });
      }
      return [dashed(pts), ...extra(pos)];
    },
    cubic(pos) {
      if (!from) return undefined;
      const ts = at(from.pos);
      const te = at(pos);
      if (ts <= 1e-4 || ts >= 1 - 1e-4 || Math.abs(te - ts) < 1e-3) return undefined;
      const start = offsetPoint(c, ts, offset);
      if (distXZ(start, from.pos) > 0.3) return undefined;
      const sub0 = subCubic(c, Math.min(ts, te), Math.max(ts, te));
      const fit = fitOffset(sub0, offset);
      if (fit.error > 0.3) return undefined;
      let cubic = fit.cubic;
      if (te < ts) cubic = { p0: cubic.p3, p1: cubic.p2, p2: cubic.p1, p3: cubic.p0 };
      // Exact ends, heights from the draft.
      const y0 = from.pos.y;
      const y1 = pos.y;
      return {
        p0: { ...from.pos },
        p1: { x: cubic.p1.x, y: y0 + (y1 - y0) / 3, z: cubic.p1.z },
        p2: { x: cubic.p2.x, y: y0 + ((y1 - y0) * 2) / 3, z: cubic.p2.z },
        p3: { ...pos },
      };
    },
  };
}

function nearbySegments(net: RoadNetwork, p: Vec3, reach: number): Id[] {
  return net.segmentsInRegion({ minX: p.x - reach, minZ: p.z - reach, maxX: p.x + reach, maxZ: p.z + reach }, true);
}

/** Segments that the drawing starts on, which no guide should come from. */
function ownSegments(net: RoadNetwork, anchor: RoadAnchor | null | undefined): Set<Id> {
  const out = new Set<Id>();
  if (anchor?.kind === 'segment') out.add(anchor.id);
  if (anchor?.kind === 'node') for (const s of net.getNode(anchor.id)?.segments ?? []) out.add(s);
  return out;
}

function parallelConstraints(net: RoadNetwork, raw: Vec3, from: SnapFrom | null, ctx: GuideContext, catchM: number): Constraint[] {
  const out: Constraint[] = [];
  const dir = from && distXZ(from.pos, raw) > 8 ? normalizeXZ(sub(raw, from.pos)) : null;
  const own = ownSegments(net, ctx.fromAnchor);
  const cosMax = Math.cos(PARALLEL_ANGLE);
  const near: { id: Id; t: number; point: Vec3; tan: Vec3; lateral: number }[] = [];
  for (const id of nearbySegments(net, raw, PARALLEL_REACH)) {
    if (own.has(id)) continue;
    const c = net.cubicOf(id);
    const hit = closestPointOnCubic(c, raw);
    if (hit.t <= 1e-4 || hit.t >= 1 - 1e-4) continue;
    if (Math.abs(hit.point.y - raw.y) > 2.5 || hit.distance > PARALLEL_REACH) continue;
    const tan = cubicTangentXZ(c, hit.t);
    if (dir && Math.abs(tan.x * dir.x + tan.z * dir.z) < cosMax) continue;
    const lateral = (raw.x - hit.point.x) * -tan.z + (raw.z - hit.point.z) * tan.x;
    near.push({ id, t: hit.t, point: hit.point, tan, lateral });
  }
  for (const r of near) {
    const side = r.lateral >= 0 ? 1 : -1;
    const seg = net.getSegment(r.id)!;
    if (ctx.toggles.parallel) {
      const touch = touchingOffset(net, seg.roadType, ctx.roadType);
      const offsets: { o: number; why: string }[] = [
        { o: touch, why: 'kerb to kerb' },
        { o: touch + PARALLEL_GAP, why: 'gap' },
      ];
      const g = ctx.grid;
      if (g?.enabled) {
        const { u } = gridAxes(g);
        const cross = Math.abs(u.x * r.tan.z - u.z * r.tan.x);
        const dot = Math.abs(u.x * r.tan.x + u.z * r.tan.z);
        if (Math.min(cross, dot) < 0.01) {
          for (let k = 1; k * g.spacing <= PARALLEL_REACH; k++) {
            if (k * g.spacing >= touch - 0.3) offsets.push({ o: k * g.spacing, why: 'grid' });
          }
        }
      }
      for (const { o } of offsets) {
        if (Math.abs(Math.abs(r.lateral) - o) > catchM) continue;
        out.push(offsetConstraint(net, 'parallel', `Parallel ${fmt(o)} m`, 0.9, r.id, side * o, from));
      }
    }
  }
  if (ctx.toggles.spacing) {
    // Two parallel roads beside the cursor: offer the offset that makes the gaps equal.
    for (const a of near) {
      for (const b of near) {
        if (a.id === b.id) continue;
        if (Math.abs(a.tan.x * b.tan.x + a.tan.z * b.tan.z) < Math.cos((5 * Math.PI) / 180)) continue;
        const lb = (b.point.x - a.point.x) * -a.tan.z + (b.point.z - a.point.z) * a.tan.x;
        if (Math.abs(lb) < 6) continue;
        for (const o of [lb / 2, 2 * lb, -lb]) {
          const target = o;
          if (Math.abs(a.lateral - target) > catchM) continue;
          const gap = Math.abs(lb) / (o === lb / 2 ? 2 : 1);
          const ca = net.cubicOf(a.id);
          const cb = net.cubicOf(b.id);
          out.push(
            offsetConstraint(net, 'spacing', `Equal spacing ${fmt(gap)} m · ${fmt(gap)} m`, 0.85, a.id, target, from, (pos) => {
              const pa = closestPointOnCubic(ca, pos).point;
              const pb = closestPointOnCubic(cb, pos).point;
              const nearer = distXZ(pa, pos) < distXZ(pb, pos) ? pa : pb;
              const farther = nearer === pa ? pb : pa;
              const marks: ToolMark[] = [
                { kind: 'line', points: [{ ...pa, y: pos.y }, { ...pb, y: pos.y }], color: GUIDE_COLOR, width: MARK_WIDTH },
                { kind: 'line', points: [{ ...nearer, y: pos.y }, pos], color: GUIDE_COLOR, width: MARK_WIDTH },
              ];
              void farther;
              return marks;
            }),
          );
        }
      }
    }
  }
  return out;
}

function perpendicularConstraints(net: RoadNetwork, raw: Vec3, from: SnapFrom | null, ctx: GuideContext): Constraint[] {
  if (!from) return [];
  const out: Constraint[] = [];
  const a = ctx.fromAnchor;
  // Leaving a road square on.
  const tangents: { tan: Vec3; segId: Id }[] = [];
  if (a?.kind === 'segment' && net.getSegment(a.id)) tangents.push({ tan: cubicTangentXZ(net.cubicOf(a.id), a.t), segId: a.id });
  if (a?.kind === 'node') {
    for (const arm of net.nodeGeom(a.id)?.arms ?? []) tangents.push({ tan: arm.dir, segId: arm.segmentId });
  }
  for (const { tan, segId } of tangents) {
    for (const s of [1, -1]) {
      const n = { x: -tan.z * s, y: 0, z: tan.x * s };
      out.push(
        lineConstraint('perpendicular', `90° to ${roadName(net, segId)}`, 0.9, from.pos, n, true, 3000, () => [
          rightAngleMarker(from.pos, n, tan, ctx.mpp),
        ]),
      );
    }
  }
  // Meeting a nearby road square on: the line from the start to the foot of its perpendicular.
  const own = ownSegments(net, a);
  for (const id of nearbySegments(net, raw, 60)) {
    if (own.has(id)) continue;
    const c = net.cubicOf(id);
    const foot = closestPointOnCubic(c, from.pos);
    if (foot.t <= 1e-3 || foot.t >= 1 - 1e-3 || foot.distance < 6) continue;
    if (Math.abs(foot.point.y - raw.y) > 2.5) continue;
    const d = normalizeXZ(sub(foot.point, from.pos));
    const tan = cubicTangentXZ(c, foot.t);
    const toward = { x: -d.x, y: 0, z: -d.z };
    out.push(
      lineConstraint('perpendicular', `90° to ${roadName(net, id)}`, 0.9, from.pos, d, true, foot.distance + 20, () => [
        dashed([{ ...from.pos }, { ...foot.point, y: from.pos.y }]),
        rightAngleMarker({ ...foot.point }, toward, tan, ctx.mpp),
      ]),
    );
  }
  return out;
}

const straightCache = new WeakMap<RoadNetwork, { version: number; lines: { segId: Id; a: Vec3; b: Vec3; d: Vec3 }[] }>();

/** Straight roads, cached per network version. */
function straightRoads(net: RoadNetwork): { segId: Id; a: Vec3; b: Vec3; d: Vec3 }[] {
  const hit = straightCache.get(net);
  if (hit && hit.version === net.version) return hit.lines;
  const lines: { segId: Id; a: Vec3; b: Vec3; d: Vec3 }[] = [];
  for (const seg of net.segments) {
    if (net.roadTypeOf(seg.id).category === 'rail') continue;
    const c = net.cubicOf(seg.id);
    const len = distXZ(c.p0, c.p3);
    if (len < 10) continue;
    const d = normalizeXZ(sub(c.p3, c.p0));
    const off = (p: Vec3) => Math.abs((p.x - c.p0.x) * -d.z + (p.z - c.p0.z) * d.x);
    if (off(c.p1) > 0.15 || off(c.p2) > 0.15) continue;
    lines.push({ segId: seg.id, a: c.p0, b: c.p3, d });
  }
  straightCache.set(net, { version: net.version, lines });
  return lines;
}

function extensionConstraints(net: RoadNetwork, raw: Vec3, catchM: number): Constraint[] {
  const out: Constraint[] = [];
  const near = (p: Vec3, d: Vec3) => {
    const s = (raw.x - p.x) * d.x + (raw.z - p.z) * d.z;
    if (s <= 2 || s > EXTENSION_REACH) return false;
    return Math.abs((raw.x - p.x) * -d.z + (raw.z - p.z) * d.x) <= catchM;
  };
  const seen = new Set<string>();
  const add = (p: Vec3, d: Vec3, label: string) => {
    const key = `${p.x.toFixed(2)},${p.z.toFixed(2)},${d.x.toFixed(3)},${d.z.toFixed(3)}`;
    if (seen.has(key) || !near(p, d)) return;
    seen.add(key);
    out.push(lineConstraint('extension', label, 1, p, d, true, EXTENSION_REACH));
  };
  for (const l of straightRoads(net)) {
    const name = `In line with ${roadName(net, l.segId)}`;
    add(l.b, l.d, name);
    add(l.a, { x: -l.d.x, y: 0, z: -l.d.z }, name);
  }
  for (const id of net.deadEnds()) {
    const node = net.getNode(id)!;
    const seg = node.segments[0];
    const c = net.cubicOf(seg);
    const atStart = net.getSegment(seg)!.a === id;
    const t = cubicTangentXZ(c, atStart ? 0 : 1);
    const d = atStart ? { x: -t.x, y: 0, z: -t.z } : t;
    add(node.pos, d, 'In line with road end');
  }
  return out;
}

function lineupConstraints(net: RoadNetwork, raw: Vec3, ctx: GuideContext, catchM: number): Constraint[] {
  const out: Constraint[] = [];
  const axes = ctx.grid?.enabled ? gridAxes(ctx.grid) : { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 } };
  const skip = ctx.fromAnchor?.kind === 'node' ? ctx.fromAnchor.id : null;
  const box = { minX: raw.x - LINEUP_REACH, minZ: raw.z - LINEUP_REACH, maxX: raw.x + LINEUP_REACH, maxZ: raw.z + LINEUP_REACH };
  for (const id of net.nodesInRegion(box)) {
    if (id === skip) continue;
    const node = net.getNode(id)!;
    if (!node.segments.length || net.roadTypeOf(node.segments[0]).category === 'rail') continue;
    if (distXZ(node.pos, raw) < 10) continue;
    const what = node.segments.length >= 3 ? 'junction' : node.segments.length === 1 ? 'road end' : 'node';
    for (const d of [axes.u, axes.v]) {
      const lat = Math.abs((raw.x - node.pos.x) * -d.z + (raw.z - node.pos.z) * d.x);
      if (lat > catchM) continue;
      out.push(lineConstraint('lineup', `In line with ${what}`, 1.1, node.pos, d, false, LINEUP_REACH));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

function fmt(m: number): string {
  return Math.abs(m - Math.round(m)) < 0.05 ? Math.round(m).toString() : m.toFixed(1);
}

function intersect(p: Vec3, d: Vec3, q: Vec3, e: Vec3): Vec3 | null {
  const den = d.x * e.z - d.z * e.x;
  if (Math.abs(den) < Math.sin((15 * Math.PI) / 180)) return null;
  const s = ((q.x - p.x) * e.z - (q.z - p.z) * e.x) / den;
  return { x: p.x + d.x * s, y: p.y, z: p.z + d.z * s };
}

/** Where two guides cross, refined for curves. */
function crossing(a: Constraint, b: Constraint, raw: Vec3): Vec3 | null {
  let pa = a.project(raw);
  let pb = b.project(raw);
  if (!pa || !pb) return null;
  let x: Vec3 | null = null;
  for (let i = 0; i < 4; i++) {
    x = intersect(pa.pos, pa.dir, pb.pos, pb.dir);
    if (!x) return null;
    x.y = raw.y;
    const na = a.project(x);
    const nb = b.project(x);
    if (!na || !nb) return null;
    pa = na;
    pb = nb;
  }
  if (!x || pa.dist > 0.02 || pb.dist > 0.02) return null;
  return x;
}

export interface GuideSnap {
  pos: Vec3;
  result: GuideResult;
}

/** The guide snap for this cursor, or null when no guide is close. */
export function snapToSmartGuides(net: RoadNetwork, raw: Vec3, from: SnapFrom | null, ctx: GuideContext): GuideSnap | null {
  const catchM = guideCatch(ctx.mpp);
  const t = ctx.toggles;
  const all: Constraint[] = [];
  if (t.parallel || t.spacing) all.push(...parallelConstraints(net, raw, from, ctx, catchM));
  if (t.perpendicular) all.push(...perpendicularConstraints(net, raw, from, ctx));
  if (t.extension) all.push(...extensionConstraints(net, raw, catchM));
  if (t.lineup) all.push(...lineupConstraints(net, raw, ctx, catchM));

  if (ctx.lock && from) {
    const lock = lineConstraint('lock', 'Locked direction', 0, from.pos, ctx.lock, true, 5000);
    const base = lock.project(raw);
    if (!base) return null;
    let best: { pos: Vec3; other: Constraint } | null = null;
    for (const c of all) {
      const x = crossing(lock, c, raw);
      if (x && distXZ(x, raw) <= catchM * 1.5 && (!best || distXZ(x, raw) < distXZ(best.pos, raw))) best = { pos: x, other: c };
    }
    if (best) return finish(best.pos, [lock, best.other], ctx.lock);
    return finish(base.pos, [lock], ctx.lock);
  }

  const near = all
    .map((c) => ({ c, p: c.project(raw) }))
    .filter((x): x is { c: Constraint; p: Projection } => !!x.p && x.p.dist <= catchM)
    .sort((x, y) => x.p.dist * x.c.weight - y.p.dist * y.c.weight)
    .slice(0, 8);
  if (!near.length) return null;
  // Two guides crossing near the cursor make a point to snap to.
  let best: { pos: Vec3; a: Constraint; b: Constraint } | null = null;
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      if (near[i].c.source === near[j].c.source && near[i].c.source === 'parallel') continue;
      const x = crossing(near[i].c, near[j].c, raw);
      if (!x || distXZ(x, raw) > catchM * 1.5) continue;
      if (!best || distXZ(x, raw) < distXZ(best.pos, raw)) best = { pos: x, a: near[i].c, b: near[j].c };
    }
  }
  if (best) return finish(best.pos, [best.a, best.b], null);
  const top = near[0];
  return finish(top.p.pos, [top.c], top.p.dir);
}

function finish(pos: Vec3, used: Constraint[], dir: Vec3 | null): GuideSnap {
  const marks = used.flatMap((c) => c.marks(pos));
  const cubic = used.length === 1 ? used[0].cubic?.(pos) : undefined;
  const d = dir ?? used[0].project(pos)?.dir ?? null;
  return { pos, result: { label: used.map((c) => c.label).join(' · '), marks, dir: d, cubic } };
}

// ---------------------------------------------------------------------------
// Refinements of a snap onto a road, and readout
// ---------------------------------------------------------------------------

/** Arc-length midpoint parameter of a cubic. */
export function midpointT(c: Cubic): number {
  const n = 64;
  const cum = [0];
  let prev = cubicPoint(c, 0);
  for (let i = 1; i <= n; i++) {
    const p = cubicPoint(c, i / n);
    cum.push(cum[i - 1] + distXZ(prev, p));
    prev = p;
  }
  const half = cum[n] / 2;
  for (let i = 1; i <= n; i++) {
    if (cum[i] >= half) {
      const f = (half - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-9);
      return (i - 1 + f) / n;
    }
  }
  return 0.5;
}

/**
 * A snap onto a road moves to its midpoint, or to the foot of the perpendicular
 * from the start, when either is close. The hit stays on the road.
 */
export function refineRoadHit(net: RoadNetwork, hit: SnapHit, from: SnapFrom | null, ctx: GuideContext): SnapHit {
  if (hit.anchor.kind !== 'segment') return hit;
  const segId = hit.anchor.id;
  const c = net.cubicOf(segId);
  const catchM = guideCatch(ctx.mpp);
  const name = roadName(net, segId);
  const options: { t: number; label: string; marks: (p: Vec3) => ToolMark[] }[] = [];
  if (ctx.toggles.midpoint) options.push({ t: midpointT(c), label: `Midpoint of ${name}`, marks: () => [] });
  if (ctx.toggles.perpendicular && from) {
    const foot = closestPointOnCubic(c, from.pos);
    if (foot.t > 1e-3 && foot.t < 1 - 1e-3 && foot.distance > 6) {
      const tan = cubicTangentXZ(c, foot.t);
      const d = normalizeXZ(sub(from.pos, foot.point));
      options.push({ t: foot.t, label: `90° to ${name}`, marks: (p) => [rightAngleMarker(p, d, tan, ctx.mpp)] });
    }
  }
  let best: { t: number; pos: Vec3; label: string; marks: ToolMark[] } | null = null;
  for (const o of options) {
    const p = cubicPoint(c, o.t);
    const d = distXZ(p, hit.pos);
    if (d > catchM || (best && d >= distXZ(best.pos, hit.pos))) continue;
    best = { t: o.t, pos: p, label: o.label, marks: o.marks(p) };
  }
  if (!best) return hit;
  return {
    ...hit,
    pos: best.pos,
    anchor: { kind: 'segment', id: segId, t: best.t },
    guides: { label: best.label, marks: best.marks, dir: cubicTangentXZ(c, best.t) },
  };
}

/** Distance from a point to the nearest road running along the draft, for the readout. */
export function parallelDistanceInfo(net: RoadNetwork, pos: Vec3, from: SnapFrom | null, anchor: RoadAnchor | null | undefined): string | null {
  if (!from || distXZ(from.pos, pos) < 8) return null;
  const dir = normalizeXZ(sub(pos, from.pos));
  const own = ownSegments(net, anchor);
  let best = Infinity;
  for (const id of nearbySegments(net, pos, 60)) {
    if (own.has(id)) continue;
    const c = net.cubicOf(id);
    const hit = closestPointOnCubic(c, pos);
    if (hit.t <= 1e-4 || hit.t >= 1 - 1e-4 || Math.abs(hit.point.y - pos.y) > 2.5) continue;
    const tan = cubicTangentXZ(c, hit.t);
    if (Math.abs(tan.x * dir.x + tan.z * dir.z) < Math.cos(PARALLEL_ANGLE)) continue;
    best = Math.min(best, hit.distance);
  }
  return Number.isFinite(best) ? `To parallel road ${best.toFixed(1)} m` : null;
}

/**
 * The existing node or road a new road's end lands on, or a free point. Within a
 * road's half width counts, so a road drawn up to another joins it.
 */
export function resolveEndAnchor(net: RoadNetwork, p: Vec3, roadType: string, ignore?: ReadonlySet<Id>): RoadAnchor {
  const near = net.nearestNode(p, 3);
  const node = near ? net.getNode(near.nodeId) : undefined;
  if (node && Math.abs(node.pos.y - p.y) < 1.5) return { kind: 'node', id: node.id };
  const def = net.roadType(roadType);
  void def;
  let best: { id: Id; t: number; d: number } | null = null;
  for (const id of nearbySegments(net, p, 30)) {
    if (ignore?.has(id)) continue;
    const c = net.cubicOf(id);
    const hit = closestPointOnCubic(c, p);
    if (Math.abs(hit.point.y - p.y) > 1.5) continue;
    const tol = totalHalfWidth(net.roadTypeOf(id)) + 1;
    if (hit.distance > tol || (best && hit.distance >= best.d)) continue;
    best = { id, t: hit.t, d: hit.distance };
  }
  if (best) {
    const seg = net.getSegment(best.id)!;
    const len = net.segmentGeom(best.id)?.fullLength ?? 0;
    if (best.t * len < 6) return { kind: 'node', id: seg.a };
    if ((1 - best.t) * len < 6) return { kind: 'node', id: seg.b };
    return { kind: 'segment', id: best.id, t: best.t };
  }
  return { kind: 'free', pos: { ...p } };
}
