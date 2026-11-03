/**
 * References to single automatic markings at a junction (types.ts AutoMarkingRef),
 * so one crosswalk, stop line, arrow, guide or gore can be taken away and brought
 * back. Pure helpers; the renderer reads `control.autoOff` to leave them out.
 */
import type { AutoMarkingRef, Id, JunctionControl } from './types';

export function sameAutoRef(a: AutoMarkingRef, b: AutoMarkingRef): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'stop':
      return a.segmentId === (b as typeof a).segmentId;
    case 'arrow':
      return a.segmentId === (b as typeof a).segmentId && a.lane === (b as typeof a).lane;
    case 'guide':
      return a.from === (b as typeof a).from && a.to === (b as typeof a).to && a.part === (b as typeof a).part;
    case 'gore': {
      const s = [...(b as typeof a).segments].sort((x, y) => x - y);
      const t = [...a.segments].sort((x, y) => x - y);
      return s.length === t.length && s.every((v, i) => v === t[i]);
    }
  }
}

/** Every segment a reference names. */
export function autoRefSegments(ref: AutoMarkingRef): Id[] {
  switch (ref.kind) {
    case 'stop':
    case 'arrow':
      return [ref.segmentId];
    case 'guide':
      return [ref.from, ref.to];
    case 'gore':
      return ref.segments;
  }
}

/** The reference with one segment id replaced, as when a segment is split. */
export function renameAutoRef(ref: AutoMarkingRef, from: Id, to: Id): AutoMarkingRef {
  const r = (id: Id) => (id === from ? to : id);
  switch (ref.kind) {
    case 'stop':
      return { kind: 'stop', segmentId: r(ref.segmentId) };
    case 'arrow':
      return { kind: 'arrow', segmentId: r(ref.segmentId), lane: ref.lane };
    case 'guide':
      return { kind: 'guide', from: r(ref.from), to: r(ref.to), part: ref.part };
    case 'gore':
      return { kind: 'gore', segments: ref.segments.map(r) };
  }
}

export function isAutoOff(control: Pick<JunctionControl, 'autoOff'> | undefined, ref: AutoMarkingRef): boolean {
  return !!control?.autoOff?.some((x) => sameAutoRef(x, ref));
}

/** A stable text key, for caches and lists. */
export function autoRefKey(ref: AutoMarkingRef): string {
  switch (ref.kind) {
    case 'stop':
      return `stop:${ref.segmentId}`;
    case 'arrow':
      return `arrow:${ref.segmentId}:${ref.lane}`;
    case 'guide':
      return `guide:${ref.from}>${ref.to}:${ref.part}`;
    case 'gore':
      return `gore:${[...ref.segments].sort((a, b) => a - b).join(',')}`;
  }
}
