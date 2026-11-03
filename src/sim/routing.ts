/**
 * Endpoints and cost tables. One table per destination, indexed by lane: the time
 * from the start of that lane to the destination. A lane change is an edge in the
 * graph too, so a lane that can only get there by changing has a finite cost and a
 * flag saying which way to go. Infinity means no route at all.
 */
import { effectiveLanes, type Id, type RoadNetwork, type TrafficEndpoint, type VehicleMix } from '../core';
import { ALLOW_BIKE, ALLOW_BUS, ALLOW_CAR, type CompiledGraph } from './compiled';
import { LANE_CHANGE_COST_SEC } from './constants';
import type { JunctionSystem } from './junctions';

export const FLAG_NONE = 0;
export const FLAG_LEFT = 1;
export const FLAG_RIGHT = 2;

export interface LanePoint {
  lane: number;
  s: number;
}

/** One place traffic can come from or go to. */
export interface Place {
  /** Survives rebuilds: `e${id}` or `n${nodeId}` for an automatic gateway. */
  key: string;
  endpointId: Id | null;
  name: string;
  /** Relative pull as a destination. 0 when nothing can arrive here. */
  weight: number;
  /** Vehicles per hour at 100%. */
  rate: number;
  mix: VehicleMix | null;
  sinks: LanePoint[];
  sources: LanePoint[];
  /** Zones start and end mid-lane, gateways at lane ends. */
  isZone: boolean;
}

function laneDir(net: RoadNetwork, seg: Id, index: number): 1 | -1 {
  const s = net.getSegment(seg)!;
  return effectiveLanes(net.roadTypeOf(seg), s.overrides)[index].dir;
}

/** Road lanes arriving at or leaving a dead-end node, kept to those vehicles can use. */
function gatewayLanes(net: RoadNetwork, g: CompiledGraph, nodeId: Id): { sinks: LanePoint[]; sources: LanePoint[] } {
  const node = net.getNode(nodeId);
  const sinks: LanePoint[] = [];
  const sources: LanePoint[] = [];
  if (!node || node.segments.length !== 1) return { sinks, sources };
  const segId = node.segments[0];
  const seg = net.getSegment(segId)!;
  const dense = g.graph.roadLanes.get(segId) ?? [];
  dense.forEach((idx, i) => {
    if (idx < 0 || g.allow[idx] === 0) return;
    const dir = laneDir(net, segId, i);
    const arrives = (seg.b === nodeId && dir === 1) || (seg.a === nodeId && dir === -1);
    if (arrives) sinks.push({ lane: idx, s: Math.max(0.5, g.len[idx] - 1) });
    else sources.push({ lane: idx, s: 0 });
  });
  return { sinks, sources };
}

/** The kerbside drive and bus lanes of each direction of the fronting segment, at `t`. */
function zoneLanes(net: RoadNetwork, g: CompiledGraph, ep: TrafficEndpoint): LanePoint[] {
  const segId = ep.segmentId;
  if (segId === null) return [];
  const seg = net.getSegment(segId);
  const geom = net.segmentGeom(segId);
  const dense = g.graph.roadLanes.get(segId);
  if (!seg || !geom || !dense || geom.length <= 0) return [];
  const lanes = effectiveLanes(net.roadTypeOf(segId), seg.overrides);
  const oneWay = lanes.every((l) => l.dir === 1);
  const along = Math.min(0.95, Math.max(0.05, (ep.t * geom.fullLength - geom.trimA) / geom.length));
  const out: LanePoint[] = [];
  const add = (index: number, dir: 1 | -1) => {
    const idx = dense[index];
    if (idx < 0) return;
    out.push({ lane: idx, s: (dir === 1 ? along : 1 - along) * g.len[idx] });
  };
  const pick = (dir: 1 | -1, kind: 'drive' | 'bus' | 'bike', sideSign: 1 | -1) => {
    let best = -1;
    lanes.forEach((l, i) => {
      if (l.dir !== dir || l.kind !== kind || dense[i] < 0) return;
      if (best < 0 || l.offset * sideSign > lanes[best].offset * sideSign) best = i;
    });
    if (best >= 0) add(best, dir);
  };
  if (oneWay) {
    pick(1, 'drive', ep.side);
    pick(1, 'bus', ep.side);
    pick(1, 'bike', ep.side);
    return out;
  }
  for (const kind of ['drive', 'bus', 'bike'] as const) {
    pick(1, kind, 1);
    pick(-1, kind, -1);
  }
  return out;
}

/** Everything that can send or receive traffic right now. */
export function collectPlaces(net: RoadNetwork, g: CompiledGraph): Place[] {
  const places: Place[] = [];
  const claimed = new Set<Id>();
  for (const ep of net.endpoints) {
    if (ep.nodeId !== null) claimed.add(ep.nodeId);
    if (!ep.enabled) continue;
    if (ep.kind === 'gateway' || ep.nodeId !== null) {
      if (ep.nodeId === null) continue;
      const { sinks, sources } = gatewayLanes(net, g, ep.nodeId);
      if (!sinks.length && !sources.length) continue;
      places.push({
        key: `e${ep.id}`,
        endpointId: ep.id,
        name: ep.name || `Gateway ${ep.id}`,
        weight: sinks.length ? ep.attraction : 0,
        rate: sources.length ? ep.ratePerHour : 0,
        mix: ep.mix,
        sinks,
        sources,
        isZone: false,
      });
    } else {
      const lanes = zoneLanes(net, g, ep);
      if (!lanes.length) continue;
      places.push({
        key: `e${ep.id}`,
        endpointId: ep.id,
        name: ep.name || `${ep.kind} ${ep.id}`,
        weight: ep.attraction,
        rate: ep.ratePerHour,
        mix: ep.mix,
        sinks: lanes,
        sources: lanes,
        isZone: true,
      });
    }
  }
  const traffic = net.traffic;
  if (traffic.autoGateways) {
    for (const nodeId of net.deadEnds()) {
      if (claimed.has(nodeId)) continue;
      const { sinks, sources } = gatewayLanes(net, g, nodeId);
      if (!sinks.length && !sources.length) continue;
      const out = sources.filter((p) => g.allow[p.lane] & ALLOW_CAR).length;
      const into = sinks.filter((p) => g.allow[p.lane] & ALLOW_CAR).length;
      places.push({
        key: `n${nodeId}`,
        endpointId: null,
        name: `Gateway ${nodeId}`,
        weight: into,
        rate: out * traffic.autoGatewayRatePerLane,
        mix: null,
        sinks,
        sources,
        isZone: false,
      });
    }
  }
  return places;
}

/** Binary min-heap over (cost, lane) with no allocation. */
class LaneHeap {
  private cost: Float64Array;
  private lane: Int32Array;
  size = 0;

  constructor(capacity: number) {
    this.cost = new Float64Array(capacity);
    this.lane = new Int32Array(capacity);
  }

  push(c: number, l: number): void {
    const { cost, lane } = this;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cost[p] <= c) break;
      cost[i] = cost[p];
      lane[i] = lane[p];
      i = p;
    }
    cost[i] = c;
    lane[i] = l;
  }

  topCost(): number {
    return this.cost[0];
  }

  pop(): number {
    const { cost, lane } = this;
    const top = lane[0];
    const n = --this.size;
    if (n > 0) {
      const c = cost[n];
      const l = lane[n];
      let i = 0;
      for (;;) {
        let k = i * 2 + 1;
        if (k >= n) break;
        if (k + 1 < n && cost[k + 1] < cost[k]) k++;
        if (cost[k] >= c) break;
        cost[i] = cost[k];
        lane[i] = lane[k];
        i = k;
      }
      cost[i] = c;
      lane[i] = l;
    }
    return top;
  }
}

/** Cost tables for all places, one row per place, for one class of vehicle. */
export class RouteTable {
  cost: Float32Array;
  flag: Uint8Array;

  constructor(rows: number, cols: number) {
    this.cost = new Float32Array(rows * cols).fill(Infinity);
    this.flag = new Uint8Array(rows * cols);
  }
}

export class Routing {
  places: Place[] = [];
  n = 0;
  car: RouteTable;
  /** Same object as `car` when the network has no bus-only lanes. */
  bus: RouteTable;
  /** Empty when the network has no bike lanes. */
  bike: RouteTable;
  /** Per lane: 1 when some place sinks here. */
  sinkFlag: Uint8Array;
  /** Turnarounds at gateways, which routes may not use. */
  private edgeOfMap: Uint8Array;
  /** Fraction of the limit traffic is moving at, smoothed, by lane. */
  laneFlow: Float64Array;
  private dist: Float64Array;
  private flag: Uint8Array;
  private heap: LaneHeap;
  private travel: Float64Array;
  private cursor = 0;

  constructor(private g: CompiledGraph, private jn: JunctionSystem) {
    this.n = g.n;
    this.car = new RouteTable(0, 0);
    this.bus = this.car;
    this.bike = this.car;
    this.sinkFlag = new Uint8Array(g.n);
    this.edgeOfMap = new Uint8Array(g.n);
    this.laneFlow = new Float64Array(g.n).fill(1);
    this.dist = new Float64Array(g.n);
    this.flag = new Uint8Array(g.n);
    this.heap = new LaneHeap(g.nextList.length + g.n * 4 + 16);
    this.travel = new Float64Array(g.n);
  }

  /** Take over from an older table when the lanes kept their indices. */
  adoptFlow(old: Routing): void {
    if (old.n === this.n) this.laneFlow.set(old.laneFlow);
  }

  /** Rebuild every table against a new place list. */
  setPlaces(places: Place[]): void {
    this.places = places;
    const { g } = this;
    const rows = places.length;
    this.car = new RouteTable(rows, g.n);
    let busOnly = false;
    let bikes = false;
    for (let i = 0; i < g.n; i++) {
      if (g.allow[i] === ALLOW_BUS) busOnly = true;
      else if (g.allow[i] === ALLOW_BIKE) bikes = true;
    }
    this.bus = busOnly ? new RouteTable(rows, g.n) : this.car;
    this.bike = bikes ? new RouteTable(rows, g.n) : this.car;
    this.sinkFlag.fill(0);
    this.edgeOfMap.fill(0);
    for (const p of places) {
      for (const k of p.sinks) this.sinkFlag[k.lane] = 1;
      if (p.isZone) continue;
      for (const k of p.sinks) {
        for (let e = g.nextStart[k.lane]; e < g.nextStart[k.lane + 1]; e++) this.edgeOfMap[g.nextList[e]] = 1;
      }
    }
    this.cursor = 0;
    this.refreshTravel();
    for (let r = 0; r < rows; r++) this.compute(r);
  }

  private refreshTravel(): void {
    const { g, travel, laneFlow, jn, edgeOfMap } = this;
    for (let l = 0; l < g.n; l++) {
      // A gateway is the edge of the map, not a place to turn round.
      travel[l] = edgeOfMap[l] ? Infinity : g.len[l] / Math.max(g.speed[l] * laneFlow[l], 1) + (g.isConn[l] ? jn.delay[l] : 0);
    }
  }

  /** Refresh the next table in turn, with current congestion. */
  refreshNext(): void {
    const rows = this.places.length;
    if (!rows) return;
    if (this.cursor >= rows) this.cursor = 0;
    if (this.cursor === 0) this.refreshTravel();
    this.compute(this.cursor++);
  }

  private compute(row: number): void {
    this.computeFor(row, this.car, ALLOW_CAR);
    if (this.bus !== this.car) this.computeFor(row, this.bus, ALLOW_BUS);
    if (this.bike !== this.car) this.computeFor(row, this.bike, ALLOW_BIKE);
  }

  private computeFor(row: number, table: RouteTable, bit: number): void {
    const { g, dist, flag, heap, travel } = this;
    const { allow, left, right, prevStart, prevList, speed } = g;
    dist.fill(Infinity);
    flag.fill(0);
    heap.size = 0;
    for (const sink of this.places[row].sinks) {
      if (!(allow[sink.lane] & bit)) continue;
      const c = sink.s / speed[sink.lane];
      if (c < dist[sink.lane]) {
        dist[sink.lane] = c;
        heap.push(c, sink.lane);
      }
    }
    while (heap.size > 0) {
      const c = heap.topCost();
      const l = heap.pop();
      if (c > dist[l]) continue;
      // Going on along the lane wins ties, so a lane is only flagged when changing helps.
      for (let k = prevStart[l]; k < prevStart[l + 1]; k++) {
        const p = prevList[k];
        if (!(allow[p] & bit)) continue;
        const nc = c + travel[p];
        if (nc === Infinity) continue;
        if (nc < dist[p] - 1e-3) {
          dist[p] = nc;
          flag[p] = FLAG_NONE;
          heap.push(nc, p);
        } else if (nc <= dist[p] + 0.05) {
          flag[p] = FLAG_NONE;
        }
      }
      const nc = c + LANE_CHANGE_COST_SEC;
      // `q` changing to its right lands on l when l is q's right neighbour.
      const a = left[l];
      if (a >= 0 && allow[a] & bit && right[a] === l && nc < dist[a] - 0.05) {
        dist[a] = nc;
        flag[a] = FLAG_RIGHT;
        heap.push(nc, a);
      }
      const b = right[l];
      if (b >= 0 && allow[b] & bit && left[b] === l && nc < dist[b] - 0.05) {
        dist[b] = nc;
        flag[b] = FLAG_LEFT;
        heap.push(nc, b);
      }
    }
    const base = row * g.n;
    table.cost.set(dist, base);
    table.flag.set(flag, base);
  }
}
