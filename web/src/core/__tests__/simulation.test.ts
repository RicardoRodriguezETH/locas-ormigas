import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AntLayer, createAnt } from '../ant';
import { createEgg } from '../brood';
import { defaultConfig } from '../config';
import { readPheromoneStrength } from '../grid';
import { Simulation } from '../simulation';

const cfg = { ...defaultConfig, mapMinX: -64, mapMinY: -64, mapMaxX: 64, mapMaxY: 64, mapGridSize: 16 };

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

  it('gradient algorithm snaps toward a nearby lead, scoring it by decayed freshness', () => {
    const localCfg = { ...cfg, antComEveryFrame: true };
    const sim = new Simulation(localCfg, { randomizeGrid: false });
    const lead = sim.grid.get(1, 0).pheromones.food;
    lead.strength = 1;
    lead.lastUpdated = 0;
    lead.where = { x: 100, y: 100 };

    const seeker = createAnt(localCfg, { x: 8, y: 8 }, { x: 0, y: -1 });
    seeker.speed = 0;
    seeker.lookingFor = 'food';
    sim.ants = [seeker];
    sim.frame = 0;
    sim.update();

    expect(seeker.maxLeadScore).toBeCloseTo(1);
    expect(seeker.direction.x).toBeGreaterThan(0);
    expect(seeker.direction.y).toBeGreaterThan(0);
  });

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
    const info = { strength: 1, lastUpdated: 0, time: -1, where: { x: 0, y: 0 }, flow: { x: 0, y: 0 } };
    const initial = readPheromoneStrength(info, 0, cfg.pheromoneDecayPerFrame);
    const decayedLater = readPheromoneStrength(info, 1000, cfg.pheromoneDecayPerFrame);

    expect(decayedLater).toBeLessThan(initial);
    expect(decayedLater).toBeGreaterThan(0);
  });

  it('legacy algorithm: deterministically snaps toward the freshest known lead, with no decay', () => {
    const localCfg = { ...cfg, antComEveryFrame: true, pheromoneAlgorithm: 'legacy' as const };
    const sim = new Simulation(localCfg, { randomizeGrid: false });

    const scout = createAnt(localCfg, { x: 5, y: 5 }, { x: 1, y: 0 });
    scout.speed = 0;
    scout.lookingFor = 'cave';
    scout.lastTimeSeen.food = 50;
    scout.oldestPositionRemembered = { x: 100, y: 100 };

    const seeker = createAnt(localCfg, { x: 20, y: 5 }, { x: -1, y: 0 });
    seeker.speed = 0;
    seeker.lookingFor = 'food';

    sim.ants = [scout, seeker];
    sim.frame = 60;
    sim.update();

    expect(seeker.maxLeadScore).toBe(50);
    expect(seeker.direction.x).toBeGreaterThan(0);
    expect(seeker.direction.y).toBeGreaterThan(0);
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
});
