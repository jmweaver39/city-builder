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
  clampMinSpacing,
  GRID_MAX_SPACING,
  GRID_MIN_SPACING,
  GRID_MIN_SPACINGS,
  GRID_SPACINGS,
  gridMinSpacing,
  loadGridPrefs,
  normalizeGridRotation,
  resetGrid,
  saveGridPrefs,
  type GridPrefStore,
} from '../tools/grid';
import { PARALLEL_PRESETS } from '../tools/parallel';
import type { GuideToggles } from '../tools/guides';
import { registerKeys } from './keymap';
import { MOD_KEY } from '../tools/platform';
import { GUIDE_KEYS } from './guideKeys';
import type { UiContext } from './context';
import { checkbox, el, iconButton, numberInput, row, selectInput, sliderInput } from './dom';
import { formatSpacing, GRID_FINEST } from '../render/gridLevels';

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const GRID_ICONS = {
  grid: svg('<path d="M4 8h16M4 16h16M8 4v16M16 4v16"/><circle cx="16" cy="16" r="1.6" fill="currentColor"/>'),
  settings: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  guideParallel: svg('<path d="M4 18 18 4M8 21 21 8" stroke-dasharray="3 2.5"/>'),
  guidePerpendicular: svg('<path d="M4 20h16M10 20V5"/><path d="M10 16h4v4"/>'),
  guideExtension: svg('<path d="M3 20 11 12"/><path d="M13 10l8-8" stroke-dasharray="2.5 2.5"/>'),
  guideLineup: svg('<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 9v9h9" stroke-dasharray="2.5 2.5"/>'),
  guideSpacing: svg('<path d="M4 3v18M12 3v18M20 3v18"/><path d="M5 12h6M13 12h6" stroke-dasharray="2 2"/>'),
  guideMidpoint: svg('<path d="M3 16h18"/><path d="M12 16V8M9 11l3-3 3 3"/><circle cx="12" cy="16" r="1.6" fill="currentColor"/>'),
  parallel: svg('<path d="M5 20C5 11 9 6 18 4"/><path d="M10 21c0-7 3-11 10-13" stroke-dasharray="2.5 2.5"/>'),
};

export const GRID_HOTKEY = 'G';

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
  registerKeys(GUIDE_KEYS);
  registerKeys([
    {
      id: 'grid.minLarger',
      label: 'Smallest grid larger',
      group: 'View',
      keys: [],
      scope: 'global',
      desc: 'Bigger squares close up: grid lines and snapping stop subdividing at the next size up',
      run: () => stepMinSpacing(ui, 1),
    },
    {
      id: 'grid.minSmaller',
      label: 'Smallest grid smaller',
      group: 'View',
      keys: [],
      scope: 'global',
      desc: 'Finer squares close up, down to 0.5 m',
      run: () => stepMinSpacing(ui, -1),
    },
  ]);
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

/** Step the smallest grid through its presets, never above the base spacing. */
export function stepMinSpacing(ui: UiContext, dir: 1 | -1): void {
  const g = ui.tools.settings.grid;
  const cur = gridMinSpacing(g);
  const fits = GRID_MIN_SPACINGS.filter((m) => m <= g.spacing + 1e-9);
  const next = dir > 0 ? fits.find((m) => m > cur + 1e-9) ?? fits[fits.length - 1] : [...fits].reverse().find((m) => m < cur - 1e-9) ?? GRID_FINEST;
  g.minSpacing = next;
  ui.tools.settingsChanged();
  ui.toast(`Smallest grid ${formatSpacing(next)}`, 'info');
}

/** Turn grid snapping on or off. */
export function toggleGridSnap(ui: UiContext): void {
  const g = ui.tools.settings.grid;
  g.enabled = !g.enabled;
  ui.tools.settingsChanged();
  ui.toast(g.enabled ? `Grid on, ${g.spacing} m (G hides it)` : 'Grid off', 'info');
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

const GUIDE_BUTTONS: { key: keyof GuideToggles; icon: keyof typeof GRID_ICONS; tip: string }[] = [
  { key: 'parallel', icon: 'guideParallel', tip: 'Parallel guides: run alongside nearby roads, kerb to kerb, a verge apart, or on aligned grid lines. Follows curves' },
  { key: 'perpendicular', icon: 'guidePerpendicular', tip: 'Perpendicular guides: leave or meet a road at exactly 90 degrees' },
  { key: 'extension', icon: 'guideExtension', tip: 'Extension lines: line up with the straight continuation of road ends and straight roads, however far' },
  { key: 'lineup', icon: 'guideLineup', tip: 'Line up with junctions and road ends nearby, along the grid axes' },
  { key: 'spacing', icon: 'guideSpacing', tip: 'Equal spacing: beside two parallel roads, place the next at the same gap' },
  { key: 'midpoint', icon: 'guideMidpoint', tip: 'Midpoints: snap to the middle of a road' },
];

/** Toggles for each smart guide type. Shift while drawing locks the guide direction. */
export function guideToggleRow(ui: UiContext): HTMLElement {
  const rowEl = el('div', { class: 'opt-row', style: { flexWrap: 'wrap' } });
  for (const b of GUIDE_BUTTONS) {
    rowEl.append(
      iconButton(GRID_ICONS[b.icon], {
        tip: `${b.tip}. Hold Shift to lock the direction, ${MOD_KEY} turns all snapping off`,
        class: `snap-btn guide-btn guide-${b.key}`,
        onClick: () => {
          const g = ui.tools.settings.guides;
          g[b.key] = !g[b.key];
          ui.tools.settingsChanged();
        },
      }),
    );
  }
  return rowEl;
}

/** Reflect state in the grid buttons. */
export function syncGridControls(root: HTMLElement, ui: UiContext): void {
  const s = ui.tools.settings;
  const active = ui.tools.active.id;
  root.querySelector('.snap-grid')?.classList.toggle('active', s.grid.enabled);
  for (const b of GUIDE_BUTTONS) root.querySelector(`.guide-${b.key}`)?.classList.toggle('active', s.guides[b.key]);
  root.querySelector('.parallel-btn')?.classList.toggle('active', active === 'parallel');
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
        g.minSpacing = clampMinSpacing(g.minSpacing, m);
        apply(true);
      },
    });
    spacing.append(b);
  }
  const custom = numberInput(g.spacing, { min: GRID_MIN_SPACING, max: GRID_MAX_SPACING, step: 1 }, (v) => {
    if (v < GRID_MIN_SPACING || v > GRID_MAX_SPACING) return;
    g.spacing = v;
    g.minSpacing = clampMinSpacing(g.minSpacing, v);
    spacing.querySelectorAll('.grid-spacing').forEach((b) => b.classList.toggle('active', Number(b.textContent) === v));
    syncMin();
    apply();
  });
  custom.style.width = '64px';

  // Smallest grid: presets above the base spacing are greyed out.
  const minRow = el('div', { class: 'opt-row', style: { flexWrap: 'wrap' } });
  const minButtons = GRID_MIN_SPACINGS.map((m) => {
    const b = iconButton('', {
      tip: `Squares never smaller than ${formatSpacing(m)}, however close you zoom`,
      label: `${m}`,
      class: 'grid-min',
      onClick: () => {
        if (m > g.spacing) return;
        g.minSpacing = m;
        minCustom.value = String(m);
        syncMin();
        apply();
      },
    });
    b.dataset.min = String(m);
    minRow.append(b);
    return b;
  });
  const minCustom = numberInput(gridMinSpacing(g), { min: GRID_FINEST, max: g.spacing, step: 0.5 }, (v) => {
    if (v < GRID_FINEST || v > g.spacing) return;
    g.minSpacing = v;
    syncMin();
    apply();
  });
  minCustom.style.width = '64px';
  function syncMin(): void {
    const cur = gridMinSpacing(g);
    for (const b of minButtons) {
      const m = Number(b.dataset.min);
      b.disabled = m > g.spacing + 1e-9;
      b.classList.toggle('active', Math.abs(m - cur) < 1e-9);
    }
    minCustom.max = String(g.spacing);
    if (document.activeElement !== minCustom) minCustom.value = String(cur);
  }
  syncMin();

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

  panel.append(
    el('div', { class: 'opt-title', text: 'Grid' }),
    row('Snap to grid', snapCheckbox(ui, render), `Toggle with ${GRID_HOTKEY}`),
    row(
      'Snap to visible subdivisions',
      checkbox(g.snapSubdivisions, (v) => {
        g.snapSubdivisions = v;
        apply();
      }),
      'On: zoom in for finer lines and finer snapping, down to the smallest grid. Off: base spacing only',
    ),
    el('div', { class: 'opt-title', text: 'Spacing (m)' }),
    spacing,
    row('Custom', custom, `Any spacing from ${GRID_MIN_SPACING} to ${GRID_MAX_SPACING} m`),
    el('div', { class: 'opt-title', text: 'Smallest grid (m)', tip: 'Zoomed in, lines and snapping stop subdividing at this size, so squares stay large' }),
    minRow,
    row('Custom', minCustom, 'Any size from 0.5 m up to the spacing. Subdivisions halve the spacing, so the finest is the last halving at least this big'),
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
      'Origin on road centreline',
      checkbox(g.alignOrigin, (v) => {
        g.alignOrigin = v;
        apply();
      }),
      'Align to road puts the grid origin on the road, so grid lines run at exact multiples of the spacing from it',
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
        tip: 'Back to 32 m, no rotation, origin at the map centre, smallest grid 0.5 m',
        attrs: { type: 'button' },
        on: {
          click: () => {
            resetGrid(g);
            apply(true);
          },
        },
      }),
    ),
    el('div', { class: 'small muted', text: `Off by default. Free and curved roads are untouched while snapping is off. Hold ${MOD_KEY} to skip all snapping.` }),
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

// ---------------------------------------------------------------------------
// Parallel Road tool: button and options
// ---------------------------------------------------------------------------

/** The Parallel Road tool button and its options button, for the draw mode row. */
export function parallelButtons(ui: UiContext): HTMLElement[] {
  const tool = iconButton(GRID_ICONS.parallel, {
    tip: 'Parallel road: point beside a road and click for a copy at the chosen offset on that side. Drag to copy just some pieces. [ and ] change the offset',
    class: 'parallel-btn',
    onClick: () => ui.tools.setTool(ui.tools.active.id === 'parallel' ? 'road' : 'parallel'),
  });
  const options = iconButton(GRID_ICONS.settings, {
    tip: 'Parallel road options: offset, direction, road type',
    class: 'parallel-settings-btn',
    onClick: () => openParallelPopover(ui, options),
  });
  return [tool, options];
}

function openParallelPopover(ui: UiContext, anchor: HTMLElement): void {
  if (closeGridPopover()) {
    ui.tools.settingsChanged();
    return;
  }
  const panel = el('div', {
    class: 'panel grid-popover parallel-popover',
    attrs: { role: 'dialog', 'aria-label': 'Parallel road options' },
    style: { position: 'fixed', zIndex: '60', width: '250px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px' },
  });
  popover = panel;
  const p = ui.tools.settings.parallel;
  const render = () => {
    panel.replaceChildren();
    const presets = el('div', { class: 'opt-row', style: { flexWrap: 'wrap' } });
    for (const o of PARALLEL_PRESETS) {
      presets.append(
        iconButton('', {
          tip: o === null ? 'Edges touching' : `${o} m centre to centre`,
          label: o === null ? 'Touch' : `${o}`,
          class: `parallel-offset ${p.offset === o ? 'active' : ''}`,
          onClick: () => {
            p.offset = o;
            ui.tools.settingsChanged();
            render();
          },
        }),
      );
    }
    const custom = numberInput(p.offset ?? 0, { min: 0, max: 200, step: 1 }, (v) => {
      if (v <= 0) return;
      p.offset = v;
      presets.querySelectorAll('.parallel-offset').forEach((b) => b.classList.remove('active'));
      ui.tools.settingsChanged();
    });
    custom.style.width = '64px';
    panel.append(
      el('div', { class: 'opt-title', text: 'Parallel road' }),
      el('div', { class: 'opt-title', text: 'Offset (m, centre to centre)' }),
      presets,
      row('Custom', custom),
      row(
        'Direction',
        selectInput(
          [
            { value: 'auto', label: 'Auto (one-ways reversed)' },
            { value: 'same', label: 'Same way' },
            { value: 'opposite', label: 'Opposite way' },
          ],
          p.direction,
          (v) => {
            p.direction = v as typeof p.direction;
            ui.tools.settingsChanged();
          },
        ),
      ),
      row(
        'Road type',
        selectInput(
          [
            { value: 'same', label: 'Same as original' },
            { value: 'selected', label: 'Selected in panel' },
          ],
          p.roadType,
          (v) => {
            p.roadType = v as typeof p.roadType;
            ui.tools.settingsChanged();
          },
        ),
      ),
      el('div', { class: 'small muted', text: 'Refused where it would overlap other roads. The ends join roads they land on.' }),
    );
  };
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
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  unbind = () => {
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
  };
  ui.tools.settingsChanged();
}
