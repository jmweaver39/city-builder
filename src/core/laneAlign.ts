/**
 * Lining up a narrower road with the wider road it continues.
 *
 * Where a 2-lane road carries on from the end of a 3-lane one, the narrower road can
 * sit with its left edge on the wider one's left edge, centred, or with the right
 * edges together (`SegmentOverrides.alignA` / `alignB`, looking along the narrower
 * road's a to b). That end of its curve moves sideways by the difference, so the
 * lanes that carry on stay in line and only the lane that ends or begins shifts.
 * Centred, the default, is no move at all: older saves are unchanged.
 *
 * Only the narrower road moves, and only while it is the narrower one. The shift is
 * worked out from node positions and control points (never from shifted curves), so
 * nothing here depends on itself.
 */
import type { Id, LaneAlign, LaneDef, RoadNode, RoadTypeDef, Segment, Vec3 } from './types';
import type { Cubic } from './bezier';
import { cubicTangentXZ } from './bezier';
import { addScaled, dotXZ, normalizeXZ, rightOf, scale } from './math';
import { effectiveLanes } from './roadTypes';

/** What the alignment needs from the network. Same shape as ramps.ts AttachAccess. */
export interface AlignAccess {
  node(id: Id): RoadNode | undefined;
  segment(id: Id): Segment | undefined;
  def(seg: Segment): RoadTypeDef;
}

/** Roads within this of straight on carry on from each other at a node. */
const STRAIGHT_COS = Math.cos(0.5);

export function alignAt(seg: Segment, nodeId: Id): LaneAlign | undefined {
  if (seg.a === nodeId && seg.overrides.alignA) return seg.overrides.alignA;
  if (seg.b === nodeId && seg.overrides.alignB) return seg.overrides.alignB;
  return undefined;
}

function rawCubic(acc: AlignAccess, seg: Segment): Cubic | null {
  const a = acc.node(seg.a);
  const b = acc.node(seg.b);
  return a && b ? { p0: a.pos, p1: seg.c1, p2: seg.c2, p3: b.pos } : null;
}

const attachedAt = (seg: Segment, nodeId: Id) => (seg.a === nodeId && !!seg.overrides.attachA) || (seg.b === nodeId && !!seg.overrides.attachB);

/** Unit direction of a segment's a to b at one of its ends, from its raw curve. */
function forwardAt(acc: AlignAccess, seg: Segment, nodeId: Id): Vec3 | null {
  const c = rawCubic(acc, seg);
  if (!c || seg.a === seg.b) return null;
  return cubicTangentXZ(c, seg.a === nodeId ? 0 : 1);
}

/**
 * The road a segment end carries on as at a node: the closest to straight on of the
 * other roads there, leaving out ramps attached by lane and track meeting road.
 */
export function partnerAt(acc: AlignAccess, seg: Segment, nodeId: Id): { other: Segment; k: 1 | -1; forward: Vec3 } | null {
  const node = acc.node(nodeId);
  const f = forwardAt(acc, seg, nodeId);
  if (!node || !f || attachedAt(seg, nodeId)) return null;
  const rail = acc.def(seg).category === 'rail';
  // Away from the node along this road.
  const away = seg.a === nodeId ? f : scale(f, -1);
  let best: { other: Segment; k: 1 | -1; forward: Vec3 } | null = null;
  let bestDot = STRAIGHT_COS;
  for (const id of node.segments) {
    if (id === seg.id) continue;
    const o = acc.segment(id);
    if (!o || o.a === o.b || attachedAt(o, nodeId) || (acc.def(o).category === 'rail') !== rail) continue;
    const fo = forwardAt(acc, o, nodeId);
    if (!fo) continue;
    const awayO = o.a === nodeId ? fo : scale(fo, -1);
    const d = -dotXZ(away, awayO);
    if (d > bestDot) {
      bestDot = d;
      best = { other: o, k: dotXZ(fo, f) >= 0 ? 1 : -1, forward: f };
    }
  }
  return best;
}

/** Left and right edges of a road's carriageway, right of its a to b, every lane but track. */
export function carriagewaySpan(lanes: readonly LaneDef[]): { left: number; right: number } {
  let left = Infinity;
  let right = -Infinity;
  for (const l of lanes) {
    if (l.kind === 'rail') continue;
    left = Math.min(left, l.offset - l.width / 2);
    right = Math.max(right, l.offset + l.width / 2);
  }
  return Number.isFinite(left) ? { left, right } : { left: 0, right: 0 };
}

/** Sideways move, right of a to b, that lines up `own` with `other` (already in this road's frame). */
export function alignShift(own: { left: number; right: number }, other: { left: number; right: number }, align: LaneAlign): number {
  if (own.right - own.left >= other.right - other.left - 1e-3) return 0;
  if (align === 'left') return other.left - own.left;
  if (align === 'right') return other.right - own.right;
  return (other.left + other.right) / 2 - (own.left + own.right) / 2;
}

/** Both roads' spans at a joint, in `seg`'s frame, or null when it continues nothing. */
export function jointSpans(acc: AlignAccess, seg: Segment, nodeId: Id): { own: { left: number; right: number }; other: { left: number; right: number }; dir: Vec3 } | null {
  const p = partnerAt(acc, seg, nodeId);
  if (!p) return null;
  const own = carriagewaySpan(effectiveLanes(acc.def(seg), seg.overrides));
  const o = carriagewaySpan(effectiveLanes(acc.def(p.other), p.other.overrides));
  const other = p.k === 1 ? o : { left: -o.right, right: -o.left };
  // Square to both roads, as a plain joint's shared cross section is.
  const fo = forwardAt(acc, p.other, nodeId)!;
  const dir = normalizeXZ({ x: p.forward.x + fo.x * p.k, y: 0, z: p.forward.z + fo.z * p.k }, p.forward);
  return { own, other, dir };
}

/** How far right of its a to b a segment's end sits off its node. 0 when not aligned. */
export function endShift(acc: AlignAccess, seg: Segment, nodeId: Id): number {
  const align = alignAt(seg, nodeId);
  if (!align) return 0;
  const j = jointSpans(acc, seg, nodeId);
  return j ? alignShift(j.own, j.other, align) : 0;
}

/** A segment's curve with aligned ends moved sideways, handles with them so the tangent holds. */
export function alignedCubic(acc: AlignAccess, seg: Segment, c: Cubic): Cubic {
  let { p0, p1, p2, p3 } = c;
  for (const [nodeId, atA] of [
    [seg.a, true],
    [seg.b, false],
  ] as const) {
    if (!alignAt(seg, nodeId) || seg.a === seg.b) continue;
    const j = jointSpans(acc, seg, nodeId);
    if (!j) continue;
    const shift = alignShift(j.own, j.other, alignAt(seg, nodeId)!);
    if (Math.abs(shift) < 1e-6) continue;
    const r = rightOf(j.dir);
    if (atA) {
      p0 = addScaled(p0, r, shift);
      p1 = addScaled(p1, r, shift);
    } else {
      p3 = addScaled(p3, r, shift);
      p2 = addScaled(p2, r, shift);
    }
  }
  return { p0, p1, p2, p3 };
}

/** The alignment that puts a lane drop or add on `side` (1 right, looking along a to b) of the narrower road. */
export function alignForDropSide(side: 1 | -1): LaneAlign {
  return side > 0 ? 'left' : 'right';
}
