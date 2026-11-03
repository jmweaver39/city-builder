/**
 * Controls for the optional drawing grid: the snapping toggle and settings
 * popover in the road panel, the Grid Block button, the hotkey, and the local
 * preference that remembers the settings.
 *
 * Grid settings are an editor preference, saved in localStorage rather than in
 * the project: they describe how the player likes to draw, not the road network,
 * and keeping them out of the save format means old and new saves load unchanged.
 */
import {
  GRID_MAX_BLOCK_CELLS,
  GRID_MAX_SPACING,
  GRID_MIN_SPACING,
  GRID_SPACINGS,
  loadGridPrefs,
  normalizeGridRotation,
  resetGrid,
  saveGridPrefs,
  type GridPrefStore,
} from '../tools/grid';
import type { UiContext } from './context';
import { checkbox, el, iconButton, numberInput, row, selectInput, sliderInput } from './dom';

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const GRID_ICONS = {
  grid: svg('<path d="M4 8h16M4 16h16M8 4v16M16 4v16"/><circle cx="16" cy="16" r="1.6" fill="currentColor"/>'),
  settings: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  block: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="1"/><path d="M3.5 12h17M12 3.5v17"/>'),
};

export const GRID_HOTKEY = 'Shift+G';

function store(): GridPrefStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let lastSaved = '';

/** Load the saved grid preference and keep it saved. Call once. */
export function initGridPrefs(ui: UiContext): void {
  const s = ui.tools.settings;
  Object.assign(s.grid, loadGridPrefs(store()));
  lastSaved = JSON.stringify(s.grid);
  ui.tools.onChange(() => {
    const now = JSON.stringify(s.grid);
    if (now === lastSaved) return;
    lastSaved = now;
    saveGridPrefs(store(), s.grid);
  });
  ui.tools.settingsChanged();
}

/** Turn grid snapping on or off. */
export function toggleGridSnap(ui: UiContext): void {
  const g = ui.tools.settings.grid;
  g.enabled = !g.enabled;
  ui.tools.settingsChanged();
  ui.toast(g.enabled ? `Grid snapping on, ${g.spacing} m` : 'Grid snapping off', 'info');
}

/** The grid buttons for the road panel's snapping row. */
export function gridSnapButtons(ui: UiContext): HTMLElement[] {
  const toggle = iconButton(GRID_ICONS.grid, {
    tip: 'Snap to grid: road points land on grid crossings and lines. Nodes and roads still come first',
    keyHint: GRID_HOTKEY,
    class: 'snap-btn snap-grid',
    onClick: () => toggleGridSnap(ui),
  });
  const settings = iconButton(GRID_ICONS.settings, {
    tip: 'Grid settings: spacing, rotation, origin, align to a road',
    class: 'grid-settings-btn',
    onClick: () => openGridPopover(ui, settings),
  });
  return [toggle, settings];
}

/** The Grid Block button for the draw mode row. */
export function gridBlockButton(ui: UiContext): HTMLElement {
  return iconButton(GRID_ICONS.block, {
    tip: 'Grid block: drag a rectangle on the grid to lay out a street grid of the selected road. [ and ] change the block size',
    class: 'grid-block-btn',
    onClick: () => ui.tools.setTool(ui.tools.active.id === 'gridBlock' ? 'road' : 'gridBlock'),
  });
}

/** Reflect state in the grid buttons. */
export function syncGridControls(root: HTMLElement, ui: UiContext): void {
  const s = ui.tools.settings;
  const active = ui.tools.active.id;
  root.querySelector('.snap-grid')?.classList.toggle('active', s.grid.enabled);
  root.querySelector('.grid-block-btn')?.classList.toggle('active', active === 'gridBlock');
  root.querySelector('.grid-settings-btn')?.classList.toggle('active', popover !== null || active === 'gridAlign');
}

// ---------------------------------------------------------------------------
// Settings popover
// ---------------------------------------------------------------------------

let popover: HTMLElement | null = null;
let unbind: (() => void) | null = null;

export function closeGridPopover(): boolean {
  if (!popover) return false;
  popover.remove();
  popover = null;
  unbind?.();
  unbind = null;
  return true;
}

function openGridPopover(ui: UiContext, anchor: HTMLElement): void {
  if (closeGridPopover()) {
    ui.tools.settingsChanged();
    return;
  }
  const panel = el('div', {
    class: 'panel grid-popover',
    attrs: { role: 'dialog', 'aria-label': 'Grid settings' },
    style: { position: 'fixed', zIndex: '60', width: '260px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px' },
  });
  popover = panel;
  const render = () => fillPopover(ui, panel, render);
  render();
  document.body.append(panel);
  const r = anchor.getBoundingClientRect();
  const h = panel.offsetHeight;
  panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8))}px`;
  panel.style.top = `${r.top - h - 8 > 8 ? r.top - h - 8 : Math.min(window.innerHeight - h - 8, r.bottom + 8)}px`;
  const onDown = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!panel.contains(t) && !anchor.contains(t)) {
      closeGridPopover();
      ui.tools.settingsChanged();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeGridPopover();
      ui.tools.settingsChanged();
    }
  };
  const offTools = ui.tools.onChange(() => {
    // Align to road changes the grid from the map: show the new values.
    const now = JSON.stringify(ui.tools.settings.grid);
    if (panel.dataset.grid !== now && !panel.contains(document.activeElement)) render();
  });
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  unbind = () => {
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    offTools();
  };
  ui.tools.settingsChanged();
}

function fillPopover(ui: UiContext, panel: HTMLElement, render: () => void): void {
  const tools = ui.tools;
  const g = tools.settings.grid;
  panel.dataset.grid = JSON.stringify(g);
  panel.replaceChildren();
  const apply = (rerender = false) => {
    panel.dataset.grid = JSON.stringify(g);
    tools.settingsChanged();
    if (rerender) render();
  };

  const spacing = el('div', { class: 'opt-row', style: { flexWrap: 'wrap' } });
  for (const m of GRID_SPACINGS) {
    const b = iconButton('', {
      tip: `${m} m between lines`,
      label: `${m}`,
      class: `grid-spacing ${g.spacing === m ? 'active' : ''}`,
      onClick: () => {
        g.spacing = m;
        apply(true);
      },
    });
    spacing.append(b);
  }
  const custom = numberInput(g.spacing, { min: GRID_MIN_SPACING, max: GRID_MAX_SPACING, step: 1 }, (v) => {
    if (v < GRID_MIN_SPACING || v > GRID_MAX_SPACING) return;
    g.spacing = v;
    spacing.querySelectorAll('.grid-spacing').forEach((b) => b.classList.toggle('active', Number(b.textContent) === v));
    apply();
  });
  custom.style.width = '64px';

  const deg = Math.round(((g.rotation * 180) / Math.PI) * 10) / 10;
  const rotation = sliderInput(deg, { min: 0, max: 89.5, step: 0.5, format: (v) => `${v.toFixed(1)}°` }, (v) => {
    g.rotation = normalizeGridRotation((v * Math.PI) / 180);
    apply();
  });
  const originX = numberInput(Math.round(g.originX * 10) / 10, { min: -2000, max: 2000, step: 1 }, (v) => {
    g.originX = v;
    apply();
  });
  const originZ = numberInput(Math.round(g.originZ * 10) / 10, { min: -2000, max: 2000, step: 1 }, (v) => {
    g.originZ = v;
    apply();
  });
  originX.style.width = originZ.style.width = '72px';

  const blockOptions = Array.from({ length: GRID_MAX_BLOCK_CELLS }, (_, i) => ({
    value: String(i + 1),
    label: `${i + 1} cell${i ? 's' : ''}, ${((i + 1) * g.spacing).toFixed(0)} m`,
  }));

  panel.append(
    el('div', { class: 'opt-title', text: 'Grid' }),
    row('Snap to grid', snapCheckbox(ui, render), `Toggle with ${GRID_HOTKEY}`),
    row(
      'Snap to visible subdivisions',
      checkbox(g.snapSubdivisions, (v) => {
        g.snapSubdivisions = v;
        apply();
      }),
      'On: zoom in for finer lines and finer snapping, down to 0.5 m. Off: base spacing only',
    ),
    el('div', { class: 'opt-title', text: 'Spacing (m)' }),
    spacing,
    row('Custom', custom, `Any spacing from ${GRID_MIN_SPACING} to ${GRID_MAX_SPACING} m`),
    el('div', { class: 'opt-title', text: 'Rotation' }),
    rotation,
    el('div', { class: 'opt-title', text: 'Origin' }),
    el('div', { class: 'opt-row' }, row('X', originX), row('Z', originZ)),
    row(
      'Major lines',
      selectInput(
        [
          { value: '4', label: 'Every 4' },
          { value: '5', label: 'Every 5' },
        ],
        String(g.majorEvery),
        (v) => {
          g.majorEvery = Number(v);
          apply();
        },
      ),
    ),
    row(
      'Block size',
      selectInput(blockOptions, String(g.blockCells), (v) => {
        g.blockCells = Number(v);
        apply();
      }),
      'Grid Block tool: grid cells per street block',
    ),
    el(
      'div',
      { class: 'opt-row' },
      el('button', {
        class: 'btn grid-align',
        text: 'Align to road',
        tip: 'Click a road next: the grid turns and shifts so a line runs along it there',
        attrs: { type: 'button' },
        on: {
          click: () => {
            closeGridPopover();
            tools.alignGrid();
          },
        },
      }),
      el('button', {
        class: 'btn grid-reset',
        text: 'Reset',
        tip: 'Back to 32 m, no rotation, origin at the map centre',
        attrs: { type: 'button' },
        on: {
          click: () => {
            resetGrid(g);
            apply(true);
          },
        },
      }),
    ),
    el('div', { class: 'small muted', text: 'Off by default. Free and curved roads are untouched while snapping is off. Ctrl or Cmd skips all snapping.' }),
  );
}

function snapCheckbox(ui: UiContext, render: () => void): HTMLInputElement {
  const input = el('input', {
    attrs: { type: 'checkbox' },
    on: {
      change: () => {
        ui.tools.settings.grid.enabled = input.checked;
        ui.tools.settingsChanged();
        render();
      },
    },
  });
  input.checked = ui.tools.settings.grid.enabled;
  return input;
}
