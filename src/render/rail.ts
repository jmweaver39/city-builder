/**
 * Everything to do with railways in the scene, as one RenderLayer. The app adds it
 * through the renderer's RenderContext, so the renderer itself knows nothing of rail.
 */
import * as THREE from 'three';
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Vec3 } from '../core/types';
import type { TrainSim } from '../rail/TrainSim';
import type { RenderContext, RenderLayer } from './context';
import { TrackLayer } from './tracks';
import { TrainLayer } from './trains';

export class RailLayer implements RenderLayer {
  readonly group = new THREE.Group();
  private tracks: TrackLayer;
  private trainLayer: TrainLayer;
  trains: TrainSim | null = null;
  /** Train the camera follows, or null. */
  following: number | null = null;
  private followAt = { x: 0, y: 0, z: 0 };
  private lineOverlay = false;

  constructor(
    net: RoadNetwork,
    ctx: RenderContext,
    private readonly cameraDistance: () => number,
    private readonly moveCamera: (target: Vec3) => void,
  ) {
    this.tracks = new TrackLayer(net, ctx.shared);
    this.trainLayer = new TrainLayer(net, ctx.shared);
    this.group.add(this.tracks.group, this.trainLayer.group);
    ctx.scene.add(this.group);
  }

  update(dt: number, ctx: RenderContext): void {
    this.tracks.update(this.trains, dt);
    this.trainLayer.update(this.trains, ctx.camera, this.cameraDistance());
    if (this.following !== null) {
      if (this.trains?.trainCenter(this.following, this.followAt)) this.moveCamera(this.followAt);
      else this.following = null;
    }
  }

  setUnderground(on: boolean): void {
    this.tracks.setUnderground(on);
  }

  get lineOverlayOn(): boolean {
    return this.lineOverlay;
  }

  setLineOverlay(on: boolean): void {
    this.lineOverlay = on;
    this.tracks.setLineOverlay(on);
  }

  /** The train under a ray from the camera. */
  pick(origin: Vec3, dir: Vec3): number | null {
    const ray = new THREE.Ray(new THREE.Vector3(origin.x, origin.y, origin.z), new THREE.Vector3(dir.x, dir.y, dir.z));
    return this.trainLayer.pick(this.trains, ray);
  }

  dispose(): void {
    this.tracks.dispose();
    this.trainLayer.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
