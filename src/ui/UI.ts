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
      inspect: (target) => this.inspectors.open(target),
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
    bindInput(context, { toolbar: this.toolbar, topbar: this.topbar, infobar: this.infobar, menu: this.menu });
    this.menu.showHints();
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

  private tick(): void {
    this.topbar.tick();
    this.inspectors.tick();
    this.stats.tick();
  }
}
