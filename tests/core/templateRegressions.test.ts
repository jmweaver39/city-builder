import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { mulberry32 } from './helpers';

describe('self crossing check', () => {
  it('never reports a straight road as crossing itself', () => {
    const net = new RoadNetwork();
    const random = mulberry32(5);
    for (let i = 0; i < 3000; i++) {
      const h = random() * Math.PI * 2;
      const x = random() * 1000 - 500;
      const z = random() * 1000 - 500;
      const len = 50 + random() * 300;
      const issues = net.validateDraft({
        start: { kind: 'free', pos: { x, y: 0, z } },
        end: { kind: 'free', pos: { x: x + Math.cos(h) * len, y: 0, z: z + Math.sin(h) * len } },
        roadType: 'highway-3',
      });
      expect(issues.filter((d) => d.code === 'selfCrossing')).toEqual([]);
    }
  });
});

describe('road width changes', () => {
  it('lets highway traffic through a lane add at speed', () => {
    const net = new RoadNetwork();
    const a = net.addNode({ x: 0, y: 0, z: 0 });
    const b = net.addNode({ x: 400, y: 0, z: 0 });
    const c = net.addNode({ x: 800, y: 0, z: 0 });
    net.addSegment(a, b, { roadType: 'highway-3' });
    net.addSegment(b, c, { roadType: 'highway-4' });
    const graph = net.laneGraph;
    const connectors = (graph.connectorsAt.get(b) ?? []).map((i) => graph.lanes[i]);
    expect(connectors.length).toBeGreaterThan(0);
    // 110 km/h. The taper used to be 5 m, which forced every lane down to 20 km/h.
    for (const c of connectors) expect(c.speed).toBeGreaterThan(100 / 3.6);
  });

  it('keeps a short taper between slow roads of similar width', () => {
    const net = new RoadNetwork();
    const a = net.addNode({ x: 0, y: 0, z: 0 });
    const b = net.addNode({ x: 200, y: 0, z: 0 });
    const c = net.addNode({ x: 400, y: 0, z: 0 });
    net.addSegment(a, b, { roadType: 'street-2' });
    const out = net.addSegment(b, c, { roadType: 'street-2-bike' });
    expect(net.segmentGeom(out)!.trimA).toBeLessThan(15);
  });
});
