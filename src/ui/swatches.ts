/**
 * Marking previews for panels. They are drawn by the game's renderer with the real
 * paint (render/swatch.ts), so a preview looks exactly like the marking on a road.
 * Without a renderer (headless tests) a plain canvas stands in.
 */
import type { RendererApi } from '../render/api';
import type { SwatchSubject } from '../render/swatch';
import { el, hiDpiCanvas } from './dom';

/** An image of the subject, `w` by `h` CSS pixels, or `fallback()` when it cannot be drawn. */
export function swatchElement(renderer: RendererApi | undefined, subject: SwatchSubject, w: number, h: number, fallback?: (c: HTMLCanvasElement) => void): HTMLElement {
  let url: string | null = null;
  try {
    url = renderer?.paintSwatch?.(subject, w, h) ?? null;
  } catch {
    url = null;
  }
  if (url) return el('img', { attrs: { src: url, width: String(w), height: String(h), alt: '', draggable: 'false' }, style: { width: `${w}px`, height: `${h}px`, display: 'block', borderRadius: '4px' } });
  const c = hiDpiCanvas(w, h);
  if (fallback) fallback(c);
  return c;
}
