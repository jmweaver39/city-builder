import { beforeEach, describe, expect, it } from 'vitest';
import { checkNetworkInvariants, cubicTangentXZ, distXZ, dotXZ, type Id } from '../../src/core';
import { buildCubic, readout, withGrade } from '../../src/tools/draft';
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

describe('Straight mode', () => {
  it('draws a road in two clicks and continues from its end', () => {
    r.click(0, 0);
    expect(r.tools.road.stage).toBe('end');
    r.click(120, 0);
    expect(r.net.segments).toHaveLength(1);
    r.hover(240, 0);
    expect(r.view.previews).toHaveLength(1);
    expect(r.tools.road.stage).toBe('end');
    r.click(240, 0);
    expect(r.net.segments).toHaveLength(2);
    expect(r.net.nodes).toHaveLength(3);
    expect(checkNetworkInvariants(r.net)).toEqual([]);
  });

  it('right click drops the continuation and then does nothing', () => {
    r.click(0, 0);
    r.click(120, 0);
    r.rightClick();
    expect(r.tools.road.stage).toBe('start');
    r.rightClick();
    expect(r.tools.active.id).toBe('road');
    expect(r.net.segments).toHaveLength(1);
  });

  it('Esc leaves the tool and clears the ghost', () => {
    r.click(0, 0);
    r.hover(100, 0);
    r.tools.escape();
    expect(r.tools.active.id).toBe('select');
    expect(r.view.previews).toEqual([]);
    expect(r.view.marks).toEqual([]);
  });

  it('a short road is blocked with the reason, and nothing changes', () => {
    r.click(0, 0);
    const v = r.net.version;
    r.click(2, 0, { ctrl: true });
    expect(r.net.version).toBe(v);
    expect(r.toasts.at(-1)).toMatch(/too short/i);
    expect(r.tools.road.currentDraft?.state).toBe('error');
    expect(r.view.previews[0].state).toBe('error');
    expect(r.tools.hud?.tone).toBe('error');
    expect(r.tools.hud?.notes.join()).toMatch(/too short/i);
  });

  it('crossing a road at grade makes a junction and shows it first', () => {
    r.click(-100, 0);
    r.click(100, 0);
    r.rightClick();
    r.click(0, -100);
    r.hover(0, 100);
    expect(r.tools.road.currentDraft?.crossings).toHaveLength(1);
    expect(r.tools.road.currentDraft?.crossings[0].atGrade).toBe(true);
    expect(r.tools.hud?.lines.join()).toMatch(/Junctions: 1/);
    expect(r.view.marks.some((m) => m.kind === 'ring')).toBe(true);
    r.click(0, 100);
    expect(r.net.segments).toHaveLength(4);
    expect(r.net.nodes.some((n) => n.segments.length === 4)).toBe(true);
    expect(checkNetworkInvariants(r.net)).toEqual([]);
  });

  it('starting on a road splits it, and ending on a node reuses it', () => {
    r.click(-100, 0);
    r.click(100, 0);
    r.rightClick();
    r.click(0, 0);
    r.click(0, 80);
    expect(r.net.segments).toHaveLength(3);
    r.rightClick();
    const before = r.net.nodes.length;
    r.click(0, 80);
    r.click(100, 0);
    expect(r.net.nodes).toHaveLength(before);
  });

  it('works with a custom road type', () => {
    r.net.setCustomRoadType({ ...r.net.roadType('street-2')!, id: 'custom-a', name: 'Mine', category: 'custom' });
    r.tools.settings.roadType = 'custom-a';
    r.click(0, 0);
    r.click(100, 0);
    expect(r.net.segments[0].roadType).toBe('custom-a');
  });

  it('Ctrl disables snapping', () => {
    r.click(0, 0);
    r.click(100, 0);
    r.rightClick();
    r.click(3, 3, { ctrl: true });
    const n = r.net.nodes.length;
    r.click(3, 90, { ctrl: true });
    expect(r.net.nodes).toHaveLength(n + 2);
  });
});

describe('Curved mode', () => {
  beforeEach(() => mode('curved'));

  it('takes start, control and end', () => {
    r.click(0, 0);
    expect(r.tools.road.stage).toBe('control');
    r.click(100, 0, { ctrl: true });
    expect(r.tools.road.stage).toBe('end');
    r.hover(100, 100, { ctrl: true });
    expect(r.tools.hud?.lines.join()).toMatch(/Radius/);
    r.click(100, 100, { ctrl: true });
    expect(r.net.segments).toHaveLength(1);
    const c = r.net.cubicOf(r.net.segments[0].id);
    expect(c.p1.x).toBeCloseTo((100 * 2) / 3, 3);
    expect(c.p1.z).toBeCloseTo(0, 6);
    expect(c.p2.z).toBeCloseTo(100 / 3, 3);
  });

  it('right click steps back through control then start', () => {
    r.click(0, 0);
    r.click(100, 0);
    r.rightClick();
    expect(r.tools.road.stage).toBe('control');
    r.rightClick();
    expect(r.tools.road.stage).toBe('start');
  });

  it('continues the tangent of a dead end by default', () => {
    r.tools.settings.drawMode = 'straight';
    r.click(0, 0);
    r.click(100, 0);
    r.rightClick();
    mode('curved');
    r.click(100, 0);
    r.click(160, 40);
    r.click(170, 120);
    const curve = r.net.segments.find((s) => s.id !== r.net.segments[0].id)!;
    const t = cubicTangentXZ(r.net.cubicOf(curve.id), 0);
    expect(t.x).toBeCloseTo(1, 4);
    expect(t.z).toBeCloseTo(0, 4);
  });
});

describe('Freeform mode', () => {
  it('continues the previous tangent across pieces', () => {
    mode('freeform');
    r.click(0, 0);
    r.click(100, 0);
    r.click(190, 50);
    r.click(250, 130);
    const ids = r.net.segments.map((s) => s.id);
    for (let i = 0; i + 1 < ids.length; i++) {
      const a = cubicTangentXZ(r.net.cubicOf(ids[i]), 1);
      const b = cubicTangentXZ(r.net.cubicOf(ids[i + 1]), 0);
      expect(dotXZ(a, b)).toBeGreaterThan(0.9999);
    }
    expect(ids).toHaveLength(3);
  });

  it('continues from an existing dead end', () => {
    r.click(0, 0);
    r.click(100, 0);
    r.rightClick();
    mode('freeform');
    r.click(100, 0);
    r.click(200, 60);
    const t = cubicTangentXZ(r.net.cubicOf(r.net.segments[1].id), 0);
    expect(t.x).toBeCloseTo(1, 4);
  });

  it('meets a dead end it lands on, running on into that road', () => {
    r.click(200, 0);
    r.click(300, 0);
    r.rightClick();
    mode('freeform');
    r.click(0, 0);
    r.click(50, 0, { ctrl: true });
    r.click(200, 0);
    const last = r.net.segments.at(-1)!;
    const t = cubicTangentXZ(r.net.cubicOf(last.id), 1);
    expect(t.x).toBeCloseTo(1, 3);
  });
});

describe('Elevation', () => {
  it('PageUp and PageDown step 4 m and clamp to the allowed range', () => {
    r.key('PageUp');
    expect(r.tools.settings.elevation).toBe(4);
    r.key('PageDown');
    r.key('PageDown');
    expect(r.tools.settings.elevation).toBe(-4);
    for (let i = 0; i < 30; i++) r.key('PageUp');
    expect(r.tools.settings.elevation).toBe(48);
    for (let i = 0; i < 30; i++) r.key('PageDown');
    expect(r.tools.settings.elevation).toBe(-24);
  });

  it('a ramp grades smoothly between its ends', () => {
    r.click(0, 0);
    r.key('PageUp');
    r.key('PageUp');
    r.click(200, 0);
    const c = r.net.cubicOf(r.net.segments[0].id);
    expect(c.p0.y).toBe(0);
    expect(c.p3.y).toBe(8);
    const g = readout(c).grade;
    expect(g).toBeGreaterThan(8 / 200);
    expect(g).toBeLessThan((8 / 200) * 1.5);
    // Eased at the free ends, so the ends rise less than a straight line would.
    expect(c.p1.y).toBeLessThan(8 / 3);
  });

  it('crosses over a road with clearance and makes no junction', () => {
    r.click(-100, 0);
    r.click(100, 0);
    r.rightClick();
    for (let i = 0; i < 3; i++) r.key('PageUp'); // 12 m
    r.click(-40, -220, { ctrl: true });
    r.click(-40, 220, { ctrl: true });
    expect(r.net.segments).toHaveLength(2);
    expect(r.net.nodes.every((n) => n.segments.length === 1)).toBe(true);
    r.rightClick();
    r.click(40, -220, { ctrl: true });
    r.hover(40, 220, { ctrl: true });
    const crossing = r.tools.road.currentDraft!.crossings[0];
    expect(crossing.atGrade).toBe(false);
    expect(r.tools.hud?.lines.join()).toMatch(/Grade separated: 1/);
  });

  it('insufficient clearance is blocked', () => {
    r.click(-100, 0);
    r.click(100, 0);
    r.rightClick();
    r.key('PageUp');
    r.click(0, -100, { ctrl: true });
    r.hover(0, 100, { ctrl: true });
    expect(r.tools.road.currentDraft?.state).toBe('error');
    const before = r.net.segments.length;
    r.click(0, 100, { ctrl: true });
    expect(r.net.segments).toHaveLength(before);
    expect(r.toasts.at(-1)).toMatch(/clearance/);
  });

  it('starting on an elevated road picks up its height', () => {
    r.key('PageUp');
    r.key('PageUp');
    r.click(0, 0);
    r.click(100, 0);
    r.rightClick();
    r.key('PageDown');
    r.key('PageDown');
    r.tools.settings.elevation = 0;
    r.click(100, 0);
    expect(r.tools.settings.elevation).toBe(8);
  });

  it('warnings do not block placement', () => {
    r.tools.settings.roadType = 'highway-3';
    r.click(0, 0);
    r.key('PageUp');
    r.key('PageUp');
    r.click(90, 0);
    expect(r.net.segments).toHaveLength(1);
  });
});

describe('Live readouts', () => {
  it('shows length, radius, slope and the angle at the snap', () => {
    r.click(0, 0);
    r.click(100, 0);
    r.hover(100 + 80 * Math.cos(Math.PI / 4), 80 * Math.sin(Math.PI / 4));
    const lines = r.tools.hud!.lines.join('|');
    expect(lines).toMatch(/Length 80\.0 m/);
    expect(lines).toMatch(/Radius straight/);
    expect(lines).toMatch(/Slope 0\.0%/);
    expect(lines).toMatch(/Angle 45\.0/);
    expect(lines).toMatch(/Ground 0 m/);
  });

  it('shows the elevation', () => {
    r.key('PageUp');
    r.hover(0, 0);
    expect(r.tools.hud!.lines.join()).toMatch(/Elevated \+4 m/);
    r.key('PageDown');
    r.key('PageDown');
    r.hover(0, 0);
    expect(r.tools.hud!.lines.join()).toMatch(/Tunnel -4 m/);
  });
});

describe('Upgrade mode', () => {
  function row(): Id[] {
    r.click(0, 0);
    r.click(100, 0);
    r.click(200, 0);
    r.click(300, 0);
    r.rightClick();
    return r.net.segments.map((s) => s.id);
  }

  it('changes one road on a click and keeps its direction', () => {
    const ids = row();
    const before = { a: r.net.getSegment(ids[0])!.a, b: r.net.getSegment(ids[0])!.b };
    mode('upgrade');
    r.tools.settings.roadType = 'avenue-4';
    r.click(50, 0);
    expect(r.net.getSegment(ids[0])).toMatchObject({ roadType: 'avenue-4', ...before });
    expect(r.net.getSegment(ids[1])!.roadType).toBe('street-2');
  });

  it('a drag across roads is one undo step', () => {
    const ids = row();
    mode('upgrade');
    r.tools.settings.roadType = 'avenue-4';
    const steps = r.history.size;
    r.drag([[50, 0], [150, 0], [250, 0]]);
    expect(ids.map((id) => r.net.getSegment(id)!.roadType)).toEqual(['avenue-4', 'avenue-4', 'avenue-4']);
    expect(r.history.size).toBe(steps + 1);
    r.history.undo();
    expect(r.net.segments.map((s) => s.roadType)).toEqual(['street-2', 'street-2', 'street-2']);
  });

});

describe('draft shapes', () => {
  const p = (x: number, z: number, y = 0) => ({ x, y, z });

  it('a freeform piece is a true arc: both handles equal and the end tangent mirrored', () => {
    const c = buildCubic('freeform', { start: p(0, 0), end: p(100, 100), startDir: { x: 1, y: 0, z: 0 } }, null);
    expect(distXZ(c.p0, c.p1)).toBeCloseTo(distXZ(c.p2, c.p3), 6);
    expect(cubicTangentXZ(c, 1).z).toBeCloseTo(1, 4);
    expect(readout(c).radius).toBeGreaterThan(95);
    expect(readout(c).radius).toBeLessThan(105);
  });

  it('straight stays exactly on the chord', () => {
    const c = buildCubic('straight', { start: p(0, 0), end: p(90, 0) }, null);
    expect(c.p1).toMatchObject({ x: 30, z: 0 });
  });

  it('carries a slope into the next piece, within limits', () => {
    const flat = { p0: p(0, 0), p1: p(30, 0), p2: p(60, 0), p3: p(90, 0, 9) };
    const carried = withGrade(flat, { startSlope: 0.1 });
    expect((carried.p1.y - carried.p0.y) / 30).toBeCloseTo(0.1, 6);
    const level = withGrade({ ...flat, p3: p(90, 0) }, { startSlope: 0.1 });
    expect(level.p1.y).toBeLessThan(1);
  });
});
