/**
 * Draft checks that concern track: curve and grade limits, track meeting a road,
 * and metro, which never crosses anything at grade.
 */
import type { Cubic } from './bezier';
import { curvatureXZ, cubicPoint } from './bezier';
import { cubicFootprint, footprintsClash, kioskFootprints, placedStationFootprint } from './footprint';
import { maxGrade } from './geometry';
import { segmentElectrification, trackSpec } from './railTypes';
import type { DraftIssue, RoadAnchor, RoadNetwork } from './RoadNetwork';
import type { Id, RoadTypeDef } from './types';
import { GRADE_CLEARANCE } from './terrain';

function pct(grade: number): string {
  return `${(grade * 100).toFixed(1)}%`;
}

function tightest(cubic: Cubic): { radius: number; t: number } {
  let kappa = 0;
  let t = 0;
  for (let i = 0; i <= 64; i++) {
    const k = Math.abs(curvatureXZ(cubic, i / 64));
    if (k > kappa) {
      kappa = k;
      t = i / 64;
    }
  }
  return { radius: kappa > 1e-9 ? 1 / kappa : Infinity, t };
}

/** Every road at an anchor, as one list of segment ids. */
function anchorSegments(net: RoadNetwork, a: RoadAnchor): Id[] {
  if (a.kind === 'segment') return [a.id];
  if (a.kind === 'node') return [...(net.getNode(a.id)?.segments ?? [])];
  return [];
}

/** Clearance between surfaces for a road over wired track: the wires need room. */
export const CLEARANCE_OVER_WIRES = 6;
/** Road over unwired track, or track over a road. */
export const CLEARANCE_RAIL = 5;

/**
 * The clearance a draft needs to pass over or under an existing segment without
 * meeting it. Two roads need GRADE_CLEARANCE. Anything over wired track needs room
 * for the wires; otherwise track and road need CLEARANCE_RAIL.
 */
export function crossingClearance(net: RoadNetwork, draft: RoadTypeDef, draftY: number, other: Id, otherY: number): number {
  const otherDef = net.roadTypeOf(other);
  const draftRail = draft.category === 'rail';
  const otherRail = otherDef.category === 'rail';
  if (!draftRail && !otherRail) return GRADE_CLEARANCE;
  const draftBelow = draftY < otherY;
  const lowerDef = draftBelow ? draft : otherDef;
  if (lowerDef.category === 'rail') {
    const seg = draftBelow ? undefined : net.getSegment(other);
    return segmentElectrification(lowerDef, seg?.overrides) === 'overhead' ? CLEARANCE_OVER_WIRES : CLEARANCE_RAIL;
  }
  return CLEARANCE_RAIL;
}

export function railDraftIssues(
  net: RoadNetwork,
  def: RoadTypeDef,
  cubic: Cubic,
  length: number,
  start: RoadAnchor,
  end: RoadAnchor,
  radius: number,
): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const isRail = def.category === 'rail';
  const spec = trackSpec(def.id);

  if (spec) {
    const grade = maxGrade(cubic);
    if (grade > spec.maxGrade + 1e-6) {
      issues.push({
        code: 'tooSteep',
        severity: 'error',
        message: `Too steep for track: ${pct(grade)} grade, the limit is ${pct(spec.maxGrade)}.`,
      });
    }
    if (radius < spec.minRadius - 1e-6) {
      const t = tightest(cubic).t;
      issues.push({
        code: 'tightCurve',
        severity: 'error',
        message: `Curve too tight for track: ${radius.toFixed(0)} m radius, needs ${spec.minRadius} m.`,
        at: cubicPoint(cubic, t),
      });
    }
  }

  // Track and road never join end to end, they can only cross.
  for (const a of [start, end]) {
    for (const id of anchorSegments(net, a)) {
      const other = net.roadTypeOf(id);
      if ((other.category === 'rail') === isRail) continue;
      issues.push({
        code: 'railCrossing',
        severity: 'error',
        message: isRail ? 'Track cannot join a road. Cross it instead.' : 'A road cannot join track. Cross it instead.',
      });
      break;
    }
  }

  const ignore = [start, end].flatMap((a) => (a.kind === 'node' ? [a.id] : []));
  for (const hit of net.findCrossings(cubic, ignore, def.id)) {
    if (!hit.atGrade) continue;
    const nearEnd = Math.min(hit.t, 1 - hit.t) * length < 0.5;
    if (nearEnd) continue;
    const other = net.roadTypeOf(hit.segmentId);
    const otherSpec = trackSpec(other.id);
    const metro = (spec?.metro && !!otherSpec === false) || (otherSpec?.metro && !isRail);
    const mixed = spec?.metro !== otherSpec?.metro && !!spec && !!otherSpec;
    if (metro || mixed) {
      issues.push({
        code: 'railCrossing',
        severity: 'error',
        message: `Metro track cannot cross at grade. It needs ${GRADE_CLEARANCE} m of clearance.`,
        at: hit.point,
      });
    }
  }
  // Roads and track pass over or under stations with clearance, never through them.
  const anchors = new Set<Id>([start, end].flatMap((x) => (x.kind === 'segment' ? [x.id] : x.kind === 'node' ? net.getNode(x.id)?.segments ?? [] : [])));
  const mine = cubicFootprint(cubic, def.halfWidth + def.sidewalk);
  for (const st of net.rail.stations) {
    if (anchors.has(st.segmentId)) continue;
    const box = placedStationFootprint(net, st);
    if (box && footprintsClash(mine, box)) {
      issues.push({ code: 'railCrossing', severity: 'error', message: `Runs through ${st.name} station. Pass over or under it with clearance.` });
      break;
    }
    if (!isRail && kioskFootprints(net, st).some((k) => footprintsClash(mine, k))) {
      issues.push({ code: 'railCrossing', severity: 'error', message: `Runs through an entrance of ${st.name} station.` });
      break;
    }
  }
  return issues;
}
