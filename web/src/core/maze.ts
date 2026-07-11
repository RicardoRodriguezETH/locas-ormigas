/** Deterministic PRNG (mulberry32) so a maze is reproducible from a seed — useful for a
 * stable "base map" everyone sees the same version of, rather than a fresh random layout
 * every page load. */
export function createRng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export interface Maze {
  /** Tile dimensions: always 2*cols+1 by 2*rows+1, since each logical cell becomes a tile
   * with a wall-or-passage tile between it and each neighbor. */
  width: number;
  height: number;
  /** [x][y]-indexed; true = passable corridor tile, false = wall. The outer boundary ring is
   * always solid — callers open their own entrance/exit through it. */
  passable: boolean[][];
}

const DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Carves a "perfect" maze (exactly one path between any two logical cells, no loops) of
 * `cols` x `rows` logical cells using the randomized depth-first search / recursive
 * backtracker algorithm. Iterative (explicit stack) so it doesn't blow the call stack on
 * larger mazes. */
export function generateMaze(cols: number, rows: number, rng: () => number = Math.random): Maze {
  const width = 2 * cols + 1;
  const height = 2 * rows + 1;
  const passable: boolean[][] = Array.from({ length: width }, () => Array(height).fill(false));
  const visited: boolean[][] = Array.from({ length: cols }, () => Array(rows).fill(false));

  const stack: Array<[number, number]> = [[0, 0]];
  visited[0][0] = true;
  passable[1][1] = true;

  while (stack.length > 0) {
    const [cx, cy] = stack[stack.length - 1];
    const next = shuffle(DIRECTIONS, rng)
      .map(([dx, dy]) => [cx + dx, cy + dy, dx, dy] as const)
      .find(([nx, ny]) => nx >= 0 && nx < cols && ny >= 0 && ny < rows && !visited[nx][ny]);

    if (!next) {
      stack.pop();
      continue;
    }

    const [nx, ny, dx, dy] = next;
    passable[2 * cx + 1 + dx][2 * cy + 1 + dy] = true; // knock down the wall between them
    passable[2 * nx + 1][2 * ny + 1] = true;
    visited[nx][ny] = true;
    stack.push([nx, ny]);
  }

  return { width, height, passable };
}
