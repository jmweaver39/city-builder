import { beforeEach, describe, expect, it } from 'vitest';
import { checkNetworkInvariants, resolveDecal, RoadNetwork, type Id } from '../../src/core';
import { Simulation } from '../../src/sim/Simulation';
import { TrainSim } from '../../src/rail';
import { CLICK_WHOLE, MIN_STUB, SECTION } from '../../src/tools/bulldozeSpan';
import { rig, type Rig } from './helpers';

let r: Rig;
beforeEach(() => {
  r = rig();
  r.tools.setTool('bulldoze');
});

const free = (x: number, z: number, y = 0) => ({ kind: 'free' as const, pos: { x, y, z } });

/** Plan x extents of every segment, sorted, for roads laid along the x axis. */
function spans(net: RoadNetwork, type?: string): [number, number][] {
  return net.segments
    .filter((s) => !type || s.roadType === type)
    .map((s) => {
      const c = net.cubicOf(s.id);
      return [Math.min(c.p0.x, c.p3.x), Math.max(c.p0.x, c.p3.x)] as [number, number];
    })
    .sort((a, b) => a[0] - b[0]);
}

/** Total length of road left. */
const total = (net: RoadNetwork): number => net.segments.reduce((sum, s) => sum + net.curveOf(s.id).length, 0);

const clean = (net: RoadNetwork) => expect(checkNetworkInvariants(net)).toEqual([]);

describe('Bulldoze: a click', () => {
  it('on a long road with no junctions takes out only a section round the cursor', () => {
    r.net.drawRoad({ start: free(0, 0), end: free(600, 0), roadType: 'street-2' });
    r.click(300, 0);
    expect(total(r.net)).toBeCloseTo(600 - SECTION, 0);
    const parts = spans(r.net);
    expect(parts).toHaveLength(2);
    expect(parts[0][1]).toBeCloseTo(300 - SECTION / 2, 0);
    expect(parts[1][0]).toBeCloseTo(300 + SECTION / 2, 0);
    // Two new dead ends where the cut was.
    expect(r.net.deadEnds()).toHaveLength(4);
    clean(r.net);
  });

  it('near the end of a long road runs out to the dead end rather than leave a stub', () => {
    r.net.drawRoad({ start: free(0, 0), end: free(600, 0), roadType: 'street-2' });
    r.click(MIN_STUB, 0);
    const parts = spans(r.net);
    expect(parts).toHaveLength(1);
    expect(parts[0][0]).toBeCloseTo(SECTION, 0);
    clean(r.net);
  });

  it('takes the stretch between two junctions, and leaves the junctions', () => {
    r.net.drawRoad({ start: free(0, 0), end: free(300, 0), roadType: 'street-2' });
    const j1 = r.net.drawRoad({ start: free(100, -100), end: free(100, 100), roadType: 'street-2' }).junctions[0];
    const j2 = r.net.drawRoad({ start: free(200, -100), end: free(200, 100), roadType: 'street-2' }).junctions[0];
    expect(200 - 100).toBeLessThan(CLICK_WHOLE);
    const before = r.net.segments.length;
    r.click(150, 0);
    expect(r.net.segments).toHaveLength(before - 1);
    expect(spans(r.net, 'street-2').some(([a, b]) => a < 150 && b > 150)).toBe(false);
    // The crossing roads stay, joined straight through where the junctions were.
    expect(r.net.getNode(j1)).toBeDefined();
    expect(r.net.getNode(j2)).toBeDefined();
    clean(r.net);
  });

  it('passes through the plain joints of a curve chain', () => {
    const a = r.net.drawRoad({ start: free(0, 0), end: free(40, 0), roadType: 'street-2' });
    r.net.drawRoad({ start: { kind: 'node', id: a.nodes[1] }, end: free(80, 0), roadType: 'street-2' });
    expect(r.net.segments).toHaveLength(2);
    r.click(20, 0);
    expect(r.net.segments).toHaveLength(0);
  });

  it('hover shows exactly that stretch in red, with its length', () => {
    r.net.drawRoad({ start: free(0, 0), end: free(600, 0), roadType: 'street-2' });
    r.hover(300, 0);
    expect(r.view.previews).toHaveLength(1);
    expect(r.view.previews[0].state).toBe('error');
    const c = r.view.previews[0].curves[0];
    expect(Math.min(c.p0.x, c.p3.x)).toBeCloseTo(300 - SECTION / 2, 0);
    expect(Math.max(c.p0.x, c.p3.x)).toBeCloseTo(300 + SECTION / 2, 0);
    // A red line across each cut.
    expect(r.view.marks.filter((m) => m.kind === 'line')).toHaveLength(2);
    expect(r.tools.hud?.lines[0]).toBe(`Remove ${SECTION} m of ${r.net.roadType('street-2')!.name}`);
    // Nothing is removed by looking.
    expect(r.net.segments).toHaveLength(1);
  });

  it('with Shift takes the whole connected road, straight through junctions', () => {
    r.net.drawRoad({ start: free(0, 0), end: free(600, 0), roadType: 'street-2' });
    r.net.drawRoad({ start: free(300, -100), end: free(300, 100), roadType: 'street-4' });
    r.hover(100, 0, { shift: true });
    expect(r.tools.hud?.lines[0]).toMatch(/^Remove all 600 m/);
    r.click(100, 0, { shift: true });
    expect(r.net.segments.every((s) => s.roadType === 'street-4')).toBe(true);
    clean(r.net);
  });

  it('is one undo step that restores the signature', () => {
    r.net.drawRoad({ start: free(0, 0), end: free(600, 0), roadType: 'street-2' });
    const sig = r.net.signature();
    r.history.clear();
    r.click(300, 0);
    expect(r.history.size).toBe(1);
    r.history.undo();
    expect(r.net.signature()).toBe(sig);
  });
});

describe('Bulldoze: a drag along the road', () => {
  it('removes exactly the dragged stretch, within a metre', () => {
    r.net.drawRoad({ start: free(0, 0), end: free(400, 0), roadType: 'street-2' });
    r.drag([[100, 0], [140, 1], [200, -1], [250, 0]]);
    const parts = spans(r.net);
    expect(parts).toHaveLength(2);
    expect(Math.abs(parts[0][1] - 100)).toBeLessThan(1);
    expect(Math.abs(parts[1][0] - 250)).toBeLessThan(1);
    expect(parts[0][0]).toBeCloseTo(0, 6);
    expect(parts[1][1]).toBeCloseTo(400, 6);
    clean(r.net);
  });

  it('works backwards too, and the cursor may wander off the road', () => {
    r.net.drawRoad({ start: free(0, 0), end: free(400, 0), roadType: 'street-2' });
    r.drag([[300, 0], [200, 8], [120, 12]]);
    const parts = spans(r.net);
    expect(Math.abs(parts[0][1] - 120)).toBeLessThan(1);
    expect(Math.abs(parts[1][0] - 300)).toBeLessThan(1);
  });

  it('follows the road across plain joints and through a junction', () => {
    const a = r.net.drawRoad({ start: free(0, 0), end: free(200, 0), roadType: 'street-2' });
    r.net.drawRoad({ start: { kind: 'node', id: a.nodes[1] }, end: free(500, 0), roadType: 'street-2' });
    const j = r.net.drawRoad({ start: free(350, -100), end: free(350, 100), roadType: 'street-2' }).junctions[0];
    r.drag([[120, 0], [250, 0], [420, 0]]);
    const along = spans(r.net).filter(([x0, x1]) => x1 - x0 > 1);
    expect(along).toHaveLength(2 + 0);
    expect(Math.abs(along[0][1] - 120)).toBeLessThan(1);
    expect(Math.abs(along[1][0] - 420)).toBeLessThan(1);
    // The crossing road is untouched and no longer has a junction to stop at.
    expect(r.net.getNode(j)).toBeDefined();
    clean(r.net);
  });

  it('runs out to a junction it ends near, so no stub is left inside it', () => {
    r.net.drawRoad({ start: free(0, 0), end: free(400, 0), roadType: 'street-2' });
    const j = r.net.drawRoad({ start: free(300, -100), end: free(300, 100), roadType: 'street-2' }).junctions[0];
    r.drag([[150, 0], [296, 0]]);
    const node = r.net.getNode(j)!;
    // Three arms left: the crossing road both ways and the road on to 400.
    expect(node.segments).toHaveLength(3);
    expect(spans(r.net, 'street-2').some(([a, b]) => a < 290 && b > 160)).toBe(false);
    clean(r.net);
  });

  it('is one undo step that restores the signature', () => {
    r.net.drawRoad({ start: free(0, 0), end: free(400, 0), roadType: 'street-2' });
    const sig = r.net.signature();
    r.history.clear();
    r.drag([[100, 0], [250, 0]]);
    expect(r.history.size).toBe(1);
    r.history.undo();
    expect(r.net.signature()).toBe(sig);
  });

  it('a right click during the drag drops it', () => {
    r.net.drawRoad({ start: free(0, 0), end: free(400, 0), roadType: 'street-2' });
    r.tools.pointerDown({ x: 100, y: 0, button: 0, shift: false, ctrl: false, alt: false });
    r.tools.pointerMove({ x: 250, y: 0, button: 0, shift: false, ctrl: false, alt: false });
    r.rightClick();
    r.tools.pointerUp({ x: 250, y: 0, button: 0, shift: false, ctrl: false, alt: false });
    expect(r.net.segments).toHaveLength(1);
  });
});

describe('Bulldoze: what hangs off the road', () => {
  it('cuts road paint at the cut, keeping what lies outside it', () => {
    r.net.drawRoad({ start: free(0, 0), end: free(400, 0), roadType: 'street-2' });
    r.tools.setTool('paint');
    r.click(20, 3.2);
    r.click(380, 3.2);
    expect(r.net.decals).toHaveLength(1);
    r.tools.setTool('bulldoze');
    r.drag([[150, 0], [250, 0]]);
    expect(r.net.decals).toHaveLength(2);
    for (const d of r.net.decals) {
      const pts = resolveDecal(r.net, d).points;
      expect(pts.every((p) => p.x < 151 || p.x > 249)).toBe(true);
    }
  });

  it('keeps vehicles on the road safe when a stretch goes under traffic', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-400, 0), end: free(400, 0), roadType: 'street-2' });
    net.setTraffic({ multiplier: 3 });
    const t = rig(null, net);
    t.tools.setTool('bulldoze');
    const sim = new Simulation(net);
    for (let i = 0; i < 1200; i++) sim.step();
    expect(sim.stats().active).toBeGreaterThan(0);
    t.drag([[-50, 0], [50, 0]]);
    for (let i = 0; i < 600; i++) sim.step();
    for (let k = 0; k < sim.vehicles.count; k++) {
      expect(Number.isFinite(sim.vehicles.x[k])).toBe(true);
      expect(Math.abs(sim.vehicles.x[k]) > 49 || Math.abs(sim.vehicles.z[k]) > 10).toBe(true);
    }
    clean(net);
  });
});

describe('Bulldoze: rail track', () => {
  function railway(): { net: RoadNetwork; t: Rig; mid: Id; west: Id; east: Id; line: Id } {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-1000, 0), end: free(1000, 0), roadType: 'rail-double' });
    const seg = net.segments[0].id;
    const west = net.addStation({ name: 'West', kind: 'surface', segmentId: seg, t: 0.1, platformLength: 200 });
    const mid = net.addStation({ name: 'Middle', kind: 'surface', segmentId: seg, t: 0.5, platformLength: 200 });
    const east = net.addStation({ name: 'East', kind: 'surface', segmentId: seg, t: 0.9, platformLength: 200 });
    const line = net.addLine({ name: 'Blue line', color: '#36f', stops: [west, mid, east], trainType: 'emu', cars: 4, trains: 2, headwaySec: 120 });
    const t = rig(null, net);
    t.tools.setTool('bulldoze');
    return { net, t, mid, west, east, line };
  }

  it('a click on track takes a section, and a station on it goes with a warning for its line', () => {
    const { net, t, mid } = railway();
    t.click(0, 0);
    expect(total(net)).toBeCloseTo(2000 - SECTION, 0);
    expect(net.rail.stations.find((s) => s.id === mid)).toBeUndefined();
    expect(net.rail.lines[0].stops).toHaveLength(2);
    expect(t.toasts.some((m) => m.includes('Middle'))).toBe(true);
    expect(t.toasts.some((m) => m.includes('Blue line') && m.includes('track is cut'))).toBe(true);
    clean(net);
  });

  it('a cut into the end of a platform shortens it to fit', () => {
    const { net, t, mid } = railway();
    // Middle's platform runs from x -100 to 100. Cut from 60 eastwards.
    t.drag([[60, 0], [300, 0]]);
    const st = net.rail.stations.find((s) => s.id === mid)!;
    expect(st.platformLength).toBeLessThan(200);
    expect(st.platformLength).toBeGreaterThan(140);
    const c = net.cubicOf(st.segmentId);
    const centre = c.p0.x + (c.p3.x - c.p0.x) * st.t;
    expect(centre + st.platformLength / 2).toBeLessThanOrEqual(60);
    expect(t.toasts.some((m) => m.includes('Shortened') && m.includes('Middle'))).toBe(true);
    clean(net);
  });

  it('the train sim rebuilds and keeps running after a cut', () => {
    const { net, t } = railway();
    const trains = new TrainSim(net, 3);
    for (let i = 0; i < 600; i++) trains.step();
    t.drag([[300, 0], [500, 0]]);
    for (let i = 0; i < 600; i++) trains.step();
    const v = trains.view;
    for (let i = 0; i < v.count; i++) expect(Number.isFinite(v.x[i])).toBe(true);
  });

  it('Shift+click takes all the track and its stations, as one undo step', () => {
    const { net, t } = railway();
    const sig = net.signature();
    t.history.clear();
    t.click(0, 0, { shift: true });
    expect(net.segments).toHaveLength(0);
    expect(net.rail.stations).toHaveLength(0);
    expect(t.history.size).toBe(1);
    t.history.undo();
    expect(net.signature()).toBe(sig);
  });
});
