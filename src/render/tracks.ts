/**
 * Track, stations, signals and level crossings, built from the train sim's track
 * graph. Everything here rebuilds whole when the graph does, which only happens on
 * a rail edit. Per frame it only moves gates, flashes lamps and recolours signals.
 *
 * Heights are from the lane height: ballast top +0.10, sleepers +0.16, rail top
 * at RAIL_TOP. Trains ride at RAIL_TOP.
 */
import * as THREE from 'three';
import type { RoadNetwork } from '../core/RoadNetwork';
import { riverDistance, RIVER_HALF_WIDTH, terrainHeight } from '../core/terrain';
import { RAIL_TOP } from '../rail/constants';
import type { TrackPiece } from '../rail/TrackGraph';
import type { TrainSim } from '../rail/TrainSim';
import type { Shared } from './materials';
import {
  lin,
  M_BALLAST,
  M_CONCRETE,
  M_GLASS,
  M_LAMP,
  M_PAINT,
  M_PLAIN,
  M_RAIL_HEAD,
  M_RAIL_SIDE,
  M_SLEEPERS,
  M_STEEL,
  M_TILE,
  MeshBuf,
  polyFrames,
  sweep,
  trackMaterial,
  type PFrame,
} from './railMesh';

const GAUGE_HALF = 0.7175;
const HEAD = 0.036;
const SLEEPER_TOP = 0.16;
const BALLAST_TOP = 0.1;
const MAST_SPACING = 55;
const CONTACT = 5.55;
const MESSENGER = 6.7;
const PLATFORM_EDGE = 1.65;
const PLATFORM_WIDTH = 5;
const PLATFORM_TOP = 1.1;
const CHUNK = 300;

const C = {
  ballast: lin(0x8f897e),
  ballastDark: lin(0x7b766c),
  railSide: lin(0x6b4a37),
  concrete: lin(0xb3b0a8),
  concreteDark: lin(0x8c8a84),
  steel: lin(0x6f767c),
  galv: lin(0x9ba3a8),
  white: lin(0xe9e7e2),
  yellow: lin(0xe3b52c),
  red: lin(0xc0302a),
  black: lin(0x111214),
  roof: lin(0x55606a),
  glass: lin(0x2a3644),
  tile: lin(0xd8d4cb),
  grass: lin(0x5c7a3f),
  lamp: lin(0xffe2b0),
  dark: lin(0x1c1e22),
  wood: lin(0x7a5638),
  bench: lin(0x3b5f86),
};

function chunkKey(x: number, z: number): string {
  return `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
}

/** Sweep a rail: head, two sides. */
function rail(buf: MeshBuf, frames: readonly PFrame[], x: number, top = RAIL_TOP, foot = SLEEPER_TOP): void {
  sweep(buf, frames, [x - HEAD, top], [x + HEAD, top], C.steel, M_RAIL_HEAD);
  sweep(buf, frames, [x + HEAD, top], [x + HEAD, foot], C.railSide, M_RAIL_SIDE);
  sweep(buf, frames, [x - HEAD, foot], [x - HEAD, top], C.railSide, M_RAIL_SIDE);
}

interface GateParts {
  arm: THREE.Object3D;
  lamps: THREE.Mesh[];
}

export class TrackLayer {
  readonly group = new THREE.Group();
  private readonly world = new THREE.Group();
  private readonly under = new THREE.Group();
  private readonly overlay = new THREE.Group();
  private readonly material: THREE.MeshStandardMaterial;
  private readonly wireMat = new THREE.LineBasicMaterial({ color: 0x24282c, transparent: true, opacity: 0.85 });
  private readonly overlayMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false });
  private readonly lampOn = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.4, 0.3), toneMapped: false });
  private readonly lampOff = new THREE.MeshBasicMaterial({ color: 0x2a1010 });
  private readonly gateMat = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.5 });
  private readonly gateStripe = new THREE.MeshStandardMaterial({ color: 0xc22d26, roughness: 0.5 });
  private signalMast: THREE.InstancedMesh | null = null;
  private signalLamp: THREE.InstancedMesh | null = null;
  private signalColors = [new THREE.Color(0.1, 3.2, 0.6), new THREE.Color(3.4, 2.2, 0.1), new THREE.Color(4, 0.12, 0.08)];
  private dimColor = new THREE.Color(0.03, 0.03, 0.03);
  private gates: GateParts[][] = [];
  private builtGraph = -1;
  private builtLines = '';
  private disposables: { dispose(): void }[] = [];
  private undergroundOn = false;
  private time = 0;

  constructor(
    private readonly net: RoadNetwork,
    shared: Shared,
  ) {
    this.material = trackMaterial(shared);
    this.group.add(this.world, this.under, this.overlay);
    this.under.visible = false;
    this.overlay.visible = false;
  }

  setUnderground(on: boolean): void {
    this.undergroundOn = on;
    this.under.visible = on;
  }

  setLineOverlay(on: boolean): void {
    this.overlay.visible = on;
  }

  update(trains: TrainSim | null, dt: number): void {
    this.time += dt;
    if (!trains) return;
    if (trains.graphVersion !== this.builtGraph) {
      this.builtGraph = trains.graphVersion;
      this.rebuild(trains);
      this.builtLines = '';
    }
    const lineKey = JSON.stringify(this.net.rail.lines.map((l) => [l.id, l.color, l.hidden, l.stops]));
    if (lineKey !== this.builtLines) {
      this.builtLines = lineKey;
      this.rebuildOverlay(trains);
    }
    this.updateSignals(trains);
    this.updateGates(trains);
  }

  private clear(): void {
    for (const g of [this.world, this.under]) {
      for (const child of [...g.children]) {
        g.remove(child);
      }
    }
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.signalMast = null;
    this.signalLamp = null;
    this.gates = [];
  }

  private add(parent: THREE.Object3D, obj: THREE.Mesh | THREE.LineSegments | THREE.InstancedMesh | THREE.Sprite): void {
    parent.add(obj);
    if ('geometry' in obj) this.disposables.push(obj.geometry);
  }

  private rebuild(trains: TrainSim): void {
    this.clear();
    const g = trains.graph;
    const bufs = new Map<string, MeshBuf>();
    const bufAt = (x: number, z: number) => {
      const key = chunkKey(x, z);
      let b = bufs.get(key);
      if (!b) {
        b = new MeshBuf();
        bufs.set(key, b);
      }
      return b;
    };
    const wires: number[] = [];
    const crossingPieces = new Set<number>();
    for (const c of g.crossings) for (const p of c.pieces) crossingPieces.add(p);

    for (const p of g.pieces) {
      const mid = Math.floor(p.pts.length / 6) * 3;
      const buf = bufAt(p.pts[mid], p.pts[mid + 2]);
      const frames = polyFrames(p.pts);
      if (frames.length < 2) continue;
      this.buildTrack(buf, p, frames, crossingPieces.has(p.id));
      if (p.electrified) this.buildCatenary(buf, wires, p, frames);
      if (p.thirdRail && !crossingPieces.has(p.id)) {
        const side = p.kind === 'run' && p.track === 0 && p.normal !== 0 ? -1 : 1;
        const x = side * 1.38;
        sweep(buf, frames, [x - 0.04, 0.3], [x + 0.04, 0.3], C.steel, M_RAIL_SIDE);
        sweep(buf, frames, [x - 0.12, 0.37], [x + 0.12, 0.37], lin(0xd8c27a), M_PAINT);
      }
      this.buildTruss(buf, p, frames);
    }
    for (const end of g.ends) this.buildEnd(bufAt(end.pos.x, end.pos.z), end);
    for (const c of g.crossings) this.buildCrossing(bufAt(c.pos.x, c.pos.z), c);

    for (const b of bufs.values()) {
      if (!b.count) continue;
      const mesh = new THREE.Mesh(b.toGeometry(), this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.add(this.world, mesh);
    }
    if (wires.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
      const lines = new THREE.LineSegments(geo, this.wireMat);
      lines.matrixAutoUpdate = false;
      this.add(this.world, lines);
    }
    this.buildStations(trains);
    this.buildSignals(trains);
    this.buildGates(trains);
  }

  private buildTrack(buf: MeshBuf, p: TrackPiece, frames: PFrame[], crossing: boolean): void {
    if (crossing) {
      // Rubber panels flush with the rail head, set into the road.
      sweep(buf, frames, [-1.75, RAIL_TOP - 0.01], [1.75, RAIL_TOP - 0.01], lin(0x3a3b3d), M_CONCRETE);
      sweep(buf, frames, [1.75, RAIL_TOP - 0.01], [1.95, 0.06], lin(0x3a3b3d), M_CONCRETE);
      sweep(buf, frames, [-1.95, 0.06], [-1.75, RAIL_TOP - 0.01], lin(0x3a3b3d), M_CONCRETE);
      sweep(buf, frames, [-GAUGE_HALF - HEAD, RAIL_TOP + 0.001], [-GAUGE_HALF + HEAD, RAIL_TOP + 0.001], C.steel, M_RAIL_HEAD);
      sweep(buf, frames, [GAUGE_HALF - HEAD, RAIL_TOP + 0.001], [GAUGE_HALF + HEAD, RAIL_TOP + 0.001], C.steel, M_RAIL_HEAD);
      return;
    }
    sweep(buf, frames, [-3.0, -0.25], [-1.95, BALLAST_TOP], C.ballast, M_BALLAST);
    sweep(buf, frames, [-1.95, BALLAST_TOP], [1.95, BALLAST_TOP], C.ballast, M_BALLAST);
    sweep(buf, frames, [1.95, BALLAST_TOP], [3.0, -0.25], C.ballast, M_BALLAST);
    sweep(buf, frames, [-1.3, SLEEPER_TOP], [1.3, SLEEPER_TOP], C.ballastDark, M_SLEEPERS);
    // Sleeper ends, so the strip has thickness from low angles.
    sweep(buf, frames, [1.3, SLEEPER_TOP], [1.3, BALLAST_TOP], C.concreteDark, M_CONCRETE);
    sweep(buf, frames, [-1.3, BALLAST_TOP], [-1.3, SLEEPER_TOP], C.concreteDark, M_CONCRETE);
    rail(buf, frames, -GAUGE_HALF);
    rail(buf, frames, GAUGE_HALF);
  }

  /** Masts on the outside of each track, a cantilever over it, and the wires. */
  private buildCatenary(buf: MeshBuf, wires: number[], p: TrackPiece, frames: PFrame[]): void {
    const side = p.kind === 'run' && p.track === 0 && p.normal !== 0 ? -1 : 1;
    // Wires, staggered from side to side between masts as real ones are.
    let last: number[] | null = null;
    let lastM: number[] | null = null;
    const span = MAST_SPACING;
    for (let s = 0; ; s += span / 2) {
      const at = Math.min(s, p.length);
      const f = frameAt(frames, at);
      const zig = (Math.round(at / (span / 2)) % 2 === 0 ? 1 : -1) * 0.2;
      const cw = [f.x + f.rx * zig, f.y + RAIL_TOP + CONTACT, f.z + f.rz * zig];
      const mw = [f.x, f.y + RAIL_TOP + MESSENGER, f.z];
      if (last && lastM) {
        wires.push(...last, ...cw, ...lastM, ...mw);
        // Droppers.
        for (const k of [0.25, 0.5, 0.75]) {
          const ax = last[0] + (cw[0] - last[0]) * k;
          const ay = last[1] + (cw[1] - last[1]) * k;
          const az = last[2] + (cw[2] - last[2]) * k;
          const sag = 0.35 * Math.sin(Math.PI * k);
          wires.push(ax, ay, az, ax, lastM[1] + (mw[1] - lastM[1]) * k - sag, az);
        }
      }
      last = cw;
      lastM = mw;
      if (at >= p.length) break;
    }
    if (p.kind !== 'run') return;
    const first = Math.ceil(frames[0].s / span) * span;
    for (let s = first + span / 2; s < p.length - 4; s += span) {
      const f = frameAt(frames, s);
      if (f.y < -1.5) continue;
      const mx = f.x + f.rx * side * 3.3;
      const mz = f.z + f.rz * side * 3.3;
      const ground = Math.min(f.y, terrainHeight(mx, mz));
      buf.box(mx, (ground + f.y + 7.3) / 2, mz, 0.13, (f.y + 7.3 - ground) / 2, 0.13, f.rx, f.rz, C.galv, M_STEEL);
      // Cantilever tube and brace, out to just past the track.
      const reach = 3.3 + 0.5;
      const cx = f.x + f.rx * side * (3.3 - reach / 2);
      const cz = f.z + f.rz * side * (3.3 - reach / 2);
      buf.box(cx, f.y + RAIL_TOP + MESSENGER, cz, reach / 2, 0.05, 0.05, f.rx, f.rz, C.galv, M_STEEL);
      buf.box(cx, f.y + RAIL_TOP + CONTACT + 0.3, cz, reach / 2, 0.04, 0.04, f.rx, f.rz, C.galv, M_STEEL);
      buf.box(f.x - f.rx * side * 0.1, f.y + RAIL_TOP + CONTACT + 0.15, f.z - f.rz * side * 0.1, 0.03, 0.18, 0.03, f.rx, f.rz, C.galv, M_STEEL);
    }
  }

  /** A steel truss where the track crosses the river on a span. */
  private buildTruss(buf: MeshBuf, p: TrackPiece, frames: PFrame[]): void {
    if (p.kind !== 'run') return;
    let i0 = -1;
    for (let i = 0; i <= frames.length; i++) {
      const f = frames[i];
      const over = f !== undefined && riverDistance(f.x, f.z) < RIVER_HALF_WIDTH + 25 && f.y - terrainHeight(f.x, f.z) > 2.5;
      if (over && i0 < 0) i0 = i;
      if (!over && i0 >= 0) {
        this.truss(buf, frames, frames[i0].s, frames[i - 1].s);
        i0 = -1;
      }
    }
  }

  private truss(buf: MeshBuf, frames: PFrame[], s0: number, s1: number): void {
    if (s1 - s0 < 10) return;
    const H = 7.5;
    const panel = 8;
    const n = Math.max(2, Math.round((s1 - s0) / panel));
    const step = (s1 - s0) / n;
    for (const side of [-1, 1]) {
      const off = side * 2.9;
      const at = (s: number, up: number): number[] => {
        const f = frameAt(frames, s);
        return [f.x + f.rx * off, f.y + RAIL_TOP + up, f.z + f.rz * off];
      };
      for (let k = 0; k < n; k++) {
        const a = s0 + k * step;
        const b = a + step;
        this.member(buf, at(a, 0), at(b, 0), 0.22);
        this.member(buf, at(a, H), at(b, H), 0.22);
        this.member(buf, at(a, k % 2 ? H : 0), at(b, k % 2 ? 0 : H), 0.15);
        this.member(buf, at(a, 0), at(a, H), 0.12);
      }
      this.member(buf, at(s1, 0), at(s1, H), 0.12);
    }
    for (let k = 0; k <= n; k++) {
      const f = frameAt(frames, s0 + k * step);
      buf.box(f.x, f.y + RAIL_TOP + H, f.z, 2.9, 0.1, 0.1, f.rx, f.rz, lin(0x5d6a72), M_STEEL);
    }
  }

  private member(buf: MeshBuf, a: number[], b: number[], r: number): void {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.01) return;
    // A square tube along a to b.
    const t = [dx / len, dy / len, dz / len];
    const up = Math.abs(t[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = [t[1] * up[2] - t[2] * up[1], t[2] * up[0] - t[0] * up[2], t[0] * up[1] - t[1] * up[0]];
    const ul = Math.hypot(u[0], u[1], u[2]);
    u[0] /= ul;
    u[1] /= ul;
    u[2] /= ul;
    const w = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
    const corner = (p: number[], su: number, sw: number) => [p[0] + (u[0] * su + w[0] * sw) * r, p[1] + (u[1] * su + w[1] * sw) * r, p[2] + (u[2] * su + w[2] * sw) * r];
    const ring = [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ];
    const col = lin(0x5d6a72);
    for (let i = 0; i < 4; i++) {
      const [su0, sw0] = ring[i];
      const [su1, sw1] = ring[(i + 1) % 4];
      buf.face([corner(a, su0, sw0), corner(b, su0, sw0), corner(b, su1, sw1), corner(a, su1, sw1)], col, M_STEEL);
    }
  }

  private buildEnd(buf: MeshBuf, end: { pos: { x: number; y: number; z: number }; dir: { x: number; z: number }; gateway: boolean }): void {
    const { pos, dir } = end;
    const rx = -dir.z;
    const rz = dir.x;
    if (end.gateway) {
      // The line runs on into a tunnel under the hills past the map edge.
      const d = 10;
      const cx = pos.x + dir.x * d;
      const cz = pos.z + dir.z * d;
      const y = pos.y;
      const W = 4.2;
      const H = 7.4;
      buf.box(cx + rx * (W + 0.9), y + H / 2, cz + rz * (W + 0.9), 0.9, H / 2 + 0.6, 1.2, rx, rz, C.concrete, M_CONCRETE);
      buf.box(cx - rx * (W + 0.9), y + H / 2, cz - rz * (W + 0.9), 0.9, H / 2 + 0.6, 1.2, rx, rz, C.concrete, M_CONCRETE);
      buf.box(cx, y + H + 0.8, cz, W + 1.8, 0.8, 1.2, rx, rz, C.concrete, M_CONCRETE);
      buf.box(cx + dir.x * 1.3, y + H / 2, cz + dir.z * 1.3, W, H / 2 + 0.2, 0.1, rx, rz, C.black, M_PLAIN);
      // Earth over the tunnel mouth.
      const back = 24;
      const hx = cx + dir.x * (back / 2 + 1);
      const hz = cz + dir.z * (back / 2 + 1);
      const top = y + H + 3;
      const p = (sr: number, sf: number, up: number) => [hx + rx * sr + dir.x * sf, up, hz + rz * sr + dir.z * sf];
      const wide = W + 16;
      buf.face([p(-wide, -back / 2, y - 0.3), p(wide, -back / 2, y - 0.3), p(wide - 6, -back / 2 + 3, top), p(-wide + 6, -back / 2 + 3, top)], C.grass, M_BALLAST);
      buf.face([p(-wide + 6, -back / 2 + 3, top), p(wide - 6, -back / 2 + 3, top), p(wide - 6, back / 2, top), p(-wide + 6, back / 2, top)], C.grass, M_BALLAST);
      buf.face([p(wide, -back / 2, y - 0.3), p(wide, back / 2, y - 0.3), p(wide - 6, back / 2, top), p(wide - 6, -back / 2 + 3, top)], C.grass, M_BALLAST);
      buf.face([p(-wide, back / 2, y - 0.3), p(-wide, -back / 2, y - 0.3), p(-wide + 6, -back / 2 + 3, top), p(-wide + 6, back / 2, top)], C.grass, M_BALLAST);
      return;
    }
    // Buffer stop: a steel frame with sprung buffers and a red lamp.
    const bx = pos.x + dir.x * 1.5;
    const bz = pos.z + dir.z * 1.5;
    const y = pos.y + RAIL_TOP;
    buf.box(bx, y + 0.6, bz, 1.5, 0.6, 0.35, rx, rz, C.red, M_PAINT);
    buf.box(bx, y + 1.05, bz, 1.55, 0.12, 0.38, rx, rz, C.white, M_PAINT);
    for (const s of [-0.88, 0.88]) {
      buf.box(bx + rx * s - dir.x * 0.55, y + 1.0, bz + rz * s - dir.z * 0.55, 0.2, 0.2, 0.25, rx, rz, C.dark, M_STEEL);
    }
    buf.box(bx + dir.x * 1.2, y + 0.4, bz + dir.z * 1.2, 0.3, 0.4, 1.0, rx, rz, C.steel, M_STEEL);
    buf.box(bx, y + 1.45, bz, 0.12, 0.12, 0.08, rx, rz, lin(0xff3020), M_LAMP);
  }

  private buildCrossing(buf: MeshBuf, c: TrainSim['graph']['crossings'][number]): void {
    // Posts with flashing lights sit beside each road approach; the arms move per frame.
    for (const arm of c.roadArms) {
      const rx = -arm.dir.z;
      const rz = arm.dir.x;
      const d = c.trackHalf + 2.5;
      const px = c.pos.x + arm.dir.x * d + rx * (arm.halfWidth + 0.8);
      const pz = c.pos.z + arm.dir.z * d + rz * (arm.halfWidth + 0.8);
      const y = terrainHeight(px, pz);
      buf.post(px, pz, y, y + 3.4, 0.09, C.white, M_PAINT);
      // Crossbuck.
      buf.box(px, y + 3.0, pz, 0.6, 0.08, 0.03, arm.dir.x, arm.dir.z, C.white, M_PAINT);
      buf.box(px, y + 2.6, pz, 0.45, 0.17, 0.05, -arm.dir.x, -arm.dir.z, C.dark, M_PLAIN);
      buf.box(px - rx * 0.1, y + 1.0, pz - rz * 0.1, 0.25, 0.5, 0.25, rx, rz, C.steel, M_STEEL);
    }
  }

  private buildGates(trains: TrainSim): void {
    const g = trains.graph;
    const armGeo = new THREE.BoxGeometry(1, 0.11, 0.11);
    const stripeGeo = new THREE.BoxGeometry(0.5, 0.115, 0.115);
    const lampGeo = new THREE.SphereGeometry(0.13, 10, 8);
    this.disposables.push(armGeo, stripeGeo, lampGeo);
    for (const c of g.crossings) {
      const parts: GateParts[] = [];
      for (const arm of c.roadArms) {
        const rx = -arm.dir.z;
        const rz = arm.dir.x;
        const d = c.trackHalf + 2.5;
        const px = c.pos.x + arm.dir.x * d + rx * (arm.halfWidth + 0.8);
        const pz = c.pos.z + arm.dir.z * d + rz * (arm.halfWidth + 0.8);
        const y = terrainHeight(px, pz) + 1.15;
        const pivot = new THREE.Object3D();
        pivot.position.set(px - rx * 0.3, y, pz - rz * 0.3);
        // Local x runs from the post across the road.
        pivot.rotation.y = Math.atan2(rz, -rx);
        const lengthAcross = arm.halfWidth + 0.6;
        const holder = new THREE.Object3D();
        pivot.add(holder);
        const bar = new THREE.Mesh(armGeo, this.gateMat);
        bar.scale.x = lengthAcross;
        bar.position.x = lengthAcross / 2;
        holder.add(bar);
        for (let k = 0.5; k < lengthAcross; k += 1.0) {
          const s = new THREE.Mesh(stripeGeo, this.gateStripe);
          s.position.x = k;
          holder.add(s);
        }
        bar.castShadow = true;
        const lamps: THREE.Mesh[] = [];
        for (const off of [-0.22, 0.22]) {
          const lamp = new THREE.Mesh(lampGeo, this.lampOff);
          lamp.position.set(px + arm.dir.x * 0.15 + rx * off, y + 1.45, pz + arm.dir.z * 0.15 + rz * off);
          this.world.add(lamp);
          lamps.push(lamp);
        }
        this.world.add(pivot);
        parts.push({ arm: holder, lamps });
      }
      this.gates.push(parts);
    }
  }

  private updateGates(trains: TrainSim): void {
    const flash = Math.floor(this.time * 1.6) % 2;
    trains.crossings.forEach((c, i) => {
      const parts = this.gates[i];
      if (!parts) return;
      // Arms come down over the last three quarters of the gate time.
      const down = Math.min(1, Math.max(0, (c.gate - 0.15) / 0.85));
      const angle = (1 - down) * (Math.PI / 2) * 0.96;
      const lit = c.closed || c.gate > 0.02;
      for (const p of parts) {
        p.arm.rotation.z = angle;
        p.lamps[0].material = lit && flash === 0 ? this.lampOn : this.lampOff;
        p.lamps[1].material = lit && flash === 1 ? this.lampOn : this.lampOff;
      }
    });
  }

  private buildSignals(trains: TrainSim): void {
    const s = trains.signals;
    if (!s.count) return;
    const mb = new MeshBuf();
    mb.post(0, 0, 0, 4.6, 0.07, C.galv, M_STEEL);
    mb.box(0, 4.6, 0, 0.22, 0.62, 0.14, 1, 0, C.dark, M_PLAIN);
    // Hood over the lamps, facing the driver (+z local).
    mb.box(0, 5.25, 0.17, 0.24, 0.03, 0.06, 1, 0, C.dark, M_PLAIN);
    const mast = new THREE.InstancedMesh(mb.toGeometry(), this.material, s.count);
    const lampGeo = new THREE.CircleGeometry(0.09, 10);
    const lamp = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ toneMapped: false }), s.count * 3);
    this.disposables.push(lamp.material as THREE.Material, lampGeo);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < s.count; i++) {
      // The head faces back down the track at the driver.
      q.setFromAxisAngle(up, s.yaw[i] + Math.PI);
      m.compose(new THREE.Vector3(s.x[i], s.y[i] + RAIL_TOP, s.z[i]), q, one);
      mast.setMatrixAt(i, m);
      for (let k = 0; k < 3; k++) {
        const local = new THREE.Vector3(0, 4.25 + k * 0.33, 0.15).applyQuaternion(q);
        m.compose(local.add(new THREE.Vector3(s.x[i], s.y[i] + RAIL_TOP, s.z[i])), q, one);
        lamp.setMatrixAt(i * 3 + k, m);
        lamp.setColorAt(i * 3 + k, this.dimColor);
      }
    }
    mast.castShadow = true;
    this.add(this.world, mast);
    this.add(this.world, lamp);
    this.signalMast = mast;
    this.signalLamp = lamp;
  }

  private updateSignals(trains: TrainSim): void {
    const lamp = this.signalLamp;
    if (!lamp) return;
    const s = trains.signals;
    // Bottom green, middle yellow, top red.
    for (let i = 0; i < s.count; i++) {
      const state = s.state[i];
      for (let k = 0; k < 3; k++) lamp.setColorAt(i * 3 + k, k === [0, 1, 2][state] ? this.signalColors[k] : this.dimColor);
    }
    if (lamp.instanceColor) lamp.instanceColor.needsUpdate = true;
  }

  private buildStations(trains: TrainSim): void {
    const g = trains.graph;
    for (const st of g.stations.values()) {
      if (st.kind === 'gateway' || !st.spans.length) continue;
      const underground = st.kind === 'underground';
      const buf = new MeshBuf();
      const spans = st.spans.map((sp) => polyFrames(sp, 8));
      const double = st.spans.length === 2;
      spans.forEach((frames, i) => {
        if (frames.length < 2) return;
        // Track 0 of double track is the left one: its platform goes on the left.
        const side = double ? (i === 0 ? -1 : 1) : 1;
        this.platform(buf, frames, side, underground);
      });
      if (underground) this.stationBox(buf, spans, double);
      const mesh = new THREE.Mesh(buf.toGeometry(), this.material);
      mesh.castShadow = !underground;
      mesh.receiveShadow = true;
      this.add(underground ? this.under : this.world, mesh);
      this.nameSigns(st.name, spans, double, underground);
      if (underground) this.kiosks(st.name, spans[spans.length - 1], double);
    }
  }

  /** One side platform along a track. */
  private platform(buf: MeshBuf, frames: PFrame[], side: -1 | 1, underground: boolean): void {
    const inner = side * PLATFORM_EDGE;
    const outer = side * (PLATFORM_EDGE + PLATFORM_WIDTH);
    const top = RAIL_TOP + PLATFORM_TOP - 0.24;
    const L = (a: number, b: number) => (side > 0 ? ([a, b] as const) : ([b, a] as const));
    const [l, r] = L(inner, outer);
    sweep(buf, frames, [l, top], [r, top], C.tile, underground ? M_TILE : M_CONCRETE);
    // Platform edge face and the coping with its yellow line.
    if (side > 0) sweep(buf, frames, [inner, top], [inner, -0.2], C.concreteDark, M_CONCRETE);
    else sweep(buf, frames, [inner, -0.2], [inner, top], C.concreteDark, M_CONCRETE);
    const y0 = side * (PLATFORM_EDGE + 0.45);
    const y1 = side * (PLATFORM_EDGE + 0.6);
    sweep(buf, frames, [Math.min(y0, y1), top + 0.005], [Math.max(y0, y1), top + 0.005], C.yellow, M_PAINT);
    if (side > 0) sweep(buf, frames, [outer, -0.2], [outer, top], C.concreteDark, M_CONCRETE);
    else sweep(buf, frames, [outer, top], [outer, -0.2], C.concreteDark, M_CONCRETE);
    // Canopy over the middle of the platform, on a row of columns.
    const length = frames[frames.length - 1].s;
    const mid = side * (PLATFORM_EDGE + PLATFORM_WIDTH * 0.55);
    const roofIn = side * (PLATFORM_EDGE + 0.9);
    const roofOut = side * (PLATFORM_EDGE + PLATFORM_WIDTH + 0.3);
    const c0 = length * 0.18;
    const c1 = length * 0.82;
    const i0 = frames.findIndex((f) => f.s >= c0);
    let i1 = frames.length - 1;
    while (i1 > 0 && frames[i1].s > c1) i1--;
    if (!underground && i1 > i0) {
      const [a, b] = L(roofIn, roofOut);
      sweep(buf, frames, [a, top + 4.0], [b, top + 4.25], C.roof, M_STEEL, i0, i1);
      sweep(buf, frames, [b, top + 4.25], [a, top + 4.0], lin(0xc9ccd0), M_PLAIN, i0, i1);
    }
    for (let s = 6; s < length - 4; s += 12) {
      const f = frameAt(frames, s);
      const x = f.x + f.rx * mid;
      const z = f.z + f.rz * mid;
      const inCanopy = s >= c0 && s <= c1;
      if (inCanopy && !underground) buf.post(x, z, f.y + top, f.y + top + 4.05, 0.1, C.steel, M_STEEL, 8);
      else {
        // Lamp post with a warm head.
        buf.post(x, z, f.y + top, f.y + top + 3.6, 0.05, C.steel, M_STEEL, 6);
        buf.box(x, f.y + top + 3.6, z, 0.18, 0.06, 0.18, f.rx, f.rz, C.lamp, M_LAMP);
      }
      if (inCanopy) buf.box(f.x + f.rx * (mid - side * 0.2), f.y + top + 3.85, f.z + f.rz * (mid - side * 0.2), 0.25, 0.04, 0.6, f.rx, f.rz, C.lamp, M_LAMP);
      if (Math.round(s / 12) % 2 === 0) {
        const bx = f.x + f.rx * (mid + side * 1.2);
        const bz = f.z + f.rz * (mid + side * 1.2);
        buf.box(bx, f.y + top + 0.45, bz, 0.25, 0.04, 0.9, f.rx, f.rz, C.bench, M_PAINT);
        buf.box(bx + f.rx * side * 0.22, f.y + top + 0.7, bz + f.rz * side * 0.22, 0.03, 0.22, 0.9, f.rx, f.rz, C.bench, M_PAINT);
        buf.box(bx, f.y + top + 0.2, bz, 0.2, 0.2, 0.05, f.rx, f.rz, C.steel, M_STEEL);
      }
    }
  }

  /** The concrete box a subway station sits in, open on top for the underground view. */
  private stationBox(buf: MeshBuf, spans: PFrame[][], double: boolean): void {
    const frames = spans[0];
    const far = double ? 2 * 2.2 + PLATFORM_EDGE + PLATFORM_WIDTH + 0.5 : PLATFORM_EDGE + PLATFORM_WIDTH + 0.5;
    const near = double ? -(PLATFORM_EDGE + PLATFORM_WIDTH + 0.5) : -2.6;
    const H = 7;
    sweep(buf, frames, [near, H], [near, -0.3], lin(0x5b6068), M_CONCRETE);
    sweep(buf, frames, [far, -0.3], [far, H], lin(0x5b6068), M_CONCRETE);
    sweep(buf, frames, [near, -0.3], [far, -0.3], lin(0x3c4046), M_CONCRETE);
    // Strip lights along the walls.
    sweep(buf, frames, [near + 0.05, H - 1.2], [near + 0.05, H - 1.4], C.lamp, M_LAMP);
    sweep(buf, frames, [far - 0.05, H - 1.4], [far - 0.05, H - 1.2], C.lamp, M_LAMP);
  }

  private kiosks(name: string, frames: PFrame[], double: boolean): void {
    if (frames.length < 2) return;
    const buf = new MeshBuf();
    const length = frames[frames.length - 1].s;
    for (const s of [length * 0.15, length * 0.85]) {
      const f = frameAt(frames, s);
      const off = (double ? 2.2 : 0) + PLATFORM_EDGE + PLATFORM_WIDTH + 6;
      const x = f.x + f.rx * off;
      const z = f.z + f.rz * off;
      const y = terrainHeight(x, z);
      // Glass entrance with a flat roof and stairs going down.
      buf.box(x, y + 1.4, z, 1.8, 1.4, 3.2, f.rx, f.rz, C.glass, M_GLASS);
      buf.box(x, y + 2.95, z, 2.1, 0.15, 3.5, f.rx, f.rz, C.roof, M_STEEL);
      buf.box(x + f.rx * 2.6, y + 1.8, z + f.rz * 2.6, 0.08, 1.8, 0.08, f.rx, f.rz, C.steel, M_STEEL);
      buf.box(x + f.rx * 2.6, y + 3.8, z + f.rz * 2.6, 0.45, 0.45, 0.08, f.rx, f.rz, lin(0x1f5fbf), M_LAMP);
      this.sign('M', x + f.rx * 2.6, y + 3.8, z + f.rz * 2.6, 0.9, '#ffffff', '#1f5fbf', this.world);
    }
    const mesh = new THREE.Mesh(buf.toGeometry(), this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.add(this.world, mesh);
    this.sign(name, frameAt(frames, length * 0.15).x, terrainHeight(frameAt(frames, length * 0.15).x, frameAt(frames, length * 0.15).z) + 5.2, frameAt(frames, length * 0.15).z, 0, '#ffffff', '#1d2a3a', this.world);
  }

  private nameSigns(name: string, spans: PFrame[][], double: boolean, underground: boolean): void {
    const frames = spans[spans.length - 1];
    if (frames.length < 2) return;
    const length = frames[frames.length - 1].s;
    const off = (double ? 1 : 1) * (PLATFORM_EDGE + PLATFORM_WIDTH * 0.55);
    for (const s of [length * 0.5]) {
      const f = frameAt(frames, s);
      this.sign(name, f.x + f.rx * off, f.y + 6.2, f.z + f.rz * off, 0, '#ffffff', '#1d2a3a', underground ? this.under : this.world);
    }
  }

  private sign(text: string, x: number, y: number, z: number, square: number, fg: string, bg: string, parent: THREE.Object3D): void {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const h = 64;
    ctx.font = 'bold 40px system-ui, sans-serif';
    const w = square ? h : Math.ceil(ctx.measureText(text).width + 36);
    c.width = w;
    c.height = h;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = fg;
    ctx.font = 'bold 40px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false, sizeAttenuation: true });
    const sprite = new THREE.Sprite(mat);
    const height = square ? square : 2.2;
    sprite.scale.set((height * w) / h, height, 1);
    sprite.position.set(x, y, z);
    sprite.renderOrder = 4;
    parent.add(sprite);
    this.disposables.push(tex, mat);
  }

  private rebuildOverlay(trains: TrainSim): void {
    for (const child of [...this.overlay.children]) {
      this.overlay.remove(child);
      (child as THREE.Mesh).geometry?.dispose();
    }
    const g = trains.graph;
    const buf = new MeshBuf();
    const used = new Map<number, number>();
    for (const line of this.net.rail.lines) {
      if (line.hidden) continue;
      const color = lin(parseInt(line.color.replace('#', ''), 16) || 0x46d0ff);
      for (const id of trains.linePieces(line.id)) {
        const p = g.pieces[id];
        const n = used.get(id) ?? 0;
        used.set(id, n + 1);
        const frames = polyFrames(p.pts);
        const off = (n - 0.5) * 0.9 * (n > 0 ? 1 : 0);
        sweep(buf, frames, [off - 0.55, RAIL_TOP + 0.4 + n * 0.02], [off + 0.55, RAIL_TOP + 0.4 + n * 0.02], color, M_PLAIN);
      }
    }
    if (!buf.count) return;
    const mesh = new THREE.Mesh(buf.toGeometry(), this.overlayMat);
    mesh.renderOrder = 9;
    this.overlay.add(mesh);
  }

  dispose(): void {
    this.clear();
    for (const child of [...this.overlay.children]) (child as THREE.Mesh).geometry?.dispose();
    this.material.dispose();
    this.wireMat.dispose();
    this.overlayMat.dispose();
    this.lampOn.dispose();
    this.lampOff.dispose();
    this.gateMat.dispose();
    this.gateStripe.dispose();
    this.group.clear();
  }

  get underground(): boolean {
    return this.undergroundOn;
  }
}

function frameAt(frames: readonly PFrame[], s: number): PFrame {
  if (s <= frames[0].s) return frames[0];
  for (let i = 0; i + 1 < frames.length; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    if (s > b.s) continue;
    const f = (s - a.s) / Math.max(b.s - a.s, 1e-6);
    const rx = a.rx + (b.rx - a.rx) * f;
    const rz = a.rz + (b.rz - a.rz) * f;
    const rl = Math.hypot(rx, rz) || 1;
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      z: a.z + (b.z - a.z) * f,
      tx: a.tx,
      ty: a.ty,
      tz: a.tz,
      rx: rx / rl,
      rz: rz / rl,
      s,
    };
  }
  return frames[frames.length - 1];
}

export { frameAt as railFrameAt };
