/**
 * Keys and palette commands for the Modify > Upgrade cards. Pure (no DOM at
 * import), so the keymap tests can check them for clashes.
 */
import { UPGRADE_CARDS, type UpgradeCardId } from '../core/upgradeTypes';
import type { UiContext } from './context';
import { registerKeys, type KeyBinding } from './keymap';

/** Switch to Modify > Upgrade with a card picked (null: the road-type upgrade). */
export function pickUpgradeCard(ui: UiContext, id: UpgradeCardId | null): void {
  const s = ui.tools.settings;
  s.drawMode = 'upgrade';
  s.upgradeCards.card = id;
  // The old "Upgrade paints" choice is now the cards; with none picked Upgrade changes the road type.
  s.walls.upgrade = 'road';
  if (ui.tools.active.id !== 'road') ui.tools.setTool('road');
  ui.tools.settingsChanged();
}

/** Pick a style of a card, and the card with it. */
export function pickUpgradeStyle(ui: UiContext, id: UpgradeCardId, style: string): void {
  ui.tools.settings.upgradeCards.styles[id] = style;
  pickUpgradeCard(ui, id);
}

/** Shift+1 to Shift+7 pick the cards while drawing or upgrading; every card and style is in the palette. */
export function upgradeKeys(ui: UiContext): KeyBinding[] {
  const out: KeyBinding[] = [];
  UPGRADE_CARDS.forEach((c, i) => {
    out.push({
      id: `upgrade.${c.id}`,
      label: `Upgrade: ${c.label}`,
      group: 'Road upgrades',
      keys: [`Shift+${i + 1}`],
      scope: 'tool:road',
      desc: `${c.desc}. Click the middle of a road for both sides, near an edge for one`,
      icon: 'upgrade',
      run: (a) => {
        pickUpgradeCard(ui, c.id);
        if (a.currentTab !== 'modify') a.openTab('modify');
      },
    });
    out.push({
      id: `upgrade.open.${c.id}`,
      label: `Road upgrade: ${c.label}`,
      group: 'Road upgrades',
      keys: [],
      scope: 'global',
      desc: c.desc,
      run: (a) => {
        pickUpgradeCard(ui, c.id);
        if (a.currentTab !== 'modify') a.openTab('modify');
      },
    });
    if (c.styles.length > 1) {
      for (const st of c.styles) {
        out.push({
          id: `upgrade.style.${c.id}.${st.value}`,
          label: `Road upgrade: ${c.label}, ${st.label}`,
          group: 'Road upgrades',
          keys: [],
          scope: 'global',
          desc: st.desc,
          run: (a) => {
            pickUpgradeStyle(ui, c.id, st.value);
            if (a.currentTab !== 'modify') a.openTab('modify');
          },
        });
      }
    }
  });
  return out;
}

let registered = false;

export function registerUpgradeKeys(ui: UiContext): void {
  if (registered) return;
  registered = true;
  registerKeys(upgradeKeys(ui));
}

