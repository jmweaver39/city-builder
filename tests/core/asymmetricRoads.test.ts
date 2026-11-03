import { describe, expect, it } from 'vitest';
import {
  RoadNetwork,
  boundaryOffsets,
  checkNetworkInvariants,
  isOneWay,
  lanesMirror,
  makeCustomRoadType,
  roadEdges,
  roadTypeProblems,
  sidewalkOn,
  totalHalfWidth,
  type CustomLane,
  type GLane,
  type Id,
  type RoadTypeDef,
} from '../../src/core';
import { Simulation } from '../../src/sim/Simulation';
import { connectedRoadOriented, mirroredLane, upgradeSegment } from '../../src/tools/roadOps';
import { expectClean, expectConnectorsContinuous, free, atNode, firstPoint, lastPoint } from './helpers';

const lane = (kind: CustomLane['kind'], dir: 1 | -1, width = 3.5): CustomLane => ({ kind, dir, width });

/** Two bus lanes and a drive lane one way, one bus lane and a drive lane the other. */
function uneven(extra: Parameters<typeof makeCustomRoadType>[0] = {}): RoadTypeDef {
  return makeCustomRoadType({
    id: 'custom-uneven',
    name: 'Uneven',
    lanes: [lane('bus', -1), lane('drive', -1), lane('drive', 1), lane('bus', 1), lane('bus', 1)],
    speedKmh: 50,
    ...extra,
  });
}

function netWith(def: RoadTypeDef): RoadNetwork {
  const net = new RoadNetwork();
  net.setCustomRoadType(def);
  return net;
}

/** Lanes of a segment by index. */
const lanesOf = (net: RoadNetwork, id: Id): GLane[] => {
  const g = net.laneGraph;
  return g.roadLanes.get(id)!.map((i) => g.lanes[i]);
};

describe('Uneven road layout', () => {
  it('centres the pavement, so the direction boundary is off the centreline', () => {
    const def = uneven();
    expect(roadTypeProblems(def)).toEqual([]);
    expect(def.halfWidth).toBeCloseTo(8.75, 9);
    expect(def.lanes.map((l) => l.offset)).toEqual([-7, -3.5, 0, 3.5, 7]);
    // The boundary between directions is at -1.75, left of the centreline.
    const edge = def.lanes[1].offset + def.lanes[1].width / 2;
    expect(edge).toBeCloseTo(-1.75, 9);
    expect(lanesMirror(def)).toBe(false);
    expect(isOneWay(def)).toBe(false);
  });

  it('allows different widths per lane', () => {
    const def = makeCustomRoadType({ lanes: [lane('drive', -1, 3), lane('bus', 1, 4.5), lane('bike', 1, 1.5)] });
    expect(roadTypeProblems(def)).toEqual([]);
    expect(def.halfWidth).toBeCloseTo(4.5, 9);
  });

  it('puts a median anywhere in the strip, off-centre', () => {
    const def = uneven({ medianKind: 'grass', medianWidth: 2 });
    expect(def.median.offset).toBeCloseTo(-1.75 - 1 + 1, 6);
    const later = uneven({ medianKind: 'grass', medianWidth: 2, medianIndex: 3 });
    expect(later.median.offset).toBeGreaterThan(1);
    expect(roadTypeProblems(later)).toEqual([]);
    const a = later.lanes[2];
    const b = later.lanes[3];
    expect(b.offset - b.width / 2 - (a.offset + a.width / 2)).toBeCloseTo(2, 9);
    // Same direction either side of it: a one-way can have one as well.
    const oneWay = makeCustomRoadType({ lanes: [lane('drive', 1), lane('bus', 1)], medianKind: 'grass', medianWidth: 1, medianIndex: 1 });
    expect(oneWay.median.kind).toBe('grass');
  });

  it('keeps a sidewalk on one side only', () => {
    const def = uneven({ sidewalkLeft: 0, sidewalkRight: 3 });
    expect(sidewalkOn(def, -1)).toBe(0);
    expect(sidewalkOn(def, 1)).toBe(3);
    expect(def.sidewalk).toBe(3);
    expect(totalHalfWidth(def)).toBeCloseTo(def.halfWidth + 3, 9);
    const net = netWith(def);
    const id = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: def.id }).segments[0];
    const edges = roadEdges(net.segmentGeom(id)!, def);
    expect(edges.outerLeft).toBe(edges.left);
    expect(edges.outerRight[0].z).toBeCloseTo(def.halfWidth + 3, 6);
  });

  it('keeps shoulders on one side only, shifting the lanes', () => {
    const def = makeCustomRoadType({ lanes: [lane('drive', 1)], shoulderLeft: 0, shoulderRight: 3 });
    expect(def.lanes[0].offset).toBeCloseTo(-1.5, 9);
    expect(def.halfWidth).toBeCloseTo(3.25, 9);
  });

  it('symmetric lists still come out mirrored, with no new fields', () => {
    const def = makeCustomRoadType({ lanes: [lane('drive', -1), lane('drive', 1)], sidewalkWidth: 2, medianKind: 'grass', medianWidth: 2 });
    expect(def.lanes.map((l) => l.offset)).toEqual([-2.75, 2.75]);
    expect(lanesMirror(def)).toBe(true);
    expect('sidewalkLeft' in def).toBe(false);
    expect('offset' in def.median).toBe(false);
  });

  it('still refuses traffic on the wrong side', () => {
    const def = structuredClone(uneven());
    const [a, b] = [def.lanes[1], def.lanes[2]];
    a.dir = 1;
    b.dir = -1;
    expect(roadTypeProblems(def).join()).toMatch(/must sit left/);
  });

  it('round trips the per-side fields', () => {
    const def = uneven({ sidewalkLeft: 1, sidewalkRight: 3, medianKind: 'grass', medianWidth: 2 });
    const net = netWith(def);
    net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: def.id });
    const back = new RoadNetwork(net.serialize());
    expect(back.signature()).toBe(net.signature());
    expect(back.roadType(def.id)!.sidewalkLeft).toBe(1);
    expect(back.roadType(def.id)!.median.offset).toBeCloseTo(def.median.offset!, 9);
  });
});

describe('Traffic keeps right on an uneven road', () => {
  /** A lane's world side relative to its travel direction, from its opposing lane. */
  function checkRightHand(net: RoadNetwork, id: Id): void {
    const lanes = lanesOf(net, id);
    const forward = lanes.filter((l) => net.getSegment(id) && net.roadTypeOf(id).lanes[l.laneIndex].dir === 1);
    const backward = lanes.filter((l) => net.roadTypeOf(id).lanes[l.laneIndex].dir === -1);
    for (const f of forward) {
      for (const b of backward) {
        // Travelling along f, b must be on the left, so the cross product is negative.
        const a = firstPoint(f);
        const e = lastPoint(f);
        const dx = e.x - a.x;
        const dz = e.z - a.z;
        const rel = { x: firstPoint(b).x - a.x, z: firstPoint(b).z - a.z };
        expect(dx * rel.z - dz * rel.x).toBeLessThan(0);
      }
    }
  }

  it('holds drawn each way, and the layout mirrors', () => {
    const def = uneven();
    const net = netWith(def);
    const east = net.drawRoad({ start: free(0, 0), end: free(200, 0), roadType: def.id }).segments[0];
    const west = net.drawRoad({ start: free(200, 100), end: free(0, 100), roadType: def.id }).segments[0];
    checkRightHand(net, east);
    checkRightHand(net, west);
    // Drawn east, the three forward lanes go east. Drawn west, they go west.
    const count = (id: Id, sign: number) =>
      lanesOf(net, id).filter((l) => (lastPoint(l).x - firstPoint(l).x) * sign > 0).length;
    expect(count(east, 1)).toBe(3);
    expect(count(west, -1)).toBe(3);
  });
});

describe('Uneven road through a 4-way', () => {
  function fourWay(cross = 'street-4') {
    const def = uneven({ sidewalkLeft: 0, sidewalkRight: 2 });
    const net = netWith(def);
    net.drawRoad({ start: free(-300, 0), end: free(300, 0), roadType: def.id });
    const r = net.drawRoad({ start: free(0, -300), end: free(0, 300), roadType: cross });
    const node = r.junctions[0];
    const arms = net.nodeGeom(node)!.arms;
    const west = arms.find((a) => a.dir.x < -0.9)!.segmentId;
    const east = arms.find((a) => a.dir.x > 0.9)!.segmentId;
    return { net, def, node, west, east };
  }

  it('is a clean junction with continuous connectors', () => {
    const { net, node } = fourWay();
    expectClean(net);
    expect(net.nodeGeom(node)!.kind).toBe('junction');
    expect(net.nodeGeom(node)!.outline.length).toBeGreaterThan(3);
    expectConnectorsContinuous(net.laneGraph, node, 5);
  });

  it('every drive lane has a way out and every leaving lane a way in', () => {
    const { net, west, east } = fourWay();
    for (const id of [west, east]) {
      for (const l of lanesOf(net, id)) {
        if (l.vehicleKind !== 'drive') continue;
        expect(l.next.length + l.prev.length).toBeGreaterThan(0);
      }
    }
    expect(lanesOf(net, west).filter((l) => l.next.length > 0).length).toBeGreaterThan(0);
  });

  it('through traffic pairs lanes sensibly, and buses stay on bus lanes', () => {
    const { net, west, east } = fourWay();
    const g = net.laneGraph;
    const straightTargets = (from: GLane) =>
      from.next.map((i) => g.lanes[i]).filter((c) => c.turn === 'straight').map((c) => g.lanes[c.toLane]);
    const towards = lanesOf(net, west).filter((l) => net.roadTypeOf(west).lanes[l.laneIndex].dir === 1);
    const forwardBus = towards.filter((l) => l.vehicleKind === 'bus');
    expect(forwardBus).toHaveLength(2);
    const targets = new Set<number>();
    for (const b of forwardBus) {
      const out = straightTargets(b);
      expect(out.length).toBeGreaterThan(0);
      for (const t of out) {
        expect(t.segmentId).toBe(east);
        expect(t.vehicleKind).toBe('bus');
        targets.add(t.laneIndex);
      }
    }
    // Each of the two bus lanes keeps its own lane through the junction.
    expect(targets.size).toBe(2);
    const car = towards.find((l) => l.vehicleKind === 'drive')!;
    for (const t of straightTargets(car)) expect(t.vehicleKind).toBe('drive');
  });

  it('runs in the simulation with nobody stuck', () => {
    const { net } = fourWay();
    const sim = new Simulation(net);
    for (let i = 0; i < 3000; i++) sim.step();
    const s = sim.stats();
    expect(s.spawnedTotal).toBeGreaterThan(50);
    expect(s.arrivedTotal).toBeGreaterThan(10);
    expect(s.despawnedStuck).toBe(0);
  });
});

describe('Joining an uneven road to itself', () => {
  it('end to end is a plain joint with the lanes lined up', () => {
    const def = uneven();
    const net = netWith(def);
    const a = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: def.id });
    const b = net.drawRoad({ start: atNode(a.nodes[1]), end: free(200, 0), roadType: def.id });
    expect(net.nodeGeom(a.nodes[1])!.kind).toBe('plain');
    const l = lanesOf(net, a.segments[0])[3];
    expect(l.next.map((i) => net.laneGraph.lanes[i].key)).toEqual([`r${b.segments[0]}:3`]);
    expectClean(net);
  });

  it('head on is a junction, lanes merge, and no drive lane is stranded', () => {
    const def = uneven();
    const net = netWith(def);
    const a = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: def.id });
    net.drawRoad({ start: free(200, 0), end: atNode(a.nodes[1]), roadType: def.id });
    const geom = net.nodeGeom(a.nodes[1])!;
    expect(geom.kind).toBe('junction');
    expect(geom.outline.length).toBeGreaterThan(3);
    expectClean(net);
    expect(checkNetworkInvariants(net)).toEqual([]);
    const sim = new Simulation(net);
    for (let i = 0; i < 2000; i++) sim.step();
    expect(sim.stats().despawnedStuck).toBe(0);
  });
});

describe('Reversing an uneven road', () => {
  function placed() {
    const def = uneven({ sidewalkLeft: 0, sidewalkRight: 2 });
    const net = netWith(def);
    const id = net.drawRoad({ start: free(0, 0), end: free(200, 0), roadType: def.id }).segments[0];
    return { net, def, id };
  }

  it('swaps which way the bigger side runs, in place', () => {
    const { net, id } = placed();
    const seg = net.getSegment(id)!;
    const [a, b] = [seg.a, seg.b];
    expect(upgradeSegment(net, id, seg.roadType, true)).toBe(id);
    expect(net.getSegment(id)).toMatchObject({ a: b, b: a });
    const west = lanesOf(net, id).filter((l) => lastPoint(l).x < firstPoint(l).x);
    expect(west).toHaveLength(3);
    expectClean(net);
  });

  it('leaves a mirrored road alone', () => {
    const net = new RoadNetwork();
    const id = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: 'street-2' }).segments[0];
    expect(upgradeSegment(net, id, 'street-2', true)).toBe(id);
  });

  it('mirrors marking anchors with the road', () => {
    const { net, id } = placed();
    const seg = net.getSegment(id)!;
    const count = boundaryOffsets(net.roadTypeOf(id)).length;
    net.addNodeMarking(seg.b, {
      kind: 'line',
      from: { segmentId: id, boundary: 0 },
      to: { segmentId: id, boundary: 2 },
      style: 'stopLine',
      color: 'white',
      width: 0.5,
      straight: true,
    });
    const b = seg.b;
    net.reverseSegment(id);
    const m = net.getNode(b)!.control.markings![0];
    expect(m.kind === 'line' && m.from).toEqual({ segmentId: id, boundary: count - 1 });
    expect(m.kind === 'line' && m.to).toEqual({ segmentId: id, boundary: count - 3 });
  });
});

describe('Whole road on pieces drawn either way', () => {
  it('finds which pieces are flipped and lines up their lanes', () => {
    const net = new RoadNetwork();
    const a = net.drawRoad({ start: free(0, 0), end: free(100, 0), roadType: 'street-4' });
    const b = net.drawRoad({ start: free(200, 0), end: atNode(a.nodes[1]), roadType: 'street-4' });
    const c = net.drawRoad({ start: atNode(a.nodes[0]), end: free(-100, 0), roadType: 'street-4' });
    const pieces = connectedRoadOriented(net, a.segments[0]);
    const flip = (id: Id) => pieces.find((p) => p.id === id)!.flipped;
    expect(flip(a.segments[0])).toBe(false);
    expect(flip(b.segments[0])).toBe(true);
    expect(flip(c.segments[0])).toBe(true);
    const def = net.roadType('street-4')!;
    expect(mirroredLane(def.lanes, 0)).toBe(3);
    expect(mirroredLane(def.lanes, 2)).toBe(1);
  });

  it('gives -1 when an uneven road has no matching lane', () => {
    const def = uneven();
    expect(mirroredLane(def.lanes, 2)).toBe(-1);
  });
});
