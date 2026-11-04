/**
 * The lane strip: a road's cross section, left to right looking the way it was
 * drawn, edited directly with the mouse. Drag an element to move it, drag its right
 * edge to change its width, click it to edit it. Shared by the Road Designer and the
 * road inspector, so both behave the same. Pointer events, so it works the same in
 * every browser, and the owner hears about a drag while it is still going.
 *
 * The rules (where things may go, what a drop does) live in tools/laneStrip.ts.
 */
import type { LaneKind } from '../core/types';
import {
  addElement,
  addLane,
  moveItem,
  removeItem,
  setDirection,
  stripIssues,
  stripWidth,
  updateItem,
  type StripItem,
} from '../tools/laneStrip';
import { clear, el, iconButton, row, sliderInput } from './dom';
import { ICONS } from './icons';

const DRAG_START_PX = 4;
const WIDTH_STEP = 0.25;

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** Icons for the strip's buttons. */
export const STRIP_ICONS = {
  laneForward: svg('<path d="M9 20V5M5 9l4-4 4 4"/><path d="M18 13v7M14.5 16.5h7"/>'),
  laneBack: svg('<path d="M9 4v15M5 15l4 4 4-4"/><path d="M18 4v7M14.5 7.5h7"/>'),
  bus: svg('<rect x="5" y="3" width="14" height="15" rx="2.5"/><path d="M5 11h14M8 18v2.5M16 18v2.5"/><circle cx="8.5" cy="14.5" r=".6" fill="currentColor"/><circle cx="15.5" cy="14.5" r=".6" fill="currentColor"/>'),
  bike: svg('<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-7h5l3 7M10 9l2 7h-6M14 6h2"/>'),
  drive: svg('<path d="M5 13 7 7.5A2 2 0 0 1 9 6h6a2 2 0 0 1 2 1.5L19 13"/><rect x="3.5" y="13" width="17" height="5" rx="1.5"/><path d="M6.5 18v2M17.5 18v2"/>'),
  median: svg('<path d="M7 3v18M17 3v18"/><path d="M10 6l4 4M10 11l4 4M10 16l4 4"/>'),
  walkLeft: svg('<path d="M3 3v18M7 3v18"/><path d="M3 8h4M3 13h4M3 18h4"/><path d="M15 12h6M18 9v6"/>'),
  walkRight: svg('<path d="M17 3v18M21 3v18"/><path d="M17 8h4M17 13h4M17 18h4"/><path d="M3 12h6M6 9v6"/>'),
  shoulderLeft: svg('<path d="M4 3v18M8 3v18" stroke-dasharray="2.5 2.5"/><path d="M15 12h6M18 9v6"/>'),
  shoulderRight: svg('<path d="M16 3v18M20 3v18" stroke-dasharray="2.5 2.5"/><path d="M3 12h6M6 9v6"/>'),
  forward: svg('<path d="M12 20V4M6 10l6-6 6 6"/>'),
  backward: svg('<path d="M12 4v16M6 14l6 6 6-6"/>'),
  left: svg('<path d="M15 6l-6 6 6 6"/>'),
  right: svg('<path d="M9 6l6 6-6 6"/>'),
  grass: svg('<path d="M5 20c1-4 1-7 0-10M10 20c0-5 1-9 3-12M15 20c0-4 1-6 4-8"/>'),
  barrier: svg('<path d="M3 15h18M5 15V9h14v6M8 9v6M16 9v6"/>'),
  paint: svg('<path d="M4 20 20 4M4 14 14 4M10 20 20 10"/>'),
};

const KIND_NAMES: Record<string, string> = { drive: 'Drive', bus: 'BUS', bike: 'Bike', rail: 'Rail' };

function itemLabel(i: StripItem): string {
  if (i.type === 'lane') return KIND_NAMES[i.kind] ?? i.kind;
  if (i.type === 'median') return i.kind === 'grass' ? 'Grass' : i.kind === 'barrier' ? 'Barrier' : 'Paint';
  return i.type === 'sidewalk' ? 'Walk' : 'Shldr';
}

function itemName(i: StripItem): string {
  if (i.type === 'lane') return `${i.kind === 'drive' ? 'Lane' : i.kind === 'bus' ? 'Bus lane' : i.kind === 'bike' ? 'Bike lane' : 'Track'} ${i.dir === 1 ? 'forward' : 'backward'}`;
  if (i.type === 'median') return `${itemLabel(i)} median`;
  return i.type === 'sidewalk' ? 'Sidewalk' : 'Shoulder';
}

function itemClass(i: StripItem): string {
  if (i.type === 'lane') return `lane-${i.kind}`;
  return `item-${i.type} ${i.type === 'median' ? `median-${i.kind}` : ''}`;
}

export function widthBounds(i: StripItem): { min: number; max: number } {
  if (i.type === 'lane') return { min: 1, max: 6 };
  if (i.type === 'median') return { min: 0.5, max: 30 };
  if (i.type === 'sidewalk') return { min: 0.5, max: 10 };
  return { min: 0.5, max: 5 };
}

export interface LaneStripOptions {
  /** Widest the strip may draw, in CSS pixels. */
  widthPx: number;
  /** The limit a lane starts with when given one of its own. */
  defaultSpeed: () => number;
  /** After every finished change. */
  onChange?: (items: readonly StripItem[]) => void;
  /** During a drag, with the strip as the drop would leave it, and after every change. */
  onPreview?: (items: readonly StripItem[]) => void;
}

/** The strip and its controls. The owner places the four parts where it likes. */
export class LaneStrip {
  private list: StripItem[] = [];
  private selectedId: number | null = null;
  private readonly strip = el('div', { class: 'strip', attrs: { role: 'listbox', 'aria-label': 'Cross section, left to right' } });
  private readonly indicator = el('div', { class: 'strip-gap' });
  /** The cross section itself. */
  readonly stripEl = el('div', { class: 'strip-wrap' }, this.strip, this.indicator);
  /** Add buttons. */
  readonly addRow: HTMLElement;
  /** Problems with the layout, live. */
  readonly issues = el('div', { class: 'small strip-issues', attrs: { 'aria-live': 'polite' } });
  /** Controls for the selected element. */
  readonly editor = el('div', { class: 'strip-editor' });

  constructor(private readonly opts: LaneStripOptions) {
    const add = (icon: string, tip: string, fn: () => StripItem[]) =>
      iconButton(icon, {
        tip,
        class: 'strip-add-btn',
        onClick: () => this.commit(fn()),
      });
    this.addRow = el(
      'div',
      { class: 'strip-add' },
      add(STRIP_ICONS.laneForward, 'Add a lane forward, on the right of the lanes going your way', () => addLane(this.list, 'drive', 1)),
      add(STRIP_ICONS.laneBack, 'Add a lane backward, on the left', () => addLane(this.list, 'drive', -1)),
      add(STRIP_ICONS.bus, 'Add a bus lane forward', () => addLane(this.list, 'bus', 1)),
      add(STRIP_ICONS.bike, 'Add a bike lane forward', () => addLane(this.list, 'bike', 1)),
      el('span', { class: 'card-sep' }),
      add(STRIP_ICONS.median, 'Add a median between the directions', () => addElement(this.list, 'median')),
      add(STRIP_ICONS.walkLeft, 'Add a sidewalk on the left', () => addElement(this.list, 'sidewalk', true)),
      add(STRIP_ICONS.walkRight, 'Add a sidewalk on the right', () => addElement(this.list, 'sidewalk', false)),
      add(STRIP_ICONS.shoulderLeft, 'Add a shoulder on the left', () => addElement(this.list, 'shoulder', true)),
      add(STRIP_ICONS.shoulderRight, 'Add a shoulder on the right', () => addElement(this.list, 'shoulder', false)),
    );
  }

  get items(): readonly StripItem[] {
    return this.list;
  }

  get selected(): StripItem | null {
    return this.list.find((i) => i.uid === this.selectedId) ?? null;
  }

  /** Show these items. The selection stays if its element is still there. */
  setItems(items: readonly StripItem[]): void {
    this.list = [...items];
    if (!this.list.some((i) => i.uid === this.selectedId)) this.selectedId = null;
    this.refresh();
  }

  select(uid: number | null): void {
    this.selectedId = uid;
    this.refresh();
    this.focusSelected();
  }

  /** Move the selected element one place left or right. */
  moveSelected(step: 1 | -1): boolean {
    const item = this.selected;
    if (!item) return false;
    const at = this.list.indexOf(item);
    // Gaps count positions as they stand: one to the right is two gaps on.
    const next = moveItem(this.list, item.uid, step > 0 ? at + 2 : at - 1);
    this.commit(next);
    this.focusSelected();
    return true;
  }

  removeSelected(): boolean {
    const item = this.selected;
    if (!item) return false;
    this.selectedId = null;
    this.commit(removeItem(this.list, item.uid));
    return true;
  }

  private focusSelected(): void {
    const node = this.strip.querySelector<HTMLElement>(`[data-uid="${this.selectedId}"]`);
    node?.focus({ preventScroll: true });
  }

  private commit(next: StripItem[]): void {
    this.list = next;
    this.refresh();
    this.opts.onChange?.(this.list);
  }

  private refresh(): void {
    this.drawStrip(this.list, null);
    this.drawEditor();
    this.showIssues(this.list);
    this.opts.onPreview?.(this.list);
  }

  private showIssues(list: readonly StripItem[]): void {
    this.issues.textContent = stripIssues(list).join('. ');
  }

  /** Pixels per metre, so the strip always fits. */
  private scale(list: readonly StripItem[]): number {
    return Math.min(40, this.opts.widthPx / Math.max(stripWidth(list), 1));
  }

  private drawStrip(list: readonly StripItem[], dragging: number | null, k = this.scale(list)): void {
    clear(this.strip);
    for (const item of list) {
      const dirMark = item.type === 'lane' ? (item.dir === 1 ? '↑' : '↓') : '';
      const speedMark = item.type === 'lane' && item.speedKmh !== undefined ? `${item.speedKmh}` : '';
      const node = el(
        'div',
        {
          class: `strip-item ${itemClass(item)} ${item.uid === this.selectedId ? 'selected' : ''} ${item.uid === dragging ? 'dragging' : ''}`,
          style: { flexBasis: `${item.width * k}px`, width: `${item.width * k}px` },
          dataset: { uid: String(item.uid) },
          tip: `${itemName(item)}, ${item.width} m. Drag to move, drag the right edge to resize, click to edit`,
          attrs: { role: 'option', tabindex: '0', 'aria-selected': String(item.uid === this.selectedId), 'aria-label': `${itemName(item)}, ${item.width} metres` },
        },
        el('b', { text: dirMark }),
        el('span', { text: itemLabel(item) }),
        speedMark ? el('small', { text: speedMark }) : null,
      );
      const grip = el('div', { class: 'strip-resize', attrs: { 'aria-hidden': 'true' } });
      node.append(grip);
      grip.addEventListener('pointerdown', (e) => this.beginResize(e, item.uid));
      node.addEventListener('pointerdown', (e) => {
        if (e.target === grip) return;
        this.beginDrag(e, item.uid, node);
      });
      node.addEventListener('focus', () => {
        if (this.selectedId !== item.uid) {
          this.selectedId = item.uid;
          this.drawEditor();
          for (const n of this.strip.children) n.classList.toggle('selected', (n as HTMLElement).dataset.uid === String(item.uid));
        }
      });
      this.strip.append(node);
    }
  }

  /** The gap under a client x, counted over the strip's elements as they stand. */
  private gapAt(x: number): number {
    const nodes = [...this.strip.children] as HTMLElement[];
    for (let i = 0; i < nodes.length; i++) {
      const r = nodes[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) return i;
    }
    return nodes.length;
  }

  private showGap(gap: number): void {
    const nodes = [...this.strip.children] as HTMLElement[];
    const wrap = this.stripEl.getBoundingClientRect();
    const r = (nodes[gap] ?? nodes[nodes.length - 1])?.getBoundingClientRect();
    if (!r) return;
    this.indicator.style.display = 'block';
    this.indicator.style.left = `${(gap < nodes.length ? r.left : r.right) - wrap.left - 2}px`;
  }

  private beginDrag(e: PointerEvent, id: number, node: HTMLElement): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const original = this.list;
    let moving = false;
    let gap = -1;
    let ghost: HTMLElement | null = null;
    const move = (ev: PointerEvent): void => {
      if (!moving) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_START_PX) return;
        moving = true;
        this.selectedId = id;
        this.drawStrip(original, id);
        ghost = node.cloneNode(true) as HTMLElement;
        ghost.classList.add('strip-ghost');
        document.body.append(ghost);
      }
      if (ghost) {
        ghost.style.left = `${ev.clientX - ghost.offsetWidth / 2}px`;
        ghost.style.top = `${ev.clientY - 30}px`;
      }
      const next = this.gapAt(ev.clientX);
      if (next === gap) return;
      gap = next;
      this.showGap(gap);
      const preview = moveItem(original, id, gap);
      this.showIssues(preview);
      this.opts.onPreview?.(preview);
    };
    const finish = (drop: boolean): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      this.indicator.style.display = 'none';
      ghost?.remove();
      if (drop && moving && gap >= 0) {
        const next = moveItem(original, id, gap);
        this.selectedId = id;
        this.commit(next);
      } else {
        if (drop) this.selectedId = id;
        this.refresh();
      }
      this.focusSelected();
    };
    const up = (): void => finish(true);
    const cancel = (): void => finish(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }

  /** Drag an element's right edge to change its width. The scale holds still meanwhile. */
  private beginResize(e: PointerEvent, id: number): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const item = this.list.find((i) => i.uid === id);
    if (!item) return;
    const k = this.scale(this.list);
    const startX = e.clientX;
    const startW = item.width;
    const b = widthBounds(item);
    this.selectedId = id;
    let width = startW;
    const original = this.list;
    document.body.classList.add('strip-resizing');
    const move = (ev: PointerEvent): void => {
      const raw = startW + (ev.clientX - startX) / k;
      const next = Math.min(b.max, Math.max(b.min, Math.round(raw / WIDTH_STEP) * WIDTH_STEP));
      if (next === width) return;
      width = next;
      const preview = updateItem(original, id, { width });
      this.drawStrip(preview, null, k);
      this.showIssues(preview);
      this.opts.onPreview?.(preview);
    };
    const finish = (keep: boolean): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      document.body.classList.remove('strip-resizing');
      if (keep && width !== startW) this.commit(updateItem(original, id, { width }));
      else this.refresh();
      this.focusSelected();
    };
    const up = (): void => finish(true);
    const cancel = (): void => finish(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }

  private drawEditor(): void {
    const editor = this.editor;
    clear(editor);
    const item = this.selected;
    if (!item) {
      editor.append(el('div', { class: 'small muted', text: 'Click an element to edit it. Drag it to move it, or drag its right edge to resize it.' }));
      return;
    }
    const seg = <T extends string>(options: { value: T; icon: string; tip: string }[], value: T, onPick: (v: T) => void) =>
      el(
        'div',
        { class: 'seg', attrs: { role: 'radiogroup' } },
        ...options.map((o) =>
          el('button', {
            class: `seg-btn ${o.value === value ? 'active' : ''}`,
            html: o.icon,
            tip: o.tip,
            attrs: { type: 'button', role: 'radio', 'aria-checked': String(o.value === value), 'aria-label': o.tip },
            on: { click: () => onPick(o.value) },
          }),
        ),
      );
    const head = el(
      'div',
      { class: 'strip-editor-head' },
      el('span', { class: 'strip-editor-name', text: itemName(item) }),
      iconButton(STRIP_ICONS.left, { tip: 'Move left', keyHint: 'Alt+ArrowLeft', onClick: () => this.moveSelected(-1) }),
      iconButton(STRIP_ICONS.right, { tip: 'Move right', keyHint: 'Alt+ArrowRight', onClick: () => this.moveSelected(1) }),
      iconButton(ICONS.trash, { tip: 'Remove', keyHint: 'Shift+Delete', class: 'danger', onClick: () => this.removeSelected() }),
    );
    editor.append(head);
    const b = widthBounds(item);
    editor.append(
      row('Width', sliderInput(item.width, { min: b.min, max: b.max, step: WIDTH_STEP, format: (v) => `${v} m` }, (v) => {
        this.list = updateItem(this.list, item.uid, { width: v });
        this.drawStrip(this.list, null);
        this.showIssues(this.list);
        this.opts.onPreview?.(this.list);
        this.opts.onChange?.(this.list);
      })),
    );
    if (item.type === 'lane') {
      const kinds: { value: LaneKind; icon: string; tip: string }[] = [
        { value: 'drive', icon: STRIP_ICONS.drive, tip: 'General traffic' },
        { value: 'bus', icon: STRIP_ICONS.bus, tip: 'Buses only' },
        { value: 'bike', icon: STRIP_ICONS.bike, tip: 'Bikes only' },
      ];
      editor.append(
        row('Use', seg(kinds, item.kind, (v) => this.commit(updateItem(this.list, item.uid, { kind: v })))),
        row(
          'Direction',
          seg(
            [
              { value: '1', icon: STRIP_ICONS.forward, tip: 'Forward, the way the road was drawn' },
              { value: '-1', icon: STRIP_ICONS.backward, tip: 'Backward' },
            ],
            String(item.dir),
            (v) => this.commit(setDirection(this.list, item.uid, Number(v) as 1 | -1)),
          ),
          'Turning a lane round carries it across to the other direction',
        ),
      );
      const own = item.speedKmh !== undefined;
      editor.append(
        row(
          'Own limit',
          el('input', {
            attrs: { type: 'checkbox', ...(own ? { checked: '' } : {}) },
            on: {
              change: (ev) => {
                const on = (ev.target as HTMLInputElement).checked;
                this.commit(updateItem(this.list, item.uid, { speedKmh: on ? this.opts.defaultSpeed() : undefined }));
              },
            },
          }),
          'Give this lane a speed limit of its own',
        ),
      );
      if (own) {
        editor.append(
          row('Lane limit', sliderInput(item.speedKmh!, { min: 5, max: 160, step: 5, format: (v) => `${v} km/h` }, (v) => {
            this.list = updateItem(this.list, item.uid, { speedKmh: v });
            this.drawStrip(this.list, null);
            this.opts.onPreview?.(this.list);
            this.opts.onChange?.(this.list);
          })),
        );
      }
    }
    if (item.type === 'median') {
      editor.append(
        row(
          'Median',
          seg(
            [
              { value: 'grass', icon: STRIP_ICONS.grass, tip: 'Grass' },
              { value: 'barrier', icon: STRIP_ICONS.barrier, tip: 'Barrier' },
              { value: 'paint', icon: STRIP_ICONS.paint, tip: 'Painted' },
            ],
            item.kind,
            (v) => this.commit(updateItem(this.list, item.uid, { kind: v })),
          ),
        ),
      );
    }
  }
}
