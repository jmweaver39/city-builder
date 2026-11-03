import { describe, expect, it } from 'vitest';
import { RoadNetwork, distXZ, type Vec3 } from '../../src/core';
import { ANGLE_STEP, LENGTH_STEP, continuationAt, referenceDirection, snapRoadPoint, type SnapQuery } from '../../src/tools/snap';

const v = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });
const on = { nodes: true, segments: true, angle: true, length: true };
const query = (raw: Vec3, extra: Partial<SnapQuery> = {}): SnapQuery => ({
  picks: [{ level: 0, pos: raw }],
  raw,
  from: null,
  toggles: on,
  disabled: false,
  ...extra,
});

function road(): { net: RoadNetwork; seg: number; a: number; b: number } {
  const net = new RoadNetwork();
  const r = net.drawRoad({ start: { kind: 'free', pos: v(0, 0) }, end: { kind: 'free', pos: v(200, 0) }, roadType: 'street-2' });
  return { net, seg: r.segments[0], a: r.nodes[0], b: r.nodes[1] };
}

describe('snapRoadPoint', () => {
  it('prefers a node over the road it sits on', () => {
    const { net, a } = road();
    const hit = snapRoadPoint(net, query(v(3, 2)));
    expect(hit.kind).toBe('node');
    expect(hit.anchor).toEqual({ kind: 'node', id: a });
    expect(hit.pos).toMatchObject({ x: 0, z: 0 });
  });

  it('snaps along a segment and carries the split position', () => {
    const { net, seg } = road();
    const hit = snapRoadPoint(net, query(v(100, 3)));
    expect(hit.kind).toBe('segment');
    expect(hit.anchor.kind).toBe('segment');
    if (hit.anchor.kind === 'segment') {
      expect(hit.anchor.id).toBe(seg);
      expect(hit.anchor.t).toBeCloseTo(0.5, 2);
    }
    expect(hit.pos.z).toBeCloseTo(0, 6);
  });

  it('falls back to the node near a segment end rather than making a stub', () => {
    const { net, b } = road();
    // Beyond node reach, but within the end gap measured along the road.
    const hit = snapRoadPoint(net, query(v(196, 7.9)), );
    expect(hit.anchor).toEqual({ kind: 'node', id: b });
  });

  it('does nothing when disabled, however close the road is', () => {
    const { net } = road();
    const raw = v(1, 1);
    const hit = snapRoadPoint(net, query(raw, { disabled: true, from: { pos: v(50, 50), ref: null } }));
    expect(hit.kind).toBe('free');
    expect(hit.pos).toEqual(raw);
    expect(hit.anchor).toEqual({ kind: 'free', pos: raw });
  });

  it('honours the toggles', () => {
    const { net } = road();
    const hit = snapRoadPoint(net, query(v(100, 3), { toggles: { ...on, segments: false } }));
    expect(hit.kind).toBe('free');
  });

  it('snaps to 15 degree steps relative to the reference road, not world axes', () => {
    const net = new RoadNetwork();
    const ref = { x: Math.cos(0.3), y: 0, z: Math.sin(0.3) };
    const from = v(0, 0);
    // 45 degrees off the reference, nudged slightly.
    const angle = 0.3 + (46 * Math.PI) / 180;
    const raw = v(Math.cos(angle) * 100, Math.sin(angle) * 100);
    const hit = snapRoadPoint(net, query(raw, { from: { pos: from, ref } }));
    expect(hit.kind).toBe('angleLength');
    expect(hit.angle! / ANGLE_STEP).toBeCloseTo(3, 6);
    expect(hit.guide).not.toBeNull();
  });

  it('rounds length along the guide to the length step', () => {
    const net = new RoadNetwork();
    const hit = snapRoadPoint(net, query(v(99, 0.5), { from: { pos: v(0, 0), ref: { x: 1, y: 0, z: 0 } } }));
    expect(distXZ(hit.pos, v(0, 0)) % LENGTH_STEP).toBeCloseTo(0, 6);
    expect(hit.pos.z).toBeCloseTo(0, 6);
  });

  it('length snap alone keeps the free direction', () => {
    const net = new RoadNetwork();
    const toggles = { ...on, angle: false };
    const raw = v(70, 42);
    const len = Math.hypot(70, 42);
    const hit = snapRoadPoint(net, query(raw, { toggles, from: { pos: v(0, 0), ref: null } }));
    const expected = Math.round(len / LENGTH_STEP) * LENGTH_STEP;
    if (Math.abs(expected - len) <= 2.5) {
      expect(distXZ(hit.pos, v(0, 0))).toBeCloseTo(expected, 6);
      expect(hit.kind).toBe('length');
    } else {
      expect(hit.kind).toBe('free');
    }
  });

  it('keeps the drawing elevation on a free end', () => {
    const net = new RoadNetwork();
    const raw = v(10, 10, 12);
    const hit = snapRoadPoint(net, query(raw, { picks: [{ level: 0, pos: v(10, 10) }], from: { pos: v(-90, 10), ref: { x: 1, y: 0, z: 0 } } }));
    expect(hit.pos.y).toBe(12);
  });

  it('ignores roads in another height band', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: { kind: 'free', pos: v(0, 0, 12) }, end: { kind: 'free', pos: v(200, 0, 12) }, roadType: 'street-2' });
    const ground = snapRoadPoint(net, query(v(100, 2)));
    expect(ground.kind).toBe('free');
    const raised = snapRoadPoint(net, query(v(100, 2, 12), { picks: [{ level: 12, pos: v(100, 2, 12) }] }));
    expect(raised.kind).toBe('segment');
    expect(raised.pos.y).toBeCloseTo(12, 6);
  });
});

describe('snapRoadPoint at a grade separation', () => {
  function stacked() {
    const net = new RoadNetwork();
    const low = net.drawRoad({ start: { kind: 'free', pos: v(-100, 0) }, end: { kind: 'free', pos: v(100, 0) }, roadType: 'street-2' }).segments[0];
    const high = net.drawRoad({ start: { kind: 'free', pos: v(20, -200, 12) }, end: { kind: 'free', pos: v(20, 200, 12) }, roadType: 'street-2' }).segments[0];
    return { net, low, high };
  }

  it('finds the road on each level, even where the other road is nearer in plan', () => {
    const { net, low, high } = stacked();
    // Right beside the bridge, and further from the street than from the bridge.
    const nearBridge = v(21, 1.5);
    const onGround = snapRoadPoint(net, query(nearBridge));
    expect(onGround.anchor).toMatchObject({ kind: 'segment', id: low });
    expect(onGround.pos.y).toBeCloseTo(0, 6);
    const pos = v(19, 1, 12);
    const onDeck = snapRoadPoint(net, query(pos, { picks: [{ level: 12, pos }] }));
    expect(onDeck.anchor).toMatchObject({ kind: 'segment', id: high });
    expect(onDeck.pos.y).toBeCloseTo(12, 6);
  });
});

describe('continuationAt', () => {
  it('points out of a dead end along the road, at either end', () => {
    const { net, a, b } = road();
    expect(continuationAt(net, b)!.dir.x).toBeCloseTo(1, 6);
    expect(continuationAt(net, a)!.dir.x).toBeCloseTo(-1, 6);
  });

  it('is null at a node with two roads', () => {
    const { net, seg } = road();
    const { node } = net.splitSegment(seg, 0.5);
    expect(continuationAt(net, node)).toBeNull();
  });

  it('carries the slope of the road', () => {
    const net = new RoadNetwork();
    const r = net.drawRoad({ start: { kind: 'free', pos: v(0, 0, 0) }, end: { kind: 'free', pos: v(100, 0, 8) }, roadType: 'street-2' });
    expect(continuationAt(net, r.nodes[1])!.slope).toBeCloseTo(0.08, 4);
  });
});

describe('referenceDirection', () => {
  it('uses the segment tangent for a point on a road', () => {
    const { net, seg } = road();
    const ref = referenceDirection(net, { kind: 'segment', id: seg, t: 0.5 }, null)!;
    expect(Math.abs(ref.x)).toBeCloseTo(1, 6);
  });
});
