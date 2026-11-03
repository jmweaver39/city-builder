/**
 * Grass tufts around the camera. A fixed set of instances wraps around a moving
 * square in the vertex shader, so nothing is rebuilt as the camera travels. Roads
 * and water are masked out by the tree layer's footprint grid.
 */
import * as THREE from 'three';
import type { QualitySettings } from './quality';
import { keepNormals, type Shared } from './materials';
import { makeGrassTexture } from './textures';

const RANGE = 100;

export class GrassLayer {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private geo: THREE.BufferGeometry;
  private mat: THREE.MeshStandardMaterial;
  private tex: THREE.Texture;

  constructor(
    shared: Shared,
    mask: THREE.Texture,
    worldHalf: number,
  ) {
    this.tex = makeGrassTexture();
    // Two crossed cards, with normals pointing up so they light like the ground.
    const pos: number[] = [];
    const uv: number[] = [];
    const nor: number[] = [];
    const idx: number[] = [];
    for (let k = 0; k < 2; k++) {
      const a = (k * Math.PI) / 2 + 0.4;
      const cx = Math.cos(a) * 0.5;
      const cz = Math.sin(a) * 0.5;
      const v = pos.length / 3;
      pos.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 1, -cz);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      for (let i = 0; i < 4; i++) nor.push(0, 1, 0);
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    this.geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    this.geo.setIndex(idx);

    this.mat = new THREE.MeshStandardMaterial({ map: this.tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
    this.mat.onBeforeCompile = (s) => {
      s.uniforms.uTime = shared.uTime;
      s.uniforms.uMask = { value: mask };
      s.uniforms.uWorldHalf = { value: worldHalf };
      const wrap = /* glsl */ `
vec3 base = instanceMatrix[3].xyz;
// Wrap into the square around the camera.
vec2 wrapped = base.xz + ${(RANGE * 2).toFixed(1)} * floor((cameraPosition.xz - base.xz) / ${(RANGE * 2).toFixed(1)} + 0.5);
vec2 maskUv = (wrapped + uWorldHalf) / (2.0 * uWorldHalf);
float blocked = textureLod(uMask, maskUv, 0.0).r;
float dist = distance(wrapped, cameraPosition.xz);
float scale = (1.0 - smoothstep(${(RANGE * 0.62).toFixed(1)}, ${(RANGE * 0.97).toFixed(1)}, dist)) * step(blocked, 0.002);
scale *= step(max(abs(wrapped.x), abs(wrapped.y)), 2000.0);
vec3 local = mat3(instanceMatrix) * transformed * scale;
// Sway from the top of the blades.
float gust = sin(uTime * 1.4 + wrapped.x * 0.13 + wrapped.y * 0.09) + 0.5 * sin(uTime * 2.9 + wrapped.x * 0.31);
local.xz += vec2(0.06, 0.04) * gust * transformed.y;
vec3 wPos = vec3(wrapped.x, 0.0, wrapped.y) + local;
`;
      s.vertexShader = s.vertexShader
        .replace('#include <common>', `#include <common>\nuniform float uTime;\nuniform sampler2D uMask;\nuniform float uWorldHalf;\nvarying float vTuftTone;`)
        .replace(
          '#include <project_vertex>',
          `${wrap}\nvTuftTone = fract(base.x * 0.37 + base.z * 0.61);\nvec4 mvPosition = viewMatrix * vec4(wPos, 1.0);\ngl_Position = projectionMatrix * mvPosition;`,
        )
        .replace('#include <worldpos_vertex>', `vec4 worldPosition = vec4(wPos, 1.0);`);
      s.fragmentShader = keepNormals(s.fragmentShader)
        .replace('#include <common>', `#include <common>\nvarying float vTuftTone;`)
        .replace('#include <color_fragment>', `#include <color_fragment>\ndiffuseColor.rgb *= mix(vec3(0.7, 0.78, 0.62), vec3(0.98, 0.94, 0.7), vTuftTone);`);
    };
    this.mat.customProgramCacheKey = () => 'cl-grass';
  }

  setQuality(q: QualitySettings): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
    }
    const n = q.grass;
    if (!n) return;
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, n);
    const d = new THREE.Object3D();
    // Golden-angle hash, evenly spread with no visible rows.
    for (let i = 0; i < n; i++) {
      const u = (i * 0.7548776662) % 1;
      const v = (i * 0.5698402910) % 1;
      d.position.set(u * RANGE * 2, 0, v * RANGE * 2);
      d.rotation.y = i * 2.399963;
      const w = 0.55 + ((i * 0.3819) % 1) * 0.6;
      const h = 0.22 + ((i * 0.2361) % 1) * 0.3;
      d.scale.set(w, h, w);
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    this.mesh = mesh;
    this.group.add(mesh);
  }

  dispose(): void {
    this.mesh?.dispose();
    this.geo.dispose();
    this.mat.dispose();
    this.tex.dispose();
    this.group.clear();
  }
}
