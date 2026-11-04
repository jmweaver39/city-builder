/**
 * The catalogue of hand-placed marking styles: what each line, crosswalk and fill
 * is called, its default measures, which settings apply to it, the built-in
 * presets, and colour helpers. Pure data, shared by the renderer, tools and panels.
 */
import { CROSSWALK, DOT, DOUBLE_SPACING, FILL_STANDARDS, HATCH, GORE, LINE_STANDARDS, LINE_W, PAINT_HEX, STOP, dashFor, lineStandard, standardWidth } from './paintStandard';
import type { LineStyleSpec, MarkingPreset, NodeFillStyle, NodeFillerMarking, NodeLineMarking, NodeLineStyle, PaintColor } from './types';

export { PAINT_HEX };

export type LineFamily = 'line' | 'stop' | 'crosswalk' | 'teeth' | 'lane' | 'empty';

export interface LineStyleInfo {
  value: NodeLineStyle;
  label: string;
  family: LineFamily;
  /** Width, and the other measures that apply, when the style is chosen. */
  defaults: Omit<LineStyleSpec, 'style' | 'color'>;
  /** Which settings the panel offers. */
  uses: ('dash' | 'gap' | 'border')[];
}

const STD = (id: Parameters<typeof lineStandard>[0]) => lineStandard(id).spec;

export const LINE_STYLE_INFO: readonly LineStyleInfo[] = [
  { value: 'solid', label: 'Solid', family: 'line', defaults: { width: LINE_W.lane }, uses: [] },
  // Dash and space left unset follow the road's speed class (paintStandard.ts).
  { value: 'dashed', label: 'Dashed', family: 'line', defaults: { width: LINE_W.lane }, uses: ['dash'] },
  { value: 'double', label: 'Double solid', family: 'line', defaults: { width: LINE_W.centre, gap: DOUBLE_SPACING - LINE_W.centre }, uses: ['gap'] },
  { value: 'doubleDashed', label: 'Double dashed', family: 'line', defaults: { width: LINE_W.lane, gap: DOUBLE_SPACING - LINE_W.lane, dash: 0.6, space: 0.3 }, uses: ['dash', 'gap'] },
  { value: 'solidDashed', label: 'Solid and dashed', family: 'line', defaults: { width: LINE_W.centre, gap: DOUBLE_SPACING - LINE_W.centre }, uses: ['dash', 'gap'] },
  { value: 'dashedSolid', label: 'Dashed and solid', family: 'line', defaults: { width: LINE_W.centre, gap: DOUBLE_SPACING - LINE_W.centre }, uses: ['dash', 'gap'] },
  { value: 'dotted', label: 'Dotted', family: 'line', defaults: { width: LINE_W.lane, dash: DOT.dash, space: DOT.gap }, uses: ['dash'] },
  { value: 'zigzag', label: 'Zigzag', family: 'line', defaults: { width: LINE_W.lane, dash: 1, gap: 0.5 }, uses: ['dash', 'gap'] },
  { value: 'sharkTeeth', label: "Shark's teeth (yield)", family: 'teeth', defaults: { width: STD('giveWay').width, dash: STD('giveWay').dash, space: STD('giveWay').space }, uses: ['dash'] },
  { value: 'stopLine', label: 'Stop line', family: 'stop', defaults: { width: STOP.width }, uses: [] },
  { value: 'stopLineDashed', label: 'Stop line, dashed (give way)', family: 'stop', defaults: { width: STOP.width, dash: 0.6, space: 0.3 }, uses: ['dash'] },
  { value: 'stopLineDouble', label: 'Stop line, double', family: 'stop', defaults: { width: 0.3, gap: 0.3 }, uses: ['gap'] },
  { value: 'stopLineSolidDashed', label: 'Stop line, solid and dashed', family: 'stop', defaults: { width: 0.3, gap: 0.3, dash: 0.6, space: 0.3 }, uses: ['dash', 'gap'] },
  { value: 'lane', label: 'Lane (painted area)', family: 'lane', defaults: { width: 3 }, uses: [] },
  { value: 'crosswalkZebra', label: 'Crosswalk, zebra', family: 'crosswalk', defaults: { width: CROSSWALK.depth, dash: CROSSWALK.stripe, space: CROSSWALK.gap }, uses: ['dash', 'border'] },
  { value: 'crosswalkDoubleZebra', label: 'Crosswalk, double zebra', family: 'crosswalk', defaults: { width: 5, dash: CROSSWALK.stripe, space: CROSSWALK.gap, gap: 0.4 }, uses: ['dash', 'gap', 'border'] },
  { value: 'crosswalkLadder', label: 'Crosswalk, ladder', family: 'crosswalk', defaults: { width: CROSSWALK.depth, dash: CROSSWALK.stripe, space: CROSSWALK.gap }, uses: ['dash'] },
  { value: 'crosswalkLines', label: 'Crosswalk, parallel lines', family: 'crosswalk', defaults: { width: CROSSWALK.depth, dash: CROSSWALK.rail }, uses: ['dash'] },
  { value: 'crosswalkDashedLines', label: 'Crosswalk, parallel dashed lines', family: 'crosswalk', defaults: { width: CROSSWALK.depth, dash: CROSSWALK.rail, space: 0.6, gap: 0.6 }, uses: ['dash', 'gap'] },
  { value: 'crosswalkSolid', label: 'Crosswalk, solid', family: 'crosswalk', defaults: { width: CROSSWALK.depth }, uses: ['border'] },
  { value: 'crosswalkChessboard', label: 'Crosswalk, chessboard', family: 'crosswalk', defaults: { width: CROSSWALK.depth, dash: CROSSWALK.stripe }, uses: ['dash', 'border'] },
  { value: 'empty', label: 'No paint', family: 'empty', defaults: { width: LINE_W.lane }, uses: [] },
];

export function lineStyleInfo(style: NodeLineStyle): LineStyleInfo {
  return LINE_STYLE_INFO.find((s) => s.value === style) ?? LINE_STYLE_INFO[0];
}

/** Styles that run along a path and so may curve, follow the kerb or follow lanes. */
export function isPathStyle(style: NodeLineStyle): boolean {
  const f = lineStyleInfo(style).family;
  return f === 'line' || f === 'lane' || f === 'empty';
}

export interface FillStyleInfo {
  value: NodeFillStyle;
  label: string;
  defaults: { width: number; angle?: number; step?: number };
}

export const FILL_STYLE_INFO: readonly FillStyleInfo[] = [
  { value: 'stripes', label: 'Stripes', defaults: { width: HATCH.stripe, angle: 45, step: HATCH.step } },
  { value: 'hatch', label: 'Hatch (45°)', defaults: { width: HATCH.stripe, step: HATCH.step } },
  { value: 'chevron', label: 'Chevrons', defaults: { width: GORE.stripe, angle: 0, step: GORE.step } },
  { value: 'grid', label: 'Grid', defaults: { width: 0.15, angle: 0, step: 1.5 } },
  { value: 'triangle', label: 'Triangles', defaults: { width: 0.3, angle: 0, step: 2 } },
  { value: 'solid', label: 'Solid colour', defaults: { width: LINE_W.lane } },
];

export function fillStyleInfo(fill: NodeFillStyle): FillStyleInfo {
  return FILL_STYLE_INFO.find((f) => f.value === fill) ?? FILL_STYLE_INFO[0];
}

/** Styles whose dashes, when left unset, follow the speed of the road they are on. */
const SPEED_DASHED = new Set<NodeLineStyle>(['dashed', 'solidDashed', 'dashedSolid']);

/**
 * Measures a style uses, defaults filled in from the marking standard. `speedKmh`
 * is the road's speed, which sets an unset dash and space on dashed styles.
 */
export function resolvedStyle(spec: LineStyleSpec, speedKmh = 50): Required<Pick<LineStyleSpec, 'width' | 'dash' | 'space' | 'gap' | 'offset'>> & LineStyleSpec {
  const d = lineStyleInfo(spec.style).defaults;
  const speed = SPEED_DASHED.has(spec.style) ? dashFor(speedKmh) : null;
  const width = standardWidth(spec.width, speedKmh);
  return {
    ...spec,
    width,
    dash: spec.dash ?? speed?.dash ?? d.dash ?? 3,
    space: spec.space ?? speed?.gap ?? d.space ?? 6,
    // A standard double keeps its lines 0.32 m apart, centre to centre, whatever width the road draws them.
    gap: spec.gap === undefined || Math.abs(spec.gap - (DOUBLE_SPACING - spec.width)) < 1e-9 ? (spec.gap === undefined && d.gap !== undefined && Math.abs(d.gap - (DOUBLE_SPACING - (d.width ?? 0))) > 1e-9 ? d.gap : DOUBLE_SPACING - width) : spec.gap,
    offset: spec.offset ?? 0,
  };
}

/** The look of a line, without its anchors and parts. */
export function styleOf(m: LineStyleSpec): LineStyleSpec {
  const out: LineStyleSpec = { style: m.style, color: m.color, width: m.width };
  for (const k of ['hex', 'dash', 'space', 'gap', 'offset', 'align', 'border', 'color2', 'hex2'] as const) {
    if (m[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = m[k];
  }
  return out;
}

/**
 * The fields to merge into a line to give it a look: every style field, with the
 * unset ones cleared so nothing of the old look is left behind.
 */
export function stylePatch(spec: LineStyleSpec): Partial<NodeLineMarking> {
  return {
    style: spec.style,
    color: spec.color,
    width: spec.width,
    hex: spec.hex,
    dash: spec.dash,
    space: spec.space,
    gap: spec.gap,
    offset: spec.offset,
    align: spec.align,
    border: spec.border,
    color2: spec.color2,
    hex2: spec.hex2,
  };
}

export type FillStyleSpec = Pick<NodeFillerMarking, 'fill' | 'color' | 'hex' | 'width' | 'angle' | 'step' | 'offset' | 'noOutline' | 'invert'>;

export function fillOf(m: FillStyleSpec): FillStyleSpec {
  const out: FillStyleSpec = { fill: m.fill, color: m.color, width: m.width };
  for (const k of ['hex', 'angle', 'step', 'offset', 'noOutline', 'invert'] as const) {
    if (m[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = m[k];
  }
  return out;
}

export function fillPatch(spec: FillStyleSpec): Partial<NodeFillerMarking> {
  return { fill: spec.fill, color: spec.color, width: spec.width, hex: spec.hex, angle: spec.angle, step: spec.step, offset: spec.offset, noOutline: spec.noOutline, invert: spec.invert };
}

/** The same look seen in a mirror: sides swap. */
export function mirroredStyle(spec: LineStyleSpec): LineStyleSpec {
  const out = { ...spec };
  if (spec.style === 'solidDashed') out.style = 'dashedSolid';
  else if (spec.style === 'dashedSolid') out.style = 'solidDashed';
  // The second line's own colour moves to the other side with it.
  if (spec.color2 || spec.hex2) {
    out.color = spec.color2 ?? spec.color;
    out.hex = spec.hex2;
    out.color2 = spec.color;
    out.hex2 = spec.hex;
  }
  if (spec.align) out.align = spec.align === 'left' ? 'right' : 'left';
  if (spec.offset) out.offset = -spec.offset;
  return out;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export function isHex(s: unknown): s is string {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
}

/** 0 to 1 channels. */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The colour a marking shows, as hex. */
export function markingHex(m: { color: PaintColor; hex?: string }): string {
  return m.hex && isHex(m.hex) ? m.hex.toLowerCase() : PAINT_HEX[m.color];
}

// ---------------------------------------------------------------------------
// Built-in presets
// ---------------------------------------------------------------------------

/** The built-in presets are the marking standard itself (paintStandard.ts), by name. */
export const BUILTIN_PRESETS: readonly MarkingPreset[] = [
  ...LINE_STANDARDS.map((s): MarkingPreset => ({ id: `builtin-${s.id}`, name: s.name, kind: 'line', style: { ...s.spec } })),
  ...FILL_STANDARDS.map((s): MarkingPreset => ({ id: `builtin-${s.id}`, name: s.name, kind: 'filler', style: { ...s.spec } })),
];

export function isBuiltinPreset(id: string): boolean {
  return id.startsWith('builtin-');
}
