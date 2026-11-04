/**
 * Custom Road designer: a cross section built left to right in the shared lane
 * strip (LaneStrip.ts). Every element is dragged into place with the mouse, and the
 * whole dialog shows the result while the drag is still going.
 */
import { BUILTIN_ROAD_TYPES, makeCustomRoadType } from '../core/roadTypes';
import { NetworkError } from '../core/RoadNetwork';
import type { RoadTypeDef } from '../core/types';
import { makeLane, stripFromDef, stripToParams, stripWidth, type StripItem } from '../tools/laneStrip';
import type { UiContext } from './context';
import { el, hiDpiCanvas, row, selectInput, sliderInput, textInput } from './dom';
import { LaneStrip } from './LaneStrip';
import { modal } from './Panel';
import { drawRoadThumb } from './thumbnails';

const STRIP_PX = 500;

export function openRoadDesigner(ui: UiContext, editId?: string): void {
  const { net, tools, history } = ui;
  const existing = editId ? net.roadType(editId) : undefined;
  let name = existing?.name ?? 'My road';
  let speed = existing?.speedKmh ?? 50;
  const blank = (): StripItem[] => [makeLane('drive', -1), makeLane('drive', 1)];
  let base: RoadTypeDef | undefined = existing;

  const art = hiDpiCanvas(170, 170);
  const summary = el('div', { class: 'small muted' });

  const buildDef = (list: readonly StripItem[]): RoadTypeDef | null => {
    try {
      return makeCustomRoadType({ ...stripToParams(list), id: 'preview', speedKmh: speed });
    } catch {
      return null;
    }
  };

  const showPreview = (list: readonly StripItem[]): void => {
    const def = buildDef(list);
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

  // The cross section itself is the shared lane strip (LaneStrip.ts), as in the road inspector.
  const strip = new LaneStrip({ widthPx: STRIP_PX, defaultSpeed: () => speed, onPreview: (list) => showPreview(list) });
  const saveBtn = el('button', { class: 'btn primary', text: 'Save', attrs: { type: 'button' } });

  const startFrom = [{ value: '', label: 'Start from...' }, ...BUILTIN_ROAD_TYPES.map((t) => ({ value: t.id, label: t.name }))];
  const fields = el(
    'div',
    { class: 'designer-fields' },
    row('Name', textInput(name, 'Road name', (v) => {
      name = v;
      showPreview(strip.items);
    })),
    row('Start from', selectInput(startFrom, '', (v) => {
      base = net.roadType(v);
      if (!base) return;
      speed = base.speedKmh;
      strip.setItems(stripFromDef(base));
    })),
    row('Road speed', sliderInput(speed, { min: 10, max: 160, step: 5, format: (v) => `${v} km/h` }, (v) => {
      speed = v;
    })),
  );
  const body = el(
    'div',
    { class: 'dialog-body' },
    el('div', { class: 'small muted', text: 'Left to right, looking the way you draw the road. Drag anything to move it. Dropping a lane among lanes running the other way turns it round.' }),
    strip.stripEl,
    strip.addRow,
    strip.issues,
    el('div', { class: 'designer' }, el('div', { class: 'designer-fields' }, fields, strip.editor), el('div', { class: 'designer-art' }, art, summary)),
  );

  const save = (): void => {
    const id = existing?.id ?? uniqueId(ui, name);
    try {
      const def = makeCustomRoadType({
        ...stripToParams(strip.items),
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
  saveBtn.addEventListener('click', save);
  const foot = el(
    'div',
    { class: 'dialog-foot' },
    existing ? el('button', { class: 'btn danger', text: 'Delete', attrs: { type: 'button' }, style: { marginRight: 'auto' }, on: { click: remove } }) : null,
    el('button', { class: 'btn', text: 'Cancel', attrs: { type: 'button' }, on: { click: () => close() } }),
    saveBtn,
  );
  const close = modal(ui.host, existing ? `Edit ${existing.name}` : 'Custom road', body, foot);
  body.parentElement?.classList.add('dialog-wide');
  strip.setItems(existing ? stripFromDef(existing) : blank());
}

function uniqueId(ui: UiContext, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'road';
  let id = `custom-${slug}`;
  for (let i = 2; ui.net.roadType(id); i++) id = `custom-${slug}-${i}`;
  return id;
}
