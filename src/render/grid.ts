/**
 * The optional drawing grid, shown on the ground while the grid is on and a road
 * tool is active.
 *
 * Adaptive like a CAD grid: finer subdivisions fade in as the camera closes in
 * and coarser levels take over zoomed out (levels from gridLevels.ts). Each level
 * fades by its cell size in screen pixels, so zooming crossfades with no popping
 * and lines are dropped before they get dense enough to shimmer. Lines further
 * apart on screen draw brighter, and major lines stay brightest.
 *
 * One quad around the cursor in the overlay scene. Lines are found per pixel from
 * world position, so they stay a crisp pixel or two wide at any zoom. Depth
 * testing is off, like the other tool marks, so the grid never z-fights terrain
 * or road surfaces and reads on asphalt too. A dark halo under each light line
 * keeps it legible on bright grass by day; it is dimmed a little at night. The
 * fade radius grows with camera distance so the grid still reads map-wide.
 */
import * as THREE from 'three';
import type { GridView } from './api';
import type { RenderContext, RenderLayer } from './context';
import { GRID_FADE_PX, GRID_MAX_LEVELS, gridLevels } from './gridLevels';

const VERT = /* glsl */ `
varying vec2 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAG = /* glsl */ `
#define MAX_LEVELS ${GRID_MAX_LEVELS}
uniform vec2 uOrigin;
uniform vec2 uRot;
uniform float uLevels[MAX_LEVELS];
uniform float uWeights[MAX_LEVELS];
uniform int uCount;
uniform vec2 uFade;
uniform float uPixelRatio;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uNight;
varying vec2 vWorld;

void main() {
  vec2 d = vWorld - uOrigin;
  vec2 l = vec2(dot(d, uRot), dot(d, vec2(-uRot.y, uRot.x)));
  // Metres per drawing-buffer pixel along each grid axis.
  vec2 w = max(fwidth(l), vec2(1e-6));
  // Density is judged on the more squashed axis, in CSS pixels, so lines going
  // edge-on towards the horizon drop out before they alias.
  float mpp = max(w.x, w.y) * uPixelRatio;
  float core = 0.0;
  float halo = 0.0;
  for (int i = 0; i < MAX_LEVELS; i++) {
    if (i >= uCount) break;
    float s = uLevels[i];
    float cellPx = s / mpp;
    float on = smoothstep(uFade.x, uFade.y, cellPx);
    if (on <= 0.0) continue;
    vec2 c = l / s;
    vec2 dpx = abs(fract(c - 0.5) - 0.5) * s / w;
    float dl = min(dpx.x, dpx.y);
    // Lines that are far apart on screen read as the structure, so draw them brighter.
    float wt = uWeights[i] * mix(0.6, 1.0, smoothstep(16.0, 160.0, cellPx)) * on;
    float width = mix(0.9, 1.5, uWeights[i]) * uPixelRatio;
    core = max(core, (1.0 - smoothstep(width * 0.4, width * 1.1, dl)) * wt);
    halo = max(halo, (1.0 - smoothstep(width, width * 2.8, dl)) * wt * 0.4);
  }
  float dist = length(vWorld - uCenter);
  float fade = 1.0 - smoothstep(uRadius * 0.2, uRadius, dist);
  core *= fade * mix(1.0, 0.8, uNight);
  halo *= fade * mix(1.0, 0.5, uNight);
  float a = core + halo * (1.0 - core);
  if (a < 0.003) discard;
  vec3 light = vec3(0.86, 0.95, 1.0);
  vec3 dark = vec3(0.02, 0.06, 0.1);
  vec3 col = (light * core + dark * halo * (1.0 - core)) / a;
  gl_FragColor = vec4(col, a);
}
`;

export class GridLayer implements RenderLayer {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private view: GridView | null = null;
  private readonly eye = new THREE.Vector3();

  constructor(private readonly ctx: RenderContext) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uOrigin: { value: new THREE.Vector2() },
        uRot: { value: new THREE.Vector2(1, 0) },
        uLevels: { value: new Array<number>(GRID_MAX_LEVELS).fill(1) },
        uWeights: { value: new Array<number>(GRID_MAX_LEVELS).fill(0) },
        uCount: { value: 0 },
        uFade: { value: new THREE.Vector2(GRID_FADE_PX[0], GRID_FADE_PX[1]) },
        uPixelRatio: { value: 1 },
        uCenter: { value: new THREE.Vector2() },
        uRadius: { value: 300 },
        uNight: { value: 0 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    // Under the ghosts and tool marks, which are 20 and up.
    this.mesh.renderOrder = 18;
    this.mesh.visible = false;
    ctx.overlayScene.add(this.mesh);
  }

  /** Fade radius for a spacing and camera distance: enough to work in, never the whole map close up. */
  static radiusFor(spacing: number, cameraDistance = 0): number {
    return Math.min(4000, Math.max(120, spacing * 6, cameraDistance * 0.9));
  }

  set(view: GridView | null): void {
    this.view = view;
    this.mesh.visible = !!view;
    if (!view) return;
    const u = this.material.uniforms;
    u.uOrigin.value.set(view.originX, view.originZ);
    u.uRot.value.set(Math.cos(view.rotation), Math.sin(view.rotation));
    const levels = gridLevels(Math.max(0.5, view.spacing), Math.max(2, view.majorEvery));
    const sp = u.uLevels.value as number[];
    const wt = u.uWeights.value as number[];
    for (let i = 0; i < GRID_MAX_LEVELS; i++) {
      sp[i] = levels[i]?.spacing ?? 1;
      wt[i] = levels[i]?.weight ?? 0;
    }
    u.uCount.value = levels.length;
    u.uCenter.value.set(view.center.x, view.center.z);
    this.mesh.position.set(view.center.x, view.elevation + 0.05, view.center.z);
    this.place();
  }

  /** Size the quad and fade radius for the camera distance. */
  private place(): void {
    const view = this.view;
    if (!view) return;
    this.eye.set(view.center.x, view.elevation, view.center.z);
    const r = GridLayer.radiusFor(view.spacing, this.ctx.camera.position.distanceTo(this.eye));
    this.material.uniforms.uRadius.value = r;
    this.mesh.scale.set(r, 1, r);
  }

  get current(): GridView | null {
    return this.view;
  }

  update(): void {
    if (!this.view) return;
    const u = this.material.uniforms;
    u.uNight.value = this.ctx.night;
    u.uPixelRatio.value = this.ctx.gl.getPixelRatio();
    this.place();
  }

  dispose(): void {
    this.ctx.overlayScene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
