import { afterEach, describe, expect, it } from 'vitest';
import {
  RoadNetwork,
  WATER_LEVEL,
  baseTerrainHeight,
  isWater,
  riverCentreZ,
  roadLevel,
  terrainHeight,
  totalHalfWidth,
} from '../../src/core';
import {
  DECK_CLEAR,
  EDIT_CELL,
  EDIT_ORIGIN,
  EDIT_POINTS,
  EDIT_TILE,
  EDIT_TILES,
  bindTerrainEdits,
  decodeTerrain,
  encodeTerrain,
  TerrainEditGrid,
  tileBox,
  unbindTerrainEdits,
  type BrushParams,
  type TerrainEditor,
} from '../../src/core/terrainEdit';
import { History } from '../../src/app/History';
import { free } from './helpers';

/** Flat land well away from the river. */
const Z = -1200;

afterEach(() => unbindTerrainEdits());

function stroke(ed: TerrainEditor, p: Partial<BrushParams> & Pick<BrushParams, 'op' | 'x' | 'z'>, ticks = 30): void {
  ed.beginStroke();
  for (let i = 0; i < ticks; i++) ed.tick({ radius: 40, strength: 0.5, dt: 1 / 60, shape: 'soft', ...p });
  ed.endStroke();
}

describe('landscaping height', () => {
  it('raise lifts the ground with a smooth falloff to the brush edge', () => {
    const net = new RoadNetwork();
    const ed = bindTerrainEdits(net);
    expect(terrainHeight(0, Z)).toBe(0);
    stroke(ed, { op: 'raise', x: 0, z: Z, radius: 40 });
    const centre = terrainHeight(0, Z);
    // 30 ticks of 1/60 s at half strength: 24 * 0.5 * 0.5 = 6 m at the centre.
    expect(centre).toBeGreaterThan(5.5);
    expect(centre).toBeLessThan(6.5);
    // Falls off monotonically and smoothly, flat at the rim.
    let last = centre;
    for (let d = 2; d <= 44; d += 2) {
      const h = terrainHeight(d, Z);
      expect(h).toBeLessThanOrEqual(last + 1e-6);
      expect(last - h).toBeLessThan(0.6);
      last = h;
    }
    expect(terrainHeight(41, Z)).toBeCloseTo(0, 6);
    // Bilinear between grid points, so it is continuous off the grid too.
    expect(Math.abs(terrainHeight(1, Z + 0.7) - terrainHeight(1.05, Z + 0.7))).toBeLessThan(0.02);
  });

  it('lower digs down, and both respect the elevation limits', () => {
    const net = new RoadNetwork();
    const ed = bindTerrainEdits(net);
    stroke(ed, { op: 'lower', x: 0, z: Z, strength: 1 }, 120);
    expect(terrainHeight(0, Z)).toBeCloseTo(-24, 5);
    stroke(ed, { op: 'raise', x: 300, z: Z, strength: 1 }, 400);
    expect(terrainHeight(300, Z)).toBeCloseTo(48, 5);
  });

  it('never edits on or past the map edge', () => {
    const net = new RoadNetwork();
    const ed = bindTerrainEdits(net);
    stroke(ed, { op: 'raise', x: 1995, z: Z, radius: 30 });
    expect(terrainHeight(1990, Z)).toBeGreaterThan(1);
    expect(terrainHeight(2000, Z)).toBe(baseTerrainHeight(2000, Z));
    expect(terrainHeight(2010, Z)).toBe(baseTerrainHeight(2010, Z));
  });

  it('level flattens to the target and slope makes an even grade', () => {
    const net = new RoadNetwork();
    const ed = bindTerrainEdits(net);
    stroke(ed, { op: 'raise', x: 0, z: Z, radius: 60, strength: 1 }, 40);
    stroke(ed, { op: 'level', x: 0, z: Z, radius: 30, strength: 1, target: 5, shape: 'hard' }, 120);
    for (const [dx, dz] of [[0, 0], [10, 0], [0, -12], [-15, 8]]) expect(terrainHeight(dx, Z + dz)).toBeCloseTo(5, 2);
    // Slope from 0 m at x = 400 to 8 m at x = 480.
    const from = { x: 400, y: 0, z: Z };
    const to = { x: 480, y: 8, z: Z };
    for (let x = 400; x <= 480; x += 16) stroke(ed, { op: 'slope', x, z: Z, radius: 20, strength: 1, from, to, shape: 'hard' }, 120);
    for (const x of [416, 440, 464]) expect(terrainHeight(x, Z)).toBeCloseTo(((x - 400) / 80) * 8, 1);
  });

  it('soften smooths a sharp step', () => {
    const net = new RoadNetwork();
    const ed = bindTerrainEdits(net);
    stroke(ed, { op: 'raise', x: 0, z: Z, radius: 20, strength: 1, shape: 'hard' }, 40);
    const step = () => terrainHeight(14, Z) - terrainHeight(22, Z);
    const before = step();
    stroke(ed, { op: 'soften', x: 18, z: Z, radius: 30, strength: 1 }, 60);
    expect(step()).toBeLessThan(before * 0.8);
  });
});

describe('landscaping and roads', () => {
  it('ground at a road edge stays at road height when raised or lowered beside it', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-300, Z), end: free(300, Z), roadType: 'street-4' });
    const w = totalHalfWidth(net.roadType('street-4')!);
    const ed = bindTerrainEdits(net);
    stroke(ed, { op: 'raise', x: 0, z: Z + 25, radius: 50, strength: 1 }, 60);
    stroke(ed, { op: 'lower', x: 120, z: Z - 25, radius: 50, strength: 1 }, 60);
    for (const x of [-20, 0, 20, 100, 120, 140]) {
      for (const side of [-1, 1]) {
        expect(Math.abs(terrainHeight(x, Z + side * w))).toBeLessThan(0.03);
        expect(Math.abs(terrainHeight(x, Z + side * (w + 1)))).toBeLessThan(0.03);
      }
      expect(roadLevel({ x, y: 0, z: Z })).toBe('ground');
    }
    // Natural slopes beyond the shoulder, no steeper than 1:1.5.
    expect(terrainHeight(0, Z + 30)).toBeGreaterThan(5);
    for (let o = w + 3; o < w + 30; o += 1) {
      const rise = Math.abs(terrainHeight(0, Z + o + 1) - terrainHeight(0, Z + o));
      expect(rise).toBeLessThan(1 / 1.5 + 0.05);
    }
  });

  it('a road drawn after the edits gets ground conformed to it', () => {
    const net = new RoadNetwork();
    const ed = bindTerrainEdits(net);
    stroke(ed, { op: 'raise', x: 0, z: Z, radius: 60, strength: 1 }, 30);
    const top = terrainHeight(0, Z);
    // A flat road 0.8 m above the hilltop: the ground comes up to meet it.
    net.drawRoad({ start: free(-10, Z, top + 0.8), end: free(10, Z, top + 0.8), roadType: 'street-2' });
    expect(terrainHeight(0, Z)).toBeCloseTo(top + 0.8, 2);
    // Bulldozing it gives the painted land back (only strokes bake roads in).
    net.removeSegment(net.segments[0].id);
    expect(terrainHeight(0, Z)).toBeCloseTo(top, 2);
  });

  it('brushes cannot push the ground through a bridge deck', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-100, Z, 12), end: free(100, Z, 12), roadType: 'street-2' });
    const ed = bindTerrainEdits(net);
    ed.beginStroke();
    let clamped = null;
    for (let i = 0; i < 200; i++) clamped = ed.tick({ op: 'raise', x: 0, z: Z, radius: 40, strength: 1, dt: 1 / 60, shape: 'soft' }).clamped ?? clamped;
    ed.endStroke();
    expect(clamped).toBe('bridge');
    expect(terrainHeight(0, Z)).toBeLessThanOrEqual(12 - DECK_CLEAR + 1e-3);
    expect(roadLevel({ x: 0, y: 12, z: Z })).toBe('bridge');
  });

  it('brushes keep cover over a tunnel', () => {
    const net = new RoadNetwork();
    const ed = bindTerrainEdits(net);
    stroke(ed, { op: 'raise', x: 0, z: Z, radius: 120, strength: 1, shape: 'hard' }, 60);
    const hill = terrainHeight(0, Z);
    expect(hill).toBeGreaterThan(20);
    net.drawRoad({ start: free(-40, Z, 4), end: free(40, Z, 4), roadType: 'street-2' });
    expect(roadLevel({ x: 0, y: 4, z: Z })).toBe('tunnel');
    stroke(ed, { op: 'lower', x: 0, z: Z, radius: 30, strength: 1 }, 200);
    expect(terrainHeight(0, Z)).toBeGreaterThanOrEqual(4 + 2.5 - 1e-3);
  });

  it('roads never move', () => {
    const net = new RoadNetwork();
    net.drawRoad({ start: free(-100, Z), end: free(100, Z), roadType: 'street-2' });
    const before = JSON.stringify(net.project.nodes);
    const ed = bindTerrainEdits(net);
    stroke(ed, { op: 'raise', x: 0, z: Z, radius: 80, strength: 1 }, 60);
    expect(JSON.stringify(net.project.nodes)).toBe(before);
  });
});

describe('landscaping and water', () => {
  /** Dig a straight channel from (x, z0) to (x, z1), hard brush. */
  function channel(ed: TerrainEditor, x: number, z0: number, z1: number, radius = 14): void {
    const step = Math.sign(z1 - z0) * 8;
    for (let z = z0; step > 0 ? z <= z1 : z >= z1; z += step) stroke(ed, { op: 'lower', x, z, radius, strength: 1, shape: 'hard' }, 40);
  }

  it('a pit dug far from the river stays dry, with no water anywhere in it', () => {
    const net = new RoadNetwork();
    const ed = bindTerrainEdits(net);
    stroke(ed, { op: 'lower', x: 0, z: Z, radius: 40, strength: 1, shape: 'hard' }, 60);
    expect(terrainHeight(0, Z)).toBeLessThan(-15);
    for (let d = 0; d < 40; d += 4) {
      expect(isWater(d, Z)).toBe(false);
      expect(isWater(0, Z + d)).toBe(false);
    }
  });

  it('a channel dug through to the river lets the water in, and filling the river dries it', () => {
    const net = new RoadNetwork();
    const ed = bindTerrainEdits(net);
    const x = 0;
    const zc = riverCentreZ(x);
    // A pit 120 m from the river: dry.
    stroke(ed, { op: 'lower', x, z: zc - 120, radius: 30, strength: 1, shape: 'hard' }, 40);
    expect(terrainHeight(x, zc - 120)).toBeLessThan(WATER_LEVEL);
    expect(isWater(x, zc - 120)).toBe(false);
    // Cut a channel from it to the river: it floods.
    channel(ed, x, zc - 110, zc - 20);
    expect(isWater(x, zc - 120)).toBe(true);
    expect(isWater(x, zc - 70)).toBe(true);
    // Water only ever stands on ground below the water level.
    for (let dz = -150; dz <= 60; dz += 3) if (isWater(x, zc + dz)) expect(terrainHeight(x, zc + dz)).toBeLessThan(WATER_LEVEL);
    // River bed raised above the level is dry land.
    stroke(ed, { op: 'raise', x: 300, z: riverCentreZ(300), radius: 40, strength: 1 }, 60);
    expect(terrainHeight(300, riverCentreZ(300))).toBeGreaterThan(WATER_LEVEL);
    expect(isWater(300, riverCentreZ(300))).toBe(false);
    // The untouched river is still water.
    expect(isWater(-600, riverCentreZ(-600))).toBe(true);
  });

  it('a road in a flooded cut stays dry, and so does a trench', () => {
    const net = new RoadNetwork();
    const ed = bindTerrainEdits(net);
    const x = 0;
    const zc = riverCentreZ(x);
    // A wide basin connected to the river.
    stroke(ed, { op: 'lower', x, z: zc - 120, radius: 60, strength: 1, shape: 'hard' }, 60);
    channel(ed, x, zc - 80, zc - 20, 16);
    const floor = terrainHeight(x, zc - 120);
    expect(floor).toBeLessThan(-10);
    expect(isWater(x, zc - 120)).toBe(true);
    // A road along the basin floor, below the water level.
    net.drawRoad({ start: free(x - 30, zc - 120, floor), end: free(x + 30, zc - 120, floor), roadType: 'street-2' });
    const w = totalHalfWidth(net.roadType('street-2')!);
    for (const dx of [-20, 0, 20]) {
      expect(isWater(x + dx, zc - 120)).toBe(false);
      expect(isWater(x + dx, zc - 120 + w - 0.5)).toBe(false);
    }
    // Further out in the basin the water stands.
    expect(isWater(x, zc - 120 + 30)).toBe(true);
    // A trench road (walls module) through the wet basin: its cut stays dry.
    net.drawRoad({ start: free(x - 30, zc - 140, floor - 2), end: free(x + 30, zc - 140, floor - 2), roadType: 'street-2', overrides: { structure: { mode: 'trench' } } });
    expect(isWater(x, zc - 140)).toBe(false);
  });

  it('"Let water in" floods a pit that does not reach the river, and it survives save and load', () => {
    const net = new RoadNetwork();
    const ed = bindTerrainEdits(net);
    stroke(ed, { op: 'lower', x: 0, z: Z, radius: 40, strength: 1, shape: 'hard', letWater: true }, 40);
    stroke(ed, { op: 'lower', x: 200, z: Z, radius: 40, strength: 1, shape: 'hard' }, 40);
    expect(isWater(0, Z)).toBe(true);
    expect(isWater(200, Z)).toBe(false);
    expect(net.project.terrain!.water).toBeTruthy();
    const text = net.serialize();
    unbindTerrainEdits();
    bindTerrainEdits(new RoadNetwork(text));
    expect(isWater(0, Z)).toBe(true);
    expect(isWater(200, Z)).toBe(false);
  });
});

describe('landscaping persistence', () => {
  it('survives save and load exactly', () => {
    const net = new RoadNetwork();
    const ed = bindTerrainEdits(net);
    stroke(ed, { op: 'raise', x: 0, z: Z, radius: 60, strength: 1 }, 30);
    stroke(ed, { op: 'lower', x: 200, z: Z, radius: 40, strength: 1 }, 30);
    const samples = [[0, Z], [13.3, Z + 7.1], [200, Z], [190, Z - 21]].map(([x, z]) => terrainHeight(x, z));
    const text = net.serialize();
    unbindTerrainEdits();
    expect(terrainHeight(0, Z)).toBe(0);
    const again = new RoadNetwork(text);
    bindTerrainEdits(again);
    const after = [[0, Z], [13.3, Z + 7.1], [200, Z], [190, Z - 21]].map(([x, z]) => terrainHeight(x, z));
    expect(after).toEqual(samples);
    // Old saves have no terrain field and load unchanged.
    expect(new RoadNetwork().serialize()).not.toContain('terrain');
  });

  it('a typical edit packs small', () => {
    const net = new RoadNetwork();
    const ed = bindTerrainEdits(net);
    stroke(ed, { op: 'raise', x: 0, z: Z, radius: 100, strength: 1 }, 40);
    const bytes = net.project.terrain!.tiles.length;
    // A 100 m radius hill: about 7900 points.
    expect(bytes).toBeLessThan(16000);
  });

  it('each stroke is one undo step', () => {
    const net = new RoadNetwork();
    const ed = bindTerrainEdits(net);
    const history = new History(net);
    stroke(ed, { op: 'raise', x: 0, z: Z }, 30);
    const one = terrainHeight(0, Z);
    stroke(ed, { op: 'raise', x: 0, z: Z }, 30);
    expect(history.size).toBe(2);
    expect(terrainHeight(0, Z)).toBeGreaterThan(one);
    history.undo();
    expect(terrainHeight(0, Z)).toBeCloseTo(one, 6);
    history.undo();
    expect(terrainHeight(0, Z)).toBe(0);
    history.redo();
    expect(terrainHeight(0, Z)).toBeCloseTo(one, 6);
  });

  it('codec round-trips arbitrary tiles', () => {
    const g = new TerrainEditGrid();
    for (let i = 100; i < 180; i++) for (let j = 300; j < 340; j++) g.setRaw(i, j, Math.round((Math.sin(i * 0.3) * 7 + Math.cos(j * 0.17) * 3 - (i % 7 === 0 ? 11 : 0)) * 100) / 100);
    const data = encodeTerrain(g)!;
    const h = new TerrainEditGrid();
    decodeTerrain(h, data);
    for (let i = 96; i < 184; i++) for (let j = 296; j < 344; j++) expect(h.getRaw(i, j)).toBe(g.getRaw(i, j));
  });
});

describe('landscaping on the GPU', () => {
  /** The shader's lookup, emulated in float32 over the texture as the layer uploads it. */
  function gpuHeight(ed: TerrainEditor, x: number, z: number): number {
    const fr = Math.fround;
    const tex = (i: number, j: number) => {
      const t = ed.grid.eff[Math.floor(j / EDIT_TILE) * EDIT_TILES + Math.floor(i / EDIT_TILE)];
      return t ? t[(j % EDIT_TILE) * EDIT_TILE + (i % EDIT_TILE)] : 0;
    };
    const gx = fr(fr(x - EDIT_ORIGIN) / EDIT_CELL);
    const gz = fr(fr(z - EDIT_ORIGIN) / EDIT_CELL);
    if (gx < 0 || gz < 0 || gx >= EDIT_POINTS - 1 || gz >= EDIT_POINTS - 1) return 0;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = fr(gx - i);
    const fz = fr(gz - j);
    const top = fr(tex(i, j) + fr(fr(tex(i + 1, j) - tex(i, j)) * fx));
    const bot = fr(tex(i, j + 1) + fr(fr(tex(i + 1, j + 1) - tex(i, j + 1)) * fx));
    return fr(top + fr(fr(bot - top) * fz));
  }

  it('the GLSL lookup agrees with terrainHeight at sample points', () => {
    const net = new RoadNetwork();
    const ed = bindTerrainEdits(net);
    stroke(ed, { op: 'raise', x: 31, z: Z + 17, radius: 70, strength: 1 }, 30);
    stroke(ed, { op: 'lower', x: -40, z: Z - 30, radius: 30, strength: 1 }, 30);
    let worst = 0;
    for (let k = 0; k < 2000; k++) {
      const x = -110 + ((k * 37.13) % 220);
      const z = Z - 110 + ((k * 91.7) % 220);
      worst = Math.max(worst, Math.abs(baseTerrainHeight(x, z) + gpuHeight(ed, x, z) - terrainHeight(x, z)));
    }
    expect(worst).toBeLessThan(2e-3);
  });

  it('a brush tick changes only the tiles under it', () => {
    const net = new RoadNetwork();
    const ed = bindTerrainEdits(net);
    const tiles: number[][] = [];
    ed.onEdit((e) => tiles.push(e.tiles));
    ed.beginStroke();
    const res = ed.tick({ op: 'raise', x: 0, z: Z, radius: 20, strength: 1, dt: 1 / 60, shape: 'soft' });
    expect(res.tiles.length).toBeGreaterThan(0);
    expect(res.tiles.length).toBeLessThanOrEqual(4);
    for (const k of res.tiles) {
      const b = tileBox(k);
      expect(b.maxX).toBeGreaterThan(-20);
      expect(b.minX).toBeLessThan(20);
      expect(b.maxZ).toBeGreaterThan(Z - 20);
      expect(b.minZ).toBeLessThan(Z + 20);
    }
    expect(ed.grid.effCount).toBe(res.tiles.length);
    ed.endStroke();
  });
});
