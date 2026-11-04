/**
 * Keys and palette commands of the junction markings editor, registered with the
 * central keymap so they show in the shortcut panel and in Cmd+K. Plain keys are
 * handled by NodeMarkingTool.keyDown and are listed here to document them; keys
 * with a modifier, and palette-only commands, run from here.
 */
import { captureTemplate } from '../core/markingTemplates';
import type { MarkingPreset } from '../core/types';
import type { UiContext } from './context';
import type { KeyBinding } from './keymap';
import { libraryId, savePreset, saveTemplate } from './markingLibrary';

// The one Markings tool (MarkingTool.ts) has id 'paint'.
const SCOPE = 'tool:paint' as const;
const GROUP = 'Markings';

export function markingKeys(ui: UiContext): KeyBinding[] {
  const tool = () => ui.tools.nodeMarkings;
  const editing = () => tool().host !== null && ui.tools.active.id === 'paint';
  return [
    { id: 'markings.pick', label: 'Pick', group: GROUP, keys: ['V'], scope: SCOPE, shadows: ['tool.select'], desc: 'Pick markings without drawing', noPalette: true },
    { id: 'markings.line', label: 'Draw line', group: GROUP, keys: ['L'], scope: SCOPE, shadows: ['tool.lanes'], desc: 'Two anchors, on one arm or across the junction', noPalette: true },
    { id: 'markings.crosswalk', label: 'Draw crosswalk', group: GROUP, keys: ['C'], scope: SCOPE, desc: 'One click across an arm', noPalette: true },
    { id: 'markings.stop', label: 'Draw stop line', group: GROUP, keys: ['X'], scope: SCOPE, desc: 'One click across the incoming lanes of an arm', noPalette: true },
    { id: 'markings.filler', label: 'Draw area', group: GROUP, keys: ['F'], scope: SCOPE, shadows: ['camera.tilt'], desc: 'Anchors round an area; Enter closes it', noPalette: true },
    { id: 'markings.stamp', label: 'Stamp arrows and text', group: GROUP, keys: ['T'], scope: SCOPE, shadows: ['tool.traffic'], desc: 'On a lane', noPalette: true },
    { id: 'markings.erase', label: 'Eraser', group: GROUP, keys: ['E'], scope: SCOPE, shadows: ['camera.rotateRight'], desc: 'Click any marking, automatic ones too, to remove it', noPalette: true },
    { id: 'markings.close', label: 'Close the area', group: GROUP, keys: ['Enter'], scope: SCOPE, noPalette: true, desc: 'At a junction, after clicking its corners' },
    { id: 'markings.delete', label: 'Delete selected', group: GROUP, keys: ['Delete', 'Backspace'], scope: SCOPE, shadows: ['edit.delete', 'select.delete', 'select.deleteEndpoint'], desc: 'Automatic markings can be brought back from the panel', noPalette: true },
    { id: 'markings.cycle', label: 'Next or previous marking', group: GROUP, keys: ['Tab', 'Shift+Tab'], scope: SCOPE, shadows: ['tab.next', 'tab.prev'], noPalette: true },
    { id: 'markings.style', label: 'Previous or next style', group: GROUP, keys: ['[', ']'], scope: SCOPE, noPalette: true },
    { id: 'markings.width', label: 'Thinner or wider', group: GROUP, keys: ['-', '='], scope: SCOPE, repeat: true, noPalette: true },
    { id: 'markings.nudge', label: 'Nudge the point under the cursor', group: GROUP, keys: ['ArrowLeft', 'ArrowRight', 'Shift+ArrowLeft', 'Shift+ArrowRight'], scope: SCOPE, repeat: true, desc: '5 cm a press, 25 cm with Shift', noPalette: true },
    { id: 'markings.back', label: 'Move a crosswalk or stop line along its arm', group: GROUP, keys: ['ArrowUp', 'ArrowDown', 'Shift+ArrowUp', 'Shift+ArrowDown'], scope: SCOPE, repeat: true, noPalette: true },
    { id: 'markings.duplicate', label: 'Duplicate selected markings', group: GROUP, keys: ['Mod+D'], scope: SCOPE, run: () => tool().duplicate() },
    { id: 'markings.selectAll', label: 'Select every marking here', group: GROUP, keys: ['Mod+A'], scope: SCOPE, run: () => tool().selectAll() },
    // With nothing selected, or over a single marking, app/clipboard.ts hands these to the middle-click copy and paste.
    { id: 'markings.copy', label: 'Copy junction markings', group: GROUP, keys: ['Mod+C'], scope: SCOPE, shadows: ['edit.copyHover'], desc: 'The selected markings; with none selected, the style under the cursor', run: () => void tool().copy() },
    { id: 'markings.paste', label: 'Paste junction markings', group: GROUP, keys: ['Mod+V'], scope: SCOPE, shadows: ['edit.pasteHover'], desc: 'Turned to fit the arms here; over a marking, a copied style goes onto it', run: () => void tool().paste() },
    {
      id: 'markings.savePreset',
      label: 'Save the selected look as a preset',
      group: GROUP,
      keys: ['Alt+P'],
      scope: SCOPE,
      run: () => {
        const look = tool().selectedLook();
        if (!look) {
          ui.toast('Pick a marking first.', 'warning');
          return;
        }
        const kind = 'fill' in look ? 'filler' : 'line';
        const name = `My ${kind === 'line' ? 'line' : 'area'} ${new Date().toLocaleTimeString()}`;
        savePreset({ id: libraryId('preset'), name, kind, style: look } as MarkingPreset);
        ui.toast(`Saved preset ${name}.`, 'info');
      },
    },
    {
      id: 'markings.saveTemplate',
      label: 'Save junction markings as a template',
      group: GROUP,
      keys: [],
      scope: SCOPE,
      run: () => {
        const host = tool().host;
        if (!host || !editing()) return;
        const name = `Junction ${new Date().toLocaleTimeString()}`;
        saveTemplate(captureTemplate(ui.net, host, name, libraryId('template')));
        ui.toast(`Saved template ${name}.`, 'info');
      },
    },
    { id: 'markings.rotate', label: 'Rotate the applied template', group: GROUP, keys: [], scope: SCOPE, run: () => tool().refit('rotate') },
    { id: 'markings.mirror', label: 'Mirror the applied template', group: GROUP, keys: [], scope: SCOPE, run: () => tool().refit('mirror') },
    { id: 'markings.convert', label: 'Make the selected automatic marking editable', group: GROUP, keys: [], scope: SCOPE, run: () => void tool().convertAuto() },
    { id: 'markings.restoreAll', label: 'Bring back every automatic marking here', group: GROUP, keys: [], scope: SCOPE, run: () => tool().restoreAllAuto() },
  ];
}
