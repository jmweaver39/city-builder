import { describe, expect, it } from 'vitest';
import {
  RoadNetwork,
  builtinRoadType,
  customLaneProblems,
  effectiveLanes,
  laneSpeedKmh,
  makeCustomRoadType,
  roadTypeProblems,
  type CustomLane,
  type RoadTypeDef,
} from '../../src/core';
import { expectClean, free, onSeg, v } from './helpers';

const drive = (dir: 1 | -1, width = 3.5, speedKmh?: number): CustomLane => ({ kind: 'drive', dir, width, speedKmh });
const bus = (dir: 1 | -1, speedKmh?: number): CustomLane => ({ kind: 'bus', dir, width: 3.5, speedKmh });
const bike = (dir: 1 | -1, speedKmh?: number): CustomLane => ({ kind: 'bike', dir, width: 1.8, speedKmh });

function road(net: RoadNetwork, roadType: string, x0 = 0, x1 = 200): number {
  return net.drawRoad({ start: free(x0, 0), end: free(x1, 0), roadType }).segments[0];
}

const laneOf = (net: RoadNetwork, seg: number, i: number) => {
  const g = net.laneGraph;
  return g.lanes[g.roadLanes.get(seg)![i]];
};

describe('makeCustomRoadType with an explicit lane list', () => {
  it('lays lanes out left to right across the median, keeping kinds and speeds', () => {
    const def = makeCustomRoadType({
      id: 'custom-a',
      lanes: [bike(-1, 25), drive(-1), drive(1, 3.5, 40), bus(1, 30), bike(1)],
      medianKind: 'grass',
      medianWidth: 2,
      sidewalkWidth: 2,
      speedKmh: 50,
    });
    expect(roadTypeProblems(def)).toEqual([]);
    expect(def.lanes.map((l) => l.kind)).toEqual(['bike', 'drive', 'drive', 'bus', 'bike']);
    expect(def.lanes.map((l) => l.dir)).toEqual([-1, -1, 1, 1, 1]);
    // 5.3 m one way, 2 m of median, 8.8 m the other: 16.1 m centred on the curve.
    const off = def.lanes.map((l) => l.offset);
    [-7.15, -4.5, 1, 4.5, 7.15].forEach((x, i) => expect(off[i]).toBeCloseTo(x, 9));
    expect(def.lanes[0].speedKmh).toBe(25);
    expect(def.lanes[1].speedKmh).toBeUndefined();
    expect(def.halfWidth).toBeCloseTo(8.05, 9);
    expect(def.median.kind).toBe('grass');
    expect(def.median.offset).toBeCloseTo(-1.75, 9);
  });

  it('centres a one-way and ignores the median', () => {
    const def = makeCustomRoadType({ lanes: [drive(1), bike(1)], medianKind: 'grass', medianWidth: 4 });
    expect(def.median.kind).toBe('none');
    const hi = def.lanes[1].offset + def.lanes[1].width / 2;
    const lo = def.lanes[0].offset - def.lanes[0].width / 2;
    expect(hi).toBeCloseTo(-lo, 9);
    expect(def.halfWidth).toBeCloseTo(hi, 9);
  });

  it('flips a road with every lane backward, mirroring the order', () => {
    const def = makeCustomRoadType({ lanes: [bike(-1), drive(-1)] });
    expect(def.lanes.every((l) => l.dir === 1)).toBe(true);
    expect(def.lanes.map((l) => l.kind)).toEqual(['drive', 'bike']);
  });

  it('needs at least one lane', () => {
    expect(() => makeCustomRoadType({ lanes: [] })).toThrow(/at least one lane/);
    expect(customLaneProblems({ lanes: [] })).toEqual(['A road type needs at least one lane']);
  });

  it('refuses overlapping lanes', () => {
    const lanes: CustomLane[] = [
      { ...drive(1), offset: 0 },
      { ...drive(1), offset: 2 },
    ];
    expect(customLaneProblems({ lanes })[0]).toMatch(/overlap/);
    expect(() => makeCustomRoadType({ lanes })).toThrow(/overlap/);
  });

  it('refuses lanes that do not fit the road width', () => {
    const lanes = [drive(1), drive(1), drive(1)];
    expect(customLaneProblems({ lanes, halfWidth: 4 }).join()).toMatch(/does not fit/);
    expect(() => makeCustomRoadType({ lanes, halfWidth: 4 })).toThrow(/does not fit/);
    expect(makeCustomRoadType({ lanes, halfWidth: 6 }).halfWidth).toBe(6);
  });

  it('refuses a lane on the wrong side of the road', () => {
    const lanes = [drive(1), drive(-1)];
    expect(customLaneProblems({ lanes })[0]).toMatch(/left of the others/);
    expect(() => makeCustomRoadType({ lanes })).toThrow(/left of the others/);
  });

  it('refuses a partly positioned lane list', () => {
    expect(customLaneProblems({ lanes: [{ ...drive(1), offset: 0 }, drive(1)] })[0]).toMatch(/every lane/);
  });

  it('clamps widths and speeds, as the sliders may overshoot', () => {
    const def = makeCustomRoadType({ lanes: [{ kind: 'drive', dir: 1, width: 40, speedKmh: 900 }] });
    expect(def.lanes[0].width).toBe(6);
    expect(def.lanes[0].speedKmh).toBe(160);
  });

  it('leaves lane-count parameters working exactly as before', () => {
    const def = makeCustomRoadType({ id: 'x', forwardLanes: 2, backwardLanes: 1, bikeLanes: true, busLanes: true });
    expect(def.lanes.map((l) => l.kind)).toEqual(['bike', 'bus', 'drive', 'drive', 'drive', 'bus', 'bike']);
    expect(() => makeCustomRoadType({ forwardLanes: 0, backwardLanes: 0 })).toThrow(/at least one lane/);
    expect(def.lanes.every((l) => l.speedKmh === undefined)).toBe(true);
  });

  it('every built-in road still validates', () => {
    for (const id of ['street-2', 'street-2-bike', 'avenue-4-bus', 'boulevard-8', 'highway-5', 'dual-6', 'ramp-2']) {
      expect(roadTypeProblems(builtinRoadType(id) as RoadTypeDef)).toEqual([]);
    }
  });

  it('roadTypeProblems catches a bad saved type', () => {
    const def = structuredClone(builtinRoadType('street-2')!);
    def.lanes[1].offset = -1.5;
    expect(roadTypeProblems(def).join()).toMatch(/overlap/);
    const narrow = structuredClone(builtinRoadType('street-2')!);
    narrow.halfWidth = 2;
    expect(roadTypeProblems(narrow).join()).toMatch(/does not fit/);
  });
});

describe('Per-lane speeds and kinds in the lane graph', () => {
  function setup() {
    const net = new RoadNetwork();
    const def = makeCustomRoadType({
      id: 'custom-b',
      lanes: [bike(-1, 20), drive(-1), drive(1, 3.5, 40), bus(1, 30), bike(1)],
      speedKmh: 60,
    });
    net.setCustomRoadType(def);
    return { net, def, seg: road(net, 'custom-b') };
  }

  it('GLane.speed comes from the lane, falling back to the road', () => {
    const { net, seg } = setup();
    expect(laneOf(net, seg, 0).speed).toBeCloseTo(20 / 3.6, 6);
    expect(laneOf(net, seg, 1).speed).toBeCloseTo(60 / 3.6, 6);
    expect(laneOf(net, seg, 2).speed).toBeCloseTo(40 / 3.6, 6);
    expect(laneOf(net, seg, 3).speed).toBeCloseTo(30 / 3.6, 6);
  });

  it('a placed road beats its type, and a lane beats the road', () => {
    const { net, def, seg } = setup();
    net.setSegmentOverrides(seg, { speedKmh: 45 });
    expect(laneOf(net, seg, 0).speed).toBeCloseTo(45 / 3.6, 6);
    net.setSegmentOverrides(seg, { laneSpeeds: { 0: 15 } });
    expect(laneOf(net, seg, 0).speed).toBeCloseTo(15 / 3.6, 6);
    expect(laneOf(net, seg, 1).speed).toBeCloseTo(45 / 3.6, 6);
    expect(laneSpeedKmh(def, net.getSegment(seg)!.overrides, 0)).toBe(15);
    expect(effectiveLanes(def, net.getSegment(seg)!.overrides)[0].speedKmh).toBe(15);
  });

  it('a kind override changes vehicleKind in the graph', () => {
    const { net, seg } = setup();
    expect(laneOf(net, seg, 1).vehicleKind).toBe('drive');
    const before = net.laneGraph.version;
    net.setSegmentOverrides(seg, { laneKinds: { 1: 'bus' } });
    expect(laneOf(net, seg, 1).vehicleKind).toBe('bus');
    expect(net.laneGraph.version).toBeGreaterThan(before);
    expectClean(net);
  });

  it('overrides survive a split on both sides', () => {
    const { net, seg } = setup();
    net.setSegmentOverrides(seg, { laneKinds: { 1: 'bus' }, laneSpeeds: { 2: 35 } });
    const { right } = net.splitSegment(seg, 0.5);
    for (const id of [seg, right!]) {
      expect(laneOf(net, id, 1).vehicleKind).toBe('bus');
      expect(laneOf(net, id, 2).speed).toBeCloseTo(35 / 3.6, 6);
    }
    expectClean(net);
  });

  it('overrides and custom lanes survive serialize, with the same signature', () => {
    const { net, seg } = setup();
    net.setSegmentOverrides(seg, { laneKinds: { 1: 'bus' }, laneSpeeds: { 2: 35 } });
    const back = new RoadNetwork(net.serialize());
    expect(back.signature()).toBe(net.signature());
    expect(laneOf(back, seg, 2).speed).toBeCloseTo(35 / 3.6, 6);
    expect(laneOf(back, seg, 1).vehicleKind).toBe('bus');
    expect(back.roadType('custom-b')!.lanes[0].speedKmh).toBe(20);
  });

  it('undo-style reload keeps the speeds', () => {
    const { net, seg } = setup();
    const snap = net.snapshot();
    net.setSegmentOverrides(seg, { laneSpeeds: { 1: 10 } });
    net.load(snap);
    expect(laneOf(net, seg, 1).speed).toBeCloseTo(60 / 3.6, 6);
  });

  it('a connector is limited by its slower lane', () => {
    const net = new RoadNetwork();
    const a = road(net, 'street-4', -200, 0);
    const b = net.drawRoad({ start: { kind: 'node', id: net.getSegment(a)!.b }, end: free(200, 0), roadType: 'street-4' }).segments[0];
    net.drawRoad({ start: free(0, -150), end: free(0, 150), roadType: 'street-4' });
    const lane = net.getSegment(a)!.overrides;
    expect(lane).toEqual({});
    net.setSegmentOverrides(a, { laneSpeeds: { 2: 20, 3: 20 } });
    const g = net.laneGraph;
    const from = g.roadLanes.get(a)![3];
    const connector = g.lanes[from].next.map((i) => g.lanes[i]).find((l) => l.kind === 'connector')!;
    expect(connector.speed).toBeLessThanOrEqual(20 / 3.6 + 1e-6);
    expect(b).toBeGreaterThan(0);
    expectClean(net);
  });
});

describe('Connector rules for bus and bike lanes', () => {
  /** Two of a road meeting a crossing road. */
  function crossing(roadType: string) {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-200, 0), end: free(200, 0), roadType });
    net.drawRoad({ start: free(0, -200), end: free(0, 200), roadType: 'street-2' });
    return net;
  }

  it('bus lanes connect only to drive or bus lanes, and bike lanes only to bike lanes', () => {
    const net = new RoadNetwork();
    net.setCustomRoadType(makeCustomRoadType({ id: 'custom-c', lanes: [bike(-1), drive(-1), drive(1), bus(1), bike(1)] }));
    const main = net.drawRoad({ start: free(-200, 0), end: free(200, 0), roadType: 'custom-c' });
    expect(main.segments).toHaveLength(1);
    net.drawRoad({ start: free(0, -200), end: free(0, 200), roadType: 'custom-c' });
    const g = net.laneGraph;
    let seen = 0;
    for (const lane of g.lanes) {
      if (lane.kind !== 'connector') continue;
      const from = g.lanes[lane.fromLane].vehicleKind;
      const to = g.lanes[lane.toLane].vehicleKind;
      seen++;
      if (from === 'bike') expect(to).toBe('bike');
      if (to === 'bike') expect(from).toBe('bike');
      if (from === 'bus') expect(['drive', 'bus']).toContain(to);
    }
    expect(seen).toBeGreaterThan(10);
    expectClean(net);
  });

  it('holds when a drive lane is turned into a bike lane by an override', () => {
    const net = crossing('street-4');
    const seg = net.segments[0].id;
    net.setSegmentOverrides(seg, { laneKinds: { 3: 'bike' } });
    const g = net.laneGraph;
    const lane = laneOf(net, seg, 3);
    expect(lane.vehicleKind).toBe('bike');
    for (const n of [...lane.next, ...lane.prev]) {
      const c = g.lanes[n];
      const other = g.lanes[c.kind === 'connector' ? (c.fromLane === lane.idx ? c.toLane : c.fromLane) : n];
      expect(other.vehicleKind).toBe('bike');
    }
    expectClean(net);
  });

  it('every drive lane keeps a way out on a road with mixed lanes', () => {
    const net = new RoadNetwork();
    net.setCustomRoadType(makeCustomRoadType({ id: 'custom-d', lanes: [drive(-1), drive(1), bus(1), bike(1)] }));
    const r = net.drawRoad({ start: free(0, 0), end: free(200, 0), roadType: 'custom-d' });
    net.drawRoad({ start: onSeg(r.segments[0], 0.5), end: free(100, 200), roadType: 'street-2' });
    expectClean(net);
    expect(v(0, 0).y).toBe(0);
  });
});
