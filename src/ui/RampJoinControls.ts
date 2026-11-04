/**
 * Road panel options for ramps meeting a highway lane (core/edgeMerge.ts): blend into
 * the edge lane or build a full junction, and whether an on-ramp adds a lane or an
 * off-ramp takes one. Alt swaps edge merge and full junction while drawing.
 */
import type { UiContext } from './context';
import { clear, el, numberInput, row, selectInput } from './dom';

const JOIN = [
  { value: 'edge', label: 'Blend into edge lane' },
  { value: 'full', label: 'Full junction' },
] as const;
const ON_RAMP = [
  { value: 'taper', label: 'Taper' },
  { value: 'add', label: 'Added lane, then merge' },
  { value: 'addFull', label: 'Added lane for good' },
] as const;
const OFF_RAMP = [
  { value: 'taper', label: 'Taper' },
  { value: 'drop', label: 'Edge lane exit only' },
] as const;

export function rampJoinOptions(ui: UiContext): HTMLElement {
  const box = el('div', { class: 'ramp-join-options' });
  const render = () => {
    clear(box);
    const j = ui.tools.settings.rampJoin;
    const changed = () => {
      ui.tools.settingsChanged();
      render();
    };
    box.append(
      el('div', { class: 'opt-title', text: 'Ramps onto highways' }),
      row('Join', selectInput(JOIN, j.edge ? 'edge' : 'full', (v) => {
        j.edge = v === 'edge';
        changed();
      }), 'Hold Alt while drawing for the other one'),
    );
    if (j.edge) {
      box.append(
        row('On-ramp', selectInput(ON_RAMP, j.onRamp, (v) => {
          j.onRamp = v;
          changed();
        })),
      );
      if (j.onRamp === 'add') {
        box.append(row('Lane length', numberInput(j.addLength, { min: 50, max: 2000, step: 50 }, (v) => {
          j.addLength = Math.max(50, v);
          ui.tools.settingsChanged();
        }), 'Metres the added lane runs before it merges'));
      }
      box.append(
        row('Off-ramp', selectInput(OFF_RAMP, j.offRamp, (v) => {
          j.offRamp = v;
          changed();
        })),
      );
    }
  };
  render();
  return box;
}
