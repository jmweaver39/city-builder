import { describe, expect, it } from 'vitest';
import {
  RoadNetwork,
  cubicPoint,
  cubicTangentXZ,
  distXZ,
  effectiveControl,
  makeAttach,
  type DrawRoadParams,
  type GLane,
  type Id,
  type RampAttach,
  type Vec3,
} from '../../src/core';
import { Simulation } from '../../src/sim/Simulation';
import { atNode, expectClean, expectConnectorsContinuous, free, onSeg, v } from './helpers';

const HIGHWAYS = ['highway-2', 'highway-3', 'highway-4', 'highway-5', 'dual-4', 'dual-6'];

function lanesOf(net: RoadNetwork, seg: Id): GLane[] {
  const g = net.laneGraph;
  return g.roadLanes.get(seg)!.map((i) => g.lanes[i]);
}

function connectorsAt(net: RoadNetwork, node: Id): GLane[] {
  const g = net.laneGraph;
  return (g.connectorsAt.get(node) ?? []).map((i) => g.lanes[i]);
}

const fromOf = (net: RoadNetwork, c: GLane) => net.laneGraph.lanes[c.fromLane];
const toOf = (net: RoadNetwork, c: GLane) => net.laneGraph.lanes[c.toLane];

/** A highway along x from -600 to 600, drawn +x. */
function highway(type: string) {
  const net = new RoadNetwork();
  const seg = net.drawRoad({ start: free(-600, 0), end: free(600, 0), roadType: type }).segments[0];
  return { net, seg };
}

/**
 * The carriageways of a highway along +x: the right one runs +x on the +z side,
 * and on a dual the left one runs -x on the -z side.
 */
function carriageways(type: string): { travel: 1 | -1; side: 1 | -1 }[] {
  return type.startsWith('dual') ? [{ travel: 1, side: 1 }, { travel: -1, side: -1 }] : [{ travel: 1, side: 1 }];
}

/** Lanes of a highway segment (drawn +x) that run with `travel`, outermost on the right first. */
function carriagewayLanes(net: RoadNetwork, seg: Id, travel: 1 | -1): GLane[] {
  const def = net.roadTypeOf(seg);
  const oneWay = def.lanes.every((x) => x.dir === 1);
  return lanesOf(net, seg)
    .filter((l) => oneWay || def.lanes[l.laneIndex].dir === travel)
    .sort((a, b) => (def.lanes[b.laneIndex].offset - def.lanes[a.laneIndex].offset) * (oneWay ? 1 : travel));
}

/** The segment of the highway under a point. */
const hwAt = (net: RoadNetwork, x: number) => net.nearestSegment(v(x, 0))!;

/** Attach for a ramp leaving or joining a highway along x at the side `side` (+z = 1). */
function attachOn(side: 1 | -1, rampTravel: 1 | -1, lane = 0): RampAttach {
  return makeAttach(lane, v(1, 0), v(rampTravel, 0), side);
}

/** An off-ramp leaving carriageway `cw` at x0, aligned with its traffic, then curving away. */
function drawOff(net: RoadNetwork, x0: number, cw: { travel: 1 | -1; side: 1 | -1 }, opts: { lane?: number; roadType?: string; attach?: boolean } = {}) {
  const near = hwAt(net, x0);
  const d = cw.travel;
  const s = cw.side;
  const params: DrawRoadParams = {
    start: onSeg(near.segmentId, near.t),
    end: free(x0 + d * 260, s * 150),
    c1: v(x0 + d * 100, s * 10),
    c2: v(x0 + d * 190, s * 60),
    roadType: opts.roadType ?? 'ramp-1',
    startAttach: opts.attach === false ? undefined : attachOn(s, d, opts.lane ?? 0),
  };
  const issues = net.validateDraft(params);
  const r = net.drawRoad(params);
  return { node: r.nodes[0], ramp: r.segments[0], issues };
}

/** An on-ramp joining carriageway `cw` at x0, arriving aligned with its traffic. */
function drawOn(net: RoadNetwork, x0: number, cw: { travel: 1 | -1; side: 1 | -1 }, opts: { lane?: number; roadType?: string } = {}) {
  const near = hwAt(net, x0);
  const d = cw.travel;
  const s = cw.side;
  const params: DrawRoadParams = {
    start: free(x0 - d * 260, s * 150),
    end: onSeg(near.segmentId, near.t),
    c1: v(x0 - d * 190, s * 60),
    c2: v(x0 - d * 100, s * 10),
    roadType: opts.roadType ?? 'ramp-1',
    endAttach: attachOn(s, d, opts.lane ?? 0),
  };
  const issues = net.validateDraft(params);
  const r = net.drawRoad(params);
  return { node: r.nodes[r.nodes.length - 1], ramp: r.segments[r.segments.length - 1], issues };
}

/** Highway segments meeting at a node, as [before, after] in the +x sense. */
function mainAt(net: RoadNetwork, node: Id): [Id, Id] {
  const segs = net.getNode(node)!.segments.filter((s) => net.roadTypeOf(s).category === 'highway');
  const before = segs.find((s) => net.getSegment(s)!.b === node)!;
  const after = segs.find((s) => net.getSegment(s)!.a === node)!;
  return [before, after];
}

describe('controlled access: diverges', () => {
  for (const type of HIGHWAYS) {
    for (const cw of carriageways(type)) {
      it(`${type}: an off-ramp (travel ${cw.travel}) takes only the outside lane of its own carriageway`, () => {
        const { net } = highway(type);
        const { node, ramp, issues } = drawOff(net, cw.travel > 0 ? -100 : 100, cw);
        expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
        const [before, after] = mainAt(net, node);
        const inSeg = cw.travel > 0 ? before : after;
        const outSeg = cw.travel > 0 ? after : before;
        const conn = connectorsAt(net, node);
        const toRamp = conn.filter((c) => toOf(net, c).segmentId === ramp);
        const feeders = carriagewayLanes(net, inSeg, cw.travel);
        expect(toRamp.map((c) => c.fromLane)).toEqual([feeders[0].idx]);
        // Every through lane carries straight on into the lane in the same place.
        const outs = carriagewayLanes(net, outSeg, cw.travel);
        feeders.forEach((l, i) => {
          const through = conn.filter((c) => c.fromLane === l.idx && toOf(net, c).segmentId === outSeg);
          expect(through.map((c) => c.toLane)).toEqual([outs[i].idx]);
          expect(through[0].turn).toBe('straight');
        });
        // Nothing reaches the ramp from the other carriageway, and nothing turns across.
        expect(conn.every((c) => c.turn !== 'uturn')).toBe(true);
        expect(conn.filter((c) => c.turn === 'left' && toOf(net, c).segmentId === ramp)).toEqual([]);
        expect(effectiveControl(net, node).kind).toBe('none');
        expectConnectorsContinuous(net.laneGraph, node, 4);
        expectClean(net);
      });
    }
  }

  it('picking a lane further in feeds the ramp from that lane and every lane outside it', () => {
    const { net } = highway('highway-4');
    const { node, ramp } = drawOff(net, 0, { travel: 1, side: 1 }, { lane: 1, roadType: 'ramp-2' });
    const [before] = mainAt(net, node);
    const conn = connectorsAt(net, node).filter((c) => toOf(net, c).segmentId === ramp);
    const feeders = new Set(conn.map((c) => fromOf(net, c).laneIndex));
    expect(feeders).toEqual(new Set([2, 3]));
    expect(lanesOf(net, ramp).every((l) => l.prev.length > 0)).toBe(true);
    expect(lanesOf(net, before).every((l) => l.next.length > 0)).toBe(true);
  });

  it('a left exit on a one-way highway takes only the nearest lane, never a sweep across', () => {
    const { net } = highway('highway-4');
    const { node, ramp } = drawOff(net, 0, { travel: 1, side: -1 }, { roadType: 'ramp-2' });
    const conn = connectorsAt(net, node).filter((c) => toOf(net, c).segmentId === ramp);
    expect(new Set(conn.map((c) => fromOf(net, c).laneIndex))).toEqual(new Set([0]));
    expect(lanesOf(net, ramp).every((l) => l.prev.length > 0)).toBe(true);
  });

  it('an unattached ramp from the centreline still diverges from the outside lane', () => {
    const { net } = highway('highway-3');
    const { node, ramp } = drawOff(net, 0, { travel: 1, side: 1 }, { attach: false });
    const conn = connectorsAt(net, node).filter((c) => toOf(net, c).segmentId === ramp);
    expect(conn.map((c) => fromOf(net, c).laneIndex)).toEqual([2]);
  });
});

describe('controlled access: merges', () => {
  for (const type of HIGHWAYS) {
    for (const cw of carriageways(type)) {
      it(`${type}: an on-ramp (travel ${cw.travel}) merges only into the outside lane of its own carriageway`, () => {
        const { net } = highway(type);
        const { node, ramp, issues } = drawOn(net, cw.travel > 0 ? 100 : -100, cw);
        expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
        const [before, after] = mainAt(net, node);
        const outSeg = cw.travel > 0 ? after : before;
        const conn = connectorsAt(net, node);
        const fromRamp = conn.filter((c) => fromOf(net, c).segmentId === ramp);
        expect(fromRamp.map((c) => c.toLane)).toEqual([carriagewayLanes(net, outSeg, cw.travel)[0].idx]);
        expect(fromRamp[0].conflicts.some((k) => k.kind === 'merge')).toBe(true);
        expect(effectiveControl(net, node).kind).toBe('none');
        expectConnectorsContinuous(net.laneGraph, node, 4);
        expectClean(net);
      });
    }
  }

  it('a lane add takes the ramp into the new lane without a merge', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-400, 0));
    const n = net.addNode(v(0, 0));
    const b = net.addNode(v(400, 0));
    const start = net.addNode(v(-260, 150));
    net.addSegment(a, n, { roadType: 'highway-3' });
    const after = net.addSegment(n, b, { roadType: 'highway-4' });
    const ramp = net.addSegment(start, n, { roadType: 'ramp-1', c1: v(-180, 70), c2: v(-90, 0), overrides: { attachB: attachOn(1, 1) } });
    const fromRamp = connectorsAt(net, n).filter((c) => fromOf(net, c).segmentId === ramp);
    expect(fromRamp.map((c) => toOf(net, c).laneIndex)).toEqual([3]);
    expect(lanesOf(net, after).every((l) => l.prev.length === 1)).toBe(true);
  });
});

/** Which side of the median (z = 0) a lane end is on. */
const sideOfZ = (p: number) => (p > 0 ? 1 : -1);

function lanePoints(l: GLane): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < l.cum.length; i++) out.push({ x: l.pts[i * 3], y: l.pts[i * 3 + 1], z: l.pts[i * 3 + 2] });
  return out;
}

describe('controlled access: no connector crosses a median', () => {
  for (const type of ['dual-4', 'dual-6']) {
    it(`${type}: ramps on both sides and a street at grade on both sides`, () => {
      const { net } = highway(type);
      const nodes: Id[] = [];
      nodes.push(drawOff(net, -300, { travel: 1, side: 1 }).node);
      nodes.push(drawOn(net, 300, { travel: 1, side: 1 }).node);
      nodes.push(drawOff(net, 300 - 40, { travel: -1, side: -1 }).node);
      nodes.push(drawOn(net, -300 + 40, { travel: -1, side: -1 }).node);
      // A street joined at grade from each side, and one crossing straight over.
      for (const side of [1, -1]) {
        const near = hwAt(net, 0 + side * 20);
        const street = net.drawRoad({ start: onSeg(near.segmentId, near.t), end: free(side * 20, side * 200), roadType: 'street-2' });
        nodes.push(street.nodes[0]);
      }
      const cross = net.drawRoad({ start: free(150, -200), end: free(150, 200), roadType: 'street-2' });
      nodes.push(...cross.junctions);
      const g = net.laneGraph;
      for (const node of nodes) {
        // The crossing street also meets a ramp at grade, an ordinary junction.
        const onHighway = net.getNode(node)!.segments.some((x) => net.roadTypeOf(x).category === 'highway');
        if (onHighway) expect(effectiveControl(net, node).kind).toBe('none');
        for (const c of connectorsAt(net, node)) {
          const from = fromOf(net, c);
          const to = toOf(net, c);
          const a = lanePoints(from).at(-1)!;
          const b = lanePoints(to)[0];
          // From one side of the highway to the other means crossing the median.
          expect(sideOfZ(a.z), `${c.key} crosses the median`).toBe(sideOfZ(b.z));
          for (const p of lanePoints(c)) expect(sideOfZ(p.z), `${c.key} crosses the median`).toBe(sideOfZ(a.z));
          const hw = [from, to].some((l) => net.roadTypeOf(l.segmentId).category === 'highway');
          if (hw) expect(['left', 'uturn']).not.toContain(c.turn);
        }
      }
      expect(g.lanes.length).toBeGreaterThan(0);
      expectClean(net);
    });
  }

  it('a street at grade on a one-way highway is right in, right out, and warned about', () => {
    const { net, seg } = highway('highway-3');
    const params: DrawRoadParams = { start: onSeg(seg, 0.5), end: free(0, 200), roadType: 'street-2' };
    const issues = net.validateDraft(params);
    expect(issues.map((i) => i.code)).toContain('atGradeHighway');
    const r = net.drawRoad(params);
    const node = r.nodes[0];
    const street = r.segments[0];
    const conn = connectorsAt(net, node);
    const out = conn.filter((c) => fromOf(net, c).segmentId === street);
    const into = conn.filter((c) => toOf(net, c).segmentId === street);
    // Out of the street: only into the nearest highway lane.
    expect(out.map((c) => toOf(net, c).laneIndex)).toEqual([2]);
    expect(into.map((c) => fromOf(net, c).laneIndex)).toEqual([2]);
    expect(effectiveControl(net, node).kind).toBe('none');
  });

  it('a hand-set lane link still wins over the rules', () => {
    const { net } = highway('dual-4');
    const { node, ramp } = drawOff(net, 0, { travel: 1, side: 1 });
    const [, after] = mainAt(net, node);
    // The far carriageway's inside lane, sent across to the ramp on purpose.
    const lane = lanesOf(net, after).find((l) => net.roadTypeOf(after).lanes[l.laneIndex].dir === -1)!;
    net.setJunctionControl(node, { laneLinks: [{ from: `${after}:${lane.laneIndex}`, to: `${ramp}:0` }] });
    const conn = connectorsAt(net, node);
    expect(conn).toHaveLength(1);
    expect(toOf(net, conn[0]).segmentId).toBe(ramp);
  });
});

describe('controlled access in the simulation', () => {
  it('no vehicle crosses the median of a dual carriageway with ramps on both sides', () => {
    const { net } = highway('dual-6');
    drawOff(net, -300, { travel: 1, side: 1 });
    drawOn(net, 300, { travel: 1, side: 1 });
    drawOff(net, 260, { travel: -1, side: -1 });
    drawOn(net, -260, { travel: -1, side: -1 });
    const sim = new Simulation(net);
    // Which side of the median each vehicle was on while it was on the highway.
    const side = new Map<number, number>();
    let crossings = 0;
    let seen = 0;
    for (let step = 0; step < 2500; step++) {
      sim.step();
      const v = sim.vehicles;
      for (let i = 0; i < v.count; i++) {
        if (Math.abs(v.x[i]) > 580 || Math.abs(v.z[i]) > 9 || Math.abs(v.z[i]) < 0.6) continue;
        const s = Math.sign(v.z[i]);
        const was = side.get(v.id[i]);
        if (was === undefined) side.set(v.id[i], s);
        else if (was !== s) crossings++;
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(1000);
    expect(crossings).toBe(0);
    expect(sim.stats().despawnedStuck).toBe(0);
  });
});

describe('ramps drawn the wrong way', () => {
  it('a ramp leaving against the traffic is an error, and gets no connector', () => {
    const { net } = highway('highway-3');
    const near = hwAt(net, 0);
    const params: DrawRoadParams = { start: onSeg(near.segmentId, near.t), end: free(-260, 150), c1: v(-100, 6), c2: v(-190, 60), roadType: 'ramp-1' };
    const issues = net.validateDraft(params);
    expect(issues.find((i) => i.code === 'wrongWay')?.severity).toBe('error');
    const r = net.drawRoad(params);
    expect(connectorsAt(net, r.nodes[0]).filter((c) => toOf(net, c).segmentId === r.segments[0])).toEqual([]);
  });

  it('an on-ramp joining against the traffic is an error', () => {
    const { net } = highway('highway-3');
    const near = hwAt(net, 0);
    const issues = net.validateDraft({ start: free(260, 150), end: onSeg(near.segmentId, near.t), c1: v(190, 60), c2: v(100, 6), roadType: 'ramp-1' });
    expect(issues.find((i) => i.code === 'wrongWay')?.severity).toBe('error');
  });

  it('on a dual carriageway, a ramp on the far side serves the far carriageway only', () => {
    const { net } = highway('dual-4');
    const near = hwAt(net, 0);
    // On the -z side, traffic runs -x, so a ramp leaving towards +x there is backwards.
    const issues = net.validateDraft({ start: onSeg(near.segmentId, near.t), end: free(260, -150), c1: v(100, -6), c2: v(190, -60), roadType: 'ramp-1' });
    expect(issues.map((i) => i.code)).toContain('wrongWay');
  });
});

describe('ramp lane attach', () => {
  it('starts on the outer edge of the chosen lane, tangent to the highway', () => {
    const { net } = highway('highway-3');
    const { node, ramp } = drawOff(net, 0, { travel: 1, side: 1 });
    const c = net.cubicOf(ramp);
    const nodePos = net.getNode(node)!.pos;
    // Three 3.75 m lanes centred on the road: the outer edge is 5.625 m right.
    expect(c.p0.z - nodePos.z).toBeCloseTo(5.625, 3);
    expect(c.p0.x).toBeCloseTo(nodePos.x, 3);
    expect(Math.abs(cubicTangentXZ(c, 0).z)).toBeLessThan(0.1);
    // The ramp leaves at a small angle, and clears the highway well inside the trim cap.
    expect(net.segmentGeom(ramp)!.trimA).toBeLessThan(80);
  });

  it('survives serialize and load', () => {
    const { net } = highway('highway-3');
    const { ramp } = drawOff(net, 0, { travel: 1, side: 1 }, { lane: 1 });
    const before = net.cubicOf(ramp);
    const copy = new RoadNetwork(net.serialize());
    expect(copy.getSegment(ramp)!.overrides.attachA).toEqual(net.getSegment(ramp)!.overrides.attachA);
    expect(distXZ(copy.cubicOf(ramp).p0, before.p0)).toBeLessThan(1e-9);
    expect(copy.signature()).toBe(net.signature());
  });

  it('old saves without an attach still load and sit on the centreline', () => {
    const { net } = highway('highway-3');
    const { ramp, node } = drawOff(net, 0, { travel: 1, side: 1 }, { attach: false });
    const copy = new RoadNetwork(net.serialize());
    expect(copy.getSegment(ramp)!.overrides.attachA).toBeUndefined();
    expect(distXZ(copy.cubicOf(ramp).p0, copy.getNode(node)!.pos)).toBe(0);
  });

  it('stays with its own end when the ramp is split', () => {
    const { net } = highway('highway-3');
    const { ramp } = drawOff(net, 0, { travel: 1, side: 1 });
    const p0 = net.cubicOf(ramp).p0;
    const mid = cubicPoint(net.cubicOf(ramp), 0.5);
    const { left, right } = net.splitSegment(ramp, 0.5);
    expect(net.getSegment(left)!.overrides.attachA).toBeDefined();
    expect(net.getSegment(left)!.overrides.attachB).toBeUndefined();
    expect(net.getSegment(right!)!.overrides.attachA).toBeUndefined();
    expect(distXZ(net.cubicOf(left).p0, p0)).toBeLessThan(1e-6);
    expect(distXZ(net.cubicOf(left).p3, mid)).toBeLessThan(1e-6);
    expectClean(net);
  });

  it('moves with the highway, and keeps to its edge when the highway turns', () => {
    const { net } = highway('highway-3');
    const { node, ramp } = drawOff(net, 0, { travel: 1, side: 1 });
    net.moveNode(node, v(10, 30));
    let c = net.cubicOf(ramp);
    const pos = net.getNode(node)!.pos;
    expect(distXZ(c.p0, pos)).toBeCloseTo(5.625, 3);
    // Swing the far end of the highway: the ramp start follows the new direction.
    const [, after] = mainAt(net, node);
    const far = net.getSegment(after)!.b;
    net.moveNode(far, v(600, 200));
    c = net.cubicOf(ramp);
    // The highway now kinks at the node: the ramp sits square to the mean direction.
    const [before2] = mainAt(net, node);
    const t1 = cubicTangentXZ(net.cubicOf(before2), 1);
    const t2 = cubicTangentXZ(net.cubicOf(after), 0);
    const len = Math.hypot(t1.x + t2.x, t1.z + t2.z);
    const hostDir = { x: (t1.x + t2.x) / len, y: 0, z: (t1.z + t2.z) / len };
    const rel = { x: c.p0.x - pos.x, y: 0, z: c.p0.z - pos.z };
    // Square to the highway at the node, on its right.
    expect(Math.abs(rel.x * hostDir.x + rel.z * hostDir.z)).toBeLessThan(1e-6);
    expect(-hostDir.z * rel.x + hostDir.x * rel.z).toBeCloseTo(5.625, 3);
    expectClean(net);
    // And the incremental state matches a fresh build.
    const fresh = new RoadNetwork(net.serialize());
    expect(JSON.stringify(fresh.segmentGeom(ramp)!.stations[0].pos)).toBe(JSON.stringify(net.segmentGeom(ramp)!.stations[0].pos));
  });

  it('stays attached when the highway is split elsewhere or its type changes', () => {
    const { net } = highway('highway-3');
    const { node, ramp } = drawOff(net, 0, { travel: 1, side: 1 });
    const [before, after] = mainAt(net, node);
    net.splitSegment(after, 0.5);
    net.splitSegment(before, 0.5);
    expect(net.cubicOf(ramp).p0.z).toBeCloseTo(5.625, 3);
    const [b2, a2] = mainAt(net, node);
    net.setRoadType(b2, 'highway-4');
    net.setRoadType(a2, 'highway-4');
    expect(net.cubicOf(ramp).p0.z).toBeCloseTo(7.5, 3);
    const conn = connectorsAt(net, node).filter((c) => toOf(net, c).segmentId === ramp);
    expect(conn.map((c) => fromOf(net, c).laneIndex)).toEqual([3]);
  });

  it('turns round with the ramp when it is reversed', () => {
    const { net } = highway('highway-3');
    const { ramp } = drawOff(net, 0, { travel: 1, side: 1 });
    const p0 = net.cubicOf(ramp).p0;
    net.reverseSegment(ramp);
    const seg = net.getSegment(ramp)!;
    expect(seg.overrides.attachA).toBeUndefined();
    expect(seg.overrides.attachB).toEqual({ lane: 0, hostSide: 1 });
    expect(distXZ(net.cubicOf(ramp).p3, p0)).toBeLessThan(1e-6);
  });

  it('an on-ramp ends on the edge aligned with the traffic', () => {
    const { net } = highway('highway-3');
    const { node, ramp } = drawOn(net, 0, { travel: 1, side: 1 });
    const c = net.cubicOf(ramp);
    expect(c.p3.z - net.getNode(node)!.pos.z).toBeCloseTo(5.625, 3);
    expect(cubicTangentXZ(c, 1).x).toBeGreaterThan(0.99);
  });
});

describe('a road on top of another road is refused', () => {
  const errors = (net: RoadNetwork, p: DrawRoadParams) => net.validateDraft(p).filter((i) => i.severity === 'error');
  const overlap = (net: RoadNetwork, p: DrawRoadParams) => errors(net, p).find((i) => /overlap|junction without|doubles back/i.test(i.message));

  it('fully on top, partly along, or too close alongside', () => {
    const { net } = highway('highway-3');
    expect(overlap(net, { start: free(-300, 0), end: free(300, 0), roadType: 'street-2' })?.message).toMatch(/overlaps an existing road/i);
    expect(overlap(net, { start: free(400, 0), end: free(900, 0), roadType: 'street-2' })).toBeDefined();
    // Edges overlap: 8.1 m highway half width plus 3.5 m street half width.
    expect(overlap(net, { start: free(-300, 10), end: free(300, 10), roadType: 'street-2' })).toBeDefined();
    // Clear of it alongside is fine.
    expect(overlap(net, { start: free(-300, 14), end: free(300, 14), roadType: 'street-2' })).toBeUndefined();
    const issue = overlap(net, { start: free(-300, 0), end: free(300, 0), roadType: 'street-2' })!;
    expect(issue.stretch!.length).toBeGreaterThan(10);
  });

  it('drawn from a node or a point along it, back over the same road', () => {
    const { net, seg } = highway('highway-3');
    expect(overlap(net, { start: onSeg(seg, 0.5), end: free(400, 0.5), roadType: 'highway-3' })).toBeDefined();
    const end = net.getSegment(seg)!.b;
    expect(overlap(net, { start: atNode(end), end: free(200, 1), roadType: 'highway-3' })).toBeDefined();
  });

  it('a road doubling back over itself', () => {
    const net = new RoadNetwork();
    const p: DrawRoadParams = { start: free(0, 0), end: free(0, 6), c1: v(300, 0), c2: v(300, 6), roadType: 'street-2' };
    expect(overlap(net, p)?.message).toMatch(/doubles back/i);
  });

  it('through an existing junction surface without joining it', () => {
    const { net } = highway('highway-3');
    const { node } = drawOff(net, 0, { travel: 1, side: 1 });
    // Crosses the highway inside the ramp junction's surface, but not at its node.
    const g = net.nodeGeom(node)!;
    const inside = g.outline.reduce((m, p) => (p.x > m ? p.x : m), -Infinity) - 20;
    const issue = overlap(net, { start: free(inside, -150), end: free(inside, 150), roadType: 'street-2' });
    expect(issue).toBeDefined();
  });

  it('allows the exceptions: ramps, bridges, crossings, continuing a road', () => {
    const { net, seg } = highway('highway-3');
    // A ramp leaving at a small angle overlaps near its node by design.
    const near = hwAt(net, 0);
    expect(errors(net, {
      start: onSeg(near.segmentId, near.t), end: free(260, 150), c1: v(100, 6), c2: v(190, 60),
      roadType: 'ramp-1', startAttach: attachOn(1, 1),
    })).toEqual([]);
    // The same from the centreline, as older ramps were drawn.
    expect(errors(net, { start: onSeg(near.segmentId, near.t), end: free(260, 150), c1: v(90, 0), c2: v(180, 70), roadType: 'ramp-1' })).toEqual([]);
    // A bridge over it, a crossing at grade.
    expect(overlap(net, { start: free(-100, 0, 8), end: free(300, 0, 8), roadType: 'street-2' })).toBeUndefined();
    expect(overlap(net, { start: free(-200, -200), end: free(-200, 200), roadType: 'street-2' })).toBeUndefined();
    // Carrying on from its end.
    const end = net.getSegment(seg)!.b;
    expect(overlap(net, { start: atNode(end), end: free(900, 0), roadType: 'highway-3' })).toBeUndefined();
  });

  it('allows an on-ramp merge, and a ramp leaving and rejoining further on', () => {
    const { net } = highway('highway-3');
    const near = hwAt(net, 0);
    expect(errors(net, {
      start: free(-260, 150), end: onSeg(near.segmentId, near.t), c1: v(-190, 60), c2: v(-100, 6),
      roadType: 'ramp-1', endAttach: attachOn(1, 1),
    })).toEqual([]);
  });

  it('a road moved on top of another is reported', async () => {
    const { segmentOverlapIssues } = await import('../../src/core/overlap');
    const { net } = highway('highway-3');
    const s = net.drawRoad({ start: free(-300, 40), end: free(300, 40), roadType: 'street-2' }).segments[0];
    expect(segmentOverlapIssues(net, s)).toEqual([]);
    const seg = net.getSegment(s)!;
    net.moveNode(seg.a, v(-300, 2));
    net.moveNode(seg.b, v(300, 2));
    expect(segmentOverlapIssues(net, s).map((i) => i.message).join()).toMatch(/overlaps/i);
  });
});
