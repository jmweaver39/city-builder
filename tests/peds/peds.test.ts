import { describe, expect, it } from 'vitest';
import { closestPointOnCubic, cubicTangentXZ, DEFAULT_ZONE_SETTINGS, fillBlock, makeCustomRoadType, RoadNetwork, sidewalkOn, type Id } from '../../src/core';
import { buildStarterScene } from '../../src/app/starter';
import { Simulation } from '../../src/sim';
import { footprintAt } from '../../src/peds/footprint';
import { buildPedGraph, crosswalkOn, E_CROSS, N_DOOR, N_PLATFORM, N_STOP, type PedGraph } from '../../src/peds/graph';
import { PedSim } from '../../src/peds/PedSim';
import { free, town, v } from './scene';

const FAST = new Set(['highway', 'ramp', 'rail']);

/** Every node clear of carriageways, junction surfaces, track and water, and on a road with a sidewalk. */
function checkNodes(net: RoadNetwork, g: PedGraph): void {
  for (let i = 0; i < g.n; i++) {
    const hit = footprintAt(net, g.x[i], g.y[i], g.z[i]);
    if (hit) throw new Error(`node ${i} (kind ${g.kind[i]}) at ${g.x[i].toFixed(1)},${g.z[i].toFixed(1)} is on ${hit}`);
    const seg = g.seg[i];
    if (seg >= 0) {
      const def = net.roadTypeOf(seg);
      expect(FAST.has(def.category)).toBe(false);
      const c = net.cubicOf(seg);
      const hitSeg = closestPointOnCubic(c, { x: g.x[i], y: 0, z: g.z[i] });
      const tan = cubicTangentXZ(c, hitSeg.t);
      const lateral = (g.x[i] - hitSeg.point.x) * -tan.z + (g.z[i] - hitSeg.point.z) * tan.x;
      expect(sidewalkOn(def, lateral >= 0 ? 1 : -1)).toBeGreaterThan(0);
      expect(sidewalkOn(def, 1) > 0 || sidewalkOn(def, -1) > 0).toBe(true);
    }
  }
  // Nothing near a fast road.
  for (const s of net.segments) {
    const def = net.roadTypeOf(s.id);
    if (!FAST.has(def.category)) continue;
    const c = net.cubicOf(s.id);
    for (let i = 0; i < g.n; i++) {
      const hit = closestPointOnCubic(c, { x: g.x[i], y: 0, z: g.z[i] });
      if (hit.distance < def.halfWidth + 1 && Math.abs(hit.point.y - g.y[i]) < 3) throw new Error(`node ${i} on ${def.category} ${s.id}`);
    }
  }
}

/** Every edge but a crossing stays off roads; every crossing edge is a painted crosswalk. */
function checkEdges(net: RoadNetwork, g: PedGraph): void {
  for (let u = 0; u < g.n; u++) {
    for (let k = g.start[u]; k < g.start[u + 1]; k++) {
      const w = g.to[k];
      if (w < u) continue;
      if (g.ekind[k] === E_CROSS) {
        const c = g.crossings[g.ecross[k]];
        expect(crosswalkOn(net, c.nodeId, c.segmentId)).toBe(true);
        expect(FAST.has(net.roadTypeOf(c.segmentId).category)).toBe(false);
        continue;
      }
      const L = Math.hypot(g.x[w] - g.x[u], g.z[w] - g.z[u]);
      const n = Math.max(1, Math.ceil(L / 1));
      for (let i = 1; i < n; i++) {
        const f = i / n;
        const x = g.x[u] + (g.x[w] - g.x[u]) * f;
        const y = g.y[u] + (g.y[w] - g.y[u]) * f;
        const z = g.z[u] + (g.z[w] - g.z[u]) * f;
        const hit = footprintAt(net, x, y, z);
        if (hit) throw new Error(`edge ${u}-${w} kind ${g.ekind[k]} crosses ${hit} at ${x.toFixed(1)},${z.toFixed(1)}`);
      }
    }
  }
}

describe('pedestrian graph', () => {
  it('walks only on sidewalks, corners, lot paths and painted crosswalks in a town', () => {
    const { net } = town();
    const g = buildPedGraph(net);
    expect(g.n).toBeGreaterThan(500);
    expect(g.crossings.length).toBe(28);
    expect(g.crossings.filter((c) => c.signal).length).toBe(8);
    checkNodes(net, g);
    checkEdges(net, g);
    // One connected town: every place can reach every other.
    const comps = new Set(g.places.map((p) => g.comp[p.node]));
    expect(comps.size).toBe(1);
    expect(g.places.filter((p) => p.kind === 'home').length).toBeGreaterThan(20);
    expect(g.places.filter((p) => p.kind === 'shop').length).toBeGreaterThan(5);
    for (const p of g.places) expect([N_DOOR, N_STOP, N_PLATFORM].includes(g.kind[p.node]) || p.kind === 'station').toBe(true);
  });

  it('puts nothing on the highway, the ramps or the highway junctions of the starter scene', () => {
    const net = new RoadNetwork();
    buildStarterScene(net);
    const g = buildPedGraph(net);
    expect(g.n).toBeGreaterThan(100);
    checkNodes(net, g);
    checkEdges(net, g);
  });

  it('follows sidewalkLeft and sidewalkRight, and leaves roads without sidewalks alone', () => {
    const net = new RoadNetwork();
    const lanes = [
      { kind: 'drive' as const, dir: -1 as const, width: 3.5 },
      { kind: 'drive' as const, dir: 1 as const, width: 3.5 },
    ];
    const oneSide = makeCustomRoadType({ lanes, sidewalkLeft: 2.5, sidewalkRight: 0 });
    net.setCustomRoadType(oneSide);
    const bare = makeCustomRoadType({ lanes, sidewalkLeft: 0, sidewalkRight: 0 });
    net.setCustomRoadType({ ...bare, id: `${bare.id}-bare` });
    const a = net.drawRoad({ start: free(0, 0), end: free(300, 0), roadType: oneSide.id }).segments[0];
    const b = net.drawRoad({ start: free(0, 100), end: free(300, 100), roadType: `${bare.id}-bare` }).segments[0];
    const g = buildPedGraph(net);
    let left = 0;
    for (let i = 0; i < g.n; i++) {
      expect(g.seg[i]).not.toBe(b);
      if (g.seg[i] === a) {
        // Left of a road heading +x is -z.
        expect(g.z[i]).toBeLessThan(0);
        left++;
      }
    }
    expect(left).toBeGreaterThan(10);
  });

  it('rebuilds after edits: a removed street loses its walks, a new one gains them', () => {
    const { net } = town();
    const sim = new PedSim(net, null, { seed: 3 });
    sim.setFocus(300, 200, 500);
    const g0 = sim.refresh();
    const seg = net.nearestSegment(v(300, 400), 5)!.segmentId;
    expect(Array.from(g0.seg).includes(seg)).toBe(true);
    net.removeSegment(seg);
    const g1 = sim.refresh();
    expect(g1).not.toBe(g0);
    expect(Array.from(g1.seg).includes(seg)).toBe(false);
    const added = net.drawRoad({ start: free(0, 600), end: free(600, 600), roadType: 'street-2' }).segments;
    const g2 = sim.refresh();
    for (const id of added) expect(Array.from(g2.seg).includes(id)).toBe(true);
    checkNodes(net, g2);
  });
});

function pedsOK(net: RoadNetwork, peds: PedSim, g: PedGraph): void {
  for (let i = 0; i < peds.count; i++) {
    if (peds.crossingOf(i) >= 0) continue;
    // A walker fades in and out at doors; anywhere else they stand on walkable ground.
    const hit = footprintAt(net, peds.x[i], peds.y[i] + 0.05, peds.z[i]);
    if (hit) throw new Error(`walker ${i} on ${hit} at ${peds.x[i].toFixed(1)},${peds.z[i].toFixed(1)}`);
  }
  void g;
}

/** Vehicle body rectangle contains the point, with a margin. Yaw 0 faces -z. */
function vehicleHits(sim: Simulation, x: number, z: number, margin: number): boolean {
  const v = sim.vehicles;
  const HALF = [2.3, 2.6, 5.2, 6.2, 0.9];
  const W = [0.95, 1.05, 1.25, 1.3, 0.4];
  for (let k = 0; k < v.count; k++) {
    const fx = -Math.sin(v.yaw[k]);
    const fz = -Math.cos(v.yaw[k]);
    const dx = x - v.x[k];
    const dz = z - v.z[k];
    const along = dx * fx + dz * fz;
    const across = -dx * fz + dz * fx;
    if (Math.abs(along) < HALF[v.type[k]] + margin && Math.abs(across) < W[v.type[k]] + margin) return true;
  }
  return false;
}

describe('pedestrians', () => {
  it('make trips between plausible places, and stay on walkable ground', () => {
    const { net } = town();
    net.setTraffic({ autoGatewayRatePerLane: 200 });
    const sim = new Simulation(net, 5);
    const peds = new PedSim(net, sim, { seed: 9 });
    peds.hour = 12;
    peds.setFocus(300, 200, 450);
    const g = peds.refresh();
    const placeNodes = new Map(g.places.map((p) => [p.node, p.kind]));
    const trips: [string, string][] = [];
    peds.onTrip = (from, to) => trips.push([placeNodes.get(from) ?? 'none', placeNodes.get(to) ?? 'none']);
    for (let s = 0; s < 600; s++) {
      sim.step();
      peds.step(0.1);
      if (s % 20 === 0) pedsOK(net, peds, g);
    }
    expect(peds.count).toBeGreaterThan(40);
    expect(trips.length).toBeGreaterThan(40);
    for (const [from, to] of trips) {
      expect(from).not.toBe('none');
      expect(to).not.toBe('none');
      // Nobody walks from one home to another, or from a shop to another shop.
      if (from === to) expect(from).toBe('home');
    }
    expect(peds.counts.crossed).toBeGreaterThan(10);
  });

  it('come out by day, mostly stay in at night, and none walk where there is nowhere to go', () => {
    const { net } = town();
    const day = new PedSim(net, null, { seed: 1 });
    day.hour = 13;
    day.setFocus(300, 200, 450);
    day.step(0.1);
    const night = new PedSim(net, null, { seed: 1 });
    night.hour = 3;
    night.setFocus(300, 200, 450);
    night.step(0.1);
    expect(day.count).toBeGreaterThan(night.count * 4);
    expect(night.count).toBeGreaterThan(0);
    // Out by the highway there is nothing: nobody appears.
    const empty = new PedSim(net, null, { seed: 1 });
    empty.hour = 13;
    empty.setFocus(300, -500, 150);
    for (let i = 0; i < 50; i++) empty.step(0.1);
    expect(empty.count).toBe(0);
    // Zoomed out: no work, nobody.
    day.setFocus(0, 0, 0);
    expect(day.count).toBe(0);
  });

  it('cross only at crosswalks, and at signals only when traffic over the crosswalk has red', () => {
    const { net, signals } = town();
    net.setTraffic({ autoGatewayRatePerLane: 400 });
    const sim = new Simulation(net, 7);
    const peds = new PedSim(net, sim, { seed: 4, hook: false });
    peds.hour = 17.5;
    peds.setFocus(300, 200, 450);
    const g = peds.refresh();
    let signalEntries = 0;
    let bad = 0;
    peds.onCross = (ci) => {
      const c = g.crossings[ci];
      expect(crosswalkOn(net, c.nodeId, c.segmentId)).toBe(true);
      if (!c.signal) return;
      expect(signals.includes(c.nodeId)).toBe(true);
      signalEntries++;
      for (const key of [...c.fromKeys, ...c.straightIntoKeys]) {
        const idx = net.laneGraph.byKey.get(key)!;
        if (sim.connectorLight(idx) !== 'red') bad++;
      }
    };
    let conflicts = 0;
    for (let s = 0; s < 1500; s++) {
      sim.step();
      peds.step(0.1);
      for (let i = 0; i < peds.count; i++) if (peds.crossingOf(i) >= 0 && vehicleHits(sim, peds.x[i], peds.z[i], 0.3)) conflicts++;
    }
    expect(signalEntries).toBeGreaterThan(5);
    expect(bad).toBe(0);
    expect(peds.counts.waitedAtSignal).toBeGreaterThan(0);
    expect(conflicts).toBe(0);
    expect(sim.stats().collisions ?? 0).toBe(0);
  });

  it('hold turning cars for people on a crosswalk without breaking the road sim', () => {
    const { net } = town();
    net.setTraffic({ autoGatewayRatePerLane: 500 });
    const sim = new Simulation(net, 11);
    const peds = new PedSim(net, sim, { seed: 2, hook: true });
    peds.hour = 8;
    peds.setFocus(300, 200, 450);
    peds.refresh();
    let conflicts = 0;
    const before = sim.stats().forcedStops ?? 0;
    for (let s = 0; s < 1800; s++) {
      sim.step();
      peds.step(0.1);
      for (let i = 0; i < peds.count; i++) if (peds.crossingOf(i) >= 0 && vehicleHits(sim, peds.x[i], peds.z[i], 0.3)) conflicts++;
    }
    const st = sim.stats();
    expect(peds.counts.held).toBeGreaterThan(3);
    expect(conflicts).toBe(0);
    expect(st.collisions ?? 0).toBe(0);
    expect((st.forcedStops ?? 0) - before).toBeLessThan(3);
    expect(st.despawnedStuck).toBe(0);
    // Leaving the area lets every held lane go.
    peds.setFocus(0, 0, 0);
    expect(peds.heldLanes().length).toBe(0);
  });

  it('is deterministic for the same seed', () => {
    const run = () => {
      const { net } = town();
      const sim = new Simulation(net, 5);
      const peds = new PedSim(net, sim, { seed: 21 });
      peds.hour = 9;
      peds.setFocus(300, 200, 400);
      for (let s = 0; s < 200; s++) {
        sim.step();
        peds.step(0.1);
      }
      return Array.from(peds.x.subarray(0, peds.count)).map((x, i) => `${x.toFixed(3)},${peds.z[i].toFixed(3)}`).join(';');
    };
    const a = run();
    expect(a.length).toBeGreaterThan(100);
    expect(run()).toBe(a);
  });

  it('steps thousands of people cheaply', () => {
    const net = new RoadNetwork();
    // A bigger town: 6 by 6 blocks.
    for (let k = 0; k <= 6; k++) {
      net.drawRoad({ start: free(0, k * 150), end: free(900, k * 150), roadType: k === 3 ? 'avenue-4' : 'street-2' });
      net.drawRoad({ start: free(k * 150, 0), end: free(k * 150, 900), roadType: 'street-2' });
    }
    const kinds = ['residential', 'commercial', 'office', 'residential', 'industrial'] as const;
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 6; j++) {
        const r = fillBlock(net, v(i * 150 + 75, j * 150 + 75), DEFAULT_ZONE_SETTINGS);
        if ('error' in r) continue;
        const kind = kinds[(i * 7 + j * 3) % kinds.length];
        net.addZone({ kind, density: 'high', enabled: true, name: kind, polygon: r.polygon, anchors: r.anchors, source: 'block', settings: { ...DEFAULT_ZONE_SETTINGS } });
      }
    const peds = new PedSim(net, null, { seed: 1 });
    peds.maxPeds = 3000;
    peds.density = 4;
    peds.hour = 12;
    peds.setFocus(450, 450, 700);
    peds.step(0.016);
    const t0 = performance.now();
    for (let s = 0; s < 60; s++) peds.step(1 / 60);
    const ms = (performance.now() - t0) / 60;
    console.log(`pedestrians: ${peds.count} people, ${ms.toFixed(3)} ms per step`);
    expect(ms).toBeLessThan(8);
  });
});

describe('the crosswalk setting', () => {
  it('is on by default, saved when changed, and old saves load unchanged', () => {
    const { net } = town();
    expect(net.traffic.pedestriansStopTraffic).toBeUndefined();
    const old = new RoadNetwork(net.serialize());
    expect(old.traffic.pedestriansStopTraffic).toBeUndefined();
    net.setTraffic({ pedestriansStopTraffic: false });
    expect(new RoadNetwork(net.serialize()).traffic.pedestriansStopTraffic).toBe(false);
  });

  it('off: people still cross, only in gaps, and traffic is never held', () => {
    const { net } = town();
    net.setTraffic({ autoGatewayRatePerLane: 500, pedestriansStopTraffic: false });
    const sim = new Simulation(net, 11);
    const peds = new PedSim(net, sim, { seed: 2 });
    peds.hour = 8;
    peds.setFocus(300, 200, 450);
    let conflicts = 0;
    for (let s = 0; s < 1200; s++) {
      sim.step();
      peds.step(0.1);
      expect(peds.heldLanes().length).toBe(0);
      for (let i = 0; i < peds.count; i++) if (peds.crossingOf(i) >= 0 && vehicleHits(sim, peds.x[i], peds.z[i], 0.3)) conflicts++;
    }
    expect(peds.counts.held).toBe(0);
    expect(peds.counts.crossed).toBeGreaterThan(20);
    expect(conflicts).toBe(0);
    // Turning it back on holds traffic again.
    net.setTraffic({ pedestriansStopTraffic: true });
    for (let s = 0; s < 1200; s++) {
      sim.step();
      peds.step(0.1);
    }
    expect(peds.counts.held).toBeGreaterThan(0);
    expect(sim.stats().collisions ?? 0).toBe(0);
  });
});

export type { Id };
