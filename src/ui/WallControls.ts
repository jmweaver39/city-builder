/**
 * Controls for road structures, walls, sound barriers and quays: the Structure
 * options in the road panel, the Upgrade target, the inspector's section and the
 * Landscaping tray. Built from the shared dom helpers and classes, so the panel
 * styling applies to them.
 */
import type { Id, SegmentOverrides } from '../core/types';
import { BARRIER_MAX_HEIGHT, BARRIER_MIN_HEIGHT, BARRIER_KINDS, QUAY_STYLES, QUAY_TOPS, STRUCTURE_MODES, WALL_STYLES, WALL_TOPS, type BarrierKind, type BarrierSide, type StructureMode, type StructureSpec, type WallSide } from '../core/wallTypes';
import { isEarthwork, mirrorBarriers, mirrorStructure, segmentFootprintIssues, structureExtents, wallHeight, wallSide, segmentSections } from '../core/walls';
import { connectedRoadOriented, type RoadPiece } from '../tools/roadOps';
import { UPGRADE_TARGETS, WALL_SIDES, type WallSides } from '../tools/wallOps';
import type { UiContext } from './context';
import { checkbox, clear, el, numberInput, row, selectInput, sliderInput } from './dom';

// ---------------------------------------------------------------------------
// Road panel: Structure beside Elevation, and what Upgrade paints
// ---------------------------------------------------------------------------

/** The Structure block for the road panel's options strip. Re-renders itself. */
export function roadStructureOptions(ui: UiContext): HTMLElement {
  const box = el('div', { class: 'wall-options' });
  const render = () => {
    clear(box);
    const s = ui.tools.settings;
    const w = s.walls;
    const changed = () => {
      ui.tools.settingsChanged();
      render();
    };
    box.append(
      el('div', { class: 'opt-title', text: 'Structure' }),
      selectInput(STRUCTURE_MODES, w.mode, (v) => {
        w.mode = v;
        changed();
      }),
    );
    if (isEarthwork(w.mode)) {
      box.append(
        row('Walls', selectInput(WALL_SIDES, w.sides, (v) => {
          w.sides = v as WallSides;
          changed();
        })),
        row('Style', selectInput(WALL_STYLES, w.style, (v) => {
          w.style = v;
          changed();
        })),
        row('Top', selectInput(WALL_TOPS, w.top, (v) => {
          w.top = v;
          changed();
        })),
        row('Max height', heightBox(w.height, (v) => {
          w.height = v;
          ui.tools.settingsChanged();
        }), 'Blank follows the road. Above this the rest is an earth slope'),
      );
    }
    if (s.drawMode === 'upgrade') {
      box.append(
        el('div', { class: 'opt-title', text: 'Upgrade paints' }),
        selectInput(UPGRADE_TARGETS, w.upgrade, (v) => {
          w.upgrade = v;
          changed();
        }),
      );
      if (w.upgrade === 'barriers') {
        box.append(
          row('Barrier', selectInput(BARRIER_KINDS, w.barrier, (v) => {
            w.barrier = v as BarrierKind;
            changed();
          })),
          row('Height', sliderInput(w.barrierHeight, { min: BARRIER_MIN_HEIGHT, max: BARRIER_MAX_HEIGHT, step: 0.5, format: (v) => `${v} m` }, (v) => {
            w.barrierHeight = v;
            ui.tools.settingsChanged();
          })),
          row('Sides', selectInput([
            { value: 'both', label: 'Both sides' },
            { value: 'left', label: 'Left of sweep' },
            { value: 'right', label: 'Right of sweep' },
          ] as const, w.barrierSides, (v) => {
            w.barrierSides = v;
            changed();
          })),
        );
      }
    }
  };
  render();
  // Draw mode changes come from elsewhere, so follow them.
  let lastMode = ui.tools.settings.drawMode;
  ui.tools.onChange(() => {
    if (!box.isConnected) return;
    if (ui.tools.settings.drawMode !== lastMode) {
      lastMode = ui.tools.settings.drawMode;
      render();
    }
  });
  return box;
}

function heightBox(value: number | null | undefined, onChange: (v: number | null) => void): HTMLInputElement {
  const input = numberInput(value ?? NaN, { min: 1, max: 40, step: 0.5 }, (v) => onChange(v >= 0.5 ? v : null));
  if (value === null || value === undefined) input.value = '';
  input.placeholder = 'Auto';
  input.addEventListener('change', () => {
    if (input.value.trim() === '') onChange(null);
  });
  return input;
}

// ---------------------------------------------------------------------------
// Segment inspector
// ---------------------------------------------------------------------------

/**
 * The inspector's Structure, walls and barriers section. `whole` says whether
 * edits run along the connected road; pieces drawn the other way get their left
 * and right swapped so walls stay on the same side in the world.
 */
export function structureSection(ui: UiContext, id: Id, whole: () => boolean, rerender: () => void): HTMLElement {
  const { net, history } = ui;
  const seg = net.getSegment(id)!;
  const spec: StructureSpec = seg.overrides.structure ?? { mode: 'auto' };
  const box = el('div', {});
  const pieces = (): RoadPiece[] => (whole() ? connectedRoadOriented(net, id) : [{ id, flipped: false }]);

  /** Apply a change, computed on this segment's orientation, to every target. */
  const apply = (label: string, key: string, make: (o: SegmentOverrides) => SegmentOverrides) => {
    history.hint(label, `${key}:${id}`);
    let refused: string | null = null;
    net.batch(() => {
      for (const p of pieces()) {
        const own = net.getSegment(p.id);
        if (!own) continue;
        // Work in this segment's frame, then turn it back for a piece drawn the other way.
        const here: SegmentOverrides = p.flipped
          ? { structure: own.overrides.structure && mirrorStructure(own.overrides.structure), barriers: own.overrides.barriers && mirrorBarriers(own.overrides.barriers) }
          : { structure: own.overrides.structure, barriers: own.overrides.barriers };
        const next = make(here);
        const patch: SegmentOverrides = {};
        if ('structure' in next) patch.structure = next.structure && p.flipped ? mirrorStructure(next.structure) : next.structure;
        if ('barriers' in next) patch.barriers = next.barriers && p.flipped ? mirrorBarriers(next.barriers) : next.barriers;
        if (patch.structure) {
          const bad = segmentFootprintIssues(net, p.id, patch.structure).find((i) => i.severity === 'error');
          if (bad) {
            refused = bad.message;
            continue;
          }
        }
        net.setSegmentOverrides(p.id, patch);
      }
    });
    if (refused) ui.toast(refused, 'error');
    rerender();
  };

  const setMode = (mode: StructureMode) =>
    apply('Change road structure', 'structure-mode', (o) => {
      const cur = o.structure ?? { mode: 'auto' };
      const next: StructureSpec = { ...cur, mode };
      return { structure: mode === 'auto' && !next.left && !next.right ? undefined : next };
    });
  const setSide = (side: -1 | 1, patch: Partial<WallSide>) =>
    apply('Change wall', `wall-${side}-${Object.keys(patch).join()}`, (o) => {
      const cur = o.structure ?? { mode: 'auto' };
      const key = side < 0 ? 'left' : 'right';
      const base = wallSide(cur, side);
      const merged: WallSide = { style: base.style, top: base.top, ...cur[key], ...patch };
      if (merged.height === undefined) delete merged.height;
      return { structure: { ...cur, [key]: merged } };
    });
  const setBarrier = (side: -1 | 1, b: BarrierSide | null) =>
    apply('Change sound barrier', `barrier-${side}`, (o) => {
      const cur = { ...(o.barriers ?? {}) };
      const key = side < 0 ? 'left' : 'right';
      if (b && b.kind !== 'none') cur[key] = b;
      else delete cur[key];
      return { barriers: cur.left || cur.right ? cur : undefined };
    });

  box.append(
    el('div', { class: 'section-title', text: 'Structure and walls' }),
    row('Structure', selectInput(STRUCTURE_MODES, spec.mode, (v) => setMode(v)), 'How the road is carried where it leaves the ground'),
  );
  if (isEarthwork(spec.mode)) {
    const samples = segmentSections(net, id);
    for (const side of [-1, 1] as const) {
      const ws = wallSide(spec, side);
      const name = side < 0 ? 'Left' : 'Right';
      const tallest = Math.max(0, ...samples.map((s) => wallHeight(side < 0 ? s.left : s.right)));
      box.append(
        el(
          'div',
          { class: 'field', style: { gridTemplateColumns: '60px 22px 1fr 1fr' } },
          el('span', { class: 'field-label', text: `${name} wall` }),
          checkbox(ws.on, (v) => setSide(side, { on: v })),
          selectInput(WALL_STYLES, ws.style, (v) => setSide(side, { style: v })),
          selectInput(WALL_TOPS, ws.top, (v) => setSide(side, { top: v })),
        ),
        row(`${name} max height`, heightBox(ws.height, (v) => setSide(side, { height: v ?? undefined })), tallest > 0 ? `Tallest here ${tallest.toFixed(1)} m` : 'No wall stands here'),
      );
    }
    const ext = structureExtents(net, id);
    box.append(el('div', { class: 'small muted', text: `Takes ${ext.left.toFixed(1)} m left and ${ext.right.toFixed(1)} m right of the centreline.` }));
  }
  box.append(el('div', { class: 'section-title', text: 'Sound barriers' }));
  for (const side of [-1, 1] as const) {
    const b = (side < 0 ? seg.overrides.barriers?.left : seg.overrides.barriers?.right) ?? { kind: 'none' as const, height: 3 };
    box.append(
      el(
        'div',
        { class: 'field', style: { gridTemplateColumns: '60px 1fr 92px' } },
        el('span', { class: 'field-label', text: side < 0 ? 'Left' : 'Right' }),
        selectInput(BARRIER_KINDS, b.kind, (v) => setBarrier(side, { kind: v, height: b.height })),
        sliderInput(b.height, { min: BARRIER_MIN_HEIGHT, max: BARRIER_MAX_HEIGHT, step: 0.5, format: (v) => `${v} m` }, (v) => {
          if (b.kind !== 'none') setBarrier(side, { kind: b.kind, height: v });
        }),
      ),
    );
  }
  return box;
}

// ---------------------------------------------------------------------------
// Landscaping tray: quays
// ---------------------------------------------------------------------------

const QUAY_SWATCH: Record<string, string> = {
  concrete: 'linear-gradient(180deg,#d9d5cb 0 14%,#bcb7ac 14% 100%)',
  brick: 'repeating-linear-gradient(0deg,#9c5640 0 5px,#7f7468 5px 6px),#9c5640',
  stone: 'repeating-linear-gradient(0deg,#aaa08b 0 11px,#55524c 11px 12px),#aaa08b',
  timber: 'repeating-linear-gradient(90deg,#6f5539 0 7px,#3b2d1f 7px 8px),#6f5539',
};

/** Cards and options for the Landscaping tab. */
export function renderLandscapeTray(ui: UiContext, options: HTMLElement, cards: HTMLElement): void {
  const w = ui.tools.settings.walls;
  options.append(
    el('div', { class: 'opt-title', text: 'Quay top' }),
    selectInput(QUAY_TOPS, w.quayTop, (v) => {
      w.quayTop = v;
      ui.tools.settingsChanged();
    }),
    el('div', { class: 'small muted', text: 'Click along the river bank. The wall follows the bank and holds the land at road level. Bulldoze removes it.' }),
  );
  for (const s of QUAY_STYLES) {
    const card = el(
      'button',
      {
        class: 'card',
        dataset: { quay: s.value },
        tip: `${s.label} quay wall`,
        attrs: { type: 'button', 'aria-label': `${s.label} quay` },
        on: {
          click: () => {
            w.quayStyle = s.value;
            ui.tools.setTool('quay');
            ui.tools.settingsChanged();
            for (const c of cards.querySelectorAll<HTMLElement>('[data-quay]')) c.classList.toggle('active', c.dataset.quay === s.value);
          },
        },
      },
      el('div', { class: 'art', style: { background: QUAY_SWATCH[s.value], borderRadius: '4px', height: '40px' } }),
      el('div', { class: 'card-name', text: `${s.label} quay` }),
      el('div', { class: 'card-meta', text: 'Along the river' }),
    );
    if (ui.tools.active.id === 'quay' && w.quayStyle === s.value) card.classList.add('active');
    cards.append(card);
  }
}
