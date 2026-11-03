/** The bottom toolbar: category tabs, thumbnail cards and the left options strip. */
import { BUILTIN_ROAD_TYPES, driveLaneCount, isOneWay } from '../core/roadTypes';
import type { DecalKind, EndpointKind, PaintColor, RoadCategory, RoadTypeDef } from '../core/types';
import { MAX_ELEVATION, MIN_ELEVATION } from '../core/terrain';
import { defaultDecalWidth, LINE_DECALS, LINE_STYLES, AREA_DECALS } from '../tools/PaintTool';
import { formatElevation } from '../tools/RoadTool';
import { ENDPOINT_NAMES } from '../tools/TrafficTool';
import type { DrawMode, ToolId } from '../tools/types';
import type { UiContext } from './context';
import { checkbox, clear, el, hiDpiCanvas, iconButton, row, selectInput, sliderInput, textInput } from './dom';
import { ICONS, type IconName } from './icons';
import { drawDecalThumb, drawLineThumb, drawRoadThumb, PAINT_CSS } from './thumbnails';

export type TabId = RoadCategory | 'intersections' | 'control' | 'paint' | 'traffic';

const ROAD_TABS: readonly RoadCategory[] = ['street', 'avenue', 'oneway', 'highway', 'ramp', 'custom'];

const TABS: { id: TabId; label: string; icon: IconName; key?: string }[] = [
  { id: 'street', label: 'Streets', icon: 'street', key: 'N' },
  { id: 'avenue', label: 'Avenues', icon: 'avenue' },
  { id: 'oneway', label: 'One-ways', icon: 'oneway' },
  { id: 'highway', label: 'Highways', icon: 'highway' },
  { id: 'ramp', label: 'Ramps', icon: 'ramp' },
  { id: 'custom', label: 'Custom', icon: 'custom' },
  { id: 'control', label: 'Traffic Control', icon: 'control', key: 'J' },
  { id: 'paint', label: 'Paint', icon: 'paint', key: 'P' },
  { id: 'traffic', label: 'Traffic', icon: 'traffic', key: 'T' },
];

const DRAW_MODES: { mode: DrawMode; icon: IconName; tip: string; key: string }[] = [
  { mode: 'straight', icon: 'straight', tip: 'Straight', key: 'Z' },
  { mode: 'curved', icon: 'curved', tip: 'Curved: start, control, end', key: 'X' },
  { mode: 'freeform', icon: 'freeform', tip: 'Freeform: continues the last tangent', key: 'C' },
  { mode: 'upgrade', icon: 'upgrade', tip: 'Upgrade: click or drag over roads', key: 'G' },
];

const DECAL_CARDS: { kind: DecalKind; name: string }[] = [
  { kind: 'hatch', name: 'Hatched area' },
  { kind: 'fill', name: 'Filled area' },
  { kind: 'crosswalk', name: 'Crosswalk' },
  { kind: 'stopLine', name: 'Stop line' },
  { kind: 'yieldTriangles', name: 'Yield triangles' },
  { kind: 'arrowStraight', name: 'Arrow ahead' },
  { kind: 'arrowLeft', name: 'Arrow left' },
  { kind: 'arrowRight', name: 'Arrow right' },
  { kind: 'arrowStraightLeft', name: 'Ahead or left' },
  { kind: 'arrowStraightRight', name: 'Ahead or right' },
  { kind: 'text', name: 'Text' },
];

const ENDPOINT_CARDS: { kind: EndpointKind; icon: IconName; meta: string }[] = [
  { kind: 'gateway', icon: 'gateway', meta: 'On a dead end' },
  { kind: 'residential', icon: 'home', meta: 'Beside a road' },
  { kind: 'commercial', icon: 'shop', meta: 'Beside a road' },
  { kind: 'industrial', icon: 'factory', meta: 'Beside a road' },
  { kind: 'office', icon: 'office', meta: 'Beside a road' },
];

const PAINT_COLORS: PaintColor[] = ['white', 'yellow', 'blue', 'red', 'green'];

export class Toolbar {
  readonly root: HTMLElement;
  private readonly tabs = new Map<TabId, HTMLButtonElement>();
  private readonly toolButtons = new Map<ToolId, HTMLButtonElement>();
  private readonly tray = el('div', { class: 'tray closed' });
  private readonly options = el('div', { class: 'options' });
  private readonly cards = el('div', { class: 'cards' });
  private tab: TabId | null = null;

  constructor(private readonly ui: UiContext) {
    const tabRow = el('div', { class: 'tabs', attrs: { role: 'tablist' } });
    for (const t of TABS) {
      const btn = el('button', {
        class: 'tab',
        tip: t.label,
        keyHint: t.key,
        html: `${ICONS[t.icon]}<span>${t.label}</span>`,
        attrs: { type: 'button', role: 'tab', 'aria-label': t.label },
        on: { click: () => this.toggleTab(t.id) },
      });
      this.tabs.set(t.id, btn);
      tabRow.append(btn);
    }
    const cluster = el('div', { class: 'tool-cluster' });
    const addTool = (id: ToolId, icon: IconName, tip: string, key: string) => {
      const btn = iconButton(ICONS[icon], { tip, keyHint: key, onClick: () => this.toggleTool(id) });
      this.toolButtons.set(id, btn);
      cluster.append(btn);
    };
    addTool('select', 'select', 'Inspect', 'V');
    addTool('move', 'move', 'Move nodes and curves', 'M');
    addTool('bulldoze', 'bulldoze', 'Bulldoze', 'B');
    tabRow.append(cluster);

    this.tray.append(this.options, this.cards);
    this.root = el('div', { class: 'panel toolbar' }, this.tray, tabRow);
    ui.dock.append(this.root);
    ui.tools.onChange(() => this.syncState());
    ui.net.onChange((c) => {
      if (c.settingsChanged || c.reset) {
        if (this.tab === 'custom') this.render();
      }
    });
    this.syncState();
  }

  get currentTab(): TabId | null {
    return this.tab;
  }

  private get tools() {
    return this.ui.tools;
  }

  toggleTool(id: ToolId): void {
    this.tools.setTool(this.tools.active.id === id ? 'select' : id);
  }

  toggleTab(id: TabId): void {
    this.openTab(this.tab === id ? null : id);
  }

  openTab(id: TabId | null): void {
    this.tab = id;
    this.render();
    if (id === 'control' && this.tools.active.id !== 'lanes') this.tools.setTool('junction');
    if (id === 'paint') this.tools.setTool('paint');
    if (id === 'traffic') this.tools.setTool('traffic');
    if (id === 'intersections' && this.tools.settings.template.id) this.tools.setTool('template');
    this.syncState();
  }

  private render(): void {
    const id = this.tab;
    this.tray.classList.toggle('closed', id === null);
    clear(this.options);
    clear(this.cards);
    if (id === null) return;
    if ((ROAD_TABS as readonly string[]).includes(id)) this.renderRoads(id as RoadCategory);
    else if (id === 'intersections') this.renderTemplates();
    else if (id === 'control') this.renderControl();
    else if (id === 'paint') this.renderPaint();
    else if (id === 'traffic') this.renderTraffic();
  }

  private roadCard(def: RoadTypeDef): HTMLElement {
    const canvas = hiDpiCanvas(102, 52);
    drawRoadThumb(canvas, def, 102, 52);
    const lanes = isOneWay(def) ? `${driveLaneCount(def)} one-way` : `${driveLaneCount(def, 1)}+${driveLaneCount(def, -1)} lanes`;
    const card = el(
      'button',
      {
        class: 'card',
        dataset: { road: def.id },
        tip: def.name,
        attrs: { type: 'button', 'aria-label': def.name },
        on: {
          click: () => {
            this.tools.settings.roadType = def.id;
            if (this.tools.settings.drawMode === 'upgrade' && this.tools.active.id !== 'road') this.tools.settings.drawMode = 'straight';
            this.tools.setTool('road');
          },
        },
      },
      canvas,
      el('div', { class: 'card-name', text: def.name }),
      el('div', { class: 'card-meta', text: `${lanes}, ${def.speedKmh} km/h` }),
    );
    if (def.category === 'custom') {
      card.append(
        el('span', {
          class: 'btn card-edit',
          text: 'Edit',
          on: {
            click: (e) => {
              e.stopPropagation();
              this.ui.openDesigner(def.id);
            },
          },
        }),
      );
    }
    return card;
  }

  private renderRoads(category: RoadCategory): void {
    this.renderDrawOptions();
    const defs = [...BUILTIN_ROAD_TYPES, ...this.ui.net.project.customRoadTypes].filter((d) => d.category === category);
    for (const def of defs) this.cards.append(this.roadCard(def));
    if (category === 'custom') {
      this.cards.append(
        el(
          'button',
          {
            class: 'card',
            tip: 'Design a new road type',
            attrs: { type: 'button' },
            on: { click: () => this.ui.openDesigner() },
          },
          el('div', { class: 'art', html: ICONS.plus }),
          el('div', { class: 'card-name', text: 'New road' }),
          el('div', { class: 'card-meta', text: 'Road designer' }),
        ),
      );
    }
    this.syncState();
  }

  private renderDrawOptions(): void {
    const s = this.tools.settings;
    const modes = el('div', { class: 'opt-row' });
    for (const m of DRAW_MODES) {
      modes.append(
        Object.assign(
          iconButton(ICONS[m.icon], {
            tip: m.tip,
            keyHint: m.key,
            class: 'mode-btn',
            onClick: () => this.setDrawMode(m.mode),
          }),
          { value: m.mode },
        ),
      );
    }
    modes.append(
      iconButton(ICONS.reverse, {
        tip: 'Reverse direction: click or drag over roads',
        keyHint: 'H',
        class: 'reverse-btn',
        onClick: () => this.tools.setTool(this.tools.active.id === 'reverse' ? 'road' : 'reverse'),
      }),
      iconButton(ICONS.follow, {
        tip: 'Reverse the whole connected road, not one piece',
        class: 'reverse-whole-btn',
        onClick: () => {
          s.reverseWholeRoad = !s.reverseWholeRoad;
          this.tools.settingsChanged();
        },
      }),
    );

    const snaps = el('div', { class: 'opt-row' });
    const toggle = (key: 'snapNodes' | 'snapSegments' | 'snapAngle' | 'snapLength', icon: IconName, tip: string) => {
      snaps.append(
        iconButton(ICONS[icon], {
          tip: `${tip}. Ctrl or Cmd turns all snapping off while held`,
          class: `snap-btn snap-${key}`,
          onClick: () => {
            s[key] = !s[key];
            this.tools.settingsChanged();
          },
        }),
      );
    };
    toggle('snapNodes', 'node', 'Snap to nodes');
    toggle('snapSegments', 'snapRoad', 'Snap along roads, splitting them');
    toggle('snapAngle', 'angle', 'Snap to 15 degree guides');
    toggle('snapLength', 'ruler', 'Snap length to 8 m steps');

    const elevation = el(
      'div',
      { class: 'elevation' },
      iconButton(ICONS.down, { tip: 'Lower 4 m', keyHint: 'PgDn', onClick: () => this.tools.road.stepElevation(-1) }),
      el('b', { class: 'elevation-value' }),
      iconButton(ICONS.up, { tip: 'Raise 4 m', keyHint: 'PgUp', onClick: () => this.tools.road.stepElevation(1) }),
    );
    this.options.append(
      el('div', { class: 'opt-title', text: 'Draw mode' }),
      modes,
      el('div', { class: 'opt-title', text: 'Snapping' }),
      snaps,
      el('div', { class: 'opt-title', text: 'Elevation' }),
      elevation,
    );
  }

  setDrawMode(mode: DrawMode): void {
    this.tools.settings.drawMode = mode;
    this.tools.setTool('road');
    this.tools.settingsChanged();
  }

  private renderTemplates(): void {
    const { templates } = this.ui;
    if (!templates) {
      this.cards.append(el('div', { class: 'tray-note', text: 'Interchange templates are not available in this build yet.' }));
      return;
    }
    const s = this.tools.settings.template;
    for (const t of templates.TEMPLATES) {
      this.cards.append(
        el(
          'button',
          {
            class: 'card',
            dataset: { template: t.id },
            tip: t.description,
            attrs: { type: 'button', 'aria-label': t.name },
            on: {
              click: () => {
                s.id = t.id;
                this.tools.setTool('template');
                this.render();
                this.syncState();
              },
            },
          },
          el('div', { class: 'art', html: ICONS.intersections }),
          el('div', { class: 'card-name', text: t.name }),
          el('div', { class: 'card-meta', text: t.category ? t.category[0].toUpperCase() + t.category.slice(1) : `${t.params.length} settings` }),
        ),
      );
    }
    const def = this.tools.template.template;
    if (!def) return;
    const params = this.tools.template.paramsOf(def);
    this.options.append(el('div', { class: 'opt-title', text: def.name }));
    for (const p of def.params) {
      this.options.append(
        el(
          'div',
          {},
          el('div', { class: 'opt-title', text: p.label }),
          sliderInput(params[p.key], { min: p.min, max: p.max, step: p.step }, (v) => {
            params[p.key] = v;
            this.tools.settingsChanged();
          }),
        ),
      );
    }
    const roadOptions = [{ value: '', label: 'Template default' }, ...BUILTIN_ROAD_TYPES.map((r) => ({ value: r.id, label: r.name }))];
    this.options.append(
      el('div', { class: 'opt-title', text: 'Road type' }),
      selectInput(roadOptions, s.roadType ?? '', (v) => {
        s.roadType = v || null;
        this.tools.settingsChanged();
      }),
      el('div', { class: 'opt-title', text: 'Rotation and height' }),
      el(
        'div',
        { class: 'opt-row' },
        iconButton('[', { tip: 'Rotate left', keyHint: '[', onClick: () => this.tools.template.rotate(-1) }),
        iconButton(']', { tip: 'Rotate right', keyHint: ']', onClick: () => this.tools.template.rotate(1) }),
        iconButton(ICONS.down, { tip: 'Lower 4 m', keyHint: 'PgDn', onClick: () => this.tools.template.stepElevation(-1) }),
        el('b', { class: 'template-elevation' }),
        iconButton(ICONS.up, { tip: 'Raise 4 m', keyHint: 'PgUp', onClick: () => this.tools.template.stepElevation(1) }),
      ),
    );
    this.syncState();
  }

  private renderControl(): void {
    const card = (tool: ToolId, icon: IconName, name: string, meta: string, key: string) =>
      el(
        'button',
        {
          class: 'card',
          dataset: { tool },
          tip: name,
          keyHint: key,
          attrs: { type: 'button', 'aria-label': name },
          on: { click: () => this.tools.setTool(tool) },
        },
        el('div', { class: 'art', html: ICONS[icon] }),
        el('div', { class: 'card-name', text: name }),
        el('div', { class: 'card-meta', text: meta }),
      );
    this.cards.append(
      card('junction', 'control', 'Junction control', 'Signs and signals', 'J'),
      card('lanes', 'lanes', 'Lane connector', 'Link lanes by hand', 'L'),
    );
    this.options.append(
      el('div', { class: 'opt-title', text: 'Lane connector' }),
      el('button', { class: 'btn reset-lanes', text: 'Reset to Auto', tip: 'Back to automatic connectors at this junction', attrs: { type: 'button' }, on: { click: () => this.tools.lanes.resetToAuto() } }),
      el('div', { class: 'small muted', text: 'Click a junction, an amber arriving lane, then a cyan leaving lane.' }),
    );
    this.syncState();
  }

  private renderPaint(): void {
    const p = this.tools.settings.paint;
    this.cards.append(
      el(
        'button',
        {
          class: 'card',
          dataset: { tool: 'nodeMarkings' },
          tip: 'Click a junction, then click anchors to mark it by hand',
          keyHint: 'K',
          attrs: { type: 'button', 'aria-label': 'Node markings' },
          on: { click: () => this.tools.setTool('nodeMarkings') },
        },
        el('div', { class: 'art', html: ICONS.intersections }),
        el('div', { class: 'card-name', text: 'Node markings' }),
      ),
    );
    const pick = (apply: () => void) => {
      apply();
      this.tools.setTool('paint');
      this.tools.settingsChanged();
      this.renderPaintOptions();
      this.syncState();
    };
    for (const l of LINE_STYLES) {
      const canvas = hiDpiCanvas(102, 52);
      drawLineThumb(canvas, l.style, 102, 52);
      this.cards.append(
        el(
          'button',
          {
            class: 'card',
            dataset: { line: l.style },
            tip: `${l.name}. Click where it starts, then where it ends. It follows the road`,
            attrs: { type: 'button', 'aria-label': l.name },
            on: {
              click: () =>
                pick(() => {
                  p.kind = 'line';
                  p.lineStyle = l.style;
                  p.width = defaultDecalWidth('line');
                }),
            },
          },
          canvas,
          el('div', { class: 'card-name', text: l.name }),
        ),
      );
    }
    for (const d of DECAL_CARDS) {
      const canvas = hiDpiCanvas(102, 52);
      drawDecalThumb(canvas, d.kind, 102, 52);
      this.cards.append(
        el(
          'button',
          {
            class: 'card',
            dataset: { decal: d.kind },
            tip: d.name,
            attrs: { type: 'button', 'aria-label': d.name },
            on: {
              click: () =>
                pick(() => {
                  p.kind = d.kind;
                  p.width = defaultDecalWidth(d.kind);
                }),
            },
          },
          canvas,
          el('div', { class: 'card-name', text: d.name }),
        ),
      );
    }
    this.renderPaintOptions();
    this.syncState();
  }

  private renderPaintOptions(): void {
    const p = this.tools.settings.paint;
    clear(this.options);
    const swatches = el('div', { class: 'swatches' });
    for (const c of PAINT_COLORS) {
      swatches.append(
        el('button', {
          class: `swatch ${p.color === c ? 'active' : ''}`,
          tip: c,
          style: { background: PAINT_CSS[c] },
          attrs: { type: 'button', 'aria-label': `${c} paint` },
          on: {
            click: () => {
              p.color = c;
              this.tools.settingsChanged();
              this.renderPaintOptions();
            },
          },
        }),
      );
    }
    const isLine = LINE_DECALS.includes(p.kind) || AREA_DECALS.includes(p.kind);
    this.options.append(
      el('div', { class: 'opt-title', text: 'Colour' }),
      swatches,
      el('div', { class: 'opt-title', text: 'Width' }),
      sliderInput(p.width, { min: 0.1, max: isLine ? 3 : 12, step: 0.05, format: (v) => `${v.toFixed(2)} m` }, (v) => {
        p.width = v;
        this.tools.settingsChanged();
      }),
    );
    if (p.kind === 'text') {
      this.options.append(
        el('div', { class: 'opt-title', text: 'Text' }),
        textInput(p.text, 'Text to paint', (v) => {
          p.text = v;
          this.tools.settingsChanged();
        }),
      );
    }
    const hint = AREA_DECALS.includes(p.kind)
      ? 'Click one side of the area, then the other side further along. It follows the road.'
      : isLine
        ? 'Click a start, then an end. Near a junction the line reaches its edge.'
        : 'Click a lane. The direction comes from the lane.';
    this.options.append(el('div', { class: 'small muted', text: hint }));
  }

  private renderTraffic(): void {
    const s = this.tools.settings;
    for (const c of ENDPOINT_CARDS) {
      this.cards.append(
        el(
          'button',
          {
            class: 'card',
            dataset: { endpoint: c.kind },
            tip: ENDPOINT_NAMES[c.kind],
            attrs: { type: 'button', 'aria-label': ENDPOINT_NAMES[c.kind] },
            on: {
              click: () => {
                s.trafficKind = c.kind;
                this.tools.setTool('traffic');
                this.tools.settingsChanged();
                this.syncState();
              },
            },
          },
          el('div', { class: 'art', html: ICONS[c.icon] }),
          el('div', { class: 'card-name', text: ENDPOINT_NAMES[c.kind] }),
          el('div', { class: 'card-meta', text: c.meta }),
        ),
      );
    }
    this.options.append(
      el('div', { class: 'opt-title', text: 'Auto gateways' }),
      row('Dead ends', checkbox(this.ui.net.traffic.autoGateways, (v) => {
        this.ui.history.hint('Auto gateways');
        this.ui.net.setTraffic({ autoGateways: v });
      }), 'Treat every dead end with no endpoint as a gateway'),
      el('div', { class: 'small muted', text: 'Click an endpoint to edit its rate, attraction and mix.' }),
    );
    this.syncState();
  }

  /** Reflect tool state in the buttons without rebuilding the tray. */
  private syncState(): void {
    const { tools } = this;
    const s = tools.settings;
    const active = tools.active.id;
    for (const [id, btn] of this.toolButtons) btn.classList.toggle('active', id === active);
    for (const [id, btn] of this.tabs) {
      btn.classList.toggle('active', id === this.tab);
      btn.setAttribute('aria-selected', String(id === this.tab));
    }
    this.root.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((b) => b.classList.toggle('active', b.value === s.drawMode && active === 'road'));
    const reverse = this.root.querySelector<HTMLElement>('.reverse-btn');
    if (reverse) {
      reverse.classList.toggle('active', active === 'reverse');
      const whole = this.root.querySelector<HTMLElement>('.reverse-whole-btn');
      if (whole) {
        whole.classList.toggle('active', s.reverseWholeRoad);
        whole.style.display = active === 'reverse' ? '' : 'none';
      }
    }
    for (const key of ['snapNodes', 'snapSegments', 'snapAngle', 'snapLength'] as const) {
      this.root.querySelector(`.snap-${key}`)?.classList.toggle('active', s[key]);
    }
    const elevation = this.root.querySelector<HTMLElement>('.elevation-value');
    if (elevation) {
      elevation.textContent = formatElevation(s.elevation);
      elevation.classList.toggle('above', s.elevation > 0);
      elevation.classList.toggle('below', s.elevation < 0);
    }
    const down = elevation?.previousElementSibling as HTMLButtonElement | null;
    const up = elevation?.nextElementSibling as HTMLButtonElement | null;
    if (down) down.disabled = s.elevation <= MIN_ELEVATION;
    if (up) up.disabled = s.elevation >= MAX_ELEVATION;
    const te = this.root.querySelector<HTMLElement>('.template-elevation');
    if (te) te.textContent = `${s.template.elevation} m`;
    this.cards.querySelectorAll<HTMLElement>('.card').forEach((card) => {
      const d = card.dataset;
      let on = false;
      if (d.road) on = active === 'road' && s.roadType === d.road;
      if (d.template) on = active === 'template' && s.template.id === d.template;
      if (d.decal) on = active === 'paint' && s.paint.kind === d.decal;
      if (d.line) on = active === 'paint' && s.paint.kind === 'line' && s.paint.lineStyle === d.line;
      if (d.endpoint) on = active === 'traffic' && s.trafficKind === d.endpoint;
      if (d.tool) on = active === d.tool;
      card.classList.toggle('active', on);
    });
    this.root.querySelector<HTMLButtonElement>('.reset-lanes')?.toggleAttribute('disabled', tools.lanes.node === null);
  }
}
