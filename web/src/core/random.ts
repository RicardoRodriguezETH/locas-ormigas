/** Deterministic, seeded stand-in for `Math.random()` (mulberry32) — same call shape (no
 * arguments, returns a float in [0, 1)), so it can be assigned directly to `Math.random` wherever
 * reproducible "looks random" behavior is needed instead of genuine unseeded randomness: fixed
 * test seeds, and `runPheromoneBenchmark`'s per-trial determinism (see its doc comment for why a
 * pheromone-algorithm comparison needs this to be a fair, repeatable measurement rather than
 * whatever one unseeded run happened to roll). */
export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
