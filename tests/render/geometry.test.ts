import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core/RoadNetwork';
import type { Vec3 } from '../../src/core/types';
import { ChunkBatch, HoleBuf, PAINT_SCHEMA, PaintBuf, SURF_SCHEMA, SurfBuf } from '../../src/render/batch';
import { buildSegmentPaint, arrowShape } from '../../src/render/markings';
import { buildSegment } from '../../src/render/roads';
import { buildJunction } from '../../src/render/junctions';
import { strokesOf } from '../../src/render/constants';
import { BuildingBuf, buildZone } from '../../src/render/endpoints';
import { buildModels } from '../../src/render/vehicleModels';
import * as THREE from 'three';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

function sampleNetwork(): RoadNetwork {
  const net = new RoadNetwork();
  net.drawRoad({ start: { kind: 'free', pos: v(-200, 0, 0) }, end: { kind: 'free', pos: v(200, 0, 0) }, roadType: 'avenue-4' });
  net.drawRoad({ start: { kind: 'free', pos: v(0, 0, -200) }, end: { kind: 'free', pos: v(0, 0, 200) }, roadType: 'street-4' });
  // Over the river, and down into a tunnel.
  net.drawRoad({ start: { kind: 'free', pos: v(600, 0, 0) }, end: { kind: 'free', pos: v(640, 0, 900) }, c1: v(600, 12, 300), c2: v(640, 12, 600), roadType: 'highway-2' });
  net.drawRoad({ start: { kind: 'free', pos: v(-900, 0, -500) }, end: { kind: 'free', pos: v(-300, 0, -500) }, c1: v(-700, -22, -500), c2: v(-500, -22, -500), roadType: 'street-2' });
  return net;
}

function outputs() {
  return { surf: new SurfBuf(), tube: new SurfBuf(), plug: new SurfBuf(), hole: new HoleBuf() };
}

describe('road meshing', () => {
  it('produces finite, unit-normal, in-range geometry for every segment and node', () => {
    const net = sampleNetwork();
    const check = (buf: SurfBuf) => {
      for (const c of buf.pos) expect(Number.isFinite(c)).toBe(true);
      for (let i = 0; i < buf.nor.length; i += 3) {
        expect(Math.hypot(buf.nor[i], buf.nor[i + 1], buf.nor[i + 2])).toBeCloseTo(1, 3);
      }
      const n = buf.vertexCount;
      for (const i of buf.idx) expect(i).toBeLessThan(n);
    };
    for (const s of net.segments) {
      const o = outputs();
      buildSegment(net, s.id, 1, o);
      expect(o.surf.vertexCount).toBeGreaterThan(0);
      check(o.surf);
      check(o.tube);
    }
    for (const n of net.nodes) {
      const o = outputs();
      buildJunction(net, n.id, 1, o);
      check(o.surf);
    }
  });

  it('winds road tops counter-clockwise from above', () => {
    const net = sampleNetwork();
    const o = outputs();
    buildSegment(net, net.segments[0].id, 1, o);
    const b = o.surf;
    const p = (i: number) => new THREE.Vector3(b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]);
    const n = (i: number) => new THREE.Vector3(b.nor[i * 3], b.nor[i * 3 + 1], b.nor[i * 3 + 2]);
    for (let t = 0; t < b.idx.length; t += 3) {
      const [i0, i1, i2] = [b.idx[t], b.idx[t + 1], b.idx[t + 2]];
      const face = p(i1).sub(p(i0)).cross(p(i2).sub(p(i0)));
      if (face.lengthSq() < 1e-8) continue;
      expect(face.dot(n(i0))).toBeGreaterThan(0);
    }
  });

  it('adds tunnel tube and terrain cut only to roads that dip below ground', () => {
    const net = sampleNetwork();
    let tubes = 0;
    let holes = 0;
    for (const s of net.segments) {
      const o = outputs();
      buildSegment(net, s.id, 1, o);
      if (o.tube.vertexCount) tubes++;
      if (o.hole.pos.length) holes++;
    }
    expect(tubes).toBe(1);
    expect(holes).toBe(1);
  });
});

describe('markings', () => {
  it('paints finite geometry and honours crosswalk overrides', () => {
    const net = sampleNetwork();
    const node = net.nodes.find((n) => net.nodeGeom(n.id)?.kind === 'junction')!;
    const seg = node.segments[0];
    const count = () => {
      const buf = new PaintBuf();
      buildSegmentPaint(net, seg, buf);
      for (const c of buf.pos) expect(Number.isFinite(c)).toBe(true);
      return buf.vertexCount;
    };
    net.setCrosswalk(node.id, seg, 'zebra');
    const zebra = count();
    net.setCrosswalk(node.id, seg, 'none');
    const none = count();
    net.setCrosswalk(node.id, seg, 'ladder');
    const ladder = count();
    expect(zebra).toBeGreaterThan(none);
    expect(ladder).toBeGreaterThan(zebra);
  });

  it('has strokes for each line style', () => {
    expect(strokesOf('none')).toHaveLength(0);
    expect(strokesOf('solid')).toHaveLength(1);
    expect(strokesOf('double')).toHaveLength(2);
    const sd = strokesOf('solidDashed');
    expect(sd[0].period).toBe(0);
    expect(sd[1].period).toBeGreaterThan(0);
  });

  it('builds arrows from whole triangles', () => {
    expect(arrowShape(true, true, true, true).length % 6).toBe(0);
  });
});

describe('ChunkBatch', () => {
  it('re-merges only what changed and removes empty chunks', () => {
    const batch = new ChunkBatch(PAINT_SCHEMA, new THREE.MeshBasicMaterial(), { chunkSize: 100 });
    const piece = (x: number) => {
      const b = new PaintBuf();
      b.bar(x, 0, 0, x + 5, 0, 0, 1, [1, 1, 1]);
      return b.toPiece();
    };
    batch.set(1, piece(10));
    batch.set(2, piece(20));
    batch.set(3, piece(500));
    batch.flush();
    expect(batch.group.children).toHaveLength(2);
    const far = batch.group.children.find((m) => (m as THREE.Mesh).geometry.boundingSphere!.center.x > 100) as THREE.Mesh;
    batch.set(1, null);
    batch.flush();
    // The untouched chunk keeps its mesh.
    expect(batch.group.children).toContain(far);
    batch.set(3, null);
    batch.flush();
    expect(batch.group.children).toHaveLength(1);
    expect(SURF_SCHEMA.map((a) => a.name)).toContain("aRoad");
  });
});

/** Signed volume of a triangle soup. Positive when faces point outward. */
function signedVolume(pos: ArrayLike<number>, idx?: ArrayLike<number>): number {
  let v = 0;
  const n = idx ? idx.length : pos.length / 3;
  const at = (k: number) => {
    const i = (idx ? idx[k] : k) * 3;
    return [pos[i], pos[i + 1], pos[i + 2]];
  };
  // Measured about the first vertex, so position in the world does not matter.
  const o = at(0);
  for (let k = 0; k + 2 < n; k += 3) {
    const a = at(k).map((c, i) => c - o[i]);
    const b = at(k + 1).map((c, i) => c - o[i]);
    const c = at(k + 2).map((q, i) => q - o[i]);
    v += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return v / 6;
}

describe('procedural solids face outward', () => {
  const headings: [number, number][] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
    [Math.SQRT1_2, -Math.SQRT1_2],
  ];
  const wall = [0.5, 0.5, 0.5] as const;

  it('building blocks and roofs, at every heading', () => {
    for (const [fx, fz] of headings) {
      const box = new BuildingBuf();
      box.block(30, 2, -40, 5, 3, 7, fx, fz, wall, wall, 1, 0);
      // Five faces of a box, open at the bottom, volume about half the sum of a closed one.
      expect(signedVolume(box.pos, box.idx)).toBeGreaterThan(100);
      const roof = new BuildingBuf();
      roof.gable(30, 2, -40, 5, 3, 2, fx, fz, wall, wall);
      expect(signedVolume(roof.pos, roof.idx)).toBeGreaterThan(0);
    }
  });

  it('every wall normal points away from the centre of its building', () => {
    const box = new BuildingBuf();
    box.block(10, 0, 20, 4, 6, 5, 0.6, 0.8, wall, wall, 1, 0);
    for (let i = 0; i < box.idx.length; i += 6) {
      const a = box.idx[i] * 3;
      const face = [(box.pos[a] + box.pos[box.idx[i + 2] * 3]) / 2 - 10, (box.pos[a + 2] + box.pos[box.idx[i + 2] * 3 + 2]) / 2 - 20];
      const out = box.nor[a] * face[0] + box.nor[a + 2] * face[1];
      if (Math.abs(box.nor[a + 1]) < 0.5) expect(out).toBeGreaterThan(0);
    }
  });

  it('whole zones of each kind', () => {
    const net = new RoadNetwork();
    const seg = net.drawRoad({ start: { kind: 'free', pos: v(-300, 0, -300) }, end: { kind: 'free', pos: v(300, 0, -300) }, roadType: 'street-2' }).segments[0];
    for (const kind of ['residential', 'commercial', 'industrial', 'office'] as const) {
      for (const side of [1, -1] as const) {
        const id = net.addEndpoint({ kind, segmentId: seg, t: 0.5, side, ratePerHour: 400 });
        const buf = new BuildingBuf();
        expect(buildZone(net, net.endpoints.find((e) => e.id === id)!, buf)).not.toBeNull();
        expect(buf.pos.length).toBeGreaterThan(0);
        expect(signedVolume(buf.pos, buf.idx)).toBeGreaterThan(0);
        net.removeEndpoint(id);
      }
    }
  });

  it('structure boxes, prisms and beams', () => {
    const style = { color: wall, kind: 3, slot: 0, bias: 0 };
    for (const [fx, fz] of headings) {
      const rx = -fz;
      const rz = fx;
      const a = new SurfBuf();
      a.box(5, 1, 5, 2, 1, 3, rx, rz, fx, fz, style, { bottom: true });
      expect(signedVolume(a.pos, a.idx)).toBeCloseTo(48, 3);
      const b = new SurfBuf();
      b.taperBeam(5, 0, 2, 5, 3, 1, 1, rx, rz, fx, fz, style);
      expect(signedVolume(b.pos, b.idx)).toBeGreaterThan(0);
    }
    const p = new SurfBuf();
    p.prism(0, 0, 0, 5, 1, 10, style);
    expect(signedVolume(p.pos, p.idx)).toBeGreaterThan(0);
  });

  it('vehicle bodies at every level of detail', () => {
    buildModels().forEach((m, k) => {
      for (const g of [m.near, m.mid, m.far]) {
        if (k === 7) continue; // The bicycle has two-sided wheels and no closed body.
        expect(signedVolume(g.getAttribute('position').array)).toBeGreaterThan(0);
      }
    });
  });
});

describe('roof parts', () => {
  it('every roof face points away from the roof centre', () => {
    for (const [fx, fz] of [[1, 0], [0, -1], [0.6, 0.8]] as [number, number][]) {
      const roof = new BuildingBuf();
      roof.gable(0, 10, 0, 5, 3, 2, fx, fz, [1, 1, 1], [1, 1, 1]);
      // Centre of the roof solid, a little above the eave line.
      const cy = 10.6;
      for (let i = 0; i < roof.idx.length; i += 3) {
        const [a, b, c] = [roof.idx[i], roof.idx[i + 1], roof.idx[i + 2]].map((k) => [roof.pos[k * 3], roof.pos[k * 3 + 1], roof.pos[k * 3 + 2]]);
        const m = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3 - cy, (a[2] + b[2] + c[2]) / 3];
        const n = [roof.nor[roof.idx[i] * 3], roof.nor[roof.idx[i] * 3 + 1], roof.nor[roof.idx[i] * 3 + 2]];
        const area = Math.hypot(...[0, 1, 2].map((k) => (b[(k + 1) % 3] - a[(k + 1) % 3]) * (c[(k + 2) % 3] - a[(k + 2) % 3]) - (b[(k + 2) % 3] - a[(k + 2) % 3]) * (c[(k + 1) % 3] - a[(k + 1) % 3])));
        if (area < 1e-6) continue;
        // Undersides face down, toward a centre above them; everything else faces out.
        if (n[1] < -0.3) continue;
        expect(n[0] * m[0] + n[1] * m[1] + n[2] * m[2]).toBeGreaterThan(-1e-6);
      }
    }
  });
});
