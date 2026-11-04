/**
 * Junction > Rules in the tray: a card per rule mode (lane arrows, speed limits,
 * vehicles, junction rules, priority road, manual lights, timed lights, clear
 * traffic), and the options strip for the picked one: sign and vehicle pickers,
 * restriction filter, copy, paste and green wave, and the clear-traffic buttons.
 * Hosted by ControlTray, which switches between Control and Rules.
 */
import { resetLaneArrows, speedLabel, VEHICLE_CLASSES, ARM_RULE_KEYS, ARM_RULE_NAMES } from '../core/trafficRules';
import { SPEED_CARDS, VEHICLE_NAMES } from '../tools/TrafficRulesTool';
import { RULE_MODE_ART, ruleSvg, speedSignSvg, vehicleSvg } from '../tools/trafficArt';
import { RULE_MODES, type RuleMode } from '../tools/trafficRuleSettings';
import type { UiContext } from './context';
import { checkbox, el, sliderInput } from './dom';

export class TrafficRulesTray {
  constructor(private readonly ui: UiContext) {}

  private get tools() {
    return this.ui.tools;
  }

  private get s() {
    return this.ui.tools.settings.trafficRules;
  }

  pick(mode: RuleMode): void {
    this.s.mode = mode;
    if (this.tools.active.id !== 'trafficRules') this.tools.setTool('trafficRules');
    this.tools.settingsChanged();
  }

  renderCards(cards: HTMLElement): void {
    RULE_MODES.forEach((m, i) => {
      cards.append(
        el(
          'button',
          {
            class: 'card card-icon',
            dataset: { rule: m.mode },
            tip: m.name,
            desc: m.desc,
            keyHint: String(i + 1),
            attrs: { type: 'button', 'aria-label': m.name },
            on: { click: () => this.pick(m.mode) },
          },
          el('div', { class: 'art picture rule-art', html: RULE_MODE_ART[m.mode] }),
          el('div', { class: 'card-name', text: m.name }),
          el('div', { class: 'card-meta', text: m.desc.split(/[,.(]/)[0] }),
          el('kbd', { class: 'card-key', text: String(i + 1) }),
        ),
      );
    });
  }

  syncCards(cards: HTMLElement): void {
    const on = this.tools.active.id === 'trafficRules';
    cards.querySelectorAll<HTMLElement>('.card[data-rule]').forEach((c) => {
      const a = on && c.dataset.rule === this.s.mode;
      c.classList.toggle('active', a);
      c.setAttribute('aria-pressed', String(a));
    });
  }

  /** What the options strip shows; it is rebuilt only when this changes. */
  layoutKey(): string {
    return `rules:${this.s.mode}:${this.s.timed}`;
  }

  renderOptions(o: HTMLElement): void {
    const info = RULE_MODES.find((m) => m.mode === this.s.mode)!;
    o.append(el('div', { class: 'opt-title', text: info.name }), el('p', { class: 'opt-help', text: info.desc }));
    switch (this.s.mode) {
      case 'arrows':
        o.append(
          el('button', {
            class: 'btn rules-reset-arrows',
            text: 'Reset arrows here',
            tip: 'Back to automatic turns at the junction under the cursor',
            attrs: { type: 'button' },
            on: {
              click: () => {
                const node = this.tools.trafficRules.node;
                if (node === null) return;
                this.ui.history.hint('Reset lane arrows');
                resetLaneArrows(this.ui.net, node);
              },
            },
          }),
        );
        break;
      case 'speed':
        o.append(this.picker(
          SPEED_CARDS.map((kmh) => ({ value: String(kmh), html: speedSignSvg(kmh), tip: kmh === null ? 'Road default' : speedLabel(kmh) })),
          String(this.s.speed),
          (v) => (this.s.speed = v === 'null' ? null : Number(v)),
        ), el('p', { class: 'opt-help', text: '[ and ] step through the signs.' }));
        break;
      case 'vehicles':
        o.append(this.picker(
          VEHICLE_CLASSES.map((c) => ({ value: c, html: vehicleSvg(c, true), tip: VEHICLE_NAMES[c] })),
          this.s.vehicle,
          (v) => (this.s.vehicle = v as typeof this.s.vehicle),
        ), el('p', { class: 'opt-help', text: 'Banned vehicles route round. Icons on the map show bans.' }));
        break;
      case 'junction':
        o.append(this.picker(
          [{ value: 'all', html: '<span class="rule-all">All</span>', tip: 'Show every switch' }, ...ARM_RULE_KEYS.map((k) => ({ value: k, html: ruleSvg(k, true), tip: ARM_RULE_NAMES[k] }))],
          this.s.rule ?? 'all',
          (v) => (this.s.rule = v === 'all' ? null : (v as typeof this.s.rule)),
        ));
        break;
      case 'manual':
        o.append(
          el('button', {
            class: 'btn rules-release',
            text: 'Back to automatic',
            tip: 'Give every junction under hand control back to its plan',
            attrs: { type: 'button' },
            on: {
              click: () => {
                const n = this.tools.trafficRules.releaseAll();
                this.ui.toast(n ? (n === 1 ? 'Lights back on their plan.' : `${n} junctions back on their plans.`) : 'No lights are under hand control.');
              },
            },
          }),
        );
        break;
      case 'timed':
        o.append(
          el(
            'div',
            { class: 'seg', attrs: { role: 'radiogroup' } },
            ...(['copy', 'paste', 'wave'] as const).map((t) =>
              el('button', {
                class: `seg-btn ${this.s.timed === t ? 'active' : ''}`,
                text: t === 'copy' ? 'Copy' : t === 'paste' ? 'Paste' : 'Green wave',
                attrs: { type: 'button', role: 'radio', 'aria-checked': String(this.s.timed === t) },
                on: {
                  click: () => {
                    this.s.timed = t;
                    this.tools.settingsChanged();
                  },
                },
              }),
            ),
          ),
        );
        if (this.s.timed === 'wave') {
          o.append(
            el(
              'label',
              { class: 'opt-field', tip: 'The speed the wave is timed for' },
              el('span', { text: 'Speed' }),
              sliderInput(this.s.waveSpeed, { min: 20, max: 100, step: 5, format: (v) => `${v} km/h` }, (v) => {
                this.s.waveSpeed = v;
              }),
            ),
            el(
              'div',
              { class: 'btn-row' },
              el('button', { class: 'btn primary rules-wave', text: 'Link', keyHint: 'Enter', tip: 'Set offsets along the picked junctions', attrs: { type: 'button' }, on: { click: () => this.tools.trafficRules.makeWave() } }),
              el('button', {
                class: 'btn rules-wave-clear',
                text: 'Clear picks',
                attrs: { type: 'button' },
                on: {
                  click: () => {
                    this.tools.trafficRules.wave = [];
                    this.tools.settingsChanged();
                  },
                },
              }),
            ),
          );
        }
        o.append(el('p', { class: 'opt-help rules-timed-status' }));
        break;
      case 'clear':
        o.append(
          el(
            'div',
            { class: 'btn-row' },
            el('button', {
              class: 'btn danger',
              text: 'Clear all',
              tip: 'Remove every vehicle now',
              attrs: { type: 'button' },
              on: { click: () => this.ui.toast(`Removed ${this.ui.sim.clearTraffic?.() ?? 0} vehicles.`) },
            }),
            el('button', {
              class: 'btn',
              text: 'Clear stuck',
              tip: 'Remove vehicles that have not moved for 20 s (waiting at a red light does not count)',
              attrs: { type: 'button' },
              on: { click: () => this.ui.toast(`Removed ${this.ui.sim.clearTraffic?.({ stuckOnly: true }) ?? 0} stuck vehicles.`) },
            }),
          ),
          el(
            'label',
            { class: 'opt-row rules-pause', tip: 'No new vehicles while on' },
            checkbox(!!this.ui.sim.spawnPaused, (v) => {
              this.ui.sim.setSpawnPaused?.(v);
              this.ui.toast(v ? 'Spawning paused.' : 'Spawning resumed.');
            }),
            el('span', { text: 'Pause spawning' }),
          ),
        );
        break;
      default:
        break;
    }
    if (this.s.mode !== 'clear' && this.s.mode !== 'timed') {
      o.append(
        el(
          'label',
          { class: 'opt-row', tip: 'Show this mode’s icons over the whole map, not just near the cursor' },
          checkbox(this.s.showAll, (v) => {
            this.s.showAll = v;
            this.tools.settingsChanged();
          }),
          el('span', { text: 'Show everywhere' }),
        ),
      );
    }
    this.syncOptions(o);
  }

  /** Live values, without rebuilding. */
  syncOptions(o: HTMLElement): void {
    const tool = this.tools.trafficRules;
    o.querySelector('.rules-reset-arrows')?.toggleAttribute('disabled', tool.node === null);
    const wave = o.querySelector<HTMLButtonElement>('.rules-wave');
    if (wave) {
      wave.disabled = tool.wave.length < 2;
      wave.textContent = tool.wave.length ? `Link ${tool.wave.length}` : 'Link';
    }
    const status = o.querySelector<HTMLElement>('.rules-timed-status');
    if (status) {
      status.textContent =
        this.s.timed === 'wave'
          ? `${tool.wave.length} junction${tool.wave.length === 1 ? '' : 's'} picked, in order. Right click removes the last.`
          : tool.clip
            ? `Copied: ${tool.clip.plan.phases.length} phases from one junction.`
            : 'Nothing copied yet.';
    }
    o.querySelectorAll<HTMLElement>('.rules-picker button').forEach((b) => {
      const cur = this.s.mode === 'speed' ? String(this.s.speed) : this.s.mode === 'vehicles' ? this.s.vehicle : (this.s.rule ?? 'all');
      b.classList.toggle('active', b.dataset.value === cur);
    });
  }

  /** A row of picture buttons, one picked. */
  private picker(options: { value: string; html: string; tip: string }[], value: string, set: (v: string) => void): HTMLElement {
    return el(
      'div',
      { class: 'rules-picker', attrs: { role: 'radiogroup' } },
      ...options.map((opt) =>
        el('button', {
          class: opt.value === value ? 'active' : '',
          html: opt.html,
          tip: opt.tip,
          dataset: { value: opt.value },
          attrs: { type: 'button', role: 'radio', 'aria-label': opt.tip },
          on: {
            click: () => {
              set(opt.value);
              this.tools.settingsChanged();
            },
          },
        }),
      ),
    );
  }
}
