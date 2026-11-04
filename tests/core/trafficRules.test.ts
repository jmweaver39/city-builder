import { describe, expect, it } from 'vitest';
import { RoadNetwork, defaultSignalPlan, type Id, type TurnKind } from '../../src/core';
import {
  applyPriorityRoad,
  armRule,
  laneArrowsAt,
  priorityRoadPath,
  setArmRule,
  setLaneArrows,
  setLaneVehicles,
  setRoadSpeed,
  toggleArmRule,
  toggleLaneArrow,
  UNLIMITED_KMH,
} from '../../src/core/trafficRules';
import { applyGreenWave, copySignalPlan, cycleOf, pasteSignalPlan } from '../../src/core/signalTools';
import { History } from '../../src/app/History';
import { compileGraph, ALLOW_TRUCK, ALLOW_CAR } from '../../src/sim/compiled';
import { lanesWithoutExit } from './helpers';

const v = (x: number, z: number) => ({ x, y: 0, z });

/** A crossroads whose arms are drawn towards the hub, so the hub is each segment's b end. */
function inwardCross(type = 'street-4', arm = 200) {
  const net = new RoadNetwork();
  const hub = net.addNode(v(0, 0));
  const ends = [v(arm, 0), v(-arm, 0), v(0, arm), v(0, -arm)].map((p) => net.addNode(p));
  const segs = ends.map((e) => net.addSegment(e, hub, { roadType: type }));
  return { net, hub, ends, segs };
}

/** Turns of the connectors leaving one arriving lane. */
function turnsFrom(net: RoadNetwork, nodeId: Id, segId: Id, lane: number): TurnKind[] {
  const g = net.laneGraph;
  const road = g.roadLanes.get(segId)![lane];
  const set = new Set<TurnKind>();
  for (const c of g.connectorsAt.get(nodeId) ?? []) if (g.lanes[c].fromLane === road) set.add(g.lanes[c].turn ?? 'straight');
  return [...set].sort();
}

/** Arriving lanes on one arm, by lane index. */
function arriving(net: RoadNetwork, hub: Id, seg: Id): string[] {
  return laneArrowsAt(net, hub).filter((l) => l.segmentId === seg).map((l) => l.ref);
}

describe('lane arrows', () => {
  it('lay connectors out from the arrows and keep every lane with a way out', () => {
    const { net, hub, segs } = inwardCross();
    const lanes = laneArrowsAt(net, hub).filter((l) => l.segmentId === segs[0]);
    expect(lanes.length).toBe(2);
    const [a, b] = lanes;
    expect(a.available).toEqual(expect.arrayContaining(['left', 'straight', 'right']));
    setLaneArrows(net, hub, a.ref, ['left']);
    setLaneArrows(net, hub, b.ref, ['straight', 'right']);
    expect(turnsFrom(net, hub, segs[0], a.laneIndex)).toEqual(['left']);
    expect(turnsFrom(net, hub, segs[0], b.laneIndex)).toEqual(['right', 'straight']);
    expect(lanesWithoutExit(net.laneGraph)).toEqual([]);
    // Reading back shows what is set.
    const again = laneArrowsAt(net, hub).find((l) => l.ref === a.ref)!;
    expect(again.turns).toEqual(['left']);
    expect(again.explicit).toBe(true);
  });

  it('refuses to take away the last arrow, and toggles the rest', () => {
    const { net, hub, segs } = inwardCross();
    const ref = arriving(net, hub, segs[0])[0];
    setLaneArrows(net, hub, ref, ['straight']);
    expect(toggleLaneArrow(net, hub, ref, 'straight').ok).toBe(false);
    expect(toggleLaneArrow(net, hub, ref, 'right')).toMatchObject({ ok: true, turns: ['straight', 'right'] });
    expect(toggleLaneArrow(net, hub, ref, 'straight')).toMatchObject({ ok: true, turns: ['right'] });
  });

  it('give a lane a U-turn when asked', () => {
    const { net, hub, segs } = inwardCross();
    const ref = arriving(net, hub, segs[0])[1];
    expect(toggleLaneArrow(net, hub, ref, 'uturn').ok).toBe(true);
    expect(turnsFrom(net, hub, segs[0], Number(ref.split(':')[1]))).toContain('uturn');
  });

  it('survive save, split and undo', () => {
    const { net, hub, segs } = inwardCross();
    const ref = arriving(net, hub, segs[0])[0];
    const history = new History(net);
    history.hint('Lane arrows');
    setLaneArrows(net, hub, ref, ['right']);
    // Save and load.
    const loaded = new RoadNetwork(net.serialize());
    expect(loaded.getNode(hub)!.control.rules?.laneArrows?.[ref]).toEqual(['right']);
    expect(turnsFrom(loaded, hub, segs[0], Number(ref.split(':')[1]))).toEqual(['right']);
    // Splitting a road gives the hub's end a new id: the arrows follow it.
    const { right } = net.splitSegment(segs[0], 0.5);
    const lane = Number(ref.split(':')[1]);
    expect(net.getNode(hub)!.control.rules?.laneArrows?.[`${right}:${lane}`]).toEqual(['right']);
    expect(turnsFrom(net, hub, right!, lane)).toEqual(['right']);
    // Undo the split and then the arrows.
    history.undo();
    history.undo();
    expect(net.getNode(hub)!.control.rules).toBeUndefined();
  });

  it('follow the lane when a road is turned round', () => {
    const { net, hub, segs } = inwardCross('street-4');
    const [kerb] = laneArrowsAt(net, hub).filter((l) => l.segmentId === segs[0]);
    setLaneArrows(net, hub, kerb.ref, ['right']);
    const posBefore = kerb.pos;
    net.reverseSegment(segs[0]);
    const after = laneArrowsAt(net, hub).find((l) => l.segmentId === segs[0] && l.explicit)!;
    expect(after).toBeDefined();
    expect(Math.hypot(after.pos.x - posBefore.x, after.pos.z - posBefore.z)).toBeLessThan(0.5);
    expect(after.turns).toEqual(['right']);
  });

  it('leave old saves as they were', () => {
    const { net } = inwardCross();
    const text = JSON.stringify(net.serialize());
    expect(text).not.toContain('"rules"');
    expect(text).not.toContain('laneBans');
  });
});

describe('junction restrictions', () => {
  it('U-turns add a connector back along the arm', () => {
    const { net, hub, segs } = inwardCross();
    expect(turnsFrom(net, hub, segs[0], 1)).not.toContain('uturn');
    setArmRule(net, hub, segs[0], 'uturn', true);
    expect(armRule(net.getNode(hub)!.control, segs[0], 'uturn')).toBe(true);
    const turns = laneArrowsAt(net, hub).filter((l) => l.segmentId === segs[0]).flatMap((l) => l.turns);
    expect(turns).toContain('uturn');
    toggleArmRule(net, hub, segs[0], 'uturn');
    expect(net.getNode(hub)!.control.rules).toBeUndefined();
  });

  it('lane changing straight through links each straight lane to its neighbour too', () => {
    const { net, hub, segs } = inwardCross();
    const g0 = net.laneGraph;
    const count = () => {
      const g = net.laneGraph;
      return (g.connectorsAt.get(hub) ?? []).filter((c) => g.lanes[c].turn === 'straight' && g.lanes[g.lanes[c].fromLane].segmentId === segs[0]).length;
    };
    const before = count();
    expect(g0).toBeDefined();
    setArmRule(net, hub, segs[0], 'laneChange', true);
    expect(count()).toBeGreaterThan(before);
  });

  it('no pedestrian crossing takes the crosswalk away, and back', () => {
    const { net, hub, segs } = inwardCross();
    setArmRule(net, hub, segs[1], 'pedestrians', false);
    expect(net.getNode(hub)!.control.crosswalks[segs[1]]).toBe('none');
    setArmRule(net, hub, segs[1], 'pedestrians', true);
    expect(net.getNode(hub)!.control.crosswalks[segs[1]]).toBeUndefined();
  });

  it('are stripped when the road goes', () => {
    const { net, hub, segs } = inwardCross();
    setArmRule(net, hub, segs[2], 'enterBlocked', true);
    net.removeSegment(segs[2]);
    expect(net.getNode(hub)!.control.rules).toBeUndefined();
  });
});

describe('vehicle restrictions', () => {
  it('ban trucks from a road in the compiled lanes, and survive save', () => {
    const { net, segs } = inwardCross();
    setLaneVehicles(net, segs[0], null, ['car', 'van', 'bus', 'bike']);
    const loaded = new RoadNetwork(net.serialize());
    const g = compileGraph(loaded);
    for (const idx of loaded.laneGraph.roadLanes.get(segs[0])!) {
      expect(g.allow[idx] & ALLOW_TRUCK).toBe(0);
      expect(g.allow[idx] & ALLOW_CAR).toBe(ALLOW_CAR);
    }
    // Connectors into it close to trucks too.
    const into = loaded.laneGraph.lanes.filter((l) => l.kind === 'connector' && loaded.laneGraph.lanes[l.toLane].segmentId === segs[0]);
    expect(into.length).toBeGreaterThan(0);
    for (const c of into) expect(g.allow[c.idx] & ALLOW_TRUCK).toBe(0);
    // A split copies the ban to both halves.
    const { left, right } = loaded.splitSegment(segs[0], 0.5);
    expect(loaded.getSegment(left)!.overrides.laneBans).toEqual(loaded.getSegment(right!)!.overrides.laneBans);
  });
});

describe('speed limits', () => {
  it('set a road and clear its lane limits; no limit is above any vehicle', () => {
    const { net, segs } = inwardCross();
    net.setSegmentOverrides(segs[0], { laneSpeeds: { 0: 20 } });
    setRoadSpeed(net, segs[0], 80);
    expect(net.getSegment(segs[0])!.overrides).toMatchObject({ speedKmh: 80 });
    expect(net.getSegment(segs[0])!.overrides.laneSpeeds).toBeUndefined();
    setRoadSpeed(net, segs[0], UNLIMITED_KMH);
    const lane = net.laneGraph.lanes[net.laneGraph.roadLanes.get(segs[0])![0]];
    expect(lane.speed).toBeCloseTo(UNLIMITED_KMH / 3.6);
  });
});

describe('priority roads', () => {
  /** An avenue along x crossed by three streets. */
  function avenue() {
    const net = new RoadNetwork();
    const xs = [-300, -100, 100, 300];
    const nodes = [-500, ...xs, 500].map((x) => net.addNode(v(x, 0)));
    const main: Id[] = [];
    for (let i = 0; i + 1 < nodes.length; i++) main.push(net.addSegment(nodes[i], nodes[i + 1], { roadType: 'avenue-4' }));
    const side: Id[] = [];
    for (let i = 1; i <= xs.length; i++) {
      const n = net.addNode(v(xs[i - 1], 150));
      const s = net.addNode(v(xs[i - 1], -150));
      side.push(net.addSegment(nodes[i], n, { roadType: 'street-2' }), net.addSegment(nodes[i], s, { roadType: 'street-2' }));
    }
    return { net, nodes, main, side };
  }

  it('one click signs every junction along the road', () => {
    const { net, nodes, main, side } = avenue();
    const path = priorityRoadPath(net, main[2]);
    expect(path.segments.sort()).toEqual([...main].sort());
    const r = applyPriorityRoad(net, main[2]);
    expect(r.signed.length).toBe(4);
    for (let i = 1; i <= 4; i++) {
      const c = net.getNode(nodes[i])!.control;
      expect(c.mode).toBe('priority');
      expect(c.signs[main[i - 1]]).toBe('priority');
      expect(c.signs[main[i]]).toBe('priority');
    }
    for (const s of side) {
      const seg = net.getSegment(s)!;
      expect(net.getNode(seg.a)!.control.signs[s]).toBe('yield');
    }
  });

  it('leaves junctions with lights alone', () => {
    const { net, nodes, main } = avenue();
    net.setJunctionControl(nodes[2], { mode: 'signal', signal: defaultSignalPlan(net, nodes[2]) });
    const r = applyPriorityRoad(net, main[0]);
    expect(r.skipped).toContain(nodes[2]);
    expect(net.getNode(nodes[2])!.control.mode).toBe('signal');
  });

  it('green waves give each junction an offset from the travel time', () => {
    const { net, nodes } = avenue();
    for (let i = 1; i <= 4; i++) net.setJunctionControl(nodes[i], { mode: 'signal', signal: defaultSignalPlan(net, nodes[i]) });
    const r = applyGreenWave(net, nodes.slice(1, 5), 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cycle = r.cycleSec;
    for (let i = 1; i <= 4; i++) {
      const plan = net.getNode(nodes[i])!.control.signal!;
      expect(cycleOf(plan)).toBeCloseTo(cycle, 0);
      expect(plan.kind).toBe('fixed');
    }
    // 200 m apart at 50 km/h is 14.4 s: consecutive offsets differ by that, modulo the cycle.
    const off = r.steps.map((s) => s.offsetSec);
    const step = (((off[0] - off[1]) % cycle) + cycle) % cycle;
    expect(step).toBeCloseTo(14.4, 0);
  });

  it('copies a timed plan to a junction of the same shape', () => {
    const { net, nodes } = avenue();
    const plan = defaultSignalPlan(net, nodes[1], 'protectedLefts');
    plan.phases[0].greenSec = 33;
    net.setJunctionControl(nodes[1], { mode: 'signal', signal: plan });
    const clip = copySignalPlan(net, nodes[1])!;
    const r = pasteSignalPlan(net, clip, nodes[3]);
    expect(r.ok).toBe(true);
    const pasted = net.getNode(nodes[3])!.control;
    expect(pasted.mode).toBe('signal');
    expect(pasted.signal!.phases.length).toBe(plan.phases.length);
    expect(pasted.signal!.phases[0].greenSec).toBe(33);
    // Every key names a movement that exists at the new junction.
    const keys = new Set(net.laneGraph.connectorsAt.get(nodes[3])!.map((c) => {
      const l = net.laneGraph.lanes[c];
      return `${net.laneGraph.lanes[l.fromLane].segmentId}>${net.laneGraph.lanes[l.toLane].segmentId}`;
    }));
    for (const p of pasted.signal!.phases) for (const k of Object.keys(p.moves)) expect(keys.has(k)).toBe(true);
  });
});
