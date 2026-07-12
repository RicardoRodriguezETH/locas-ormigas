import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AntLayer, createAnt } from '../ant';
import { createEgg } from '../brood';
import { CaveCell, FoodCell } from '../cells';
import { defaultConfig } from '../config';
import { readPheromoneStrength } from '../grid';
import { Simulation } from '../simulation';

const cfg = { ...defaultConfig, mapMinX: -64, mapMinY: -64, mapMaxX: 64, mapMaxY: 64, mapGridSize: 16 };

/** Deterministic, seeded stand-in for `Math.random()` (mulberry32) — for tests that need varied,
 * realistic-looking randomness (not the constant 0.5 stub) without being flaky: real unseeded
 * `Math.random()` makes a test's pass/fail depend on which run it happens to be. */
function seededRandom(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Simulation', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('spawns the requested number of ants, all initially looking for food', () => {
    const sim = new Simulation(cfg, { randomizeGrid: false });
    sim.init(25);
    expect(sim.ants).toHaveLength(25);
    expect(sim.ants.every((a) => a.lookingFor === 'food')).toBe(true);
  });

  it('paints cells through the same API the UI uses', () => {
    const sim = new Simulation(cfg, { randomizeGrid: false });
    sim.setCell('block', { x: 5, y: 5 });
    expect(sim.grid.canPass({ x: 5, y: 5 })).toBe(false);
  });

  it('fills cargo and flips the task when an ant reaches food it was looking for', () => {
    const sim = new Simulation(cfg, { randomizeGrid: false });
    sim.grid.seedCell('food', 0, 0);

    const ant = createAnt(cfg, { x: 8, y: 8 }, { x: 1, y: 0 });
    ant.speed = 0;
    ant.lookingFor = 'food';
    sim.ants = [ant];

    sim.update();

    expect(ant.cargo.count).toBe(ant.cargo.capacity);
    expect(ant.lookingFor).toBe('cave');
    expect(ant.pheromonesWrite).toBe(false);
  });

  it('an ant deposits pheromone about interests it has personally seen, not ones it hasn\'t', () => {
    const localCfg = { ...cfg, antComEveryFrame: true };
    const sim = new Simulation(localCfg, { randomizeGrid: false });

    const scout = createAnt(localCfg, { x: 5, y: 5 }, { x: 1, y: 0 });
    scout.speed = 0;
    scout.lastTimeSeen.food = 50; // has personally seen food; never seen a cave
    sim.ants = [scout];
    sim.frame = 60;
    sim.update();

    const { pheromones } = sim.grid.get(0, 0);
    expect(pheromones.food.strength).toBeGreaterThan(0);
    expect(pheromones.cave.strength).toBe(0);
  });

  it('gradient algorithm steers toward a nearby lead, scoring it by decayed freshness', () => {
    const localCfg = { ...cfg, antComEveryFrame: true };
    const sim = new Simulation(localCfg, { randomizeGrid: false });
    const lead = sim.grid.get(1, 0).pheromones.food;
    lead.strength = 1;
    lead.lastUpdated = 0;
    lead.where = { x: 100, y: 100 }; // to the ant's south-east

    const seeker = createAnt(localCfg, { x: 8, y: 8 }, { x: 0, y: -1 }); // heading straight up (north)
    seeker.speed = 0;
    seeker.lookingFor = 'food';
    sim.ants = [seeker];
    sim.frame = 0;
    sim.update();

    expect(seeker.maxLeadScore).toBeCloseTo(1);
    // the heading rotates toward the lead (blended, not hard-snapped): its x-component swings
    // from 0 toward the eastward lead, and it aligns more with the lead than the old heading did
    expect(seeker.direction.x).toBeGreaterThan(0);
    const towardLead = { x: 92 / Math.hypot(92, 92), y: 92 / Math.hypot(92, 92) };
    const alignment = seeker.direction.x * towardLead.x + seeker.direction.y * towardLead.y;
    const oldAlignment = 0 * towardLead.x + -1 * towardLead.y; // old heading {0,-1}
    expect(alignment).toBeGreaterThan(oldAlignment);
  });

  it('a fresh ant surrounded by empty cells does not steer toward the world origin', () => {
    // regression: maxLeadScore starting at -1 let an untouched cell's score of 0 win the
    // `score > maxLeadScore` gate and snap the heading toward the empty cell's default
    // `where` of {0,0}
    const localCfg = { ...cfg, antComEveryFrame: true };
    const sim = new Simulation(localCfg, { randomizeGrid: false });

    // placed to the upper-right of the origin, heading further away (east); a phantom pull
    // toward {0,0} would flip direction.x negative
    const seeker = createAnt(localCfg, { x: 40, y: 40 }, { x: 1, y: 0 });
    seeker.speed = 0;
    seeker.lookingFor = 'food';
    seeker.restAt = Infinity; // don't let the rest cycle interfere
    sim.ants = [seeker];
    sim.frame = 0;
    sim.update();

    expect(seeker.maxLeadScore).toBe(0);
    expect(seeker.direction.x).toBeGreaterThan(0); // still heading away from origin, not snapped toward it
  });

  it("flow algorithm steers a seeking ant along the deposited flow vector", () => {
    const localCfg = { ...cfg, pheromoneAlgorithm: 'flow' as const, antComEveryFrame: true };
    const sim = new Simulation(localCfg, { randomizeGrid: false });

    // strong eastward 'food' flow across the ant's cell (0,0) and all its neighbors
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const info = sim.grid.get(dx, dy).pheromones.food;
        info.flow = { x: localCfg.pheromoneSaturation, y: 0 };
        info.lastUpdated = 0;
      }
    }

    const seeker = createAnt(localCfg, { x: 8, y: 8 }, { x: 0, y: -1 }); // heading north
    seeker.speed = 0;
    seeker.lookingFor = 'food';
    seeker.restAt = Infinity;
    sim.ants = [seeker];
    sim.frame = 0;
    sim.update();

    expect(seeker.direction.x).toBeGreaterThan(0); // turned to follow the eastward flow
  });

  it('flow algorithm deposits the heading an ant arrived with, not one already steered by this frame\'s read', () => {
    // regression: depositing the post-steer direction creates a same-frame read-then-write
    // feedback loop (an ant reports back a heading it only has because it just read this cell),
    // which measurably wrecked convergence — deposits must reflect independent travel history
    const localCfg = { ...cfg, pheromoneAlgorithm: 'flow' as const, antComEveryFrame: true };
    const sim = new Simulation(localCfg, { randomizeGrid: false });

    // a strong northward 'food' flow already sitting in the ant's cell — reading it would want
    // to steer the ant's heading toward north (0,-1)
    const info = sim.grid.get(0, 0).pheromones.food;
    info.flow = { x: 0, y: -localCfg.pheromoneSaturation };
    info.lastUpdated = 0;

    // the ant arrives heading due east and has personally seen 'cave' (so it deposits on that
    // channel too, using the reversed heading)
    const seeker = createAnt(localCfg, { x: 0, y: 0 }, { x: 1, y: 0 });
    seeker.speed = 0;
    seeker.lookingFor = 'food';
    seeker.lastTimeSeen.cave = 0;
    seeker.restAt = Infinity;
    sim.ants = [seeker];
    sim.frame = 0;
    sim.update();

    // it did steer toward the field (sanity check the read side still works)
    expect(seeker.direction.y).toBeLessThan(0);

    // but the 'cave' deposit (this frame's only fresh write) reflects the ant's *incoming* (due
    // east) heading reversed — not the already-steered (now north-ish) direction
    const caveInfo = sim.grid.get(0, 0).pheromones.cave;
    expect(caveInfo.flow.x).toBeLessThan(0); // reversed east = west, not a reversed north
    expect(caveInfo.flow.y).toBeCloseTo(0, 1);
  });

  it('flow algorithm colony still delivers food, not fewer than an undirected colony would', () => {
    // regression: an earlier version of flow's steering was actively counterproductive (deposit
    // feedback loop + neighborhood-summed signal smearing), delivering far *less* than ants
    // getting home by undirected wander alone would. A tiny colony over a modest window is a
    // cheap floor check that it's at least functional, not a full throughput benchmark.
    vi.restoreAllMocks(); // needs real randomness for exploration, not the fixed 0.5 stub
    const localCfg = { ...defaultConfig, pheromoneAlgorithm: 'flow' as const };
    const sim = new Simulation(localCfg, { randomizeGrid: false });
    sim.init(300);
    const probe = sim as unknown as { deliveriesThisFrame: number };
    let deliveries = 0;
    for (let f = 0; f < 10000; f++) {
      sim.update();
      deliveries += probe.deliveriesThisFrame ?? 0;
    }
    // ~200 is typical on the real map at this scale; a broken/counterproductive steering (the
    // pre-fix state) delivered single digits or fewer over this window
    expect(deliveries).toBeGreaterThan(30);
  }, 30000);

  it('diffusion algorithm steers up the local scent gradient toward the interest an ant is seeking', () => {
    const localCfg = { ...cfg, pheromoneAlgorithm: 'diffusion' as const };
    const sim = new Simulation(localCfg, { randomizeGrid: false });

    // seed a rising-to-the-east scent field directly, isolating steering from `diffuseScent`
    // itself (which is covered separately in grid.test.ts)
    sim.grid.get(1, 0).pheromones.food.scent = 1;
    sim.grid.get(0, 0).pheromones.food.scent = 0.5;
    sim.grid.get(-1, 0).pheromones.food.scent = 0.2;

    const seeker = createAnt(localCfg, { x: 8, y: 8 }, { x: 0, y: 1 }); // heading south
    seeker.speed = 0;
    seeker.lookingFor = 'food';
    seeker.restAt = Infinity;
    sim.ants = [seeker];
    sim.update();

    expect(seeker.direction.x).toBeGreaterThan(0); // pulled east, toward the rising scent
  });

  it('diffusion algorithm: reaching a resource marks it discovered, gating it as a scent source', () => {
    const sim = new Simulation({ ...cfg, pheromoneAlgorithm: 'diffusion' as const }, { randomizeGrid: false });
    sim.grid.seedCell('food', 0, 0);
    sim.grid.seedCell('cave', 4, 0);

    const foodCell = sim.grid.get(0, 0).cell as FoodCell;
    const caveCell = sim.grid.get(4, 0).cell as CaveCell;
    expect(foodCell.discovered).toBe(false);
    expect(caveCell.discovered).toBe(false);

    const scout = createAnt(cfg, { x: 8, y: 8 }, { x: -1, y: 0 });
    scout.speed = 0;
    scout.lookingFor = 'food';
    sim.ants = [scout];
    sim.update(); // steps onto (0,0), picks up food, flips discovered

    expect(foodCell.discovered).toBe(true);
    expect(caveCell.discovered).toBe(false); // not yet visited
  });

  it('diffusion algorithm colony delivers food, not fewer than an undirected colony would', () => {
    // same floor-check rationale as the 'flow' throughput test above: cheap regression guard,
    // not a benchmark. Measured empirically (see config.ts's diffusionDecayPerStep doc comment)
    // to comfortably outperform 'legacy+' on the stress-test map at these tuned defaults.
    vi.restoreAllMocks();
    const localCfg = { ...defaultConfig, pheromoneAlgorithm: 'diffusion' as const };
    const sim = new Simulation(localCfg, { randomizeGrid: false });
    sim.init(300);
    const probe = sim as unknown as { deliveriesThisFrame: number };
    let deliveries = 0;
    for (let f = 0; f < 10000; f++) {
      sim.update();
      deliveries += probe.deliveriesThisFrame ?? 0;
    }
    expect(deliveries).toBeGreaterThan(30);
  }, 30000);

  it("legacy algorithm (true original): steers by hard-snapping straight onto the lead, no blend", () => {
    const localCfg = { ...cfg, antComEveryFrame: true, pheromoneAlgorithm: 'legacy' as const };
    const sim = new Simulation(localCfg, { randomizeGrid: false });

    const scout = createAnt(localCfg, { x: 5, y: 5 }, { x: 1, y: 0 });
    scout.speed = 0;
    scout.lookingFor = 'cave';
    scout.lastTimeSeen.food = 50;
    scout.oldestPositionRemembered = { x: 100, y: 100 };

    const seeker = createAnt(localCfg, { x: 20, y: 5 }, { x: -1, y: 0 }); // heading west, away from the lead
    seeker.speed = 0;
    seeker.lookingFor = 'food';

    sim.ants = [scout, seeker];
    sim.frame = 60;
    sim.update();

    // heading becomes *exactly* the direction to the lead, not just rotated toward it
    const toward = { x: 80 / Math.hypot(80, 95), y: 95 / Math.hypot(80, 95) };
    expect(seeker.direction.x).toBeCloseTo(toward.x, 5);
    expect(seeker.direction.y).toBeCloseTo(toward.y, 5);
  });

  it('legacy algorithm: a persistent high-water mark blocks re-steering toward any weaker lead, even a fresher one', () => {
    const localCfg = { ...cfg, antComEveryFrame: true, pheromoneAlgorithm: 'legacy' as const };
    const sim = new Simulation(localCfg, { randomizeGrid: false });

    const seeker = createAnt(localCfg, { x: 8, y: 8 }, { x: 0, y: 1 });
    seeker.speed = 0;
    seeker.lookingFor = 'food';
    seeker.maxLeadScore = 500; // already locked onto a strong lead from earlier in the run

    const weakerButFresher = sim.grid.get(1, 0).pheromones.food;
    weakerButFresher.time = 100; // a higher (more recent) frame number than 500 is impossible here...
    weakerButFresher.where = { x: 1000, y: 0 };

    sim.ants = [seeker];
    sim.frame = 600;
    sim.update();

    // ...the point is score (raw frame-time), not recency: 100 < 500 never clears the gate
    expect(seeker.maxLeadScore).toBe(500);
    expect(seeker.direction).toEqual({ x: 0, y: 1 }); // heading untouched
  });

  it('legacy algorithm: unlike every other algorithm, never resets the high-water mark on a goal switch', () => {
    const sim = new Simulation({ ...cfg, pheromoneAlgorithm: 'legacy' as const }, { randomizeGrid: false });
    sim.grid.seedCell('food', 0, 0);

    const ant = createAnt(cfg, { x: 8, y: 8 }, { x: 1, y: 0 });
    ant.speed = 0;
    ant.lookingFor = 'food';
    ant.maxLeadScore = 999;
    sim.ants = [ant];
    sim.update(); // steps onto the food, completing the goal switch

    expect(ant.lookingFor).toBe('cave');
    expect(ant.maxLeadScore).toBe(999); // untouched
  });

  it('legacy algorithm: ants never enter the rest/idle cycle, unlike every other algorithm', () => {
    vi.restoreAllMocks();
    const localCfg = { ...defaultConfig, pheromoneAlgorithm: 'legacy' as const };
    const sim = new Simulation(localCfg, { randomizeGrid: false });
    sim.init(20);

    for (let f = 0; f < 100; f++) sim.update();

    expect(sim.ants.some((a) => a.paused)).toBe(false);
  });

  it('legacy algorithm colony still delivers food, not fewer than an undirected colony would', () => {
    // deliberately the weakest of the five (see PheromoneAlgorithm's doc comment) — this is a
    // cheap floor check that the deliberately-unfixed original still forages at all, not a
    // benchmark. ~130-150 is typical on the stress-test map at this scale.
    vi.restoreAllMocks();
    const localCfg = { ...defaultConfig, pheromoneAlgorithm: 'legacy' as const };
    const sim = new Simulation(localCfg, { randomizeGrid: false });
    sim.init(300);
    const probe = sim as unknown as { deliveriesThisFrame: number };
    let deliveries = 0;
    for (let f = 0; f < 10000; f++) {
      sim.update();
      deliveries += probe.deliveriesThisFrame ?? 0;
    }
    expect(deliveries).toBeGreaterThan(30);
  }, 30000);

  it('gradient algorithm favors a freshly-refreshed lead over a stale one, even if both were once equally strong', () => {
    const localCfg = { ...cfg, antComEveryFrame: true };
    const sim = new Simulation(localCfg, { randomizeGrid: false });

    const stale = sim.grid.get(1, 0).pheromones.food;
    stale.strength = 1;
    stale.lastUpdated = 0; // hasn't been refreshed in 2000 frames — mostly decayed away
    stale.where = { x: 1000, y: 0 };

    const fresh = sim.grid.get(-1, 0).pheromones.food;
    fresh.strength = 1;
    fresh.lastUpdated = 1999; // refreshed a frame ago — still near full strength
    fresh.where = { x: -1000, y: 0 };

    const seeker = createAnt(localCfg, { x: 8, y: 8 }, { x: 0, y: 1 });
    seeker.speed = 0;
    seeker.lookingFor = 'food';
    seeker.restAt = Infinity; // not testing the rest/activity cycle here
    sim.ants = [seeker];
    sim.frame = 2000;
    sim.update();

    // pulled toward the fresh (west) lead, not the stale (east) one
    expect(seeker.direction.x).toBeLessThan(0);
  });

  it('pheromone concentration decays over time when not refreshed', () => {
    const info = { strength: 1, lastUpdated: 0, time: -1, where: { x: 0, y: 0 }, flow: { x: 0, y: 0 }, scent: 0 };
    const initial = readPheromoneStrength(info, 0, cfg.pheromoneDecayPerFrame);
    const decayedLater = readPheromoneStrength(info, 1000, cfg.pheromoneDecayPerFrame);

    expect(decayedLater).toBeLessThan(initial);
    expect(decayedLater).toBeGreaterThan(0);
  });

  it('legacy+ algorithm: steers toward the freshest known lead by its raw frame-time, with no decay', () => {
    const localCfg = { ...cfg, antComEveryFrame: true, pheromoneAlgorithm: 'legacy+' as const };
    const sim = new Simulation(localCfg, { randomizeGrid: false });

    // a scout deposits a 'food' lead pointing at {100,100} into cell (0,0)
    const scout = createAnt(localCfg, { x: 5, y: 5 }, { x: 1, y: 0 });
    scout.speed = 0;
    scout.lookingFor = 'cave';
    scout.lastTimeSeen.food = 50;
    scout.oldestPositionRemembered = { x: 100, y: 100 };

    const seeker = createAnt(localCfg, { x: 20, y: 5 }, { x: -1, y: 0 }); // heading west, away from the lead
    seeker.speed = 0;
    seeker.lookingFor = 'food';

    sim.ants = [scout, seeker];
    sim.frame = 60;
    sim.update();

    // it scored the lead by its raw deposit time (no decay), and turned toward it (blended)
    expect(seeker.maxLeadScore).toBe(50);
    const toward = { x: 80 / Math.hypot(80, 95), y: 95 / Math.hypot(80, 95) };
    const alignment = seeker.direction.x * toward.x + seeker.direction.y * toward.y;
    const oldAlignment = -1 * toward.x + 0 * toward.y; // old heading {-1,0}
    expect(alignment).toBeGreaterThan(oldAlignment);
  });

  it('counts a delivery and feeds the colony-level foraging throttle EMAs', () => {
    const sim = new Simulation(cfg, { randomizeGrid: false });
    sim.grid.seedCell('cave', 0, 0);
    const ant = createAnt(cfg, { x: 8, y: 8 }, { x: 0, y: 0 });
    ant.speed = 0;
    ant.lookingFor = 'cave'; // about to complete a delivery this frame
    sim.ants = [ant];

    sim.update();

    expect(sim.deliveryEmaFast).toBeGreaterThan(0);
    expect(sim.deliveryEmaSlow).toBeGreaterThan(0);
  });

  it('foraging throttle stays neutral before a delivery-rate baseline has formed', () => {
    const sim = new Simulation(cfg, { randomizeGrid: false });
    sim.ants = []; // nobody delivering anything
    for (let i = 0; i < 50; i++) sim.update();
    expect(sim.foragingThrottle).toBe(1);
  });

  it('foraging throttle stays within its configured clamp range under sustained delivery pressure', () => {
    const sim = new Simulation(cfg, { randomizeGrid: false });
    sim.grid.seedCell('food', 0, 0);
    sim.grid.seedCell('cave', 4, 0);
    // several ants sat right on the cave tile, always "delivering" every frame once looking for cave
    sim.ants = Array.from({ length: 10 }, () => {
      const ant = createAnt(cfg, { x: 4 * cfg.mapGridSize + 8, y: 8 }, { x: 0, y: 0 });
      ant.speed = 0;
      ant.lookingFor = 'cave';
      return ant;
    });

    for (let i = 0; i < 300; i++) {
      sim.ants.forEach((ant) => (ant.lookingFor = 'cave')); // keep "delivering" every frame
      sim.update();
    }

    expect(sim.foragingThrottle).toBeGreaterThanOrEqual(cfg.antForagingThrottleMin);
    expect(sim.foragingThrottle).toBeLessThanOrEqual(cfg.antForagingThrottleMax);
  });

  it('teleports an ant that steps onto a linked portal', () => {
    const sim = new Simulation(cfg, { randomizeGrid: false });
    sim.setCell('portal', { x: 0, y: 0 });
    sim.setCell('portal', { x: 48, y: 48 });

    const ant = createAnt(cfg, { x: 8, y: 8 }, { x: 0, y: 0 });
    ant.speed = 0;
    sim.ants = [ant];

    sim.update();

    // teleported to the middle of the linked (second) portal's tile
    expect(ant.position.x).toBeCloseTo(48 + cfg.mapGridSize / 2, 0);
    expect(ant.position.y).toBeCloseTo(48 + cfg.mapGridSize / 2, 0);
    expect(ant.teleportedOnFrame).toBe(0);
  });

  it('releases a brood item an ant was carrying if that ant dies of natural causes mid-carry', () => {
    const sim = new Simulation(cfg, { randomizeGrid: false });
    sim.init(1);

    const ant = sim.ants[0];
    ant.layer = 'underground';
    ant.naturalLifespanDays = 1;
    ant.ageDays = 1; // already at its sampled lifespan — dies this frame

    const brood = createEgg({ x: 0, y: 0 });
    brood.beingCarried = true;
    ant.carriedBrood = brood;
    sim.brood = [brood];

    sim.update();

    // otherwise this brood item would stay "beingCarried" forever with no ant actually
    // carrying it, permanently excluded from ever being picked up again
    expect(brood.beingCarried).toBe(false);
  });

  it('an ant that dies of old age mid-delivery is removed, and its in-flight food is credited not lost', () => {
    const sim = new Simulation(cfg, { randomizeGrid: false });
    sim.init(1);

    const ant = sim.ants[0];
    ant.layer = 'underground';
    ant.deliveringUnderground = true;
    ant.cargo.count = 1; // mid-delivery: food already counted at the cave, not yet at the larder
    ant.naturalLifespanDays = 1;
    ant.ageDays = 1; // dies this frame
    sim.queen.nextEggAttemptFrame = Infinity; // isolate the food credit from queen egg spending
    const foodBefore = sim.foodStored;

    sim.update();

    // natural death removes the ant outright (the queen's laying replaces it from the nest)
    expect(sim.ants).not.toContain(ant);
    expect(sim.ants).toHaveLength(0);
    // the delivery it was carrying landed instead of vanishing
    expect(sim.foodStored).toBe(foodBefore + 1);
  });

  it('defers eclosion of a pupa that crosses its eclosion age while still being carried', () => {
    const sim = new Simulation(cfg, { randomizeGrid: false });
    sim.init(1);
    const popBefore = sim.ants.length;

    // a pupa already past its eclosion age, but currently in a nurse's mandibles mid-carry
    const pupa = createEgg({ x: 0, y: 0 });
    pupa.stage = 'pupa';
    pupa.ageDays = cfg.pupaDurationDays + 1;
    pupa.beingCarried = true;
    sim.brood = [pupa];

    sim.update();

    // must not eclose while carried — that would leave the carrier hauling a freed object
    expect(sim.brood).toContain(pupa);
    expect(sim.ants.length).toBe(popBefore);

    // once it's no longer being carried, it ecloses on the next opportunity
    pupa.beingCarried = false;
    sim.update();
    expect(sim.brood).not.toContain(pupa);
    expect(sim.ants.length).toBe(popBefore + 1);
  });

  it('an ant whose duty shift ends walks back to the entrance rather than resurfacing instantly from wherever it is', () => {
    const sim = new Simulation(defaultConfig, { randomizeGrid: false });
    sim.init(1);

    const ant = sim.ants[0];
    // routed through a function call, not a literal assignment, so TS doesn't narrow
    // `ant.layer`'s type down to the literal 'underground' for the rest of this test
    const asLayer = (l: AntLayer): AntLayer => l;
    ant.layer = asLayer('underground');
    ant.position = { ...sim.nurseryChamberPosition }; // far from the entrance
    ant.undergroundDutyUntil = 0; // duty already expired

    sim.update();

    // must not teleport to the surface from wherever it happened to be — it should start
    // walking the route back to the entrance first
    expect(ant.layer).toBe('underground');
    expect(ant.headingToSurface).toBe(true);
    expect(ant.exitPath.length).toBeGreaterThan(0);

    // ...and only actually resurfaces once it's walked there
    let resurfaced = false;
    for (let i = 0; i < 2000 && !resurfaced; i++) {
      sim.update();
      resurfaced = ant.layer === 'surface';
    }
    expect(resurfaced).toBe(true);
    expect(ant.headingToSurface).toBe(false);
    expect(ant.exitPath).toHaveLength(0);
  });

  it('seeds an established colony with in-progress brood and starting food, so growth begins quickly', () => {
    // needs varied randomness for the stage spread, not the constant 0.5 stub — but real
    // unseeded Math.random() made this test's pass/fail depend on which run it happened to be
    // (flaky in CI); a fixed seed keeps the same varied-looking sequence every time.
    vi.spyOn(Math, 'random').mockImplementation(seededRandom(42));
    const sim = new Simulation(defaultConfig, { randomizeGrid: false });
    sim.init(600);

    // brood pipeline is pre-populated across stages rather than starting empty
    expect(sim.brood.length).toBeGreaterThan(0);
    expect(sim.brood.some((b) => b.stage === 'egg')).toBe(true);
    expect(sim.brood.some((b) => b.stage === 'larva')).toBe(true);
    expect(sim.brood.some((b) => b.stage === 'pupa')).toBe(true);
    // seeded brood sits in the nursery, not waiting to be carried there
    expect(sim.brood.every((b) => b.atNursery)).toBe(true);
    expect(sim.foodStored).toBeGreaterThan(0);

    // a new worker ecloses within the first few hundred frames, not ~20k later
    const startPop = sim.ants.length;
    let firstEclosion = -1;
    for (let f = 0; f < 2000 && firstEclosion === -1; f++) {
      sim.update();
      if (sim.ants.length > startPop) firstEclosion = f;
    }
    expect(firstEclosion).toBeGreaterThanOrEqual(0);
    expect(firstEclosion).toBeLessThan(2000);
  });

  it('caps reproduction against the actual starting population, not the config default', () => {
    // start well below config.numAnts (1500); the cap should track the 40 we started with
    const sim = new Simulation(defaultConfig, { randomizeGrid: false });
    sim.init(40);
    const cap = 40 * defaultConfig.populationCapMultiplier;

    for (let i = 0; i < 40000; i++) sim.update();
    expect(sim.ants.length).toBeLessThanOrEqual(Math.ceil(cap));
  });

  it('records a bounded rolling history for the stats overlay, sampled roughly every 30 frames', () => {
    const sim = new Simulation(cfg, { randomizeGrid: false });
    sim.init(5);

    for (let i = 0; i < 95; i++) sim.update(); // spans several 30-frame sample intervals
    expect(sim.history.length).toBeGreaterThanOrEqual(3);
    expect(sim.history[0].population).toBe(5);
    expect(sim.history.every((s, i) => i === 0 || s.frame > sim.history[i - 1].frame)).toBe(true);

    for (let i = 0; i < 30 * 500; i++) sim.update();
    expect(sim.history.length).toBeLessThanOrEqual(400);
  });
});
