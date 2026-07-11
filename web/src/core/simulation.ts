import {
  type Ant,
  createAnt,
  enablePheromonesWrite,
  isComNeeded,
  objectAvoidance,
  updateActivityCycle,
  updateAnt,
  updateRestingMovement,
} from './ant';
import { GRID_COM_SCAN, INTERESTS, type SimConfig, defaultConfig } from './config';
import { type PaintableCellType, WorldGrid, readPheromoneFlow, readPheromoneStrength } from './grid';
import { add, directionTo, distance, fromAngle, length, normalize, scale, type Vector2 } from './vector';

export interface SimulationOptions {
  /** Sprinkle a little random grass/rubble across the map on init. Tests usually want this off. */
  randomizeGrid?: boolean;
}

/** Base map: three staggered wall segments standing between the colony and two food sources,
 * forcing a zigzag detour rather than a beeline — enough to stress-test pathing and
 * pheromone-following without being a full labyrinth (a proper generated maze turned out to
 * be nearly unsolvable for any of the algorithms within a reasonable time). */
const WALL_REGION_WIDTH = 18;
const WALL_REGION_HEIGHT = 15;
const WALL_GAP_SIZE = 3;
/** X offsets (within the region) of the three wall columns, and whether each one's gap is at
 * the top or bottom — alternating, so ants have to weave through them. */
const WALLS: ReadonlyArray<{ x: number; gapAtTop: boolean }> = [
  { x: 4, gapAtTop: true },
  { x: 9, gapAtTop: false },
  { x: 14, gapAtTop: true },
];

/** Owns the ant colony and drives the pheromone-following behavior each frame: move, react to
 * the tile underfoot, then read/write trail info in the surrounding grid cells. */
export class Simulation {
  readonly config: SimConfig;
  readonly grid: WorldGrid;
  ants: Ant[] = [];
  frame = 0;
  cavePosition: Vector2 = { x: 0, y: 0 };

  constructor(config: SimConfig = defaultConfig, options: SimulationOptions = {}) {
    this.config = config;
    this.grid = new WorldGrid(config, { randomize: options.randomizeGrid ?? true });
  }

  init(numAnts: number = this.config.numAnts): void {
    const caveGx = -6;
    const caveGy = -4;
    this.grid.seedCell('cave', caveGx, caveGy);
    this.cavePosition = add(this.grid.gridToWorldOrigin(caveGx, caveGy), scale({ x: this.config.mapGridSize, y: this.config.mapGridSize }, 0.5));
    this.buildZigzagStressTestMap();

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

  /** Carves the three staggered wall segments into the grid, positioned relative to the
   * configured map bounds (near the right edge, vertically centered), and seeds two food
   * sources beyond the last wall at different heights so reaching either requires weaving
   * through all three gaps rather than a beeline. */
  private buildZigzagStressTestMap(): void {
    const gridSize = this.config.mapGridSize;
    const maxXg = Math.floor(this.config.mapMaxX / gridSize);
    const originX = maxXg - WALL_REGION_WIDTH - 2;
    const originY = -Math.floor(WALL_REGION_HEIGHT / 2);

    for (const wall of WALLS) {
      for (let y = 0; y < WALL_REGION_HEIGHT; y++) {
        const inGap = wall.gapAtTop ? y < WALL_GAP_SIZE : y >= WALL_REGION_HEIGHT - WALL_GAP_SIZE;
        if (!inGap) {
          this.grid.get(originX + wall.x, originY + y).pass = false;
        }
      }
    }

    const lastWallX = WALLS[WALLS.length - 1].x;
    this.grid.seedCell('food', originX + lastWallX + 4, originY + 2);
    this.grid.seedCell('food', originX + lastWallX + 4, originY + WALL_REGION_HEIGHT - 3);
  }

  update(): void {
    for (const ant of this.ants) {
      const eligibleToRest = ant.cargo.count === 0 && distance(ant.position, this.cavePosition) <= this.config.antRestTetherRadius;
      updateActivityCycle(ant, this.config, this.frame, eligibleToRest);
      if (ant.paused) {
        this.stepRestingAnt(ant);
      } else {
        this.stepAnt(ant);
      }
    }
    for (const ant of this.ants) {
      updateAnt(ant, this.config, this.frame);
    }
    this.frame += 1;
  }

  /** Resting ants just mill slowly near the cave — no pheromone communication, no goal-seeking
   * collision reaction, just gentle movement and the ordinary map-boundary/wall collision. */
  private stepRestingAnt(ant: Ant): void {
    updateRestingMovement(ant, this.config, this.cavePosition);
    this.grid.resolveBlockingCollisionAndMove(ant, this.frame);
  }

  private stepAnt(ant: Ant): void {
    this.grid.resolveBlockingCollisionAndMove(ant, this.frame);
    this.interactionWithCells(ant);

    // 'flow' needs to deposit every frame — a trail only reads as a spatially continuous line
    // if ants lay it densely as they walk, unlike 'legacy'/'gradient''s sparse "check in every
    // few frames" snapshot mechanic.
    const shouldCommunicate =
      this.config.pheromoneAlgorithm === 'flow' || this.config.antComEveryFrame || isComNeeded(ant, this.frame);
    if (shouldCommunicate) {
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
   * they're standing on. Dispatches to whichever algorithm is configured. */
  private communicatePheromones(ant: Ant): void {
    if (this.config.pheromoneAlgorithm === 'flow') {
      this.communicatePheromonesFlow(ant);
    } else {
      this.communicatePheromonesScored(ant);
    }
  }

  /** 'legacy' and 'gradient': both share the same "snap directly to whichever nearby cell
   * scores best, and only overwrite a cell if you'd raise its score" mechanic — that decisive,
   * immediate-commitment behavior is what makes it work. They differ only in what "score"
   * means:
   *  - 'legacy': raw frame-time. A lead is exactly as good as it ever was until something
   *    newer replaces it — simple, but stale leads can linger and mislead indefinitely.
   *  - 'gradient': frame-time run through exponential decay, so a lead quietly loses
   *    authority the longer it goes unrefreshed, and an ant's own contribution is scaled by
   *    how recently *it* personally confirmed the resource. This is the one piece of realism
   *    (evaporation) the original was missing, without touching the mechanic that actually
   *    makes foraging work. */
  private communicatePheromonesScored(ant: Ant): void {
    const useDecay = this.config.pheromoneAlgorithm === 'gradient';
    const [gx, gy] = this.grid.worldToGrid(ant.position.x, ant.position.y);

    for (const [dx, dy] of GRID_COM_SCAN) {
      const info = this.grid.get(gx + dx, gy + dy).pheromones[ant.lookingFor];
      const score = useDecay ? readPheromoneStrength(info, this.frame, this.config.pheromoneDecayPerFrame) : info.time;
      if (score > ant.maxLeadScore) {
        ant.maxLeadScore = score;
        ant.direction = directionTo(ant.position, info.where, ant.direction);
        ant.informedUntil = this.frame + this.config.antInformedWindow;
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

  /** 'flow': each cell holds a decaying direction *vector* per interest — built from the
   * headings of ants who walked through it while seeking that interest — instead of a
   * remembered coordinate. Followers align with the summed vector from their neighborhood
   * rather than beelining for a stored point, which is what lets a trail curve around
   * obstacles and lets multiple simultaneous trails coexist without needing to track which
   * source each one leads to.
   *
   * Deposits go onto *both* interests every time, like legacy/gradient, not just the one the
   * ant is currently seeking — an ant heading toward its current goal is, by construction,
   * heading *away* from the one it just left, so that heading reversed is exactly the useful
   * direction to advertise for the other channel. Depositing only the current-goal channel
   * misses the single freshest, most useful moment there is: right when an ant discovers a
   * resource, `lookingFor` has already flipped to the *other* interest before this runs, so
   * an ant that finds food gets immediately gated out of ever mentioning it via that path. */
  private communicatePheromonesFlow(ant: Ant): void {
    const [gx, gy] = this.grid.worldToGrid(ant.position.x, ant.position.y);
    const decay = this.config.pheromoneDecayPerFrame;

    let pull: Vector2 = { x: 0, y: 0 };
    for (const [dx, dy] of GRID_COM_SCAN) {
      const info = this.grid.get(gx + dx, gy + dy).pheromones[ant.lookingFor];
      pull = add(pull, readPheromoneFlow(info, this.frame, decay));
    }
    const strength = length(pull);
    if (strength > 0) {
      const confidence = Math.min(1, strength / this.config.pheromoneSaturation);
      const blended = add(scale(ant.direction, 1 - confidence), scale(normalize(pull, ant.direction), confidence));
      ant.direction = normalize(blended, ant.direction);
      if (confidence > 0.3) {
        ant.informedUntil = this.frame + this.config.antInformedWindow;
      }
    }

    if (ant.pheromonesWrite) {
      for (const interest of INTERESTS) {
        const lastSeen = ant.lastTimeSeen[interest];
        if (lastSeen < 0) continue;
        const personalFreshness = decay ** (this.frame - lastSeen);
        const depositAmount = this.config.pheromoneDepositAmount * personalFreshness;
        const heading = interest === ant.lookingFor ? ant.direction : scale(ant.direction, -1);
        const info = this.grid.get(gx, gy).pheromones[interest];
        const decayedFlow = readPheromoneFlow(info, this.frame, decay);
        const updatedFlow = add(decayedFlow, scale(heading, depositAmount));
        // cap magnitude so the field never "freezes": without this, 1500 ants constantly
        // depositing (decay is slow relative to traffic) push magnitude into the hundreds,
        // at which point a single ant's fresh deposit (<=1) is too small to ever correct
        // whatever direction got baked in during the early, noisy bootstrap phase.
        // capping at *4 still let the field drift into an unrecoverable state over 10k+
        // frames (peaked then decayed back to zero); capping right at pheromoneSaturation —
        // the point beyond which magnitude does nothing extra for confidence or the overlay
        // anyway — keeps a single fresh deposit a much larger fraction of the total, so the
        // field stays meaningfully correctable indefinitely
        const updatedMagnitude = length(updatedFlow);
        const maxMagnitude = this.config.pheromoneSaturation;
        info.flow = updatedMagnitude > maxMagnitude ? scale(updatedFlow, maxMagnitude / updatedMagnitude) : updatedFlow;
        info.lastUpdated = this.frame;
      }
    } else if (this.frame >= ant.pheromonesBackTime) {
      enablePheromonesWrite(ant);
    }
  }
}
