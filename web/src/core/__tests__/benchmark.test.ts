import { describe, expect, it } from 'vitest';
import { runPheromoneBenchmark, TRIAL_SEEDS } from '../benchmark';

const ALL_ALGORITHMS = ['legacy', 'legacy+', 'gradient', 'flow', 'diffusion', 'integration'];
// requested frames don't divide evenly across trials; the actual frame count a result's
// deliveriesPerFrame is measured against is the floored per-trial count times the trial count,
// not the raw requested number — see runPheromoneBenchmark's doc comment.
const REQUESTED_FRAMES = 50;
const ACTUAL_FRAMES = Math.floor(REQUESTED_FRAMES / TRIAL_SEEDS.length) * TRIAL_SEEDS.length;

describe('runPheromoneBenchmark', () => {
  it('runs all six algorithms and reports a delivery count for each', async () => {
    const results = await runPheromoneBenchmark({ frames: REQUESTED_FRAMES, antCount: 20 });

    expect(results.map((r) => r.algorithm)).toEqual(ALL_ALGORITHMS);
    for (const r of results) {
      expect(r.deliveries).toBeGreaterThanOrEqual(0);
      expect(r.deliveriesPerFrame).toBeCloseTo(r.deliveries / ACTUAL_FRAMES);
    }
  });

  it('is deterministic: repeated runs with the same inputs produce identical results', async () => {
    const first = await runPheromoneBenchmark({ frames: REQUESTED_FRAMES, antCount: 20 });
    const second = await runPheromoneBenchmark({ frames: REQUESTED_FRAMES, antCount: 20 });
    expect(second).toEqual(first);
  });

  it('reports progress for each algorithm up to the full frame count', async () => {
    const seen: Array<[string, number, number]> = [];
    await runPheromoneBenchmark({
      frames: REQUESTED_FRAMES,
      antCount: 20,
      onProgress: (algorithm, done, total) => seen.push([algorithm, done, total]),
    });

    const algorithms = new Set(seen.map(([a]) => a));
    expect(algorithms).toEqual(new Set(ALL_ALGORITHMS));
    expect(seen.every(([, done, total]) => done <= total && total === REQUESTED_FRAMES)).toBe(true);
    // last progress call per algorithm reaches the full requested frame count
    for (const algorithm of ALL_ALGORITHMS) {
      const last = [...seen].reverse().find(([a]) => a === algorithm);
      expect(last?.[1]).toBe(REQUESTED_FRAMES);
    }
  });
});
