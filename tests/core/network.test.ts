import { describe, expect, it } from 'vitest';
import {
  GRADE_CLEARANCE,
  NetworkError,
  ProjectFormatError,
  RoadNetwork,
  checkNetworkInvariants,
  createEmptyProject,
  cubicPoint,
  defaultSignalPlan,
  dist,
  effectiveControl,
  makeCustomRoadType,
  movementsAt,
  parseProject,
  type Cubic,
  type Id,
  type NetworkChange,
  type Project,
} from '../../src/core';
import { atNode, expectClean, free, lanesWithoutExit, maxDeviation, movementKeys, onSeg, v } from './helpers';

function street(net: RoadNetwork, x0: number, z0: number, x1: number, z1: number, type = 'street-2'): Id {
  return net.drawRoad({ start: free(x0, z0), end: free(x1, z1), roadType: type }).segments[0];
}

describe('basic edits', () => {
  it('adds nodes and segments and keeps node.segments in sync', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(100, 0));
    const s = net.addSegment(a, b, { roadType: 'street-2' });
    expect(net.getNode(a)!.segments).toEqual([s]);
    expect(net.getNode(b)!.segments).toEqual([s]);
    expect(net.segmentGeom(s)!.fullLength).toBeCloseTo(100, 6);
    expectClean(net);
  });

  it('refuses bad input', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(10, 0));
    expect(() => net.addSegment(a, a, { roadType: 'street-2' })).toThrow(NetworkError);
    expect(() => net.addSegment(a, 99, { roadType: 'street-2' })).toThrow(/node 99/);
    expect(() => net.addSegment(a, b, { roadType: 'nope' })).toThrow(/Unknown road type/);
    expect(() => net.addNode({ x: Number.NaN, y: 0, z: 0 })).toThrow(/finite/);
    expect(() => net.moveNode(a, { x: 0, y: Infinity, z: 0 })).toThrow(/finite/);
    expect(() => net.setSegmentControls(1234, v(0, 0), v(0, 0))).toThrow();
  });

  it('removes a segment and its orphan nodes only', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(100, 0));
    const c = net.addNode(v(200, 0));
    const s1 = net.addSegment(a, b, { roadType: 'street-2' });
    const s2 = net.addSegment(b, c, { roadType: 'street-2' });
    net.removeSegment(s2);
    expect(net.getNode(c)).toBeUndefined();
    expect(net.getNode(b)!.segments).toEqual([s1]);
    expect(net.segmentGeom(s2)).toBeUndefined();
    expectClean(net);
    net.removeSegment(s1);
    expect(net.nodes).toHaveLength(0);
    expect(net.laneGraph.lanes).toHaveLength(0);
    expectClean(net);
  });

  it('does not merge two segments when the third is removed', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-100, 0));
    const n = net.addNode(v(0, 0));
    const b = net.addNode(v(100, 0));
    const c = net.addNode(v(0, 100));
    net.addSegment(a, n, { roadType: 'street-2' });
    net.addSegment(n, b, { roadType: 'street-2' });
    const side = net.addSegment(n, c, { roadType: 'street-2' });
    expect(net.nodeGeom(n)!.kind).toBe('junction');
    net.removeSegment(side);
    expect(net.segments).toHaveLength(2);
    expect(net.nodeGeom(n)!.isPlainJoint).toBe(true);
    expectClean(net);
  });

  it('moves a node keeping straight roads straight', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-100, 0));
    const n = net.addNode(v(0, 0));
    const b = net.addNode(v(100, 0));
    const s1 = net.addSegment(a, n, { roadType: 'street-2' });
    const s2 = net.addSegment(n, b, { roadType: 'street-2' });
    net.moveNode(n, v(0, 30));
    for (const s of [s1, s2]) {
      const c = net.cubicOf(s);
      const mid = cubicPoint(c, 0.5);
      expect(mid.z).toBeCloseTo(15, 6);
    }
    expectClean(net);
  });

  it('moves a node keeping a smooth joint smooth', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-100, 0));
    const n = net.addNode(v(0, 0));
    const b = net.addNode(v(100, 0));
    const s1 = net.addSegment(a, n, { roadType: 'street-2', c1: v(-60, -20), c2: v(-30, 0) });
    const s2 = net.addSegment(n, b, { roadType: 'street-2', c1: v(30, 0), c2: v(60, 20) });
    expect(net.nodeGeom(n)!.isPlainJoint).toBe(true);
    net.moveNode(n, v(10, 8));
    const left = net.getSegment(s1)!.c2;
    const right = net.getSegment(s2)!.c1;
    const pos = net.getNode(n)!.pos;
    const ax = pos.x - left.x;
    const az = pos.z - left.z;
    const bx = right.x - pos.x;
    const bz = right.z - pos.z;
    expect(Math.abs(ax * bz - az * bx)).toBeLessThan(1e-9);
    expect(net.nodeGeom(n)!.isPlainJoint).toBe(true);
    expectClean(net);
  });

  it('updates controls, road type and overrides', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(100, 0));
    const s = net.addSegment(a, b, { roadType: 'street-2' });
    net.setSegmentControls(s, v(30, 40), v(70, 40));
    expect(net.segmentGeom(s)!.fullLength).toBeGreaterThan(105);
    net.setRoadType(s, 'avenue-6');
    expect(net.laneGraph.roadLanes.get(s)).toHaveLength(6);
    net.setSegmentOverrides(s, { speedKmh: 36, laneKinds: { 0: 'bus' } });
    const graph = net.laneGraph;
    expect(graph.lanes[graph.roadLanes.get(s)![0]].vehicleKind).toBe('bus');
    expect(graph.lanes[graph.roadLanes.get(s)![1]].speed).toBeCloseTo(10);
    net.setSegmentOverrides(s, { speedKmh: undefined });
    expect(net.getSegment(s)!.overrides.speedKmh).toBeUndefined();
    expectClean(net);
  });

  it('stations are tighter on bends than on straights', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(400, 0));
    const c = net.addNode(v(400, 400));
    const straight = net.addSegment(a, b, { roadType: 'street-2' });
    const bend = net.addSegment(b, c, { roadType: 'street-2', c1: v(620, 0), c2: v(620, 400) });
    const spacing = (id: Id) => {
      const st = net.segmentGeom(id)!.stations;
      return Math.min(...st.slice(1).map((s, i) => s.s - st[i].s));
    };
    expect(net.segmentGeom(straight)!.stations.length).toBeLessThan(12);
    expect(spacing(bend)).toBeLessThan(spacing(straight));
    expect(net.segmentGeom(bend)!.minRadius).toBeLessThan(Infinity);
  });

  it('keeps lane spacing constant through a bend', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(100, 100));
    const s = net.addSegment(a, b, { roadType: 'avenue-6', c1: v(55, 0), c2: v(100, 45) });
    const g = net.laneGraph;
    const [l0, l1] = g.roadLanes.get(s)!.map((i) => g.lanes[i]);
    expect(l0.cum.length).toBe(l1.cum.length);
    for (let i = 0; i < l0.cum.length; i++) {
      const n = l0.cum.length - 1 - i;
      const d = Math.hypot(l0.pts[i * 3] - l1.pts[i * 3], l0.pts[i * 3 + 2] - l1.pts[i * 3 + 2]);
      expect(d, `station ${n}`).toBeCloseTo(3.5, 3);
    }
  });
});

describe('splitting', () => {
  const curved = (net: RoadNetwork) => {
    const a = net.addNode(v(-200, 0));
    const b = net.addNode(v(200, 0, 12));
    return net.addSegment(a, b, { roadType: 'avenue-4', c1: v(-100, 200, 4), c2: v(100, -160, 8) });
  };

  it('preserves the curve exactly', () => {
    const net = new RoadNetwork();
    const s = curved(net);
    const before: Cubic = structuredClone(net.cubicOf(s));
    const { node, left, right } = net.splitSegment(s, 0.37);
    expect(left).toBe(s);
    expect(net.nodeGeom(node)!.isPlainJoint).toBe(true);
    const dev = maxDeviation(net, [left, right!], (t) => cubicPoint(before, t), 200);
    expect(dev).toBeLessThan(0.01);
    expectClean(net);
  });

  it('carries overrides to both halves and keeps endpoints in place', () => {
    const net = new RoadNetwork();
    const s = curved(net);
    net.setSegmentOverrides(s, { name: 'Main St', speedKmh: 40 });
    const e1 = net.addEndpoint({ kind: 'residential', segmentId: s, t: 0.25 });
    const e2 = net.addEndpoint({ kind: 'office', segmentId: s, t: 0.75 });
    const { right } = net.splitSegment(s, 0.5);
    expect(net.getSegment(right!)!.overrides).toEqual({ name: 'Main St', speedKmh: 40 });
    expect(net.getSegment(s)!.overrides).toEqual({ name: 'Main St', speedKmh: 40 });
    const ep = (id: Id) => net.endpoints.find((e) => e.id === id)!;
    expect(ep(e1).segmentId).toBe(s);
    expect(ep(e1).t).toBeCloseTo(0.5);
    expect(ep(e2).segmentId).toBe(right);
    expect(ep(e2).t).toBeCloseTo(0.5);
  });

  it('moves control data at the far node to the new segment id', () => {
    const net = new RoadNetwork();
    const hub = net.addNode(v(0, 0));
    const west = net.addNode(v(-300, 0));
    const others = [v(100, 0), v(0, 100), v(0, -100)].map((p) => net.addNode(p));
    const seg = net.addSegment(west, hub, { roadType: 'street-2' });
    const rest = others.map((n) => net.addSegment(hub, n, { roadType: 'street-2' }));
    net.setSign(hub, seg, 'stop');
    net.setCrosswalk(hub, seg, 'ladder');
    net.setJunctionControl(hub, {
      mode: 'signal',
      signal: defaultSignalPlan(net, hub, 'opposing'),
      laneLinks: [{ from: `${seg}:1`, to: `${rest[0]}:1` }],
    });
    const before = JSON.stringify(net.getNode(hub)!.control.signal);
    expect(before).toContain(`${seg}>`);
    const { right } = net.splitSegment(seg, 0.5);
    const ctl = net.getNode(hub)!.control;
    expect(ctl.signs[right!]).toBe('stop');
    expect(ctl.signs[seg]).toBeUndefined();
    expect(ctl.crosswalks[right!]).toBe('ladder');
    expect(ctl.laneLinks).toEqual([{ from: `${right}:1`, to: `${rest[0]}:1` }]);
    expect(JSON.stringify(ctl.signal)).toContain(`${right}>`);
    expect(JSON.stringify(ctl.signal)).not.toContain(`"${seg}>`);
    expectClean(net);
  });

  it('returns the end node for a split at the very end', () => {
    const net = new RoadNetwork();
    const s = curved(net);
    const seg = net.getSegment(s)!;
    expect(net.splitSegment(s, 0)).toEqual({ node: seg.a, left: s, right: null });
    expect(net.splitSegment(s, 1)).toEqual({ node: seg.b, left: s, right: null });
    expect(net.segments).toHaveLength(1);
    expect(() => net.splitSegment(s, 1.5)).toThrow(/outside/);
  });
});

describe('drawRoad', () => {
  it('draws free to free, one segment, in the direction drawn', () => {
    const net = new RoadNetwork();
    const r = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: 'highway-3' });
    expect(r.segments).toHaveLength(1);
    expect(r.nodes).toHaveLength(2);
    expect(r.junctions).toEqual([]);
    const seg = net.getSegment(r.segments[0])!;
    expect(net.getNode(seg.a)!.pos.x).toBe(0);
    expect(net.getNode(seg.b)!.pos.x).toBe(100);
  });

  it('crossing at grade makes exactly one 4-way and preserves the shape', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-200, 30));
    const b = net.addNode(v(200, -30));
    const old = net.addSegment(a, b, { roadType: 'street-4', c1: v(-90, -90), c2: v(90, 90) });
    const before = structuredClone(net.cubicOf(old));
    const r = net.drawRoad({ start: free(0, -150), end: free(10, 150), roadType: 'street-2' });
    expect(r.junctions).toHaveLength(1);
    expect(r.segments).toHaveLength(2);
    expect(net.segments).toHaveLength(4);
    const j = r.junctions[0];
    expect(net.getNode(j)!.segments).toHaveLength(4);
    expect(net.nodeGeom(j)!.arms).toHaveLength(4);
    expect(net.nodes).toHaveLength(5);
    const halves = net.getNode(j)!.segments.filter((s) => net.getSegment(s)!.roadType === 'street-4');
    expect(maxDeviation(net, halves, (t) => cubicPoint(before, t), 200)).toBeLessThan(0.01);
    expect(movementKeys(net.laneGraph, j).size).toBe(12);
    expectClean(net);
  });

  it('crossing with 8 m clearance creates no junction', () => {
    const net = new RoadNetwork();
    const old = street(net, -200, 0, 200, 0);
    const r = net.drawRoad({ start: free(0, -200, 8), end: free(0, 200, 8), roadType: 'street-2' });
    expect(r.junctions).toEqual([]);
    expect(r.segments).toHaveLength(1);
    expect(net.segments).toHaveLength(2);
    expect(net.nodes).toHaveLength(4);
    expect(net.getSegment(old)).toBeDefined();
    expectClean(net);
  });

  it('treats just under the clearance as at grade, and exactly at it as separated', () => {
    const net = new RoadNetwork();
    street(net, -200, 0, 200, 0);
    const clear = net.drawRoad({
      start: free(50, -200, GRADE_CLEARANCE),
      end: free(50, 200, GRADE_CLEARANCE),
      roadType: 'street-2',
    });
    expect(clear.junctions).toEqual([]);
    const low = net.drawRoad({
      start: free(-50, -200, GRADE_CLEARANCE - 0.5),
      end: free(-50, 200, GRADE_CLEARANCE - 0.5),
      roadType: 'street-2',
    });
    expect(low.junctions).toHaveLength(1);
    // The junction stays on the existing road's surface.
    expect(net.getNode(low.junctions[0])!.pos.y).toBeCloseTo(0, 6);
    expectClean(net);
  });

  it('a ramp passing under a bridge sees only the slopes at the crossing', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-300, 0, 0), end: free(300, 0, 0), roadType: 'highway-3' });
    const r = net.drawRoad({
      start: free(0, -300, 12),
      end: free(0, 300, 12),
      c1: v(0, -100, 12),
      c2: v(0, 100, 12),
      roadType: 'street-2',
    });
    expect(r.junctions).toEqual([]);
  });

  it('a curved road crossing another twice makes two junctions', () => {
    const net = new RoadNetwork();
    const old = street(net, -300, 0, 300, 0, 'street-4');
    const before = structuredClone(net.cubicOf(old));
    const r = net.drawRoad({
      start: free(-100, -100),
      end: free(100, -100),
      c1: v(-100, 200),
      c2: v(100, 200),
      roadType: 'street-2',
    });
    expect(r.junctions).toHaveLength(2);
    expect(r.segments).toHaveLength(3);
    expect(net.segments).toHaveLength(6);
    for (const j of r.junctions) expect(net.getNode(j)!.segments).toHaveLength(4);
    const streets = net.segments.filter((s) => s.roadType === 'street-4').map((s) => s.id);
    expect(maxDeviation(net, streets, (t) => cubicPoint(before, t), 200)).toBeLessThan(0.01);
    expectClean(net);
  });

  it('crosses several roads in order', () => {
    const net = new RoadNetwork();
    for (const z of [-100, 0, 100]) street(net, -200, z, 200, z);
    const r = net.drawRoad({ start: free(0, -200), end: free(0, 200), roadType: 'avenue-4' });
    expect(r.junctions).toHaveLength(3);
    expect(r.segments).toHaveLength(4);
    const zs = r.nodes.map((n) => net.getNode(n)!.pos.z);
    expect(zs).toEqual([...zs].sort((a, b) => a - b));
    expectClean(net);
  });

  it('starts from a node and from a point on a segment', () => {
    const net = new RoadNetwork();
    const s = street(net, -100, 0, 100, 0);
    const seg = net.getSegment(s)!;
    const fromNode = net.drawRoad({ start: atNode(seg.b), end: free(100, 100), roadType: 'street-2' });
    expect(fromNode.junctions).toEqual([]);
    expect(net.getNode(seg.b)!.segments).toHaveLength(2);
    const fromSeg = net.drawRoad({ start: onSeg(s, 0.25), end: free(-50, 100), roadType: 'street-2' });
    expect(fromSeg.junctions).toEqual([]);
    expect(net.getNode(fromSeg.nodes[0])!.segments).toHaveLength(3);
    expect(net.getNode(fromSeg.nodes[0])!.pos.x).toBeCloseTo(-50, 6);
    expectClean(net);
  });

  it('connects two points on the same segment', () => {
    const net = new RoadNetwork();
    const s = street(net, -200, 0, 200, 0);
    const r = net.drawRoad({
      start: onSeg(s, 0.25),
      end: onSeg(s, 0.75),
      c1: v(-100, 80),
      c2: v(100, 80),
      roadType: 'street-2',
    });
    expect(r.segments).toHaveLength(1);
    expect(net.getNode(r.nodes[0])!.pos.x).toBeCloseTo(-100, 6);
    expect(net.getNode(r.nodes[1])!.pos.x).toBeCloseTo(100, 6);
    expect(net.segments).toHaveLength(4);
    expectClean(net);

    const back = new RoadNetwork();
    const t = street(back, -200, 0, 200, 0);
    const reversed = back.drawRoad({
      start: onSeg(t, 0.75),
      end: onSeg(t, 0.25),
      c1: v(100, 80),
      c2: v(-100, 80),
      roadType: 'street-2',
    });
    expect(back.getNode(reversed.nodes[0])!.pos.x).toBeCloseTo(100, 6);
    expectClean(back);
  });

  it('a free end landing just over a road joins it', () => {
    const net = new RoadNetwork();
    street(net, -100, 0, 100, 0);
    const r = net.drawRoad({ start: free(0, -100), end: free(0, 1), roadType: 'street-2' });
    expect(r.junctions).toHaveLength(1);
    expect(r.segments).toHaveLength(1);
    expect(net.getNode(r.nodes[1])!.pos.z).toBeCloseTo(0, 6);
    expect(net.getNode(r.junctions[0])!.segments).toHaveLength(3);
    expect(net.nodes).toHaveLength(4);
    expectClean(net);
  });

  it('a crossing right by a node uses the node', () => {
    const net = new RoadNetwork();
    const left = street(net, -100, 0, 0, 0);
    const seg = net.getSegment(left)!;
    net.drawRoad({ start: atNode(seg.b), end: free(100, 0), roadType: 'street-2' });
    const r = net.drawRoad({ start: free(1, -100), end: free(1, 100), roadType: 'street-2' });
    expect(r.junctions).toEqual([seg.b]);
    expect(net.getNode(seg.b)!.segments).toHaveLength(4);
    expect(net.segments).toHaveLength(4);
    expectClean(net);
  });

  it('a closed loop gets a node of its own', () => {
    const net = new RoadNetwork();
    const s = street(net, -300, 0, 0, 0);
    const n = net.getSegment(s)!.b;
    const r = net.drawRoad({
      start: atNode(n),
      end: atNode(n),
      c1: v(150, 150),
      c2: v(150, -150),
      roadType: 'street-2',
    });
    expect(r.segments).toHaveLength(2);
    expect(r.nodes[0]).toBe(n);
    expect(r.nodes[2]).toBe(n);
    expectClean(net);
  });

  it('refuses a road with no length, leaving the network alone', () => {
    const net = new RoadNetwork();
    expect(() => net.drawRoad({ start: free(5, 5), end: free(5, 5), roadType: 'street-2' })).toThrow(/length/);
    expect(net.nodes).toHaveLength(0);
    expect(() => net.drawRoad({ start: free(0, 0), end: free(5, 5), roadType: 'bad' })).toThrow(/Unknown/);
  });

  it('closes a loop drawn in free space', () => {
    const net = new RoadNetwork();
    const r = net.drawRoad({ start: free(0, 0), end: free(0, 0), c1: v(200, 200), c2: v(-200, 200), roadType: 'street-2' });
    expect(r.segments).toHaveLength(2);
    expect(net.nodes).toHaveLength(2);
    expectClean(net);
  });

  it('refuses an anchor with no position, leaving the network alone', () => {
    const net = new RoadNetwork();
    const s = street(net, 0, 0, 100, 0);
    const before = net.serialize();
    expect(() => net.drawRoad({ start: onSeg(s, Number.NaN), end: free(0, 50), roadType: 'street-2' })).toThrow(NetworkError);
    expect(() => net.drawRoad({ start: free(0, 50), end: atNode(424242), roadType: 'street-2' })).toThrow(/424242/);
    expect(net.serialize()).toBe(before);
  });

  it('every lane still has a way out after a crossing', () => {
    const net = new RoadNetwork();
    street(net, -200, 0, 200, 0);
    net.drawRoad({ start: free(0, -200), end: free(0, 200), roadType: 'street-2' });
    expect(lanesWithoutExit(net.laneGraph)).toEqual([]);
  });
});

describe('bulldozing a chain', () => {
  it('keeps nodes and the lane graph consistent', () => {
    const net = new RoadNetwork();
    const ids = [0, 1, 2, 3, 4].map((i) => net.addNode(v(i * 100, 0)));
    const segs = ids.slice(1).map((id, i) => net.addSegment(ids[i], id, { roadType: 'highway-3' }));
    const graph = net.laneGraph;
    expect(graph.lanes.filter((l) => l.next.length === 0)).toHaveLength(3);
    net.removeSegment(segs[1]);
    expectClean(net);
    expect(net.segments).toHaveLength(3);
    const g = net.laneGraph;
    expect(g.lanes.filter((l) => l.next.length === 0)).toHaveLength(6);
    expect(g.byKey.has(`r${segs[1]}:0`)).toBe(false);
    expect(net.getNode(ids[1])!.segments).toEqual([segs[0]]);
    expect(net.getNode(ids[2])!.segments).toEqual([segs[2]]);
    expect(net.nodeGeom(ids[1])!.kind).toBe('deadEnd');
    net.removeSegment(segs[0]);
    expect(net.getNode(ids[0])).toBeUndefined();
    expect(net.getNode(ids[1])).toBeUndefined();
    expectClean(net);
  });

  it('drops endpoints that lost their road', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(100, 0));
    const s = net.addSegment(a, b, { roadType: 'street-2' });
    net.addEndpoint({ kind: 'gateway', nodeId: a });
    net.addEndpoint({ kind: 'commercial', segmentId: s, t: 0.5 });
    expect(net.endpoints).toHaveLength(2);
    net.removeSegment(s);
    expect(net.endpoints).toHaveLength(0);
  });
});

describe('change events and batches', () => {
  it('reports dirty ids for one edit', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(100, 0));
    const events: NetworkChange[] = [];
    const off = net.onChange((e) => events.push(e));
    const s = net.addSegment(a, b, { roadType: 'street-2' });
    expect(events).toHaveLength(1);
    expect(events[0].dirtySegments).toEqual([s]);
    expect(new Set(events[0].dirtyNodes)).toEqual(new Set([a, b]));
    expect(events[0].version).toBe(net.version);
    off();
    net.moveNode(b, v(120, 0));
    expect(events).toHaveLength(1);
  });

  it('reports only what changed, including neighbours whose trims moved', () => {
    const net = new RoadNetwork();
    const hub = net.addNode(v(0, 0));
    const others = [v(100, 0), v(0, 100), v(-100, 0)].map((p) => net.addNode(p));
    const far = net.addNode(v(1000, 1000));
    const far2 = net.addNode(v(1100, 1000));
    const remote = net.addSegment(far, far2, { roadType: 'street-2' });
    const segs = others.map((n) => net.addSegment(hub, n, { roadType: 'street-2' }));
    const events: NetworkChange[] = [];
    net.onChange((e) => events.push(e));
    const extra = net.addNode(v(0, -100));
    events.length = 0;
    const added = net.addSegment(hub, extra, { roadType: 'avenue-6' });
    const e = events[0];
    expect(e.dirtySegments).toContain(added);
    expect(e.dirtySegments).toContain(segs[0]); // Trim grew: a wide road joined.
    expect(net.nodeGeom(hub)!.arms).toHaveLength(4);
    expect(e.dirtySegments).not.toContain(remote);
    expect(e.dirtyNodes).toContain(hub);
    expect(e.dirtyNodes).not.toContain(far);
  });

  it('batches a compound edit into one event', () => {
    const net = new RoadNetwork();
    const events: NetworkChange[] = [];
    net.onChange((e) => events.push(e));
    net.beginBatch();
    const r1 = net.drawRoad({ start: free(-100, 0), end: free(100, 0), roadType: 'street-2' });
    const r2 = net.drawRoad({ start: free(0, -100), end: free(0, 100), roadType: 'street-2' });
    expect(events).toHaveLength(0);
    // Reads stay valid mid-batch.
    expect(net.laneGraph.lanes.length).toBeGreaterThan(0);
    expect(net.nodeGeom(r2.junctions[0])!.arms).toHaveLength(4);
    net.commit();
    expect(events).toHaveLength(1);
    expect(events[0].dirtySegments).toEqual(expect.arrayContaining([...r1.segments, ...r2.segments]));
    net.commit(); // Harmless extra commit.
    expect(events).toHaveLength(1);
  });

  it('handles nested batches and removal inside a batch', () => {
    const net = new RoadNetwork();
    const events: NetworkChange[] = [];
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(100, 0));
    net.onChange((e) => events.push(e));
    net.batch(() => {
      const s = net.addSegment(a, b, { roadType: 'street-2' });
      net.batch(() => net.moveNode(b, v(150, 0)));
      expect(events).toHaveLength(0);
      net.removeSegment(s);
    });
    expect(events).toHaveLength(1);
    expect(events[0].removedNodes).toEqual(expect.arrayContaining([a, b]));
    expect(events[0].dirtySegments).toEqual([]);
    expectClean(net);
  });

  it('commits a batch that throws', () => {
    const net = new RoadNetwork();
    const events: NetworkChange[] = [];
    net.onChange((e) => events.push(e));
    expect(() =>
      net.batch(() => {
        net.addNode(v(0, 0));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(events).toHaveLength(1);
  });

  it('bumps the lane graph version and returns a fresh graph', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(100, 0));
    net.addSegment(a, b, { roadType: 'street-2' });
    const g1 = net.laneGraph;
    expect(net.laneGraph).toBe(g1);
    net.moveNode(b, v(120, 0));
    const g2 = net.laneGraph;
    expect(g2).not.toBe(g1);
    expect(g2.version).toBeGreaterThan(g1.version);
  });

  it('shares untouched lanes across an edit and leaves the old graph intact', () => {
    const net = new RoadNetwork();
    const s = street(net, -100, 0, 100, 0);
    const far = street(net, 500, 500, 600, 500);
    const g1 = net.laneGraph;
    const oldLane = g1.lanes[g1.roadLanes.get(s)![0]];
    const oldEnd = Array.from(oldLane.pts);
    const farLane = g1.lanes[g1.roadLanes.get(far)![0]];
    net.moveNode(net.getSegment(s)!.b, v(150, 40));
    const g2 = net.laneGraph;
    expect(g2).not.toBe(g1);
    expect(g2.lanes[g2.roadLanes.get(far)![0]]).toBe(farLane);
    expect(g2.lanes[g2.roadLanes.get(s)![0]]).not.toBe(oldLane);
    // Whoever still holds the old graph sees exactly what it saw.
    expect(g1.lanes[g1.roadLanes.get(s)![0]]).toBe(oldLane);
    expect(Array.from(oldLane.pts)).toEqual(oldEnd);
    expectClean(net);
  });

  it('falls back to a full rebuild when an edit changes the lanes', () => {
    const net = new RoadNetwork();
    const s = street(net, -100, 0, 100, 0);
    const before = net.laneGraph.lanes.length;
    net.setRoadType(s, 'street-4');
    expect(net.laneGraph.lanes.length).toBeGreaterThan(before);
    // Same lane count, opposite travel: connectors and keys must follow.
    const t = street(net, 500, 0, 600, 0);
    net.setRoadType(t, 'street-2-oneway');
    expectClean(net);
    expect(net.laneGraph.connectorsAt.get(net.getSegment(t)!.a)).toEqual([]);
  });

  it('keeps keys stable across unrelated edits', () => {
    const net = new RoadNetwork();
    const s = street(net, -100, 0, 100, 0);
    const key = `r${s}:0`;
    const before = net.laneGraph.byKey.has(key);
    street(net, 500, 500, 600, 500);
    expect(before).toBe(true);
    expect(net.laneGraph.byKey.has(key)).toBe(true);
  });

  it('reports endpoints, decals and settings', () => {
    const net = new RoadNetwork();
    const events: NetworkChange[] = [];
    net.onChange((e) => events.push(e));
    const d = net.addDecal({ kind: 'line', points: [v(0, 0), v(1, 0)], color: 'white', width: 0.2, rotation: 0 });
    expect(events.at(-1)!.decalsChanged).toBe(true);
    net.updateDecal(d, { color: 'red' });
    expect(net.decals[0].color).toBe('red');
    net.removeDecal(d);
    expect(net.decals).toHaveLength(0);
    const n = net.addNode(v(0, 0));
    const ep = net.addEndpoint({ kind: 'gateway', nodeId: n, ratePerHour: 100 });
    expect(events.at(-1)!.endpointsChanged).toBe(true);
    net.updateEndpoint(ep, { ratePerHour: 500, enabled: false });
    expect(net.endpoints[0].ratePerHour).toBe(500);
    expect(() => net.updateEndpoint(ep, { nodeId: 4242 })).toThrow();
    net.removeEndpoint(ep);
    expect(() => net.removeEndpoint(ep)).toThrow();
    net.setTraffic({ multiplier: 2 });
    expect(events.at(-1)!.settingsChanged).toBe(true);
    expect(net.traffic.multiplier).toBe(2);
    net.setProjectName('Town');
    expect(net.project.name).toBe('Town');
  });
});

describe('queries', () => {
  const net = new RoadNetwork();
  const grid: Id[] = [];
  for (let i = 0; i < 10; i++) grid.push(street(net, -500, i * 100, 500, i * 100));

  it('finds the nearest node', () => {
    const hit = net.nearestNode(v(-490, 305))!;
    expect(net.getNode(hit.nodeId)!.pos).toEqual(v(-500, 300));
    expect(net.nearestNode(v(0, 300), 5)).toBeNull();
    expect(new RoadNetwork().nearestNode(v(0, 0))).toBeNull();
  });

  it('finds the nearest segment with t and lateral offset', () => {
    const hit = net.nearestSegment(v(250, 205))!;
    expect(hit.segmentId).toBe(grid[2]);
    expect(hit.t).toBeCloseTo(0.75, 3);
    expect(hit.distance).toBeCloseTo(5, 6);
    // Road runs +x, so +z is its right.
    expect(hit.lateral).toBeCloseTo(5, 6);
    expect(net.nearestSegment(v(250, 195))!.lateral).toBeCloseTo(-5, 6);
    expect(net.nearestSegment(v(0, 150), 3)).toBeNull();
    expect(new RoadNetwork().nearestSegment(v(0, 0))).toBeNull();
  });

  it('finds things a long way away with no limit', () => {
    const sparse = new RoadNetwork();
    const s = street(sparse, 1900, 1900, 1990, 1990);
    expect(sparse.nearestSegment(v(-1900, -1900))!.segmentId).toBe(s);
    expect(sparse.nearestNode(v(-1900, -1900))).not.toBeNull();
  });

  it('lists segments in a region exactly', () => {
    const r = { minX: -10, minZ: 290, maxX: 10, maxZ: 310 };
    expect(net.segmentsInRegion(r)).toEqual([grid[3]]);
    expect(net.segmentsInRegion({ minX: -10, minZ: 110, maxX: 10, maxZ: 190 })).toEqual([]);
    expect(net.segmentsInRegion({ minX: -600, minZ: -100, maxX: 600, maxZ: 1000 })).toHaveLength(10);
    expect(net.nodesInRegion({ minX: -510, minZ: -10, maxX: -490, maxZ: 110 })).toHaveLength(2);
  });

  it('agrees with brute force after edits', () => {
    const n = new RoadNetwork();
    const ids: Id[] = [];
    for (let i = 0; i < 40; i++) {
      ids.push(street(n, i * 37 - 500, (i * 91) % 300, i * 37 - 450, ((i * 91) % 300) + 500));
    }
    n.removeSegment(ids[3]);
    n.moveNode(n.getSegment(ids[7])!.a, v(900, 900));
    const q = v(-200, 300);
    const brute = Math.min(...n.segments.map((s) => {
      let best = Infinity;
      const c = n.cubicOf(s.id);
      for (let k = 0; k <= 400; k++) {
        const p = cubicPoint(c, k / 400);
        best = Math.min(best, Math.hypot(p.x - q.x, p.z - q.z));
      }
      return best;
    }));
    expect(n.nearestSegment(q)!.distance).toBeCloseTo(brute, 1);
  });

  it('lists dead ends', () => {
    const n = new RoadNetwork();
    const s = street(n, 0, 0, 100, 0);
    expect(n.deadEnds()).toHaveLength(2);
    n.drawRoad({ start: atNode(n.getSegment(s)!.b), end: free(200, 0), roadType: 'street-2' });
    expect(n.deadEnds()).toHaveLength(2);
  });
});

describe('validateDraft', () => {
  const issues = (net: RoadNetwork, d: Parameters<RoadNetwork['validateDraft']>[0]) => net.validateDraft(d);
  const codes = (list: ReturnType<RoadNetwork['validateDraft']>, severity?: string) =>
    list.filter((i) => !severity || i.severity === severity).map((i) => i.code);

  it('passes a good road', () => {
    expect(issues(new RoadNetwork(), { start: free(0, 0), end: free(200, 0), roadType: 'street-2' })).toEqual([]);
  });

  it('flags zero length and too short', () => {
    const net = new RoadNetwork();
    expect(codes(issues(net, { start: free(0, 0), end: free(0, 0), roadType: 'street-2' }))).toEqual(['zeroLength']);
    expect(codes(issues(net, { start: free(0, 0), end: free(3, 0), roadType: 'street-2' }))).toContain('tooShort');
    const msg = issues(net, { start: free(0, 0), end: free(3, 0), roadType: 'street-2' })[0].message;
    expect(msg).toMatch(/3\.0 m/);
  });

  it('warns on grade per road category and stops at the hard limit', () => {
    const net = new RoadNetwork();
    const slope = (rise: number, roadType: string) =>
      issues(net, { start: free(0, 0, 0), end: free(100, 0, rise), roadType }).filter((i) => i.code === 'tooSteep');
    expect(slope(7, 'highway-3')).toEqual([]);
    expect(slope(9, 'highway-3')[0].severity).toBe('warning');
    expect(slope(9, 'ramp-1')).toEqual([]);
    expect(slope(13, 'ramp-1')[0].severity).toBe('warning');
    expect(slope(16, 'ramp-1')[0].severity).toBe('error');
    expect(slope(16, 'highway-3')[0].severity).toBe('error');
  });

  it('flags a curve too tight for the road width', () => {
    const net = new RoadNetwork();
    const list = issues(net, {
      start: free(0, 0),
      end: free(20, 0),
      c1: v(0, 30),
      c2: v(20, 30),
      roadType: 'boulevard-8',
    });
    expect(codes(list, 'error')).toContain('tightCurve');
    const gentle = issues(net, {
      start: free(0, 0),
      end: free(200, 200),
      c1: v(110, 0),
      c2: v(200, 90),
      roadType: 'highway-3',
    });
    expect(codes(gentle, 'warning')).toContain('tightCurve');
  });

  it('flags leaving the map and the elevation range', () => {
    const net = new RoadNetwork();
    expect(codes(issues(net, { start: free(1900, 0), end: free(2100, 0), roadType: 'street-2' }))).toContain('outOfBounds');
    expect(codes(issues(net, { start: free(0, 0, 40), end: free(500, 0, 60), roadType: 'street-2' }))).toContain(
      'elevationRange',
    );
  });

  it('flags insufficient clearance but not a level crossing or a proper bridge', () => {
    const net = new RoadNetwork();
    street(net, -200, 0, 200, 0);
    const at = (y: number) => codes(issues(net, { start: free(0, -200, y), end: free(0, 200, y), roadType: 'street-2' }));
    expect(at(0)).toEqual([]);
    expect(at(8)).toEqual([]);
    expect(at(4)).toContain('insufficientClearance');
  });

  it('flags a nearly parallel road', () => {
    const net = new RoadNetwork();
    street(net, -300, 0, 300, 0, 'avenue-4');
    const draft = (z: number) => issues(net, { start: free(-200, z), end: free(200, z), roadType: 'avenue-4' });
    expect(codes(draft(100))).toEqual([]);
    expect(codes(draft(14), 'error')).toContain('tooClose');
    expect(codes(draft(17.5), 'warning')).toContain('tooClose');
    // Above it with clearance is fine.
    expect(
      codes(issues(net, { start: free(-200, 0, 8), end: free(200, 0, 8), roadType: 'avenue-4' })),
    ).not.toContain('tooClose');
  });

  it('does not nag about a ramp leaving its own highway', () => {
    const net = new RoadNetwork();
    const s = street(net, -400, 0, 400, 0, 'highway-3');
    const list = issues(net, {
      start: onSeg(s, 0.5),
      end: free(260, 150),
      c1: v(90, 0),
      c2: v(180, 70),
      roadType: 'ramp-1',
    });
    expect(codes(list, 'error')).toEqual([]);
    expect(codes(list)).not.toContain('tooClose');
  });

  it('flags a road crossing itself', () => {
    const net = new RoadNetwork();
    const list = issues(net, {
      start: free(0, 0),
      end: free(100, 0),
      c1: v(300, 300),
      c2: v(-200, 300),
      roadType: 'street-2',
    });
    expect(codes(list)).toContain('selfCrossing');
  });

  it('leaves the network unchanged', () => {
    const net = new RoadNetwork();
    const s = street(net, -200, 0, 200, 0);
    const before = net.signature();
    net.validateDraft({ start: onSeg(s, 0.5), end: free(0, 100), roadType: 'street-2' });
    expect(net.signature()).toBe(before);
  });
});

describe('custom road types', () => {
  it('uses a custom type in a network and saves it', () => {
    const net = new RoadNetwork();
    const def = makeCustomRoadType({ id: 'x-road', forwardLanes: 3, backwardLanes: 1, medianKind: 'paint', medianWidth: 1 });
    net.setCustomRoadType(def);
    const s = street(net, 0, 0, 100, 0, 'x-road');
    expect(net.laneGraph.roadLanes.get(s)).toHaveLength(4);
    const copy = new RoadNetwork(net.serialize());
    expect(copy.roadTypeOf(s).id).toBe('x-road');
    expect(() => net.removeCustomRoadType('x-road')).toThrow(/in use/);
    expect(() => net.setCustomRoadType({ ...def, id: 'street-2' })).toThrow(/built-in/);
    net.removeSegment(s);
    net.removeCustomRoadType('x-road');
    expect(net.roadType('x-road')).toBeUndefined();
  });

  it('rebuilds segments when a custom type is redefined', () => {
    const net = new RoadNetwork();
    net.setCustomRoadType(makeCustomRoadType({ id: 'y', forwardLanes: 1, backwardLanes: 1 }));
    const s = street(net, 0, 0, 100, 0, 'y');
    net.setCustomRoadType(makeCustomRoadType({ id: 'y', forwardLanes: 2, backwardLanes: 2 }));
    expect(net.laneGraph.roadLanes.get(s)).toHaveLength(4);
    expectClean(net);
  });
});

describe('serialization', () => {
  function sample(): RoadNetwork {
    const net = new RoadNetwork();
    net.setProjectName('Sample');
    net.setCustomRoadType(makeCustomRoadType({ id: 'c1', forwardLanes: 2, backwardLanes: 1 }));
    const a = street(net, -300, 0, 300, 0, 'avenue-4');
    const r = net.drawRoad({ start: free(0, -300), end: free(0, 300), roadType: 'c1' });
    net.drawRoad({ start: free(-100, -300, 10), end: free(-100, 300, 10), roadType: 'street-2' });
    const j = r.junctions[0];
    net.setJunctionControl(j, { mode: 'signal', signal: defaultSignalPlan(net, j, 'protectedLefts') });
    net.setSign(net.getSegment(a)!.a, a, 'stop');
    net.setSegmentOverrides(a, { name: 'First Ave', surface: 'concrete', markings: { laneLine: 'solid' } });
    net.addEndpoint({ kind: 'gateway', nodeId: net.getSegment(a)!.a, name: 'West' });
    net.addEndpoint({ kind: 'office', segmentId: r.segments[0], t: 0.4, side: -1 });
    net.addDecal({ kind: 'text', points: [v(5, 5)], color: 'yellow', width: 1, rotation: 0.5, text: 'SLOW' });
    net.setTraffic({ multiplier: 1.5 });
    return net;
  }

  it('round-trips losslessly', () => {
    const net = sample();
    const text = net.serialize();
    const copy = new RoadNetwork(text);
    expect(copy.project).toEqual(net.project);
    expect(copy.serialize()).toBe(text);
    expect(copy.signature()).toBe(net.signature());
    expectClean(copy);
  });

  it('round-trips through split, snapshot and load', () => {
    const net = sample();
    const snap = net.snapshot();
    const before = net.serialize();
    net.splitSegment(net.segments[1].id, 0.3);
    expect(net.serialize()).not.toBe(before);
    net.load(snap);
    expect(net.serialize()).toBe(before);
    expectClean(net);
    // A snapshot stays private to its holder.
    snap.name = 'Changed';
    expect(net.project.name).toBe('Sample');
  });

  it('yields the same lane graph after a round trip', () => {
    const net = sample();
    const copy = new RoadNetwork(net.serialize());
    const a = net.laneGraph;
    const b = copy.laneGraph;
    expect([...b.byKey.keys()].sort()).toEqual([...a.byKey.keys()].sort());
    for (const lane of a.lanes) {
      const other = b.lanes[b.byKey.get(lane.key)!];
      expect(Array.from(other.pts)).toEqual(Array.from(lane.pts));
      expect(other.turn).toBe(lane.turn);
    }
  });

  it('fires a reset event on load', () => {
    const net = sample();
    const events: NetworkChange[] = [];
    net.onChange((e) => events.push(e));
    net.load(net.serialize());
    expect(events).toHaveLength(1);
    expect(events[0].reset).toBe(true);
    expect(events[0].dirtySegments).toHaveLength(net.segments.length);
  });

  it('keeps ids unique after loading', () => {
    const net = sample();
    const copy = new RoadNetwork(net.serialize());
    const id = copy.addNode(v(1, 1));
    expect(net.getNode(id)).toBeUndefined();
    expect(copy.project.nextId).toBeGreaterThan(id);
  });

  it('rebuilds node.segments from the segments', () => {
    const net = sample();
    const raw = JSON.parse(net.serialize());
    for (const n of raw.nodes) n.segments = [999];
    const parsed = parseProject(raw);
    expect(parsed.nodes).toEqual(net.project.nodes);
  });

  it('migrates a file with no version', () => {
    const p = parseProject({ nextId: 3, nodes: [{ id: 1, pos: v(0, 0) }, { id: 2, pos: v(9, 0) }], segments: [] });
    expect(p.version).toBe(1);
    expect(p.traffic.multiplier).toBe(1);
    expect(p.nodes[0].control.mode).toBe('auto');
    expect(p.decals).toEqual([]);
  });

  it('repairs a stale nextId', () => {
    const p = createEmptyProject();
    const raw = { ...p, nextId: 1, nodes: [{ id: 40, pos: v(0, 0), segments: [] }] };
    expect(parseProject(raw).nextId).toBe(41);
  });

  it('rejects garbage with clear errors', () => {
    const good = (): Project => JSON.parse(sample().serialize());
    const bad = (mutate: (p: Project) => void) => {
      const p = good();
      mutate(p);
      return () => parseProject(p);
    };
    expect(() => parseProject('{not json')).toThrow(ProjectFormatError);
    expect(() => parseProject('[1,2]')).toThrow(/expected a project/);
    expect(() => parseProject(null)).toThrow(ProjectFormatError);
    expect(() => parseProject(42)).toThrow(ProjectFormatError);
    expect(bad((p) => ((p as { version: number }).version = 2))).toThrow(/newer/);
    expect(bad((p) => (p.nodes = 'x' as never))).toThrow(/nodes must be a list/);
    expect(bad((p) => (p.nodes[0].pos.x = Number.NaN))).toThrow(/nodes\[0\]\.pos\.x/);
    expect(bad((p) => (p.segments[0].a = 123456))).toThrow(/missing node 123456/);
    expect(bad((p) => (p.segments[0].b = p.segments[0].a))).toThrow(/starts and ends/);
    expect(bad((p) => (p.segments[0].roadType = 'warp-road'))).toThrow(/warp-road/);
    expect(bad((p) => (p.segments[1].id = p.segments[0].id))).toThrow(/reuses id/);
    expect(bad((p) => p.nodes.push({ ...p.nodes[0] }))).toThrow(/reuses id/);
    expect(bad((p) => (p.endpoints[0].nodeId = 99999))).toThrow(/missing node/);
    expect(bad((p) => (p.customRoadTypes[0].lanes[0].dir = 3 as never))).toThrow(/dir/);
    expect(bad((p) => (p.customRoadTypes[0].lanes = []))).toThrow(/no lanes/);
    expect(bad((p) => (p.traffic = null as never))).toThrow(/traffic/);
    expect(bad((p) => ((p.nodes[0].control as { mode: string }).mode = 'chaos'))).toThrow(/chaos/);
  });

  it('leaves the network as it was when load fails', () => {
    const net = sample();
    const before = net.serialize();
    expect(() => net.load('garbage')).toThrow(ProjectFormatError);
    expect(net.serialize()).toBe(before);
    expectClean(net);
  });

  it('clears down to an empty project', () => {
    const net = sample();
    net.clear('Fresh');
    expect(net.project.name).toBe('Fresh');
    expect(net.segments).toHaveLength(0);
    expect(net.laneGraph.lanes).toHaveLength(0);
    expectClean(net);
  });

  it('has a signature that follows content, and a version that follows edits', () => {
    const net = sample();
    const sig = net.signature();
    const version = net.version;
    net.setTraffic({ multiplier: 3 });
    expect(net.signature()).not.toBe(sig);
    expect(net.version).toBe(version + 1);
    net.batch(() => undefined);
    expect(net.version).toBe(version + 1);
  });
});

describe('signals and junction control', () => {
  function crossing(typeA: string, typeB: string, headings: { a: number[]; b: number[] }) {
    const net = new RoadNetwork();
    const hub = net.addNode(v(0, 0));
    const add = (deg: number, type: string) => {
      const r = (deg * Math.PI) / 180;
      const n = net.addNode(v(Math.cos(r) * 200, Math.sin(r) * 200));
      return net.addSegment(hub, n, { roadType: type });
    };
    return { net, hub, a: headings.a.map((d) => add(d, typeA)), b: headings.b.map((d) => add(d, typeB)) };
  }
  const fourWay = { a: [0, 180], b: [90, 270] };

  it('lists movements with turn kinds', () => {
    const { net, hub } = crossing('street-2', 'street-2', fourWay);
    const moves = movementsAt(net, hub);
    expect(moves).toHaveLength(12);
    expect(moves.filter((m) => m.turn === 'left')).toHaveLength(4);
    for (const m of moves) {
      expect(m.key).toBe(`${m.fromSegment}>${m.toSegment}`);
      expect(m.connectors.length).toBeGreaterThan(0);
    }
  });

  it('opposing preset: facing approaches share a phase, lefts permissive', () => {
    const { net, hub } = crossing('street-2', 'street-2', fourWay);
    const plan = defaultSignalPlan(net, hub, 'opposing');
    expect(plan.phases).toHaveLength(2);
    const moves = movementsAt(net, hub);
    for (const m of moves) {
      const owners = plan.phases.filter((p) => p.moves[m.key]);
      expect(owners).toHaveLength(1);
      expect(owners[0].moves[m.key]).toBe(m.turn === 'left' ? 'permissive' : 'protected');
    }
    expect(plan.phases.map((p) => p.id)).toEqual([1, 2]);
    expect(plan.phases[0].yellowSec).toBeGreaterThan(0);
  });

  it('protected lefts preset adds left phases', () => {
    const { net, hub } = crossing('avenue-4', 'avenue-4', fourWay);
    const plan = defaultSignalPlan(net, hub, 'protectedLefts');
    expect(plan.phases).toHaveLength(4);
    const states = plan.phases.flatMap((p) => Object.values(p.moves));
    expect(states).not.toContain('permissive');
    const lefts = movementsAt(net, hub).filter((m) => m.turn === 'left');
    for (const m of lefts) {
      expect(plan.phases.filter((p) => p.moves[m.key] === 'protected')).toHaveLength(1);
    }
    const leftPhases = plan.phases.filter((p) => Object.keys(p.moves).length && lefts.some((l) => p.moves[l.key]));
    for (const p of leftPhases) expect(Object.keys(p.moves).every((k) => lefts.some((l) => l.key === k))).toBe(true);
  });

  it('split preset runs each approach alone', () => {
    const { net, hub, a, b } = crossing('street-2', 'street-2', fourWay);
    const plan = defaultSignalPlan(net, hub, 'split');
    expect(plan.phases).toHaveLength(4);
    for (const p of plan.phases) {
      const sources = new Set(Object.keys(p.moves).map((k) => k.split('>')[0]));
      expect(sources.size).toBe(1);
      expect(Object.values(p.moves).every((s) => s === 'protected')).toBe(true);
    }
    const all = new Set(plan.phases.flatMap((p) => Object.keys(p.moves)));
    expect(all.size).toBe(12);
    expect(a.length + b.length).toBe(4);
  });

  it('handles a 3-way', () => {
    const { net, hub } = crossing('street-2', 'street-2', { a: [0, 180], b: [90] });
    const plan = defaultSignalPlan(net, hub, 'opposing');
    expect(plan.phases).toHaveLength(2);
    const all = plan.phases.flatMap((p) => Object.keys(p.moves));
    expect(new Set(all).size).toBe(movementsAt(net, hub).length);
    expect(all.length).toBe(new Set(all).size);
    const split = defaultSignalPlan(net, hub, 'split');
    expect(split.phases).toHaveLength(3);
  });

  it('handles a 5-way', () => {
    const { net, hub } = crossing('street-2', 'street-2', { a: [0, 180], b: [72, 144, 290] });
    const plan = defaultSignalPlan(net, hub, 'protectedLefts');
    const moves = movementsAt(net, hub);
    const all = new Set(plan.phases.flatMap((p) => Object.keys(p.moves)));
    expect(all.size).toBe(moves.length);
  });

  it('handles one-way arms, skipping those with no way in', () => {
    const net = new RoadNetwork();
    const hub = net.addNode(v(0, 0));
    const e = net.addNode(v(200, 0));
    const w = net.addNode(v(-200, 0));
    const s = net.addNode(v(0, 200));
    const n = net.addNode(v(0, -200));
    const out = net.addSegment(hub, e, { roadType: 'street-2-oneway' });
    const inbound = net.addSegment(w, hub, { roadType: 'street-2-oneway' });
    net.addSegment(hub, s, { roadType: 'street-2' });
    net.addSegment(hub, n, { roadType: 'street-2' });
    const plan = defaultSignalPlan(net, hub, 'split');
    expect(plan.phases).toHaveLength(3);
    expect(plan.phases.flatMap((p) => Object.keys(p.moves)).some((k) => k.startsWith(`${out}>`))).toBe(false);
    const opposing = defaultSignalPlan(net, hub, 'opposing');
    const inPhase = opposing.phases.find((p) => Object.keys(p.moves).some((k) => k.startsWith(`${inbound}>`)))!;
    // With nobody opposite, a left is free to go.
    expect(Object.entries(inPhase.moves).filter(([k]) => k.startsWith(`${inbound}>`)).every(([, st]) => st === 'protected')).toBe(true);
  });

  it('auto: two avenues get a signal', () => {
    const { net, hub } = crossing('avenue-4', 'avenue-4', fourWay);
    const c = effectiveControl(net, hub);
    expect(c.kind).toBe('signal');
    expect(c.auto).toBe(true);
    expect(c.signal!.phases.length).toBeGreaterThanOrEqual(2);
  });

  it('auto: higher rank road has priority, lower yields', () => {
    const { net, hub, a, b } = crossing('avenue-4', 'street-2', fourWay);
    const c = effectiveControl(net, hub);
    expect(c.kind).toBe('priority');
    for (const s of a) expect(c.signs[s]).toBe('priority');
    for (const s of b) expect(c.signs[s]).toBe('yield');
  });

  it('auto: equal ranks pick the busier axis', () => {
    const { net, hub, a, b } = crossing('street-2-bike', 'street-2', fourWay);
    const c = effectiveControl(net, hub);
    expect(c.kind).toBe('priority');
    for (const s of a) expect(c.signs[s]).toBe('priority');
    for (const s of b) expect(c.signs[s]).toBe('yield');
  });

  it('auto: a street T-ing into a street still gives one road priority', () => {
    const { net, hub, a, b } = crossing('street-2', 'street-2', { a: [0, 180], b: [90] });
    const c = effectiveControl(net, hub);
    expect(c.kind).toBe('priority');
    expect(c.signs[a[0]]).toBe('priority');
    expect(c.signs[a[1]]).toBe('priority');
    expect(c.signs[b[0]]).toBe('yield');
  });

  it('auto: merges and diverges on highways have no signs', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-400, 0));
    const n = net.addNode(v(0, 0));
    const b = net.addNode(v(400, 0));
    const c = net.addNode(v(300, 200));
    net.addSegment(a, n, { roadType: 'highway-3' });
    net.addSegment(n, b, { roadType: 'highway-3' });
    net.addSegment(n, c, { roadType: 'ramp-1', c1: v(100, 0), c2: v(200, 80) });
    expect(effectiveControl(net, n)).toEqual({ kind: 'none', signs: {}, signal: null, auto: true });
  });

  it('auto: a ramp ending at a street yields or gets the right control', () => {
    const net = new RoadNetwork();
    const hub = net.addNode(v(0, 0));
    const a = net.addNode(v(-200, 0));
    const b = net.addNode(v(200, 0));
    const c = net.addNode(v(0, -200));
    const s1 = net.addSegment(hub, a, { roadType: 'avenue-4' });
    const s2 = net.addSegment(hub, b, { roadType: 'avenue-4' });
    const ramp = net.addSegment(c, hub, { roadType: 'ramp-1' });
    const ctl = effectiveControl(net, hub);
    expect(ctl.kind).toBe('priority');
    expect(ctl.signs[ramp]).toBe('yield');
    expect(ctl.signs[s1]).toBe('priority');
    expect(ctl.signs[s2]).toBe('priority');
  });

  it('auto: dead ends and plain joints need nothing', () => {
    const { net, hub } = crossing('street-2', 'street-2', { a: [0], b: [180] });
    expect(effectiveControl(net, hub).kind).toBe('none');
    const end = net.deadEnds()[0];
    expect(effectiveControl(net, end).kind).toBe('none');
  });

  it('respects manual modes', () => {
    const { net, hub, a, b } = crossing('street-2', 'street-2', fourWay);
    net.setJunctionControl(hub, { mode: 'allStop' });
    const stop = effectiveControl(net, hub);
    expect(stop.kind).toBe('allStop');
    expect(Object.values(stop.signs)).toEqual(['stop', 'stop', 'stop', 'stop']);
    expect(stop.auto).toBe(false);

    net.setJunctionControl(hub, { mode: 'signal', signal: null });
    expect(effectiveControl(net, hub).signal!.phases).toHaveLength(2);
    const plan = defaultSignalPlan(net, hub, 'split');
    net.setJunctionControl(hub, { signal: plan });
    expect(effectiveControl(net, hub).signal).toEqual(plan);

    net.setJunctionControl(hub, { mode: 'priority', signs: { [b[0]]: 'priority', [b[1]]: 'priority', [a[0]]: 'stop', [a[1]]: 'stop' } });
    const prio = effectiveControl(net, hub);
    expect(prio.signs[b[0]]).toBe('priority');
    expect(prio.signs[a[1]]).toBe('stop');
  });

  it('gives no sign to a road that does not arrive at the node', () => {
    const net = new RoadNetwork();
    const hub = net.addNode(v(0, 0));
    const e = net.addNode(v(200, 0));
    const w = net.addNode(v(-200, 0));
    const s = net.addNode(v(0, 200));
    const out = net.addSegment(hub, e, { roadType: 'street-2-oneway' });
    net.addSegment(hub, w, { roadType: 'street-2' });
    net.addSegment(hub, s, { roadType: 'street-2' });
    const ctl = effectiveControl(net, hub);
    expect(ctl.signs[out]).toBeUndefined();
    expect(Object.keys(ctl.signs)).toHaveLength(2);
  });

  it('dropping an arm strips it from the plan', () => {
    const { net, hub, a } = crossing('street-2', 'street-2', fourWay);
    net.setJunctionControl(hub, { mode: 'signal', signal: defaultSignalPlan(net, hub) });
    net.removeSegment(a[0]);
    const plan = net.getNode(hub)!.control.signal!;
    for (const p of plan.phases) {
      for (const key of Object.keys(p.moves)) expect(key.split('>').map(Number)).not.toContain(a[0]);
    }
    expect(checkNetworkInvariants(net)).toEqual([]);
  });
});

it('dist helper is exported for other modules', () => {
  expect(dist(v(0, 0), v(3, 4))).toBe(5);
});
