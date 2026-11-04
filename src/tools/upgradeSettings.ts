/** Editor settings for the Modify > Upgrade cards (UpgradeCardTool.ts). */
import { UPGRADE_CARDS, type UpgradeCardId } from '../core/upgradeTypes';

export interface UpgradeCardSettings {
  /** The card a click applies, or null for the road-type upgrade. */
  card: UpgradeCardId | null;
  /** Style picked on each card. */
  styles: Record<UpgradeCardId, string>;
}

export function defaultUpgradeCardSettings(): UpgradeCardSettings {
  const styles = {} as Record<UpgradeCardId, string>;
  for (const c of UPGRADE_CARDS) styles[c.id] = c.defaultStyle;
  return { card: null, styles };
}
