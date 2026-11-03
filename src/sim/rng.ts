/** Seeded generator, so a run is reproducible. Math.random is never used in the sim. */
export class Rng {
  private a: number;

  constructor(seed: number) {
    this.a = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Unit-rate exponential. */
  exp(): number {
    return -Math.log(1 - this.next());
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

/** Stable hash of a vehicle and a lane to [0, 1), for per-vehicle route noise. */
export function hashNoise(seed: number, lane: number): number {
  let t = Math.imul(seed ^ Math.imul(lane + 1, 0x9e3779b1), 0x85ebca6b);
  t ^= t >>> 13;
  t = Math.imul(t, 0xc2b2ae35);
  t ^= t >>> 16;
  return (t >>> 0) / 4294967296;
}
