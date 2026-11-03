/**
 * Marking templates: a junction's (or a segment's) hand-placed markings stored by
 * arm index and by boundary counted left to right looking into the junction, so
 * they fit another junction with the same arm layout. Matching tries every
 * rotation, and the mirror image, scoring how well the arm directions agree. Copy
 * and paste use the same capture and apply.
 */
import { framesOf, hostOf, type HostArg } from './nodeMarkings';
import { mirroredStyle } from './markingStyle';
import type { RoadNetwork } from './RoadNetwork';
import type {
  LineRule,
  MarkingAnchor,
  MarkingHost,
  MarkingPointSetting,
  MarkingTemplate,
  NodeMarking,
  RuleBound,
  TemplateArm,
} from './types';

const TAU = Math.PI * 2;

interface TargetArm {
  segmentId: number;
  end?: 'a' | 'b';
  /** Radians, plan direction away from the host. */
  angle: number;
  boundaries: number;
  /** 1 when boundary indexes already run left to right as seen, -1 when they run the other way. */
  seenSign: 1 | -1;
}

/** The arms of a host in template order: clockwise round a node, or a then b along a segment. */
export function templateArms(net: RoadNetwork, hostArg: HostArg): TargetArm[] {
  const host = hostOf(hostArg);
  const frames = framesOf(net, host);
  return frames.map((f) => ({
    segmentId: f.segmentId,
    end: f.end,
    // Away from the host: against the inward direction at a node, along the road on a segment.
    angle: host.kind === 'node' ? Math.atan2(-f.inward.z, -f.inward.x) : f.end === 'a' ? 0 : Math.PI,
    boundaries: f.offsets.length,
    seenSign: f.seenSign,
  }));
}

const wrap = (a: number) => ((a % TAU) + TAU) % TAU;
const angleDiff = (a: number, b: number) => {
  const d = Math.abs(wrap(a) - wrap(b));
  return Math.min(d, TAU - d);
};

/** Boundary index as seen, left to right, from a segment's own index. */
const seenIndex = (b: number, count: number, seenSign: 1 | -1) => (seenSign === 1 ? b : count - 1 - b);

/** Capture a host's markings as a template. */
export function captureTemplate(net: RoadNetwork, hostArg: HostArg, name: string, id: string): MarkingTemplate {
  const host = hostOf(hostArg);
  const arms = templateArms(net, host);
  const index = (a: Pick<MarkingAnchor, 'segmentId' | 'end'>) => arms.findIndex((x) => x.segmentId === a.segmentId && x.end === a.end);
  const list = net.markingsOf(host);
  const order = new Map(list.map((m, i) => [m.id, i]));
  const anchor = (a: MarkingAnchor): MarkingAnchor => {
    const i = index(a);
    const arm = arms[i];
    const out: MarkingAnchor = { segmentId: i, boundary: a.corner !== undefined ? 0 : seenIndex(a.boundary, arm.boundaries, arm.seenSign) };
    if (a.corner !== undefined) out.corner = a.corner;
    if (a.back) out.back = a.back;
    if (a.end) out.end = a.end;
    return out;
  };
  const bound = (b: RuleBound): RuleBound => ('cross' in b ? { cross: order.get(b.cross) ?? -1 } : b);
  const markings: NodeMarking[] = list.map((m, i) => {
    const copy = structuredClone(m);
    copy.id = i;
    if (copy.kind === 'line' && m.kind === 'line') {
      copy.from = anchor(m.from);
      copy.to = anchor(m.to);
      if (copy.rules) copy.rules = copy.rules.map((r) => ({ ...r, from: bound(r.from), to: bound(r.to) }));
    } else if (copy.kind === 'filler' && m.kind === 'filler') {
      copy.anchors = m.anchors.map(anchor);
    }
    return copy;
  });
  const points = net.pointsOf(host).map((p) => {
    const i = index(p);
    const out: MarkingPointSetting = { ...structuredClone(p), segmentId: i, boundary: seenIndex(p.boundary, arms[i].boundaries, arms[i].seenSign) };
    return out;
  });
  const first = arms[0]?.angle ?? 0;
  const tArms: TemplateArm[] = arms.map((a) => ({ angle: wrap(a.angle - first), boundaries: a.boundaries }));
  const tpl: MarkingTemplate = { id, name, host: host.kind, arms: tArms, markings, points };
  if (host.kind === 'node' && net.getNode(host.id)?.control.hideAutoMarkings) tpl.hideAutoMarkings = true;
  return tpl;
}

export interface TemplateFit {
  /** Template arm i lands on target arm (i + shift) mod n, or (shift - i) mod n mirrored. */
  shift: number;
  mirror: boolean;
  /** Radians of disagreement summed over the arms, plus a penalty per arm whose lane count differs. */
  score: number;
}

/** Every way a template could sit on a host, best first. Empty when the arm counts differ. */
export function fitTemplate(net: RoadNetwork, hostArg: HostArg, tpl: MarkingTemplate): TemplateFit[] {
  const host = hostOf(hostArg);
  if (tpl.host !== host.kind) return [];
  const arms = templateArms(net, host);
  const n = arms.length;
  if (n !== tpl.arms.length || n === 0) return [];
  const out: TemplateFit[] = [];
  for (const mirror of [false, true]) {
    for (let shift = 0; shift < n; shift++) {
      const map = (i: number) => (mirror ? (shift - i + n * 2) % n : (i + shift) % n);
      const base = arms[map(0)].angle;
      let score = 0;
      for (let i = 0; i < n; i++) {
        // In a mirror, turning clockwise becomes turning anticlockwise.
        const want = mirror ? -tpl.arms[i].angle : tpl.arms[i].angle;
        score += angleDiff(arms[map(i)].angle - base, want);
        if (arms[map(i)].boundaries !== tpl.arms[i].boundaries) score += 0.3;
      }
      out.push({ shift, mirror, score });
    }
  }
  return out.sort((a, b) => a.score - b.score || Number(a.mirror) - Number(b.mirror) || a.shift - b.shift);
}

/** More than one fit is about as good as the best: the user should choose by rotating or mirroring. */
export function isAmbiguous(fits: readonly TemplateFit[]): boolean {
  return fits.length > 1 && fits[1].score - fits[0].score < 0.2;
}

export interface ApplyResult {
  markings: NodeMarking[];
  points: MarkingPointSetting[];
}

/**
 * The markings and point settings a template gives a host for one fit, with fresh
 * ids. Null when the template does not fit the host at all.
 */
export function templateOn(net: RoadNetwork, hostArg: HostArg, tpl: MarkingTemplate, fit: Pick<TemplateFit, 'shift' | 'mirror'>): ApplyResult | null {
  const host = hostOf(hostArg);
  if (tpl.host !== host.kind) return null;
  const arms = templateArms(net, host);
  const n = arms.length;
  if (n !== tpl.arms.length || n === 0) return null;
  const { shift, mirror } = fit;
  const map = (i: number) => (mirror ? (shift - i + n * 2) % n : (i + shift) % n);
  const boundary = (tplArm: number, seen: number): number => {
    const arm = arms[map(tplArm)];
    const from = tpl.arms[tplArm].boundaries;
    const c = arm.boundaries;
    let nb = from === c ? seen : Math.round((seen * (c - 1)) / Math.max(1, from - 1));
    nb = Math.max(0, Math.min(c - 1, nb));
    if (mirror) nb = c - 1 - nb;
    return arm.seenSign === 1 ? nb : c - 1 - nb;
  };
  const anchor = (a: MarkingAnchor): MarkingAnchor | null => {
    const i = a.segmentId;
    if (i < 0 || i >= n) return null;
    if (a.corner !== undefined) {
      // A kerb runs from arm i clockwise to arm i + 1. In a mirror it runs from the
      // image of i + 1 to the image of i, the other way.
      const arm = mirror ? arms[map((i + 1) % n)] : arms[map(i)];
      return { segmentId: arm.segmentId, boundary: 0, corner: mirror ? Math.round((1 - a.corner) * 1e6) / 1e6 : a.corner, ...(a.back ? { back: a.back } : {}) };
    }
    const arm = arms[map(i)];
    const out: MarkingAnchor = { segmentId: arm.segmentId, boundary: boundary(i, a.boundary) };
    if (a.back) out.back = a.back;
    if (arm.end) out.end = arm.end;
    return out;
  };
  const out: NodeMarking[] = [];
  for (const m of tpl.markings) {
    const copy = structuredClone(m);
    if (copy.kind === 'line') {
      const from = anchor(copy.from);
      const to = anchor(copy.to);
      if (!from || !to) continue;
      copy.from = from;
      copy.to = to;
      if (mirror) {
        Object.assign(copy, mirroredStyle(copy));
        if (copy.rules) copy.rules = copy.rules.map((r: LineRule) => ({ ...r, style: mirroredStyle(r.style) }));
      }
    } else {
      const anchors = copy.anchors.map(anchor);
      if (anchors.some((a) => !a)) continue;
      copy.anchors = anchors as MarkingAnchor[];
      if (mirror) {
        copy.anchors = copy.anchors.reverse();
        if (copy.angle) copy.angle = -copy.angle;
      }
    }
    out.push(copy);
  }
  // Template ids are list positions; parts name crossing lines by them.
  const fresh = net.freshMarkingIds(out);
  const byOld = new Map(out.map((m, i) => [m.id, fresh[i].id]));
  for (const m of fresh) {
    if (m.kind !== 'line' || !m.rules) continue;
    m.rules = m.rules
      .map((r) => ({
        ...r,
        from: 'cross' in r.from ? (byOld.has(r.from.cross) ? { cross: byOld.get(r.from.cross)! } : null) : r.from,
        to: 'cross' in r.to ? (byOld.has(r.to.cross) ? { cross: byOld.get(r.to.cross)! } : null) : r.to,
      }))
      .filter((r): r is LineRule => r.from !== null && r.to !== null);
  }
  const points: MarkingPointSetting[] = [];
  for (const p of tpl.points) {
    if (p.segmentId < 0 || p.segmentId >= n) continue;
    const arm = arms[map(p.segmentId)];
    const out: MarkingPointSetting = { segmentId: arm.segmentId, boundary: boundary(p.segmentId, p.boundary) };
    if (arm.end) out.end = arm.end;
    if (p.offset) out.offset = mirror ? -p.offset : p.offset;
    if (p.place) out.place = mirror ? (p.place === 'left' ? 'right' : 'left') : p.place;
    if (p.off) out.off = true;
    points.push(out);
  }
  return { markings: fresh, points };
}

/** Put a template on a host, replacing its markings, in one batch. False when it does not fit. */
export function applyTemplate(net: RoadNetwork, hostArg: HostArg, tpl: MarkingTemplate, fit?: Pick<TemplateFit, 'shift' | 'mirror'>): boolean {
  const host: MarkingHost = hostOf(hostArg);
  const chosen = fit ?? fitTemplate(net, host, tpl)[0];
  if (!chosen) return false;
  let ok = false;
  net.batch(() => {
    const result = templateOn(net, host, tpl, chosen);
    if (!result) return;
    net.setMarkings(host, result.markings, result.points);
    if (host.kind === 'node') net.setHideAutoMarkings(host.id, !!tpl.hideAutoMarkings);
    ok = true;
  });
  return ok;
}
