/**
 * Custom Road designer: a cross section built left to right. Every element is
 * dragged into place with the mouse. Pointer events, so it behaves the same in every
 * browser, and the whole dialog shows the result while the drag is still going.
 */
import { BUILTIN_ROAD_TYPES, makeCustomRoadType } from '../core/roadTypes';
import { NetworkError } from '../core/RoadNetwork';
import type { LaneKind, RoadTypeDef } from '../core/types';
import {
  addElement,
  addLane,
  makeLane,
  moveItem,
  removeItem,
  setDirection,
  stripFromDef,
  stripIssues,
  stripToParams,
  stripWidth,
  updateItem,
  type StripItem,
} from '../tools/laneStrip';
import type { UiContext } from './context';
import { checkbox, clear, el, hiDpiCanvas, row, selectInput, sliderInput, textInput } from './dom';
import { modal } from './Panel';
import { drawRoadThumb } from './thumbnails';

const STRIP_PX = 500;
const DRAG_START_PX = 4;

const KIND_NAMES: Record<string, string> = { drive: 'Drive', bus: 'BUS', bike: 'Bike', rail: 'Rail' };

function itemLabel(i: StripItem): string {
  if (i.type === 'lane') return KIND_NAMES[i.kind] ?? i.kind;
  if (i.type === 'median') return i.kind === 'grass' ? 'Grass' : i.kind === 'barrier' ? 'Barrier' : 'Paint';
  return i.type === 'sidewalk' ? 'Walk' : 'Shldr';
}

function itemClass(i: StripItem): string {
  if (i.type === 'lane') return `lane-${i.kind}`;
  return `item-${i.type} ${i.type === 'median' ? `median-${i.kind}` : ''}`;
}

export function openRoadDesigner(ui: UiContext, editId?: string): void {
  const { net, tools, history } = ui;
  const existing = editId ? net.roadType(editId) : undefined;
  let name = existing?.name ?? 'My road';
  let speed = existing?.speedKmh ?? 50;
  const blank = (): StripItem[] => [makeLane('drive', -1), makeLane('drive', 1)];
  let items: StripItem[] = existing ? stripFromDef(existing) : blank();
  let selected: number | null = null;
  let base: RoadTypeDef | undefined = existing;

  const strip = el('div', { class: 'strip' });
  const indicator = el('div', { class: 'strip-gap' });
  const stripWrap = el('div', { class: 'strip-wrap' }, strip, indicator);
  const art = hiDpiCanvas(170, 170);
  const summary = el('div', { class: 'small muted' });
  const issues = el('div', { class: 'small strip-issues' });
  const editor = el('div', { class: 'strip-editor' });

  const buildDef = (list: readonly StripItem[]): RoadTypeDef | null => {
    try {
      return makeCustomRoadType({ ...stripToParams(list), id: 'preview', speedKmh: speed });
    } catch {
      return null;
    }
  };

  const showPreview = (list: readonly StripItem[]): void => {
    const def = buildDef(list);
    const problems = stripIssues(list);
    issues.textContent = problems.join('. ');
    saveBtn.disabled = !def || !name.trim();
    const ctx = art.getContext('2d');
    if (!def) {
      ctx?.clearRect(0, 0, 170, 170);
      summary.textContent = '';
      return;
    }
    drawRoadThumb(art, def, 170, 170);
    const each = (dir: 1 | -1) => def.lanes.filter((l) => l.dir === dir).length;
    const shape = each(-1) === 0 ? `${each(1)} lanes one way` : `${each(1)} lanes forward, ${each(-1)} back`;
    summary.textContent = `${stripWidth(list).toFixed(1)} m wide. ${shape}.`;
  };

  /** Pixels per metre, so the strip always fits. */
  const scale = (list: readonly StripItem[]): number => Math.min(40, STRIP_PX / Math.max(stripWidth(list), 1));

  const drawStrip = (list: readonly StripItem[], dragging: number | null): void => {
    clear(strip);
    const k = scale(list);
    for (const item of list) {
      const dirMark = item.type === 'lane' ? (item.dir === 1 ? '↑' : '↓') : '';
      const speedMark = item.type === 'lane' && item.speedKmh !== undefined ? `${item.speedKmh}` : '';
      const node = el(
        'div',
        {
          class: `strip-item ${itemClass(item)} ${item.uid === selected ? 'selected' : ''} ${item.uid === dragging ? 'dragging' : ''}`,
          style: { flexBasis: `${item.width * k}px`, width: `${item.width * k}px` },
          dataset: { uid: String(item.uid) },
          tip: 'Drag to move. Click to edit',
          attrs: { role: 'button', 'aria-label': `${itemLabel(item)} ${dirMark}` },
        },
        el('b', { text: dirMark }),
        el('span', { text: itemLabel(item) }),
        speedMark ? el('small', { text: speedMark }) : null,
      );
      node.addEventListener('pointerdown', (e) => beginDrag(e, item.uid, node));
      strip.append(node);
    }
  };

  /** The gap under a client x, counted over the strip's elements as they stand. */
  const gapAt = (x: number): number => {
    const nodes = [...strip.children] as HTMLElement[];
    for (let i = 0; i < nodes.length; i++) {
      const r = nodes[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) return i;
    }
    return nodes.length;
  };

  const showGap = (gap: number): void => {
    const nodes = [...strip.children] as HTMLElement[];
    const wrap = stripWrap.getBoundingClientRect();
    const r = (nodes[gap] ?? nodes[nodes.length - 1])?.getBoundingClientRect();
    if (!r) return;
    indicator.style.display = 'block';
    indicator.style.left = `${(gap < nodes.length ? r.left : r.right) - wrap.left - 2}px`;
  };

  const beginDrag = (e: PointerEvent, id: number, node: HTMLElement): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const original = items;
    const originalNodes = (): void => drawStrip(original, id);
    let moving = false;
    let gap = -1;
    let ghost: HTMLElement | null = null;
    const move = (ev: PointerEvent): void => {
      if (!moving) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_START_PX) return;
        moving = true;
        selected = id;
        originalNodes();
        ghost = node.cloneNode(true) as HTMLElement;
        ghost.classList.add('strip-ghost');
        document.body.append(ghost);
      }
      if (ghost) {
        ghost.style.left = `${ev.clientX - ghost.offsetWidth / 2}px`;
        ghost.style.top = `${ev.clientY - 30}px`;
      }
      const next = gapAt(ev.clientX);
      if (next === gap) return;
      gap = next;
      showGap(gap);
      showPreview(moveItem(original, id, gap));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      indicator.style.display = 'none';
      ghost?.remove();
      if (moving && gap >= 0) items = moveItem(original, id, gap);
      else selected = id;
      refresh();
    };
    const cancel = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      indicator.style.display = 'none';
      ghost?.remove();
      refresh();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  const widthBounds = (i: StripItem): { min: number; max: number } => {
    if (i.type === 'lane') return { min: 1, max: 6 };
    if (i.type === 'median') return { min: 0.5, max: 30 };
    if (i.type === 'sidewalk') return { min: 0.5, max: 10 };
    return { min: 0.5, max: 5 };
  };

  const drawEditor = (): void => {
    clear(editor);
    const item = items.find((i) => i.uid === selected);
    if (!item) {
      editor.append(el('div', { class: 'small muted', text: 'Click an element to edit it, or drag it to a new place.' }));
      return;
    }
    const b = widthBounds(item);
    editor.append(
      row('Width', sliderInput(item.width, { min: b.min, max: b.max, step: 0.25, format: (v) => `${v} m` }, (v) => {
        items = updateItem(items, item.uid, { width: v });
        drawStrip(items, null);
        showPreview(items);
      })),
    );
    if (item.type === 'lane') {
      const kinds: { value: LaneKind; label: string }[] = [
        { value: 'drive', label: 'General traffic' },
        { value: 'bus', label: 'Bus lane' },
        { value: 'bike', label: 'Bike lane' },
      ];
      editor.append(
        row('Lane type', selectInput(kinds, item.kind, (v) => {
          items = updateItem(items, item.uid, { kind: v });
          refresh();
        })),
        row('Direction', selectInput([{ value: '1', label: '↑ Forward' }, { value: '-1', label: '↓ Backward' }], String(item.dir), (v) => {
          items = setDirection(items, item.uid, Number(v) as 1 | -1);
          refresh();
        })),
        row('Own speed', checkbox(item.speedKmh !== undefined, (v) => {
          items = updateItem(items, item.uid, { speedKmh: v ? speed : undefined });
          refresh();
        }), 'Give this lane its own limit'),
      );
      if (item.speedKmh !== undefined) {
        editor.append(
          row('Lane speed', sliderInput(item.speedKmh, { min: 5, max: 160, step: 5, format: (v) => `${v} km/h` }, (v) => {
            items = updateItem(items, item.uid, { speedKmh: v });
            drawStrip(items, null);
          })),
        );
      }
    }
    if (item.type === 'median') {
      editor.append(
        row('Median', selectInput([{ value: 'grass', label: 'Grass' }, { value: 'barrier', label: 'Barrier' }, { value: 'paint', label: 'Painted' }], item.kind, (v) => {
          items = updateItem(items, item.uid, { kind: v });
          refresh();
        })),
      );
    }
    editor.append(
      el('div', { class: 'btn-row' }, el('button', {
        class: 'btn danger',
        text: 'Remove',
        attrs: { type: 'button' },
        on: {
          click: () => {
            items = removeItem(items, item.uid);
            selected = null;
            refresh();
          },
        },
      })),
    );
  };

  const refresh = (): void => {
    drawStrip(items, null);
    drawEditor();
    showPreview(items);
  };

  const add = (label: string, fn: () => StripItem[]): HTMLElement =>
    el('button', {
      class: 'btn',
      text: label,
      attrs: { type: 'button' },
      on: {
        click: () => {
          items = fn();
          refresh();
        },
      },
    });

  const startFrom = [{ value: '', label: 'Start from...' }, ...BUILTIN_ROAD_TYPES.map((t) => ({ value: t.id, label: t.name }))];
  const fields = el(
    'div',
    { class: 'designer-fields' },
    row('Name', textInput(name, 'Road name', (v) => {
      name = v;
      showPreview(items);
    })),
    row('Start from', selectInput(startFrom, '', (v) => {
      base = net.roadType(v);
      if (!base) return;
      items = stripFromDef(base);
      speed = base.speedKmh;
      selected = null;
      refresh();
    })),
    row('Road speed', sliderInput(speed, { min: 10, max: 160, step: 5, format: (v) => `${v} km/h` }, (v) => {
      speed = v;
    })),
  );
  const addRow = el(
    'div',
    { class: 'btn-row strip-add' },
    add('+ Lane forward', () => addLane(items, 'drive', 1)),
    add('+ Lane back', () => addLane(items, 'drive', -1)),
    add('+ Bus', () => addLane(items, 'bus', 1)),
    add('+ Bike', () => addLane(items, 'bike', 1)),
    add('+ Median', () => addElement(items, 'median')),
    add('+ Sidewalk left', () => addElement(items, 'sidewalk', true)),
    add('+ Sidewalk right', () => addElement(items, 'sidewalk', false)),
    add('+ Shoulder left', () => addElement(items, 'shoulder', true)),
    add('+ Shoulder right', () => addElement(items, 'shoulder', false)),
  );
  const body = el(
    'div',
    { class: 'dialog-body' },
    el('div', { class: 'small muted', text: 'Left to right, looking the way you draw the road. Drag anything to move it. Dropping a lane among lanes running the other way turns it round.' }),
    stripWrap,
    addRow,
    issues,
    el('div', { class: 'designer' }, el('div', { class: 'designer-fields' }, fields, editor), el('div', { class: 'designer-art' }, art, summary)),
  );

  const save = (): void => {
    const id = existing?.id ?? uniqueId(ui, name);
    try {
      const def = makeCustomRoadType({
        ...stripToParams(items),
        id,
        name: name.trim() || 'Custom road',
        speedKmh: speed,
        ...(base ? { rank: base.rank } : {}),
      });
      history.hint('Save road type');
      net.setCustomRoadType(def);
      tools.settings.roadType = id;
      close();
      ui.toast(`Saved ${def.name}.`);
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : 'Could not save this road.', 'error');
    }
  };
  const remove = (): void => {
    if (!existing) return;
    try {
      history.hint('Delete road type');
      net.removeCustomRoadType(existing.id);
      if (tools.settings.roadType === existing.id) tools.settings.roadType = 'street-2';
      close();
    } catch (err) {
      const message = err instanceof NetworkError ? 'That road type is still in use, so it cannot be deleted.' : 'Could not delete this road.';
      ui.toast(message, 'error');
    }
  };
  const saveBtn = el('button', { class: 'btn primary', text: 'Save', attrs: { type: 'button' }, on: { click: save } });
  const foot = el(
    'div',
    { class: 'dialog-foot' },
    existing ? el('button', { class: 'btn danger', text: 'Delete', attrs: { type: 'button' }, style: { marginRight: 'auto' }, on: { click: remove } }) : null,
    el('button', { class: 'btn', text: 'Cancel', attrs: { type: 'button' }, on: { click: () => close() } }),
    saveBtn,
  );
  const close = modal(ui.host, existing ? `Edit ${existing.name}` : 'Custom road', body, foot);
  body.parentElement?.classList.add('dialog-wide');
  refresh();
}

function uniqueId(ui: UiContext, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'road';
  let id = `custom-${slug}`;
  for (let i = 2; ui.net.roadType(id); i++) id = `custom-${slug}-${i}`;
  return id;
}
