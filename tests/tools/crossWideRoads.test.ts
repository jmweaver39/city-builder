import { describe, expect, it } from 'vitest';
import { totalHalfWidth } from '../../src/core';
import { checkChain, fitDraft, jointsOffRoads } from '../../src/tools/curveDraft';
import { rig } from './helpers';

const v = (x: number, z: number) => ({ x, y: 0, z });

describe('drawing across a wide road in one stroke', () => {
  it('a curved street over a boulevard crosses it even when a joint of the fitted curve lands on it', () => {
    let jointOnRoad = 0;
    for (const cx of [-40, -30, -20, -10, 0]) {
      const r = rig();
      r.net.drawRoad({ start: { kind: 'free', pos: v(-600, 0) }, end: { kind: 'free', pos: v(600, 0) }, roadType: 'boulevard-8' });
      r.tools.setTool('road');
      r.tools.settings.roadType = 'street-2';
      r.tools.settings.drawMode = 'curved';
      r.tools.settingsChanged();
      const hw = totalHalfWidth(r.net.roadType('boulevard-8')!);
      // How the raw fit would have been cut: a joint on the boulevard made an end there, refused as an overlap.
      const fit = fitDraft(r.net, { start: v(-90, -100), end: v(120, 80), startDir: null, endDir: null, startSlope: null, endSlope: null, control: v(cx, 0) }, 'street-2')!;
      const joints = fit.cubics.slice(0, -1).map((c) => c.p3);
      if (joints.some((p) => Math.abs(p.z) < hw)) {
        jointOnRoad++;
        const before = checkChain(r.net, fit.cubics, { kind: 'free', pos: v(-90, -100) }, { kind: 'free', pos: v(120, 80) }, 'street-2', undefined, undefined, fit);
        expect(before.state).toBe('error');
        const after = jointsOffRoads(r.net, fit.cubics, 'street-2');
        expect(after.length).toBeLessThan(fit.cubics.length);
        expect(after.slice(0, -1).every((c) => Math.abs(c.p3.z) > hw)).toBe(true);
      }
      r.click(-90, -100);
      r.click(cx, 0);
      r.click(120, 80);
      expect(r.toasts.filter((t) => /overlap/i.test(t)), `control at ${cx}`).toEqual([]);
      const streets = r.net.segments.filter((s) => s.roadType === 'street-2');
      expect(streets.length, `control at ${cx}`).toBeGreaterThanOrEqual(2);
      const junctions = r.net.nodes.filter((n) => n.segments.length >= 4);
      expect(junctions, `control at ${cx}`).toHaveLength(1);
    }
    expect(jointOnRoad).toBeGreaterThan(0);
  });

  it('a straight street across a divided highway of two one-way roads makes two crossings', () => {
    const r = rig();
    r.net.drawRoad({ start: { kind: 'free', pos: v(-600, 15) }, end: { kind: 'free', pos: v(600, 15) }, roadType: 'highway-3' });
    r.net.drawRoad({ start: { kind: 'free', pos: v(600, -15) }, end: { kind: 'free', pos: v(-600, -15) }, roadType: 'highway-3' });
    r.tools.setTool('road');
    r.tools.settings.roadType = 'street-2';
    r.tools.settings.drawMode = 'straight';
    r.tools.settingsChanged();
    r.click(0, -120);
    r.click(0, 120);
    const crossings = r.net.nodes.filter((n) => n.control.highwayAccess === 'crossing');
    expect(crossings).toHaveLength(2);
    expect(r.net.segments.filter((s) => s.roadType === 'street-2')).toHaveLength(3);
  });
});
