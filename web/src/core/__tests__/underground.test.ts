import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import { UndergroundGrid } from '../underground';

describe('UndergroundGrid', () => {
  it('starts fully undug', () => {
    const grid = new UndergroundGrid(defaultConfig);
    expect(grid.get(0, 0).dug).toBe(false);
    expect(grid.canPass({ x: 0, y: 0 })).toBe(false);
  });

  it('dig() excavates a single tile', () => {
    const grid = new UndergroundGrid(defaultConfig);
    grid.dig(3, 3);
    expect(grid.get(3, 3).dug).toBe(true);
    expect(grid.get(3, 4).dug).toBe(false);
  });

  it('dig() is a no-op outside the grid bounds', () => {
    const grid = new UndergroundGrid(defaultConfig);
    grid.dig(grid.maxXg + 1000, grid.maxYg + 1000);
    expect(grid.dugCount()).toBe(0);
  });

  it('digChamber() excavates a filled disc', () => {
    const grid = new UndergroundGrid(defaultConfig);
    grid.digChamber(0, 0, 2);
    expect(grid.get(0, 0).dug).toBe(true);
    expect(grid.get(2, 0).dug).toBe(true); // on the radius
    expect(grid.get(3, 0).dug).toBe(false); // outside the radius
  });

  it('seedStarterNest() produces a connected, non-trivial dug network', () => {
    const grid = new UndergroundGrid(defaultConfig);
    grid.seedStarterNest(0, 0);
    expect(grid.get(0, 0).dug).toBe(true); // entrance
    expect(grid.dugCount()).toBeGreaterThan(20); // more than just the entrance chamber alone
  });

  it('worldToGrid/gridToWorldOrigin round-trip like WorldGrid', () => {
    const grid = new UndergroundGrid(defaultConfig);
    const origin = grid.gridToWorldOrigin(5, -3);
    const [xg, yg] = grid.worldToGrid(origin.x + 1, origin.y + 1);
    expect([xg, yg]).toEqual([5, -3]);
  });

  it('canDig() is false for arbitrary dirt — only explicitly-designated cells are diggable', () => {
    const grid = new UndergroundGrid(defaultConfig);
    grid.digChamber(0, 0, 2);
    // (5,0) is adjacent to dug space (a candidate) but has not been designated
    expect(grid.canDig(5, 0)).toBe(false);
    expect(grid.canDig(100, 100)).toBe(false); // not even a candidate
  });

  it('ensureDesignatedFrontier() only designates cells adjacent to already-dug space, up to the pool size', () => {
    const grid = new UndergroundGrid(defaultConfig);
    grid.dig(0, 0);
    grid.ensureDesignatedFrontier(4, 100); // a single dug cell has 8 undug neighbors; pool size caps it at 4

    let designatedCount = 0;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        if (grid.canDig(dx, dy)) {
          designatedCount++;
          // every designated cell must be adjacent (Chebyshev distance 1) to (0,0)
          expect(Math.max(Math.abs(dx), Math.abs(dy))).toBe(1);
        }
      }
    }
    expect(designatedCount).toBe(4);
  });

  it('ensureDesignatedFrontier() stops once the target volume is reached', () => {
    const grid = new UndergroundGrid(defaultConfig);
    grid.dig(0, 0);
    grid.ensureDesignatedFrontier(4, 1); // dugCount is already 1 >= target 1
    let designatedCount = 0;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        if (grid.canDig(dx, dy)) designatedCount++;
      }
    }
    expect(designatedCount).toBe(0);
  });

  it('digging a designated cell makes it passable and no longer diggable, and adds new candidates', () => {
    const grid = new UndergroundGrid(defaultConfig);
    grid.dig(0, 0);
    grid.ensureDesignatedFrontier(1, 100);

    let designatedXY: [number, number] | null = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (grid.canDig(dx, dy)) designatedXY = [dx, dy];
      }
    }
    expect(designatedXY).not.toBeNull();
    const [xg, yg] = designatedXY!;

    grid.dig(xg, yg);
    expect(grid.get(xg, yg).dug).toBe(true);
    expect(grid.canDig(xg, yg)).toBe(false); // dug, not "still diggable"
  });
});
