import type { Ant } from './ant';
import type { Interest, SimConfig } from './config';
import { CaveCell, type Cell, FoodCell, type FoodType, GrassCell, PortalCell, PortalFactory } from './cells';
import { type Vector2 } from './vector';

export interface PheromoneInfo {
  /** Concentration as of `lastUpdated`; decays continuously after that — read it with
   * `readPheromoneStrength` rather than using this field directly. Used by the 'gradient'
   * algorithm, and kept updated by 'legacy' too so the debug overlay can render either. */
  strength: number;
  /** Shared decay clock for `strength` and `flow` alike — whichever algorithm is active only
   * ever touches the fields it uses, so one timestamp for both is safe. */
  lastUpdated: number;
  /** 'legacy' algorithm only: frame this was last reported here; -1 = never. */
  time: number;
  /** 'legacy'/'gradient' only: world position to head toward to chase this lead. */
  where: Vector2;
  /** 'flow' algorithm only: decaying sum of the headings of ants who deposited here while
   * seeking this interest. Its *direction* is the trail's direction, its *magnitude* is the
   * trail's strength — read it with `readPheromoneFlow`. */
  flow: Vector2;
}

export interface GridCellData {
  /** Can an ant walk through this tile? */
  pass: boolean;
  cell: Cell | null;
  pheromones: Record<Interest, PheromoneInfo>;
}

/** Current concentration of a pheromone deposit, decayed for the time elapsed since it was
 * last topped up. Lazy exponential decay: cheap to read, and needs no per-frame sweep of the
 * whole grid to "tick down" cells nobody is currently looking at. */
export function readPheromoneStrength(info: PheromoneInfo, frame: number, decayPerFrame: number): number {
  const elapsed = frame - info.lastUpdated;
  if (elapsed <= 0) return info.strength;
  return info.strength * decayPerFrame ** elapsed;
}

/** Current flow vector, decayed the same way as `readPheromoneStrength` — shrinking the
 * vector's magnitude over time while preserving its direction. */
export function readPheromoneFlow(info: PheromoneInfo, frame: number, decayPerFrame: number): Vector2 {
  const elapsed = frame - info.lastUpdated;
  if (elapsed <= 0) return info.flow;
  const factor = decayPerFrame ** elapsed;
  return { x: info.flow.x * factor, y: info.flow.y * factor };
}

/** Placeable tile types, as exposed to the UI's cell-painting tool. */
export type PaintableCellType = 'block' | 'grass' | 'food' | 'cave' | 'portal' | 'ground';

const GRID_BORDER = 2;

/** The world's spatial grid: walkability, special tiles (food/cave/grass/portals), and the
 * pheromone trails ants leave behind. Extends slightly past the map's visible bounds so
 * neighbor lookups never need bounds-checking. */
export class WorldGrid {
  readonly config: SimConfig;
  readonly minXg: number;
  readonly maxXg: number;
  readonly minYg: number;
  readonly maxYg: number;

  private cells = new Map<string, GridCellData>();
  private portalFactory = new PortalFactory();

  constructor(config: SimConfig, options: { randomize?: boolean } = {}) {
    this.config = config;
    const gridSize = config.mapGridSize;
    this.minXg = Math.floor(config.mapMinX / gridSize) - GRID_BORDER;
    this.maxXg = Math.floor(config.mapMaxX / gridSize) + GRID_BORDER;
    this.minYg = Math.floor(config.mapMinY / gridSize) - GRID_BORDER;
    this.maxYg = Math.floor(config.mapMaxY / gridSize) + GRID_BORDER;

    const randomize = options.randomize ?? true;
    for (let xg = this.minXg; xg <= this.maxXg; xg++) {
      for (let yg = this.minYg; yg <= this.maxYg; yg++) {
        this.initCell(xg, yg, randomize);
      }
    }
  }

  private key(xg: number, yg: number): string {
    return `${xg},${yg}`;
  }

  private initCell(xg: number, yg: number, randomize: boolean): GridCellData {
    const data: GridCellData = {
      pass: true,
      cell: null,
      pheromones: {
        food: { strength: 0, lastUpdated: 0, time: -1, where: { x: 0, y: 0 }, flow: { x: 0, y: 0 } },
        cave: { strength: 0, lastUpdated: 0, time: -1, where: { x: 0, y: 0 }, flow: { x: 0, y: 0 } },
      },
    };
    // light scattered grass for texture; no random blocks (those are placed deliberately as
    // obstacles in `Simulation.buildBaseMap`, and stray ones were an ascend/spawn hazard)
    if (randomize && Math.random() < 0.004) data.cell = new GrassCell();
    this.cells.set(this.key(xg, yg), data);
    return data;
  }

  get(xg: number, yg: number): GridCellData {
    return this.cells.get(this.key(xg, yg)) ?? this.initCell(xg, yg, false);
  }

  isInsideGrid(xg: number, yg: number): boolean {
    return xg >= this.minXg && xg <= this.maxXg && yg >= this.minYg && yg <= this.maxYg;
  }

  worldToGrid(x: number, y: number): [number, number] {
    const gridSize = this.config.mapGridSize;
    return [Math.floor(x / gridSize), Math.floor(y / gridSize)];
  }

  /** Top-left world corner of a grid tile (tile sprites are positioned/anchored from here). */
  gridToWorldOrigin(xg: number, yg: number): Vector2 {
    const gridSize = this.config.mapGridSize;
    return { x: xg * gridSize, y: yg * gridSize };
  }

  canPass(position: Vector2): boolean {
    const [xg, yg] = this.worldToGrid(position.x, position.y);
    return this.get(xg, yg).pass;
  }

  /** Places food/cave directly by grid coordinates, used for initial world seeding. `foodType`
   * is ignored for 'cave'. */
  seedCell(type: 'food' | 'cave', xg: number, yg: number, foodType?: FoodType): void {
    const data = this.get(xg, yg);
    data.pass = true;
    data.cell = type === 'food' ? new FoodCell(foodType) : new CaveCell();
  }

  /** Places a decorative grass tile by grid coords, only on empty passable ground (won't paint
   * over food/cave/walls). Used to seed grass patches at world init. */
  seedGrass(xg: number, yg: number): void {
    const data = this.get(xg, yg);
    if (data.pass && !data.cell) data.cell = new GrassCell();
  }

  removeCell(xg: number, yg: number): void {
    const data = this.get(xg, yg);
    if (data.cell?.type === 'portal') {
      const linked = (data.cell as PortalCell).link;
      if (linked) {
        const linkedData = this.get(linked.gridX, linked.gridY);
        linkedData.pass = true;
        linkedData.cell = null;
      }
    }
    data.cell = null;
    data.pass = true;
  }

  /** Paints a tile from world coordinates, matching the UI's click/drag cell tool. */
  setCellAtWorld(type: PaintableCellType, worldPosition: Vector2): void {
    const [xg, yg] = this.worldToGrid(worldPosition.x, worldPosition.y);
    if (!this.isInsideGrid(xg, yg)) return;

    this.removeCell(xg, yg);
    const data = this.get(xg, yg);
    switch (type) {
      case 'block':
        data.pass = false;
        break;
      case 'grass':
        data.cell = new GrassCell();
        break;
      case 'food':
        data.cell = new FoodCell();
        break;
      case 'cave':
        data.cell = new CaveCell();
        break;
      case 'portal': {
        const portal = this.portalFactory.create();
        portal.gridX = xg;
        portal.gridY = yg;
        portal.position = this.gridToWorldOrigin(xg, yg);
        data.cell = portal;
        break;
      }
      case 'ground':
        // removeCell above already cleared it back to plain ground
        break;
    }
  }

  private collidesWithLimits(position: Vector2, direction: Vector2): boolean {
    const { mapMinX, mapMaxX, mapMinY, mapMaxY } = this.config;
    if (position.x < mapMinX) {
      if (direction.x < 0) direction.x = -direction.x;
      return true;
    } else if (position.x > mapMaxX) {
      if (direction.x > 0) direction.x = -direction.x;
      return true;
    }
    if (position.y < mapMinY) {
      if (direction.y < 0) direction.y = -direction.y;
      return true;
    } else if (position.y > mapMaxY) {
      if (direction.y > 0) direction.y = -direction.y;
      return true;
    }
    return false;
  }

  private collidesWithCell(position: Vector2, direction: Vector2): boolean {
    const gridSize = this.config.mapGridSize;
    const [xg, yg] = this.worldToGrid(position.x, position.y);
    if (this.get(xg, yg).pass) return false;

    const centerX = (xg + 0.5) * gridSize;
    const centerY = (yg + 0.5) * gridSize;
    const relX = position.x - centerX;
    const relY = position.y - centerY;
    // which side of the blocking tile did we hit? bounce off the nearer edge.
    if ((relY < -relX && relY > relX) || (relY > -relX && relY < relX)) {
      // left or right side
      if (direction.y >= 0) {
        direction.x = 0;
        direction.y = 1;
      } else {
        direction.x = 0;
        direction.y = -1;
      }
    } else {
      // top or bottom side
      if (direction.x >= 0) {
        direction.x = 1;
        direction.y = 0;
      } else {
        direction.x = -1;
        direction.y = 0;
      }
    }
    return true;
  }

  /** True (and nudges `direction`) if `position` collides with the map limits or a blocking
   * tile. `direction` is mutated in place, mirroring how the caller's movement vector reacts. */
  anyCollisionWith(position: Vector2, direction: Vector2): boolean {
    return this.collidesWithLimits(position, direction) || this.collidesWithCell(position, direction);
  }

  /** An ant is thoroughly stuck (e.g. the user painted a block on top of it): spiral outward
   * from its current spot until we find a free tile, and snap it there. */
  private fixTrapped(ant: Ant): void {
    let angle = 0;
    let radius = 0;
    let collision = true;
    let p: Vector2 = { x: 0, y: 0 };
    do {
      radius += 1;
      angle += 0.1;
      p = {
        x: ant.position.x + radius * Math.cos(angle),
        y: ant.position.y + radius * Math.sin(angle),
      };
      collision = this.anyCollisionWith(p, ant.direction);
    } while (collision && radius < 100);

    if (radius < 100) {
      ant.position = p;
    }
  }

  /** Moves an ant one step, deflecting off obstacles/limits and using `fixTrapped` as a last
   * resort if it's still stuck after a few bounce attempts. */
  resolveBlockingCollisionAndMove(ant: Ant, frame: number): void {
    let numTries = 0;
    let collision = false;
    const dir = { ...ant.direction };
    let newPosition: Vector2 = { ...ant.position };

    do {
      numTries += 1;
      newPosition = {
        x: ant.position.x + dir.x * ant.speed,
        y: ant.position.y + dir.y * ant.speed,
      };
      collision = this.anyCollisionWith(newPosition, dir);
      if (collision && numTries === 3) {
        dir.x = -ant.direction.x;
        dir.y = -ant.direction.y;
      } else if (collision && numTries === 6) {
        this.fixTrapped(ant);
      }
    } while (collision && numTries < 6);

    ant.direction = dir;
    ant.position = {
      x: ant.position.x + dir.x * ant.speed,
      y: ant.position.y + dir.y * ant.speed,
    };
    ant.traveled += ant.speed;

    if (numTries > 1) {
      ant.lastCollisionTime = frame;
    }
  }
}
