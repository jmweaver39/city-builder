/** Base class of every editor tool. All handlers default to doing nothing. */
import type { NetworkChange } from '../core/RoadNetwork';
import type { ToolContext, ToolId, ToolKey, ToolPointer } from './types';

export abstract class Tool {
  abstract readonly id: ToolId;
  /** Latest pointer position, so key presses can refresh the hover state. */
  protected pointer: ToolPointer | null = null;

  constructor(protected readonly ctx: ToolContext) {}

  activate(): void {}

  /** Clear everything this tool shows. The manager clears marks and previews too. */
  deactivate(): void {}

  pointerDown(_e: ToolPointer): void {}
  pointerMove(e: ToolPointer): void {
    this.pointer = e;
  }
  pointerUp(_e: ToolPointer): void {}
  doubleClick(_e: ToolPointer): void {}

  /** Return true to take the wheel event away from the camera. */
  wheel(_delta: number, _e: ToolPointer): boolean {
    return false;
  }

  /** Return true when the key was used. */
  keyDown(_e: ToolKey): boolean {
    return false;
  }
  keyUp(_e: ToolKey): boolean {
    return false;
  }

  /** Right click: step back one stage. Return false when there is nothing to undo. */
  back(): boolean {
    return false;
  }

  /** The network changed. `reset` means every held id may be gone. */
  networkChanged(_change: NetworkChange): void {}

  /** A setting changed from a panel. Redraw the hover state. */
  settingsChanged(): void {}
}
