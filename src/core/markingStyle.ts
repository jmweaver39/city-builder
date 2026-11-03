/**
 * The catalogue of hand-placed marking styles: what each line, crosswalk and fill
 * is called, its default measures, which settings apply to it, the built-in
 * presets, and colour helpers. Pure data, shared by the renderer, tools and panels.
 */
import type { LineStyleSpec, MarkingPreset, NodeFillStyle, NodeFillerMarking, NodeLineMarking, NodeLineStyle, PaintColor } from './types';

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

export const LINE_STYLE_INFO: readonly LineStyleInfo[] = [
  { value: 'solid', label: 'Solid', family: 'line', defaults: { width: 0.15 }, uses: [] },
  { value: 'dashed', label: 'Dashed', family: 'line', defaults: { width: 0.15, dash: 3, space: 3 }, uses: ['dash'] },
  { value: 'double', label: 'Double solid', family: 'line', defaults: { width: 0.12, gap: 0.12 }, uses: ['gap'] },
  { value: 'doubleDashed', label: 'Double dashed', family: 'line', defaults: { width: 0.12, gap: 0.12, dash: 0.6, space: 0.3 }, uses: ['dash', 'gap'] },
  { value: 'solidDashed', label: 'Solid and dashed', family: 'line', defaults: { width: 0.12, gap: 0.12, dash: 3, space: 3 }, uses: ['dash', 'gap'] },
  { value: 'dashedSolid', label: 'Dashed and solid', family: 'line', defaults: { width: 0.12, gap: 0.12, dash: 3, space: 3 }, uses: ['dash', 'gap'] },
  { value: 'dotted', label: 'Dotted', family: 'line', defaults: { width: 0.18, dash: 0.18, space: 0.42 }, uses: ['dash'] },
  { value: 'zigzag', label: 'Zigzag', family: 'line', defaults: { width: 0.12, dash: 1, gap: 0.5 }, uses: ['dash', 'gap'] },
  { value: 'sharkTeeth', label: "Shark's teeth (yield)", family: 'teeth', defaults: { width: 0.6, dash: 0.45, space: 0.3 }, uses: ['dash'] },
  { value: 'stopLine', label: 'Stop line', family: 'stop', defaults: { width: 0.45 }, uses: [] },
  { value: 'lane', label: 'Lane (painted area)', family: 'lane', defaults: { width: 3 }, uses: [] },
  { value: 'crosswalkZebra', label: 'Crosswalk, zebra', family: 'crosswalk', defaults: { width: 3, dash: 0.5, space: 0.5 }, uses: ['dash', 'border'] },
  { value: 'crosswalkDoubleZebra', label: 'Crosswalk, double zebra', family: 'crosswalk', defaults: { width: 5, dash: 0.5, space: 0.5, gap: 0.4 }, uses: ['dash', 'gap', 'border'] },
  { value: 'crosswalkLadder', label: 'Crosswalk, ladder', family: 'crosswalk', defaults: { width: 3, dash: 0.5, space: 0.5 }, uses: ['dash'] },
  { value: 'crosswalkLines', label: 'Crosswalk, parallel lines', family: 'crosswalk', defaults: { width: 3, dash: 0.3 }, uses: ['dash'] },
  { value: 'crosswalkSolid', label: 'Crosswalk, solid', family: 'crosswalk', defaults: { width: 3 }, uses: ['border'] },
  { value: 'crosswalkChessboard', label: 'Crosswalk, chessboard', family: 'crosswalk', defaults: { width: 3, dash: 0.6 }, uses: ['dash', 'border'] },
  { value: 'empty', label: 'No paint', family: 'empty', defaults: { width: 0.15 }, uses: [] },
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
  { value: 'stripes', label: 'Stripes', defaults: { width: 0.3, angle: 45, step: 1.4 } },
  { value: 'hatch', label: 'Hatch (45°)', defaults: { width: 0.3, step: 1.4 } },
  { value: 'chevron', label: 'Chevrons', defaults: { width: 0.4, angle: 0, step: 2 } },
  { value: 'grid', label: 'Grid', defaults: { width: 0.15, angle: 0, step: 1.5 } },
  { value: 'triangle', label: 'Triangles', defaults: { width: 0.3, angle: 0, step: 2 } },
  { value: 'solid', label: 'Solid colour', defaults: { width: 0.2 } },
];

export function fillStyleInfo(fill: NodeFillStyle): FillStyleInfo {
  return FILL_STYLE_INFO.find((f) => f.value === fill) ?? FILL_STYLE_INFO[0];
}

/** Measures a style uses, defaults filled in. */
export function resolvedStyle(spec: LineStyleSpec): Required<Pick<LineStyleSpec, 'width' | 'dash' | 'space' | 'gap' | 'offset'>> & LineStyleSpec {
  const d = lineStyleInfo(spec.style).defaults;
  return {
    ...spec,
    width: spec.width,
    dash: spec.dash ?? d.dash ?? 3,
    space: spec.space ?? d.space ?? 3,
    gap: spec.gap ?? d.gap ?? 0.12,
    offset: spec.offset ?? 0,
  };
}

/** The look of a line, without its anchors and parts. */
export function styleOf(m: LineStyleSpec): LineStyleSpec {
  const out: LineStyleSpec = { style: m.style, color: m.color, width: m.width };
  for (const k of ['hex', 'dash', 'space', 'gap', 'offset', 'align', 'border'] as const) {
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
  };
}

export type FillStyleSpec = Pick<NodeFillerMarking, 'fill' | 'color' | 'hex' | 'width' | 'angle' | 'step' | 'offset' | 'noOutline'>;

export function fillOf(m: FillStyleSpec): FillStyleSpec {
  const out: FillStyleSpec = { fill: m.fill, color: m.color, width: m.width };
  for (const k of ['hex', 'angle', 'step', 'offset', 'noOutline'] as const) {
    if (m[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = m[k];
  }
  return out;
}

export function fillPatch(spec: FillStyleSpec): Partial<NodeFillerMarking> {
  return { fill: spec.fill, color: spec.color, width: spec.width, hex: spec.hex, angle: spec.angle, step: spec.step, offset: spec.offset, noOutline: spec.noOutline };
}

/** The same look seen in a mirror: sides swap. */
export function mirroredStyle(spec: LineStyleSpec): LineStyleSpec {
  const out = { ...spec };
  if (spec.style === 'solidDashed') out.style = 'dashedSolid';
  else if (spec.style === 'dashedSolid') out.style = 'solidDashed';
  if (spec.align) out.align = spec.align === 'left' ? 'right' : 'left';
  if (spec.offset) out.offset = -spec.offset;
  return out;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** The named paint colours, as hex, matching the renderer's palette. */
export const PAINT_HEX: Record<PaintColor, string> = {
  white: '#f2f2ee',
  yellow: '#f2c230',
  blue: '#3f7fe0',
  red: '#d9443a',
  green: '#3faa5a',
};

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

export const BUILTIN_PRESETS: readonly MarkingPreset[] = [
  {
    id: 'builtin-us-double-yellow',
    name: 'US double yellow',
    kind: 'line',
    style: { style: 'double', color: 'yellow', width: 0.1, gap: 0.1 },
  },
  {
    id: 'builtin-uk-give-way',
    name: 'UK give-way',
    kind: 'line',
    style: { style: 'doubleDashed', color: 'white', width: 0.2, gap: 0.2, dash: 0.6, space: 0.3 },
  },
  {
    id: 'builtin-continental-zebra',
    name: 'Continental zebra',
    kind: 'line',
    style: { style: 'crosswalkZebra', color: 'white', width: 4, dash: 0.5, space: 0.5 },
  },
  {
    id: 'builtin-gore-chevron',
    name: 'Highway gore chevron',
    kind: 'filler',
    style: { fill: 'chevron', color: 'white', width: 0.45, angle: 0, step: 3 },
  },
];

export function isBuiltinPreset(id: string): boolean {
  return id.startsWith('builtin-');
}
