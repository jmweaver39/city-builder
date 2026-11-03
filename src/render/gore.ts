/**
 * Paint through highway diverges, merges, lane adds and lane drops.
 *
 * A ramp junction has a long surface with no paint of its own, so without this a
 * highway loses every line at every ramp. Here the lines carry on along the
 * connectors: dashed lines between lanes that run on together, edge lines along
 * the outside of each branch, one solid line where an exit lane parts from the
 * mainline, and a hatched gore between a branch and the mainline once they part.
 * There are no stop lines, crosswalks or turn arrows at these junctions.
 *
 * Also here: clipping for a segment's own lines where they would run over another
 * road's surface near such a junction, as where a ramp hugs its highway.
 */
import type { GLane, Id, LineStyle, MarkingStyle, Vec3 } from '../core/types';
import type { RoadNetwork } from '../core/RoadNetwork';
import { closestPointOnCubic } from '../core/bezier';
import { isControlledAccess } from '../core/ramps';
import { effectiveLanes, effectiveMarkings } from '../core/roadTypes';
import { PaintBuf, type LinePoint } from './batch';
import { LINE_WIDTH, PAINT_COL, ROAD_LIFT, strokesOf } from './constants';
import { clipToPolygon } from './nodeMarkings';

const EDGE_INSET = 0.18;
/** Edges of two branches closer than this are painted as one line. */
const MERGE_GAP = 0.9;
const HATCH_STEP = 2.6;
const HATCH_WIDTH = 0.4;

/** True for a junction painted as a free-flowing highway junction. */
export function isRampJunction(net: RoadNetwork, nodeId: Id): boolean {
  const g = net.nodeGeom(nodeId);
  if (!g || g.kind !== 'junction') return false;
  const cats = g.arms.map((a) => ({ category: net.roadTypeOf(a.segmentId).category }));
  if (isControlledAccess(cats)) return true;
  // Tapers between highway and ramp types, as at a lane add or drop.
  return cats.every((c) => c.category === 'highway' || c.category === 'ramp');
}

interface Strip {
  lane: GLane;
  /** Points of the lane centre in travel order. */
  pts: Vec3[];
  width: number;
  group: string;
  markings: MarkingStyle;
}

function pointsOf(l: GLane): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < l.cum.length; i++) out.push({ x: l.pts[i * 3], y: l.pts[i * 3 + 1], z: l.pts[i * 3 + 2] });
  return out;
}

/** Resample a polyline to n + 1 points evenly by length. */
function resample(pts: Vec3[], n: number): Vec3[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const total = cum[cum.length - 1];
  const out: Vec3[] = [];
  let j = 0;
  for (let k = 0; k <= n; k++) {
    const s = (total * k) / n;
    while (j + 2 < cum.length && cum[j + 1] < s) j++;
    const span = cum[j + 1] - cum[j];
    const f = span > 1e-9 ? Math.min(1, Math.max(0, (s - cum[j]) / span)) : 0;
    const a = pts[j];
    const b = pts[Math.min(j + 1, pts.length - 1)];
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f });
  }
  return out;
}

/** Right-hand unit normal at each point of a polyline. */
function normals(pts: Vec3[]): { x: number; z: number }[] {
  return pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: -dz / l, z: dx / l };
  });
}

function offsetLine(pts: Vec3[], d: number): Vec3[] {
  const nm = normals(pts);
  return pts.map((p, i) => ({ x: p.x + nm[i].x * d, y: p.y, z: p.z + nm[i].z * d }));
}

function toLinePoints(pts: Vec3[]): LinePoint[] {
  const nm = normals(pts);
  let u = 0;
  return pts.map((p, i) => {
    if (i > 0) u += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
    return { x: p.x, y: p.y + ROAD_LIFT, z: p.z, rx: nm[i].x, rz: nm[i].z, u };
  });
}

function stroke(buf: PaintBuf, pts: Vec3[], style: LineStyle, color: keyof typeof PAINT_COL, width = LINE_WIDTH): void {
  if (pts.length < 2 || style === 'none') return;
  for (const k of strokesOf(style)) {
    const line = k.shift ? offsetLine(pts, k.shift) : pts;
    buf.ribbon(toLinePoints(line), width, PAINT_COL[color], k.period, k.duty);
  }
}

/** Runs of consecutive true flags, as index ranges. */
function runs(flags: boolean[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  flags.forEach((f, i) => {
    if (f && start < 0) start = i;
    if (!f && start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  });
  if (start >= 0) out.push([start, flags.length - 1]);
  return out;
}

function distToPolyline(p: Vec3, pts: Vec3[]): number {
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

/** The lane strips through the junction: one per lane leaving, and one per lane arriving. */
function stripsAt(net: RoadNetwork, nodeId: Id): Strip[] {
  const g = net.laneGraph;
  const conns = (g.connectorsAt.get(nodeId) ?? []).map((i) => g.lanes[i]).filter((c) => c.vehicleKind !== 'rail' && c.vehicleKind !== 'bike');
  const pick = new Map<number, GLane>();
  const prefer = (c: GLane, old: GLane | undefined) => !old || (c.turn === 'straight' && old.turn !== 'straight');
  const byTo = new Map<number, GLane>();
  const byFrom = new Map<number, GLane>();
  for (const c of conns) {
    if (prefer(c, byTo.get(c.toLane))) byTo.set(c.toLane, c);
    if (prefer(c, byFrom.get(c.fromLane))) byFrom.set(c.fromLane, c);
  }
  for (const c of [...byTo.values(), ...byFrom.values()]) pick.set(c.idx, c);
  return [...pick.values()].map((c) => {
    const from = g.lanes[c.fromLane];
    const to = g.lanes[c.toLane];
    const seg = net.getSegment(from.segmentId)!;
    return {
      lane: c,
      pts: resample(pointsOf(c), 40),
      width: c.width,
      group: `${from.segmentId}>${to.segmentId}`,
      markings: effectiveMarkings(net.roadTypeOf(seg.id), seg.overrides),
    };
  });
}

/** Lines and gores through a ramp junction. Paints nothing at an ordinary junction. */
export function buildRampJunctionPaint(net: RoadNetwork, nodeId: Id, buf: PaintBuf): void {
  if (!isRampJunction(net, nodeId)) return;
  const node = net.getNode(nodeId);
  if (!node || node.control.hideAutoMarkings) return;
  const strips = stripsAt(net, nodeId);
  if (!strips.length) return;

  // Branches: strips making the same movement, ordered left to right.
  const groups = new Map<string, Strip[]>();
  for (const s of strips) {
    const list = groups.get(s.group);
    if (list) list.push(s);
    else groups.set(s.group, [s]);
  }
  const lateralOrder = (list: Strip[]) => {
    // Order by position across the middle of the movement.
    const mid = Math.floor(list[0].pts.length / 2);
    const ref = list[0].pts;
    const nm = normals(ref)[mid];
    return list.sort((a, b) => (a.pts[mid].x - b.pts[mid].x) * nm.x + (a.pts[mid].z - b.pts[mid].z) * nm.z);
  };
  const branches = [...groups.values()].map(lateralOrder);

  // Lines between lanes of one branch: dashed, following the connectors.
  for (const list of branches) {
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i];
      const b = list[i + 1];
      const mid = a.pts.map((p, k) => ({ x: (p.x + b.pts[k].x) / 2, y: (p.y + b.pts[k].y) / 2, z: (p.z + b.pts[k].z) / 2 }));
      // Two lanes that pull apart are separate branches, not one road.
      const spread = Math.max(...a.pts.map((p, k) => Math.hypot(p.x - b.pts[k].x, p.z - b.pts[k].z)));
      if (spread > (a.width + b.width) / 2 + 1.5) continue;
      stroke(buf, mid, a.markings.laneLine === 'none' ? 'dashed' : a.markings.laneLine, a.markings.laneColor);
    }
  }

  // Outside edges of each branch. Hidden where they lie inside another branch's
  // lane, as along a shared exit lane, and painted once where two run together.
  interface Edge {
    pts: Vec3[];
    branch: number;
    side: -1 | 1;
    visible: boolean[];
    markings: MarkingStyle;
  }
  const edges: Edge[] = [];
  branches.forEach((list, bi) => {
    for (const side of [-1, 1] as const) {
      const s = side < 0 ? list[0] : list[list.length - 1];
      const pts = offsetLine(s.pts, side * (s.width / 2 - EDGE_INSET));
      edges.push({ pts, branch: bi, side, visible: pts.map(() => true), markings: s.markings });
    }
  });
  for (const e of edges) {
    e.pts.forEach((p, k) => {
      for (let bi = 0; bi < branches.length; bi++) {
        if (bi === e.branch) continue;
        for (const s of branches[bi]) {
          if (distToPolyline(p, s.pts) < s.width / 2 - 0.3) {
            e.visible[k] = false;
            return;
          }
        }
      }
    });
  }
  edges.forEach((e, ei) => {
    e.pts.forEach((p, k) => {
      if (!e.visible[k]) return;
      for (let fj = 0; fj < ei; fj++) {
        const f = edges[fj];
        if (f.branch === e.branch) continue;
        if (distToPolyline(p, f.pts.filter((_, j) => f.visible[j])) < MERGE_GAP) {
          e.visible[k] = false;
          return;
        }
      }
    });
  });
  for (const e of edges) {
    for (const [i, j] of runs(e.visible)) {
      if (j - i < 1) continue;
      stroke(buf, e.pts.slice(i, j + 1), e.markings.edgeLine === 'none' ? 'solid' : e.markings.edgeLine, e.markings.edgeColor, LINE_WIDTH * 1.2);
    }
  }

  // Gores: between two branches sharing an end, from where they part to the cut.
  const g = net.laneGraph;
  for (let a = 0; a < branches.length; a++) {
    for (let b = a + 1; b < branches.length; b++) {
      const A = branches[a][0].lane;
      const B = branches[b][0].lane;
      const diverge = A.fromLane !== -1 && g.lanes[A.fromLane].segmentId === g.lanes[B.fromLane].segmentId;
      const merge = g.lanes[A.toLane].segmentId === g.lanes[B.toLane].segmentId;
      if (diverge === merge) continue;
      paintGore(buf, edges, a, b, diverge, net.getNode(nodeId)!.pos.y);
    }
  }
}

/** Hatch the area between the facing edges of two branches once they part. */
function paintGore(buf: PaintBuf, edges: { pts: Vec3[]; branch: number; side: -1 | 1; markings: MarkingStyle }[], a: number, b: number, diverge: boolean, y: number): void {
  // Facing edges: whichever pair is closest at the far end, where the branches have parted.
  const ea = edges.filter((e) => e.branch === a);
  const eb = edges.filter((e) => e.branch === b);
  const far = (e: { pts: Vec3[] }) => (diverge ? e.pts[e.pts.length - 1] : e.pts[0]);
  let best: [typeof ea[0], typeof eb[0]] | null = null;
  let bestD = Infinity;
  for (const x of ea) {
    for (const z of eb) {
      const d = Math.hypot(far(x).x - far(z).x, far(x).z - far(z).z);
      if (d < bestD) {
        bestD = d;
        best = [x, z];
      }
    }
  }
  if (!best) return;
  const [p, q] = best;
  const n = p.pts.length;
  // Walk from the far end towards the shared end until the edges meet.
  const order = diverge ? [...Array(n).keys()].reverse() : [...Array(n).keys()];
  const kept: number[] = [];
  for (const k of order) {
    const gap = Math.hypot(p.pts[k].x - q.pts[k].x, p.pts[k].z - q.pts[k].z);
    // Facing edges cross over where the branches still share road.
    const nm = normals(p.pts)[k];
    const sideNow = (q.pts[k].x - p.pts[k].x) * nm.x + (q.pts[k].z - p.pts[k].z) * nm.z;
    if (gap < 0.6 || Math.sign(sideNow) !== p.side) break;
    kept.push(k);
  }
  if (kept.length < 3) return;
  kept.sort((i, j) => i - j);
  const poly = [...kept.map((k) => p.pts[k]), ...kept.slice().reverse().map((k) => q.pts[k])];
  const color = PAINT_COL[p.markings.edgeColor];
  // Diagonal hatching, in the frame of the gore's long axis.
  const first = p.pts[kept[0]];
  const last = p.pts[kept[kept.length - 1]];
  const ux0 = last.x - first.x;
  const uz0 = last.z - first.z;
  const ul = Math.hypot(ux0, uz0) || 1;
  const ux = ux0 / ul;
  const uz = uz0 / ul;
  const vx = -uz;
  const vz = ux;
  const cx = (first.x + last.x) / 2;
  const cz = (first.z + last.z) / 2;
  const reach = ul / 2 + 20;
  const lift = y + ROAD_LIFT + 0.004;
  // Stripes lean back from the nose, like chevrons seen from the mainline.
  const lean = diverge ? -1 : 1;
  for (let k = -reach * 2; k <= reach * 2; k += HATCH_STEP) {
    const ax = cx + ux * k - vx * reach + ux * reach * lean;
    const az = cz + uz * k - vz * reach + uz * reach * lean;
    const bx = cx + ux * k + vx * reach - ux * reach * lean;
    const bz = cz + uz * k + vz * reach - uz * reach * lean;
    for (const [t0, t1] of clipToPolygon(ax, az, bx, bz, poly)) {
      const sy = lerpY(poly, ax + (bx - ax) * t0, az + (bz - az) * t0) ?? lift;
      buf.bar(ax + (bx - ax) * t0, sy, az + (bz - az) * t0, ax + (bx - ax) * t1, sy, az + (bz - az) * t1, HATCH_WIDTH, color);
    }
  }
}

/** Height of the nearest polygon vertex, lifted onto the road. */
function lerpY(poly: Vec3[], x: number, z: number): number | null {
  let best: Vec3 | null = null;
  let bd = Infinity;
  for (const p of poly) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best ? best.y + ROAD_LIFT + 0.004 : null;
}

// ---------------------------------------------------------------------------
// Clipping a segment's own lines near a ramp junction
// ---------------------------------------------------------------------------

/** How far past its cut a line may lie on another road before it is clipped. */
const CLIP_REACH = 150;
const CLIP_STEP = 2;

/**
 * For a segment meeting ramp junctions, a function giving the visible span of a
 * line at a lateral offset: the stretch next to each such junction where the line
 * lies on another road's lanes (or on a more important road's surface, shoulder
 * included) is left off, so a ramp and its highway never paint over each other.
 * Null when nothing needs clipping.
 */
export function overlapClip(net: RoadNetwork, segId: Id): ((offset: number, s0: number, s1: number) => [number, number]) | null {
  const seg = net.getSegment(segId);
  const geom = net.segmentGeom(segId);
  if (!seg || !geom || geom.stations.length < 2) return null;
  const rank = net.roadTypeOf(segId).rank;
  type Other = { cubic: ReturnType<RoadNetwork['cubicOf']>; reach: number };
  const othersAt = (nodeId: Id): Other[] => {
    if (!isRampJunction(net, nodeId)) return [];
    const out: Other[] = [];
    for (const id of net.getNode(nodeId)?.segments ?? []) {
      if (id === segId) continue;
      const def = net.roadTypeOf(id);
      const lanes = effectiveLanes(def, net.getSegment(id)!.overrides);
      const laneHalf = Math.max(...lanes.map((l) => Math.abs(l.offset) + l.width / 2));
      // A more important road keeps its shoulder clear too. Equal rank shares by id.
      const wins = def.rank > rank || (def.rank === rank && id < segId);
      out.push({ cubic: net.cubicOf(id), reach: wins ? def.halfWidth : laneHalf });
    }
    return out;
  };
  const atA = othersAt(seg.a);
  const atB = othersAt(seg.b);
  if (!atA.length && !atB.length) return null;
  const st = geom.stations;
  const pointAt = (s: number, offset: number): Vec3 => {
    let i = 0;
    while (i + 2 < st.length && st[i + 1].s < s) i++;
    const a = st[i];
    const b = st[i + 1];
    const f = Math.min(1, Math.max(0, (s - a.s) / Math.max(b.s - a.s, 1e-6)));
    return {
      x: a.pos.x + (b.pos.x - a.pos.x) * f + (a.right.x + (b.right.x - a.right.x) * f) * offset,
      y: a.pos.y + (b.pos.y - a.pos.y) * f,
      z: a.pos.z + (b.pos.z - a.pos.z) * f + (a.right.z + (b.right.z - a.right.z) * f) * offset,
    };
  };
  const onOther = (p: Vec3, others: Other[]) =>
    others.some((o) => {
      const hit = closestPointOnCubic(o.cubic, p);
      return hit.t > 1e-3 && hit.t < 1 - 1e-3 && hit.distance < o.reach && Math.abs(hit.point.y - p.y) < 3;
    });
  const cache = new Map<string, [number, number]>();
  return (offset, s0, s1) => {
    const key = `${offset.toFixed(3)}:${s0.toFixed(2)}:${s1.toFixed(2)}`;
    const hit = cache.get(key);
    if (hit) return hit;
    let a = s0;
    let b = s1;
    if (atA.length) {
      for (let s = s0; s < Math.min(s1, s0 + CLIP_REACH) && onOther(pointAt(s, offset), atA); s += CLIP_STEP) a = s + CLIP_STEP;
    }
    if (atB.length) {
      for (let s = s1; s > Math.max(a, s1 - CLIP_REACH) && onOther(pointAt(s, offset), atB); s -= CLIP_STEP) b = s - CLIP_STEP;
    }
    const out: [number, number] = [a, Math.max(a, b)];
    cache.set(key, out);
    return out;
  };
}
