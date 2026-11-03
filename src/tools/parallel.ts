/**
 * Parallel roads: offset curves of existing roads, and the Parallel Road tool's
 * planning and building. Pure functions over a RoadNetwork.
 *
 * An offset of a cubic is not a cubic, so each offset is fitted with cubics that
 * keep the original end tangents (Hermite handles by least squares), split in two
 * until every piece is within PARALLEL_TOLERANCE of the true offset. Heights
 * follow the original road. Offsets are measured to the right of the curve's
 * direction, (-t.z, 0, t.x), so a positive offset is on the right.
 */
import { closestPointOnCubic, cubicLength, cubicPoint, cubicTangentXZ, curvatureXZ, splitCubic, type Cubic } from '../core/bezier';
import { distXZ } from '../core/math';
import type { RoadAnchor, RoadNetwork } from '../core/RoadNetwork';
import { isOneWay, totalHalfWidth } from '../core/roadTypes';
import type { Id, Vec3 } from '../core/types';
import { resolveEndAnchor } from './guides';

/** Largest plan distance between a fitted offset and the true offset, metres. */
export const PARALLEL_TOLERANCE = 0.03;
/** Clear verge between two parallel roads for the "gap" offset, metres. */
export const PARALLEL_GAP = 6;
/** Offsets the tool offers, centre to centre, metres. Null is kerb to kerb. */
export const PARALLEL_PRESETS: readonly (number | null)[] = [null, 16, 24, 32, 48];

export type ParallelDirection = 'auto' | 'same' | 'opposite';

export interface ParallelSettings {
  /** Centreline to centreline, metres. Null: the two roads' edges touch. */
  offset: number | null;
  direction: ParallelDirection;
  /** Build with the original road's type, or the road type selected in the panel. */
  roadType: 'same' | 'selected';
}

export function defaultParallelSettings(): ParallelSettings {
  return { offset: null, direction: 'auto', roadType: 'same' };
}

/** Point offset `d` metres to the right of the curve at t. Height follows the curve. */
export function offsetPoint(c: Cubic, t: number, d: number): Vec3 {
  const p = cubicPoint(c, t);
  const tan = cubicTangentXZ(c, t);
  return { x: p.x - tan.z * d, y: p.y, z: p.z + tan.x * d };
}

/** Bernstein weights. */
function bern(u: number): [number, number, number, number] {
  const v = 1 - u;
  return [v * v * v, 3 * u * v * v, 3 * u * u * v, u * u * u];
}

/** One cubic fitted to the offset of `c`, keeping its end tangents, and its worst error. */
export function fitOffset(c: Cubic, d: number): { cubic: Cubic; error: number } {
  const a = offsetPoint(c, 0, d);
  const b = offsetPoint(c, 1, d);
  const t0 = cubicTangentXZ(c, 0);
  const t3 = cubicTangentXZ(c, 1);
  // Least squares for the handle lengths, matching the offset at the curve's own parameters.
  let a11 = 0, a12 = 0, a22 = 0, r1 = 0, r2 = 0;
  const n = 24;
  for (let i = 1; i < n; i++) {
    const u = i / n;
    const q = offsetPoint(c, u, d);
    const [b0, b1, b2, b3] = bern(u);
    const rx = q.x - a.x * (b0 + b1) - b.x * (b2 + b3);
    const rz = q.z - a.z * (b0 + b1) - b.z * (b2 + b3);
    const dot = t0.x * t3.x + t0.z * t3.z;
    a11 += b1 * b1;
    a12 -= b1 * b2 * dot;
    a22 += b2 * b2;
    r1 += b1 * (t0.x * rx + t0.z * rz);
    r2 -= b2 * (t3.x * rx + t3.z * rz);
  }
  const det = a11 * a22 - a12 * a12;
  const chord = distXZ(a, b);
  let h0 = chord / 3;
  let h3 = chord / 3;
  if (Math.abs(det) > 1e-12) {
    h0 = (r1 * a22 - r2 * a12) / det;
    h3 = (a11 * r2 - a12 * r1) / det;
  }
  if (!(h0 > 0) || !(h3 > 0) || h0 > chord * 2 || h3 > chord * 2) {
    h0 = chord / 3;
    h3 = chord / 3;
  }
  const cubic: Cubic = {
    p0: a,
    p1: { x: a.x + t0.x * h0, y: c.p1.y, z: a.z + t0.z * h0 },
    p2: { x: b.x - t3.x * h3, y: c.p2.y, z: b.z - t3.z * h3 },
    p3: b,
  };
  let error = 0;
  for (let i = 0; i <= 32; i++) {
    const q = offsetPoint(c, i / 32, d);
    error = Math.max(error, closestPointOnCubic(cubic, q).distance);
  }
  return { cubic, error };
}

/** The offset of `c` as cubics within `tolerance` of the true offset curve. */
export function offsetCubic(c: Cubic, d: number, tolerance = PARALLEL_TOLERANCE, depth = 0): Cubic[] {
  if (Math.abs(d) < 1e-9) return [c];
  const fit = fitOffset(c, d);
  if (fit.error <= tolerance || depth >= 6) return [fit.cubic];
  const [l, r] = splitCubic(c, 0.5);
  return [...offsetCubic(l, d, tolerance, depth + 1), ...offsetCubic(r, d, tolerance, depth + 1)];
}

/** Tightest radius on the side `d` is offset to (Infinity when that side never bends in). */
export function insideRadius(c: Cubic, d: number): number {
  let r = Infinity;
  for (let i = 0; i <= 48; i++) {
    const k = curvatureXZ(c, i / 48);
    // Positive curvature bends right, so the right side (d > 0) is the inside.
    if (k * d > 1e-9) r = Math.min(r, 1 / Math.abs(k));
  }
  return r;
}

export function reverseCubic(c: Cubic): Cubic {
  return { p0: c.p3, p1: c.p2, p2: c.p1, p3: c.p0 };
}

/** Centre-to-centre offset at which two road types' edges touch. */
export function touchingOffset(net: RoadNetwork, a: string, b: string): number {
  const da = net.roadType(a);
  const db = net.roadType(b);
  return (da ? totalHalfWidth(da) : 5) + (db ? totalHalfWidth(db) : 5) + 0.5;
}

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

export interface ChainStep {
  segmentId: Id;
  /** True when the chain runs b to a along this segment. */
  reversed: boolean;
}

/** Order a set of segments into one path through their shared nodes. Null when they don't form one. */
export function orderChain(net: RoadNetwork, ids: readonly Id[]): ChainStep[] | null {
  const set = new Set(ids.filter((id) => net.getSegment(id)));
  if (!set.size) return null;
  const linked = (node: Id) => net.getNode(node)!.segments.filter((s) => set.has(s));
  // Start from a segment with an end that links to nothing else in the set.
  let first: Id | null = null;
  let fromNode: Id | null = null;
  for (const id of set) {
    const seg = net.getSegment(id)!;
    for (const n of [seg.a, seg.b]) {
      if (linked(n).length === 1) {
        first = id;
        fromNode = n;
        break;
      }
    }
    if (first !== null) break;
  }
  if (first === null) {
    first = [...set][0];
    fromNode = net.getSegment(first)!.a;
  }
  const out: ChainStep[] = [];
  const used = new Set<Id>();
  let cur: Id | null = first;
  let node = fromNode!;
  while (cur !== null && !used.has(cur)) {
    const seg = net.getSegment(cur)!;
    const reversed = seg.b === node;
    out.push({ segmentId: cur, reversed });
    used.add(cur);
    node = reversed ? seg.a : seg.b;
    const next = linked(node).filter((s) => !used.has(s));
    if (next.length > 1) return null;
    cur = next[0] ?? null;
  }
  return out.length === set.size ? out : null;
}

/** The road a segment belongs to: extended both ways through nodes with exactly two roads. */
export function roadChain(net: RoadNetwork, segmentId: Id): Id[] {
  const ids = new Set<Id>([segmentId]);
  const walk = (seg: Id, node: Id) => {
    for (let guard = 0; guard < 500; guard++) {
      const n = net.getNode(node);
      if (!n || n.segments.length !== 2) return;
      const next = n.segments.find((s) => s !== seg)!;
      if (ids.has(next)) return;
      ids.add(next);
      const s = net.getSegment(next)!;
      seg = next;
      node = s.a === node ? s.b : s.a;
    }
  };
  const seg = net.getSegment(segmentId);
  if (!seg) return [];
  walk(segmentId, seg.a);
  walk(segmentId, seg.b);
  return [...ids];
}

// ---------------------------------------------------------------------------
// The Parallel Road tool
// ---------------------------------------------------------------------------

export interface ParallelPlan {
  pieces: Cubic[];
  roadType: string;
  /** Centre-to-centre distance used. */
  offset: number;
  /** +1 right of the chain's direction, -1 left. */
  side: 1 | -1;
  /** The copy runs against the original's direction. */
  opposite: boolean;
  errors: string[];
  warnings: string[];
  /** Validation state per piece. */
  state: ('ok' | 'warning' | 'error')[];
}

/** Plan a parallel copy of an ordered chain. */
export function planParallel(
  net: RoadNetwork,
  chain: readonly ChainStep[],
  side: 1 | -1,
  settings: ParallelSettings,
  selectedRoadType: string,
): ParallelPlan {
  const baseType = net.getSegment(chain[0].segmentId)?.roadType ?? selectedRoadType;
  const roadType = settings.roadType === 'selected' ? selectedRoadType : baseType;
  const touch = touchingOffset(net, baseType, roadType);
  const offset = settings.offset ?? touch;
  const def = net.roadType(baseType);
  const opposite = settings.direction === 'opposite' || (settings.direction === 'auto' && !!def && isOneWay(def));
  const errors = new Set<string>();
  const warnings = new Set<string>();
  let pieces: Cubic[] = [];
  for (const step of chain) {
    const c0 = net.cubicOf(step.segmentId);
    const c = step.reversed ? reverseCubic(c0) : c0;
    const d = side * offset;
    if (insideRadius(c, d) <= offset + 1) errors.add(`The road bends too tightly to run ${offset.toFixed(0)} m inside it.`);
    pieces.push(...offsetCubic(c, d));
  }
  if (opposite) pieces = pieces.map(reverseCubic).reverse();
  const state: ParallelPlan['state'] = [];
  if (!errors.size) {
    const anchors = pieceAnchors(net, pieces, roadType, true);
    pieces.forEach((p, i) => {
      const issues = net.validateDraft({ start: anchors[i], end: anchors[i + 1], c1: p.p1, c2: p.p2, roadType });
      let worst: 'ok' | 'warning' | 'error' = 'ok';
      for (const issue of issues) {
        if (issue.severity === 'error') {
          worst = 'error';
          errors.add(issue.message);
        } else {
          if (worst === 'ok') worst = 'warning';
          warnings.add(issue.message);
        }
      }
      state.push(worst);
    });
  }
  if (errors.size) pieces.forEach((_, i) => (state[i] = 'error'));
  return { pieces, roadType, offset, side, opposite, errors: [...errors], warnings: [...warnings], state };
}

/** Anchors at the piece joints: the ends join roads they land on, joints in between are free points. */
function pieceAnchors(net: RoadNetwork, pieces: readonly Cubic[], roadType: string, preview: boolean): RoadAnchor[] {
  const out: RoadAnchor[] = [];
  const last = pieces.length;
  for (let i = 0; i <= last; i++) {
    const p = i < last ? pieces[i].p0 : pieces[last - 1].p3;
    if (i === 0 || i === last) out.push(resolveEndAnchor(net, p, roadType));
    else out.push({ kind: 'free', pos: { ...p } });
  }
  void preview;
  return out;
}

/** Build a checked plan. Call inside one `net.batch` for one undo step. */
export function buildParallel(net: RoadNetwork, plan: ParallelPlan): Id[] {
  const segments: Id[] = [];
  const pieces = plan.pieces;
  let prevNode: Id | null = null;
  pieces.forEach((p, i) => {
    const start: RoadAnchor = prevNode !== null ? { kind: 'node', id: prevNode } : resolveEndAnchor(net, p.p0, plan.roadType);
    const end: RoadAnchor = i === pieces.length - 1 ? resolveEndAnchor(net, p.p3, plan.roadType) : { kind: 'free', pos: { ...p.p3 } };
    const r = net.drawRoad({ start, end, c1: p.p1, c2: p.p2, roadType: plan.roadType });
    segments.push(...r.segments);
    prevNode = r.nodes[r.nodes.length - 1] ?? null;
  });
  return segments;
}

/** Length of a chain, metres. */
export function chainLength(net: RoadNetwork, chain: readonly ChainStep[]): number {
  return chain.reduce((sum, s) => sum + cubicLength(net.cubicOf(s.segmentId), 32), 0);
}
