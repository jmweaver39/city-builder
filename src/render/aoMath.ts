/**
 * Depth reconstruction for the ambient occlusion pass (post.ts), as TypeScript
 * mirrors of the GLSL so the maths can be tested.
 *
 * The scene's depth buffer is logarithmic: three.js writes
 * d = log2(1 + w) / log2(far + 1), where w is view-space depth. AO runs at a
 * fraction of the screen, so each AO texel takes its depth from one full-resolution
 * texel, and it must rebuild the position from that same texel's centre. Rebuilding
 * from the AO texel's own centre puts the point up to half a full-resolution pixel
 * off the surface; on ground seen at a low angle that is centimetres in depth, which
 * tilted the reconstructed normal row by row and drew horizontal stripes.
 */

/** log2(far + 1): the scale of three.js's logarithmic depth. */
export const logFar = (far: number): number => Math.log2(far + 1);

/** The value three.js's logarithmic depth writes for view depth `z`. */
export const encodeLogDepth = (z: number, far: number): number => Math.log2(1 + z) / logFar(far);

/** View depth back from a logarithmic depth value. Mirrors the GLSL. */
export const decodeLogDepth = (d: number, lf: number): number => Math.pow(2, d * lf) - 1;

/**
 * The full-resolution texel an AO texel reads its depth from, on one axis. Offset by
 * half a texel from the exact ratio so a 2:1 ratio never lands on a texel boundary,
 * where rounding would pick either neighbour. Mirrors `aoSource` in the GLSL.
 */
export function aoSourceTexel(a: number, scale: number, full: number): number {
  return Math.min(Math.max(Math.floor((a + 0.5) * scale - 0.5), 0), full - 1);
}

/** Centre of a full-resolution texel, in UV. */
export const texelCentreUv = (i: number, full: number): number => (i + 0.5) / full;

/** View-space position from a UV and view depth. `tan` is tan(half fov) on x and y. */
export function viewPosition(u: number, v: number, z: number, tanX: number, tanY: number): [number, number, number] {
  return [(u * 2 - 1) * tanX * z, (v * 2 - 1) * tanY * z, -z];
}

/**
 * Which neighbour to take a tangent from on one axis: the side whose next texel
 * continues a plane through the centre. Inverse depth is linear across the screen
 * on a plane, so the side with the smaller extrapolation error is on the same
 * surface. Returns -1 for the near (minus) side, +1 for the plus side.
 */
export function tangentSide(z: number, zMinus1: number, zMinus2: number, zPlus1: number, zPlus2: number): -1 | 1 {
  const iz = 1 / z;
  const errMinus = Math.abs(2 / zMinus1 - 1 / zMinus2 - iz);
  const errPlus = Math.abs(2 / zPlus1 - 1 / zPlus2 - iz);
  return errMinus < errPlus ? -1 : 1;
}

/**
 * viewPosition from a full-resolution texel index, with the UV step folded into one
 * scale and bias per axis: `posScale` = 2 tan / full, `posBias` = tan (1 / full - 1).
 * The GLSL does this, being cheaper per tap than going through UV.
 */
export function aoPosScaleBias(tan: number, full: number): [number, number] {
  return [(2 * tan) / full, tan * (1 / full - 1)];
}

/**
 * Shared GLSL. AO texel indices are floats holding whole numbers. Needs uniforms
 * `uFull` (full resolution size), `uScale` (full size over AO size), and `uPosScale`
 * and `uPosBias` from aoPosScaleBias for x and y.
 */
export const AO_RECON_GLSL = /* glsl */ `
vec2 aoSource(vec2 a) {
  return clamp(floor((a + 0.5) * uScale - 0.5), vec2(0.0), uFull - 1.0);
}
vec3 aoViewPos(vec2 a, float z) {
  return vec3((aoSource(a) * uPosScale + uPosBias) * z, -z);
}
`;
