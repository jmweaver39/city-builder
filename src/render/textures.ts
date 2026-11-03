/** Procedural textures. Nothing here loads a file. */
import * as THREE from 'three';

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Tiling value noise. period is in lattice cells. */
function tileNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = fade(x - xi);
  const fy = fade(y - yi);
  const w = (v: number) => ((v % period) + period) % period;
  const a = hash(w(xi), w(yi), seed);
  const b = hash(w(xi + 1), w(yi), seed);
  const c = hash(w(xi), w(yi + 1), seed);
  const d = hash(w(xi + 1), w(yi + 1), seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function fbm(u: number, v: number, base: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let total = 0;
  let f = base;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileNoise(u * f, v * f, f, seed + o);
    total += amp;
    amp *= 0.55;
    f *= 2;
  }
  return sum / total;
}

function stretch(v: number): number {
  return Math.min(1, Math.max(0, (v - 0.28) / 0.44));
}

/**
 * Four tiling noise channels in one RGBA texture, stored as data rather than
 * colour. R fine grain, G soft blotches, B broad patches, A slab and speckle.
 */
export function makeNoiseTexture(size = 256, anisotropy = 8): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const i = (x + y * size) * 4;
      data[i] = stretch(fbm(u, v, 32, 3, 11)) * 255;
      data[i + 1] = stretch(fbm(u, v, 8, 4, 23)) * 255;
      data[i + 2] = stretch(fbm(u, v, 3, 4, 37)) * 255;
      data[i + 3] = hash(x, y, 91) * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function finish(c: HTMLCanvasElement, anisotropy: number): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/**
 * High-resolution tiling detail for ground and roads. R: grass speckle (tiny
 * blades and seeds over soft clumps). G: asphalt grain. B: small clumps. A: white
 * noise. Mipmapped with full anisotropy, so it stays sharp from the map view down.
 */
export function makeDetailTexture(size: number, anisotropy: number): THREE.DataTexture {
  const n = size * size;
  const data = new Uint8Array(n * 4);
  const r = new Float32Array(n).fill(0.5);
  const cells = 48;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const i = x + y * size;
      // Soft clumps under the speckle, then grain for asphalt from two hash scales.
      r[i] = 0.42 + 0.16 * tileNoise(u * cells, v * cells, cells, 5);
      const g = 0.6 * hash(x, y, 13) + 0.4 * hash(x >> 1, y >> 1, 17);
      data[i * 4 + 1] = g * 255;
      data[i * 4 + 2] = stretch(fbm(u, v, 16, 3, 29)) * 255;
      data[i * 4 + 3] = hash(x, y, 31) * 255;
    }
  }
  // Speckle: thousands of tiny dots, light seeds and dark blades, wrapped at the edges.
  let seed = 977;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const dots = Math.floor(n * 0.11);
  for (let k = 0; k < dots; k++) {
    const x = Math.floor(rnd() * size);
    const y = Math.floor(rnd() * size);
    const light = rnd() < 0.42;
    const amp = (light ? 1 : -1) * (0.12 + rnd() * 0.22);
    const big = rnd() < 0.3;
    for (let dy = 0; dy <= (big ? 1 : 0); dy++) {
      for (let dx = 0; dx <= (big ? 1 : 0); dx++) {
        const i = ((x + dx) % size) + ((y + dy) % size) * size;
        r[i] += amp * (dx || dy ? 0.6 : 1);
      }
    }
  }
  for (let i = 0; i < n; i++) data[i * 4] = Math.max(0, Math.min(255, r[i] * 255));
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Road sign faces in a 3 by 1 strip: stop, yield, priority. */
export function makeSignAtlas(anisotropy = 4): THREE.CanvasTexture {
  const s = 128;
  const [c, g] = canvas(s * 3, s);
  g.clearRect(0, 0, s * 3, s);
  // Stop: octagon.
  const oct = (r: number) => {
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = ((i + 0.5) / 8) * Math.PI * 2;
      g.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r);
    }
    g.closePath();
  };
  oct(62);
  g.fillStyle = '#f4f2ec';
  g.fill();
  oct(56);
  g.fillStyle = '#c4281c';
  g.fill();
  g.fillStyle = '#f4f2ec';
  g.font = 'bold 40px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('STOP', s / 2, s / 2 + 2);
  // Yield: inverted triangle.
  g.save();
  g.translate(s, 0);
  const tri = (m: number) => {
    g.beginPath();
    g.moveTo(m, m * 0.9);
    g.lineTo(s - m, m * 0.9);
    g.lineTo(s / 2, s - m);
    g.closePath();
  };
  tri(4);
  g.fillStyle = '#c4281c';
  g.fill();
  tri(26);
  g.fillStyle = '#f4f2ec';
  g.fill();
  g.restore();
  // Priority: yellow diamond.
  g.save();
  g.translate(s * 2.5, s / 2);
  g.rotate(Math.PI / 4);
  g.fillStyle = '#f4f2ec';
  g.fillRect(-42, -42, 84, 84);
  g.fillStyle = '#e8b92e';
  g.fillRect(-30, -30, 60, 60);
  g.restore();
  return finish(c, anisotropy);
}

/** Painted road text, white on transparent so vertex colour tints it. */
export function makeTextTexture(text: string, anisotropy = 8): { texture: THREE.CanvasTexture; aspect: number } {
  const label = text.slice(0, 40) || ' ';
  const h = 128;
  const [, pg] = canvas(4, 4);
  const font = 'bold 110px Arial, sans-serif';
  pg.font = font;
  const w = Math.min(2048, Math.ceil(pg.measureText(label).width) + 24);
  const [c, g] = canvas(w, h);
  g.font = font;
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, w / 2, h / 2 + 4);
  return { texture: finish(c, anisotropy), aspect: w / h };
}

/**
 * Cutout texture from a canvas. Transparent pixels take the average colour of the
 * opaque ones, so mipmaps do not pull dark fringes into the edges.
 */
function cutout(c: HTMLCanvasElement, g: CanvasRenderingContext2D, anisotropy: number): THREE.DataTexture {
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let r = 0;
  let gr = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    r += d[i];
    gr += d[i + 1];
    b += d[i + 2];
    n++;
  }
  const k = n ? 1 / n : 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] >= 128) continue;
    d[i] = r * k;
    d[i + 1] = gr * k;
    d[i + 2] = b * k;
  }
  const tex = new THREE.DataTexture(new Uint8Array(d.buffer), c.width, c.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function rnd(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

/**
 * Four 512-pixel cells side by side: broad leaf clusters, needle sprays, dark bark,
 * pale birch bark. Foliage is drawn pale so instance colour sets the species.
 */
export function makeLeafAtlas(anisotropy: number): THREE.Texture {
  const S = 512;
  const [c, g] = canvas(S * 4, S);
  g.clearRect(0, 0, S * 4, S);
  const r = rnd(4411);
  // Broad leaves: hundreds of small leaves on twigs, each shaded across its midrib,
  // packed densest at the centre so the card edge breaks up into single leaves.
  g.save();
  g.beginPath();
  g.rect(0, 0, S, S);
  g.clip();
  g.strokeStyle = 'rgb(92,80,62)';
  g.lineWidth = 3;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + r() * 0.6;
    g.beginPath();
    g.moveTo(S / 2, S / 2);
    g.quadraticCurveTo(S / 2 + Math.cos(a + 0.4) * S * 0.2, S / 2 + Math.sin(a + 0.4) * S * 0.2, S / 2 + Math.cos(a) * S * 0.42, S / 2 + Math.sin(a) * S * 0.42);
    g.stroke();
  }
  // Leaves bunch round a few twig ends, so the card's outline is lumpy, not a disc.
  const tufts: number[][] = [[S / 2, S / 2, S * 0.24]];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + r() * 0.7;
    const d = S * (0.2 + r() * 0.1);
    tufts.push([S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d, S * (0.1 + r() * 0.08)]);
  }
  for (let i = 0; i < 1700; i++) {
    const tf = tufts[Math.floor(r() * tufts.length)];
    const a = r() * Math.PI * 2;
    const d = Math.pow(r(), 0.7) * tf[2];
    const x = tf[0] + Math.cos(a) * d;
    const y = tf[1] + Math.sin(a) * d;
    const l = 13 + r() * 15;
    // Leaves further in and lower sit in shade.
    const tone = (120 + r() * 115) * (1 - (d / tf[2]) * 0.12);
    g.save();
    g.translate(x, y);
    g.rotate(a + (r() - 0.5) * 1.6);
    g.fillStyle = `rgb(${tone * 0.9},${tone},${tone * 0.78})`;
    g.beginPath();
    g.moveTo(-l, 0);
    g.quadraticCurveTo(0, l * 0.58, l, 0);
    g.quadraticCurveTo(0, -l * 0.58, -l, 0);
    g.fill();
    // Light side of the leaf, then the midrib.
    g.fillStyle = `rgba(255,255,235,${0.1 + r() * 0.12})`;
    g.beginPath();
    g.moveTo(-l, 0);
    g.quadraticCurveTo(0, -l * 0.58, l, 0);
    g.closePath();
    g.fill();
    g.strokeStyle = `rgba(40,40,20,0.25)`;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(-l * 0.9, 0);
    g.lineTo(l * 0.9, 0);
    g.stroke();
    g.restore();
  }
  g.restore();
  // Needle spray: a twig with tufts of fine needles angled forward, thinning at the tip.
  g.save();
  g.translate(S, 0);
  g.beginPath();
  g.rect(0, 0, S, S);
  g.clip();
  g.strokeStyle = 'rgb(110,92,70)';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(S / 2, 0);
  g.lineTo(S / 2, S);
  g.stroke();
  for (let b = 0; b < 14; b++) {
    const y0 = (b + 0.3) * (S / 14);
    const reach = (1 - b / 16) * 200;
    for (let side = -1; side <= 1; side += 2) {
      // Side shoot.
      const sx = S / 2 + side * reach;
      const sy = y0 + 70;
      g.strokeStyle = 'rgb(100,86,64)';
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(S / 2, y0);
      g.lineTo(sx, sy);
      g.stroke();
      for (let i = 0; i < 70; i++) {
        const t = r();
        const px = S / 2 + (sx - S / 2) * t;
        const py = y0 + (sy - y0) * t;
        const len = 16 + r() * 18;
        const ang = Math.atan2(sy - y0, sx - S / 2) + (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.6);
        const tone = 130 + r() * 110;
        g.strokeStyle = `rgb(${tone * 0.84},${tone},${tone * 0.82})`;
        g.lineWidth = 1.6 + r() * 1.2;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len);
        g.stroke();
      }
    }
  }
  g.restore();
  const bark = (ox: number, base: number[], lines: string, stripes: boolean) => {
    g.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
    g.fillRect(ox, 0, S, S);
    for (let i = 0; i < 2600; i++) {
      const x = ox + r() * S;
      const y = r() * S;
      g.strokeStyle = r() < 0.2 ? 'rgba(255,250,235,0.5)' : lines;
      g.globalAlpha = 0.2 + r() * 0.45;
      g.lineWidth = stripes ? 1.5 + r() * 3 : 1.5 + r() * 4;
      g.beginPath();
      g.moveTo(x, y);
      if (stripes) g.lineTo(x + 14 + r() * 50, y + r() * 3);
      else g.lineTo(x + r() * 8 - 4, y + 24 + r() * 60);
      g.stroke();
    }
    g.globalAlpha = 1;
  };
  bark(S * 2, [88, 70, 54], 'rgb(40,30,24)', false);
  bark(S * 3, [206, 204, 192], 'rgb(52,48,44)', true);
  return cutout(c, g, anisotropy);
}

export const BILLBOARD_COUNT = 7;

/**
 * Far-distance trees, 256 by 512 a cell, painted as many small leaf clumps.
 * Pale and evenly lit, so instance colour tints them and the shader lights them.
 */
export function makeBillboardAtlas(anisotropy: number): THREE.Texture {
  const K = 2;
  const S = 128 * K;
  const [c, g] = canvas(S * BILLBOARD_COUNT, S * 2);
  g.clearRect(0, 0, S * BILLBOARD_COUNT, S * 2);
  g.scale(K, K);
  const W = 128;
  const H = 256;
  const r = rnd(9127);
  const blob = (ox: number, x: number, y: number, rad: number, tone: number) => {
    const grad = g.createRadialGradient(ox + x - rad * 0.2, y - rad * 0.3, rad * 0.1, ox + x, y, rad);
    grad.addColorStop(0, `rgb(${tone * 1.02},${tone * 1.08},${tone * 0.94})`);
    grad.addColorStop(1, `rgb(${tone * 0.78},${tone * 0.84},${tone * 0.74})`);
    g.fillStyle = grad;
    g.beginPath();
    // Lumpy outline rather than a clean circle.
    for (let k = 0; k <= 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      const rr = rad * (0.8 + r() * 0.35);
      if (k === 0) g.moveTo(ox + x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      else g.lineTo(ox + x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.fill();
  };
  const trunk = (ox: number, top: number, w: number, tone: string) => {
    g.fillStyle = tone;
    g.beginPath();
    g.moveTo(ox + W / 2 - w / 2, H);
    g.lineTo(ox + W / 2 + w / 2, H);
    g.lineTo(ox + W / 2 + w * 0.25, top);
    g.lineTo(ox + W / 2 - w * 0.25, top);
    g.fill();
  };
  const round = (cell: number, crownTop: number, crownBottom: number, halfW: number, trunkTone: string, n: number, trunkW: number) => {
    const ox = cell * W;
    if (trunkW > 0) trunk(ox, crownBottom - 30, trunkW, trunkTone);
    for (let i = 0; i < n; i++) {
      const y = crownBottom - (crownBottom - crownTop) * (0.06 + 0.88 * r());
      const span = Math.sin(((y - crownTop) / (crownBottom - crownTop)) * Math.PI);
      const x = W / 2 + (r() * 2 - 1) * halfW * Math.sqrt(span);
      blob(ox, x, y, 4 + r() * 5, 150 + r() * 70);
    }
  };
  const cone = (cell: number, top: number, bottom: number, halfW: number) => {
    const ox = cell * W;
    trunk(ox, top + 10, 5, '#3c2e24');
    for (let i = 0; i < 220; i++) {
      const t = r();
      const y = top + (bottom - top) * t;
      const x = W / 2 + (r() * 2 - 1) * halfW * t;
      blob(ox, x, y, 2 + 3 * t + r() * 2, 150 + r() * 70);
    }
  };
  round(0, 10, 150, 54, '#46362a', 240, 8);
  round(1, 8, 165, 40, '#46362a', 220, 7);
  round(2, 6, 170, 26, '#cfccbf', 170, 5);
  round(3, 2, 195, 16, '#46362a', 170, 6);
  cone(4, 4, 150, 34);
  cone(5, 2, 225, 42);
  round(6, 40, 250, 56, '#46362a', 260, 0);
  return cutout(c, g, anisotropy);
}

/** Grass tuft: pale blades fanning out from the base. */
export function makeGrassTexture(): THREE.Texture {
  const S = 128;
  const [c, g] = canvas(S, S);
  g.clearRect(0, 0, S, S);
  const r = rnd(551);
  for (let i = 0; i < 60; i++) {
    const x0 = 22 + r() * 84;
    const lean = (r() - 0.5) * 42;
    const h = 40 + r() * 84;
    const tone = 46 + r() * 44;
    g.strokeStyle = `rgb(${tone * 1.02},${tone * 1.36},${tone * 0.5})`;
    g.lineWidth = 2 + r() * 2;
    g.beginPath();
    g.moveTo(x0, S);
    g.quadraticCurveTo(x0 + lean * 0.3, S - h * 0.6, x0 + lean, S - h);
    g.stroke();
  }
  return cutout(c, g, 2);
}

/** Headlight throw on the road: bright by the bumper, fading and widening ahead. Top of the image is far. */
export function makeBeamTexture(): THREE.CanvasTexture {
  const w = 64;
  const h = 128;
  const [c, g] = canvas(w, h);
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const along = 1 - y / (h - 1);
    for (let x = 0; x < w; x++) {
      const across = Math.abs((x + 0.5) / w - 0.5) * 2;
      const spread = 0.34 + 0.66 * along;
      const side = Math.max(0, 1 - across / spread);
      const fall = Math.pow(1 - along, 1.6) * Math.min(1, along * 12);
      const v = Math.round(255 * side * side * (3 - 2 * side) * fall);
      const i = (x + y * w) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = v;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Contact shadow under a vehicle: a soft dark rounded rectangle. */
export function makeBlobTexture(): THREE.CanvasTexture {
  const s = 64;
  const [c, g] = canvas(s, s);
  const img = g.createImageData(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = Math.max(0, Math.abs((x + 0.5) / s - 0.5) * 2 - 0.55) / 0.45;
      const dz = Math.max(0, Math.abs((y + 0.5) / s - 0.5) * 2 - 0.62) / 0.38;
      const d = Math.min(1, Math.hypot(dx, dz));
      const a = (1 - d) * (1 - d) * (3 - 2 * (1 - d)) * 0.62;
      const i = (x + y * s) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

/** Soft radial spot, for lamp pools and halos. */
export function makeGlowTexture(): THREE.CanvasTexture {
  const s = 64;
  const [c, g] = canvas(s, s);
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.14)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Facade materials
// ---------------------------------------------------------------------------

/** Cells of the facade atlas, four across and two down. */
export const FACADE_CELL = { brick: 0, stone: 1, concrete: 2, stucco: 3, siding: 4, roofTile: 5, flatRoof: 6, metal: 7 } as const;
/** Metres of wall each cell covers before it repeats. */
export const FACADE_TILE = [2.4, 4.8, 6, 4, 2.4, 3, 8, 2];

export interface FacadeAtlas {
  /** RGB colour, A how much the building's own colour tints it (1 tinted, 0 as drawn). Linear. */
  color: THREE.DataTexture;
  /** RG tangent-space normal, B roughness, A cavity occlusion. Linear. */
  data: THREE.DataTexture;
}

function atlasTexture(data: Uint8Array, w: number, h: number, anisotropy: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** One tiling fbm field of S by S, period-matched so it wraps. */
function field(S: number, base: number, octaves: number, seed: number, step = 1): Float32Array {
  const f = new Float32Array(S * S);
  // Smooth fields are worked out on a coarser grid and filled in.
  const n = S / step;
  const coarse = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) coarse[x + y * n] = fbm(x / n, y / n, base, octaves, seed);
  for (let y = 0; y < S; y++) {
    const gy = y / step;
    const y0 = Math.floor(gy);
    const ty = gy - y0;
    const r0 = (y0 % n) * n;
    const r1 = ((y0 + 1) % n) * n;
    for (let x = 0; x < S; x++) {
      const gx = x / step;
      const x0 = Math.floor(gx);
      const tx = gx - x0;
      const x1 = (x0 + 1) % n;
      const a = coarse[r0 + (x0 % n)] + (coarse[r0 + x1] - coarse[r0 + (x0 % n)]) * tx;
      const b = coarse[r1 + (x0 % n)] + (coarse[r1 + x1] - coarse[r1 + (x0 % n)]) * tx;
      f[x + y * S] = a + (b - a) * ty;
    }
  }
  return f;
}

/**
 * Brick, stone, precast concrete, render, lap siding, clay roof tiles, roof
 * membrane and corrugated metal, each 512 pixels square: colour, a normal from a
 * height field, roughness and cavity occlusion. Pale and neutral where a
 * building's own colour should show through.
 */
export function makeFacadeAtlas(anisotropy: number, S = 512): FacadeAtlas {
  const W = S * 4;
  const H = S * 2;
  const color = new Uint8Array(W * H * 4);
  const data = new Uint8Array(W * H * 4);
  const fine = field(S, 64, 2, 301, 2);
  const mid = field(S, 16, 3, 302, 4);
  const broad = field(S, 4, 3, 303, 8);
  const at = (f: Float32Array, x: number, y: number) => f[(((x % S) + S) % S) + (((y % S) + S) % S) * S];
  const height = new Float32Array(S * S);
  const rgb = new Float32Array(S * S * 3);
  const mask = new Float32Array(S * S);
  const rough = new Float32Array(S * S);
  const ao = new Float32Array(S * S);
  const smooth = (e0: number, e1: number, v: number) => {
    const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const cells: ((x: number, y: number, i: number) => void)[] = [];
  const set = (i: number, h: number, r: number, g: number, b: number, m: number, ro: number, a: number) => {
    height[i] = h;
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
    mask[i] = m;
    rough[i] = ro;
    ao[i] = a;
  };
  // Brick, stretcher bond: 10 bricks across, 30 courses up, mortar recessed.
  cells[FACADE_CELL.brick] = (x, y, i) => {
    const bh = S / 30;
    const bw = S / 10;
    const row = Math.floor(y / bh);
    const sx = x + (row % 2) * bw * 0.5;
    const col = Math.floor(sx / bw);
    const ex = Math.min(sx - col * bw, (col + 1) * bw - sx);
    const ey = Math.min(y - row * bh, (row + 1) * bh - y);
    const edge = Math.min(ex, ey);
    const brick = smooth(1.1, 2.6, edge);
    const id = hash(((col % 10) + 10) % 10, row, 17);
    const tone = 0.36 + id * 0.16 + (at(mid, x + 31, y) - 0.5) * 0.12 + (hash(x, y, 5) - 0.5) * 0.05;
    const burnt = id > 0.9 ? 0.7 : 1;
    const mortar = 0.52 + (at(fine, x, y) - 0.5) * 0.1;
    set(i, brick * (0.75 + at(fine, x + 7, y + 3) * 0.25), (tone * 1.04 * burnt) * brick + mortar * (1 - brick), tone * burnt * brick + mortar * (1 - brick), (tone * 0.95 * burnt) * brick + mortar * 0.97 * (1 - brick), brick, 0.82 + 0.1 * (1 - brick), 0.62 + 0.38 * brick);
  };
  // Ashlar stone: blocks 1.2 by 0.6 m, offset by half, fine joints.
  cells[FACADE_CELL.stone] = (x, y, i) => {
    const bh = S / 8;
    const bw = S / 4;
    const row = Math.floor(y / bh);
    const sx = x + (row % 2) * bw * 0.5;
    const col = Math.floor(sx / bw);
    const edge = Math.min(sx - col * bw, (col + 1) * bw - sx, y - row * bh, (row + 1) * bh - y);
    const block = smooth(0.8, 3, edge);
    const id = hash(((col % 4) + 4) % 4, row, 29);
    const tone = 0.47 + (id - 0.5) * 0.06 + (at(mid, x, y + 77) - 0.5) * 0.08 + (hash(x, y, 9) - 0.5) * 0.04;
    set(i, block * (0.8 + at(mid, x + 50, y) * 0.2), tone, tone, tone * 0.98, 0.6 + 0.4 * block, 0.78, 0.7 + 0.3 * block);
  };
  // Precast concrete: four 3 m panels, recessed joints, form-tie holes, rain streaks.
  cells[FACADE_CELL.concrete] = (x, y, i) => {
    const p = S / 2;
    const px = x % p;
    const py = y % p;
    const edge = Math.min(px, p - px, py, p - py);
    const joint = smooth(1.5, 3.5, edge);
    const g = p / 3;
    const hole = smooth(2, 3.6, Math.hypot(px - (Math.floor(px / g) + 0.5) * g, py - (Math.floor(py / g) + 0.5) * g));
    const id = hash(Math.floor(x / p), Math.floor(y / p), 41);
    const streak = (at(fine, x, 0) - 0.5) * (0.4 + at(broad, x, y) * 0.6);
    const tone = 0.5 + (id - 0.5) * 0.05 + (at(mid, x + 90, y + 20) - 0.5) * 0.08 - Math.max(0, streak) * 0.12 + (hash(x, y, 13) - 0.5) * 0.06;
    set(i, joint * hole * (0.92 + at(fine, x + 100, y) * 0.08), tone, tone, tone, 1, 0.9, 0.55 + 0.45 * joint * (0.5 + 0.5 * hole));
  };
  // Render: fine, uneven bumps.
  cells[FACADE_CELL.stucco] = (x, y, i) => {
    const n = at(fine, x + 200, y + 13) * 0.6 + hash(x, y, 21) * 0.4;
    const tone = 0.5 + (at(broad, x + 7, y) - 0.5) * 0.06 + (n - 0.5) * 0.04;
    set(i, n * 0.6, tone, tone, tone, 1, 0.94, 0.92 + n * 0.08);
  };
  // Lap siding: twelve boards, each thicker at its lower edge, in shadow under the next.
  cells[FACADE_CELL.siding] = (x, y, i) => {
    const bh = S / 12;
    const t = (y % bh) / bh;
    const grain = at(fine, x >> 2, y * 4) - 0.5;
    const id = hash(0, Math.floor(y / bh), 51);
    const tone = 0.49 + (id - 0.5) * 0.03 + grain * 0.03;
    set(i, (1 - t) * 0.8 + grain * 0.04, tone, tone, tone, 1, 0.66, 1 - 0.35 * smooth(0.82, 1, t));
  };
  // Clay roof tiles. u runs down the slope, v along the ridge: courses of rounded tiles.
  cells[FACADE_CELL.roofTile] = (x, y, i) => {
    const cl = S / 10;
    const tw = S / 12;
    const course = Math.floor(x / cl);
    const u = (x % cl) / cl;
    const sy = y + (course % 2) * tw * 0.5;
    const tile = Math.floor(sy / tw);
    const v = (sy % tw) / tw;
    const round = 0.5 + 0.5 * Math.cos((v - 0.5) * Math.PI * 2);
    const id = hash(course, ((tile % 12) + 12) % 12, 61);
    const tone = 0.43 + (id - 0.5) * 0.14 + (at(mid, x, y + 300) - 0.5) * 0.1 - (at(broad, x, y) > 0.62 ? 0.06 : 0);
    const lip = u * 0.5;
    set(i, round * 0.55 + lip, tone, tone, tone, 1, 0.72, (0.55 + 0.45 * smooth(0, 0.18, u)) * (0.75 + 0.25 * round));
  };
  // Roof membrane in 1 m sheets with welded seams, stains and patches.
  cells[FACADE_CELL.flatRoof] = (x, y, i) => {
    const sw = S / 8;
    const sx = x % sw;
    const seam = Math.max(0, 1 - Math.abs(sx - 2) / 2.2);
    const stain = smooth(0.55, 0.75, at(broad, x + 40, y + 90));
    const tone = 0.5 + (at(mid, x, y) - 0.5) * 0.1 - stain * 0.12 + (hash(x, y, 71) - 0.5) * 0.08 + seam * 0.03;
    set(i, seam * 0.6 + at(fine, x, y) * 0.15, tone, tone, tone, 1, 0.88 - stain * 0.08, 0.92 + 0.08 * (1 - stain));
  };
  // Corrugated sheet: trapezoid ribs, a little streaking.
  cells[FACADE_CELL.metal] = (x, y, i) => {
    const period = S / 14;
    const t = (x % period) / period;
    const rib = smooth(0.1, 0.3, t) * (1 - smooth(0.55, 0.75, t));
    const streak = at(fine, x, 1) * at(broad, x, y);
    const tone = 0.5 + (at(mid, x + 60, y) - 0.5) * 0.06 - streak * 0.08;
    set(i, rib, tone, tone, tone * 0.99, 1, 0.42 + streak * 0.25, 0.85 + 0.15 * rib);
  };
  const strength = [5, 3, 4, 2.5, 7, 6, 2, 4];
  for (let c = 0; c < 8; c++) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) cells[c](x, y, x + y * S);
    const ox = (c % 4) * S;
    const oy = Math.floor(c / 4) * S;
    const k = strength[c] / 8;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = x + y * S;
        const hx = height[((x + 1) % S) + y * S] - height[((x + S - 1) % S) + y * S];
        const hy = height[x + ((y + 1) % S) * S] - height[x + ((y + S - 1) % S) * S];
        let nx = -hx * k * 4;
        let ny = -hy * k * 4;
        const l = Math.hypot(nx, ny, 1);
        nx /= l;
        ny /= l;
        const o = (oy + y) * W * 4 + (ox + x) * 4;
        color[o] = Math.min(255, rgb[i * 3] * 255);
        color[o + 1] = Math.min(255, rgb[i * 3 + 1] * 255);
        color[o + 2] = Math.min(255, rgb[i * 3 + 2] * 255);
        color[o + 3] = mask[i] * 255;
        data[o] = (nx * 0.5 + 0.5) * 255;
        data[o + 1] = (ny * 0.5 + 0.5) * 255;
        data[o + 2] = rough[i] * 255;
        data[o + 3] = ao[i] * 255;
      }
    }
  }
  return { color: atlasTexture(color, W, H, anisotropy), data: atlasTexture(data, W, H, anisotropy) };
}
