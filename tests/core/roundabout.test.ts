import { describe, expect, it } from 'vitest';
import { RoadNetwork, effectiveControl, movementsAt, type Id } from '../../src/core';
import {
  buildRoundabout,
  DEFAULT_ROUNDABOUT,
  findRoundabouts,
  planRoundabout,
  removeRoundabout,
  updateRoundabout,
  type RoundaboutParams,
} from '../../src/core/roundabout';
import { History } from '../../src/app/History';
import { expectClean, free, v } from './helpers';

const params = (p: Partial<RoundaboutParams> = {}): RoundaboutParams => ({ ...DEFAULT_ROUNDABOUT, ...p });

/** Two roads crossing at the origin. */
function crossing(type = 'street-2', len = 200): { net: RoadNetwork; node: Id } {
  const net = new RoadNetwork();
  net.drawRoad({ start: free(-len, 0), end: free(len, 0), roadType: type });
  net.drawRoad({ start: free(0, -len), end: free(0, len), roadType: type });
  const node = net.nodes.find((n) => n.segments.length === 4)!.id;
  return { net, node };
}

function ringOk(net: RoadNetwork): void {
  const [rb] = findRoundabouts(net);
  for (const id of rb.segments) {
    const g = net.segmentGeom(id)!;
    expect(g.stations.length, `ring segment ${id} has a visible span`).toBeGreaterThan(1);
    expect(g.length).toBeGreaterThan(2);
  }
}

describe('roundabouts', () => {
  it('builds a standalone roundabout on open ground', () => {
    const net = new RoadNetwork();
    const plan = planRoundabout(net, v(100, 50), params({ radius: 25 }));
    expect(plan.reasons).toEqual([]);
    expect(plan.arms).toHaveLength(0);
    buildRoundabout(net, plan);
    const all = findRoundabouts(net);
    expect(all).toHaveLength(1);
    expect(all[0].radius).toBeCloseTo(25, 0);
    expect(all[0].centre.x).toBeCloseTo(100, 0);
    expect(all[0].segments).toHaveLength(4);
    expectClean(net);
  });

  for (const lanes of [1, 2, 3] as const) {
    it(`replaces a 4-way junction with a ${lanes}-lane roundabout, joining every arm`, () => {
      const { net, node } = crossing(lanes === 1 ? 'street-2' : 'avenue-4');
      const plan = planRoundabout(net, net.getNode(node)!.pos, params({ radius: 22 + lanes * 6, lanes }), node);
      expect(plan.reasons).toEqual([]);
      expect(plan.arms).toHaveLength(4);
      buildRoundabout(net, plan);
      expect(net.getNode(node)).toBeUndefined();
      const [rb] = findRoundabouts(net);
      expect(rb.arms).toHaveLength(4);
      expect(rb.lanes).toBe(lanes);
      ringOk(net);
      expectClean(net);
      // The ring has priority and every entry yields.
      for (const arm of rb.arms) {
        const ctl = effectiveControl(net, arm.nodeId);
        expect(ctl.kind).toBe('priority');
        expect(ctl.signs[arm.segmentId]).toBe('yield');
        const ringIn = rb.segments.find((s) => net.getSegment(s)!.b === arm.nodeId)!;
        expect(ctl.signs[ringIn]).toBe('priority');
      }
      // Arms meet the ring square on.
      for (const arm of rb.arms) {
        const p = net.getNode(arm.nodeId)!.pos;
        const seg = net.getSegment(arm.segmentId)!;
        const handle = arm.atStart ? seg.c1 : seg.c2;
        const radial = Math.atan2(p.z, p.x);
        const out = Math.atan2(handle.z - p.z, handle.x - p.x);
        expect(Math.abs(Math.atan2(Math.sin(out - radial), Math.cos(out - radial)))).toBeLessThan(0.02);
      }
    });
  }

  it('circulates anticlockwise seen from above, and every entry and exit is a right turn', () => {
    const { net, node } = crossing();
    buildRoundabout(net, planRoundabout(net, v(0, 0), params(), node));
    const [rb] = findRoundabouts(net);
    // Anticlockwise from above means the heading angle falls along the ring.
    for (const id of rb.segments) {
      const s = net.getSegment(id)!;
      const a = net.getNode(s.a)!.pos;
      const b = net.getNode(s.b)!.pos;
      const turn = Math.atan2(Math.sin(Math.atan2(b.z, b.x) - Math.atan2(a.z, a.x)), Math.cos(Math.atan2(b.z, b.x) - Math.atan2(a.z, a.x)));
      expect(turn).toBeLessThan(0);
    }
    for (const arm of rb.arms) {
      for (const m of movementsAt(net, arm.nodeId)) {
        if (m.fromSegment === arm.segmentId || m.toSegment === arm.segmentId) expect(m.turn).toBe('right');
      }
    }
  });

  it('uses a spiral lane plan on a two-lane ring', () => {
    const { net, node } = crossing('avenue-4');
    buildRoundabout(net, planRoundabout(net, v(0, 0), params({ radius: 34, lanes: 2 }), node));
    const [rb] = findRoundabouts(net);
    const g = net.laneGraph;
    const arm = rb.arms[0];
    const ringIn = rb.segments.find((s) => net.getSegment(s)!.b === arm.nodeId)!;
    const ringOut = rb.segments.find((s) => net.getSegment(s)!.a === arm.nodeId)!;
    const conns = (g.connectorsAt.get(arm.nodeId) ?? []).map((i) => g.lanes[i]);
    const from = (seg: Id, lane: number) =>
      conns.filter((c) => g.lanes[c.fromLane].segmentId === seg && g.lanes[c.fromLane].laneIndex === lane);
    // Ring lanes: index 0 is inner (left), 1 is outer (right).
    const outer = from(ringIn, 1);
    expect(outer.length).toBeGreaterThan(0);
    expect(outer.every((c) => g.lanes[c.toLane].segmentId === arm.segmentId)).toBe(true);
    const inner = from(ringIn, 0);
    const innerTo = inner.map((c) => `${g.lanes[c.toLane].segmentId}:${g.lanes[c.toLane].laneIndex}`);
    expect(innerTo).toContain(`${ringOut}:0`);
    expect(innerTo).toContain(`${ringOut}:1`);
    // The arm's right lane feeds the outer ring lane, its left lane the inner one.
    const armLanes = conns.filter((c) => g.lanes[c.fromLane].segmentId === arm.segmentId);
    const targets = new Set(armLanes.map((c) => g.lanes[c.toLane].laneIndex));
    expect(targets).toEqual(new Set([0, 1]));
  });

  it('changes radius, lanes, speed and priority in place, keeping ids', () => {
    const { net, node } = crossing('avenue-4', 260);
    buildRoundabout(net, planRoundabout(net, v(0, 0), params({ radius: 30 }), node));
    const before = findRoundabouts(net)[0];
    expect(updateRoundabout(net, before, params({ radius: 50, lanes: 2, speedKmh: 40, priority: 'signal' }))).toEqual([]);
    const after = findRoundabouts(net)[0];
    expect(after.segments).toEqual(before.segments);
    expect(after.radius).toBeCloseTo(50, 0);
    expect(after.lanes).toBe(2);
    expect(after.speedKmh).toBe(40);
    expect(after.priority).toBe('signal');
    for (const arm of after.arms) expect(effectiveControl(net, arm.nodeId).kind).toBe('signal');
    ringOk(net);
    expectClean(net);
    expect(updateRoundabout(net, after, params({ radius: 24, lanes: 1 }))).toEqual([]);
    expect(findRoundabouts(net)[0].radius).toBeCloseTo(24, 0);
    expectClean(net);
  });

  it('refuses settings that do not fit, saying why', () => {
    const { net, node } = crossing('street-2', 60);
    const far = planRoundabout(net, v(0, 0), params({ radius: 55 }), node);
    expect(far.ok).toBe(false);
    expect(far.reasons.join(' ')).toMatch(/too short/);
    // Wide roads need a bigger ring.
    const wide = crossing('boulevard-8', 300);
    const tight = planRoundabout(wide.net, v(0, 0), params({ radius: 18, lanes: 2 }), wide.node);
    expect(tight.reasons.join(' ')).toMatch(/larger radius/);
    // Two roads leaving at a narrow angle.
    const vee = new RoadNetwork();
    vee.drawRoad({ start: free(0, 0), end: free(200, 0), roadType: 'avenue-4' });
    vee.drawRoad({ start: free(0, 0), end: free(200, 30), roadType: 'avenue-4' });
    vee.drawRoad({ start: free(0, 0), end: free(-200, 0), roadType: 'avenue-4' });
    const n = vee.nodes.find((x) => x.segments.length === 3)!.id;
    const close = planRoundabout(vee, v(0, 0), params({ radius: 18 }), n);
    expect(close.reasons.join(' ')).toMatch(/too close together/);
    // Another junction inside the circle.
    const two = new RoadNetwork();
    two.drawRoad({ start: free(-200, 0), end: free(200, 0), roadType: 'street-2' });
    two.drawRoad({ start: free(0, -200), end: free(0, 200), roadType: 'street-2' });
    two.drawRoad({ start: free(20, -200), end: free(20, 200), roadType: 'street-2' });
    const centre = two.nodes.find((x) => x.segments.length === 4 && Math.abs(x.pos.x) < 1)!.id;
    expect(planRoundabout(two, v(0, 0), params({ radius: 40 }), centre).reasons.join(' ')).toMatch(/Another junction/);
  });

  it('removes a roundabout and joins its arms again in the middle', () => {
    const { net, node } = crossing();
    buildRoundabout(net, planRoundabout(net, v(0, 0), params(), node));
    removeRoundabout(net, findRoundabouts(net)[0]);
    expect(findRoundabouts(net)).toHaveLength(0);
    const middle = net.nodes.find((n) => n.segments.length === 4);
    expect(middle).toBeDefined();
    expect(Math.hypot(middle!.pos.x, middle!.pos.z)).toBeLessThan(0.01);
    expectClean(net);
  });

  it('is one undo step', () => {
    const { net, node } = crossing();
    const history = new History(net);
    const sig = net.signature();
    history.hint('Build roundabout');
    buildRoundabout(net, planRoundabout(net, v(0, 0), params(), node));
    expect(history.size).toBe(1);
    history.undo();
    expect(net.signature()).toBe(sig);
  });

  it('cuts a road it is placed across into two arms', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-200, 10), end: free(200, 10), roadType: 'street-2' });
    const plan = planRoundabout(net, v(0, 0), params({ radius: 30 }));
    expect(plan.reasons).toEqual([]);
    expect(plan.arms).toHaveLength(2);
    buildRoundabout(net, plan);
    expect(findRoundabouts(net)[0].arms).toHaveLength(2);
    expectClean(net);
  });

  it('takes a road drawn into the ring as a new yielding arm', () => {
    const net = new RoadNetwork();
    buildRoundabout(net, planRoundabout(net, v(0, 0), params({ radius: 30 })));
    const [rb] = findRoundabouts(net);
    const seg = rb.segments[0];
    net.drawRoad({ start: { kind: 'segment', id: seg, t: 0.5 }, end: free(150, -150), roadType: 'street-2' });
    const after = findRoundabouts(net)[0];
    expect(after.arms).toHaveLength(1);
    const arm = after.arms[0];
    expect(effectiveControl(net, arm.nodeId).signs[arm.segmentId]).toBe('yield');
    expectClean(net);
  });
});
