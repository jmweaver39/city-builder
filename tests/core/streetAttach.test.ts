import { describe, expect, it } from 'vitest';
import { RoadNetwork, effectiveControl, movementsAt, defaultSignalPlan, type DrawRoadParams, type GLane, type Id, type RampAttach } from '../../src/core';
import { Simulation } from '../../src/sim/Simulation';
import { atNode, expectClean, expectConnectorsContinuous, free, lanesWithoutExit, onSeg, v } from './helpers';

/** A street along x from -400 to 400, drawn +x. Its +x lanes (dir 1) are on the +z side. */
function street(type: string) {
  const net = new RoadNetwork();
  const seg = net.drawRoad({ start: free(-400, 0), end: free(400, 0), roadType: type }).segments[0];
  return { net, seg };
}

function connectorsAt(net: RoadNetwork, node: Id): GLane[] {
  const g = net.laneGraph;
  return (g.connectorsAt.get(node) ?? []).map((i) => g.lanes[i]);
}
const fromOf = (net: RoadNetwork, c: GLane) => net.laneGraph.lanes[c.fromLane];
const toOf = (net: RoadNetwork, c: GLane) => net.laneGraph.lanes[c.toLane];

/** Street segments at a node, as [before, after] in the +x sense. */
function hostAt(net: RoadNetwork, node: Id, ramp: Id): [Id, Id] {
  const segs = net.getNode(node)!.segments.filter((s) => s !== ramp);
  return [segs.find((s) => net.getSegment(s)!.b === node)!, segs.find((s) => net.getSegment(s)!.a === node)!];
}

/** Lane index on a street-like road with direction `dir`, `fromKerb` lanes in from its kerb. */
function laneIndex(net: RoadNetwork, seg: Id, dir: 1 | -1, fromKerb: number): number {
  const lanes = net.roadTypeOf(seg).lanes.map((l, i) => ({ ...l, i })).filter((l) => l.dir === dir && (l.kind === 'drive' || l.kind === 'bus'));
  // The kerb is right of the travel: highest offset for dir 1, lowest for dir -1.
  lanes.sort((a, b) => (b.offset - a.offset) * dir);
  return lanes[fromKerb].i;
}

const terminal = (lanes: number[]): RampAttach => ({ lane: 0, hostSide: 1, lanes });

/** A road arriving at the street at x = 0 from the +z side, square to it. */
function drawArriving(net: RoadNetwork, host: Id, roadType: string, attach: RampAttach | undefined) {
  const params: DrawRoadParams = { start: free(0, 250), end: onSeg(host, 0.5), roadType, endAttach: attach };
  const issues = net.validateDraft(params);
  const r = net.drawRoad(params);
  return { node: r.nodes[r.nodes.length - 1], road: r.segments[r.segments.length - 1], issues };
}

/** A road leaving the street at x = 0 to the +z side, square to it. */
function drawLeaving(net: RoadNetwork, host: Id, roadType: string, attach: RampAttach | undefined) {
  const params: DrawRoadParams = { start: onSeg(host, 0.5), end: free(0, 250), roadType, startAttach: attach };
  const issues = net.validateDraft(params);
  const r = net.drawRoad(params);
  return { node: r.nodes[0], road: r.segments[0], issues };
}

describe('street terminals: chosen lanes', () => {
  it('an off-ramp onto street-4 that feeds only the near kerb lane', () => {
    const { net, seg } = street('street-4');
    const { node, road, issues } = drawArriving(net, seg, 'ramp-1', terminal([0]));
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    const [, after] = hostAt(net, node, road);
    const fromRamp = connectorsAt(net, node).filter((c) => fromOf(net, c).segmentId === road);
    expect(fromRamp).toHaveLength(1);
    expect(toOf(net, fromRamp[0]).segmentId).toBe(after);
    expect(toOf(net, fromRamp[0]).laneIndex).toBe(laneIndex(net, after, 1, 0));
    expect(fromRamp[0].turn).toBe('right');
    // The street's own traffic carries straight on in every lane.
    expect(lanesWithoutExit(net.laneGraph)).toEqual([]);
    expectConnectorsContinuous(net.laneGraph, node, 4);
    expectClean(net);
  });

  it('an on-ramp from street-4 fed only from the right lane', () => {
    const { net, seg } = street('street-4');
    const { node, road } = drawLeaving(net, seg, 'ramp-1', terminal([0]));
    const [before] = hostAt(net, node, road);
    const toRamp = connectorsAt(net, node).filter((c) => toOf(net, c).segmentId === road);
    expect(toRamp).toHaveLength(1);
    expect(fromOf(net, toRamp[0]).segmentId).toBe(before);
    expect(fromOf(net, toRamp[0]).laneIndex).toBe(laneIndex(net, before, 1, 0));
    expect(toRamp[0].turn).toBe('right');
    expectClean(net);
  });

  it('a two-lane ramp splits into a left-turn lane and a right-turn lane', () => {
    const { net, seg } = street('street-4');
    // Near kerb lane (0) for the right turn, far inside lane (2) for the left.
    const { node, road } = drawArriving(net, seg, 'ramp-2', terminal([0, 2]));
    const [before, after] = hostAt(net, node, road);
    const fromRamp = connectorsAt(net, node).filter((c) => fromOf(net, c).segmentId === road);
    expect(fromRamp).toHaveLength(2);
    const byLane = new Map(fromRamp.map((c) => [fromOf(net, c).laneIndex, c]));
    expect(byLane.size).toBe(2);
    // Ramp lanes left to right as the driver sees them: lane 0 is the left one.
    const left = byLane.get(0)!;
    const right = byLane.get(1)!;
    expect(left.turn).toBe('left');
    expect(toOf(net, left).segmentId).toBe(before);
    expect(toOf(net, left).laneIndex).toBe(laneIndex(net, before, -1, 1));
    expect(right.turn).toBe('right');
    expect(toOf(net, right).segmentId).toBe(after);
    expect(toOf(net, right).laneIndex).toBe(laneIndex(net, after, 1, 0));
    expectClean(net);
  });

  it('a two-way road on a terminal uses the same lanes both ways', () => {
    const { net, seg } = street('avenue-4');
    const { node, road } = drawArriving(net, seg, 'street-2', terminal([0]));
    const [before, after] = hostAt(net, node, road);
    const conn = connectorsAt(net, node);
    const fromRoad = conn.filter((c) => fromOf(net, c).segmentId === road);
    const toRoad = conn.filter((c) => toOf(net, c).segmentId === road);
    expect(fromRoad.map((c) => [toOf(net, c).segmentId, toOf(net, c).laneIndex])).toEqual([[after, laneIndex(net, after, 1, 0)]]);
    expect(toRoad.map((c) => [fromOf(net, c).segmentId, fromOf(net, c).laneIndex])).toEqual([[before, laneIndex(net, before, 1, 0)]]);
    expectClean(net);
  });

  it('without chosen lanes the terminal is an ordinary junction', () => {
    const { net, seg } = street('street-4');
    const { node, road } = drawArriving(net, seg, 'ramp-1', undefined);
    const fromRamp = connectorsAt(net, node).filter((c) => fromOf(net, c).segmentId === road);
    expect(new Set(fromRamp.map((c) => c.turn))).toEqual(new Set(['left', 'right']));
  });

  it('hand-set lane links still win', () => {
    const { net, seg } = street('street-4');
    const { node, road } = drawArriving(net, seg, 'ramp-1', terminal([0]));
    const [before] = hostAt(net, node, road);
    const far = laneIndex(net, before, -1, 0);
    net.setJunctionControl(node, { laneLinks: [{ from: `${road}:0`, to: `${before}:${far}` }] });
    const conn = connectorsAt(net, node);
    expect(conn).toHaveLength(1);
    expect(toOf(net, conn[0]).laneIndex).toBe(far);
  });
});

describe('street side merges', () => {
  /** A one-way road joining the street's +z kerb at x0, aligned with its +x traffic. */
  function drawMerge(net: RoadNetwork, host: Id, x0: number, lane = 0) {
    const near = net.nearestSegment(v(x0, 0))!;
    const params: DrawRoadParams = {
      start: free(x0 - 200, 120),
      end: onSeg(near.segmentId, near.t),
      c1: v(x0 - 140, 40),
      c2: v(x0 - 70, 8),
      roadType: 'ramp-1',
      // Host on the ramp's left: the ramp is on the street's right (+z) side.
      endAttach: { lane, hostSide: -1 },
    };
    const issues = net.validateDraft(params);
    const r = net.drawRoad(params);
    return { node: r.nodes[r.nodes.length - 1], road: r.segments[r.segments.length - 1], issues };
  }

  it('a slip road merges into the kerb lane only, and flows freely', () => {
    const { net, seg } = street('street-4');
    const { node, road, issues } = drawMerge(net, seg, 0);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    const [, after] = hostAt(net, node, road);
    const fromRamp = connectorsAt(net, node).filter((c) => fromOf(net, c).segmentId === road);
    expect(fromRamp.map((c) => [toOf(net, c).segmentId, toOf(net, c).laneIndex])).toEqual([[after, laneIndex(net, after, 1, 0)]]);
    // Nothing goes back across the oncoming lanes.
    expect(connectorsAt(net, node).filter((c) => c.turn === 'uturn')).toEqual([]);
    expect(effectiveControl(net, node).kind).toBe('none');
    expectClean(net);
  });

  it('never crosses a median: a merge onto an avenue reaches only its own carriageway', () => {
    const { net, seg } = street('avenue-6');
    // Ask for more lanes than the carriageway has: it stops at the median.
    const { node, road } = drawMerge(net, seg, 0, 5);
    const [, after] = hostAt(net, node, road);
    const fromRamp = connectorsAt(net, node).filter((c) => fromOf(net, c).segmentId === road);
    const def = net.roadTypeOf(after);
    expect(fromRamp.length).toBe(3);
    for (const c of fromRamp) {
      expect(toOf(net, c).segmentId).toBe(after);
      expect(def.lanes[toOf(net, c).laneIndex].dir).toBe(1);
    }
  });

  it('a merge drawn against the street traffic is refused', () => {
    const { net, seg } = street('street-4');
    const near = net.nearestSegment(v(0, 0))!;
    const issues = net.validateDraft({
      start: free(200, 120),
      end: onSeg(near.segmentId, near.t),
      c1: v(140, 40),
      c2: v(70, 8),
      roadType: 'ramp-1',
      endAttach: { lane: 0, hostSide: 1 },
    });
    expect(issues.some((i) => i.code === 'wrongWay')).toBe(true);
    void seg;
  });
});

describe('street terminals: junction control', () => {
  it('signal phases carry the chosen movements only', () => {
    const { net, seg } = street('avenue-4');
    const { node, road } = drawArriving(net, seg, 'ramp-2', terminal([0, 2]));
    net.setJunctionControl(node, { mode: 'signal' });
    expect(effectiveControl(net, node).kind).toBe('signal');
    const fromRamp = movementsAt(net, node).filter((m) => m.fromSegment === road);
    expect(fromRamp.map((m) => m.turn).sort()).toEqual(['left', 'right']);
    const plan = defaultSignalPlan(net, node, 'protectedLefts');
    const served = new Set(plan.phases.flatMap((p) => Object.keys(p.moves)));
    for (const m of fromRamp) expect(served.has(m.key)).toBe(true);
    // Stop and yield work as at any junction.
    net.setJunctionControl(node, { mode: 'allStop' });
    expect(effectiveControl(net, node).signs[road]).toBe('stop');
    net.setJunctionControl(node, { mode: 'priority', signs: { [road]: 'yield' } });
    expect(effectiveControl(net, node).signs[road]).toBe('yield');
  });

  it('in the simulation, vehicles turning left at a signalised terminal use the left lane', () => {
    const { net, seg } = street('avenue-4');
    const { node, road } = drawArriving(net, seg, 'ramp-2', terminal([0, 2]));
    const [before, after] = hostAt(net, node, road);
    net.setJunctionControl(node, { mode: 'signal' });
    net.setTraffic({ autoGatewayRatePerLane: 700 });
    const sim = new Simulation(net, 7);
    const g = () => net.laneGraph;
    const conn = new Set(g().connectorsAt.get(node)!);
    let left = 0;
    let right = 0;
    let wrong = 0;
    for (let step = 0; step < 3000; step++) {
      sim.step();
      const { veh } = sim.state;
      for (let i = 0; i < veh.liveCount; i++) {
        const k = veh.live[i];
        const l = veh.lane[k];
        if (!conn.has(l)) continue;
        const c = g().lanes[l];
        const from = g().lanes[c.fromLane];
        if (from.segmentId !== road) continue;
        const to = g().lanes[c.toLane];
        if (to.segmentId === before) {
          left++;
          if (from.laneIndex !== 0) wrong++;
        } else if (to.segmentId === after) {
          right++;
          if (from.laneIndex !== 1) wrong++;
        } else wrong++;
      }
    }
    expect(left).toBeGreaterThan(50);
    expect(right).toBeGreaterThan(50);
    expect(wrong).toBe(0);
    expect(sim.stats().despawnedStuck).toBe(0);
  });
});

describe('street attaches persist', () => {
  it('survive save and load, split, reverse and moving the host', () => {
    const { net, seg } = street('street-4');
    const { node, road } = drawArriving(net, seg, 'ramp-2', terminal([0, 2]));
    const links = () =>
      connectorsAt(net, node)
        .filter((c) => fromOf(net, c).segmentId === road)
        .map((c) => `${fromOf(net, c).laneIndex}>${net.roadTypeOf(toOf(net, c).segmentId).lanes[toOf(net, c).laneIndex].dir}:${c.turn}`)
        .sort();
    const want = links();
    expect(want).toEqual(['0>-1:left', '1>1:right']);

    const copy = new RoadNetwork(net.serialize());
    expect(copy.getSegment(road)!.overrides.attachB).toEqual(terminal([0, 2]));
    // Splitting the ramp keeps the attach on the end at the street.
    const { right } = net.splitSegment(road, 0.5);
    const tail = right!;
    expect(net.getSegment(tail)!.overrides.attachB).toEqual(terminal([0, 2]));
    const tailLinks = connectorsAt(net, node).filter((c) => fromOf(net, c).segmentId === tail);
    expect(tailLinks.map((c) => c.turn).sort()).toEqual(['left', 'right']);
    // Reversing the street keeps the same physical lanes: kerb lane for the right turn.
    const [before, after] = hostAt(net, node, tail);
    net.reverseSegment(before);
    net.reverseSegment(after);
    const turns = connectorsAt(net, node).filter((c) => fromOf(net, c).segmentId === tail);
    expect(turns.map((c) => c.turn).sort()).toEqual(['left', 'right']);
    const rightTurn = turns.find((c) => c.turn === 'right')!;
    expect(fromOf(net, rightTurn).laneIndex).toBe(1);
    // Moving the host node along keeps the terminal.
    net.moveNode(node, v(20, 0));
    expect(connectorsAt(net, node).filter((c) => fromOf(net, c).segmentId === tail).map((c) => c.turn).sort()).toEqual(['left', 'right']);
    expectClean(net);
  });

  it('old saves without chosen lanes load unchanged', () => {
    const { net, seg } = street('street-4');
    drawArriving(net, seg, 'ramp-1', undefined);
    const data = net.serialize();
    const copy = new RoadNetwork(data);
    expect(copy.signature()).toBe(net.signature());
    void atNode;
  });
});
