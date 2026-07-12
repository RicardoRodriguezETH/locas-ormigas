import { describe, expect, it } from 'vitest';
import { runPheromoneBenchmark } from '../benchmark';

const ALL_ALGORITHMS = ['legacy', 'legacy+', 'gradient', 'flow', 'diffusion'];

describe('runPheromoneBenchmark', () => {
  it('runs all five algorithms and reports a delivery count for each', async () => {
    const results = await runPheromoneBenchmark({ frames: 50, antCount: 20 });

    expect(results.map((r) => r.algorithm)).toEqual(ALL_ALGORITHMS);
    for (const r of results) {
      expect(r.deliveries).toBeGreaterThanOrEqual(0);
      expect(r.deliveriesPerFrame).toBeCloseTo(r.deliveries / 50);
    }
  });

  it('reports progress for each algorithm up to the full frame count', async () => {
    const seen: Array<[string, number, number]> = [];
    await runPheromoneBenchmark({
      frames: 50,
      antCount: 20,
      onProgress: (algorithm, done, total) => seen.push([algorithm, done, total]),
    });

    const algorithms = new Set(seen.map(([a]) => a));
    expect(algorithms).toEqual(new Set(ALL_ALGORITHMS));
    expect(seen.every(([, done, total]) => done <= total && total === 50)).toBe(true);
    // last progress call per algorithm reaches the full frame count
    for (const algorithm of ALL_ALGORITHMS) {
      const last = [...seen].reverse().find(([a]) => a === algorithm);
      expect(last?.[1]).toBe(50);
    }
  });
});
