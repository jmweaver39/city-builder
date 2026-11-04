/**
 * Lane adds and drops at an edge merge (core/edgeMerge.ts), as the road tool builds
 * them: an on-ramp carrying on as an added lane, for a distance or for good, and an
 * off-ramp taking the edge lane exit only. The highway past the node becomes the
 * built-in highway with one lane more or fewer, and the narrower road lines up with
 * the wider one on the side away from the ramp (core/laneAlign.ts), so every other
 * lane runs straight on. Where an added lane ends, the highway narrows again with a
 * lane drop lined up the same way.
 */
import { tAtLength } from '../core/bezier';
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Id, LaneAlign, Segment } from '../core/types';

/** The built-in one-way highway with `delta` more lanes, or null. */
function highwayWith(net: RoadNetwork, roadType: string, delta: number): string | null {
  const m = /^highway-(\d)$/.exec(roadType);
  if (!m) return null;
  const id = `highway-${Number(m[1]) + delta}`;
  return net.roadType(id) ? id : null;
}

/** Roads straight on from `seg` beyond `from`, through plain joints of the same type. */
function chainFrom(net: RoadNetwork, seg: Segment, from: Id, limit = 40): Id[] {
  const out: Id[] = [seg.id];
  let cur = seg;
  let at = cur.a === from ? cur.b : cur.a;
  for (let i = 0; i < limit; i++) {
    const node = net.getNode(at);
    if (!node || node.segments.length !== 2 || net.nodeGeom(at)?.kind !== 'plain') break;
    const nextId = node.segments.find((s) => s !== cur.id)!;
    const next = net.getSegment(nextId);
    if (!next || next.roadType !== seg.roadType || out.includes(nextId)) break;
    out.push(nextId);
    cur = next;
    at = cur.a === at ? cur.b : cur.a;
  }
  return out;
}

/**
 * Turn the edge merge at `nodeId` into a lane add ('add' for `addLength` metres,
 * 'addFull' for good) or an exit-only lane drop ('drop'). Returns why not, or null.
 */
export function applyRampLaneChange(net: RoadNetwork, nodeId: Id, mode: 'add' | 'addFull' | 'drop', addLength = 300): string | null {
  const g = net.nodeGeom(nodeId);
  const e = g?.edge;
  if (!g || !e) return 'Not an edge merge.';
  if ((mode === 'drop') === e.merge) return mode === 'drop' ? 'Only an off-ramp can take the edge lane.' : 'Only an on-ramp can add a lane.';
  const hostIn = net.getSegment(g.arms[e.hostIn].segmentId)!;
  const hostOut = net.getSegment(g.arms[e.hostOut].segmentId)!;
  // Only one-way highways, drawn the way they run, have a type a lane more or less.
  if (hostIn.b !== nodeId || hostOut.a !== nodeId) return 'Lane adds and drops need a one-way highway.';
  const target = highwayWith(net, hostOut.roadType, mode === 'drop' ? -1 : 1);
  if (!target || hostIn.roadType !== hostOut.roadType) return mode === 'drop' ? 'No highway one lane narrower to drop to.' : 'No highway one lane wider to add to.';
  // The lanes away from the ramp carry on: line up the narrower road on that side.
  const keep: LaneAlign = e.side > 0 ? 'left' : 'right';
  net.batch(() => {
    if (mode === 'drop') {
      for (const id of chainFrom(net, hostOut, nodeId)) net.setRoadType(id, target);
      net.setSegmentOverrides(hostOut.id, { alignA: keep });
      return;
    }
    let pieces = chainFrom(net, hostOut, nodeId);
    if (mode === 'add' && addLength > 0) {
      // Split where the added lane ends, then the lanes drop back with the same line-up.
      const len = net.curveOf(hostOut.id).length;
      if (len > addLength + 40) {
        const t = tAtLength(net.curveOf(hostOut.id).table, addLength);
        net.splitSegment(hostOut.id, t);
      }
      pieces = [hostOut.id];
      const end = net.getSegment(hostOut.id)!;
      const beyond = net.getNode(end.b)?.segments.find((s) => s !== end.id);
      if (beyond !== undefined && net.getSegment(beyond)?.a === end.b) net.setSegmentOverrides(beyond, { alignA: keep });
    }
    for (const id of pieces) net.setRoadType(id, target);
    net.setSegmentOverrides(hostIn.id, { alignB: keep });
    const ramp = net.getSegment(g.arms[e.ramp].segmentId)!;
    const attach = ramp.b === nodeId ? ramp.overrides.attachB : ramp.overrides.attachA;
    if (attach?.edge) {
      const patched = { ...attach, edge: { ...attach.edge, mode: 'add' as const, ...(mode === 'add' ? { addLength } : {}) } };
      net.setSegmentOverrides(ramp.id, ramp.b === nodeId ? { attachB: patched } : { attachA: patched });
    }
  });
  if (mode === 'drop') {
    const ramp = net.getSegment(g.arms[e.ramp].segmentId);
    if (ramp) {
      const attach = ramp.a === nodeId ? ramp.overrides.attachA : ramp.overrides.attachB;
      if (attach?.edge) net.setSegmentOverrides(ramp.id, ramp.a === nodeId ? { attachA: { ...attach, edge: { ...attach.edge, mode: 'drop' } } } : { attachB: { ...attach, edge: { ...attach.edge, mode: 'drop' } } });
    }
  }
  return null;
}
