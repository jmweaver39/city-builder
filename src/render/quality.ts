/**
 * Quality levels, the GPU guess that picks a default, and the governor that steps
 * down when frames run long. Everything expensive reads its budget from here.
 */
import type * as THREE from 'three';

export type QualityName = 'low' | 'medium' | 'high' | 'ultra';

export const QUALITY_ORDER: readonly QualityName[] = ['low', 'medium', 'high', 'ultra'];

export interface QualitySettings {
  name: QualityName;
  /** Cap on device pixels per CSS pixel. */
  pixelRatio: number;
  /** False draws straight to the screen with no post pipeline at all. */
  post: boolean;
  /** MSAA samples on the HDR target. */
  msaa: number;
  /** Ambient occlusion resolution as a fraction of the screen, 0 for none. */
  ao: number;
  /** Ambient occlusion taps per pixel. */
  aoSamples: number;
  /** Bloom is allowed. It only runs when it adds something: at dusk and night. */
  bloom: boolean;
  shadowSize: number;
  /**
   * The sun's shadow map is redrawn whenever its view or the scene changes, and at
   * least every this many frames for moving casters such as trains. 1 is every frame.
   */
  shadowEvery: number;
  /** Vehicles cast sun shadows. Without, they keep their soft contact shadow. */
  vehicleShadows: boolean;
  /** Alpha to coverage on leaves, through MSAA. Off is a plain alpha test. */
  treeCoverage: boolean;
  /** Trees inside this are full models, then cards, then billboards. Metres. */
  treeNear: number;
  treeMid: number;
  /** Trees beyond this are not drawn. Metres. */
  treeFar: number;
  /** Fraction of scattered trees shown. */
  treeDensity: number;
  /** Grass tuft instances near the camera, 0 for none. */
  grass: number;
  /** Vehicles inside this are full models, then simple ones, then boxes. Metres. */
  vehicleNear: number;
  vehicleMid: number;
  /** Bring back guard rail posts, drains and other small geometry. */
  detail: boolean;
  cloudShadows: boolean;
  /** Side and spacing of the fine ground patch under the camera, metres. 0 for none. */
  groundPatch: number;
  groundStep: number;
}

export const QUALITY: Record<QualityName, QualitySettings> = {
  low: {
    name: 'low',
    pixelRatio: 1,
    post: false,
    msaa: 0,
    ao: 0,
    aoSamples: 0,
    bloom: false,
    shadowSize: 1536,
    shadowEvery: 3,
    vehicleShadows: false,
    treeCoverage: false,
    treeNear: 60,
    treeMid: 380,
    treeFar: 1600,
    treeDensity: 0.55,
    grass: 0,
    vehicleNear: 45,
    vehicleMid: 220,
    detail: false,
    cloudShadows: false,
    groundPatch: 0,
    groundStep: 1,
  },
  medium: {
    name: 'medium',
    pixelRatio: 1,
    post: true,
    msaa: 2,
    ao: 0,
    aoSamples: 0,
    bloom: true,
    shadowSize: 2048,
    shadowEvery: 2,
    vehicleShadows: false,
    treeCoverage: true,
    treeNear: 75,
    treeMid: 520,
    treeFar: 2400,
    treeDensity: 0.8,
    grass: 0,
    vehicleNear: 70,
    vehicleMid: 320,
    detail: true,
    cloudShadows: false,
    groundPatch: 0,
    groundStep: 1,
  },
  high: {
    name: 'high',
    pixelRatio: 1.5,
    post: true,
    msaa: 4,
    ao: 0.5,
    aoSamples: 8,
    bloom: true,
    shadowSize: 4096,
    shadowEvery: 1,
    vehicleShadows: true,
    treeCoverage: true,
    treeNear: 140,
    treeMid: 700,
    treeFar: 3200,
    treeDensity: 1,
    grass: 0,
    vehicleNear: 110,
    vehicleMid: 480,
    detail: true,
    cloudShadows: false,
    groundPatch: 320,
    groundStep: 1.25,
  },
  ultra: {
    name: 'ultra',
    pixelRatio: 2,
    post: true,
    msaa: 4,
    ao: 0.5,
    aoSamples: 10,
    bloom: true,
    shadowSize: 4096,
    shadowEvery: 1,
    vehicleShadows: true,
    treeCoverage: true,
    treeNear: 220,
    treeMid: 1100,
    treeFar: 4600,
    treeDensity: 1,
    grass: 0,
    vehicleNear: 170,
    vehicleMid: 700,
    detail: true,
    cloudShadows: false,
    groundPatch: 480,
    groundStep: 1,
  },
};

/**
 * Guess a starting level from the GPU's name. Never Ultra: a name says nothing about
 * the screen size or what else is running, so the governor steps up from High only
 * once frames show clear headroom, and back down quickly when they do not.
 */
export function guessQuality(gl: WebGL2RenderingContext): QualityName {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).toLowerCase();
  if (/swiftshader|llvmpipe|software|basic render/.test(name)) return 'low';
  if (/mali|adreno|powervr|videocore/.test(name)) return 'low';
  if (/apple m\d+ (max|ultra|pro)/.test(name)) return 'high';
  if (/rtx [2-9]\d{3}|rx [5-9]\d{3}|geforce 4\d/.test(name)) return 'high';
  if (/apple m\d|rtx|gtx|radeon|rx \d/.test(name)) return 'medium';
  if (/intel.*(iris|arc|xe)/.test(name)) return 'medium';
  if (/intel/.test(name)) return 'low';
  return 'medium';
}

/** Frames are judged over this long before stepping down: quick, but a single hitch does not count. */
const DOWN_WINDOW = 1.5;
/** About 45 fps sustained. */
const SLOW_FRAME = 0.022;
/** Headroom must hold this long before stepping up. */
const UP_WINDOW = 6;
/** Step up only while the GPU is busy for less than this share of a 60 Hz frame... */
const UP_GPU_SHARE = 0.3;
/** ...and frames keep up with the display. */
const UP_FRAME = 0.0185;
/** No step up for this long after any change, so a new level is judged on its own frames. */
const SETTLE = 4;

export class QualityGovernor {
  enabled = true;
  /** Highest level it may step up to. Lowered for good when a level proves too slow. */
  ceiling: QualityName = 'ultra';
  private sum = 0;
  private frames = 0;
  private upSum = 0;
  private upFrames = 0;
  private upGpu: number[] = [];
  private settle = SETTLE;
  /** GPU milliseconds over the down window, when the browser can time the GPU. */
  private gpuSum = 0;
  private gpuFrames = 0;

  /**
   * Feed real frame times, and the frame's GPU milliseconds when known (null when the
   * GPU cannot be timed: then it only ever steps down). Returns a level to switch to, or null.
   */
  sample(dt: number, current: QualityName, gpuMs: number | null = null): QualityName | null {
    if (!this.enabled || dt <= 0 || dt > 0.25) return null;
    const i = QUALITY_ORDER.indexOf(current);
    this.settle -= dt;
    this.sum += dt;
    this.frames++;
    if (gpuMs !== null) {
      this.gpuSum += gpuMs;
      this.gpuFrames++;
    }
    if (this.sum >= DOWN_WINDOW) {
      const mean = this.sum / this.frames;
      const gpuMean = this.gpuFrames > this.frames * 0.5 ? this.gpuSum / this.gpuFrames : null;
      this.sum = this.frames = this.gpuSum = this.gpuFrames = 0;
      // Slow frames that the GPU is not behind (a busy sim, say) are not helped by a lower level.
      const gpuBound = gpuMean === null || gpuMean > mean * 1000 * 0.55;
      if (mean >= SLOW_FRAME && gpuBound && i > 0) {
        this.ceiling = QUALITY_ORDER[i - 1];
        this.changed();
        return QUALITY_ORDER[i - 1];
      }
    }
    if (gpuMs === null || i >= QUALITY_ORDER.indexOf(this.ceiling) || this.settle > 0) {
      this.upSum = this.upFrames = 0;
      this.upGpu.length = 0;
      return null;
    }
    this.upSum += dt;
    this.upFrames++;
    this.upGpu.push(gpuMs);
    if (this.upSum < UP_WINDOW) return null;
    const mean = this.upSum / this.upFrames;
    const sorted = this.upGpu.sort((a, b) => a - b);
    const gpu75 = sorted[Math.floor(sorted.length * 0.75)];
    this.upSum = this.upFrames = 0;
    this.upGpu.length = 0;
    if (mean < UP_FRAME && gpu75 < UP_GPU_SHARE * (1000 / 60)) {
      this.changed();
      return QUALITY_ORDER[i + 1];
    }
    return null;
  }

  private changed(): void {
    this.reset();
    this.settle = SETTLE;
  }

  reset(): void {
    this.sum = this.frames = this.gpuSum = this.gpuFrames = 0;
    this.upSum = this.upFrames = 0;
    this.upGpu.length = 0;
  }
}

export type { THREE };
