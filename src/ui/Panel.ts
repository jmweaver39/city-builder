/** Floating draggable panels. */
import { el } from './dom';
import { ICONS } from './icons';

let nextZ = 12;
let cascade = 0;

export class Panel {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  private readonly titleEl: HTMLElement;
  private dragStart: { x: number; y: number; left: number; top: number } | null = null;
  onClose: (() => void) | null = null;

  constructor(host: HTMLElement, title: string, opts: { wide?: boolean; left?: number; top?: number } = {}) {
    this.titleEl = el('div', { class: 'inspector-title', text: title });
    this.kind = title;
    const close = el('button', {
      class: 'icon-btn',
      tip: 'Close',
      html: ICONS.close,
      attrs: { type: 'button', 'aria-label': 'Close' },
      on: { click: () => this.close() },
    });
    close.style.minWidth = '26px';
    close.style.height = '26px';
    const head = el('div', { class: 'inspector-head' }, this.kindEl, this.titleEl, close);
    this.body = el('div', { class: 'inspector-body' });
    this.root = el('div', { class: `panel inspector ${opts.wide ? 'wide' : ''}` }, head, this.pictureEl, this.body);
    // Matches .inspector widths in style.css; narrow windows shrink them to fit.
    const width = Math.min(opts.wide ? 360 : 320, window.innerWidth - 8);
    const narrow = window.innerWidth < 560;
    const left = opts.left ?? (narrow ? 4 : Math.max(60, window.innerWidth - width - 16 - cascade * 24));
    const top = opts.top ?? (narrow ? 56 : 64 + cascade * 24);
    cascade = (cascade + 1) % 5;
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
    this.root.style.zIndex = String(nextZ++);
    host.append(this.root);
    this.root.addEventListener('pointerdown', () => {
      this.root.style.zIndex = String(nextZ++);
    });
    head.addEventListener('pointerdown', (e) => this.startDrag(e, head));
    head.addEventListener('pointermove', (e) => this.drag(e));
    head.addEventListener('pointerup', () => (this.dragStart = null));
    head.addEventListener('pointercancel', () => (this.dragStart = null));
  }

  private startDrag(e: PointerEvent, head: HTMLElement): void {
    if ((e.target as HTMLElement).closest('button')) return;
    const r = this.root.getBoundingClientRect();
    this.dragStart = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    head.setPointerCapture(e.pointerId);
  }

  private drag(e: PointerEvent): void {
    if (!this.dragStart) return;
    const r = this.root.getBoundingClientRect();
    const left = this.dragStart.left + e.clientX - this.dragStart.x;
    const top = this.dragStart.top + e.clientY - this.dragStart.y;
    this.root.style.left = `${Math.max(0, Math.min(window.innerWidth - r.width, left))}px`;
    this.root.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, top))}px`;
  }

  /** Every inspector names what it shows the same way: a kind tag, then the name. */
  private readonly kindEl = el('span', { class: 'inspector-kind' });
  private kind: string;

  /** A picture leads every inspector that has one: road, junction, train. Survives body refreshes. */
  private readonly pictureEl = el('div', { class: 'inspector-picture-slot' });

  setPicture(picture: Node | null): void {
    this.pictureEl.replaceChildren(...(picture ? [el('div', { class: 'inspector-picture' }, picture)] : []));
  }

  setTitle(title: string): void {
    // The title a panel opened with is its kind ("Road", "Junction"); a later
    // name ("Main Street") shows after it.
    this.kindEl.textContent = title === this.kind ? '' : this.kind;
    this.titleEl.textContent = title;
  }

  close(): void {
    this.root.remove();
    this.onClose?.();
  }
}

/** A modal dialog. Returns its close function. */
export function modal(
  host: HTMLElement,
  title: string,
  body: HTMLElement,
  foot: HTMLElement | null,
  narrow = false,
  onClose?: () => void,
): () => void {
  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    back.remove();
    window.removeEventListener('keydown', esc, true);
    onClose?.();
  };
  const esc = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const closeBtn = el('button', { class: 'icon-btn', tip: 'Close', html: ICONS.close, attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: close } });
  closeBtn.style.minWidth = '26px';
  closeBtn.style.height = '26px';
  const dialog = el(
    'div',
    { class: `panel dialog ${narrow ? 'narrow' : ''}`, attrs: { role: 'dialog', 'aria-label': title } },
    el('div', { class: 'inspector-head', style: { cursor: 'default' } }, el('div', { class: 'inspector-title', text: title }), closeBtn),
    body,
    foot,
  );
  const back = el('div', { class: 'modal-back' }, dialog);
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back) close();
  });
  window.addEventListener('keydown', esc, true);
  host.append(back);
  return close;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirm: string;
  cancel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
}

/**
 * A styled yes or no question. Resolves true on confirm, false on cancel, Esc or a
 * click outside. The confirm button takes focus, so Enter confirms.
 */
export function confirmDialog(host: HTMLElement, opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const body = el('div', { class: 'dialog-body' }, el('p', { class: 'dialog-message', text: opts.message }));
    const cancel = el('button', { class: 'btn', text: opts.cancel ?? 'Cancel', attrs: { type: 'button' }, on: { click: () => close() } });
    const ok = el('button', {
      class: `btn ${opts.danger ? 'danger-solid' : 'primary'}`,
      text: opts.confirm,
      attrs: { type: 'button' },
      on: {
        click: () => {
          answer = true;
          close();
        },
      },
    });
    const foot = el('div', { class: 'dialog-foot' }, cancel, ok);
    const close = modal(host, opts.title, body, foot, true, () => resolve(answer));
    ok.focus();
  });
}
