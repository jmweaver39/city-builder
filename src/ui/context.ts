/** What every panel can reach. */
import type { RoadNetwork } from '../core/RoadNetwork';
import type { RendererApi } from '../render/api';
import type { SimApi } from '../sim/api';
import type { History } from '../app/History';
import type { SaveRecord, SaveStore } from '../app/storage';
import type { ToolManager } from '../tools/ToolManager';
import type { InspectTarget, TemplateApi, ToastKind } from '../tools/types';

export interface AppActions {
  newProject(name: string, starter: boolean): void;
  loadRecord(record: SaveRecord): void;
  importJson(text: string): void;
  exportJson(): void;
}

export interface UiContext {
  net: RoadNetwork;
  sim: SimApi;
  renderer: RendererApi;
  tools: ToolManager;
  history: History;
  saves: SaveStore;
  templates: TemplateApi | null;
  actions: AppActions;
  host: HTMLElement;
  /** Bottom centre stack: hints above the toolbar. */
  dock: HTMLElement;
  toast(message: string, kind?: ToastKind): void;
  inspect(target: InspectTarget | null): void;
  openDesigner(editId?: string): void;
  openStats(): void;
}
