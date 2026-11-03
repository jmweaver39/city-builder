import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { CAR_KINDS, TrainSim } from '../../src/rail';
import { station, v } from './helpers';

function curveLayout() {
  const net = new RoadNetwork();
  const a = net.addNode(v(-1200, 0));
  const b = net.addNode(v(-200, 0));
  const c = net.addNode(v(0, 200));
  const d = net.addNode(v(0, 1200));
  const s1 = net.addSegment(a, b, { roadType: 'rail-single' });
  net.addSegment(b, c, { c1: v(-90, 0), c2: v(0, 90), roadType: 'rail-single' });
  const s3 = net.addSegment(c, d, { roadType: 'rail-single' });
  const from = station(net, s1, 0.5, 'A', 400);
  const to = station(net, s3, 0.75, 'B', 400);
  net.addLine({ name: 'L', color: '#fff', stops: [from, to], trainType: 'freight', cars: 42, trains: 1 });
  return { net, sim: new TrainSim(net) };
}

describe('bogies', () => {
  it('both bogies of every car stay on the rails through a curve', () => {
    const { sim } = curveLayout();
    let onCurve = 0;
    for (let i = 0; i < 9000; i++) {
      sim.step();
      if (i % 10) continue;
      const view = sim.view;
      const yaws = new Set<number>();
      for (let k = 0; k < view.count; k++) {
        if (view.flags[k] & 1) continue;
        for (const b of [k * 8, k * 8 + 4]) {
          const hit = sim.graph.nearest({ x: view.bogie[b], y: view.bogie[b + 1], z: view.bogie[b + 2] }, 3);
          expect(hit, `bogie of car ${k}`).not.toBeNull();
          expect(hit!.distance).toBeLessThan(0.15);
        }
        yaws.add(Math.round(view.yaw[k] * 50));
      }
      // Snaking: cars of one train point different ways at once.
      if (yaws.size > 8) onCurve++;
    }
    expect(onCurve).toBeGreaterThan(5);
  });

  it('a car hangs in the chord between its bogies', () => {
    const { sim } = curveLayout();
    for (let i = 0; i < 3000; i++) sim.step();
    const view = sim.view;
    for (let k = 0; k < view.count; k++) {
      const spacing = CAR_KINDS[view.kind[k]].bogieSpacing;
      const b = k * 8;
      const d = Math.hypot(view.bogie[b] - view.bogie[b + 4], view.bogie[b + 2] - view.bogie[b + 6]);
      expect(d).toBeGreaterThan(spacing - 0.4);
      expect(d).toBeLessThanOrEqual(spacing + 0.01);
      expect(view.x[k]).toBeCloseTo((view.bogie[b] + view.bogie[b + 4]) / 2, 3);
    }
  });

  it('cars pitch on a grade', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(0, 0));
    const b = net.addNode(v(1000, 0));
    const c = net.addNode(v(1600, 0, 12));
    const d = net.addNode(v(2600, 0, 12));
    const s1 = net.addSegment(a, b, { roadType: 'rail-single' });
    net.addSegment(b, c, { roadType: 'rail-single' });
    const s3 = net.addSegment(c, d, { roadType: 'rail-single' });
    const from = station(net, s1, 0.5, 'A', 300);
    const to = station(net, s3, 0.7, 'B', 300);
    net.addLine({ name: 'L', color: '#fff', stops: [from, to], trainType: 'emu', cars: 8, trains: 1 });
    const sim = new TrainSim(net);
    let peak = 0;
    let mixed = false;
    for (let i = 0; i < 4000; i++) {
      sim.step();
      const view = sim.view;
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < view.count; k++) {
        lo = Math.min(lo, Math.abs(view.pitch[k]));
        hi = Math.max(hi, Math.abs(view.pitch[k]));
      }
      if (view.count) peak = Math.max(peak, hi);
      if (lo < 0.002 && hi > 0.015) mixed = true;
    }
    expect(peak).toBeCloseTo(0.02, 2);
    expect(mixed).toBe(true);
  });
});
