/**
 * Public contract of the renderer, used by tools, ui and app.
 * The render team implements this in Renderer.ts. Add to it freely, but do not
 * rename or change what is here without updating every consumer.
 */
import type { Cubic } from '../core/bezier';
import type { Id, Vec3 } from '../core/types';
import type { QualityName } from './quality';

export type OverlayMode = 'none' | 'traffic' | 'speedLimit' | 'lanes' | 'roadType';

export type DraftState = 'ok' | 'warning' | 'error';

/** Ghost of a road about to be placed. */
export interface RoadPreview {
  curves: Cubic[];
  roadType: string;
  state: DraftState;
}

/** A dot, ring or line drawn over the world while a tool is active. */
export type ToolMark =
  /**
   * Point and ring radii are metres at a normal drawing zoom; the renderer keeps
   * them about that size on screen when zooming (see markScale.ts). Set `px` for
   * an exact radius in screen pixels instead.
   */
  | { kind: 'point'; pos: Vec3; color: string; radius: number; px?: number }
  | { kind: 'ring'; pos: Vec3; color: string; radius: number; px?: number }
  | { kind: 'line'; points: Vec3[]; color: string; width: number; dashed?: boolean }
  /** Text label anchored at a world position. */
  | { kind: 'label'; pos: Vec3; text: string; color?: string };

/** A region about to be zoned, drawn as a tinted area. */
export interface ZoneGhost {
  points: Vec3[];
  color: string;
}

export interface HighlightSet {
  segments?: Id[];
  nodes?: Id[];
  color?: string;
}

/** Stored camera, for save files and the follow view. */
export interface CameraPose {
  target: Vec3;
  distance: number;
  /** Radians about +Y. */
  yaw: number;
  /** Radians above the horizon. */
  pitch: number;
}

export interface RendererStats {
  fps: number;
  drawCalls: number;
  triangles: number;
}

export interface RendererApi {
  readonly canvas: HTMLCanvasElement;
  /** Render one frame. Reads the sim's VehicleView and signal heads. */
  frame(realDt: number): void;
  resize(width: number, height: number): void;
  dispose(): void;

  /** Ray from the camera through a client-space point onto the plane y = planeY. */
  pickPlane(clientX: number, clientY: number, planeY: number): Vec3 | null;
  /** The camera ray through a client-space point, for picking with tools/pick.ts. Unit direction. */
  pickRay?(clientX: number, clientY: number): { origin: Vec3; dir: Vec3 } | null;
  /** True while the underground view is on, so tunnels can be picked. */
  getUnderground?(): boolean;
  /** Vehicle id under the cursor, or null. */
  pickVehicle(clientX: number, clientY: number): number | null;
  /** Project a world point to client coordinates, null when behind the camera. */
  project(pos: Vec3): { x: number; y: number } | null;

  setPreview(previews: RoadPreview[]): void;
  /** Replace all tool marks. Pass [] to clear. */
  setMarks(marks: ToolMark[]): void;
  setHighlight(set: HighlightSet | null): void;
  setOverlay(mode: OverlayMode): void;
  /** See-through terrain with tunnels drawn. */
  setUnderground(on: boolean): void;
  /** Hours 0 to 24. */
  setTimeOfDay(hours: number): void;
  getTimeOfDay(): number;
  setShadows(on: boolean): void;
  /** Show the lane graph lines, for the lane tools and debugging. */
  setLaneDebug(on: boolean): void;
  /** Tint zoned regions on the ground, while a zoning tool is active. */
  setZoneOverlay(on: boolean): void;
  /** Replace the regions being selected. Pass [] to clear. */
  setZoneGhost(ghosts: ZoneGhost[]): void;

  getCamera(): CameraPose;
  setCamera(pose: Partial<CameraPose>, animate?: boolean): void;
  /** Lock the camera onto a vehicle. Null releases it. */
  follow(vehicleId: number | null): void;
  /** Keyboard state is fed in here so the camera ignores keys typed into forms. */
  setCameraKeysEnabled(on: boolean): void;

  stats(): RendererStats;
}

/** Added by the render team. Everything in RendererApi is unchanged. */
export interface RendererExtras {
  /** The active overlay. */
  getOverlay(): OverlayMode;
  /** The vehicle the camera follows, or null. */
  getFollow(): number | null;
  /**
   * True from the moment a right or middle press becomes an orbit drag until the
   * task after its release, so pointerup handlers can tell a drag from a click.
   */
  isCameraDragging(): boolean;
  /** Right button pressed and released in about the same spot. Returns an unsubscribe. */
  onRightClick(fn: (clientX: number, clientY: number, event: PointerEvent) => void): () => void;
  /** Told when the WebGL context is lost (true) and restored (false). Returns an unsubscribe. */
  onContextChange(fn: (lost: boolean) => void): () => void;
  /** Render at a fraction of full resolution, 0.5 to 1. For weak GPUs. */
  setResolutionScale(scale: number): void;
  /** Pick a quality level. Turns off the automatic step-down. */
  setQuality(level: QualityName): void;
  getQuality(): QualityName;
  /** Lower quality automatically when frames run long. On by default. */
  setAutoQuality(on: boolean): void;
  /** Q and E turn the camera only while this is on (off while a tool uses them for elevation). Alt+Q/E always turns. */
  setCameraRotateKeys(on: boolean): void;
  /** Show the drawing grid on the ground around a point. Null hides it. */
  setGrid(grid: GridView | null): void;
}

/** The optional drawing grid as the renderer draws it. */
export interface GridView {
  /** Metres between lines. */
  spacing: number;
  /** Radians. Lines run along (cos r, sin r) in x and z, and across it. */
  rotation: number;
  originX: number;
  originZ: number;
  /** Every this many lines is a major line. */
  majorEvery: number;
  /** Smallest subdivision drawn, metres. Absent: 0.5 m. */
  minSpacing?: number;
  /** Lines fade out with distance from this point, usually the cursor. */
  center: { x: number; z: number };
  /** Height of the plane it lies on, the drawing elevation. */
  elevation: number;
}
