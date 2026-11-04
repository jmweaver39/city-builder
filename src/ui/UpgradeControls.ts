/**
 * The Modify > Upgrade cards: a row of picture cards (street lights, sound
 * barriers, walls, trees, guard rails, stops, remove), the chosen card's style
 * picker in the options strip, their keys and palette commands, and the segment
 * inspector's toggles for the same upgrades. The editing itself is in
 * tools/UpgradeCardTool.ts and core/roadUpgrades.ts.
 */
import { hasMedian, mirrorUpgrades, readUpgrade, upgradePatch } from '../core/roadUpgrades';
import { BARRIER_MAX_HEIGHT, BARRIER_MIN_HEIGHT, WALL_STYLES } from '../core/wallTypes';
import { UPGRADE_CARDS, upgradeCard, type UpgradeCardId, type UpgradePlace } from '../core/upgradeTypes';
import type { Id, SegmentOverrides } from '../core/types';
import { connectedRoadOriented, type RoadPiece } from '../tools/roadOps';
import type { UiContext } from './context';
import { clear, el, row, selectInput, sliderInput } from './dom';
import { keyHint } from './keymap';
import { pickUpgradeCard, pickUpgradeStyle, registerUpgradeKeys } from './upgradeKeys';
import { STYLE_ART, UPGRADE_ART } from './upgradeArt';

export { pickUpgradeCard, pickUpgradeStyle, registerUpgradeKeys, upgradeKeys } from './upgradeKeys';

// ---------------------------------------------------------------------------
// The tray
// ---------------------------------------------------------------------------

/** The upgrade cards, then a separator before the road-type cards. */
export function renderUpgradeCards(ui: UiContext, cards: HTMLElement): void {
  registerUpgradeKeys(ui);
  for (const c of UPGRADE_CARDS) {
    cards.append(
      el(
        'button',
        {
          class: 'card card-icon upgrade-card',
          dataset: { upgrade: c.id },
          tip: c.label,
          desc: c.desc,
          keyHint: keyHint(`upgrade.${c.id}`),
          attrs: { type: 'button', 'aria-label': c.label },
          on: { click: () => pickUpgradeCard(ui, ui.tools.settings.upgradeCards.card === c.id ? null : c.id) },
        },
        el('div', { class: 'art picture', html: UPGRADE_ART[c.id] }),
        el('div', { class: 'card-name', text: c.label }),
        el('div', { class: 'card-meta', text: c.desc }),
      ),
    );
  }
  cards.append(pasteStyleCard(ui));
  cards.append(el('div', { class: 'card-sep', attrs: { 'aria-hidden': 'true' } }));
}

const PASTE_ART =
  '<svg viewBox="0 0 48 32" aria-hidden="true"><rect x="15" y="5" width="18" height="23" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="19" y="2.5" width="10" height="5" rx="1.5" fill="currentColor"/><path d="M19 15h10M19 20h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/** Upgrade's Paste style: sweep a road copied with a middle click over other roads (tools/clipboard.ts). */
export function pickPasteStyle(ui: UiContext): void {
  const s = ui.tools.settings;
  s.drawMode = 'upgrade';
  s.upgradeCards.card = null;
  s.walls.upgrade = 'style';
  if (s.roadStyle) s.roadType = s.roadStyle.roadType;
  if (ui.tools.active.id !== 'road') ui.tools.setTool('road');
  ui.tools.settingsChanged();
  if (!s.roadStyle) ui.toast('Middle-click or Option+click a road first to copy its style.', 'info');
}

function pasteStyleCard(ui: UiContext): HTMLElement {
  const held = ui.tools.settings.roadStyle;
  return el(
    'button',
    {
      class: 'card card-icon upgrade-card paste-style-card',
      dataset: { paste: 'style' },
      tip: 'Paste style',
      desc: held ? `Click or drag over roads to give them the copied ${held.name}` : 'Middle-click or Option+click a road to copy its type, lanes and upgrades, then sweep it over others',
      attrs: { type: 'button', 'aria-label': 'Paste copied road style' },
      on: { click: () => pickPasteStyle(ui) },
    },
    el('div', { class: 'art picture', html: PASTE_ART }),
    el('div', { class: 'card-name', text: 'Paste style' }),
    el('div', { class: 'card-meta', text: held ? held.name : 'Copy a road first' }),
  );
}

/** The options strip for Upgrade: the picked card's styles, or what a road card does. Re-renders itself. */
export function upgradeOptions(ui: UiContext): HTMLElement {
  const box = el('div', { class: 'upgrade-options' });
  let shown = '';
  const shownKey = () => {
    const s = ui.tools.settings;
    const id = s.upgradeCards.card;
    return `${id}:${id ? s.upgradeCards.styles[id] : ''}:${s.walls.upgrade}:${s.roadStyle?.name ?? ''}`;
  };
  const render = () => {
    clear(box);
    const s = ui.tools.settings;
    const id = s.upgradeCards.card;
    shown = shownKey();
    if (!id && s.walls.upgrade === 'style') {
      box.append(el('div', { class: 'opt-title', text: 'Paste style' }));
      box.append(el('p', { class: 'opt-help', text: s.roadStyle ? `Click or drag over roads to give them ${s.roadStyle.name}: type, lanes, surface, structure and upgrades.` : 'Middle-click or Option+click a road to copy it, then click or drag over roads to paste.' }));
      return;
    }
    if (!id) {
      box.append(el('p', { class: 'opt-help', text: 'Pick an upgrade card, or a road card to sweep a new road type over roads.' }));
      return;
    }
    const card = upgradeCard(id);
    const style = s.upgradeCards.styles[id];
    box.append(el('div', { class: 'opt-title', text: card.label }));
    if (card.styles.length > 1) {
      const styles = el('div', { class: 'opt-row upgrade-styles', attrs: { role: 'radiogroup', 'aria-label': `${card.label} style` } });
      for (const st of card.styles) {
        styles.append(
          el('button', {
            class: `upgrade-style ${st.value === style ? 'active' : ''}`,
            tip: st.label,
            desc: st.desc,
            html: STYLE_ART[`${id}.${st.value}`] ?? '',
            dataset: { style: st.value },
            attrs: { type: 'button', role: 'radio', 'aria-label': st.label, 'aria-checked': String(st.value === style) },
            on: { click: () => pickUpgradeStyle(ui, id, st.value) },
          }),
        );
      }
      box.append(styles, el('div', { class: 'upgrade-style-name', text: card.styles.find((x) => x.value === style)?.label ?? '' }));
    }
    if (id === 'barriers') {
      box.append(
        row('Height', sliderInput(s.walls.barrierHeight, { min: BARRIER_MIN_HEIGHT, max: BARRIER_MAX_HEIGHT, step: 0.5, format: (v) => `${v} m` }, (v) => {
          s.walls.barrierHeight = v;
          ui.tools.settingsChanged();
        })),
      );
    }
    if (id === 'structure') {
      box.append(
        row('Wall finish', selectInput(WALL_STYLES, s.walls.style, (v) => {
          s.walls.style = v;
          ui.tools.settingsChanged();
        })),
      );
    }
    const how =
      id === 'remove'
        ? 'Click a side to clear it, or the middle to clear the whole road. Drag along to clear more.'
        : card.median
          ? 'Middle: both sides, or the median. Near an edge: that side. Drag along. Click again to take it off.'
          : 'Middle: both sides. Near an edge: that side. Drag along. Click again to take it off.';
    box.append(el('p', { class: 'opt-help', text: how }));
  };
  render();
  ui.tools.onChange(() => {
    if (!box.isConnected) return;
    if (shownKey() !== shown) render();
  });
  return box;
}

// ---------------------------------------------------------------------------
// Segment inspector
// ---------------------------------------------------------------------------

const PLACE_LABEL: Record<UpgradePlace, string> = { left: 'Left', median: 'Median', right: 'Right' };

/**
 * The inspector's Road upgrades section: lights, trees, guard rails and stops on
 * each side and the median, as the cards set them. Barriers and walls are in the
 * Structure section above. `whole` runs edits along the connected road, sides
 * swapped on pieces drawn the other way so they stay put in the world.
 */
export function upgradeSection(ui: UiContext, id: Id, whole: () => boolean, rerender: () => void): HTMLElement {
  const { net, history } = ui;
  const seg = net.getSegment(id)!;
  const def = net.roadTypeOf(id);
  const box = el('div', { class: 'upgrade-section' });
  if (def.category === 'rail') return box;
  const places: UpgradePlace[] = hasMedian(def) ? ['left', 'median', 'right'] : ['left', 'right'];
  const pieces = (): RoadPiece[] => (whole() ? connectedRoadOriented(net, id) : [{ id, flipped: false }]);

  const apply = (card: UpgradeCardId, place: UpgradePlace, make: (o: SegmentOverrides) => SegmentOverrides) => {
    history.hint(upgradeCard(card).label, `upgrade-${card}-${place}:${id}`);
    net.batch(() => {
      for (const p of pieces()) {
        const own = net.getSegment(p.id);
        if (!own) continue;
        const flip = p.flipped && place !== 'median';
        const here: SegmentOverrides = flip ? { ...own.overrides, upgrades: own.overrides.upgrades && mirrorUpgrades(own.overrides.upgrades) } : own.overrides;
        const patch = make(here);
        if (flip && patch.upgrades) patch.upgrades = mirrorUpgrades(patch.upgrades);
        net.setSegmentOverrides(p.id, patch);
      }
    });
    rerender();
  };

  box.append(el('div', { class: 'section-title', text: 'Road upgrades' }));
  const head = el('div', { class: 'field upgrade-grid', style: { gridTemplateColumns: `60px repeat(${places.length}, 1fr)` } }, el('span', {}));
  for (const p of places) head.append(el('span', { class: 'field-label', text: PLACE_LABEL[p] }));
  box.append(head);

  const cards: UpgradeCardId[] = ['lights', 'trees', 'rails', 'stops'];
  for (const card of cards) {
    const c = upgradeCard(card);
    const line = el('div', { class: 'field upgrade-grid', style: { gridTemplateColumns: `60px repeat(${places.length}, 1fr)` } }, el('span', { class: 'field-label', text: c.label === 'Street lights' ? 'Lights' : c.label, attrs: { title: c.desc } }));
    for (const place of places) {
      if (card === 'stops') {
        if (place === 'median') {
          line.append(el('span', {}));
          continue;
        }
        const s = seg.overrides.upgrades?.[place];
        const now = s?.busStop && s?.bikeRacks ? 'both' : s?.busStop ? 'bus' : s?.bikeRacks ? 'bike' : 'off';
        line.append(
          selectInput(
            [
              { value: 'off', label: 'None' },
              { value: 'bus', label: 'Bus stop' },
              { value: 'bike', label: 'Bike racks' },
              { value: 'both', label: 'Both' },
            ] as const,
            now,
            (v) =>
              apply(card, place, (o) => {
                const a = upgradePatch(o, 'stops', 'bus', [place], v === 'bus' || v === 'both');
                return upgradePatch({ ...o, ...a }, 'stops', 'bike', [place], v === 'bike' || v === 'both');
              }),
          ),
        );
        continue;
      }
      const now = readUpgrade(seg.overrides, card, place) ?? 'off';
      const options = [{ value: 'off', label: card === 'lights' ? 'Automatic' : 'None' }, ...c.styles.map((s) => ({ value: s.value, label: s.label }))];
      line.append(selectInput(options, now, (v) => apply(card, place, (o) => upgradePatch(o, card, v, [place], v !== 'off'))));
    }
    box.append(line);
  }
  return box;
}
