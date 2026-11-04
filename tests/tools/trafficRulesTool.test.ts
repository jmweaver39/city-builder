import { describe, expect, it } from 'vitest';
import { RoadNetwork, defaultSignalPlan, type Id } from '../../src/core';
import type { ToolMark } from '../../src/render/api';
import type { TrafficRulesTool } from '../../src/tools/TrafficRulesTool';
import type { RuleMode } from '../../src/tools/trafficRuleSettings';
import { rig, type Rig } from './helpers';

const v = (x: number, z: number) => ({ x, y: 0, z });

function cross(): { net: RoadNetwork; hub: Id; segs: Id[] } {
  const net = new RoadNetwork();
  const hub = net.addNode(v(0, 0));
  const segs = [v(300, 0), v(-300, 0), v(0, 300), v(0, -300)].map((p) => net.addSegment(hub, net.addNode(p), { roadType: 'street-4' }));
  return { net, hub, segs };
}

function open(r: Rig, mode: RuleMode): TrafficRulesTool {
  r.tools.settings.trafficRules.mode = mode;
  r.tools.setTool('trafficRules');
  r.tools.settingsChanged();
  return r.tools.trafficRules;
}

const icons = (r: Rig) => r.view.marks.filter((m): m is Extract<ToolMark, { kind: 'icon' }> => m.kind === 'icon');

describe('the traffic rules tool', () => {
  it('lane arrows: hovering a junction shows arrows, clicking one toggles it, undo takes it back', () => {
    const { net, hub } = cross();
    const r = rig(null, net);
    const tool = open(r, 'arrows');
    r.hover(0, 0);
    expect(tool.node).toBe(hub);
    const shown = icons(r);
    expect(shown.length).toBeGreaterThan(8);
    // Click an arrow that is on, as long as its lane keeps another.
    const target = shown.find((m) => m.svg.includes('#1e9bd7'))!;
    r.click(target.pos.x, target.pos.z);
    expect(Object.keys(net.getNode(hub)!.control.rules?.laneArrows ?? {}).length).toBe(1);
    r.history.undo();
    expect(net.getNode(hub)!.control.rules).toBeUndefined();
  });

  it('speed limits: a click sets the road, Shift+click one lane', () => {
    const { net, segs } = cross();
    const r = rig(null, net);
    open(r, 'speed');
    r.tools.settings.trafficRules.speed = 80;
    r.click(150, 0);
    expect(net.getSegment(segs[0])!.overrides.speedKmh).toBe(80);
    r.tools.settings.trafficRules.speed = 30;
    r.click(150, 4, { shift: true });
    expect(Object.values(net.getSegment(segs[0])!.overrides.laneSpeeds ?? {})).toEqual([30]);
    // The overlay shows signs.
    expect(icons(r).some((m) => m.svg.includes('>30<'))).toBe(true);
  });

  it('vehicles: a click bans the picked class from the road and shows it', () => {
    const { net, segs } = cross();
    const r = rig(null, net);
    open(r, 'vehicles');
    r.tools.settings.trafficRules.vehicle = 'truck';
    r.click(0, 150);
    const bans = net.getSegment(segs[2])!.overrides.laneBans!;
    expect(Object.values(bans).every((l) => l.includes('truck'))).toBe(true);
    r.click(0, 150);
    expect(net.getSegment(segs[2])!.overrides.laneBans).toBeUndefined();
  });

  it('junction rules: icons per arm toggle a restriction', () => {
    const { net, hub } = cross();
    const r = rig(null, net);
    const tool = open(r, 'junction');
    r.tools.settings.trafficRules.rule = 'uturn';
    r.tools.settingsChanged();
    r.hover(0, 0);
    expect(tool.node).toBe(hub);
    const shown = icons(r);
    expect(shown.length).toBe(4);
    r.click(shown[0].pos.x, shown[0].pos.z);
    const arms = net.getNode(hub)!.control.rules?.arms ?? {};
    expect(Object.values(arms).some((a) => a.uturn === true)).toBe(true);
  });

  it('priority road and copy, paste of a timed plan', () => {
    const net = new RoadNetwork();
    const nodes = [-400, -150, 150, 400].map((x) => net.addNode(v(x, 0)));
    const main = [0, 1, 2].map((i) => net.addSegment(nodes[i], nodes[i + 1], { roadType: 'avenue-4' }));
    for (const i of [1, 2]) {
      net.addSegment(nodes[i], net.addNode(v(nodes[i] === nodes[1] ? -150 : 150, 200)), { roadType: 'street-2' });
      net.addSegment(nodes[i], net.addNode(v(nodes[i] === nodes[1] ? -150 : 150, -200)), { roadType: 'street-2' });
    }
    const r = rig(null, net);
    open(r, 'priority');
    r.click(0, 0);
    expect(net.getNode(nodes[1])!.control.mode).toBe('priority');
    expect(net.getNode(nodes[1])!.control.signs[main[0]]).toBe('priority');
    // Lights on one, then copy it to the other.
    net.setJunctionControl(nodes[1], { mode: 'signal', signal: defaultSignalPlan(net, nodes[1], 'split') });
    const tool = open(r, 'timed');
    r.tools.settings.trafficRules.timed = 'copy';
    r.click(-150, 0);
    expect(tool.clip).not.toBeNull();
    expect(r.tools.settings.trafficRules.timed).toBe('paste');
    r.click(150, 0);
    expect(net.getNode(nodes[2])!.control.mode).toBe('signal');
    expect(net.getNode(nodes[2])!.control.signal!.phases.length).toBe(net.getNode(nodes[1])!.control.signal!.phases.length);
    // A green wave over both.
    r.tools.settings.trafficRules.timed = 'wave';
    r.tools.settingsChanged();
    r.click(-150, 0);
    r.click(150, 0);
    expect(tool.wave.length).toBe(2);
    r.key('Enter');
    expect(tool.wave.length).toBe(0);
    expect(net.getNode(nodes[2])!.control.signal!.kind).toBe('fixed');
  });
});
