/**
 * Marking presets, templates, recent colours and the copied markings, kept per
 * user in local preferences. Every read and write is guarded: in a private window
 * or with storage blocked, it all still works for the session, just unsaved.
 * Presets and templates used in a map are also copied into the map
 * (RoadNetwork.saveToLibrary), so it opens the same on another machine.
 */
import { BUILTIN_PRESETS } from '../core/markingStyle';
import type { MarkingPreset, MarkingTemplate } from '../core/types';

const KEYS = {
  presets: 'cloverleaf.marking.presets',
  templates: 'cloverleaf.marking.templates',
  colours: 'cloverleaf.marking.recentColours',
  clipboard: 'cloverleaf.marking.clipboard',
} as const;

const memory = new Map<string, string>();

function read<T>(key: string, fallback: T): T {
  let raw: string | null = memory.get(key) ?? null;
  try {
    raw = localStorage.getItem(key) ?? raw;
  } catch {
    // Storage blocked: the session copy is all there is.
  }
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  const raw = JSON.stringify(value);
  memory.set(key, raw);
  try {
    localStorage.setItem(key, raw);
  } catch {
    // Kept for this session only.
  }
}

let version = 0;
const listeners = new Set<() => void>();

/** Bumps whenever the library changes, so panels know to redraw. */
export function libraryVersion(): number {
  return version;
}

export function onLibraryChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(): void {
  version++;
  for (const fn of [...listeners]) fn();
}

export function userPresets(): MarkingPreset[] {
  const list = read<MarkingPreset[]>(KEYS.presets, []);
  return Array.isArray(list) ? list.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string') : [];
}

/** Built-in presets, then the user's, then any only the map has, without repeats. */
export function allPresets(mapPresets: readonly MarkingPreset[] = []): MarkingPreset[] {
  const out: MarkingPreset[] = [];
  const seen = new Set<string>();
  for (const p of [...BUILTIN_PRESETS, ...userPresets(), ...mapPresets]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

export function savePreset(p: MarkingPreset): void {
  write(KEYS.presets, [...userPresets().filter((x) => x.id !== p.id), p]);
  changed();
}

export function deletePreset(id: string): void {
  write(KEYS.presets, userPresets().filter((x) => x.id !== id));
  changed();
}

export function userTemplates(): MarkingTemplate[] {
  const list = read<MarkingTemplate[]>(KEYS.templates, []);
  return Array.isArray(list) ? list.filter((t) => t && typeof t.id === 'string' && Array.isArray(t.markings)) : [];
}

export function allTemplates(mapTemplates: readonly MarkingTemplate[] = []): MarkingTemplate[] {
  const out: MarkingTemplate[] = [];
  const seen = new Set<string>();
  for (const t of [...userTemplates(), ...mapTemplates]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

export function saveTemplate(t: MarkingTemplate): void {
  write(KEYS.templates, [...userTemplates().filter((x) => x.id !== t.id), t]);
  changed();
}

export function deleteTemplate(id: string): void {
  write(KEYS.templates, userTemplates().filter((x) => x.id !== id));
  changed();
}

export function recentColours(): string[] {
  const list = read<string[]>(KEYS.colours, []);
  return Array.isArray(list) ? list.filter((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)).slice(0, 8) : [];
}

export function noteColour(hex: string): void {
  const c = hex.toLowerCase();
  write(KEYS.colours, [c, ...recentColours().filter((x) => x !== c)].slice(0, 8));
  changed();
}

export function storedClipboard(): MarkingTemplate | null {
  const t = read<MarkingTemplate | null>(KEYS.clipboard, null);
  return t && Array.isArray(t.markings) ? t : null;
}

export function storeClipboard(t: MarkingTemplate): void {
  write(KEYS.clipboard, t);
  changed();
}

/** A fresh id for a preset or template. */
export function libraryId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}
