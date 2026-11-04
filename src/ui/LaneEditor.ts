/**
 * The road inspector's lane editor: the selected road's cross section in the shared
 * lane strip (LaneStrip.ts). Drag lanes, the median and sidewalks about, add and
 * remove them, set each lane's use, direction, width and limit, then Apply. Applying
 * gives the road (or the whole road) a road type with that layout, in one undo step
 * (tools/laneEdit.ts), and names anything attached that could not be kept.
 */
import type { Id } from '../core/types';
import { applyLaneStrip, stripForSegment, stripKey, type LaneEditSource } from '../tools/laneEdit';
import { connectedRoad } from '../tools/roadOps';
import type { UiContext } from './context';
import { el, iconButton } from './dom';
import { ICONS } from './icons';
import { registerKeys } from './keymap';
import { laneEditKeys } from './laneKeys';
import { LaneStrip } from './LaneStrip';

const STRIP_PX = 316;

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const APPLY_ICON = svg('<path d="M5 12.5 10 17 19 7"/>');

/** The lane editor of the open road inspector, for the keys. */
let active: RoadLaneEditor | null = null;
let keysDone = false;

export class RoadLaneEditor {
  readonly el: HTMLElement;
  readonly strip: LaneStrip;
  private src: LaneEditSource | null = null;
  private readonly status = el('span', { class: 'lane-edit-status small' });
  private readonly applyBtn: HTMLButtonElement;
  private readonly revertBtn: HTMLButtonElement;

  constructor(
    private readonly ui: UiContext,
    private readonly segmentId: Id,
    private readonly whole: () => boolean,
  ) {
    if (!keysDone) {
      registerKeys(
        laneEditKeys(() => {
          const ed = active;
          if (!ed) return null;
          return { apply: () => ed.apply(), revert: () => ed.revert(), moveSelected: (s) => ed.strip.moveSelected(s), removeSelected: () => ed.strip.removeSelected() };
        }),
      );
      keysDone = true;
    }
    active = this;
    this.strip = new LaneStrip({
      widthPx: STRIP_PX,
      defaultSpeed: () => this.src?.roadSpeedKmh ?? 50,
      onPreview: () => this.showState(),
    });
    this.applyBtn = el('button', {
      class: 'btn primary lane-apply',
      html: `${APPLY_ICON}<span>Apply</span>`,
      keyHint: 'Mod+Enter',
      attrs: { type: 'button' },
      on: { click: () => this.apply() },
    });
    this.revertBtn = iconButton(ICONS.undo, { tip: 'Revert: back to the lanes the road has', class: 'lane-revert', onClick: () => this.revert() });
    this.el = el(
      'div',
      { class: 'lane-editor' },
      el('div', { class: 'small muted lane-edit-hint', text: 'Left to right, looking the way the road was drawn (↑). Drag to move, drag an edge to resize.' }),
      this.strip.stripEl,
      this.strip.addRow,
      this.strip.issues,
      this.strip.editor,
      el('div', { class: 'lane-edit-actions' }, this.status, this.revertBtn, this.applyBtn),
    );
    // Delete in the strip removes the picked element, never the road.
    this.strip.stripEl.addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        this.strip.removeSelected();
      }
    });
    this.el.addEventListener('pointerdown', () => (active = this));
    this.reload();
  }

  /** True while the strip differs from the road. */
  get pending(): boolean {
    return !!this.src && stripKey(this.strip.items) !== stripKey(this.src.items);
  }

  /** Read the road's lanes afresh. */
  reload(): void {
    this.src = stripForSegment(this.ui.net, this.segmentId);
    this.strip.setItems(this.src?.items ?? []);
    this.showState();
  }

  /** After a network change: follow the road unless there are edits waiting. */
  sync(): void {
    if (!this.ui.net.getSegment(this.segmentId)) return;
    const now = stripForSegment(this.ui.net, this.segmentId);
    if (!now || !this.src) return this.reload();
    if (now.signature !== this.src.signature || stripKey(now.items) !== stripKey(this.src.items)) {
      if (!this.pending) this.reload();
      else {
        // Someone else changed the road (undo, say): the edits no longer fit it.
        this.src = null;
        this.showState();
      }
    }
    this.showState();
  }

  revert(): void {
    this.reload();
  }

  apply(): boolean {
    const { ui } = this;
    if (!this.src) {
      ui.toast('The road changed since you began. Revert to start from its lanes as they are now.', 'warning');
      return false;
    }
    if (!this.pending) return false;
    const whole = this.whole();
    ui.history.hint(whole ? 'Edit lanes of the whole road' : 'Edit lanes');
    const report = applyLaneStrip(ui.net, this.src, this.strip.items, {
      whole,
      keepType: (id) => ui.tools.settings.roadType === id,
    });
    if (!report.ok) {
      ui.toast(report.error ?? 'Could not change the lanes.', 'error');
      return false;
    }
    const type = ui.net.roadType(report.typeId!);
    const what = report.segments.length > 1 ? `${report.segments.length} pieces of road` : 'The road';
    const made = report.createdTypes.length ? `, a new road type "${type?.name}"` : ` (${type?.name})`;
    ui.toast(`${what} now ${report.segments.length > 1 ? 'have' : 'has'} the new lanes${made}.`, 'info');
    if (report.lost.length) ui.toast(`Could not keep: ${report.lost.join(', ')}.`, 'warning');
    if (report.skipped.length) ui.toast(`${report.skipped.length} connected piece${report.skipped.length === 1 ? '' : 's'} left as ${report.skipped.length === 1 ? 'it was' : 'they were'}: the lanes do not line up with this one.`, 'warning');
    this.reload();
    return true;
  }

  private showState(): void {
    const pending = this.pending;
    const stale = !this.src;
    const problems = this.strip.issues.textContent ?? '';
    this.applyBtn.disabled = stale || !pending || problems.length > 0;
    this.revertBtn.disabled = !pending && !stale;
    const n = this.whole() ? connectedRoad(this.ui.net, this.segmentId).length : 1;
    this.applyBtn.dataset.tip = n > 1 ? `Apply to the whole road, ${n} pieces, as one undo step` : 'Apply to this road as one undo step';
    this.status.textContent = stale ? 'Road changed' : pending ? 'Not applied' : '';
    this.status.classList.toggle('tone-caution', pending || stale);
    this.el.classList.toggle('pending', pending);
  }

  dispose(): void {
    if (active === this) active = null;
  }
}
