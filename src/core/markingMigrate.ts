/**
 * Older saves to the shared marking standard (core/paintStandard.ts). Placement is
 * never touched: anchors, pieces, offsets and points stay exactly as saved. Only
 * the look moves. A measure that was the old built-in default (or unset) becomes
 * the standard's, so old default paint now matches the roads' own lines; a measure
 * the player chose stays as it was. Decals gain a `style` (or `fill`) in the same
 * vocabulary as hand-placed markings. Running it twice changes nothing.
 */
import { CROSSWALK, DOT, DOUBLE_SPACING, LINE_W, TEETH, lineStandard } from './paintStandard';
import type { Decal, LineStyleSpec, NodeFillerMarking, NodeLineMarking, NodeLineStyle, NodeMarking, Project } from './types';

/** The defaults each line style had before the standard, for telling defaults from choices. */
const OLD_LINE_DEFAULTS: Partial<Record<NodeLineStyle, { width: number[]; dash?: number; space?: number; gap?: number }>> = {
  solid: { width: [0.15, 0.16] },
  dashed: { width: [0.15, 0.16], dash: 3, space: 3 },
  double: { width: [0.12, 0.16], gap: 0.12 },
  doubleDashed: { width: [0.12, 0.16], gap: 0.12, dash: 0.6, space: 0.3 },
  solidDashed: { width: [0.12, 0.16], gap: 0.12, dash: 3, space: 3 },
  dashedSolid: { width: [0.12, 0.16], gap: 0.12, dash: 3, space: 3 },
  dotted: { width: [0.18, 0.16], dash: 0.18, space: 0.42 },
  zigzag: { width: [0.12, 0.16], dash: 1, gap: 0.5 },
  sharkTeeth: { width: [0.6], dash: 0.45, space: 0.3 },
  stopLine: { width: [0.45] },
  crosswalkZebra: { width: [3], dash: 0.5, space: 0.5 },
  crosswalkDoubleZebra: { width: [5], dash: 0.5, space: 0.5, gap: 0.4 },
  crosswalkLadder: { width: [3], dash: 0.5, space: 0.5 },
  crosswalkLines: { width: [3], dash: 0.3 },
  crosswalkSolid: { width: [3] },
  crosswalkChessboard: { width: [3], dash: 0.6 },
};

/** New defaults, from the standard. */
const NEW_WIDTH: Partial<Record<NodeLineStyle, number>> = {
  solid: LINE_W.lane,
  dashed: LINE_W.lane,
  double: LINE_W.centre,
  doubleDashed: LINE_W.lane,
  solidDashed: LINE_W.centre,
  dashedSolid: LINE_W.centre,
  dotted: LINE_W.lane,
  zigzag: LINE_W.lane,
  sharkTeeth: TEETH.length,
  stopLine: LINE_W.stop,
};

const OLD_FILL_DEFAULTS: Record<string, { width: number[]; step: number }> = {
  stripes: { width: [0.3, 0.25], step: 1.4 },
  hatch: { width: [0.3, 0.25], step: 1.4 },
  chevron: { width: [0.4, 0.25], step: 2 },
  grid: { width: [0.15, 0.25], step: 1.5 },
  triangle: { width: [0.3, 0.25], step: 2 },
  solid: { width: [0.2, 0.25], step: 0 },
};

const eq = (a: number | undefined, b: number | undefined) => a !== undefined && b !== undefined && Math.abs(a - b) < 1e-6;

/** A line look with its old defaults moved to the standard. Returns the same object when nothing changes. */
export function migrateLineLook<T extends LineStyleSpec>(spec: T): T {
  const old = OLD_LINE_DEFAULTS[spec.style];
  if (!old) return spec;
  const out = { ...spec };
  let changed = false;
  const drop = (k: 'dash' | 'space' | 'gap') => {
    if (out[k] !== undefined && eq(out[k], old[k])) {
      delete out[k];
      changed = true;
    }
  };
  drop('dash');
  drop('space');
  drop('gap');
  const nw = NEW_WIDTH[spec.style];
  if (nw !== undefined && old.width.some((w) => eq(w, out.width)) && !eq(out.width, nw)) {
    out.width = nw;
    changed = true;
  }
  return changed ? out : spec;
}

export function migrateFillLook<T extends Pick<NodeFillerMarking, 'fill' | 'width' | 'step'>>(m: T): T {
  const old = OLD_FILL_DEFAULTS[m.fill];
  if (!old) return m;
  const out = { ...m };
  let changed = false;
  if (out.step !== undefined && eq(out.step, old.step)) {
    delete out.step;
    changed = true;
  }
  if (old.width.some((w) => eq(w, out.width))) {
    const nw = m.fill === 'chevron' ? 0.4 : m.fill === 'grid' ? 0.15 : m.fill === 'solid' ? LINE_W.lane : 0.3;
    if (!eq(out.width, nw)) {
      out.width = nw;
      changed = true;
    }
  }
  return changed ? out : m;
}

function migrateMarking(m: NodeMarking): NodeMarking {
  if (m.kind === 'filler') return migrateFillLook(m);
  let out: NodeLineMarking = migrateLineLook(m);
  if (out.rules?.length) {
    const rules = out.rules.map((r) => {
      const style = migrateLineLook(r.style);
      return style === r.style ? r : { ...r, style };
    });
    if (rules.some((r, i) => r !== out.rules![i])) out = { ...out, rules };
  }
  return out;
}

/** The old Paint tool default width, which now means "the standard". */
const OLD_DECAL_WIDTH = 0.2;

/**
 * The look an older decal had, in the shared vocabulary, or null for stamps that
 * have none (arrows, text) and for areas (see `legacyDecalFill`).
 */
export function legacyDecalLook(d: Pick<Decal, 'kind' | 'lineStyle' | 'color' | 'width'>): LineStyleSpec | null {
  const w = d.width > 0 ? d.width : OLD_DECAL_WIDTH;
  const color = d.color;
  const isDefault = eq(w, OLD_DECAL_WIDTH);
  const std = (id: Parameters<typeof lineStandard>[0]): LineStyleSpec => ({ ...lineStandard(id).spec, color });
  // Old auto strokes were scaled by width / 0.14, double centres 0.32 apart at 0.14.
  const scaledGap = w * (DOUBLE_SPACING / LINE_W.lane) - w;
  if (d.kind === 'line' || d.kind === 'dashedLine' || d.kind === 'doubleLine') {
    const ls = d.kind === 'dashedLine' ? 'legacyDashed' : d.kind === 'doubleLine' ? 'legacyDouble' : (d.lineStyle ?? 'solid');
    switch (ls) {
      case 'none':
      case 'solid':
        return isDefault ? std('laneSolid') : { style: 'solid', color, width: w };
      case 'dashed':
        return isDefault ? std('lane') : { style: 'dashed', color, width: w, dash: 3, space: 6 };
      case 'legacyDashed':
        return isDefault ? std('lane') : { style: 'dashed', color, width: w, dash: 3, space: 3 };
      case 'dotted':
        return isDefault ? std('dotted') : { style: 'dotted', color, width: w, dash: DOT.dash, space: DOT.gap };
      case 'legacyDouble':
        return isDefault ? std('centreDouble') : { style: 'double', color, width: w, gap: DOUBLE_SPACING };
      case 'double':
        return isDefault ? std('centreDouble') : { style: 'double', color, width: w, gap: scaledGap };
      case 'solidDashed':
      case 'dashedSolid':
        return isDefault ? { style: ls, color, width: LINE_W.centre, gap: DOUBLE_SPACING - LINE_W.centre } : { style: ls, color, width: w, gap: scaledGap, dash: 3, space: 6 };
    }
    return std('laneSolid');
  }
  switch (d.kind) {
    case 'crosswalk': {
      const depth = Math.max(w, 2);
      return eq(d.width, 3) ? std('zebra') : { style: 'crosswalkZebra', color, width: depth, dash: CROSSWALK.stripe, space: CROSSWALK.gap };
    }
    case 'stopLine':
      return eq(d.width, 0.5) ? std('stop') : { style: 'stopLine', color, width: Math.max(w, LINE_W.stop) };
    case 'yieldTriangles': {
      if (eq(d.width, 0.8)) return std('giveWay');
      const size = Math.max(w, 0.6);
      return { style: 'sharkTeeth', color, width: 0.95 * size, dash: 0.8 * size, space: 0.25 * size };
    }
    default:
      return null;
  }
}

export function legacyDecalFill(d: Pick<Decal, 'kind' | 'color'>): Decal['fill'] | undefined {
  if (d.kind === 'hatch') return { fill: 'hatch', color: d.color, width: 0.3, step: 1.6 };
  if (d.kind === 'fill') return { fill: 'solid', color: d.color, width: LINE_W.lane };
  return undefined;
}

/** One decal in the current shape. Returns the same object when nothing changes. */
export function migrateDecal(d: Decal): Decal {
  if (d.style || d.fill) return d;
  const look = legacyDecalLook(d);
  if (look) {
    const out: Decal = { ...d, kind: d.kind === 'dashedLine' || d.kind === 'doubleLine' ? 'line' : d.kind, style: look, width: look.width };
    delete out.lineStyle;
    return out;
  }
  const fill = legacyDecalFill(d);
  if (fill) return { ...d, fill };
  return d;
}

/** Bring every marking and decal of a project to the standard, in place. */
export function migrateMarkingLooks(p: Project): void {
  p.decals = p.decals.map(migrateDecal);
  for (const n of p.nodes) {
    if (n.control.markings) n.control.markings = n.control.markings.map(migrateMarking);
  }
  for (const s of p.segments) {
    if (s.overrides.handMarkings) s.overrides.handMarkings = s.overrides.handMarkings.map(migrateMarking);
  }
}
