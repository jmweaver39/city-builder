/**
 * Undo and redo by whole-project snapshots.
 *
 * Every committed network change becomes one step, so nothing can forget to
 * record itself. begin() and end() fold a drag into one step. A hint with a
 * coalesce key merges repeated edits, such as a slider being dragged.
 */
import type { ResetReason, RoadNetwork } from '../core/RoadNetwork';
import type { Project } from '../core/types';
import type { EditRecorder } from '../tools/types';

export const HISTORY_LEVELS = 100;
/** Edits with the same key this close together are one step. */
const COALESCE_MS = 900;

interface Step {
  label: string;
  /** The project as it was before this step. */
  before: Project;
}

export class History implements EditRecorder {
  private undoStack: Step[] = [];
  private redoStack: { label: string; project: Project }[] = [];
  /** The project as of the latest step. */
  private current: Project;
  private depth = 0;
  private dirty = false;
  private openLabel = 'Edit';
  private nextLabel: string | null = null;
  private nextKey: string | null = null;
  private lastKey: string | null = null;
  private lastTime = 0;
  private applying = false;
  private listeners = new Set<() => void>();
  private off: () => void;

  constructor(
    private readonly net: RoadNetwork,
    private readonly levels = HISTORY_LEVELS,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.current = net.snapshot();
    this.off = net.onChange(() => this.onChange());
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  get size(): number {
    return this.undoStack.length;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn();
  }

  private onChange(): void {
    if (this.applying) return;
    if (this.depth > 0) {
      this.dirty = true;
      return;
    }
    this.commitStep(this.nextLabel ?? 'Edit', this.nextKey);
    this.nextLabel = null;
    this.nextKey = null;
  }

  private commitStep(label: string, key: string | null): void {
    const snap = this.net.snapshot();
    const t = this.now();
    this.redoStack = [];
    if (key !== null && key === this.lastKey && t - this.lastTime < COALESCE_MS) {
      this.current = snap;
      this.lastTime = t;
      this.notify();
      return;
    }
    this.undoStack.push({ label, before: this.current });
    if (this.undoStack.length > this.levels) this.undoStack.shift();
    this.current = snap;
    this.lastKey = key;
    this.lastTime = t;
    this.notify();
  }

  begin(label: string): void {
    if (this.depth === 0) {
      this.openLabel = label;
      this.dirty = false;
    }
    this.depth++;
  }

  end(): void {
    if (this.depth === 0) return;
    this.depth--;
    if (this.depth === 0 && this.dirty) {
      this.dirty = false;
      this.commitStep(this.openLabel, null);
    }
  }

  abort(): void {
    if (this.depth === 0) return;
    this.depth = 0;
    if (this.dirty) {
      this.dirty = false;
      this.restore(this.current, 'undo');
    }
  }

  hint(label: string, coalesceKey?: string): void {
    this.nextLabel = label;
    this.nextKey = coalesceKey ?? null;
  }

  private restore(project: Project, reason: ResetReason): void {
    this.applying = true;
    try {
      this.net.load(structuredClone(project), reason);
    } finally {
      this.applying = false;
    }
  }

  undo(): boolean {
    this.abort();
    const step = this.undoStack.pop();
    if (!step) return false;
    this.redoStack.push({ label: step.label, project: this.current });
    this.current = step.before;
    this.lastKey = null;
    this.restore(this.current, 'undo');
    this.notify();
    return true;
  }

  redo(): boolean {
    this.abort();
    const step = this.redoStack.pop();
    if (!step) return false;
    this.undoStack.push({ label: step.label, before: this.current });
    this.current = step.project;
    this.lastKey = null;
    this.restore(this.current, 'redo');
    this.notify();
    return true;
  }

  /** Replace the whole project with no way back, for New, Load and Import. */
  replace(load: () => void): void {
    this.abort();
    this.applying = true;
    try {
      load();
    } finally {
      this.applying = false;
    }
    this.clear();
  }

  /**
   * Replace the whole project as one undoable step, for New, Load, Import and demos,
   * so a map replaced by mistake comes back with Undo.
   */
  replaceUndoable(label: string, load: () => void): void {
    this.abort();
    const before = this.current;
    this.applying = true;
    try {
      load();
    } finally {
      this.applying = false;
    }
    this.redoStack = [];
    this.undoStack.push({ label, before });
    if (this.undoStack.length > this.levels) this.undoStack.shift();
    this.current = this.net.snapshot();
    this.lastKey = null;
    this.nextLabel = null;
    this.nextKey = null;
    this.notify();
  }

  /** Forget all steps and treat the current network as the start. */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.current = this.net.snapshot();
    this.lastKey = null;
    this.nextLabel = null;
    this.nextKey = null;
    this.notify();
  }

  destroy(): void {
    this.off();
  }
}
