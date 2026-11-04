import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { ToolManager } from '../../src/tools/ToolManager';
import { History } from '../../src/app/History';
import { FakeView } from './helpers';
import { GROUPS, groupOf, legacyTab, MIGRATION, modeOf, ROAD_CHIPS } from '../../src/ui/toolGroups';
import { bindings, findConflicts, registerKeys } from '../../src/ui/keymap';
import { GUIDE_KEYS } from '../../src/ui/guideKeys';

registerKeys(GUIDE_KEYS);

const RUNTIME_BINDINGS = ['tool.terrain'];

/** Every tool implementation the editor has, from a real ToolManager. */
function allToolIds(): string[] {
  const net = new RoadNetwork();
  const tools = new ToolManager({ net, sim: null, view: new FakeView(), history: new History(net) });
  return Object.keys(tools.tools);
}

describe('the eight broad tools', () => {
  it('are eight, with Bulldoze last', () => {
    expect(GROUPS.map((g) => g.id)).toEqual(['build', 'modify', 'junction', 'paint', 'zones', 'terrain', 'transit', 'bulldoze']);
  });

  it('give every former tool a home, so nothing is lost', () => {
    const homeless = allToolIds().filter((id) => groupOf(id, 'straight') === null);
    expect(homeless).toEqual([]);
    // Upgrade is the road tool in upgrade mode, which lives in Modify.
    expect(groupOf('road', 'upgrade')).toBe('modify');
    expect(groupOf('road', 'curved')).toBe('build');
    expect(modeOf('road', 'upgrade')?.id).toBe('upgrade');
    expect(modeOf('reverse', 'straight')?.id).toBe('reverse');
    // Junction markings are the one Markings tool now, in the Markings (paint) group.
    expect(modeOf('nodeMarkings', 'straight')?.id).toBe('markings');
    expect(modeOf('paint', 'straight')?.id).toBe('markings');
    expect(groupOf('nodeMarkings', 'straight')).toBe('paint');
  });

  it('make every mode reachable by a key or the command palette', () => {
    const byId = new Map(bindings().map((b) => [b.id, b]));
    for (const g of GROUPS) {
      if (RUNTIME_BINDINGS.includes(g.binding)) continue;
      const gb = byId.get(g.binding);
      expect(gb, g.binding).toBeDefined();
      expect(gb!.keys.length > 0 || (!!gb!.run && !gb!.noPalette), g.id).toBe(true);
      for (const m of g.modes) {
        // A mode with a key or palette binding, or reached by its tool's mode row.
        if (!m.binding) continue;
        // Registered at runtime by a DOM module (TerrainControls.ts), so not loaded here.
        if (RUNTIME_BINDINGS.includes(m.binding)) continue;
        const b = byId.get(m.binding);
        expect(b, `${g.id}.${m.id}: ${m.binding}`).toBeDefined();
        expect(b!.keys.length > 0 || (!!b!.run && !b!.noPalette), m.binding).toBe(true);
      }
    }
    expect(findConflicts()).toEqual([]);
  });

  it('open the right tool for every old tab id', () => {
    expect(legacyTab('street')).toEqual({ group: 'build', chip: 'street' });
    expect(legacyTab('highway')).toEqual({ group: 'build', chip: 'highway' });
    expect(legacyTab('control')).toEqual({ group: 'junction' });
    expect(legacyTab('traffic')).toEqual({ group: 'zones' });
    expect(legacyTab('rail')).toEqual({ group: 'transit' });
    expect(legacyTab('landscape')).toEqual({ group: 'terrain' });
    expect(legacyTab('paint')).toEqual({ group: 'paint' });
    expect(ROAD_CHIPS.map((c) => c.label)).toEqual(['Streets', 'Avenues', 'One-ways', 'Highways', 'Ramps', 'Rail', 'Custom']);
  });

  it('list where every old control went', () => {
    expect(MIGRATION.length).toBeGreaterThan(15);
    for (const [, now] of MIGRATION) {
      const tool = now.split(':')[0].split(' ')[0];
      expect(['Build', 'Modify', 'Junction', 'Paint', 'Zones', 'Terrain', 'Transit', 'Bulldoze', 'Command'], now).toContain(tool);
    }
  });
});
