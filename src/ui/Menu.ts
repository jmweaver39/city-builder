/** The main menu: New, Save, Load, Export, Import, Help, and the first-run hints. */
import { SLOT_COUNT } from '../app/storage';
import type { UiContext } from './context';
import { clear, el, iconButton } from './dom';
import { ICONS } from './icons';
import { confirmDialog, modal } from './Panel';
import { bindings, formatCombo, GESTURES, keyHint } from './keymap';
import type { RendererExtras } from '../render/api';
import { ROAD_DETAIL_LABEL, ROAD_DETAIL_ORDER, type RoadDetailPref } from '../render/roadDetail';

type RoadDetailControl = Partial<Pick<RendererExtras, 'setRoadDetail' | 'getRoadDetail' | 'getQuality'>>;

export class Menu {
  private closeFn: (() => void) | null = null;
  private lastSlot: number | null = null;

  constructor(private readonly ui: UiContext) {}

  private show(title: string, body: HTMLElement, foot: HTMLElement | null = null, narrow = true): void {
    this.closeFn?.();
    this.closeFn = modal(this.ui.host, title, body, foot, narrow);
  }

  private close(): void {
    this.closeFn?.();
    this.closeFn = null;
  }

  open(): void {
    const { actions } = this.ui;
    const item = (icon: string, text: string, onClick: () => void, key?: string) => {
      const b = el('button', { class: 'btn', html: `${icon}<span>${text}</span>`, attrs: { type: 'button' }, on: { click: onClick } });
      if (key) b.append(el('kbd', { class: 'menu-key', text: key }));
      return b;
    };
    const importInput = el('input', {
      attrs: { type: 'file', accept: 'application/json,.json' },
      style: { display: 'none' },
      on: {
        change: async () => {
          const file = importInput.files?.[0];
          if (!file) return;
          const text = await file.text();
          importInput.value = '';
          this.close();
          const ok = await confirmDialog(this.ui.host, {
            title: 'Import map?',
            message: `Replace the current map with ${file.name}? Unsaved changes will be lost, though Undo brings the map back.`,
            confirm: 'Replace',
            danger: true,
          });
          if (ok) actions.importJson(text);
        },
      },
    });
    const body = el(
      'div',
      { class: 'dialog-body' },
      el(
        'div',
        { class: 'menu-list' },
        item(ICONS.plus, 'New', () => this.confirmNew(), keyHint('file.new')),
        item(ICONS.down, 'Save', () => this.slots(true), keyHint('file.save')),
        item(ICONS.up, 'Load', () => this.slots(false), keyHint('file.open')),
        item(ICONS.down, 'Export JSON', () => {
          actions.exportJson();
          this.close();
        }),
        item(ICONS.up, 'Import JSON', () => importInput.click()),
        item(ICONS.help, 'Keyboard reference', () => this.help(), keyHint('app.help')),
        item(ICONS.menu, 'Graphics', () => this.graphics()),
        importInput,
      ),
    );
    this.show('Cloverleaf', body);
  }

  /** Cmd+S or Ctrl+S: into the last slot used, or the slot picker the first time. */
  saveNow(): void {
    const { saves, net, renderer, toast } = this.ui;
    if (this.lastSlot === null) {
      this.slots(true);
      return;
    }
    if (saves.saveSlot(this.lastSlot, net, renderer.getCamera())) toast(`Saved to slot ${this.lastSlot}.`);
    else toast('Could not save. Browser storage may be full or blocked.', 'error');
  }

  private confirmNew(): void {
    const { actions } = this.ui;
    const body = el('div', { class: 'dialog-body' }, el('p', { class: 'dialog-message', text: 'Replace the current map with a new one? Unsaved changes will be lost, though Undo brings the map back.' }));
    const foot = el(
      'div',
      { class: 'dialog-foot' },
      el('button', { class: 'btn', text: 'Cancel', attrs: { type: 'button' }, on: { click: () => this.close() } }),
      el('button', { class: 'btn', text: 'Starter town', attrs: { type: 'button' }, on: { click: () => { actions.newProject('Starter town', true); this.close(); } } }),
      this.ui.rail ? el('button', { class: 'btn', text: 'Rail demo', attrs: { type: 'button' }, on: { click: () => { this.ui.rail?.loadDemo({ confirmed: true }); this.close(); } } }) : null,
      el('button', { class: 'btn primary', text: 'Empty map', attrs: { type: 'button' }, on: { click: () => { actions.newProject('Untitled', false); this.close(); } } }),
    );
    this.show('New map', body, foot);
  }

  private slots(saving: boolean): void {
    const { saves, net, renderer, actions } = this.ui;
    const body = el('div', { class: 'dialog-body' });
    const draw = (): void => {
      clear(body);
      const info = saves.slots();
      for (let slot = 1; slot <= SLOT_COUNT; slot++) {
        const entry = info.find((s) => s.slot === slot);
        const text = entry ? `${entry.name}, ${new Date(entry.savedAt).toLocaleString()}` : 'Empty';
        const act = saving
          ? el('button', {
              class: 'btn primary',
              text: 'Save',
              attrs: { type: 'button' },
              on: {
                click: () => {
                  if (saves.saveSlot(slot, net, renderer.getCamera())) {
                    this.lastSlot = slot;
                    this.ui.toast(`Saved to slot ${slot}.`);
                    this.close();
                  } else {
                    this.ui.toast('Could not save. Browser storage may be full or blocked.', 'error');
                  }
                },
              },
            })
          : el('button', {
              class: 'btn primary',
              text: 'Load',
              attrs: { type: 'button' },
              on: {
                click: () => {
                  const record = saves.loadSlot(slot);
                  if (!record) {
                    this.ui.toast('That slot could not be read.', 'error');
                    return;
                  }
                  this.close();
                  void confirmDialog(this.ui.host, {
                    title: 'Load map?',
                    message: `Replace the current map with ${entry?.name ?? `slot ${slot}`}? Unsaved changes will be lost, though Undo brings the map back.`,
                    confirm: 'Replace',
                    danger: true,
                  }).then((ok) => {
                    if (ok) actions.loadRecord(record);
                  });
                },
              },
            });
        if (!saving && !entry) act.disabled = true;
        body.append(
          el(
            'div',
            { class: 'slot-row' },
            el('b', { text: `Slot ${slot}` }),
            el('span', { class: entry ? '' : 'muted', text }),
            el(
              'div',
              { class: 'btn-row' },
              act,
              entry
                ? iconButton(ICONS.trash, {
                    tip: 'Delete this save',
                    onClick: () => {
                      saves.deleteSlot(slot);
                      draw();
                    },
                  })
                : null,
            ),
          ),
        );
      }
    };
    draw();
    this.show(saving ? 'Save map' : 'Load map', body, null, false);
  }

  /** Graphics settings: road detail, on its own scale beside the overall quality. */
  graphics(): void {
    const r = this.ui.renderer as unknown as RoadDetailControl;
    const body = el('div', { class: 'dialog-body' });
    const draw = (): void => {
      clear(body);
      const state = r.getRoadDetail?.();
      const quality = r.getQuality?.();
      body.append(
        el('div', { class: 'section-title', text: 'Road detail' }),
        el('p', {
          class: 'dialog-message',
          text: 'Procedural asphalt, concrete, sidewalks and kerbs. Low is flat and light on the GPU; Ultra uses 4096 textures. Changes apply at once.',
        }),
      );
      const list = el('div', { class: 'menu-list' });
      for (const pref of ['auto', ...ROAD_DETAIL_ORDER] as RoadDetailPref[]) {
        const on = state?.pref === pref;
        list.append(
          el('button', {
            class: on ? 'btn primary' : 'btn',
            text: ROAD_DETAIL_LABEL[pref],
            attrs: { type: 'button', 'aria-pressed': String(on) },
            on: {
              click: () => {
                r.setRoadDetail?.(pref);
                draw();
              },
            },
          }),
        );
      }
      body.append(list);
      if (state) {
        const held = state.pref !== 'auto' && state.pref !== state.level;
        const note = `Drawing ${ROAD_DETAIL_LABEL[state.level]}${quality ? ` (graphics quality ${quality})` : ''}${held ? ', held lower to keep frames smooth' : ''}.`;
        body.append(el('p', { class: 'muted', text: note }));
      }
    };
    draw();
    this.show('Graphics', body);
  }

  /** The keyboard reference, built from the keymap so it is always current. */
  help(): void {
    const groups = new Map<string, HTMLElement>();
    const where = (scope: string) =>
      scope.startsWith('tool:') ? ` (${scope.slice(5)} tool)` : scope.startsWith('select:') ? ` (${scope.slice(7)} selected)` : scope.startsWith('hover:') ? ` (over ${scope.slice(6)})` : scope === 'tab' ? ' (tray open)' : '';
    for (const b of bindings()) {
      if (!b.keys.length) continue;
      let list = groups.get(b.group);
      if (!list) groups.set(b.group, (list = el('div', { class: 'ref-list' })));
      const caps = b.id === 'tab.pick' ? [el('kbd', { text: '1\u20139' })] : b.keys.slice(0, 4).map((k) => el('kbd', { text: formatCombo(k) }));
      list.append(el('div', { class: 'ref-row' }, el('span', { class: 'ref-keys' }, ...caps), el('span', { class: 'ref-label', text: b.label + where(b.scope) })));
    }
    const gestures = el('div', { class: 'ref-list' });
    for (const [g, what] of GESTURES) gestures.append(el('div', { class: 'ref-row' }, el('span', { class: 'ref-keys' }, el('kbd', { text: g })), el('span', { class: 'ref-label', text: what })));
    const cols = el('div', { class: 'ref-grid' });
    for (const [name, list] of groups) cols.append(el('section', {}, el('div', { class: 'section-title', text: name }), list));
    cols.append(el('section', {}, el('div', { class: 'section-title', text: 'Mouse and trackpad' }), gestures));
    const body = el(
      'div',
      { class: 'dialog-body' },
      el('p', { class: 'dialog-message', text: `Everything has a key. ${formatCombo('Mod+K')} searches every action; ? shows the keys for what you are doing.` }),
      cols,
    );
    this.show('Keyboard reference', body, null, false);
  }

  /** New map, asking first. */
  newMap(): void {
    this.confirmNew();
  }

  /** Pick a save slot to load. */
  openLoad(): void {
    this.slots(false);
  }

  /** The strip shown on a first visit. */
  showHints(): void {
    const { saves } = this.ui;
    if (saves.seenHints) return;
    const strip = el(
      'div',
      { class: 'panel hint-strip' },
      el(
        'div',
        { class: 'hint-body' },
        el(
          'div',
          { class: 'hint-keys' },
          ...([['N', 'Build'], ['V', 'Modify'], ['J', 'Junction'], ['B', 'Bulldoze'], ['Mod+K', 'Search'], ['?', 'Keys']] as const).map(([k, t]) => el('span', {}, el('kbd', { text: formatCombo(k) }), t)),
        ),
      ),
      iconButton(ICONS.help, { tip: 'Help and controls', desc: 'Every hotkey', onClick: () => this.help() }),
      iconButton(ICONS.close, {
        tip: 'Dismiss',
        onClick: () => {
          strip.remove();
          saves.markHintsSeen();
        },
      }),
    );
    this.ui.dock.prepend(strip);
  }
}
