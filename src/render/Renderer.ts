/**
 * The Three.js renderer behind RendererApi. Owns the WebGL context and wires the
 * layers together. See ARCHITECTURE.md, Rendering design.
 */
import * as THREE from 'three';
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Vec3 } from '../core/types';
import type { SimApi } from '../sim/api';
import type { CameraPose, HighlightSet, OverlayMode, RendererApi, RendererExtras, RendererStats, RoadPreview, ToolMark } from './api';
import type { GridView } from './api';
import { CameraRig } from './camera';
import { RenderContext } from './context';
import { DecalLayer } from './decals';
import { NodeMarkingLayer } from './nodeMarkings';
import { EndpointLayer } from './endpoints';
import { FurnitureLayer } from './furniture';
import { Shared } from './materials';
import { GrassLayer } from './grass';
import { LaneDebug, OverlayPainter, ToolLayer } from './overlays';
import { GridLayer } from './grid';
import { PostPipeline } from './post';
import { QUALITY, QualityGovernor, guessQuality, type QualityName } from './quality';
import { RoadLayer } from './RoadLayer';
import { SceneRig } from './scene';
import { Terrain } from './terrain';
import { makeGlowTexture } from './textures';
import { TreeLayer } from './trees';
import { VehicleLayer } from './vehicles';

const FURNITURE_INTERVAL = 0.25;

/** Thrown from the constructor when the browser has no WebGL2. */
export class WebGLUnavailableError extends Error {
  constructor(detail?: string) {
    super(`Cloverleaf needs WebGL2, which this browser or GPU does not provide.${detail ? ` (${detail})` : ''}`);
    this.name = 'WebGLUnavailableError';
  }
}

function assertWebGL2(): void {
  const probe = document.createElement('canvas');
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = probe.getContext('webgl2');
  } catch (err) {
    throw new WebGLUnavailableError(String(err));
  }
  if (!gl) throw new WebGLUnavailableError();
  gl.getExtension('WEBGL_lose_context')?.loseContext();
}

export class Renderer implements RendererApi, RendererExtras {
  readonly canvas: HTMLCanvasElement;
  private gl: THREE.WebGLRenderer;
  private rig: SceneRig;
  private cam: CameraRig;
  private shared: Shared;
  private terrain: Terrain;
  private trees: TreeLayer;
  private grass: GrassLayer;
  private post: PostPipeline;
  private governor = new QualityGovernor();
  /** Shared access for layers and for modules outside this directory. */
  readonly context: RenderContext;
  private roads: RoadLayer;
  private decals: DecalLayer;
  private nodeMarkings: NodeMarkingLayer;
  private vehicles: VehicleLayer;
  private furniture: FurnitureLayer;
  private endpoints: EndpointLayer;
  private overlay: OverlayPainter;
  private tools: ToolLayer;
  private laneDebug: LaneDebug;
  private grid: GridLayer;
  private glow: THREE.Texture;
  private resizeObserver: ResizeObserver | null = null;
  private contextLost = false;
  private contextListeners = new Set<(lost: boolean) => void>();

  private followId: number | null = null;
  private followSlot = 0;
  private followPoint = new THREE.Vector3();

  private fps = 60;
  private lastStats: RendererStats = { fps: 0, drawCalls: 0, triangles: 0 };
  private time = 0;
  private lightKey = NaN;
  private underground = false;
  private projected = new THREE.Vector3();
  private disposed = false;
  private furnitureStale = false;
  private furnitureTimer = 0;
  private resolutionScale = 1;

  private onLost = (e: Event) => {
    e.preventDefault();
    this.contextLost = true;
    for (const fn of this.contextListeners) fn(true);
  };
  private onRestored = () => {
    this.contextLost = false;
    // Three.js reinitialises its state and re-uploads buffers lazily. The slot table
    // and noise are data textures, so they need flagging again.
    this.shared.slotTex.needsUpdate = true;
    this.shared.uNoise.value.needsUpdate = true;
    for (const fn of this.contextListeners) fn(false);
  };

  constructor(
    private readonly container: HTMLElement,
    private readonly net: RoadNetwork,
    private readonly sim: SimApi | null,
  ) {
    assertWebGL2();
    let gl: THREE.WebGLRenderer;
    try {
      gl = new THREE.WebGLRenderer({
        antialias: true,
        logarithmicDepthBuffer: true,
        stencil: true,
        powerPreference: 'high-performance',
      });
    } catch (err) {
      throw new WebGLUnavailableError(err instanceof Error ? err.message : String(err));
    }
    this.gl = gl;
    this.canvas = gl.domElement;
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(this.canvas);
    gl.setPixelRatio(this.pixelRatio());
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFShadowMap;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 0.6;
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.info.autoReset = false;
    this.canvas.addEventListener('webglcontextlost', this.onLost);
    this.canvas.addEventListener('webglcontextrestored', this.onRestored);

    const aniso = Math.min(8, gl.capabilities.getMaxAnisotropy());
    this.shared = new Shared(aniso);
    this.glow = makeGlowTexture();
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;
    gl.setSize(w, h);

    this.rig = new SceneRig(this.shared, gl);
    this.cam = new CameraRig(this.canvas, w / h);
    const scene = this.rig.scene;
    this.post = new PostPipeline(gl, this.cam.camera.far);
    const startLevel = guessQuality(gl.getContext() as WebGL2RenderingContext);
    this.context = new RenderContext(gl, scene, this.rig.overlayScene, this.cam.camera, net, sim, this.shared, QUALITY[startLevel], this.post);
    this.context.lightDir = this.rig.lightDir;
    this.terrain = new Terrain(this.shared);
    scene.add(this.terrain.group);
    this.trees = new TreeLayer(net, aniso);
    scene.add(this.trees.group);
    this.grass = new GrassLayer(this.shared, this.trees.maskTexture, TreeLayer.WORLD);
    scene.add(this.grass.group);
    this.roads = new RoadLayer(net, this.shared);
    scene.add(this.roads.group);
    this.decals = new DecalLayer(net, this.shared, aniso);
    scene.add(this.decals.group);
    this.nodeMarkings = new NodeMarkingLayer(net, this.shared);
    scene.add(this.nodeMarkings.group);
    this.vehicles = new VehicleLayer(this.shared);
    scene.add(this.vehicles.group);
    this.furniture = new FurnitureLayer(net, this.shared, this.roads.surfaceMaterial, this.glow, aniso);
    scene.add(this.furniture.group);
    this.endpoints = new EndpointLayer(net, this.shared);
    scene.add(this.endpoints.group);
    this.overlay = new OverlayPainter(net, this.shared, this.roads);
    this.tools = new ToolLayer(net, container);
    this.rig.overlayScene.add(this.tools.group);
    this.laneDebug = new LaneDebug(net);
    this.rig.overlayScene.add(this.laneDebug.object);
    this.grid = new GridLayer(this.context);
    this.context.addLayer(this.grid);
    this.roads.onSlotsChanged = () => this.overlay.refresh();
    this.trees.blockers = () => this.endpoints.footprints;
    this.applyQuality(startLevel);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        if (cw > 0 && ch > 0) this.resize(cw, ch);
      });
      this.resizeObserver.observe(container);
    }
    this.applyNetworkChanges();
    this.flushFurniture(FURNITURE_INTERVAL);
    this.furniture.updateNight();
  }

  private pixelRatio(): number {
    const cap = this.context?.quality.pixelRatio ?? 2;
    return Math.min(window.devicePixelRatio || 1, cap) * this.resolutionScale;
  }

  private applyNetworkChanges(): void {
    const change = this.roads.flush();
    this.nodeMarkings.flush();
    if (!change) return;
    if (change.decals || this.decals.followsRoads) this.decals.rebuild();
    if (change.endpoints || change.structural) this.endpoints.rebuild();
    for (const b of change.boxes) this.trees.markRegion(b[0], b[1], b[2], b[3]);
    if (change.endpoints || change.reset) this.trees.markAll();
    if (change.structural) this.furnitureStale = true;
  }

  /** Signs and lamps rebuild whole, so a drag that edits every frame only pays a few times a second. */
  private flushFurniture(dt: number): void {
    this.furnitureTimer += dt;
    if (!this.furnitureStale || this.furnitureTimer < FURNITURE_INTERVAL) return;
    this.furnitureTimer = 0;
    this.furnitureStale = false;
    this.furniture.rebuildSigns();
    this.furniture.rebuildLamps();
  }

  private updateFollow(): void {
    const id = this.followId;
    if (id === null || !this.sim) {
      this.cam.followPoint = null;
      return;
    }
    const v = this.sim.vehicles;
    let slot = this.followSlot;
    if (slot >= v.count || v.id[slot] !== id) {
      slot = -1;
      for (let i = 0; i < v.count; i++) {
        if (v.id[i] === id) {
          slot = i;
          break;
        }
      }
      if (slot < 0) {
        this.follow(null);
        return;
      }
      this.followSlot = slot;
    }
    const a = this.sim.renderAlpha;
    this.followPoint.set(v.prevX[slot] + (v.x[slot] - v.prevX[slot]) * a, v.prevY[slot] + (v.y[slot] - v.prevY[slot]) * a, v.prevZ[slot] + (v.z[slot] - v.prevZ[slot]) * a);
    this.cam.followPoint = this.followPoint;
  }

  frame(realDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(0.1, Math.max(0, realDt));
    if (dt > 0) this.fps += (1 / Math.max(realDt, 1e-3) - this.fps) * Math.min(1, dt * 3);
    if (this.contextLost) return;
    this.time += dt;
    this.shared.uTime.value = this.time;

    this.applyNetworkChanges();
    this.flushFurniture(dt);
    this.updateFollow();
    this.cam.update(dt);
    const camera = this.cam.camera;
    const dist = this.cam.distance;
    this.shared.uPxScale.value = this.gl.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.rig.update(camera, this.cam.target, dist);
    this.rig.updateFog(dist);
    this.context.envMap = this.rig.updateEnvironment(dt);
    if (this.lightKey !== this.rig.getTimeOfDay()) {
      this.lightKey = this.rig.getTimeOfDay();
      const night = this.shared.uNight.value;
      this.terrain.setLighting(this.rig.haze, this.rig.skyTop, this.rig.sun.color, this.rig.sun.intensity, this.rig.lightDir, night);
      this.furniture.updateNight();
      // Day haze is thin. Dusk air glows, and at night lamps should bloom.
      this.post.bloomStrength = 0.1 + 0.55 * night;
      this.post.setAtmosphere(this.rig.haze, this.rig.sunVector, this.rig.sun.color, 0.00007 + 0.00005 * (1 - night));
    }
    this.shared.uCloud.value.x = this.time * 7;
    this.shared.uCloud.value.y = this.time * 3;
    this.vehicles.update(this.sim, camera, dist);
    for (const layer of this.context.layers) layer.update?.(dt, this.context);
    this.furniture.updateSignals(this.sim);
    this.overlay.update(dt, this.sim);
    this.trees.update(dt, camera.position.x, camera.position.y, camera.position.z);
    this.laneDebug.refresh();
    this.tools.updateLabels((p) => this.project(p), this.canvas.getBoundingClientRect());

    this.gl.info.reset();
    this.post.render(this.rig.scene, camera, this.rig.overlayScene);
    const info = this.gl.info.render;
    this.lastStats = { fps: this.fps, drawCalls: info.calls, triangles: info.triangles };

    const down = this.governor.sample(realDt, this.context.quality.name);
    if (down) {
      console.info(`Cloverleaf: frame time is long, dropping quality to ${down}.`);
      this.applyQuality(down);
    }
  }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.gl.setSize(width, height);
    const cam = this.cam.camera;
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
    const size = this.gl.getDrawingBufferSize(new THREE.Vector2());
    this.post.resize(size.x, size.y);
  }

  private applyQuality(level: QualityName): void {
    const q = QUALITY[level];
    this.context.quality = q;
    this.gl.setPixelRatio(this.pixelRatio());
    const size = this.gl.getDrawingBufferSize(new THREE.Vector2());
    this.post.resize(size.x, size.y);
    this.post.setQuality(q);
    this.rig.setMaterialFog(!q.post);
    this.rig.setShadowSize(q.shadowSize);
    this.shared.uCloud.value.z = q.cloudShadows ? 0.42 : 0;
    this.trees.setQuality(q);
    this.grass.setQuality(q);
    this.vehicles?.setQuality(q);
    for (const layer of this.context.layers) layer.setQuality?.(q, this.context);
    this.governor.reset();
  }

  /** Pick a level. This turns off the automatic step-down. */
  setQuality(level: QualityName): void {
    this.governor.enabled = false;
    this.applyQuality(level);
  }

  getQuality(): QualityName {
    return this.context.quality.name;
  }

  /** Let the renderer lower quality by itself when frames run long. On by default. */
  setAutoQuality(on: boolean): void {
    this.governor.enabled = on;
    this.governor.reset();
  }

  /** Render at a fraction of full resolution, 0.5 to 1. For weak GPUs. */
  setResolutionScale(scale: number): void {
    this.resolutionScale = Math.min(1, Math.max(0.5, scale));
    this.gl.setPixelRatio(this.pixelRatio());
    const size = this.gl.getDrawingBufferSize(new THREE.Vector2());
    this.post.resize(size.x, size.y);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.cam.dispose();
    this.roads.dispose();
    this.decals.dispose();
    this.nodeMarkings.dispose();
    this.vehicles.dispose();
    this.furniture.dispose();
    this.endpoints.dispose();
    this.tools.dispose();
    this.laneDebug.dispose();
    for (const layer of this.context.layers) layer.dispose?.();
    this.grass.dispose();
    this.trees.dispose();
    this.terrain.dispose();
    this.post.dispose();
    this.rig.dispose();
    this.glow.dispose();
    this.shared.dispose();
    this.gl.dispose();
    this.canvas.remove();
  }

  // -------------------------------------------------------------------------
  // Picking
  // -------------------------------------------------------------------------

  pickPlane(clientX: number, clientY: number, planeY: number): Vec3 | null {
    const hit = this.cam.rayToPlane(clientX, clientY, planeY);
    return hit ? { x: hit.x, y: planeY, z: hit.z } : null;
  }

  pickRay(clientX: number, clientY: number): { origin: Vec3; dir: Vec3 } | null {
    const ray = this.cam.ray(clientX, clientY);
    const o = ray.origin;
    const d = ray.direction;
    return { origin: { x: o.x, y: o.y, z: o.z }, dir: { x: d.x, y: d.y, z: d.z } };
  }

  getUnderground(): boolean {
    return this.underground;
  }

  pickVehicle(clientX: number, clientY: number): number | null {
    if (!this.sim) return null;
    return this.vehicles.pick(this.sim.vehicles, this.cam.ray(clientX, clientY), this.sim.renderAlpha);
  }

  project(pos: Vec3): { x: number; y: number } | null {
    const camera = this.cam.camera;
    const v = this.projected.set(pos.x, pos.y, pos.z).applyMatrix4(camera.matrixWorldInverse);
    if (v.z >= -camera.near) return null;
    v.applyMatrix4(camera.projectionMatrix);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  // -------------------------------------------------------------------------
  // Tool feedback
  // -------------------------------------------------------------------------

  setPreview(previews: RoadPreview[]): void {
    this.tools.setPreview(previews);
  }

  setMarks(marks: ToolMark[]): void {
    this.tools.setMarks(marks);
  }

  setHighlight(set: HighlightSet | null): void {
    this.overlay.setHighlight(set);
  }

  setOverlay(mode: OverlayMode): void {
    this.overlay.setMode(mode);
    this.roads.setLaneArrows(mode === 'lanes');
  }

  /** The active overlay. */
  getOverlay(): OverlayMode {
    return this.overlay.mode;
  }

  setUnderground(on: boolean): void {
    if (on === this.underground) return;
    this.underground = on;
    this.terrain.setUnderground(on);
    this.rig.setUnderground(on);
    this.grass.group.visible = !on;
    for (const layer of this.context.layers) layer.setUnderground?.(on, this.context);
    this.roads.setUnderground(on);
    this.trees.group.visible = !on;
  }

  setTimeOfDay(hours: number): void {
    this.rig.setTimeOfDay(hours);
  }

  getTimeOfDay(): number {
    return this.rig.getTimeOfDay();
  }

  setShadows(on: boolean): void {
    this.rig.setShadows(on);
  }

  /** The optional drawing grid around a point. Null hides it. */
  setGrid(grid: GridView | null): void {
    this.grid.set(grid);
  }

  setLaneDebug(on: boolean): void {
    this.laneDebug.setEnabled(on);
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  getCamera(): CameraPose {
    return this.cam.getPose();
  }

  setCamera(pose: Partial<CameraPose>, animate?: boolean): void {
    this.cam.setPose(pose, animate);
  }

  follow(vehicleId: number | null): void {
    this.followId = vehicleId;
    this.followSlot = 0;
    if (vehicleId === null) this.cam.followPoint = null;
  }

  /** The vehicle the camera follows, or null. */
  getFollow(): number | null {
    return this.followId;
  }

  setCameraKeysEnabled(on: boolean): void {
    this.cam.setKeysEnabled(on);
  }

  /** True while, and just after, a right or middle press became an orbit drag. */
  isCameraDragging(): boolean {
    return this.cam.isDragging;
  }

  /** Called when the right button is pressed and released in about the same spot. */
  onRightClick(fn: (clientX: number, clientY: number, event: PointerEvent) => void): () => void {
    return this.cam.onRightClick(fn);
  }

  /** Told when the WebGL context is lost (true) and restored (false). */
  onContextChange(fn: (lost: boolean) => void): () => void {
    this.contextListeners.add(fn);
    return () => this.contextListeners.delete(fn);
  }

  stats(): RendererStats {
    return this.lastStats;
  }

  /** Instanced tree count, for debugging. */
  treeCount(): number {
    return this.trees.total;
  }
}
