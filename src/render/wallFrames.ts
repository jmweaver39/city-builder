/** Marks road frames with what a segment's structure setting forces (see core/walls.ts). */
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Id } from '../core/types';
import { isSunkEarth, structureOf } from '../core/walls';
import { ROAD_LIFT } from './constants';
import type { Frame } from './frames';

export function markStructureFrames(net: RoadNetwork, id: Id, frames: Frame[]): void {
  const mode = structureOf(net.getSegment(id)?.overrides).mode;
  if (mode === 'auto') return;
  for (const f of frames) {
    if (isSunkEarth(mode)) f.open = true;
    else if (mode === 'tunnel') f.covered = f.y - ROAD_LIFT < -0.6 && f.c < -0.3;
    else if (mode === 'pillars') f.viaduct = true;
  }
}
