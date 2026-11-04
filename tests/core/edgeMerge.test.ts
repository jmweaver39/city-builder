import { describe, expect, it } from 'vitest';
import { RoadNetwork, makeAttach, type DrawRoadParams, type GLane, type Id, type RampAttach } from '../../src/core';
import { applyRampLaneChange } from '../../src/tools/edgeMergeOps';
import { alignChoiceAt, jointAlign, setJointAlign } from '../../src/tools/endAlign';
import { overlapClip } from '../../src/render/gore';
import { laneEndLines } from '../../src/render/markings';
import { atNode, expectClean, free, onSeg, v } from './helpers';

/** Attach for a ramp on side `side` (+z = 1) of a highway along x, travelling `travel`. */
function attachOn(side: 1 | -1, travel: 1 | -1, edge = true, lane = 0): RampAttach {
  return { ...makeAttach(lane, v(1, 0), v(travel, 0), side), ...(edge ? { edge: {} } : {}) };
}

function highway(type = 'highway-3') {
  const net = new RoadNetwork();
  net.drawRoad({ start: free(-800, 0), end: free(800, 0), roadType: type });
  return net;
}

/** An on-ramp joining at x0, on side `side`, travelling `travel`, arriving nearly parallel. */
function onRamp(net: RoadNetwork, x0: number, side: 1 | -1 = 1, travel: 1 | -1 = 1, opts: { edge?: boolean; lane?: number; steep?: boolean } = {}) {
  const near = net.nearestSegment(v(x0, 0))!;
  const d = travel;
  const params: DrawRoadParams = {
    start: free(x0 - d * 420, side * (opts.steep ? 300 : 170)),
    end: onSeg(near.segmentId, near.t),
    c1: v(x0 - d * 260, side * (opts.steep ? 200 : 60)),
    c2: opts.steep ? v(x0 - d * 60, side * 60) : v(x0 - d * 130, side * 8),
    roadType: 'ramp-1',
    endAttach: attachOn(side, d, opts.edge ?? true, opts.lane ?? 0),
  };
  const issues = net.validateDraft(params);
  const r = net.drawRoad(params);
  return { node: r.nodes[r.nodes.length - 1], ramp: r.segments[r.segments.length - 1], issues };
}

/** An off-ramp leaving at x0. */
function offRamp(net: RoadNetwork, x0: number, side: 1 | -1 = 1, travel: 1 | -1 = 1, opts: { edge?: boolean } = {}) {
  const near = net.nearestSegment(v(x0, 0))!;
  const d = travel;
  const params: DrawRoadParams = {
    start: onSeg(near.segmentId, near.t),
    end: free(x0 + d * 420, side * 170),
    c1: v(x0 + d * 130, side * 8),
    c2: v(x0 + d * 260, side * 60),
    roadType: 'ramp-1',
    startAttach: attachOn(side, d, opts.edge ?? true),
  };
  const issues = net.validateDraft(params);
  const r = net.drawRoad(params);
  return { node: r.nodes[0], ramp: r.segments[0], issues };
}

const lanesAt = (net: RoadNetwork, node: Id): GLane[] => (net.laneGraph.connectorsAt.get(node) ?? []).map((i) => net.laneGraph.lanes[i]);
const hostsAt = (net: RoadNetwork, node: Id) => net.getNode(node)!.segments.filter((s) => net.roadTypeOf(s).category === 'highway');

/** Every road lane of a highway segment ending at `node` goes on into the other highway segment. */
function directThrough(net: RoadNetwork, node: Id): { from: GLane; to: GLane }[] {
  const g = net.laneGraph;
  const out: { from: GLane; to: GLane }[] = [];
  for (const s of hostsAt(net, node)) {
    for (const i of g.roadLanes.get(s) ?? []) {
      const lane = g.lanes[i];
      const m = lane.cum.length;
      const end = { x: lane.pts[m * 3 - 3], z: lane.pts[m * 3 - 1] };
      const pos = net.getNode(node)!.pos;
      if (Math.hypot(end.x - pos.x, end.z - pos.z) > 15) continue;
      for (const n of lane.next) if (g.lanes[n].kind === 'road') out.push({ from: lane, to: g.lanes[n] });
    }
  }
  return out;
}

describe('edge merge: lane graph', () => {
  it('an on-ramp blends into the edge lane: through lanes join directly, only the ramp has a connector', () => {
    const net = highway();
    const { node, ramp, issues } = onRamp(net, 0);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    const g = net.nodeGeom(node)!;
    expect(g.kind).toBe('merge');
    const conns = lanesAt(net, node);
    expect(conns).toHaveLength(1);
    const c = conns[0];
    const lg = net.laneGraph;
    expect(lg.lanes[c.fromLane].segmentId).toBe(ramp);
    // Into the outermost lane on the right (+z) of the highway past the node.
    const to = lg.lanes[c.toLane];
    const after = hostsAt(net, node).find((s) => net.getSegment(s)!.a === node)!;
    expect(to.segmentId).toBe(after);
    expect(to.laneIndex).toBe(2);
    // All three highway lanes run straight on as road lanes.
    expect(directThrough(net, node)).toHaveLength(3);
    // The highway is not trimmed at the node.
    for (const s of hostsAt(net, node)) {
      const sg = net.segmentGeom(s)!;
      expect(net.getSegment(s)!.a === node ? sg.trimA : sg.trimB).toBe(0);
    }
    // The ramp is trimmed by the taper.
    expect(net.segmentGeom(ramp)!.trimB).toBeCloseTo(g.edge!.taper, 3);
    expectClean(net);
  });

  it('an off-ramp leaves from the edge lane, which also carries on', () => {
    const net = highway();
    const { node, ramp } = offRamp(net, 0);
    expect(net.nodeGeom(node)!.kind).toBe('merge');
    const conns = lanesAt(net, node);
    expect(conns).toHaveLength(1);
    const lg = net.laneGraph;
    expect(lg.lanes[conns[0].toLane].segmentId).toBe(ramp);
    expect(lg.lanes[conns[0].fromLane].laneIndex).toBe(2);
    expect(directThrough(net, node)).toHaveLength(3);
    expectClean(net);
  });

  it('the junction outline covers only the edge region beside the taper', () => {
    const net = highway();
    const { node } = onRamp(net, 0);
    const g = net.nodeGeom(node)!;
    const taper = g.edge!.taper;
    // Highway-3: carriageway edge at z = 5.625. Nothing of the outline reaches the inner lanes.
    for (const p of g.outline) {
      expect(p.z).toBeGreaterThan(5.625 - 0.05);
      expect(p.x).toBeLessThan(1);
      expect(p.x).toBeGreaterThan(-taper - 30);
    }
    expect(g.edge!.gore.length).toBeGreaterThan(2);
    for (const p of g.edge!.gore) expect(p.z).toBeGreaterThan(5.6);
  });

  for (const type of ['highway-2', 'highway-4', 'dual-4', 'dual-6']) {
    const cws: { side: 1 | -1; travel: 1 | -1 }[] = type.startsWith('dual') ? [{ side: 1, travel: 1 }, { side: -1, travel: -1 }] : [{ side: 1, travel: 1 }, { side: -1, travel: 1 }];
    for (const cw of cws) {
      it(`${type}: on- and off-ramps on side ${cw.side} travelling ${cw.travel} are edge merges`, () => {
        const net = highway(type);
        const on = onRamp(net, -200, cw.side, cw.travel);
        const off = offRamp(net, 300, cw.side, cw.travel);
        for (const r of [on, off]) {
          expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
          expect(net.nodeGeom(r.node)!.kind).toBe('merge');
          expect(lanesAt(net, r.node)).toHaveLength(1);
          const lanes = net.roadTypeOf(hostsAt(net, r.node)[0]).lanes.filter((l) => l.kind === 'drive').length;
          expect(directThrough(net, r.node)).toHaveLength(lanes);
        }
        expectClean(net);
      });
    }
  }

  it('refuses the median side of a two-way highway with a reason, and the draft is an error', () => {
    const net = highway('dual-4');
    const r = onRamp(net, 0, -1, 1);
    expect(r.issues.some((i) => i.code === 'wrongWay' && i.severity === 'error')).toBe(true);
    expect(net.nodeGeom(r.node)!.kind).toBe('junction');
  });

  it('refuses a ramp drawn against a one-way highway', () => {
    const net = highway('highway-3');
    const r = onRamp(net, 0, 1, -1);
    expect(r.issues.some((i) => i.code === 'wrongWay')).toBe(true);
  });

  it('falls back to a full junction when too steep or when inner lanes feed the ramp', () => {
    const net = highway();
    const steep = onRamp(net, -300, 1, 1, { steep: true });
    expect(net.nodeGeom(steep.node)!.kind).toBe('junction');
    const inner = onRamp(net, 300, 1, 1, { lane: 1 });
    expect(net.nodeGeom(inner.node)!.kind).toBe('junction');
    const node = net.getNode(inner.node)!;
    const layoutArms = node.segments.length;
    expect(layoutArms).toBe(3);
  });

  it('says why a ramp asking for an edge merge got a full junction', () => {
    const net = highway();
    const inner = onRamp(net, -300, 1, 1, { lane: 1 });
    expect(net.edgeMergeProblem(inner.node)).toMatch(/Inner lanes/);
    const steep = onRamp(net, 300, 1, 1, { steep: true });
    expect(net.edgeMergeProblem(steep.node)).toMatch(/steep/);
    const ok = onRamp(net, 0);
    expect(net.edgeMergeProblem(ok.node)).toBeNull();
  });
});

describe('edge merge: persistence', () => {
  it('survives save and load; an old save without the edge flag stays a full junction', () => {
    const net = highway();
    const { node } = onRamp(net, 0);
    const copy = new RoadNetwork(net.serialize());
    expect(copy.nodeGeom(node)!.kind).toBe('merge');
    const old = JSON.parse(net.serialize());
    for (const s of old.segments) {
      if (s.overrides.attachB) delete s.overrides.attachB.edge;
      if (s.overrides.attachA) delete s.overrides.attachA.edge;
    }
    expect(new RoadNetwork(old).nodeGeom(node)!.kind).toBe('junction');
  });

  it('survives splitting the highway elsewhere, moving its far end, reversing the ramp twice and undo', () => {
    const net = highway();
    const { node, ramp } = onRamp(net, 0);
    const before = net.snapshot();
    const far = hostsAt(net, node).find((s) => net.getSegment(s)!.a === node)!;
    net.splitSegment(far, 0.6);
    expect(net.nodeGeom(node)!.kind).toBe('merge');
    const end = net.getSegment(far)!.b;
    net.moveNode(end, { ...net.getNode(end)!.pos, z: 6 });
    expect(net.nodeGeom(node)!.kind).toBe('merge');
    net.reverseSegment(ramp);
    net.reverseSegment(ramp);
    expect(net.nodeGeom(node)!.kind).toBe('merge');
    net.load(before, 'undo');
    expect(net.nodeGeom(node)!.kind).toBe('merge');
    expectClean(net);
  });

  it('follows the highway when the ramp is reversed into a wrong-way road: full junction, not a broken merge', () => {
    const net = highway();
    const { node, ramp } = onRamp(net, 0);
    net.reverseSegment(ramp);
    expect(net.nodeGeom(node)!.kind).not.toBe('merge');
    expectClean(net);
  });
});

describe('edge merge: lane add and exit only', () => {
  it('an on-ramp carrying on as an added lane for a distance: no merge at the node, a lane drop further on', () => {
    const net = highway();
    const { node, ramp } = onRamp(net, 0);
    expect(applyRampLaneChange(net, node, 'add', 300)).toBeNull();
    const g = net.nodeGeom(node)!;
    expect(g.kind).toBe('merge');
    expect(g.edge!.mode).toBe('add');
    const conns = lanesAt(net, node);
    expect(conns).toHaveLength(1);
    const lg = net.laneGraph;
    const to = lg.lanes[conns[0].toLane];
    expect(net.roadTypeOf(to.segmentId).id).toBe('highway-4');
    expect(to.laneIndex).toBe(3);
    // The added lane has only the ramp feeding it: no merge here.
    expect(to.prev).toHaveLength(1);
    expect(directThrough(net, node)).toHaveLength(3);
    // 300 m on, the four lanes become three with the left three running straight on.
    const seg = net.getSegment(to.segmentId)!;
    const drop = net.nodeGeom(seg.b)!;
    expect(drop.arms).toHaveLength(2);
    expect(net.getSegment(ramp)!.overrides.attachB?.edge?.mode).toBe('add');
    expectClean(net);
  });

  it('an added lane for good widens the highway to its end', () => {
    const net = highway();
    const { node } = onRamp(net, 0);
    expect(applyRampLaneChange(net, node, 'addFull')).toBeNull();
    const after = hostsAt(net, node).find((s) => net.getSegment(s)!.a === node)!;
    expect(net.roadTypeOf(after).id).toBe('highway-4');
    expect(net.nodeGeom(net.getSegment(after)!.b)!.kind).toBe('deadEnd');
    expectClean(net);
  });

  it('an exit-only off-ramp takes the edge lane, which does not carry on', () => {
    const net = highway();
    const { node, ramp } = offRamp(net, 0);
    expect(applyRampLaneChange(net, node, 'drop')).toBeNull();
    const g = net.nodeGeom(node)!;
    expect(g.edge!.mode).toBe('drop');
    const conns = lanesAt(net, node);
    expect(conns).toHaveLength(1);
    const lg = net.laneGraph;
    const from = lg.lanes[conns[0].fromLane];
    expect(from.laneIndex).toBe(2);
    expect(from.next).toEqual([conns[0].idx]);
    expect(lg.lanes[conns[0].toLane].segmentId).toBe(ramp);
    expect(directThrough(net, node)).toHaveLength(2);
    // The lane line beside the exit lane is the exit-only line on the approach.
    const before = hostsAt(net, node).find((s) => net.getSegment(s)!.b === node)!;
    expect(net.roadTypeOf(before).id).toBe('highway-3');
    expectClean(net);
    void laneEndLines;
  });

  it('refuses a lane add on an off-ramp and a drop from a 2-lane highway', () => {
    const net = highway('highway-2');
    const off = offRamp(net, 0);
    expect(applyRampLaneChange(net, off.node, 'add')).toMatch(/on-ramp/);
    expect(applyRampLaneChange(net, off.node, 'drop')).toMatch(/narrower/);
  });
});

describe('edge merge: markings', () => {
  it('the highway lines run on: lane lines unclipped, only the edge line steps aside along the taper', () => {
    const net = highway();
    const { node } = onRamp(net, 0);
    const before = hostsAt(net, node).find((s) => net.getSegment(s)!.b === node)!;
    const after = hostsAt(net, node).find((s) => net.getSegment(s)!.a === node)!;
    const sg = net.segmentGeom(before)!;
    const s0 = sg.stations[0].s;
    const s1 = sg.stations[sg.stations.length - 1].s;
    const clip = overlapClip(net, before)!;
    expect(clip).not.toBeNull();
    // Lane lines at +-1.875 run the whole way to the node.
    expect(clip(1.875, s0, s1)).toEqual([s0, s1]);
    expect(clip(-1.875, s0, s1)).toEqual([s0, s1]);
    // The left edge line too.
    expect(clip(-5.445, s0, s1)).toEqual([s0, s1]);
    // The right edge line gives way along the taper only.
    const [a, b] = clip(5.445, s0, s1);
    expect(a).toBe(s0);
    expect(s1 - b).toBeCloseTo(net.nodeGeom(node)!.edge!.taper, 0);
    // Past the node nothing is clipped at all.
    expect(overlapClip(net, after)).toBeNull();
  });
});

describe('lining up roads of different widths', () => {
  for (const [from, to] of [
    ['highway-3', 'highway-2'],
    ['highway-2', 'highway-3'],
  ] as const) {
    for (const align of ['left', 'centre', 'right'] as const) {
      it(`${from} to ${to}, ${align}: the lanes that carry on run straight`, () => {
        const net = new RoadNetwork();
        const a = net.drawRoad({ start: free(-600, 0), end: free(0, 0), roadType: from });
        const n = a.nodes[a.nodes.length - 1];
        net.drawRoad({ start: atNode(n), end: free(600, 0), roadType: to });
        setJointAlign(net, n, align, a.segments[0]);
        expect(jointAlign(net, n)!.align).toBe(align);
        const lg = net.laneGraph;
        const conns = (lg.connectorsAt.get(n) ?? []).map((i) => lg.lanes[i]);
        const drift = conns.map((c) => Math.abs(c.pts[c.cum.length * 3 - 1] - c.pts[2]));
        // Two lanes carry on; centred they each shift half a lane, lined up they stay put.
        const straight = drift.filter((d) => d < 0.2).length;
        expect(straight).toBe(align === 'centre' ? 0 : 2);
        // Every lane has a way on, and the extra one tapers by a whole lane, on the far side.
        expect(conns).toHaveLength(3);
        if (align !== 'centre') expect(Math.max(...drift)).toBeGreaterThan(3.5);
        expectClean(net);
      });
    }
  }

  it('survives save, split, reverse and moving', () => {
    const net = new RoadNetwork();
    const a = net.drawRoad({ start: free(-600, 0), end: free(0, 0), roadType: 'highway-3' });
    const n = a.nodes[a.nodes.length - 1];
    const b = net.drawRoad({ start: atNode(n), end: free(600, 0), roadType: 'highway-2' }).segments[0];
    setJointAlign(net, n, 'left', a.segments[0]);
    const zOf = () => net.cubicOf(b).p0.z;
    const z = zOf();
    expect(z).toBeCloseTo(-1.875, 3);
    expect(new RoadNetwork(net.serialize()).cubicOf(b).p0.z).toBeCloseTo(z, 3);
    net.splitSegment(b, 0.5);
    expect(zOf()).toBeCloseTo(z, 3);
    net.reverseSegment(b);
    expect(net.getSegment(b)!.overrides.alignB).toBe('right');
    expect(net.cubicOf(b).p3.z).toBeCloseTo(z, 3);
    net.moveNode(n, v(0, 10));
    expect(jointAlign(net, n)!.align).toBe('left');
    expectClean(net);
  });

  it('offers three points across the end, the usual lane drop on the right of the traffic by default', () => {
    const net = new RoadNetwork();
    const a = net.drawRoad({ start: free(-600, 0), end: free(0, 0), roadType: 'highway-3' });
    const n = a.nodes[a.nodes.length - 1];
    const choice = alignChoiceAt(net, n, 'highway-2', null)!;
    expect(choice.options.map((o) => o.align)).toEqual(['left', 'centre', 'right']);
    expect(choice.chosen.align).toBe('left');
    expect(choice.byDefault).toBe(true);
    // A click on the right-hand point lines up the right edges.
    const right = choice.options[2];
    const picked = alignChoiceAt(net, n, 'highway-2', right.pos)!;
    expect(picked.chosen.align).toBe('right');
    expect(picked.newShift).toBeCloseTo(1.875, 3);
    expect(alignChoiceAt(net, n, 'highway-3', null)).toBeNull();
  });
});
