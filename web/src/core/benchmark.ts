import type { PheromoneAlgorithm } from './config';
import { defaultConfig } from './config';
import { mulberry32 } from './random';
import { Simulation } from './simulation';

export interface BenchmarkResult {
  algorithm: PheromoneAlgorithm;
  deliveries: number;
  /** `deliveries / frames`, averaged across `TRIAL_SEEDS` — the primary comparison metric. Raw
   * `deliveries` alone isn't comparable across differently-sized runs; this is what actually
   * answers "which algorithm forages faster". */
  deliveriesPerFrame: number;
}

export interface BenchmarkOptions {
  /** Simulated frames per algorithm, summed across all trials (see `TRIAL_SEEDS`) — matches the
   * total amount of simulated time a single unseeded run used to take, just split into several
   * independent seeded samples instead of one long unseeded one. */
  frames?: number;
  antCount?: number;
  onProgress?: (algorithm: PheromoneAlgorithm, framesDone: number, framesTotal: number) => void;
}

const ALL_ALGORITHMS: PheromoneAlgorithm[] = ['legacy', 'legacy+', 'gradient', 'flow', 'diffusion', 'integration'];
/** How often the frame loop yields back to the event loop — frequent enough that the tab stays
 * responsive and `onProgress` can drive a live progress readout, infrequent enough that yielding
 * itself isn't a meaningful fraction of the benchmark's own runtime. */
const YIELD_EVERY_FRAMES = 250;
/** Fixed seeds shared by every algorithm's run — see this module's doc comment for why a single
 * unseeded run wasn't actually a fair or repeatable comparison. Three trials, not one: even with
 * a shared seed, two algorithms' own logic calls `Math.random()` a different number of times per
 * frame, so their random sequences diverge almost immediately regardless — a seed alone can't make
 * the comparison perfectly lockstep. What it *does* buy is reproducibility (the same code always
 * produces the same result) and, combined with averaging across a few independent seeds, protects
 * against any single seed happening to favor one algorithm. */
export const TRIAL_SEEDS = [1, 2, 3];

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Runs each of the six pheromone algorithms on an identical small headless colony for a fixed
 * simulated window and reports average deliveries/frame — the in-app version of the diagnostic
 * harness used to empirically tune 'diffusion' during development. Each algorithm/trial gets its
 * own throwaway `Simulation` on the same base map; nothing here touches or is visible to whatever
 * simulation is currently on screen. Chunked with periodic yields so a several-second run doesn't
 * freeze the tab.
 *
 * Seeded and repeated across `TRIAL_SEEDS`: an earlier version used real, unseeded `Math.random()`
 * for a single long run, which meant clicking "Run benchmark" twice could show a different
 * algorithm "winning" each time — noise, not a real result. `Math.random` is swapped for a seeded
 * generator only for the synchronous duration of each trial's frame chunk, and always restored to
 * the real one before yielding — so the live colony still running on screen during that yield
 * never sees the seeded sequence; only these throwaway benchmark simulations do.
 *
 * Comparing 'legacy' against 'legacy+' in particular measures something different from the
 * other pairs here: not "which pheromone algorithm is better" but "how much did fixing the
 * pheromone mechanic and adding the modern ant-behavior layer (rest/idle, scout/recruited
 * wander) improve on the literal original" — see `PheromoneAlgorithm`'s doc comment. */
export async function runPheromoneBenchmark(options: BenchmarkOptions = {}): Promise<BenchmarkResult[]> {
  const totalFrames = options.frames ?? 50000;
  const framesPerTrial = Math.floor(totalFrames / TRIAL_SEEDS.length);
  const antCount = options.antCount ?? 300;
  const results: BenchmarkResult[] = [];

  for (const algorithm of ALL_ALGORITHMS) {
    let deliveriesSum = 0;
    let framesSum = 0;

    for (const seed of TRIAL_SEEDS) {
      const realRandom = Math.random;
      const rng = mulberry32(seed);

      Math.random = rng;
      const cfg = { ...defaultConfig, pheromoneAlgorithm: algorithm };
      const sim = new Simulation(cfg, { randomizeGrid: false });
      sim.init(antCount);

      for (let f = 0; f < framesPerTrial; f++) {
        sim.update();
        if (f % YIELD_EVERY_FRAMES === 0) {
          Math.random = realRandom; // don't leak the seeded sequence into the live colony's own tick
          options.onProgress?.(algorithm, framesSum + f, totalFrames);
          await yieldToEventLoop();
          Math.random = rng; // resume this trial's deterministic sequence
        }
      }
      Math.random = realRandom;

      deliveriesSum += sim.totalDeliveries;
      framesSum += framesPerTrial;
    }

    options.onProgress?.(algorithm, totalFrames, totalFrames);
    results.push({ algorithm, deliveries: deliveriesSum, deliveriesPerFrame: deliveriesSum / framesSum });
  }

  return results;
}
