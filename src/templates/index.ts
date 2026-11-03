/**
 * Parametric interchange and junction stamps. See catalog.ts for the list and
 * blueprint.ts for the local coordinate convention.
 */
import type { Cubic, RoadNetwork } from '../core';
import { worldCubics, worldFrame, type Placement } from './blueprint';
import { TEMPLATES, buildBlueprint, findEntry, type TemplateCategory, type TemplateDef, type TemplateParam } from './catalog';
import { placementErrors, stampBlueprint, type StampResult, type StampedPort } from './stamp';

export { TEMPLATES };
export type { Placement, StampResult, StampedPort, TemplateCategory, TemplateDef, TemplateParam };

export type TemplateParams = Record<string, number>;

/**
 * Stamp a template as one batch. Reasons it cannot go here at all come back in
 * `problems` with nothing stamped. Anything else in `problems` is advice about how
 * it met roads that were already there.
 */
export function stampTemplate(net: RoadNetwork, id: string, params: TemplateParams, placement: Placement): StampResult {
  if (!findEntry(id)) return { segments: [], nodes: [], problems: [`Unknown template "${id}".`], ports: [] };
  return stampBlueprint(net, buildBlueprint(id, params, placement), placement);
}

/** The ghost curves of a template. Touches no network. */
export function previewTemplate(id: string, params: TemplateParams, placement: Placement): Cubic[] {
  if (!findEntry(id)) return [];
  return worldCubics(buildBlueprint(id, params, placement), worldFrame(placement));
}

/** Why a template cannot be placed here, for colouring a ghost. Empty when it can. */
export function placementProblems(id: string, params: TemplateParams, placement: Placement): string[] {
  if (!findEntry(id)) return [`Unknown template "${id}".`];
  return placementErrors(buildBlueprint(id, params, placement), worldFrame(placement));
}
