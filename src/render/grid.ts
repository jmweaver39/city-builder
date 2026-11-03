/**
 * The optional drawing grid, shown on the ground while the grid is on and a road
 * tool is active.
 *
 * One quad around the cursor in the overlay scene. Lines are found per pixel from
 * world position, so they stay a crisp pixel or two wide at any zoom, and minor
 * lines fade out before they get dense enough to shimmer. Depth testing is off,
 * like the other tool marks, so the grid never z-fights terrain or road surfaces
 * and reads on asphalt too. A dark halo under each light line keeps it legible on
 * bright grass by day; it is dimmed a little at night.
 */
import * as THREE from 'three';
import type { GridView } from './api';
import type { RenderContext, RenderLayer } from './context';

const VERT = /* glsl */ `
varying vec2 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAG = /* glsl */ `
uniform vec2 uOrigin;
uniform vec2 uRot;
uniform float uSpacing;
uniform float uMajor;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uNight;
varying vec2 vWorld;

// Distance to the nearest line of each family, in pixels.
vec2 linePx(vec2 c) {
  vec2 w = max(fwidth(c), vec2(1e-6));
  return abs(fract(c - 0.5) - 0.5) / w;
}

void main() {
  vec2 d = vWorld - uOrigin;
  vec2 l = vec2(dot(d, uRot), dot(d, vec2(-uRot.y, uRot.x)));
  vec2 c = l / uSpacing;
  vec2 cm = c / uMajor;
  vec2 pm = linePx(c);
  vec2 pM = linePx(cm);
  float dMinor = min(pm.x, pm.y);
  float dMajor = min(pM.x, pM.y);
  // Cells smaller than a few pixels would only shimmer.
  float cellPx = 1.0 / max(max(fwidth(c).x, fwidth(c).y), 1e-6);
  float minorOn = smoothstep(6.0, 14.0, cellPx);
  float majorOn = smoothstep(6.0, 14.0, cellPx * uMajor);
  float minorCore = (1.0 - smoothstep(0.35, 1.1, dMinor)) * minorOn;
  float majorCore = (1.0 - smoothstep(0.6, 1.6, dMajor)) * majorOn;
  float core = max(minorCore * 0.42, majorCore * 0.78);
  float halo = max((1.0 - smoothstep(0.8, 2.6, dMinor)) * minorOn * 0.22, (1.0 - smoothstep(1.2, 3.4, dMajor)) * majorOn * 0.32);
  float dist = length(vWorld - uCenter);
  float fade = 1.0 - smoothstep(uRadius * 0.3, uRadius, dist);
  float dim = mix(1.0, 0.8, uNight);
  core *= fade * dim;
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

  constructor(private readonly ctx: RenderContext) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uOrigin: { value: new THREE.Vector2() },
        uRot: { value: new THREE.Vector2(1, 0) },
        uSpacing: { value: 32 },
        uMajor: { value: 4 },
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

  /** Fade radius for a spacing: a dozen or so cells, never tiny or huge. */
  static radiusFor(spacing: number): number {
    return Math.min(700, Math.max(140, spacing * 9));
  }

  set(view: GridView | null): void {
    this.view = view;
    this.mesh.visible = !!view;
    if (!view) return;
    const u = this.material.uniforms;
    u.uOrigin.value.set(view.originX, view.originZ);
    u.uRot.value.set(Math.cos(view.rotation), Math.sin(view.rotation));
    u.uSpacing.value = Math.max(0.5, view.spacing);
    u.uMajor.value = Math.max(1, view.majorEvery);
    u.uCenter.value.set(view.center.x, view.center.z);
    const r = GridLayer.radiusFor(view.spacing);
    u.uRadius.value = r;
    this.mesh.scale.set(r, 1, r);
    this.mesh.position.set(view.center.x, view.elevation + 0.05, view.center.z);
  }

  get current(): GridView | null {
    return this.view;
  }

  update(): void {
    if (this.view) this.material.uniforms.uNight.value = this.ctx.night;
  }

  dispose(): void {
    this.ctx.overlayScene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
