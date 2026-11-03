/**
 * Plan-view footprints with a height range, for asking whether a station fits.
 * Everything is a chain of oriented boxes along a centreline, and two things
 * clash when any of their boxes overlap in plan (separating axis test) and their
 * height ranges overlap.
 */
import { closestPointOnCubic, cubicPoint, type Cubic } from './bezier';
import { stationLayout, trackOffsets, type PlatformLayout, type RailStation, type RailStationKind } from './railTypes';
import type { RoadNetwork } from './RoadNetwork';
import { terrainHeight } from './terrain';
import type { Id, RoadTypeDef, Vec3 } from './types';

/** A box in plan: centre, unit axis along it, half length and half width. */
export interface PlanBox {
  cx: number;
  cz: number;
  ax: number;
  az: number;
  hl: number;
  hw: number;
}

export interface Footprint {
  boxes: PlanBox[];
  y0: number;
  y1: number;
}

/** Separating axis test of two boxes in plan. Touching does not count. */
export function boxesOverlap(a: PlanBox, b: PlanBox): boolean {
  const dx = b.cx - a.cx;
  const dz = b.cz - a.cz;
  const axes: [number, number][] = [
    [a.ax, a.az],
    [-a.az, a.ax],
    [b.ax, b.az],
    [-b.az, b.ax],
  ];
  const extent = (q: PlanBox, x: number, z: number) => Math.abs(q.ax * x + q.az * z) * q.hl + Math.abs(-q.az * x + q.ax * z) * q.hw;
  for (const [x, z] of axes) {
    if (Math.abs(dx * x + dz * z) >= extent(a, x, z) + extent(b, x, z) - 1e-6) return false;
  }
  return true;
}

export function footprintsClash(a: Footprint, b: Footprint): boolean {
  if (a.y1 <= b.y0 || b.y1 <= a.y0) return false;
  for (const p of a.boxes) for (const q of b.boxes) if (boxesOverlap(p, q)) return true;
  return false;
}

/** Height range of a road or track surface at height y, by what it is: tunnel, deck or ground. */
function surfaceRange(y0: number, y1: number, ground: number): [number, number] {
  if (Math.max(y0, y1) < -1.5) return [Math.min(y0, y1) - 0.6, Math.max(y0, y1) + 6.4];
  if (Math.min(y0, y1) - ground > 1) return [Math.min(y0, y1) - 1.6, Math.max(y0, y1) + 5];
  return [Math.min(y0, y1) - 0.3, Math.max(y0, y1) + 4.5];
}

/** A whole segment, or the part of it between two arc lengths, with its width. */
export function segmentFootprint(net: RoadNetwork, id: Id, halfWidth?: number, from = 0, to = Infinity): Footprint {
  const def = net.roadTypeOf(id);
  const hw = halfWidth ?? def.halfWidth + def.sidewalk;
  const c = net.cubicOf(id);
  const L = net.curveOf(id).length;
  const s0 = Math.max(0, from);
  const s1 = Math.min(L, to);
  const n = Math.max(1, Math.ceil((s1 - s0) / 20));
  const boxes: PlanBox[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  let prev = cubicPoint(c, s0 / L);
  for (let i = 1; i <= n; i++) {
    const p = cubicPoint(c, (s0 + ((s1 - s0) * i) / n) / L);
    const dx = p.x - prev.x;
    const dz = p.z - prev.z;
    const l = Math.hypot(dx, dz) || 1;
    boxes.push({ cx: (p.x + prev.x) / 2, cz: (p.z + prev.z) / 2, ax: dx / l, az: dz / l, hl: l / 2, hw });
    const [a, b] = surfaceRange(prev.y, p.y, terrainHeight((p.x + prev.x) / 2, (p.z + prev.z) / 2));
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
    prev = p;
  }
  return { boxes, y0: lo, y1: hi };
}

/** A proposed curve's footprint, as segmentFootprint gives for a placed one. */
export function cubicFootprint(cubic: Cubic, halfWidth: number): Footprint {
  const boxes: PlanBox[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  const n = 24;
  let prev = cubicPoint(cubic, 0);
  for (let i = 1; i <= n; i++) {
    const p = cubicPoint(cubic, i / n);
    const dx = p.x - prev.x;
    const dz = p.z - prev.z;
    const l = Math.hypot(dx, dz) || 1;
    boxes.push({ cx: (p.x + prev.x) / 2, cz: (p.z + prev.z) / 2, ax: dx / l, az: dz / l, hl: l / 2, hw: halfWidth });
    const [a, b] = surfaceRange(prev.y, p.y, terrainHeight((p.x + prev.x) / 2, (p.z + prev.z) / 2));
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
    prev = p;
  }
  return { boxes, y0: lo, y1: hi };
}

/** How far a station reaches either side of its track's centreline, looking a to b. */
export function stationReach(def: RoadTypeDef, layout: PlatformLayout, kind: RailStationKind, building: 'left' | 'right' | null): { left: number; right: number } {
  const off = trackOffsets(def);
  const outer = 1.65 + 5 + 0.6;
  let left = -off[0] + 2.6;
  let right = off[off.length - 1] + 2.6;
  if (layout === 'island' && off.length === 2) {
    left = right = 4.65 + 2.6;
  } else {
    if (layout === 'left' || layout === 'both') left = -off[0] + outer;
    if (layout === 'right' || layout === 'both') right = off[off.length - 1] + outer;
  }
  if (kind === 'underground') {
    left += 0.5;
    right += 0.5;
  }
  // A building, or an elevated station's lift tower and hall, stands off to one side.
  const side = building ?? (kind === 'elevated' ? 'right' : null);
  if (side === 'left') left += 12;
  if (side === 'right') right += 12;
  return { left, right };
}

/** The footprint of a station's platforms, box or deck. */
export function stationFootprint(net: RoadNetwork, segmentId: Id, t: number, length: number, reach: { left: number; right: number }, kind: RailStationKind): Footprint {
  const c = net.cubicOf(segmentId);
  const L = net.curveOf(segmentId).length;
  const at = t * L;
  const half = Math.max(length, 20) / 2;
  const n = Math.max(1, Math.ceil((2 * half) / 20));
  const boxes: PlanBox[] = [];
  let y = 0;
  const shift = (reach.right - reach.left) / 2;
  const hw = (reach.right + reach.left) / 2;
  let prev = cubicPoint(c, Math.max(0, Math.min(1, (at - half) / L)));
  for (let i = 1; i <= n; i++) {
    const p = cubicPoint(c, Math.max(0, Math.min(1, (at - half + (2 * half * i) / n) / L)));
    const dx = p.x - prev.x;
    const dz = p.z - prev.z;
    const l = Math.hypot(dx, dz) || 1;
    const ax = dx / l;
    const az = dz / l;
    // Right of travel is (-az, ax).
    boxes.push({ cx: (p.x + prev.x) / 2 - az * shift, cz: (p.z + prev.z) / 2 + ax * shift, ax, az, hl: l / 2, hw });
    y = (p.y + prev.y) / 2;
    prev = p;
  }
  const range: Record<RailStationKind, [number, number]> = {
    surface: [-0.3, 5.5],
    elevated: [-2, 6],
    underground: [-0.8, 8],
    gateway: [-0.3, 5],
  };
  const [a, b] = range[kind];
  return { boxes, y0: y + a, y1: y + b };
}

/** The footprint of a placed station, from its saved layout. */
export function placedStationFootprint(net: RoadNetwork, st: RailStation): Footprint | null {
  if (!net.getSegment(st.segmentId) || st.kind === 'gateway') return null;
  const def = net.roadTypeOf(st.segmentId);
  const reach = stationReach(def, stationLayout(st, def), st.kind, st.building ?? null);
  return stationFootprint(net, st.segmentId, st.t, st.platformLength, reach, st.kind);
}

/** The station's own track: its segment and plain continuations of it, which its platforms may run onto. */
export function ownTrack(net: RoadNetwork, segmentId: Id): Set<Id> {
  const out = new Set<Id>([segmentId]);
  const type = net.getSegment(segmentId)?.roadType;
  let frontier = [segmentId];
  for (let hop = 0; hop < 3; hop++) {
    const next: Id[] = [];
    for (const id of frontier) {
      const s = net.getSegment(id);
      if (!s) continue;
      for (const nodeId of [s.a, s.b]) {
        const arms = net.getNode(nodeId)?.segments ?? [];
        if (arms.length !== 2) continue;
        for (const x of arms) {
          if (!out.has(x) && net.getSegment(x)?.roadType === type) {
            out.add(x);
            next.push(x);
          }
        }
      }
    }
    frontier = next;
  }
  return out;
}

/** A way in from the street: where it stands and which way its door faces. */
export interface StationEntrance {
  pos: Vec3;
  /** Unit horizontal direction the entrance faces, toward the street. */
  facing: { x: number; z: number };
  /** True when it stands beside a road rather than in open ground. */
  onStreet: boolean;
}

/**
 * Street entrances of a station: beside the nearest road to each end of the
 * platform, on the pavement edge facing it, or beside the station when there is
 * no road within reach. Used by the renderer, and by anything that walks people in.
 */
export function stationEntrances(net: RoadNetwork, ends: readonly Vec3[], fallbackSide: { x: number; z: number }, reach = 220): StationEntrance[] {
  return ends.map((end) => {
    let best: { p: Vec3; d: number; seg: Id } | null = null;
    for (const id of net.segmentsInRegion({ minX: end.x - reach, minZ: end.z - reach, maxX: end.x + reach, maxZ: end.z + reach }, true)) {
      const def = net.roadTypeOf(id);
      if (def.category === 'rail') continue;
      const hit = closestPointOnCubic(net.cubicOf(id), { ...end, y: 0 });
      if (Math.abs(hit.point.y) > 2) continue;
      if (!best || hit.distance < best.d) best = { p: hit.point, d: hit.distance, seg: id };
    }
    if (best && best.d < reach) {
      const def = net.roadTypeOf(best.seg);
      const dx = end.x - best.p.x;
      const dz = end.z - best.p.z;
      const l = Math.hypot(dx, dz) || 1;
      const off = def.halfWidth + def.sidewalk + 3;
      return {
        pos: { x: best.p.x + (dx / l) * off, y: 0, z: best.p.z + (dz / l) * off },
        facing: { x: -dx / l, z: -dz / l },
        onStreet: true,
      };
    }
    return { pos: { x: end.x + fallbackSide.x * 14, y: 0, z: end.z + fallbackSide.z * 14 }, facing: fallbackSide, onStreet: false };
  });
}

/** Kiosk footprints of an underground station's street entrances. */
export function kioskFootprints(net: RoadNetwork, st: RailStation): Footprint[] {
  if (st.kind !== 'underground' || !net.getSegment(st.segmentId)) return [];
  const c = net.cubicOf(st.segmentId);
  const L = net.curveOf(st.segmentId).length;
  const at = st.t * L;
  const ends = [at - st.platformLength * 0.35, at + st.platformLength * 0.35].map((s) => cubicPoint(c, Math.max(0, Math.min(1, s / L))));
  const a = cubicPoint(c, Math.max(0, st.t - 0.01));
  const b = cubicPoint(c, Math.min(1, st.t + 0.01));
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  // Only kiosks on a street are fixed; a stand-in beside the station moves to the first road built.
  return stationEntrances(net, ends, { x: -(b.z - a.z) / l, z: (b.x - a.x) / l }).filter((e) => e.onStreet).map((e) => ({
    boxes: [{ cx: e.pos.x, cz: e.pos.z, ax: e.facing.x, az: e.facing.z, hl: 3.4, hw: 2 }],
    y0: e.pos.y - 0.5,
    y1: e.pos.y + 3.5,
  }));
}
