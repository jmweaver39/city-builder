import { describe, expect, it } from 'vitest';
import {
  MAX_TRIM,
  RoadNetwork,
  dist,
  effectiveControl,
  polygonSelfIntersects,
  type GLane,
  type Id,
  type Vec3,
} from '../../src/core';
import {
  atNode,
  degreesBetween,
  endDir,
  expectClean,
  expectConnectorsContinuous,
  firstPoint,
  lanesWithoutExit,
  free,
  lastPoint,
  movementKeys,
  onSeg,
  startDir,
  v,
} from './helpers';

/** Spokes from one hub, each drawn as the given road type outward from it. */
function star(type: string, headings: number[], length = 150, y = 0) {
  const net = new RoadNetwork();
  const hub = net.addNode(v(0, 0, y));
  const arms: Id[] = headings.map((deg) => {
    const a = (deg * Math.PI) / 180;
    const end = net.addNode(v(Math.cos(a) * length, Math.sin(a) * length, y));
    return net.addSegment(hub, end, { roadType: type });
  });
  return { net, hub, arms };
}

/** The real rounded outline is simple. The hull fallback must not have stepped in. */
function expectCurvedOutline(net: RoadNetwork, n: Id): void {
  const g = net.nodeGeom(n)!;
  expect(g.outlineSimplified, `node ${n} fell back to a hull`).toBe(false);
  expect(polygonSelfIntersects(g.outline), `node ${n} outline`).toBe(false);
  expect(polygonSelfIntersects(g.outerOutline), `node ${n} outer outline`).toBe(false);
}

/** True for a star road lane heading towards the hub at the origin. */
const intoHub = (l: GLane) => dist(lastPoint(l), v(0, 0)) < dist(firstPoint(l), v(0, 0));

function lanesOf(net: RoadNetwork, seg: Id): GLane[] {
  const g = net.laneGraph;
  return g.roadLanes.get(seg)!.map((i) => g.lanes[i]);
}

/** Highway running +x through x = 0, with a node there. */
function mainline(lanesIn: string, lanesOut: string) {
  const net = new RoadNetwork();
  const a = net.addNode(v(-400, 0));
  const n = net.addNode(v(0, 0));
  const b = net.addNode(v(400, 0));
  const inSeg = net.addSegment(a, n, { roadType: lanesIn });
  const outSeg = net.addSegment(n, b, { roadType: lanesOut });
  return { net, a, n, b, inSeg, outSeg };
}

/** Every drive lane that is not on a true dead-end road can leave the node. */
function expectAllLeave(net: RoadNetwork, n: Id): void {
  const graph = net.laneGraph;
  const geom = net.nodeGeom(n)!;
  for (const arm of geom.arms) {
    for (const lane of lanesOf(net, arm.segmentId)) {
      const towardNode = dist(lastPoint(lane), arm.centre) < dist(firstPoint(lane), arm.centre);
      if (towardNode) expect(lane.next.length, `${lane.key} needs an exit`).toBeGreaterThan(0);
      else expect(lane.prev.length, `${lane.key} needs a feeder`).toBeGreaterThan(0);
    }
  }
  expect(graph.version).toBeGreaterThan(0);
}

describe('right-hand traffic', () => {
  it('puts the lane going +x at larger z, from the right-vector rule', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-50, 0));
    const b = net.addNode(v(50, 0));
    const seg = net.addSegment(a, b, { roadType: 'street-2' });
    const [back, fwd] = lanesOf(net, seg);
    // right of +x is (-0, 0, 1), so the forward lane sits at positive z.
    expect(firstPoint(fwd).z).toBeGreaterThan(0);
    expect(firstPoint(back).z).toBeLessThan(0);
    expect(firstPoint(fwd).z).toBeCloseTo(1.75);
    expect(lastPoint(fwd).x).toBeGreaterThan(firstPoint(fwd).x);
    expect(lastPoint(back).x).toBeLessThan(firstPoint(back).x);
    expectClean(net);
  });

  it('keeps opposite directions on opposite sides of any heading', () => {
    for (const deg of [0, 37, 90, 133, 180, 255, 311]) {
      const a = (deg * Math.PI) / 180;
      const net = new RoadNetwork();
      const p = net.addNode(v(0, 0));
      const q = net.addNode(v(Math.cos(a) * 100, Math.sin(a) * 100));
      const seg = net.addSegment(p, q, { roadType: 'street-4' });
      for (const lane of lanesOf(net, seg)) {
        const d = startDir(lane);
        const mid = firstPoint(lane);
        // The centreline passes through p and q. Each lane must have it on its left.
        const toCentre = { x: -mid.x, z: -mid.z };
        const lateral = -d.z * -toCentre.x + d.x * -toCentre.z;
        expect(lateral).toBeGreaterThan(0);
      }
    }
  });

  it('builds a one-way road along the direction drawn', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(100, 0));
    const seg = net.addSegment(a, b, { roadType: 'highway-3' });
    const lanes = lanesOf(net, seg);
    expect(lanes).toHaveLength(3);
    expect(lanes.every((l) => lastPoint(l).x > firstPoint(l).x)).toBe(true);
    expect(lanes[0].right).toBe(lanes[1].idx);
    expect(lanes[1].left).toBe(lanes[0].idx);
    expect(lanes[0].left).toBe(-1);
    expect(lanes[2].right).toBe(-1);
  });

  it('gives left and right as the driver sees them on the backward side', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(100, 0));
    const seg = net.addSegment(a, b, { roadType: 'street-4' });
    const lanes = lanesOf(net, seg);
    // Backward lanes travel -x. Their left is +z, towards the centreline.
    const [outer, inner] = lanes;
    expect(firstPoint(outer).z).toBeLessThan(firstPoint(inner).z);
    expect(outer.left).toBe(inner.idx);
    expect(inner.right).toBe(outer.idx);
  });
});

describe('straight 4-way', () => {
  const { net, hub, arms } = star('street-2', [0, 90, 180, 270]);

  it('sorts arms clockwise from above', () => {
    const g = net.nodeGeom(hub)!;
    expect(g.arms).toHaveLength(4);
    // Clockwise from above is +x, +z, -x, -z.
    const order = g.arms.map((a) => [Math.round(a.dir.x) + 0, Math.round(a.dir.z) + 0]);
    const start = order.findIndex(([x]) => x === 1);
    const walked = [0, 1, 2, 3].map((i) => order[(start + i) % 4]);
    expect(walked).toEqual([
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ]);
  });

  it('has three moves per arm and no u-turns', () => {
    const graph = net.laneGraph;
    const moves = movementKeys(graph, hub);
    expect(moves.size).toBe(12);
    for (const from of arms) {
      const out = [...moves].filter((m) => m.startsWith(`${from}>`));
      expect(out).toHaveLength(3);
      expect(out).not.toContain(`${from}>${from}`);
    }
    const turns = (graph.connectorsAt.get(hub) ?? []).map((i) => graph.lanes[i].turn);
    expect(turns.filter((t) => t === 'left')).toHaveLength(4);
    expect(turns.filter((t) => t === 'right')).toHaveLength(4);
    expect(turns.filter((t) => t === 'straight')).toHaveLength(4);
    expect(turns).not.toContain('uturn');
  });

  it('connects lane ends within 1 cm and tangents within 3 degrees', () => {
    expectConnectorsContinuous(net.laneGraph, hub, 3);
  });

  it('starts each connector from a lane heading into the junction', () => {
    const graph = net.laneGraph;
    for (const idx of graph.connectorsAt.get(hub)!) {
      const c = graph.lanes[idx];
      const from = graph.lanes[c.fromLane];
      const to = graph.lanes[c.toLane];
      expect(from.kind).toBe('road');
      expect(to.kind).toBe('road');
      expect(dist(lastPoint(from), v(0, 0))).toBeLessThan(dist(firstPoint(from), v(0, 0)));
      expect(dist(firstPoint(to), v(0, 0))).toBeLessThan(dist(lastPoint(to), v(0, 0)));
      expect(from.segmentId).not.toBe(to.segmentId);
    }
  });

  it('classifies turns by the driver\'s side', () => {
    const graph = net.laneGraph;
    for (const idx of graph.connectorsAt.get(hub)!) {
      const c = graph.lanes[idx];
      const a = startDir(c);
      const b = endDir(c);
      const cross = a.x * b.z - a.z * b.x;
      if (c.turn === 'right') expect(cross).toBeGreaterThan(0.9);
      if (c.turn === 'left') expect(cross).toBeLessThan(-0.9);
      if (c.turn === 'straight') expect(Math.abs(cross)).toBeLessThan(0.1);
    }
  });

  it('computes conflicts by intersection', () => {
    const graph = net.laneGraph;
    const ids = graph.connectorsAt.get(hub)!;
    const kinds = new Set(ids.flatMap((i) => graph.lanes[i].conflicts.map((c) => c.kind)));
    expect(kinds).toEqual(new Set(['cross', 'merge', 'diverge']));
    const straight = ids.map((i) => graph.lanes[i]).filter((l) => l.turn === 'straight');
    const crossings = straight[0].conflicts.filter((c) => c.kind === 'cross' && graph.lanes[c.lane].turn === 'straight');
    expect(crossings).toHaveLength(2);
    for (const c of crossings) {
      expect(c.selfS).toBeGreaterThan(0);
      expect(c.selfS).toBeLessThan(straight[0].length);
      const back = graph.lanes[c.lane].conflicts.find((x) => x.lane === straight[0].idx)!;
      expect(back.selfS).toBeCloseTo(c.otherS, 3);
    }
  });

  it('labels same-exit and same-entry pairs as merge and diverge', () => {
    const graph = net.laneGraph;
    for (const i of graph.connectorsAt.get(hub)!) {
      const a = graph.lanes[i];
      for (const c of a.conflicts) {
        const b = graph.lanes[c.lane];
        if (c.kind === 'merge') expect(b.toLane).toBe(a.toLane);
        if (c.kind === 'diverge') expect(b.fromLane).toBe(a.fromLane);
        if (c.kind === 'cross') {
          expect(b.toLane).not.toBe(a.toLane);
          expect(b.fromLane).not.toBe(a.fromLane);
        }
      }
    }
  });

  it('builds a simple clockwise outline', () => {
    const g = net.nodeGeom(hub)!;
    expect(g.outline.length).toBeGreaterThan(8);
    expectCurvedOutline(net, hub);
    let area = 0;
    g.outline.forEach((p, i) => {
      const q = g.outline[(i + 1) % g.outline.length];
      area += p.x * q.z - q.x * p.z;
    });
    expect(area).toBeGreaterThan(0);
    expect(g.outerOutline.length).toBeGreaterThan(8);
  });

  it('labels arm edges as seen looking at the node', () => {
    const g = net.nodeGeom(hub)!;
    const east = g.arms.find((a) => a.dir.x > 0.9)!;
    // Looking at the node from +x means facing -x, so left is +z.
    expect(east.leftEdge.z).toBeGreaterThan(east.rightEdge.z);
    expect(east.trim).toBeGreaterThan(5);
  });
});

describe('junction shapes', () => {
  it.each([
    ['T', [0, 90, 180]],
    ['Y', [0, 120, 240]],
    ['skew 4-way', [10, 80, 190, 290]],
    ['5-way', [0, 72, 144, 216, 288]],
    ['6-way', [0, 60, 120, 180, 240, 300]],
    ['sharp pair', [0, 25, 180]],
  ])('%s has exits for every lane and a simple outline', (_name, headings) => {
    for (const type of ['street-2', 'street-4', 'avenue-4', 'boulevard-8', 'street-2-bike', 'avenue-4-bus']) {
      const { net, hub } = star(type, headings);
      expectClean(net);
      expectAllLeave(net, hub);
      expectConnectorsContinuous(net.laneGraph, hub, 6);
      expectCurvedOutline(net, hub);
      const graph = net.laneGraph;
      for (const i of graph.connectorsAt.get(hub)!) expect(graph.lanes[i].turn).not.toBe('uturn');
    }
  });

  it('gives a multi-lane approach sensible moves', () => {
    const { net, hub, arms } = star('avenue-6', [0, 90, 180, 270]);
    const graph = net.laneGraph;
    const conn = graph.connectorsAt.get(hub)!.map((i) => graph.lanes[i]);
    const west = arms[2];
    const lanes = lanesOf(net, west).filter(intoHub);
    expect(lanes).toHaveLength(3);
    const bySide = lanes.sort((a, b) => firstPoint(a).z - firstPoint(b).z);
    // Road runs from the hub to -x. Inbound lanes travel +x; driver's left is -z.
    const turnsFrom = (l: GLane) => new Set(conn.filter((c) => c.fromLane === l.idx).map((c) => c.turn));
    expect(turnsFrom(bySide[0])).toEqual(new Set(['left']));
    expect(turnsFrom(bySide[1])).toEqual(new Set(['straight']));
    expect(turnsFrom(bySide[2])).toEqual(new Set(['right']));
    // Every lane leaving the junction is fed too.
    expectAllLeave(net, hub);
  });

  it('keeps cars out of bus-only turns and keeps bikes on bike lanes', () => {
    const { net, hub } = star('avenue-4-bus', [0, 90, 180, 270]);
    const graph = net.laneGraph;
    for (const i of graph.connectorsAt.get(hub)!) {
      const c = graph.lanes[i];
      const from = graph.lanes[c.fromLane].vehicleKind;
      const to = graph.lanes[c.toLane].vehicleKind;
      if (from === 'bus' || to === 'bus') expect(c.vehicleKind).toBe('bus');
      else expect(c.vehicleKind).toBe('drive');
    }
    const cars = star('street-2-bike', [0, 90, 180, 270]);
    const g2 = cars.net.laneGraph;
    for (const i of g2.connectorsAt.get(cars.hub)!) {
      const c = g2.lanes[i];
      const fromBike = g2.lanes[c.fromLane].vehicleKind === 'bike';
      const toBike = g2.lanes[c.toLane].vehicleKind === 'bike';
      expect(fromBike).toBe(toBike);
    }
  });

  it('lets a car turn right on a road with a kerbside bus lane', () => {
    const { net, hub, arms } = star('avenue-4-bus', [0, 90, 180, 270]);
    const graph = net.laneGraph;
    const west = lanesOf(net, arms[2]).filter((l) => l.vehicleKind === 'drive' && intoHub(l));
    const turns = new Set(
      west.flatMap((l) => l.next.map((i) => graph.lanes[i]).filter((c) => c.vehicleKind === 'drive').map((c) => c.turn)),
    );
    expect(turns).toEqual(new Set(['left', 'straight', 'right']));
  });

  it('turns round at a two-way dead end only', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(100, 0));
    const seg = net.addSegment(a, b, { roadType: 'street-2' });
    const graph = net.laneGraph;
    for (const n of [a, b]) {
      const conns = graph.connectorsAt.get(n)!;
      expect(conns).toHaveLength(1);
      expect(graph.lanes[conns[0]].turn).toBe('uturn');
      expect(net.nodeGeom(n)!.outline).toEqual([]);
      expect(net.nodeGeom(n)!.kind).toBe('deadEnd');
    }
    expect(net.segmentGeom(seg)!.trimA).toBe(0);
    expect(lanesWithoutExit(graph)).toEqual([]);
    expectConnectorsContinuous(graph, a, 3);

    const oneWay = new RoadNetwork();
    const p = oneWay.addNode(v(0, 0));
    const q = oneWay.addNode(v(100, 0));
    oneWay.addSegment(p, q, { roadType: 'highway-3' });
    expect(oneWay.laneGraph.connectorsAt.get(q)).toEqual([]);
    expect(oneWay.laneGraph.connectorsAt.get(p)).toEqual([]);
  });

  it('handles a one-way arm in a crossroads', () => {
    const net = new RoadNetwork();
    const hub = net.addNode(v(0, 0));
    const e = net.addNode(v(150, 0));
    const w = net.addNode(v(-150, 0));
    const s = net.addNode(v(0, 150));
    const n = net.addNode(v(0, -150));
    const ee = net.addSegment(hub, e, { roadType: 'street-2-oneway' });
    const ww = net.addSegment(w, hub, { roadType: 'street-2-oneway' });
    const ss = net.addSegment(hub, s, { roadType: 'street-2' });
    const nn = net.addSegment(hub, n, { roadType: 'street-2' });
    const moves = movementKeys(net.laneGraph, hub);
    expect(moves.has(`${ww}>${ee}`)).toBe(true);
    expect(moves.has(`${ee}>${ww}`)).toBe(false);
    expect(moves.has(`${ss}>${ee}`)).toBe(true);
    expect(moves.has(`${nn}>${ee}`)).toBe(true);
    expect([...moves].some((m) => m.endsWith(`>${ww}`))).toBe(false);
    expectAllLeave(net, hub);
    expectClean(net);
  });

  it('uses a u-turn only when there is truly no other way out', () => {
    const net = new RoadNetwork();
    const hub = net.addNode(v(0, 0));
    const a = net.addNode(v(-100, 0));
    const b = net.addNode(v(100, 0));
    const inbound = net.addSegment(a, hub, { roadType: 'street-2-oneway' });
    const street = net.addSegment(hub, b, { roadType: 'street-2' });
    const moves = movementKeys(net.laneGraph, hub);
    expect(moves.has(`${inbound}>${street}`)).toBe(true);
    expect(moves.has(`${street}>${street}`)).toBe(true);
    expectClean(net);
  });
});

describe('plain joints and two-road nodes', () => {
  it('links lanes directly across a plain joint', () => {
    const { net, n, inSeg, outSeg } = mainline('highway-3', 'highway-3');
    const g = net.nodeGeom(n)!;
    expect(g.isPlainJoint).toBe(true);
    expect(g.outline).toEqual([]);
    expect(net.segmentGeom(inSeg)!.trimB).toBe(0);
    expect(net.segmentGeom(outSeg)!.trimA).toBe(0);
    const graph = net.laneGraph;
    expect(graph.connectorsAt.get(n)).toEqual([]);
    const a = lanesOf(net, inSeg);
    const b = lanesOf(net, outSeg);
    a.forEach((l, i) => {
      expect(l.next).toEqual([b[i].idx]);
      expect(b[i].prev).toEqual([l.idx]);
      expect(dist(lastPoint(l), firstPoint(b[i]))).toBeLessThan(0.01);
    });
  });

  it('joins two roads drawn head to head', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-100, 0));
    const n = net.addNode(v(0, 0));
    const b = net.addNode(v(100, 0));
    const left = net.addSegment(n, a, { roadType: 'street-4' });
    const right = net.addSegment(n, b, { roadType: 'street-4' });
    expect(net.nodeGeom(n)!.isPlainJoint).toBe(true);
    for (const l of [...lanesOf(net, left), ...lanesOf(net, right)]) {
      const graph = net.laneGraph;
      for (const j of l.next) {
        expect(dist(lastPoint(l), firstPoint(graph.lanes[j]))).toBeLessThan(0.01);
        expect(graph.lanes[j].segmentId).not.toBe(l.segmentId);
      }
    }
    expectClean(net);
  });

  it('closes small tangent errors at a plain joint', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-100, -2));
    const n = net.addNode(v(0, 0));
    const b = net.addNode(v(100, -2));
    const p = net.addSegment(a, n, { roadType: 'highway-3' });
    const q = net.addSegment(n, b, { roadType: 'highway-3' });
    expect(net.nodeGeom(n)!.isPlainJoint).toBe(true);
    const x = lanesOf(net, p);
    const y = lanesOf(net, q);
    x.forEach((l, i) => expect(dist(lastPoint(l), firstPoint(y[i]))).toBeLessThan(0.01));
  });

  it('makes a real junction at a kink', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-100, 0));
    const n = net.addNode(v(0, 0));
    const b = net.addNode(v(70, 70));
    net.addSegment(a, n, { roadType: 'street-2' });
    net.addSegment(n, b, { roadType: 'street-2' });
    const g = net.nodeGeom(n)!;
    expect(g.isPlainJoint).toBe(false);
    expect(g.outline.length).toBeGreaterThan(4);
    expectCurvedOutline(net, n);
    expectAllLeave(net, n);
    expectConnectorsContinuous(net.laneGraph, n);
  });

  it('makes a taper between road types and pairs lanes by position', () => {
    const { net, n, inSeg, outSeg } = mainline('street-4', 'street-2');
    const g = net.nodeGeom(n)!;
    expect(g.isPlainJoint).toBe(false);
    expect(net.segmentGeom(inSeg)!.trimB).toBeGreaterThan(1);
    expectCurvedOutline(net, n);
    expectAllLeave(net, n);
    expectClean(net);
    const conn = net.laneGraph.connectorsAt.get(n)!.map((i) => net.laneGraph.lanes[i]);
    expect(conn.filter((c) => net.laneGraph.lanes[c.toLane].segmentId === outSeg)).toHaveLength(2);
    expect(conn.filter((c) => net.laneGraph.lanes[c.fromLane].segmentId === outSeg)).toHaveLength(2);
  });

  it('honours a bridge deck slope in a plain joint', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-200, 0, 0));
    const n = net.addNode(v(0, 0, 10));
    const b = net.addNode(v(200, 0, 20));
    net.addSegment(a, n, { roadType: 'street-2' });
    net.addSegment(n, b, { roadType: 'street-2' });
    expect(net.nodeGeom(n)!.isPlainJoint).toBe(true);
    expect(lanesWithoutExit(net.laneGraph)).toEqual([]);
    const lane = net.laneGraph.lanes.find((l) => l.key.endsWith(':1') && l.kind === 'road')!;
    expect(lastPoint(lane).y).toBeCloseTo(10, 3);
  });
});

/** A curved off-ramp leaving the mainline to the right at node n. */
function offRamp(hw: string, ramp: string) {
  const base = mainline(hw, hw);
  const { net, n } = base;
  const end = net.addNode(v(260, 150));
  const rampSeg = net.addSegment(n, end, {
    roadType: ramp,
    c1: v(90, 0),
    c2: v(180, 70),
  });
  return { ...base, end, rampSeg };
}

function onRamp(hw: string, ramp: string) {
  const base = mainline(hw, hw);
  const { net, n } = base;
  const start = net.addNode(v(-260, 150));
  const rampSeg = net.addSegment(start, n, {
    roadType: ramp,
    c1: v(-180, 70),
    c2: v(-90, 0),
  });
  return { ...base, start, rampSeg };
}

describe('highway interchanges', () => {
  it('diverges 3-lane highway + 1-lane off-ramp, keeping the mainline whole', () => {
    const { net, n, inSeg, outSeg, rampSeg } = offRamp('highway-3', 'ramp-1');
    const graph = net.laneGraph;
    const conn = graph.connectorsAt.get(n)!.map((i) => graph.lanes[i]);
    const inLanes = lanesOf(net, inSeg);
    const main = lanesOf(net, outSeg);
    const ramp = lanesOf(net, rampSeg);
    // Each mainline lane continues into the same position.
    inLanes.forEach((l, i) => {
      const toMain = conn.filter((c) => c.fromLane === l.idx && graph.lanes[c.toLane].segmentId === outSeg);
      expect(toMain.map((c) => c.toLane)).toEqual([main[i].idx]);
    });
    // Only the rightmost lane reaches the ramp.
    const toRamp = conn.filter((c) => c.toLane === ramp[0].idx);
    expect(toRamp.map((c) => c.fromLane)).toEqual([inLanes[2].idx]);
    expect(conn).toHaveLength(4);
    expect(toRamp[0].turn).toBe('right');
    expect(conn.filter((c) => c.turn === 'straight')).toHaveLength(3);
    expectAllLeave(net, n);
    expectConnectorsContinuous(graph, n);
    expectClean(net);
  });

  it('trims a shallow diverge long, up to the cap, and keeps the outline clean', () => {
    const { net, n, inSeg, outSeg, rampSeg } = offRamp('highway-3', 'ramp-1');
    const main = net.segmentGeom(outSeg)!;
    const ramp = net.segmentGeom(rampSeg)!;
    expect(main.trimA).toBeGreaterThan(30);
    expect(main.trimA).toBeLessThanOrEqual(MAX_TRIM);
    expect(ramp.trimA).toBeGreaterThan(30);
    expect(ramp.trimA).toBeLessThanOrEqual(MAX_TRIM);
    expect(net.segmentGeom(inSeg)!.trimB).toBeLessThan(10);
    expectCurvedOutline(net, n);
  });

  it('sees the gore: ramp and mainline clear of each other at the cut', () => {
    const { net, n, outSeg, rampSeg } = offRamp('highway-3', 'ramp-1');
    const arms = net.nodeGeom(n)!.arms;
    const main = arms.find((a) => a.segmentId === outSeg)!;
    const ramp = arms.find((a) => a.segmentId === rampSeg)!;
    // Ramp goes right of the mainline, so its road edge nearest the mainline is
    // its leftEdge looking outward, the rightEdge seen looking at the node.
    expect(ramp.rightEdge.z).toBeGreaterThanOrEqual(main.leftEdge.z - 0.01);
  });

  it('merges an on-ramp into a 3-lane mainline', () => {
    const { net, n, inSeg, outSeg, rampSeg } = onRamp('highway-3', 'ramp-1');
    const graph = net.laneGraph;
    const conn = graph.connectorsAt.get(n)!.map((i) => graph.lanes[i]);
    const a = lanesOf(net, inSeg);
    const b = lanesOf(net, outSeg);
    const r = lanesOf(net, rampSeg);
    a.forEach((l, i) => {
      expect(conn.filter((c) => c.fromLane === l.idx).map((c) => c.toLane)).toEqual([b[i].idx]);
    });
    expect(conn.filter((c) => c.fromLane === r[0].idx).map((c) => c.toLane)).toEqual([b[2].idx]);
    const merges = conn.flatMap((c) => c.conflicts).filter((c) => c.kind === 'merge');
    expect(merges.length).toBe(2);
    expectAllLeave(net, n);
    expectConnectorsContinuous(graph, n);
    expectCurvedOutline(net, n);
    expectClean(net);
  });

  it('adds a lane: 4 + 1 becomes 5', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-400, 0));
    const n = net.addNode(v(0, 0));
    const b = net.addNode(v(400, 0));
    const start = net.addNode(v(-260, 150));
    const main = net.addSegment(a, n, { roadType: 'highway-4' });
    const after = net.addSegment(n, b, { roadType: 'highway-5' });
    const ramp = net.addSegment(start, n, { roadType: 'ramp-1', c1: v(-180, 70), c2: v(-90, 0) });
    const graph = net.laneGraph;
    const conn = graph.connectorsAt.get(n)!.map((i) => graph.lanes[i]);
    const out = lanesOf(net, after);
    const mainLanes = lanesOf(net, main);
    mainLanes.forEach((l, i) => {
      expect(conn.filter((c) => c.fromLane === l.idx).map((c) => c.toLane)).toEqual([out[i].idx]);
    });
    expect(conn.filter((c) => c.fromLane === lanesOf(net, ramp)[0].idx).map((c) => c.toLane)).toEqual([out[4].idx]);
    expect(conn).toHaveLength(5);
    expect(conn.flatMap((c) => c.conflicts)).toEqual([]);
    expectAllLeave(net, n);
    expectClean(net);
  });

  it('drops a lane: 3 to 2 without stranding one', () => {
    const { net, n, inSeg, outSeg } = mainline('highway-3', 'highway-2');
    const graph = net.laneGraph;
    const conn = graph.connectorsAt.get(n)!.map((i) => graph.lanes[i]);
    expect(conn).toHaveLength(3);
    for (const l of lanesOf(net, inSeg)) expect(l.next.length).toBeGreaterThan(0);
    for (const l of lanesOf(net, outSeg)) expect(l.prev.length).toBeGreaterThan(0);
    expect(conn.flatMap((c) => c.conflicts).filter((c) => c.kind === 'merge')).toHaveLength(2);
    expectConnectorsContinuous(graph, n);
    expectClean(net);
  });

  it('adds a lane in pass-through: 2 to 3 fans out', () => {
    const { net, n, inSeg, outSeg } = mainline('highway-2', 'highway-3');
    expectAllLeave(net, n);
    const graph = net.laneGraph;
    const conn = graph.connectorsAt.get(n)!.map((i) => graph.lanes[i]);
    expect(conn).toHaveLength(3);
    expect(new Set(conn.map((c) => c.toLane)).size).toBe(3);
    expect(lanesOf(net, inSeg).every((l) => l.next.length >= 1)).toBe(true);
    expect(lanesOf(net, outSeg).every((l) => l.prev.length === 1)).toBe(true);
  });

  it('feeds both branches from a shared lane when outgoing exceeds incoming', () => {
    const { net, n, inSeg, outSeg, rampSeg } = offRamp('highway-2', 'ramp-2');
    const graph = net.laneGraph;
    const conn = graph.connectorsAt.get(n)!.map((i) => graph.lanes[i]);
    expect(lanesOf(net, inSeg).every((l) => l.next.length >= 1)).toBe(true);
    const main = lanesOf(net, outSeg);
    const ramp = lanesOf(net, rampSeg);
    const shared = lanesOf(net, inSeg)[1];
    expect(conn.filter((c) => c.fromLane === shared.idx).length).toBeGreaterThanOrEqual(2);
    for (const l of [...main, ...ramp]) expect(l.prev.length).toBeGreaterThan(0);
    expectClean(net);
  });

  it('splits a highway into two highways', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-300, 0));
    const n = net.addNode(v(0, 0));
    const left = net.addNode(v(300, -80));
    const right = net.addNode(v(300, 80));
    const inSeg = net.addSegment(a, n, { roadType: 'highway-4' });
    const l = net.addSegment(n, left, { roadType: 'highway-2', c1: v(100, 0), c2: v(200, -80) });
    const r = net.addSegment(n, right, { roadType: 'highway-2', c1: v(100, 0), c2: v(200, 80) });
    const graph = net.laneGraph;
    const moves = movementKeys(graph, n);
    expect(moves).toEqual(new Set([`${inSeg}>${l}`, `${inSeg}>${r}`]));
    const inLanes = lanesOf(net, inSeg);
    const leftLanes = lanesOf(net, l);
    const rightLanes = lanesOf(net, r);
    const conn = graph.connectorsAt.get(n)!.map((i) => graph.lanes[i]);
    expect(conn.filter((c) => c.fromLane === inLanes[0].idx).map((c) => c.toLane)).toEqual([leftLanes[0].idx]);
    expect(conn.filter((c) => c.fromLane === inLanes[3].idx).map((c) => c.toLane)).toEqual([rightLanes[1].idx]);
    expectAllLeave(net, n);
    expectCurvedOutline(net, n);
  });

  it('tells apart arms leaving on exactly the same tangent', () => {
    for (const side of [1, -1]) {
      const net = new RoadNetwork();
      const a = net.addNode(v(-300, 0));
      const n = net.addNode(v(0, 0));
      const main = net.addNode(v(300, 0));
      const far = net.addNode(v(300, 120 * side));
      const inSeg = net.addSegment(a, n, { roadType: 'highway-3' });
      net.addSegment(n, main, { roadType: 'highway-3' });
      const ramp = net.addSegment(n, far, { roadType: 'ramp-1', c1: v(100, 0), c2: v(200, 120 * side) });
      const graph = net.laneGraph;
      const conn = graph.connectorsAt.get(n)!.map((i) => graph.lanes[i]);
      const toRamp = conn.filter((c) => graph.lanes[c.toLane].segmentId === ramp);
      const expected = side === 1 ? 2 : 0;
      expect(toRamp.map((c) => c.fromLane)).toEqual([lanesOf(net, inSeg)[expected].idx]);
      expect(toRamp[0].turn).toBe(side === 1 ? 'right' : 'left');
    }
  });

  it('caps a nearly parallel split at the maximum trim', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-300, 0));
    const n = net.addNode(v(0, 0));
    const b = net.addNode(v(400, 0));
    const c = net.addNode(v(400, 4));
    net.addSegment(a, n, { roadType: 'highway-3' });
    const main = net.addSegment(n, b, { roadType: 'highway-3' });
    const ramp = net.addSegment(n, c, { roadType: 'ramp-1' });
    expect(net.segmentGeom(main)!.trimA).toBe(MAX_TRIM);
    expect(net.segmentGeom(ramp)!.trimA).toBe(MAX_TRIM);
    expectClean(net);
    expectCurvedOutline(net, n);
  });

  it('never trims past the road on a short link', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-300, 0));
    const n1 = net.addNode(v(0, 0));
    const n2 = net.addNode(v(30, 0));
    const b = net.addNode(v(300, 0));
    const ramp1 = net.addNode(v(100, 200));
    const ramp2 = net.addNode(v(100, -200));
    net.addSegment(a, n1, { roadType: 'highway-3' });
    const link = net.addSegment(n1, n2, { roadType: 'highway-3' });
    net.addSegment(n2, b, { roadType: 'highway-3' });
    net.addSegment(n1, ramp1, { roadType: 'ramp-1', c1: v(40, 5), c2: v(90, 80) });
    net.addSegment(n2, ramp2, { roadType: 'ramp-1', c1: v(70, 5), c2: v(100, -80) });
    const g = net.segmentGeom(link)!;
    expect(g.trimA + g.trimB).toBeLessThan(g.fullLength);
    expect(g.valid).toBe(true);
    expect(g.length).toBeGreaterThan(0.5);
    expect(g.stations.length).toBeGreaterThanOrEqual(2);
    expectClean(net);
    expect(lanesWithoutExit(net.laneGraph).length).toBe(0 + lanesOf(net, net.segments[2].id).length + 2);
  });

  it('flags a road with no length left but keeps the graph sound', () => {
    const net = new RoadNetwork();
    const n1 = net.addNode(v(0, 0));
    const n2 = net.addNode(v(0.01, 0));
    const a = net.addNode(v(-100, 0));
    const b = net.addNode(v(100, 0));
    const c = net.addNode(v(0, 100));
    net.addSegment(a, n1, { roadType: 'street-2' });
    net.addSegment(n1, c, { roadType: 'street-2' });
    const tiny = net.addSegment(n1, n2, { roadType: 'street-2' });
    net.addSegment(n2, b, { roadType: 'street-2' });
    expect(net.segmentGeom(tiny)!.valid).toBe(false);
    expect(net.segmentGeom(tiny)!.stations).toEqual([]);
    expect(net.laneGraph.roadLanes.get(tiny)!.every((i) => i === -1)).toBe(true);
    expectClean(net);
  });

  it('carries heights through a multi-level node without jumps', () => {
    const net = new RoadNetwork();
    const hub = net.addNode(v(0, 0, 8));
    const low = net.addNode(v(-200, 0, 0));
    const high = net.addNode(v(200, 0, 20));
    const sideUp = net.addNode(v(0, 200, 24));
    const sideDown = net.addNode(v(0, -200, 0));
    net.addSegment(low, hub, { roadType: 'street-4' });
    net.addSegment(hub, high, { roadType: 'street-4' });
    net.addSegment(hub, sideUp, { roadType: 'street-2' });
    net.addSegment(hub, sideDown, { roadType: 'street-2' });
    const graph = net.laneGraph;
    expectConnectorsContinuous(graph, hub, 5);
    for (const i of graph.connectorsAt.get(hub)!) {
      const c = graph.lanes[i];
      const a = firstPoint(c).y;
      const b = lastPoint(c).y;
      for (let k = 1; k < c.cum.length; k++) {
        const dy = Math.abs(c.pts[k * 3 + 1] - c.pts[k * 3 - 2]);
        const ds = c.cum[k] - c.cum[k - 1];
        expect(dy / ds, c.key).toBeLessThan(0.5);
      }
      expect(Math.min(a, b) - 2).toBeLessThanOrEqual(8);
    }
    expectClean(net);
  });

  it('does not treat connectors stacked with headroom as crossing', () => {
    const net = new RoadNetwork();
    const hub = net.addNode(v(0, 0, 10));
    const p: Vec3[] = [v(-120, 0, 0), v(120, 0, 20), v(0, -120, 20), v(0, 120, 0)];
    p.forEach((pos, i) => {
      const n = net.addNode(pos);
      net.addSegment(i % 2 === 0 ? n : hub, i % 2 === 0 ? hub : n, { roadType: 'street-2' });
    });
    expectClean(net);
  });
});

describe('lane links and connection editing', () => {
  it('replaces automatic connectors with the user list', () => {
    const { net, hub, arms } = star('street-2', [0, 90, 180, 270]);
    const options = net.connectionsAt(hub);
    expect(options.filter((o) => o.active)).toHaveLength(12);
    expect(options.length).toBeGreaterThanOrEqual(12);
    const pick = options.find((o) => o.fromSegment === arms[0] && o.toSegment === arms[2])!;
    net.setJunctionControl(hub, { laneLinks: [{ from: pick.from, to: pick.to }] });
    const graph = net.laneGraph;
    const conns = graph.connectorsAt.get(hub)!;
    expect(conns).toHaveLength(1);
    expect(graph.lanes[conns[0]].turn).toBe('straight');
    expect(net.connectionsAt(hub).filter((o) => o.active)).toHaveLength(1);
    expectClean(net);
    net.setJunctionControl(hub, { laneLinks: null });
    expect(net.laneGraph.connectorsAt.get(hub)).toHaveLength(12);
  });

  it('ignores links that make no sense', () => {
    const { net, hub, arms } = star('street-2-bike', [0, 90, 180, 270]);
    const drive = lanesOf(net, arms[0]).find((l) => l.vehicleKind === 'drive' && intoHub(l))!;
    const bike = lanesOf(net, arms[2]).find((l) => l.vehicleKind === 'bike' && !intoHub(l))!;
    net.setJunctionControl(hub, {
      laneLinks: [
        { from: `${arms[0]}:${drive.laneIndex}`, to: `${arms[2]}:${bike.laneIndex}` },
        { from: '999:0', to: `${arms[2]}:0` },
        { from: 'garbage', to: 'also garbage' },
      ],
    });
    expect(net.laneGraph.connectorsAt.get(hub)).toEqual([]);
    expectClean(net);
  });

  it('survives a segment disappearing from a link list', () => {
    const { net, hub, arms } = star('street-2', [0, 90, 180, 270]);
    const options = net.connectionsAt(hub).filter((o) => o.active);
    net.setJunctionControl(hub, { laneLinks: options.map((o) => ({ from: o.from, to: o.to })) });
    net.removeSegment(arms[1]);
    expect(net.getNode(hub)!.control.laneLinks!.some((l) => l.from.startsWith(`${arms[1]}:`))).toBe(false);
    expectClean(net);
  });

  it('supports user links at a plain joint without a connector', () => {
    const { net, n, inSeg, outSeg } = mainline('highway-2', 'highway-2');
    net.setJunctionControl(n, { laneLinks: [{ from: `${inSeg}:0`, to: `${outSeg}:1` }] });
    const a = lanesOf(net, inSeg);
    const b = lanesOf(net, outSeg);
    expect(a[0].next).toEqual([b[1].idx]);
    expect(a[1].next).toEqual([]);
    expectClean(net);
  });
});

/** Lanes from which no sink (a lane with no next) can be reached. */
function lanesThatLoopForever(net: RoadNetwork): GLane[] {
  const graph = net.laneGraph;
  const canExit = new Set<number>();
  const stack = graph.lanes.filter((l) => l.next.length === 0).map((l) => l.idx);
  while (stack.length) {
    const i = stack.pop()!;
    if (canExit.has(i)) continue;
    canExit.add(i);
    stack.push(...graph.lanes[i].prev);
  }
  return graph.lanes.filter((l) => !canExit.has(l.idx));
}

describe('whole interchanges', () => {
  it('a diamond: highways under a street, four ramps, nothing stranded', () => {
    const net = new RoadNetwork();
    const Y = 8;
    // Two carriageways along x, right-hand traffic: +x at z = 20, -x at z = -20.
    const east = net.drawRoad({ start: free(-700, 20), end: free(700, 20), roadType: 'highway-3' }).segments[0];
    const west = net.drawRoad({ start: free(700, -20), end: free(-700, -20), roadType: 'highway-3' }).segments[0];
    // The street crosses over at 8 m and must not join either carriageway.
    const bridge = net.drawRoad({ start: free(0, -400, Y), end: free(0, 400, Y), roadType: 'street-4' });
    expect(bridge.junctions).toEqual([]);
    const main = bridge.segments[0];

    // Terminals at z = 60 and z = -60. The original id keeps the a side of each split.
    const south = net.splitSegment(main, 460 / 800).node;
    const north = net.splitSegment(main, 340 / 460).node;
    expect(net.getNode(south)!.pos.z).toBeCloseTo(60, 6);
    expect(net.getNode(north)!.pos.z).toBeCloseTo(-60, 6);

    const ramp = (start: Parameters<RoadNetwork['drawRoad']>[0]['start'], end: Parameters<RoadNetwork['drawRoad']>[0]['end'], c1: Vec3, c2: Vec3) =>
      net.drawRoad({ start, end, c1, c2, roadType: 'ramp-1' });

    // Eastbound off and on, westbound off and on.
    const offE = ramp(onSeg(east, 0.2), atNode(south), v(-300, 20), v(-120, 60, Y));
    const eastAfter = net.nearestSegment(v(400, 20))!.segmentId;
    const onE = ramp(atNode(south), onSeg(eastAfter, 0.75), v(120, 60, Y), v(300, 20));
    const offW = ramp(onSeg(west, 0.2), atNode(north), v(300, -20), v(120, -60, Y));
    const westAfter = net.nearestSegment(v(-400, -20))!.segmentId;
    const onW = ramp(atNode(north), onSeg(westAfter, 0.75), v(-120, -60, Y), v(-300, -20));
    expect([offE, onE, offW, onW].every((r) => r.segments.length === 1)).toBe(true);

    expectClean(net);
    const graph = net.laneGraph;
    // Drive lanes only stop at the true ends of the map.
    const stuck = lanesWithoutExit(graph).filter((l) => {
      const p = lastPoint(l);
      return Math.abs(p.x) < 690 && Math.abs(p.z) < 390;
    });
    expect(stuck.map((l) => l.key)).toEqual([]);
    expect(lanesThatLoopForever(net).map((l) => l.key)).toEqual([]);

    for (const n of net.nodes) {
      expectCurvedOutline(net, n.id);
      expectConnectorsContinuous(graph, n.id, 7);
    }
    // Trims stay within the road everywhere, even on the short highway links.
    for (const s of net.segments) {
      const g = net.segmentGeom(s.id)!;
      expect(g.trimA + g.trimB).toBeLessThan(g.fullLength);
      expect(g.stations.length).toBeGreaterThanOrEqual(2);
    }
    // The street stays above the highway, so nothing connects them except ramps.
    const onStreet = net.getNode(south)!;
    expect(onStreet.pos.y).toBeCloseTo(Y, 5);
    expect(effectiveControl(net, south).kind).toBe('priority');
  });

  it('a roundabout of one-way arcs with two-way spokes', () => {
    const net = new RoadNetwork();
    const R = 40;
    const k = 0.5523 * R;
    const ring = [v(R, 0), v(0, R), v(-R, 0), v(0, -R)].map((p) => net.addNode(p));
    // Clockwise from above is the way right-hand roundabouts do not run, so go
    // counter-clockwise: +x, -z, -x, +z.
    const order = [0, 3, 2, 1];
    for (let i = 0; i < 4; i++) {
      const a = net.getNode(ring[order[i]])!.pos;
      const b = net.getNode(ring[order[(i + 1) % 4]])!.pos;
      const tanA = v(a.z / R, -a.x / R);
      const tanB = v(b.z / R, -b.x / R);
      net.addSegment(ring[order[i]], ring[order[(i + 1) % 4]], {
        roadType: 'street-2-oneway',
        c1: v(a.x + tanA.x * k, a.z + tanA.z * k),
        c2: v(b.x - tanB.x * k, b.z - tanB.z * k),
      });
    }
    for (const n of ring) {
      const p = net.getNode(n)!.pos;
      const spoke = net.addNode(v(p.x * 5, p.z * 5));
      net.addSegment(n, spoke, { roadType: 'street-2' });
    }
    expectClean(net);
    const graph = net.laneGraph;
    expect(lanesWithoutExit(graph)).toEqual([]);
    // No lane may be trapped circling: every ring lane can leave by a spoke.
    for (const n of ring) {
      const moves = movementKeys(graph, n);
      expect(moves.size).toBeGreaterThanOrEqual(3);
      expectCurvedOutline(net, n);
    }
  });

  it('a two-way road ending at a pair of one-way carriageways', () => {
    const net = new RoadNetwork();
    const hub = net.addNode(v(0, 0));
    const a = net.addNode(v(-300, 5));
    const b = net.addNode(v(300, 5));
    const c = net.addNode(v(0, -300));
    net.addSegment(a, hub, { roadType: 'street-2-oneway' });
    net.addSegment(hub, b, { roadType: 'street-2-oneway' });
    net.addSegment(hub, c, { roadType: 'street-2' });
    expectClean(net);
    expectAllLeave(net, hub);
  });
});

describe('tight bends', () => {
  it('marks a bend tighter than the road invalid, but keeps it drivable', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(12, 0));
    const s = net.addSegment(a, b, { roadType: 'boulevard-8', c1: v(0, 18), c2: v(12, 18) });
    const g = net.segmentGeom(s)!;
    expect(g.valid).toBe(false);
    expect(g.minRadius).toBeLessThan(net.roadTypeOf(s).halfWidth);
    expect(g.stations.length).toBeGreaterThan(2);
    expect(net.laneGraph.roadLanes.get(s)!.every((i) => i >= 0)).toBe(true);
    expectClean(net);
  });
});

describe('degrees check helper sanity', () => {
  it('measures angles', () => {
    expect(degreesBetween(v(1, 0), v(1, 0))).toBeCloseTo(0);
    expect(degreesBetween(v(1, 0), v(0, 1))).toBeCloseTo(90);
  });
});
