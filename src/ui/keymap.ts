/**
 * The keymap: the one source of truth for every shortcut. Input handling, the
 * command palette, tooltips, the corner shortcut panel and the help screen all
 * read from here, so nothing drifts and a test catches clashes.
 *
 * A binding lives in a scope. Scopes nest, most specific first:
 *   tool:<id>      while that tool is active
 *   select:<kind>  while an inspector is open on a segment, junction, endpoint...
 *   tab            while a bottom tray tab is open (1 to 9 pick a card, Tab cycles)
 *   global         always
 *   camera         always, handled by the camera itself (documented here)
 * A key bound in a narrower scope that is also bound more broadly must name the
 * broader binding in `shadows`, or findConflicts reports it.
 *
 * Combos are written 'Mod+Shift+Z': modifiers in the order Mod, Alt, Shift, then
 * the key. Mod is Cmd on a Mac and Ctrl elsewhere; Alt is Option on a Mac. Keys are
 * upper case letters, digits, or names: Space, Escape, Enter, Tab, Delete,
 * Backspace, PageUp, PageDown, ArrowUp and so on, or a symbol such as [ ] / ?.
 *
 * Other modules register their keys with registerKeys(); they then show in the
 * panel, the palette and help with no further work.
 *
 * Pure: no DOM at import time, so it runs headless under Vitest.
 */
import type { ToolId } from '../tools/types';
import { groupOf } from './toolGroups';

export type Scope = 'global' | 'camera' | 'tab' | `tool:${string}` | `select:${string}` | `hover:${string}`;

export type KeyGroup =
  | 'File'
  | 'Edit'
  | 'Tools'
  | 'Draw'
  | 'Traffic control'
  | 'Roundabout'
  | 'Panels'
  | 'View'
  | 'Simulation'
  | 'Camera'
  | 'Selection'
  | string;

/** What a binding's run function can reach. Implemented by Input.ts. */
export interface KeyApp {
  readonly activeTool: ToolId;
  setTool(id: ToolId): void;
  toggleTool(id: ToolId): void;
  openTab(id: string | null): void;
  readonly currentTab: string | null;
  pickCard(index: number): void;
  cycleCard(step: 1 | -1): void;
  setDrawMode(mode: 'straight' | 'curved' | 'freeform' | 'upgrade'): void;
  undo(): void;
  redo(): void;
  save(): void;
  open(): void;
  newMap(): void;
  openMenu(): void;
  openHelp(): void;
  openStats(): void;
  togglePause(): void;
  setSpeed(speed: number): void;
  toggleUnderground(): void;
  toggleOverlay(mode: 'traffic' | 'speedLimit' | 'lanes' | 'roadType'): void;
  toggleShadows(): void;
  toggleGrid(): void;
  toggleSnap(key: 'snapNodes' | 'snapSegments' | 'snapAngle' | 'snapLength'): void;
  stepElevation(direction: 1 | -1): void;
  deleteSelection(): boolean;
  openPalette(): void;
  toggleShortcuts(): void;
  setControlCard(kind: string): void;
}

export interface KeyBinding {
  id: string;
  /** Short, for the corner panel and the palette. */
  label: string;
  group: KeyGroup;
  /** First is the one shown. Empty for a palette-only command. */
  keys: string[];
  scope: Scope;
  /** A longer explanation, for tooltips and the palette. */
  desc?: string;
  /** Global bindings shown in the corner panel whatever you are doing. */
  essential?: boolean;
  /** Ids of broader bindings this one deliberately overrides in its scope. */
  shadows?: string[];
  /**
   * Run it. Absent when the key is handled elsewhere, by a tool's keyDown or the
   * camera; the binding then documents it.
   */
  run?: (app: KeyApp) => void;
  /** Leave out of the command palette. */
  noPalette?: boolean;
  /** Icon name (icons.ts) shown beside the keycap in the corner panel. */
  icon?: string;
  /** Fires on key repeat too. Off by default. */
  repeat?: boolean;
}

const LEVEL: Record<string, number> = { tool: 3, select: 2, hover: 2, tab: 1, global: 0, camera: -1 };
export function scopeLevel(scope: Scope): number {
  return LEVEL[scope.split(':')[0]] ?? 0;
}

// ---------------------------------------------------------------------------
// Combos
// ---------------------------------------------------------------------------

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? '');
}

const MOD_ORDER = ['Mod', 'Alt', 'Shift'] as const;

/** Put a combo in canonical form: 'shift+mod+z' becomes 'Mod+Shift+Z'. */
export function normalizeCombo(combo: string): string {
  const parts = combo.split('+').map((p) => p.trim());
  // A trailing '+' as the key itself.
  if (combo.endsWith('++')) parts.splice(parts.length - 2, 2, '+');
  const key = parts.pop() ?? '';
  const mods = new Set(
    parts.map((m) => {
      const l = m.toLowerCase();
      if (l === 'cmd' || l === 'ctrl' || l === 'meta' || l === 'mod' || l === 'control') return 'Mod';
      if (l === 'alt' || l === 'option' || l === 'opt') return 'Alt';
      if (l === 'shift') return 'Shift';
      return m;
    }),
  );
  const k = key.length === 1 ? key.toUpperCase() : NAMED[key.toLowerCase()] ?? key;
  return [...MOD_ORDER.filter((m) => mods.has(m)), k].join('+');
}

const NAMED: Record<string, string> = {
  ' ': 'Space',
  space: 'Space',
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  del: 'Delete',
  delete: 'Delete',
  backspace: 'Backspace',
  pgup: 'PageUp',
  pageup: 'PageUp',
  pgdn: 'PageDown',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
};

/** The combo a key event makes, in canonical form. Letters and digits by physical key. */
export function comboFromEvent(e: { key: string; code?: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): string {
  let key: string;
  let shift = e.shiftKey;
  const code = e.code ?? '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  // Shift with the slash key is a question mark, whatever the event's key says.
  else if (code === 'Slash' && e.shiftKey) {
    key = '?';
    shift = false;
  } else if (e.key.length === 1 && e.key !== ' ') {
    key = e.key.toUpperCase();
    // A symbol typed with Shift, such as ?, already says so.
    if (!/[A-Z0-9]/.test(key)) shift = false;
  } else key = NAMED[e.key.toLowerCase()] ?? e.key;
  const mods: string[] = [];
  if (e.metaKey || e.ctrlKey) mods.push('Mod');
  if (e.altKey) mods.push('Alt');
  if (shift) mods.push('Shift');
  return [...mods, key].join('+');
}

const MAC_GLYPH: Record<string, string> = { Mod: '⌘', Alt: '⌥', Shift: '⇧' };
const KEY_GLYPH: Record<string, string> = {
  Escape: 'Esc',
  Enter: '↩',
  Space: 'Space',
  Tab: 'Tab',
  Delete: 'Del',
  Backspace: '⌫',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/** A combo as the user sees it: '⌘⇧Z' on a Mac, 'Ctrl+Shift+Z' elsewhere. */
export function formatCombo(combo: string, mac = isMac()): string {
  const parts = normalizeCombo(combo).split('+');
  const key = parts.pop()!;
  const k = KEY_GLYPH[key] ?? key;
  if (mac) return parts.map((m) => MAC_GLYPH[m] ?? m).join('') + k;
  return [...parts.map((m) => (m === 'Mod' ? 'Ctrl' : m)), k].join('+');
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry: KeyBinding[] = [];
const listeners = new Set<() => void>();

/** Add bindings. Returns a function that removes them again. */
export function registerKeys(list: KeyBinding[]): () => void {
  for (const b of list) {
    const i = registry.findIndex((x) => x.id === b.id);
    const clean = { ...b, keys: b.keys.map(normalizeCombo) };
    if (i >= 0) registry[i] = clean;
    else registry.push(clean);
  }
  for (const fn of listeners) fn();
  return () => {
    for (const b of list) {
      const i = registry.findIndex((x) => x.id === b.id);
      if (i >= 0) registry.splice(i, 1);
    }
    for (const fn of listeners) fn();
  };
}

export function onKeymapChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function bindings(): readonly KeyBinding[] {
  return registry;
}

export function binding(id: string): KeyBinding | undefined {
  return registry.find((b) => b.id === id);
}

/** The shown key of a binding, formatted, for data-key hints. */
export function keyHint(id: string): string | undefined {
  const k = binding(id)?.keys[0];
  return k ? formatCombo(k) : undefined;
}

/** Scopes in force, most specific first. */
export function activeScopes(state: { tool: string; select: string | null; tab: string | null }): Scope[] {
  const out: Scope[] = [`tool:${state.tool}`];
  if (state.select) out.push(`select:${state.select}`);
  if (state.tab) out.push('tab');
  out.push('global', 'camera');
  return out;
}

/** The binding a combo triggers in these scopes, or null. */
export function match(combo: string, scopes: Scope[], list: readonly KeyBinding[] = registry): KeyBinding | null {
  const c = normalizeCombo(combo);
  for (const scope of scopes) {
    const hit = list.find((b) => b.scope === scope && b.keys.includes(c));
    if (hit) return hit;
  }
  return null;
}

/** Every clash: the same combo twice in one scope, or an undeclared override of a broader scope. */
export function findConflicts(list: readonly KeyBinding[] = registry): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const b of list) {
    if (ids.has(b.id)) problems.push(`duplicate id ${b.id}`);
    ids.add(b.id);
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      for (const k of a.keys) {
        if (!b.keys.includes(k)) continue;
        if (a.scope === b.scope) {
          problems.push(`${k}: ${a.id} and ${b.id} both in ${a.scope}`);
          continue;
        }
        const la = scopeLevel(a.scope);
        const lb = scopeLevel(b.scope);
        // Different tools, tabs or selections are never active together.
        if (la === lb) continue;
        const [narrow, broad] = la > lb ? [a, b] : [b, a];
        if (!(narrow.shadows ?? []).includes(broad.id)) problems.push(`${k}: ${narrow.id} (${narrow.scope}) overrides ${broad.id} (${broad.scope}) without saying so`);
      }
    }
  }
  return problems;
}

/** Bindings for the corner panel: the active tool and selection, the open tab, then essentials. */
export function contextBindings(scopes: Scope[], list: readonly KeyBinding[] = registry): KeyBinding[] {
  const out: KeyBinding[] = [];
  const taken = new Set<string>();
  for (const scope of scopes) {
    if (scope === 'camera') continue;
    for (const b of list) {
      if (b.scope !== scope || !b.keys.length) continue;
      if (scope === 'global' && !b.essential) continue;
      const k = b.keys[0];
      if (taken.has(k)) continue;
      taken.add(k);
      out.push(b);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The corner panel's rows
// ---------------------------------------------------------------------------

const TOOL_TITLES: Record<string, string> = {
  select: 'Inspect',
  road: 'Draw roads',
  bulldoze: 'Bulldoze',
  move: 'Move',
  junction: 'Traffic control',
  roundabout: 'Roundabout',
  lanes: 'Lane connector',
  paint: 'Paint',
  nodeMarkings: 'Junction markings',
  traffic: 'Traffic endpoints',
  template: 'Stamp',
  reverse: 'Reverse',
  terrain: 'Landscaping',
};

export interface ShortcutState {
  tool: string;
  select: string | null;
  tab: string | null;
}

/** The rows the panel shows for a state. Pure, for tests. */
/** Icons for bindings that have an obvious picture, for the corner panel. */
const ROW_ICONS: Record<string, string> = {
  'draw.straight': 'straight',
  'draw.curved': 'curved',
  'draw.freeform': 'freeform',
  'draw.upgrade': 'upgrade',
  'draw.lower': 'down',
  'draw.raise': 'up',
  'draw.snapNodes': 'node',
  'draw.snapRoads': 'snapRoad',
  'draw.snapAngle': 'angle',
  'draw.snapLength': 'ruler',
  'roundabout.smaller': 'down',
  'roundabout.bigger': 'up',
  'roundabout.delete': 'trash',
  'select.delete': 'trash',
  'select.deleteEndpoint': 'trash',
  'edit.delete': 'trash',
  'edit.undo': 'undo',
  'app.palette': 'help',
  'tab.pick': 'type',
  'tab.next': 'freeform',
  'move.lower': 'down',
  'move.raise': 'up',
};

export interface PanelRow {
  keys: string;
  label: string;
  scope: Scope;
  icon?: string;
}

export function panelRows(state: ShortcutState, list: readonly KeyBinding[] = bindings()): { title: string; rows: PanelRow[] } {
  const scopes = activeScopes(state);
  const rows = contextBindings(scopes, list).map((b) => ({
    keys: b.id === 'tab.pick' ? '1–9' : b.keys.length > 1 && b.keys.every((k) => k.length === 1) && b.keys.length <= 4 ? b.keys.join(' ') : formatCombo(b.keys[0]),
    label: b.label,
    scope: b.scope,
    icon: b.icon ?? ROW_ICONS[b.id],
  }));
  return { title: TOOL_TITLES[state.tool] ?? state.tool, rows };
}

/**
 * The few rows the corner panel shows by default: the current step's own keys
 * first, topped up with undo and the palette. '?' shows them all.
 */
export function compactRows(rows: readonly PanelRow[], max = 5): PanelRow[] {
  const own = rows.filter((r) => r.scope !== 'global');
  const essentials = rows.filter((r) => r.scope === 'global' && r.keys !== '?' && !/^esc/i.test(r.keys));
  return [...own, ...essentials].slice(0, max);
}

// ---------------------------------------------------------------------------
// The built-in bindings
// ---------------------------------------------------------------------------

/**
 * A key for one tool implementation. It opens the broad tool that owns it (see
 * toolGroups.ts) and switches to that mode. Modify modes and Bulldoze toggle back
 * to Select when pressed again.
 */
const tool = (id: ToolId, key: string, label: string, desc: string, extra: Partial<KeyBinding> = {}): KeyBinding => ({
  id: `tool.${id}`,
  label,
  group: 'Tools',
  keys: key ? [key] : [],
  scope: 'global',
  desc,
  run: (app) => {
    const g = groupOf(id, 'straight');
    if (id === 'road') {
      app.setTool('road');
      if (!app.currentTab) app.openTab('build');
    } else if (g === 'modify' || g === 'bulldoze' || !g) app.toggleTool(id);
    else {
      app.openTab(g);
      app.setTool(id);
    }
  },
  ...extra,
});

const speedIds = ['sim.speed1', 'sim.speed2', 'sim.speed4'];

export const DEFAULT_BINDINGS: KeyBinding[] = [
  // File and edit
  { id: 'edit.undo', label: 'Undo', group: 'Edit', keys: ['Mod+Z'], scope: 'global', essential: true, repeat: true, run: (a) => a.undo() },
  { id: 'edit.redo', label: 'Redo', group: 'Edit', keys: ['Mod+Shift+Z', 'Mod+Y'], scope: 'global', repeat: true, run: (a) => a.redo() },
  { id: 'edit.delete', label: 'Delete selected', group: 'Edit', keys: ['Delete', 'Backspace'], scope: 'global', desc: 'Remove the selected road, endpoint or roundabout', run: (a) => void a.deleteSelection() },
  { id: 'file.save', label: 'Save', group: 'File', keys: ['Mod+S'], scope: 'global', run: (a) => a.save() },
  { id: 'file.open', label: 'Open a save', group: 'File', keys: ['Mod+O'], scope: 'global', run: (a) => a.open() },
  { id: 'file.new', label: 'New map', group: 'File', keys: ['Mod+Alt+N', 'Alt+N'], scope: 'global', desc: 'The browser keeps Cmd+N, so Option+N works too', run: (a) => a.newMap() },
  { id: 'app.palette', label: 'Command palette', group: 'Panels', keys: ['Mod+K', '/'], scope: 'global', essential: true, desc: 'Search every action and setting', run: (a) => a.openPalette() },
  { id: 'app.shortcuts', label: 'Show shortcuts', group: 'Panels', keys: ['?'], scope: 'global', essential: true, desc: 'Keep the shortcut panel and keycaps on screen', run: (a) => a.toggleShortcuts() },
  { id: 'app.back', label: 'Back out, menu', group: 'Panels', keys: ['Escape'], scope: 'global', essential: true, desc: 'Close what is open, leave the tool, then the menu', noPalette: true },
  { id: 'app.menu', label: 'Menu', group: 'Panels', keys: [], scope: 'global', run: (a) => a.openMenu() },
  { id: 'app.help', label: 'Keyboard reference', group: 'Panels', keys: ['Mod+/'], scope: 'global', run: (a) => a.openHelp() },
  { id: 'app.stats', label: 'Traffic statistics', group: 'Panels', keys: ['Alt+T'], scope: 'global', run: (a) => a.openStats() },

  // Tools
  tool('road', 'N', 'Draw roads', 'The road tool, in the open road category'),
  tool('select', 'V', 'Inspect', 'Click anything to inspect it'),
  tool('bulldoze', 'B', 'Bulldoze', 'Click a road for the stretch between junctions, drag along it for an exact stretch'),
  tool('move', 'M', 'Move', 'Drag nodes and curve handles'),
  tool('junction', 'J', 'Traffic control', 'One click sets lights, signs or priority'),
  tool('roundabout', 'O', 'Roundabout', 'Build, resize or remove roundabouts'),
  tool('lanes', 'L', 'Lane connector', 'Link lanes through a junction by hand'),
  tool('paint', 'P', 'Paint', 'Lines, areas, arrows and text on the road'),
  tool('nodeMarkings', 'K', 'Junction markings', 'Paint lines and fillers inside a junction'),
  tool('junctionShape', 'Shift+K', 'Junction shape', 'Drag kerb radii, sidewalks, arm trims and islands of a junction'),
  tool('traffic', 'T', 'Traffic endpoints', 'Gateways and zones that make traffic'),
  tool('reverse', 'H', 'Reverse', 'Turn one-way roads round'),
  tool('parallel', 'I', 'Parallel road', 'Draw a road alongside an existing one'),
  tool('junctionShape', 'Shift+K', 'Junction shape', 'Drag kerbs, sidewalks, cut lines and islands'),
  tool('electrify', '', 'Electrify track', 'Sweep over track to add overhead wires'),
  tool('gridAlign', '', 'Align grid', 'Line the drawing grid up with a road'),
  tool('zone', '', 'Zone land', 'Fill a block, drag along roads, or draw a shape'),
  tool('station', '', 'Place station', 'A station on track'),
  tool('line', '', 'Draw train line', 'Click stations in order'),
  tool('quay', '', 'Build quay', 'A wall along the water'),
  // Shift+L opens Terrain through the terrain module's tool.terrain binding.
  { id: 'group.terrain', label: 'Terrain', group: 'Tools', keys: [], scope: 'global', desc: 'Landscaping and quays', run: (a) => a.openTab('terrain') },
  { id: 'group.transit', label: 'Transit', group: 'Tools', keys: ['Shift+T'], scope: 'global', desc: 'Stations, lines and trains', run: (a) => a.openTab('transit') },

  // Road drawing
  { id: 'draw.straight', label: 'Straight', group: 'Draw', keys: ['Z'], scope: 'tool:road', run: (a) => a.setDrawMode('straight') },
  { id: 'draw.curved', label: 'Curved', group: 'Draw', keys: ['X'], scope: 'tool:road', run: (a) => a.setDrawMode('curved') },
  { id: 'draw.freeform', label: 'Freeform', group: 'Draw', keys: ['C'], scope: 'tool:road', run: (a) => a.setDrawMode('freeform') },
  { id: 'draw.upgrade', label: 'Upgrade', group: 'Tools', keys: ['Y'], scope: 'global', desc: 'Modify: sweep a road type, structure or barriers over roads', run: (a) => a.setDrawMode('upgrade') },
  {
    id: 'draw.lower',
    label: 'Lower 4 m',
    group: 'Draw',
    keys: ['Q', 'PageDown'],
    scope: 'tool:road',
    shadows: ['camera.rotateLeft'],
    repeat: true,
    desc: 'Q and E change elevation while drawing; Option+Q/E still turns the camera. Handled by ToolManager',
  },
  { id: 'draw.raise', label: 'Raise 4 m', group: 'Draw', keys: ['E', 'PageUp'], scope: 'tool:road', shadows: ['camera.rotateRight'], repeat: true },
  { id: 'draw.elevation', label: 'Change elevation', group: 'Draw', keys: [], scope: 'global', desc: 'Raise the road being drawn 4 m', run: (a) => a.stepElevation(1) },
  { id: 'draw.snapNodes', label: 'Snap to nodes', group: 'Draw', keys: ['Alt+N'], scope: 'tool:road', shadows: ['file.new'], run: (a) => a.toggleSnap('snapNodes') },
  { id: 'draw.snapRoads', label: 'Snap along roads', group: 'Draw', keys: ['Alt+R'], scope: 'tool:road', run: (a) => a.toggleSnap('snapSegments') },
  { id: 'draw.snapAngle', label: 'Angle guides', group: 'Draw', keys: ['Alt+A'], scope: 'tool:road', run: (a) => a.toggleSnap('snapAngle') },
  { id: 'draw.snapLength', label: 'Length steps', group: 'Draw', keys: ['Alt+L'], scope: 'tool:road', run: (a) => a.toggleSnap('snapLength') },
  { id: 'draw.noSnap', label: 'Hold: no snapping', group: 'Draw', keys: ['Mod'], scope: 'tool:road', noPalette: true },

  // Traffic control: its cards are picked with 1 to 9 in the tab (tab.pick).

  // Roundabout
  { id: 'roundabout.smaller', label: 'Radius smaller', group: 'Roundabout', keys: ['['], scope: 'tool:roundabout', repeat: true },
  { id: 'roundabout.bigger', label: 'Radius larger', group: 'Roundabout', keys: [']'], scope: 'tool:roundabout', repeat: true, desc: 'The mouse wheel does it too; Cmd+wheel zooms' },
  { id: 'roundabout.delete', label: 'Delete roundabout', group: 'Roundabout', keys: ['Delete', 'Backspace'], scope: 'tool:roundabout', shadows: ['edit.delete', 'select.delete', 'select.deleteEndpoint'] },

  // Stamps and paint
  { id: 'template.rotate', label: 'Rotate stamp', group: 'Draw', keys: ['[', ']'], scope: 'tool:template' },
  { id: 'template.height', label: 'Stamp height', group: 'Draw', keys: ['PageUp', 'PageDown'], scope: 'tool:template' },
  { id: 'paint.rotate', label: 'Rotate stamp', group: 'Draw', keys: ['[', ']'], scope: 'tool:paint' },
  { id: 'paint.finish', label: 'Finish line', group: 'Draw', keys: ['Enter'], scope: 'tool:paint' },
  { id: 'bulldoze.whole', label: 'Hold: whole road', group: 'Draw', keys: ['Shift'], scope: 'tool:bulldoze', desc: 'Shift+click removes the whole connected road or track', noPalette: true },

  // The open tray
  { id: 'tab.pick', label: 'Pick card 1 to 9', group: 'Panels', keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'], scope: 'tab', shadows: speedIds, noPalette: true },
  { id: 'tab.next', label: 'Next card', group: 'Panels', keys: ['Tab'], scope: 'tab', run: (a) => a.cycleCard(1), noPalette: true },
  { id: 'tab.prev', label: 'Previous card', group: 'Panels', keys: ['Shift+Tab'], scope: 'tab', run: (a) => a.cycleCard(-1), noPalette: true },

  // Over a track, from any tool (the rail module handles it in ToolManager).
  { id: 'rail.wires', label: 'Overhead wires', group: 'Selection', keys: ['O', 'Shift+O'], scope: 'hover:track', shadows: ['tool.roundabout'], desc: 'Over a track: electrify it, or with Shift remove the wires', noPalette: true },

  // Selection
  { id: 'select.delete', label: 'Delete road', group: 'Selection', keys: ['Delete', 'Backspace'], scope: 'select:segment', shadows: ['edit.delete'], run: (a) => void a.deleteSelection() },
  { id: 'select.deleteEndpoint', label: 'Remove endpoint', group: 'Selection', keys: ['Delete', 'Backspace'], scope: 'select:endpoint', shadows: ['edit.delete'], run: (a) => void a.deleteSelection() },

  // Simulation
  { id: 'sim.pause', label: 'Pause', group: 'Simulation', keys: ['Space'], scope: 'global', run: (a) => a.togglePause() },
  { id: 'sim.speed1', label: 'Normal speed', group: 'Simulation', keys: ['1'], scope: 'global', run: (a) => a.setSpeed(1) },
  { id: 'sim.speed2', label: 'Double speed', group: 'Simulation', keys: ['2'], scope: 'global', run: (a) => a.setSpeed(2) },
  { id: 'sim.speed4', label: 'Four times speed', group: 'Simulation', keys: ['3'], scope: 'global', run: (a) => a.setSpeed(4) },

  // View
  { id: 'view.underground', label: 'Underground view', group: 'View', keys: ['U'], scope: 'global', run: (a) => a.toggleUnderground() },
  { id: 'view.grid', label: 'Grid', group: 'View', keys: ['G'], scope: 'global', desc: 'Show the drawing grid and snap to it', run: (a) => a.toggleGrid() },
  { id: 'view.traffic', label: 'Traffic heatmap', group: 'View', keys: ['Alt+1'], scope: 'global', run: (a) => a.toggleOverlay('traffic') },
  { id: 'view.speed', label: 'Speed limits', group: 'View', keys: ['Alt+2'], scope: 'global', run: (a) => a.toggleOverlay('speedLimit') },
  { id: 'view.lanes', label: 'Lanes', group: 'View', keys: ['Alt+3'], scope: 'global', run: (a) => a.toggleOverlay('lanes') },
  { id: 'view.types', label: 'Road types', group: 'View', keys: ['Alt+4'], scope: 'global', run: (a) => a.toggleOverlay('roadType') },
  { id: 'view.shadows', label: 'Shadows', group: 'View', keys: ['Alt+S'], scope: 'global', run: (a) => a.toggleShadows() },

  // Camera, handled by the camera
  { id: 'camera.pan', label: 'Pan', group: 'Camera', keys: ['W', 'A', 'S', 'D'], scope: 'camera', desc: 'Or two-finger scroll on a trackpad', noPalette: true },
  { id: 'camera.rotateLeft', label: 'Rotate left', group: 'Camera', keys: ['Q', 'Alt+Q'], scope: 'camera', noPalette: true },
  { id: 'camera.rotateRight', label: 'Rotate right', group: 'Camera', keys: ['E', 'Alt+E'], scope: 'camera', noPalette: true },
  { id: 'camera.tilt', label: 'Tilt', group: 'Camera', keys: ['R', 'F'], scope: 'camera', desc: 'Or Option-drag, or right drag', noPalette: true },
];

registerKeys(DEFAULT_BINDINGS);

/** Mouse and trackpad gestures, for the help screen. */
export const GESTURES: [string, string][] = [
  ['Click', 'Place, pick, apply'],
  ['Right click or two-finger click', 'Step back'],
  ['Wheel or pinch', 'Zoom'],
  ['Two-finger scroll', 'Pan'],
  ['Right drag or Option-drag', 'Orbit'],
  ['Shift+wheel', 'Rotate a stamp'],
];
