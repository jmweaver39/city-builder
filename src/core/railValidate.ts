/**
 * Draft checks that concern track: curve and grade limits, track meeting a road,
 * and metro, which never crosses anything at grade.
 */
import type { Cubic } from './bezier';
import { curvatureXZ, cubicPoint } from './bezier';
import { maxGrade } from './geometry';
import { trackSpec } from './railTypes';
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
  for (const hit of net.findCrossings(cubic, ignore)) {
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
  return issues;
}
