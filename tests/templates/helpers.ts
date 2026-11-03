/**
 * Checks shared by the template tests. Nothing here knows how a template is built:
 * everything is measured on the stamped network, the way the sim will see it.
 */
import {
  GRADE_CLEARANCE,
  MAX_TRIM,
  RoadNetwork,
  cubicPoint,
  maxGrade,
  totalHalfWidth,
  type Id,
  type LaneGraph,
  type Vec3,
} from '../../src/core';
import type { StampResult, StampedPort } from '../../src/templates';

export function portNamed(result: StampResult, name: string): StampedPort {
  const p = result.ports.find((x) => x.name === name);
  if (!p) throw new Error(`No port ${name}; have ${result.ports.map((x) => x.name).join(', ')}`);
  return p;
}

/** Driving lanes leaving a port node into the network. */
export function entryLanes(net: RoadNetwork, nodeId: Id): number[] {
  const graph = net.laneGraph;
  const out: number[] = [];
  for (const segId of net.getNode(nodeId)!.segments) {
    const seg = net.getSegment(segId)!;
    const def = net.roadTypeOf(segId);
    const lanes = graph.roadLanes.get(segId) ?? [];
    def.lanes.forEach((l, i) => {
      if (l.kind === 'drive' && lanes[i] >= 0 && (seg.a === nodeId ? l.dir === 1 : l.dir === -1)) out.push(lanes[i]);
    });
  }
  return out;
}

/** Driving lanes arriving at a port node. */
export function exitLanes(net: RoadNetwork, nodeId: Id): number[] {
  const graph = net.laneGraph;
  const out: number[] = [];
  for (const segId of net.getNode(nodeId)!.segments) {
    const seg = net.getSegment(segId)!;
    const def = net.roadTypeOf(segId);
    const lanes = graph.roadLanes.get(segId) ?? [];
    def.lanes.forEach((l, i) => {
      if (l.kind === 'drive' && lanes[i] >= 0 && (seg.b === nodeId ? l.dir === 1 : l.dir === -1)) out.push(lanes[i]);
    });
  }
  return out;
}

/** Lanes reachable from a start lane. Lane changes count, as the sim makes them. */
export function reachable(graph: LaneGraph, starts: readonly number[]): Set<number> {
  const seen = new Set<number>(starts);
  const stack = [...starts];
  while (stack.length) {
    const lane = graph.lanes[stack.pop()!];
    const nexts = [...lane.next];
    if (lane.left >= 0) nexts.push(lane.left);
    if (lane.right >= 0) nexts.push(lane.right);
    for (const n of nexts) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen;
}

/** Lane-graph movements a template should serve that it does not. */
export function missingMovements(net: RoadNetwork, result: StampResult, movements: readonly (readonly [string, string])[]): string[] {
  const graph = net.laneGraph;
  const missing: string[] = [];
  for (const [from, to] of movements) {
    const starts = entryLanes(net, portNamed(result, from).nodeId);
    const ends = exitLanes(net, portNamed(result, to).nodeId);
    if (!starts.length) {
      missing.push(`${from} has no entry lanes`);
      continue;
    }
    if (!ends.length) {
      missing.push(`${to} has no exit lanes`);
      continue;
    }
    // Every entry lane must get there: a lane change is fine, a dead lane is not.
    for (const s of starts) {
      const seen = reachable(graph, [s]);
      if (!ends.some((e) => seen.has(e))) {
        missing.push(`${from} -> ${to} from lane ${graph.lanes[s].key}`);
      }
    }
  }
  return missing;
}

interface RibbonSample {
  seg: Id;
  pos: Vec3;
  tx: number;
  tz: number;
  half: number;
}

function ribbon(net: RoadNetwork, seg: Id, step: number): RibbonSample[] {
  const geom = net.segmentGeom(seg)!;
  const half = net.roadTypeOf(seg).halfWidth;
  const out: RibbonSample[] = [];
  const st = geom.stations;
  for (let i = 0; i + 1 < st.length; i++) {
    const a = st[i];
    const b = st[i + 1];
    const d = Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 0; k <= (i + 2 === st.length ? n : n - 1); k++) {
      const f = k / n;
      const pos = {
        x: a.pos.x + (b.pos.x - a.pos.x) * f,
        y: a.pos.y + (b.pos.y - a.pos.y) * f,
        z: a.pos.z + (b.pos.z - a.pos.z) * f,
      };
      const tx = a.tangent.x + (b.tangent.x - a.tangent.x) * f;
      const tz = a.tangent.z + (b.tangent.z - a.tangent.z) * f;
      const l = Math.hypot(tx, tz) || 1;
      out.push({ seg, pos, tx: tx / l, tz: tz / l, half });
    }
  }
  return out;
}

/**
 * Places where two road surfaces overlap in plan with too little height between
 * them. Surfaces meeting at a junction are trimmed clear of each other, so a real
 * junction never shows up here; neither does the joint between two lengths of the
 * same road.
 */
export function clearanceViolations(net: RoadNetwork, tolerance = 0.3): string[] {
  const step = 3;
  const cell = 24;
  const grid = new Map<string, RibbonSample[]>();
  const keyOf = (x: number, z: number) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  const all: RibbonSample[] = [];
  for (const s of net.segments) {
    for (const r of ribbon(net, s.id, step)) {
      all.push(r);
      const k = keyOf(r.pos.x, r.pos.z);
      const list = grid.get(k);
      if (list) list.push(r);
      else grid.set(k, [r]);
    }
  }
  const plain = new Map<Id, Set<Id>>();
  for (const n of net.nodes) {
    if (net.nodeGeom(n.id)?.kind !== 'plain') continue;
    const [a, b] = n.segments;
    if (!plain.has(a)) plain.set(a, new Set());
    if (!plain.has(b)) plain.set(b, new Set());
    plain.get(a)!.add(b);
    plain.get(b)!.add(a);
  }
  const problems = new Set<string>();
  for (const q of all) {
    // Walk across the road: the centre and the two edges.
    const rx = -q.tz;
    const rz = q.tx;
    for (const k of [-1, -0.5, 0, 0.5, 1]) {
      const px = q.pos.x + rx * q.half * k;
      const pz = q.pos.z + rz * q.half * k;
      const cx = Math.floor(px / cell);
      const cz = Math.floor(pz / cell);
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          for (const p of grid.get(`${cx + i},${cz + j}`) ?? []) {
            if (p.seg <= q.seg) continue;
            if (plain.get(q.seg)?.has(p.seg)) continue;
            if (Math.abs(p.pos.y - q.pos.y) >= GRADE_CLEARANCE - 1e-3) continue;
            const dx = px - p.pos.x;
            const dz = pz - p.pos.z;
            const along = dx * p.tx + dz * p.tz;
            if (Math.abs(along) > step * 0.75) continue;
            const across = Math.abs(-dx * p.tz + dz * p.tx);
            if (across < p.half - tolerance) {
              problems.add(
                `${q.seg} (${net.getSegment(q.seg)!.roadType}) and ${p.seg} (${net.getSegment(p.seg)!.roadType}) ` +
                  `overlap near (${px.toFixed(0)}, ${pz.toFixed(0)}) with ${Math.abs(p.pos.y - q.pos.y).toFixed(1)} m between them`,
              );
            }
          }
        }
      }
    }
  }
  return [...problems];
}

/** Rebuild a network segment by segment, asking validateDraft about each as a draft. */
export function draftErrors(net: RoadNetwork): string[] {
  const check = new RoadNetwork();
  const ids = new Map<Id, Id>();
  check.batch(() => {
    for (const n of net.nodes) ids.set(n.id, check.addNode(n.pos));
  });
  for (const def of net.project.customRoadTypes) check.setCustomRoadType(def);
  const problems: string[] = [];
  for (const s of net.segments) {
    const issues = check.validateDraft({
      start: { kind: 'node', id: ids.get(s.a)! },
      end: { kind: 'node', id: ids.get(s.b)! },
      c1: s.c1,
      c2: s.c2,
      roadType: s.roadType,
    });
    for (const i of issues) {
      if (i.severity !== 'error') continue;
      const at = i.at ? ` at (${i.at.x.toFixed(0)}, ${i.at.z.toFixed(0)})` : '';
      problems.push(`${s.roadType} ${s.id}: ${i.code} ${i.message}${at}`);
    }
    check.addSegment(ids.get(s.a)!, ids.get(s.b)!, { c1: s.c1, c2: s.c2, roadType: s.roadType });
  }
  return problems;
}

export function steepest(net: RoadNetwork): { grade: number; seg: Id } {
  let worst = { grade: 0, seg: -1 };
  for (const s of net.segments) {
    const g = maxGrade(net.cubicOf(s.id), 48);
    if (g > worst.grade) worst = { grade: g, seg: s.id };
  }
  return worst;
}

/** Gores where the trim hit core's cap, which leaves two road surfaces overlapping. */
export function cappedTrims(net: RoadNetwork): string[] {
  const out: string[] = [];
  for (const n of net.nodes) {
    for (const arm of net.nodeGeom(n.id)?.arms ?? []) {
      if (arm.trim >= MAX_TRIM - 1e-6) out.push(`node ${n.id} arm ${arm.segmentId} trimmed by ${arm.trim.toFixed(1)}`);
    }
  }
  return out;
}

/** Segments whose trims were squeezed, which means a junction ran out of road. */
export function squeezedTrims(net: RoadNetwork): string[] {
  const out: string[] = [];
  for (const n of net.nodes) {
    const g = net.nodeGeom(n.id);
    if (!g || g.kind !== 'junction') continue;
    for (const arm of g.arms) {
      const seg = net.segmentGeom(arm.segmentId)!;
      if (seg.length < Math.max(2, 0.05 * seg.fullLength)) {
        out.push(`segment ${arm.segmentId} has only ${seg.length.toFixed(1)} m left of ${seg.fullLength.toFixed(1)}`);
      }
    }
  }
  return out;
}

export { cubicPoint, totalHalfWidth };

export interface MainWalk {
  /** Lanes in travel order. */
  lanes: number[];
  /** Junction events along the way, in order. */
  events: ('exit' | 'entry')[];
  /** The node the walk ended at. */
  end: Id;
  /** Smallest dot product of the direction of travel with the starting direction. */
  minDot: number;
}

function laneDirs(graph: LaneGraph, idx: number): { x: number; z: number }[] {
  const lane = graph.lanes[idx];
  const out: { x: number; z: number }[] = [];
  const n = lane.cum.length;
  for (let i = 0; i + 1 < n; i++) {
    const dx = lane.pts[(i + 1) * 3] - lane.pts[i * 3];
    const dz = lane.pts[(i + 1) * 3 + 2] - lane.pts[i * 3 + 2];
    const l = Math.hypot(dx, dz);
    if (l > 1e-6) out.push({ x: dx / l, z: dz / l });
  }
  return out;
}

/**
 * Drive the mainline from an entry stub to the end, keeping to the same road class
 * at every junction, and note what happens on the way.
 */
export function walkMainline(net: RoadNetwork, entry: Id): MainWalk {
  const graph = net.laneGraph;
  const typeOf = (lane: number) => net.getSegment(graph.lanes[lane].segmentId)!.roadType;
  const start = entryLanes(net, entry);
  let lane = start[Math.floor(start.length / 2)];
  const mainType = typeOf(lane);
  const family = /^highway/.test(mainType) ? /^highway/ : new RegExp(`^${mainType}$`);
  const first = laneDirs(graph, lane)[0];
  const lanes: number[] = [lane];
  const events: MainWalk['events'] = [];
  let minDot = 1;
  let end = entry;
  for (let guard = 0; guard < 4000; guard++) {
    for (const d of laneDirs(graph, lane)) minDot = Math.min(minDot, d.x * first.x + d.z * first.z);
    const cur = graph.lanes[lane];
    const seg = net.getSegment(cur.segmentId)!;
    const nodeId = seg.b;
    end = nodeId;
    const node = net.getNode(nodeId)!;
    if (node.segments.length === 3) {
      const other = node.segments.find((id) => id !== seg.id && !family.test(net.getSegment(id)!.roadType));
      if (other !== undefined) events.push(net.getSegment(other)!.a === nodeId ? 'exit' : 'entry');
    }
    // Next road lane on the main road, going through a connector if there is one.
    let next = -1;
    for (const n of cur.next) {
      const l = graph.lanes[n];
      const road = l.kind === 'connector' ? l.next[0] : n;
      if (!family.test(net.getSegment(graph.lanes[road].segmentId)!.roadType)) continue;
      next = n;
      break;
    }
    if (next < 0) break;
    const l = graph.lanes[next];
    if (l.kind === 'connector') {
      lanes.push(next);
      for (const d of laneDirs(graph, next)) minDot = Math.min(minDot, d.x * first.x + d.z * first.z);
      next = l.next[0];
    }
    lanes.push(next);
    lane = next;
  }
  return { lanes, events, end, minDot };
}

/** Lanes no vehicle can use: not reachable from any entry, or leading to no exit. */
export function deadLanes(net: RoadNetwork, result: StampResult): string[] {
  const graph = net.laneGraph;
  const starts = result.ports.flatMap((p) => (p.flow === 'out' ? [] : entryLanes(net, p.nodeId)));
  const ends = new Set(result.ports.flatMap((p) => (p.flow === 'in' ? [] : exitLanes(net, p.nodeId))));
  const fromEntry = reachable(graph, starts);
  const bad: string[] = [];
  for (const lane of graph.lanes) {
    if (lane.vehicleKind !== 'drive') continue;
    if (!fromEntry.has(lane.idx)) bad.push(`${lane.key} cannot be reached`);
    const on = reachable(graph, [lane.idx]);
    if (![...ends].some((e) => on.has(e))) bad.push(`${lane.key} leads nowhere`);
  }
  return bad;
}

/** Ramps meeting a highway from its left. Right-hand traffic never should. */
export function leftSideRamps(net: RoadNetwork): string[] {
  const bad: string[] = [];
  for (const n of net.nodes) {
    if (n.segments.length !== 3) continue;
    const geom = net.nodeGeom(n.id)!;
    const main = geom.arms.filter((a) => net.roadTypeOf(a.segmentId).category === 'highway');
    const ramps = geom.arms.filter((a) => net.roadTypeOf(a.segmentId).category === 'ramp');
    if (main.length !== 2 || ramps.length !== 1) continue;
    const arriving = main.find((a) => !a.atStart);
    if (!arriving) continue;
    // Direction of travel on the main road, and the right-hand side of it.
    const hx = -arriving.dir.x;
    const hz = -arriving.dir.z;
    const side = -hz * ramps[0].dir.x + hx * ramps[0].dir.z;
    if (side <= 0) bad.push(`ramp ${ramps[0].segmentId} meets the highway on its left at node ${n.id}`);
  }
  return bad;
}

/** Slowest connector on a walk. Metres per second. */
export function slowestConnector(net: RoadNetwork, lanes: readonly number[]): number {
  const graph = net.laneGraph;
  let worst = Infinity;
  for (const i of lanes) {
    const l = graph.lanes[i];
    if (l.kind === 'connector' && l.speed < worst) worst = l.speed;
  }
  return worst;
}

/** Bends in the plan at joints between lengths of the same road, and cubics that turn too far. */
export function roughJoints(net: RoadNetwork): string[] {
  const bad: string[] = [];
  const heading = (seg: Id, t: number) => {
    const c = net.cubicOf(seg);
    const a = cubicPoint(c, Math.max(0, t - 0.001));
    const b = cubicPoint(c, Math.min(1, t + 0.001));
    return { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  };
  const planAngle = (p: Vec3, q: Vec3) => {
    const dot = p.x * q.x + p.z * q.z;
    const cross = p.x * q.z - p.z * q.x;
    return Math.abs(Math.atan2(cross, dot));
  };
  for (const n of net.nodes) {
    if (n.segments.length !== 2) continue;
    const [a, b] = n.segments.map((id) => net.getSegment(id)!);
    const inSeg = a.b === n.id ? a : b;
    const outSeg = inSeg === a ? b : a;
    if (inSeg.b !== n.id || outSeg.a !== n.id) continue;
    const p = heading(inSeg.id, 1);
    const q = heading(outSeg.id, 0);
    const degrees = (planAngle(p, q) * 180) / Math.PI;
    if (degrees > 1) bad.push(`${degrees.toFixed(1)} degree kink at node ${n.id}`);
    const slopeIn = p.y / Math.hypot(p.x, p.z);
    const slopeOut = q.y / Math.hypot(q.x, q.z);
    if (Math.abs(slopeIn - slopeOut) > 0.012) bad.push(`grade jumps ${slopeIn.toFixed(3)} to ${slopeOut.toFixed(3)} at node ${n.id}`);
  }
  for (const s of net.segments) {
    const c = net.cubicOf(s.id);
    let turn = 0;
    let last = heading(s.id, 0.001);
    for (let i = 1; i <= 24; i++) {
      const h = heading(s.id, Math.min(0.999, i / 24));
      turn += planAngle(last, h);
      last = h;
    }
    if (turn > Math.PI / 2 + 1e-3) bad.push(`segment ${s.id} turns ${((turn * 180) / Math.PI).toFixed(0)} degrees in one cubic`);
    void c;
  }
  return bad;
}

/** Length of road from a stub end to the first junction. */
export function stubLength(net: RoadNetwork, nodeId: Id): number {
  let cur = nodeId;
  let seg = net.getNode(nodeId)!.segments[0];
  let total = 0;
  for (;;) {
    total += net.segmentGeom(seg)!.fullLength;
    const s = net.getSegment(seg)!;
    const next = s.a === cur ? s.b : s.a;
    const node = net.getNode(next)!;
    if (node.segments.length !== 2) return total;
    seg = node.segments[0] === seg ? node.segments[1] : node.segments[0];
    cur = next;
  }
}
