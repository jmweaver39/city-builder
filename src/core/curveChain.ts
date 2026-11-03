/**
 * Placing fitted curves (curveFit.ts) in the network. A fitted curve is a chain
 * of cubics, laid as one segment each and joined end to end with matching road
 * type and tangent, so every joint is a plain joint: no trim, no junction
 * surface, lanes running straight through.
 */
import type { Id, RampAttach, RoadTypeDef, SegmentOverrides, Vec3 } from './types';
import { arcLengthTable, closestPointOnCubic, cubicLength, cubicPoint, curvatureXZ, tAtLength, type Cubic } from './bezier';
import { clamp } from './math';
import { refitCubic, type FitResult } from './curveFit';
import { totalHalfWidth } from './roadTypes';
import type { DrawRoadResult, RoadAnchor, RoadNetwork } from './RoadNetwork';
import { NetworkError } from './RoadNetwork';

/** Tightest radius a road may be drawn at, as validateDraft rules. */
export function hardMinRadius(def: RoadTypeDef): number {
  return totalHalfWidth(def) * 1.25;
}

/** Radius under which a fast road should warn, as validateDraft rules. Undefined for slow roads. */
export function comfortRadius(def: RoadTypeDef): number | undefined {
  if (def.category !== 'highway' && def.category !== 'ramp') return undefined;
  const v = def.speedKmh;
  return (v * v) / (127 * 0.35);
}

export interface DrawChainParams {
  start: RoadAnchor;
  end: RoadAnchor;
  /** The chain, start to end. Inner joints become new nodes. */
  cubics: Cubic[];
  roadType: string;
  overrides?: SegmentOverrides;
  startAttach?: RampAttach;
  endAttach?: RampAttach;
}

/**
 * Draw a chain of cubics as one road, in one batch, so it is one undo step. Each
 * piece goes through drawRoad, so crossings still make junctions or bridges.
 */
export function drawChain(net: RoadNetwork, params: DrawChainParams): DrawRoadResult {
  const { cubics, roadType, overrides } = params;
  if (!cubics.length) throw new NetworkError('A road needs some length');
  if (cubics.length === 1) {
    const c = cubics[0];
    return net.drawRoad({
      start: params.start,
      end: params.end,
      c1: c.p1,
      c2: c.p2,
      roadType,
      overrides,
      startAttach: params.startAttach,
      endAttach: params.endAttach,
    });
  }
  return net.batch(() => {
    const { start, end } = resolveEnds(net, params.start, params.end);
    const result: DrawRoadResult = { segments: [], nodes: [], junctions: [] };
    let from: RoadAnchor = start;
    for (let i = 0; i < cubics.length; i++) {
      const c = cubics[i];
      const last = i === cubics.length - 1;
      const to: RoadAnchor = last ? end : { kind: 'free', pos: { ...c.p3 } };
      const piece = net.drawRoad({
        start: from,
        end: to,
        c1: c.p1,
        c2: c.p2,
        roadType,
        overrides,
        startAttach: i === 0 ? params.startAttach : undefined,
        endAttach: last ? params.endAttach : undefined,
      });
      result.segments.push(...piece.segments);
      for (const j of piece.junctions) if (!result.junctions.includes(j)) result.junctions.push(j);
      for (const n of piece.nodes) if (result.nodes[result.nodes.length - 1] !== n) result.nodes.push(n);
      const tail = piece.nodes[piece.nodes.length - 1];
      if (tail === undefined) break;
      from = { kind: 'node', id: tail };
    }
    return result;
  });
}

/**
 * Split segment anchors into nodes before any piece is drawn, since a piece
 * crossing that segment would change what its parameter means.
 */
function resolveEnds(net: RoadNetwork, start: RoadAnchor, end: RoadAnchor): { start: RoadAnchor; end: RoadAnchor } {
  if (start.kind === 'segment' && end.kind === 'segment' && start.id === end.id && start.t !== end.t) {
    // Both ends on one road: split the later point first so the earlier t still holds.
    const later = start.t > end.t ? start : end;
    const earlier = later === start ? end : start;
    const laterNode = net.splitSegment(later.id, later.t).node;
    const earlierNode = net.splitSegment(earlier.id, earlier.t / later.t).node;
    const ln: RoadAnchor = { kind: 'node', id: laterNode };
    const en: RoadAnchor = { kind: 'node', id: earlierNode };
    return later === start ? { start: ln, end: en } : { start: en, end: ln };
  }
  const resolve = (a: RoadAnchor): RoadAnchor => (a.kind === 'segment' ? { kind: 'node', id: net.splitSegment(a.id, a.t).node } : a);
  const s = resolve(start);
  return { start: s, end: resolve(end) };
}

/** Smooth curve refuses a refit longer than this many times the road it replaces. */
const MAX_GROWTH = 1.6;

export interface SmoothResult {
  /** True when the road changed. */
  changed: boolean;
  /** Segments of the road afterwards, a to b. */
  segments: Id[];
  fit: FitResult | null;
  message: string;
}

/**
 * Refit a segment as a smooth chain of tangent, spirals and arc, keeping its end
 * points, end directions and end grades. The original id keeps the first piece,
 * so whatever is attached at the a end stays put.
 */
export function smoothSegment(net: RoadNetwork, id: Id): SmoothResult {
  const seg = net.getSegment(id);
  if (!seg) return { changed: false, segments: [], fit: null, message: 'No such road.' };
  const def = net.roadTypeOf(id);
  const cubic = net.cubicOf(id);
  const opts = { minRadius: hardMinRadius(def), comfortRadius: comfortRadius(def) };
  let fit = refitCubic(cubic, opts);
  // With both end directions fixed, spirals make a loop swing wider. Where that costs
  // a lot of extra road, a plain arc stays closer to what was there.
  if (fit.kind === 'loop') {
    const plain = refitCubic(cubic, { ...opts, spirals: false });
    if (plain.ok && plain.length * 1.15 < fit.length) fit = plain;
  }
  if (fit.kind === 'straight') return { changed: false, segments: [id], fit, message: 'This road is already straight.' };
  if (!fit.ok) return { changed: false, segments: [id], fit, message: fit.reason ?? 'No smooth curve fits this road.' };
  // Ends and end directions fixed, an even arc can need far more room than a cramped
  // cubic took, as when a tight loop is squeezed between close ends. Say so rather than
  // throwing the road across the map.
  const before = cubicLength(cubic, 128);
  if (fit.length > before * MAX_GROWTH) {
    return {
      changed: false,
      segments: [id],
      fit,
      message: `Keeping these ends and directions, an even curve would be ${fit.length.toFixed(0)} m long against ${before.toFixed(0)} m now. Redraw it with Freeform for a compact loop.`,
    };
  }
  const pieces = fit.cubics;
  // A curve already close to its smooth fit, or whose curvature already runs evenly
  // from end to end as on an arc or a spiral (any piece of a fitted chain), stays.
  if (evenCurvature(cubic) || deviation(cubic, pieces) < Math.max(0.25, 0.002 * fit.length)) {
    return { changed: false, segments: [id], fit, message: 'This curve is already smooth.' };
  }
  const segments = net.batch(() => {
    // Cut the road where the chain's joints fall, by share of length, far end first.
    // The original id keeps the a side, so later cuts only rescale by the last one.
    const table = arcLengthTable(cubic, 256);
    const total = cubicLengthOf(pieces);
    const ts: number[] = [];
    let s = 0;
    for (let i = 0; i + 1 < pieces.length; i++) {
      s += cubicLength(pieces[i], 64);
      ts.push(clamp(tAtLength(table, (s / total) * table.length), 0.001, 0.999));
    }
    const ids: Id[] = [id];
    let upper = 1;
    for (let i = ts.length - 1; i >= 0; i--) {
      const r = net.splitSegment(id, ts[i] / upper);
      if (r.right !== null) ids.splice(1, 0, r.right);
      upper = ts[i];
    }
    if (ids.length !== pieces.length) throw new NetworkError('Smoothing could not cut the road into pieces');
    // Joints onto the chain, then each piece's handles.
    for (let i = 0; i + 1 < ids.length; i++) {
      const joint = net.getSegment(ids[i])!.b;
      net.moveNode(joint, pieces[i].p3);
    }
    ids.forEach((pid, i) => net.setSegmentControls(pid, pieces[i].p1, pieces[i].p2));
    return ids;
  });
  return {
    changed: true,
    segments,
    fit,
    message: `Smoothed into ${pieces.length} piece${pieces.length === 1 ? '' : 's'}, ${fit.radius.toFixed(0)} m radius.`,
  };
}

function cubicLengthOf(cubics: Cubic[]): number {
  return cubics.reduce((sum, c) => sum + cubicLength(c, 64), 0);
}

/**
 * True when plan curvature along the cubic stays within 10% of a straight ramp
 * between its end values, as on an arc (constant) or a clothoid (linear).
 */
function evenCurvature(c: Cubic): boolean {
  const table = arcLengthTable(c, 128);
  const L = table.length;
  if (L < 1e-6) return true;
  const n = 48;
  const ks: number[] = [];
  for (let i = 0; i <= n; i++) ks.push(curvatureXZ(c, tAtLength(table, (L * i) / n)));
  const peak = Math.max(...ks.map(Math.abs));
  if (peak < 1e-6) return true;
  return ks.every((k, i) => Math.abs(k - (ks[0] + ((ks[n] - ks[0]) * i) / n)) <= 0.1 * peak);
}

/** Largest plan distance from a cubic to the nearest of a chain of cubics. */
function deviation(c: Cubic, chain: Cubic[]): number {
  let worst = 0;
  for (let i = 0; i <= 48; i++) {
    const p: Vec3 = cubicPoint(c, i / 48);
    let best = Infinity;
    for (const piece of chain) best = Math.min(best, closestPointOnCubic(piece, p).distance);
    worst = Math.max(worst, best);
  }
  return worst;
}
