/**
 * Picking how a road lines up with the end of a road of a different width: its left
 * edges together, centred, or its right edges together (core/laneAlign.ts). The road
 * tool offers three clickable points across the end of the road being joined; the
 * junction inspector offers the same choice for a joint already built.
 */
import { cubicTangentXZ } from '../core/bezier';
import { alignShift, carriagewaySpan } from '../core/laneAlign';
import { addScaled, distXZ, rightOf, scale } from '../core/math';
import type { RoadNetwork } from '../core/RoadNetwork';
import { effectiveLanes, isOneWay } from '../core/roadTypes';
import type { Id, LaneAlign, Vec3 } from '../core/types';

/** Widths closer than this are the same road width: nothing to line up. */
const SAME_WIDTH = 0.2;
/** How close the cursor must come to an alignment point to pick it, metres. */
const PICK = 1.8;

export interface AlignOption {
  /** In the frame of the road being joined (its a to b). */
  align: LaneAlign;
  /** Where the point is drawn: the centre of the narrower road there, just past the end. */
  pos: Vec3;
  /** What it does, for the readout. */
  label: string;
}

export interface AlignChoice {
  node: Id;
  /** The road whose end is joined, whose frame `align` is in. */
  existing: Id;
  options: AlignOption[];
  chosen: AlignOption;
  /** No point under the cursor: the default for this road. */
  byDefault: boolean;
  /** Sideways move of the new road's end at the node, right of the existing road's a to b. */
  newShift: number;
  /** Where the new road's end will sit. */
  endPos: Vec3;
}

export const flipAlign = (a: LaneAlign): LaneAlign => (a === 'left' ? 'right' : a === 'right' ? 'left' : 'centre');

type Span = { left: number; right: number };
const mirror = (s: Span): Span => ({ left: -s.right, right: -s.left });
const width = (s: Span) => s.right - s.left;

/**
 * The alignment points where a road of `roadType` would carry on from the dead end
 * at `nodeId`, with the one under `cursor` chosen. Null when the widths match.
 */
export function alignChoiceAt(net: RoadNetwork, nodeId: Id, roadType: string, cursor: Vec3 | null): AlignChoice | null {
  const node = net.getNode(nodeId);
  const def = net.roadType(roadType);
  if (!node || !def || node.segments.length !== 1 || def.category === 'rail') return null;
  const existing = net.getSegment(node.segments[0])!;
  const eDef = net.roadTypeOf(existing.id);
  if (eDef.category === 'rail' || existing.overrides.attachA || existing.overrides.attachB) return null;
  const se = carriagewaySpan(effectiveLanes(eDef, existing.overrides));
  // The new road carries straight on, so it runs the existing road's way when that ends here.
  const k = existing.b === nodeId ? 1 : -1;
  const ownN = carriagewaySpan(def.lanes);
  const sn = k === 1 ? ownN : mirror(ownN);
  if (Math.abs(width(se) - width(sn)) < SAME_WIDTH) return null;
  const forward = cubicTangentXZ(net.nodeCubicOf(existing.id), existing.b === nodeId ? 1 : 0);
  const R = rightOf(forward);
  // Into the new road, past the end.
  const beyond = scale(forward, k);
  const newNarrower = width(sn) < width(se);
  const extraSide = (a: LaneAlign) => (a === 'left' ? 'right' : a === 'right' ? 'left' : 'both sides');
  const what = newNarrower ? 'Lane drop' : 'Lane add';
  const options: AlignOption[] = (['left', 'centre', 'right'] as const).map((align) => {
    const lateral = newNarrower ? alignShift(sn, se, align) + (sn.left + sn.right) / 2 : (sn.left + sn.right) / 2 - alignShift(se, sn, align);
    const label = align === 'centre' ? `${what} on both sides, centred` : `${what} on the ${extraSide(align)}, lined up ${align}`;
    return { align, pos: addScaled(addScaled(node.pos, R, lateral), beyond, 2), label };
  });
  // A one-way road drops or adds on the right of its traffic, as usual; a two-way one centres.
  const travelRight: LaneAlign = forward && isOneWay(eDef) ? 'left' : 'centre';
  const fallback = options.find((o) => o.align === travelRight)!;
  let chosen = fallback;
  let best = PICK;
  for (const o of cursor ? options : []) {
    const d = distXZ(o.pos, cursor!);
    if (d < best) {
      best = d;
      chosen = o;
    }
  }
  const newShift = newNarrower ? alignShift(sn, se, chosen.align) : 0;
  return { node: nodeId, existing: existing.id, options, chosen, byDefault: chosen === fallback && best === PICK, newShift, endPos: addScaled(node.pos, R, newShift) };
}

/**
 * Line up the two roads at a joint, `align` in the frame of `frameSeg` (its a to b).
 * The narrower road's end there takes the alignment; centred clears it.
 */
export function setJointAlign(net: RoadNetwork, nodeId: Id, align: LaneAlign, frameSeg: Id): void {
  const node = net.getNode(nodeId);
  if (!node || node.segments.length !== 2) return;
  const [a, b] = node.segments.map((id) => net.getSegment(id)!);
  const span = (id: Id) => width(carriagewaySpan(effectiveLanes(net.roadTypeOf(id), net.getSegment(id)!.overrides)));
  const narrow = span(a.id) <= span(b.id) ? a : b;
  const other = narrow === a ? b : a;
  const frame = net.getSegment(frameSeg) ?? narrow;
  // Same sense through the node when one ends here and the other starts here.
  const sameWay = (x: typeof a, y: typeof a) => x.id === y.id || (x.b === nodeId) === (y.a === nodeId);
  const mine = sameWay(narrow, frame) ? align : flipAlign(align);
  net.batch(() => {
    // Only the narrower road moves; clear any left on the other.
    const clear = (s: typeof a) => (s.a === nodeId ? { alignA: undefined } : { alignB: undefined });
    net.setSegmentOverrides(other.id, clear(other));
    const value = align === 'centre' ? undefined : mine;
    net.setSegmentOverrides(narrow.id, narrow.a === nodeId ? { alignA: value } : { alignB: value });
  });
}

/** The current alignment at a two-road joint of different widths, in the wider road's frame, or null. */
export function jointAlign(net: RoadNetwork, nodeId: Id): { wide: Id; narrow: Id; align: LaneAlign } | null {
  const node = net.getNode(nodeId);
  if (!node || node.segments.length !== 2) return null;
  const [a, b] = node.segments.map((id) => net.getSegment(id)!);
  if ([a, b].some((s) => net.roadTypeOf(s.id).category === 'rail')) return null;
  const span = (id: Id) => width(carriagewaySpan(effectiveLanes(net.roadTypeOf(id), net.getSegment(id)!.overrides)));
  if (Math.abs(span(a.id) - span(b.id)) < SAME_WIDTH) return null;
  const narrow = span(a.id) < span(b.id) ? a : b;
  const wide = narrow === a ? b : a;
  const own = (narrow.a === nodeId ? narrow.overrides.alignA : narrow.overrides.alignB) ?? 'centre';
  const sameWay = (narrow.b === nodeId) === (wide.a === nodeId);
  return { wide: wide.id, narrow: narrow.id, align: sameWay ? own : flipAlign(own) };
}
