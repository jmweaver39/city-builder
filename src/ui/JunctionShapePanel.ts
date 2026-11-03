/** The floating panel of the Junction shape tool: every corner, arm and island of one junction. */
import type { Id } from '../core/types';
import { armInfos, cornerInfos, RADIUS_MAX, RADIUS_MIN } from '../core/junctionShape';
import type { UiContext } from './context';
import { checkbox, clear, el, iconButton, row, sliderInput } from './dom';
import { ICONS } from './icons';
import type { Panel } from './Panel';

/** One corner, arm or island: a block of fields under a name and a reset button. */
const BOX: Partial<CSSStyleDeclaration> = { display: 'block', background: 'var(--surface-2)', borderRadius: 'var(--r-md)', padding: '4px 8px 6px', marginBottom: '6px' };
const HEAD: Partial<CSSStyleDeclaration> = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px', fontSize: 'var(--fs-sm)' };

const signed = (v: number, digits = 1) => `${v > 0 ? '+' : ''}${v.toFixed(digits)} m`;

export class JunctionShapePanel {
  private shown = '';

  constructor(private readonly ui: UiContext, private readonly nodeId: Id, private readonly panel: Panel) {
    panel.setTitle('Junction shape');
    this.render();
  }

  private get tool() {
    return this.ui.tools.junctionShape;
  }

  private key(): string {
    const node = this.ui.net.getNode(this.nodeId);
    return JSON.stringify([node?.control.shape ?? null, this.tool.problem, this.tool.islandMode, this.tool.selected, node?.segments]);
  }

  /** Rebuild only when something shown has changed. */
  sync(): void {
    if (this.key() !== this.shown) this.render();
  }

  private name(seg: Id): string {
    const s = this.ui.net.getSegment(seg);
    return s?.overrides.name || (s ? this.ui.net.roadTypeOf(seg).name : `Road ${seg}`);
  }

  private render(): void {
    const { net, tools } = this.ui;
    const node = net.getNode(this.nodeId);
    const body = this.panel.body;
    if (!node) return;
    this.shown = this.key();
    clear(body);
    const tool = this.tool;
    const button = (text: string, cls: string, onClick: () => void, tip?: string) =>
      el('button', { class: `btn ${cls}`, text, tip, attrs: { type: 'button' }, on: { click: onClick } });

    body.append(
      el(
        'div',
        { class: 'btn-row' },
        button('Drag handles', tool.islandMode ? '' : 'primary', () => tool.setIslandMode(false)),
        button('Add island', tool.islandMode ? 'primary' : '', () => tool.setIslandMode(true), 'Click two lane boundaries on one arm. Key I'),
        button('Markings', '', () => {
          tools.setTool('nodeMarkings');
          tools.nodeMarkings.open(this.nodeId);
        }, 'Back to Node markings for this junction'),
      ),
    );
    if (tool.problem) body.append(el('div', { class: 'small', text: tool.problem, style: { color: '#ff7b7b', margin: '4px 0' } }));

    const corners = cornerInfos(net, this.nodeId);
    body.append(el('div', { class: 'section-title', text: 'Corners' }));
    const names = (a: Id, b: Id) => `${this.name(a)} to ${this.name(b)}`;
    for (const c of corners) {
      const box = el('div', { style: BOX });
      box.append(
        el('div', { style: HEAD },
          el('span', { class: 'phase-name', text: names(c.segmentId, c.nextSegmentId) }),
          iconButton(ICONS.undo, { tip: 'Reset this corner', onClick: () => tool.resetCorner(c.key) }),
        ),
      );
      if (Number.isFinite(c.radius)) {
        box.append(row('Kerb radius', sliderInput(Math.round(c.radius * 2) / 2, { min: RADIUS_MIN, max: Math.min(RADIUS_MAX, 30), step: 0.5, format: (v) => `${v.toFixed(1)} m` }, (v) => tool.setValue('radius', c.key, v))));
      }
      if (c.hasSidewalk) {
        box.append(row('Sidewalk', checkbox(c.setting.sidewalk !== false, (v) => tool.setCornerSidewalk(c.key, v)), 'Take the sidewalk off this corner'));
        if (c.setting.sidewalk !== false) {
          box.append(row('Kerb line', sliderInput(c.setting.kerb ?? 0, { min: -Math.min(c.walkA, c.walkB), max: 4, step: 0.25, format: (v) => signed(v, 2) }, (v) => tool.setValue('kerb', c.key, v)), 'Out into the road for a kerb extension, back for more road'));
        }
      }
      body.append(box);
    }
    if (!corners.length) body.append(el('div', { class: 'small muted', text: 'This node has no corners to shape.' }));

    body.append(el('div', { class: 'section-title', text: 'Arms' }));
    for (const a of armInfos(net, this.nodeId)) {
      const box = el('div', { style: BOX });
      box.append(
        el('div', { style: HEAD },
          el('span', { class: 'phase-name', text: this.name(a.segmentId) }),
          iconButton(ICONS.undo, { tip: 'Reset this arm', onClick: () => tool.resetArm(a.segmentId) }),
        ),
        row('Trim', sliderInput(a.setting.trim ?? 0, { min: -10, max: 30, step: 0.5, format: (v) => signed(v) }, (v) => tool.setValue('trim', String(a.segmentId), v)), 'Move the cut line out for a larger junction, in for a tighter one'),
      );
      if (a.walkLeft > 0) box.append(row('Left kerb', sliderInput(a.setting.edgeLeft ?? 0, { min: -a.walkLeft, max: Math.max(a.spareLeft, 0), step: 0.25, format: (v) => signed(v, 2) }, (v) => tool.setValue('edgeLeft', String(a.segmentId), v)), 'Looking at the junction. Negative narrows the sidewalk, positive builds it out over spare road edge'));
      if (a.walkRight > 0) box.append(row('Right kerb', sliderInput(a.setting.edgeRight ?? 0, { min: -a.walkRight, max: Math.max(a.spareRight, 0), step: 0.25, format: (v) => signed(v, 2) }, (v) => tool.setValue('edgeRight', String(a.segmentId), v))));
      body.append(box);
    }

    const islands = node.control.shape?.islands ?? [];
    body.append(el('div', { class: 'section-title', text: `Islands (${islands.length})` }));
    for (const i of islands) {
      const box = el('div', { style: { ...BOX, ...(i.id === tool.selected ? { outline: '1px solid var(--accent)' } : {}) } });
      box.append(
        el('div', { style: HEAD },
          el('span', { class: 'phase-name', text: `On ${this.name(i.segmentId)}` }),
          iconButton(ICONS.trash, { tip: 'Remove island', onClick: () => tool.removeIsland(i.id) }),
        ),
        row('Back', sliderInput(i.back, { min: 0, max: 40, step: 0.5, format: (v) => `${v.toFixed(1)} m` }, (v) => tool.setValue('islandBack', String(i.id), v)), 'How far it runs back along the road'),
        row('Nose', sliderInput(i.reach, { min: 0, max: 20, step: 0.5, format: (v) => `${v.toFixed(1)} m` }, (v) => tool.setValue('islandReach', String(i.id), v)), 'How far it reaches into the junction. Turns it would block are dropped'),
      );
      body.append(box);
    }
    if (!islands.length) body.append(el('div', { class: 'small muted', text: 'Add island, then click two lane boundaries with room between them, as either side of a median.' }));

    body.append(
      el('div', { class: 'small muted', text: 'Drag the handles on the junction. Double-click a handle to reset it.' }),
      el('div', { class: 'btn-row', style: { marginTop: '6px' } }, button('Reset all', 'danger', () => tool.resetAll())),
    );
  }
}
