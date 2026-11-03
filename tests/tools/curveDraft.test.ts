import { beforeEach, describe, expect, it } from 'vitest';
import { checkNetworkInvariants, cubicTangentXZ, curvatureXZ, distXZ, type Id } from '../../src/core';
import { rig, type Rig } from './helpers';

let r: Rig;
beforeEach(() => {
  r = rig();
  r.tools.setTool('road');
});

const mode = (m: 'straight' | 'curved' | 'freeform' | 'upgrade') => {
  r.tools.settings.drawMode = m;
  r.tools.settingsChanged();
};

/** The segments of one drawn road, a to b, following plain joints from a dead end. */
function chainFrom(start: Id): Id[] {
  const out: Id[] = [];
  let node = start;
  for (;;) {
    const n = r.net.getNode(node)!;
    const next = n.segments.find((s) => !out.includes(s) && r.net.getSegment(s)!.a === node);
    if (next === undefined) return out;
    out.push(next);
    node = r.net.getSegment(next)!.b;
  }
}

function hudValue(prefix: string): number {
  const line = r.tools.hud!.lines.find((l) => l.startsWith(prefix))!;
  return Number(line.match(/-?[\d.]+/)![0]);
}

describe('Freeform mode draws fitted curves', () => {
  it('a ramp loop from a highway end comes out round, in plain-jointed pieces, as one undo step', () => {
    r.tools.settings.roadType = 'highway-3';
    r.click(0, 0);
    r.click(300, 0);
    r.rightClick();
    r.tools.settings.roadType = 'ramp-1';
    mode('freeform');
    const before = r.net.segments.length;
    r.click(300, 0);
    // Hover: the ghost already shows the whole fitted loop.
    r.hover(240, 60);
    const draft = r.tools.road.currentDraft!;
    expect(draft.state).not.toBe('error');
    expect(draft.cubics.length).toBeGreaterThanOrEqual(6);
    expect(r.view.previews[0].curves).toHaveLength(draft.cubics.length);
    expect(hudValue('Turn')).toBeGreaterThan(250);
    // The readout is the radius of the true arc.
    expect(hudValue('Radius')).toBeCloseTo(draft.fit!.radius, 0);
    r.click(240, 60);
    const added = r.net.segments.length - before;
    expect(added).toBe(draft.cubics.length);
    const ramp = r.net.segments.slice(before).map((s) => s.id);
    for (let i = 0; i + 1 < ramp.length; i++) {
      const joint = r.net.getSegment(ramp[i])!.b;
      expect(r.net.nodeGeom(joint)!.kind).toBe('plain');
    }
    // Round: every arc piece has the same curvature at its middle.
    const ks = ramp.map((id) => Math.abs(curvatureXZ(r.net.cubicOf(id), 0.5)));
    const kmax = Math.max(...ks);
    expect(ks.filter((k) => Math.abs(k - kmax) / kmax < 0.03).length).toBeGreaterThanOrEqual(3);
    expect(checkNetworkInvariants(r.net)).toEqual([]);
    r.history.undo();
    expect(r.net.segments.length).toBe(before);
  });

  it('carries on from the end of a fitted curve with its tangent', () => {
    mode('freeform');
    r.click(0, 0);
    r.click(100, 0);
    r.click(160, 80);
    const tail = r.net.cubicOf(r.net.segments.at(-1)!.id);
    r.hover(260, 200);
    const next = r.tools.road.currentDraft!.cubics[0];
    const a = cubicTangentXZ(tail, 1);
    const b = cubicTangentXZ(next, 0);
    expect(a.x * b.x + a.z * b.z).toBeGreaterThan(0.99999);
  });

  it('an S-curve onto a parallel dead end', () => {
    r.click(300, 50);
    r.click(400, 50);
    r.rightClick();
    r.click(0, 0);
    r.click(100, 0);
    mode('freeform');
    r.click(100, 0);
    r.hover(300, 50);
    const draft = r.tools.road.currentDraft!;
    expect(draft.fit!.kind).toBe('reverse');
    r.click(300, 50);
    // One continuous road from x = 0 to x = 400 with no junction anywhere.
    expect(r.net.nodes.filter((n) => r.net.nodeGeom(n.id)!.kind === 'junction')).toHaveLength(0);
    expect(r.net.deadEnds()).toHaveLength(2);
    expect(checkNetworkInvariants(r.net)).toEqual([]);
  });

  it('a gentle bend is one segment', () => {
    mode('freeform');
    r.click(0, 0);
    r.click(100, 0);
    const n = r.net.segments.length;
    r.click(220, 8);
    expect(r.net.segments.length).toBe(n + 1);
  });

  it('refuses a radius under the road minimum and says so', () => {
    r.tools.settings.roadType = 'highway-3';
    mode('freeform');
    r.click(0, 0);
    r.click(100, 0);
    const n = r.net.segments.length;
    r.hover(104, 10);
    expect(r.tools.road.currentDraft!.state).toBe('error');
    expect(r.tools.hud!.notes.join(' ')).toMatch(/minimum/);
    r.click(104, 10);
    expect(r.net.segments.length).toBe(n);
  });

  it('warns under the comfortable radius for a fast road', () => {
    r.tools.settings.roadType = 'highway-3';
    mode('freeform');
    r.click(0, 0);
    r.click(100, 0);
    r.hover(200, 100);
    expect(r.tools.road.currentDraft!.state).toBe('warning');
    expect(r.tools.hud!.notes.join(' ')).toMatch(/advised/);
  });
});

describe('Curved mode draws fitted curves', () => {
  beforeEach(() => mode('curved'));

  it('start, control and end give a symmetric curve with the control as the tangent intersection', () => {
    r.click(0, 0);
    r.click(100, 0, { ctrl: true });
    r.hover(100, 100, { ctrl: true });
    const draft = r.tools.road.currentDraft!;
    expect(draft.cubics.length).toBeGreaterThan(1);
    expect(Math.abs(draft.fit!.sweep)).toBeCloseTo(Math.PI / 2, 6);
    r.click(100, 100, { ctrl: true });
    const ids = r.net.segments.map((s) => s.id);
    expect(ids).toHaveLength(draft.cubics.length);
    const last = r.net.cubicOf(ids.at(-1)!);
    expect(distXZ(last.p3, { x: 100, y: 0, z: 100 })).toBeLessThan(1e-6);
    expect(checkNetworkInvariants(r.net)).toEqual([]);
  });

  it('keeps the tangent of the road it continues', () => {
    mode('straight');
    r.click(0, 0);
    r.click(100, 0);
    r.rightClick();
    const joint = r.net.getSegment(r.net.segments[0].id)!.b;
    mode('curved');
    r.click(100, 0);
    r.click(160, 40);
    r.click(170, 120);
    const added = chainFrom(joint);
    expect(added.length).toBeGreaterThan(1);
    const t = cubicTangentXZ(r.net.cubicOf(added[0]), 0);
    expect(t.x).toBeCloseTo(1, 6);
  });
});

describe('Straight mode is unchanged', () => {
  it('one segment, straight', () => {
    r.click(0, 0);
    r.click(100, 30);
    expect(r.net.segments).toHaveLength(1);
    expect(r.tools.road.currentDraft?.fit ?? null).toBeNull();
  });
});
