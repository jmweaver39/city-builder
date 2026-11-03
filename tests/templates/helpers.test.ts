/** The template checks are only worth anything if they catch bad roads. */
import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import type { StampResult } from '../../src/templates';
import { clearanceViolations, deadLanes, leftSideRamps, missingMovements, roughJoints } from './helpers';

const v = (x: number, z: number, y = 0) => ({ x, y, z });

function road(net: RoadNetwork, a: number[], b: number[], type = 'ramp-1') {
  const na = net.addNode(v(a[0], a[1], a[2] ?? 0));
  const nb = net.addNode(v(b[0], b[1], b[2] ?? 0));
  net.addSegment(na, nb, { roadType: type });
  return { na, nb };
}

describe('checks', () => {
  it('flags roads crossing without a junction or enough height', () => {
    const net = new RoadNetwork();
    road(net, [-100, 0, 0], [100, 0, 0]);
    road(net, [0, -100, 3], [0, 100, 3]);
    expect(clearanceViolations(net).length).toBeGreaterThan(0);
  });

  it('passes the same crossing with clearance', () => {
    const net = new RoadNetwork();
    road(net, [-100, 0, 0], [100, 0, 0]);
    road(net, [0, -100, 6.5], [0, 100, 6.5]);
    expect(clearanceViolations(net)).toEqual([]);
  });

  it('flags two parallel roads on top of each other', () => {
    const net = new RoadNetwork();
    road(net, [-100, 0], [100, 0]);
    road(net, [-100, 3], [100, 3]);
    expect(clearanceViolations(net).length).toBeGreaterThan(0);
  });

  it('flags a ramp pointing the wrong way', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-300, 0));
    const b = net.addNode(v(0, 0));
    const c = net.addNode(v(300, 0));
    const ramp = net.addNode(v(100, 200));
    net.addSegment(a, b, { roadType: 'highway-3' });
    net.addSegment(b, c, { roadType: 'highway-3' });
    net.addSegment(ramp, b, { roadType: 'ramp-1' }); // Should leave, but arrives.
    const result: StampResult = {
      segments: [],
      nodes: [],
      problems: [],
      ports: [
        { name: 'in', nodeId: a, flow: 'in' },
        { name: 'out', nodeId: c, flow: 'out' },
        { name: 'exit', nodeId: ramp, flow: 'out' },
      ],
    };
    expect(missingMovements(net, result, [['in', 'exit']]).length).toBeGreaterThan(0);
    expect(deadLanes(net, result).length).toBeGreaterThan(0);
  });

  it('flags a ramp on the left of a highway', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-300, 0));
    const b = net.addNode(v(0, 0));
    const c = net.addNode(v(300, 0));
    const ramp = net.addNode(v(300, -80));
    net.addSegment(a, b, { roadType: 'highway-3' });
    net.addSegment(b, c, { roadType: 'highway-3' });
    net.addSegment(b, ramp, { roadType: 'ramp-1' });
    expect(leftSideRamps(net).length).toBe(1);
  });

  it('flags a kink between two lengths of road', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(100, 0));
    const c = net.addNode(v(200, 40));
    net.addSegment(a, b, { roadType: 'ramp-1' });
    net.addSegment(b, c, { roadType: 'ramp-1' });
    expect(roughJoints(net).length).toBeGreaterThan(0);
  });
});
