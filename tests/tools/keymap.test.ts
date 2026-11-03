import { describe, expect, it } from 'vitest';
import {
  activeScopes,
  bindings,
  comboFromEvent,
  findConflicts,
  formatCombo,
  match,
  normalizeCombo,
  panelRows,
  compactRows,
  registerKeys,
  type KeyBinding,
} from '../../src/ui/keymap';
import { fuzzyScore, rankCommands, type PaletteCommand } from '../../src/ui/search';
import { GUIDE_KEYS } from '../../src/ui/guideKeys';
import { markingKeys } from '../../src/ui/markingKeys';
import type { UiContext } from '../../src/ui/context';

// The grid agent's keys, registered as the app does, so clashes with them show too.
registerKeys(GUIDE_KEYS);
// The junction marking editor's, likewise. They only reach the UI when run.
registerKeys(markingKeys({} as UiContext));

const ev = (key: string, code: string, mods: Partial<{ shift: boolean; alt: boolean; ctrl: boolean; meta: boolean }> = {}) => ({
  key,
  code,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
});

describe('keymap', () => {
  it('has no clashing shortcuts', () => {
    expect(findConflicts()).toEqual([]);
  });

  it('reports a clash, and an undeclared override of a broader key', () => {
    const extra: KeyBinding[] = [
      { id: 'x.one', label: 'One', group: 'Test', keys: ['B'], scope: 'global', run: () => {} },
      { id: 'x.two', label: 'Two', group: 'Test', keys: ['M'], scope: 'tool:road', run: () => {} },
    ];
    const all = [...bindings(), ...extra];
    const problems = findConflicts(all);
    expect(problems.some((p) => p.includes('x.one') && p.includes('tool.bulldoze'))).toBe(true);
    expect(problems.some((p) => p.includes('x.two') && p.includes('tool.move'))).toBe(true);
  });

  it('makes every action reachable by a key or the palette', () => {
    for (const b of bindings()) {
      const byKey = b.keys.length > 0;
      const byPalette = !!b.run && !b.noPalette;
      expect(byKey || byPalette, b.id).toBe(true);
    }
    for (const tool of ['road', 'select', 'bulldoze', 'move', 'junction', 'roundabout', 'lanes', 'paint', 'nodeMarkings', 'traffic', 'reverse']) {
      const b = bindings().find((x) => x.id === `tool.${tool}`);
      expect(b?.keys.length, tool).toBeGreaterThan(0);
    }
  });

  it('reads key events by physical key, Option and Shift included', () => {
    // Option+N types a dead key on a Mac; the code still says N.
    expect(comboFromEvent(ev('˜', 'KeyN', { alt: true }))).toBe('Alt+N');
    expect(comboFromEvent(ev('z', 'KeyZ', { meta: true, shift: true }))).toBe('Mod+Shift+Z');
    expect(comboFromEvent(ev('z', 'KeyZ', { ctrl: true }))).toBe('Mod+Z');
    expect(comboFromEvent(ev('?', 'Slash', { shift: true }))).toBe('?');
    expect(comboFromEvent(ev('/', 'Slash', { shift: true }))).toBe('?');
    expect(comboFromEvent(ev(' ', 'Space'))).toBe('Space');
    expect(comboFromEvent(ev('3', 'Digit3'))).toBe('3');
    expect(normalizeCombo('shift+cmd+z')).toBe('Mod+Shift+Z');
  });

  it('shows Mac glyphs on a Mac and Ctrl elsewhere', () => {
    expect(formatCombo('Mod+Shift+Z', true)).toBe('⌘⇧Z');
    expect(formatCombo('Mod+Shift+Z', false)).toBe('Ctrl+Shift+Z');
    expect(formatCombo('Alt+N', true)).toBe('⌥N');
    expect(formatCombo('Escape', true)).toBe('Esc');
  });

  it('picks the binding of the most specific scope', () => {
    const at = (tool: string, tab: string | null = null, select: string | null = null) => activeScopes({ tool, tab, select });
    expect(match('3', at('select'))?.id).toBe('sim.speed4');
    expect(match('3', at('road', 'street'))?.id).toBe('tab.pick');
    expect(match('Q', at('road'))?.id).toBe('draw.lower');
    expect(match('Q', at('select'))?.id).toBe('camera.rotateLeft');
    expect(match('Delete', at('select', null, 'segment'))?.id).toBe('select.delete');
    expect(match('Delete', at('roundabout'))?.id).toBe('roundabout.delete');
    expect(match('Mod+Z', at('road'))?.id).toBe('edit.undo');
    expect(match('Y', at('road'))?.id).toBe('draw.upgrade');
    // Upgrade is a Modify mode now, so Y works from anywhere.
    expect(match('Y', at('select'))?.id).toBe('draw.upgrade');
  });

  it('fills the corner panel from the active tool', () => {
    const road = panelRows({ tool: 'road', select: null, tab: 'street' });
    const labels = road.rows.map((r) => r.label);
    expect(road.title).toBe('Draw roads');
    expect(labels).toContain('Straight');
    expect(labels).toContain('Raise 4 m');
    expect(labels).toContain('Pick card 1 to 9');
    expect(labels).toContain('Undo');
    expect(labels).toContain('Command palette');
    const parallel = panelRows({ tool: 'parallel', select: null, tab: null }).rows.map((r) => r.label);
    expect(parallel).toContain('Parallel offset');
    expect(panelRows({ tool: 'move', select: null, tab: null }).rows.map((r) => r.label)).toContain('Raise node 4 m');
    const ring = panelRows({ tool: 'roundabout', select: null, tab: 'control' }).rows.map((r) => r.label);
    expect(ring).toContain('Radius larger');
    expect(ring).not.toContain('Straight');
    const inspect = panelRows({ tool: 'select', select: 'segment', tab: null }).rows.map((r) => r.label);
    expect(inspect).toContain('Delete road');
    expect(inspect).not.toContain('Radius larger');
    // Camera keys stay out of the panel; global non-essentials too.
    expect(inspect).not.toContain('Pan');
    expect(inspect).not.toContain('Shadows');
  });

  it('keeps the corner panel to a few keys for the current step, with icons', () => {
    const { rows } = panelRows({ tool: 'road', select: null, tab: 'build' });
    const compact = compactRows(rows);
    expect(compact.length).toBeLessThanOrEqual(5);
    expect(compact[0].label).toBe('Straight');
    expect(compact[0].icon).toBe('straight');
    expect(compact.every((r) => r.scope !== 'global' || r.label === 'Undo' || r.label === 'Command palette')).toBe(true);
    // A tool with few keys of its own is topped up with essentials.
    const ring = compactRows(panelRows({ tool: 'roundabout', select: null, tab: null }).rows);
    expect(ring.map((r) => r.label)).toContain('Radius larger');
    expect(ring.map((r) => r.label)).toContain('Undo');
  });

  it('takes the markings editor keys without clashes, active in the Markings tab', async () => {
    const { markingKeys } = await import('../../src/ui/markingKeys');
    const off = registerKeys(markingKeys({} as never));
    expect(findConflicts()).toEqual([]);
    const scopes = activeScopes({ tool: 'nodeMarkings', select: null, tab: 'junction' });
    expect(match('L', scopes)?.id).toBe('markings.line');
    expect(match('E', scopes)?.id).toBe('markings.erase');
    off();
  });

  it('shows keys other modules register, in their scope', () => {
    const off = registerKeys([
      { id: 'test.electrify', label: 'Electrify track', group: 'Trains', keys: ['Alt+W'], scope: 'tool:test-rail', run: () => {} },
    ]);
    expect(panelRows({ tool: 'test-rail', select: null, tab: null }).rows.map((r) => r.label)).toContain('Electrify track');
    expect(findConflicts()).toEqual([]);
    off();
    expect(bindings().some((b) => b.id === 'test.electrify')).toBe(false);
  });
});

describe('command palette search', () => {
  const cmd = (id: string, label: string, group = 'Test'): PaletteCommand => ({ id, label, group, keys: [], run: () => {} });
  const list = [
    cmd('a', 'All-Way Stop', 'Traffic control'),
    cmd('b', 'Stop Signs', 'Traffic control'),
    cmd('c', 'Roundabout', 'Tools'),
    cmd('d', 'Draw Street 2-lane', 'Roads'),
    cmd('e', 'Underground view', 'View'),
  ];

  it('matches fuzzily, in order, and ranks word starts first', () => {
    expect(fuzzyScore('rbt', 'Roundabout')).not.toBeNull();
    expect(fuzzyScore('xyz', 'Roundabout')).toBeNull();
    expect(rankCommands(list, 'stop')[0].id).toBe('b');
    expect(rankCommands(list, 'rnd')[0].id).toBe('c');
    expect(rankCommands(list, 'street')[0].id).toBe('d');
    expect(rankCommands(list, 'qqq')).toEqual([]);
  });

  it('puts recent commands first', () => {
    expect(rankCommands(list, '', ['e', 'c']).map((c) => c.id).slice(0, 2)).toEqual(['e', 'c']);
    expect(rankCommands(list, 'o', ['e'])[0].id).toBe('e');
  });
});
