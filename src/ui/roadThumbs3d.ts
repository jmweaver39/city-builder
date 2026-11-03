/**
 * Picture cards for road types: a small offscreen Three.js render of a short
 * straight piece of each road, with its sidewalks, median, lane colours and
 * markings, and a car or two, seen from above at an angle. Rendered once per road
 * type (custom roads again whenever their definition changes) and cached as an
 * image URL. Falls back to null where WebGL is unavailable.
 */
import * as THREE from 'three';
import { sidewalkOn } from '../core/roadTypes';
import type { LineStyle, PaintColor, RoadTypeDef } from '../core/types';

const W = 200;
const H = 128;
const LENGTH = 46;

const PAINT: Record<PaintColor, string> = { white: '#f2f0e8', yellow: '#f0c534', blue: '#4f8be0', red: '#e04a3f', green: '#4cbf6b' };
const LANE_FILL: Record<string, string> = { drive: '#4b525b', bus: '#8e3b35', bike: '#3f7d57', rail: '#6b6457' };
const CAR_COLOURS = [0xd8dde3, 0xc8463d, 0x2f6fb5, 0x2b2f35, 0xe0b84a];

let renderer: THREE.WebGLRenderer | null = null;
let failed = false;
const cache = new Map<string, string>();

function signature(def: RoadTypeDef): string {
  return JSON.stringify([def.id, def.lanes, def.halfWidth, def.sidewalk, def.sidewalkLeft, def.sidewalkRight, def.median, def.markings, def.category]);
}

function getRenderer(): THREE.WebGLRenderer | null {
  if (renderer || failed) return renderer;
  try {
    const canvas = document.createElement('canvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  } catch {
    failed = true;
    renderer = null;
  }
  return renderer;
}

/** The road surface seen from above, along its length: lane colours and markings. */
function surfaceTexture(def: RoadTypeDef): THREE.CanvasTexture {
  const pxPerM = 16;
  const half = def.halfWidth;
  const cw = Math.ceil(half * 2 * pxPerM);
  const ch = 256;
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const g = canvas.getContext('2d')!;
  const x = (offset: number) => (offset + half) * pxPerM;
  g.fillStyle = '#545b64';
  g.fillRect(0, 0, cw, ch);
  for (const lane of def.lanes) {
    g.fillStyle = LANE_FILL[lane.kind] ?? LANE_FILL.drive;
    g.fillRect(x(lane.offset - lane.width / 2), 0, lane.width * pxPerM, ch);
  }
  const m = def.markings;
  const line = (at: number, style: LineStyle, color: PaintColor) => {
    if (style === 'none' || def.category === 'rail') return;
    g.fillStyle = PAINT[color];
    const w = 0.15 * pxPerM;
    const strip = (dx: number, dashed: boolean) => {
      if (!dashed) g.fillRect(x(at) + dx - w / 2, 0, w, ch);
      else for (let y = 0; y < ch; y += 48) g.fillRect(x(at) + dx - w / 2, y, w, 26);
    };
    if (style === 'double') {
      strip(-3, false);
      strip(3, false);
    } else if (style === 'solidDashed' || style === 'dashedSolid') {
      strip(-3, style === 'dashedSolid');
      strip(3, style === 'solidDashed');
    } else strip(0, style === 'dashed' || style === 'dotted');
  };
  // Lines between lanes, and the centre line where the directions meet.
  const lanes = [...def.lanes].sort((a, b) => a.offset - b.offset);
  for (let i = 0; i + 1 < lanes.length; i++) {
    const a = lanes[i];
    const b = lanes[i + 1];
    const at = (a.offset + a.width / 2 + b.offset - b.width / 2) / 2;
    if (a.dir !== b.dir) line(at, m.centerLine, m.centerColor);
    else {
      const custom = m.boundaries?.[i];
      line(at, custom?.style ?? m.laneLine, custom?.color ?? m.laneColor);
    }
  }
  if (lanes.length) {
    line(lanes[0].offset - lanes[0].width / 2 + 0.2, m.edgeLine, m.edgeColor);
    const last = lanes[lanes.length - 1];
    line(last.offset + last.width / 2 - 0.2, m.edgeLine, m.edgeColor);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function box(w: number, h: number, d: number, color: number | string, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
  mesh.position.set(x, y, z);
  return mesh;
}

function buildScene(def: RoadTypeDef): { scene: THREE.Scene; camera: THREE.PerspectiveCamera } {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#7f9a63');
  scene.add(new THREE.HemisphereLight(0xdfeeff, 0x5d6b45, 1.6));
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sun.position.set(-20, 40, 18);
  scene.add(sun);

  const half = def.halfWidth;
  const rail = def.category === 'rail';
  // Grass ground.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#6f8c55', roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  // Carriageway with its markings.
  const surface = new THREE.Mesh(
    new THREE.BoxGeometry(half * 2, 0.12, LENGTH),
    [
      new THREE.MeshStandardMaterial({ color: '#3f454d' }),
      new THREE.MeshStandardMaterial({ color: '#3f454d' }),
      new THREE.MeshStandardMaterial({ map: rail ? null : surfaceTexture(def), color: rail ? '#8a8172' : '#ffffff', roughness: 0.9 }),
      new THREE.MeshStandardMaterial({ color: '#3f454d' }),
      new THREE.MeshStandardMaterial({ color: '#3f454d' }),
      new THREE.MeshStandardMaterial({ color: '#3f454d' }),
    ],
  );
  surface.position.y = 0.06;
  scene.add(surface);
  // Sidewalks, raised.
  for (const side of [-1, 1] as const) {
    const w = sidewalkOn(def, side);
    if (w > 0) scene.add(box(w, 0.25, LENGTH, '#b9b7ae', side * (half + w / 2), 0.125, 0));
  }
  // Median.
  if (def.median.width > 0 && def.median.kind !== 'none' && def.median.kind !== 'paint') {
    const color = def.median.kind === 'grass' ? '#6d9a4c' : '#c9c8c2';
    const h = def.median.kind === 'barrier' ? 0.8 : 0.22;
    scene.add(box(def.median.width, h, LENGTH, color, def.median.offset ?? 0, h / 2 + 0.1, 0));
  }
  // Track: sleepers and rails on each rail lane.
  if (rail) {
    for (const lane of def.lanes) {
      for (let z = -LENGTH / 2; z < LENGTH / 2; z += 1.2) scene.add(box(2.6, 0.12, 0.25, '#6b5a45', lane.offset, 0.18, z));
      for (const dx of [-0.72, 0.72]) scene.add(box(0.1, 0.16, LENGTH, '#c3c7cc', lane.offset + dx, 0.28, 0));
    }
  } else {
    // A car or two on the drive lanes, facing their direction of travel.
    const drive = def.lanes.filter((l) => l.kind === 'drive' || l.kind === 'bus');
    drive.slice(0, 3).forEach((lane, i) => {
      const z = (i % 2 === 0 ? 6 : -4) + i * 3;
      const long = lane.kind === 'bus' ? 9 : 4.2;
      const body = box(1.8, 1.1, long, lane.kind === 'bus' ? 0xd96c2c : CAR_COLOURS[i % CAR_COLOURS.length], lane.offset, 0.75, z * lane.dir);
      const cabin = box(1.6, 0.6, long * 0.5, 0x1d2630, lane.offset, 1.55, z * lane.dir - lane.dir * 0.3);
      scene.add(body, cabin);
    });
  }
  // Frame the road's whole width, seen from a raised corner along its length.
  const span = half + Math.max(sidewalkOn(def, -1), sidewalkOn(def, 1)) + 1.5;
  const camera = new THREE.PerspectiveCamera(32, W / H, 0.5, 400);
  const dist = span * 2.6 + 6;
  camera.position.set(span * 0.55, dist * 0.62, dist * 0.92);
  camera.lookAt(0, 0, -2);
  return { scene, camera };
}

function dispose(scene: THREE.Scene): void {
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      (m as THREE.MeshStandardMaterial).map?.dispose();
      m.dispose();
    }
  });
}

/** An image URL showing the road type, or null when it cannot be drawn here. */
export function roadThumbnail(def: RoadTypeDef): string | null {
  const key = signature(def);
  const hit = cache.get(key);
  if (hit) return hit;
  const r = getRenderer();
  if (!r) return null;
  try {
    const { scene, camera } = buildScene(def);
    r.render(scene, camera);
    const url = r.domElement.toDataURL('image/png');
    dispose(scene);
    cache.set(key, url);
    return url;
  } catch {
    return null;
  }
}
