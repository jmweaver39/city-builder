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
 * Four cells side by side: broad leaf clusters, needle sprays, dark bark, pale
 * birch bark. Foliage is drawn pale so instance colour sets the species.
 */
export function makeLeafAtlas(anisotropy: number): THREE.Texture {
  const S = 256;
  const [c, g] = canvas(S * 4, S);
  g.clearRect(0, 0, S * 4, S);
  const r = rnd(4411);
  // Broad leaves: overlapping almond shapes, dense in the middle of the card.
  g.save();
  g.beginPath();
  g.rect(0, 0, S, S);
  g.clip();
  for (let i = 0; i < 520; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.pow(r(), 0.6) * S * 0.47;
    const x = S / 2 + Math.cos(a) * d;
    const y = S / 2 + Math.sin(a) * d;
    const l = 9 + r() * 11;
    const tone = 130 + r() * 110;
    g.save();
    g.translate(x, y);
    g.rotate(r() * Math.PI * 2);
    g.fillStyle = `rgb(${tone * 0.92},${tone},${tone * 0.8})`;
    g.beginPath();
    g.moveTo(-l, 0);
    g.quadraticCurveTo(0, l * 0.62, l, 0);
    g.quadraticCurveTo(0, -l * 0.62, -l, 0);
    g.fill();
    g.restore();
  }
  g.restore();
  // Needle spray: a stem with fine needles angled forward, fading to the tip.
  g.save();
  g.translate(S, 0);
  g.beginPath();
  g.rect(0, 0, S, S);
  g.clip();
  g.fillStyle = 'rgb(205,215,190)';
  g.fillRect(S / 2 - 34, 0, 68, S);
  for (let b = 0; b < 9; b++) {
    const y0 = (b + 0.5) * (S / 9);
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 46; i++) {
        const t = i / 46;
        const y = y0 + t * 30;
        const x = S / 2 + side * (20 + t * 100 * (1 - b * 0.02));
        const tone = 140 + r() * 100;
        g.strokeStyle = `rgb(${tone * 0.86},${tone},${tone * 0.84})`;
        g.lineWidth = 2.4;
        g.beginPath();
        g.moveTo(S / 2 + side * 8, y - 18);
        g.lineTo(x, y + r() * 12 - 6);
        g.stroke();
      }
    }
  }
  g.restore();
  const bark = (ox: number, base: number[], lines: string, stripes: boolean) => {
    g.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
    g.fillRect(ox, 0, S, S);
    for (let i = 0; i < 620; i++) {
      const x = ox + r() * S;
      const y = r() * S;
      g.strokeStyle = lines;
      g.globalAlpha = 0.25 + r() * 0.45;
      g.lineWidth = stripes ? 1.2 + r() * 2 : 1 + r() * 3;
      g.beginPath();
      g.moveTo(x, y);
      if (stripes) g.lineTo(x + 8 + r() * 26, y + r() * 2);
      else g.lineTo(x + r() * 5 - 2.5, y + 14 + r() * 28);
      g.stroke();
    }
    g.globalAlpha = 1;
  };
  bark(S * 2, [88, 70, 54], 'rgb(40,30,24)', false);
  bark(S * 3, [206, 204, 192], 'rgb(52,48,44)', true);
  return cutout(c, g, anisotropy);
}

export const BILLBOARD_COUNT = 7;

/** Far-distance trees, painted as lit clumps. Pale, so instance colour tints them. */
export function makeBillboardAtlas(anisotropy: number): THREE.Texture {
  const S = 128;
  const [c, g] = canvas(S * BILLBOARD_COUNT, S * 2);
  g.clearRect(0, 0, S * BILLBOARD_COUNT, S * 2);
  const W = S;
  const H = S * 2;
  const r = rnd(9127);
  const blob = (ox: number, x: number, y: number, rad: number, tone: number) => {
    const grad = g.createRadialGradient(ox + x - rad * 0.3, y - rad * 0.4, rad * 0.1, ox + x, y, rad);
    grad.addColorStop(0, `rgb(${tone * 1.05},${tone * 1.12},${tone * 0.95})`);
    grad.addColorStop(1, `rgb(${tone * 0.5},${tone * 0.56},${tone * 0.48})`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(ox + x, y, rad, 0, Math.PI * 2);
    g.fill();
  };
  const trunk = (ox: number, top: number, w: number, tone: string) => {
    g.fillStyle = tone;
    g.fillRect(ox + W / 2 - w / 2, top, w, H - top);
  };
  const round = (cell: number, crownTop: number, crownBottom: number, halfW: number, trunkTone: string, n: number, trunkW: number) => {
    const ox = cell * W;
    trunk(ox, crownBottom - 8, trunkW, trunkTone);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const y = crownBottom - (crownBottom - crownTop) * (0.08 + 0.84 * r());
      const span = Math.sin(((y - crownTop) / (crownBottom - crownTop)) * Math.PI);
      const x = W / 2 + (r() * 2 - 1) * halfW * span;
      void t;
      blob(ox, x, y, 7 + r() * 7, 118 + ((crownBottom - y) / (crownBottom - crownTop)) * 110);
    }
  };
  const cone = (cell: number, top: number, bottom: number, halfW: number) => {
    const ox = cell * W;
    trunk(ox, bottom - 10, 4, '#3c2e24');
    for (let i = 0; i < 90; i++) {
      const t = r();
      const y = top + (bottom - top) * t;
      const x = W / 2 + (r() * 2 - 1) * halfW * t;
      blob(ox, x, y, 3 + 4 * t + r() * 2, 110 + (1 - t) * 90 + r() * 30);
    }
  };
  round(0, 10, 150, 54, '#46362a', 70, 7);
  round(1, 8, 165, 40, '#46362a', 66, 6);
  round(2, 6, 170, 26, '#cfccbf', 54, 4);
  round(3, 2, 195, 16, '#46362a', 58, 5);
  cone(4, 4, 150, 34);
  cone(5, 2, 225, 42);
  round(6, 40, 250, 56, '#46362a', 80, 0);
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
