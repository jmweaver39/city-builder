/**
 * The physical railway, derived from the road network. The lane graph is one-way
 * per lane, but steel is not: a train can run either way over any rails. So this
 * folds rail lanes back into pieces of track that join at vertices, with a state
 * for each way along each piece.
 *
 * Pieces are grouped into blocks, the unit of signalling. Any two pieces that could
 * foul each other share a block, so two trains in different blocks can never touch.
 * The graph is rebuilt from scratch on any rail edit and holds no train state.
 */
import { cubicPoint, type Cubic } from '../core/bezier';
import { trackOffsets, trackOfLane, trackSpec } from '../core/railTypes';
import type { RoadNetwork } from '../core/RoadNetwork';
import type { GLane, Id, LaneGraph, RoadTypeDef, Vec3 } from '../core/types';
import {
  BLOCK_LENGTH,
  CROSSOVER_GAP,
  CROSSOVER_LENGTH,
  CURVE_ACCEL,
  FOUL_DISTANCE,
  FOUL_HEADROOM,
  MIN_PIECE,
  SWITCH_SPEED,
} from './constants';

export interface TrackPiece {
  id: number;
  kind: 'run' | 'link' | 'crossover';
  /** Run pieces: the segment and track. Otherwise -1. */
  segmentId: Id;
  track: number;
  /** Link pieces: the node. Otherwise -1. */
  nodeId: Id;
  pts: Float32Array;
  cum: Float32Array;
  length: number;
  /** m/s, with curves taken into account. */
  speed: number;
  v0: number;
  v1: number;
  /** Way traffic normally runs: 1 v0 to v1, -1 back, 0 either. */
  normal: 1 | -1 | 0;
  block: number;
  metro: boolean;
  electrified: boolean;
  thirdRail: boolean;
  /** Tightest radius, metres. */
  radius: number;
}

export interface TrackBlock {
  id: number;
  pieces: number[];
  length: number;
  /** Plain track a train may stand on without being in anyone's way at a junction. */
  plain: boolean;
  /** Level crossing index, or -1. */
  crossing: number;
}

/** Where a train can stop for a station: one spot per track. */
export interface StationStop {
  piece: number;
  /** Along the piece from v0. */
  s: number;
  track: number;
}

export interface StationPlace {
  id: Id;
  name: string;
  kind: 'surface' | 'underground' | 'gateway';
  segmentId: Id;
  center: Vec3;
  platformLength: number;
  stops: StationStop[];
  /** Centreline of each platform track, for meshing. */
  spans: Float32Array[];
}

export interface LevelCrossing {
  nodeId: Id;
  pos: Vec3;
  pieces: number[];
  /** Dense lane indices of the road connectors a train closes. */
  roadLanes: number[];
  /** Unit horizontal directions of the road arms, away from the node. */
  roadArms: { dir: Vec3; halfWidth: number; centre: Vec3 }[];
  /** Half the width of the track across the crossing. */
  trackHalf: number;
}

/** A place where the track stops. */
export interface TrackEnd {
  pos: Vec3;
  /** Unit direction leaving the end, off the track. */
  dir: Vec3;
  nodeId: Id;
  gateway: boolean;
}

interface Run {
  seg: Id;
  track: number;
  def: RoadTypeDef;
  pts: Float32Array;
  cum: Float32Array;
  length: number;
  speed: number;
}

function polyLength(pts: ArrayLike<number>): Float32Array {
  const n = pts.length / 3;
  const cum = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
  }
  return cum;
}

function reversed(pts: Float32Array): Float32Array {
  const n = pts.length / 3;
  const out = new Float32Array(pts.length);
  for (let i = 0; i < n; i++) {
    out[i * 3] = pts[(n - 1 - i) * 3];
    out[i * 3 + 1] = pts[(n - 1 - i) * 3 + 1];
    out[i * 3 + 2] = pts[(n - 1 - i) * 3 + 2];
  }
  return out;
}

function pointOn(pts: Float32Array, cum: Float32Array, s: number): Vec3 {
  const n = cum.length;
  const u = Math.max(0, Math.min(cum[n - 1], s));
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (cum[m] <= u) lo = m;
    else hi = m;
  }
  const span = cum[hi] - cum[lo];
  const f = span > 1e-6 ? (u - cum[lo]) / span : 0;
  return {
    x: pts[lo * 3] + (pts[hi * 3] - pts[lo * 3]) * f,
    y: pts[lo * 3 + 1] + (pts[hi * 3 + 1] - pts[lo * 3 + 1]) * f,
    z: pts[lo * 3 + 2] + (pts[hi * 3 + 2] - pts[lo * 3 + 2]) * f,
  };
}

/** The stretch between two distances, with exact ends. */
function slice(pts: Float32Array, cum: Float32Array, s0: number, s1: number): { pts: Float32Array; cum: Float32Array } {
  const out: number[] = [];
  const a = pointOn(pts, cum, s0);
  out.push(a.x, a.y, a.z);
  for (let i = 0; i < cum.length; i++) {
    if (cum[i] > s0 + 1e-3 && cum[i] < s1 - 1e-3) out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
  }
  const b = pointOn(pts, cum, s1);
  out.push(b.x, b.y, b.z);
  const p = Float32Array.from(out);
  return { pts: p, cum: polyLength(p) };
}

/** Least radius of a polyline, measured over chords of at least `window` metres. */
function tightestRadius(pts: Float32Array, cum: Float32Array, window = 8): number {
  const n = cum.length;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    let a = i;
    while (a > 0 && cum[i] - cum[a] < window) a--;
    let b = i;
    while (b < n - 1 && cum[b] - cum[i] < window) b++;
    if (a === i || b === i) continue;
    const ax = pts[i * 3] - pts[a * 3];
    const az = pts[i * 3 + 2] - pts[a * 3 + 2];
    const bx = pts[b * 3] - pts[i * 3];
    const bz = pts[b * 3 + 2] - pts[i * 3 + 2];
    const turn = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
    const ds = (cum[b] - cum[a]) / 2;
    if (turn > 1e-5) best = Math.min(best, ds / turn);
  }
  return best;
}

class Disjoint {
  parent: number[] = [];

  add(): number {
    this.parent.push(this.parent.length);
    return this.parent.length - 1;
  }

  find(a: number): number {
    const p = this.parent;
    while (p[a] !== a) {
      p[a] = p[p[a]];
      a = p[a];
    }
    return a;
  }

  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }
}

/** Offset of `a` in the direction of travel out of the piece end. */
function exitTangent(p: TrackPiece, forward: boolean): Vec3 {
  const { pts, cum, length } = p;
  const span = Math.min(6, length);
  const a = pointOn(pts, cum, forward ? length - span : span);
  const b = pointOn(pts, cum, forward ? length : 0);
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / l, y: 0, z: (b.z - a.z) / l };
}

function entryTangent(p: TrackPiece, forward: boolean, reach = 6): Vec3 {
  const { pts, cum, length } = p;
  const span = Math.min(reach, length);
  const a = pointOn(pts, cum, forward ? 0 : length);
  const b = pointOn(pts, cum, forward ? span : length - span);
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / l, y: 0, z: (b.z - a.z) / l };
}

export class TrackGraph {
  pieces: TrackPiece[] = [];
  blocks: TrackBlock[] = [];
  /** Per state: the states a train can run into. Rightmost first. */
  next: number[][] = [];
  /** Per state: the states that lead into it. */
  prev: number[][] = [];
  stations = new Map<Id, StationPlace>();
  crossings: LevelCrossing[] = [];
  ends: TrackEnd[] = [];
  /** Segments with track, to spot edits that matter. */
  readonly segments = new Set<Id>();
  private hash = new Map<number, number[]>();
  private readonly cell = 40;

  get empty(): boolean {
    return this.pieces.length === 0;
  }

  /** Nearest track to a point, in plan with a height check. */
  nearest(pos: Vec3, maxDistance: number): { piece: number; s: number; distance: number } | null {
    const r = Math.ceil(maxDistance / this.cell);
    const cx = Math.floor(pos.x / this.cell);
    const cz = Math.floor(pos.z / this.cell);
    let best: { piece: number; s: number; distance: number } | null = null;
    const seen = new Set<number>();
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const list = this.hash.get(hashKey(cx + i, cz + j));
        if (!list) continue;
        for (const id of list) {
          if (seen.has(id)) continue;
          seen.add(id);
          const hit = projectOnto(this.pieces[id], pos);
          if (hit.distance > maxDistance || Math.abs(hit.y - pos.y) > 3) continue;
          if (!best || hit.distance < best.distance) best = { piece: id, s: hit.s, distance: hit.distance };
        }
      }
    }
    return best;
  }

  /** @internal */
  index(): void {
    const seen = new Set<number>();
    for (const p of this.pieces) {
      seen.clear();
      for (let s = 0; ; s += 16) {
        const u = Math.min(s, p.length);
        const q = pointOn(p.pts, p.cum, u);
        const key = hashKey(Math.floor(q.x / this.cell), Math.floor(q.z / this.cell));
        if (!seen.has(key)) {
          seen.add(key);
          const list = this.hash.get(key);
          if (list) list.push(p.id);
          else this.hash.set(key, [p.id]);
        }
        if (u >= p.length) break;
      }
    }
  }
}

function hashKey(cx: number, cz: number): number {
  return (cx + 4096) * 8192 + (cz + 4096);
}

/** Closest point on a piece, in plan view. */
export function projectOnto(p: TrackPiece, pos: Vec3): { s: number; distance: number; y: number } {
  const { pts, cum } = p;
  let bestD = Infinity;
  let bestS = 0;
  let bestY = 0;
  for (let i = 0; i + 1 < cum.length; i++) {
    const ax = pts[i * 3];
    const az = pts[i * 3 + 2];
    const dx = pts[i * 3 + 3] - ax;
    const dz = pts[i * 3 + 5] - az;
    const l2 = dx * dx + dz * dz;
    const u = l2 > 1e-9 ? Math.max(0, Math.min(1, ((pos.x - ax) * dx + (pos.z - az) * dz) / l2)) : 0;
    const d = Math.hypot(ax + dx * u - pos.x, az + dz * u - pos.z);
    if (d < bestD) {
      bestD = d;
      bestS = cum[i] + (cum[i + 1] - cum[i]) * u;
      bestY = pts[i * 3 + 1] + (pts[i * 3 + 4] - pts[i * 3 + 1]) * u;
    }
  }
  return { s: bestS, distance: bestD, y: bestY };
}

/** Pieces of a state list as a continuous polyline. Used for platforms and overlays. */
function stationPoint(net: RoadNetwork, segmentId: Id, t: number): Vec3 {
  return cubicPoint(net.cubicOf(segmentId), Math.max(0, Math.min(1, t)));
}

interface Crossover {
  seg: Id;
  f0: number;
  f1: number;
}

/** Stations that end a line, where trains turn back and need a way across. */
function turnbackStations(net: RoadNetwork): Set<Id> {
  const out = new Set<Id>();
  for (const line of net.rail.lines) {
    if (line.stops.length === 0) continue;
    out.add(line.stops[0]);
    out.add(line.stops[line.stops.length - 1]);
  }
  return out;
}

export function buildTrackGraph(net: RoadNetwork): TrackGraph {
  const g = new TrackGraph();
  const graph = net.laneGraph;
  const runs: Run[] = [];
  const runAt = new Map<string, Run>();

  // Fold lanes into tracks. Everything runs a to b from here on.
  for (const seg of net.segments) {
    const def = net.roadTypeOf(seg.id);
    if (def.category !== 'rail') continue;
    g.segments.add(seg.id);
    const dense = graph.roadLanes.get(seg.id);
    if (!dense) continue;
    const tracks = trackOffsets(def).length;
    for (let track = 0; track < tracks; track++) {
      const laneIndex = tracks === 1 ? 1 : track;
      const idx = dense[laneIndex];
      if (idx === undefined || idx < 0) continue;
      const lane = graph.lanes[idx];
      const pts = def.lanes[laneIndex].dir === 1 ? lane.pts : reversed(lane.pts);
      const run: Run = { seg: seg.id, track, def, pts, cum: polyLength(pts), length: lane.length, speed: lane.speed };
      runs.push(run);
      runAt.set(`${seg.id}:${track}`, run);
    }
  }
  if (!runs.length) return g;

  // Work out where each segment is cut: at platforms and crossovers first.
  const cuts = new Map<Id, number[]>();
  const crossovers: Crossover[] = [];
  const turnback = turnbackStations(net);
  const addCut = (seg: Id, f: number) => {
    const list = cuts.get(seg);
    if (list) list.push(f);
    else cuts.set(seg, [f]);
  };
  const centerFraction = new Map<Id, number>();
  for (const st of net.rail.stations) {
    const run = runAt.get(`${st.segmentId}:0`);
    if (!run) continue;
    const def = run.def;
    const p = stationPoint(net, st.segmentId, st.t);
    const hit = projectOnto(asPiece(run), p);
    const c = hit.s / run.length;
    centerFraction.set(st.id, c);
    if (st.kind === 'gateway') continue;
    const half = st.platformLength / 2 / run.length;
    for (const f of [c - half, c + half]) {
      if (f * run.length > MIN_PIECE / 2 && (1 - f) * run.length > MIN_PIECE / 2) addCut(st.segmentId, f);
    }
    if (trackOffsets(def).length === 2 && turnback.has(st.id)) {
      const gap = (st.platformLength / 2 + CROSSOVER_GAP) / run.length;
      const span = CROSSOVER_LENGTH / run.length;
      const margin = 25 / run.length;
      for (const [f0, f1] of [
        [c - gap - span, c - gap],
        [c + gap, c + gap + span],
      ]) {
        if (f0 < margin || f1 > 1 - margin) continue;
        crossovers.push({ seg: st.segmentId, f0, f1 });
        addCut(st.segmentId, f0);
        addCut(st.segmentId, f1);
      }
    }
  }

  const uf = new Disjoint();
  const ports = new Map<string, number>();
  const port = (seg: Id, track: number, end: 'a' | 'b'): number => {
    const key = `${seg}:${track}:${end}`;
    let v = ports.get(key);
    if (v === undefined) {
      v = uf.add();
      ports.set(key, v);
    }
    return v;
  };
  const cutVertex = new Map<string, number>();

  const addPiece = (init: Omit<TrackPiece, 'id' | 'length' | 'block' | 'radius'>): TrackPiece => {
    const length = init.cum[init.cum.length - 1];
    const radius = tightestRadius(init.pts, init.cum);
    const piece: TrackPiece = { ...init, id: g.pieces.length, length, block: -1, radius };
    if (init.kind === 'run') piece.speed = Math.min(piece.speed, Math.sqrt(CURVE_ACCEL * radius));
    g.pieces.push(piece);
    return piece;
  };

  // Cut each track into pieces.
  for (const run of runs) {
    const { seg, track, def } = run;
    const fixed = (cuts.get(seg) ?? []).filter((f) => f > 0 && f < 1).sort((a, b) => a - b);
    const blocks = Math.max(1, Math.round(run.length / BLOCK_LENGTH));
    const all = [...fixed];
    for (let i = 1; i < blocks; i++) {
      const f = i / blocks;
      if (fixed.every((x) => Math.abs(x - f) * run.length > MIN_PIECE)) all.push(f);
    }
    all.sort((a, b) => a - b);
    const fractions = [0];
    for (const f of all) {
      if ((f - fractions[fractions.length - 1]) * run.length > 1) fractions.push(f);
    }
    fractions.push(1);
    const spec = trackSpec(def.id)!;
    const normal: 1 | -1 | 0 = trackOffsets(def).length === 1 ? 0 : def.lanes[track].dir;
    let prevVertex = port(seg, track, 'a');
    for (let i = 0; i + 1 < fractions.length; i++) {
      const nextVertex = i + 2 === fractions.length ? port(seg, track, 'b') : uf.add();
      if (i + 2 !== fractions.length) cutVertex.set(`${seg}:${track}:${fractions[i + 1]}`, nextVertex);
      const part = slice(run.pts, run.cum, fractions[i] * run.length, fractions[i + 1] * run.length);
      addPiece({
        kind: 'run',
        segmentId: seg,
        track,
        nodeId: -1,
        pts: part.pts,
        cum: part.cum,
        speed: run.speed,
        v0: prevVertex,
        v1: nextVertex,
        normal,
        metro: spec.metro,
        electrified: spec.electrified,
        thirdRail: spec.thirdRail,
      });
      prevVertex = nextVertex;
    }
  }

  // Scissors crossovers, between tracks at the cuts just made.
  for (const x of crossovers) {
    const left = runAt.get(`${x.seg}:0`)!;
    const right = runAt.get(`${x.seg}:1`)!;
    const spec = trackSpec(left.def.id)!;
    for (const [from, to] of [
      [left, right],
      [right, left],
    ]) {
      const v0 = cutVertex.get(`${x.seg}:${from.track}:${x.f0}`);
      const v1 = cutVertex.get(`${x.seg}:${to.track}:${x.f1}`);
      if (v0 === undefined || v1 === undefined) continue;
      const p0 = pointOn(from.pts, from.cum, x.f0 * from.length);
      const p3 = pointOn(to.pts, to.cum, x.f1 * to.length);
      const t0 = pointOn(from.pts, from.cum, x.f0 * from.length + 8);
      const t3 = pointOn(to.pts, to.cum, x.f1 * to.length - 8);
      const k = CROSSOVER_LENGTH / 3 / 8;
      const c: Cubic = {
        p0,
        p1: { x: p0.x + (t0.x - p0.x) * k, y: p0.y + (t0.y - p0.y) * k, z: p0.z + (t0.z - p0.z) * k },
        p2: { x: p3.x + (t3.x - p3.x) * k, y: p3.y + (t3.y - p3.y) * k, z: p3.z + (t3.z - p3.z) * k },
        p3,
      };
      const out: number[] = [];
      for (let i = 0; i <= 14; i++) {
        const q = cubicPoint(c, i / 14);
        out.push(q.x, q.y, q.z);
      }
      const pts = Float32Array.from(out);
      addPiece({
        kind: 'crossover',
        segmentId: -1,
        track: 0,
        nodeId: -1,
        pts,
        cum: polyLength(pts),
        speed: SWITCH_SPEED,
        v0,
        v1,
        normal: 0,
        metro: spec.metro,
        electrified: spec.electrified,
        thirdRail: spec.thirdRail,
      });
    }
  }

  // Links through nodes, from the lane graph's connectors and joints.
  const linkKey = new Map<string, TrackPiece>();
  const portOf = (lane: GLane, arriving: boolean): number => {
    const def = net.roadTypeOf(lane.segmentId);
    const dir = def.lanes[lane.laneIndex].dir;
    const end: 'a' | 'b' = arriving === (dir === 1) ? 'b' : 'a';
    return port(lane.segmentId, trackOfLane(def, lane.laneIndex), end);
  };
  for (const lane of graph.lanes) {
    if (lane.vehicleKind !== 'rail') continue;
    if (lane.kind === 'connector') {
      const v0 = portOf(graph.lanes[lane.fromLane], true);
      const v1 = portOf(graph.lanes[lane.toLane], false);
      const key = v0 < v1 ? `${v0}-${v1}` : `${v1}-${v0}`;
      const same = linkKey.get(key);
      if (same) {
        same.normal = 0;
        continue;
      }
      const seg = graph.lanes[lane.fromLane].segmentId;
      const spec = trackSpec(net.roadTypeOf(seg).id)!;
      const pts = Float32Array.from(lane.pts);
      const piece = addPiece({
        kind: 'link',
        segmentId: -1,
        track: 0,
        nodeId: lane.nodeId,
        pts,
        cum: polyLength(pts),
        speed: lane.speed,
        v0,
        v1,
        normal: 1,
        metro: spec.metro,
        electrified: spec.electrified,
        thirdRail: spec.thirdRail,
      });
      linkKey.set(key, piece);
    } else {
      for (const j of lane.next) {
        const other = graph.lanes[j];
        if (other.kind === 'road' && other.vehicleKind === 'rail') uf.union(portOf(lane, true), portOf(other, false));
      }
    }
  }

  for (const p of g.pieces) {
    p.v0 = uf.find(p.v0);
    p.v1 = uf.find(p.v1);
  }

  buildAdjacency(g);
  buildCrossings(net, g, graph);
  buildBlocks(net, g);
  buildStations(net, g, centerFraction);
  buildEnds(net, g);
  g.index();
  return g;
}

function asPiece(run: Run): TrackPiece {
  return { pts: run.pts, cum: run.cum, length: run.length } as TrackPiece;
}

function buildAdjacency(g: TrackGraph): void {
  const at = new Map<number, number[]>();
  const push = (v: number, state: number) => {
    const list = at.get(v);
    if (list) list.push(state);
    else at.set(v, [state]);
  };
  // A state leaves vertex v when it enters its piece at v.
  for (const p of g.pieces) {
    push(p.v0, p.id * 2);
    push(p.v1, p.id * 2 + 1);
  }
  g.next = new Array(g.pieces.length * 2);
  g.prev = new Array(g.pieces.length * 2);
  for (let s = 0; s < g.next.length; s++) {
    g.next[s] = [];
    g.prev[s] = [];
  }
  for (const p of g.pieces) {
    for (const forward of [true, false]) {
      const state = p.id * 2 + (forward ? 0 : 1);
      const v = forward ? p.v1 : p.v0;
      const heading = exitTangent(p, forward);
      const rightX = -heading.z;
      const rightZ = heading.x;
      const scored: { state: number; right: number }[] = [];
      for (const out of at.get(v) ?? []) {
        if (out >> 1 === p.id) continue;
        const q = g.pieces[out >> 1];
        const fwd = (out & 1) === 0;
        const t = entryTangent(q, fwd);
        // Through the frog only: a train cannot switch back from branch to branch.
        if (t.x * heading.x + t.z * heading.z < 0.4) continue;
        const far = entryTangent(q, fwd, 40);
        scored.push({ state: out, right: far.x * rightX + far.z * rightZ });
      }
      scored.sort((a, b) => b.right - a.right);
      g.next[state] = scored.map((x) => x.state);
    }
  }
  for (let s = 0; s < g.next.length; s++) for (const n of g.next[s]) g.prev[n].push(s);
}

function buildCrossings(net: RoadNetwork, g: TrackGraph, graph: LaneGraph): void {
  const byNode = new Map<Id, number[]>();
  for (const p of g.pieces) {
    if (p.kind !== 'link') continue;
    const list = byNode.get(p.nodeId);
    if (list) list.push(p.id);
    else byNode.set(p.nodeId, [p.id]);
  }
  for (const node of net.nodes) {
    const defs = node.segments.map((s) => net.roadTypeOf(s));
    const rail = defs.filter((d) => d.category === 'rail');
    if (!rail.length || rail.length === defs.length) continue;
    const pieces = byNode.get(node.id) ?? [];
    const roadLanes: number[] = [];
    for (const idx of graph.connectorsAt.get(node.id) ?? []) {
      if (graph.lanes[idx].vehicleKind !== 'rail') roadLanes.push(idx);
    }
    const geom = net.nodeGeom(node.id);
    const roadArms: LevelCrossing['roadArms'] = [];
    let trackHalf = 2;
    for (const arm of geom?.arms ?? []) {
      const def = net.roadTypeOf(arm.segmentId);
      if (def.category === 'rail') trackHalf = Math.max(trackHalf, def.halfWidth);
      else roadArms.push({ dir: arm.cutDir, halfWidth: def.halfWidth + def.sidewalk, centre: arm.centre });
    }
    g.crossings.push({ nodeId: node.id, pos: { ...node.pos }, pieces, roadLanes, roadArms, trackHalf });
  }
}

function buildBlocks(net: RoadNetwork, g: TrackGraph): void {
  const uf = new Disjoint();
  for (let i = 0; i < g.pieces.length; i++) uf.add();

  // Pieces of a switch or crossover that meet share a block.
  const atVertex = new Map<number, number[]>();
  const note = (v: number, id: number) => {
    const l = atVertex.get(v);
    if (l) l.push(id);
    else atVertex.set(v, [id]);
  };
  for (const p of g.pieces) {
    if (p.kind === 'run') continue;
    note(p.v0, p.id);
    note(p.v1, p.id);
  }
  for (const list of atVertex.values()) for (let i = 1; i < list.length; i++) uf.union(list[0], list[i]);

  // Anything else close enough to foul. Samples beside a shared vertex do not count.
  const SAMPLE = 4;
  const CELL = FOUL_DISTANCE;
  const grid = new Map<number, { piece: number; x: number; y: number; z: number; s: number }[]>();
  for (const p of g.pieces) {
    const steps = Math.max(1, Math.ceil(p.length / SAMPLE));
    for (let i = 0; i <= steps; i++) {
      const s = (p.length * i) / steps;
      const q = pointOn(p.pts, p.cum, s);
      const key = hashKey(Math.floor(q.x / CELL), Math.floor(q.z / CELL));
      const list = grid.get(key);
      const entry = { piece: p.id, x: q.x, y: q.y, z: q.z, s };
      if (list) list.push(entry);
      else grid.set(key, [entry]);
    }
  }
  const nearVertex = (p: TrackPiece, s: number, v: number): boolean => (p.v0 === v && s < 12) || (p.v1 === v && p.length - s < 12);
  for (const [key, list] of grid) {
    const cx = Math.floor(key / 8192) - 4096;
    const cz = key % 8192 - 4096;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const other = grid.get(hashKey(cx + i, cz + j));
        if (!other) continue;
        for (const a of list) {
          for (const b of other) {
            if (b.piece <= a.piece) continue;
            if (uf.find(a.piece) === uf.find(b.piece)) continue;
            if (Math.abs(a.y - b.y) > FOUL_HEADROOM) continue;
            if (Math.hypot(a.x - b.x, a.z - b.z) >= FOUL_DISTANCE) continue;
            const pa = g.pieces[a.piece];
            const pb = g.pieces[b.piece];
            const shared =
              ((pa.v0 === pb.v0 || pa.v0 === pb.v1) && nearVertex(pa, a.s, pa.v0) && nearVertex(pb, b.s, pa.v0)) ||
              ((pa.v1 === pb.v0 || pa.v1 === pb.v1) && nearVertex(pa, a.s, pa.v1) && nearVertex(pb, b.s, pa.v1));
            if (!shared) uf.union(a.piece, b.piece);
          }
        }
      }
    }
  }

  const ids = new Map<number, TrackBlock>();
  for (const p of g.pieces) {
    const root = uf.find(p.id);
    let block = ids.get(root);
    if (!block) {
      block = { id: g.blocks.length, pieces: [], length: 0, plain: true, crossing: -1 };
      ids.set(root, block);
      g.blocks.push(block);
    }
    block.pieces.push(p.id);
    block.length = Math.max(block.length, p.length);
    p.block = block.id;
  }
  for (const b of g.blocks) {
    if (b.pieces.length > 1) b.plain = false;
    else if (g.pieces[b.pieces[0]].kind !== 'run') {
      // A lone link is plain track unless a switch feeds it.
      b.plain = true;
    }
  }
  g.crossings.forEach((c, i) => {
    for (const id of c.pieces) {
      const b = g.blocks[g.pieces[id].block];
      b.crossing = i;
      b.plain = false;
    }
  });
}

function buildStations(net: RoadNetwork, g: TrackGraph, fractions: Map<Id, number>): void {
  for (const st of net.rail.stations) {
    if (!fractions.has(st.id)) continue;
    const center = stationPoint(net, st.segmentId, st.t);
    const stops: StationStop[] = [];
    const spans: Float32Array[] = [];
    const list = g.pieces.filter((p) => p.segmentId === st.segmentId);
    for (const track of [0, 1]) {
      const pieces = list.filter((p) => p.track === track);
      let best: StationStop | null = null;
      let bestD = Infinity;
      for (const p of pieces) {
        const hit = projectOnto(p, center);
        if (hit.distance < bestD) {
          bestD = hit.distance;
          best = { piece: p.id, s: hit.s, track };
        }
      }
      if (!best) continue;
      stops.push(best);
      spans.push(platformSpan(g, best, st.platformLength));
    }
    g.stations.set(st.id, {
      id: st.id,
      name: st.name,
      kind: st.kind,
      segmentId: st.segmentId,
      center,
      platformLength: st.platformLength,
      stops,
      spans,
    });
  }
}

/** Walk half a platform each way from the centre, through any plain joints. */
function platformSpan(g: TrackGraph, stop: StationStop, length: number): Float32Array {
  const walk = (forward: boolean): number[] => {
    const out: number[] = [];
    let piece = g.pieces[stop.piece];
    let dir = forward;
    let from = stop.s;
    let left = length / 2;
    for (let guard = 0; guard < 40 && left > 0.01; guard++) {
      const room = dir ? piece.length - from : from;
      const take = Math.min(room, left);
      const steps = Math.max(1, Math.ceil(take / 8));
      for (let i = 1; i <= steps; i++) {
        const q = pointOn(piece.pts, piece.cum, from + ((dir ? 1 : -1) * take * i) / steps);
        out.push(q.x, q.y, q.z);
      }
      left -= take;
      if (left <= 0.01) break;
      const state = piece.id * 2 + (dir ? 0 : 1);
      const n = g.next[state][0];
      if (n === undefined) break;
      piece = g.pieces[n >> 1];
      dir = (n & 1) === 0;
      from = dir ? 0 : piece.length;
    }
    return out;
  };
  const piece = g.pieces[stop.piece];
  const mid = pointOn(piece.pts, piece.cum, stop.s);
  const fwd = walk(true);
  const back = walk(false);
  const out: number[] = [];
  for (let i = back.length - 3; i >= 0; i -= 3) out.push(back[i], back[i + 1], back[i + 2]);
  out.push(mid.x, mid.y, mid.z);
  out.push(...fwd);
  return Float32Array.from(out);
}

function buildEnds(net: RoadNetwork, g: TrackGraph): void {
  const gateways = new Set<number>();
  for (const st of g.stations.values()) {
    if (st.kind !== 'gateway') continue;
    for (const stop of st.stops) gateways.add(stop.piece);
  }
  for (const p of g.pieces) {
    if (p.kind !== 'run') continue;
    for (const forward of [true, false]) {
      const state = p.id * 2 + (forward ? 0 : 1);
      if (g.next[state].length) continue;
      const at = pointOn(p.pts, p.cum, forward ? p.length : 0);
      const seg = net.getSegment(p.segmentId)!;
      g.ends.push({ pos: at, dir: exitTangent(p, forward), nodeId: forward ? seg.b : seg.a, gateway: gateways.has(p.id) });
    }
  }
}
