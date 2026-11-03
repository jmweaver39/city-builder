/**
 * Landscaping in the Landscaping tab: Shift, Level, Soften and Slope cards ahead
 * of the walls module's quay cards, with brush size, strength and shape, and
 * their keys in the central keymap (so the shortcut panel and palette list them).
 */
import { BRUSH_MAX_RADIUS, BRUSH_MIN_RADIUS } from '../core/terrainEdit';
import { MAX_ELEVATION, MIN_ELEVATION } from '../core/terrain';
import { TERRAIN_MODES, type TerrainMode } from '../tools/TerrainTool';
import type { ToolId } from '../tools/types';
import type { UiContext } from './context';
import { el, numberInput, row, selectInput, sliderInput } from './dom';
import { registerKeys, type KeyBinding } from './keymap';

/** Line icons, drawn for this game. */
const MODE_ICONS: Record<TerrainMode, string> = {
  shift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M2 19c4 0 5-9 10-9s6 9 10 9"/><path d="M12 7V2M9.5 4.5 12 2l2.5 2.5"/></svg>',
  level: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M2 18c2 0 3-4 5-4h10c2 0 3 4 5 4"/><path d="M5 9h14"/><path d="M12 6v6"/></svg>',
  soften: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M2 18c3 0 4-6 7-6s3 3 6 3 4-3 7-3"/><path d="M4 7c2-2 4 2 6 0s4 2 6 0 4 2 6 0" opacity=".6"/></svg>',
  slope: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20h20"/><path d="M3 18 21 7"/><circle cx="3" cy="18" r="1.6"/><circle cx="21" cy="7" r="1.6"/></svg>',
};

const MODE_META: Record<TerrainMode, string> = {
  shift: 'Left raise, right lower',
  level: 'Flatten to a height',
  soften: 'Smooth the ground',
  slope: 'Even grade, A to B',
};

let registered = false;

/** Keys and palette commands for landscaping. */
export function registerTerrainKeys(ui: UiContext): void {
  if (registered) return;
  registered = true;
  const open = (mode?: TerrainMode) => {
    ui.tools.setTool('terrain' as ToolId);
    if (mode) ui.tools.terrain.setMode(mode);
  };
  const list: KeyBinding[] = [
    {
      id: 'tool.terrain',
      label: 'Landscaping',
      group: 'Tools',
      keys: ['Shift+L'],
      scope: 'global',
      desc: 'Raise, lower, level, soften and slope the ground',
      run: (a) => {
        a.openTab('landscape');
        open();
      },
    },
    ...TERRAIN_MODES.map(
      (m): KeyBinding => ({ id: `terrain.${m.value}`, label: m.label, group: 'Landscaping', keys: [m.key], scope: 'tool:terrain', desc: m.desc, run: () => open(m.value) }),
    ),
    ...TERRAIN_MODES.map(
      (m): KeyBinding => ({
        id: `terrain.open.${m.value}`,
        label: `Landscaping: ${m.label}`,
        group: 'Landscaping',
        keys: [],
        scope: 'global',
        desc: m.desc,
        run: (a) => {
          a.openTab('landscape');
          open(m.value);
        },
      }),
    ),
    { id: 'terrain.smaller', label: 'Brush smaller', group: 'Landscaping', keys: ['['], scope: 'tool:terrain', repeat: true, desc: 'Shift+wheel too', run: () => ui.tools.terrain.resize(-1) },
    { id: 'terrain.bigger', label: 'Brush larger', group: 'Landscaping', keys: [']'], scope: 'tool:terrain', repeat: true, run: () => ui.tools.terrain.resize(1) },
    { id: 'terrain.weaker', label: 'Strength down', group: 'Landscaping', keys: ['Shift+['], scope: 'tool:terrain', repeat: true, run: () => ui.tools.terrain.strengthen(-1) },
    { id: 'terrain.stronger', label: 'Strength up', group: 'Landscaping', keys: ['Shift+]'], scope: 'tool:terrain', repeat: true, run: () => ui.tools.terrain.strengthen(1) },
    { id: 'terrain.lower', label: 'Hold: lower, or sample level', group: 'Landscaping', keys: ['Alt'], scope: 'tool:terrain', noPalette: true, desc: 'Option+click (or right click, two-finger click) lowers with Shift and samples the height with Level' },
  ];
  registerKeys(list);
}

/** Brush options and the four tool cards. Add the quay cards after. */
export function renderTerrainTray(ui: UiContext, options: HTMLElement, cards: HTMLElement): void {
  registerTerrainKeys(ui);
  const tool = ui.tools.terrain;
  const b = tool.brush;
  const size = sliderInput(b.radius, { min: BRUSH_MIN_RADIUS, max: BRUSH_MAX_RADIUS, step: 1, format: (v) => `${v} m` }, (v) => {
    b.radius = v;
    tool.settingsChanged();
  });
  const strength = sliderInput(Math.round(b.strength * 100), { min: 5, max: 100, step: 5, format: (v) => `${v}%` }, (v) => {
    b.strength = v / 100;
    tool.settingsChanged();
  });
  const shape = selectInput(
    [
      { value: 'soft', label: 'Soft round' },
      { value: 'hard', label: 'Hard round' },
    ],
    b.shape,
    (v) => {
      b.shape = v;
      tool.settingsChanged();
    },
  );
  const target = numberInput(b.target === null ? 0 : Math.round(b.target * 10) / 10, { min: MIN_ELEVATION, max: MAX_ELEVATION, step: 0.5 }, (v) => tool.setTarget(v));
  target.placeholder = 'sample';
  if (b.target === null) target.value = '';
  const levelRow = row('Level to (m)', target, 'Typed height for Level. Right click or Option+click on the ground samples it');
  const help = el('div', { class: 'small muted', text: '' });
  options.append(
    el('div', { class: 'opt-title', text: 'Brush' }),
    row('Size', size, '[ and ] or Shift+wheel'),
    row('Strength', strength, 'Shift+[ and Shift+]'),
    row('Shape', shape),
    levelRow,
    help,
  );
  const sync = () => {
    const sz = size.querySelector('input')!;
    const st = strength.querySelector('input')!;
    if (document.activeElement !== sz && sz.valueAsNumber !== b.radius) {
      sz.value = String(b.radius);
      size.querySelector('output')!.textContent = `${b.radius} m`;
      sz.dispatchEvent(new Event('sync'));
    }
    const pct = Math.round(b.strength * 100);
    if (document.activeElement !== st && st.valueAsNumber !== pct) {
      st.value = String(pct);
      strength.querySelector('output')!.textContent = `${pct}%`;
      st.dispatchEvent(new Event('sync'));
    }
    if (document.activeElement !== target) target.value = b.target === null ? '' : String(Math.round(b.target * 10) / 10);
    levelRow.style.display = b.mode === 'level' ? '' : 'none';
    const on = ui.tools.active.id === 'terrain';
    help.textContent = !on ? '' : b.mode === 'slope' ? (!b.from ? 'Click the start of the slope.' : !b.to ? 'Click the end of the slope.' : 'Paint between the ends. Right click starts again.') : (TERRAIN_MODES.find((m) => m.value === b.mode)?.desc ?? '');
    for (const c of cards.querySelectorAll<HTMLElement>('[data-terrain]')) c.classList.toggle('active', on && c.dataset.terrain === b.mode);
  };
  for (const m of TERRAIN_MODES) {
    cards.append(
      el(
        'button',
        {
          class: 'card',
          dataset: { terrain: m.value },
          tip: `${m.label}: ${m.desc}`,
          keyHint: m.key,
          attrs: { type: 'button', 'aria-label': m.label },
          on: {
            click: () => {
              ui.tools.setTool('terrain' as ToolId);
              tool.setMode(m.value);
              for (const c of cards.querySelectorAll<HTMLElement>('[data-quay]')) c.classList.remove('active');
              sync();
            },
          },
        },
        el('div', { class: 'art', html: MODE_ICONS[m.value] }),
        el('div', { class: 'card-name', text: m.label }),
        el('div', { class: 'card-meta', text: MODE_META[m.value] }),
      ),
    );
  }
  sync();
  const off = ui.tools.onChange(() => {
    if (!options.isConnected || !size.isConnected) {
      off();
      return;
    }
    sync();
  });
}
