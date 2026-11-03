/**
 * Lines between any two arms of a junction must always be allowed: with the Paint
 * tool (road-following paint) and with the junction marking tool, on 3-, 4- and
 * 5-way junctions and on an uneven road, with smooth curves.
 */
import { describe, expect, it } from 'vitest';
import { makeCustomRoadType, markingPath, nodeAnchors, resolveDecal, RoadNetwork, type CustomLane, type Id, type Vec3 } from '../../src/core';
import { rig, type Rig } from './helpers';

const free = (x: number, z: number) => ({ kind: 'free' as const, pos: { x, y: 0, z } });

const lane = (kind: CustomLane['kind'], dir: 1 | -1, width = 3.5): CustomLane => ({ kind, dir, width });

/** A junction at the origin with arms in these compass directions, degrees clockwise from +x. */
function star(net: RoadNetwork, degrees: number[], roadType = 'street-2', length = 120): { node: Id; dirs: Vec3[] } {
  const dirs = degrees.map((d) => ({ x: Math.cos((d * Math.PI) / 180), y: 0, z: Math.sin((d * Math.PI) / 180) }));
  const first = net.drawRoad({ start: free(0, 0), end: free(dirs[0].x * length, dirs[0].z * length), roadType });
  const node = first.nodes[0];
  for (const d of dirs.slice(1)) net.drawRoad({ start: { kind: 'node', id: node }, end: free(d.x * length, d.z * length), roadType });
  expect(net.getNode(node)!.segments).toHaveLength(degrees.length);
  return { node, dirs };
}

/** Largest step between consecutive points: a smooth path has no jumps. */
function maxStep(points: readonly Vec3[]): number {
  let worst = 0;
  for (let i = 1; i < points.length; i++) worst = Math.max(worst, Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  return worst;
}

/** Sharpest turn between consecutive steps, in degrees. A kink shows as a large one. */
function sharpestTurn(points: readonly Vec3[]): number {
  let worst = 0;
  for (let i = 2; i < points.length; i++) {
    const ax = points[i - 1].x - points[i - 2].x;
    const az = points[i - 1].z - points[i - 2].z;
    const bx = points[i].x - points[i - 1].x;
    const bz = points[i].z - points[i - 1].z;
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    if (la < 1e-3 || lb < 1e-3) continue;
    const cos = Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb)));
    worst = Math.max(worst, (Math.acos(cos) * 180) / Math.PI);
  }
  return worst;
}

const LAYOUTS: [string, number[]][] = [
  ['3-way', [0, 90, 180]],
  ['4-way', [0, 90, 180, 270]],
  ['5-way', [0, 72, 144, 216, 288]],
];

function uneven() {
  return makeCustomRoadType({
    id: 'custom-uneven',
    name: 'Uneven',
    lanes: [lane('bus', -1), lane('drive', -1), lane('drive', 1), lane('bus', 1), lane('bus', 1)],
    speedKmh: 50,
  });
}

describe('Paint: a line from each arm to every other arm', () => {
  function paintAll(r: Rig, dirs: Vec3[], out = 26): void {
    r.tools.setTool('paint');
    r.tools.settings.paint.kind = 'line';
    r.tools.settingsChanged();
    let made = 0;
    for (let i = 0; i < dirs.length; i++) {
      for (let j = 0; j < dirs.length; j++) {
        if (i === j) continue;
        const a = dirs[i];
        const b = dirs[j];
        // Right-hand lane of each arm, a little way out from the junction.
        r.click(a.x * out - a.z * 1.75, a.z * out + a.x * 1.75);
        r.click(b.x * out + b.z * 1.75, b.z * out - b.x * 1.75);
        made++;
        expect(r.net.decals, `arm ${i} to arm ${j}`).toHaveLength(made);
        const pts = resolveDecal(r.net, r.net.decals[made - 1]).points;
        expect(pts.length).toBeGreaterThan(4);
        expect(maxStep(pts)).toBeLessThan(6);
        expect(sharpestTurn(pts)).toBeLessThan(40);
        // It ends where the second click was, on the other arm.
        const end = pts[pts.length - 1];
        expect(Math.hypot(end.x - (b.x * out + b.z * 1.75), end.z - (b.z * out - b.x * 1.75))).toBeLessThan(2.5);
        // And stays in the junction's neighbourhood rather than wandering off.
        for (const p of pts) expect(Math.hypot(p.x, p.z)).toBeLessThan(out + 4);
      }
    }
    expect(r.toasts.filter((t) => t.includes('further'))).toEqual([]);
  }

  for (const [name, degrees] of LAYOUTS) {
    it(`is accepted on a ${name} junction`, () => {
      const r = rig();
      const { dirs } = star(r.net, degrees);
      paintAll(r, dirs);
    });
  }

  it('is accepted on a 4-way of uneven roads', () => {
    const net = new RoadNetwork();
    net.setCustomRoadType(uneven());
    const r = rig(null, net);
    const { dirs } = star(net, [0, 90, 180, 270], 'custom-uneven');
    paintAll(r, dirs, 30);
  });

  it('is accepted across a junction between two different road types', () => {
    const r = rig();
    r.net.drawRoad({ start: free(-120, 0), end: free(120, 0), roadType: 'street-2' });
    r.net.drawRoad({ start: free(0, -120), end: free(0, 120), roadType: 'street-4' });
    paintAll(r, [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 0, z: -1 },
    ]);
  });
});

describe('Junction markings: a line from each arm to every other arm', () => {
  function markAll(r: Rig, node: Id): void {
    const tool = r.tools.nodeMarkings;
    r.tools.setTool('nodeMarkings');
    tool.open(node);
    const anchors = nodeAnchors(r.net, node);
    const arms = [...new Set(anchors.map((a) => a.anchor.segmentId))];
    let made = 0;
    for (const a of arms) {
      for (const b of arms) {
        if (a === b) continue;
        const pa = anchors.filter((x) => x.anchor.segmentId === a)[1];
        const pb = anchors.filter((x) => x.anchor.segmentId === b)[1];
        r.click(pa.pos.x, pa.pos.z);
        r.click(pb.pos.x, pb.pos.z);
        made++;
        const list = r.net.getNode(node)!.control.markings ?? [];
        expect(list, `arm ${a} to arm ${b}`).toHaveLength(made);
        const m = list[made - 1];
        expect(m.kind).toBe('line');
        const path = markingPath(r.net, node, m as never)!;
        expect(path.length).toBeGreaterThan(3);
        expect(maxStep(path)).toBeLessThan(6);
        expect(sharpestTurn(path)).toBeLessThan(40);
      }
    }
  }

  for (const [name, degrees] of LAYOUTS) {
    it(`is accepted on a ${name} junction, curved and following lanes`, () => {
      const r = rig();
      const { node } = star(r.net, degrees);
      markAll(r, node);
      r.net.clearNodeMarkings(node);
      r.tools.settings.nodeMarking.followLanes = true;
      markAll(r, node);
    });
  }

  it('is accepted on a 4-way of uneven roads', () => {
    const net = new RoadNetwork();
    net.setCustomRoadType(uneven());
    const r = rig(null, net);
    const { node } = star(net, [0, 90, 180, 270], 'custom-uneven');
    markAll(r, node);
  });
});
