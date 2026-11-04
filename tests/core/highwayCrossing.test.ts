import { describe, expect, it } from 'vitest';
import { RoadNetwork, crossingPair, effectiveControl, type GLane, type Id } from '../../src/core';
import { expectClean, free, lanesWithoutExit } from './helpers';

function connectorsAt(net: RoadNetwork, node: Id): GLane[] {
  const g = net.laneGraph;
  return (g.connectorsAt.get(node) ?? []).map((i) => g.lanes[i]);
}
const fromSeg = (net: RoadNetwork, c: GLane) => net.laneGraph.lanes[c.fromLane].segmentId;
const toSeg = (net: RoadNetwork, c: GLane) => net.laneGraph.lanes[c.toLane].segmentId;

/** A highway along x, drawn +x, and a street drawn straight across it along z. */
function crossing(highway: string, street = 'street-2') {
  const net = new RoadNetwork();
  net.drawRoad({ start: free(-600, 0), end: free(600, 0), roadType: highway });
  const r = net.drawRoad({ start: free(0, -300), end: free(0, 300), roadType: street });
  return { net, r };
}

/** Segments at a node by road category. */
function armsAt(net: RoadNetwork, node: Id) {
  const segs = net.getNode(node)!.segments;
  return {
    highway: segs.filter((s) => net.roadTypeOf(s).category === 'highway'),
    side: segs.filter((s) => net.roadTypeOf(s).category !== 'highway'),
  };
}

/** Moves straight across from one side road arm to the other. */
function straightAcross(net: RoadNetwork, node: Id): string[] {
  const { side } = armsAt(net, node);
  return connectorsAt(net, node)
    .filter((c) => side.includes(fromSeg(net, c)) && side.includes(toSeg(net, c)) && fromSeg(net, c) !== toSeg(net, c))
    .map((c) => `${fromSeg(net, c)}>${toSeg(net, c)}`);
}

function onlyProtected(net: RoadNetwork, node: Id): void {
  const eff = effectiveControl(net, node);
  expect(eff.kind).toBe('signal');
  for (const ph of eff.signal!.phases) for (const st of Object.values(ph.moves)) expect(st).toBe('protected');
}

describe('a street crossing a highway at grade', () => {
  for (const type of ['highway-3', 'dual-4']) {
    it(`${type}: goes straight across both ways, turns, and gets protected signals`, () => {
      const { net, r } = crossing(type);
      expect(r.junctions).toHaveLength(1);
      const node = r.junctions[0];
      expect(net.getNode(node)!.control.highwayAccess).toBe('crossing');
      const { highway, side } = armsAt(net, node);
      const across = new Set(straightAcross(net, node));
      expect(across).toEqual(new Set([`${side[0]}>${side[1]}`, `${side[1]}>${side[0]}`]));
      // The highway keeps every lane going straight on.
      const lanes = net.roadTypeOf(highway[0]).lanes.length;
      const hwThrough = connectorsAt(net, node).filter((c) => highway.includes(fromSeg(net, c)) && highway.includes(toSeg(net, c)));
      expect(hwThrough).toHaveLength(lanes);
      // Turns off and onto the highway.
      const conns = connectorsAt(net, node);
      expect(conns.some((c) => highway.includes(fromSeg(net, c)) && side.includes(toSeg(net, c)))).toBe(true);
      expect(conns.some((c) => side.includes(fromSeg(net, c)) && highway.includes(toSeg(net, c)))).toBe(true);
      onlyProtected(net, node);
      expect(lanesWithoutExit(net.laneGraph).filter((l) => l.kind !== 'road' || !net.getSegment(l.segmentId))).toEqual([]);
      expectClean(net);
    });
  }

  it('warns, not blocks, with clear wording', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-600, 0), end: free(600, 0), roadType: 'highway-3' });
    const issues = net.validateDraft({ start: free(0, -300), end: free(0, 300), roadType: 'street-2' });
    const w = issues.find((i) => i.code === 'atGradeHighway');
    expect(w?.severity).toBe('warning');
    expect(w?.message).toMatch(/traffic lights/i);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('a highway drawn across a street at grade makes a crossing too', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(0, -300), end: free(0, 300), roadType: 'avenue-4' });
    const r = net.drawRoad({ start: free(-600, 0), end: free(600, 0), roadType: 'highway-3' });
    expect(r.junctions).toHaveLength(1);
    expect(net.getNode(r.junctions[0])!.control.highwayAccess).toBe('crossing');
    expect(straightAcross(net, r.junctions[0])).toHaveLength(4);
  });

  it('a street ending on a highway stays right in, right out', () => {
    const net = new RoadNetwork();
    const hw = net.drawRoad({ start: free(-600, 0), end: free(600, 0), roadType: 'highway-3' }).segments[0];
    const r = net.drawRoad({ start: { kind: 'segment', id: hw, t: 0.5 }, end: free(0, 300), roadType: 'street-2' });
    expect(net.getNode(r.nodes[0])!.control.highwayAccess).toBeUndefined();
    expect(effectiveControl(net, r.nodes[0]).kind).toBe('none');
  });
});

describe('right in, right out only', () => {
  for (const type of ['highway-3', 'dual-4']) {
    it(`${type}: the junction option restores controlled access`, () => {
      const { net, r } = crossing(type);
      const node = r.junctions[0];
      net.setJunctionControl(node, { highwayAccess: 'rightInOut' });
      expect(straightAcross(net, node)).toEqual([]);
      expect(effectiveControl(net, node).kind).toBe('none');
      // On a dual carriageway nothing turns across the median.
      const { highway } = armsAt(net, node);
      for (const c of connectorsAt(net, node)) {
        const hw = highway.includes(fromSeg(net, c)) || highway.includes(toSeg(net, c));
        if (hw && type.startsWith('dual')) expect(['left', 'uturn']).not.toContain(c.turn);
      }
      // And back again.
      net.setJunctionControl(node, { highwayAccess: 'crossing' });
      expect(straightAcross(net, node)).toHaveLength(2);
    });
  }

  it('old saves without the field keep right in, right out; the field survives a save', () => {
    const { net, r } = crossing('highway-3');
    const node = r.junctions[0];
    const saved = JSON.parse(net.serialize());
    expect(new RoadNetwork(JSON.stringify(saved)).getNode(node)!.control.highwayAccess).toBe('crossing');
    for (const n of saved.nodes) delete n.control?.highwayAccess;
    const old = new RoadNetwork(JSON.stringify(saved));
    expect(old.getNode(node)!.control.highwayAccess).toBeUndefined();
    expect(straightAcross(old, node)).toEqual([]);
    expect(effectiveControl(old, node).kind).toBe('none');
    // Drawing elsewhere leaves the old junction alone.
    old.drawRoad({ start: free(300, -300), end: free(300, 300), roadType: 'street-2' });
    expect(old.getNode(node)!.control.highwayAccess).toBeUndefined();
    expect(straightAcross(old, node)).toEqual([]);
  });
});

describe('one stroke across wide roads', () => {
  it('across a boulevard: one junction, the street carries on and can turn', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-600, 0), end: free(600, 0), roadType: 'boulevard-8' });
    const params = { start: free(0, -300), end: free(0, 300), roadType: 'street-2' };
    expect(net.validateDraft(params).filter((i) => i.severity === 'error')).toEqual([]);
    const r = net.drawRoad(params);
    expect(r.junctions).toHaveLength(1);
    expect(r.segments).toHaveLength(2);
    const [s1, s2] = r.segments;
    const across = connectorsAt(net, r.junctions[0]).filter((c) => [s1, s2].includes(fromSeg(net, c)) && [s1, s2].includes(toSeg(net, c)) && fromSeg(net, c) !== toSeg(net, c));
    expect(new Set(across.map((c) => `${fromSeg(net, c)}>${toSeg(net, c)}`))).toEqual(new Set([`${s1}>${s2}`, `${s2}>${s1}`]));
    expect(effectiveControl(net, r.junctions[0]).kind).not.toBe('none');
  });

  it('across a divided highway of two one-way roads: two linked crossings', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-600, 15), end: free(600, 15), roadType: 'highway-3' });
    net.drawRoad({ start: free(600, -15), end: free(-600, -15), roadType: 'highway-3' });
    const params = { start: free(0, -300), end: free(0, 300), roadType: 'street-2' };
    expect(net.validateDraft(params).filter((i) => i.severity === 'error')).toEqual([]);
    const r = net.drawRoad(params);
    expect(r.junctions).toHaveLength(2);
    expect(r.segments).toHaveLength(3);
    const [a, b] = r.junctions;
    for (const n of [a, b]) {
      expect(net.getNode(n)!.control.highwayAccess).toBe('crossing');
      expect(straightAcross(net, n)).toHaveLength(2);
      onlyProtected(net, n);
    }
    // The short street between them is the link of a linked pair.
    const pair = crossingPair(net, a)!;
    expect(pair).not.toBeNull();
    expect(crossingPair(net, b)).toEqual(pair);
    expect(net.getSegment(pair.link)!.roadType).toBe('street-2');
    const pa = effectiveControl(net, a).signal!;
    const pb = effectiveControl(net, b).signal!;
    const cycle = (p: typeof pa) => p.phases.reduce((t, ph) => t + ph.greenSec + ph.yellowSec + ph.allRedSec, 0);
    expect(pa.phases.length).toBe(pb.phases.length);
    expect(cycle(pa)).toBe(cycle(pb));
    // Whenever traffic may enter the median at one end, it may leave at the other.
    const intoLink = (n: Id, ph: (typeof pa.phases)[number]) => Object.keys(ph.moves).some((k) => k.endsWith(`>${pair.link}`) && net.getNode(n)!.segments.includes(Number(k.split('>')[0])));
    const outOfLink = (ph: (typeof pa.phases)[number]) => Object.keys(ph.moves).some((k) => k.startsWith(`${pair.link}>`));
    pa.phases.forEach((ph, i) => {
      if (intoLink(a, ph)) expect(outOfLink(pb.phases[i]), `phase ${i}`).toBe(true);
      if (intoLink(b, pb.phases[i])) expect(outOfLink(ph), `phase ${i}`).toBe(true);
    });
    expectClean(net);
  });

  it('a bridge over a highway with clearance stays a bridge', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-600, 0), end: free(600, 0), roadType: 'highway-3' });
    const r = net.drawRoad({ start: free(0, -300, 8), end: free(0, 300, 8), roadType: 'street-2' });
    expect(r.junctions).toEqual([]);
    expect(r.segments).toHaveLength(1);
  });
});
