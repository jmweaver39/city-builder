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
import { CONTROL_ART } from './cardArt';
import { MarkingsEditor } from './MarkingsEditor';
import { JunctionShapePanel } from './JunctionShapePanel';
import type { Panel } from './Panel';
import { TrafficRulesTray } from './TrafficRulesTray';
import { RULE_MODE_ART } from '../tools/trafficArt';

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

/** Which picture in cardArt.ts stands for each card's icon. */
const PICTURE: Partial<Record<IconName, string>> = {
  signalLight: 'signal',
  stopSign: 'stop',
  allStop: 'allStop',
  yieldSign: 'yield',
  priorityRoad: 'priority',
  autoControl: 'auto',
  roundabout: 'roundabout',
  lanes: 'lanes',
  junctionShape: 'junctionShape',
  intersections: 'markings',
  advanced: 'editor',
};

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
    // The real sign, signal or a little picture where there is one; the line icon otherwise.
    PICTURE[opts.icon]
      ? el('div', { class: 'art picture', html: CONTROL_ART[PICTURE[opts.icon]!] })
      : el('div', { class: `art ${opts.tone ?? ''}`, html: ICONS[opts.icon] }),
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
  /** The Markings and Shape tabs host their editors right here in the strip. */
  private markings: MarkingsEditor | null = null;
  private shape: JunctionShapePanel | null = null;
  private readonly offNet: () => void;
  /** Control (signs, lights, lanes...) or Rules (the traffic rules tool), which the tray shows. */
  private view: 'control' | 'rules' = 'control';
  private readonly rules: TrafficRulesTray;

  constructor(
    private readonly ui: UiContext,
    private readonly cards: HTMLElement,
    private readonly options: HTMLElement,
  ) {
    this.offNet = ui.net.onChange(() => this.syncEditors());
    this.rules = new TrafficRulesTray(ui);
  }

  private viewKey(): 'control' | 'rules' {
    return this.tools.active.id === 'trafficRules' ? 'rules' : 'control';
  }

  /** Control or Rules, at the top of the options strip. */
  private viewSwitch(): HTMLElement {
    const make = (view: 'control' | 'rules', label: string, tip: string, desc: string) =>
      el('button', {
        class: `rules-switch-btn ${this.view === view ? 'active' : ''}`,
        text: label,
        tip,
        desc,
        keyHint: view === 'rules' ? 'Shift+J' : 'J',
        attrs: { type: 'button', role: 'tab', 'aria-selected': String(this.view === view) },
        on: {
          click: () => {
            if (view === this.view) return;
            if (view === 'rules') this.rules.pick(this.tools.settings.trafficRules.mode);
            else this.openControl();
          },
        },
      });
    return el(
      'div',
      { class: 'rules-switch', attrs: { role: 'tablist', 'aria-label': 'Junction view' } },
      make('control', 'Control', 'Control', 'Lights, signs, roundabouts, lanes, shape and markings'),
      make('rules', 'Rules', 'Traffic rules', 'Lane arrows, speed limits, vehicle bans, junction rules, priority roads, manual and timed lights'),
    );
  }

  private openControl(): void {
    this.tools.setTool('junction');
    this.tools.settingsChanged();
  }

  /** Drop the hosted editors and listeners when the tray goes. */
  dispose(): void {
    this.offNet();
    this.closeEditors();
  }

  private closeEditors(): void {
    this.markings?.dispose();
    this.markings = null;
    this.shape = null;
    this.options.classList.remove('wide-editor');
  }

  private syncEditors(): void {
    this.markings?.sync();
    this.shape?.sync();
  }

  private get tools() {
    return this.ui.tools;
  }

  render(): void {
    const { tools } = this;
    clear(this.cards);
    this.view = this.viewKey();
    if (this.view === 'rules') {
      this.rules.renderCards(this.cards);
      this.mode = '';
      this.sync();
      return;
    }
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
        meta: 'Build, resize, remove',
        data: { tool: 'roundabout' },
        onClick: () => tools.setTool('roundabout'),
      }),
      el('div', { class: 'card-sep', attrs: { 'aria-hidden': 'true' } }),
      card({
        icon: 'lanes',
        name: 'Lanes',
        meta: 'Link lanes by hand',
        data: { tool: 'lanes' },
        onClick: () => tools.setTool('lanes'),
      }),
      card({
        icon: 'junctionShape',
        name: 'Shape',
        meta: 'Kerbs, cut lines, islands',
        data: { tool: 'junctionShape' },
        onClick: () => tools.setTool('junctionShape'),
      }),
      card({
        icon: 'advanced',
        name: 'Editor',
        meta: 'Signs, phases, crosswalks',
        data: { control: 'inspect' },
        onClick: () => this.openAdvanced(),
      }),
      el(
        'button',
        {
          class: 'card card-icon',
          dataset: { rulesEntry: '1' },
          tip: 'Traffic rules',
          desc: 'Lane arrows, speed limits, vehicle bans, junction rules, priority roads, manual and timed lights, clear traffic',
          keyHint: 'Shift+J',
          attrs: { type: 'button', 'aria-label': 'Traffic rules' },
          on: { click: () => this.rules.pick(this.tools.settings.trafficRules.mode) },
        },
        el('div', { class: 'art picture rule-art', html: RULE_MODE_ART.arrows }),
        el('div', { class: 'card-name', text: 'Rules' }),
        el('div', { class: 'card-meta', text: 'Arrows, speeds, bans' }),
      ),
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
    if (id === 'nodeMarkings') {
      const h = tools.nodeMarkings.host;
      return `markings:${h ? `${h.kind}${h.id}` : ''}`;
    }
    if (id === 'junctionShape') return `shape:${tools.junctionShape.node ?? ''}`;
    if (id === 'trafficRules') return this.rules.layoutKey();
    return id;
  }

  /** Reflect tool state: active card, and the options strip. */
  sync(): void {
    const { tools } = this;
    if (this.viewKey() !== this.view) {
      this.render();
      return;
    }
    if (this.view === 'rules') {
      this.rules.syncCards(this.cards);
      const mode = this.modeKey();
      if (mode !== this.mode) {
        this.mode = mode;
        this.renderOptions();
      } else this.rules.syncOptions(this.options);
      return;
    }
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
    this.closeEditors();
    clear(o);
    const { tools } = this;
    const id = tools.active.id;
    o.append(this.viewSwitch());
    if (id === 'trafficRules') {
      this.rules.renderOptions(o);
      return;
    }
    if (id === 'roundabout') {
      this.renderRoundabout();
      return;
    }
    // With a junction open, its markings or shape editor fills the strip.
    if (id === 'nodeMarkings' && tools.nodeMarkings.host) {
      const box = el('div', { class: 'tab-editor' });
      o.append(box);
      o.classList.add('wide-editor');
      this.markings = new MarkingsEditor(this.ui, tools.nodeMarkings.host, box);
      return;
    }
    if (id === 'junctionShape' && tools.junctionShape.node !== null) {
      const box = el('div', { class: 'tab-editor' });
      o.append(box);
      o.classList.add('wide-editor');
      // The shape panel wants a Panel; here it only needs a body and a title.
      const shim = { body: box, setTitle: () => {} } as unknown as Panel;
      this.shape = new JunctionShapePanel(this.ui, tools.junctionShape.node, shim);
      return;
    }
    if (id === 'junctionShape' || id === 'nodeMarkings') {
      o.append(
        el('div', { class: 'opt-title', text: id === 'junctionShape' ? 'Shape' : 'Markings' }),
        el('p', { class: 'opt-help', text: id === 'junctionShape' ? 'Click a junction, then drag its handles.' : 'Click a junction, then its anchors.' }),
      );
      return;
    }
    if (id === 'lanes') {
      o.append(
        el('div', { class: 'opt-title', text: 'Lane connector' }),
        el('p', { class: 'opt-help', text: 'Click a junction, an arriving lane, then a leaving lane.' }),
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
            ? 'Click a junction, or near one arm.'
            : 'Click junctions to apply.',
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
      el('div', { class: 'opt-title', text: 'Editor' }),
      el('p', { class: 'opt-help', text: 'Click a junction to edit signs, phases and crosswalks.' }),
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
      o.append(el('p', { class: 'opt-help', text: 'Click a junction or open ground. Click a roundabout to edit it.' }));
    }
  }

  /** Keep values in step with the tool (the wheel changes radius) without rebuilding. */
  private syncValues(): void {
    const { tools } = this;
    this.syncEditors();
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
