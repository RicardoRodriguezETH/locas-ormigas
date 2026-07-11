import {
  type Ant,
  advanceAge,
  createAnt,
  enablePheromonesWrite,
  getLifeStage,
  isComNeeded,
  objectAvoidance,
  pause,
  randomInRange,
  respawnAsCallow,
  updateActivityCycle,
  updateAnt,
  updateRestingMovement,
} from './ant';
import { GRID_COM_SCAN, INTERESTS, type SimConfig, defaultConfig } from './config';
import { type PaintableCellType, WorldGrid, readPheromoneFlow, readPheromoneStrength } from './grid';
import { UndergroundGrid } from './underground';
import { add, directionTo, distance, fromAngle, length, normalize, rotate, scale, type Vector2 } from './vector';

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
  readonly undergroundGrid: UndergroundGrid;
  ants: Ant[] = [];
  frame = 0;
  cavePosition: Vector2 = { x: 0, y: 0 };
  /** Fixed at init (nothing currently moves ants between layers) — cached rather than
   * recounted every frame since it's used by every underground ant's dig-target check. */
  private undergroundAntCount = 0;

  /** Colony-level foraging throttle state — see `SimConfig.antForagingThrottle*`. Fast/slow EMAs
   * of colony-wide deliveries/frame; `foragingThrottle` is their clamped ratio, recomputed once
   * per frame and applied to every ant's activity cycle that frame. */
  deliveryEmaFast = 0;
  deliveryEmaSlow = 0;
  foragingThrottle = 1;
  private deliveriesThisFrame = 0;

  /** How strong the food-trail pheromone reads near the cave right now (0-1) — drives
   * recruitment of resting ants (see `SimConfig.antRecruitmentWakeGain`). Recomputed once per
   * frame from the just-updated grid, used by the *next* frame's activity-cycle checks (same
   * one-frame lag as `foragingThrottle`, negligible at 60fps). */
  caveFoodSignal = 0;

  constructor(config: SimConfig = defaultConfig, options: SimulationOptions = {}) {
    this.config = config;
    this.grid = new WorldGrid(config, { randomize: options.randomizeGrid ?? true });
    this.undergroundGrid = new UndergroundGrid(config);
  }

  init(numAnts: number = this.config.numAnts): void {
    const caveGx = -6;
    const caveGy = -4;
    this.grid.seedCell('cave', caveGx, caveGy);
    this.cavePosition = add(this.grid.gridToWorldOrigin(caveGx, caveGy), scale({ x: this.config.mapGridSize, y: this.config.mapGridSize }, 0.5));
    this.buildZigzagStressTestMap();
    // pre-built starter nest rather than an empty seed — see UndergroundGrid.seedStarterNest
    this.undergroundGrid.seedStarterNest(caveGx, caveGy);

    this.ants = [];
    this.undergroundAntCount = 0;
    for (let i = 1; i <= numAnts; i++) {
      const isUnderground = Math.random() < this.config.antUndergroundFraction;
      const direction = fromAngle(Math.random() * Math.PI * 2);
      // spawn clustered around the actual colony entrance, not the unrelated world origin —
      // otherwise every ant starts already outside resting range of its own nest
      const position = isUnderground ? { ...this.cavePosition } : add(this.cavePosition, scale(direction, 50 + i / 60));
      const ant = createAnt(this.config, position, direction, 0, isUnderground ? 'underground' : 'surface');
      if (isUnderground) this.undergroundAntCount++;
      // an established colony has a natural mix of ages, not a nursery of identical newborns —
      // sample uniformly up to this ant's own sampled lifespan (most land well past the callow
      // threshold, a few land young, matching a real standing age structure)
      ant.ageDays = Math.random() * ant.naturalLifespanDays;
      // only a small scouting party starts out foraging — the rest of the colony stays put at
      // the nest until recruited by a real trail (caveFoodSignal, see update()), with this long
      // range purely as a fallback so the colony isn't dormant forever if nothing is ever found
      if (!isUnderground && Math.random() >= this.config.antInitialActiveFraction) {
        pause(ant, 0, randomInRange(this.config.antInitialRestDurationRange));
      }
      this.ants.push(ant);
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

    // one honeydew source (aphid trophobiosis, the carb staple), one prey item (protein) —
    // mirroring L. niger's real dual-resource foraging strategy rather than two identical tiles
    const lastWallX = WALLS[WALLS.length - 1].x;
    this.grid.seedCell('food', originX + lastWallX + 4, originY + 2, 'honeydew');
    this.grid.seedCell('food', originX + lastWallX + 4, originY + WALL_REGION_HEIGHT - 3, 'prey');
  }

  update(): void {
    this.deliveriesThisFrame = 0;

    for (const ant of this.ants) {
      advanceAge(ant, this.config);
      if (ant.ageDays >= ant.naturalLifespanDays) {
        this.respawnAtHome(ant);
      }

      const isCallow = getLifeStage(ant, this.config) === 'callow';
      // pale/soft-bodied teneral coloring while callow, full color once mature
      ant.color = isCallow ? [220, 220, 220] : [255, 255, 255];

      if (ant.layer === 'underground') {
        this.stepUndergroundAnt(ant);
        continue;
      }

      const eligibleToRest = ant.cargo.count === 0 && distance(ant.position, this.cavePosition) <= this.config.antRestTetherRadius;
      updateActivityCycle(ant, this.config, this.frame, eligibleToRest, this.foragingThrottle, this.caveFoodSignal, isCallow);
      if (ant.paused) {
        this.stepRestingAnt(ant);
      } else {
        this.stepAnt(ant);
      }
    }
    for (const ant of this.ants) {
      if (ant.layer === 'surface') updateAnt(ant, this.config, this.frame);
    }

    this.updateForagingThrottle();
    this.caveFoodSignal = this.computeCaveFoodSignal();
    this.frame += 1;
  }

  private respawnAtHome(ant: Ant): void {
    const direction = fromAngle(Math.random() * Math.PI * 2);
    const position = ant.layer === 'underground' ? { ...this.cavePosition } : add(this.cavePosition, scale(direction, 50));
    respawnAsCallow(ant, this.config, position, direction);
  }

  /** Debugging-phase underground behavior: wander the dug tunnel network, occasionally digging
   * out adjacent dirt to expand it when blocked — no pheromones, no rest cycle, no foraging.
   * Digging is capped by `antUndergroundVolumePerAnt` so the nest grows proportionally with the
   * underground population rather than without bound (see config doc). */
  private stepUndergroundAnt(ant: Ant): void {
    const erratic = this.config.antUndergroundErratic;
    ant.direction = rotate(ant.direction, erratic * Math.random() - erratic * 0.5);

    const speed = this.config.antUndergroundSpeed;
    const nextPosition = add(ant.position, scale(ant.direction, speed));

    if (this.undergroundGrid.canPass(nextPosition)) {
      ant.position = nextPosition;
      ant.traveled += speed;
      return;
    }

    const targetVolume = this.undergroundAntCount * this.config.antUndergroundVolumePerAnt;
    const canGrow = this.undergroundGrid.dugCount() < targetVolume;
    if (canGrow && Math.random() < this.config.antUndergroundDigChance) {
      const [xg, yg] = this.undergroundGrid.worldToGrid(nextPosition.x, nextPosition.y);
      this.undergroundGrid.dig(xg, yg);
      ant.position = nextPosition;
      ant.traveled += speed;
    } else {
      ant.direction = fromAngle(Math.random() * Math.PI * 2);
    }
  }

  /** Strength of the 'food' trail in the cave's immediate neighborhood, normalized to [0, 1] —
   * the strongest reading among the cave cell and its 8 neighbors (same neighborhood ants
   * themselves scan), algorithm-aware like everything else pheromone-related. */
  private computeCaveFoodSignal(): number {
    const [cgx, cgy] = this.grid.worldToGrid(this.cavePosition.x, this.cavePosition.y);
    const isFlow = this.config.pheromoneAlgorithm === 'flow';
    const decay = this.config.pheromoneDecayPerFrame;

    let maxStrength = 0;
    for (const [dx, dy] of GRID_COM_SCAN) {
      const info = this.grid.get(cgx + dx, cgy + dy).pheromones.food;
      const strength = isFlow ? length(readPheromoneFlow(info, this.frame, decay)) : readPheromoneStrength(info, this.frame, decay);
      if (strength > maxStrength) maxStrength = strength;
    }
    return Math.min(1, maxStrength / this.config.pheromoneSaturation);
  }

  /** Recomputes the fast/slow delivery-rate EMAs from this frame's tally and derives next
   * frame's throttle from their ratio (see `SimConfig.antForagingThrottle*` for the biological
   * rationale). Runs once per frame, after all ants have moved. */
  private updateForagingThrottle(): void {
    const cfg = this.config;
    this.deliveryEmaFast = this.deliveryEmaFast * cfg.antForagingThrottleFastDecay + this.deliveriesThisFrame * (1 - cfg.antForagingThrottleFastDecay);
    this.deliveryEmaSlow = this.deliveryEmaSlow * cfg.antForagingThrottleSlowDecay + this.deliveriesThisFrame * (1 - cfg.antForagingThrottleSlowDecay);

    if (this.deliveryEmaSlow < cfg.antForagingThrottleWarmupRate) {
      this.foragingThrottle = 1; // no established baseline yet — stay neutral rather than react to noise
      return;
    }
    const ratio = this.deliveryEmaFast / this.deliveryEmaSlow;
    this.foragingThrottle = Math.min(cfg.antForagingThrottleMax, Math.max(cfg.antForagingThrottleMin, ratio));
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

    if (cell.type === 'cave' && ant.lookingFor === 'cave') {
      this.deliveriesThisFrame++; // about to complete a food->cave round trip
    }
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
