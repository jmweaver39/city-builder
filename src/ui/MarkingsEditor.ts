/**
 * The junction (or road) markings editor, as a component that sits in any
 * container: a floating panel today, a tab of the Junction tool's shell tomorrow.
 *
 *   const editor = new MarkingsEditor(ui, { kind: 'node', id }, container);
 *   editor.sync();     // call when the tools or the network change
 *   editor.dispose();  // when the container goes away
 *
 * It shows, top to bottom: the draw tools in one row with their keys; presets;
 * the selected marking's properties inline; every marking grouped by arm, the
 * automatic ones badged; automatic markings taken away, to bring back; point
 * settings; templates, copy and paste. All edits go through the marking tool
 * (src/tools/NodeMarkingTool.ts), so every one is an undo step.
 */
import { autoItemKey, autoMarkingItems, type AutoItem } from '../render/autoItems';
import { captureTemplate, fitTemplate, isAmbiguous } from '../core/markingTemplates';
import { FILL_STYLE_INFO, LINE_STYLE_INFO, PAINT_HEX, fillStyleInfo, lineStyleInfo, markingHex, resolvedStyle } from '../core/markingStyle';
import { LINE_STANDARDS, matchFillStandard, matchStandard } from '../core/paintStandard';
import type { SwatchSubject } from '../render/swatch';
import { swatchElement } from './swatches';
import { framesOf, lineCrossings } from '../core/nodeMarkings';
import type {
  Id,
  LineRule,
  LineStyleSpec,
  MarkingHost,
  MarkingPreset,
  NodeFillStyle,
  NodeFillerMarking,
  NodeLineMarking,
  NodeLineStyle,
  NodeMarking,
  PaintColor,
  RuleBound,
} from '../core/types';
import type { MarkingDraw } from '../tools/types';
import type { UiContext } from './context';
import { checkbox, clear, el, iconButton, row, selectInput, sliderInput, textInput } from './dom';
import { ICONS } from './icons';
import {
  allPresets,
  allTemplates,
  deletePreset,
  deleteTemplate,
  libraryId,
  libraryVersion,
  noteColour,
  recentColours,
  savePreset,
  saveTemplate,
  storedClipboard,
  storeClipboard,
} from './markingLibrary';

const DRAW_ICON: Record<MarkingDraw, keyof typeof ICONS> = {
  select: 'select',
  line: 'markLine',
  crosswalk: 'markCrossing',
  stop: 'markStop',
  filler: 'markArea',
  stamp: 'markStamp',
  erase: 'markErase',
};

const DRAWS: { value: MarkingDraw; label: string; key: string; tip: string }[] = [
  { value: 'select', label: 'Pick', key: 'V', tip: 'Pick markings without drawing' },
  { value: 'line', label: 'Line', key: 'L', tip: 'Click two anchors, on one arm or across the junction' },
  { value: 'crosswalk', label: 'Crossing', key: 'C', tip: 'Click on an arm to lay a crosswalk across it' },
  { value: 'stop', label: 'Stop', key: 'X', tip: 'Click on an arm to lay a stop line across its incoming lanes' },
  { value: 'filler', label: 'Area', key: 'F', tip: 'Click anchors round an area; Enter closes it' },
  { value: 'erase', label: 'Erase', key: 'E', tip: 'Click any marking, automatic ones too, to remove it' },
];

const COLOURS: { value: PaintColor; label: string }[] = [
  { value: 'white', label: 'White' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'blue', label: 'Blue' },
  { value: 'red', label: 'Red' },
  { value: 'green', label: 'Green' },
];

const metres = (v: number) => `${v.toFixed(2)} m`;
const degrees = (v: number) => `${Math.round(v)}°`;

const CHIP: Partial<CSSStyleDeclaration> = { padding: '2px 8px', fontSize: 'var(--fs-sm)' };
const GROUP: Partial<CSSStyleDeclaration> = { background: 'var(--surface-2)', borderRadius: 'var(--r-md)', padding: '4px 6px', marginBottom: '6px' };
const BADGE: Partial<CSSStyleDeclaration> = { fontSize: '10px', padding: '0 5px', borderRadius: '8px', background: 'rgba(154,164,178,0.25)', color: 'var(--text-muted, #9aa4b2)', marginLeft: '6px' };

/** The standard name of a marking's look, or its style with "own look". */
function describe(m: NodeMarking): string {
  if (m.kind === 'filler') return matchFillStandard(m)?.name ?? `${fillStyleInfo(m.fill).label} area`;
  const std = matchStandard(m);
  return `${std ? std.name : `${lineStyleInfo(m.style).label} (own look)`}${m.rules?.length ? `, ${m.rules.length + 1} parts` : ''}`;
}

/** What a preview of a look shows. */
function subjectOf(p: MarkingPreset | { kind: 'line'; style: LineStyleSpec }): SwatchSubject {
  if (p.kind === 'filler') return { kind: 'area', spec: p.style };
  const fam = lineStyleInfo(p.style.style).family;
  return fam === 'crosswalk' || fam === 'stop' || fam === 'teeth' ? { kind: 'crossing', spec: p.style } : { kind: 'line', spec: p.style };
}

export class MarkingsEditor {
  private shown = '';
  private templateName = '';
  private presetName = '';
  private offLib: () => void;

  constructor(
    private readonly ui: UiContext,
    private readonly host: MarkingHost,
    private readonly root: HTMLElement,
    /** Compact: the Markings strip already has the draw tools and the standards. */
    private readonly opts: { compact?: boolean } = {},
  ) {
    const tool = this.tool;
    if (!tool.clipboard) tool.clipboard = storedClipboard();
    tool.onClipboard = (tpl) => storeClipboard(tpl);
    this.offLib = () => {};
    this.render();
  }

  private get tool() {
    return this.ui.tools.nodeMarkings;
  }

  private get nodeId(): Id | null {
    return this.host.kind === 'node' ? this.host.id : null;
  }

  private exists(): boolean {
    return this.host.kind === 'node' ? !!this.ui.net.getNode(this.host.id) : !!this.ui.net.getSegment(this.host.id);
  }

  private key(): string {
    const { net, tools } = this.ui;
    const node = this.nodeId !== null ? net.getNode(this.nodeId) : null;
    return JSON.stringify([
      tools.settings.nodeMarking,
      this.tool.selection,
      this.tool.selectedAuto?.key ?? null,
      net.markingsOf(this.host),
      net.pointsOf(this.host),
      node?.control.autoOff ?? null,
      node?.control.crosswalks ?? null,
      node?.control.hideAutoMarkings ?? null,
      libraryVersion(),
      net.markingLibrary,
      this.tool.templateFit?.index ?? null,
      node?.segments ?? null,
    ]);
  }

  /** Redraw when something shown changed, but never under a slider being dragged or a box being typed in. */
  sync(): void {
    if (!this.exists()) return;
    const focus = document.activeElement;
    if (focus && this.root.contains(focus) && (focus instanceof HTMLInputElement || focus instanceof HTMLTextAreaElement)) return;
    if (this.key() !== this.shown) this.render();
  }

  dispose(): void {
    this.offLib();
    if (this.tool.onClipboard) this.tool.onClipboard = null;
  }

  private button(text: string, onClick: () => void, opts: { primary?: boolean; tip?: string; key?: string; danger?: boolean } = {}): HTMLButtonElement {
    return el('button', {
      class: `btn ${opts.primary ? 'primary' : ''} ${opts.danger ? 'danger' : ''}`,
      text: opts.key ? `${text}` : text,
      tip: opts.tip,
      keyHint: opts.key,
      style: CHIP,
      attrs: { type: 'button' },
      on: { click: onClick },
    });
  }

  private roadName(seg: Id, end?: 'a' | 'b'): string {
    const s = this.ui.net.getSegment(seg);
    const name = s?.overrides.name || (s ? this.ui.net.roadTypeOf(seg).name : `Road ${seg}`);
    return end ? `${end === 'a' ? 'Start' : 'End'} of ${name}` : name;
  }

  private render(): void {
    if (!this.exists()) return;
    this.shown = this.key();
    const body = this.root;
    clear(body);
    if (!this.opts.compact) body.append(this.drawRow(), this.presetRow());
    body.append(this.selectedSection(), this.listSection());
    if (this.nodeId !== null) body.append(this.takenAwaySection());
    body.append(this.pointsSection(), this.templateSection(), this.footer());
  }

  // -------------------------------------------------------------------------
  // Draw tools and presets
  // -------------------------------------------------------------------------

  private drawRow(): HTMLElement {
    const tool = this.tool;
    return el(
      'div',
      { class: 'mode-row markings-draw', attrs: { role: 'radiogroup', 'aria-label': 'Draw' } },
      // Icons only; the name, what it does and its key are in the tooltip.
      ...DRAWS.filter((d) => !(tool.freeFlow && (d.value === 'crosswalk' || d.value === 'stop'))).map((d) =>
        el('button', {
          class: `mode-tab ${tool.draw === d.value ? 'active' : ''}`,
          html: ICONS[DRAW_ICON[d.value]],
          tip: d.label,
          desc: d.tip,
          keyHint: d.key,
          attrs: { type: 'button', role: 'radio', 'aria-label': d.label, 'aria-checked': String(tool.draw === d.value) },
          on: { click: () => tool.setDraw(d.value) },
        }),
      ),
    );
  }

  private presetRow(): HTMLElement {
    const { net } = this.ui;
    const presets = allPresets(net.markingLibrary.presets ?? []);
    const tool = this.tool;
    const card = (p: MarkingPreset) => {
      const tip = `${p.kind === 'line' ? (LINE_STANDARDS.find((s) => `builtin-${s.id}` === p.id)?.tip ?? p.name) : p.name}. ${tool.selection.length ? 'Click to give the selection this look' : 'Click to draw with this look'}`;
      const b = el(
        'button',
        {
          class: 'btn marking-standard',
          tip,
          attrs: { type: 'button', 'aria-label': p.name },
          dataset: { preset: p.id },
          style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', padding: '3px', width: '76px', flex: '0 0 76px', height: 'auto', minHeight: '58px', whiteSpace: 'normal', overflow: 'hidden', fontSize: '10px', lineHeight: '1.15' },
          on: { click: () => tool.applyPreset(p) },
        },
        // Drawn by the game's renderer with the real paint, not a sketch.
        swatchElement(this.ui.renderer, subjectOf(p), 68, 34),
        el('span', { text: p.name, style: { whiteSpace: 'normal', textAlign: 'center' } }),
      );
      if (!p.id.startsWith('builtin-')) {
        b.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          deletePreset(p.id);
        });
      }
      return b;
    };
    const grid = () => el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', margin: '4px 0 6px' } });
    const standards = grid();
    const mine = grid();
    // A free-flowing junction (highway ramps) offers no crossings or stop lines.
    const across = (p: MarkingPreset) => p.kind === 'line' && ['crosswalk', 'stop', 'teeth'].includes(lineStyleInfo(p.style.style).family);
    for (const p of presets) {
      if (tool.freeFlow && across(p)) continue;
      (p.id.startsWith('builtin-') ? standards : mine).append(card(p));
    }
    return el(
      'div',
      {},
      el('div', { class: 'section-title', text: 'Standard markings', tip: 'The very looks the roads paint: lane, edge and centre lines, stop lines, crossings' }),
      standards,
      mine.childElementCount ? el('div', { class: 'section-title', text: 'My presets' }) : null,
      mine.childElementCount ? mine : null,
    );
  }

  // -------------------------------------------------------------------------
  // The selection
  // -------------------------------------------------------------------------

  private selectedSection(): HTMLElement {
    const { net } = this.ui;
    const tool = this.tool;
    const list = net.markingsOf(this.host);
    const chosen = list.filter((m) => tool.selection.includes(m.id));
    const auto = tool.selectedAuto;
    const box = el('div', { style: GROUP });
    if (auto) {
      box.append(
        el('div', { class: 'section-title', text: 'Selected' }),
        el('div', { style: { display: 'flex', alignItems: 'center' } }, el('span', { text: auto.label }), el('span', { text: 'auto', style: BADGE })),
        el(
          'div',
          { class: 'btn-row', style: { marginTop: '6px' } },
          this.button('Remove', () => tool.removeAuto(auto), { danger: true, key: 'Del', tip: 'Take away just this one. Bring it back below' }),
          auto.ref.kind !== 'gore' ? this.button('Make editable', () => tool.convertAuto(auto), { tip: 'Replace it with a marking you can restyle and move' }) : null,
        ),
      );
      return box;
    }
    if (chosen.length > 1) {
      box.append(
        el('div', { class: 'section-title', text: `${chosen.length} selected` }),
        this.colourRow(chosen[0], (patch) => tool.update(patch, 'colour')),
        row('Width', sliderInput(chosen[0].width, { min: 0.05, max: 6, step: 0.01, format: metres }, (v) => tool.update({ width: v }, 'width'))),
        el(
          'div',
          { class: 'btn-row' },
          this.button('Duplicate', () => tool.duplicate(), { key: '⌘D' }),
          this.button('Delete', () => tool.remove(), { danger: true, key: 'Del' }),
          this.button('Done', () => tool.select(null)),
        ),
      );
      return box;
    }
    if (chosen.length === 1) {
      const m = chosen[0];
      box.append(el('div', { class: 'section-title', text: `Selected: ${describe(m)}` }));
      const preview = m.kind === 'line' ? subjectOf({ kind: 'line', style: m }) : subjectOf({ id: '', name: '', kind: 'filler', style: m });
      box.append(el('div', { style: { margin: '2px 0 6px' } }, swatchElement(this.ui.renderer, preview, 150, 40)));
      if (m.kind === 'line') this.lineFields(box, m);
      else this.fillFields(box, m);
      const look = tool.selectedLook();
      box.append(
        el(
          'div',
          { style: { display: 'flex', gap: '4px', alignItems: 'center', marginTop: '6px' } },
          textInput(this.presetName, 'Preset name', (v) => (this.presetName = v)),
          this.button('Save preset', () => {
            if (!look) return;
            const name = this.presetName.trim() || `${describe(m)} ${allPresets().length + 1}`;
            const preset = (m.kind === 'line' ? { id: libraryId('preset'), name, kind: 'line', style: look } : { id: libraryId('preset'), name, kind: 'filler', style: look }) as MarkingPreset;
            savePreset(preset);
            this.presetName = '';
            this.ui.toast(`Saved preset ${name}.`, 'info');
          }, { key: '⌥P' }),
        ),
        el(
          'div',
          { class: 'btn-row', style: { marginTop: '6px' } },
          this.button('Duplicate', () => tool.duplicate(), { key: '⌘D' }),
          this.button('Delete', () => tool.remove(), { danger: true, key: 'Del' }),
          this.button('Done', () => tool.select(null)),
        ),
      );
      return box;
    }
    box.append(el('div', { class: 'section-title', text: 'New marking' }));
    this.defaultFields(box);
    return box;
  }

  private colourRow(m: { color: PaintColor; hex?: string }, apply: (patch: { color?: PaintColor; hex?: string }) => void): HTMLElement {
    const picker = el('input', { attrs: { type: 'color', 'aria-label': 'Own colour' }, style: { width: '28px', height: '22px', padding: '0', border: 'none', background: 'none' } });
    picker.value = markingHex(m);
    picker.addEventListener('change', () => {
      noteColour(picker.value);
      apply({ hex: picker.value });
      picker.blur();
    });
    const swatch = (hex: string, onPick: () => void, label: string) =>
      el('button', {
        attrs: { type: 'button', 'aria-label': label },
        tip: label,
        style: { width: '18px', height: '18px', borderRadius: '50%', border: markingHex(m) === hex ? '2px solid var(--accent, #4fd1ff)' : '1px solid rgba(255,255,255,0.3)', background: hex, padding: '0' },
        on: { click: onPick },
      });
    const named = COLOURS.map((c) => swatch(PAINT_HEX[c.value], () => apply({ color: c.value, hex: undefined }), c.label));
    const recent = recentColours().map((hex) => swatch(hex, () => apply({ hex }), hex));
    return row('Colour', el('span', { style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' } }, ...named, ...recent, picker));
  }

  private lineStyleSelect(value: NodeLineStyle, onChange: (v: NodeLineStyle) => void, withEmpty = false): HTMLSelectElement {
    const options = LINE_STYLE_INFO.filter((s) => withEmpty || s.value !== 'empty').map((s) => ({ value: s.value, label: s.label }));
    return selectInput(options, value, onChange);
  }

  /** Fields of a line look, shared by lines, their parts and the defaults. */
  private styleFields(box: HTMLElement, spec: LineStyleSpec, apply: (patch: Partial<LineStyleSpec>, key: string) => void, withEmpty = false): void {
    const info = lineStyleInfo(spec.style);
    // Sliders show what is drawn: unset measures as the standard fills them in.
    const shown = resolvedStyle(spec);
    box.append(
      // A new style starts as its standard: unset dashes follow the road's speed.
      row('Style', this.lineStyleSelect(spec.style, (v) => apply({ style: v, dash: undefined, space: undefined, gap: undefined, ...lineStyleInfo(v).defaults }, 'style'), withEmpty)),
      this.colourRow(spec, (patch) => apply(patch, 'colour')),
      row(info.family === 'crosswalk' ? 'Depth' : info.family === 'lane' ? 'Lane width' : info.family === 'teeth' ? 'Tooth length' : 'Width', sliderInput(spec.width, { min: 0.05, max: info.family === 'crosswalk' || info.family === 'lane' ? 8 : 1.5, step: 0.01, format: metres }, (v) => apply({ width: v }, 'width'))),
    );
    const d = info.defaults;
    if (info.uses.includes('dash')) {
      const dashLabel = info.family === 'crosswalk' ? (spec.style === 'crosswalkChessboard' ? 'Square' : 'Stripe') : info.family === 'teeth' ? 'Tooth base' : spec.style === 'zigzag' ? 'Zig length' : 'Dash';
      box.append(row(dashLabel, sliderInput(spec.dash ?? shown.dash, { min: 0.1, max: 6, step: 0.05, format: metres }, (v) => apply({ dash: v }, 'dash'))));
      if (spec.style !== 'zigzag' && spec.style !== 'crosswalkLines' && spec.style !== 'crosswalkChessboard') {
        box.append(row('Space', sliderInput(spec.space ?? shown.space, { min: 0, max: 15, step: 0.05, format: metres }, (v) => apply({ space: v }, 'space'))));
      }
    }
    if (['double', 'doubleDashed', 'solidDashed', 'dashedSolid'].includes(spec.style)) {
      // A second line in its own colour, as in a yellow and white pair.
      const second = { color: spec.color2 ?? spec.color, hex: spec.hex2 ?? (spec.color2 ? undefined : spec.hex) };
      const r = this.colourRow(second, (patch) => apply({ color2: patch.color ?? spec.color2 ?? spec.color, hex2: patch.hex }, 'colour2'));
      const label = r.querySelector('.label, label, span');
      if (label) label.textContent = 'Second line';
      box.append(r);
    }
    if (info.uses.includes('gap')) box.append(row(spec.style === 'zigzag' ? 'Swing' : spec.style === 'crosswalkDashedLines' ? 'Dash' : 'Gap', sliderInput(spec.gap ?? d.gap ?? 0.12, { min: 0.02, max: 2, step: 0.01, format: metres }, (v) => apply({ gap: v }, 'gap'))));
    box.append(row(info.family === 'crosswalk' ? 'Shift along arm' : 'Offset', sliderInput(spec.offset ?? 0, { min: -3, max: 3, step: 0.05, format: metres }, (v) => apply({ offset: v }, 'offset'))));
    if (info.family !== 'crosswalk' && info.family !== 'stop') {
      box.append(row('Sits', selectInput([{ value: 'centre', label: 'Centred on the points' }, { value: 'left', label: 'Left of the points' }, { value: 'right', label: 'Right of the points' }], spec.align ?? 'centre', (v) => apply({ align: v === 'centre' ? undefined : (v as 'left' | 'right') }, 'align'))));
    }
    if (info.uses.includes('border')) {
      box.append(row('Border', selectInput([{ value: 'none', label: 'None' }, { value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' }], spec.border ?? 'none', (v) => apply({ border: v === 'none' ? undefined : (v as 'solid' | 'dashed') }, 'border'))));
    }
  }

  private lineFields(box: HTMLElement, m: NodeLineMarking): void {
    const tool = this.tool;
    this.styleFields(box, m, (patch, key) => tool.update(patch, key));
    if (lineStyleInfo(m.style).family === 'line' || m.style === 'lane') {
      box.append(row('Straight', checkbox(m.straight && !m.path, (v) => tool.update(v ? { straight: true, path: undefined } : { straight: false }, 'straight')), 'Off curves it with the lanes'));
    }
    box.append(this.partsEditor(m));
  }

  /** Parts of a line in other styles, between its ends and the lines it crosses. */
  private partsEditor(m: NodeLineMarking): HTMLElement {
    const { net } = this.ui;
    const tool = this.tool;
    const crossings = lineCrossings(net, this.host, m);
    const others = net.markingsOf(this.host);
    const boundOptions: { value: string; label: string }[] = [
      { value: 'end0', label: 'Start' },
      ...crossings.map((c) => {
        const o = others.find((x) => x.id === c.markingId);
        return { value: `x${c.markingId}`, label: `Crossing ${o ? describe(o).toLowerCase() : c.markingId} (${c.s.toFixed(1)} m)` };
      }),
      { value: 'end1', label: 'End' },
    ];
    const toBound = (v: string): RuleBound => (v === 'end0' ? { end: 0 } : v === 'end1' ? { end: 1 } : { cross: Number(v.slice(1)) });
    const fromBound = (b: RuleBound) => ('end' in b ? `end${b.end}` : `x${b.cross}`);
    const rules = m.rules ?? [];
    const setRules = (next: LineRule[], key: string) => tool.update({ rules: next.length ? next : undefined }, key);
    const wrap = el('details', { attrs: rules.length ? { open: '' } : {} }, el('summary', { class: 'section-title', text: `Parts (${rules.length + 1})`, tip: 'Paint stretches of this line in other styles, from its ends to where it crosses other lines' }));
    rules.forEach((r, i) => {
      const part = el('div', { style: { ...GROUP, background: 'var(--surface-3, rgba(255,255,255,0.04))' } });
      part.append(
        el(
          'div',
          { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
          selectInput(boundOptions, fromBound(r.from), (v) => setRules(rules.map((x, k) => (k === i ? { ...x, from: toBound(v) } : x)), `rule-${i}-from`)),
          el('span', { text: 'to' }),
          selectInput(boundOptions, fromBound(r.to), (v) => setRules(rules.map((x, k) => (k === i ? { ...x, to: toBound(v) } : x)), `rule-${i}-to`)),
          iconButton(ICONS.trash, { tip: 'Remove this part', onClick: () => setRules(rules.filter((_, k) => k !== i), 'rule-remove') }),
        ),
      );
      this.styleFields(part, r.style, (patch, key) => setRules(rules.map((x, k) => (k === i ? { ...x, style: { ...x.style, ...patch } } : x)), `rule-${i}-${key}`), true);
      wrap.append(part);
    });
    wrap.append(
      el(
        'div',
        { class: 'btn-row' },
        this.button('Add part', () => {
          const first = crossings[0];
          const next: LineRule = {
            from: first ? { cross: first.markingId } : { end: 0 },
            to: { end: 1 },
            style: { style: m.style === 'solid' ? 'dashed' : 'solid', color: m.color, width: m.width, ...(m.style === 'solid' ? { dash: 3, space: 3 } : {}) },
          };
          setRules([...rules, next], 'rule-add');
        }, { tip: crossings.length ? 'From where it first crosses another line to its end' : 'No other line crosses it yet: the part runs end to end' }),
      ),
    );
    return wrap;
  }

  private fillFields(box: HTMLElement, m: NodeFillerMarking): void {
    const tool = this.tool;
    const info = fillStyleInfo(m.fill);
    box.append(
      row('Fill', selectInput(FILL_STYLE_INFO.map((f) => ({ value: f.value, label: f.label })), m.fill, (v: NodeFillStyle) => tool.update({ fill: v, width: fillStyleInfo(v).defaults.width, angle: fillStyleInfo(v).defaults.angle, step: fillStyleInfo(v).defaults.step }, 'fill'))),
      this.colourRow(m, (patch) => tool.update(patch, 'colour')),
    );
    if (m.fill !== 'solid') {
      box.append(
        row('Stripe width', sliderInput(m.width, { min: 0.05, max: 1.5, step: 0.01, format: metres }, (v) => tool.update({ width: v }, 'width'))),
        row(m.fill === 'grid' ? 'Cell size' : 'Step', sliderInput(m.step ?? info.defaults.step ?? 1.4, { min: 0.3, max: 8, step: 0.05, format: metres }, (v) => tool.update({ step: v }, 'step'))),
      );
      if (m.fill !== 'hatch') box.append(row('Angle', sliderInput(m.angle ?? info.defaults.angle ?? 0, { min: -90, max: 90, step: 1, format: degrees }, (v) => tool.update({ angle: v }, 'angle'))));
      box.append(row('Edge line', checkbox(!m.noOutline, (v) => tool.update({ noOutline: v ? undefined : true }, 'outline'))));
      if (m.fill === 'chevron' || m.fill === 'triangle') box.append(row('Point the other way', checkbox(!!m.invert, (v) => tool.update({ invert: v ? true : undefined }, 'invert'))));
    }
    box.append(row('Inset from edge', sliderInput(m.offset ?? 0, { min: 0, max: 3, step: 0.05, format: metres }, (v) => tool.update({ offset: v || undefined }, 'inset'))));
  }

  /** The look of the next marking the armed draw tool makes. */
  private defaultFields(box: HTMLElement): void {
    const { tools } = this.ui;
    const s = tools.settings.nodeMarking;
    const changed = () => {
      tools.settingsChanged();
      this.render();
    };
    if (s.draw === 'crosswalk' || s.draw === 'stop') {
      const spec = s.draw === 'crosswalk' ? s.crosswalk : s.stop;
      this.styleFields(box, spec, (patch) => {
        if (s.draw === 'crosswalk') s.crosswalk = { ...s.crosswalk, ...patch };
        else s.stop = { ...s.stop, ...patch };
        changed();
      });
      return;
    }
    if (s.draw === 'filler') {
      const fake: NodeFillerMarking = { id: -1, kind: 'filler', anchors: [], fill: s.fill, color: s.color, width: s.fillWidth, ...s.fillExtra };
      box.append(
        row('Fill', selectInput(FILL_STYLE_INFO.map((f) => ({ value: f.value, label: f.label })), s.fill, (v: NodeFillStyle) => {
          s.fill = v;
          s.fillWidth = fillStyleInfo(v).defaults.width;
          s.fillExtra = { ...s.fillExtra, angle: fillStyleInfo(v).defaults.angle, step: fillStyleInfo(v).defaults.step };
          changed();
        })),
        this.colourRow(fake, (patch) => {
          if (patch.color) s.color = patch.color;
          s.fillExtra = { ...s.fillExtra, hex: patch.hex };
          changed();
        }),
        row('Stripe width', sliderInput(s.fillWidth, { min: 0.05, max: 1.5, step: 0.01, format: metres }, (v) => {
          s.fillWidth = v;
          tools.settingsChanged();
        })),
      );
      return;
    }
    const spec: LineStyleSpec = { ...s.lineExtra, style: s.style, color: s.color, width: s.width };
    this.styleFields(box, spec, (patch) => {
      const next = { ...spec, ...patch };
      s.style = next.style;
      s.color = next.color;
      s.width = next.width;
      const { style: _a, color: _b, width: _c, ...extra } = next;
      s.lineExtra = extra;
      changed();
    });
    if (this.host.kind === 'node') {
      box.append(
        row('Curve between arms', checkbox(s.curved, (v) => {
          s.curved = v;
          tools.settingsChanged();
        })),
        row('Follow lane paths', checkbox(s.followLanes, (v) => {
          s.followLanes = v;
          tools.settingsChanged();
        })),
      );
    }
    box.append(el('div', { class: 'small muted', text: 'Go near an arm and its anchors appear: green ones sit between lanes coming in, blue between lanes going out, amber along the kerb. Hover back along an arm for a row further out.' }));
  }

  // -------------------------------------------------------------------------
  // Everything here, by arm
  // -------------------------------------------------------------------------

  private listSection(): HTMLElement {
    const { net } = this.ui;
    const tool = this.tool;
    const list = net.markingsOf(this.host);
    const autos = this.nodeId !== null ? autoMarkingItems(net, this.nodeId) : [];
    const wrap = el('div', {}, el('div', { class: 'section-title', text: `Markings here (${list.length + autos.length})` }));
    const frames = framesOf(net, this.host);
    const rowFor = (label: string, selected: boolean, onPick: (e: MouseEvent) => void, onDelete: () => void, isAuto: boolean, tip?: string) =>
      el(
        'div',
        { class: `phase-row ${selected ? 'selected' : ''}`, style: { display: 'flex', alignItems: 'center' } },
        el('span', { class: 'phase-name', text: label, tip, on: { click: (e) => onPick(e as MouseEvent) }, style: { flex: '1', cursor: 'pointer' } }),
        isAuto ? el('span', { text: 'auto', style: BADGE }) : null,
        iconButton(ICONS.trash, { tip: isAuto ? 'Take this one away' : 'Delete marking', onClick: onDelete }),
      );
    const userRow = (m: NodeMarking) =>
      rowFor(
        describe(m),
        tool.selection.includes(m.id),
        (e) => tool.select(m.id, e.shiftKey || e.metaKey || e.ctrlKey),
        () => tool.remove(m.id),
        false,
        'Click to pick; Shift or Cmd click to add to the selection',
      );
    const autoRow = (it: AutoItem) => rowFor(it.label.replace(/,.*$/, ''), tool.selectedAuto?.key === it.key, () => tool.selectAuto(it.key), () => tool.removeAuto(it), true);
    const placed = new Set<Id>();
    for (const f of frames) {
      const mine = list.filter((m) => m.kind === 'line' && m.from.segmentId === f.segmentId && m.from.end === f.end);
      const theirs = autos.filter((a) => a.segmentId === f.segmentId && a.ref.kind !== 'guide' && a.ref.kind !== 'gore');
      const group = el('div', { style: GROUP }, el('div', { class: 'small', text: this.roadName(f.segmentId, f.end), style: { fontWeight: '600', marginBottom: '2px' } }));
      for (const it of theirs) group.append(autoRow(it));
      for (const m of mine) {
        group.append(userRow(m));
        placed.add(m.id);
      }
      if (!mine.length && !theirs.length) group.append(el('div', { class: 'small muted', text: 'Nothing painted on this arm' }));
      wrap.append(group);
    }
    const across = autos.filter((a) => a.ref.kind === 'guide' || a.ref.kind === 'gore');
    const rest = list.filter((m) => !placed.has(m.id));
    if (across.length || rest.length) {
      const group = el('div', { style: GROUP }, el('div', { class: 'small', text: 'Through the junction and areas', style: { fontWeight: '600', marginBottom: '2px' } }));
      for (const it of across) group.append(autoRow(it));
      for (const m of rest) group.append(userRow(m));
      wrap.append(group);
    }
    return wrap;
  }

  private takenAwaySection(): HTMLElement {
    const { net } = this.ui;
    const tool = this.tool;
    const gone = autoMarkingItems(net, this.nodeId!, true).filter((i) => i.off);
    const wrap = el('details', { attrs: gone.length ? { open: '' } : {} }, el('summary', { class: 'section-title', text: `Automatic markings taken away (${gone.length})` }));
    for (const it of gone) {
      wrap.append(
        el(
          'div',
          { class: 'phase-row', style: { display: 'flex', alignItems: 'center' } },
          el('span', { class: 'phase-name', text: it.label, style: { flex: '1' } }),
          this.button('Bring back', () => tool.restoreAuto(it)),
        ),
      );
    }
    if (gone.length) wrap.append(el('div', { class: 'btn-row' }, this.button('Bring all back', () => tool.restoreAllAuto())));
    else wrap.append(el('div', { class: 'small muted', text: 'Remove any automatic marking with the eraser, Bulldoze or Delete; it is listed here to bring back.' }));
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Points
  // -------------------------------------------------------------------------

  private pointsSection(): HTMLElement {
    const { net } = this.ui;
    const tool = this.tool;
    const wrap = el('details', {}, el('summary', { class: 'section-title', text: 'Points', tip: 'Move a point sideways, put it on the edge of its line, or turn it off. Arrow keys nudge the point under the cursor' }));
    for (const f of framesOf(net, this.host)) {
      const group = el('div', { style: GROUP }, el('div', { class: 'small', text: this.roadName(f.segmentId, f.end), style: { fontWeight: '600' } }));
      // Left to right as seen looking in.
      const order = f.offsets.map((_, i) => i);
      if (f.seenSign < 0) order.reverse();
      const sections: [string, number[]][] = [
        ['Coming in', order.filter((i) => f.flows[i] === 'enter')],
        ['Going out', order.filter((i) => f.flows[i] === 'exit')],
        ['Edges and centre', order.filter((i) => f.flows[i] === 'edge' || f.flows[i] === 'split')],
      ];
      for (const [title, idx] of sections) {
        if (!idx.length) continue;
        group.append(el('div', { class: 'small muted', text: title }));
        for (const i of idx) {
          const set = tool.pointSetting(f.segmentId, i, f.end);
          const nudge = (d: number) => tool.setPoint({ ...set, offset: Math.round(((set.offset ?? 0) + d) * 100) / 100 });
          group.append(
            el(
              'div',
              { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
              el('span', { text: `Point ${order.indexOf(i) + 1}`, style: { width: '56px' } }),
              this.button('◀', () => nudge(-0.05), { tip: 'Left 5 cm' }),
              el('span', { text: `${(set.offset ?? 0) >= 0 ? '+' : ''}${(set.offset ?? 0).toFixed(2)}`, style: { width: '40px', textAlign: 'center' } }),
              this.button('▶', () => nudge(0.05), { tip: 'Right 5 cm' }),
              selectInput([{ value: 'centre', label: 'Centre' }, { value: 'left', label: 'Left edge' }, { value: 'right', label: 'Right edge' }], set.place ?? 'centre', (v) =>
                tool.setPoint({ ...set, place: v === 'centre' ? undefined : (v as 'left' | 'right') }),
              ),
              checkbox(!set.off, (v) => tool.setPoint({ ...set, off: v ? undefined : true })),
            ),
          );
        }
      }
      wrap.append(group);
    }
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Templates, copy and paste
  // -------------------------------------------------------------------------

  private templateSection(): HTMLElement {
    const { net } = this.ui;
    const tool = this.tool;
    const templates = allTemplates(net.markingLibrary.templates ?? []).filter((t) => t.host === this.host.kind);
    const wrap = el('details', { attrs: tool.templateFit ? { open: '' } : {} }, el('summary', { class: 'section-title', text: `Templates (${templates.length})` }));
    wrap.append(
      el(
        'div',
        { class: 'btn-row' },
        this.button('Copy', () => tool.copy(), { key: '⌘C', tip: 'Copy every marking here' }),
        this.button('Paste', () => tool.paste(), { key: '⌘V', tip: 'Replace the markings here with the copied ones, turned to fit' }),
      ),
      el(
        'div',
        { style: { display: 'flex', gap: '4px', alignItems: 'center', margin: '6px 0' } },
        textInput(this.templateName, 'Template name', (v) => (this.templateName = v)),
        this.button('Save as template', () => {
          const name = this.templateName.trim() || `Junction ${templates.length + 1}`;
          saveTemplate(captureTemplate(net, this.host, name, libraryId('template')));
          this.templateName = '';
          this.ui.toast(`Saved template ${name}.`, 'info');
        }),
      ),
    );
    for (const t of templates) {
      const fits = fitTemplate(net, this.host, t);
      const ok = fits.length > 0;
      wrap.append(
        el(
          'div',
          { class: 'phase-row', style: { display: 'flex', alignItems: 'center', gap: '4px' } },
          el('span', { class: 'phase-name', text: `${t.name} (${t.arms.length} arms, ${t.markings.length})`, style: { flex: '1', opacity: ok ? '1' : '0.5' } }),
          this.button('Apply', () => tool.useTemplate(t), { tip: ok ? (isAmbiguous(fits) ? 'More than one way round fits: apply, then Rotate or Mirror' : 'Replace the markings here with this template') : 'Needs a junction with the same number of arms' }),
          iconButton(ICONS.trash, { tip: 'Delete template', onClick: () => deleteTemplate(t.id) }),
        ),
      );
    }
    if (tool.templateFit) {
      wrap.append(el('div', { class: 'btn-row' }, this.button('Rotate', () => tool.refit('rotate'), { tip: 'Turn the template to the next arm' }), this.button('Mirror', () => tool.refit('mirror'), { tip: 'Flip the template' })));
    }
    return wrap;
  }

  private footer(): HTMLElement {
    const { net } = this.ui;
    const tool = this.tool;
    const node = this.nodeId !== null ? net.getNode(this.nodeId) : null;
    return el(
      'div',
      {},
      node ? row('Hide all automatic', checkbox(!!node.control.hideAutoMarkings, (v) => tool.setHideAuto(v)), 'Hide every automatic stop line, crosswalk and guide here') : null,
      el('div', { class: 'btn-row', style: { marginTop: '6px' } }, this.button('Clear my markings', () => tool.clearAll(), { danger: true })),
    );
  }
}

/** Keys the automatic items in a list by, for tests and other panels. */
export { autoItemKey };
