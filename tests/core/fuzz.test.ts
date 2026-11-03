import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROAD_TYPES,
  NetworkError,
  RoadNetwork,
  checkNetworkInvariants,
  polygonSelfIntersects,
  type Id,
  type RoadAnchor,
  type Vec3,
} from '../../src/core';
import { mulberry32 } from './helpers';

const TYPES = BUILTIN_ROAD_TYPES.map((t) => t.id);
const MAX_SEGMENTS = 90;
const EXTENT = 400;

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)];
}

function randomPoint(rng: () => number): Vec3 {
  const elevated = rng() < 0.2;
  return {
    x: (rng() - 0.5) * 2 * EXTENT,
    y: elevated ? Math.round(rng() * 4) * 4 : 0,
    z: (rng() - 0.5) * 2 * EXTENT,
  };
}

function randomAnchor(net: RoadNetwork, rng: () => number): RoadAnchor {
  const r = rng();
  if (r < 0.35 && net.nodes.length) return { kind: 'node', id: pick(rng, net.nodes).id };
  if (r < 0.6 && net.segments.length) return { kind: 'segment', id: pick(rng, net.segments).id, t: rng() };
  return { kind: 'free', pos: randomPoint(rng) };
}

type OpName = 'draw' | 'split' | 'remove' | 'removeNode' | 'move' | 'controls' | 'type' | 'reload' | 'undo' | 'control' | 'batch';

/** One random edit. Returns its name, for failure messages. */
function step(net: RoadNetwork, rng: () => number, snapshots: string[]): OpName {
  const r = rng();
  const seg = () => pick(rng, net.segments).id;
  const hasRoads = net.segments.length > 0;
  if (net.segments.length > MAX_SEGMENTS && r < 0.6) {
    net.removeSegment(seg());
    return 'remove';
  }
  if (r < 0.34 || !hasRoads) {
    const curved = rng() < 0.6;
    const a = randomPoint(rng);
    const b = randomPoint(rng);
    try {
      net.drawRoad({
        start: randomAnchor(net, rng),
        end: randomAnchor(net, rng),
        c1: curved ? a : undefined,
        c2: curved ? b : undefined,
        roadType: pick(rng, TYPES),
      });
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
    }
    return 'draw';
  }
  if (r < 0.48) {
    net.splitSegment(seg(), rng());
    return 'split';
  }
  if (r < 0.6) {
    net.removeSegment(seg());
    return 'remove';
  }
  if (r < 0.63) {
    net.removeNode(pick(rng, net.nodes).id);
    return 'removeNode';
  }
  if (r < 0.76) {
    const node = pick(rng, net.nodes);
    if (rng() < 0.5) {
      net.moveNode(node.id, randomPoint(rng));
    } else {
      const d = 30;
      net.moveNode(node.id, {
        x: node.pos.x + (rng() - 0.5) * d,
        y: node.pos.y,
        z: node.pos.z + (rng() - 0.5) * d,
      });
    }
    return 'move';
  }
  if (r < 0.82) {
    net.setSegmentControls(seg(), randomPoint(rng), randomPoint(rng));
    return 'controls';
  }
  if (r < 0.88) {
    net.setRoadType(seg(), pick(rng, TYPES));
    return 'type';
  }
  if (r < 0.92) {
    const text = net.serialize();
    net.load(text);
    if (net.serialize() !== text) throw new Error('reload changed the project');
    return 'reload';
  }
  if (r < 0.95 && snapshots.length) {
    net.load(pick(rng, snapshots));
    return 'undo';
  }
  if (r < 0.98) {
    const node = pick(rng, net.nodes);
    const options = net.connectionsAt(node.id);
    const links = options.filter(() => rng() < 0.5).map((o) => ({ from: o.from, to: o.to }));
    net.setJunctionControl(node.id, { laneLinks: rng() < 0.5 ? links : null, mode: pick(rng, ['auto', 'signal', 'allStop'] as const) });
    return 'control';
  }
  net.batch(() => {
    for (let i = 0; i < 4 && net.segments.length; i++) {
      if (rng() < 0.5) net.splitSegment(seg(), 0.2 + rng() * 0.6);
      else net.removeSegment(seg());
      // Reading mid-batch recomputes early. It must not disturb the final result.
      if (rng() < 0.5 && net.laneGraph.lanes.length < 0) throw new Error('unreachable');
    }
    net.drawRoad({ start: { kind: 'free', pos: randomPoint(rng) }, end: { kind: 'free', pos: randomPoint(rng) }, roadType: pick(rng, TYPES) });
  });
  return 'batch';
}

/** The lane graph, keyed, reduced to what must match a clean rebuild. */
function fingerprint(net: RoadNetwork): Map<string, string> {
  const g = net.laneGraph;
  const out = new Map<string, string>();
  for (const lane of g.lanes) {
    const next = lane.next.map((i) => g.lanes[i].key).sort();
    const prev = lane.prev.map((i) => g.lanes[i].key).sort();
    const conflicts = lane.conflicts.map((c) => `${g.lanes[c.lane].key}/${c.kind}/${c.selfS.toFixed(3)}`).sort();
    const ends = [...lane.pts.slice(0, 3), ...lane.pts.slice(-3)].map((n) => n.toFixed(2));
    out.set(lane.key, JSON.stringify([lane.turn, lane.vehicleKind, next, prev, conflicts, ends, lane.length.toFixed(2)]));
  }
  return out;
}

function expectSameAsFresh(net: RoadNetwork, context: string): void {
  const fresh = new RoadNetwork(net.serialize());
  const a = fingerprint(net);
  const b = fingerprint(fresh);
  const diff: string[] = [];
  for (const [k, val] of a) if (b.get(k) !== val) diff.push(`${k}: ${val} vs ${b.get(k)}`);
  for (const k of b.keys()) if (!a.has(k)) diff.push(`missing ${k}`);
  expect(diff.slice(0, 5), context).toEqual([]);
  for (const s of net.segments) {
    const x = net.segmentGeom(s.id)!;
    const y = fresh.segmentGeom(s.id)!;
    if (Math.abs(x.trimA - y.trimA) > 1e-9 || Math.abs(x.trimB - y.trimB) > 1e-9) {
      throw new Error(`${context}: segment ${s.id} trims ${x.trimA},${x.trimB} vs ${y.trimA},${y.trimB}`);
    }
  }
  for (const n of net.nodes) {
    const ax = JSON.stringify(net.nodeGeom(n.id));
    const ay = JSON.stringify(fresh.nodeGeom(n.id));
    if (ax !== ay) throw new Error(`${context}: node ${n.id} geometry differs`);
  }
}

describe('randomised fuzz', () => {
  const seeds = [1, 2, 3, 4, 5, 6];
  const opsPerSeed = 900;

  it.each(seeds)('seed %i keeps every invariant after each operation', (seed) => {
    const rng = mulberry32(seed * 7919);
    const net = new RoadNetwork();
    const snapshots: string[] = [];
    const trail: OpName[] = [];
    for (let i = 0; i < opsPerSeed; i++) {
      const name = step(net, rng, snapshots);
      trail.push(name);
      const problems = checkNetworkInvariants(net);
      if (problems.length) {
        throw new Error(`seed ${seed} op ${i} (${trail.slice(-5).join(', ')}): ${problems.slice(0, 5).join('; ')}`);
      }
      if (i % 40 === 0) snapshots.push(net.serialize());
      if (i % 25 === 0) expectSameAsFresh(net, `seed ${seed} op ${i} (${name})`);
    }
    expectSameAsFresh(net, `seed ${seed} end`);
  });

  it('a change event names everything that really changed', () => {
    const rng = mulberry32(4242);
    const net = new RoadNetwork();
    const seen = new Map<Id, string>();
    const seenNodes = new Map<Id, string>();
    const snapshots: string[] = [];
    let dirty = new Set<Id>();
    let dirtyNodes = new Set<Id>();
    let reset = false;
    net.onChange((e) => {
      dirty = new Set([...dirty, ...e.dirtySegments]);
      dirtyNodes = new Set([...dirtyNodes, ...e.dirtyNodes]);
      reset ||= e.reset;
    });
    for (let i = 0; i < 1500; i++) {
      dirty = new Set();
      dirtyNodes = new Set();
      reset = false;
      step(net, rng, snapshots);
      if (i % 50 === 0) snapshots.push(net.serialize());
      for (const s of net.segments) {
        const now = JSON.stringify(net.segmentGeom(s.id));
        const before = seen.get(s.id);
        if (before !== undefined && before !== now && !dirty.has(s.id) && !reset) {
          throw new Error(`op ${i}: segment ${s.id} changed but was not reported`);
        }
        seen.set(s.id, now);
      }
      for (const n of net.nodes) {
        const now = JSON.stringify(net.nodeGeom(n.id));
        const before = seenNodes.get(n.id);
        if (before !== undefined && before !== now && !dirtyNodes.has(n.id) && !reset) {
          throw new Error(`op ${i}: node ${n.id} changed but was not reported`);
        }
        seenNodes.set(n.id, now);
      }
    }
  });

  it('rarely needs the hull fallback, even among the stubs of random drawing', () => {
    const rng = mulberry32(7919);
    const net = new RoadNetwork();
    const point = () => ({ x: (rng() - 0.5) * 800, y: 0, z: (rng() - 0.5) * 800 });
    let junctions = 0;
    let hulls = 0;
    for (let i = 0; i < 900; i++) {
      if (net.segments.length > 90) {
        net.removeSegment(pick(rng, net.segments).id);
      } else {
        net.drawRoad({
          start: { kind: 'free', pos: point() },
          end: { kind: 'free', pos: point() },
          c1: point(),
          c2: point(),
          roadType: pick(rng, TYPES),
        });
      }
      if (i % 20 !== 0) continue;
      for (const n of net.nodes) {
        const g = net.nodeGeom(n.id)!;
        if (g.kind !== 'junction') continue;
        junctions++;
        if (g.outlineSimplified) hulls++;
      }
    }
    expect(junctions).toBeGreaterThan(1000);
    expect(hulls / junctions).toBeLessThan(0.08);
  });

  it('keeps junction outlines simple on an irregular grid of ordinary roads', () => {
    const rng = mulberry32(99);
    const net = new RoadNetwork();
    const horizontal = 8;
    for (let i = 0; i < horizontal; i++) {
      const z = -350 + i * 100 + rng() * 20;
      net.drawRoad({
        start: { kind: 'free', pos: { x: -400, y: 0, z } },
        end: { kind: 'free', pos: { x: 400, y: 0, z: z + rng() * 20 } },
        roadType: pick(rng, ['street-2', 'street-4', 'avenue-4']),
      });
    }
    for (let i = 0; i < horizontal; i++) {
      const x = -350 + i * 100 + rng() * 20;
      net.drawRoad({
        start: { kind: 'free', pos: { x, y: 0, z: -400 } },
        end: { kind: 'free', pos: { x: x + rng() * 20, y: 0, z: 400 } },
        roadType: pick(rng, ['street-2', 'street-4', 'avenue-4']),
      });
    }
    expect(checkNetworkInvariants(net)).toEqual([]);
    const junctions = net.nodes.filter((n) => n.segments.length === 4);
    expect(junctions.length).toBe(64);
    for (const n of junctions) {
      expect(net.nodeGeom(n.id)!.outlineSimplified).toBe(false);
      expect(polygonSelfIntersects(net.nodeGeom(n.id)!.outline)).toBe(false);
    }
    const stuck = net.laneGraph.lanes.filter((l) => l.next.length === 0 && l.vehicleKind === 'drive');
    expect(stuck).toEqual([]);
  });
});
