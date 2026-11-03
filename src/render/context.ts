/**
 * What the renderer shares with its layers, and with modules outside this
 * directory that add to the world, such as rail. Use a RenderContext rather than
 * reaching into Renderer.
 *
 * Adding meshes: put them in `scene`. Lit materials must be MeshStandardMaterial
 * or MeshPhysicalMaterial, because ambient light comes from `envMap` (scene
 * environment), which Lambert and Phong ignore. Things that must sit on top of
 * the image, unlit and untouched by tone mapping, go in `overlayScene`.
 *
 * Adding per-frame work: call `addLayer`. It gets `update`, `setQuality` and
 * `dispose` calls at the right moments.
 */
import type * as THREE from 'three';
import type { RoadNetwork } from '../core/RoadNetwork';
import type { SimApi } from '../sim/api';
import type { Shared } from './materials';
import type { QualitySettings } from './quality';

export interface RenderLayer {
  /** Called every frame, before drawing. */
  update?(dt: number, ctx: RenderContext): void;
  /** Called once when added, and whenever the quality level changes. */
  setQuality?(q: QualitySettings, ctx: RenderContext): void;
  /** Underground view toggled. */
  setUnderground?(on: boolean, ctx: RenderContext): void;
  dispose?(): void;
}

export interface PostPipelineApi {
  /** The linear HDR target the scene renders into, or null at low quality. */
  readonly sceneTarget: THREE.WebGLRenderTarget | null;
  /** Add a fullscreen effect, run on the HDR image before tone mapping. */
  addHdrEffect(effect: HdrEffect): () => void;
}

export interface HdrEffect {
  /** Return the material for one fullscreen pass. Reads uniform `tScene`. */
  material: THREE.ShaderMaterial;
  enabled?: boolean;
}

export class RenderContext {
  layers: RenderLayer[] = [];
  /** The sky-derived environment, also set as `scene.environment`. */
  envMap: THREE.Texture | null = null;
  /** Unit vector toward the sun, or the moon at night. */
  lightDir!: THREE.Vector3;
  /** 0 by day, 1 at night. Same value as `shared.uNight`. */
  get night(): number {
    return this.shared.uNight.value;
  }

  constructor(
    readonly gl: THREE.WebGLRenderer,
    readonly scene: THREE.Scene,
    readonly overlayScene: THREE.Scene,
    readonly camera: THREE.PerspectiveCamera,
    readonly net: RoadNetwork,
    readonly sim: SimApi | null,
    readonly shared: Shared,
    public quality: QualitySettings,
    public post: PostPipelineApi,
  ) {}

  /** Register a layer. Returns a function that removes it. */
  addLayer(layer: RenderLayer): () => void {
    this.layers.push(layer);
    layer.setQuality?.(this.quality, this);
    return () => {
      this.layers = this.layers.filter((l) => l !== layer);
    };
  }
}
