/** Save slots and autosave in a Storage-like object, so this runs under Vitest too. */
import type { RoadNetwork } from '../core/RoadNetwork';
import type { CameraPose } from '../render/api';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'cloverleaf.';
const AUTOSAVE_KEY = `${PREFIX}autosave`;
const SLOTS_KEY = `${PREFIX}slots`;
const SEEN_KEY = `${PREFIX}seenHints`;
export const SLOT_COUNT = 6;

export interface SaveRecord {
  /** Project JSON text. */
  project: string;
  camera: CameraPose | null;
  savedAt: number;
}

export interface SlotInfo {
  slot: number;
  name: string;
  savedAt: number;
}

export class SaveStore {
  constructor(private readonly store: KeyValueStore) {}

  private write(key: string, value: string): boolean {
    try {
      this.store.setItem(key, value);
      return true;
    } catch {
      return false; // Full, or storage is blocked.
    }
  }

  private read(key: string): string | null {
    try {
      return this.store.getItem(key);
    } catch {
      return null;
    }
  }

  private record(net: RoadNetwork, camera: CameraPose | null, savedAt: number): string {
    const record: SaveRecord = { project: net.serialize(), camera, savedAt };
    return JSON.stringify(record);
  }

  private parse(text: string | null): SaveRecord | null {
    if (!text) return null;
    try {
      const value = JSON.parse(text) as SaveRecord;
      return typeof value.project === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  autosave(net: RoadNetwork, camera: CameraPose | null, savedAt = Date.now()): boolean {
    return this.write(AUTOSAVE_KEY, this.record(net, camera, savedAt));
  }

  loadAutosave(): SaveRecord | null {
    return this.parse(this.read(AUTOSAVE_KEY));
  }

  clearAutosave(): void {
    try {
      this.store.removeItem(AUTOSAVE_KEY);
    } catch {
      // Nothing to do.
    }
  }

  private slotKey(slot: number): string {
    return `${PREFIX}slot.${slot}`;
  }

  saveSlot(slot: number, net: RoadNetwork, camera: CameraPose | null, savedAt = Date.now()): boolean {
    if (!this.write(this.slotKey(slot), this.record(net, camera, savedAt))) return false;
    const list = this.slots().filter((s) => s.slot !== slot);
    list.push({ slot, name: net.project.name, savedAt });
    return this.write(SLOTS_KEY, JSON.stringify(list));
  }

  loadSlot(slot: number): SaveRecord | null {
    return this.parse(this.read(this.slotKey(slot)));
  }

  deleteSlot(slot: number): void {
    try {
      this.store.removeItem(this.slotKey(slot));
    } catch {
      return;
    }
    this.write(SLOTS_KEY, JSON.stringify(this.slots().filter((s) => s.slot !== slot)));
  }

  slots(): SlotInfo[] {
    const text = this.read(SLOTS_KEY);
    if (!text) return [];
    try {
      const list = JSON.parse(text) as SlotInfo[];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  get seenHints(): boolean {
    return this.read(SEEN_KEY) === '1';
  }

  markHintsSeen(): void {
    this.write(SEEN_KEY, '1');
  }
}

/** Calls `fn` once things have been quiet for `delay` ms. */
export function debounce(fn: () => void, delay: number): { (): void; flush(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, delay);
  };
  run.flush = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    fn();
  };
  run.cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return run;
}
