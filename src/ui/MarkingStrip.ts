/**
 * The Markings tool's whole interface: one compact strip in the bottom tray, and a
 * side panel ("More") for everything else, collapsed until asked for.
 *
 *   strip   draw tools (icons) | the look as one live swatch (opens the standards) |
 *           colour, width, dash: only what applies to what is drawn or picked |
 *           stamps when stamping | where the tool is working | More
 *   panel   the selected marking's full properties and parts, the markings here and
 *           those taken away, points, templates (MarkingsEditor without its own draw
 *           row and presets); along a road, the look's finer measures.
 *
 * Swatches are drawn by the game's renderer (render/swatch.ts).
 */
import type { DecalKind, LineStyleSpec, MarkingPreset, NodeLineMarking, PaintColor } from '../core/types';
import { LINE_STYLE_INFO, PAINT_HEX, lineStyleInfo, markingHex, resolvedStyle, styleOf } from '../core/markingStyle';
import { FILL_STANDARDS, LINE_STANDARDS, matchStandard } from '../core/paintStandard';
import { resolveDecal } from '../core/roadPaint';
import type { SwatchSubject } from '../render/swatch';
import { STAMP_KINDS } from '../tools/MarkingTool';
import type { MarkingDraw } from '../tools/types';
import type { UiContext } from './context';
import { clear, el, row, selectInput, sliderInput, textInput } from './dom';
import { ICONS, type IconName } from './icons';
import { MarkingsEditor } from './MarkingsEditor';
import { allPresets } from './markingLibrary';
import { swatchElement } from './swatches';

const DRAWS: { value: MarkingDraw; icon: IconName; label: string; key: string; tip: string }[] = [
  { value: 'select', icon: 'select', label: 'Pick', key: '1', tip: 'Pick a marking to change it; on a road with nothing picked, open its road markings' },
  { value: 'line', icon: 'markLine', label: 'Line', key: '2', tip: 'Along a road: click a start and an end. At a junction: click two anchors' },
  { value: 'crosswalk', icon: 'markCrossing', label: 'Crossing', key: '3', tip: 'Click on a road, or on a junction arm, to lay a crossing' },
  { value: 'stop', icon: 'markStop', label: 'Stop', key: '4', tip: 'A stop line or give-way teeth across a lane or an arm' },
  { value: 'filler', icon: 'markArea', label: 'Area', key: '5', tip: 'Along a road: two clicks for its sides. At a junction: click anchors round it' },
  { value: 'stamp', icon: 'markStamp', label: 'Stamp', key: '6', tip: 'Arrows and text, on a lane' },
  { value: 'erase', icon: 'markErase', label: 'Erase', key: '7', tip: 'Click any marking, automatic ones too, to remove it' },
];

const COLOURS: PaintColor[] = ['white', 'yellow', 'blue', 'red', 'green'];

const STAMPS: { kind: DecalKind; label: string }[] = [
  { kind: 'arrowStraight', label: 'Ahead' },
  { kind: 'arrowLeft', label: 'Left' },
  { kind: 'arrowRight', label: 'Right' },
  { kind: 'arrowStraightLeft', label: 'Ahead or left' },
  { kind: 'arrowStraightRight', label: 'Ahead or right' },
  { kind: 'text', label: 'Text' },
];

const SIDE_KEY = 'cl-markings-side-open';

function readOpen(): boolean {
  try {
    return localStorage.getItem(SIDE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOpen(on: boolean): void {
  try {
    localStorage.setItem(SIDE_KEY, on ? '1' : '0');
  } catch {
    /* private window: the panel just starts closed */
  }
}

/** Which family of looks a draw takes. */
function familyOf(draw: MarkingDraw): 'line' | 'crosswalk' | 'stop' | 'filler' | null {
  return draw === 'line' || draw === 'crosswalk' || draw === 'stop' || draw === 'filler' ? draw : null;
}

function subjectOf(p: MarkingPreset | { kind: 'line'; style: LineStyleSpec }): SwatchSubject {
  if (p.kind === 'filler') return { kind: 'area', spec: p.style };
  const fam = lineStyleInfo(p.style.style).family;
  return fam === 'crosswalk' || fam === 'stop' || fam === 'teeth' ? { kind: 'crossing', spec: p.style } : { kind: 'line', spec: p.style };
}

export class MarkingStrip {
  private readonly strip = el('div', { class: 'mk-strip', attrs: { role: 'toolbar', 'aria-label': 'Markings' } });
  private readonly side = el('aside', { class: 'mk-side panel', attrs: { 'aria-label': 'Markings, more' } });
  private readonly sideBody = el('div', { class: 'mk-side-body' });
  private popover: HTMLElement | null = null;
  private editor: MarkingsEditor | null = null;
  private editorKey = '';
  private shown = '';
  private open = readOpen();
  private readonly offNet: () => void;
  private readonly onDoc = (e: Event) => {
    if (this.popover && !this.popover.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.mk-look')) this.closePopover();
  };
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.popover) {
      this.closePopover();
      e.stopPropagation();
    }
  };

  constructor(private readonly ui: UiContext, container: HTMLElement) {
    container.append(this.strip);
    this.side.append(
      el(
        'div',
        { class: 'mk-side-head' },
        el('span', { class: 'mk-side-title', text: 'Markings' }),
        el('button', { class: 'icon-btn mk-side-close', html: ICONS.close, tip: 'Close', attrs: { type: 'button', 'aria-label': 'Close more' }, on: { click: () => this.setOpen(false) } }),
      ),
      this.sideBody,
    );
    ui.host.append(this.side);
    this.offNet = ui.net.onChange(() => this.sync());
    document.addEventListener('pointerdown', this.onDoc, true);
    document.addEventListener('keydown', this.onKey, true);
    this.render();
  }

  private get tool() {
    return this.ui.tools.markings;
  }

  private get node() {
    return this.ui.tools.nodeMarkings;
  }

  /** The look being edited: the picked marking's, else the next one's. */
  private look(): { spec: LineStyleSpec | null; fill: boolean; target: 'decal' | 'node' | 'next' } {
    const { net } = this.ui;
    const d = this.tool.selectedDecal !== null ? net.decals.find((x) => x.id === this.tool.selectedDecal) : undefined;
    if (d?.style) return { spec: d.style, fill: false, target: 'decal' };
    const host = this.node.host;
    if (host && this.node.selection.length === 1) {
      const m = net.markingsOf(host).find((x) => x.id === this.node.selection[0]);
      if (m?.kind === 'line') return { spec: styleOf(m), fill: false, target: 'node' };
      if (m?.kind === 'filler') return { spec: null, fill: true, target: 'node' };
    }
    return { spec: this.tool.currentLook(), fill: this.tool.draw === 'filler', target: 'next' };
  }

  private applyPatch(patch: Partial<LineStyleSpec>): void {
    const l = this.look();
    if (!l.spec) return;
    const next = { ...l.spec, ...patch };
    if (l.target === 'node') this.node.update(patch as Partial<NodeLineMarking>, Object.keys(patch).join('-'));
    else this.tool.applyLook(next);
    this.sync(true);
  }

  private key(): string {
    const s = this.ui.tools.settings;
    const l = this.look();
    const host = this.node.host;
    return JSON.stringify([s.nodeMarking.draw, l.spec, l.fill, l.target, s.paint.kind, s.paint.color, s.paint.text, s.nodeMarking.fill, host, this.node.selection, this.tool.selectedDecal, this.open]);
  }

  /** Refresh when anything shown changed; never under a field being typed in. */
  sync(force = false): void {
    const focus = document.activeElement;
    const typing = focus instanceof HTMLInputElement && (this.strip.contains(focus) || this.side.contains(focus));
    if (!typing && (force || this.key() !== this.shown)) this.render();
    this.syncSide();
  }

  private render(): void {
    this.shown = this.key();
    clear(this.strip);
    const draw = this.tool.draw;
    const s = this.ui.tools.settings;
    // Draw tools, icons only; name, what it does and its key in the tooltip.
    const draws = el('div', { class: 'mk-group mk-draws', attrs: { role: 'radiogroup', 'aria-label': 'Draw' } });
    for (const d of DRAWS) {
      draws.append(
        el('button', {
          class: `icon-btn mk-draw ${draw === d.value ? 'active' : ''}`,
          html: ICONS[d.icon],
          tip: d.label,
          desc: d.tip,
          keyHint: d.key,
          dataset: { pick: d.value },
          attrs: { type: 'button', role: 'radio', 'aria-label': d.label, 'aria-checked': String(draw === d.value) },
          on: { click: () => this.tool.setDraw(d.value) },
        }),
      );
    }
    this.strip.append(draws);

    const l = this.look();
    const fam = familyOf(draw);
    // Only what applies: the look of what is drawn next, or of what Pick picked.
    const showLook = fam !== null || (draw === 'select' && l.target !== 'next');
    if (showLook) {
      this.strip.append(el('div', { class: 'mk-sep' }));
      const look = el('div', { class: 'mk-group' });
      // The look as one live swatch: click for the standards and presets.
      const subject: SwatchSubject | null = l.spec ? subjectOf({ kind: 'line', style: l.spec }) : l.fill ? { kind: 'area', spec: { fill: s.nodeMarking.fill, color: s.nodeMarking.color, width: s.nodeMarking.fillWidth, ...s.nodeMarking.fillExtra } } : null;
      const std = l.spec ? matchStandard(l.spec) : null;
      const name = l.spec ? (std?.name ?? `${lineStyleInfo(l.spec.style).label} (own)`) : 'Area';
      if (subject) {
        look.append(
          el(
            'button',
            { class: 'mk-look', tip: name, desc: 'Click for the standard markings and presets', attrs: { type: 'button', 'aria-label': `Look: ${name}`, 'aria-haspopup': 'dialog' }, on: { click: () => this.togglePopover() } },
            swatchElement(this.ui.renderer, subject, 52, 26),
            el('span', { class: 'mk-caret', html: ICONS.caret }),
          ),
        );
      }
      if (l.spec) {
        const spec = l.spec;
        // Colour: the five paints, the picked one ringed.
        const dots = el('div', { class: 'mk-dots', attrs: { role: 'radiogroup', 'aria-label': 'Colour' } });
        for (const c of COLOURS) {
          const on = !spec.hex && spec.color === c;
          dots.append(
            el('button', {
              class: `mk-dot ${on ? 'active' : ''}`,
              tip: c[0].toUpperCase() + c.slice(1),
              style: { background: PAINT_HEX[c] },
              attrs: { type: 'button', role: 'radio', 'aria-label': c, 'aria-checked': String(on) },
              on: { click: () => this.applyPatch({ color: c, hex: undefined }) },
            }),
          );
        }
        if (spec.hex) dots.append(el('span', { class: 'mk-dot active', tip: spec.hex, style: { background: markingHex(spec) } }));
        look.append(dots);
        // Width (depth for a crossing), a stepper.
        const crossing = lineStyleInfo(spec.style).family === 'crosswalk';
        const step = crossing ? 0.5 : 0.02;
        const fmt = (v: number) => (crossing ? `${v.toFixed(1)} m` : `${Math.round(v * 100)} cm`);
        look.append(
          el(
            'div',
            { class: 'mk-stepper', tip: crossing ? 'Depth' : 'Width', attrs: { role: 'group', 'aria-label': crossing ? 'Depth' : 'Width' } },
            el('button', { class: 'mk-step', text: '−', attrs: { type: 'button', 'aria-label': 'Narrower' }, on: { click: () => this.applyPatch({ width: Math.max(0.05, Math.round((spec.width - step) * 100) / 100) }) } }),
            el('span', { class: 'mk-step-value', text: fmt(spec.width) }),
            el('button', { class: 'mk-step', text: '+', attrs: { type: 'button', 'aria-label': 'Wider' }, on: { click: () => this.applyPatch({ width: Math.round((spec.width + step) * 100) / 100 }) } }),
          ),
        );
        // Solid or dashed, for lines.
        if (lineStyleInfo(spec.style).family === 'line') {
          const dashed = spec.style !== 'solid' && spec.style !== 'double';
          look.append(
            el('button', {
              class: `icon-btn mk-dash ${dashed ? 'active' : ''}`,
              html: dashed ? '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M3 12h4M10 12h4M17 12h4"/></svg>' : '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M3 12h18"/></svg>',
              tip: dashed ? 'Dashed: click for solid' : 'Solid: click for dashed',
              attrs: { type: 'button', 'aria-pressed': String(dashed), 'aria-label': 'Dashed' },
              on: { click: () => this.applyPatch(dashed ? { style: 'solid', dash: undefined, space: undefined } : { style: 'dashed', dash: undefined, space: undefined }) },
            }),
          );
        }
      }
      this.strip.append(look);
    }

    if (draw === 'stamp') {
      this.strip.append(el('div', { class: 'mk-sep' }));
      const stamps = el('div', { class: 'mk-group mk-stamps', attrs: { role: 'radiogroup', 'aria-label': 'Stamp' } });
      for (const st of STAMPS) {
        const on = s.paint.kind === st.kind;
        stamps.append(
          el(
            'button',
            {
              class: `mk-stamp ${on ? 'active' : ''}`,
              tip: st.label,
              attrs: { type: 'button', role: 'radio', 'aria-label': st.label, 'aria-checked': String(on) },
              on: {
                click: () => {
                  s.paint.kind = st.kind;
                  s.paint.width = st.kind === 'text' ? 2 : 1;
                  this.ui.tools.settingsChanged();
                  this.sync(true);
                },
              },
            },
            st.kind === 'text' ? el('span', { class: 'mk-stamp-text', text: 'Aa' }) : swatchElement(this.ui.renderer, { kind: 'stamp', decal: st.kind, color: s.paint.color }, 30, 30),
          ),
        );
      }
      const dots = el('div', { class: 'mk-dots' });
      for (const c of COLOURS) {
        dots.append(
          el('button', {
            class: `mk-dot ${s.paint.color === c ? 'active' : ''}`,
            tip: c,
            style: { background: PAINT_HEX[c] },
            attrs: { type: 'button', 'aria-label': c },
            on: {
              click: () => {
                s.paint.color = c;
                this.ui.tools.settingsChanged();
                this.sync(true);
              },
            },
          }),
        );
      }
      stamps.append(dots);
      if (s.paint.kind === 'text') {
        const t = textInput(s.paint.text, 'Text', (v) => {
          s.paint.text = v;
          this.ui.tools.settingsChanged();
        });
        t.classList.add('mk-text');
        stamps.append(t);
      }
      this.strip.append(stamps);
    }

    // Where the tool is working, and More.
    const tail = el('div', { class: 'mk-group mk-tail' });
    const host = this.node.host;
    if (host) {
      const label = host.kind === 'node' ? 'Junction' : 'Road markings';
      tail.append(
        el(
          'span',
          { class: 'mk-context', tip: host.kind === 'node' ? 'Designing this junction' : 'Markings of this stretch of road' },
          el('span', { text: label }),
          el('button', { class: 'mk-context-close', html: ICONS.close, tip: 'Done here', attrs: { type: 'button', 'aria-label': 'Done here' }, on: { click: () => this.leaveHost() } }),
        ),
      );
    }
    if (this.tool.selectedDecal !== null) {
      tail.append(el('button', { class: 'icon-btn', html: ICONS.trash, tip: 'Remove the picked mark', keyHint: 'Del', attrs: { type: 'button', 'aria-label': 'Remove' }, on: { click: () => this.tool.removeSelectedDecal() } }));
    }
    const count = host ? this.ui.net.markingsOf(host).length : 0;
    tail.append(
      el(
        'button',
        {
          class: `icon-btn mk-more ${this.open ? 'active' : ''}`,
          html: ICONS.panelRight,
          tip: this.open ? 'Hide more' : 'More',
          desc: 'Every property, the markings here, those taken away, points and templates',
          attrs: { type: 'button', 'aria-label': 'More', 'aria-expanded': String(this.open) },
          on: { click: () => this.setOpen(!this.open) },
        },
        count ? el('span', { class: 'mk-badge', text: String(count) }) : null,
      ),
    );
    this.strip.append(tail);
  }

  /** Done with the open junction or road: back to marking along roads. */
  private leaveHost(): void {
    this.node.select(null);
    this.node.back();
    this.sync(true);
  }

  // -------------------------------------------------------------------------
  // The standards popover
  // -------------------------------------------------------------------------

  private togglePopover(): void {
    if (this.popover) this.closePopover();
    else this.openPopover();
  }

  private closePopover(): void {
    this.popover?.remove();
    this.popover = null;
  }

  private openPopover(): void {
    const draw = this.tool.draw;
    const l = this.look();
    const fam = l.spec ? lineStyleInfo(l.spec.style).family : draw === 'filler' ? 'filler' : 'line';
    const free = this.node.freeFlow;
    const presets = allPresets(this.ui.net.markingLibrary.presets ?? []).filter((p) => {
      if (p.kind === 'filler') return fam === 'filler';
      const f = lineStyleInfo(p.style.style).family;
      if (free && (f === 'crosswalk' || f === 'stop' || f === 'teeth')) return false;
      if (fam === 'crosswalk') return f === 'crosswalk';
      if (fam === 'stop' || fam === 'teeth') return f === 'stop' || f === 'teeth';
      if (fam === 'filler') return false;
      return f === 'line' || f === 'lane';
    });
    const pop = el('div', { class: 'mk-popover panel', attrs: { role: 'dialog', 'aria-label': 'Standard markings' } });
    const grid = el('div', { class: 'mk-grid' });
    for (const p of presets) {
      const builtin = p.id.startsWith('builtin-');
      const tip = builtin ? (LINE_STANDARDS.find((x) => `builtin-${x.id}` === p.id)?.tip ?? FILL_STANDARDS.find((x) => `builtin-${x.id}` === p.id)?.tip ?? p.name) : p.name;
      grid.append(
        el(
          'button',
          {
            class: 'mk-preset',
            tip: p.name,
            desc: tip,
            dataset: { preset: p.id },
            attrs: { type: 'button', 'aria-label': p.name },
            on: {
              click: () => {
                if (p.kind === 'line') this.tool.applyLook({ ...p.style });
                else this.node.applyPreset(p);
                this.closePopover();
                this.sync(true);
              },
            },
          },
          swatchElement(this.ui.renderer, subjectOf(p), 60, 30),
          el('span', { text: p.name }),
        ),
      );
    }
    pop.append(el('div', { class: 'mk-pop-title', text: builtinTitle(fam) }), grid);
    // Above the bar, beside the swatch; outside the toolbar so nothing clips it.
    const anchor = (this.strip.querySelector('.mk-look') ?? this.strip).getBoundingClientRect();
    const bar = this.strip.closest('.toolbar')?.getBoundingClientRect() ?? anchor;
    pop.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - 436))}px`;
    pop.style.bottom = `${window.innerHeight - bar.top + 8}px`;
    this.ui.host.append(pop);
    this.popover = pop;
  }

  // -------------------------------------------------------------------------
  // The side panel
  // -------------------------------------------------------------------------

  /** Open (or close) the side panel; remembered. */
  setOpen(on: boolean): void {
    this.open = on;
    writeOpen(on);
    this.sync(true);
  }

  /** Show the side panel for what the tool opened (a junction or a road). */
  reveal(): void {
    this.syncSide();
  }

  private syncSide(): void {
    this.side.classList.toggle('open', this.open);
    if (!this.open) {
      this.dropEditor();
      return;
    }
    const host = this.node.host;
    const key = host ? `${host.kind}:${host.id}` : `road:${this.tool.selectedDecal ?? ''}:${this.tool.draw}`;
    if (host) {
      if (this.editorKey !== key) {
        this.dropEditor();
        clear(this.sideBody);
        this.editorKey = key;
        (this.side.querySelector('.mk-side-title') as HTMLElement).textContent = host.kind === 'node' ? 'Junction markings' : 'Road markings';
        this.editor = new MarkingsEditor(this.ui, host, this.sideBody, { compact: true });
      } else this.editor?.sync();
      return;
    }
    if (this.editorKey !== key || this.editor) {
      this.dropEditor();
      this.editorKey = key;
      (this.side.querySelector('.mk-side-title') as HTMLElement).textContent = 'Markings';
      this.renderRoadSide();
    }
  }

  private dropEditor(): void {
    this.editor?.dispose();
    this.editor = null;
    this.editorKey = '';
  }

  /** Along a road: the picked mark, and the look's finer measures. */
  private renderRoadSide(): void {
    const body = this.sideBody;
    clear(body);
    const { net } = this.ui;
    const l = this.look();
    const d = this.tool.selectedDecal !== null ? net.decals.find((x) => x.id === this.tool.selectedDecal) : undefined;
    if (d) {
      const pts = resolveDecal(net, d).points;
      body.append(el('div', { class: 'section-title', text: 'Picked' }), el('div', { class: 'small', text: `${l.spec ? (matchStandard(l.spec)?.name ?? lineStyleInfo(l.spec.style).label) : d.kind}, ${pts.length} points` }));
    }
    if (l.spec) {
      const spec = l.spec;
      const r = resolvedStyle(spec);
      const info = lineStyleInfo(spec.style);
      const apply = (patch: Partial<LineStyleSpec>) => this.applyPatch(patch);
      const metres = (v: number) => `${v.toFixed(2)} m`;
      body.append(el('div', { class: 'section-title', text: 'Look' }));
      body.append(row('Style', selectInput(LINE_STYLE_INFO.filter((x) => x.family === info.family || (info.family === 'teeth' && x.family === 'stop') || (info.family === 'stop' && x.family === 'teeth')).map((x) => ({ value: x.value, label: x.label })), spec.style, (v) => apply({ style: v, dash: undefined, space: undefined, gap: undefined, ...lineStyleInfo(v).defaults }))));
      if (info.uses.includes('dash')) {
        body.append(row('Dash', sliderInput(r.dash, { min: 0.1, max: 8, step: 0.05, format: metres }, (v) => apply({ dash: v }))));
        body.append(row('Space', sliderInput(r.space, { min: 0, max: 15, step: 0.05, format: metres }, (v) => apply({ space: v }))));
      }
      if (info.uses.includes('gap')) body.append(row('Gap', sliderInput(r.gap, { min: 0.02, max: 2, step: 0.01, format: metres }, (v) => apply({ gap: v }))));
      body.append(row('Offset', sliderInput(r.offset, { min: -3, max: 3, step: 0.05, format: metres }, (v) => apply({ offset: v || undefined }))));
    }
    body.append(el('p', { class: 'small muted', text: 'Click a junction to design it: its markings, parts, points, templates and the automatic markings taken away show here.' }));
  }

  dispose(): void {
    this.offNet();
    document.removeEventListener('pointerdown', this.onDoc, true);
    document.removeEventListener('keydown', this.onKey, true);
    this.closePopover();
    this.dropEditor();
    this.side.remove();
    this.strip.remove();
  }
}

function builtinTitle(fam: string): string {
  return fam === 'crosswalk' ? 'Crossings' : fam === 'stop' || fam === 'teeth' ? 'Stop and give way' : fam === 'filler' ? 'Areas' : 'Lines';
}

export { STAMP_KINDS };
