/** Builds the interface and runs its periodic updates. */
import { CursorHudView, installTooltips, Toasts } from './Feedback';
import { InfoBar } from './InfoBar';
import { Inspectors } from './Inspectors';
import { Menu } from './Menu';
import { openRoadDesigner } from './RoadDesigner';
import { StatsPanel } from './StatsPanel';
import { Toolbar } from './Toolbar';
import { TopBar } from './TopBar';
import { bindInput } from './Input';
import { bindings, type KeyApp } from './keymap';
import { Palette, type PaletteCommand } from './Palette';
import { ShortcutPanel, type ShortcutState } from './ShortcutPanel';
import { toggleGridSnap } from './GridControls';
import { BUILTIN_ROAD_TYPES } from '../core/roadTypes';
import { CONTROL_CARDS } from '../tools/junctionControl';
import type { TabId } from './Toolbar';
import { GROUPS } from './toolGroups';
import type { AppActions, UiContext } from './context';
import './style.css';

export interface UiOptions extends Omit<UiContext, 'host' | 'dock' | 'toast' | 'inspect' | 'openDesigner' | 'openStats' | 'actions'> {
  root: HTMLElement;
  actions: AppActions;
}

/** Live panels update at this rate. */
const TICK_SEC = 0.25;

export class UI {
  readonly context: UiContext;
  readonly toolbar: Toolbar;
  readonly topbar: TopBar;
  readonly infobar: InfoBar;
  readonly menu: Menu;
  readonly stats: StatsPanel;
  readonly inspectors: Inspectors;
  readonly palette: Palette;
  readonly shortcuts: ShortcutPanel;
  private readonly toasts: Toasts;
  private elapsed = 0;

  constructor(options: UiOptions) {
    const host = document.createElement('div');
    host.id = 'ui';
    options.root.append(host);
    const dock = document.createElement('div');
    dock.className = 'dock';
    host.append(dock);
    this.toasts = new Toasts(host);
    const context: UiContext = {
      ...options,
      host,
      dock,
      toast: (message, kind) => this.toasts.show(message, kind),
      inspect: (target) => {
        // The Markings tool shows a junction's or road's markings in its own side panel.
        if (target && (target.kind === 'nodeMarkings' || target.kind === 'segmentMarkings') && options.tools.active.id === 'paint') {
          this.inspectors.open(null);
          if (this.toolbar && this.toolbar.currentTab !== 'paint') this.toolbar.openTab('paint');
          this.toolbar?.refresh();
          this.toolbar?.markings?.reveal();
          this.shortcuts?.contextChanged();
          return;
        }
        // In the Junction tool, markings and shape open in its tray, not a floating panel.
        if (target && (target.kind === 'nodeMarkings' || target.kind === 'junctionShape') && this.toolbar?.currentTab === 'junction') {
          this.inspectors.open(null);
          this.toolbar.refresh();
          return;
        }
        this.inspectors.open(target);
        this.shortcuts?.contextChanged();
      },
      openDesigner: (id) => openRoadDesigner(context, id),
      openStats: () => this.stats.toggle(),
    };
    this.context = context;
    installTooltips();
    this.inspectors = new Inspectors(context);
    this.menu = new Menu(context);
    this.stats = new StatsPanel(context);
    this.topbar = new TopBar(context, () => this.menu.open());
    this.infobar = new InfoBar(context);
    this.toolbar = new Toolbar(context);
    new CursorHudView(host, options.tools);
    options.tools.connect({ toast: context.toast, inspect: context.inspect, templates: options.templates });
    const state = (): ShortcutState => ({ tool: options.tools.active.id, select: this.inspectors.currentKind, tab: this.toolbar.currentTab });
    this.shortcuts = new ShortcutPanel(host, state);
    const app = this.keyApp();
    this.palette = new Palette(host, () => this.commands(app));
    options.tools.onChange(() => this.shortcuts.contextChanged());
    bindInput(context, { toolbar: this.toolbar, topbar: this.topbar, infobar: this.infobar, menu: this.menu, app, palette: this.palette, shortcuts: this.shortcuts, state });
    this.menu.showHints();
    // The loading screen in index.html goes once the interface is up.
    const boot = document.getElementById('boot');
    if (boot) {
      boot.classList.add('done');
      setTimeout(() => boot.remove(), 200);
    }
    // The bar wraps on narrow windows, and panels below it must follow.
    new ResizeObserver(() => {
      host.style.setProperty('--top-h', `${this.topbar.root.offsetHeight}px`);
    }).observe(this.topbar.root);
    this.tick();
  }

  /** Called every frame with real seconds. */
  update(dt: number): void {
    this.elapsed += dt;
    if (this.elapsed < TICK_SEC) return;
    this.elapsed = 0;
    this.tick();
  }

  /** What keymap bindings act on. */
  private keyApp(): KeyApp {
    const { tools, history } = this.context;
    const ui = this;
    return {
      get activeTool() {
        return tools.active.id;
      },
      setTool: (id) => tools.setTool(id),
      toggleTool: (id) => this.toolbar.toggleTool(id),
      openTab: (id) => {
        this.toolbar.openTab(id as TabId | null);
        this.shortcuts.contextChanged();
      },
      get currentTab() {
        return ui.toolbar.currentTab;
      },
      pickCard: (i) => this.toolbar.pickCard(i),
      cycleCard: (step) => this.toolbar.cycleCard(step),
      setDrawMode: (mode) => this.toolbar.setDrawMode(mode),
      undo: () => history.undo(),
      redo: () => history.redo(),
      save: () => this.menu.saveNow(),
      open: () => this.menu.openLoad(),
      newMap: () => this.menu.newMap(),
      openMenu: () => this.menu.open(),
      openHelp: () => this.menu.help(),
      openStats: () => this.stats.toggle(),
      togglePause: () => this.topbar.togglePause(),
      setSpeed: (speed) => this.topbar.setSpeed(speed),
      toggleUnderground: () => this.infobar.toggleUnderground(),
      toggleOverlay: (mode) => this.infobar.toggleOverlay(mode),
      toggleShadows: () => this.infobar.toggleShadows(),
      toggleGrid: () => toggleGridSnap(this.context),
      toggleSnap: (key) => {
        tools.settings[key] = !tools.settings[key];
        tools.settingsChanged();
        const names = { snapNodes: 'Snap to nodes', snapSegments: 'Snap along roads', snapAngle: 'Angle guides', snapLength: 'Length steps' };
        this.context.toast(`${names[key]} ${tools.settings[key] ? 'on' : 'off'}`);
      },
      stepElevation: (d) => tools.road.stepElevation(d),
      deleteSelection: () => {
        if (tools.active.id === 'roundabout' && tools.roundabout.selection) {
          tools.roundabout.deleteSelected();
          return true;
        }
        return this.inspectors.deleteCurrent();
      },
      openPalette: () => this.palette.toggle(),
      toggleShortcuts: () => this.shortcuts.togglePinned(),
      setRoadDetail: (pref) => {
        const r = this.context.renderer as unknown as { setRoadDetail?(p: typeof pref): void };
        r.setRoadDetail?.(pref);
        this.context.toast(pref === 'auto' ? 'Road detail follows graphics quality' : `Road detail: ${pref[0].toUpperCase()}${pref.slice(1)}`);
      },
      openGraphics: () => this.menu.graphics(),
      setControlCard: (kind) => {
        tools.settings.junctionControl = kind as typeof tools.settings.junctionControl;
        this.toolbar.openTab('control');
        tools.setTool('junction');
        tools.settingsChanged();
      },
    };
  }

  /** Everything the command palette offers: keymap actions plus each card and setting. */
  private commands(app: KeyApp): PaletteCommand[] {
    const { tools } = this.context;
    const out: PaletteCommand[] = [];
    for (const b of bindings()) {
      if (!b.run || b.noPalette) continue;
      out.push({ id: b.id, label: b.label, group: b.group, keys: b.keys, desc: b.desc, run: () => b.run!(app) });
    }
    const roads = [...BUILTIN_ROAD_TYPES, ...this.context.net.project.customRoadTypes].filter((d) => d.category !== 'roundabout' && d.category !== 'rail');
    for (const d of roads) {
      out.push({
        id: `road.${d.id}`,
        label: `Draw ${d.name}`,
        group: 'Roads',
        keys: [],
        run: () => {
          tools.settings.roadType = d.id;
          if (tools.settings.drawMode === 'upgrade') tools.settings.drawMode = 'straight';
          this.toolbar.openTab(d.category as TabId);
          tools.setTool('road');
          tools.settingsChanged();
        },
      });
    }
    for (const c of CONTROL_CARDS) {
      out.push({ id: `control.${c.kind}`, label: c.name, group: 'Traffic control', keys: [], desc: `${c.description}. Key ${c.key} in the Traffic Control tab`, run: () => app.setControlCard(c.kind) });
    }
    out.push({ id: 'control.advanced', label: 'Junction editor', group: 'Traffic control', keys: [], run: () => app.setControlCard('inspect') });
    for (const lanes of [1, 2, 3] as const) {
      out.push({
        id: `roundabout.lanes${lanes}`,
        label: `Roundabout: ${lanes} lane${lanes > 1 ? 's' : ''}`,
        group: 'Roundabout',
        keys: [],
        run: () => {
          app.openTab('control');
          tools.setTool('roundabout');
          tools.settings.roundabout.lanes = lanes;
          tools.settingsChanged();
        },
      });
    }
    for (const g of GROUPS) {
      out.push({ id: `open.${g.id}`, label: g.label, group: 'Tools', keys: [], desc: g.desc, run: () => app.openTab(g.id) });
      for (const m of g.modes) {
        if (g.modes.length < 2) continue;
        out.push({ id: `mode.${g.id}.${m.id}`, label: `${g.label}: ${m.label}`, group: 'Tools', keys: [], desc: m.desc, run: () => this.toolbar.activateMode(m) });
      }
    }
    for (const [m, label] of [['auto', 'fade when idle'], ['always', 'always show'], ['never', 'hide']] as const) {
      out.push({ id: `shortcuts.${m}`, label: `Shortcut panel: ${label}`, group: 'Panels', keys: [], run: () => this.shortcuts.setMode(m) });
    }
    out.push({ id: 'file.export', label: 'Export JSON', group: 'File', keys: [], run: () => this.context.actions.exportJson() });
    return out;
  }

  private tick(): void {
    this.shortcuts.contextChanged();
    this.topbar.tick();
    this.inspectors.tick();
    this.stats.tick();
  }
}
