import { describe, expect, it } from 'vitest';
import { RoadNetwork, checkNetworkInvariants, type Id } from '../../src/core';
import { v } from './helpers';

/** A 2-way grid, curved a little so geometry is not all trivially straight. */
function buildGrid(size: number, spacing: number): { net: RoadNetwork; ids: Id[]; nodes: Id[][] } {
  const net = new RoadNetwork();
  const nodes: Id[][] = [];
  const ids: Id[] = [];
  net.batch(() => {
    for (let i = 0; i < size; i++) {
      const row: Id[] = [];
      for (let j = 0; j < size; j++) {
        row.push(net.addNode(v((j - size / 2) * spacing, (i - size / 2) * spacing)));
      }
      nodes.push(row);
    }
    const type = (i: number) => (i % 5 === 0 ? 'avenue-4' : 'street-2');
    for (let i = 0; i < size; i++) {
      for (let j = 0; j + 1 < size; j++) {
        ids.push(net.addSegment(nodes[i][j], nodes[i][j + 1], { roadType: type(i) }));
        const a = net.getNode(nodes[j][i])!.pos;
        const b = net.getNode(nodes[j + 1][i])!.pos;
        const bow = (spacing / 6) * (j % 2 === 0 ? 1 : -1);
        ids.push(
          net.addSegment(nodes[j][i], nodes[j + 1][i], {
            roadType: type(i),
            c1: v(a.x + bow, a.z + spacing / 3),
            c2: v(b.x + bow, b.z - spacing / 3),
          }),
        );
      }
    }
  });
  return { net, ids, nodes };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];

describe('performance', () => {
  it('commits one segment change on a 2000-segment network in under 16 ms', () => {
    const { net, ids, nodes } = buildGrid(32, 120);
    expect(net.segments.length).toBeGreaterThanOrEqual(1984);
    expect(checkNetworkInvariants(net)).toEqual([]);
    const timed = (fn: () => void): number => {
      const t = performance.now();
      fn();
      return performance.now() - t;
    };
    const summary = (xs: number[]) => ({
      medianMs: +median(xs).toFixed(2),
      p95Ms: +p95(xs).toFixed(2),
      maxMs: +Math.max(...xs).toFixed(2),
    });

    // Edits that keep the set of lanes, as when dragging: the patch path.
    const drag: number[] = [];
    for (let i = 0; i < 200; i++) {
      const node = nodes[3 + (i % 25)][3 + ((i * 3) % 25)];
      const p = net.getNode(node)!.pos;
      const d = i % 2 ? 1 : -1;
      drag.push(timed(() => net.moveNode(node, v(p.x + d, p.z - d))));
    }
    const reshape: number[] = [];
    for (let i = 0; i < 200; i++) {
      const seg = ids[(i * 37) % ids.length];
      const c = net.cubicOf(seg);
      const d = i % 2 ? 0.5 : -0.5;
      reshape.push(timed(() => net.setSegmentControls(seg, v(c.p1.x, c.p1.z + d), v(c.p2.x, c.p2.z + d))));
    }
    // Edits that change the set of lanes: the full assembly.
    const retype: number[] = [];
    for (let i = 0; i < 100; i++) {
      const seg = ids[(i * 53) % ids.length];
      retype.push(timed(() => net.setRoadType(seg, i % 2 ? 'street-4' : 'avenue-6')));
    }
    const draw: number[] = [];
    for (let i = 0; i < 40; i++) {
      const start = { kind: 'free', pos: v(-2000 + i * 20, -2000) } as const;
      const end = { kind: 'free', pos: v(-2000 + i * 20, -1960) } as const;
      draw.push(timed(() => net.drawRoad({ start, end, roadType: 'street-2' })));
    }
    const report = {
      segments: net.segments.length,
      lanes: net.laneGraph.lanes.length,
      dragNode: summary(drag),
      reshapeSegment: summary(reshape),
      changeRoadType: summary(retype),
      drawRoad: summary(draw),
    };
    console.log('PERF single edit', JSON.stringify(report));
    expect(checkNetworkInvariants(net)).toEqual([]);
    // Typical cost of every kind of edit, plus the spread of the ones repeated while dragging.
    expect(report.dragNode.medianMs).toBeLessThan(16);
    expect(report.reshapeSegment.medianMs).toBeLessThan(16);
    expect(report.changeRoadType.medianMs).toBeLessThan(16);
    expect(report.drawRoad.medianMs).toBeLessThan(16);
    expect(report.dragNode.p95Ms).toBeLessThan(16);
    expect(report.reshapeSegment.p95Ms).toBeLessThan(16);
  });

  it('full build of 2000 segments takes under 500 ms', () => {
    const { net } = buildGrid(32, 120);
    const text = net.serialize();
    const runs: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      const fresh = new RoadNetwork(text);
      runs.push(performance.now() - t0);
      expect(fresh.laneGraph.lanes.length).toBe(net.laneGraph.lanes.length);
    }
    const t0 = performance.now();
    net.load(text);
    const reload = performance.now() - t0;
    console.log('PERF full build', JSON.stringify({ medianMs: median(runs), maxMs: Math.max(...runs), reloadMs: reload }));
    expect(median(runs)).toBeLessThan(500);
    expect(reload).toBeLessThan(500);
  });

  it('a stamp of many roads recomputes once', () => {
    const net = new RoadNetwork();
    let events = 0;
    net.onChange(() => events++);
    const t0 = performance.now();
    net.batch(() => {
      for (let i = 0; i < 300; i++) {
        net.drawRoad({
          start: { kind: 'free', pos: v(-500, -300 + i * 2) },
          end: { kind: 'free', pos: v(500, -300 + i * 2) },
          roadType: 'ramp-1',
        });
      }
      for (let i = 0; i < 20; i++) {
        net.drawRoad({
          start: { kind: 'free', pos: v(-400 + i * 40, -400) },
          end: { kind: 'free', pos: v(-400 + i * 40, 400) },
          roadType: 'street-2',
        });
      }
    });
    const elapsed = performance.now() - t0;
    console.log('PERF stamp', JSON.stringify({ ms: elapsed, segments: net.segments.length }));
    expect(events).toBe(1);
    expect(net.segments.length).toBe(300 * 21 + 20 * 301);
  });

  it('spatial queries stay fast', () => {
    const { net } = buildGrid(32, 120);
    const t0 = performance.now();
    let found = 0;
    for (let i = 0; i < 5000; i++) {
      const hit = net.nearestSegment(v(((i * 73) % 3600) - 1800, ((i * 131) % 3600) - 1800), 300);
      if (hit) found++;
    }
    const ms = performance.now() - t0;
    console.log('PERF nearestSegment 5000x', JSON.stringify({ ms }));
    expect(found).toBeGreaterThan(0);
    expect(ms).toBeLessThan(1500);
  });
});
