import {
  type Ant,
  createAnt,
  enablePheromonesWrite,
  headTo,
  isComNeeded,
  objectAvoidance,
  updateAnt,
} from './ant';
import { GRID_COM_SCAN, INTERESTS, type SimConfig, defaultConfig } from './config';
import { type PaintableCellType, WorldGrid } from './grid';
import { fromAngle, scale, type Vector2 } from './vector';

export interface SimulationOptions {
  /** Sprinkle a little random grass/rubble across the map on init. Tests usually want this off. */
  randomizeGrid?: boolean;
}

/** Owns the ant colony and drives the pheromone-following behavior each frame: move, react to
 * the tile underfoot, then read/write trail info in the surrounding grid cells. */
export class Simulation {
  readonly config: SimConfig;
  readonly grid: WorldGrid;
  ants: Ant[] = [];
  frame = 0;

  constructor(config: SimConfig = defaultConfig, options: SimulationOptions = {}) {
    this.config = config;
    this.grid = new WorldGrid(config, { randomize: options.randomizeGrid ?? true });
  }

  init(numAnts: number = this.config.numAnts): void {
    this.grid.seedCell('cave', -6, -4);
    this.grid.seedCell('food', 12, 5);

    this.ants = [];
    for (let i = 1; i <= numAnts; i++) {
      const direction = fromAngle(Math.random() * Math.PI * 2);
      const position = scale(direction, 50 + i / 60);
      this.ants.push(createAnt(this.config, position, direction));
    }
  }

  setCell(type: PaintableCellType, worldPosition: Vector2): void {
    this.grid.setCellAtWorld(type, worldPosition);
  }

  update(): void {
    for (const ant of this.ants) {
      if (!ant.paused) this.stepAnt(ant);
    }
    for (const ant of this.ants) {
      updateAnt(ant, this.frame);
    }
    this.frame += 1;
  }

  private stepAnt(ant: Ant): void {
    this.grid.resolveBlockingCollisionAndMove(ant, this.frame);
    this.interactionWithCells(ant);

    if (this.config.antComEveryFrame || isComNeeded(ant, this.frame)) {
      this.communicatePheromones(ant);
    }

    if (this.config.antObjectAvoidance) {
      objectAvoidance(ant, this.config, (p) => this.grid.canPass(p));
    }
  }

  private interactionWithCells(ant: Ant): void {
    const [xg, yg] = this.grid.worldToGrid(ant.position.x, ant.position.y);
    const cell = this.grid.get(xg, yg).cell;
    if (!cell) return;

    cell.affectAnt(ant, { frame: this.frame, config: this.config });
    if (cell.type === 'food' || cell.type === 'cave') {
      ant.lastTimeSeen[cell.type] = this.frame;
    }
  }

  /** Ants never talk to each other directly; they read/write "I saw X here at time T" onto
   * the grid cell they're standing on, and check their 3x3 neighborhood for fresher leads. */
  private communicatePheromones(ant: Ant): void {
    const [gx, gy] = this.grid.worldToGrid(ant.position.x, ant.position.y);

    for (const [dx, dy] of GRID_COM_SCAN) {
      const seen = this.grid.get(gx + dx, gy + dy).pheromones[ant.lookingFor];
      if (seen.time > ant.maxTimeSeen) {
        ant.maxTimeSeen = seen.time;
        headTo(ant, seen.where, this.frame);
      }
    }

    if (ant.pheromonesWrite) {
      const seenHere = this.grid.get(gx, gy).pheromones;
      for (const interest of INTERESTS) {
        const lastSeen = ant.lastTimeSeen[interest];
        const info = seenHere[interest];
        if (lastSeen > info.time) {
          info.time = lastSeen;
          info.where = { ...ant.oldestPositionRemembered };
        }
      }
    } else if (this.frame >= ant.pheromonesBackTime) {
      enablePheromonesWrite(ant);
    }
  }
}
