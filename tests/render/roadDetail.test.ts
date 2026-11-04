import { describe, expect, it } from 'vitest';
import {
  ROAD_DETAIL,
  ROAD_DETAIL_STORAGE_KEY,
  loadRoadDetailPref,
  nextRoadDetailCap,
  resolveRoadDetail,
  roadDetailBytes,
  saveRoadDetailPref,
} from '../../src/render/roadDetail';
import { QualityGovernor } from '../../src/render/quality';
import { binding, findConflicts } from '../../src/ui/keymap';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('road detail setting', () => {
  it('defaults to auto and persists a choice', () => {
    const st = memoryStorage();
    expect(loadRoadDetailPref(st)).toBe('auto');
    saveRoadDetailPref(st, 'ultra');
    expect(st.data.get(ROAD_DETAIL_STORAGE_KEY)).toBe('ultra');
    expect(loadRoadDetailPref(st)).toBe('ultra');
    st.data.set(ROAD_DETAIL_STORAGE_KEY, 'bogus');
    expect(loadRoadDetailPref(st)).toBe('auto');
  });

  it('survives blocked storage', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadRoadDetailPref(blocked)).toBe('auto');
    expect(() => saveRoadDetailPref(blocked, 'low')).not.toThrow();
    expect(loadRoadDetailPref(null)).toBe('auto');
  });

  it('follows graphics quality on auto and holds an explicit choice', () => {
    expect(resolveRoadDetail('auto', 'medium', null)).toBe('medium');
    expect(resolveRoadDetail('auto', 'ultra', null)).toBe('ultra');
    expect(resolveRoadDetail('low', 'ultra', null)).toBe('low');
    expect(resolveRoadDetail('ultra', 'low', null)).toBe('ultra');
    // A cap only lowers.
    expect(resolveRoadDetail('ultra', 'high', 'medium')).toBe('medium');
    expect(resolveRoadDetail('low', 'high', 'medium')).toBe('low');
  });

  it('steps down with the governor and back up, never past the choice', () => {
    let cap = nextRoadDetailCap('ultra', 'high', null, true);
    expect(cap).toBe('high');
    cap = nextRoadDetailCap('ultra', 'medium', cap, true);
    expect(cap).toBe('medium');
    cap = nextRoadDetailCap('ultra', 'low', cap, false);
    expect(cap).toBe('high');
    cap = nextRoadDetailCap('ultra', 'medium', cap, false);
    expect(cap).toBeNull();
    expect(nextRoadDetailCap('low', 'high', null, true)).toBe('low');
  });

  it('is driven by the quality governor', () => {
    const g = new QualityGovernor();
    expect(g.roadDetail('ultra', 'high')).toBe('ultra');
    // Feed long frames until it steps down.
    let next = null;
    for (let i = 0; i < 200 && !next; i++) next = g.sample(0.05, 'high');
    expect(next).toBe('medium');
    g.stepRoadDetail('ultra', 'high', true);
    expect(g.roadDetail('ultra', 'medium')).toBe('high');
    expect(g.roadDetail('auto', 'medium')).toBe('medium');
  });

  it('sizes textures per level and Low has no normal-mapped concrete', () => {
    expect(ROAD_DETAIL.low.asphalt).toBeLessThanOrEqual(256);
    expect(ROAD_DETAIL.low.concrete).toBe(0);
    expect(ROAD_DETAIL.high.asphalt).toBe(2048);
    expect(ROAD_DETAIL.ultra.asphalt).toBe(4096);
    expect(roadDetailBytes('low')).toBeLessThan(1e6);
    expect(roadDetailBytes('ultra')).toBeGreaterThan(roadDetailBytes('high'));
  });

  it('is in the command palette without clashing keys', () => {
    for (const id of ['auto', 'low', 'medium', 'high', 'ultra']) expect(binding(`view.roadDetail.${id}`)?.run).toBeTypeOf('function');
    expect(findConflicts()).toEqual([]);
  });
});
