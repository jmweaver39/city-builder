/** The main menu: New, Save, Load, Export, Import, Help, and the first-run hints. */
import { SLOT_COUNT } from '../app/storage';
import type { UiContext } from './context';
import { clear, el, iconButton } from './dom';
import { ICONS } from './icons';
import { confirmDialog, modal } from './Panel';

const KEYS: [string, string][] = [
  ['W A S D', 'Pan'],
  ['Q E', 'Rotate camera'],
  ['R F', 'Tilt camera'],
  ['Wheel', 'Zoom'],
  ['Right drag', 'Orbit'],
  ['Left click', 'Place, select'],
  ['Right click', 'Step back'],
  ['Esc', 'Leave tool'],
  ['N', 'Road tool'],
  ['B', 'Bulldoze'],
  ['M', 'Move'],
  ['V', 'Inspect'],
  ['J', 'Traffic control'],
  ['G X C Y I Z', 'Light, stop, all-way, yield, priority, auto'],
  ['O', 'Roundabout'],
  ['[ ] Wheel', 'Roundabout radius'],
  ['Del', 'Delete roundabout'],
  ['L', 'Lane connector'],
  ['P', 'Paint'],
  ['T', 'Traffic'],
  ['Z X C G', 'Draw modes'],
  ['PgUp PgDn', 'Elevation 4 m'],
  ['Ctrl or Cmd', 'Hold: no snapping'],
  ['Shift+G', 'Grid snapping'],
  ['K', 'Node markings'],
  ['H', 'Reverse direction'],
  ['Enter', 'Close a filler'],
  ['Space', 'Pause'],
  ['1 2 3', 'Sim speed'],
  ['U', 'Underground'],
  ['Ctrl+Z', 'Undo'],
  ['Ctrl+Shift+Z', 'Redo'],
];

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
    const item = (icon: string, text: string, onClick: () => void) =>
      el('button', { class: 'btn', html: `${icon}<span>${text}</span>`, attrs: { type: 'button' }, on: { click: onClick } });
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
        item(ICONS.plus, 'New', () => this.confirmNew()),
        item(ICONS.down, 'Save', () => this.slots(true)),
        item(ICONS.up, 'Load', () => this.slots(false)),
        item(ICONS.down, 'Export JSON', () => {
          actions.exportJson();
          this.close();
        }),
        item(ICONS.up, 'Import JSON', () => importInput.click()),
        item(ICONS.help, 'Help and controls', () => this.help()),
        importInput,
      ),
    );
    this.show('Cloverleaf', body);
  }

  /** Ctrl+S: into the last slot used, or the slot picker the first time. */
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

  help(): void {
    const keys = el('div', { class: 'keys' });
    for (const [k, what] of KEYS) keys.append(el('kbd', { text: k }), el('span', { text: what }));
    const body = el(
      'div',
      { class: 'dialog-body' },
      el('p', { text: 'Draw roads from the bottom toolbar. Roads crossing at the same height make a junction. 6 m of height difference makes a bridge or tunnel.', style: { margin: '0 0 8px' } }),
      keys,
    );
    this.show('Help and controls', body, null, false);
  }

  /** The strip shown on a first visit. */
  showHints(): void {
    const { saves } = this.ui;
    if (saves.seenHints) return;
    const strip = el(
      'div',
      { class: 'panel hint-strip' },
      el('span', { html: '<b>Welcome.</b> Pick <b>Streets</b> below and click to draw. <b>B</b> bulldozes, <b>PgUp</b> raises, right click steps back, and <b>Ctrl+Z</b> undoes.' }),
      iconButton(ICONS.help, { tip: 'Help and controls', onClick: () => this.help() }),
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
