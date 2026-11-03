/**
 * Simple configurable roundabouts: a one-way ring of `roundabout-N` road, with a
 * node where each arm meets it. Nothing extra is saved: a roundabout is found from
 * its ring road type, and its centre, radius, lanes, speed and priority are read
 * back from the ring, so undo, save and load need nothing new.
 *
 * Traffic circulates anticlockwise seen from above (right-hand traffic). Entries
 * yield to the ring (signals.ts gives ring arms priority). With more than one ring
 * lane, lane use follows a spiral: the outer lane leaves at the next exit, inner
 * lanes carry on and spiral outward to leave later, so nobody weaves on the ring.
 * An arm's right lane feeds the outer lane and its left lane the inner ones.
 */
import type { Cubic } from './bezier';
import { cubicPoint, cubicTangentXZ } from './bezier';
import type { ArmLanes, LaneEnd, LaneLinkSpec } from './connectors';
import { clamp, distXZ, wrapPositive } from './math';
import type { RoadNetwork } from './RoadNetwork';
import { defaultSignalPlan } from './signals';
import { MAP_HALF_SIZE, terrainHeight } from './terrain';
import { builtinRoadType, totalHalfWidth } from './roadTypes';
import type { Id, RoadTypeDef, SignalPlan, Vec3 } from './types';

export type RoundaboutPriority = 'yield' | 'signal';

export interface RoundaboutParams {
  /** Ring centreline radius in metres. */
  radius: number;
  lanes: 1 | 2 | 3;
  speedKmh: number;
  priority: RoundaboutPriority;
}

export const RADIUS_MIN = 15;
export const RADIUS_MAX = 120;
export const RING_SPEED_MIN = 20;
export const RING_SPEED_MAX = 60;
export const DEFAULT_ROUNDABOUT: RoundaboutParams = { radius: 28, lanes: 1, speedKmh: 30, priority: 'yield' };

export const ringTypeId = (lanes: number): string => `roundabout-${clamp(Math.round(lanes), 1, 3)}`;
export const isRingType = (def: RoadTypeDef): boolean => def.category === 'roundabout';

/** Longest arc one ring segment may sweep. Wider sweeps get a joint in between. */
const MAX_SWEEP = Math.PI / 2 + 0.02;
/** Shortest piece of an arm left between the ring and the road's far end. */
const MIN_ARM = 14;
/** An arm meeting the ring further than this from square is refused. */
const MAX_ENTRY_ANGLE = (62 * Math.PI) / 180;
/** Height gap within which a road counts as at grade with the ring. */
const AT_GRADE = 1.5;
/** Height gap that clears the ring as a bridge or tunnel. */
const CLEARS = 7;
/** Smallest central island, metres of radius. */
const MIN_ISLAND = 3.5;

export interface RoundaboutArm {
  segmentId: Id;
  nodeId: Id;
  /** True when the arm leaves the ring node at its a end. */
  atStart: boolean;
}

export interface Roundabout {
  centre: Vec3;
  radius: number;
  lanes: 1 | 2 | 3;
  speedKmh: number;
  priority: RoundaboutPriority;
  /** Ring segments in travel order. */
  segments: Id[];
  /** nodes[i] is where segments[i] starts. */
  nodes: Id[];
  arms: RoundaboutArm[];
}

// ---------------------------------------------------------------------------
// Finding roundabouts
// ---------------------------------------------------------------------------

/** Least squares circle through points in plan (Kasa fit). */
function fitCircle(pts: Vec3[]): { x: number; z: number; r: number } {
  const n = pts.length;
  let mx = 0;
  let mz = 0;
  for (const p of pts) {
    mx += p.x / n;
    mz += p.z / n;
  }
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx;
    const v = p.z - mz;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const a = suu, b = suv, c = suv, d = svv;
  const e = (suuu + suvv) / 2;
  const f = (svvv + svuu) / 2;
  const det = a * d - b * c;
  let uc = 0;
  let vc = 0;
  if (Math.abs(det) > 1e-9) {
    uc = (e * d - b * f) / det;
    vc = (a * f - e * c) / det;
  }
  const x = mx + uc;
  const z = mz + vc;
  let r = 0;
  for (const p of pts) r += Math.hypot(p.x - x, p.z - z) / n;
  return { x, z, r };
}

const cache = new WeakMap<RoadNetwork, { version: number; list: Roundabout[] }>();

/** Every closed ring in the network. */
export function findRoundabouts(net: RoadNetwork): Roundabout[] {
  const hit = cache.get(net);
  if (hit && hit.version === net.version) return hit.list;
  const list: Roundabout[] = [];
  const seen = new Set<Id>();
  for (const seg of net.segments) {
    if (seen.has(seg.id) || !isRingType(net.roadTypeOf(seg.id))) continue;
    const segments: Id[] = [];
    const nodes: Id[] = [];
    let cur = seg;
    let closed = false;
    for (let guard = 0; guard < 400; guard++) {
      seen.add(cur.id);
      segments.push(cur.id);
      nodes.push(cur.a);
      const at = net.getNode(cur.b)!;
      const next = at.segments
        .map((id) => net.getSegment(id)!)
        .find((s) => s.id !== cur.id && s.a === at.id && isRingType(net.roadTypeOf(s.id)));
      if (!next) break;
      if (next.id === seg.id) {
        closed = true;
        break;
      }
      if (seen.has(next.id)) break;
      cur = next;
    }
    if (!closed || segments.length < 2) continue;
    const pts: Vec3[] = [];
    for (const id of segments) {
      const c = net.cubicOf(id);
      pts.push(c.p0, cubicPoint(c, 0.5));
    }
    const fit = fitCircle(pts);
    const y = nodes.reduce((s, id) => s + net.getNode(id)!.pos.y, 0) / nodes.length;
    const def = net.roadTypeOf(segments[0]);
    const lanes = clamp(def.lanes.filter((l) => l.kind !== 'bike').length, 1, 3) as 1 | 2 | 3;
    const arms: RoundaboutArm[] = [];
    let signal = false;
    const ringSet = new Set(segments);
    for (const nodeId of nodes) {
      const node = net.getNode(nodeId)!;
      if (node.control.mode === 'signal') signal = true;
      for (const id of node.segments) {
        if (ringSet.has(id)) continue;
        arms.push({ segmentId: id, nodeId, atStart: net.getSegment(id)!.a === nodeId });
      }
    }
    list.push({
      centre: { x: fit.x, y, z: fit.z },
      radius: fit.r,
      lanes,
      speedKmh: net.getSegment(segments[0])!.overrides.speedKmh ?? def.speedKmh,
      priority: signal ? 'signal' : 'yield',
      segments,
      nodes,
      arms,
    });
  }
  cache.set(net, { version: net.version, list });
  return list;
}

export function roundaboutOfSegment(net: RoadNetwork, segmentId: Id): Roundabout | null {
  return findRoundabouts(net).find((r) => r.segments.includes(segmentId)) ?? null;
}

/** The roundabout whose ring or island covers this plan position. */
export function roundaboutAt(net: RoadNetwork, pos: Vec3, slack = 0): Roundabout | null {
  let best: Roundabout | null = null;
  let bestD = Infinity;
  for (const r of findRoundabouts(net)) {
    if (Math.abs(r.centre.y - pos.y) > 3) continue;
    const reach = r.radius + totalHalfWidth(net.roadTypeOf(r.segments[0])) + slack;
    const d = distXZ(r.centre, pos);
    if (d <= reach && d < bestD) {
      best = r;
      bestD = d;
    }
  }
  return best;
}

/** True when a node is on a roundabout ring. */
export function isRingNode(net: RoadNetwork, nodeId: Id): boolean {
  return (net.getNode(nodeId)?.segments ?? []).some((id) => isRingType(net.roadTypeOf(id)));
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const at = (c: Vec3, r: number, phi: number): Vec3 => ({ x: c.x + r * Math.cos(phi), y: c.y, z: c.z + r * Math.sin(phi) });

/**
 * An anticlockwise arc seen from above, from angle `from` sweeping `sweep` (> 0).
 * Heading angles grow clockwise from above, so anticlockwise means falling angles.
 */
export function arcCubic(c: Vec3, r: number, from: number, sweep: number): Cubic {
  const to = from - sweep;
  const k = (4 / 3) * Math.tan(sweep / 4) * r;
  const p0 = at(c, r, from);
  const p3 = at(c, r, to);
  // Travel direction at angle phi going anticlockwise: (sin phi, -cos phi).
  return {
    p0,
    p1: { x: p0.x + Math.sin(from) * k, y: c.y, z: p0.z - Math.cos(from) * k },
    p2: { x: p3.x - Math.sin(to) * k, y: c.y, z: p3.z + Math.cos(to) * k },
    p3,
  };
}

/** Ring arcs through the given arm angles, split so none sweeps more than MAX_SWEEP. */
export function ringArcs(c: Vec3, r: number, phis: number[]): { from: number; sweep: number; arm: boolean }[] {
  const sorted = [...phis].sort((a, b) => b - a);
  const starts = sorted.length ? sorted : [0, -Math.PI / 2, -Math.PI, Math.PI / 2];
  const arcs: { from: number; sweep: number; arm: boolean }[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const next = starts[(i + 1) % starts.length];
    let sweep = starts.length === 1 ? Math.PI * 2 : wrapPositive(from - next);
    if (sweep < 1e-6) sweep = Math.PI * 2;
    const pieces = Math.ceil(sweep / MAX_SWEEP);
    for (let k = 0; k < pieces; k++) {
      arcs.push({ from: from - (k * sweep) / pieces, sweep: sweep / pieces, arm: k === 0 && sorted.length > 0 });
    }
  }
  return arcs;
}

function ringHalf(lanes: number): number {
  const def = builtinRoadType(ringTypeId(lanes));
  return def ? totalHalfWidth(def) : lanes * 2 + 1;
}

/** Ring length one arm needs, from its centreline to the next arm's. */
function armSpacing(armHalf: number, lanes: number): number {
  // Calibrated against built geometry: this leaves each ring piece a few metres
  // visible after the junction trims at both ends.
  return armHalf + 1.5 + ringHalf(lanes) * 0.45;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface ArmCut {
  segmentId: Id;
  /** Curve parameter of the cut. */
  t: number;
  /** The end of the segment that stays. */
  keep: 'a' | 'b';
  /** Where it meets the ring. */
  pos: Vec3;
  phi: number;
  halfWidth: number;
}

export interface RoundaboutPlan {
  centre: Vec3;
  params: RoundaboutParams;
  ok: boolean;
  reasons: string[];
  arms: ArmCut[];
  /** Segments wholly inside the circle, removed. */
  remove: Id[];
  /** The ring, for a ghost. */
  ring: Cubic[];
}

interface Sample {
  t: number;
  p: Vec3;
  d: number;
  /** -1 well below, 0 at grade, 1 well above, 2 in the conflict band. */
  level: number;
}

function sampleSegment(net: RoadNetwork, id: Id, centre: Vec3): Sample[] {
  const c = net.cubicOf(id);
  const len = net.segmentGeom(id)?.fullLength ?? distXZ(c.p0, c.p3);
  const n = Math.max(24, Math.min(400, Math.ceil(len / 1.5)));
  const out: Sample[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = cubicPoint(c, t);
    const dy = p.y - centre.y;
    const level = Math.abs(dy) <= AT_GRADE ? 0 : Math.abs(dy) >= CLEARS ? Math.sign(dy) : 2;
    out.push({ t, p, d: distXZ(p, centre), level });
  }
  return out;
}

/** Bisect the parameter where the curve crosses the circle, between t0 (inside) and t1. */
function crossingT(net: RoadNetwork, id: Id, centre: Vec3, r: number, tIn: number, tOut: number): number {
  const c = net.cubicOf(id);
  let a = tIn;
  let b = tOut;
  for (let i = 0; i < 40; i++) {
    const m = (a + b) / 2;
    if (distXZ(cubicPoint(c, m), centre) < r) a = m;
    else b = m;
  }
  return (a + b) / 2;
}

function arcLengthBetween(net: RoadNetwork, id: Id, t0: number, t1: number): number {
  const c = net.cubicOf(id);
  const n = 24;
  let len = 0;
  let prev = cubicPoint(c, t0);
  for (let i = 1; i <= n; i++) {
    const p = cubicPoint(c, t0 + ((t1 - t0) * i) / n);
    len += distXZ(prev, p);
    prev = p;
  }
  return len;
}

/**
 * How a roundabout of these settings would go in centred here: which roads it cuts
 * and joins, and every reason it cannot. Touches nothing.
 */
export function planRoundabout(net: RoadNetwork, centre: Vec3, params: RoundaboutParams, junction: Id | null = null): RoundaboutPlan {
  const R = clamp(params.radius, RADIUS_MIN, RADIUS_MAX);
  const lanes = params.lanes;
  const half = ringHalf(lanes);
  const reasons = new Set<string>();
  const arms: ArmCut[] = [];
  const remove = new Set<Id>();

  if (R - half < MIN_ISLAND) reasons.add(`Radius too small for ${lanes} lanes. Try ${Math.ceil(half + MIN_ISLAND)} m or more.`);
  if (Math.abs(centre.x) + R + half > MAP_HALF_SIZE || Math.abs(centre.z) + R + half > MAP_HALF_SIZE) reasons.add('The roundabout would leave the map.');
  if (Math.abs(centre.y - terrainHeight(centre.x, centre.z)) > 1) reasons.add('Roundabouts are built on the ground.');
  for (let i = 0; i < 16; i++) {
    const p = at(centre, R + half, (i / 16) * Math.PI * 2);
    if (terrainHeight(p.x, p.z) < centre.y - 0.75) {
      reasons.add('Too close to the river.');
      break;
    }
  }

  const reach = R + half + 40;
  const box = { minX: centre.x - reach, minZ: centre.z - reach, maxX: centre.x + reach, maxZ: centre.z + reach };
  for (const id of net.segmentsInRegion(box, true)) {
    const seg = net.getSegment(id)!;
    const def = net.roadTypeOf(id);
    const samples = sampleSegment(net, id, centre);
    const armHalf = totalHalfWidth(def);
    const touches = samples.some((s) => s.d < R + half + armHalf && s.level !== 1 && s.level !== -1);
    if (!touches) continue;
    if (isRingType(def)) {
      reasons.add('Too close to another roundabout.');
      continue;
    }
    if (def.category === 'rail') {
      reasons.add('Track runs through here.');
      continue;
    }
    if (samples.some((s) => s.level === 2 && s.d < R + half + armHalf)) {
      reasons.add('A bridge or tunnel passes too close above or below.');
      continue;
    }
    const inside = samples.map((s) => s.level === 0 && s.d < R);
    if (!inside.some(Boolean)) {
      // Not crossing, but running close beside the ring.
      if (samples.some((s) => s.level === 0 && s.d < R + half + armHalf + 0.5)) reasons.add('A road runs too close beside the ring.');
      continue;
    }
    // Runs of inside samples. An outside run in the middle means the road weaves in and out.
    let changes = 0;
    for (let i = 1; i < inside.length; i++) if (inside[i] !== inside[i - 1]) changes++;
    const startsIn = inside[0];
    const endsIn = inside[inside.length - 1];
    if (changes > 2 || (changes === 2 && (startsIn || endsIn))) {
      reasons.add('A road curves in and out of the circle.');
      continue;
    }
    if (changes === 0) {
      remove.add(id);
      continue;
    }
    const cut = (keep: 'a' | 'b') => {
      // The crossing nearest the kept end.
      let tIn = 0;
      let tOut = 0;
      if (keep === 'a') {
        const k = inside.indexOf(true);
        tIn = samples[k].t;
        tOut = samples[k - 1].t;
      } else {
        const k = inside.lastIndexOf(true);
        tIn = samples[k].t;
        tOut = samples[k + 1].t;
      }
      const t = crossingT(net, id, centre, R, tIn, tOut);
      const keptLen = keep === 'a' ? arcLengthBetween(net, id, 0, t) : arcLengthBetween(net, id, t, 1);
      if (keptLen < MIN_ARM) {
        reasons.add('A road is too short to reach the ring. Try a smaller radius.');
        return;
      }
      const c = net.cubicOf(id);
      const p = cubicPoint(c, t);
      const tan = cubicTangentXZ(c, t);
      const radial = { x: (p.x - centre.x) / R, y: 0, z: (p.z - centre.z) / R };
      const cos = Math.abs(tan.x * radial.x + tan.z * radial.z);
      if (Math.acos(Math.min(1, cos)) > MAX_ENTRY_ANGLE) reasons.add('A road meets the ring at too shallow an angle.');
      const phi = Math.atan2(p.z - centre.z, p.x - centre.x);
      arms.push({ segmentId: id, t, keep, pos: at(centre, R, phi), phi, halfWidth: armHalf });
    };
    if (!startsIn) cut('a');
    if (!endsIn) cut('b');
  }

  // Nodes swallowed by the circle: only bends and stubs may go, besides the junction clicked.
  for (const id of net.nodesInRegion({ minX: centre.x - R, minZ: centre.z - R, maxX: centre.x + R, maxZ: centre.z + R })) {
    const node = net.getNode(id)!;
    if (distXZ(node.pos, centre) >= R || Math.abs(node.pos.y - centre.y) > AT_GRADE) continue;
    if (id !== junction && node.segments.length >= 3) reasons.add('Another junction is inside the circle.');
    if (net.endpoints.some((e) => e.nodeId === id)) reasons.add('A traffic gateway is inside the circle.');
  }

  // Arms must leave room on the ring between them.
  const sorted = [...arms].sort((a, b) => b.phi - a.phi);
  for (let i = 0; i < sorted.length && sorted.length > 1; i++) {
    const a = sorted[i];
    const b = sorted[(i + 1) % sorted.length];
    const gap = wrapPositive(a.phi - b.phi) || Math.PI * 2;
    if (gap * R < armSpacing(a.halfWidth, lanes) + armSpacing(b.halfWidth, lanes)) {
      reasons.add('Arms too close together for this radius. Try a larger radius.');
      break;
    }
  }

  const ring = ringArcs(centre, R, arms.map((a) => a.phi)).map((arc) => arcCubic(centre, R, arc.from, arc.sweep));
  const list = [...reasons];
  return { centre: { ...centre }, params: { ...params, radius: R }, ok: list.length === 0, reasons: list, arms, remove: [...remove], ring };
}

// ---------------------------------------------------------------------------
// Building and editing
// ---------------------------------------------------------------------------

/**
 * A signal plan for a ring node: metered entry. Circulating traffic always has a
 * green, and the entry gets its light for part of the cycle, still giving way to the
 * ring. Stopping the ring at every node lets entries fill it until it locks, so the
 * ring is never held.
 */
export function ringSignalPlan(net: RoadNetwork, nodeId: Id, offsetSec = 0): SignalPlan {
  const plan = defaultSignalPlan(net, nodeId, 'split');
  const ringSegs = new Set((net.getNode(nodeId)?.segments ?? []).filter((id) => isRingType(net.roadTypeOf(id))));
  const ringMoves: Record<string, 'protected'> = {};
  const entryMoves: Record<string, 'permissive'> = {};
  for (const p of plan.phases) {
    for (const key of Object.keys(p.moves)) {
      if (ringSegs.has(Number(key.split('>')[0]))) ringMoves[key] = 'protected';
      else entryMoves[key] = 'permissive';
    }
  }
  const base = { yellowSec: 3, allRedSec: 0, minGreenSec: 6, maxGreenSec: 40 };
  return {
    kind: 'fixed',
    offsetSec,
    phases: [
      { id: 1, name: 'Ring', greenSec: 14, ...base, moves: { ...ringMoves } },
      { id: 2, name: 'Entry', greenSec: 16, ...base, moves: { ...ringMoves, ...entryMoves } },
    ],
  };
}

/** Bend an arm so it meets the ring square, keeping its far end as it was. */
function squareArm(net: RoadNetwork, arm: RoundaboutArm, centre: Vec3): void {
  const seg = net.getSegment(arm.segmentId);
  if (!seg) return;
  const ringNode = net.getNode(arm.nodeId)!.pos;
  const far = net.getNode(arm.atStart ? seg.b : seg.a)!.pos;
  const d = distXZ(ringNode, centre) || 1;
  const out = { x: (ringNode.x - centre.x) / d, y: 0, z: (ringNode.z - centre.z) / d };
  const len = distXZ(ringNode, far);
  const h = clamp(len / 3, 2, 60);
  const near = { x: ringNode.x + out.x * h, y: ringNode.y, z: ringNode.z + out.z * h };
  const farHandle = arm.atStart ? seg.c2 : seg.c1;
  if (arm.atStart) net.setSegmentControls(seg.id, near, farHandle);
  else net.setSegmentControls(seg.id, farHandle, near);
}

function applyControl(net: RoadNetwork, rb: Pick<Roundabout, 'nodes' | 'arms'>, priority: RoundaboutPriority): void {
  const armNodes = [...new Set(rb.arms.map((a) => a.nodeId))];
  armNodes.forEach((id, i) => {
    if (priority === 'signal') {
      net.setJunctionControl(id, { mode: 'signal', signal: ringSignalPlan(net, id, (i * 7) % 30), signs: {} });
    } else {
      net.setJunctionControl(id, { mode: 'auto', signal: null, signs: {} });
    }
  });
}

/** Build a planned roundabout as one batch. Returns the new roundabout. */
export function buildRoundabout(net: RoadNetwork, plan: RoundaboutPlan): Roundabout | null {
  if (!plan.ok) return null;
  const { centre, params } = plan;
  const R = params.radius;
  return net.batch(() => {
    // Cut each road at the circle, from the highest t down so earlier ts stay valid.
    const bySeg = new Map<Id, ArmCut[]>();
    for (const cut of plan.arms) bySeg.set(cut.segmentId, [...(bySeg.get(cut.segmentId) ?? []), cut]);
    const armNodes: { phi: number; arm: RoundaboutArm }[] = [];
    const doomed: Id[] = [...plan.remove];
    for (const [id, cuts] of bySeg) {
      cuts.sort((a, b) => a.t - b.t);
      if (cuts.length === 2) {
        const [first, second] = cuts;
        const s2 = net.splitSegment(id, second.t);
        const s1 = net.splitSegment(id, first.t / second.t);
        armNodes.push({ phi: first.phi, arm: { segmentId: id, nodeId: s1.node, atStart: false } });
        if (s2.right !== null) armNodes.push({ phi: second.phi, arm: { segmentId: s2.right, nodeId: s2.node, atStart: true } });
        if (s1.right !== null) doomed.push(s1.right);
      } else {
        const cut = cuts[0];
        const s = net.splitSegment(id, cut.t);
        if (cut.keep === 'a') {
          armNodes.push({ phi: cut.phi, arm: { segmentId: id, nodeId: s.node, atStart: false } });
          if (s.right !== null) doomed.push(s.right);
        } else if (s.right !== null) {
          armNodes.push({ phi: cut.phi, arm: { segmentId: s.right, nodeId: s.node, atStart: true } });
          doomed.push(id);
        }
      }
    }
    for (const id of doomed) if (net.getSegment(id)) net.removeSegment(id);

    // Ring nodes exactly on the circle, arms squared up to them.
    for (const { phi, arm } of armNodes) net.moveNode(arm.nodeId, at(centre, R, phi));
    for (const { arm } of armNodes) squareArm(net, arm, centre);

    const ringType = ringTypeId(params.lanes);
    const overrides = params.speedKmh === 30 ? {} : { speedKmh: params.speedKmh };
    const arcs = ringArcs(centre, R, armNodes.map((a) => a.phi));
    const byPhi = [...armNodes].sort((a, b) => b.phi - a.phi);
    const nodes: Id[] = [];
    let armIndex = 0;
    for (const arc of arcs) {
      if (arc.arm) nodes.push(byPhi[armIndex++].arm.nodeId);
      else nodes.push(net.addNode(at(centre, R, arc.from)));
    }
    const segments: Id[] = [];
    arcs.forEach((arc, i) => {
      const c = arcCubic(centre, R, arc.from, arc.sweep);
      segments.push(net.addSegment(nodes[i], nodes[(i + 1) % nodes.length], { c1: c.p1, c2: c.p2, roadType: ringType, overrides }));
    });
    const arms = armNodes.map((a) => a.arm);
    applyControl(net, { nodes, arms }, params.priority);
    return { centre: { ...centre }, radius: R, lanes: params.lanes, speedKmh: params.speedKmh, priority: params.priority, segments, nodes, arms };
  });
}

/** Why the roundabout cannot take these settings, or an empty list. */
export function updateProblems(net: RoadNetwork, rb: Roundabout, params: RoundaboutParams): string[] {
  const R = clamp(params.radius, RADIUS_MIN, RADIUS_MAX);
  const half = ringHalf(params.lanes);
  const problems = new Set<string>();
  if (R - half < MIN_ISLAND) problems.add(`Radius too small for ${params.lanes} lanes. Try ${Math.ceil(half + MIN_ISLAND)} m or more.`);
  const own = new Set([...rb.segments, ...rb.arms.map((a) => a.segmentId)]);
  for (const arm of rb.arms) {
    const seg = net.getSegment(arm.segmentId)!;
    const far = net.getNode(arm.atStart ? seg.b : seg.a)!.pos;
    if (distXZ(far, rb.centre) - R < MIN_ARM) problems.add('A road is too short to reach the ring. Try a smaller radius.');
  }
  const phis = rb.arms.map((a) => {
    const p = net.getNode(a.nodeId)!.pos;
    return { phi: Math.atan2(p.z - rb.centre.z, p.x - rb.centre.x), half: totalHalfWidth(net.roadTypeOf(a.segmentId)) };
  });
  phis.sort((a, b) => b.phi - a.phi);
  for (let i = 0; i < phis.length && phis.length > 1; i++) {
    const a = phis[i];
    const b = phis[(i + 1) % phis.length];
    const gap = wrapPositive(a.phi - b.phi) || Math.PI * 2;
    if (gap * R < armSpacing(a.half, params.lanes) + armSpacing(b.half, params.lanes)) {
      problems.add('Arms too close together for this radius. Try a larger radius.');
      break;
    }
  }
  // Anything else the bigger ring would run into.
  const reach = R + half + 30;
  for (const id of net.segmentsInRegion({ minX: rb.centre.x - reach, minZ: rb.centre.z - reach, maxX: rb.centre.x + reach, maxZ: rb.centre.z + reach }, true)) {
    if (own.has(id)) continue;
    const half2 = totalHalfWidth(net.roadTypeOf(id));
    if (sampleSegment(net, id, rb.centre).some((s) => s.level !== 1 && s.level !== -1 && s.d < R + half + half2 + 0.5)) {
      problems.add('The ring would run into another road.');
      break;
    }
  }
  return [...problems];
}

/** Change a roundabout's settings in place, keeping its ids. Returns why not, or []. */
export function updateRoundabout(net: RoadNetwork, rb: Roundabout, params: RoundaboutParams): string[] {
  const problems = updateProblems(net, rb, params);
  if (problems.length) return problems;
  const R = clamp(params.radius, RADIUS_MIN, RADIUS_MAX);
  const c = rb.centre;
  net.batch(() => {
    const angle = (id: Id) => {
      const p = net.getNode(id)!.pos;
      return Math.atan2(p.z - c.z, p.x - c.x);
    };
    const phis = rb.nodes.map(angle);
    if (Math.abs(R - rb.radius) > 0.01) {
      rb.nodes.forEach((id, i) => net.moveNode(id, at(c, R, phis[i])));
    }
    const ringType = ringTypeId(params.lanes);
    rb.segments.forEach((id, i) => {
      const from = phis[i];
      const to = phis[(i + 1) % phis.length];
      const sweep = wrapPositive(from - to) || Math.PI * 2;
      const arc = arcCubic(c, R, from, sweep);
      net.setSegmentControls(id, arc.p1, arc.p2);
      if (net.getSegment(id)!.roadType !== ringType) net.setRoadType(id, ringType);
      const speed = params.speedKmh === 30 ? undefined : params.speedKmh;
      if (net.getSegment(id)!.overrides.speedKmh !== speed) net.setSegmentOverrides(id, { speedKmh: speed });
    });
    for (const arm of rb.arms) squareArm(net, arm, c);
    if (params.priority !== rb.priority || params.priority === 'signal') applyControl(net, rb, params.priority);
  });
  return [];
}

/**
 * Remove a roundabout. With two or more arms they meet again at a plain junction
 * in the middle, so the roads stay connected.
 */
export function removeRoundabout(net: RoadNetwork, rb: Roundabout): Id | null {
  return net.batch(() => {
    for (const id of rb.segments) if (net.getSegment(id)) net.removeSegment(id);
    if (rb.arms.length < 2) return null;
    const centre = net.addNode({ ...rb.centre });
    for (const arm of rb.arms) {
      const seg = net.getSegment(arm.segmentId);
      if (!seg || !net.getNode(arm.nodeId)) continue;
      const opts = { roadType: seg.roadType, overrides: seg.overrides };
      // Carry on in the arm's own direction, so one-way roads stay one way.
      if (arm.atStart) net.addSegment(centre, arm.nodeId, opts);
      else net.addSegment(arm.nodeId, centre, opts);
    }
    return centre;
  });
}

// ---------------------------------------------------------------------------
// Lane use at ring nodes
// ---------------------------------------------------------------------------

const drives = (l: LaneEnd) => l.kind === 'drive' || l.kind === 'bus';

/**
 * Connectors at a node where one road meets the ring, or null when the node is not
 * one. Lane index from the outside: 0 is the outer ring lane.
 */
export function roundaboutLaneLinks(arms: ArmLanes[], defOf: (id: Id) => RoadTypeDef): LaneLinkSpec[] | null {
  const ring = arms.filter((a) => isRingType(defOf(a.segmentId)));
  if (ring.length !== 2) return null;
  const others = arms.filter((a) => !ring.includes(a));
  if (others.length !== 1) return null;
  const ringIn = ring.find((a) => a.incoming.some(drives));
  const ringOut = ring.find((a) => a.outgoing.some(drives));
  if (!ringIn || !ringOut || ringIn === ringOut) return null;
  const arm = others[0];
  const rin = ringIn.incoming.filter(drives);
  const rout = ringOut.outgoing.filter(drives);
  const ins = arm.incoming.filter(drives);
  const outs = arm.outgoing.filter(drives);
  const nIn = rin.length;
  const nOut = rout.length;
  // Lanes are listed left to right, and left is the inside of the ring.
  const inLane = (o: number) => rin[nIn - 1 - Math.min(o, nIn - 1)];
  const outLane = (o: number) => rout[nOut - 1 - Math.min(o, nOut - 1)];
  const links = new Map<string, LaneLinkSpec>();
  const add = (from: LaneEnd, to: LaneEnd, turn: LaneLinkSpec['turn']) => {
    links.set(`${from.segmentId}:${from.laneIndex}>${to.segmentId}:${to.laneIndex}`, { from, to, turn });
  };
  const exits = outs.length > 0;
  for (let o = 0; o < nIn; o++) {
    if (o === 0) {
      // The outer lane leaves here, unless there is no way out or only one lane.
      if (!exits || nIn === 1) add(inLane(0), outLane(0), 'straight');
    } else {
      add(inLane(o), outLane(o), 'straight');
      if (exits) add(inLane(o), outLane(o - 1), 'straight');
    }
  }
  // Exits: the outer lane takes the right exit lane, inner lanes any further left.
  for (let k = 0; k < outs.length; k++) add(inLane(Math.min(k, nIn - 1)), outs[outs.length - 1 - k], 'right');
  // Entries: the arm's right lane feeds the outer lane, its left lane the inner ones.
  const m = ins.length;
  for (let o = 0; o < nOut && m > 0; o++) add(ins[m - 1 - Math.min(o, m - 1)], outLane(o), 'right');
  for (let k = nOut; k < m; k++) add(ins[m - 1 - k], outLane(nOut - 1), 'right');
  return [...links.values()];
}
