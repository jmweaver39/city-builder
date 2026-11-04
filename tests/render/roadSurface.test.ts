import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { RoadSurfaces } from '../../src/render/roadSurface';
import { setSurfaceDetail } from '../../src/render/materials';

/** Queued main-thread jobs, in order (Vitest has no Worker, so everything goes there). */
function queue(s: RoadSurfaces): string[] {
  const f = (s as unknown as { fallback: { req: { kind: string; size: number } }[] }).fallback;
  return f.map((j) => `${j.req.kind}-${j.req.size}`);
}

function drain(s: RoadSurfaces): void {
  for (let i = 0; i < 10000 && s.stats().pending; i++) s.update();
}

describe('road detail applied to the GPU textures', () => {
  it('binds the Low texture and nothing for concrete', () => {
    const s = new RoadSurfaces(16);
    s.setLevel('low');
    drain(s);
    const st = s.stats();
    expect(st.level).toBe('low');
    expect(st.asphalt).toBe(256);
    expect(st.concrete).toBe(0);
    expect(st.pending).toBe(0);
    expect(st.bytes).toBeLessThan(400_000);
    s.dispose();
  });

  it('queues small stand-ins first, so concrete never waits behind big asphalt', () => {
    const s = new RoadSurfaces(16);
    s.setLevel('ultra');
    expect(queue(s)).toEqual(['asphalt-256', 'concrete-512', 'concrete-2048', 'asphalt-4096']);
    s.dispose();
  });

  it('keeps the bound texture standing in while a new level generates', () => {
    const s = new RoadSurfaces(16);
    s.setLevel('low');
    drain(s);
    const low = s.uAsphalt.value;
    s.setLevel('medium');
    // Asphalt keeps showing the 256 until the 1024 arrives; the smaller concrete comes first.
    expect(s.uAsphalt.value).toBe(low);
    expect(queue(s)).toEqual(['concrete-512', 'asphalt-1024']);
    s.dispose();
  });

  it('switches the surface shader level once per change', () => {
    const m = new THREE.MeshStandardMaterial();
    setSurfaceDetail(m, 'ultra');
    expect(m.defines?.ROAD_DETAIL).toBe(3);
    const v = m.version;
    setSurfaceDetail(m, 'ultra');
    expect(m.version).toBe(v);
    setSurfaceDetail(m, 'low');
    expect(m.defines?.ROAD_DETAIL).toBe(0);
    expect(m.version).toBeGreaterThan(v);
  });
});
