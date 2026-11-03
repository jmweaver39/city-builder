/**
 * The Traffic Control tab: one card per kind of control, a Roundabout card, the
 * Lane connector and the Advanced junction editor. Pick a card, then one click on a
 * junction applies it. The options strip explains the picked card, and for the
 * roundabout holds its few settings.
 */
import { RADIUS_MAX, RADIUS_MIN, RING_SPEED_MAX, RING_SPEED_MIN } from '../core/roundabout';
import { CONTROL_CARDS, type ControlKind } from '../tools/junctionControl';
import type { UiContext } from './context';
import { clear, el, sliderInput } from './dom';
import { ICONS, type IconName } from './icons';

const CARD_ICON: Record<ControlKind, IconName> = {
  signal: 'signalLight',
  stop: 'stopSign',
  allStop: 'allStop',
  yield: 'yieldSign',
  priority: 'priorityRoad',
  auto: 'autoControl',
};

/** Semantic tone of each card's art: traffic states only. */
const CARD_TONE: Record<ControlKind, string> = {
  signal: 'tone-go',
  stop: 'tone-stop',
  allStop: 'tone-stop',
  yield: 'tone-yield',
  priority: 'tone-priority',
  auto: '',
};

export const ROUNDABOUT_KEY = 'O';

function card(opts: { icon: IconName; name: string; meta: string; key?: string; tone?: string; data: Record<string, string>; onClick: () => void }): HTMLElement {
  return el(
    'button',
    {
      class: 'card card-icon',
      dataset: opts.data,
      tip: opts.name,
      desc: opts.meta,
      keyHint: opts.key,
      attrs: { type: 'button', 'aria-label': opts.name },
      on: { click: opts.onClick },
    },
    el('div', { class: `art ${opts.tone ?? ''}`, html: ICONS[opts.icon] }),
    el('div', { class: 'card-name', text: opts.name }),
    el('div', { class: 'card-meta', text: opts.meta }),
    opts.key ? el('kbd', { class: 'card-key', text: opts.key }) : null,
  );
}

/** A row of mutually exclusive buttons. */
function segmented<T extends string | number>(options: { value: T; label: string; tip?: string }[], value: T, onPick: (v: T) => void): HTMLElement {
  const root = el('div', { class: 'seg', attrs: { role: 'radiogroup' } });
  for (const o of options) {
    root.append(
      el('button', {
        class: `seg-btn ${o.value === value ? 'active' : ''}`,
        text: o.label,
        tip: o.tip,
        attrs: { type: 'button', role: 'radio', 'aria-checked': String(o.value === value) },
        on: { click: () => onPick(o.value) },
      }),
    );
  }
  return root;
}

export class ControlTray {
  private mode = '';

  constructor(
    private readonly ui: UiContext,
    private readonly cards: HTMLElement,
    private readonly options: HTMLElement,
  ) {}

  private get tools() {
    return this.ui.tools;
  }

  render(): void {
    const { tools } = this;
    for (const c of CONTROL_CARDS) {
      this.cards.append(
        card({
          icon: CARD_ICON[c.kind],
          name: c.name,
          meta: c.description,
          key: c.key,
          tone: CARD_TONE[c.kind],
          data: { control: c.kind },
          onClick: () => {
            tools.settings.junctionControl = c.kind;
            tools.setTool('junction');
            tools.settingsChanged();
          },
        }),
      );
    }
    this.cards.append(
      card({
        icon: 'roundabout',
        name: 'Roundabout',
        meta: 'Build or edit a roundabout',
        key: ROUNDABOUT_KEY,
        data: { tool: 'roundabout' },
        onClick: () => tools.setTool('roundabout'),
      }),
      el('div', { class: 'card-sep', attrs: { 'aria-hidden': 'true' } }),
      card({
        icon: 'lanes',
        name: 'Lane connector',
        meta: 'Link lanes by hand',
        key: 'L',
        data: { tool: 'lanes' },
        onClick: () => tools.setTool('lanes'),
      }),
      card({
        icon: 'advanced',
        name: 'Advanced',
        meta: 'Junction editor and signal phases',
        data: { control: 'inspect' },
        onClick: () => this.openAdvanced(),
      }),
    );
    this.mode = '';
    this.sync();
  }

  private openAdvanced(): void {
    this.tools.settings.junctionControl = 'inspect';
    this.tools.setTool('junction');
    this.tools.settingsChanged();
  }

  /** Which options strip shows. Rebuilt only when this changes, so sliders keep focus. */
  private modeKey(): string {
    const { tools } = this;
    const id = tools.active.id;
    if (id === 'roundabout') return `roundabout:${tools.roundabout.selection ? 'edit' : 'new'}`;
    if (id === 'junction') return `junction:${tools.settings.junctionControl}`;
    return id;
  }

  /** Reflect tool state: active card, and the options strip. */
  sync(): void {
    const { tools } = this;
    const active = tools.active.id;
    this.cards.querySelectorAll<HTMLElement>('.card').forEach((c) => {
      const d = c.dataset;
      let on = false;
      if (d.control) on = active === 'junction' && tools.settings.junctionControl === d.control;
      else if (d.tool) on = active === d.tool;
      c.classList.toggle('active', on);
      c.setAttribute('aria-pressed', String(on));
    });
    const mode = this.modeKey();
    if (mode !== this.mode) {
      this.mode = mode;
      this.renderOptions();
    } else {
      this.syncValues();
    }
  }

  private renderOptions(): void {
    const o = this.options;
    clear(o);
    const { tools } = this;
    const id = tools.active.id;
    if (id === 'roundabout') {
      this.renderRoundabout();
      return;
    }
    if (id === 'lanes') {
      o.append(
        el('div', { class: 'opt-title', text: 'Lane connector' }),
        el('p', { class: 'opt-help', text: 'Click a junction, then an amber arriving lane, then a cyan leaving lane.' }),
        el('button', {
          class: 'btn reset-lanes',
          text: 'Reset to Auto',
          tip: 'Back to automatic connectors at this junction',
          attrs: { type: 'button' },
          on: { click: () => tools.lanes.resetToAuto() },
        }),
      );
      o.querySelector('.reset-lanes')?.toggleAttribute('disabled', tools.lanes.node === null);
      return;
    }
    const kind = tools.settings.junctionControl;
    if (id === 'junction' && kind !== 'inspect') {
      const c = CONTROL_CARDS.find((x) => x.kind === kind)!;
      o.append(
        el('div', { class: 'opt-title', text: c.name }),
        el('p', {
          class: 'opt-help',
          text: c.perArm
            ? 'Click a junction to apply. Click near one arm to sign just that arm.'
            : 'Click a junction to apply. The tool stays on, so you can click down a street.',
        }),
        el('div', { class: 'opt-keys' }, ...CONTROL_CARDS.map((x) => el('span', { class: x.kind === kind ? 'on' : '' }, el('kbd', { text: x.key }), x.name))),
        el('button', {
          class: 'btn',
          text: 'Advanced editor',
          tip: 'Click a junction to open its detailed editor and signal phases',
          attrs: { type: 'button' },
          on: { click: () => this.openAdvanced() },
        }),
      );
      return;
    }
    o.append(
      el('div', { class: 'opt-title', text: 'Advanced' }),
      el('p', { class: 'opt-help', text: 'Click a junction to open its detailed editor: per-arm signs, crosswalks and signal phases.' }),
      el('p', { class: 'opt-help muted', text: 'Pick a card on the right to set control with one click instead.' }),
    );
  }

  private renderRoundabout(): void {
    const o = this.options;
    const { tools } = this;
    const tool = tools.roundabout;
    const s = tools.settings.roundabout;
    const sel = tool.selection;
    const changed = () => tools.settingsChanged();
    o.append(
      el('div', { class: 'opt-title', text: sel ? 'Editing roundabout' : 'Roundabout' }),
      el(
        'label',
        { class: 'opt-field', tip: 'Ring radius to the centre of the road', desc: 'Mouse wheel or [ ] over the map changes it too' },
        el('span', { text: 'Radius' }),
        sliderInput(s.radius, { min: RADIUS_MIN, max: RADIUS_MAX, step: 1, format: (v) => `${v} m` }, (v) => {
          s.radius = v;
          changed();
        }),
      ),
      el(
        'div',
        { class: 'opt-field' },
        el('span', { text: 'Lanes' }),
        segmented(
          [
            { value: 1, label: '1' },
            { value: 2, label: '2' },
            { value: 3, label: '3' },
          ],
          s.lanes,
          (v) => {
            s.lanes = v as 1 | 2 | 3;
            changed();
            this.mode = '';
            this.sync();
          },
        ),
      ),
      el(
        'label',
        { class: 'opt-field' },
        el('span', { text: 'Speed' }),
        sliderInput(s.speedKmh, { min: RING_SPEED_MIN, max: RING_SPEED_MAX, step: 5, format: (v) => `${v} km/h` }, (v) => {
          s.speedKmh = v;
          changed();
        }),
      ),
      el(
        'div',
        { class: 'opt-field' },
        el('span', { text: 'Priority' }),
        segmented(
          [
            { value: 'yield', label: 'Yield', tip: 'Entries give way to the ring' },
            { value: 'signal', label: 'Signals', tip: 'Entries are metered by lights; the ring keeps moving' },
          ],
          s.priority,
          (v) => {
            s.priority = v as 'yield' | 'signal';
            changed();
            this.mode = '';
            this.sync();
          },
        ),
      ),
    );
    if (sel) {
      o.append(
        el(
          'div',
          { class: 'btn-row' },
          el('button', { class: 'btn danger', text: 'Delete', tip: 'Remove it and join its roads again', keyHint: 'Del', attrs: { type: 'button' }, on: { click: () => tool.deleteSelected() } }),
          el('button', { class: 'btn', text: 'Done', tip: 'Stop editing', attrs: { type: 'button' }, on: { click: () => tool.deselect() } }),
        ),
      );
    } else {
      o.append(el('p', { class: 'opt-help', text: 'Click a junction to replace it, or open ground for a new one. Click a roundabout to edit it.' }));
    }
  }

  /** Keep values in step with the tool (the wheel changes radius) without rebuilding. */
  private syncValues(): void {
    const { tools } = this;
    this.options.querySelector('.reset-lanes')?.toggleAttribute('disabled', tools.lanes.node === null);
    if (tools.active.id !== 'roundabout') return;
    const s = tools.settings.roundabout;
    const ranges = this.options.querySelectorAll<HTMLInputElement>('input[type="range"]');
    const outs = this.options.querySelectorAll<HTMLOutputElement>('.slider output');
    const values = [s.radius, s.speedKmh];
    const fmt = [(v: number) => `${v} m`, (v: number) => `${v} km/h`];
    ranges.forEach((r, i) => {
      if (document.activeElement === r || values[i] === undefined) return;
      r.value = String(values[i]);
      if (outs[i]) outs[i].textContent = fmt[i](values[i]);
      r.dispatchEvent(new Event('sync'));
    });
  }
}
