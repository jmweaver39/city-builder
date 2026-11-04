/** Generates road textures off the main thread. See roadSurface.ts. */
import { generateRoadTexture, type RoadTexKind } from './roadTextures';

interface Request {
  id: number;
  kind: RoadTexKind;
  size: number;
  seed: number;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const { id, kind, size, seed } = e.data;
  const t0 = performance.now();
  const data = generateRoadTexture(kind, size, seed);
  ctx.postMessage({ id, data, ms: performance.now() - t0 }, [data.buffer]);
};
