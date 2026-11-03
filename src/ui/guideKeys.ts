/** Keys for the grid, smart guides and Parallel Road tool, registered with the central keymap. Pure. */
import type { KeyBinding } from './keymap';

/** Keys handled by the grid, guide and parallel code, listed in the central keymap. */
export const GUIDE_KEYS: KeyBinding[] = [
  { id: 'move.lower', label: 'Lower node 4 m', group: 'Draw', keys: ['Q', 'PageDown'], scope: 'tool:move', shadows: ['camera.rotateLeft'], repeat: true, desc: 'Option+Q/E still turns the camera. Handled by ToolManager' },
  { id: 'move.raise', label: 'Raise node 4 m', group: 'Draw', keys: ['E', 'PageUp'], scope: 'tool:move', shadows: ['camera.rotateRight'], repeat: true },
  { id: 'template.lowerRaise', label: 'Stamp height (Q lower, E raise)', group: 'Draw', keys: ['Q', 'E'], scope: 'tool:template', shadows: ['camera.rotateLeft', 'camera.rotateRight'], repeat: true },
  { id: 'draw.lockGuide', label: 'Hold: lock guide direction', group: 'Draw', keys: ['Shift'], scope: 'tool:road', noPalette: true, desc: 'Keeps the road on the current guide or direction while held' },
  { id: 'parallel.offset', label: 'Parallel offset', group: 'Draw', keys: ['[', ']'], scope: 'tool:parallel', desc: 'Step through the offset presets' },
];

