/** Toasts, the shared tooltip, and the readout beside the cursor. */
import type { ToolManager } from '../tools/ToolManager';
import type { ToastKind } from '../tools/types';
import { el } from './dom';

export class Toasts {
  private readonly root = el('div', { class: 'toasts', attrs: { role: 'status', 'aria-live': 'polite' } });
  private lastText = '';
  private lastTime = 0;

  constructor(host: HTMLElement) {
    host.append(this.root);
  }

  show(message: string, kind: ToastKind = 'info'): void {
    const now = performance.now();
    if (message === this.lastText && now - this.lastTime < 1500) return;
    this.lastText = message;
    this.lastTime = now;
    const toast = el('div', { class: `toast ${kind}`, text: message });
    this.root.append(toast);
    while (this.root.children.length > 4) this.root.firstElementChild?.remove();
    setTimeout(() => toast.remove(), kind === 'error' ? 5000 : 3400);
  }
}

/** Any element with data-tip gets this tooltip. data-key names its hotkey. */
export function installTooltips(): void {
  const tip = el('div', { attrs: { id: 'tooltip', role: 'tooltip' } });
  document.body.append(tip);
  let current: HTMLElement | null = null;
  const place = (target: HTMLElement): void => {
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const above = r.top - h - 6 >= 4;
    tip.style.top = `${above ? r.top - h - 6 : r.bottom + 6}px`;
    tip.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, r.left + r.width / 2 - w / 2))}px`;
  };
  document.addEventListener('pointerover', (e) => {
    const target = (e.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null;
    if (target === current) return;
    current = target;
    if (!target) {
      tip.style.display = 'none';
      return;
    }
    tip.textContent = target.dataset.tip ?? '';
    if (target.dataset.key) tip.append(el('kbd', { text: target.dataset.key }));
    tip.style.display = 'block';
    place(target);
  });
  document.addEventListener('pointerdown', () => {
    tip.style.display = 'none';
    current = null;
  });
}

export class CursorHudView {
  private readonly root = el('div', { class: 'cursor-hud' });
  private shown = '';

  constructor(host: HTMLElement, private readonly tools: ToolManager) {
    host.append(this.root);
    tools.onChange(() => this.update());
  }

  private update(): void {
    const hud = this.tools.hud;
    if (!hud) {
      this.root.style.display = 'none';
      this.shown = '';
      return;
    }
    const text = [...hud.lines, '|', ...hud.notes, hud.tone].join('\n');
    if (text !== this.shown) {
      this.shown = text;
      this.root.className = `cursor-hud ${hud.tone}`;
      this.root.replaceChildren(
        ...hud.lines.map((l) => el('div', { text: l })),
        ...(hud.notes.length ? [el('div', { class: 'notes', text: hud.notes.join(' ') })] : []),
      );
    }
    this.root.style.display = 'block';
    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    const x = hud.x + 18 + w > window.innerWidth ? hud.x - w - 14 : hud.x + 18;
    const y = hud.y + 18 + h > window.innerHeight ? hud.y - h - 12 : hud.y + 18;
    this.root.style.transform = `translate(${x}px, ${y}px)`;
    this.root.style.left = '0';
    this.root.style.top = '0';
  }
}
