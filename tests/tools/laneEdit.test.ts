import { describe, expect, it } from 'vitest';
import { RoadNetwork, boundaryOffsets, checkNetworkInvariants, effectiveLanes, type Id, type LaneLink } from '../../src/core';
import { History } from '../../src/app/History';
import { Simulation } from '../../src/sim';
import { EDITED_TYPE_PREFIX, applyLaneStrip, mirrorStrip, stripForSegment, stripKey, typeFromStrip } from '../../src/tools/laneEdit';
import { addElement, addLane, makeLane, moveItem, removeItem, setDirection, updateItem, type LaneItem, type StripItem } from '../../src/tools/laneStrip';
import { expectFiniteState, run } from '../sim/helpers';

const v = (x: number, z: number) => ({ x, y: 0, z });
const free = (x: number, z: number) => ({ kind: 'free' as const, pos: v(x, z) });
const lanesOf = (items: readonly StripItem[]) => items.filter((i): i is LaneItem => i.type === 'lane');
const clean = (net: RoadNetwork) => expect(checkNetworkInvariants(net)).toEqual([]);

/** A street along +x from -300 to 300 with a T junction at x = 0 (side road to +z). */
function tee(type = 'street-4') {
  const net = new RoadNetwork();
  const r = net.drawRoad({ start: free(-300, 0), end: free(300, 0), roadType: type });
  const main = r.segments[0];
  const side = net.drawRoad({ start: { kind: 'segment', id: main, t: 0.5 }, end: free(0, 250), roadType: 'street-2' });
  const hub = side.nodes[0];
  const segs = net.getNode(hub)!.segments;
  const west = segs.find((s) => net.getSegment(s)!.b === hub && net.roadTypeOf(s).id === type)!;
  const east = segs.find((s) => net.getSegment(s)!.a === hub && net.roadTypeOf(s).id === type)!;
  return { net, hub, west, east, side: side.segments[0] };
}

describe('reading a placed road as a strip', () => {
  it('reads lanes, lane kinds and lane limits set on the road', () => {
    const net = new RoadNetwork();
    const id = net.drawRoad({ start: free(0, 0), end: free(200, 0), roadType: 'street-4' }).segments[0];
    net.setSegmentOverrides(id, { laneKinds: { 3: 'bus' }, laneSpeeds: { 0: 30 } });
    const src = stripForSegment(net, id)!;
    const lanes = lanesOf(src.items);
    expect(lanes.map((l) => `${l.kind}${l.dir}`)).toEqual(['drive-1', 'drive-1', 'drive1', 'bus1']);
    expect(lanes[0].speedKmh).toBe(30);
    expect(lanes[1].speedKmh).toBeUndefined();
    expect(src.laneUids).toEqual(lanes.map((l) => l.uid));
    expect(src.items[0].type).toBe('sidewalk');
  });
});

describe('applying an edited strip', () => {
  it('adds a lane as one undo step, with a new custom type built from makeCustomRoadType', () => {
    const net = new RoadNetwork();
    const history = new History(net);
    const id = net.drawRoad({ start: free(-200, 0), end: free(200, 0), roadType: 'street-4' }).segments[0];
    const before = net.signature();
    const src = stripForSegment(net, id)!;
    const items = addLane(src.items, 'drive', 1);
    history.hint('Edit lanes');
    const rep = applyLaneStrip(net, src, items);
    expect(rep.ok).toBe(true);
    expect(rep.createdTypes).toHaveLength(1);
    expect(rep.typeId!.startsWith(EDITED_TYPE_PREFIX)).toBe(true);
    const def = net.roadTypeOf(id);
    expect(def.lanes.map((l) => l.dir)).toEqual([-1, -1, 1, 1, 1]);
    expect(def.category).toBe('street');
    expect(def.name).toMatch(/\(edited\)$/);
    expect(net.laneGraph.roadLanes.get(id)!.length).toBe(5);
    clean(net);
    expect(history.undoLabel).toBe('Edit lanes');
    history.undo();
    expect(net.signature()).toBe(before);
    expect(net.roadTypeOf(id).id).toBe('street-4');
  });

  it('reuses a type with the same layout, built-in included, and tidies away unused edited types', () => {
    const net = new RoadNetwork();
    const id = net.drawRoad({ start: free(-200, 0), end: free(200, 0), roadType: 'street-4' }).segments[0];
    let src = stripForSegment(net, id)!;
    const wider = addLane(src.items, 'drive', 1);
    const first = applyLaneStrip(net, src, wider);
    // The same layout on another road reuses the type.
    const other = net.drawRoad({ start: free(-200, 100), end: free(200, 100), roadType: 'street-4' }).segments[0];
    const src2 = stripForSegment(net, other)!;
    const again = applyLaneStrip(net, src2, addLane(src2.items, 'drive', 1));
    expect(again.typeId).toBe(first.typeId);
    expect(again.createdTypes).toEqual([]);
    // Back to four lanes: that is the built-in street again, and the edited type goes once unused.
    src = stripForSegment(net, id)!;
    const last = lanesOf(src.items).at(-1)!;
    expect(applyLaneStrip(net, src, removeItem(src.items, last.uid)).typeId).toBe('street-4');
    expect(net.roadType(first.typeId!)).toBeDefined();
    const src3 = stripForSegment(net, other)!;
    applyLaneStrip(net, src3, removeItem(src3.items, lanesOf(src3.items).at(-1)!.uid));
    expect(net.roadType(first.typeId!)).toBeUndefined();
    clean(net);
  });

  it('keeps an unused edited type the caller asks to keep', () => {
    const net = new RoadNetwork();
    const id = net.drawRoad({ start: free(-200, 0), end: free(200, 0), roadType: 'street-4' }).segments[0];
    let src = stripForSegment(net, id)!;
    const t = applyLaneStrip(net, src, addLane(src.items, 'bike', 1)).typeId!;
    src = stripForSegment(net, id)!;
    applyLaneStrip(net, src, removeItem(src.items, lanesOf(src.items).at(-1)!.uid), { keepType: (x) => x === t });
    expect(net.roadType(t)).toBeDefined();
  });

  it('keeps lane kinds, directions, widths, medians and per-lane limits, and keeps the road category', () => {
    const net = new RoadNetwork();
    const id = net.drawRoad({ start: free(-200, 0), end: free(200, 0), roadType: 'highway-3' }).segments[0];
    const src = stripForSegment(net, id)!;
    const [a, b] = lanesOf(src.items);
    let items = updateItem(src.items, a.uid, { kind: 'bus', width: 4 });
    items = updateItem(items, b.uid, { speedKmh: 60 });
    const rep = applyLaneStrip(net, src, items);
    expect(rep.ok).toBe(true);
    const def = net.roadTypeOf(id);
    expect(def.category).toBe('highway');
    expect(def.lanes[0].kind).toBe('bus');
    expect(def.lanes[0].width).toBe(4);
    const seg = net.getSegment(id)!;
    expect(seg.overrides.laneSpeeds).toEqual({ 1: 60 });
    expect(seg.overrides.laneKinds).toBeUndefined();
    clean(net);
  });

  it('refuses a strip with every lane running backwards, and a broken strip', () => {
    const net = new RoadNetwork();
    const id = net.drawRoad({ start: free(-200, 0), end: free(200, 0), roadType: 'street-2-oneway' }).segments[0];
    const src = stripForSegment(net, id)!;
    let items = src.items;
    for (const l of lanesOf(items)) items = setDirection(items, l.uid, -1);
    const rep = applyLaneStrip(net, src, items);
    expect(rep.ok).toBe(false);
    expect(rep.error).toMatch(/against/);
    const none = src.items.filter((i) => i.type !== 'lane');
    expect(applyLaneStrip(net, src, none).ok).toBe(false);
    expect(net.roadTypeOf(id).id).toBe('street-2-oneway');
  });

  it('refuses a stale strip after the road changed underneath', () => {
    const net = new RoadNetwork();
    const id = net.drawRoad({ start: free(-200, 0), end: free(200, 0), roadType: 'street-4' }).segments[0];
    const src = stripForSegment(net, id)!;
    net.setRoadType(id, 'avenue-6');
    expect(applyLaneStrip(net, src, addLane(src.items, 'drive', 1)).ok).toBe(false);
  });
});

describe('whole road', () => {
  it('edits every connected piece, mirroring the layout on pieces drawn the other way', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-300, 0));
    const m1 = net.addNode(v(-100, 0));
    const m2 = net.addNode(v(100, 0));
    const b = net.addNode(v(300, 0));
    const s1 = net.addSegment(a, m1, { roadType: 'street-4' });
    const s2 = net.addSegment(m2, m1, { roadType: 'street-4' }); // drawn the other way
    const s3 = net.addSegment(m2, b, { roadType: 'street-4' });
    const src = stripForSegment(net, s1)!;
    // A bus lane on the right going +x, and one fewer lane going -x: uneven.
    let items = addLane(src.items, 'bus', 1);
    items = removeItem(items, lanesOf(items)[0].uid);
    const rep = applyLaneStrip(net, src, items, { whole: true });
    expect(rep.ok).toBe(true);
    expect(rep.segments.sort()).toEqual([s1, s2, s3].sort());
    expect(net.roadTypeOf(s3).id).toBe(net.roadTypeOf(s1).id);
    expect(net.roadTypeOf(s2).id).not.toBe(net.roadTypeOf(s1).id);
    // On the ground, the pieces agree: the bus lane is on the +z side running +x everywhere.
    const busSide = (seg: Id) => {
      const s = net.getSegment(seg)!;
      const forwardX = net.getNode(s.b)!.pos.x > net.getNode(s.a)!.pos.x ? 1 : -1;
      const lane = net.roadTypeOf(seg).lanes.find((l) => l.kind === 'bus')!;
      // Right of a-to-b along +x is +z.
      return { z: Math.sign(lane.offset * forwardX), x: lane.dir * forwardX };
    };
    for (const s of [s1, s2, s3]) expect(busSide(s)).toEqual({ z: 1, x: 1 });
    clean(net);
    expect(net.roadTypeOf(s2).lanes.filter((l) => l.kind === 'drive')).toHaveLength(3);
    expect(net.laneGraph.roadLanes.get(s2)!.every((i) => i >= 0)).toBe(true);
  });

  it('applies to the selected piece only without the toggle', () => {
    const net = new RoadNetwork();
    const r = net.drawRoad({ start: free(-300, 0), end: free(300, 0), roadType: 'street-4' });
    const right = net.splitSegment(r.segments[0], 0.5).right!;
    const src = stripForSegment(net, r.segments[0])!;
    const rep = applyLaneStrip(net, src, addLane(src.items, 'drive', -1));
    expect(rep.segments).toEqual([r.segments[0]]);
    expect(net.roadTypeOf(right).id).toBe('street-4');
    clean(net);
  });
});

describe('keeping what is attached', () => {
  it('remaps hand-set lane connections by lane, and links new lanes automatically', () => {
    const { net, hub, west, east, side } = tee();
    // Hand-set links: the automatic ones plus straight on from the west curb lane, which normally only turns right.
    const auto = net.connectionsAt(hub).filter((c) => c.active).map((c) => ({ from: c.from, to: c.to }));
    expect(auto.some((l) => l.from === `${west}:3` && l.to.startsWith(`${east}:`))).toBe(false);
    const links: LaneLink[] = [...auto, { from: `${west}:3`, to: `${east}:3` }];
    net.setJunctionControl(hub, { laneLinks: links });
    // Add a lane on the far left of the west piece (a back lane), shifting every index by one.
    const src = stripForSegment(net, west)!;
    const items = addLane(src.items, 'drive', -1);
    const rep = applyLaneStrip(net, src, items);
    expect(rep.ok).toBe(true);
    expect(rep.lost).toEqual([]);
    const now = net.getNode(hub)!.control.laneLinks!;
    // The old curb lane is lane 4 now, and keeps both its right turn and the hand-set link straight on.
    expect(now.some((l) => l.from === `${west}:4` && l.to === `${east}:3`)).toBe(true);
    expect(now.some((l) => l.from === `${west}:4` && l.to.startsWith(`${side}:`))).toBe(true);
    expect(now.some((l) => l.from === `${west}:3` && l.to.startsWith(`${side}:`))).toBe(false);
    // The new outgoing lane (index 0, running -x away from the hub) is fed.
    expect(now.some((l) => l.to === `${west}:0`)).toBe(true);
    // Hand-set links still rule: the graph has the extra link.
    const g = net.laneGraph;
    const key = (ref: string) => g.byKey.get(`r${ref}`)!;
    expect((g.connectorsAt.get(hub) ?? []).some((i) => g.lanes[i].fromLane === key(`${west}:4`) && g.lanes[i].toLane === key(`${east}:3`))).toBe(true);
    clean(net);
  });

  it('names what it could not keep when a lane goes', () => {
    const { net, hub, west, east } = tee();
    net.setJunctionControl(hub, { laneLinks: net.connectionsAt(hub).filter((c) => c.active).map((c) => ({ from: c.from, to: c.to })) });
    const src = stripForSegment(net, west)!;
    const curb = lanesOf(src.items).at(-1)!; // the west piece's curb lane, running +x into the hub
    const rep = applyLaneStrip(net, src, removeItem(src.items, curb.uid));
    expect(rep.ok).toBe(true);
    expect(rep.lost.some((x) => /lane connection/.test(x))).toBe(true);
    expect(net.getNode(hub)!.control.laneLinks!.every((l) => !l.from.startsWith(`${west}:3`))).toBe(true);
    expect(net.getNode(hub)!.control.laneLinks!.some((l) => l.to.startsWith(`${east}:`))).toBe(true);
    clean(net);
  });

  it('moves a junction marking anchored on a lane boundary with its lane, and keeps signals, signs and crosswalks', () => {
    const { net, hub, west, side } = tee();
    const offs = boundaryOffsets(net.roadTypeOf(west));
    // Boundary between the two lanes running +x (the right side of a-to-b).
    const mid = offs.findIndex((x) => Math.abs(x - 3.5) < 0.01);
    expect(mid).toBeGreaterThan(0);
    net.addNodeMarking(hub, { kind: 'line', from: { segmentId: west, boundary: mid }, to: { segmentId: side, boundary: 1 }, style: 'solid', color: 'white', width: 0.15, straight: false });
    net.setJunctionControl(hub, { mode: 'signal' });
    net.setSign(hub, side, 'stop');
    net.setCrosswalk(hub, west, 'ladder');
    const src = stripForSegment(net, west)!;
    const items = addLane(src.items, 'drive', -1);
    applyLaneStrip(net, src, items);
    const marking = net.getNode(hub)!.control.markings![0];
    expect(marking.kind).toBe('line');
    const newOffs = boundaryOffsets(net.roadTypeOf(west));
    // The road is wider and lanes moved, but the anchor is still between the same two lanes.
    const lanes = net.roadTypeOf(west).lanes;
    const x = newOffs[(marking as { from: { boundary: number } }).from.boundary];
    // Old lanes 2 and 3 (both +x) are lanes 3 and 4 now.
    expect(x).toBeCloseTo(lanes[3].offset + lanes[3].width / 2, 5);
    expect(x).toBeCloseTo(lanes[4].offset - lanes[4].width / 2, 5);
    expect(lanes[3].dir).toBe(1);
    expect(lanes[4].dir).toBe(1);
    expect(net.getNode(hub)!.control.mode).toBe('signal');
    expect(net.getNode(hub)!.control.signs[side]).toBe('stop');
    expect(net.getNode(hub)!.control.crosswalks[west]).toBe('ladder');
    clean(net);
  });

  it('moves lane line styles, road paint and zone edges with the lanes', () => {
    const net = new RoadNetwork();
    const id = net.drawRoad({ start: free(-200, 0), end: free(200, 0), roadType: 'street-4' }).segments[0];
    const lanes = net.roadTypeOf(id).lanes;
    net.setSegmentOverrides(id, { markings: { boundaries: { 2: { style: 'solid', color: 'yellow' } } } });
    const paint = net.addDecal({ kind: 'arrow', points: [], color: 'white', width: 1, rotation: 0, road: { pieces: [{ segmentId: id, t0: 0.4, t1: 0.6 }], offset: lanes[3].offset } } as never);
    const edge = 7 + 2; // well clear of the road
    net.addZone({ kind: 'residential', density: 'low', enabled: true, name: 'Z', polygon: [v(0, 20), v(50, 20), v(50, 40)], anchors: [{ segmentId: id, t: 0.5, offset: edge + 1 }, null, null], source: 'frontage', settings: { depth: 20, setback: 1, snap: true, snapDistance: 5, excludeFast: true } } as never);
    const src = stripForSegment(net, id)!;
    // A bike lane on the far right: the road widens to the right.
    let items = addLane(src.items, 'bike', 1);
    items = moveItem(items, lanesOf(items).at(-1)!.uid, items.length - 1);
    const before = net.roadTypeOf(id);
    const rep = applyLaneStrip(net, src, items);
    expect(rep.lost).toEqual([]);
    const after = net.roadTypeOf(id);
    const seg = net.getSegment(id)!;
    expect(seg.overrides.markings?.boundaries).toEqual({ 2: { style: 'solid', color: 'yellow' } });
    const d = net.decals.find((x) => x.id === paint)!;
    expect(d.road!.offset).toBeCloseTo(after.lanes[3].offset, 5);
    const z = net.project.zones![0];
    const grow = after.halfWidth + after.sidewalk - (before.halfWidth + before.sidewalk);
    expect(z.anchors![0]!.offset).toBeCloseTo(edge + 1 + grow, 5);
  });

  it('drops paint on a lane that was removed, and says so', () => {
    const net = new RoadNetwork();
    const id = net.drawRoad({ start: free(-200, 0), end: free(200, 0), roadType: 'street-4' }).segments[0];
    const lanes = net.roadTypeOf(id).lanes;
    net.addDecal({ kind: 'arrow', points: [], color: 'white', width: 1, rotation: 0, road: { pieces: [{ segmentId: id, t0: 0.5, t1: 0.5 }], offset: lanes[0].offset } } as never);
    const src = stripForSegment(net, id)!;
    const rep = applyLaneStrip(net, src, removeItem(src.items, lanesOf(src.items)[0].uid));
    expect(net.decals).toHaveLength(0);
    expect(rep.lost).toEqual(['1 painted mark']);
  });

  it('keeps a median added in the strip', () => {
    const net = new RoadNetwork();
    const id = net.drawRoad({ start: free(-200, 0), end: free(200, 0), roadType: 'street-4' }).segments[0];
    const src = stripForSegment(net, id)!;
    applyLaneStrip(net, src, addElement(src.items, 'median'));
    expect(net.roadTypeOf(id).median.kind).toBe('grass');
    expect(effectiveLanes(net.roadTypeOf(id))).toHaveLength(4);
    clean(net);
  });
});

describe('helpers', () => {
  it('mirrors a strip and compares strips by what they build', () => {
    const items = [makeLane('drive', -1), makeLane('bus', 1)];
    const m = mirrorStrip(items);
    expect(lanesOf(m).map((l) => `${l.kind}${l.dir}`)).toEqual(['bus-1', 'drive1']);
    expect(stripKey(items)).toBe(stripKey(items.map((i) => ({ ...i, uid: i.uid + 100 }))));
    expect(stripKey(items)).not.toBe(stripKey(m));
    expect(typeFromStrip(new RoadNetwork().roadType('street-2')!, items).lanes).toHaveLength(2);
  });
});

describe('vehicles on an edited road', () => {
  it('keeps running with traffic on the road while lanes are added, removed, reordered and turned round', () => {
    const { net, west, east } = tee('avenue-4');
    net.setTraffic({ autoGatewayRatePerLane: 900 });
    const sim = new Simulation(net, 77);
    run(sim, 120, () => expectFiniteState(sim));
    expect(sim.stats().active).toBeGreaterThan(5);
    const edits: ((items: StripItem[]) => StripItem[])[] = [
      (items) => addLane(items, 'drive', 1),
      (items) => removeItem(items, lanesOf(items)[0].uid),
      (items) => {
        const l = lanesOf(items);
        return moveItem(items, l.at(-1)!.uid, items.indexOf(l.at(-2)!));
      },
      (items) => setDirection(items, lanesOf(items)[0].uid, 1),
      (items) => addLane(items, 'bus', -1),
    ];
    // Count anyone moving against the lane under them along the main road. Both pieces run +x,
    // so a lane's offset is its z, and dir 1 means +x (on an uneven road that can be at negative z).
    const wrongWay = () => {
      const vw = sim.vehicles;
      let wrong = 0;
      let seen = 0;
      for (let i = 0; i < vw.count; i++) {
        // Clear of the junction at 0 and the turnarounds at the dead ends (300).
        if (Math.abs(vw.x[i]) > 250 || Math.abs(vw.x[i]) < 40 || Math.abs(vw.z[i]) > 14) continue;
        const dx = vw.x[i] - vw.prevX[i];
        if (Math.abs(dx) < 0.05) continue;
        const lanes = net.roadTypeOf(vw.x[i] < 0 ? west : east).lanes;
        let near = lanes[0];
        for (const l of lanes) if (Math.abs(l.offset - vw.z[i]) < Math.abs(near.offset - vw.z[i])) near = l;
        // Mid lane change: no telling which lane it belongs to.
        if (Math.abs(near.offset - vw.z[i]) > 0.5) continue;
        seen++;
        if (Math.sign(dx) !== near.dir) wrong++;
      }
      return { wrong, seen };
    };
    // Where every vehicle is, to catch any that jump or turn round when the lanes change under them.
    const where = () => {
      const vw = sim.vehicles;
      const out = new Map<number, { x: number; z: number; yaw: number }>();
      for (let i = 0; i < vw.count; i++) out.set(vw.id[i], { x: vw.x[i], z: vw.z[i], yaw: vw.yaw[i] });
      return out;
    };
    let seen = 0;
    let carried = 0;
    for (const edit of edits) {
      for (const seg of [west, east]) {
        const src = stripForSegment(net, seg)!;
        const before = where();
        const rep = applyLaneStrip(net, src, edit(src.items), { whole: true });
        expect(rep.ok, rep.error).toBe(true);
        clean(net);
        sim.step();
        const vw = sim.vehicles;
        let jumped = 0;
        for (let i = 0; i < vw.count; i++) {
          const b = before.get(vw.id[i]);
          if (!b || Math.abs(b.x) > 250) continue;
          carried++;
          const turn = Math.abs(Math.atan2(Math.sin(vw.yaw[i] - b.yaw), Math.cos(vw.yaw[i] - b.yaw)));
          if (Math.hypot(vw.x[i] - b.x, vw.z[i] - b.z) > 8 || turn > Math.PI / 2) jumped++;
        }
        expect(jumped).toBe(0);
        sim.step();
        const w = wrongWay();
        expect(w.wrong).toBe(0);
        seen += w.seen;
        run(sim, 30, () => expectFiniteState(sim));
      }
    }
    expect(seen).toBeGreaterThan(20);
    expect(carried).toBeGreaterThan(20);
    run(sim, 120, () => expectFiniteState(sim));
    expect(sim.stats().arrivedTotal).toBeGreaterThan(0);
  });
});
