/**
 * Partial bulldozing. A road is walked into a "line": its segments in order,
 * carrying on through plain joints (curve chains, type changes) and, for a drag,
 * straight on through junctions. A span is a stretch of that line in metres, and
 * removing it splits the end segments exactly (splitSegment) and deletes what lies
 * between, so the road is left with two clean dead ends.
 *
 * The click rule: a click takes the stretch between the junctions or dead ends on
 * either side of the cursor. Plain joints are not boundaries, because nobody can
 * see them. When that stretch is longer than CLICK_WHOLE a section of SECTION
 * metres round the cursor goes instead, run out to a junction or dead end when it
 * would otherwise leave a stub shorter than MIN_STUB.
 */
import { closestPointOnCubic, cubicTangentXZ, subCubic, tAtLength, type Cubic } from '../core/bezier';
import { dotXZ, scale } from '../core/math';
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Id, Vec3 } from '../core/types';
import { totalHalfWidth } from '../core/roadTypes';
import { nodeReach } from './pick';

/** A stretch between junctions up to this long goes in one click. */
export const CLICK_WHOLE = 150;
/** Length of the section a click takes out of a longer stretch. */
export const SECTION = 60;
/** A click never leaves less than this between its cut and a junction or dead end. */
export const MIN_STUB = 20;
/** A cut this close to a segment's end uses the end, so no sliver is left. */
const END_EPS = 1;
/** Pieces this close to dead ahead count as the same road through a junction. */
const THROUGH_COS = Math.cos((35 * Math.PI) / 180);

export interface LinePiece {
  segmentId: Id;
  /** True when the segment runs a to b in the line's direction. */
  forward: boolean;
  /** Line distance where the piece starts. */
  start: number;
  length: number;
}

export interface RoadLine {
  pieces: LinePiece[];
  /** nodes[i] starts piece i; the last one ends the last piece. */
  nodes: Id[];
  length: number;
}

export interface Span {
  line: RoadLine;
  s0: number;
  s1: number;
}

const isRail = (net: RoadNetwork, id: Id): boolean => net.roadTypeOf(id).category === 'rail';

/** Unit plan direction of a segment leaving a node. */
function awayFrom(net: RoadNetwork, segId: Id, nodeId: Id): Vec3 {
  const seg = net.getSegment(segId)!;
  const c = net.cubicOf(segId);
  return seg.a === nodeId ? cubicTangentXZ(c, 0) : scale(cubicTangentXZ(c, 1), -1);
}

/** The segment that carries the road on from `cur` through `nodeId`, or null. */
function nextPiece(net: RoadNetwork, cur: Id, nodeId: Id, throughJunctions: boolean): Id | null {
  const node = net.getNode(nodeId);
  if (!node) return null;
  const others = node.segments.filter((s) => s !== cur);
  if (node.segments.length === 2) {
    const other = others[0];
    return other !== undefined && isRail(net, other) === isRail(net, cur) ? other : null;
  }
  if (!throughJunctions || node.segments.length < 2) return null;
  const incoming = awayFrom(net, cur, nodeId);
  const type = net.getSegment(cur)!.roadType;
  let best: Id | null = null;
  let bestCos = THROUGH_COS;
  for (const other of others) {
    if (net.getSegment(other)!.roadType !== type) continue;
    const cos = -dotXZ(incoming, awayFrom(net, other, nodeId));
    if (cos > bestCos) {
      best = other;
      bestCos = cos;
    }
  }
  return best;
}

/** Plain joints only, or straight on through junctions too. */
export function roadLine(net: RoadNetwork, segmentId: Id, throughJunctions: boolean): RoadLine {
  const first = net.getSegment(segmentId)!;
  type Step = { segmentId: Id; forward: boolean };
  const seen = new Set<Id>([segmentId]);
  const ahead: Step[] = [];
  const behind: Step[] = [];
  const walk = (out: Step[], fromNode: Id, cur: Id): Id => {
    let node = fromNode;
    for (;;) {
      const next = nextPiece(net, cur, node, throughJunctions);
      if (next === null || seen.has(next)) return node;
      seen.add(next);
      const seg = net.getSegment(next)!;
      // Leaving `node` along `next`: forward when next starts there.
      out.push({ segmentId: next, forward: seg.a === node });
      cur = next;
      node = seg.a === node ? seg.b : seg.a;
    }
  };
  walk(ahead, first.b, segmentId);
  const startNode = walk(behind, first.a, segmentId);
  // Behind was walked away from the start, so reverse it and flip each piece.
  const steps: Step[] = [...behind.reverse().map((s) => ({ segmentId: s.segmentId, forward: !s.forward })), { segmentId, forward: true }, ...ahead];
  const pieces: LinePiece[] = [];
  const nodes: Id[] = [startNode];
  let s = 0;
  for (const step of steps) {
    const length = net.curveOf(step.segmentId).length;
    pieces.push({ ...step, start: s, length });
    s += length;
    const seg = net.getSegment(step.segmentId)!;
    nodes.push(step.forward ? seg.b : seg.a);
  }
  return { pieces, nodes, length: s };
}

/** Line distance of a point given as segment and parameter. */
export function lineDistance(net: RoadNetwork, line: RoadLine, segmentId: Id, t: number): number {
  const piece = line.pieces.find((p) => p.segmentId === segmentId);
  if (!piece) return 0;
  const table = net.curveOf(segmentId).table;
  const u = lengthAt(table, t);
  return piece.start + (piece.forward ? u : piece.length - u);
}

function lengthAt(table: { ts: ArrayLike<number>; ss: ArrayLike<number> }, t: number): number {
  const n = table.ts.length - 1;
  if (n < 1) return 0;
  const x = Math.max(0, Math.min(1, t)) * n;
  const i = Math.min(Math.floor(x), n - 1);
  return table.ss[i] + (table.ss[i + 1] - table.ss[i]) * (x - i);
}

/** The segment and parameter at a line distance. */
export function pointAt(net: RoadNetwork, line: RoadLine, s: number): { segmentId: Id; t: number; pos: Vec3 } {
  const clamped = Math.max(0, Math.min(line.length, s));
  const piece = line.pieces.find((p) => clamped <= p.start + p.length) ?? line.pieces[line.pieces.length - 1];
  const curve = net.curveOf(piece.segmentId);
  const local = clamped - piece.start;
  const t = tAtLength(curve.table, piece.forward ? local : piece.length - local);
  const c = curve.cubic;
  const u = 1 - t;
  const pos = {
    x: u * u * u * c.p0.x + 3 * u * u * t * c.p1.x + 3 * u * t * t * c.p2.x + t * t * t * c.p3.x,
    y: u * u * u * c.p0.y + 3 * u * u * t * c.p1.y + 3 * u * t * t * c.p2.y + t * t * t * c.p3.y,
    z: u * u * u * c.p0.z + 3 * u * u * t * c.p1.z + 3 * u * t * t * c.p2.z + t * t * t * c.p3.z,
  };
  return { segmentId: piece.segmentId, t, pos };
}

/** The line distance nearest a point, in plan, and how far off the line it is. */
export function projectOnLine(net: RoadNetwork, line: RoadLine, p: Vec3): { s: number; distance: number } {
  let best = { s: 0, distance: Infinity };
  for (const piece of line.pieces) {
    const hit = closestPointOnCubic(net.cubicOf(piece.segmentId), p);
    if (hit.distance < best.distance) best = { s: lineDistance(net, line, piece.segmentId, hit.t), distance: hit.distance };
  }
  return best;
}

/** True at a junction or dead end: somewhere a span may stop without a cut. */
function isBoundary(net: RoadNetwork, nodeId: Id): boolean {
  return (net.getNode(nodeId)?.segments.length ?? 0) !== 2;
}

/** What a click at this point takes out. See the rule at the top of the file. */
export function clickSpan(net: RoadNetwork, segmentId: Id, t: number): Span {
  const line = roadLine(net, segmentId, false);
  const L = line.length;
  if (L <= CLICK_WHOLE) return { line, s0: 0, s1: L };
  const s = lineDistance(net, line, segmentId, t);
  let s0 = Math.max(0, s - SECTION / 2);
  let s1 = Math.min(L, s + SECTION / 2);
  // Keep the section its full length when the cursor is near one end.
  if (s0 === 0) s1 = Math.min(L, SECTION);
  if (s1 === L) s0 = Math.max(0, L - SECTION);
  if (s0 < MIN_STUB) s0 = 0;
  if (L - s1 < MIN_STUB) s1 = L;
  return { line, s0, s1 };
}

/**
 * The stretch from where a drag started to where the cursor is now, along the
 * road. An end near a junction or dead end runs out to it, so no stub is left
 * inside the junction.
 */
export function dragSpan(net: RoadNetwork, line: RoadLine, from: number, to: number): Span {
  let s0 = Math.min(from, to);
  let s1 = Math.max(from, to);
  const snapEnd = (s: number): number => {
    let at = s;
    let bestD = Infinity;
    for (let i = 0; i < line.nodes.length; i++) {
      const nodeId = line.nodes[i];
      if (!isBoundary(net, nodeId)) continue;
      const ns = i < line.pieces.length ? line.pieces[i].start : line.length;
      const d = Math.abs(ns - s);
      if (d <= nodeReach(net, nodeId) + 3 && d < bestD) {
        at = ns;
        bestD = d;
      }
    }
    return at;
  };
  s0 = snapEnd(s0);
  s1 = snapEnd(s1);
  return { line, s0, s1 };
}

export function spanLength(span: Span): number {
  return Math.max(0, span.s1 - span.s0);
}

/** The part of each segment a span covers, in that segment's own metres from a. */
export function spanParts(span: Span): { segmentId: Id; u0: number; u1: number; length: number }[] {
  const out: { segmentId: Id; u0: number; u1: number; length: number }[] = [];
  for (const p of span.line.pieces) {
    const a = Math.max(span.s0, p.start);
    const b = Math.min(span.s1, p.start + p.length);
    if (b - a <= 1e-6) continue;
    const l0 = a - p.start;
    const l1 = b - p.start;
    out.push({
      segmentId: p.segmentId,
      u0: p.forward ? l0 : p.length - l1,
      u1: p.forward ? l1 : p.length - l0,
      length: p.length,
    });
  }
  return out;
}

/** Curves of the stretch a span covers, for the red preview. */
export function spanCurves(net: RoadNetwork, span: Span): { roadType: string; cubic: Cubic }[] {
  return spanParts(span).map((part) => {
    const curve = net.curveOf(part.segmentId);
    const t0 = part.u0 <= END_EPS ? 0 : tAtLength(curve.table, part.u0);
    const t1 = part.length - part.u1 <= END_EPS ? 1 : tAtLength(curve.table, part.u1);
    return { roadType: net.getSegment(part.segmentId)!.roadType, cubic: subCubic(curve.cubic, t0, t1) };
  });
}

/** Where the span cuts the road, as points with the road's plan direction. Ends at a node are left out. */
export function spanCuts(net: RoadNetwork, span: Span): { pos: Vec3; dir: Vec3; halfWidth: number }[] {
  const out: { pos: Vec3; dir: Vec3; halfWidth: number }[] = [];
  for (const s of [span.s0, span.s1]) {
    const atNode = span.line.pieces.some((p) => Math.abs(p.start - s) < END_EPS) || Math.abs(span.line.length - s) < END_EPS;
    if (atNode) continue;
    const at = pointAt(net, span.line, s);
    out.push({ pos: at.pos, dir: cubicTangentXZ(net.cubicOf(at.segmentId), at.t), halfWidth: totalHalfWidth(net.roadTypeOf(at.segmentId)) });
  }
  return out;
}

export interface RemoveReport {
  /** Segments deleted outright, ids as they were when deleted. */
  removed: Id[];
  /** Segments cut short and kept. */
  trimmed: Id[];
  metres: number;
}

/** Remove a span: split the end segments and delete everything between. One batch. */
export function removeSpan(net: RoadNetwork, span: Span): RemoveReport {
  const parts = spanParts(span);
  const report: RemoveReport = { removed: [], trimmed: [], metres: spanLength(span) };
  net.batch(() => {
    for (const part of parts) {
      const id = part.segmentId;
      if (!net.getSegment(id)) continue;
      const L = net.curveOf(id).length;
      const fromStart = part.u0 <= END_EPS;
      const toEnd = L - part.u1 <= END_EPS;
      if (fromStart && toEnd) {
        net.removeSegment(id);
        report.removed.push(id);
      } else if (fromStart) {
        const cut = net.splitSegment(id, tAtLength(net.curveOf(id).table, part.u1));
        net.removeSegment(cut.left);
        report.removed.push(cut.left);
        if (cut.right !== null) report.trimmed.push(cut.right);
      } else if (toEnd) {
        const cut = net.splitSegment(id, tAtLength(net.curveOf(id).table, part.u0));
        if (cut.right !== null) {
          net.removeSegment(cut.right);
          report.removed.push(cut.right);
        }
        report.trimmed.push(id);
      } else {
        const far = net.splitSegment(id, tAtLength(net.curveOf(id).table, part.u1));
        const near = net.splitSegment(id, tAtLength(net.curveOf(id).table, part.u0));
        if (near.right !== null) {
          net.removeSegment(near.right);
          report.removed.push(near.right);
        }
        report.trimmed.push(id);
        if (far.right !== null) report.trimmed.push(far.right);
      }
    }
  });
  report.trimmed = report.trimmed.filter((id) => net.getSegment(id));
  return report;
}

/** Total length of a set of segments. */
export function segmentsLength(net: RoadNetwork, ids: readonly Id[]): number {
  let total = 0;
  for (const id of ids) if (net.getSegment(id)) total += net.curveOf(id).length;
  return total;
}

/** Platforms shorter than this after a cut are removed rather than kept as a stump. */
export const MIN_PLATFORM = 30;
/** Space kept between a platform and a new end of track. */
const PLATFORM_MARGIN = 2;

/** What the rail data looked like, to say afterwards what a removal did to it. */
export interface RailBefore {
  stations: Map<Id, string>;
  lines: { id: Id; name: string; stops: Id[] }[];
}

export function railBefore(net: RoadNetwork): RailBefore {
  return {
    stations: new Map(net.rail.stations.map((s) => [s.id, s.name])),
    lines: net.rail.lines.map((l) => ({ id: l.id, name: l.name, stops: [...l.stops] })),
  };
}

/**
 * Shorten platforms that now run past a new end of track, or remove them when too
 * little is left. Only stations on the given segments are looked at. Returns the
 * names of stations trimmed.
 */
export function trimStations(net: RoadNetwork, segments: readonly Id[]): string[] {
  const trimmed: string[] = [];
  const set = new Set(segments);
  for (const st of [...net.rail.stations]) {
    if (!set.has(st.segmentId) || st.platformLength <= 0) continue;
    const seg = net.getSegment(st.segmentId);
    if (!seg) continue;
    const curve = net.curveOf(st.segmentId);
    const L = curve.length;
    const c = lengthAt(curve.table, st.t);
    let lo = c - st.platformLength / 2;
    let hi = c + st.platformLength / 2;
    const deadA = net.getNode(seg.a)?.segments.length === 1;
    const deadB = net.getNode(seg.b)?.segments.length === 1;
    if (deadA) lo = Math.max(lo, PLATFORM_MARGIN);
    if (deadB) hi = Math.min(hi, L - PLATFORM_MARGIN);
    const length = hi - lo;
    if (length >= st.platformLength - 1e-6) continue;
    if (length < MIN_PLATFORM) {
      net.removeStation(st.id);
      continue;
    }
    net.updateStation(st.id, { t: tAtLength(curve.table, (lo + hi) / 2), platformLength: Math.round(length * 10) / 10 });
    trimmed.push(st.name);
  }
  return trimmed;
}

/** Warnings for stations and lines a removal changed. */
export function railMessages(net: RoadNetwork, before: RailBefore, trimmed: readonly string[]): string[] {
  const out: string[] = [];
  const now = new Set(net.rail.stations.map((s) => s.id));
  const gone = [...before.stations].filter(([id]) => !now.has(id));
  if (gone.length) out.push(`Removed station${gone.length > 1 ? 's' : ''} ${gone.map(([, n]) => n).join(', ')}.`);
  if (trimmed.length) out.push(`Shortened the platform at ${trimmed.join(', ')}.`);
  for (const line of before.lines) {
    const after = net.rail.lines.find((l) => l.id === line.id);
    if (!after) continue;
    const lost = line.stops.filter((s) => !after.stops.includes(s));
    if (!lost.length) continue;
    const names = [...new Set(lost.map((s) => before.stations.get(s) ?? `station ${s}`))].join(', ');
    out.push(
      after.stops.length < 2
        ? `${line.name} lost ${names} and has too few stops to run.`
        : `${line.name} no longer calls at ${names}.`,
    );
  }
  // Track cut between two stops a line still has.
  const component = trackComponents(net);
  for (const line of net.rail.lines) {
    const seg = (stop: Id) => net.rail.stations.find((s) => s.id === stop)?.segmentId;
    for (let i = 0; i + 1 < line.stops.length; i++) {
      const a = seg(line.stops[i]);
      const b = seg(line.stops[i + 1]);
      if (a === undefined || b === undefined || component.get(a) === component.get(b)) continue;
      const name = (stop: Id) => net.rail.stations.find((s) => s.id === stop)?.name ?? `station ${stop}`;
      out.push(`${line.name} can no longer run between ${name(line.stops[i])} and ${name(line.stops[i + 1])}: the track is cut.`);
      break;
    }
  }
  return out;
}

/** Which connected piece of track each rail segment belongs to. */
function trackComponents(net: RoadNetwork): Map<Id, number> {
  const out = new Map<Id, number>();
  let next = 0;
  for (const seg of net.segments) {
    if (out.has(seg.id) || !isRail(net, seg.id)) continue;
    const queue = [seg.id];
    out.set(seg.id, next);
    while (queue.length) {
      const cur = net.getSegment(queue.pop()!)!;
      for (const nodeId of [cur.a, cur.b]) {
        for (const other of net.getNode(nodeId)?.segments ?? []) {
          if (out.has(other) || !isRail(net, other)) continue;
          out.set(other, next);
          queue.push(other);
        }
      }
    }
    next++;
  }
  return out;
}
