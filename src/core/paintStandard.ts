/**
 * The one marking standard. Every painted mark in the game, automatic or placed by
 * hand, takes its measures from here: line widths, dash and gap lengths by road
 * speed class, the two road paint colours, crosswalk, stop line, teeth, arrow, text
 * and gore proportions, the paint material, and the order paint stacks in.
 *
 * Automatic road lines are described in the same vocabulary as hand-placed ones
 * (a LineStyleSpec), and both turn into strokes with `strokesOfSpec`, so a hand
 * drawn lane line and an automatic one in the same place are the same geometry.
 * Pure data and functions, no DOM or Three.js.
 */
import type { CrosswalkStyle, LaneDef, LineStyle, LineStyleSpec, MarkingStyle, NodeFillerMarking, NodeLineStyle, PaintColor } from './types';

// ---------------------------------------------------------------------------
// Measures, metres
// ---------------------------------------------------------------------------

/** Line widths. */
export const LINE_W = {
  lane: 0.14,
  centre: 0.14,
  edge: 0.168,
  stop: 0.45,
  guide: 0.12,
  /** The pale outline along kerbless roads. Not paint a player places. */
  outline: 0.16,
} as const;

/** Centre to centre distance of the two lines of a double. */
export const DOUBLE_SPACING = 0.32;
/** Edge lines sit this far inside the outer lane edge. */
export const EDGE_INSET = 0.18;
/** The pale outline sits this far inside the paving edge. */
export const OUTLINE_INSET = 0.1;

export type SpeedClass = 'urban' | 'arterial' | 'fast';

export function speedClassOf(kmh: number): SpeedClass {
  return kmh <= 50 ? 'urban' : kmh < 80 ? 'arterial' : 'fast';
}

/** Dash and gap of a dashed line, by the speed of the road it is on. Always one third paint. */
export const DASH: Record<SpeedClass, { dash: number; gap: number }> = {
  urban: { dash: 3, gap: 6 },
  arterial: { dash: 4.5, gap: 9 },
  fast: { dash: 6, gap: 12 },
};

export function dashFor(kmh: number): { dash: number; gap: number } {
  return DASH[speedClassOf(kmh)];
}

/** Dotted lines, at any speed. */
export const DOT = { dash: 0.48, gap: 0.72 };
/** Guides carrying lane lines through a junction. */
export const GUIDE_DASH = { dash: 0.75, gap: 0.75 };

/** Crosswalks: depth along the road, stripes across it, the setback from the cut line. */
export const CROSSWALK = { depth: 3, stripe: 0.6, gap: 0.6, rail: 0.3, setback: 0.5, border: 0.2, borderGap: 0.15 } as const;
/** Stop line width, and the space between a stop line and the crosswalk beyond it. */
export const STOP = { width: LINE_W.stop, beforeCrosswalk: 0.9 } as const;
/** Give-way teeth: base along the line, space between, length to the tip. */
export const TEETH = { base: 0.8, space: 0.25, length: 0.95 } as const;
/** Turn arrows: 5 m long at scale 1, set back from the stop line. */
export const ARROW = { scale: 1, length: 5, back: 7.5 } as const;
/** Road text: letter length along travel at width 1, and how much it is stretched. */
export const TEXT = { length: 3.2, stretch: 1.6 } as const;
/** Hatched areas and gore chevrons: stripe width and spacing. */
export const HATCH = { stripe: 0.3, step: 1.6, angle: 45 } as const;
export const GORE = { stripe: 0.4, step: 2.6 } as const;

/** The paint itself: one material for every mark. */
export const PAINT_MATERIAL = {
  roughness: 0.62,
  /** Metres above the road surface. */
  lift: 0.025,
  /** Logarithmic depth bias against the road surface. */
  bias: 7e-6,
  /** Stamps (arrows, text, symbols) fade out between these camera distances. */
  fadeNear: 600,
  fadeFar: 1500,
} as const;

/**
 * Paint stacks in this order, whatever placed it: areas under lines, lines under
 * crossing bars, bars under arrows and text. Paint writes no depth, so marks of
 * one layer never fight marks of another: the later layer is simply drawn on top.
 */
export type PaintLayer = 'fill' | 'line' | 'bar' | 'symbol';
export const PAINT_LAYERS: readonly PaintLayer[] = ['fill', 'line', 'bar', 'symbol'];

// ---------------------------------------------------------------------------
// Colour: one white, one yellow, and three accents
// ---------------------------------------------------------------------------

export const PAINT_HEX: Record<PaintColor, string> = {
  white: '#f2f1ec',
  yellow: '#e2b33c',
  blue: '#3e7fd6',
  red: '#d2402f',
  green: '#46a85a',
};

// ---------------------------------------------------------------------------
// Line looks as strokes
// ---------------------------------------------------------------------------

/** Width a style takes across its path, for alignment to one side. */
export function styleSpan(spec: Pick<LineStyleSpec, 'style' | 'width'> & { gap: number }): number {
  switch (spec.style) {
    case 'double':
    case 'doubleDashed':
    case 'solidDashed':
    case 'dashedSolid':
      return spec.width * 2 + spec.gap;
    case 'zigzag':
      return spec.gap * 2 + spec.width;
    default:
      return spec.width;
  }
}

export interface PaintStroke {
  /** Metres right of the path. */
  shift: number;
  width: number;
  /** Dash period, 0 for solid. */
  period: number;
  /** Share of the period painted. */
  duty: number;
}

/** A look with every measure it uses filled in. */
export type ResolvedSpec = LineStyleSpec & { width: number; dash: number; space: number; gap: number; offset: number };

/**
 * The plain strokes of a line look, or null for a look drawn another way (zigzag,
 * teeth, a painted lane, crosswalks). Left and right are of the path's direction.
 */
export function strokesOfSpec(spec: ResolvedSpec): PaintStroke[] | null {
  const span = styleSpan(spec);
  const centre = spec.offset + (spec.align === 'left' ? -span / 2 : spec.align === 'right' ? span / 2 : 0);
  const w = spec.width;
  const period = spec.dash + spec.space;
  const solid = (shift: number): PaintStroke => ({ shift, width: w, period: 0, duty: 1 });
  const dashed = (shift: number): PaintStroke => (period > 0.01 ? { shift, width: w, period, duty: spec.dash / period } : solid(shift));
  const side = spec.gap / 2 + w / 2;
  switch (spec.style) {
    case 'solid':
    case 'stopLine':
      return [solid(centre)];
    case 'dashed':
    case 'dotted':
      return [dashed(centre)];
    case 'double':
      return [solid(centre - side), solid(centre + side)];
    case 'doubleDashed':
      return [dashed(centre - side), dashed(centre + side)];
    case 'solidDashed':
      return [solid(centre - side), dashed(centre + side)];
    case 'dashedSolid':
      return [dashed(centre - side), solid(centre + side)];
    case 'empty':
      return [];
    default:
      return null;
  }
}

/**
 * An automatic road line in the shared vocabulary. Speed sets the dash; `width`
 * is the stroke width (edge lines are a little wider than lane lines).
 */
export function autoLineSpec(style: LineStyle, color: PaintColor, width: number, speedKmh: number): ResolvedSpec | null {
  if (style === 'none') return null;
  const d = style === 'dotted' ? DOT : dashFor(speedKmh);
  return { style: style as NodeLineStyle, color, width, dash: d.dash, space: d.gap, gap: DOUBLE_SPACING - width, offset: 0 };
}

/**
 * Stretch a dash pattern to fit a run exactly, so a dash rather than a gap meets
 * each end. Returns the period to use, or 0 when the run is too short to dash.
 */
export function fitDashes(length: number, period: number, duty: number): number {
  const dash = period * duty;
  if (length < dash * 1.5) return 0;
  const n = Math.max(1, Math.round((length - dash) / period));
  return length / (n + duty);
}

// ---------------------------------------------------------------------------
// Automatic lines across a road
// ---------------------------------------------------------------------------

/** Which automatic line a position across a road holds. */
export type AutoLineRole = 'lane' | 'centre' | 'edge' | 'outline';

export interface BoundaryLine {
  offset: number;
  style: MarkingStyle['laneLine'];
  color: PaintColor;
  width: number;
  role: AutoLineRole;
  /** Stable key on its road, for taking one away: 'L' and 'R' edges, 'b0'... between lanes, 'b0L'/'b0R' each side of a median. */
  key: string;
  /** Overrides the paint colour, for the pale outline. */
  hex?: string;
}

const OUTLINE_HEX = '#c9c9c4';

/** Every painted line along a road, as offsets from the centreline. */
export function boundaryLines(lanes: readonly LaneDef[], m: MarkingStyle, oneWay: boolean, medianKind: string, medianWidth: number, medianOffset = 0, outline = 0): BoundaryLine[] {
  const out: BoundaryLine[] = [];
  const add = (offset: number, style: MarkingStyle['laneLine'], color: PaintColor, width: number, role: AutoLineRole, key: string) => {
    if (style !== 'none') out.push({ offset, style, color, width, role, key });
  };
  const outlines = () => {
    if (outline <= 0) return;
    out.push({ offset: -outline + OUTLINE_INSET, style: 'solid', color: 'white', width: LINE_W.outline, role: 'outline', key: 'oL', hex: OUTLINE_HEX });
    out.push({ offset: outline - OUTLINE_INSET, style: 'solid', color: 'white', width: LINE_W.outline, role: 'outline', key: 'oR', hex: OUTLINE_HEX });
  };
  const n = lanes.length;
  if (!n) {
    outlines();
    return out;
  }
  const raised = medianKind === 'grass' || medianKind === 'barrier';
  for (let i = 0; i + 1 < n; i++) {
    const a = lanes[i];
    const b = lanes[i + 1];
    const edgeA = a.offset + a.width / 2;
    const edgeB = b.offset - b.width / 2;
    const mid = (edgeA + edgeB) / 2;
    const over = m.boundaries?.[i];
    // The median can sit anywhere in the strip, so it belongs to one gap only.
    const holdsMedian = medianOffset > edgeA - 0.01 && medianOffset < edgeB + 0.01 && medianWidth > 0;
    if (raised && holdsMedian) {
      add(edgeA - EDGE_INSET + 0.02, m.edgeLine, m.edgeColor, LINE_W.lane, 'edge', `b${i}L`);
      add(edgeB + EDGE_INSET - 0.02, m.edgeLine, m.edgeColor, LINE_W.lane, 'edge', `b${i}R`);
      continue;
    }
    if (a.dir !== b.dir) {
      if (oneWay) continue;
      const style = over?.style ?? m.centerLine;
      const color = over?.color ?? m.centerColor;
      if (medianKind === 'paint' && medianWidth > 0.4 && holdsMedian) {
        add(edgeA, style, color, LINE_W.centre, 'centre', `b${i}L`);
        add(edgeB, style, color, LINE_W.centre, 'centre', `b${i}R`);
      } else {
        add(mid, style, color, LINE_W.centre, 'centre', `b${i}`);
      }
    } else {
      add(mid, over?.style ?? m.laneLine, over?.color ?? m.laneColor, LINE_W.lane, 'lane', `b${i}`);
    }
  }
  const lo = lanes[0].offset - lanes[0].width / 2;
  const hi = lanes[n - 1].offset + lanes[n - 1].width / 2;
  add(lo + EDGE_INSET, m.edgeLine, m.edgeColor, LINE_W.edge, 'edge', 'L');
  add(hi - EDGE_INSET, m.edgeLine, m.edgeColor, LINE_W.edge, 'edge', 'R');
  outlines();
  return out;
}

// ---------------------------------------------------------------------------
// Arrows
// ---------------------------------------------------------------------------

function rect(a0: number, b0: number, a1: number, b1: number): number[] {
  return [a0, b0, a1, b0, a1, b1, a0, b0, a1, b1, a0, b1];
}

const HEAD_STRAIGHT = [-0.42, 0.9, 0.42, 0.9, 0, 2.5];
const STEM_T = 0.13;

/** Triangles of a turn arrow, flat a, b pairs. Local frame: +a right of travel, +b forward, metres at scale 1. */
export function arrowShape(left: boolean, straight: boolean, right: boolean, uturn: boolean): number[] {
  const out: number[] = [];
  const top = straight ? 0.9 : uturn ? 0.7 : -0.25;
  out.push(...rect(-STEM_T, -2.5, STEM_T, top));
  if (straight) out.push(...HEAD_STRAIGHT);
  const branch = (side: 1 | -1) => {
    out.push(...rect(side * STEM_T, -0.55, side * 0.7, -0.25));
    out.push(side * 0.7, -0.92, side * 0.7, 0.12, side * 1.7, -0.4);
  };
  if (left) branch(-1);
  if (right) branch(1);
  if (uturn) {
    out.push(...rect(-1.05, 0.42, STEM_T, 0.7));
    out.push(...rect(-1.05, -0.3, -0.79, 0.7));
    out.push(-1.34, -0.3, -0.5, -0.3, -0.92, -1.2);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The named standards a player paints with
// ---------------------------------------------------------------------------

export type LineStandardId = 'lane' | 'laneSolid' | 'edge' | 'centre' | 'centreDouble' | 'dotted' | 'guide' | 'stop' | 'giveWay' | 'zebra' | 'ladder' | 'crossLines';
export type FillStandardId = 'hatch' | 'gore' | 'solidFill';

export interface LineStandard {
  id: LineStandardId;
  name: string;
  /** What it is for, for tooltips. */
  tip: string;
  spec: LineStyleSpec;
  /** Dash and gap follow the road's speed: leave them unset on the marking. */
  speedDash?: true;
}

export interface FillStandard {
  id: FillStandardId;
  name: string;
  tip: string;
  spec: Pick<NodeFillerMarking, 'fill' | 'color' | 'width' | 'angle' | 'step' | 'noOutline'>;
}

export const LINE_STANDARDS: readonly LineStandard[] = [
  { id: 'lane', name: 'Lane line', tip: 'Dashed white between lanes going the same way; dash length follows the road speed', spec: { style: 'dashed', color: 'white', width: LINE_W.lane }, speedDash: true },
  { id: 'laneSolid', name: 'Solid lane line', tip: 'No changing lanes here', spec: { style: 'solid', color: 'white', width: LINE_W.lane } },
  { id: 'edge', name: 'Edge line', tip: 'Solid white along the edge of the carriageway', spec: { style: 'solid', color: 'white', width: LINE_W.edge } },
  { id: 'centre', name: 'Centre line', tip: 'Dashed yellow between the two directions', spec: { style: 'dashed', color: 'yellow', width: LINE_W.centre }, speedDash: true },
  { id: 'centreDouble', name: 'Centre double yellow', tip: 'No overtaking: two solid yellow lines', spec: { style: 'double', color: 'yellow', width: LINE_W.centre, gap: DOUBLE_SPACING - LINE_W.centre } },
  { id: 'dotted', name: 'Dotted line', tip: 'Short dashes, as at a lane drop or across a junction', spec: { style: 'dotted', color: 'white', width: LINE_W.lane, dash: DOT.dash, space: DOT.gap } },
  { id: 'guide', name: 'Junction guide', tip: 'Short dashes carrying a lane line through a junction', spec: { style: 'dashed', color: 'white', width: LINE_W.guide, dash: GUIDE_DASH.dash, space: GUIDE_DASH.gap } },
  { id: 'stop', name: 'Stop line', tip: 'Bar across the lanes coming in', spec: { style: 'stopLine', color: 'white', width: STOP.width } },
  { id: 'giveWay', name: 'Give-way teeth', tip: 'A row of triangles pointing at the driver', spec: { style: 'sharkTeeth', color: 'white', width: TEETH.length, dash: TEETH.base, space: TEETH.space } },
  { id: 'zebra', name: 'Zebra', tip: 'Zebra crossing, as the roads paint it', spec: { style: 'crosswalkZebra', color: 'white', width: CROSSWALK.depth, dash: CROSSWALK.stripe, space: CROSSWALK.gap } },
  { id: 'ladder', name: 'Ladder crossing', tip: 'Zebra stripes between two rails', spec: { style: 'crosswalkLadder', color: 'white', width: CROSSWALK.depth, dash: CROSSWALK.stripe, space: CROSSWALK.gap } },
  { id: 'crossLines', name: 'Two-line crossing', tip: 'Two parallel lines across the road', spec: { style: 'crosswalkLines', color: 'white', width: CROSSWALK.depth, dash: CROSSWALK.rail } },
];

export const FILL_STANDARDS: readonly FillStandard[] = [
  { id: 'hatch', name: 'Hatched area', tip: 'Diagonal stripes inside an edge line', spec: { fill: 'hatch', color: 'white', width: HATCH.stripe, step: HATCH.step } },
  { id: 'gore', name: 'Gore chevrons', tip: 'Chevrons as at a highway exit', spec: { fill: 'chevron', color: 'white', width: GORE.stripe, angle: 0, step: GORE.step } },
  { id: 'solidFill', name: 'Solid fill', tip: 'Paint the whole area', spec: { fill: 'solid', color: 'white', width: LINE_W.lane } },
];

export function lineStandard(id: LineStandardId): LineStandard {
  return LINE_STANDARDS.find((s) => s.id === id)!;
}

/** The standard look for a style when nothing else is set: what a new marking of that style starts as. */
export function standardForStyle(style: NodeLineStyle): LineStandard | null {
  switch (style) {
    case 'dashed':
      return lineStandard('lane');
    case 'solid':
      return lineStandard('laneSolid');
    case 'double':
      return lineStandard('centreDouble');
    case 'dotted':
      return lineStandard('dotted');
    case 'stopLine':
      return lineStandard('stop');
    case 'sharkTeeth':
      return lineStandard('giveWay');
    case 'crosswalkZebra':
      return lineStandard('zebra');
    case 'crosswalkLadder':
      return lineStandard('ladder');
    case 'crosswalkLines':
      return lineStandard('crossLines');
    default:
      return null;
  }
}

const near = (a: number | undefined, b: number | undefined) => (a === undefined && b === undefined) || (a !== undefined && b !== undefined && Math.abs(a - b) < 1e-6);

/**
 * The standard a look is, or null for a look of the player's own. A look with its
 * dashes unset on a speed-dashed style counts as that standard on any road.
 */
export function matchStandard(spec: LineStyleSpec): LineStandard | null {
  if (spec.hex || spec.offset || spec.align || spec.border) return null;
  for (const s of LINE_STANDARDS) {
    const t = s.spec;
    if (t.style !== spec.style || t.color !== spec.color || !near(t.width, spec.width)) continue;
    if (s.speedDash ? spec.dash !== undefined || spec.space !== undefined : !near(t.dash, spec.dash ?? t.dash) || !near(t.space, spec.space ?? t.space)) continue;
    if (t.gap !== undefined && !near(t.gap, spec.gap ?? t.gap)) continue;
    return s;
  }
  return null;
}

export function matchFillStandard(spec: Pick<NodeFillerMarking, 'fill' | 'color' | 'width' | 'step' | 'hex'>): FillStandard | null {
  if (spec.hex) return null;
  return FILL_STANDARDS.find((s) => s.spec.fill === spec.fill && s.spec.color === spec.color && (spec.fill === 'solid' || (near(s.spec.width, spec.width) && near(s.spec.step, spec.step ?? s.spec.step)))) ?? null;
}

/** The crosswalk look of an automatic crosswalk. */
export function crosswalkSpec(style: CrosswalkStyle): LineStyleSpec | null {
  switch (style) {
    case 'zebra':
      return lineStandard('zebra').spec;
    case 'ladder':
      return lineStandard('ladder').spec;
    case 'lines':
      return lineStandard('crossLines').spec;
    default:
      return null;
  }
}
