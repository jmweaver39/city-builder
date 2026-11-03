import { describe, expect, it } from 'vitest';
import {
  RoadNetwork,
  anchorCurve,
  armFrames,
  boundaryOffsets,
  checkNetworkInvariants,
  curveMidpoint,
  cubicTangentXZ,
  distXZ,
  dotXZ,
  fillerPolygon,
  lineCurve,
  makeCustomRoadType,
  nodeAnchors,
  resolveAnchor,
  type Id,
  type NodeLineMarking,
  type NodeMarkingInit,
} from '../../src/core';
import { expectClean, free } from './helpers';

function crossing(): { net: RoadNetwork; node: Id; arms: Id[] } {
  const net = new RoadNetwork();
  net.drawRoad({ start: free(-200, 0), end: free(200, 0), roadType: 'street-4' });
  const r = net.drawRoad({ start: free(0, -200), end: free(0, 200), roadType: 'street-4' });
  const node = r.junctions[0];
  return { net, node, arms: net.getNode(node)!.segments };
}

const line = (from: Id, to: Id, patch: Partial<NodeLineMarking> = {}): NodeMarkingInit => ({
  kind: 'line',
  from: { segmentId: from, boundary: 1 },
  to: { segmentId: to, boundary: 1 },
  style: 'dashed',
  color: 'white',
  width: 0.15,
  straight: false,
  ...patch,
});

describe('Anchors', () => {
  it('has a boundary at each road edge and lane edge', () => {
    const { net, node } = crossing();
    const street = net.roadType('street-4')!;
    expect(boundaryOffsets(street)).toEqual([-7, -3.5, 0, 3.5, 7]);
    expect(nodeAnchors(net, node)).toHaveLength(20);
    expect(nodeAnchors(net, node).filter((a) => a.edge)).toHaveLength(8);
  });

  it('keeps both sides of a median, and shoulders', () => {
    const def = makeCustomRoadType({ forwardLanes: 1, backwardLanes: 1, medianKind: 'grass', medianWidth: 2, shoulder: 1 });
    expect(boundaryOffsets(def)).toEqual([-5.5, -4.5, -1, 1, 4.5, 5.5]);
  });

  it('sits on the cut line of each arm, on the road surface', () => {
    const { net, node } = crossing();
    const pos = net.getNode(node)!.pos;
    const geom = net.nodeGeom(node)!;
    for (const frame of armFrames(net, node)) {
      const arm = geom.arms.find((a) => a.segmentId === frame.segmentId)!;
      expect(distXZ(frame.pos, arm.centre)).toBeLessThan(0.01);
      // Inward points back at the node.
      const toNode = { x: pos.x - frame.pos.x, y: 0, z: pos.z - frame.pos.z };
      expect(dotXZ(frame.inward, toNode)).toBeGreaterThan(0);
    }
  });

  it('steps back from a plain joint so the two sides are distinct', () => {
    const net = new RoadNetwork();
    const seg = net.drawRoad({ start: free(0, 0), end: free(200, 0), roadType: 'street-2' }).segments[0];
    const { node } = net.splitSegment(seg, 0.5);
    expect(net.nodeGeom(node)!.kind).toBe('plain');
    const dots = nodeAnchors(net, node);
    expect(dots.length).toBeGreaterThan(0);
    const [a, b] = armFrames(net, node);
    expect(distXZ(a.pos, b.pos)).toBeCloseTo(12, 3);
  });

  it('works at a dead end', () => {
    const net = new RoadNetwork();
    const r = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: 'street-2' });
    expect(nodeAnchors(net, r.nodes[0]).length).toBe(3);
  });

  it('is null for a boundary the road no longer has', () => {
    const { net, node, arms } = crossing();
    expect(resolveAnchor(net, node, { segmentId: arms[0], boundary: 4 })).not.toBeNull();
    expect(resolveAnchor(net, node, { segmentId: arms[0], boundary: 5 })).toBeNull();
    expect(resolveAnchor(net, node, { segmentId: 9999, boundary: 0 })).toBeNull();
  });
});

describe('Curves', () => {
  it('leaves and arrives along the lane direction at both ends', () => {
    const { net, node, arms } = crossing();
    const id = net.addNodeMarking(node, line(arms[0], arms[1]));
    const m = net.getNode(node)!.control.markings!.find((x) => x.id === id) as NodeLineMarking;
    const c = lineCurve(net, node, m)!;
    const p = resolveAnchor(net, node, m.from)!;
    const q = resolveAnchor(net, node, m.to)!;
    expect(dotXZ(cubicTangentXZ(c, 0), p.inward)).toBeCloseTo(1, 6);
    // Arriving at q runs opposite to q's inward direction.
    expect(dotXZ(cubicTangentXZ(c, 1), q.inward)).toBeCloseTo(-1, 6);
  });

  it('straight is a chord', () => {
    const { net, node, arms } = crossing();
    const p = resolveAnchor(net, node, { segmentId: arms[0], boundary: 0 })!;
    const q = resolveAnchor(net, node, { segmentId: arms[0], boundary: 4 })!;
    const c = anchorCurve(p, q, true);
    const mid = curveMidpoint(c);
    expect(mid.x).toBeCloseTo((p.pos.x + q.pos.x) / 2, 6);
    expect(mid.z).toBeCloseTo((p.pos.z + q.pos.z) / 2, 6);
  });

});

describe('Editing and persistence', () => {
  it('adds, edits and removes, and changes no lane graph', () => {
    const { net, node, arms } = crossing();
    const graph = net.laneGraph;
    const v = net.version;
    const id = net.addNodeMarking(node, line(arms[0], arms[1]));
    expect(net.version).toBe(v + 1);
    expect(net.laneGraph).toBe(graph);
    net.updateNodeMarking(node, id, { color: 'yellow', style: 'solid' });
    expect(net.getNode(node)!.control.markings![0]).toMatchObject({ id, kind: 'line', color: 'yellow', style: 'solid' });
    net.removeNodeMarking(node, id);
    expect(net.getNode(node)!.control.markings).toBeUndefined();
  });

  it('reports the node in the change event', () => {
    const { net, node, arms } = crossing();
    const seen: Id[][] = [];
    net.onChange((c) => seen.push(c.dirtyNodes));
    net.addNodeMarking(node, line(arms[0], arms[1]));
    net.setHideAutoMarkings(node, true);
    expect(seen).toEqual([[node], [node]]);
  });

  it('refuses a marking on a road that is not at the node', () => {
    const { net, node } = crossing();
    const other = net.drawRoad({ start: free(500, 500), end: free(600, 500), roadType: 'street-2' }).segments[0];
    expect(() => net.addNodeMarking(node, line(other, other))).toThrow(/not at node/);
  });

  it('follows the road when a node moves', () => {
    const { net, node, arms } = crossing();
    const armId = arms[0];
    const id = net.addNodeMarking(node, line(arms[0], arms[1]));
    const m = () => net.getNode(node)!.control.markings!.find((x) => x.id === id) as NodeLineMarking;
    const before = lineCurve(net, node, m())!;
    net.moveNode(node, { x: 30, y: 0, z: 20 });
    const after = lineCurve(net, node, m())!;
    expect(distXZ(before.p0, after.p0)).toBeGreaterThan(10);
    expect(m().from.segmentId).toBe(armId);
    expectClean(net);
  });

  it('carries over a split of the far side of an arm', () => {
    const { net, node, arms } = crossing();
    // Split each arm: whichever id the near side ends up with, anchors must stay on it.
    const id = net.addNodeMarking(node, line(arms[0], arms[1]));
    for (const seg of [...arms]) net.splitSegment(seg, 0.5);
    const m = net.getNode(node)!.control.markings!.find((x) => x.id === id) as NodeLineMarking;
    const here = net.getNode(node)!.segments;
    expect(here).toContain(m.from.segmentId);
    expect(here).toContain(m.to.segmentId);
    expect(lineCurve(net, node, m)).not.toBeNull();
    expect(checkNetworkInvariants(net)).toEqual([]);
  });

  it('renames fillers too', () => {
    const { net, node, arms } = crossing();
    net.addNodeMarking(node, {
      kind: 'filler',
      fill: 'hatch',
      color: 'white',
      width: 0.2,
      anchors: arms.slice(0, 3).map((segmentId) => ({ segmentId, boundary: 0 })),
    });
    for (const seg of [...arms]) net.splitSegment(seg, 0.5);
    const m = net.getNode(node)!.control.markings![0];
    expect(m.kind === 'filler' && fillerPolygon(net, node, m)).toBeTruthy();
    expectClean(net);
  });

  it('drops markings whose arm is removed, and only those', () => {
    const { net, node, arms } = crossing();
    const gone = net.addNodeMarking(node, line(arms[0], arms[1]));
    const kept = net.addNodeMarking(node, line(arms[2], arms[3]));
    const filler = net.addNodeMarking(node, {
      kind: 'filler',
      fill: 'solid',
      color: 'red',
      width: 0.2,
      anchors: [arms[0], arms[2], arms[3]].map((segmentId) => ({ segmentId, boundary: 0 })),
    });
    net.removeSegment(arms[0]);
    const ids = net.getNode(node)!.control.markings!.map((m) => m.id);
    expect(ids).toEqual([kept]);
    expect(ids).not.toContain(gone);
    expect(ids).not.toContain(filler);
    expectClean(net);
  });

  it('round trips through serialize with the same signature', () => {
    const { net, node, arms } = crossing();
    net.addNodeMarking(node, line(arms[0], arms[1], { straight: true }));
    net.setHideAutoMarkings(node, true);
    const back = new RoadNetwork(net.serialize());
    expect(back.signature()).toBe(net.signature());
    expect(back.getNode(node)!.control.hideAutoMarkings).toBe(true);
    const next = back.addNodeMarking(node, line(arms[0], arms[2]));
    expect(back.getNode(node)!.control.markings![0].id).toBeLessThan(next);
  });

  it('loads old saves with neither field and adds neither', () => {
    const { net } = crossing();
    const data = JSON.parse(net.serialize());
    for (const n of data.nodes) {
      expect(n.control.markings).toBeUndefined();
      expect('hideAutoMarkings' in n.control).toBe(false);
    }
    const back = new RoadNetwork(data);
    expect(back.signature()).toBe(net.signature());
  });

  it('refuses a malformed marking, and drops one naming a road not at the node', () => {
    const { net, node, arms } = crossing();
    net.addNodeMarking(node, line(arms[0], arms[1]));
    const data = JSON.parse(net.serialize());
    const n = data.nodes.find((x: { id: Id }) => x.id === node);
    const good = n.control.markings[0];
    n.control.markings = [{ ...good, kind: 'nonsense' }];
    expect(() => new RoadNetwork(structuredClone(data))).toThrow(/kind is unknown/);
    n.control.markings = [{ ...good, from: { segmentId: 99999, boundary: 0 } }];
    expect(new RoadNetwork(data).getNode(node)!.control.markings).toBeUndefined();
  });

  it('survives undo-style snapshot and load', () => {
    const { net, node, arms } = crossing();
    const snap = net.snapshot();
    net.addNodeMarking(node, line(arms[0], arms[1]));
    net.load(snap);
    expect(net.getNode(node)!.control.markings).toBeUndefined();
    expect(checkNetworkInvariants(net)).toEqual([]);
  });
});
