import { describe, expect, it } from 'vitest';
import { createAnt } from '../ant';
import { CaveCell, FoodCell } from '../cells';
import { defaultConfig } from '../config';
import { WorldGrid, readTraffic } from '../grid';

const cfg = { ...defaultConfig, mapMinX: -32, mapMinY: -32, mapMaxX: 32, mapMaxY: 32, mapGridSize: 16 };

describe('WorldGrid', () => {
  it('converts world coordinates to grid coordinates', () => {
    const grid = new WorldGrid(cfg, { randomize: false });
    expect(grid.worldToGrid(0, 0)).toEqual([0, 0]);
    expect(grid.worldToGrid(20, -5)).toEqual([1, -1]);
  });

  it('decays a cell\'s recent-traffic count the same way pheromone strength decays', () => {
    const grid = new WorldGrid(cfg, { randomize: false });
    const cell = grid.get(0, 0);
    cell.traffic = 10;
    cell.trafficLastUpdated = 0;
    expect(readTraffic(cell, 0, 0.99)).toBe(10); // unchanged at the moment it was set
    expect(readTraffic(cell, 100, 0.99)).toBeCloseTo(10 * 0.99 ** 100);
  });

  it('starts fully passable when not randomized', () => {
    const grid = new WorldGrid(cfg, { randomize: false });
    expect(grid.canPass({ x: 0, y: 0 })).toBe(true);
    expect(grid.canPass({ x: 100, y: 100 })).toBe(true); // outside bounds but inside the padded grid
  });

  it('reports whether grid coordinates are within the map', () => {
    const grid = new WorldGrid(cfg, { randomize: false });
    expect(grid.isInsideGrid(0, 0)).toBe(true);
    expect(grid.isInsideGrid(grid.minXg, grid.minYg)).toBe(true);
    expect(grid.isInsideGrid(grid.minXg - 1, 0)).toBe(false);
  });

  it('paints a block tile as impassable', () => {
    const grid = new WorldGrid(cfg, { randomize: false });
    grid.setCellAtWorld('block', { x: 5, y: 5 });
    expect(grid.canPass({ x: 5, y: 5 })).toBe(false);
  });

  it('paints and clears food/cave/grass cells', () => {
    const grid = new WorldGrid(cfg, { randomize: false });
    grid.setCellAtWorld('food', { x: 0, y: 0 });
    expect(grid.get(0, 0).cell?.type).toBe('food');

    grid.setCellAtWorld('ground', { x: 0, y: 0 });
    expect(grid.get(0, 0).cell).toBeNull();
  });

  it('links paired portals and removes both ends together', () => {
    const grid = new WorldGrid(cfg, { randomize: false });
    grid.setCellAtWorld('portal', { x: 0, y: 0 });
    grid.setCellAtWorld('portal', { x: 48, y: 48 });

    const [ax, ay] = grid.worldToGrid(0, 0);
    const [bx, by] = grid.worldToGrid(48, 48);
    expect(grid.get(ax, ay).cell?.type).toBe('portal');
    expect(grid.get(bx, by).cell?.type).toBe('portal');

    grid.removeCell(ax, ay);
    expect(grid.get(ax, ay).cell).toBeNull();
    expect(grid.get(bx, by).cell).toBeNull();
  });

  it('bounces direction off the map limits', () => {
    const grid = new WorldGrid(cfg, { randomize: false });
    const direction = { x: -1, y: 0 };
    const collided = grid.anyCollisionWith({ x: cfg.mapMinX - 5, y: 0 }, direction);
    expect(collided).toBe(true);
    expect(direction.x).toBe(1);
  });

  it('bounces direction off a blocked tile', () => {
    const grid = new WorldGrid(cfg, { randomize: false });
    grid.setCellAtWorld('block', { x: 16, y: 0 });
    const direction = { x: 1, y: 0 };
    const collided = grid.anyCollisionWith({ x: 16, y: 0 }, direction);
    expect(collided).toBe(true);
  });

  it('moves an ant forward freely when nothing is in the way', () => {
    const grid = new WorldGrid(cfg, { randomize: false });
    const ant = createAnt(cfg, { x: 0, y: 0 }, { x: 1, y: 0 });
    ant.speed = 1;
    grid.resolveBlockingCollisionAndMove(ant, 0);
    expect(ant.position.x).toBeCloseTo(1);
    expect(ant.position.y).toBeCloseTo(0);
    expect(ant.traveled).toBeCloseTo(1);
  });

  it('keeps an ant out of a blocked tile it walks straight into', () => {
    const grid = new WorldGrid(cfg, { randomize: false });
    grid.setCellAtWorld('block', { x: 16, y: 0 });
    const ant = createAnt(cfg, { x: 15, y: 0 }, { x: 1, y: 0 });
    ant.speed = 1;
    grid.resolveBlockingCollisionAndMove(ant, 0);
    expect(grid.canPass(ant.position)).toBe(true);
  });

  describe('diffuseScent', () => {
    it('does not pin any scent until a food source is actually discovered', () => {
      const grid = new WorldGrid(cfg, { randomize: false });
      grid.setCellAtWorld('food', { x: 0, y: 0 }); // discovered defaults to false
      for (let i = 0; i < 20; i++) grid.diffuseScent(cfg);

      const [xg, yg] = grid.worldToGrid(0, 0);
      expect(grid.get(xg, yg).pheromones.food.scent).toBe(0);
    });

    it('pins a discovered food source and lets scent fall off with distance through open ground', () => {
      const grid = new WorldGrid(cfg, { randomize: false });
      grid.setCellAtWorld('food', { x: 0, y: 0 });
      const [sx, sy] = grid.worldToGrid(0, 0);
      (grid.get(sx, sy).cell as FoodCell).discovered = true;
      for (let i = 0; i < 100; i++) grid.diffuseScent(cfg);

      const near = grid.get(sx + 1, sy).pheromones.food.scent;
      const far = grid.get(sx + 3, sy).pheromones.food.scent;
      expect(grid.get(sx, sy).pheromones.food.scent).toBeCloseTo(cfg.diffusionSourceStrength);
      expect(near).toBeGreaterThan(0);
      expect(far).toBeGreaterThan(0);
      expect(near).toBeGreaterThan(far); // monotonically weaker further from the source
    });

    it('bends around a wall instead of leaking straight through it', () => {
      const grid = new WorldGrid(cfg, { randomize: false });
      grid.setCellAtWorld('food', { x: 0, y: 0 });
      const [sx, sy] = grid.worldToGrid(0, 0);
      (grid.get(sx, sy).cell as FoodCell).discovered = true;

      // wall a straight column directly east of the source, except a passable gap two rows down,
      // so any scent on the far side must have routed around through the gap
      for (let dy = -2; dy <= 2; dy++) {
        if (dy === 2) continue; // the gap
        grid.setCellAtWorld('block', { x: 16, y: dy * 16 });
      }
      for (let i = 0; i < 150; i++) grid.diffuseScent(cfg);

      const behindWallDirect = grid.get(sx + 1, sy).pheromones.food.scent; // due east, blocked
      const throughGap = grid.get(sx + 1, sy + 3).pheromones.food.scent; // east, past the gap
      expect(behindWallDirect).toBe(0); // solid ground holds no scent
      expect(throughGap).toBeGreaterThan(0); // reached by the passable route around the gap
    });

    it('keeps food and cave scent independent — a discovered food source does not pin the cave field', () => {
      const grid = new WorldGrid(cfg, { randomize: false });
      grid.setCellAtWorld('food', { x: 0, y: 0 });
      const [sx, sy] = grid.worldToGrid(0, 0);
      (grid.get(sx, sy).cell as FoodCell).discovered = true;
      for (let i = 0; i < 20; i++) grid.diffuseScent(cfg);

      expect(grid.get(sx, sy).pheromones.cave.scent).toBe(0);
    });

    it('a discovered cave pins the cave field, not the food field', () => {
      const grid = new WorldGrid(cfg, { randomize: false });
      grid.setCellAtWorld('cave', { x: 0, y: 0 });
      const [sx, sy] = grid.worldToGrid(0, 0);
      (grid.get(sx, sy).cell as CaveCell).discovered = true;
      for (let i = 0; i < 20; i++) grid.diffuseScent(cfg);

      expect(grid.get(sx, sy).pheromones.cave.scent).toBeCloseTo(cfg.diffusionSourceStrength);
      expect(grid.get(sx, sy).pheromones.food.scent).toBe(0);
    });
  });
});
