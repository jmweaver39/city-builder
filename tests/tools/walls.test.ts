import { beforeEach, describe, expect, it } from 'vitest';
import { QUAY_LINE, bankPoint, groundHeight, riverCentreZ, type Id } from '../../src/core';
import { rig, type Rig } from './helpers';

let r: Rig;
beforeEach(() => {
  r = rig();
});

/** Three ground segments along z = -1200 from x = 0 to 300, drawn left to right. */
function row(): Id[] {
  r.tools.setTool('road');
  r.click(0, -1200);
  r.click(100, -1200);
  r.click(200, -1200);
  r.click(300, -1200);
  r.rightClick();
  return r.net.segments.map((s) => s.id);
}

const upgrade = (what: 'road' | 'structure' | 'barriers') => {
  r.tools.setTool('road');
  r.tools.settings.drawMode = 'upgrade';
  r.tools.settings.walls.upgrade = what;
  r.tools.settingsChanged();
};

describe('Upgrade paints structure and barriers', () => {
  it('sweeps a structure and wall style along a road in one undo step', () => {
    const ids = row();
    upgrade('structure');
    Object.assign(r.tools.settings.walls, { mode: 'retaining', sides: 'right', style: 'brick', top: 'railing' });
    const steps = r.history.size;
    r.drag([[50, -1200], [150, -1200], [250, -1200]]);
    for (const id of ids) {
      const s = r.net.getSegment(id)!.overrides.structure!;
      expect(s.mode).toBe('retaining');
      expect(s.right).toMatchObject({ on: true, style: 'brick', top: 'railing' });
      expect(s.left).toMatchObject({ on: false });
    }
    expect(r.history.size).toBe(steps + 1);
    r.history.undo();
    expect(ids.every((id) => !r.net.getSegment(id)!.overrides.structure)).toBe(true);
  });

  it('adds sound barriers, with left and right following the sweep', () => {
    const ids = row();
    upgrade('barriers');
    Object.assign(r.tools.settings.walls, { barrier: 'concrete', barrierHeight: 4, barrierSides: 'right' });
    // Swept right to left: the sweep's right is the road's left.
    r.drag([[290, -1200], [250, -1200], [150, -1200], [50, -1200]]);
    for (const id of ids) {
      const b = r.net.getSegment(id)!.overrides.barriers!;
      expect(b.left).toEqual({ kind: 'concrete', height: 4 });
      expect(b.right).toBeUndefined();
    }
    // Swept left to right on the middle piece: its right side too.
    r.tools.settings.walls.barrier = 'acrylic';
    r.drag([[110, -1200], [150, -1200], [190, -1200]]);
    const mid = r.net.getSegment(ids[1])!.overrides.barriers!;
    expect(mid.left?.kind).toBe('concrete');
    expect(mid.right?.kind).toBe('acrylic');
    // 'None' clears the chosen side.
    r.tools.settings.walls.barrier = 'none';
    r.tools.settings.walls.barrierSides = 'both';
    r.click(150, -1200);
    expect(r.net.getSegment(ids[1])!.overrides.barriers).toBeUndefined();
  });

  it('refuses walls that would stand in another road', () => {
    row();
    // A road alongside, 7 m away.
    r.net.drawRoad({ start: { kind: 'free', pos: { x: -50, y: 0, z: -1193 } }, end: { kind: 'free', pos: { x: 350, y: 0, z: -1193 } }, roadType: 'street-2' });
    // Raise the middle of the first row so its walls would need room.
    const first = r.net.segments[1];
    r.net.moveNode(first.b, { x: 200, y: 8, z: -1200 });
    upgrade('structure');
    Object.assign(r.tools.settings.walls, { mode: 'retaining', sides: 'both' });
    r.click(150, -1200);
    expect(r.net.getSegment(first.id)!.overrides.structure).toBeUndefined();
    expect(r.toasts.some((t) => /wall/i.test(t))).toBe(true);
  });
});

describe('drawing with a structure', () => {
  it('builds new roads with the panel structure and outlines the footprint', () => {
    r.tools.setTool('road');
    Object.assign(r.tools.settings.walls, { mode: 'embankment', sides: 'left', style: 'stone', top: 'fence' });
    r.tools.settings.elevation = 8;
    r.click(0, -1200);
    r.hover(200, -1200);
    const draft = r.tools.road.currentDraft!;
    expect(draft.footprint?.left.length).toBeGreaterThan(3);
    r.click(200, -1200);
    const seg = r.net.segments[0];
    expect(seg.overrides.structure).toMatchObject({ mode: 'embankment', left: { on: true, style: 'stone', top: 'fence' }, right: { on: false } });
  });
});

describe('Quay tool', () => {
  it('builds a quay along the bank from two clicks, extends it, and bulldozes it', () => {
    r.tools.setTool('quay');
    r.tools.settings.walls.quayStyle = 'stone';
    r.tools.settings.walls.quayTop = 'bollards';
    const a = bankPoint(-300, 1, QUAY_LINE + 5);
    const b = bankPoint(-150, 1, QUAY_LINE + 8);
    const c = bankPoint(-60, 1, QUAY_LINE + 2);
    r.click(a.x, a.z);
    r.click(b.x, b.z);
    expect(r.net.quays).toHaveLength(1);
    const q = r.net.quays[0];
    expect(q.bank).toBe(1);
    expect(q.x0).toBeCloseTo(-300, 0);
    expect(q.x1).toBeCloseTo(-150, 0);
    expect(q.style).toBe('stone');
    // The next click carries on and extends the same quay.
    r.click(c.x, c.z);
    expect(r.net.quays).toHaveLength(1);
    expect(r.net.quays[0].x1).toBeCloseTo(-60, 0);
    // The land behind it is at road level.
    const behind = bankPoint(-200, 1, QUAY_LINE + 3);
    expect(groundHeight(r.net, behind.x, behind.z)).toBeCloseTo(0, 6);
    // Far from the river nothing snaps.
    r.rightClick();
    r.click(0, riverCentreZ(0) - 400);
    expect(r.net.quays).toHaveLength(1);
    // Bulldoze removes it, and undo brings it back.
    r.tools.setTool('bulldoze');
    r.click(behind.x, behind.z);
    expect(r.net.quays).toHaveLength(0);
    r.history.undo();
    expect(r.net.quays).toHaveLength(1);
  });
});
