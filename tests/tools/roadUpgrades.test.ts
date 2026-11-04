import { beforeEach, describe, expect, it } from 'vitest';
import { RoadNetwork, type Id } from '../../src/core';
import { autoLampSide, mirrorUpgrades, placesFor, upgradeItems, upgradeZone } from '../../src/core/roadUpgrades';
import { builtinRoadType } from '../../src/core/roadTypes';
import { UpgradeStroke, jointPath } from '../../src/tools/UpgradeCardTool';
import type { RoadUpgrades, UpgradeCardId } from '../../src/core/upgradeTypes';
import { rig, type Rig } from './helpers';

let r: Rig;
beforeEach(() => {
  r = rig();
});

/** Three ground segments along z = -1200 from x = 0 to 300, drawn left to right (right side is +z). */
function row(type = 'street-2'): Id[] {
  r.tools.settings.roadType = type;
  r.tools.setTool('road');
  r.click(0, -1200);
  r.click(100, -1200);
  r.click(200, -1200);
  r.click(300, -1200);
  r.rightClick();
  return r.net.segments.map((s) => s.id);
}

function pick(card: UpgradeCardId, style?: string): void {
  r.tools.setTool('road');
  r.tools.settings.drawMode = 'upgrade';
  r.tools.settings.upgradeCards.card = card;
  if (style) r.tools.settings.upgradeCards.styles[card] = style;
  r.tools.settingsChanged();
}

const ups = (id: Id) => r.net.getSegment(id)!.overrides.upgrades;

describe('upgrade zones', () => {
  it('splits a road into a middle band and two sides', () => {
    const street = builtinRoadType('street-2')!;
    expect(upgradeZone(street, 0.3)).toBe('centre');
    expect(upgradeZone(street, 4)).toBe('right');
    expect(upgradeZone(street, -4)).toBe('left');
    const avenue = builtinRoadType('avenue-4')!;
    expect(placesFor('lights', avenue, 'centre')).toEqual(['median']);
    expect(placesFor('lights', street, 'centre')).toEqual(['left', 'right']);
    expect(placesFor('barriers', avenue, 'centre')).toEqual(['left', 'right']);
    expect(placesFor('trees', avenue, 'left')).toEqual(['left']);
  });
});

describe('upgrade cards', () => {
  it('a centre click sets both sides in one undo step', () => {
    const ids = row();
    pick('trees', 'trees');
    const steps = r.history.size;
    r.click(150, -1200);
    expect(ups(ids[1])).toEqual({ left: { trees: 'trees' }, right: { trees: 'trees' } });
    expect(ups(ids[0])).toBeUndefined();
    expect(r.history.size).toBe(steps + 1);
    r.history.undo();
    expect(ups(ids[1])).toBeUndefined();
  });

  it('a side click sets that side only', () => {
    const ids = row();
    pick('barriers', 'acrylic');
    r.tools.settings.walls.barrierHeight = 4;
    r.click(150, -1200 + 4.5);
    const b = r.net.getSegment(ids[1])!.overrides.barriers!;
    expect(b.right).toEqual({ kind: 'acrylic', height: 4 });
    expect(b.left).toBeUndefined();
    pick('lights', 'decorative');
    r.click(150, -1200 - 4.5);
    expect(ups(ids[1])).toEqual({ left: { lights: 'decorative' } });
  });

  it('puts median items on the median from the middle of a divided road', () => {
    const ids = row('avenue-4');
    pick('lights', 'double');
    r.click(150, -1200);
    expect(ups(ids[1])).toEqual({ median: { lights: 'double' } });
    const lamps = upgradeItems(r.net, ids[1]).points.filter((p) => p.kind === 'lamp');
    expect(lamps.length).toBeGreaterThan(1);
    expect(lamps.every((p) => p.place === 'median' && p.both && Math.abs(p.pos.z + 1200) < 0.01)).toBe(true);
  });

  it('a drag runs along the stretch, through plain joints it skipped, on the same side', () => {
    const ids = row();
    pick('rails', 'wbeam');
    // Pressed on the first piece's right edge, released on the third: the middle piece is filled in.
    r.drag([[50, -1200 + 4.5], [250, -1200 + 4.5]]);
    for (const id of ids) expect(ups(id)).toEqual({ right: { rail: 'wbeam' } });
    expect(jointPath(r.net, ids[0], ids[2])).toEqual([ids[1]]);
  });

  it('a drag keeps to the same side in the world over a piece drawn the other way', () => {
    const ids = row();
    r.net.reverseSegment(ids[1]);
    pick('lights', 'standard');
    r.drag([[50, -1200 + 4.5], [150, -1200 + 4.5], [250, -1200 + 4.5]]);
    expect(ups(ids[0])).toEqual({ right: { lights: 'standard' } });
    // Reversed: the world's +z side is its left.
    expect(ups(ids[1])).toEqual({ left: { lights: 'standard' } });
    expect(ups(ids[2])).toEqual({ right: { lights: 'standard' } });
  });

  it('a second click on a road that has it takes it off', () => {
    const ids = row();
    pick('trees', 'hedge');
    r.click(150, -1200);
    expect(ups(ids[1])).toEqual({ left: { trees: 'hedge' }, right: { trees: 'hedge' } });
    r.click(150, -1200);
    expect(ups(ids[1])).toBeUndefined();
    // A different style replaces rather than toggles.
    r.click(150, -1200 + 4.5);
    pick('trees', 'grass');
    r.click(150, -1200 + 4.5);
    expect(ups(ids[1])).toEqual({ right: { trees: 'grass' } });
  });

  it('remove clears a side, or everything from the middle', () => {
    const ids = row();
    pick('trees', 'trees');
    r.click(150, -1200);
    pick('barriers', 'timber');
    r.click(150, -1200 + 4.5);
    pick('stops', 'bus');
    r.click(150, -1200 - 4.5);
    pick('remove');
    r.click(150, -1200 + 4.5);
    const o = r.net.getSegment(ids[1])!.overrides;
    expect(o.upgrades).toEqual({ left: { trees: 'trees', busStop: true } });
    expect(o.barriers).toBeUndefined();
    r.click(150, -1200);
    expect(r.net.getSegment(ids[1])!.overrides.upgrades).toBeUndefined();
  });

  it('structure cards set embankment, walls and trench, a side click walls one side', () => {
    const ids = row();
    pick('structure', 'retaining');
    r.click(150, -1200 - 4.5);
    const s = r.net.getSegment(ids[1])!.overrides.structure!;
    expect(s.mode).toBe('retaining');
    expect(s.left?.on).toBe(true);
    expect(s.right?.on).toBe(false);
    r.click(150, -1200 - 4.5);
    expect(r.net.getSegment(ids[1])!.overrides.structure).toBeUndefined();
    pick('structure', 'embankment');
    r.click(150, -1200);
    expect(r.net.getSegment(ids[1])!.overrides.structure?.mode).toBe('embankment');
  });
});

describe('persistence', () => {
  it('survives split, reverse, save and load', () => {
    const net = new RoadNetwork();
    const { segments } = net.drawRoad({ start: { kind: 'free', pos: { x: 0, y: 0, z: 0 } }, end: { kind: 'free', pos: { x: 200, y: 0, z: 0 } }, roadType: 'avenue-4' });
    const id = segments[0];
    new UpgradeStroke(net, 'lights', 'highmast').visit(id, 0);
    new UpgradeStroke(net, 'trees', 'trees').visit(id, -8);
    new UpgradeStroke(net, 'stops', 'bike').visit(id, 8);
    const want: RoadUpgrades = { median: { lights: 'highmast' }, left: { trees: 'trees' }, right: { bikeRacks: true } };
    expect(net.getSegment(id)!.overrides.upgrades).toEqual(want);

    const split = net.splitSegment(id, 0.5);
    const left = split.left;
    const right = split.right!;
    expect(net.getSegment(left)!.overrides.upgrades).toEqual(want);
    expect(net.getSegment(right)!.overrides.upgrades).toEqual(want);

    net.reverseSegment(right);
    expect(net.getSegment(right)!.overrides.upgrades).toEqual({ median: { lights: 'highmast' }, right: { trees: 'trees' }, left: { bikeRacks: true } });
    expect(mirrorUpgrades(mirrorUpgrades(want))).toEqual(want);

    const loaded = new RoadNetwork(net.serialize());
    expect(loaded.getSegment(left)!.overrides.upgrades).toEqual(want);
    // An old save with no upgrades loads with none.
    const old = new RoadNetwork();
    old.drawRoad({ start: { kind: 'free', pos: { x: 0, y: 0, z: 0 } }, end: { kind: 'free', pos: { x: 100, y: 0, z: 0 } }, roadType: 'street-2' });
    const again = new RoadNetwork(old.serialize());
    expect(again.segments[0].overrides.upgrades).toBeUndefined();
  });
});

describe('lights replace the automatic lamps', () => {
  it('turns automatic lamps off where lights are set, and places its own', () => {
    const ids = row();
    const id = ids[1];
    expect(autoLampSide(r.net.getSegment(id)!.overrides, 1)).toBe(true);
    pick('lights', 'standard');
    r.click(150, -1200 + 4.5);
    const o = r.net.getSegment(id)!.overrides;
    expect(autoLampSide(o, 1)).toBe(false);
    expect(autoLampSide(o, -1)).toBe(true);
    const lamps = upgradeItems(r.net, id).points.filter((p) => p.kind === 'lamp');
    expect(lamps.length).toBeGreaterThanOrEqual(2);
    expect(lamps.every((p) => p.pos.z > -1200)).toBe(true);
    // 'No lights' also replaces them, with nothing.
    pick('lights', 'none');
    r.click(150, -1200 - 4.5);
    const o2 = r.net.getSegment(id)!.overrides;
    expect(autoLampSide(o2, -1)).toBe(false);
    expect(upgradeItems(r.net, id).points.filter((p) => p.kind === 'lamp' && p.place === 'left')).toEqual([]);
    // Median lights replace both sides.
    expect(autoLampSide({ upgrades: { median: { lights: 'double' } } }, 1)).toBe(false);
    expect(autoLampSide({ upgrades: { median: { lights: 'double' } } }, -1)).toBe(false);
  });
});

describe('upgrade card keys', () => {
  it('registers a key and palette command per card with no clashes', async () => {
    const { bindings, findConflicts, registerKeys, panelRows } = await import('../../src/ui/keymap');
    const { GUIDE_KEYS } = await import('../../src/ui/guideKeys');
    const { upgradeKeys } = await import('../../src/ui/upgradeKeys');
    registerKeys(GUIDE_KEYS);
    registerKeys(upgradeKeys({} as never));
    expect(findConflicts()).toEqual([]);
    const lights = bindings().find((b) => b.id === 'upgrade.lights')!;
    expect(lights.keys).toEqual(['Shift+1']);
    expect(bindings().some((b) => b.id === 'upgrade.open.remove' && b.run && !b.noPalette)).toBe(true);
    const rows = panelRows({ tool: 'road', select: null, tab: 'modify' }).rows;
    expect(rows.some((r) => r.label === 'Upgrade: Street lights')).toBe(true);
  });
});
