import type { SimConfig } from './config';
import type { Vector2 } from './vector';

export interface UndergroundCellData {
  /** true = excavated tunnel/chamber (passable); false = solid, undug dirt. */
  dug: boolean;
  /** true = explicitly designated as the colony's next dig site — the *only* undug cells ants
   * are allowed to excavate (see `canDig`). Everything else stays a static, permanent wall, so
   * ants bumping into dirt can't gradually eat through deliberately-placed interior walls (e.g.
   * between the pre-built starter nest's chambers) the way unrestricted "dig whatever you hit"
   * would. */
  diggable: boolean;
}

/** 8-directional neighbor offsets, matching the filled-disc shape `digChamber` already uses. */
const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

const GRID_BORDER = 2;

/** The below-ground layer: solid dirt that ants dig into passable tunnels, starting from a
 * small chamber under the surface cave entrance. Coordinates align 1:1 with the surface
 * WorldGrid (same `mapGridSize`/bounds), so a position translates directly between layers
 * with no remapping — descending at the cave just means switching which grid you read/write.
 *
 * Deliberately much simpler than `WorldGrid`: no pheromones, no special cell types yet (queen
 * chamber/brood chambers are a later phase) — just "is this tile dug out or not." */
export class UndergroundGrid {
  readonly config: SimConfig;
  readonly minXg: number;
  readonly maxXg: number;
  readonly minYg: number;
  readonly maxYg: number;

  private cells = new Map<string, UndergroundCellData>();
  /** Undug cells adjacent to already-dug space — candidates `ensureDesignatedFrontier` draws
   * from. Maintained incrementally in `dig()` rather than rescanned, so it stays cheap even as
   * the nest grows. */
  private expansionCandidates = new Set<string>();
  /** Currently-designated (diggable but not yet dug) subset of `expansionCandidates`. */
  private diggableFrontier = new Set<string>();

  constructor(config: SimConfig) {
    this.config = config;
    const gridSize = config.mapGridSize;
    this.minXg = Math.floor(config.mapMinX / gridSize) - GRID_BORDER;
    this.maxXg = Math.floor(config.mapMaxX / gridSize) + GRID_BORDER;
    this.minYg = Math.floor(config.mapMinY / gridSize) - GRID_BORDER;
    this.maxYg = Math.floor(config.mapMaxY / gridSize) + GRID_BORDER;
  }

  private key(xg: number, yg: number): string {
    return `${xg},${yg}`;
  }

  /** All cells start undug and non-diggable; created lazily on first access rather than
   * pre-filled, since most of the map will likely never be dug into. */
  get(xg: number, yg: number): UndergroundCellData {
    let cell = this.cells.get(this.key(xg, yg));
    if (!cell) {
      cell = { dug: false, diggable: false };
      this.cells.set(this.key(xg, yg), cell);
    }
    return cell;
  }

  isInsideGrid(xg: number, yg: number): boolean {
    return xg >= this.minXg && xg <= this.maxXg && yg >= this.minYg && yg <= this.maxYg;
  }

  /** True only for cells ants are actually allowed to excavate — see `UndergroundCellData`. */
  canDig(xg: number, yg: number): boolean {
    const cell = this.get(xg, yg);
    return !cell.dug && cell.diggable;
  }

  /** Excavates a cell outright, bypassing the diggable check — used for seeding the pre-built
   * starter nest (which isn't "designated," it just exists) and by `ensureDesignatedFrontier`'s
   * ant-driven digging once a cell has actually been designated. Also updates the frontier
   * bookkeeping: the newly-dug cell drops out of both candidate sets, and its still-undug
   * neighbors become expansion candidates for future designation. */
  dig(xg: number, yg: number): void {
    if (!this.isInsideGrid(xg, yg)) return;
    const cell = this.get(xg, yg);
    cell.dug = true;
    cell.diggable = false;
    const k = this.key(xg, yg);
    this.expansionCandidates.delete(k);
    this.diggableFrontier.delete(k);

    for (const [dx, dy] of NEIGHBOR_OFFSETS) {
      const nx = xg + dx;
      const ny = yg + dy;
      if (this.isInsideGrid(nx, ny) && !this.get(nx, ny).dug) {
        this.expansionCandidates.add(this.key(nx, ny));
      }
    }
  }

  /** Marks one more expansion candidate as the colony's next dig site, if the nest still has
   * room to grow (`dugCount() < targetVolume`) and the designated pool isn't already at
   * `poolSize`. Call once per frame; cheap when there's nothing to do. Real colonies extend
   * their nest incrementally at the working edge, not by ants opportunistically punching holes
   * anywhere they bump into dirt — this keeps growth to a small, controlled active frontier. */
  ensureDesignatedFrontier(poolSize: number, targetVolume: number): void {
    if (this.dugCount() >= targetVolume) return;
    while (this.diggableFrontier.size < poolSize) {
      const eligible: string[] = [];
      for (const k of this.expansionCandidates) {
        if (!this.diggableFrontier.has(k)) eligible.push(k);
      }
      if (eligible.length === 0) return; // no more room to expand into right now
      const picked = eligible[Math.floor(Math.random() * eligible.length)];
      this.diggableFrontier.add(picked);
      const [xg, yg] = picked.split(',').map(Number);
      this.get(xg, yg).diggable = true;
    }
  }

  /** Digs a filled disc of radius `radiusCells` around (cx, cy) — used to seed the starting
   * entrance chamber under the cave, so ants have somewhere to stand (and dig outward from)
   * the moment they first descend. */
  digChamber(cx: number, cy: number, radiusCells: number): void {
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      for (let dy = -radiusCells; dy <= radiusCells; dy++) {
        if (dx * dx + dy * dy <= radiusCells * radiusCells) {
          this.dig(cx + dx, cy + dy);
        }
      }
    }
  }

  /** Digs a straight corridor of the given half-width between two chamber centers. Simple
   * parametric walk rather than a proper line algorithm — the map is small and this only runs
   * a handful of times at seed time, so exactness doesn't matter, just a reasonably straight,
   * organic-looking connector. */
  private digTunnel(x1: number, y1: number, x2: number, y2: number, halfWidth: number): void {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x1 + ((x2 - x1) * i) / steps);
      const y = Math.round(y1 + ((y2 - y1) * i) / steps);
      for (let dx = -halfWidth; dx <= halfWidth; dx++) {
        for (let dy = -halfWidth; dy <= halfWidth; dy++) {
          this.dig(x + dx, y + dy);
        }
      }
    }
  }

  /** Seeds a small pre-built starter nest around the entrance — a floor-plan shape with a clear
   * hierarchy, rather than uniform blob-like chambers: a small entrance foyer, a single thin
   * (single-cell) main corridor running down from it, and a handful of distinctly *larger* hall
   * chambers branching off that spine at intervals, alternating sides — so tunnel vs. room reads
   * clearly from shape alone (thin corridor vs. wide open chamber), like rooms off a hallway.
   * Runs before the simulation starts, so the underground view looks like an established colony
   * immediately rather than an empty seed. Ongoing digging (see `Simulation.stepUndergroundAnt`)
   * extends this spine/branch shape further via `ensureDesignatedFrontier`.
   *
   * Returns the grid positions of the first three branch chambers: the nearest is designated
   * the queen's chamber by `Simulation`, the next one out the nursery (brood is carried there
   * rather than piling up at the queen's feet), and the third the larder — where foragers
   * actually deposit delivered food, kept separate from the queen's chamber so the colony's
   * food store reads as its own place rather than looking like ants feeding the queen directly
   * and endlessly. All three splits mirror real colonies keeping egg-laying, brood-rearing, and
   * food storage in distinct chambers. */
  seedStarterNest(
    entranceXg: number,
    entranceYg: number,
  ): {
    queenChamberXg: number;
    queenChamberYg: number;
    nurseryChamberXg: number;
    nurseryChamberYg: number;
    larderChamberXg: number;
    larderChamberYg: number;
  } {
    this.digChamber(entranceXg, entranceYg, 1);

    const trunkLength = 20;
    this.digTunnel(entranceXg, entranceYg, entranceXg, entranceYg + trunkLength, 0);

    const branches: ReadonlyArray<{ alongTrunk: number; side: -1 | 1; branchLength: number; radius: number }> = [
      { alongTrunk: 5, side: -1, branchLength: 3, radius: 2 },
      { alongTrunk: 9, side: 1, branchLength: 4, radius: 3 },
      { alongTrunk: 14, side: -1, branchLength: 3, radius: 2 },
      { alongTrunk: 18, side: 1, branchLength: 3, radius: 3 },
    ];

    let queenChamberXg = entranceXg;
    let queenChamberYg = entranceYg;
    let nurseryChamberXg = entranceXg;
    let nurseryChamberYg = entranceYg;
    let larderChamberXg = entranceXg;
    let larderChamberYg = entranceYg;
    branches.forEach((branch, i) => {
      const trunkX = entranceXg;
      const trunkY = entranceYg + branch.alongTrunk;
      const chamberX = trunkX + branch.side * branch.branchLength;
      this.digTunnel(trunkX, trunkY, chamberX, trunkY, 0);
      this.digChamber(chamberX, trunkY, branch.radius);
      if (i === 0) {
        queenChamberXg = chamberX;
        queenChamberYg = trunkY;
      } else if (i === 1) {
        nurseryChamberXg = chamberX;
        nurseryChamberYg = trunkY;
      } else if (i === 2) {
        larderChamberXg = chamberX;
        larderChamberYg = trunkY;
      }
    });

    return { queenChamberXg, queenChamberYg, nurseryChamberXg, nurseryChamberYg, larderChamberXg, larderChamberYg };
  }

  /** Count of excavated tiles, for comparing against a population-proportional target volume
   * (real nest volume grows roughly proportionally with digging population). */
  dugCount(): number {
    let count = 0;
    for (const cell of this.cells.values()) {
      if (cell.dug) count++;
    }
    return count;
  }

  worldToGrid(x: number, y: number): [number, number] {
    const gridSize = this.config.mapGridSize;
    return [Math.floor(x / gridSize), Math.floor(y / gridSize)];
  }

  /** Top-left world corner of a grid tile (matches `WorldGrid.gridToWorldOrigin`). */
  gridToWorldOrigin(xg: number, yg: number): Vector2 {
    const gridSize = this.config.mapGridSize;
    return { x: xg * gridSize, y: yg * gridSize };
  }

  canPass(position: Vector2): boolean {
    const [xg, yg] = this.worldToGrid(position.x, position.y);
    return this.get(xg, yg).dug;
  }

  /** Shortest dug-tunnel route (grid-cell centers, in world space, excluding the start) from
   * `fromWorld` to `toWorld`, or null if unreachable. Plain BFS over the dug network — direct
   * "just steer at the target" navigation fails as soon as the target isn't a straight line
   * away (e.g. down a trunk corridor then around a corner into a branch chamber), which is the
   * normal case here. Cheap at this map's scale (at most a few hundred dug tiles). */
  findPath(fromWorld: Vector2, toWorld: Vector2): Vector2[] | null {
    const [fx, fy] = this.worldToGrid(fromWorld.x, fromWorld.y);
    const [tx, ty] = this.worldToGrid(toWorld.x, toWorld.y);
    const startKey = this.key(fx, fy);
    const targetKey = this.key(tx, ty);
    if (startKey === targetKey) return [];

    const cameFrom = new Map<string, string>();
    const visited = new Set<string>([startKey]);
    const queue: Array<[number, number]> = [[fx, fy]];

    for (let qi = 0; qi < queue.length; qi++) {
      const [cx, cy] = queue[qi];
      if (this.key(cx, cy) === targetKey) break;
      for (const [dx, dy] of NEIGHBOR_OFFSETS) {
        const nx = cx + dx;
        const ny = cy + dy;
        const nk = this.key(nx, ny);
        if (visited.has(nk) || !this.get(nx, ny).dug) continue;
        visited.add(nk);
        cameFrom.set(nk, this.key(cx, cy));
        queue.push([nx, ny]);
      }
    }
    if (!visited.has(targetKey)) return null;

    const gridKeys: string[] = [];
    for (let cur = targetKey; cur !== startKey; ) {
      gridKeys.push(cur);
      cur = cameFrom.get(cur)!;
    }
    gridKeys.reverse();

    const half = this.config.mapGridSize / 2;
    return gridKeys.map((k) => {
      const [xg, yg] = k.split(',').map(Number);
      const origin = this.gridToWorldOrigin(xg, yg);
      return { x: origin.x + half, y: origin.y + half };
    });
  }
}
