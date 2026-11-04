/** Editor settings and edits for road structures, sound barriers and quays. */
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Id, SegmentOverrides } from '../core/types';
import { mirrorBarriers, mirrorStructure, segmentFootprintIssues } from '../core/walls';
import type { BarrierKind, BarrierSpec, QuayStyle, QuayTop, StructureMode, StructureSpec, WallSide, WallStyle, WallTop } from '../core/wallTypes';
import type { DraftIssue } from '../core/RoadNetwork';

/** Which sides get a wall. 'auto' leaves it to the mode: walls for retaining and trench. */
export type WallSides = 'auto' | 'both' | 'left' | 'right' | 'none';
/** What the Upgrade draw mode paints over roads. 'style' is a road copied with a middle click (clipboard.ts). */
export type UpgradeTarget = 'road' | 'structure' | 'barriers' | 'style';

export interface WallToolSettings {
  mode: StructureMode;
  sides: WallSides;
  style: WallStyle;
  top: WallTop;
  /** Most wall height, or null to follow the road. */
  height: number | null;
  barrier: BarrierKind;
  barrierHeight: number;
  barrierSides: 'both' | 'left' | 'right';
  upgrade: UpgradeTarget;
  quayStyle: QuayStyle;
  quayTop: QuayTop;
}

export function defaultWallSettings(): WallToolSettings {
  return {
    mode: 'auto',
    sides: 'auto',
    style: 'concrete',
    top: 'coping',
    height: null,
    barrier: 'concrete',
    barrierHeight: 3,
    barrierSides: 'both',
    upgrade: 'road',
    quayStyle: 'stone',
    quayTop: 'railing',
  };
}

export const WALL_SIDES: readonly { value: WallSides; label: string }[] = [
  { value: 'auto', label: 'Mode default' },
  { value: 'both', label: 'Both sides' },
  { value: 'left', label: 'Left only' },
  { value: 'right', label: 'Right only' },
  { value: 'none', label: 'No walls' },
];

export const UPGRADE_TARGETS: readonly { value: UpgradeTarget; label: string }[] = [
  { value: 'road', label: 'Road type' },
  { value: 'structure', label: 'Structure and walls' },
  { value: 'barriers', label: 'Sound barriers' },
  { value: 'style', label: 'Copied road style' },
];

/** The structure the settings describe, left and right as drawn. */
export function structureFromSettings(w: WallToolSettings): StructureSpec {
  const side = (s: -1 | 1): WallSide => {
    const on = w.sides === 'auto' ? undefined : w.sides === 'both' || (w.sides === 'left' ? s < 0 : w.sides === 'right' ? s > 0 : false);
    const out: WallSide = { style: w.style, top: w.top };
    if (on !== undefined) out.on = on;
    if (w.height !== null && w.height > 0) out.height = w.height;
    return out;
  };
  if (w.mode === 'auto') return { mode: 'auto' };
  return { mode: w.mode, left: side(-1), right: side(1) };
}

export function barriersFromSettings(w: WallToolSettings): BarrierSpec {
  // 'none' is kept on the chosen sides, so painting it clears them.
  const b = { kind: w.barrier, height: w.barrierHeight };
  return {
    left: w.barrierSides !== 'right' ? { ...b } : undefined,
    right: w.barrierSides !== 'left' ? { ...b } : undefined,
  };
}

/** Overrides a new road is drawn with. Empty for Auto with no barriers. */
export function drawOverrides(w: WallToolSettings): SegmentOverrides | undefined {
  if (w.mode === 'auto') return undefined;
  return { structure: structureFromSettings(w) };
}

/**
 * Set a segment's structure. `flipped` says the segment runs against the way the
 * settings' left and right were meant. Refused, with the reason, when the walls
 * would stand in another road.
 */
export function applyStructure(net: RoadNetwork, id: Id, spec: StructureSpec, flipped = false): DraftIssue | null {
  const s = flipped ? mirrorStructure(spec) : spec;
  const blocking = segmentFootprintIssues(net, id, s).find((i) => i.severity === 'error');
  if (blocking) return blocking;
  net.setSegmentOverrides(id, { structure: s.mode === 'auto' && !s.left && !s.right ? undefined : s });
  return null;
}

/** Set a segment's sound barriers, keeping a side the settings leave alone. */
export function applyBarriers(net: RoadNetwork, id: Id, spec: BarrierSpec, flipped = false, keepOther = true): void {
  const seg = net.getSegment(id);
  if (!seg) return;
  const s = flipped ? mirrorBarriers(spec) : spec;
  const now = seg.overrides.barriers ?? {};
  const next: BarrierSpec = keepOther ? { left: s.left ?? now.left, right: s.right ?? now.right } : s;
  if (!next.left || next.left.kind === 'none') delete next.left;
  if (!next.right || next.right.kind === 'none') delete next.right;
  net.setSegmentOverrides(id, { barriers: next.left || next.right ? next : undefined });
}

/** Remove every barrier on a segment. */
export function clearBarriers(net: RoadNetwork, id: Id): void {
  net.setSegmentOverrides(id, { barriers: undefined });
}
