/** Info view buttons down the left edge. */
import type { OverlayMode } from '../render/api';
import type { UiContext } from './context';
import { el, iconButton } from './dom';
import { ICONS } from './icons';
import { keyHint } from './keymap';

export class InfoBar {
  private readonly buttons = new Map<OverlayMode, HTMLButtonElement>();
  private overlay: OverlayMode = 'none';
  private underground = false;
  private shadows = true;
  private readonly undergroundBtn: HTMLButtonElement;
  private readonly shadowBtn: HTMLButtonElement;

  constructor(private readonly ui: UiContext) {
    const bar = el('div', { class: 'panel infobar' });
    const mode = (m: OverlayMode, icon: string, tip: string) => {
      const btn = iconButton(icon, { tip, onClick: () => this.setOverlay(this.overlay === m ? 'none' : m) });
      this.buttons.set(m, btn);
      bar.append(btn);
    };
    mode('traffic', ICONS.heat, 'Traffic heatmap');
    mode('speedLimit', ICONS.speed, 'Speed limits');
    mode('lanes', ICONS.lanes, 'Lanes');
    mode('roadType', ICONS.type, 'Road types');
    const ids: Record<string, string> = { traffic: 'view.traffic', speedLimit: 'view.speed', lanes: 'view.lanes', roadType: 'view.types' };
    for (const [m, btn] of this.buttons) {
      const k = keyHint(ids[m]);
      if (k) btn.dataset.key = k;
    }
    this.undergroundBtn = iconButton(ICONS.underground, { tip: 'Underground view', keyHint: keyHint('view.underground'), onClick: () => this.toggleUnderground() });
    this.shadowBtn = iconButton(ICONS.sun, {
      tip: 'Shadows',
      keyHint: keyHint('view.shadows'),
      class: 'active',
      onClick: () => {
        this.shadows = !this.shadows;
        ui.renderer.setShadows(this.shadows);
        this.shadowBtn.classList.toggle('active', this.shadows);
      },
    });
    bar.append(this.undergroundBtn, this.shadowBtn);
    ui.host.append(bar);
  }

  setOverlay(mode: OverlayMode): void {
    this.overlay = mode;
    this.ui.renderer.setOverlay(mode);
    for (const [m, btn] of this.buttons) btn.classList.toggle('active', m === mode);
  }

  /** Turn an overlay on, or off when it is already on. */
  toggleOverlay(mode: OverlayMode): void {
    this.setOverlay(this.overlay === mode ? 'none' : mode);
  }

  toggleShadows(): void {
    this.shadowBtn.click();
  }

  toggleUnderground(): void {
    this.underground = !this.underground;
    this.ui.renderer.setUnderground(this.underground);
    this.undergroundBtn.classList.toggle('active', this.underground);
  }
}
