/**
 * Keys of the road inspector's lane editor (LaneEditor.ts), registered with the
 * central keymap so they show in the shortcut panel, the palette and help. Pure, so
 * the keymap test can check them for clashes without a DOM.
 */
import type { KeyBinding } from './keymap';

/** What the keys drive: the lane editor of the open road inspector. */
export interface LaneKeyTarget {
  apply(): boolean;
  revert(): void;
  moveSelected(step: 1 | -1): boolean;
  removeSelected(): boolean;
}

const SCOPE = 'select:segment' as const;
const GROUP = 'Lanes';

export function laneEditKeys(target: () => LaneKeyTarget | null): KeyBinding[] {
  return [
    { id: 'lanes.apply', label: 'Apply lane changes', group: GROUP, keys: ['Mod+Enter'], scope: SCOPE, desc: 'Give the road the layout in its lane strip', run: () => void target()?.apply() },
    { id: 'lanes.left', label: 'Move lane left', group: GROUP, keys: ['Alt+ArrowLeft'], scope: SCOPE, repeat: true, desc: 'Move the element picked in the lane strip', run: () => void target()?.moveSelected(-1) },
    { id: 'lanes.right', label: 'Move lane right', group: GROUP, keys: ['Alt+ArrowRight'], scope: SCOPE, repeat: true, run: () => void target()?.moveSelected(1) },
    {
      id: 'lanes.remove',
      label: 'Remove lane',
      group: GROUP,
      keys: ['Shift+Delete', 'Shift+Backspace'],
      scope: SCOPE,
      desc: 'Remove the element picked in the lane strip. Delete alone does it too while the strip has focus',
      run: () => void target()?.removeSelected(),
    },
    { id: 'lanes.revert', label: 'Revert lane changes', group: GROUP, keys: [], scope: SCOPE, desc: 'Put the lane strip back as the road is', run: () => target()?.revert() },
  ];
}
