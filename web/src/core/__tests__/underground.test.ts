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
});
