/** The floating list of a node's hand-placed markings. */
import type { Id, NodeFillStyle, NodeLineStyle, NodeMarking, PaintColor } from '../core/types';
import { NODE_LINE_STYLES } from '../tools/NodeMarkingTool';
import type { UiContext } from './context';
import { checkbox, clear, el, iconButton, row, selectInput, sliderInput } from './dom';
import { ICONS } from './icons';
import type { Panel } from './Panel';

const FILLS: { value: NodeFillStyle; label: string }[] = [
  { value: 'hatch', label: 'Hatch' },
  { value: 'chevron', label: 'Chevron' },
  { value: 'solid', label: 'Solid colour' },
];
const COLORS: { value: PaintColor; label: string }[] = [
  { value: 'white', label: 'White' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'blue', label: 'Blue' },
  { value: 'red', label: 'Red' },
  { value: 'green', label: 'Green' },
];

function describe(m: NodeMarking): string {
  if (m.kind === 'filler') return `${FILLS.find((f) => f.value === m.fill)?.label ?? 'Filler'} area, ${m.color}`;
  return `${NODE_LINE_STYLES.find((s) => s.value === m.style)?.label ?? 'Line'}, ${m.color}`;
}

export class NodeMarkingPanel {
  private shown = '';

  constructor(private readonly ui: UiContext, private readonly nodeId: Id, private readonly panel: Panel) {
    panel.setTitle('Node markings');
    this.render();
  }

  private get tool() {
    return this.ui.tools.nodeMarkings;
  }

  /** Rebuild only when something this panel shows has changed, not on every hover. */
  sync(): void {
    const s = this.ui.tools.settings.nodeMarking;
    const node = this.ui.net.getNode(this.nodeId);
    const key = JSON.stringify([s.mode, this.tool.selected, node?.control.markings?.length, node?.control.hideAutoMarkings]);
    if (key !== this.shown) this.render();
  }

  private render(): void {
    const { net, tools } = this.ui;
    const node = net.getNode(this.nodeId);
    const body = this.panel.body;
    const s = tools.settings.nodeMarking;
    if (!node) return;
    const list = node.control.markings ?? [];
    const tool = this.tool;
    this.shown = JSON.stringify([s.mode, tool.selected, list.length, node.control.hideAutoMarkings]);
    clear(body);

    const modeBtn = (mode: 'line' | 'filler', text: string) =>
      el('button', {
        class: `btn ${s.mode === mode ? 'primary' : ''}`,
        text,
        attrs: { type: 'button' },
        on: {
          click: () => {
            s.mode = mode;
            tools.settingsChanged();
            this.render();
          },
        },
      });
    body.append(el('div', { class: 'btn-row' }, modeBtn('line', 'Line'), modeBtn('filler', 'Filler area')));

    const selected = list.find((m) => m.id === tool.selected);
    body.append(el('div', { class: 'section-title', text: selected ? 'Selected marking' : 'New marking' }));
    if (selected) this.renderSelected(body, selected);
    else this.renderDefaults(body);

    body.append(el('div', { class: 'section-title', text: `Markings here (${list.length})` }));
    const rows = el('div', { class: 'phase-list' });
    for (const m of list) {
      rows.append(
        el(
          'div',
          { class: `phase-row ${m.id === tool.selected ? 'selected' : ''}` },
          el('span', {
            class: 'phase-name',
            text: describe(m),
            on: {
              click: () => {
                tool.select(m.id);
                this.render();
              },
            },
          }),
          iconButton(ICONS.trash, {
            tip: 'Delete marking',
            onClick: () => {
              tool.remove(m.id);
              this.render();
            },
          }),
        ),
      );
    }
    if (!list.length) rows.append(el('div', { class: 'small muted', text: 'None yet. Click two anchors to add a line.' }));
    body.append(
      rows,
      row('Hide automatic', checkbox(!!node.control.hideAutoMarkings, (v) => {
        tool.setHideAuto(v);
      }), 'Hide the automatic stop lines and crosswalks here'),
      el('div', { class: 'btn-row', style: { marginTop: '6px' } }, el('button', {
        class: 'btn danger',
        text: 'Clear all',
        attrs: { type: 'button' },
        on: {
          click: () => {
            tool.clearAll();
            this.render();
          },
        },
      })),
    );
  }

  private renderDefaults(body: HTMLElement): void {
    const { tools } = this.ui;
    const s = tools.settings.nodeMarking;
    if (s.mode === 'line') {
      body.append(
        row('Style', selectInput(NODE_LINE_STYLES, s.style, (v: NodeLineStyle) => {
          s.style = v;
          if (v.startsWith('crosswalk')) s.width = 3;
          else if (v === 'stopLine') s.width = 0.5;
          else s.width = 0.16;
          tools.settingsChanged();
          this.render();
        })),
        row('Follow lanes', checkbox(s.curved, (v) => {
          s.curved = v;
          tools.settingsChanged();
        }), 'Lines between arms curve with the lanes. Off draws them straight'),
      );
    } else {
      body.append(
        row('Fill', selectInput(FILLS, s.fill, (v) => {
          s.fill = v;
          tools.settingsChanged();
        })),
      );
    }
    body.append(
      row('Colour', selectInput(COLORS, s.color, (v) => {
        s.color = v;
        tools.settingsChanged();
      })),
      row('Width', sliderInput(s.mode === 'line' ? s.width : s.fillWidth, { min: 0.1, max: 6, step: 0.02, format: (v) => `${v.toFixed(2)} m` }, (v) => {
        if (s.mode === 'line') s.width = v;
        else s.fillWidth = v;
        tools.settingsChanged();
      })),
    );
  }

  private renderSelected(body: HTMLElement, m: NodeMarking): void {
    const tool = this.tool;
    if (m.kind === 'line') {
      body.append(
        row('Style', selectInput(NODE_LINE_STYLES, m.style, (v: NodeLineStyle) => {
          tool.update({ style: v }, 'style');
          this.render();
        })),
        row('Straight', checkbox(m.straight, (v) => tool.update({ straight: v }, 'straight'))),
      );
    } else {
      body.append(
        row('Fill', selectInput(FILLS, m.fill, (v) => {
          tool.update({ fill: v }, 'fill');
          this.render();
        })),
      );
    }
    body.append(
      row('Colour', selectInput(COLORS, m.color, (v) => {
        tool.update({ color: v }, 'color');
        this.render();
      })),
      row('Width', sliderInput(m.width, { min: 0.1, max: 6, step: 0.02, format: (v) => `${v.toFixed(2)} m` }, (v) => tool.update({ width: v }, 'width'))),
      el('div', { class: 'btn-row' }, el('button', {
        class: 'btn',
        text: 'Done',
        attrs: { type: 'button' },
        on: {
          click: () => {
            tool.select(null);
            this.render();
          },
        },
      })),
    );
  }
}
