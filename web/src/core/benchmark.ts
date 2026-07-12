import type { PheromoneAlgorithm } from './config';
import { defaultConfig } from './config';
import { Simulation } from './simulation';

export interface BenchmarkResult {
  algorithm: PheromoneAlgorithm;
  deliveries: number;
  /** `deliveries / frames` — the primary comparison metric. Raw `deliveries` alone isn't
   * comparable across differently-sized runs; this is what actually answers "which algorithm
   * forages faster". */
  deliveriesPerFrame: number;
}

export interface BenchmarkOptions {
  /** Simulated frames per algorithm. */
  frames?: number;
  antCount?: number;
  onProgress?: (algorithm: PheromoneAlgorithm, framesDone: number, framesTotal: number) => void;
}

const ALL_ALGORITHMS: PheromoneAlgorithm[] = ['legacy', 'gradient', 'flow', 'diffusion'];
/** How often the frame loop yields back to the event loop — frequent enough that the tab stays
 * responsive and `onProgress` can drive a live progress readout, infrequent enough that yielding
 * itself isn't a meaningful fraction of the benchmark's own runtime. */
const YIELD_EVERY_FRAMES = 250;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Runs each of the four pheromone algorithms on an identical small headless colony for a fixed
 * simulated window and reports total deliveries — the in-app version of the diagnostic harness
 * used to empirically tune 'diffusion' during development. Each algorithm gets its own
 * throwaway `Simulation` on the same base map; nothing here touches or is visible to whatever
 * simulation is currently on screen. Chunked with periodic yields so a several-second run
 * doesn't freeze the tab. */
export async function runPheromoneBenchmark(options: BenchmarkOptions = {}): Promise<BenchmarkResult[]> {
  const frames = options.frames ?? 20000;
  const antCount = options.antCount ?? 300;
  const results: BenchmarkResult[] = [];

  for (const algorithm of ALL_ALGORITHMS) {
    const cfg = { ...defaultConfig, pheromoneAlgorithm: algorithm };
    const sim = new Simulation(cfg, { randomizeGrid: false });
    sim.init(antCount);

    for (let f = 0; f < frames; f++) {
      sim.update();
      if (f % YIELD_EVERY_FRAMES === 0) {
        options.onProgress?.(algorithm, f, frames);
        await yieldToEventLoop();
      }
    }
    options.onProgress?.(algorithm, frames, frames);
    results.push({ algorithm, deliveries: sim.totalDeliveries, deliveriesPerFrame: sim.totalDeliveries / frames });
  }

  return results;
}
