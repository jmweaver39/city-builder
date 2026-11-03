import { describe, expect, it } from 'vitest';
import { RoadNetwork, defaultSignalPlan, effectiveControl, type Id } from '../../src/core';
import { Simulation } from '../../src/sim';
import { CTL_ALLSTOP, CTL_PRIORITY, CTL_SIGNAL } from '../../src/sim/junctions';
import { GHOST_COLORS } from '../../src/tools/junctionControl';
import { rig } from './helpers';

const free = (x: number, z: number) => ({ kind: 'free' as const, pos: { x, y: 0, z } });

/** A main road along x with a side street off to +z at the origin, and a 4-way at x = 200. */
function streets(net: RoadNetwork): { tee: Id; cross: Id } {
  net.drawRoad({ start: free(-300, 0), end: free(400, 0), roadType: 'avenue-4' });
  net.drawRoad({ start: free(0, 0), end: free(0, 200), roadType: 'street-2' });
  net.drawRoad({ start: free(200, -200), end: free(200, 200), roadType: 'street-2' });
  const tee = net.nodes.find((n) => n.segments.length === 3)!.id;
  const cross = net.nodes.find((n) => n.segments.length === 4)!.id;
  return { tee, cross };
}

const armAt = (net: RoadNetwork, node: Id, dir: 'x+' | 'x-' | 'z+' | 'z-'): Id => {
  const arm = net.nodeGeom(node)!.arms.find((a) => {
    const d = a.dir;
    if (dir === 'x+') return d.x > 0.9;
    if (dir === 'x-') return d.x < -0.9;
    if (dir === 'z+') return d.z > 0.9;
    return d.z < -0.9;
  })!;
  return arm.segmentId;
};

/** Control kind of every connector at a node, as the running sim sees it. */
function simControl(sim: Simulation, node: Id): number[] {
  const { g, jn } = sim.state;
  return (g.graph.connectorsAt.get(node) ?? []).map((c) => jn.ctl[c]);
}

describe('one-click junction control', () => {
  it('puts stop signs on the minor road with one click, and the sim obeys at once', () => {
    const r = rig();
    const { tee } = streets(r.net);
    const sim = new Simulation(r.net);
    sim.step();
    r.tools.setTool('junction');
    r.tools.settings.junctionControl = 'stop';
    const h0 = r.history.size;
    r.click(0, 0);
    const minor = armAt(r.net, tee, 'z+');
    const ctl = effectiveControl(r.net, tee);
    expect(ctl.kind).toBe('priority');
    expect(ctl.signs[minor]).toBe('stop');
    expect(ctl.signs[armAt(r.net, tee, 'x+')]).toBe('priority');
    expect(ctl.signs[armAt(r.net, tee, 'x-')]).toBe('priority');
    expect(r.tools.active.id).toBe('junction');
    // The sim reads it on its next step.
    sim.step();
    const { g, jn } = sim.state;
    const fromMinor = (g.graph.connectorsAt.get(tee) ?? []).filter((c) => g.graph.lanes[g.fromLane[c]].segmentId === minor);
    expect(fromMinor.length).toBeGreaterThan(0);
    expect(fromMinor.every((c) => jn.sign[c] === 0)).toBe(true);
    expect(simControl(sim, tee).every((k) => k === CTL_PRIORITY)).toBe(true);
    // One undo step back to auto.
    expect(r.history.size).toBe(h0 + 1);
    r.history.undo();
    expect(r.net.getNode(tee)!.control.mode).toBe('auto');
  });

  it('signs just one arm when an arm is clicked', () => {
    const r = rig();
    const { cross } = streets(r.net);
    r.tools.setTool('junction');
    r.tools.settings.junctionControl = 'yield';
    const before = effectiveControl(r.net, cross).signs;
    // On the north arm, 30 m out from the junction.
    r.click(200, -30);
    const after = effectiveControl(r.net, cross).signs;
    const north = armAt(r.net, cross, 'z-');
    expect(after[north]).toBe('yield');
    for (const [seg, sign] of Object.entries(after)) {
      if (Number(seg) !== north) expect(sign).toBe(before[Number(seg)]);
    }
    // Now stop just the south arm: the north one keeps its yield.
    r.tools.settings.junctionControl = 'stop';
    r.click(200, 30);
    const again = effectiveControl(r.net, cross).signs;
    expect(again[armAt(r.net, cross, 'z+')]).toBe('stop');
    expect(again[north]).toBe('yield');
  });

  it('applies traffic lights with the default plan, and the sim runs them', () => {
    const r = rig();
    const { cross } = streets(r.net);
    const sim = new Simulation(r.net);
    sim.step();
    r.tools.setTool('junction');
    r.tools.settings.junctionControl = 'signal';
    const h0 = r.history.size;
    r.click(200, 0);
    const node = r.net.getNode(cross)!;
    expect(node.control.mode).toBe('signal');
    expect(node.control.signal).toEqual(defaultSignalPlan(r.net, cross, 'opposing'));
    sim.step();
    expect(simControl(sim, cross).every((k) => k === CTL_SIGNAL)).toBe(true);
    expect(sim.signalStatus(cross)).not.toBeNull();
    // All-way stop, then auto, each one click.
    r.tools.settings.junctionControl = 'allStop';
    r.click(200, 0);
    sim.step();
    expect(simControl(sim, cross).every((k) => k === CTL_ALLSTOP)).toBe(true);
    r.tools.settings.junctionControl = 'auto';
    r.click(200, 0);
    expect(r.net.getNode(cross)!.control.mode).toBe('auto');
    expect(r.history.size).toBe(h0 + 3);
  });

  it('stays active so you can click down a street, and a repeat click adds no step', () => {
    const r = rig();
    r.net.drawRoad({ start: free(-50, 0), end: free(650, 0), roadType: 'street-2' });
    for (const x of [100, 300, 500]) r.net.drawRoad({ start: free(x, -150), end: free(x, 150), roadType: 'street-2' });
    r.tools.setTool('junction');
    r.tools.settings.junctionControl = 'allStop';
    const h0 = r.history.size;
    for (const x of [100, 300, 500]) r.click(x, 0);
    const junctions = r.net.nodes.filter((n) => n.segments.length === 4);
    expect(junctions).toHaveLength(3);
    expect(junctions.every((n) => n.control.mode === 'allStop')).toBe(true);
    expect(r.history.size).toBe(h0 + 3);
    r.click(300, 0);
    expect(r.history.size).toBe(h0 + 3);
  });

  it('refuses highway merges and splits politely', () => {
    const r = rig();
    r.net.drawRoad({ start: free(-400, 0), end: free(400, 0), roadType: 'highway-3' });
    const main = r.net.segments[0].id;
    r.net.drawRoad({ start: { kind: 'segment', id: main, t: 0.5 }, end: free(300, 60), roadType: 'ramp-1' });
    const split = r.net.nodes.find((n) => n.segments.length === 3)!;
    r.tools.setTool('junction');
    r.tools.settings.junctionControl = 'signal';
    const h0 = r.history.size;
    r.click(split.pos.x, split.pos.z);
    expect(r.toasts.join(' ')).toMatch(/free-flow/);
    expect(r.history.size).toBe(h0);
    expect(split.control.mode).toBe('auto');
  });

  it('refuses to sign an arm traffic only leaves by', () => {
    const r = rig();
    r.net.drawRoad({ start: free(-200, 0), end: free(200, 0), roadType: 'street-2' });
    r.net.drawRoad({ start: free(0, 0), end: free(0, 200), roadType: 'street-2-oneway' });
    r.tools.setTool('junction');
    r.tools.settings.junctionControl = 'stop';
    r.click(0, 40);
    expect(r.toasts.join(' ')).toMatch(/only leaves/);
  });

  it('shows a ghost of signs or arrows while hovering', () => {
    const r = rig();
    const { tee } = streets(r.net);
    r.tools.setTool('junction');
    r.tools.settings.junctionControl = 'stop';
    r.hover(0, 0);
    const stops = r.view.marks.filter((m) => m.kind === 'line' && m.color === GHOST_COLORS.stop);
    expect(stops).toHaveLength(1);
    expect(r.net.getNode(tee)!.control.mode).toBe('auto');
    r.tools.settings.junctionControl = 'signal';
    r.tools.settingsChanged();
    expect(r.view.marks.some((m) => m.kind === 'line' && m.color === GHOST_COLORS.go)).toBe(true);
    expect(r.view.marks.some((m) => m.kind === 'label')).toBe(true);
    expect(r.view.highlight).toBeNull();
  });

  it('picks cards by hotkey while the tool is active', () => {
    const r = rig();
    r.tools.setTool('junction');
    expect(r.key('g')).toBe(true);
    expect(r.tools.settings.junctionControl).toBe('signal');
    r.key('x');
    expect(r.tools.settings.junctionControl).toBe('stop');
    r.key('Y');
    expect(r.tools.settings.junctionControl).toBe('yield');
  });

  it('still opens the detailed editor in inspect mode', () => {
    const r = rig();
    const { cross } = streets(r.net);
    r.tools.setTool('junction');
    r.tools.settings.junctionControl = 'inspect';
    const h0 = r.history.size;
    r.click(200, 0);
    expect(r.inspected).toContainEqual({ kind: 'junction', id: cross });
    expect(r.history.size).toBe(h0);
  });
});
