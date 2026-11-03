import { describe, expect, it } from 'vitest';
import { RoadNetwork, checkNetworkInvariants, cubicLength, type Cubic } from '../../src/core';
import { TEMPLATES, previewTemplate, stampTemplate, type Placement, type TemplateDef } from '../../src/templates';
import {
  cappedTrims,
  clearanceViolations,
  deadLanes,
  draftErrors,
  leftSideRamps,
  missingMovements,
  portNamed,
  roughJoints,
  slowestConnector,
  squeezedTrims,
  steepest,
  stubLength,
  walkMainline,
} from './helpers';
import { MAIN_RUNS, SPECS } from './specs';
import { mulberry32 } from '../core/helpers';

const REQUIRED = Object.keys(SPECS);

function variants(def: TemplateDef): { label: string; params: Record<string, number> }[] {
  const lo = Object.fromEntries(def.params.map((p) => [p.key, p.min]));
  const hi = Object.fromEntries(def.params.map((p) => [p.key, p.max]));
  const out = [
    { label: 'defaults', params: {} as Record<string, number> },
    { label: 'all min', params: lo },
    { label: 'all max', params: hi },
  ];
  for (const p of def.params) {
    out.push({ label: `${p.key} min`, params: { [p.key]: p.min } });
    out.push({ label: `${p.key} max`, params: { [p.key]: p.max } });
  }
  return out;
}

const placements: { label: string; at: Placement }[] = [
  { label: 'origin', at: { pos: { x: 0, y: 0, z: 0 }, rotation: 0, elevation: 0 } },
  { label: 'turned 30', at: { pos: { x: 120, y: 0, z: -80 }, rotation: Math.PI / 6, elevation: 0 } },
  { label: 'turned 200 at +12', at: { pos: { x: -60, y: 0, z: 140 }, rotation: (200 * Math.PI) / 180, elevation: 12 } },
  { label: 'turned 90 at -8', at: { pos: { x: 40, y: 0, z: 40 }, rotation: Math.PI / 2, elevation: -8 } },
];

function stamped(id: string, params: Record<string, number>, at: Placement) {
  const net = new RoadNetwork();
  const result = stampTemplate(net, id, params, at);
  return { net, result };
}

function fullCheck(id: string, params: Record<string, number>, at: Placement): void {
  const { net, result } = stamped(id, params, at);
  expect(result.problems).toEqual([]);
  expect(result.segments.length).toBeGreaterThan(0);
  expect(checkNetworkInvariants(net)).toEqual([]);
  expect(net.segments.filter((s) => !net.segmentGeom(s.id)!.valid).map((s) => s.id)).toEqual([]);
  expect(draftErrors(net)).toEqual([]);
  expect(cappedTrims(net)).toEqual([]);
  expect(squeezedTrims(net)).toEqual([]);
  expect(clearanceViolations(net)).toEqual([]);
  expect(steepest(net).grade).toBeLessThanOrEqual(0.08);
  expect(missingMovements(net, result, SPECS[id].moves)).toEqual([]);
  expect(deadLanes(net, result)).toEqual([]);
  expect(leftSideRamps(net)).toEqual([]);
  expect(roughJoints(net)).toEqual([]);
  for (const port of result.ports) {
    // Long enough to merge, and an open dead end for the auto gateway.
    expect(net.getNode(port.nodeId)!.segments.length).toBe(1);
    expect(stubLength(net, port.nodeId), `stub ${port.name}`).toBeGreaterThanOrEqual(id.startsWith('roundabout') ? 69.9 : 99.9);
  }
  for (const run of MAIN_RUNS[id] ?? []) {
    const walk = walkMainline(net, portNamed(result, run.from).nodeId);
    expect(walk.end, `${run.from} should reach ${run.to}`).toBe(portNamed(result, run.to).nodeId);
    expect(walk.minDot, `${run.from} direction of travel`).toBeGreaterThan(0.9);
    // Collector roads take all four ramps of a side, so the mainline sees just two.
    const onMainline = id === 'cloverleaf' && params.collector === 1 && /^[WE]/.test(run.from) ? ['exit', 'entry'] : run.events;
    expect(walk.events, `${run.from} order of junctions`).toEqual(onMainline);
    // Mainline traffic keeps moving through every junction.
    expect(slowestConnector(net, walk.lanes), `${run.from} connector speed`).toBeGreaterThan(70 / 3.6);
  }
}

describe('template catalogue', () => {
  it('lists every required template with well-formed params', () => {
    expect(TEMPLATES.map((t) => t.id).sort()).toEqual([...REQUIRED].sort());
    for (const t of TEMPLATES) {
      expect(['roundabout', 'interchange', 'intersection']).toContain(t.category);
      for (const p of t.params) {
        expect(p.min).toBeLessThanOrEqual(p.default);
        expect(p.default).toBeLessThanOrEqual(p.max);
        expect(p.step).toBeGreaterThan(0);
      }
    }
  });
});

describe.each(TEMPLATES.map((t) => [t.id, t] as const))('%s', (id, def) => {
  it.each(variants(def).map((v) => [v.label, v.params] as const))('holds together with %s', (_label, params) => {
    fullCheck(id, params, placements[0].at);
  });

  it.each(placements.map((p) => [p.label, p.at] as const))('holds together when %s', (_label, at) => {
    fullCheck(id, {}, at);
  });

  // The sliders can land on any combination, not just the corners.
  it('holds together across random settings', () => {
    const random = mulberry32(id.length * 977 + 13);
    for (let i = 0; i < 16; i++) {
      const params = Object.fromEntries(
        def.params.map((p) => {
          const steps = Math.round((p.max - p.min) / p.step);
          return [p.key, p.min + Math.floor(random() * (steps + 1)) * p.step];
        }),
      );
      fullCheck(id, params, placements[i % placements.length].at);
    }
  });

  it('previews exactly what it stamps', () => {
    for (const { at } of placements) {
      const curves = previewTemplate(id, {}, at);
      const { net, result } = stamped(id, {}, at);
      expect(result.segments.length).toBe(curves.length);
      result.segments.forEach((seg, i) => {
        const a = net.cubicOf(seg);
        const b: Cubic = curves[i];
        for (const k of ['p0', 'p1', 'p2', 'p3'] as const) {
          expect(Math.hypot(a[k].x - b[k].x, a[k].y - b[k].y, a[k].z - b[k].z)).toBeLessThan(1e-6);
        }
        expect(cubicLength(b)).toBeGreaterThan(0);
      });
    }
  });
});

describe('collector-distributor cloverleaf', () => {
  it('takes every ramp off the mainline', () => {
    const { net, result } = stamped('cloverleaf', { collector: 1 }, placements[0].at);
    for (const from of ['W.in', 'E.in']) {
      expect(walkMainline(net, portNamed(result, from).nodeId).events).toEqual(['exit', 'entry']);
    }
    expect(missingMovements(net, result, SPECS.cloverleaf.moves)).toEqual([]);
  });
});

describe('placement', () => {
  const origin = placements[0].at;

  it('commits as a single change', () => {
    const net = new RoadNetwork();
    let changes = 0;
    net.onChange(() => changes++);
    stampTemplate(net, 'cloverleaf', {}, origin);
    expect(changes).toBe(1);
  });

  it('refuses a template that leaves the map and touches nothing', () => {
    const net = new RoadNetwork();
    const result = stampTemplate(net, 'stack-4', {}, { ...origin, pos: { x: 1900, y: 0, z: 1900 } });
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.segments).toEqual([]);
    expect(net.segments.length).toBe(0);
  });

  it('refuses a stack too tall for the map', () => {
    const net = new RoadNetwork();
    const result = stampTemplate(net, 'stack-4', {}, { ...origin, elevation: 36 });
    expect(result.problems.join(' ')).toMatch(/Elevation/);
    expect(net.segments.length).toBe(0);
  });

  it('reports an unknown template', () => {
    const net = new RoadNetwork();
    expect(stampTemplate(net, 'nope', {}, origin).problems.length).toBe(1);
    expect(previewTemplate('nope', {}, origin)).toEqual([]);
  });

  it('clamps params to their range', () => {
    const net = new RoadNetwork();
    const result = stampTemplate(net, 'roundabout-small', { radius: 5000, armLength: -3 }, origin);
    expect(result.problems).toEqual([]);
    expect(checkNetworkInvariants(net)).toEqual([]);
  });

  it.each([
    ['diamond', 'highway-4'],
    ['diamond', 'highway-5'],
    ['diamond', 'dual-6'],
    ['cloverleaf', 'highway-2'],
    ['on-off-ramps', 'highway-5'],
    ['lane-add-drop', 'highway-5'],
    ['lane-add-drop', 'highway-2'],
    ['stack-4', 'dual-4'],
    ['roundabout-small', 'avenue-6'],
    ['roundabout-large', 'boulevard-8'],
    ['roundabout-turbo', 'avenue-6'],
    ['signal-crossing', 'avenue-4'],
    ['signal-crossing', 'street-2'],
    // Meaningless overrides are ignored rather than breaking the template.
    ['roundabout-small', 'highway-3'],
    ['diamond', 'street-2'],
  ])('%s takes road type %s', (id, roadType) => {
    fullCheck(id, {}, { ...origin, roadType });
  });

  it('uses the road type it was given', () => {
    const net = new RoadNetwork();
    stampTemplate(net, 'diamond', {}, { ...origin, roadType: 'highway-4' });
    expect(net.segments.some((s) => s.roadType === 'highway-4')).toBe(true);
    expect(net.segments.some((s) => s.roadType === 'highway-3')).toBe(false);
  });
});
