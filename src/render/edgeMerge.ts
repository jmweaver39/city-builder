/**
 * Drawing an edge merge or diverge (core/edgeMerge.ts): the highway runs on
 * untouched, and only the ramp's taper beside its edge gets surface and paint.
 *
 * Surface: the taper outline, with a verge (or a barrier, raised) along its outer
 * edge so the kerb follows the taper. Paint, all through the shared standards
 * (core/paintStandard.ts, render/paint.ts): an edge line along the taper into the
 * highway's edge line, the gore with its chevrons and edge lines between ramp and
 * highway, and the broken line between the taper lane and the highway's edge lane.
 * The highway's own edge line steps aside along the taper (`edgeMergeClip`).
 */
import type { EdgeMergeGeom, Id, NodeGeom, Vec3 } from '../core/types';
import type { RoadNetwork } from '../core/RoadNetwork';
import { effectiveMarkings } from '../core/roadTypes';
import { groundHeight } from '../core/terrainMods';
import { EDGE_INSET, FILL_STANDARDS, lineStandard, speedClassOf } from '../core/paintStandard';
import { roadSpeed } from '../core/paintCoherence';
import { isAutoOff } from '../core/autoMarkings';
import { carriagewayEdgeOf } from '../core/edgeMerge';
import { effectiveLanes } from '../core/roadTypes';
import type { PaintBuf } from './batch';
import { ROAD_LIFT, BIAS_JUNCTION } from './constants';
import { paintArea, paintSpecAlong } from './paint';
import type { RoadOutputs } from './roads';
import { buildCorner, fillPolygon, junctionColour, junctionKind } from './junctions';

/** True for a node drawn as an edge merge. */
export function isEdgeMerge(net: RoadNetwork, nodeId: Id): boolean {
  return net.nodeGeom(nodeId)?.kind === 'merge';
}

function offsetLine(pts: readonly Vec3[], d: number): Vec3[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    // Right of travel is (-dz, dx).
    return { x: p.x - (dz / l) * d, y: p.y, z: p.z + (dx / l) * d };
  });
}

/** Part of a polyline between two shares of its length. */
function portion(pts: readonly Vec3[], from: number, to: number): Vec3[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const total = cum[cum.length - 1];
  const at = (s: number): Vec3 => {
    let i = 0;
    while (i + 2 < cum.length && cum[i + 1] < s) i++;
    const f = cum[i + 1] > cum[i] ? Math.min(1, Math.max(0, (s - cum[i]) / (cum[i + 1] - cum[i]))) : 0;
    const a = pts[i];
    const b = pts[Math.min(i + 1, pts.length - 1)];
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
  };
  const s0 = total * from;
  const s1 = total * to;
  const out = [at(s0)];
  for (let i = 0; i < pts.length; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pts[i]);
  out.push(at(s1));
  return out;
}

/** The segment and its markings for the host arm beside the taper. */
function hostOf(net: RoadNetwork, g: NodeGeom, e: EdgeMergeGeom) {
  const arm = g.arms[e.merge ? e.hostIn : e.hostOut];
  const seg = net.getSegment(arm.segmentId)!;
  const def = net.roadTypeOf(arm.segmentId);
  return { arm, seg, def, markings: effectiveMarkings(def, seg.overrides), speed: roadSpeed(net, arm.segmentId) };
}

/** Surface of an edge merge: the taper, and the verge or barrier along its outside. */
export function buildEdgeMergeSurface(net: RoadNetwork, id: Id, slot: number, out: RoadOutputs): void {
  const g = net.nodeGeom(id);
  const node = net.getNode(id);
  if (!g || !node || !g.edge || g.outline.length < 3) return;
  const e = g.edge;
  fillPolygon(out.surf, g.outline, ROAD_LIFT, { color: junctionColour(net, g), kind: junctionKind(net, g), slot, bias: BIAS_JUNCTION }, false, { x: node.pos.x, z: node.pos.z });
  // Corner chains run with the outside on their left (junctions.ts): against travel on the right side.
  const chain = e.side > 0 ? e.taperOuter.slice().reverse() : e.taperOuter.slice();
  const mid = chain[chain.length >> 1];
  const ground = groundHeight(net, mid.x, mid.z);
  buildCorner(out.surf, chain, chain, 0, 0, { slot, clearance: mid.y - ground, ground });
}

/** Paint of an edge merge: taper edge line, gore and the broken line beside the edge lane. */
export function buildEdgeMergePaint(net: RoadNetwork, id: Id, buf: PaintBuf): void {
  const g = net.nodeGeom(id);
  const node = net.getNode(id);
  if (!g || !node || !g.edge || node.control.hideAutoMarkings) return;
  const e = g.edge;
  const host = hostOf(net, g, e);
  const fast = speedClassOf(host.speed) === 'fast';
  const edgeColor = e.side < 0 && fast && host.markings.edgeColor === 'white' ? 'yellow' : host.markings.edgeColor;
  // The edge line round the outside of the taper, carrying the ramp's into the highway's.
  const inward = -e.side * EDGE_INSET;
  if (host.markings.edgeLine !== 'none') {
    paintSpecAlong(buf, offsetLine(e.taperLine, inward), { ...lineStandard('edge').spec, color: edgeColor }, 1, host.speed);
  }
  // The line between the taper lane and the edge lane: broken where the ramp blends in.
  // An on-ramp's acceleration lane ends ahead (lane drop); an off-ramp's lane is exit only.
  const n = e.hostEdge.length;
  if (n >= 2) {
    // Where the ramp's lanes already run beside the highway's at the cut, the line starts there.
    const share = e.mode === 'taper' ? (e.gore.length ? 0.45 : 0.05) : 1;
    // From the gore's tip to the node, in travel order.
    const run = e.merge ? portion(e.hostEdge, share, e.mode === 'taper' ? 0.92 : 1) : portion(e.hostEdge, e.mode === 'taper' ? 0.08 : 0, 1 - share);
    const look = e.mode === 'add' ? lineStandard('lane').spec : e.merge ? lineStandard('laneDrop').spec : lineStandard('exitOnly').spec;
    if (run.length >= 2 && e.mode !== 'drop') paintSpecAlong(buf, run, { ...look, color: host.markings.laneColor }, 1, host.speed);
  }
  // Gore: chevrons inside an edge line, from the nose to where the lanes meet. Part of it
  // lies in the taper; the rest is between the ramp and the highway beyond the ramp's cut.
  const segments = [...new Set(g.arms.map((a) => a.segmentId))].sort((a, b) => a - b);
  if (!isAutoOff(node.control, { kind: 'gore', segments })) {
    const look = { ...FILL_STANDARDS.find((f) => f.id === 'gore')!.spec, color: host.markings.edgeColor, ...(e.merge ? {} : { invert: true as const }) };
    const yOf = (poly: Vec3[]) => poly.reduce((s, p) => s + p.y, 0) / poly.length + ROAD_LIFT;
    if (e.gore.length >= 3) paintArea(buf, e.gore, yOf(e.gore), look);
    const beyond = goreBeyondCut(net, g, e);
    // Its sides are the ramp's and the highway's own edge lines already.
    if (beyond.length >= 3) paintArea(buf, beyond, yOf(beyond), { ...look, noOutline: true });
  }
}

/** Widest a painted gore gets before it is left to grass, metres. */
const GORE_WIDTH = 6;
/** How far along the ramp a gore is looked for past its cut, metres. */
const GORE_REACH = 250;

/** Stations walked outward from a node along a road and on through plain joints, with the way out at each. */
export function chainOutward(net: RoadNetwork, segId: Id, fromNode: Id, reach: number): { pos: Vec3; tangent: Vec3; right: Vec3; segId: Id }[] {
  const out: { pos: Vec3; tangent: Vec3; right: Vec3; segId: Id }[] = [];
  let id = segId;
  let at = fromNode;
  let walked = 0;
  for (let hop = 0; hop < 12 && walked < reach; hop++) {
    const seg = net.getSegment(id);
    const geom = net.segmentGeom(id);
    if (!seg || !geom || geom.stations.length < 2) break;
    const st = seg.a === at ? geom.stations : geom.stations.slice().reverse();
    const sign = seg.a === at ? 1 : -1;
    for (const x of st) {
      const prev = out[out.length - 1];
      if (prev) walked += Math.hypot(x.pos.x - prev.pos.x, x.pos.z - prev.pos.z);
      out.push({ pos: x.pos, tangent: { x: x.tangent.x * sign, y: 0, z: x.tangent.z * sign }, right: x.right, segId: id });
      if (walked >= reach) break;
    }
    const far = seg.a === at ? seg.b : seg.a;
    const node = net.getNode(far);
    if (!node || node.segments.length !== 2 || net.nodeGeom(far)?.kind !== 'plain') break;
    id = node.segments.find((s) => s !== id)!;
    at = far;
  }
  return out;
}

/** The same walk with a point at least every `step` metres, so a gore's sides come out smooth. */
function densify<T extends { pos: Vec3; right: Vec3 }>(pts: T[], step: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    out.push(a);
    const b = pts[i + 1];
    if (!b) break;
    const d = Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
    const n = Math.floor(d / step);
    for (let k = 1; k < n; k++) {
      const f = k / n;
      const mix = (u: Vec3, v: Vec3): Vec3 => ({ x: u.x + (v.x - u.x) * f, y: u.y + (v.y - u.y) * f, z: u.z + (v.z - u.z) * f });
      out.push({ ...a, pos: mix(a.pos, b.pos), right: mix(a.right, b.right) });
    }
  }
  return out;
}

/**
 * The gore between an edge-merged ramp and its highway past the ramp's cut: between the
 * ramp's inner lane edge and the highway's lane edge, while they are close enough for
 * paint. Empty when the ramp leaves the highway at once.
 */
export function goreBeyondCut(net: RoadNetwork, g: NodeGeom, e: EdgeMergeGeom): Vec3[] {
  const rampArm = g.arms[e.ramp];
  const hostArm = g.arms[e.merge ? e.hostIn : e.hostOut];
  const ramp = densify(chainOutward(net, rampArm.segmentId, g.nodeId, GORE_REACH), 2);
  const host = chainOutward(net, hostArm.segmentId, g.nodeId, GORE_REACH + 80);
  if (ramp.length < 2 || host.length < 2) return [];
  // The host's lane edge on the ramp's side, from its own lanes at each station.
  const hostEdge = host.map((h) => {
    const seg = net.getSegment(h.segId)!;
    const lanes = effectiveLanes(net.roadTypeOf(h.segId), seg.overrides);
    // Travel runs against the way out beside an on-ramp, with it beside an off-ramp.
    const travel = e.merge ? { x: -h.tangent.x, y: 0, z: -h.tangent.z } : h.tangent;
    const rt = { x: -travel.z, y: 0, z: travel.x };
    const kk = h.right.x * rt.x + h.right.z * rt.z >= 0 ? 1 : -1;
    const off = carriagewayEdgeOf(lanes, kk as 1 | -1, e.side) * kk;
    return { p: { x: h.pos.x + h.right.x * off, y: h.pos.y, z: h.pos.z + h.right.z * off }, rt };
  });
  const rampLanes = effectiveLanes(net.roadTypeOf(rampArm.segmentId), net.getSegment(rampArm.segmentId)!.overrides);
  const innerOff = carriagewayEdgeOf(rampLanes, 1, e.side === 1 ? -1 : 1);
  const P: Vec3[] = [];
  const Q: Vec3[] = [];
  let j = 0;
  for (const r of ramp) {
    const p = { x: r.pos.x + r.right.x * innerOff, y: r.pos.y, z: r.pos.z + r.right.z * innerOff };
    while (j + 1 < hostEdge.length && Math.hypot(hostEdge[j + 1].p.x - p.x, hostEdge[j + 1].p.z - p.z) <= Math.hypot(hostEdge[j].p.x - p.x, hostEdge[j].p.z - p.z)) j++;
    const h = hostEdge[j];
    // Foot of the perpendicular on the host edge, and the gap outward from it.
    const t = { x: -h.rt.z, z: h.rt.x };
    const along = (p.x - h.p.x) * t.x + (p.z - h.p.z) * t.z;
    const q = { x: h.p.x + t.x * along, y: h.p.y, z: h.p.z + t.z * along };
    const gap = ((p.x - q.x) * h.rt.x + (p.z - q.z) * h.rt.z) * e.side;
    if (gap > GORE_WIDTH || Math.abs(p.y - q.y) > 2) break;
    if (gap < 0.15) {
      if (P.length) break;
      continue;
    }
    P.push(p);
    Q.push(q);
  }
  if (P.length < 2) return [];
  return [...P, ...Q.reverse()];
}

/**
 * For a highway segment beside an edge merge's taper, a clip that leaves its edge
 * line and outline off along the taper on the ramp's side, where the merge paints its
 * own. Takes and returns the visible span of a line at a lateral offset, as
 * render/gore.ts overlapClip does. Null when the segment is beside no taper.
 */
export function edgeMergeClip(net: RoadNetwork, segId: Id): ((offset: number, s0: number, s1: number) => [number, number]) | null {
  const seg = net.getSegment(segId);
  if (!seg) return null;
  const cuts: { atStart: boolean; from: number; reach: number; side: number }[] = [];
  for (const [nodeId, atStart] of [
    [seg.a, true],
    [seg.b, false],
  ] as const) {
    const g = net.nodeGeom(nodeId);
    const e = g?.edge;
    if (!g || !e) continue;
    const arm = g.arms[e.merge ? e.hostIn : e.hostOut];
    if (arm.segmentId !== segId || arm.atStart !== atStart) continue;
    // The ramp's side in this segment's own right-hand frame.
    // Does this segment run a to b with the traffic the ramp meets?
    const T = { x: g.arms[e.hostOut].dir.x - g.arms[e.hostIn].dir.x, y: 0, z: g.arms[e.hostOut].dir.z - g.arms[e.hostIn].dir.z };
    const f = atStart ? arm.dir : { x: -arm.dir.x, y: 0, z: -arm.dir.z };
    const sideHere = e.side * (f.x * T.x + f.z * T.z >= 0 ? 1 : -1);
    const lanes = effectiveLanes(net.roadTypeOf(segId), seg.overrides);
    const edge = carriagewayEdgeOf(lanes, 1, sideHere > 0 ? 1 : -1);
    // Lines within half a metre inside the edge, and everything beyond it.
    cuts.push({ atStart, from: Math.abs(edge) - 0.5, reach: e.taper, side: sideHere });
  }
  if (!cuts.length) return null;
  return (offset, s0, s1) => {
    let a = s0;
    let b = s1;
    for (const c of cuts) {
      if (offset * c.side < c.from) continue;
      if (c.atStart) a = Math.max(a, Math.min(s1, s0 + c.reach));
      else b = Math.min(b, Math.max(s0, s1 - c.reach));
    }
    return [a, Math.max(a, b)];
  };
}
