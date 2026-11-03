/**
 * Rail UI: the Trains tab tray, the Lines panel, and the train and station
 * inspectors. Everything reads the train sim through UiContext.rail.
 */
import { TRAIN_TYPES, trainLength } from '../rail/consists';
import { segmentElectrification, stationLayout, type PlatformLayout, type TrainTypeId } from '../core/railTypes';
import { BUILTIN_ROAD_TYPES } from '../core/roadTypes';
import { connectedTrack, setElectrification } from '../tools/RailTools';
import type { Id } from '../core/types';
import type { UiContext } from './context';
import { checkbox, clear, el, numberInput, row, selectInput, sliderInput, textInput } from './dom';
import { ICONS } from './icons';
import { Panel } from './Panel';

const TYPE_OPTIONS = (Object.keys(TRAIN_TYPES) as TrainTypeId[]).map((id) => ({ value: id, label: TRAIN_TYPES[id].name }));

function fmtTime(sec: number): string {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

/** Station and line cards and their options, after the track cards. */
export function renderRailTray(ui: UiContext, options: HTMLElement, cards: HTMLElement): void {
  const { tools } = ui;
  const card = (tool: 'station' | 'line', icon: string, name: string, meta: string) =>
    el(
      'button',
      {
        class: 'card',
        dataset: { tool },
        tip: name,
        attrs: { type: 'button', 'aria-label': name },
        on: { click: () => tools.setTool(tool) },
      },
      el('div', { class: 'art', html: icon }),
      el('div', { class: 'card-name', text: name }),
      el('div', { class: 'card-meta', text: meta }),
    );
  const wires = (on: boolean) => {
    const active = tools.active.id === 'electrify' && tools.electrify.electrify === on;
    return el(
      'button',
      {
        class: `card ${active ? 'active' : ''}`,
        tip: on ? 'Put up overhead wires (third rail on metro). Click or drag along track' : 'Take wires down: diesel territory. Click or drag along track',
        keyHint: 'O',
        attrs: { type: 'button', 'aria-label': on ? 'Electrify' : 'De-electrify' },
        on: {
          click: () => {
            tools.electrify.electrify = on;
            tools.setTool('electrify');
            tools.settingsChanged();
            cards.querySelectorAll('.wires-card').forEach((c) => c.classList.toggle('active', (c as HTMLElement).dataset.on === String(on)));
          },
        },
        dataset: { on: String(on) },
      },
      el('div', { class: 'art', html: on ? ICONS.wires : ICONS.noWires }),
      el('div', { class: 'card-name', text: on ? 'Electrify' : 'De-electrify' }),
      el('div', { class: 'card-meta', text: on ? 'Wires up' : 'Diesel only' }),
    );
  };
  const up = wires(true);
  const down = wires(false);
  up.classList.add('wires-card');
  down.classList.add('wires-card');
  cards.append(
    card('station', ICONS.station, 'Station', 'Platform on track'),
    card('line', ICONS.trainLine, 'Line', 'Click stations in order'),
    up,
    down,
    el(
      'button',
      { class: 'card', tip: 'Every line with its trains and stats', attrs: { type: 'button', 'aria-label': 'Lines' }, on: { click: () => ui.rail?.openLines() } },
      el('div', { class: 'art', html: ICONS.train }),
      el('div', { class: 'card-name', text: 'Lines' }),
      el('div', { class: 'card-meta', text: `${ui.net.rail.lines.length} lines` }),
    ),
  );
  const station = tools.station;
  const line = tools.line;
  const rerender = () => {
    tools.settingsChanged();
  };
  options.append(
    el('div', { class: 'opt-title', text: 'Station platform' }),
    sliderInput(station.platformLength, { min: 80, max: 450, step: 10, format: (v) => `${v} m` }, (v) => {
      station.platformLength = v;
      rerender();
    }),
    selectInput(
      [
        { value: 'auto', label: 'Level from track height' },
        { value: 'surface', label: 'Surface' },
        { value: 'elevated', label: 'Elevated' },
        { value: 'underground', label: 'Subway' },
        { value: 'gateway', label: 'Freight gateway' },
      ],
      station.kind,
      (v) => {
        station.kind = v as typeof station.kind;
        rerender();
      },
    ),
    selectInput(
      [
        { value: 'side', label: 'Side platform, side under cursor' },
        { value: 'both', label: 'Platforms both sides' },
        { value: 'island', label: 'Island between the tracks' },
      ],
      station.layout,
      (v) => {
        station.layout = v as typeof station.layout;
        rerender();
      },
    ),
    row('Building', checkbox(station.building, (v) => {
      station.building = v;
      rerender();
    }), 'A station building beside the platforms. [ puts it on the other side'),
    el('div', { class: 'opt-title', text: 'New line' }),
    selectInput([{ value: 'auto', label: 'Train to suit track' }, ...TYPE_OPTIONS], line.trainType, (v) => {
      line.trainType = v as TrainTypeId | 'auto';
      line.cars = 0;
      rerender();
    }),
    row('Cars', numberInput(line.cars, { min: 0, max: 124, step: 1 }, (v) => {
      line.cars = Math.max(0, Math.round(v));
      rerender();
    }), '0 uses the train type default'),
    row('Trains', numberInput(line.trains, { min: 1, max: 30, step: 1 }, (v) => {
      line.trains = Math.max(1, Math.round(v));
      rerender();
    })),
    el('div', { class: 'opt-title', text: 'Wires' }),
    row('Whole line', checkbox(tools.electrify.wholeLine, (v) => {
      tools.electrify.wholeLine = v;
      rerender();
    }), 'Electrify or clear all track joined end to end, not just one piece. Shift+O does the same from any tool'),
    el('div', { class: 'small muted', text: 'O over track toggles its wires.' }),
    el('button', { class: 'btn', text: 'Rail demo', tip: 'Replace the map with a sample railway', attrs: { type: 'button' }, on: { click: () => ui.rail?.loadDemo() } }),
  );
}

/** Every line, its fleet and stats, with show, hide and edits. */
export class LinesPanel {
  private panel: Panel | null = null;
  private key = '';

  constructor(private readonly ui: UiContext) {
    ui.net.onChange((e) => {
      if (e.railChanged || e.reset) this.render(true);
    });
  }

  get isOpen(): boolean {
    return this.panel !== null;
  }

  toggle(): void {
    if (this.panel) {
      this.panel.close();
      return;
    }
    this.panel = new Panel(this.ui.host, 'Train lines', { wide: true, left: 64, top: 70 });
    this.panel.onClose = () => (this.panel = null);
    this.render(true);
  }

  tick(): void {
    this.render(false);
  }

  private render(force: boolean): void {
    const p = this.panel;
    const rail = this.ui.rail;
    if (!p || !rail) return;
    const { net, history } = this.ui;
    const trains = rail.trains;
    const infos = net.rail.lines.map((l) => trains.lineInfo(l.id)!).filter(Boolean);
    const key = JSON.stringify(infos.map((i) => [i.id, i.running, Math.round(i.carried / 10), Math.round(i.onTimePct), i.problem, i.warning])) + JSON.stringify(net.rail.lines);
    if (!force && key === this.key) return;
    if (!force && p.body.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) return;
    this.key = key;
    const body = p.body;
    clear(body);
    const s = trains.stats();
    body.append(
      el('dl', { class: 'kv' },
        el('dt', { text: 'Trains running' }), el('dd', { text: `${s.trains} (${s.cars} vehicles)` }),
        el('dt', { text: 'Passengers' }), el('dd', { text: `${s.carried.toLocaleString()} carried, ${s.onBoard} on board` }),
        el('dt', { text: 'On time' }), el('dd', { text: `${Math.round(s.onTimePct)}%` }),
      ),
      row('Line colours', checkbox(rail.layer.lineOverlayOn, (v) => rail.layer.setLineOverlay(v)), 'Show each line in its colour over the track'),
    );
    if (!net.rail.lines.length) {
      body.append(el('div', { class: 'small muted', text: 'No lines yet. Place stations, then use the Line tool and click them in order.' }));
      return;
    }
    for (const line of net.rail.lines) {
      const info = trains.lineInfo(line.id);
      if (!info) continue;
      const stops = line.stops.map((id) => net.rail.stations.find((st) => st.id === id)?.name ?? '?').join(' – ');
      const edit = (label: string, patch: Parameters<typeof net.updateLine>[1]) => {
        history.hint(label, `line-${line.id}`);
        net.updateLine(line.id, patch);
      };
      const swatch = el('input', { attrs: { type: 'color', value: line.color, 'aria-label': 'Line colour' }, style: { width: '28px', height: '22px', padding: '0', border: 'none', background: 'none' } });
      swatch.addEventListener('change', () => edit('Line colour', { color: swatch.value }));
      body.append(
        el('div', { class: 'section-title', style: { display: 'flex', gap: '6px', alignItems: 'center' } }, swatch, el('span', { text: line.name })),
        el('div', { class: 'small muted', text: stops }),
        el('dl', { class: 'kv' },
          el('dt', { text: 'Trains' }), el('dd', { text: `${info.running} of ${info.wanted} running` }),
          el('dt', { text: 'Train' }), el('dd', { text: `${TRAIN_TYPES[line.trainType].name}, ${line.cars} cars, ${Math.round(info.trainLength)} m` }),
          el('dt', { text: 'Round trip' }), el('dd', { text: `${info.lengthKm.toFixed(1)} km, ${fmtTime(info.cycleSec)}` }),
          el('dt', { text: line.trainType === 'freight' ? 'Trips' : 'Passengers' }), el('dd', { text: line.trainType === 'freight' ? '' : info.carried.toLocaleString() }),
          el('dt', { text: 'On time' }), el('dd', { text: `${Math.round(info.onTimePct)}%` }),
        ),
      );
      if (info.problem) body.append(el('div', { class: 'small', style: { color: '#ff7a6b' }, text: info.problem }));
      if (info.fixType) {
        const fix = info.fixType;
        body.append(el('div', { class: 'btn-row' }, el('button', {
          class: 'btn primary',
          text: `Switch to ${TRAIN_TYPES[fix].name}`,
          tip: 'A diesel runs on track with or without wires',
          attrs: { type: 'button' },
          on: { click: () => edit('Switch to diesel', { trainType: fix, cars: TRAIN_TYPES[fix].defaultCars }) },
        })));
      }
      else if (info.warning) body.append(el('div', { class: 'small', style: { color: '#ffc857' }, text: info.warning }));
      body.append(
        row('Name', textInput(line.name, 'Line name', (v) => edit('Rename line', { name: v || line.name }))),
        row('Train', selectInput(TYPE_OPTIONS, line.trainType, (v) => edit('Change train', { trainType: v, cars: TRAIN_TYPES[v].defaultCars }))),
        row('Cars', numberInput(line.cars, { min: TRAIN_TYPES[line.trainType].minCars, max: TRAIN_TYPES[line.trainType].maxCars, step: 1 }, (v) => edit('Change cars', { cars: Math.round(v) }))),
        row('Trains', numberInput(line.trains, { min: 0, max: 30, step: 1 }, (v) => edit('Change fleet', { trains: Math.max(0, Math.round(v)) }))),
        row('Show', checkbox(!line.hidden, (v) => edit(v ? 'Show line' : 'Hide line', { hidden: v ? undefined : true })), 'Hidden lines keep running but leave the colour overlay'),
        el('div', { class: 'btn-row' }, el('button', {
          class: 'btn danger',
          text: 'Delete line',
          attrs: { type: 'button' },
          on: {
            click: () => {
              history.hint('Delete line');
              net.removeLine(line.id);
            },
          },
        })),
      );
    }
  }
}

/** Clicked train: what it is, where it is going, and Follow. */
export class TrainInspector {
  private panel: Panel;
  private fields = el('dl', { class: 'kv' });
  private followBtn: HTMLButtonElement;
  private gone = false;

  constructor(private readonly ui: UiContext, private readonly id: number) {
    this.panel = new Panel(ui.host, `Train ${id}`);
    this.panel.onClose = () => {
      this.dispose();
      ui.inspect(null);
    };
    this.followBtn = el('button', {
      class: 'btn',
      text: 'Follow',
      attrs: { type: 'button' },
      on: {
        click: () => {
          const layer = this.ui.rail?.layer;
          if (!layer) return;
          layer.following = layer.following === this.id ? null : this.id;
          if (layer.following !== null) this.ui.renderer.setCamera({ distance: 260, pitch: 0.42 }, true);
          this.followBtn.textContent = layer.following === this.id ? 'Stop following' : 'Follow';
        },
      },
    });
    this.panel.body.append(this.fields, el('div', { class: 'btn-row', style: { marginTop: '8px' } }, this.followBtn));
    this.tick();
  }

  tick(): void {
    if (this.gone) return;
    const d = this.ui.rail?.trains.trainDetail(this.id);
    if (!d) {
      this.gone = true;
      clear(this.fields);
      this.fields.append(el('dt', { text: 'Status' }), el('dd', { text: 'Left service' }));
      this.followBtn.disabled = true;
      this.dispose();
      return;
    }
    this.panel.setTitle(`${d.line}: ${d.type}`);
    clear(this.fields);
    const add = (k: string, v: string) => this.fields.append(el('dt', { text: k }), el('dd', { text: v }));
    add('Status', d.status);
    add('Speed', `${Math.round(d.speedKmh)} of ${d.maxKmh} km/h`);
    add('Next stop', d.next || 'None');
    add('Consist', `${d.cars} vehicles, ${Math.round(d.lengthM)} m`);
    add('Mass', `${Math.round(d.massT).toLocaleString()} t`);
    add('Grade', `${d.gradePct >= 0 ? '+' : ''}${d.gradePct.toFixed(1)}%`);
    if (d.seats) add('On board', `${d.passengers} of ${d.seats}`);
    this.ui.tools.setOverlayMarks('train-route', d.route.length > 1 ? [{ kind: 'line', points: d.route.map((p) => ({ ...p, y: p.y + 1 })), color: d.color, width: 1.5 }] : []);
  }

  refresh(): boolean {
    return true;
  }

  close(): void {
    this.panel.onClose = null;
    this.panel.close();
    this.dispose();
  }

  private dispose(): void {
    this.ui.tools.setOverlayMarks('train-route', []);
    const layer = this.ui.rail?.layer;
    if (layer && layer.following === this.id) layer.following = null;
  }
}

/** Clicked station: name, kind, platform, and the lines that call. */
export class StationInspector {
  private panel: Panel;

  constructor(private readonly ui: UiContext, private readonly id: Id) {
    this.panel = new Panel(ui.host, 'Station');
    this.panel.onClose = () => ui.inspect(null);
    this.render();
  }

  private render(): void {
    const { net, history } = this.ui;
    const st = net.rail.stations.find((s) => s.id === this.id);
    if (!st) return;
    this.panel.setTitle(st.name);
    const body = this.panel.body;
    clear(body);
    const lines = net.rail.lines.filter((l) => l.stops.includes(st.id));
    const longest = Math.max(0, ...lines.map((l) => trainLength(l.trainType, l.cars)));
    body.append(
      row('Name', textInput(st.name, 'Station name', (v) => {
        history.hint('Rename station', `station-${st.id}`);
        net.updateStation(st.id, { name: v || st.name });
      })),
      row('Kind', selectInput([
        { value: 'surface', label: 'Surface' },
        { value: 'elevated', label: 'Elevated' },
        { value: 'underground', label: 'Subway' },
        { value: 'gateway', label: 'Freight gateway' },
      ], st.kind, (v) => {
        history.hint('Change station');
        net.updateStation(st.id, { kind: v });
      })),
    );
    if (st.kind !== 'gateway') {
      const seg = net.getSegment(st.segmentId);
      const def = seg ? net.roadTypeOf(st.segmentId) : null;
      const layouts = [
        { value: 'left', label: 'Side platform, left' },
        { value: 'right', label: 'Side platform, right' },
        { value: 'both', label: 'Both sides' },
        ...(def && def.lanes.length === 2 && Math.abs(def.lanes[0].offset) > 0.5 ? [{ value: 'island', label: 'Island' }] : []),
      ] as { value: PlatformLayout; label: string }[];
      body.append(
        row('Platforms', selectInput(layouts, def ? stationLayout(st, def) : 'right', (v) => {
          history.hint('Change platforms');
          net.updateStation(st.id, { layout: v });
        })),
        row('Building', selectInput([
          { value: 'none', label: 'None' },
          { value: 'left', label: 'On the left' },
          { value: 'right', label: 'On the right' },
        ], st.building ?? 'none', (v) => {
          history.hint('Change station building');
          net.updateStation(st.id, { building: v === 'none' ? undefined : v });
        })),
      );
      body.append(row('Platform', sliderInput(st.platformLength, { min: 80, max: 450, step: 10, format: (v) => `${v} m` }, (v) => {
        history.hint('Platform length', `platform-${st.id}`);
        net.updateStation(st.id, { platformLength: v });
      })));
      if (longest > st.platformLength + 1) {
        body.append(el('div', { class: 'small', style: { color: '#ffc857' }, text: `The longest train calling is ${Math.round(longest)} m, longer than the platform.` }));
      }
    }
    body.append(
      el('div', { class: 'section-title', text: 'Lines' }),
      el('div', { class: 'small muted', text: lines.length ? lines.map((l) => l.name).join(', ') : 'No line calls here yet' }),
      el('div', { class: 'btn-row', style: { marginTop: '8px' } }, el('button', {
        class: 'btn danger',
        text: 'Remove station',
        attrs: { type: 'button' },
        on: {
          click: () => {
            history.hint('Remove station');
            net.removeStation(st.id);
          },
        },
      })),
    );
  }

  tick(): void {}

  refresh(): boolean {
    if (!this.ui.net.rail.stations.some((s) => s.id === this.id)) return false;
    const a = document.activeElement;
    if (!(a instanceof HTMLInputElement && this.panel.body.contains(a))) this.render();
    return true;
  }

  close(): void {
    this.panel.onClose = null;
    this.panel.close();
  }
}

/** Clicked track: its power, with buttons, and the basics. */
export class RailSegmentInspector {
  private panel: Panel;
  private whole = false;

  constructor(private readonly ui: UiContext, private readonly id: Id) {
    this.panel = new Panel(ui.host, 'Track', { wide: true });
    this.panel.onClose = () => ui.inspect(null);
    this.render();
  }

  private targets(): Id[] {
    return this.whole ? connectedTrack(this.ui.net, this.id) : [this.id];
  }

  private render(): void {
    const { net, history } = this.ui;
    const seg = net.getSegment(this.id);
    if (!seg) return;
    const def = net.roadTypeOf(this.id);
    const power = segmentElectrification(def, seg.overrides);
    this.panel.setTitle(seg.overrides.name || def.name);
    const body = this.panel.body;
    clear(body);
    const types = BUILTIN_ROAD_TYPES.filter((t) => t.category === 'rail').map((t) => ({ value: t.id, label: t.name }));
    const setPower = (on: boolean) => {
      history.hint(on ? 'Electrify track' : 'Remove overhead wires');
      setElectrification(net, this.targets(), on);
      this.render();
    };
    const metro = def.id.startsWith('metro');
    const btn = (label: string, active: boolean, on: boolean) =>
      el('button', { class: `btn ${active ? 'primary' : ''}`, text: label, attrs: { type: 'button', 'aria-pressed': String(active) }, on: { click: () => setPower(on) } });
    body.append(
      row('Track', selectInput(types, seg.roadType, (v) => {
        history.hint('Change track type');
        net.batch(() => {
          for (const id of this.targets()) net.setRoadType(id, v);
        });
        this.render();
      })),
      row('Power', el('div', { class: 'btn-row' },
        btn(metro ? 'Third rail' : 'Overhead wires', power !== 'none', true),
        btn('None (diesel)', power === 'none', false),
      ), 'Electric trains need it; diesels run either way. O over track toggles it'),
      row(`Whole line (${connectedTrack(net, this.id).length})`, checkbox(this.whole, (v) => {
        this.whole = v;
        this.render();
      }), 'Apply to all track joined end to end with this piece'),
      row('Speed limit', sliderInput(seg.overrides.speedKmh ?? def.speedKmh, { min: 20, max: def.speedKmh >= 300 ? 320 : 200, step: 10, format: (v) => `${v} km/h` }, (v) => {
        history.hint('Change speed limit', `speed:${this.id}`);
        net.batch(() => {
          for (const id of this.targets()) net.setSegmentOverrides(id, { speedKmh: v === def.speedKmh ? undefined : v });
        });
      })),
    );
    const geom = net.segmentGeom(this.id);
    const lines = net.rail.lines.filter((l) => l.stops.some((s) => net.rail.stations.find((st) => st.id === s)?.segmentId === this.id));
    body.append(
      el('dl', { class: 'kv' },
        el('dt', { text: 'Length' }), el('dd', { text: `${Math.round(geom?.length ?? 0)} m` }),
        el('dt', { text: 'Power' }), el('dd', { text: power === 'overhead' ? 'Overhead wires' : power === 'thirdRail' ? 'Third rail' : 'None: diesel only' }),
        el('dt', { text: 'Stations here' }), el('dd', { text: lines.length ? lines.map((l) => l.name).join(', ') : 'None' }),
      ),
      el('div', { class: 'btn-row', style: { marginTop: '8px' } }, el('button', {
        class: 'btn danger',
        text: 'Bulldoze',
        attrs: { type: 'button' },
        on: {
          click: () => {
            history.hint('Bulldoze track');
            net.removeSegment(this.id);
          },
        },
      })),
    );
  }

  tick(): void {}

  refresh(): boolean {
    if (!this.ui.net.getSegment(this.id)) return false;
    const a = document.activeElement;
    if (!(a instanceof HTMLInputElement && this.panel.body.contains(a))) this.render();
    return true;
  }

  close(): void {
    this.panel.onClose = null;
    this.panel.close();
  }
}
