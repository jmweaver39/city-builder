/** Turns DOM input into tool events and hotkeys. */
import type { ToolId, ToolKey, ToolPointer } from '../tools/types';
import { closePopups } from './dom';
import type { UiContext } from './context';
import type { Toolbar } from './Toolbar';
import type { TopBar } from './TopBar';
import type { InfoBar } from './InfoBar';
import type { Menu } from './Menu';
import { activeScopes, comboFromEvent, match, type KeyApp } from './keymap';
import { isTrackpadScroll } from '../render/camera';
import type { Palette } from './Palette';
import type { ShortcutPanel, ShortcutState } from './ShortcutPanel';
import type { RendererApi, RendererExtras } from '../render/api';

function toPointer(e: MouseEvent): ToolPointer {
  return { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
}

function isForm(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement
    ? target.type !== 'range' && target.type !== 'checkbox'
    : target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
}

export interface InputParts {
  toolbar: Toolbar;
  topbar: TopBar;
  infobar: InfoBar;
  menu: Menu;
  app: KeyApp;
  palette: Palette;
  shortcuts: ShortcutPanel;
  state: () => ShortcutState;
}

export function bindInput(ui: UiContext, parts: InputParts): void {
  const { tools, renderer, history } = ui;
  const { toolbar, topbar, infobar, menu } = parts;
  const canvas = renderer.canvas;
  // Q and E turn the camera except while a tool uses them for elevation (Alt+Q/E always turns).
  const turnKeys = renderer as RendererApi & Partial<Pick<RendererExtras, 'setCameraRotateKeys'>>;
  const syncTurnKeys = () => turnKeys.setCameraRotateKeys?.(!tools.elevationKeys);
  tools.onChange(syncTurnKeys);
  syncTurnKeys();
  // Landscaping takes right drag and Option-drag itself (lowering), so the camera leaves them alone then.
  const toolButtons = renderer as RendererApi & { setCameraToolButtons?(on: boolean): void };
  const syncToolButtons = () => toolButtons.setCameraToolButtons?.(tools.usesRightButton);
  tools.onChange(syncToolButtons);
  syncToolButtons();
  let pressed = 0;

  canvas.addEventListener('pointerdown', (e) => {
    // Option-drag orbits the camera (for trackpads), so the tool does not see it.
    if (e.button === 0 && e.altKey && !tools.usesRightButton) return;
    pressed |= 1 << e.button;
    (document.activeElement as HTMLElement | null)?.blur?.();
    tools.pointerDown(toPointer(e));
  });
  window.addEventListener('pointermove', (e) => {
    if (e.target === canvas || pressed) tools.pointerMove(toPointer(e));
  });
  window.addEventListener('pointerup', (e) => {
    if (!(pressed & (1 << e.button))) return;
    pressed &= ~(1 << e.button);
    tools.pointerUp(toPointer(e));
  });
  window.addEventListener('blur', () => {
    if (pressed & 1) tools.pointerUp({ x: 0, y: 0, button: 0, shift: false, ctrl: false, alt: false });
    pressed = 0;
  });
  canvas.addEventListener('pointerleave', () => {
    if (!pressed) tools.pointerLeave();
  });
  canvas.addEventListener('dblclick', (e) => tools.doubleClick(toPointer(e)));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // Capture, so a tool can take Shift+wheel before the camera sees it.
  canvas.parentElement?.addEventListener(
    'wheel',
    (e) => {
      // A two-finger trackpad scroll pans the camera, so tools leave it alone.
      if (!e.ctrlKey && !e.metaKey && isTrackpadScroll(e)) return;
      if (tools.wheel(e.deltaY, toPointer(e))) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true, passive: false },
  );

  // The camera ignores keys while a text field has focus, checked per key press.
  // A latch toggled on focusin and focusout got stuck off whenever a panel
  // re-rendered and removed its focused field, since no focusout follows.
  // Hand focus back to the game once a pick is made, so Space, PageUp and the
  // hotkeys don't re-trigger the button or change the select.
  ui.host.addEventListener('change', (e) => {
    if (e.target instanceof HTMLSelectElement || (e.target instanceof HTMLInputElement && !isForm(e.target))) {
      e.target.blur();
    }
  });
  ui.host.addEventListener('click', (e) => {
    const button = e.target instanceof Element ? e.target.closest('button') : null;
    if (button && e.detail > 0) button.blur();
  });

  const key = (e: KeyboardEvent): ToolKey => ({ key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey });

  // Every shortcut comes from the keymap (keymap.ts); this only routes key presses.
  const app = parts.app;
  const scopes = () => activeScopes(parts.state());

  window.addEventListener('keydown', (e) => {
    if (parts.palette.isOpen) return;
    if (isForm(e.target)) {
      if (e.key === 'Escape') (e.target as HTMLElement).blur();
      return;
    }
    if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') {
      // Ctrl or Cmd held turns snapping off in the road tool.
      tools.keyDown(key(e));
      if (e.key !== 'Shift' && !e.repeat) parts.shortcuts.modifier(e.key);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      backOut();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    // Tools take their own keys first: brackets, PageUp and PageDown, Q and E, Enter, Delete.
    if (!mod && tools.keyDown(key(e))) {
      e.preventDefault();
      parts.shortcuts.activity();
      return;
    }
    const combo = comboFromEvent(e);
    const hit = match(combo, scopes());
    if (!hit) return;
    if (hit.id === 'tab.pick') {
      e.preventDefault();
      if (!e.repeat) app.pickCard(Number(combo.slice(-1)) - 1);
      parts.shortcuts.activity();
      return;
    }
    if (!hit.run) return;
    e.preventDefault();
    if (e.repeat && !hit.repeat) return;
    hit.run(app);
    parts.shortcuts.activity();
  });

  /** Esc backs out one level: a popup, the tool's step, the tool, the inspector, then the menu. */
  function backOut(): void {
    if (closePopups()) return;
    if (tools.active.id !== 'select') {
      if (tools.active.back()) return;
      tools.escape();
      return;
    }
    if (parts.state().select) {
      ui.inspect(null);
      return;
    }
    if (toolbar.currentTab) {
      toolbar.openTab(null);
      return;
    }
    menu.open();
  }

  window.addEventListener('keyup', (e) => {
    if (!isForm(e.target)) tools.keyUp(key(e));
  });
}
