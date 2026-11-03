/**
 * The command palette, on Cmd+K or /. Fuzzy search over every action and setting,
 * each shown with its shortcut, recent commands first. Enter runs, arrows move,
 * Esc closes.
 */
import { el } from './dom';
import { formatCombo } from './keymap';
import { rankCommands, type PaletteCommand } from './search';

export type { PaletteCommand } from './search';
export { fuzzyScore, rankCommands } from './search';

const RECENT_KEY = 'cloverleaf.palette.recent';
const RECENT_MAX = 6;

function loadRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function saveRecent(list: string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    // Storage blocked: recents last for this visit only.
  }
}

export class Palette {
  private root: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private list: HTMLElement | null = null;
  private shown: PaletteCommand[] = [];
  private index = 0;
  private recent = loadRecent();

  constructor(
    private readonly host: HTMLElement,
    private readonly source: () => PaletteCommand[],
  ) {}

  get isOpen(): boolean {
    return this.root !== null;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    if (this.root) return;
    this.input = el('input', {
      class: 'palette-input',
      attrs: { type: 'text', placeholder: 'Search actions and settings', spellcheck: 'false', 'aria-label': 'Search commands', role: 'combobox', 'aria-expanded': 'true' },
      on: {
        input: () => {
          this.index = 0;
          this.render();
        },
        keydown: (e) => this.key(e),
      },
    });
    this.list = el('div', { class: 'palette-list', attrs: { role: 'listbox' } });
    const box = el(
      'div',
      { class: 'panel palette', attrs: { role: 'dialog', 'aria-label': 'Command palette' } },
      el('div', { class: 'palette-head' }, this.input, el('kbd', { text: 'Esc' })),
      this.list,
      el('div', { class: 'palette-foot' }, el('span', {}, el('kbd', { text: '↑' }), el('kbd', { text: '↓' }), ' move'), el('span', {}, el('kbd', { text: '↩' }), ' run')),
    );
    this.root = el('div', { class: 'palette-back' }, box);
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) this.close();
    });
    this.host.append(this.root);
    this.render();
    this.input.focus();
  }

  close(): void {
    this.root?.remove();
    this.root = null;
    this.input = null;
    this.list = null;
  }

  private key(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      this.move(1);
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      this.move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.runAt(this.index);
    }
    e.stopPropagation();
  }

  private move(step: number): void {
    if (!this.shown.length) return;
    this.index = (this.index + step + this.shown.length) % this.shown.length;
    this.highlight();
  }

  private runAt(i: number): void {
    const c = this.shown[i];
    if (!c) return;
    this.recent = [c.id, ...this.recent.filter((id) => id !== c.id)].slice(0, RECENT_MAX);
    saveRecent(this.recent);
    this.close();
    c.run();
  }

  private render(): void {
    if (!this.list || !this.input) return;
    const query = this.input.value;
    this.shown = rankCommands(this.source(), query, this.recent).slice(0, 60);
    this.list.replaceChildren();
    if (!this.shown.length) {
      this.list.append(el('div', { class: 'empty', text: `Nothing matches “${query}”` }));
      return;
    }
    let lastGroup = '';
    this.shown.forEach((c, i) => {
      const isRecent = !query.trim() && this.recent.includes(c.id);
      const group = isRecent ? 'Recent' : query.trim() ? '' : c.group;
      if (group && group !== lastGroup) {
        this.list!.append(el('div', { class: 'palette-group', text: group }));
        lastGroup = group;
      }
      this.list!.append(
        el(
          'button',
          {
            class: 'palette-item',
            dataset: { index: String(i) },
            attrs: { type: 'button', role: 'option' },
            on: {
              click: () => this.runAt(i),
              pointermove: () => {
                if (this.index !== i) {
                  this.index = i;
                  this.highlight();
                }
              },
            },
          },
          el('span', { class: 'palette-label' }, el('span', { text: c.label }), c.desc ? el('span', { class: 'palette-desc', text: c.desc }) : null),
          query.trim() ? el('span', { class: 'palette-tag', text: c.group }) : null,
          c.keys.length ? el('kbd', { text: formatCombo(c.keys[0]) }) : null,
        ),
      );
    });
    this.highlight();
  }

  private highlight(): void {
    this.list?.querySelectorAll<HTMLElement>('.palette-item').forEach((item) => {
      const on = Number(item.dataset.index) === this.index;
      item.classList.toggle('active', on);
      item.setAttribute('aria-selected', String(on));
      if (on) item.scrollIntoView({ block: 'nearest' });
    });
  }
}
