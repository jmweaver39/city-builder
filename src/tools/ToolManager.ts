/**
 * Holds the tools and routes input to the active one. One tool is active at a
 * time. Esc leaves a tool for Inspect. A right click that did not drag steps back.
 */
import type { NetworkChange, RoadNetwork } from '../core/RoadNetwork';
import type { ToolMark } from '../render/api';
import type { SimApi } from '../sim/api';
import { BulldozeTool } from './BulldozeTool';
import { JunctionTool } from './JunctionTool';
import { LaneTool } from './LaneTool';
import { MoveTool } from './MoveTool';
import { NodeMarkingTool } from './NodeMarkingTool';
import { PaintTool } from './PaintTool';
import { ReverseTool } from './ReverseTool';
import { RoadTool } from './RoadTool';
import { SelectTool } from './SelectTool';
import { TemplateTool } from './TemplateTool';
import { Tool } from './Tool';
import { TrafficTool } from './TrafficTool';
import { GridAlignTool, GridBlockTool } from './GridBlockTool';
import { gridViewFor } from './grid';
import {
  defaultSettings,
  type CursorHud,
  type EditRecorder,
  type EditorSettings,
  type InspectTarget,
  type TemplateApi,
  type ToastKind,
  type ToolContext,
  type ToolId,
  type ToolKey,
  type ToolPointer,
  type ToolView,
} from './types';

export interface ToolManagerOptions {
  net: RoadNetwork;
  sim: SimApi | null;
  view: ToolView;
  history: EditRecorder;
  templates?: TemplateApi | null;
  toast?: (message: string, kind?: ToastKind) => void;
  inspect?: (target: InspectTarget | null) => void;
}

/** A right press that moves further than this was a camera drag. */
const CLICK_SLOP_PX = 6;

export class ToolManager {
  readonly settings: EditorSettings = defaultSettings();
  readonly ctx: ToolContext;
  readonly tools: Record<ToolId, Tool>;
  private current: Tool;
  private listeners = new Set<() => void>();
  private toolMarks: ToolMark[] = [];
  private overlayMarks = new Map<string, ToolMark[]>();
  private rightDown: { x: number; y: number } | null = null;
  private dispose: () => void;
  hud: CursorHud | null = null;
  /** Grid: the tool to return to after Align to road, and the last cursor on the ground. */
  private beforeAlign: ToolId = 'road';
  private gridPointer: ToolPointer | null = null;
  private gridCenter: { x: number; z: number } | null = null;

  constructor(private readonly options: ToolManagerOptions) {
    const self = this;
    this.ctx = {
      net: options.net,
      sim: options.sim,
      view: options.view,
      history: options.history,
      settings: this.settings,
      get templates() {
        return self.options.templates ?? null;
      },
      setMarks: (marks) => {
        this.toolMarks = marks;
        this.pushMarks();
      },
      setHud: (hud) => {
        this.hud = hud;
        this.notify();
      },
      toast: (message, kind) => this.options.toast?.(message, kind),
      inspect: (target) => this.options.inspect?.(target),
      changed: () => this.notify(),
    };
    this.tools = {
      select: new SelectTool(this.ctx),
      road: new RoadTool(this.ctx),
      bulldoze: new BulldozeTool(this.ctx),
      move: new MoveTool(this.ctx),
      junction: new JunctionTool(this.ctx),
      lanes: new LaneTool(this.ctx),
      paint: new PaintTool(this.ctx),
      traffic: new TrafficTool(this.ctx),
      template: new TemplateTool(this.ctx),
      nodeMarkings: new NodeMarkingTool(this.ctx),
      reverse: new ReverseTool(this.ctx),
      gridBlock: new GridBlockTool(this.ctx),
      gridAlign: new GridAlignTool(this.ctx),
    };
    (this.tools.gridAlign as GridAlignTool).onDone = () => this.setTool(this.beforeAlign);
    this.current = this.tools.select;
    this.dispose = options.net.onChange((change) => this.networkChanged(change));
  }

  /** Wire late-bound hooks, once the UI exists. */
  connect(hooks: Pick<ToolManagerOptions, 'toast' | 'inspect' | 'templates'>): void {
    Object.assign(this.options, hooks);
  }

  get active(): Tool {
    return this.current;
  }

  get road(): RoadTool {
    return this.tools.road as RoadTool;
  }

  get paint(): PaintTool {
    return this.tools.paint as PaintTool;
  }

  get lanes(): LaneTool {
    return this.tools.lanes as LaneTool;
  }

  get nodeMarkings(): NodeMarkingTool {
    return this.tools.nodeMarkings as NodeMarkingTool;
  }

  get template(): TemplateTool {
    return this.tools.template as TemplateTool;
  }

  setTool(id: ToolId): void {
    if (this.current.id === id) {
      this.current.settingsChanged();
      this.notify();
      return;
    }
    this.current.deactivate();
    this.clearView();
    this.current = this.tools[id];
    this.current.activate();
    this.notify();
  }

  /** Esc: leave the active tool. */
  escape(): void {
    this.setTool('select');
  }

  private clearView(): void {
    this.options.view.setPreview([]);
    this.options.view.setHighlight(null);
    this.toolMarks = [];
    this.pushMarks();
    this.hud = null;
  }

  private pushMarks(): void {
    const all = [...this.toolMarks];
    for (const marks of this.overlayMarks.values()) all.push(...marks);
    this.options.view.setMarks(all);
  }

  /** Marks that outlive tools, such as a followed vehicle's route. Empty clears them. */
  setOverlayMarks(key: string, marks: ToolMark[]): void {
    if (marks.length) this.overlayMarks.set(key, marks);
    else this.overlayMarks.delete(key);
    this.pushMarks();
  }

  /** A setting changed from a panel. */
  settingsChanged(): void {
    this.current.settingsChanged();
    this.notify();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.syncGrid();
    for (const fn of [...this.listeners]) fn();
  }

  get gridBlock(): GridBlockTool {
    return this.tools.gridBlock as GridBlockTool;
  }

  /** Pick a road to line the grid up with, then come back to the current tool. */
  alignGrid(): void {
    if (this.current.id !== 'gridAlign') this.beforeAlign = this.current.id === 'gridBlock' ? 'gridBlock' : 'road';
    this.setTool('gridAlign');
  }

  /** Show or hide the optional grid for the active tool, around the cursor. */
  private syncGrid(): void {
    const view = this.options.view;
    if (!view.setGrid) return;
    const s = this.settings;
    const e = this.gridPointer;
    const p = e ? view.pickPlane(e.x, e.y, s.elevation) : null;
    if (p) this.gridCenter = { x: p.x, z: p.z };
    const preview = this.current instanceof GridAlignTool ? this.current.preview : null;
    view.setGrid(gridViewFor(this.current.id, s.drawMode, s.grid, preview, this.gridCenter, s.elevation));
  }

  private networkChanged(change: NetworkChange): void {
    if (change.reset || change.settingsChanged) this.dropMissingRoadTypes();
    this.current.networkChanged(change);
  }

  /** Undo or Load can remove a custom road type that is still selected. */
  private dropMissingRoadTypes(): void {
    const { net } = this.options;
    const s = this.settings;
    if (!net.roadType(s.roadType)) {
      s.roadType = 'street-2';
      this.notify();
    }
    if (s.template.roadType && !net.roadType(s.template.roadType)) s.template.roadType = null;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  pointerDown(e: ToolPointer): void {
    if (e.button === 2) {
      this.rightDown = { x: e.x, y: e.y };
      return;
    }
    if (e.button === 0) this.current.pointerDown(e);
  }

  pointerMove(e: ToolPointer): void {
    this.current.pointerMove(e);
    this.gridPointer = e;
    this.syncGrid();
  }

  pointerUp(e: ToolPointer): void {
    if (e.button === 2) {
      const down = this.rightDown;
      this.rightDown = null;
      if (down && Math.hypot(e.x - down.x, e.y - down.y) <= CLICK_SLOP_PX) this.current.back();
      return;
    }
    if (e.button === 0) this.current.pointerUp(e);
  }

  doubleClick(e: ToolPointer): void {
    this.current.doubleClick(e);
  }

  wheel(delta: number, e: ToolPointer): boolean {
    return this.current.wheel(delta, e);
  }

  keyDown(e: ToolKey): boolean {
    return this.current.keyDown(e);
  }

  keyUp(e: ToolKey): boolean {
    return this.current.keyUp(e);
  }

  /** The pointer left the canvas. */
  pointerLeave(): void {
    this.options.view.setHighlight(null);
    this.hud = null;
    this.notify();
  }

  destroy(): void {
    this.dispose();
  }
}
