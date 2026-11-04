/** Junction panel: control mode, per-arm signs, and the signal editor. */
import { defaultSignalPlan, effectiveControl, type SignalPreset } from '../core/signals';
import { autoSignalPlan, hasHighwayAccessChoice } from '../core/highwayCrossing';
import type { CrosswalkStyle, HighwayAccess, Id, JunctionMode, LaneAlign, SignalPlan, SignKind } from '../core/types';
import { jointAlign, setJointAlign } from '../tools/endAlign';
import { layoutDiagram, moveAt, type JunctionDiagram } from '../tools/junctionDiagram';
import { addPhase, cycleLength, cycleMove, movePhase, moveState, removePhase, setPhaseField } from '../tools/signalEdit';
import { CROSSWALK_STYLES } from '../tools/types';
import type { UiContext } from './context';
import { clear, el, hiDpiCanvas, iconButton, numberInput, row, selectInput, textInput } from './dom';
import { ICONS } from './icons';
import type { Panel } from './Panel';

const MODES: { value: JunctionMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'priority', label: 'Priority signs' },
  { value: 'allStop', label: 'All-way stop' },
  { value: 'signal', label: 'Traffic lights' },
];
const ACCESS: { value: HighwayAccess; label: string }[] = [
  { value: 'crossing', label: 'Crossing, with turns' },
  { value: 'rightInOut', label: 'Right-in, right-out only' },
];
const SIGNS: { value: SignKind; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'priority', label: 'Priority' },
  { value: 'yield', label: 'Yield' },
  { value: 'stop', label: 'Stop' },
];
const PRESETS: { value: SignalPreset; label: string; tip: string }[] = [
  { value: 'opposing', label: 'Opposing', tip: 'Facing approaches go together, lefts yield' },
  { value: 'protectedLefts', label: 'Protected lefts', tip: 'A leading phase for left turns' },
  { value: 'split', label: 'Split', tip: 'Each approach runs alone' },
];

const DIAGRAM_SIZE = 240;
const STATE_STYLE = {
  red: { color: '#f06257', width: 1.5, dash: [3, 4] },
  permissive: { color: '#f2b53a', width: 2.2, dash: [7, 4] },
  protected: { color: '#4cd28c', width: 2.8, dash: [] as number[] },
};

const STAGE_NAMES: Record<string, string> = { green: 'green', yellow: 'yellow', allRed: 'all red' };

export class JunctionEditor {
  private phaseIndex = 0;
  private diagram: JunctionDiagram | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private status: HTMLElement | null = null;
  private phaseList: HTMLElement | null = null;

  constructor(private readonly ui: UiContext, private readonly id: Id, private readonly panel: Panel) {}

  private get plan(): SignalPlan | null {
    return this.ui.net.getNode(this.id)?.control.signal ?? null;
  }

  private setPlan(plan: SignalPlan, label: string, key?: string): void {
    this.ui.history.hint(label, key);
    this.ui.net.setJunctionControl(this.id, { signal: plan });
  }

  private setMode(mode: JunctionMode): void {
    const { net, history } = this.ui;
    const node = net.getNode(this.id);
    if (!node) return;
    history.hint('Change junction control');
    net.batch(() => {
      if (mode === 'signal' && !node.control.signal) {
        net.setJunctionControl(this.id, { mode, signal: autoSignalPlan(net, this.id) });
      } else {
        net.setJunctionControl(this.id, { mode });
      }
    });
    this.render();
  }

  /** Crossing with turns, or right in and right out only, at a junction with a highway. */
  private setAccess(access: HighwayAccess): void {
    const { net, history } = this.ui;
    history.hint('Change highway access');
    // The movements change, so a plan made for the old ones goes; lights fall back to the automatic plan.
    net.setJunctionControl(this.id, { highwayAccess: access, signal: null });
    this.render();
  }

  /** Two roads of different widths end to end: pick how they line up (tools/endAlign.ts). */
  private renderLineUp(body: HTMLElement): void {
    const { net } = this.ui;
    const info = jointAlign(net, this.id);
    if (!info) return;
    const options: { value: LaneAlign; label: string }[] = [
      { value: 'left', label: 'Left edges together' },
      { value: 'centre', label: 'Centred' },
      { value: 'right', label: 'Right edges together' },
    ];
    const buttons = el('div', { class: 'btn-row line-up' });
    for (const o of options) {
      buttons.append(
        el('button', {
          class: `btn${o.value === info.align ? ' active' : ''}`,
          text: o.label,
          dataset: { align: o.value },
          attrs: { type: 'button', 'aria-pressed': String(o.value === info.align) },
          on: {
            click: () => {
              this.ui.history.hint('Line up roads');
              setJointAlign(net, this.id, o.value, info.wide);
              this.render();
            },
          },
        }),
      );
    }
    body.append(el('div', { class: 'opt-title', text: 'Lanes line up' }), buttons, el('div', { class: 'small muted', text: 'Left and right looking along the wider road. The lane that ends or begins tapers on the other side.' }));
  }

  render(): void {
    const { net } = this.ui;
    const node = net.getNode(this.id);
    const geom = net.nodeGeom(this.id);
    const body = this.panel.body;
    if (!node || !geom) return;
    clear(body);
    this.canvas = null;
    this.status = null;
    this.phaseList = null;

    if (geom.kind !== 'junction') {
      const kind = geom.kind === 'deadEnd' ? 'Dead end' : geom.kind === 'plain' ? 'Plain joint' : geom.kind === 'merge' ? 'Edge merge' : 'Node';
      this.panel.setTitle(kind);
      const details = el('dl', { class: 'kv' });
      details.append(el('dt', { text: 'Height' }), el('dd', { text: `${node.pos.y.toFixed(1)} m` }));
      details.append(el('dt', { text: 'Roads' }), el('dd', { text: String(node.segments.length) }));
      if (geom.edge) {
        // An edge merge (core/edgeMerge.ts): the highway runs on, the ramp blends into its edge lane.
        const e = geom.edge;
        const what = e.mode === 'add' ? 'On-ramp, added lane' : e.mode === 'drop' ? 'Off-ramp, edge lane exit only' : e.merge ? 'On-ramp, taper' : 'Off-ramp, taper';
        details.append(el('dt', { text: 'Ramp' }), el('dd', { text: what }));
        details.append(el('dt', { text: 'Taper' }), el('dd', { text: `${e.taper.toFixed(0)} m` }));
      }
      body.append(details);
      this.renderLineUp(body);
      if (geom.kind === 'deadEnd' && !net.endpoints.some((e) => e.nodeId === this.id)) {
        body.append(
          el('div', { class: 'btn-row', style: { marginTop: '8px' } }, el('button', {
            class: 'btn',
            text: 'Add gateway here',
            attrs: { type: 'button' },
            on: {
              click: () => {
                this.ui.history.hint('Add gateway');
                const lanes = net.roadTypeOf(node.segments[0]).lanes.length;
                const id = net.addEndpoint({ kind: 'gateway', name: `Gateway ${net.endpoints.length + 1}`, nodeId: this.id, ratePerHour: 300 * lanes });
                this.ui.inspect({ kind: 'endpoint', id });
              },
            },
          })),
        );
      }
      return;
    }

    this.panel.setTitle('Junction');
    // A ramp asked to blend into the edge lane but could not (core/edgeMerge.ts).
    const why = net.edgeMergeProblem(this.id);
    if (why) body.append(el('div', { class: 'small muted', text: `Edge merge not possible: ${why}` }));
    this.renderLineUp(body);
    const effective = effectiveControl(net, this.id);
    const control = node.control;
    body.append(row('Control', selectInput(MODES, control.mode, (v) => this.setMode(v))));
    if (hasHighwayAccessChoice(net, this.id)) {
      // Where a road meets a highway at grade (core/highwayCrossing.ts). Absent is right in, right out.
      body.append(row('Highway', selectInput(ACCESS, control.highwayAccess ?? 'rightInOut', (v) => this.setAccess(v))));
    }
    if (control.mode === 'auto') {
      const label = effective.kind === 'none' ? 'Free flow' : effective.kind === 'signal' ? 'Traffic lights' : effective.kind === 'allStop' ? 'All-way stop' : 'Priority signs';
      body.append(el('div', { class: 'small muted', text: `Auto is using: ${label}.` }));
    }
    if (control.mode === 'priority') this.renderSigns(body, geom.arms.map((a) => a.segmentId));
    if (control.mode === 'signal') this.renderSignal(body);
    this.renderCrosswalks(body, geom.arms.map((a) => a.segmentId));
    body.append(
      el('div', { class: 'btn-row', style: { marginTop: '8px' } }, el('button', {
        class: 'btn',
        text: 'Mark this junction',
        tip: 'Add lines, crosswalks and fillers by hand',
        attrs: { type: 'button' },
        on: {
          click: () => {
            this.ui.tools.setTool('paint');
            this.ui.tools.nodeMarkings.open(this.id);
          },
        },
      }), el('button', {
        class: 'btn',
        text: control.laneLinks ? 'Edit lanes (manual)' : 'Edit lanes',
        attrs: { type: 'button' },
        on: {
          click: () => {
            this.ui.tools.setTool('lanes');
            this.ui.tools.lanes.openNode(this.id);
          },
        },
      })),
    );
  }

  private armName(seg: Id): string {
    const { net } = this.ui;
    return net.getSegment(seg)?.overrides.name || net.roadTypeOf(seg).name;
  }

  private renderSigns(body: HTMLElement, arms: Id[]): void {
    const { net, history } = this.ui;
    const node = net.getNode(this.id)!;
    const shown = effectiveControl(net, this.id).signs;
    body.append(el('div', { class: 'section-title', text: 'Signs per arm' }));
    for (const seg of arms) {
      if (!(seg in shown) && !(seg in node.control.signs)) continue;
      body.append(
        row(this.armName(seg), selectInput(SIGNS, node.control.signs[seg] ?? shown[seg] ?? 'none', (v) => {
          history.hint('Set sign');
          net.setSign(this.id, seg, v);
        })),
      );
    }
  }

  private renderCrosswalks(body: HTMLElement, arms: Id[]): void {
    const { net, history } = this.ui;
    const node = net.getNode(this.id)!;
    const details = el('details', {}, el('summary', { class: 'section-title', text: 'Crosswalks per arm' }));
    const options: { value: CrosswalkStyle | 'road'; label: string }[] = [
      { value: 'road', label: 'From the road' },
      ...CROSSWALK_STYLES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })),
    ];
    for (const seg of arms) {
      details.append(
        row(this.armName(seg), selectInput(options, node.control.crosswalks[seg] ?? 'road', (v) => {
          history.hint('Set crosswalk');
          if (v === 'road') {
            const rest = { ...node.control.crosswalks };
            delete rest[seg];
            net.setJunctionControl(this.id, { crosswalks: rest });
          } else {
            net.setCrosswalk(this.id, seg, v);
          }
        })),
      );
    }
    body.append(details);
  }

  private renderSignal(body: HTMLElement): void {
    const plan = this.plan;
    if (!plan) return;
    if (this.phaseIndex >= plan.phases.length) this.phaseIndex = Math.max(0, plan.phases.length - 1);

    body.append(el('div', { class: 'section-title', text: 'Signal plan' }));
    const presets = el('div', { class: 'btn-row' });
    for (const p of PRESETS) {
      presets.append(
        el('button', {
          class: 'btn',
          text: p.label,
          tip: p.tip,
          attrs: { type: 'button' },
          on: {
            click: () => {
              this.setPlan(defaultSignalPlan(this.ui.net, this.id, p.value), 'Apply signal preset');
              this.phaseIndex = 0;
              this.render();
            },
          },
        }),
      );
    }
    body.append(
      presets,
      row('Timing', selectInput([{ value: 'fixed', label: 'Fixed' }, { value: 'actuated', label: 'Actuated' }], plan.kind, (v) => {
        this.setPlan({ ...plan, kind: v }, 'Change signal timing');
        this.render();
      })),
      row('Offset', numberInput(plan.offsetSec, { min: 0, max: 600, step: 1 }, (v) => {
        const current = this.plan;
        if (current) this.setPlan({ ...current, offsetSec: Math.max(0, v) }, 'Change signal offset', `offset-${this.id}`);
      }), 'Seconds into the cycle, to coordinate neighbouring signals'),
    );

    this.canvas = hiDpiCanvas(DIAGRAM_SIZE, DIAGRAM_SIZE, 'diagram');
    this.canvas.setAttribute('aria-label', 'Junction diagram. Click an arrow to cycle red, permissive, protected.');
    this.canvas.addEventListener('click', (e) => {
      if (!this.diagram) return;
      const m = moveAt(this.diagram, e.offsetX, e.offsetY);
      const current = this.plan;
      if (!m || !current) return;
      this.setPlan(cycleMove(current, this.phaseIndex, m.key), 'Edit signal phase');
      this.drawDiagram();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.canvas && this.diagram) this.canvas.style.cursor = moveAt(this.diagram, e.offsetX, e.offsetY) ? 'pointer' : 'default';
    });
    this.diagram = layoutDiagram(this.ui.net, this.id, DIAGRAM_SIZE);
    this.status = el('div', { class: 'small', style: { textAlign: 'center', marginBottom: '4px' } });
    body.append(
      this.canvas,
      el(
        'div',
        { class: 'legend' },
        el('span', {}, el('i', { style: { borderTop: '2px dashed #ff6b6b' } }), 'Red'),
        el('span', {}, el('i', { style: { borderTop: '2px dashed #ffc857' } }), 'Permissive'),
        el('span', {}, el('i', { style: { borderTop: '3px solid #58e6a9' } }), 'Protected'),
      ),
      this.status,
    );
    this.drawDiagram();

    this.phaseList = el('div', { class: 'phase-list' });
    this.renderPhases();
    body.append(
      el('div', { class: 'section-title', text: `Phases, ${cycleLength(plan).toFixed(1)} s cycle` }),
      this.phaseList,
      el('div', { class: 'btn-row', style: { marginTop: '5px' } }, el('button', {
        class: 'btn',
        text: 'Add phase',
        attrs: { type: 'button' },
        on: {
          click: () => {
            const current = this.plan;
            if (!current) return;
            this.setPlan(addPhase(current), 'Add signal phase');
            this.phaseIndex = current.phases.length;
            this.render();
          },
        },
      })),
    );
    this.renderPhaseFields(body);
    this.tick();
  }

  private renderPhases(): void {
    const plan = this.plan;
    if (!plan || !this.phaseList) return;
    clear(this.phaseList);
    plan.phases.forEach((phase, i) => {
      const line = el(
        'div',
        { class: `phase-row ${i === this.phaseIndex ? 'selected' : ''}`, dataset: { phase: String(i) } },
        el('span', {
          class: 'phase-name',
          text: `${phase.name}, ${phase.greenSec} s`,
          on: {
            click: () => {
              this.phaseIndex = i;
              this.render();
            },
          },
        }),
        el(
          'span',
          { class: 'btn-row', style: { gap: '0', flexWrap: 'nowrap' } },
          iconButton(ICONS.up, { tip: 'Earlier', onClick: () => this.shift(i, -1) }),
          iconButton(ICONS.down, { tip: 'Later', onClick: () => this.shift(i, 1) }),
          iconButton(ICONS.trash, {
            tip: 'Remove phase',
            onClick: () => {
              const current = this.plan;
              if (!current || current.phases.length <= 1) {
                this.ui.toast('A signal needs at least one phase.', 'warning');
                return;
              }
              this.setPlan(removePhase(current, i), 'Remove signal phase');
              this.render();
            },
          }),
        ),
      );
      this.phaseList!.append(line);
    });
  }

  private shift(index: number, direction: 1 | -1): void {
    const current = this.plan;
    if (!current) return;
    const next = movePhase(current, index, direction);
    if (next === current) return;
    this.setPlan(next, 'Reorder signal phases');
    if (this.phaseIndex === index) this.phaseIndex = index + direction;
    this.render();
  }

  private renderPhaseFields(body: HTMLElement): void {
    const plan = this.plan;
    const phase = plan?.phases[this.phaseIndex];
    if (!plan || !phase) return;
    const number = (label: string, field: 'greenSec' | 'yellowSec' | 'allRedSec' | 'minGreenSec' | 'maxGreenSec', min: number, max: number, step: number) =>
      row(label, numberInput(phase[field], { min, max, step }, (v) => {
        const current = this.plan;
        if (current) this.setPlan(setPhaseField(current, this.phaseIndex, field, Math.max(min, v)), 'Change phase timing', `phase-${field}-${this.id}`);
      }));
    body.append(
      el('div', { class: 'section-title', text: 'Selected phase' }),
      row('Name', textInput(phase.name, 'Phase name', (v) => {
        const current = this.plan;
        if (current) this.setPlan(setPhaseField(current, this.phaseIndex, 'name', v), 'Rename phase', `phase-name-${this.id}`);
      })),
      number('Green', 'greenSec', 1, 180, 1),
      number('Yellow', 'yellowSec', 0, 10, 0.5),
      number('All red', 'allRedSec', 0, 10, 0.5),
    );
    if (plan.kind === 'actuated') {
      body.append(number('Min green', 'minGreenSec', 1, 120, 1), number('Max green', 'maxGreenSec', 1, 240, 1));
    }
  }

  private drawDiagram(): void {
    const canvas = this.canvas;
    const d = this.diagram;
    const plan = this.plan;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !d || !plan) return;
    const phase = plan.phases[this.phaseIndex];
    ctx.clearRect(0, 0, d.size, d.size);
    ctx.strokeStyle = '#3a5574';
    ctx.lineCap = 'butt';
    for (const arm of d.arms) {
      ctx.lineWidth = arm.half * 2;
      ctx.beginPath();
      ctx.moveTo(d.centre.x, d.centre.y);
      ctx.lineTo(arm.tip.x, arm.tip.y);
      ctx.stroke();
    }
    ctx.fillStyle = '#3a5574';
    ctx.beginPath();
    ctx.arc(d.centre.x, d.centre.y, Math.max(...d.arms.map((a) => a.half)), 0, Math.PI * 2);
    ctx.fill();
    const order = { red: 0, permissive: 1, protected: 2 } as const;
    const moves = [...d.moves].sort((a, b) => order[moveState(phase, a.key)] - order[moveState(phase, b.key)]);
    for (const m of moves) {
      const style = STATE_STYLE[moveState(phase, m.key)];
      ctx.strokeStyle = style.color;
      ctx.fillStyle = style.color;
      ctx.lineWidth = style.width;
      ctx.setLineDash(style.dash);
      ctx.beginPath();
      m.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.setLineDash([]);
      const end = m.points[m.points.length - 1];
      const prev = m.points[m.points.length - 2];
      const a = Math.atan2(end.y - prev.y, end.x - prev.x);
      ctx.beginPath();
      ctx.moveTo(end.x + Math.cos(a) * 3, end.y + Math.sin(a) * 3);
      ctx.lineTo(end.x + Math.cos(a + 2.5) * 8, end.y + Math.sin(a + 2.5) * 8);
      ctx.lineTo(end.x + Math.cos(a - 2.5) * 8, end.y + Math.sin(a - 2.5) * 8);
      ctx.fill();
    }
  }

  /** Live phase from the simulation. */
  tick(): void {
    if (!this.status) return;
    const s = this.ui.sim.signalStatus(this.id);
    if (!s) {
      this.status.textContent = 'Signal not running';
      return;
    }
    if (s.phaseIndex < 0) {
      this.status.textContent = 'Now: hand control (Junction > Rules > Manual lights)';
      return;
    }
    const plan = this.plan;
    const name = plan?.phases[s.phaseIndex]?.name ?? `Phase ${s.phaseIndex + 1}`;
    this.status.textContent = `Now: ${name}, ${STAGE_NAMES[s.stage] ?? s.stage}, ${s.remainingSec.toFixed(0)} s left`;
    this.phaseList?.querySelectorAll<HTMLElement>('.phase-row').forEach((r) => r.classList.toggle('running', r.dataset.phase === String(s.phaseIndex)));
  }
}
