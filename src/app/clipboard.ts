/**
 * Wires the middle-click copy into the app: the click itself (from the camera,
 * which tells a click from an orbit drag), Cmd+C and Cmd+V over the map, the
 * system clipboard, and the feedback (a toast, a flash on what was copied, and a
 * chip by the cursor showing what is held). The copying and pasting is
 * tools/clipboard.ts.
 *
 * The in-game clipboard is the source of truth. A copy is also written to the
 * system clipboard as JSON, when the browser allows it, so it can be pasted into
 * another tab or map; a paste reads the system clipboard through the paste event
 * (no permission prompt) and takes the newer of the two valid clips.
 */
import type { Renderer } from '../render/Renderer';
import { copyAt, parseClip, pasteAt, serializeClip, targetAt, targetOutline, useClip, ClipFormatError, type Clip, type ClipTarget } from '../tools/clipboard';
import type { ToolManager } from '../tools/ToolManager';
import { COLORS } from '../tools/types';
import type { ToolMark } from '../render/api';
import { activeScopes, binding, match, registerKeys, type KeyBinding } from '../ui/keymap';
import { groupOf } from '../ui/toolGroups';
import type { TabId } from '../ui/Toolbar';
import type { UI } from '../ui/UI';
import '../ui/clipboard.css';

const FLASH_KEY = 'clipboard-flash';
/** Cmd+V waits this long for the browser's paste event before using the in-game clip alone. */
const PASTE_WAIT_MS = 120;

const CLIP_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M5.5 2.5h5v2h-5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5 3.5H3.5v10h9v-10H11" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

export interface ClipboardApp {
  /** What the in-game clipboard holds. */
  readonly clip: Clip | null;
  copyAt(x: number, y: number): Clip | null;
  pasteAt(x: number, y: number, fromSystem?: string | null): boolean;
  dispose(): void;
}

function isForm(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement
    ? !['range', 'checkbox', 'radio', 'button', 'color'].includes(target.type)
    : target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
}

export function installClipboard(opts: { renderer: Renderer; tools: ToolManager; ui: UI }): ClipboardApp {
  const { renderer, tools, ui } = opts;
  const canvas = renderer.canvas;
  const toast = ui.context.toast;
  let clip: Clip | null = null;
  let clipAt = 0;
  let cursor: { x: number; y: number } | null = null;
  let overCanvas = false;
  const cleanups: (() => void)[] = [];
  const on = <K extends keyof WindowEventMap>(target: Window | Document | HTMLElement, type: K, fn: (e: WindowEventMap[K]) => void, capture = false) => {
    target.addEventListener(type, fn as EventListener, capture);
    cleanups.push(() => target.removeEventListener(type, fn as EventListener, capture));
  };

  // -------------------------------------------------------------------------
  // Feedback
  // -------------------------------------------------------------------------

  const chip = document.createElement('div');
  chip.className = 'clip-chip';
  chip.setAttribute('aria-live', 'polite');
  ui.context.host.append(chip);
  cleanups.push(() => chip.remove());

  const showChip = () => {
    if (!clip || !cursor || !overCanvas) {
      chip.classList.remove('shown');
      return;
    }
    chip.classList.add('shown');
    const w = chip.offsetWidth;
    const x = cursor.x + 18 + w > window.innerWidth ? cursor.x - w - 14 : cursor.x + 18;
    const y = Math.max(4, cursor.y - 30);
    chip.style.transform = `translate(${x}px, ${y}px)`;
  };

  const setChip = () => {
    chip.innerHTML = '';
    if (!clip) return;
    const icon = document.createElement('span');
    icon.className = 'clip-icon';
    icon.innerHTML = CLIP_ICON;
    const text = document.createElement('span');
    text.textContent = clip.name;
    chip.title = `Clipboard: ${clip.name}. Cmd+V over a ${clip.kind === 'road' ? 'road' : clip.kind === 'junction' ? 'junction' : 'marking'} pastes it`;
    chip.append(icon, text);
    chip.classList.remove('pulse');
    void chip.offsetWidth;
    chip.classList.add('pulse');
  };

  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  const flash = (target: ClipTarget) => {
    const lines = targetOutline(tools.ctx.net, target);
    if (!lines.length) return;
    const marks: ToolMark[] = lines.map((points) => ({ kind: 'line', points, color: COLORS.snap, width: 0.7 }));
    tools.setOverlayMarks(FLASH_KEY, marks);
    if (flashTimer) clearTimeout(flashTimer);
    // Two short pulses, then gone.
    flashTimer = setTimeout(() => {
      tools.setOverlayMarks(FLASH_KEY, []);
      flashTimer = setTimeout(() => {
        tools.setOverlayMarks(FLASH_KEY, marks);
        flashTimer = setTimeout(() => {
          tools.setOverlayMarks(FLASH_KEY, []);
          flashTimer = null;
        }, 260);
      }, 120);
    }, 260);
  };
  cleanups.push(() => {
    if (flashTimer) clearTimeout(flashTimer);
    tools.setOverlayMarks(FLASH_KEY, []);
  });

  // -------------------------------------------------------------------------
  // Copy and paste
  // -------------------------------------------------------------------------

  const writeSystem = (c: Clip, at: number) => {
    try {
      const write = navigator.clipboard?.writeText(serializeClip(c, at));
      // Refused without focus or permission; the in-game clipboard still has it.
      write?.catch(() => undefined);
    } catch {
      /* no system clipboard here */
    }
  };

  const hold = (c: Clip, at: number) => {
    clip = c;
    clipAt = at;
    setChip();
    showChip();
  };

  /** Open the tray for what useClip switched to. */
  const openTray = (use: ReturnType<typeof useClip>) => {
    if (use.tool === 'road') ui.toolbar.openTab((use.upgrade ? 'modify' : use.category) as TabId);
    else if (use.tool === 'paint') {
      const g = groupOf('paint', tools.settings.drawMode);
      if (g) ui.toolbar.openTab(g as TabId);
    }
    ui.toolbar.refresh?.();
  };

  const copy = (x: number, y: number): Clip | null => {
    const got = copyAt(tools.ctx, { x, y });
    if (!got) {
      toast('Nothing to copy here. Middle-click a road, marking or junction.', 'info');
      return null;
    }
    const at = Date.now();
    hold(got.clip, at);
    writeSystem(got.clip, at);
    const use = useClip(tools, got.clip);
    openTray(use);
    flash(got.target);
    const after = use.tool === 'road' ? (use.upgrade ? ': click roads to paste it' : ': drawing with it') : use.tool === 'paint' ? ': painting with it' : '. Cmd+V over a junction pastes it';
    toast(`Copied ${got.clip.name}${after}`);
    return got.clip;
  };

  /** Paste at a point: the newer of the system clipboard's clip and the in-game one. */
  const paste = (x: number, y: number, systemText: string | null = null): boolean => {
    let use = clip;
    if (systemText) {
      try {
        const parsed = parseClip(systemText);
        if (parsed && (!clip || parsed.at > clipAt)) {
          use = parsed.clip;
          hold(parsed.clip, parsed.at);
        }
      } catch (err) {
        if (err instanceof ClipFormatError) {
          toast(`The clipboard has a Cloverleaf copy that could not be read: ${err.message}`, 'error');
          return false;
        }
        throw err;
      }
    }
    if (!use) {
      toast('Nothing copied yet. Middle-click or Option+click a road, marking or junction first.', 'info');
      return false;
    }
    let result;
    try {
      result = pasteAt(tools.ctx, use, { x, y });
    } catch (err) {
      toast(`Could not paste: ${(err as Error).message}`, 'error');
      return false;
    }
    if (!result.ok) {
      toast(result.message, 'warning');
      return false;
    }
    flash(result.target);
    toast(result.message);
    if (result.warning) toast(result.warning, 'warning');
    return true;
  };

  // The camera tells a middle (or Option) click from an orbit drag.
  const offMiddle = renderer.onMiddleClick((x, y) => {
    if (document.elementFromPoint?.(x, y) !== canvas) return;
    copy(x, y);
  });
  cleanups.push(offMiddle);

  on(window, 'pointermove', (e) => {
    overCanvas = e.target === canvas;
    if (overCanvas) cursor = { x: e.clientX, y: e.clientY };
    showChip();
  });
  on(canvas, 'pointerleave', () => {
    overCanvas = false;
    showChip();
  });

  let pending: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  on(window, 'keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || (e.code ? e.code !== 'KeyV' : e.key.toLowerCase() !== 'v') || isForm(e.target)) return;
    if (!cursor || !overCanvas || ui.palette.isOpen) return;
    // A tool with its own Cmd+V (the Markings tool's junction paste) has it; see the wrappers below.
    const scopes = activeScopes({ tool: tools.active.id, select: ui.inspectors.currentKind, tab: ui.toolbar.currentTab });
    if (match('Mod+V', scopes)?.id !== 'edit.pasteHover') return;
    if (pending) clearTimeout(pending.timer);
    const at = cursor;
    // The browser follows the key with a paste event carrying the system clipboard; without one, use ours.
    pending = {
      ...at,
      timer: setTimeout(() => {
        pending = null;
        paste(at.x, at.y);
      }, PASTE_WAIT_MS),
    };
  });
  on(document, 'paste', (e) => {
    if (isForm(e.target)) return;
    const at = pending ?? (overCanvas ? cursor : null);
    if (pending) clearTimeout(pending.timer);
    pending = null;
    if (!at) return;
    e.preventDefault();
    paste(at.x, at.y, e.clipboardData?.getData('text/plain') ?? null);
  });

  // Keymap: the corner panel, the palette and help list these. Cmd+V is handled above.
  const keys: KeyBinding[] = [
    {
      ...(binding('edit.copyHover') ?? { id: 'edit.copyHover', label: "Copy what's under the cursor", group: 'Edit', keys: ['Mod+C'], scope: 'global' }),
      run: () => {
        // Text picked out in a panel copies as text, as Cmd+C always does.
        const picked = window.getSelection?.()?.toString() ?? '';
        if (picked && !overCanvas) {
          navigator.clipboard?.writeText(picked).catch(() => undefined);
          return;
        }
        if (cursor) copy(cursor.x, cursor.y);
        else toast('Point at a road, marking or junction, then middle-click, Option+click or press Cmd+C.', 'info');
      },
    },
    {
      id: 'edit.clearRoadStyle',
      label: 'Forget the copied road style',
      group: 'Edit',
      keys: [],
      scope: 'global',
      desc: 'New roads are drawn plain again',
      run: () => {
        tools.settings.roadStyle = null;
        if (tools.settings.walls.upgrade === 'style') tools.settings.walls.upgrade = 'road';
        tools.settingsChanged();
        toast('Copied road style forgotten.');
      },
    },
  ];
  // The Markings tool keeps Cmd+C and Cmd+V for a junction's whole set of markings. With no
  // junction open Cmd+C copies the style under the cursor, and over a single marking
  // Cmd+V pastes a copied style onto it; otherwise they do what they did.
  const markingCopy = binding('markings.copy');
  const markingPaste = binding('markings.paste');
  if (markingCopy?.run && markingPaste?.run) {
    const ownCopy = markingCopy.run;
    const ownPaste = markingPaste.run;
    keys.push(
      {
        ...markingCopy,
        run: (a) => {
          if (tools.nodeMarkings.host === null && cursor) copy(cursor.x, cursor.y);
          else ownCopy(a);
        },
      },
      {
        ...markingPaste,
        run: (a) => {
          const overMarking = !!cursor && overCanvas && clip?.kind === 'marking' && !!targetAt(tools.ctx, cursor, 'marking');
          if (cursor && (overMarking || tools.nodeMarkings.host === null)) paste(cursor.x, cursor.y);
          else ownPaste(a);
        },
      },
    );
  }
  cleanups.push(registerKeys(keys));

  return {
    get clip() {
      return clip;
    },
    copyAt: copy,
    pasteAt: paste,
    dispose() {
      for (const c of cleanups.splice(0)) c();
    },
  };
}
