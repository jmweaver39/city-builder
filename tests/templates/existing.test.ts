import { describe, expect, it } from 'vitest';
import { RoadNetwork, checkNetworkInvariants, type Id } from '../../src/core';
import { Simulation } from '../../src/sim';
import { previewTemplate, stampTemplate, type Placement } from '../../src/templates';
import { carriagewayOffset } from '../../src/templates/kit';
import { Blueprint } from '../../src/templates/blueprint';
import { clearanceViolations, deadLanes, entryLanes, exitLanes, missingMovements, reachable } from './helpers';
import { SPECS } from './specs';

const origin: Placement = { pos: { x: 0, y: 0, z: 0 }, rotation: 0, elevation: 0 };

function carriageway(net: RoadNetwork, x0: number, z0: number, x1: number, z1: number, roadType = 'highway-3'): Id[] {
  const r = net.drawRoad({ start: { kind: 'free', pos: { x: x0, y: 0, z: z0 } }, end: { kind: 'free', pos: { x: x1, y: 0, z: z1 } }, roadType });
  return r.nodes;
}

/** A highway in both directions, spaced the way interchange templates expect. */
function dividedHighway(net: RoadNetwork, half: number): { eastIn: Id; eastOut: Id; westIn: Id; westOut: Id } {
  const m = carriagewayOffset(new Blueprint(), 'highway-3');
  const east = carriageway(net, -half, m, half, m);
  const west = carriageway(net, half, -m, -half, -m);
  return { eastIn: east[0], eastOut: east[east.length - 1], westIn: west[0], westOut: west[west.length - 1] };
}

describe('dropping a template on an existing highway', () => {
  it('splices a diamond into a divided highway', () => {
    const net = new RoadNetwork();
    const ends = dividedHighway(net, 1600);
    const result = stampTemplate(net, 'diamond', {}, origin);
    expect(result.problems).toEqual([]);
    expect(checkNetworkInvariants(net)).toEqual([]);
    expect(clearanceViolations(net)).toEqual([]);
    expect(net.segments.filter((s) => !net.segmentGeom(s.id)!.valid)).toEqual([]);

    // Nothing of the old road is left running under the template.
    const dead = new Set(net.deadEnds());
    expect(dead.has(ends.eastIn)).toBe(true);
    expect(dead.size).toBe(6); // Two highway ends each way plus the cross road's two.
    const under = net.segments.filter((s) => {
      const c = net.cubicOf(s.id);
      return Math.abs(c.p0.x) < 100 && Math.abs(c.p3.x) < 100 && s.roadType === 'highway-3' && !result.segments.includes(s.id);
    });
    expect(under).toEqual([]);

    // The far ends of the old road are now the interchange's stubs.
    const graph = net.laneGraph;
    const fromEast = reachable(graph, entryLanes(net, ends.eastIn));
    expect(exitLanes(net, ends.eastOut).some((l) => fromEast.has(l))).toBe(true);
    for (const name of ['N', 'S']) {
      const port = result.ports.find((p) => p.name === name)!;
      expect(exitLanes(net, port.nodeId).some((l) => fromEast.has(l))).toBe(true);
      const on = reachable(graph, entryLanes(net, port.nodeId));
      expect(exitLanes(net, ends.westOut).some((l) => on.has(l))).toBe(true);
    }
  });

  it('keeps the direction of travel across the joins', () => {
    const net = new RoadNetwork();
    const ends = dividedHighway(net, 1600);
    stampTemplate(net, 'cloverleaf', {}, origin);
    const graph = net.laneGraph;
    // Walk the eastbound road and check nothing heads west.
    for (const lane of graph.lanes) {
      if (lane.kind !== 'road') continue;
      const seg = net.getSegment(lane.segmentId)!;
      if (!seg.roadType.startsWith('highway')) continue;
      const c = net.cubicOf(seg.id);
      if (Math.abs(c.p0.z - c.p3.z) > 1) continue; // Cross highway.
      const dx = lane.pts[lane.pts.length - 3] - lane.pts[0];
      const onEast = c.p0.z > 0;
      expect(Math.sign(dx)).toBe(onEast ? 1 : -1);
    }
    expect(net.getNode(ends.eastIn)).toBeDefined();
  });

  it('lands on a road that is turned and off the origin', () => {
    const net = new RoadNetwork();
    const theta = Math.PI / 6;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const px = 150;
    const pz = -90;
    const line = carriageway(net, px - 1500 * c, pz - 1500 * s, px + 1500 * c, pz + 1500 * s);
    const result = stampTemplate(net, 'on-off-ramps', {}, { ...origin, pos: { x: px, y: 0, z: pz }, rotation: theta });
    expect(result.problems).toEqual([]);
    expect(checkNetworkInvariants(net)).toEqual([]);
    expect(deadEndsOf(net).length).toBe(4);
    const on = reachable(net.laneGraph, entryLanes(net, line[0]));
    expect(exitLanes(net, line[line.length - 1]).some((l) => on.has(l))).toBe(true);
    const off = result.ports.find((p) => p.name === 'off')!;
    expect(exitLanes(net, off.nodeId).some((l) => on.has(l))).toBe(true);
  });

  it('joins a stub to a dead end waiting for it', () => {
    const net = new RoadNetwork();
    const start = previewTemplate('on-off-ramps', {}, origin)[0].p0.x;
    const before = carriageway(net, -1800, 0, start, 0);
    const result = stampTemplate(net, 'on-off-ramps', {}, origin);
    expect(result.problems).toEqual([]);
    expect(result.ports.find((p) => p.name === 'W.in')!.nodeId).toBe(before[before.length - 1]);
    expect(missingMovements(net, result, SPECS['on-off-ramps'].moves)).toEqual([]);
    const on = reachable(net.laneGraph, entryLanes(net, before[0]));
    const out = result.ports.find((p) => p.name === 'E.out')!;
    expect(exitLanes(net, out.nodeId).some((l) => on.has(l))).toBe(true);
  });

  it('will not join a one-way road running the wrong way', () => {
    const net = new RoadNetwork();
    const start = previewTemplate('on-off-ramps', {}, origin)[0].p0.x;
    const wrong = carriageway(net, start, 0, -1500, 0);
    const before = net.segments.length;
    const result = stampTemplate(net, 'on-off-ramps', {}, origin);
    expect(result.problems.join(' ')).toMatch(/wrong way/);
    expect(result.ports.find((p) => p.name === 'W.in')!.nodeId).not.toBe(wrong[0]);
    expect(net.segments.length).toBeGreaterThan(before);
    expect(checkNetworkInvariants(net)).toEqual([]);
  });

  it('adds a junction where a template crosses another road at grade', () => {
    const net = new RoadNetwork();
    carriageway(net, 0, -400, 0, 400, 'street-2');
    const result = stampTemplate(net, 'lane-add-drop', {}, origin);
    expect(result.problems.join(' ')).toMatch(/at grade/);
    expect(checkNetworkInvariants(net)).toEqual([]);
    expect(net.nodes.some((n) => n.segments.length === 4)).toBe(true);
  });

  it('warns when dropped on a road it cannot join', () => {
    const net = new RoadNetwork();
    net.drawRoad({
      start: { kind: 'free', pos: { x: -300, y: 3, z: 0 } },
      end: { kind: 'free', pos: { x: 300, y: 3, z: 0 } },
      roadType: 'street-2',
    });
    const result = stampTemplate(net, 'lane-add-drop', { addedLength: 200, stubLength: 150 }, origin);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it('runs traffic across the joins', () => {
    const net = new RoadNetwork();
    dividedHighway(net, 1600);
    const result = stampTemplate(net, 'parclo', {}, origin);
    expect(result.problems).toEqual([]);
    net.setTraffic({ multiplier: 0.7 });
    const sim = new Simulation(net, 11);
    for (let i = 0; i < 6000; i++) sim.step();
    expect(sim.stats().arrivedTotal).toBeGreaterThan(200);
    expect(sim.stats().despawnedStuck).toBeLessThan(5);
    expect(deadLanes(net, { ...result, ports: autoPorts(net) })).toEqual([]);
  });
});

function deadEndsOf(net: RoadNetwork): Id[] {
  return net.deadEnds();
}

function autoPorts(net: RoadNetwork) {
  return net.deadEnds().map((nodeId) => ({ name: String(nodeId), nodeId, flow: 'both' as const }));
}
