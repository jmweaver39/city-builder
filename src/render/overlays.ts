/**
 * Things drawn over the world for the player: overlay colours, ghost roads, tool
 * marks, highlights, DOM labels, lane debug lines and lane direction arrows.
 * None of it touches road geometry: colour overlays only write the slot table.
 */
import * as THREE from 'three';
import type { Id, RoadTypeDef, Vec3 } from '../core/types';
import type { RoadNetwork } from '../core/RoadNetwork';
import { buildSegmentCurve, buildSegmentGeom } from '../core/geometry';
import { effectiveSpeedKmh, totalHalfWidth } from '../core/roadTypes';
import type { SimApi } from '../sim/api';
import type { DraftState, HighlightSet, OverlayMode, RoadPreview, ToolMark } from './api';
import { PaintBuf } from './batch';
import { arrowShape, placeStamp } from './markings';
import { hexRGB, ROAD_LIFT } from './constants';
import { SLOT_COLS, type Shared } from './materials';

const ARROW_STEP = 22;

export interface SlotOwner {
  slotOfSegment(id: Id): number;
  slotOfNode(id: Id): number;
}

const TRAFFIC_STOPS = [0xb8140e, 0xe85a10, 0xf0c81e, 0x74c21e, 0x17a544].map(hexRGB);

/** Green to red, the way traffic maps read. Input 1 is free flowing. */
function trafficRamp(ratio: number, out: number[]): void {
  const r = Math.min(1, Math.max(0, ratio));
  const stops = TRAFFIC_STOPS;
  const f = r * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  const t = f - i;
  for (let k = 0; k < 3; k++) out[k] = stops[i][k] + (stops[i + 1][k] - stops[i][k]) * t;
}

const CATEGORY_COL: Record<string, readonly [number, number, number]> = {
  street: hexRGB(0x7fd0a0),
  avenue: hexRGB(0xe6c85a),
  oneway: hexRGB(0x62c2e8),
  highway: hexRGB(0xe8704a),
  ramp: hexRGB(0xc070e0),
  custom: hexRGB(0xb0b0b0),
};

const SPEED_BANDS: [number, number][] = [
  [30, 0x4fc98a],
  [50, 0x8fd65a],
  [60, 0xd8d84a],
  [80, 0xeeb040],
  [100, 0xe87a3a],
  [120, 0xdc4a3c],
  [Infinity, 0xb0349a],
];

/** Colours used by the data overlays, for a legend in the UI. */
export function overlayLegend(mode: OverlayMode): { label: string; color: string }[] {
  const css = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`;
  if (mode === 'traffic') {
    return [
      { label: 'Free flow', color: '#2bb04f' },
      { label: 'Busy', color: '#f0d030' },
      { label: 'Heavy', color: '#f0841c' },
      { label: 'Jammed', color: '#c81c14' },
    ];
  }
  if (mode === 'speedLimit') {
    return SPEED_BANDS.map(([kmh, hex]) => ({ label: kmh === Infinity ? 'Over 120 km/h' : `Up to ${kmh} km/h`, color: css(hex) }));
  }
  if (mode === 'roadType') {
    return [
      { label: 'Street', color: '#7fd0a0' },
      { label: 'Avenue', color: '#e6c85a' },
      { label: 'One-way', color: '#62c2e8' },
      { label: 'Highway', color: '#e8704a' },
      { label: 'Ramp', color: '#c070e0' },
      { label: 'Custom', color: '#b0b0b0' },
    ];
  }
  return [];
}

export class OverlayPainter {
  mode: OverlayMode = 'none';
  private timer = 0;
  private colour = [0, 0, 0];
  private highlight: HighlightSet | null = null;
  private highlighted: number[] = [];

  constructor(
    private readonly net: RoadNetwork,
    private readonly shared: Shared,
    private readonly slots: SlotOwner,
  ) {}

  private write(slot: number, row: number, r: number, g: number, b: number, a: number): void {
    const d = this.shared.slotData;
    const y = Math.floor(slot / SLOT_COLS) * 2 + row;
    const i = ((slot % SLOT_COLS) + y * SLOT_COLS) * 4;
    d[i] = r * 255;
    d[i + 1] = g * 255;
    d[i + 2] = b * 255;
    d[i + 3] = a * 255;
  }

  setMode(mode: OverlayMode): void {
    this.mode = mode;
    this.shared.uDim.value = mode === 'none' || mode === 'lanes' ? 0 : 0.8;
    this.timer = Infinity;
    if (mode === 'none' || mode === 'lanes') this.clear();
  }

  private clear(): void {
    const net = this.net;
    for (const s of net.segments) this.write(this.slots.slotOfSegment(s.id), 0, 0, 0, 0, 0);
    for (const n of net.nodes) this.write(this.slots.slotOfNode(n.id), 0, 0, 0, 0, 0);
    this.shared.slotTex.needsUpdate = true;
  }

  private paintNode(nodeId: Id, sum: number[], count: number): void {
    const k = count > 0 ? 1 / count : 0;
    this.write(this.slots.slotOfNode(nodeId), 0, sum[0] * k, sum[1] * k, sum[2] * k, count > 0 ? 0.92 : 0);
  }

  /** Repaint from data, a few times a second. Geometry stays untouched. */
  update(dt: number, sim: SimApi | null): void {
    if (this.mode === 'none' || this.mode === 'lanes') return;
    this.timer += dt;
    const interval = this.mode === 'traffic' ? 0.25 : 1;
    if (this.timer < interval) return;
    this.timer = 0;
    const net = this.net;
    const col = this.colour;
    const accum = new Map<Id, { sum: number[]; n: number }>();
    for (const seg of net.segments) {
      const def = net.roadTypeOf(seg.id);
      switch (this.mode) {
        case 'traffic': {
          const t = sim?.segmentTraffic(seg.id);
          trafficRamp(t ? t.speedRatio : 1, col);
          break;
        }
        case 'speedLimit': {
          const kmh = effectiveSpeedKmh(def, seg.overrides);
          const band = SPEED_BANDS.find(([limit]) => kmh <= limit)!;
          const c = hexRGB(band[1]);
          col[0] = c[0];
          col[1] = c[1];
          col[2] = c[2];
          break;
        }
        case 'roadType': {
          const c = CATEGORY_COL[def.category] ?? CATEGORY_COL.custom;
          col[0] = c[0];
          col[1] = c[1];
          col[2] = c[2];
          break;
        }
      }
      this.write(this.slots.slotOfSegment(seg.id), 0, col[0], col[1], col[2], 0.92);
      for (const nid of [seg.a, seg.b]) {
        let a = accum.get(nid);
        if (!a) accum.set(nid, (a = { sum: [0, 0, 0], n: 0 }));
        a.sum[0] += col[0];
        a.sum[1] += col[1];
        a.sum[2] += col[2];
        a.n++;
      }
    }
    for (const [nid, a] of accum) this.paintNode(nid, a.sum, a.n);
    this.shared.slotTex.needsUpdate = true;
  }

  setHighlight(set: HighlightSet | null): void {
    for (const s of this.highlighted) this.write(s, 1, 0, 0, 0, 0);
    this.highlighted = [];
    this.highlight = set;
    this.apply();
  }

  /** Slots moved: repaint everything from scratch. */
  refresh(): void {
    this.shared.slotData.fill(0);
    this.timer = Infinity;
    this.highlighted = [];
    this.apply();
  }

  /** Reapply highlights after slots change. */
  apply(): void {
    const set = this.highlight;
    if (set) {
      const c = new THREE.Color(set.color ?? '#35c8ff');
      const paint = (slot: number) => {
        this.write(slot, 1, c.r, c.g, c.b, 1);
        this.highlighted.push(slot);
      };
      for (const id of set.segments ?? []) paint(this.slots.slotOfSegment(id));
      for (const id of set.nodes ?? []) paint(this.slots.slotOfNode(id));
    }
    this.shared.slotTex.needsUpdate = true;
  }
}

/** Lane direction arrows for the 'lanes' overlay. */
export function buildLaneArrows(net: RoadNetwork, id: Id, buf: PaintBuf): void {
  const seg = net.getSegment(id);
  const geom = net.segmentGeom(id);
  const graph = net.laneGraph;
  if (!seg || !geom || geom.stations.length < 2) return;
  const lanes = graph.roadLanes.get(id);
  if (!lanes) return;
  const shape = arrowShape(false, true, false, false);
  for (const idx of lanes) {
    if (idx < 0) continue;
    const lane = graph.lanes[idx];
    const pts = lane.pts;
    const cum = lane.cum;
    const len = lane.length;
    const color = lane.vehicleKind === 'bus' ? hexRGB(0xff7a4a) : lane.vehicleKind === 'bike' ? hexRGB(0x7be08c) : hexRGB(0x46d0ff);
    let k = 0;
    const count = Math.max(1, Math.floor(len / ARROW_STEP));
    const scale = Math.min(1.2, len / 7);
    for (let i = 0; i < count; i++) {
      const s = ((i + 0.5) / count) * len;
      while (k + 2 < cum.length && cum[k + 1] < s) k++;
      const f = (s - cum[k]) / Math.max(cum[k + 1] - cum[k], 1e-6);
      const x0 = pts[k * 3];
      const y0 = pts[k * 3 + 1];
      const z0 = pts[k * 3 + 2];
      const x1 = pts[k * 3 + 3];
      const y1 = pts[k * 3 + 4];
      const z1 = pts[k * 3 + 5];
      const dx = x1 - x0;
      const dz = z1 - z0;
      const l = Math.hypot(dx, dz) || 1;
      buf.stamp(placeStamp(shape, x0 + dx * f, z0 + dz * f, dx / l, dz / l, scale), y0 + (y1 - y0) * f + ROAD_LIFT + 0.01, color);
    }
  }
}

function stateColour(state: DraftState): THREE.Color {
  return new THREE.Color(state === 'error' ? 0xff4436 : state === 'warning' ? 0xffb52e : 0x3ec8ff);
}

/** Vertex-coloured transparent triangles, drawn over the world. */
class OverlayMesh {
  readonly mesh: THREE.Mesh;
  pos: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  constructor(group: THREE.Group, material: THREE.Material, order: number) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.visible = false;
    group.add(this.mesh);
  }
  reset(): void {
    this.pos.length = 0;
    this.col.length = 0;
    this.idx.length = 0;
  }
  vert(x: number, y: number, z: number, c: THREE.Color, a: number): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b, a);
    return i;
  }
  commit(): void {
    this.mesh.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 4));
    g.setIndex(this.idx);
    this.mesh.geometry = g;
    this.mesh.visible = this.idx.length > 0;
  }
  dispose(): void {
    this.mesh.geometry.dispose();
  }
}

const OVER_ALL = (): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });

function markColour(color: string): { c: THREE.Color; a: number } {
  const m = /rgba?\(([^)]+)\)/.exec(color);
  if (m) {
    const p = m[1].split(',').map((v) => parseFloat(v));
    return { c: new THREE.Color(`rgb(${Math.round(p[0])},${Math.round(p[1])},${Math.round(p[2])})`), a: p.length > 3 ? p[3] : 1 };
  }
  return { c: new THREE.Color(color), a: 1 };
}

export class ToolLayer {
  readonly group = new THREE.Group();
  private material = OVER_ALL();
  private ghosts = new OverlayMesh(this.group, this.material, 20);
  private marks = new OverlayMesh(this.group, this.material, 21);
  private labelRoot: HTMLDivElement;
  private labels: { el: HTMLDivElement; pos: Vec3 }[] = [];
  private pool: HTMLDivElement[] = [];

  constructor(
    private readonly net: RoadNetwork,
    container: HTMLElement,
  ) {
    const root = document.createElement('div');
    root.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
    container.appendChild(root);
    this.labelRoot = root;
  }

  /** Ghost ribbons tinted by state, with lane edges and direction arrows. */
  setPreview(previews: RoadPreview[]): void {
    const m = this.ghosts;
    m.reset();
    for (const p of previews) {
      const def = this.net.roadType(p.roadType);
      if (!def) continue;
      const c = stateColour(p.state);
      for (const curve of p.curves) this.ghostCurve(m, curve, def, c);
    }
    m.commit();
  }

  private ghostCurve(m: OverlayMesh, cubic: RoadPreview['curves'][number], def: RoadTypeDef, c: THREE.Color): void {
    const curve = buildSegmentCurve(cubic);
    if (curve.length < 0.1) return;
    const geom = buildSegmentGeom(-1, curve, 0, 0, { halfWidth: def.halfWidth });
    const st = geom.stations;
    const W = totalHalfWidth(def);
    const y = (i: number) => st[i].pos.y + ROAD_LIFT + 0.2;
    const band = (o0: number, o1: number, a: number) => {
      const base = m.pos.length / 3;
      for (let i = 0; i < st.length; i++) {
        const s = st[i];
        m.vert(s.pos.x + s.right.x * o0, y(i), s.pos.z + s.right.z * o0, c, a);
        m.vert(s.pos.x + s.right.x * o1, y(i), s.pos.z + s.right.z * o1, c, a);
      }
      for (let i = 0; i + 1 < st.length; i++) {
        const v = base + i * 2;
        m.idx.push(v, v + 1, v + 3, v, v + 3, v + 2);
      }
    };
    band(-W, W, 0.28);
    band(-W, -W + 0.25, 0.9);
    band(W - 0.25, W, 0.9);
    const lanes = def.lanes;
    for (let i = 0; i + 1 < lanes.length; i++) {
      const o = (lanes[i].offset + lanes[i + 1].offset) / 2;
      band(o - 0.07, o + 0.07, 0.55);
    }
    // Direction of each lane, walked along the curve.
    const white = new THREE.Color(1, 1, 1);
    const tris = arrowShape(false, true, false, false);
    const step = 14;
    let next = step / 2;
    for (let i = 0; i + 1 < st.length; i++) {
      const a = st[i];
      const b = st[i + 1];
      while (next < b.s) {
        if (next < a.s) {
          next += step;
          continue;
        }
        const f = (next - a.s) / Math.max(b.s - a.s, 1e-6);
        const px = a.pos.x + (b.pos.x - a.pos.x) * f;
        const pz = a.pos.z + (b.pos.z - a.pos.z) * f;
        const py = a.pos.y + (b.pos.y - a.pos.y) * f + ROAD_LIFT + 0.25;
        for (const lane of lanes) {
          const fx = a.tangent.x * lane.dir;
          const fz = a.tangent.z * lane.dir;
          const l = Math.hypot(fx, fz) || 1;
          const pts = placeStamp(tris, px + a.right.x * lane.offset, pz + a.right.z * lane.offset, fx / l, fz / l, 0.7);
          const base = m.pos.length / 3;
          for (let k = 0; k < pts.length; k += 2) m.vert(pts[k], py, pts[k + 1], white, 0.85);
          for (let k = 0; k < pts.length / 2; k++) m.idx.push(base + k);
        }
        next += step;
      }
    }
  }

  setMarks(marks: ToolMark[]): void {
    const m = this.marks;
    m.reset();
    this.clearLabels();
    for (const mark of marks) {
      switch (mark.kind) {
        case 'point': {
          const { c, a } = markColour(mark.color);
          const seg = 20;
          const y = mark.pos.y + ROAD_LIFT + 0.25;
          const centre = m.vert(mark.pos.x, y, mark.pos.z, c, a);
          const ring = m.pos.length / 3;
          for (let i = 0; i < seg; i++) {
            const t = (i / seg) * Math.PI * 2;
            m.vert(mark.pos.x + Math.cos(t) * mark.radius, y, mark.pos.z + Math.sin(t) * mark.radius, c, a);
          }
          for (let i = 0; i < seg; i++) m.idx.push(centre, ring + i, ring + ((i + 1) % seg));
          break;
        }
        case 'ring': {
          const { c, a } = markColour(mark.color);
          const seg = 40;
          const y = mark.pos.y + ROAD_LIFT + 0.25;
          const t = Math.max(0.2, mark.radius * 0.06);
          const base = m.pos.length / 3;
          for (let i = 0; i < seg; i++) {
            const q = (i / seg) * Math.PI * 2;
            const cx = Math.cos(q);
            const sz = Math.sin(q);
            m.vert(mark.pos.x + cx * (mark.radius - t), y, mark.pos.z + sz * (mark.radius - t), c, a);
            m.vert(mark.pos.x + cx * (mark.radius + t), y, mark.pos.z + sz * (mark.radius + t), c, a);
          }
          for (let i = 0; i < seg; i++) {
            const v = base + i * 2;
            const w = base + ((i + 1) % seg) * 2;
            m.idx.push(v, v + 1, w + 1, v, w + 1, w);
          }
          break;
        }
        case 'line': {
          const { c, a } = markColour(mark.color);
          this.lineMark(m, mark.points, mark.width, c, a, !!mark.dashed);
          break;
        }
        case 'label':
          this.addLabel(mark.pos, mark.text, mark.color);
          break;
      }
    }
    m.commit();
  }

  private lineMark(m: OverlayMesh, pts: readonly Vec3[], width: number, c: THREE.Color, a: number, dashed: boolean): void {
    const hw = width / 2;
    const dash = Math.max(1.5, width * 5);
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-5) continue;
      const rx = (-dz / len) * hw;
      const rz = (dx / len) * hw;
      const piece = (t0: number, t1: number) => {
        const y0 = p.y + (q.y - p.y) * t0 + ROAD_LIFT + 0.25;
        const y1 = p.y + (q.y - p.y) * t1 + ROAD_LIFT + 0.25;
        const ax = p.x + dx * t0;
        const az = p.z + dz * t0;
        const bx = p.x + dx * t1;
        const bz = p.z + dz * t1;
        const v = m.vert(ax - rx, y0, az - rz, c, a);
        m.vert(ax + rx, y0, az + rz, c, a);
        m.vert(bx + rx, y1, bz + rz, c, a);
        m.vert(bx - rx, y1, bz - rz, c, a);
        m.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      };
      if (!dashed) {
        piece(0, 1);
        continue;
      }
      const n = Math.max(1, Math.floor(len / (dash * 2)));
      for (let k = 0; k < n; k++) piece(k / n, (k + 0.5) / n);
    }
  }

  private addLabel(pos: Vec3, text: string, color?: string): void {
    const el = this.pool.pop() ?? document.createElement('div');
    el.textContent = text;
    el.style.cssText =
      'position:absolute;left:0;top:0;transform-origin:0 0;white-space:nowrap;' +
      'font:600 12px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;padding:3px 7px;border-radius:6px;' +
      'background:rgba(14,26,46,.82);border:1px solid rgba(90,190,240,.35);' +
      `color:${color ?? '#e8f4fb'};will-change:transform;`;
    this.labelRoot.appendChild(el);
    this.labels.push({ el, pos });
  }

  private clearLabels(): void {
    for (const l of this.labels) {
      l.el.remove();
      this.pool.push(l.el);
    }
    this.labels = [];
  }

  /** Stick DOM labels to their world positions. */
  updateLabels(project: (p: Vec3) => { x: number; y: number } | null, rect: DOMRect): void {
    for (const l of this.labels) {
      const p = project(l.pos);
      if (!p) {
        l.el.style.display = 'none';
        continue;
      }
      l.el.style.display = '';
      l.el.style.transform = `translate(${Math.round(p.x - rect.left)}px,${Math.round(p.y - rect.top - 28)}px) translateX(-50%)`;
    }
  }

  dispose(): void {
    this.ghosts.dispose();
    this.marks.dispose();
    this.material.dispose();
    this.labelRoot.remove();
    this.group.clear();
  }
}

/** Lane graph drawn as thin ribbons over everything, rebuilt when the graph changes. */
export class LaneDebug {
  readonly object: THREE.Mesh;
  private version = -1;
  private material = OVER_ALL();
  enabled = false;

  constructor(private readonly net: RoadNetwork) {
    this.object = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 19;
    this.object.visible = false;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.object.visible = on;
    if (on) this.refresh();
  }

  refresh(): void {
    if (!this.enabled) return;
    const graph = this.net.laneGraph;
    if (graph.version === this.version) return;
    this.version = graph.version;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const hw = 0.16;
    for (const lane of graph.lanes) {
      const c = lane.kind === 'connector' ? [1, 0.75, 0.2] : lane.vehicleKind === 'bus' ? [1, 0.4, 0.3] : lane.vehicleKind === 'bike' ? [0.4, 1, 0.5] : [0.25, 0.8, 1];
      const p = lane.pts;
      const n = p.length / 3;
      for (let i = 0; i + 1 < n; i++) {
        const dx = p[i * 3 + 3] - p[i * 3];
        const dz = p[i * 3 + 5] - p[i * 3 + 2];
        const l = Math.hypot(dx, dz) || 1;
        const rx = (-dz / l) * hw;
        const rz = (dx / l) * hw;
        const v = pos.length / 3;
        const y0 = p[i * 3 + 1] + ROAD_LIFT + 0.3;
        const y1 = p[i * 3 + 4] + ROAD_LIFT + 0.3;
        pos.push(p[i * 3] - rx, y0, p[i * 3 + 2] - rz, p[i * 3] + rx, y0, p[i * 3 + 2] + rz);
        pos.push(p[i * 3 + 3] + rx, y1, p[i * 3 + 5] + rz, p[i * 3 + 3] - rx, y1, p[i * 3 + 5] - rz);
        // Dim at the tail of each step, so direction reads along the line.
        for (let k = 0; k < 4; k++) {
          const f = k < 2 ? 0.4 : 1;
          col.push(c[0] * f, c[1] * f, c[2] * f, 0.9);
        }
        idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      }
    }
    this.object.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    g.setIndex(idx);
    this.object.geometry = g;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
