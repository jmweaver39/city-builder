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
  bloom: boolean;
  shadowSize: number;
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
    bloom: false,
    shadowSize: 1536,
    treeNear: 70,
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
    pixelRatio: 1.25,
    post: true,
    msaa: 2,
    ao: 0,
    bloom: true,
    shadowSize: 2048,
    treeNear: 90,
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
    bloom: true,
    shadowSize: 4096,
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
    ao: 1,
    bloom: true,
    shadowSize: 4096,
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

/** Guess a level from the GPU's name. The governor corrects a bad guess. */
export function guessQuality(gl: WebGL2RenderingContext): QualityName {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).toLowerCase();
  if (/swiftshader|llvmpipe|software|basic render/.test(name)) return 'low';
  if (/mali|adreno|powervr|videocore/.test(name)) return 'low';
  if (/apple m\d+ (max|ultra)/.test(name)) return 'ultra';
  if (/rtx [2-9]\d{3}|rx [5-9]\d{3}|geforce 4\d/.test(name)) return 'ultra';
  if (/apple m\d|rtx|gtx|radeon|rx \d/.test(name)) return 'high';
  if (/intel.*(iris|arc|xe)/.test(name)) return 'medium';
  if (/intel/.test(name)) return 'low';
  return 'medium';
}

/** Long enough that a hitch or a tab switch does not trigger a step down. */
const WINDOW_SECONDS = 3;
/** About 42 fps sustained. */
const SLOW_FRAME = 0.024;

export class QualityGovernor {
  enabled = true;
  private sum = 0;
  private frames = 0;

  /** Feed real frame times. Returns the level to drop to, or null. */
  sample(dt: number, current: QualityName): QualityName | null {
    if (!this.enabled || dt <= 0 || dt > 0.25) return null;
    this.sum += dt;
    this.frames++;
    if (this.sum < WINDOW_SECONDS) return null;
    const mean = this.sum / this.frames;
    this.sum = 0;
    this.frames = 0;
    if (mean < SLOW_FRAME) return null;
    const i = QUALITY_ORDER.indexOf(current);
    return i > 0 ? QUALITY_ORDER[i - 1] : null;
  }

  reset(): void {
    this.sum = 0;
    this.frames = 0;
  }
}

export type { THREE };
