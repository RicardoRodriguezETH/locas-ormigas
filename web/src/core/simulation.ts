import { type Ant, createAnt, enablePheromonesWrite, isComNeeded, objectAvoidance, updateAnt } from './ant';
import { GRID_COM_SCAN, INTERESTS, type SimConfig, defaultConfig } from './config';
import { type PaintableCellType, WorldGrid, readPheromoneStrength } from './grid';
import { createRng, generateMaze } from './maze';
import { directionTo, fromAngle, scale, type Vector2 } from './vector';

export interface SimulationOptions {
  /** Sprinkle a little random grass/rubble across the map on init. Tests usually want this off. */
  randomizeGrid?: boolean;
}

/** Base map: a generated maze standing between the colony and two food sources, meant to
 * stress-test pathing and pheromone-following against something harder than open ground —
 * a required entrance, winding corridors, and two simultaneous destinations. Fixed seed so
 * everyone gets the same layout to compare algorithms against. */
const MAZE_COLS = 9;
const MAZE_ROWS = 7;
const MAZE_SEED = 1337;

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
    this.buildMazeStressTestMap();

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

  /** Carves the maze into the grid, positioned relative to the configured map bounds (near
   * the right edge, vertically centered), breaches a single entrance facing the open field
   * where the colony spawns, and seeds two food sources at far interior corners so reaching
   * either requires real navigation through the maze rather than a beeline. */
  private buildMazeStressTestMap(): void {
    const maze = generateMaze(MAZE_COLS, MAZE_ROWS, createRng(MAZE_SEED));
    const gridSize = this.config.mapGridSize;
    const maxXg = Math.floor(this.config.mapMaxX / gridSize);
    const originX = maxXg - maze.width - 2;
    const originY = -Math.floor(maze.height / 2);

    for (let x = 0; x < maze.width; x++) {
      for (let y = 0; y < maze.height; y++) {
        if (!maze.passable[x][y]) {
          this.grid.get(originX + x, originY + y).pass = false;
        }
      }
    }

    // breach the west wall next to the maze's starting cell (logical (0,0), tile (1,1))
    this.grid.get(originX, originY + 1).pass = true;

    // two food sources at the maze's far interior corners, reached by different corridors
    this.grid.seedCell('food', originX + maze.width - 2, originY + 1);
    this.grid.seedCell('food', originX + maze.width - 2, originY + maze.height - 2);
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

  /** Ants never talk to each other directly; they leave/read pheromone info on the grid cell
   * they're standing on. Both algorithms share the same "snap directly to whichever nearby
   * cell scores best, and only overwrite a cell if you'd raise its score" mechanic — that
   * decisive, immediate-commitment behavior is what makes it work. They differ only in what
   * "score" means:
   *  - 'legacy': raw frame-time. A lead is exactly as good as it ever was until something
   *    newer replaces it — simple, but stale leads can linger and mislead indefinitely.
   *  - 'gradient': frame-time run through exponential decay, so a lead quietly loses
   *    authority the longer it goes unrefreshed, and an ant's own contribution is scaled by
   *    how recently *it* personally confirmed the resource. This is the one piece of realism
   *    (evaporation) the original was missing, without touching the mechanic that actually
   *    makes foraging work. */
  private communicatePheromones(ant: Ant): void {
    const useDecay = this.config.pheromoneAlgorithm === 'gradient';
    const [gx, gy] = this.grid.worldToGrid(ant.position.x, ant.position.y);

    for (const [dx, dy] of GRID_COM_SCAN) {
      const info = this.grid.get(gx + dx, gy + dy).pheromones[ant.lookingFor];
      const score = useDecay ? readPheromoneStrength(info, this.frame, this.config.pheromoneDecayPerFrame) : info.time;
      if (score > ant.maxLeadScore) {
        ant.maxLeadScore = score;
        ant.direction = directionTo(ant.position, info.where, ant.direction);
      }
    }

    if (ant.pheromonesWrite) {
      for (const interest of INTERESTS) {
        const lastSeen = ant.lastTimeSeen[interest];
        if (lastSeen < 0) continue;
        const info = this.grid.get(gx, gy).pheromones[interest];

        if (useDecay) {
          const candidateScore = this.config.pheromoneDecayPerFrame ** (this.frame - lastSeen);
          const existingScore = readPheromoneStrength(info, this.frame, this.config.pheromoneDecayPerFrame);
          if (candidateScore <= existingScore) continue;
          info.strength = candidateScore;
        } else {
          if (lastSeen <= info.time) continue;
          info.time = lastSeen;
          info.strength = this.config.pheromoneDepositAmount; // for the debug overlay only
        }
        info.lastUpdated = this.frame;
        info.where = { ...ant.oldestPositionRemembered };
      }
    } else if (this.frame >= ant.pheromonesBackTime) {
      enablePheromonesWrite(ant);
    }
  }
}
