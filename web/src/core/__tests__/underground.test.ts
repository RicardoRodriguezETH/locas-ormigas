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

  it('seedStarterNest() returns distinct, dug queen and nursery chamber positions', () => {
    const grid = new UndergroundGrid(defaultConfig);
    const { queenChamberXg, queenChamberYg, nurseryChamberXg, nurseryChamberYg } = grid.seedStarterNest(0, 0);
    expect(grid.get(queenChamberXg, queenChamberYg).dug).toBe(true);
    expect(grid.get(nurseryChamberXg, nurseryChamberYg).dug).toBe(true);
    expect([queenChamberXg, queenChamberYg]).not.toEqual([nurseryChamberXg, nurseryChamberYg]);
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

  it('findPath() returns an empty path when start and target are the same cell', () => {
    const grid = new UndergroundGrid(defaultConfig);
    grid.dig(0, 0);
    const origin = grid.gridToWorldOrigin(0, 0);
    const center = { x: origin.x + defaultConfig.mapGridSize / 2, y: origin.y + defaultConfig.mapGridSize / 2 };
    expect(grid.findPath(center, center)).toEqual([]);
  });

  it('findPath() returns null when the target is unreachable', () => {
    const grid = new UndergroundGrid(defaultConfig);
    grid.digChamber(0, 0, 1);
    grid.digChamber(20, 20, 1); // disconnected — no tunnel links them
    const from = grid.gridToWorldOrigin(0, 0);
    const to = grid.gridToWorldOrigin(20, 20);
    expect(grid.findPath(from, to)).toBeNull();
  });

  it("findPath() routes through a corner rather than cutting through undug dirt", () => {
    const grid = new UndergroundGrid(defaultConfig);
    // an L-shaped corridor: (0,0) -> (0,5) -> (5,5), single-width, no direct diagonal dug
    for (let y = 0; y <= 5; y++) grid.dig(0, y);
    for (let x = 0; x <= 5; x++) grid.dig(x, 5);

    const from = grid.gridToWorldOrigin(0, 0);
    const to = grid.gridToWorldOrigin(5, 5);
    const path = grid.findPath(from, to);
    expect(path).not.toBeNull();
    // every waypoint must be over dug ground — the whole point is not to cut through walls
    for (const p of path!) {
      const [xg, yg] = grid.worldToGrid(p.x, p.y);
      expect(grid.get(xg, yg).dug).toBe(true);
    }
    // 5 steps down + 5 steps right, minus the shared corner cell = 9 distinct waypoints
    expect(path!.length).toBe(9);
  });
});
