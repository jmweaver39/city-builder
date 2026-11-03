/**
 * A full structural check of a RoadNetwork and everything derived from it. Used
 * by the tests, and handy from the debug hook. Returns human-readable problems.
 */
import type { Vec3 } from './types';
import type { RoadNetwork } from './RoadNetwork';
import { isFiniteVec } from './math';

function finiteStation(p: Vec3): boolean {
  return isFiniteVec(p);
}

export function checkNetworkInvariants(net: RoadNetwork): string[] {
  const problems: string[] = [];
  const say = (m: string) => problems.push(m);
  const project = net.project;

  const nodeIds = new Set(project.nodes.map((n) => n.id));
  const segIds = new Set(project.segments.map((s) => s.id));
  if (nodeIds.size !== project.nodes.length) say('duplicate node ids');
  if (segIds.size !== project.segments.length) say('duplicate segment ids');

  const expected = new Map<number, number[]>();
  for (const n of project.nodes) expected.set(n.id, []);
  for (const s of project.segments) {
    if (!nodeIds.has(s.a)) say(`segment ${s.id} has missing node a ${s.a}`);
    if (!nodeIds.has(s.b)) say(`segment ${s.id} has missing node b ${s.b}`);
    if (s.a === s.b) say(`segment ${s.id} is a self loop`);
    if (!isFiniteVec(s.c1) || !isFiniteVec(s.c2)) say(`segment ${s.id} has a bad control`);
    expected.get(s.a)?.push(s.id);
    expected.get(s.b)?.push(s.id);
    if (!net.roadType(s.roadType)) say(`segment ${s.id} has unknown road type ${s.roadType}`);
    if (s.id >= project.nextId) say(`segment id ${s.id} is not below nextId`);
  }
  for (const n of project.nodes) {
    if (!isFiniteVec(n.pos)) say(`node ${n.id} has a bad position`);
    const want = expected.get(n.id)!;
    if (want.length !== n.segments.length || want.some((v, i) => v !== n.segments[i])) {
      say(`node ${n.id} segments [${n.segments}] should be [${want}]`);
    }
    if (n.id >= project.nextId) say(`node id ${n.id} is not below nextId`);
    for (const key of Object.keys(n.control.signs)) {
      if (!n.segments.includes(Number(key))) say(`node ${n.id} has a sign for foreign segment ${key}`);
    }
  }
  for (const e of project.endpoints) {
    if (e.nodeId !== null && !nodeIds.has(e.nodeId)) say(`endpoint ${e.id} refers to missing node`);
    if (e.segmentId !== null && !segIds.has(e.segmentId)) say(`endpoint ${e.id} refers to missing segment`);
  }

  for (const s of project.segments) {
    const g = net.segmentGeom(s.id);
    if (!g) {
      say(`segment ${s.id} has no geometry`);
      continue;
    }
    if (!Number.isFinite(g.fullLength) || !Number.isFinite(g.length)) say(`segment ${s.id} has a bad length`);
    if (g.trimA < 0 || g.trimB < 0) say(`segment ${s.id} has a negative trim`);
    if (g.trimA + g.trimB > g.fullLength + 1e-6) say(`segment ${s.id} trims exceed its length`);
    for (const st of g.stations) {
      if (!finiteStation(st.pos) || !finiteStation(st.tangent) || !finiteStation(st.right)) {
        say(`segment ${s.id} has a bad station`);
        break;
      }
    }
  }
  for (const n of project.nodes) {
    const g = net.nodeGeom(n.id);
    if (!g) {
      say(`node ${n.id} has no geometry`);
      continue;
    }
    if (g.arms.length !== n.segments.length) say(`node ${n.id} has ${g.arms.length} arms`);
    for (const p of g.outline) if (!isFiniteVec(p)) say(`node ${n.id} has a bad outline point`);
    for (const a of g.arms) {
      if (!isFiniteVec(a.leftEdge) || !isFiniteVec(a.rightEdge) || !isFiniteVec(a.centre)) {
        say(`node ${n.id} arm ${a.segmentId} has a bad edge`);
      }
    }
  }

  const graph = net.laneGraph;
  graph.lanes.forEach((lane, i) => {
    if (lane.idx !== i) say(`lane ${i} has idx ${lane.idx}`);
    if (graph.byKey.get(lane.key) !== i) say(`byKey is wrong for ${lane.key}`);
    const count = lane.cum.length;
    if (lane.pts.length !== count * 3) say(`${lane.key} pts and cum disagree`);
    if (count < 2) say(`${lane.key} has fewer than 2 points`);
    for (let k = 0; k < lane.pts.length; k++) {
      if (!Number.isFinite(lane.pts[k])) {
        say(`${lane.key} has a non-finite point`);
        break;
      }
    }
    for (let k = 1; k < count; k++) {
      if (!(lane.cum[k] > lane.cum[k - 1])) {
        say(`${lane.key} cum is not increasing at ${k}`);
        break;
      }
    }
    if (!(lane.length > 0) || !Number.isFinite(lane.length)) say(`${lane.key} has length ${lane.length}`);
    if (!(lane.speed > 0)) say(`${lane.key} has speed ${lane.speed}`);
    for (const j of lane.next) {
      const other = graph.lanes[j];
      if (!other) say(`${lane.key} next ${j} is out of range`);
      else if (!other.prev.includes(i)) say(`${lane.key} -> ${other.key} is not symmetric`);
    }
    for (const j of lane.prev) {
      const other = graph.lanes[j];
      if (!other) say(`${lane.key} prev ${j} is out of range`);
      else if (!other.next.includes(i)) say(`${lane.key} <- ${other.key} is not symmetric`);
    }
    if (lane.kind === 'connector') {
      if (lane.next.length !== 1 || lane.prev.length !== 1) say(`${lane.key} must have one next and one prev`);
      const key = lane.key;
      if (!graph.connectorsAt.get(lane.nodeId)?.includes(i)) say(`${key} missing from connectorsAt`);
      for (const c of lane.conflicts) {
        const other = graph.lanes[c.lane];
        if (!other) say(`${key} conflicts with missing lane`);
        else if (other.nodeId !== lane.nodeId) say(`${key} conflicts across nodes`);
        else if (!other.conflicts.some((x) => x.lane === i)) say(`${key} conflict is not mutual`);
        if (!Number.isFinite(c.selfS) || !Number.isFinite(c.otherS)) say(`${key} has a bad conflict distance`);
      }
    } else {
      const list = graph.roadLanes.get(lane.segmentId);
      if (list?.[lane.laneIndex] !== i) say(`${lane.key} missing from roadLanes`);
      for (const side of [lane.left, lane.right]) {
        if (side !== -1 && graph.lanes[side]?.segmentId !== lane.segmentId) say(`${lane.key} has a bad neighbour`);
      }
    }
  });
  for (const node of net.nodes) {
    for (const m of node.control.markings ?? []) {
      for (const a of m.kind === 'line' ? [m.from, m.to] : m.anchors) {
        if (!node.segments.includes(a.segmentId)) say(`marking ${m.id} at node ${node.id} names segment ${a.segmentId}`);
      }
    }
  }
  if (graph.byKey.size !== graph.lanes.length) say('byKey has duplicate keys');
  for (const id of graph.roadLanes.keys()) if (!segIds.has(id)) say(`roadLanes has stale segment ${id}`);
  for (const id of graph.connectorsAt.keys()) if (!nodeIds.has(id)) say(`connectorsAt has stale node ${id}`);
  return problems;
}
