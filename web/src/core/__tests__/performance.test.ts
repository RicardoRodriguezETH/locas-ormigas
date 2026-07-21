import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import { Simulation } from '../simulation';

/** Guards against silently reintroducing an expensive per-frame scan (e.g. an O(ants × brood)
 * loop with no early exit) as the codebase grows — not a promise about real-world FPS on any
 * particular device (this environment's CPU has no fixed relationship to a user's phone or
 * computer; see the pheromone-benchmark investigation for why cross-environment absolute numbers
 * don't transfer). The budget is deliberately generous — around 10x what a healthy `update()`
 * measures here — so normal environment noise (a slower CI runner, GC pauses) doesn't make this
 * flaky; it's meant to catch a real regression (a change that makes frames meaningfully more
 * expensive), not to certify a specific millisecond figure. */
describe('performance', () => {
  it('sim.update() stays within a generous per-frame budget for a full-size established colony', () => {
    const sim = new Simulation(defaultConfig, { randomizeGrid: false });
    sim.init(1500);
    // warm up past the initial-seeding transient so the measured frames reflect steady-state
    // task distribution (nurses/feeders/deliveries in flight), not a one-time startup cost
    for (let i = 0; i < 300; i++) sim.update();

    const frames = 200;
    const start = performance.now();
    for (let i = 0; i < frames; i++) sim.update();
    const avgFrameMs = (performance.now() - start) / frames;

    expect(avgFrameMs).toBeLessThan(15);
  }, 30000);
});
