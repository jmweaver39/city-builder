/**
 * Every automatic marking at a junction as a single item that can be pointed at:
 * each crosswalk, stop line or yield-teeth row, turn arrow, lane guide and gore,
 * with an outline for hovering and picking and the reference that takes it away
 * (core/autoMarkings.ts). Built from the same layouts the renderer paints from, so
 * the outlines sit on the paint. Pure reads; no drawing.
 */
import { autoRefKey, isAutoOff } from '../core/autoMarkings';
import { framesOf } from '../core/nodeMarkings';
import type { RoadNetwork } from '../core/RoadNetwork';
import type { AutoMarkingRef, Id, Vec3 } from '../core/types';
import { goreAreas } from './gore';
import { armEndLayout, CROSSWALK_DEPTH, junctionGuides, STOP_WIDTH, TEETH_DEPTH } from './markings';

/** A crosswalk is taken away through the junction's crosswalk overrides, not `autoOff`. */
export type AutoItemRef = AutoMarkingRef | { kind: 'crosswalk'; segmentId: Id };

export interface AutoItem {
  ref: AutoItemRef;
  key: string;
  label: string;
  /** Closed outline (or, for a guide, the line itself) in world space. Empty for an item taken away. */
  outline: Vec3[];
  closed: boolean;
  /** Taken away by the user. */
  off: boolean;
  /** The arm it belongs to, for grouping. Guides and gores name their first road. */
  segmentId: Id;
}

export function autoItemKey(ref: AutoItemRef): string {
  return ref.kind === 'crosswalk' ? `crosswalk:${ref.segmentId}` : autoRefKey(ref);
}

/** A rectangle across a road from a to b, `depth` deep, centred on the line between them. */
function band(a: Vec3, b: Vec3, depth: number): Vec3[] {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  const nx = (-dz / l) * (depth / 2);
  const nz = (dx / l) * (depth / 2);
  return [
    { x: a.x + nx, y: a.y, z: a.z + nz },
    { x: b.x + nx, y: b.y, z: b.z + nz },
    { x: b.x - nx, y: b.y, z: b.z - nz },
    { x: a.x - nx, y: a.y, z: a.z - nz },
  ];
}

/** A box round a point, `w` across and `l` along a direction. */
function box(p: Vec3, dir: Vec3, w: number, l: number): Vec3[] {
  const ux = dir.x * (l / 2);
  const uz = dir.z * (l / 2);
  const vx = -dir.z * (w / 2);
  const vz = dir.x * (w / 2);
  return [
    { x: p.x - ux - vx, y: p.y, z: p.z - uz - vz },
    { x: p.x + ux - vx, y: p.y, z: p.z + uz - vz },
    { x: p.x + ux + vx, y: p.y, z: p.z + uz + vz },
    { x: p.x - ux + vx, y: p.y, z: p.z - uz + vz },
  ];
}

function roadName(net: RoadNetwork, id: Id): string {
  const s = net.getSegment(id);
  return s?.overrides.name || (s ? net.roadTypeOf(id).name : `road ${id}`);
}

/** The automatic markings at a node. With `withOff`, the ones taken away are listed too, without outlines. */
export function autoMarkingItems(net: RoadNetwork, nodeId: Id, withOff = false): AutoItem[] {
  const node = net.getNode(nodeId);
  if (!node) return [];
  const out: AutoItem[] = [];
  const push = (ref: AutoItemRef, label: string, outline: Vec3[], closed: boolean, segmentId: Id) =>
    out.push({ ref, key: autoItemKey(ref), label, outline, closed, off: false, segmentId });
  const frames = framesOf(net, nodeId);
  for (const segId of node.segments) {
    const seg = net.getSegment(segId);
    if (!seg) continue;
    const end = seg.b === nodeId ? 1 : -1;
    const layout = armEndLayout(net, segId, end);
    if (!layout) continue;
    const name = roadName(net, segId);
    if (layout.crosswalk) push({ kind: 'crosswalk', segmentId: segId }, `Crosswalk, ${name}`, band(layout.crosswalk.a, layout.crosswalk.b, CROSSWALK_DEPTH), true, segId);
    if (layout.stop) {
      const teeth = layout.stop.kind === 'teeth';
      push({ kind: 'stop', segmentId: segId }, `${teeth ? 'Yield teeth' : 'Stop line'}, ${name}`, band(layout.stop.a, layout.stop.b, teeth ? TEETH_DEPTH : Math.max(STOP_WIDTH, 0.8)), true, segId);
    }
    const inward = frames.find((f) => f.segmentId === segId)?.inward ?? { x: 1, y: 0, z: 0 };
    layout.arrows.forEach((a) => {
      push({ kind: 'arrow', segmentId: segId, lane: a.laneIndex }, `Turn arrow, lane ${a.laneIndex + 1}, ${name}`, box(a.pos, inward, 1.6, 5.2), true, segId);
    });
  }
  for (const g of junctionGuides(net, nodeId)) {
    const pts = g.pts.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    push({ kind: 'guide', from: g.from, to: g.to, part: g.part }, `Lane guide, ${roadName(net, g.from)} to ${roadName(net, g.to)}`, pts, false, g.from);
  }
  for (const gore of goreAreas(net, nodeId)) {
    const ref: AutoMarkingRef = { kind: 'gore', segments: gore.segments };
    if (isAutoOff(node.control, ref)) continue;
    push(ref, 'Gore hatching', gore.poly, true, gore.segments[0]);
  }
  if (withOff) {
    for (const [seg, style] of Object.entries(node.control.crosswalks)) {
      if (style !== 'none') continue;
      const id = Number(seg);
      out.push({ ref: { kind: 'crosswalk', segmentId: id }, key: `crosswalk:${id}`, label: `Crosswalk, ${roadName(net, id)}`, outline: [], closed: true, off: true, segmentId: id });
    }
    for (const ref of node.control.autoOff ?? []) {
      const seg = ref.kind === 'stop' || ref.kind === 'arrow' ? ref.segmentId : ref.kind === 'guide' ? ref.from : ref.segments[0];
      const label =
        ref.kind === 'stop'
          ? `Stop line or teeth, ${roadName(net, seg)}`
          : ref.kind === 'arrow'
            ? `Turn arrow, lane ${ref.lane + 1}, ${roadName(net, seg)}`
            : ref.kind === 'guide'
              ? `Lane guide, ${roadName(net, ref.from)} to ${roadName(net, ref.to)}`
              : 'Gore hatching';
      out.push({ ref, key: autoRefKey(ref), label, outline: [], closed: true, off: true, segmentId: seg });
    }
  }
  return out;
}

function inside(p: { x: number; z: number }, poly: readonly Vec3[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}

function distToLine(p: { x: number; z: number }, pts: readonly Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t));
  }
  return best;
}

/** The automatic item under a ground point, smallest first so an arrow beats a gore round it. */
export function autoItemAt(items: readonly AutoItem[], p: { x: number; z: number }, reach = 0.6): AutoItem | null {
  let best: AutoItem | null = null;
  let bestArea = Infinity;
  for (const it of items) {
    if (it.off || it.outline.length < 2) continue;
    let hit = false;
    let area = 0;
    if (it.closed && it.outline.length >= 3) {
      hit = inside(p, it.outline) || distToLine(p, [...it.outline, it.outline[0]]) <= reach * 0.5;
      for (let i = 0, j = it.outline.length - 1; i < it.outline.length; j = i++) area += it.outline[j].x * it.outline[i].z - it.outline[i].x * it.outline[j].z;
      area = Math.abs(area / 2);
    } else {
      hit = distToLine(p, it.outline) <= reach;
      area = 1;
    }
    if (hit && area < bestArea) {
      best = it;
      bestArea = area;
    }
  }
  return best;
}
