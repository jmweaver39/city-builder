/** The bottom toolbar: category tabs, thumbnail cards and the left options strip. */
import { BUILTIN_ROAD_TYPES, driveLaneCount, isOneWay } from '../core/roadTypes';
import type { DecalKind, EndpointKind, PaintColor, RoadCategory, RoadTypeDef, ZoneKind } from '../core/types';
import { MAX_ELEVATION, MIN_ELEVATION } from '../core/terrain';
import { defaultDecalWidth, LINE_DECALS, LINE_STYLES, AREA_DECALS } from '../tools/PaintTool';
import { formatElevation } from '../tools/RoadTool';
import { MOD_KEY } from '../tools/platform';
import { ENDPOINT_NAMES } from '../tools/TrafficTool';
import { ZONE_COLORS } from '../tools/ZoneTool';
import { ZONE_NAMES } from '../tools/zoneOps';
import type { DrawMode, ToolId } from '../tools/types';
import type { UiContext } from './context';
import { renderRailTray } from './RailPanels';
import { ControlTray } from './ControlTray';
import { renderLandscapeTray, roadStructureOptions } from './WallControls';
import { registerTerrainKeys, renderTerrainTray } from './TerrainControls';
import { checkbox, clear, el, hiDpiCanvas, iconButton, row, selectInput, sliderInput, textInput } from './dom';
import { ICONS, type IconName } from './icons';
import { drawDecalThumb, drawLineThumb, drawRoadThumb, PAINT_CSS } from './thumbnails';
import { gridSnapButtons, guideToggleRow, initGridPrefs, parallelButtons, syncGridControls } from './GridControls';
import { group, groupOf, GROUPS, legacyTab, modeOf, ROAD_CHIPS, type GroupId, type ToolMode } from './toolGroups';
import { keyHint } from './keymap';
import { GATEWAY_ART, zoneArt } from './cardArt';
import { roadThumbnail } from './roadThumbs3d';

/**
 * The open tray: one of the eight tools (toolGroups.ts). Old tab ids still open
 * the right one, so code that calls openTab('street') or openTab('control') works.
 */
export type TabId = GroupId | RoadCategory | 'intersections' | 'control' | 'traffic' | 'landscape';


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
  /** Road-type filter chips, above the cards in Build and Upgrade. */
  private readonly chips = el('div', { class: 'chips', attrs: { role: 'tablist', 'aria-label': 'Road types' } });
  private tab: TabId | null = null;
  private chip: RoadCategory = 'street';
  private renderedMode = '';
  private controlTray: ControlTray | null = null;

  constructor(private readonly ui: UiContext) {
    const tabRow = el('div', { class: 'tabs', attrs: { role: 'tablist' } });
    for (const g of GROUPS) {
      if (g.id === 'bulldoze') continue;
      const btn = el('button', {
        class: 'tab',
        tip: g.label,
        desc: g.desc,
        keyHint: keyHint(g.binding),
        html: `${ICONS[g.icon as IconName] ?? ''}<span>${g.label}</span>`,
        attrs: { type: 'button', role: 'tab', 'aria-label': g.label },
        on: { click: () => this.toggleTab(g.id) },
      });
      this.tabs.set(g.id, btn);
      tabRow.append(btn);
    }
    const cluster = el('div', { class: 'tool-cluster' });
    const bulldoze = iconButton(ICONS.bulldoze, { tip: 'Bulldoze', desc: 'Removes whatever is under the cursor', keyHint: keyHint('tool.bulldoze'), onClick: () => this.toggleTool('bulldoze') });
    this.toolButtons.set('bulldoze', bulldoze);
    cluster.append(bulldoze);
    tabRow.append(cluster);

    this.tray.append(this.options, el('div', { class: 'cards-wrap' }, this.chips, this.cards));
    this.root = el('div', { class: 'panel toolbar' }, this.tray, tabRow);
    ui.dock.append(this.root);
    ui.tools.onChange(() => this.syncState());
    initGridPrefs(ui);
    registerTerrainKeys(ui);
    ui.net.onChange((c) => {
      if (c.settingsChanged || c.reset) {
        if (this.tab === 'build' && this.chip === 'custom') this.render();
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

  private trayCards(): HTMLElement[] {
    return [...this.cards.querySelectorAll<HTMLElement>('.card')];
  }

  /** Click the nth card of the open tab, as keys 1 to 9 do. */
  pickCard(index: number): void {
    this.trayCards()[index]?.click();
  }

  /** Move to the next or previous card of the open tab, as Tab does. */
  cycleCard(step: 1 | -1): void {
    const cards = this.trayCards();
    if (!cards.length) return;
    const at = cards.findIndex((c) => c.classList.contains('active'));
    const next = cards[(at + step + cards.length) % cards.length];
    next.click();
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Number the first nine cards, which keys 1 to 9 pick. */
  private numberCards(): void {
    this.trayCards().forEach((card, i) => {
      card.querySelector('.card-num')?.remove();
      if (i >= 9) return;
      card.dataset.key = String(i + 1);
      if (!card.querySelector('.card-key')) card.append(el('kbd', { class: 'card-key card-num', text: String(i + 1) }));
    });
  }

  toggleTab(id: TabId): void {
    this.openTab(this.tab === id ? null : id);
  }

  openTab(id: TabId | null): void {
    if (id === 'intersections') {
      this.tab = id;
      this.render();
      if (this.tools.settings.template.id) this.tools.setTool('template');
      this.syncState();
      return;
    }
    const target = id === null ? null : legacyTab(id);
    if (id !== null && !target) return;
    const g = target?.group ?? null;
    if (target?.chip) this.chip = target.chip;
    this.tab = g;
    const s = this.tools.settings;
    const active = this.tools.active.id;
    // Opening a tool picks its first mode, unless one of its modes is already on.
    if (g && g !== 'transit' && groupOf(active, s.drawMode) !== g) {
      const first = group(g).modes[0];
      this.activateMode(first, false);
    }
    if (g === 'build' && active === 'road' && s.drawMode === 'upgrade') this.activateMode(group('build').modes[0], false);
    this.render();
    this.syncState();
  }

  /** Re-read tool state, for changes made outside a tool event. */
  refresh(): void {
    this.syncState();
  }

  /** Switch to one mode of a tool. */
  activateMode(m: ToolMode, notify = true): void {
    const s = this.tools.settings;
    if (m.drawMode) s.drawMode = m.drawMode;
    else if (m.tool === 'road' && s.drawMode === 'upgrade') s.drawMode = 'straight';
    this.tools.setTool(m.tool);
    if (notify || m.drawMode) this.tools.settingsChanged();
  }

  private render(): void {
    const id = this.tab;
    this.tray.classList.toggle('closed', id === null || id === 'bulldoze');
    this.tray.dataset.group = id ?? '';
    if (id !== 'junction') {
      this.controlTray?.dispose();
      this.controlTray = null;
    }
    clear(this.options);
    clear(this.cards);
    clear(this.chips);
    this.renderedMode = modeOf(this.tools.active.id, this.tools.settings.drawMode)?.id ?? '';
    if (id === null) return;
    if (id === 'build') this.renderBuild();
    else if (id === 'modify') this.renderModify();
    else if (id === 'intersections') this.renderTemplates();
    else if (id === 'junction') this.renderControl();
    else if (id === 'paint') this.renderPaint();
    else if (id === 'zones') this.renderTraffic();
    else if (id === 'terrain') {
      renderTerrainTray(this.ui, this.options, this.cards);
      renderLandscapeTray(this.ui, this.options, this.cards);
    }
    else if (id === 'transit') {
      renderRailTray(this.ui, this.options, this.cards);
      this.syncState();
    }
    this.numberCards();
  }

  /** The mode row at the top of the options strip, one button per mode. */
  private modeRow(g: GroupId): HTMLElement {
    const row = el('div', { class: 'mode-row', attrs: { role: 'radiogroup', 'aria-label': `${group(g).label} mode` } });
    for (const m of group(g).modes) {
      const b = el('button', {
        class: 'mode-tab',
        tip: m.label,
        desc: m.desc,
        keyHint: m.binding ? keyHint(m.binding) : undefined,
        html: `${ICONS[m.icon as IconName] ?? ''}<span>${m.label}</span>`,
        attrs: { type: 'button', role: 'radio', 'aria-label': m.label },
        dataset: { mode: m.id },
        on: { click: () => this.activateMode(m) },
      });
      row.append(b);
    }
    return row;
  }

  /** The road-type chips and cards, shared by Build and Upgrade. */
  private renderPicker(): void {
    for (const c of ROAD_CHIPS) {
      this.chips.append(
        el('button', {
          class: `chip ${c.id === this.chip ? 'active' : ''}`,
          text: c.label,
          attrs: { type: 'button', role: 'tab', 'aria-selected': String(c.id === this.chip) },
          on: {
            click: () => {
              this.chip = c.id;
              this.render();
              this.syncState();
            },
          },
        }),
      );
    }
    this.renderRoadCards(this.chip);
  }

  private renderBuild(): void {
    this.options.append(this.modeRow('build'));
    this.renderDrawOptions();
    this.renderPicker();
  }

  private renderModify(): void {
    const s = this.tools.settings;
    const mode = this.renderedMode;
    this.options.append(this.modeRow('modify'));
    const note = (text: string) => this.options.append(el('p', { class: 'opt-help', text }));
    if (mode === 'upgrade') {
      note('Sweep over roads.');
      this.options.append(roadStructureOptions(this.ui));
      this.renderPicker();
    } else if (mode === 'reverse') {
      note('Sweep over one-way roads.');
      this.options.append(row('Whole road', checkbox(s.reverseWholeRoad, (v) => {
        s.reverseWholeRoad = v;
        this.tools.settingsChanged();
      }), 'Turn every connected piece of the road'));
    } else if (mode === 'move') {
      note('Drag a node or curve handle. Q and E change its height.');
    } else if (mode === 'electrify') {
      note('Sweep over track. Shift removes wires.');
    } else if (mode === 'align') {
      note('Click a road to line the grid up with it.');
    } else {
      note('Click anything to inspect it.');
    }
  }

  private roadCard(def: RoadTypeDef): HTMLElement {
    // A rendered picture of the road where WebGL allows, the drawn cross-section otherwise.
    const url = roadThumbnail(def);
    let picture: HTMLElement;
    if (url) picture = el('img', { class: 'thumb', attrs: { src: url, alt: '', draggable: 'false' } });
    else {
      const canvas = hiDpiCanvas(102, 52);
      drawRoadThumb(canvas, def, 102, 52);
      picture = canvas;
    }
    const badge = def.category === 'rail' ? `${def.lanes.length}` : isOneWay(def) ? `${driveLaneCount(def)}` : `${driveLaneCount(def, 1)}+${driveLaneCount(def, -1)}`;
    const lanes =
      def.category === 'rail'
        ? def.lanes.length === 2 && Math.abs(def.lanes[0].offset) > 0.5
          ? 'Two tracks'
          : 'One track, both ways'
        : isOneWay(def)
          ? `${driveLaneCount(def)} one-way`
          : `${driveLaneCount(def, 1)}+${driveLaneCount(def, -1)} lanes`;
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
            // The Parallel tool can build with the selected road, so picking one keeps it.
            if (this.tools.active.id === 'parallel') this.tools.settingsChanged();
            else this.tools.setTool('road');
          },
        },
      },
      picture,
      el('span', { class: 'lane-badge', html: `${isOneWay(def) && def.category !== 'rail' ? ICONS.oneway : ICONS.lanes}${badge}`, attrs: { 'aria-hidden': 'true' } }),
      el('div', { class: 'card-name', text: def.name }),
      el('div', { class: 'card-meta', text: `${lanes}, ${def.speedKmh} km/h` }),
    );
    card.dataset.desc = `${lanes}, ${def.speedKmh} km/h`;
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

  private renderRoadCards(category: RoadCategory): void {
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
    // The parallel tool's own buttons (offset presets), from the grid module.
    const parallel = parallelButtons(this.ui);

    const snaps = el('div', { class: 'opt-row' });
    const toggle = (key: 'snapNodes' | 'snapSegments' | 'snapAngle' | 'snapLength', icon: IconName, tip: string) => {
      snaps.append(
        iconButton(ICONS[icon], {
          tip: `${tip}. Hold ${MOD_KEY} to turn all snapping off`,
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
    snaps.append(...gridSnapButtons(this.ui));

    const elevation = el(
      'div',
      { class: 'elevation', tip: 'Elevation', desc: 'Height of the next road end, in 4 m steps' },
      el('span', { class: 'elevation-icon', html: ICONS.toolTerrain, attrs: { 'aria-hidden': 'true' } }),
      iconButton(ICONS.down, { tip: 'Lower 4 m', keyHint: 'Q or PgDn', onClick: () => this.tools.road.stepElevation(-1) }),
      el('b', { class: 'elevation-value' }),
      iconButton(ICONS.up, { tip: 'Raise 4 m', keyHint: 'E or PgUp', onClick: () => this.tools.road.stepElevation(1) }),
    );
    this.options.append(
      ...(parallel.length ? [el('div', { class: 'opt-row parallel-row' }, ...parallel)] : []),
      snaps,
      elevation,
      el(
        'details',
        { class: 'advanced' },
        el('summary', { text: 'Advanced' }),
        el('div', { class: 'opt-title', text: 'Guides' }),
        guideToggleRow(this.ui),
        roadStructureOptions(this.ui),
      ),
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
    const roadOptions = [{ value: '', label: 'Template default' }, ...BUILTIN_ROAD_TYPES.filter((r) => r.category !== 'rail').map((r) => ({ value: r.id, label: r.name }))];
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
        iconButton(ICONS.down, { tip: 'Lower 4 m', keyHint: 'Q or PgDn', onClick: () => this.tools.template.stepElevation(-1) }),
        el('b', { class: 'template-elevation' }),
        iconButton(ICONS.up, { tip: 'Raise 4 m', keyHint: 'E or PgUp', onClick: () => this.tools.template.stepElevation(1) }),
      ),
    );
    this.syncState();
  }

  private renderControl(): void {
    this.controlTray?.dispose();
    this.controlTray = new ControlTray(this.ui, this.cards, this.options);
    this.controlTray.render();
    this.syncState();
  }

  private renderPaint(): void {
    const p = this.tools.settings.paint;
    // Junction markings and shape moved to the Junction tool.
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
    const gateway = ENDPOINT_CARDS[0];
    this.cards.append(
      el(
        'button',
        {
          class: 'card',
          dataset: { endpoint: 'gateway' },
          tip: 'Gateway: traffic enters and leaves the map at a dead end',
          attrs: { type: 'button', 'aria-label': 'Gateway' },
          on: {
            click: () => {
              s.trafficKind = 'gateway';
              this.tools.setTool('traffic');
              this.tools.settingsChanged();
              this.renderTrafficOptions();
              this.syncState();
            },
          },
        },
        el('div', { class: 'art picture', html: GATEWAY_ART }),
        el('div', { class: 'card-name', text: 'Gateway' }),
        el('div', { class: 'card-meta', text: gateway.meta }),
      ),
    );
    const zones: { kind: ZoneKind | 'none'; icon: IconName; meta: string }[] = [
      { kind: 'residential', icon: 'home', meta: 'Homes' },
      { kind: 'commercial', icon: 'shop', meta: 'Shops' },
      { kind: 'industrial', icon: 'factory', meta: 'Industry' },
      { kind: 'office', icon: 'office', meta: 'Offices' },
      { kind: 'none', icon: 'bulldoze', meta: 'Remove zoning' },
    ];
    for (const z of zones) {
      this.cards.append(
        el(
          'button',
          {
            class: 'card',
            dataset: { zone: z.kind },
            tip: `${ZONE_NAMES[z.kind]}: fill a block, drag along roads, or draw a shape`,
            attrs: { type: 'button', 'aria-label': ZONE_NAMES[z.kind] },
            on: {
              click: () => {
                s.zone.kind = z.kind;
                this.tools.setTool('zone');
                this.tools.settingsChanged();
                this.renderTrafficOptions();
                this.syncState();
              },
            },
          },
          el('div', { class: 'art picture', html: zoneArt(z.kind, z.kind === 'none' ? '#f06257' : ZONE_COLORS[z.kind]) }),
          el('div', { class: 'card-name', text: ZONE_NAMES[z.kind] }),
          el('div', { class: 'card-meta', text: z.meta }),
        ),
      );
    }
    this.renderTrafficOptions();
    this.syncState();
  }

  /** Zoning options when a zone tool is active, gateway options otherwise. */
  private renderTrafficOptions(): void {
    clear(this.options);
    const z = this.tools.settings.zone;
    if (this.tools.active.id !== 'zone') {
      this.options.append(
        el('div', { class: 'opt-title', text: 'Auto gateways' }),
        row('Dead ends', checkbox(this.ui.net.traffic.autoGateways, (v) => {
          this.ui.history.hint('Auto gateways');
          this.ui.net.setTraffic({ autoGateways: v });
        }), 'Treat every dead end with no endpoint as a gateway'),
        el('div', { class: 'opt-title', text: 'Pedestrians' }),
        row('Stop traffic', checkbox(this.ui.net.traffic.pedestriansStopTraffic !== false, (v) => {
          this.ui.history.hint('Pedestrians stop traffic');
          this.ui.net.setTraffic({ pedestriansStopTraffic: v });
        }), 'Pedestrians stop traffic at crosswalks. Off: they cross only in gaps, and traffic flows a little better'),
        el('div', { class: 'small muted', text: 'Pick a zone to zone land. Click an endpoint or region to edit it.' }),
      );
      return;
    }
    const changed = () => this.tools.settingsChanged();
    const modes = el('div', { class: 'opt-row' });
    const mode = (m: typeof z.mode, label: string, tip: string) =>
      modes.append(
        el('button', {
          class: `btn zone-mode ${z.mode === m ? 'primary' : ''}`,
          text: label,
          tip,
          attrs: { type: 'button' },
          dataset: { mode: m },
          on: {
            click: () => {
              z.mode = m;
              changed();
              this.renderTrafficOptions();
            },
          },
        }),
      );
    mode('block', 'Block', 'Click inside land enclosed by roads');
    mode('frontage', 'Frontage', 'Drag along roads, on the side to zone');
    mode('rect', 'Rectangle', 'Drag a rectangle. Corners snap to road edges');
    mode('polygon', 'Polygon', 'Click corners. Enter or the first corner finishes');
    const metres = (v: number) => `${v} m`;
    this.options.append(
      el('div', { class: 'opt-title', text: 'Mode' }),
      modes,
      z.kind === 'none'
        ? el('div', { class: 'small muted', text: 'Dezone removes zoning wherever it covers.' })
        : row('Density', selectInput([{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }], z.density, (v) => {
            z.density = v;
            changed();
          })),
      row('Depth', sliderInput(z.depth, { min: 8, max: 120, step: 4, format: metres }, (v) => {
        z.depth = v;
        changed();
      }), 'How deep a frontage strip reaches back from the road'),
      row('Setback', sliderInput(z.setback, { min: 0, max: 20, step: 1, format: metres }, (v) => {
        z.setback = v;
        changed();
      }), 'Gap kept from the road edge'),
      row('Snap to roads', checkbox(z.snap, (v) => {
        z.snap = v;
        changed();
      })),
      row('Snap distance', sliderInput(z.snapDistance, { min: 2, max: 30, step: 1, format: metres }, (v) => {
        z.snapDistance = v;
        changed();
      })),
      row('Skip highways', checkbox(z.excludeFast, (v) => {
        z.excludeFast = v;
        changed();
      }), 'Highways, ramps and rail cannot front a zone'),
    );
  }

  /** Reflect tool state in the buttons without rebuilding the tray. */
  private syncState(): void {
    const { tools } = this;
    const s = tools.settings;
    const active = tools.active.id;
    for (const [id, btn] of this.toolButtons) btn.classList.toggle('active', id === active);
    // The tray follows the tool: a hotkey that switches tool switches the tray too.
    const g = groupOf(active, s.drawMode);
    const modeId = modeOf(active, s.drawMode)?.id ?? '';
    if (this.tab !== null && this.tab !== 'intersections' && g && (g !== this.tab || (g === 'modify' && modeId !== this.renderedMode))) {
      this.tab = g;
      this.render();
    }
    for (const [id, btn] of this.tabs) {
      btn.classList.toggle('active', id === this.tab);
      btn.setAttribute('aria-selected', String(id === this.tab));
    }
    this.root.querySelectorAll<HTMLElement>('.mode-tab').forEach((b) => {
      const on = b.dataset.mode === modeId;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    for (const key of ['snapNodes', 'snapSegments', 'snapAngle', 'snapLength'] as const) {
      this.root.querySelector(`.snap-${key}`)?.classList.toggle('active', s[key]);
    }
    syncGridControls(this.root, this.ui);
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
      if (d.road) on = (active === 'road' || active === 'parallel') && s.roadType === d.road;
      if (d.template) on = active === 'template' && s.template.id === d.template;
      if (d.decal) on = active === 'paint' && s.paint.kind === d.decal;
      if (d.line) on = active === 'paint' && s.paint.kind === 'line' && s.paint.lineStyle === d.line;
      if (d.endpoint) on = active === 'traffic' && s.trafficKind === d.endpoint;
      if (d.zone) on = active === 'zone' && s.zone.kind === d.zone;
      if (d.tool) on = active === d.tool;
      if (d.control) return;
      card.classList.toggle('active', on);
    });
    this.root.querySelector<HTMLButtonElement>('.reset-lanes')?.toggleAttribute('disabled', tools.lanes.node === null);
    if (this.tab === 'junction') this.controlTray?.sync();
  }
}
