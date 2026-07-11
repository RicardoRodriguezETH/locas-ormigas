import type { SimConfig } from './config';
import type { Vector2 } from './vector';

export interface UndergroundCellData {
  /** true = excavated tunnel/chamber (passable); false = solid, undug dirt. */
  dug: boolean;
}

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

  /** All cells start undug; created lazily on first access rather than pre-filled, since most
   * of the map will likely never be dug into. */
  get(xg: number, yg: number): UndergroundCellData {
    let cell = this.cells.get(this.key(xg, yg));
    if (!cell) {
      cell = { dug: false };
      this.cells.set(this.key(xg, yg), cell);
    }
    return cell;
  }

  isInsideGrid(xg: number, yg: number): boolean {
    return xg >= this.minXg && xg <= this.maxXg && yg >= this.minYg && yg <= this.maxYg;
  }

  dig(xg: number, yg: number): void {
    if (!this.isInsideGrid(xg, yg)) return;
    this.get(xg, yg).dug = true;
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

  /** Seeds a small pre-built starter nest around the entrance — an entrance chamber plus a
   * handful of satellite chambers linked by corridors — so the underground view looks like an
   * established colony immediately rather than an empty seed that digging alone would take a
   * long time to fill in. Ongoing digging (see `Simulation.stepUndergroundAnt`) expands outward
   * from this base. */
  seedStarterNest(entranceXg: number, entranceYg: number): void {
    this.digChamber(entranceXg, entranceYg, 2);

    const satellites: ReadonlyArray<{ dx: number; dy: number; radius: number }> = [
      { dx: -3, dy: 4, radius: 2 },
      { dx: 4, dy: 5, radius: 1 },
      { dx: -1, dy: 8, radius: 2 },
      { dx: 3, dy: 10, radius: 1 },
    ];

    let prevX = entranceXg;
    let prevY = entranceYg;
    for (const sat of satellites) {
      const sx = entranceXg + sat.dx;
      const sy = entranceYg + sat.dy;
      this.digTunnel(prevX, prevY, sx, sy, 1);
      this.digChamber(sx, sy, sat.radius);
      prevX = sx;
      prevY = sy;
    }
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
}
