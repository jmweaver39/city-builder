/**
 * The pedestrian graph: where people may walk. Pure TS, rebuilt from the network.
 *
 * - Sidewalks run along each side of a segment that has one (sidewalkLeft and
 *   sidewalkRight honoured), never along highways, ramps or rail, never in tunnels.
 * - Corners join the sidewalks of neighbouring arms round a junction, along the
 *   junction's kerb (so a shaped junction's edited kerb and its corners with the
 *   sidewalk taken off are honoured), and round the cap of a dead end.
 * - Crossings exist only where a crosswalk is painted, as one edge kerb to kerb.
 * - Doors of building lots, bus stops and station platforms hang off the sidewalks.
 */
import { closestPointOnCubic, lengthAtT } from '../core/bezier';
import { cornerInfos, segmentKerbShift } from '../core/junctionShape';
import type { RoadNetwork } from '../core/RoadNetwork';
import { isControlledAccess } from '../core/ramps';
import { effectiveMarkings, sidewalkOn } from '../core/roadTypes';
import { effectiveControl } from '../core/signals';
import { surfaceLevel, terrainHeight } from '../core/terrain';
import type { GLane, Id, LaneGraph, NodeArm, Vec3, ZoneKind } from '../core/types';
import { footprintAt } from './footprint';
import { busStopsOn, collectLots, collectPlatforms, stationPoint, walkableDef, type Lot } from './places';

/** Mirrors render/constants: road surfaces float this far up, kerbs stand this tall. */
export const ROAD_LIFT = 0.06;
export const KERB_HEIGHT = 0.15;
/** Crosswalk centre back from the arm's cut line, as render/markings paints it. */
export const CROSSWALK_BACK = 2.0;
export const CROSSWALK_DEPTH = 3;

export const N_WALK = 0;
export const N_DOOR = 1;
export const N_PLATFORM = 2;
export const N_STOP = 3;

export const E_WALK = 0;
export const E_CROSS = 1;
export const E_PATH = 2;
export const E_PLATFORM = 3;

export type PlaceKind = 'home' | 'shop' | 'office' | 'work' | 'bus' | 'station';

export interface PedPlace {
  kind: PlaceKind;
  node: number;
  weight: number;
  /** Rail station id for 'station'. */
  stationId?: Id;
}

/** Vehicle path samples watched before a crossing: x, z, heading x, heading z, metres to the crosswalk, group. */
export const WATCH_STRIDE = 6;
/** Approaching on the arm: stoppable by a red light or a closure. */
export const G_APPROACH = 0;
/** On a connector into the arm, or just past the junction: committed. */
export const G_COMMITTED = 1;
/** On a road feeding a connector into the arm: stoppable by a closure. */
export const G_FEEDER = 2;
/** Leaving over the crosswalk from the arm: only in the way while on it. */
export const G_LEAVING = 3;

export interface PedCrossing {
  index: number;
  nodeId: Id;
  segmentId: Id;
  /** Landing nodes on each kerb. */
  a: number;
  b: number;
  centre: Vec3;
  /** Unit direction along the road, away from the junction. */
  ux: number;
  uz: number;
  length: number;
  signal: boolean;
  /** Cars may be held for people on it (no track at this node). */
  hook: boolean;
  /** Lane keys of connectors leaving from, going into, and going straight into the arm. */
  fromKeys: string[];
  intoKeys: string[];
  straightIntoKeys: string[];
  /** Road lanes of the arm arriving at the junction, whose traffic stops before the crosswalk. */
  approachKeys: string[];
  watch: Float32Array;
  /** Offsets into watch, bucketed by watchCellKey. */
  watchCells: Map<number, number[]>;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface PlatformInfo {
  stationId: Id;
  nodes: number[];
  /** True when a path joins it to the sidewalks. */
  linked: boolean;
}

export interface PedGraph {
  /** Network version the graph was built from. */
  version: number;
  laneGraphVersion: number;
  n: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  kind: Uint8Array;
  /** Segment the node belongs to, -1 for none. */
  seg: Int32Array;
  /** How far either side of the node's line people may walk. */
  spread: Float32Array;
  start: Int32Array;
  to: Int32Array;
  len: Float32Array;
  ekind: Uint8Array;
  ecross: Int32Array;
  comp: Int32Array;
  crossings: PedCrossing[];
  places: PedPlace[];
  platforms: PlatformInfo[];
  /** Spatial buckets of node indices, 32 m cells. */
  cells: Map<number, number[]>;
}

const CELL = 32;
const cellKey = (ix: number, iz: number) => ix * 73856093 + iz * 19349663;

class Builder {
  x: number[] = [];
  y: number[] = [];
  z: number[] = [];
  kind: number[] = [];
  seg: number[] = [];
  spread: number[] = [];
  edges: number[] = [];

  node(x: number, y: number, z: number, kind: number, seg: number, spread: number): number {
    this.x.push(x);
    this.y.push(y);
    this.z.push(z);
    this.kind.push(kind);
    this.seg.push(seg);
    this.spread.push(spread);
    return this.x.length - 1;
  }

  edge(a: number, b: number, kind: number, cross = -1): void {
    if (a === b || a < 0 || b < 0) return;
    this.edges.push(a, b, kind, cross);
  }

  dist(a: number, b: number): number {
    return Math.hypot(this.x[a] - this.x[b], this.y[a] - this.y[b], this.z[a] - this.z[b]);
  }
}

interface SideWalk {
  segmentId: Id;
  side: 1 | -1;
  /** Arc lengths and node indices along the side, a to b. */
  s: number[];
  nodes: number[];
  /** Node at the a end and b end of the visible span, or -1 if it does not reach. */
  endA: number;
  endB: number;
}

function inTunnel(p: { x: number; y: number; z: number }): boolean {
  return p.y < terrainHeight(p.x, p.z) - 1.5 && p.y < surfaceLevel(p.x, p.z) - 1.5;
}

/** True for a junction painted as free-flowing (render/gore isRampJunction). */
function rampJunction(net: RoadNetwork, nodeId: Id): boolean {
  const g = net.nodeGeom(nodeId);
  if (!g || g.kind !== 'junction') return false;
  const cats = g.arms.map((a) => ({ category: net.roadTypeOf(a.segmentId).category }));
  if (isControlledAccess(cats, net.getNode(nodeId)?.control.highwayAccess)) return true;
  return cats.every((c) => c.category === 'highway' || c.category === 'ramp');
}

/** Crosswalk painted on this arm, as render/markings decides. */
export function crosswalkOn(net: RoadNetwork, nodeId: Id, segId: Id): boolean {
  const g = net.nodeGeom(nodeId);
  const node = net.getNode(nodeId);
  const seg = net.getSegment(segId);
  if (!g || !node || !seg || g.kind !== 'junction' || g.arms.length < 3) return false;
  if (node.control.hideAutoMarkings) return false;
  if (rampJunction(net, nodeId)) return false;
  const def = net.roadTypeOf(segId);
  const style = node.control.crosswalks[segId] ?? effectiveMarkings(def, seg.overrides).crosswalk;
  return style !== 'none';
}

/** Arm end on one side, looking at the node: the segment side it is. */
const armSide = (arm: NodeArm, which: 'left' | 'right'): 1 | -1 => (which === 'left' ? (arm.atStart ? 1 : -1) : arm.atStart ? -1 : 1);

/** Is the straight path from p to q clear of every carriageway, track and water? */
function pathClear(net: RoadNetwork, p: Vec3, q: Vec3, skipStart = 0.6, skipEnd = 0.6): boolean {
  const L = Math.hypot(q.x - p.x, q.z - p.z);
  const n = Math.max(1, Math.ceil(L / 1.5));
  for (let i = 0; i <= n; i++) {
    const d = (L * i) / n;
    if (d < skipStart || d > L - skipEnd) continue;
    const f = i / n;
    const x = p.x + (q.x - p.x) * f;
    const z = p.z + (q.z - p.z) * f;
    const y = p.y + (q.y - p.y) * f;
    if (footprintAt(net, x, Math.max(y, terrainHeight(x, z)), z, { radius: 0.3 })) return false;
  }
  return true;
}

export function buildPedGraph(net: RoadNetwork): PedGraph {
  const B = new Builder();
  const graph = net.laneGraph;
  const segIds = net.segments.map((s) => s.id);
  const walkSides = new Map<string, number>();
  const sideKey = (seg: Id, side: number) => `${seg}:${side}`;
  const requests = new Map<string, number[]>();
  const request = (seg: Id, side: number, s: number) => {
    const k = sideKey(seg, side);
    let list = requests.get(k);
    if (!list) requests.set(k, (list = []));
    list.push(s);
  };

  for (const id of segIds) {
    const def = net.roadTypeOf(id);
    if (!walkableDef(def)) continue;
    const geom = net.segmentGeom(id);
    if (!geom || geom.stations.length < 2 || geom.length < 1) continue;
    for (const side of [1, -1] as const) {
      const W = sidewalkOn(def, side);
      if (W >= 0.8) walkSides.set(sideKey(id, side), W);
    }
  }

  // Crosswalk landings, two metres in from each cut line, on both sides.
  interface CrossPlan {
    nodeId: Id;
    arm: NodeArm;
    s: number;
  }
  const crossPlans: CrossPlan[] = [];
  for (const node of net.nodes) {
    const g = net.nodeGeom(node.id);
    if (!g || g.kind !== 'junction') continue;
    for (const arm of g.arms) {
      const id = arm.segmentId;
      if (!walkSides.has(sideKey(id, 1)) || !walkSides.has(sideKey(id, -1))) continue;
      if (!crosswalkOn(net, node.id, id)) continue;
      const geom = net.segmentGeom(id)!;
      if (geom.length < CROSSWALK_BACK * 2 + 2) continue;
      const st = geom.stations;
      const s = arm.atStart ? st[0].s + CROSSWALK_BACK : st[st.length - 1].s - CROSSWALK_BACK;
      crossPlans.push({ nodeId: node.id, arm, s });
      request(id, 1, s);
      request(id, -1, s);
    }
  }

  // Lot doors, joined straight to the sidewalk in front of them.
  interface DoorPlan {
    lot: Lot;
    s: number;
  }
  const doorPlans: DoorPlan[] = [];
  for (const lot of collectLots(net)) {
    if (!walkSides.has(sideKey(lot.segmentId, lot.side))) continue;
    const geom = net.segmentGeom(lot.segmentId)!;
    const hit = closestPointOnCubic(net.cubicOf(lot.segmentId), lot.door);
    const st = geom.stations;
    const s = Math.max(st[0].s + 4, Math.min(st[st.length - 1].s - 4, lengthAtT(net.curveOf(lot.segmentId).table, hit.t)));
    if (st[st.length - 1].s - st[0].s < 9) continue;
    doorPlans.push({ lot, s });
    request(lot.segmentId, lot.side, s);
  }

  const stops = segIds.flatMap((id) => busStopsOn(net, id)).filter((b) => walkSides.has(sideKey(b.segmentId, b.side)));
  for (const b of stops) request(b.segmentId, b.side, b.s);

  // Sidewalk lines.
  const sides = new Map<string, SideWalk>();
  const atS = new Map<string, number>();
  const sKey = (seg: Id, side: number, s: number) => `${seg}:${side}:${Math.round(s * 100)}`;
  for (const [key, W] of walkSides) {
    const [segStr, sideStr] = key.split(':');
    const id = Number(segStr);
    const side = Number(sideStr) as 1 | -1;
    const def = net.roadTypeOf(id);
    const geom = net.segmentGeom(id)!;
    const st = geom.stations;
    const s0 = st[0].s;
    const s1 = st[st.length - 1].s;
    const shift = segmentKerbShift(net, id);
    const wanted = new Set<number>([s0, s1]);
    for (const x of st) wanted.add(x.s);
    for (let s = s0; s < s1; s += 12) wanted.add(s);
    for (const s of requests.get(key) ?? []) wanted.add(s);
    const list = [...wanted].filter((s) => s >= s0 - 1e-6 && s <= s1 + 1e-6).sort((a, b) => a - b);
    // Thin points closer than 1.5 m unless they were asked for.
    const asked = new Set(requests.get(key) ?? []);
    const keep: number[] = [];
    for (const s of list) {
      const last = keep[keep.length - 1];
      if (last !== undefined && s - last < 1.5 && !asked.has(s) && s !== s1) continue;
      if (last !== undefined && s - last < 1.5 && s === s1 && !asked.has(last) && keep.length > 1) keep.pop();
      keep.push(s);
    }
    const walk: SideWalk = { segmentId: id, side, s: [], nodes: [], endA: -1, endB: -1 };
    let prev = -1;
    for (const s of keep) {
      const p = stationPoint(st, s);
      if (inTunnel(p)) {
        prev = -1;
        continue;
      }
      const kerb = def.halfWidth - (shift ? shift(side, s) : 0);
      const walkW = def.halfWidth + W - kerb;
      // Walk a little toward the buildings: the kerb side is where the furniture stands.
      const o = side * (kerb + walkW * 0.58);
      const spread = Math.max(0.05, Math.min(0.45, walkW * 0.5 - 0.55));
      const n = B.node(p.x + p.rx * o, p.y + ROAD_LIFT + KERB_HEIGHT, p.z + p.rz * o, N_WALK, id, spread);
      walk.s.push(s);
      walk.nodes.push(n);
      atS.set(sKey(id, side, s), n);
      if (prev >= 0) B.edge(prev, n, E_WALK);
      prev = n;
      if (Math.abs(s - s0) < 1e-6) walk.endA = n;
      if (Math.abs(s - s1) < 1e-6) walk.endB = n;
    }
    sides.set(key, walk);
  }
  const endOf = (arm: NodeArm, which: 'left' | 'right'): number => {
    const w = sides.get(sideKey(arm.segmentId, armSide(arm, which)));
    if (!w) return -1;
    return arm.atStart ? w.endA : w.endB;
  };

  // Corners, joints and dead ends.
  for (const node of net.nodes) {
    const g = net.nodeGeom(node.id);
    if (!g || g.arms.length === 0) continue;
    if (g.kind === 'deadEnd') {
      const arm = g.arms[0];
      const a = endOf(arm, 'left');
      const b = endOf(arm, 'right');
      if (a < 0 || b < 0) continue;
      const def = net.roadTypeOf(arm.segmentId);
      const H = def.halfWidth;
      const ux = (arm.leftEdge.x - arm.centre.x) / H;
      const uz = (arm.leftEdge.z - arm.centre.z) / H;
      const r = (Math.hypot(B.x[a] - arm.centre.x, B.z[a] - arm.centre.z) + Math.hypot(B.x[b] - arm.centre.x, B.z[b] - arm.centre.z)) / 2;
      let prev = a;
      const y = B.y[a];
      for (let i = 1; i < 10; i++) {
        const ang = (i / 10) * Math.PI;
        const n = B.node(
          arm.centre.x + ux * Math.cos(ang) * r - arm.dir.x * Math.sin(ang) * r,
          y,
          arm.centre.z + uz * Math.cos(ang) * r - arm.dir.z * Math.sin(ang) * r,
          N_WALK,
          -1,
          B.spread[a],
        );
        B.edge(prev, n, E_WALK);
        prev = n;
      }
      B.edge(prev, b, E_WALK);
      continue;
    }
    const corners = g.kind === 'junction' ? cornerInfos(net, node.id) : [];
    if (corners.length) {
      for (const c of corners) {
        if (c.setting.sidewalk === false || c.walkA <= 0 || c.walkB <= 0 || !c.back) continue;
        const A = g.arms[c.arm];
        const Bm = g.arms[c.next];
        const a = endOf(A, 'left');
        const b = endOf(Bm, 'right');
        if (a < 0 || b < 0) continue;
        const kerb = resample(c.kerb, Math.max(3, Math.ceil(polyLength(c.kerb) / 2.5) + 1));
        const back = resample(c.back, kerb.length);
        let prev = a;
        for (let i = 1; i < kerb.length - 1; i++) {
          const k = kerb[i];
          const o = back[i];
          const n = B.node(k.x + (o.x - k.x) * 0.58, k.y + ROAD_LIFT + KERB_HEIGHT, k.z + (o.z - k.z) * 0.58, N_WALK, -1, Math.min(B.spread[a], B.spread[b]));
          if (B.dist(prev, n) < 0.8) continue;
          B.edge(prev, n, E_WALK);
          prev = n;
        }
        B.edge(prev, b, E_WALK);
      }
      continue;
    }
    // A plain joint or a junction with no outline: walks meet end to end.
    const n = g.arms.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const A = g.arms[i];
      const Bm = g.arms[(i + 1) % n];
      const a = endOf(A, 'left');
      const b = endOf(Bm, 'right');
      if (a < 0 || b < 0) continue;
      if (B.dist(a, b) < 6) B.edge(a, b, E_WALK);
    }
  }

  // Crossings.
  const crossings: PedCrossing[] = [];
  for (const plan of crossPlans) {
    const id = plan.arm.segmentId;
    const a = atS.get(sKey(id, -1, plan.s));
    const b = atS.get(sKey(id, 1, plan.s));
    if (a === undefined || b === undefined) continue;
    const geom = net.segmentGeom(id)!;
    const p = stationPoint(geom.stations, plan.s);
    const index = crossings.length;
    const ctl = effectiveControl(net, plan.nodeId);
    const g = net.nodeGeom(plan.nodeId)!;
    const hasRail = g.arms.some((arm) => net.roadTypeOf(arm.segmentId).category === 'rail');
    const fromKeys: string[] = [];
    const intoKeys: string[] = [];
    const straightIntoKeys: string[] = [];
    const approachKeys: string[] = [];
    for (const li of graph.roadLanes.get(id) ?? []) {
      if (li < 0) continue;
      const l = graph.lanes[li];
      const n = l.pts.length;
      const endD = Math.hypot(l.pts[n - 3] - plan.arm.centre.x, l.pts[n - 1] - plan.arm.centre.z);
      const startD = Math.hypot(l.pts[0] - plan.arm.centre.x, l.pts[2] - plan.arm.centre.z);
      if (endD < startD) approachKeys.push(l.key);
    }
    for (const c of graph.connectorsAt.get(plan.nodeId) ?? []) {
      const l = graph.lanes[c];
      if (graph.lanes[l.fromLane]?.segmentId === id) fromKeys.push(l.key);
      if (graph.lanes[l.toLane]?.segmentId === id) {
        intoKeys.push(l.key);
        if (l.turn === 'straight') straightIntoKeys.push(l.key);
      }
    }
    const watch = watchSamples(net, plan.nodeId, plan.arm, id);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < watch.length; i += WATCH_STRIDE) {
      minX = Math.min(minX, watch[i]);
      maxX = Math.max(maxX, watch[i]);
      minZ = Math.min(minZ, watch[i + 1]);
      maxZ = Math.max(maxZ, watch[i + 1]);
    }
    crossings.push({
      index,
      nodeId: plan.nodeId,
      segmentId: id,
      a,
      b,
      centre: { x: p.x, y: p.y + ROAD_LIFT, z: p.z },
      ux: plan.arm.cutDir.x,
      uz: plan.arm.cutDir.z,
      length: B.dist(a, b),
      signal: ctl.kind === 'signal',
      hook: !hasRail,
      fromKeys,
      intoKeys,
      straightIntoKeys,
      approachKeys,
      watch,
      watchCells: watchGrid(watch),
      minX,
      minZ,
      maxX,
      maxZ,
    });
    B.edge(a, b, E_CROSS, index);
  }

  // Places: doors, bus stops, platforms.
  const places: PedPlace[] = [];
  const LOT_KIND: Record<ZoneKind, PlaceKind> = { residential: 'home', commercial: 'shop', office: 'office', industrial: 'work' };
  for (const { lot, s } of doorPlans) {
    const at = atS.get(sKey(lot.segmentId, lot.side, s));
    if (at === undefined) continue;
    const p = { x: B.x[at], y: B.y[at], z: B.z[at] };
    const door = lot.door;
    if (Math.hypot(door.x - p.x, door.z - p.z) > (lot.region ? 34 : 60)) continue;
    if (!pathClear(net, p, door, 1.2, 0.5)) continue;
    const d = B.node(door.x, door.y, door.z, N_DOOR, -1, 0.25);
    B.edge(at, d, E_PATH);
    places.push({ kind: LOT_KIND[lot.kind], node: d, weight: lot.weight });
  }
  for (const stop of stops) {
    const at = atS.get(sKey(stop.segmentId, stop.side, stop.s));
    if (at === undefined) continue;
    B.kind[at] = N_STOP;
    places.push({ kind: 'bus', node: at, weight: 1.5 });
  }

  // Index of sidewalk nodes so far, for joining platforms and entrances.
  const walkCells = new Map<number, number[]>();
  for (let i = 0; i < B.x.length; i++) {
    if (B.kind[i] !== N_WALK && B.kind[i] !== N_STOP) continue;
    const k = cellKey(Math.floor(B.x[i] / CELL), Math.floor(B.z[i] / CELL));
    let list = walkCells.get(k);
    if (!list) walkCells.set(k, (list = []));
    list.push(i);
  }
  const nearWalk = (p: Vec3, r: number): number[] => {
    const out: number[] = [];
    for (let ix = Math.floor((p.x - r) / CELL); ix <= Math.floor((p.x + r) / CELL); ix++) {
      for (let iz = Math.floor((p.z - r) / CELL); iz <= Math.floor((p.z + r) / CELL); iz++) {
        for (const i of walkCells.get(cellKey(ix, iz)) ?? []) {
          if (Math.hypot(B.x[i] - p.x, B.z[i] - p.z) <= r) out.push(i);
        }
      }
    }
    return out.sort((i, j) => Math.hypot(B.x[i] - p.x, B.z[i] - p.z) - Math.hypot(B.x[j] - p.x, B.z[j] - p.z));
  };

  const platforms: PlatformInfo[] = [];
  for (const pf of collectPlatforms(net)) {
    if (pf.underground) {
      // An entrance on the street above: people walk to it and go down.
      const near = nearWalk(pf.centre, 90);
      if (near.length) places.push({ kind: 'station', node: near[0], weight: 4, stationId: pf.stationId });
      continue;
    }
    const nodes: number[] = [];
    let prev = -1;
    for (const p of pf.line) {
      const n = B.node(p.x, p.y + ROAD_LIFT, p.z, N_PLATFORM, -1, 1.2);
      if (prev >= 0) B.edge(prev, n, E_PLATFORM);
      nodes.push(n);
      prev = n;
    }
    // Stairs and paths: from an end or the middle of the platform to the nearest sidewalk.
    let linked = false;
    const tryFrom = [0, nodes.length - 1, Math.floor(nodes.length / 2)];
    let best: { from: number; to: number; d: number } | null = null;
    for (const k of tryFrom) {
      const from = nodes[k];
      const out = pf.out[k];
      // Leave from the platform's back edge, away from the track.
      const edge = { x: B.x[from] + out.x * 2.8, y: B.y[from], z: B.z[from] + out.z * 2.8 };
      for (const to of nearWalk(edge, 120).slice(0, 12)) {
        const q = { x: B.x[to], y: B.y[to], z: B.z[to] };
        const d = Math.hypot(q.x - edge.x, q.z - edge.z);
        if (best && d >= best.d) break;
        if (!pathClear(net, edge, q, 0.3, 1.2)) continue;
        best = { from, to, d };
        break;
      }
    }
    if (best) {
      B.edge(best.from, best.to, E_PATH);
      linked = true;
    }
    const mid = nodes[Math.floor(nodes.length / 2)];
    places.push({ kind: 'station', node: mid, weight: linked ? 5 : 1.5, stationId: pf.stationId });
    platforms.push({ stationId: pf.stationId, nodes, linked });
  }

  return compact(net, B, crossings, places, platforms);
}

function compact(net: RoadNetwork, B: Builder, crossings: PedCrossing[], places: PedPlace[], platforms: PlatformInfo[]): PedGraph {
  const n = B.x.length;
  const deg = new Int32Array(n + 1);
  const E = B.edges;
  for (let i = 0; i < E.length; i += 4) {
    deg[E[i]]++;
    deg[E[i + 1]]++;
  }
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
  const m = start[n];
  const to = new Int32Array(m);
  const len = new Float32Array(m);
  const ekind = new Uint8Array(m);
  const ecross = new Int32Array(m);
  const fill = start.slice(0, n);
  for (let i = 0; i < E.length; i += 4) {
    const a = E[i];
    const b = E[i + 1];
    const d = Math.max(0.05, B.dist(a, b));
    for (const [u, v] of [
      [a, b],
      [b, a],
    ]) {
      const k = fill[u]++;
      to[k] = v;
      len[k] = d;
      ekind[k] = E[i + 2];
      ecross[k] = E[i + 3];
    }
  }
  // Connected components.
  const comp = new Int32Array(n).fill(-1);
  let c = 0;
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (comp[i] >= 0) continue;
    comp[i] = c;
    stack.push(i);
    while (stack.length) {
      const u = stack.pop()!;
      for (let k = start[u]; k < start[u + 1]; k++) {
        const v = to[k];
        if (comp[v] < 0) {
          comp[v] = c;
          stack.push(v);
        }
      }
    }
    c++;
  }
  const cells = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const k = cellKey(Math.floor(B.x[i] / CELL), Math.floor(B.z[i] / CELL));
    let list = cells.get(k);
    if (!list) cells.set(k, (list = []));
    list.push(i);
  }
  return {
    version: net.version,
    laneGraphVersion: net.laneGraph.version,
    n,
    x: Float32Array.from(B.x),
    y: Float32Array.from(B.y),
    z: Float32Array.from(B.z),
    kind: Uint8Array.from(B.kind),
    seg: Int32Array.from(B.seg),
    spread: Float32Array.from(B.spread),
    start,
    to,
    len,
    ekind,
    ecross,
    comp,
    crossings,
    places,
    platforms,
    cells,
  };
}

/** Node indices of the graph within r of (x, z). */
export function nodesNear(g: PedGraph, x: number, z: number, r: number, out: number[] = []): number[] {
  out.length = 0;
  for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
    for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
      for (const i of g.cells.get(cellKey(ix, iz)) ?? []) {
        const dx = g.x[i] - x;
        const dz = g.z[i] - z;
        if (dx * dx + dz * dz <= r * r) out.push(i);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Watching the traffic at a crossing
// ---------------------------------------------------------------------------

function pushLaneSamples(out: number[], l: GLane, from: number, to: number, remainAt: (s: number) => number, group: number, step = 2): void {
  const lo = Math.max(0, from);
  const hi = Math.min(l.length, to);
  if (hi <= lo) return;
  const n = Math.max(1, Math.ceil((hi - lo) / step));
  let k = 0;
  for (let i = 0; i <= n; i++) {
    const s = lo + ((hi - lo) * i) / n;
    while (k + 2 < l.cum.length && l.cum[k + 1] < s) k++;
    const s0 = l.cum[k];
    const s1 = l.cum[k + 1];
    const f = s1 > s0 ? Math.max(0, Math.min(1, (s - s0) / (s1 - s0))) : 0;
    const ax = l.pts[k * 3];
    const az = l.pts[k * 3 + 2];
    const bx = l.pts[(k + 1) * 3];
    const bz = l.pts[(k + 1) * 3 + 2];
    const hx = bx - ax;
    const hz = bz - az;
    const hl = Math.hypot(hx, hz) || 1;
    out.push(ax + hx * f, az + hz * f, hx / hl, hz / hl, remainAt(s), group);
  }
}

/** How far upstream traffic is watched: a car at town speed covers this while someone crosses a wide road. */
const WATCH_UPSTREAM = 320;
const WATCH_FEEDER = 220;

/**
 * Sample a lane and walk on upstream through whatever feeds it, until `budget` metres
 * are covered. `remainAtEnd` is the distance from the lane's end to the crosswalk.
 */
function walkUpstream(graph: LaneGraph, out: number[], li: number, remainAtEnd: number, budget: number, group: number, seen: Set<number>, depth = 0): void {
  if (budget <= 0 || seen.has(li) || depth > 12) return;
  seen.add(li);
  const l = graph.lanes[li];
  if (!l) return;
  pushLaneSamples(out, l, l.length - budget, l.length, (s) => l.length - s + remainAtEnd, group, remainAtEnd + l.length - budget > 80 ? 4 : 2);
  for (const p of l.prev) walkUpstream(graph, out, p, remainAtEnd + l.length, budget - l.length, group, seen, depth + 1);
}

/** Points on every path that crosses the crosswalk, with the distance left to it. */
function watchSamples(net: RoadNetwork, nodeId: Id, arm: NodeArm, segId: Id): Float32Array {
  const graph = net.laneGraph;
  const out: number[] = [];
  const road = graph.roadLanes.get(segId) ?? [];
  // A lane travelling toward the node ends at the cut; the crosswalk is CROSSWALK_BACK before.
  for (const li of road) {
    if (li < 0) continue;
    const l = graph.lanes[li];
    const lastX = l.pts[l.pts.length - 3];
    const lastZ = l.pts[l.pts.length - 1];
    const firstX = l.pts[0];
    const firstZ = l.pts[2];
    const towards = Math.hypot(lastX - arm.centre.x, lastZ - arm.centre.z) < Math.hypot(firstX - arm.centre.x, firstZ - arm.centre.z);
    if (towards) walkUpstream(graph, out, li, -CROSSWALK_BACK, WATCH_UPSTREAM, G_APPROACH, new Set());
    else pushLaneSamples(out, l, 0, 12, (s) => CROSSWALK_BACK - s, G_COMMITTED);
  }
  const feeders = new Map<number, number>();
  for (const c of graph.connectorsAt.get(nodeId) ?? []) {
    const l = graph.lanes[c];
    const into = graph.lanes[l.toLane]?.segmentId === segId;
    const from = graph.lanes[l.fromLane]?.segmentId === segId;
    if (into && !from) {
      pushLaneSamples(out, l, 0, l.length, (s) => l.length - s + CROSSWALK_BACK, G_COMMITTED);
      const prev = feeders.get(l.fromLane);
      if (prev === undefined || l.length < prev) feeders.set(l.fromLane, l.length);
    } else if (from) {
      pushLaneSamples(out, l, 0, Math.min(l.length, 10), (s) => -(s + CROSSWALK_BACK), G_LEAVING);
    }
  }
  const seen = new Set<number>();
  for (const [li, connLen] of feeders) walkUpstream(graph, out, li, connLen + CROSSWALK_BACK, WATCH_FEEDER, G_FEEDER, seen);
  return Float32Array.from(out);
}

/** Watch samples bucketed in WATCH_CELL cells, so a vehicle only meets the samples near it. */
export const WATCH_CELL = 6;
export const watchCellKey = (ix: number, iz: number): number => ix * 92821 + iz * 68917;

function watchGrid(watch: Float32Array): Map<number, number[]> {
  const grid = new Map<number, number[]>();
  for (let i = 0; i < watch.length; i += WATCH_STRIDE) {
    const k = watchCellKey(Math.floor(watch[i] / WATCH_CELL), Math.floor(watch[i + 1] / WATCH_CELL));
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(i);
  }
  return grid;
}

function polyLength(p: readonly Vec3[]): number {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
  return L;
}

function resample(p: readonly Vec3[], count: number): Vec3[] {
  const cum = [0];
  for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z));
  const L = cum[cum.length - 1];
  const out: Vec3[] = [];
  let k = 1;
  for (let i = 0; i < count; i++) {
    const s = (L * i) / (count - 1);
    while (k < p.length - 1 && cum[k] < s) k++;
    const a = p[k - 1];
    const b = p[k];
    const span = cum[k] - cum[k - 1];
    const f = span > 1e-9 ? Math.max(0, Math.min(1, (s - cum[k - 1]) / span)) : 0;
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f });
  }
  return out;
}
