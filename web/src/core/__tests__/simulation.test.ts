import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnt } from '../ant';
import { defaultConfig } from '../config';
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

  it('relays a pheromone lead from one ant to a nearby ant seeking the same thing', () => {
    const localCfg = { ...cfg, antComEveryFrame: true };
    const sim = new Simulation(localCfg, { randomizeGrid: false });

    const scout = createAnt(localCfg, { x: 5, y: 5 }, { x: 1, y: 0 });
    scout.speed = 0;
    scout.lookingFor = 'cave'; // not actively seeking food, just passing the word along
    scout.lastTimeSeen.food = 50;
    scout.oldestPositionRemembered = { x: 100, y: 100 };

    const seeker = createAnt(localCfg, { x: 20, y: 5 }, { x: -1, y: 0 });
    seeker.speed = 0;
    seeker.lookingFor = 'food';

    sim.ants = [scout, seeker];
    sim.frame = 60;
    sim.update();

    expect(seeker.maxTimeSeen).toBe(50);
    expect(seeker.direction.x).toBeGreaterThan(0);
    expect(seeker.direction.y).toBeGreaterThan(0);
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
});
