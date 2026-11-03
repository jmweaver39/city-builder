/** Turns DOM input into tool events and hotkeys. */
import type { ToolId, ToolKey, ToolPointer } from '../tools/types';
import { closePopups } from './dom';
import type { UiContext } from './context';
import type { Toolbar } from './Toolbar';
import type { TopBar } from './TopBar';
import type { InfoBar } from './InfoBar';
import type { Menu } from './Menu';

function toPointer(e: MouseEvent): ToolPointer {
  return { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
}

function isForm(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement
    ? target.type !== 'range' && target.type !== 'checkbox'
    : target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
}

const TOOL_KEYS: Record<string, ToolId> = { b: 'bulldoze', m: 'move', v: 'select', p: 'paint', t: 'traffic', j: 'junction', l: 'lanes' };

export function bindInput(ui: UiContext, parts: { toolbar: Toolbar; topbar: TopBar; infobar: InfoBar; menu: Menu }): void {
  const { tools, renderer, history } = ui;
  const { toolbar, topbar, infobar, menu } = parts;
  const canvas = renderer.canvas;
  let pressed = 0;

  canvas.addEventListener('pointerdown', (e) => {
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

  window.addEventListener('keydown', (e) => {
    if (isForm(e.target)) {
      if (e.key === 'Escape') (e.target as HTMLElement).blur();
      return;
    }
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
      return;
    }
    if (mod && k === 'y') {
      e.preventDefault();
      history.redo();
      return;
    }
    if (mod && k === 's') {
      e.preventDefault();
      menu.saveNow();
      return;
    }
    if (mod) {
      tools.keyDown(key(e));
      return;
    }
    if (e.key === 'Escape') {
      if (closePopups()) return;
      if (tools.active.id === 'select') {
        menu.open();
        return;
      }
      tools.escape();
      return;
    }
    if (tools.keyDown(key(e))) {
      e.preventDefault();
      return;
    }
    if (e.repeat) return;
    if (e.key === ' ') {
      e.preventDefault();
      topbar.togglePause();
      return;
    }
    if (e.key === '1' || e.key === '2' || e.key === '3') {
      topbar.setSpeed(e.key === '1' ? 1 : e.key === '2' ? 2 : 4);
      return;
    }
    if (TOOL_KEYS[k]) {
      const id = TOOL_KEYS[k];
      if (id === 'paint') toolbar.openTab('paint');
      else if (id === 'traffic') toolbar.openTab('traffic');
      else if (id === 'junction' || id === 'lanes') {
        toolbar.openTab('control');
        tools.setTool(id);
      } else toolbar.toggleTool(id);
      return;
    }
    if (k === 'n') {
      tools.setTool('road');
      if (!toolbar.currentTab) toolbar.openTab('street');
      return;
    }
    if (k === 'k') {
      toolbar.openTab('paint');
      tools.setTool('nodeMarkings');
      return;
    }
    if (k === 'h') {
      tools.setTool(tools.active.id === 'reverse' ? 'select' : 'reverse');
      return;
    }
    if (k === 'u') {
      infobar.toggleUnderground();
      return;
    }
    if (tools.active.id === 'road') {
      const modes = { z: 'straight', x: 'curved', c: 'freeform', g: 'upgrade' } as const;
      const mode = modes[k as keyof typeof modes];
      if (mode) toolbar.setDrawMode(mode);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (!isForm(e.target)) tools.keyUp(key(e));
  });
}
