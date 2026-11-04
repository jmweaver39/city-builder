/**
 * Edge merges and diverges: a ramp that joins or leaves a highway the way real ones
 * do, blending into the outermost lane instead of turning the whole carriageway into
 * a junction.
 *
 * A ramp end with `RampAttach.edge` still meets the highway at a node, which splits
 * it for the lane graph, but the node lays out as kind 'merge':
 *
 * - The two highway arms behave as a plain joint: no trim, a shared cross section,
 *   lane lines and edge lines running straight on. Their lanes link directly,
 *   lane for lane, with no connectors.
 * - The ramp is trimmed back by the taper length. A connector runs from each ramp
 *   lane along the outside of the highway into the edge lane (an on-ramp), or out
 *   of the edge lane to the ramp (an off-ramp). Only that taper beside the highway's
 *   edge is junction surface, with a painted gore between ramp and highway.
 * - A lane add or drop: past the node the highway has one lane more (an on-ramp
 *   carrying on as an added lane) or one fewer (an exit-only off-ramp). The arm with
 *   the different lane count is moved sideways at the node (`SegmentOverrides.shiftA`
 *   or `shiftB`) so its other lanes stay in line, and the ramp links with the lane
 *   that has no partner.
 *
 * Anything that does not fit (a steep angle, the wrong side of a two-way highway,
 * lanes that do not line up, inner lanes picked to feed the ramp) lays out as the
 * full junction it always was. `edgeMergeProblem` says why, for the editor.
 */
import type { EdgeMergeGeom, EdgeMergeSpec, LaneDef, NodeArm, RampAttach, RoadTypeDef, SegmentGeom, Station, TurnKind, Vec3 } from './types';
import type { ArmLayout } from './junction';
import type { ArmLanes, LaneEnd, LaneLinkSpec } from './connectors';
import { canLink } from './connectors';
import { addScaled, clamp, distXZ, dotXZ, normalizeXZ, rightOf, scale, signedTurn, sub } from './math';
import { isOneWay, totalHalfWidth } from './roadTypes';

/** Sharpest a ramp may meet its highway and still blend in at the edge, radians. */
export const MAX_EDGE_ANGLE = (25 * Math.PI) / 180;
/** Shortest and longest taper, metres. */
export const MIN_TAPER = 25;
export const MAX_TAPER = 150;
/** Host arms must carry on within this of straight through, as at a plain joint. */
const JOINT_ANGLE = (3 * Math.PI) / 180;
/** Lane ends closer than this across the joint are the same lane. */
const SAME_LANE = 0.5;
/** How far along the taper the painted gore reaches, as a share of it. */
const GORE_SHARE = 0.45;

/** How an edge merge node is laid out. Arm indices are into the sorted layout arms. */
export interface EdgeMergePlan {
  ramp: number;
  hostIn: number;
  hostOut: number;
  /** Side of the host the ramp is on, right of the host's travel being 1. */
  side: 1 | -1;
  /** On-ramp (merge) rather than off-ramp (diverge). */
  merge: boolean;
  /** Trim of the ramp end: the taper length. */
  taper: number;
  mode: NonNullable<EdgeMergeSpec['mode']>;
}

/** Default taper for a highway speed, metres: long enough to blend at that speed. */
export function defaultTaper(speedKmh: number): number {
  return clamp(speedKmh * 0.75, 40, 110);
}

interface ArmInput {
  dir: Vec3;
  atStart: boolean;
  def: RoadTypeDef;
  attach?: RampAttach;
  shift?: number;
  stations: readonly Station[];
  length: number;
}

function inputOf(arm: ArmLayout): ArmInput {
  const s = arm.source;
  return { dir: arm.dir, atStart: s.atStart, def: s.def, attach: s.attach, shift: s.shift, stations: s.curve.stations, length: s.curve.length };
}

/** Direction of travel of a one-way road's end at the node. `dir` points away from the node. */
const travelOf = (a: { dir: Vec3; atStart: boolean }): Vec3 => (a.atStart ? a.dir : scale(a.dir, -1));

/** Lanes of a host arm across the joint, in the frame right of `T`, with whether each runs with T. */
function lanesAcross(a: ArmInput, T: Vec3): { lat: number; withT: boolean; lane: LaneDef }[] {
  // The segment's a-to-b direction at the node, and whether that agrees with T.
  const forward = a.atStart ? a.dir : scale(a.dir, -1);
  const k = dotXZ(forward, T) >= 0 ? 1 : -1;
  const shift = a.shift ?? 0;
  return a.def.lanes
    .filter((l) => l.kind === 'drive' || l.kind === 'bus')
    .map((lane) => ({ lat: (lane.offset + shift) * k, withT: lane.dir * k > 0, lane }));
}

/**
 * Why three arms cannot lay out as an edge merge, or the plan when they can. Null
 * when no arm asks for one.
 */
export function planEdgeMerge(arms: readonly ArmLayout[]): EdgeMergePlan | { problem: string } | null {
  if (arms.length !== 3) return null;
  const inputs = arms.map(inputOf);
  const r = inputs.findIndex((a) => a.attach?.edge && !a.attach.lanes);
  if (r < 0) return null;
  const ramp = inputs[r];
  const attach = ramp.attach!;
  const hosts = [0, 1, 2].filter((i) => i !== r);
  if (inputs.some((a, i) => i !== r && a.attach)) return { problem: 'Another road is attached here too.' };
  if (hosts.some((i) => inputs[i].def.category !== 'highway')) return { problem: 'Edge merges join highways only.' };
  if (!isOneWay(ramp.def)) return { problem: 'Only a one-way road can blend into a highway lane.' };
  if (Math.round(attach.lane) > 0) return { problem: 'Inner lanes picked to feed the ramp: full junction.' };
  const merge = !ramp.atStart;
  const rampTravel = travelOf(ramp);
  const [h0, h1] = hosts;
  const d0 = dotXZ(inputs[h0].dir, rampTravel);
  const d1 = dotXZ(inputs[h1].dir, rampTravel);
  const hostOut = d0 >= d1 ? h0 : h1;
  const hostIn = hostOut === h0 ? h1 : h0;
  const hin = inputs[hostIn];
  const hout = inputs[hostOut];
  if (!(dotXZ(hout.dir, rampTravel) > 0 && dotXZ(hin.dir, rampTravel) < 0)) return { problem: 'The highway does not run past the ramp here.' };
  if (Math.abs(signedTurn(hout.dir, scale(hin.dir, -1))) > JOINT_ANGLE) return { problem: 'The highway bends at this point: full junction.' };
  const T = normalizeXZ(sub(hout.dir, hin.dir), rampTravel);
  if (Math.abs(signedTurn(T, rampTravel)) > MAX_EDGE_ANGLE) return { problem: 'Too steep to blend in at the edge: full junction.' };
  // The ramp's side, from its attach: the host on its left puts it on the host's right.
  const side: 1 | -1 = attach.hostSide === -1 ? 1 : -1;
  const lanesIn = lanesAcross(hin, T);
  const lanesOut = lanesAcross(hout, T);
  // The carriageway the ramp meets must run with it.
  const nearIn = lanesIn.filter((l) => l.withT);
  const nearOut = lanesOut.filter((l) => l.withT);
  if (!nearIn.length || !nearOut.length) return { problem: 'Joins against the highway traffic.' };
  const sideOf = (list: { lat: number; withT: boolean }[]) => list.every((l) => !l.withT || list.every((o) => o.withT || (o.lat - l.lat) * side < 0));
  if (!sideOf(lanesIn) || !sideOf(lanesOut)) return { problem: 'Joins the median side of a two-way highway.' };
  // Lanes must line up across the joint, apart from one added or dropped at the edge.
  const unmatched = (a: typeof lanesIn, b: typeof lanesIn) => a.filter((l) => !b.some((o) => o.withT === l.withT && Math.abs(o.lat - l.lat) < SAME_LANE));
  const extraIn = unmatched(lanesIn, lanesOut);
  const extraOut = unmatched(lanesOut, lanesIn);
  const outermost = (list: typeof lanesIn, l: (typeof lanesIn)[number]) => l.withT && list.filter((o) => o.withT).every((o) => o.lat * side <= l.lat * side + 1e-6);
  let mode: EdgeMergePlan['mode'] = 'taper';
  if (extraIn.length || extraOut.length) {
    const drop = merge === false && extraIn.length === 1 && !extraOut.length && outermost(lanesIn, extraIn[0]);
    const add = merge && extraOut.length === 1 && !extraIn.length && outermost(lanesOut, extraOut[0]);
    if (!drop && !add) return { problem: 'The highway lanes do not line up here: full junction.' };
    mode = drop ? 'drop' : 'add';
  }
  const along = merge ? hin : hout;
  const nose = noseDistance(ramp, along);
  const spec = attach.edge!;
  const wanted = spec.taper ?? (mode === 'taper' ? Math.max(nose, defaultTaper(Math.min(hin.def.speedKmh, hout.def.speedKmh))) : Math.max(nose, MIN_TAPER));
  const taper = clamp(wanted, MIN_TAPER, Math.min(MAX_TAPER, ramp.length * 0.8));
  return { ramp: r, hostIn, hostOut, side, merge, taper, mode };
}

/** The plan alone, when the arms make an edge merge. */
export function edgeMergePlan(arms: readonly ArmLayout[]): EdgeMergePlan | null {
  const p = planEdgeMerge(arms);
  return p && !('problem' in p) ? p : null;
}

/** Stations of an arm outward from the node, with distance from it. */
function outward(a: { stations: readonly Station[]; atStart: boolean; length: number }, limit: number): { st: Station; s: number }[] {
  const out: { st: Station; s: number }[] = [];
  const st = a.stations;
  if (a.atStart) {
    for (let i = 0; i < st.length && st[i].s <= limit; i++) out.push({ st: st[i], s: st[i].s });
  } else {
    for (let i = st.length - 1; i >= 0 && a.length - st[i].s <= limit; i--) out.push({ st: st[i], s: a.length - st[i].s });
  }
  return out;
}

/**
 * How far out along the ramp its road edge clears the host's: the nose of the gore.
 * Up to that the two surfaces overlap and there is nothing between them to see.
 */
function noseDistance(ramp: ArmInput, host: ArmInput): number {
  const reach = MAX_TAPER + 20;
  const r = outward(ramp, reach);
  const h = outward(host, reach + 60);
  if (!r.length || !h.length) return MIN_TAPER;
  const clear = totalHalfWidth(ramp.def) + totalHalfWidth(host.def);
  let j = 0;
  for (const { st, s } of r) {
    // The host station nearest this ramp station; both run outward, so the search only moves on.
    while (j + 1 < h.length && distXZ(h[j + 1].st.pos, st.pos) <= distXZ(h[j].st.pos, st.pos)) j++;
    const hs = h[j].st;
    const lateral = Math.abs(dotXZ(sub(st.pos, hs.pos), hs.right));
    if (lateral >= clear) return s;
  }
  return reach;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Lateral offset of a carriageway edge right of travel `aligned` (1 = a to b), as ramps.ts measures it. */
function carriagewayEdgeOf(lanes: readonly LaneDef[], aligned: 1 | -1, side: 1 | -1): number {
  let edge = side > 0 ? -Infinity : Infinity;
  for (const l of lanes) {
    if (l.kind === 'rail') continue;
    const o = l.offset * aligned;
    edge = side > 0 ? Math.max(edge, o + l.width / 2) : Math.min(edge, o - l.width / 2);
  }
  return Number.isFinite(edge) ? edge : 0;
}

/** Cubic Hermite from p (heading dp) to q (heading dq), sampled with n + 1 points. */
function hermite(p: Vec3, dp: Vec3, q: Vec3, dq: Vec3, n: number): Vec3[] {
  const h = distXZ(p, q) / 3;
  const c1 = addScaled(p, normalizeXZ(dp), h);
  const c2 = addScaled(q, normalizeXZ(dq), -h);
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const m = 1 - t;
    const w0 = m * m * m;
    const w1 = 3 * m * m * t;
    const w2 = 3 * m * t * t;
    const w3 = t * t * t;
    out.push({
      x: w0 * p.x + w1 * c1.x + w2 * c2.x + w3 * q.x,
      y: p.y + (q.y - p.y) * (3 * t * t - 2 * t * t * t),
      z: w0 * p.z + w1 * c1.z + w2 * c2.z + w3 * q.z,
    });
  }
  return out;
}

/** Twice the signed plan area; positive is clockwise viewed from above, as junction outlines wind. */
function signedArea(poly: readonly Vec3[]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area;
}

function dedupe(pts: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const p of pts) if (!out.length || distXZ(out[out.length - 1], p) > 0.02) out.push(p);
  if (out.length > 1 && distXZ(out[0], out[out.length - 1]) <= 0.02) out.pop();
  return out;
}

/** The far station of a segment's geometry at its node end. */
function endStation(geom: SegmentGeom | undefined, atStart: boolean): Station | null {
  const st = geom?.stations;
  if (!st?.length) return null;
  return atStart ? st[0] : st[st.length - 1];
}

/**
 * Outline and paint geometry of an edge merge, once trims are final. Null when the
 * geometry is missing, which leaves the node without a surface.
 */
export function edgeMergeGeom(
  arms: readonly ArmLayout[],
  plan: EdgeMergePlan,
  nodeArms: readonly NodeArm[],
  geomOf: (id: number) => SegmentGeom | undefined,
): { outline: Vec3[]; geom: EdgeMergeGeom } | null {
  const rampArm = arms[plan.ramp];
  const rampDef = rampArm.source.def;
  const rampGeom = geomOf(rampArm.segmentId);
  const cut = endStation(rampGeom, rampArm.atStart);
  if (!cut) return null;
  const along = arms[plan.merge ? plan.hostIn : plan.hostOut];
  const alongGeom = geomOf(along.segmentId);
  if (!alongGeom || alongGeom.stations.length < 2) return null;
  const T = normalizeXZ(sub(nodeArms[plan.hostOut].dir, nodeArms[plan.hostIn].dir));
  const R = rightOf(T);
  const side = plan.side;

  // The ramp at its cut: a one-way road's stations face its travel.
  const rampTravel = cut.tangent;
  const rr = cut.right;
  const h = rampDef.halfWidth;
  const outerAtCut = addScaled(cut.pos, rr, side * h);
  const innerAtCut = addScaled(cut.pos, rr, -side * h);
  const innerLaneAtCut = addScaled(cut.pos, rr, carriagewayEdgeOf(rampDef.lanes, 1, side === 1 ? -1 : 1));
  const outerLaneAtCut = addScaled(cut.pos, rr, carriagewayEdgeOf(rampDef.lanes, 1, side));

  // The host beside the taper, outward from the node to abreast of the ramp's cut.
  const forward = along.atStart ? along.dir : scale(along.dir, -1);
  const k: 1 | -1 = dotXZ(forward, T) >= 0 ? 1 : -1;
  const hostDef = along.source.def;
  const roadOff = side * hostDef.halfWidth;
  const laneOff = carriagewayEdgeOf(hostDef.lanes, k, side);
  const stations = outward({ stations: alongGeom.stations, atStart: along.atStart, length: alongGeom.fullLength }, Infinity);
  // Stations of the geometry carry s along the whole curve; distance from the node is what counts.
  const base = stations[0];
  const rel = stations.map(({ st }) => ({ st, s: Math.abs(st.s - base.st.s) }));
  let abreast = rel.length - 1;
  let best = Infinity;
  rel.forEach(({ st }, i) => {
    const d = distXZ(st.pos, cut.pos);
    if (d < best) {
      best = d;
      abreast = i;
    }
  });
  abreast = Math.max(1, abreast);
  const edgeAt = (st: Station, off: number) => addScaled(st.pos, st.right, k * off);
  const outwardRoad = rel.slice(0, abreast + 1).map(({ st }) => edgeAt(st, roadOff));
  const outwardLane = rel.slice(0, abreast + 1).map(({ st }) => edgeAt(st, laneOff));
  // Travel order: an on-ramp runs alongside the host before the node, an off-ramp after it.
  const hostRoad = plan.merge ? outwardRoad.slice().reverse() : outwardRoad;
  const hostLane = plan.merge ? outwardLane.slice().reverse() : outwardLane;

  // The wider host arm's road edge at the node, where the taper ends.
  const edgeAtNode = (i: number, lanes: boolean): Vec3 | null => {
    const arm = arms[i];
    const st = endStation(geomOf(arm.segmentId), arm.atStart);
    if (!st) return null;
    const f = arm.atStart ? arm.dir : scale(arm.dir, -1);
    const kk: 1 | -1 = dotXZ(f, T) >= 0 ? 1 : -1;
    const off = lanes ? carriagewayEdgeOf(arm.source.def.lanes, kk, side) : side * arm.source.def.halfWidth;
    return addScaled(st.pos, st.right, kk * off);
  };
  const eIn = edgeAtNode(plan.hostIn, false);
  const eOut = edgeAtNode(plan.hostOut, false);
  const lIn = edgeAtNode(plan.hostIn, true);
  const lOut = edgeAtNode(plan.hostOut, true);
  if (!eIn || !eOut || !lIn || !lOut) return null;
  const node = plan.merge ? hostRoad[hostRoad.length - 1] : hostRoad[0];
  const lat = (p: Vec3) => dotXZ(sub(p, node), R) * side;
  const wide = lat(eIn) > lat(eOut) ? eIn : eOut;
  const wideLane = lat(lIn) > lat(lOut) ? lIn : lOut;

  const taperOuter = plan.merge ? hermite(outerAtCut, rampTravel, wide, T, 16) : hermite(wide, T, outerAtCut, rampTravel, 16);
  const taperLine = plan.merge ? hermite(outerLaneAtCut, rampTravel, wideLane, T, 24) : hermite(wideLane, T, outerLaneAtCut, rampTravel, 24);

  // Gore: between the ramp's inner lane edge and the host's lane edge, from the cut to
  // where the ramp's lanes reach the highway's. A lane that carries straight on meets at the node.
  const share = plan.mode === 'taper' ? GORE_SHARE : 1;
  let gore: Vec3[] = [];
  const outwardLaneTip = Math.max(1, Math.round(abreast * (1 - share)));
  const laneFromTip = outwardLane.slice(outwardLaneTip, abreast + 1);
  const tip = outwardLane[outwardLaneTip];
  const gap = dotXZ(sub(innerLaneAtCut, edgeAt(rel[abreast].st, laneOff)), R) * side;
  if (gap > 0.4 && laneFromTip.length >= 2) {
    const nose = plan.merge ? hermite(innerLaneAtCut, rampTravel, tip, T, 10) : hermite(tip, T, innerLaneAtCut, rampTravel, 10);
    // Round the outline: the ramp-side curve, then back along the host edge.
    gore = plan.merge ? [...nose, ...laneFromTip.slice(0, -1)] : [...nose.slice().reverse(), ...laneFromTip.slice(0, -1)];
    gore = dedupe(gore);
    if (gore.length < 3) gore = [];
  }

  let outline = plan.merge
    ? dedupe([innerAtCut, ...hostRoad, ...taperOuter.slice().reverse()])
    : dedupe([...hostRoad, innerAtCut, ...taperOuter.slice().reverse()]);
  if (outline.length < 3) return null;
  if (signedArea(outline) < 0) outline = outline.reverse();
  const taper = plan.taper;
  return {
    outline,
    geom: { ramp: plan.ramp, hostIn: plan.hostIn, hostOut: plan.hostOut, side, merge: plan.merge, taperOuter, taperLine, hostEdge: hostLane, gore, taper, mode: plan.mode },
  };
}

// ---------------------------------------------------------------------------
// Lane links
// ---------------------------------------------------------------------------

/** Pair two ordered lists without crossing, every lane on both sides linked. */
function pairOrdered(out: LaneLinkSpec[], I: readonly LaneEnd[], O: readonly LaneEnd[], turn: TurnKind): void {
  if (!I.length || !O.length) return;
  const seen = new Set<string>();
  const add = (a: LaneEnd, b: LaneEnd) => {
    const key = `${a.segmentId}.${a.laneIndex}>${b.segmentId}.${b.laneIndex}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ from: a, to: b, turn });
  };
  for (let t = 0; t < I.length; t++) add(I[t], O[Math.floor(((t + 0.5) * O.length) / I.length)]);
  for (let b = 0; b < O.length; b++) add(I[Math.floor(((b + 0.5) * I.length) / O.length)], O[b]);
}

/** True when two lane ends are the same place across an untrimmed joint. */
export function sameLaneEnd(a: LaneEnd, b: LaneEnd): boolean {
  return distXZ(a.pos, b.pos) < SAME_LANE && Math.abs(a.pos.y - b.pos.y) < 0.5;
}

/**
 * Lane links at an edge merge: host lanes that line up join directly, as at a plain
 * joint, and the ramp links with the edge lane (or with the lane added or dropped).
 * `direct` are road-to-road joins, `links` need connectors.
 */
export function edgeMergeLinks(arms: readonly ArmLanes[], plan: EdgeMergePlan, hand: LaneLinkSpec[] | null): { direct: LaneLinkSpec[]; links: LaneLinkSpec[] } {
  const road = (l: LaneEnd) => l.kind !== 'bike' && l.kind !== 'rail';
  if (hand) {
    // Hand-set links: those along the highway join directly, the rest get connectors.
    const direct: LaneLinkSpec[] = [];
    const links: LaneLinkSpec[] = [];
    for (const l of hand) (sameLaneEnd(l.from, l.to) ? direct : links).push(l);
    return { direct, links };
  }
  const direct: LaneLinkSpec[] = [];
  const fedOut = new Set<LaneEnd>();
  const goesOn = new Set<LaneEnd>();
  for (const [x, y] of [
    [plan.hostIn, plan.hostOut],
    [plan.hostOut, plan.hostIn],
  ] as const) {
    for (const l of arms[x].incoming) {
      const o = arms[y].outgoing.find((c) => !fedOut.has(c) && canLink(l.kind, c.kind) && sameLaneEnd(l, c));
      if (!o) continue;
      direct.push({ from: l, to: o, turn: 'straight' });
      fedOut.add(o);
      goesOn.add(l);
    }
  }
  const turn: TurnKind = plan.side > 0 ? 'right' : 'left';
  const links: LaneLinkSpec[] = [];
  // Outermost on the ramp's side last, lanes sorted left to right as the driver sees them.
  const outer = (list: LaneEnd[]) => list.reduce<LaneEnd | null>((b, l) => (!b || l.lat * plan.side > b.lat * plan.side ? l : b), null);
  if (plan.merge) {
    const host = arms[plan.hostOut].outgoing.filter(road);
    const added = host.filter((l) => !fedOut.has(l));
    const edge = outer(host);
    const targets = added.length ? added : edge ? [edge] : [];
    pairOrdered(links, arms[plan.ramp].incoming.filter(road), targets, turn);
  } else {
    const host = arms[plan.hostIn].incoming.filter(road);
    const dropped = host.filter((l) => !goesOn.has(l));
    const edge = outer(host);
    const sources = dropped.length ? dropped : edge ? [edge] : [];
    pairOrdered(links, sources, arms[plan.ramp].outgoing.filter(road), turn);
  }
  return { direct, links };
}

// ---------------------------------------------------------------------------
// Placing the ramp end
// ---------------------------------------------------------------------------

/**
 * Lateral offset, right of the ramp's travel at the node, of an edge-merged ramp's
 * centreline: its inner carriageway edge on the host's carriageway edge, so its
 * lanes run alongside the highway's. `hostEdge` is that edge, signed the same way.
 */
export function edgeRampOffset(hostEdge: number, rampLanes: readonly LaneDef[], side: 1 | -1): number {
  return hostEdge - carriagewayEdgeOf(rampLanes, 1, side === 1 ? -1 : 1);
}

export { carriagewayEdgeOf };
