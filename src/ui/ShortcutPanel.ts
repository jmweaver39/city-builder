/**
 * The shortcut panel, top right under the top bar. It lists the keys for what you
 * are doing now (the active tool, the selection, the open tray, and a few
 * essentials), read from the keymap. It fades in when the tool or selection
 * changes or a modifier is pressed, stays while you work, and fades out after a
 * few quiet seconds. Hovering that corner or pressing ? brings it back. A setting
 * keeps it always on or always off.
 *
 * '?' also lays keycaps over every control that has a key; holding Option does the
 * same while held.
 */
import { el } from './dom';
import { bindings, compactRows, formatCombo, onKeymapChange, panelRows, type ShortcutState } from './keymap';
import { ICONS, type IconName } from './icons';

export type ShortcutMode = 'auto' | 'always' | 'never';

/** Seconds of quiet before the panel fades. */
export const FADE_AFTER_MS = 2500;
/** Rows shown on a narrow window, before the '?' row. */
const NARROW_ROWS = 4;
const MODE_KEY = 'cloverleaf.shortcuts';

export { panelRows, type ShortcutState } from './keymap';

function loadMode(): ShortcutMode {
  try {
    const v = window.localStorage.getItem(MODE_KEY);
    return v === 'always' || v === 'never' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export class ShortcutPanel {
  readonly root = el('div', { class: 'shortcuts', attrs: { 'aria-label': 'Shortcuts', role: 'complementary' } });
  private readonly overlay = el('div', { class: 'keycap-overlay', attrs: { 'aria-hidden': 'true' } });
  private timer = 0;
  private hovered = false;
  private pinned = false;
  private altHeld = 0;
  private lastKey = '';
  mode: ShortcutMode = loadMode();

  constructor(
    private readonly host: HTMLElement,
    private readonly state: () => ShortcutState,
  ) {
    // Only the panel itself goes in. The keycap overlay is mounted only while it
    // shows, and hover is read from the pointer position, not from an element, so
    // nothing ever sits over the map while the panel is faded out.
    host.append(this.root);
    window.addEventListener('pointermove', (e) => this.trackHover(e.clientX, e.clientY), { passive: true });
    onKeymapChange(() => this.render(true));
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Alt') this.setAlt(false);
    });
    window.addEventListener('blur', () => this.setAlt(false));
    window.addEventListener('resize', () => this.render(true));
    this.render(true);
    this.apply();
  }

  /** Hovering the panel's corner brings it back; the panel's own box is the target. */
  private trackHover(x: number, y: number): void {
    if (this.mode === 'never' && !this.pinned) return;
    const r = this.root.getBoundingClientRect();
    const inside = r.width > 0 && x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8;
    if (inside === this.hovered) return;
    this.hovered = inside;
    if (inside) this.show();
    else this.scheduleHide();
  }

  get visible(): boolean {
    return this.root.classList.contains('visible');
  }

  setMode(mode: ShortcutMode): void {
    this.mode = mode;
    try {
      window.localStorage.setItem(MODE_KEY, mode);
    } catch {
      // Storage blocked: the setting lasts for this visit.
    }
    this.render(true);
    this.apply();
    if (mode === 'auto') this.show();
  }

  /** The tool, selection or tab changed: refresh, and show if it did. */
  contextChanged(): void {
    if (this.render(false)) this.show();
  }

  /** The user is working in the current context: keep the panel up if it is. */
  activity(): void {
    if (this.visible && this.mode === 'auto') this.scheduleHide();
  }

  /** A modifier went down: show the panel, and the keycaps while Option is held. */
  modifier(key: string): void {
    this.show();
    if (key === 'Alt') this.setAlt(true);
  }

  togglePinned(): void {
    this.pinned = !this.pinned;
    this.render(true);
    this.overlayKeys(this.pinned);
    if (this.pinned) this.show();
    else this.scheduleHide();
    this.apply();
  }

  show(): void {
    if (this.mode === 'never' && !this.pinned) return;
    this.render(false);
    this.dodgeInspectors();
    this.root.classList.add('visible');
    this.scheduleHide();
  }

  private scheduleHide(): void {
    window.clearTimeout(this.timer);
    if (this.mode !== 'auto' || this.pinned || this.hovered) return;
    this.timer = window.setTimeout(() => this.apply(true), FADE_AFTER_MS);
  }

  /** Visible or not, from the mode. `fade` lets an auto panel go. */
  private apply(fade = false): void {
    const on = this.pinned || this.mode === 'always' || (this.mode === 'auto' && (this.hovered || (!fade && this.visible)));
    this.root.classList.toggle('visible', on);
    this.root.classList.toggle('pinned', this.pinned);
  }

  private setAlt(on: boolean): void {
    window.clearTimeout(this.altHeld);
    if (on) {
      // A short hold, so Option used as a modifier for a key does not flash keycaps.
      this.altHeld = window.setTimeout(() => this.overlayKeys(true), 350);
    } else if (!this.pinned) this.overlayKeys(false);
  }

  /** Rebuild the rows. Returns true when they changed. */
  private render(force: boolean): boolean {
    const s = this.state();
    const narrow = window.innerWidth < 560;
    const key = `${s.tool}|${s.select}|${s.tab}|${narrow}|${this.mode}|${bindings().length}`;
    if (!force && key === this.lastKey) return false;
    this.lastKey = key;
    const { title, rows } = panelRows(s);
    // A handful of keys for the current step; '?' pins the panel with every key.
    const shown = this.pinned ? rows : compactRows(rows, narrow ? NARROW_ROWS : 5);
    const list = el('div', { class: 'shortcut-rows' });
    for (const r of shown) {
      const icon = r.icon && ICONS[r.icon as IconName] ? el('i', { class: 'shortcut-icon', html: ICONS[r.icon as IconName] }) : el('i', { class: 'shortcut-icon' });
      list.append(el('div', { class: `shortcut-row ${r.scope === 'global' ? 'essential' : ''}`, tip: r.label }, el('kbd', { text: r.keys }), icon, el('span', { text: r.label })));
    }
    if (!this.pinned) list.append(el('div', { class: 'shortcut-row essential more' }, el('kbd', { text: '?' }), el('i', { class: 'shortcut-icon' }), el('span', { text: 'All' })));
    const modes = el('div', { class: 'seg shortcut-mode', attrs: { role: 'radiogroup', 'aria-label': 'Shortcut panel' } });
    for (const [m, label] of [
      ['auto', 'Auto'],
      ['always', 'Always'],
      ['never', 'Hidden'],
    ] as const) {
      modes.append(
        el('button', {
          class: `seg-btn ${this.mode === m ? 'active' : ''}`,
          text: label,
          attrs: { type: 'button', role: 'radio', 'aria-checked': String(this.mode === m) },
          on: { click: () => this.setMode(m) },
        }),
      );
    }
    this.root.replaceChildren(el('div', { class: 'shortcut-title' }, el('span', { text: title }), el('kbd', { text: '?' })), list, modes);
    return true;
  }

  /** Sit left of an inspector that is open in the same corner, never under it. */
  private dodgeInspectors(): void {
    let right = 0;
    for (const panel of this.host.querySelectorAll<HTMLElement>('.inspector')) {
      const r = panel.getBoundingClientRect();
      if (r.right > window.innerWidth - 240 && r.top < 320 && r.left > 240) right = Math.max(right, window.innerWidth - r.left + 8);
    }
    this.root.style.right = right ? `${right}px` : '';
  }

  /** Keycaps over every visible control that names a key. */
  private overlayKeys(on: boolean): void {
    this.overlay.replaceChildren();
    document.body.classList.toggle('show-keys', on);
    if (!on) {
      this.overlay.remove();
      return;
    }
    this.host.append(this.overlay);
    const seen = new Set<string>();
    document.querySelectorAll<HTMLElement>('#ui [data-key]').forEach((target) => {
      const r = target.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > window.innerHeight) return;
      if (target.closest('.shortcuts')) return;
      const spot = `${Math.round(r.right)}:${Math.round(r.top)}`;
      if (seen.has(spot)) return;
      seen.add(spot);
      const raw = target.dataset.key ?? '';
      const cap = el('kbd', { class: 'keycap', text: raw.includes(' ') ? raw : formatCombo(raw) });
      cap.style.left = `${Math.round(r.right - 6)}px`;
      cap.style.top = `${Math.round(r.top - 6)}px`;
      this.overlay.append(cap);
    });
  }
}
