/** Floating inspectors for segments, junctions, endpoints and vehicles. */
import type { Id, LaneKind, LineStyle, MarkingStyle, PaintColor, SegmentOverrides, TrafficEndpoint, ZoneRegion } from '../core/types';
import { BUILTIN_ROAD_TYPES, effectiveLanes, effectiveMarkings, effectiveSpeedKmh, laneSpeedKmh } from '../core/roadTypes';
import { connectedRoad, connectedRoadOriented, mirroredLane } from '../tools/roadOps';
import { reverseMessages, reverseRoads, strandedMarks } from '../tools/ReverseTool';
import { syncZoneAccess, ZONE_NAMES, zoneStats } from '../tools/zoneOps';
import { ENDPOINT_NAMES } from '../tools/TrafficTool';
import type { InspectTarget } from '../tools/types';
import type { UiContext } from './context';
import { checkbox, clear, el, numberInput, row, selectInput, sliderInput, textInput, visualSelect, type VisualOption } from './dom';
import { JunctionEditor } from './JunctionEditor';
import { NodeMarkingPanel } from './NodeMarkingPanel';
import { Panel } from './Panel';
import { StationInspector, TrainInspector } from './RailPanels';
import { colorArt, crosswalkArt, lineStyleArt, surfaceArt } from './thumbnails';

const LINE_LABELS: Record<LineStyle, string> = {
  none: 'None',
  solid: 'Solid',
  dashed: 'Dashed',
  dotted: 'Dotted',
  double: 'Double',
  solidDashed: 'Solid, dashed',
  dashedSolid: 'Dashed, solid',
};
const LINE_OPTIONS: VisualOption<LineStyle>[] = (Object.keys(LINE_LABELS) as LineStyle[]).map((v) => ({
  value: v,
  label: LINE_LABELS[v],
  preview: lineStyleArt(v),
}));
const COLOR_OPTIONS: VisualOption<PaintColor>[] = (['white', 'yellow', 'blue', 'red', 'green'] as PaintColor[]).map((v) => ({
  value: v,
  label: v[0].toUpperCase() + v.slice(1),
  preview: colorArt(v),
}));
const CROSSWALK_OPTIONS: VisualOption<MarkingStyle['crosswalk']>[] = (['none', 'zebra', 'ladder', 'lines'] as const).map((v) => ({
  value: v,
  label: v[0].toUpperCase() + v.slice(1),
  preview: crosswalkArt(v),
}));
type Surface = NonNullable<SegmentOverrides['surface']>;
const SURFACE_LABELS: Record<Surface, string> = {
  asphalt: 'Asphalt',
  concrete: 'Concrete',
  darkAsphalt: 'Dark asphalt',
  red: 'Red surface',
  gravel: 'Gravel',
};
const SURFACE_OPTIONS: VisualOption<Surface>[] = (Object.keys(SURFACE_LABELS) as Surface[]).map((v) => ({
  value: v,
  label: SURFACE_LABELS[v],
  preview: surfaceArt(v),
}));
const LANE_KINDS: { value: LaneKind; label: string }[] = [
  { value: 'drive', label: 'General' },
  { value: 'bus', label: 'Bus only' },
  { value: 'bike', label: 'Bike only' },
];

/** One open inspector. */
abstract class Inspector {
  protected panel: Panel;

  constructor(protected readonly ui: UiContext, title: string, wide = false) {
    this.panel = new Panel(ui.host, title, { wide });
    this.panel.onClose = () => this.closed();
  }

  /** Called on network changes. Return false when the subject has gone. */
  abstract refresh(): boolean;
  /** A few times a second, for live values. */
  tick(): void {}
  protected closed(): void {
    this.ui.inspect(null);
  }

  close(): void {
    this.panel.onClose = null;
    this.panel.close();
    this.dispose();
  }

  protected dispose(): void {}

  /** True while the user is typing in or dragging a control in this panel. */
  protected get editing(): boolean {
    const a = document.activeElement;
    return !!a && this.panel.body.contains(a) && (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement);
  }
}

class SegmentInspector extends Inspector {
  private whole = false;

  constructor(ui: UiContext, private readonly id: Id) {
    super(ui, 'Road', true);
    this.render();
  }

  private targets(): Id[] {
    return this.whole ? connectedRoad(this.ui.net, this.id) : [this.id];
  }

  /** Apply a patch to this road or the whole road. */
  private patch(label: string, key: string, patch: (id: Id) => SegmentOverrides): void {
    const { net, history } = this.ui;
    history.hint(label, `${key}:${this.id}`);
    net.batch(() => {
      for (const id of this.targets()) net.setSegmentOverrides(id, patch(id));
    });
  }

  /**
   * Patch one lane along the road. Pieces drawn the other way number their lanes
   * from the other side, so the lane is matched by where it is.
   */
  private lanePatch(label: string, key: string, index: number, patch: (id: Id, lane: number) => SegmentOverrides): void {
    const { net, history } = this.ui;
    const pieces = this.whole ? connectedRoadOriented(net, this.id) : [{ id: this.id, flipped: false }];
    history.hint(label, `${key}:${this.id}:${index}`);
    net.batch(() => {
      for (const { id, flipped } of pieces) {
        const seg = net.getSegment(id)!;
        const lanes = effectiveLanes(net.roadTypeOf(id), seg.overrides);
        const lane = flipped ? mirroredLane(lanes, index) : index;
        if (lane >= 0) net.setSegmentOverrides(id, patch(id, lane));
      }
    });
  }

  private markingPatch(label: string, change: Partial<MarkingStyle>): void {
    const { net } = this.ui;
    this.patch(label, `mark-${Object.keys(change).join()}`, (id) => ({
      markings: { ...net.getSegment(id)!.overrides.markings, ...change },
    }));
    this.render();
  }

  private render(): void {
    const { net, history } = this.ui;
    const seg = net.getSegment(this.id);
    if (!seg) return;
    const def = net.roadTypeOf(this.id);
    const body = this.panel.body;
    const m = effectiveMarkings(def, seg.overrides);
    const geom = net.segmentGeom(this.id);
    clear(body);
    this.panel.setTitle(seg.overrides.name || def.name);
    const whole = connectedRoad(net, this.id).length;

    // Track only turns into other track, and road into road.
    const types = [...BUILTIN_ROAD_TYPES, ...net.project.customRoadTypes]
      .filter((t) => (t.category === 'rail') === (def.category === 'rail'))
      .map((t) => ({ value: t.id, label: t.name }));
    body.append(
      row('Name', textInput(seg.overrides.name ?? '', def.name, (v) => {
        this.patch('Rename road', 'name', () => ({ name: v || undefined }));
        this.panel.setTitle(v || def.name);
      })),
      row('Road type', selectInput(types, seg.roadType, (v) => {
        history.hint('Change road type');
        net.batch(() => {
          for (const id of this.targets()) net.setRoadType(id, v);
        });
        this.render();
      })),
      row('Speed limit', sliderInput(effectiveSpeedKmh(def, seg.overrides), { min: 10, max: 160, step: 5, format: (v) => `${v} km/h` }, (v) => {
        this.patch('Change speed limit', 'speed', () => ({ speedKmh: v === def.speedKmh ? undefined : v }));
      })),
      row('Surface', visualSelect(SURFACE_OPTIONS, seg.overrides.surface ?? 'asphalt', (v) => {
        this.patch('Change surface', 'surface', () => ({ surface: v === 'asphalt' ? undefined : v }));
        this.render();
      })),
      row(`Whole road (${whole})`, checkbox(this.whole, (v) => {
        this.whole = v;
        this.render();
      }), 'Apply changes along connected roads of this type'),
    );

    const line = (label: string, style: 'centerLine' | 'laneLine' | 'edgeLine', color: 'centerColor' | 'laneColor' | 'edgeColor') =>
      el(
        'div',
        { class: 'field', style: { gridTemplateColumns: '60px 1fr 1fr' } },
        el('span', { class: 'field-label', text: label }),
        visualSelect(LINE_OPTIONS, m[style], (v) => this.markingPatch('Change markings', { [style]: v })),
        visualSelect(COLOR_OPTIONS, m[color], (v) => this.markingPatch('Change markings', { [color]: v })),
      );
    body.append(
      el('div', { class: 'section-title', text: 'Markings' }),
      line('Centre', 'centerLine', 'centerColor'),
      line('Lanes', 'laneLine', 'laneColor'),
      line('Edges', 'edgeLine', 'edgeColor'),
      row('Crosswalk', visualSelect(CROSSWALK_OPTIONS, m.crosswalk, (v) => this.markingPatch('Change crosswalk', { crosswalk: v }))),
      row('Stop lines', checkbox(m.stopLines, (v) => this.markingPatch('Change markings', { stopLines: v }))),
      row('Turn arrows', checkbox(m.turnArrows, (v) => this.markingPatch('Change markings', { turnArrows: v }))),
    );

    const lanes = effectiveLanes(def, seg.overrides);
    const boundaries = el('div', {});
    for (let i = 0; i + 1 < lanes.length; i++) {
      if (lanes[i].dir !== lanes[i + 1].dir) continue;
      const current = m.boundaries?.[i];
      const setBoundary = (value: { style: LineStyle; color: PaintColor } | null) => {
        const next = { ...(m.boundaries ?? {}) };
        if (value) next[i] = value;
        else delete next[i];
        this.markingPatch('Change lane boundary', { boundaries: next });
      };
      boundaries.append(
        el(
          'div',
          { class: 'field', style: { gridTemplateColumns: '60px 1fr 1fr 24px' } },
          el('span', { class: 'field-label', text: `${i + 1} | ${i + 2}` }),
          visualSelect(LINE_OPTIONS, current?.style ?? m.laneLine, (v) => setBoundary({ style: v, color: current?.color ?? m.laneColor })),
          visualSelect(COLOR_OPTIONS, current?.color ?? m.laneColor, (v) => setBoundary({ style: current?.style ?? m.laneLine, color: v })),
          current ? el('button', { class: 'icon-btn', text: 'x', tip: 'Back to the lane line', attrs: { type: 'button' }, style: { minWidth: '22px', height: '22px', padding: '0' }, on: { click: () => setBoundary(null) } }) : el('span'),
        ),
      );
    }
    if (boundaries.children.length) {
      body.append(el('div', { class: 'section-title', text: 'Lane boundaries, left to right' }), boundaries);
    }

    const laneRows = el('div', {});
    lanes.forEach((lane, i) => {
      const own = seg.overrides.laneSpeeds?.[i];
      const speedBox = numberInput(laneSpeedKmh(def, seg.overrides, i), { min: 5, max: 160, step: 5 }, (v) => {
        if (!(v >= 5 && v <= 160)) return;
        this.lanePatch('Change lane speed', 'lanespeed', i, (id, lane2) => ({
          laneSpeeds: { ...net.getSegment(id)!.overrides.laneSpeeds, [lane2]: v },
        }));
      });
      laneRows.append(
        el(
          'div',
          { class: 'field', style: { gridTemplateColumns: '58px 1fr 62px 22px' } },
          el('span', { class: 'field-label', text: `Lane ${i + 1} ${lane.dir === 1 ? '\u2191' : '\u2193'}` }),
          selectInput(LANE_KINDS, lane.kind === 'rail' ? 'drive' : lane.kind, (v) => {
            this.lanePatch('Change lane use', 'lanekind', i, (id, lane2) => {
              const other = net.getSegment(id)!;
              const next = { ...(other.overrides.laneKinds ?? {}) };
              if (v === net.roadTypeOf(id).lanes[lane2]?.kind) delete next[lane2];
              else next[lane2] = v;
              return { laneKinds: Object.keys(next).length ? next : undefined };
            });
            this.render();
          }),
          speedBox,
          own === undefined
            ? el('span', { class: 'small muted', text: 'km/h', style: { fontSize: '10px' } })
            : el('button', {
                class: 'icon-btn',
                text: 'x',
                tip: 'Back to the road speed',
                attrs: { type: 'button' },
                style: { minWidth: '22px', height: '22px', padding: '0' },
                on: {
                  click: () => {
                    this.lanePatch('Change lane speed', 'lanespeed', i, (id, lane2) => {
                      const next = { ...(net.getSegment(id)!.overrides.laneSpeeds ?? {}) };
                      delete next[lane2];
                      return { laneSpeeds: Object.keys(next).length ? next : undefined };
                    });
                    this.render();
                  },
                },
              }),
        ),
      );
    });
    body.append(el('div', { class: 'section-title', text: 'Lanes: use and speed' }), laneRows);

    const reverse = el('button', {
      class: 'btn',
      text: 'Reverse direction',
      tip: 'Turn this road round, or the whole road if ticked above',
      attrs: { type: 'button' },
      on: {
        click: () => {
          const ids = this.targets();
          this.ui.history.hint('Reverse road');
          const reports = reverseRoads(net, ids);
          for (const m of reverseMessages(reports)) this.ui.toast(m.text, m.kind);
          this.ui.tools.setOverlayMarks('reverse-warning', strandedMarks(net, reports));
          this.render();
        },
      },
    });
    const reset = el('button', {
      class: 'btn',
      text: 'Reset to road defaults',
      attrs: { type: 'button' },
      on: {
        click: () => {
          this.patch('Reset road', 'reset', () => ({
            speedKmh: undefined,
            markings: undefined,
            surface: undefined,
            laneKinds: undefined,
            laneSpeeds: undefined,
          }));
          this.render();
        },
      },
    });
    const a = net.getNode(seg.a)!.pos;
    const b = net.getNode(seg.b)!.pos;
    const details = el('dl', { class: 'kv small' });
    const add = (k: string, v: string) => details.append(el('dt', { text: k }), el('dd', { text: v }));
    add('Length', `${(geom?.fullLength ?? 0).toFixed(1)} m`);
    add('Height', `${a.y.toFixed(1)} m to ${b.y.toFixed(1)} m`);
    if (geom && Number.isFinite(geom.minRadius)) add('Tightest radius', `${geom.minRadius.toFixed(0)} m`);
    this.liveTraffic = el('dd', { text: '' });
    details.append(el('dt', { text: 'Traffic' }), this.liveTraffic);
    body.append(el('div', { class: 'section-title', text: 'Details' }), details, el('div', { class: 'btn-row', style: { marginTop: '8px' } }, reverse, reset));
    this.tick();
  }

  private liveTraffic: HTMLElement | null = null;

  tick(): void {
    if (!this.liveTraffic || !this.ui.net.getSegment(this.id)) return;
    const t = this.ui.sim.segmentTraffic(this.id);
    this.liveTraffic.textContent = `${t.count} now, ${Math.round(t.flowPerHour)} per hour, ${Math.round(t.speedRatio * 100)}% speed`;
  }

  refresh(): boolean {
    if (!this.ui.net.getSegment(this.id)) return false;
    if (!this.editing) this.render();
    return true;
  }
}

class EndpointInspector extends Inspector {
  private readonly live = el('div', { class: 'small muted' });

  tick(): void {
    const s = this.ui.sim.endpointStats?.(this.id);
    this.live.textContent = s ? `Sent ${s.spawned}, received ${s.arrived}, heading here ${s.destined}, waiting ${s.queued}.` : 'No traffic yet.';
  }

  constructor(ui: UiContext, private readonly id: Id) {
    super(ui, 'Traffic endpoint');
    this.render();
  }

  private get ep(): TrafficEndpoint | undefined {
    return this.ui.net.endpoints.find((e) => e.id === this.id);
  }

  private update(label: string, patch: Partial<TrafficEndpoint>): void {
    this.ui.history.hint(label, `ep-${Object.keys(patch).join()}-${this.id}`);
    this.ui.net.updateEndpoint(this.id, patch);
  }

  private render(): void {
    const ep = this.ep;
    if (!ep) return;
    const body = this.panel.body;
    clear(body);
    this.panel.setTitle(ep.name || ENDPOINT_NAMES[ep.kind]);
    const mixRow = (key: keyof TrafficEndpoint['mix'], label: string) =>
      row(label, sliderInput(ep.mix[key], { min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` }, (v) => {
        const current = this.ep;
        if (current) this.update('Change vehicle mix', { mix: { ...current.mix, [key]: v } });
      }));
    body.append(
      row('Name', textInput(ep.name, ENDPOINT_NAMES[ep.kind], (v) => this.update('Rename endpoint', { name: v }))),
      row('Kind', selectInput((Object.keys(ENDPOINT_NAMES) as TrafficEndpoint['kind'][]).filter((k) => (ep.nodeId !== null) === (k === 'gateway')).map((k) => ({ value: k, label: ENDPOINT_NAMES[k] })), ep.kind, (v) => {
        this.update('Change endpoint', { kind: v });
        this.render();
      })),
      row('Enabled', checkbox(ep.enabled, (v) => this.update('Toggle endpoint', { enabled: v }))),
      row('Vehicles per hour', numberInput(ep.ratePerHour, { min: 0, max: 20000, step: 10 }, (v) => this.update('Change rate', { ratePerHour: Math.max(0, v) }))),
      row('Attraction', sliderInput(ep.attraction, { min: 0, max: 10, step: 0.1 }, (v) => this.update('Change attraction', { attraction: v }))),
      el('div', { class: 'section-title', text: 'Vehicle mix' }),
      mixRow('car', 'Cars'),
      mixRow('van', 'Vans'),
      mixRow('truck', 'Trucks'),
      mixRow('bus', 'Buses'),
      el('div', { class: 'section-title', text: 'Live' }),
      this.live,
      el('div', { class: 'btn-row', style: { marginTop: '8px' } }, el('button', {
        class: 'btn danger',
        text: 'Remove endpoint',
        attrs: { type: 'button' },
        on: {
          click: () => {
            this.ui.history.hint('Remove endpoint');
            this.ui.net.removeEndpoint(this.id);
          },
        },
      })),
    );
  }

  refresh(): boolean {
    if (!this.ep) return false;
    if (!this.editing) this.render();
    return true;
  }
}

class VehicleInspector extends Inspector {
  private readonly fields = el('dl', { class: 'kv' });
  private following = false;
  private readonly followBtn: HTMLButtonElement;
  private gone = false;

  constructor(ui: UiContext, private readonly id: number) {
    super(ui, `Vehicle ${id}`);
    this.followBtn = el('button', {
      class: 'btn',
      text: 'Follow',
      attrs: { type: 'button' },
      on: {
        click: () => {
          this.following = !this.following;
          ui.renderer.follow(this.following ? this.id : null);
          this.followBtn.textContent = this.following ? 'Stop following' : 'Follow';
        },
      },
    });
    this.panel.body.append(this.fields, el('div', { class: 'btn-row', style: { marginTop: '8px' } }, this.followBtn));
    this.tick();
  }

  tick(): void {
    if (this.gone) return;
    const { sim, tools } = this.ui;
    const d = sim.vehicleDetail(this.id);
    if (!d) {
      this.gone = true;
      clear(this.fields);
      this.fields.append(el('dt', { text: 'Status' }), el('dd', { text: 'Reached its destination or left' }));
      this.followBtn.disabled = true;
      tools.setOverlayMarks('vehicle-route', []);
      this.ui.renderer.follow(null);
      return;
    }
    clear(this.fields);
    const add = (k: string, v: string) => this.fields.append(el('dt', { text: k }), el('dd', { text: v }));
    add('Type', d.type);
    add('Speed', `${Math.round(d.speedKmh)} km/h`);
    add('From', d.from);
    add('To', d.to);
    add('Age', `${Math.round(d.ageSec)} s`);
    tools.setOverlayMarks('vehicle-route', d.route.length > 1 ? [{ kind: 'line', points: d.route, color: '#7fd8ff', width: 1 }] : []);
  }

  refresh(): boolean {
    return true;
  }

  protected dispose(): void {
    this.ui.tools.setOverlayMarks('vehicle-route', []);
    this.ui.renderer.follow(null);
  }

  protected closed(): void {
    this.dispose();
    super.closed();
  }
}

class ZoneInspector extends Inspector {
  private readonly live = el('dl', { class: 'kv small' });

  constructor(ui: UiContext, private readonly id: Id) {
    super(ui, 'Zone');
    this.render();
  }

  private get region(): ZoneRegion | undefined {
    return this.ui.net.project.zones?.find((z) => z.id === this.id);
  }

  /** Edit and refit access, as one undo step. */
  private edit(label: string, patch: Partial<ZoneRegion>, key: string): void {
    const { net, history } = this.ui;
    history.hint(label, `zone-${key}-${this.id}`);
    net.batch(() => {
      net.updateZone(this.id, patch);
      syncZoneAccess(net, this.id);
    });
  }

  private render(): void {
    const region = this.region;
    if (!region || region.kind === 'none') return;
    const body = this.panel.body;
    clear(body);
    this.panel.setTitle(region.name || `${ZONE_NAMES[region.kind]} zone`);
    const kinds = (['residential', 'commercial', 'industrial', 'office'] as const).map((k) => ({ value: k, label: ZONE_NAMES[k] }));
    body.append(
      row('Name', textInput(region.name, `${ZONE_NAMES[region.kind]} zone`, (v) => this.edit('Rename zone', { name: v }, 'name'))),
      row('Kind', selectInput(kinds, region.kind, (v) => {
        this.edit('Change zone', { kind: v }, 'kind');
        this.render();
      })),
      row('Density', selectInput([{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }], region.density, (v) => {
        this.edit('Change density', { density: v }, 'density');
        this.render();
      })),
      row('Enabled', checkbox(region.enabled, (v) => this.edit('Toggle zone', { enabled: v }, 'enabled'))),
      el('div', { class: 'section-title', text: 'Traffic' }),
      this.live,
      el('div', { class: 'btn-row', style: { marginTop: '8px' } }, el('button', {
        class: 'btn danger',
        text: 'Remove zone',
        attrs: { type: 'button' },
        on: {
          click: () => {
            this.ui.history.hint('Remove zone');
            this.ui.net.removeZone(this.id);
          },
        },
      })),
    );
    this.tick();
  }

  tick(): void {
    const region = this.region;
    if (!region) return;
    const { net, sim } = this.ui;
    const stats = zoneStats(net, this.id);
    let spawned = 0;
    let arrived = 0;
    for (const e of net.endpoints) {
      if (e.regionId !== this.id) continue;
      const s = sim.endpointStats?.(e.id);
      if (s) {
        spawned += s.spawned;
        arrived += s.arrived;
      }
    }
    clear(this.live);
    const add = (k: string, v: string) => this.live.append(el('dt', { text: k }), el('dd', { text: v }));
    add('Zoned area', `${Math.round(stats.area).toLocaleString()} m\u00b2`);
    add('Generates', `${stats.ratePerHour} vehicles/h`);
    add('Attraction', stats.attraction.toFixed(1));
    add('Access points', stats.access ? String(stats.access) : 'None: no road to reach it');
    add('Sent, received', `${spawned}, ${arrived}`);
  }

  refresh(): boolean {
    if (!this.region) return false;
    if (!this.editing) this.render();
    return true;
  }
}

class NodeMarkingInspector extends Inspector {
  private readonly content: NodeMarkingPanel;
  private readonly off: () => void;

  constructor(ui: UiContext, private readonly id: Id) {
    super(ui, 'Node markings');
    this.content = new NodeMarkingPanel(ui, id, this.panel);
    this.off = ui.tools.onChange(() => this.content.sync());
  }

  refresh(): boolean {
    if (!this.ui.net.getNode(this.id)) return false;
    if (!this.editing) this.content.sync();
    return true;
  }

  protected dispose(): void {
    this.off();
  }

  protected closed(): void {
    this.dispose();
    if (this.ui.tools.active.id === 'nodeMarkings') this.ui.tools.setTool('select');
    super.closed();
  }
}

class JunctionInspector extends Inspector {
  private readonly editor: JunctionEditor;

  constructor(ui: UiContext, private readonly id: Id) {
    super(ui, 'Junction', true);
    this.editor = new JunctionEditor(ui, id, this.panel);
    this.editor.render();
  }

  tick(): void {
    this.editor.tick();
  }

  refresh(): boolean {
    if (!this.ui.net.getNode(this.id)) return false;
    if (!this.editing) this.editor.render();
    return true;
  }
}

/** Keeps at most one inspector open, and follows the network. */
export class Inspectors {
  private current: Inspector | null = null;
  private target: InspectTarget | null = null;

  constructor(private readonly ui: UiContext) {
    ui.net.onChange(() => this.networkChanged());
  }

  open(target: InspectTarget | null): void {
    if (target && this.target && target.kind === this.target.kind && target.id === this.target.id) return;
    this.current?.close();
    this.current = null;
    this.target = target;
    if (!target) return;
    switch (target.kind) {
      case 'segment':
        this.current = new SegmentInspector(this.ui, target.id);
        break;
      case 'junction':
        this.current = new JunctionInspector(this.ui, target.id);
        break;
      case 'endpoint':
        this.current = new EndpointInspector(this.ui, target.id);
        break;
      case 'vehicle':
        this.current = new VehicleInspector(this.ui, target.id);
        break;
      case 'train':
        this.current = new TrainInspector(this.ui, target.id) as unknown as Inspector;
        break;
      case 'station':
        this.current = new StationInspector(this.ui, target.id) as unknown as Inspector;
        break;
      case 'nodeMarkings':
        this.current = new NodeMarkingInspector(this.ui, target.id);
        break;
      case 'zone':
        this.current = new ZoneInspector(this.ui, target.id);
        break;
    }
  }

  private networkChanged(): void {
    if (this.current && !this.current.refresh()) this.open(null);
  }

  tick(): void {
    this.current?.tick();
  }
}

