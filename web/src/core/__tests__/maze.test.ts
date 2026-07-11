import { describe, expect, it } from 'vitest';
import { createRng, generateMaze } from '../maze';

/** Flood-fills from (1,1) over passable tiles; returns how many logical cells (odd,odd tiles)
 * were reached. */
function reachableLogicalCells(maze: ReturnType<typeof generateMaze>): number {
  const seen = new Set<string>();
  const stack: Array<[number, number]> = [[1, 1]];
  seen.add('1,1');
  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;
      if (nx < 0 || nx >= maze.width || ny < 0 || ny >= maze.height) continue;
      if (!maze.passable[nx][ny] || seen.has(key)) continue;
      seen.add(key);
      stack.push([nx, ny]);
    }
  }
  let logicalCells = 0;
  for (const key of seen) {
    const [x, y] = key.split(',').map(Number);
    if (x % 2 === 1 && y % 2 === 1) logicalCells++;
  }
  return logicalCells;
}

describe('generateMaze', () => {
  it('produces a tile grid of the expected size', () => {
    const maze = generateMaze(5, 4, createRng(1));
    expect(maze.width).toBe(11);
    expect(maze.height).toBe(9);
  });

  it('connects every logical cell to every other one (a perfect maze has no isolated pockets)', () => {
    const cols = 9;
    const rows = 7;
    const maze = generateMaze(cols, rows, createRng(42));
    expect(reachableLogicalCells(maze)).toBe(cols * rows);
  });

  it('keeps the outer boundary solid, leaving entrance-carving to the caller', () => {
    const maze = generateMaze(6, 5, createRng(7));
    for (let x = 0; x < maze.width; x++) {
      expect(maze.passable[x][0]).toBe(false);
      expect(maze.passable[x][maze.height - 1]).toBe(false);
    }
    for (let y = 0; y < maze.height; y++) {
      expect(maze.passable[0][y]).toBe(false);
      expect(maze.passable[maze.width - 1][y]).toBe(false);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = generateMaze(7, 6, createRng(123));
    const b = generateMaze(7, 6, createRng(123));
    expect(a.passable).toEqual(b.passable);
  });

  it('produces different layouts for different seeds', () => {
    const a = generateMaze(7, 6, createRng(1));
    const b = generateMaze(7, 6, createRng(2));
    expect(a.passable).not.toEqual(b.passable);
  });
});
