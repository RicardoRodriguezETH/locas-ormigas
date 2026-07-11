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
  taskFound,
  updateActivityCycle,
  updateAnt,
  updateRestingMovement,
} from './ant';
import { type Brood, type Queen, advanceBroodAge, createEgg, createQueen, feedLarva, tryAdvanceBroodStage } from './brood';
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
  queenChamberPosition: Vector2 = { x: 0, y: 0 };
  nurseryChamberPosition: Vector2 = { x: 0, y: 0 };
  queen: Queen = createQueen(this.queenChamberPosition);
  brood: Brood[] = [];
  /** Colony-wide stored food, fed by underground-delivered cargo and spent on egg-laying and
   * larva feeding — see `Simulation.beginUndergroundDelivery`/`updateQueenAndBrood`. */
  foodStored = 0;
  /** Roughly how many underground ants exist right now — used by `stepUndergroundAnt`'s dig-
   * target check. Not perfectly live (ants now dynamically descend/ascend, see
   * `beginUndergroundDelivery`/`ascendToSurface`), but close enough for a soft growth cap;
   * updated whenever a descend/ascend actually happens rather than recounted every frame. */
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
    const { queenChamberXg, queenChamberYg, nurseryChamberXg, nurseryChamberYg } =
      this.undergroundGrid.seedStarterNest(caveGx, caveGy);
    const half = this.config.mapGridSize / 2;
    this.queenChamberPosition = add(this.undergroundGrid.gridToWorldOrigin(queenChamberXg, queenChamberYg), { x: half, y: half });
    this.nurseryChamberPosition = add(this.undergroundGrid.gridToWorldOrigin(nurseryChamberXg, nurseryChamberYg), { x: half, y: half });
    this.queen = createQueen(this.queenChamberPosition);
    this.brood = [];
    this.foodStored = 0;

    this.ants = [];
    this.undergroundAntCount = 0;
    for (let i = 1; i <= numAnts; i++) {
      const isUnderground = Math.random() < this.config.antUndergroundFraction;
      const direction = fromAngle(Math.random() * Math.PI * 2);
      // spawn clustered around the actual colony entrance, not the unrelated world origin —
      // otherwise every ant starts already outside resting range of its own nest
      const position = isUnderground ? { ...this.cavePosition } : add(this.cavePosition, scale(direction, 50 + i / 60));
      const ant = createAnt(this.config, position, direction, 0, isUnderground ? 'underground' : 'surface');
      if (isUnderground) {
        this.undergroundAntCount++;
        // staggered, same as every other underground ant — this fixed initial population isn't
        // a permanent caste, it cycles back to the surface like anyone else (see ascendToSurface)
        ant.undergroundDutyUntil = Math.round(randomInRange(this.config.antUndergroundDutyDaysRange) * this.config.framesPerDay);
      }
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
    const targetVolume = this.undergroundAntCount * this.config.antUndergroundVolumePerAnt;
    this.undergroundGrid.ensureDesignatedFrontier(this.config.antUndergroundDesignationPoolSize, targetVolume);
    this.updateQueenAndBrood();
    this.frame += 1;
  }

  private respawnAtHome(ant: Ant): void {
    const direction = fromAngle(Math.random() * Math.PI * 2);
    const position = ant.layer === 'underground' ? { ...this.cavePosition } : add(this.cavePosition, scale(direction, 50));
    respawnAsCallow(ant, this.config, position, direction);
  }

  /** Underground behavior. Four modes, checked in order:
   * 1. Carrying a delivery (`deliveringUnderground`): steer straight for the queen chamber
   *    and deposit on arrival — see `beginUndergroundDelivery`.
   * 2. Carrying brood (`carriedBrood`): steer for the nursery chamber and settle it there on
   *    arrival — see `tryPickUpBrood`/`stepBroodCarry`. Finishing a carry takes priority over
   *    resurfacing, same as a food delivery does.
   * 3. Duty shift over (`frame >= undergroundDutyUntil`, and not mid-delivery/carry): resurface.
   * 4. Otherwise, debugging-phase filler behavior: wander the dug tunnel network, opportunistically
   *    picking up any loose brood passed along the way, and digging out the colony's current
   *    designated site(s) if bumped into (see `UndergroundGrid.ensureDesignatedFrontier`) — no
   *    pheromones, no rest cycle. Ants bumping into a plain, non-designated wall just turn away;
   *    they can't opportunistically eat through arbitrary dirt, only ever the colony's current
   *    designated growth site(s). */
  private stepUndergroundAnt(ant: Ant): void {
    if (ant.deliveringUnderground) {
      this.stepUndergroundDelivery(ant);
      return;
    }
    if (ant.carriedBrood) {
      this.stepBroodCarry(ant);
      return;
    }
    if (this.frame >= ant.undergroundDutyUntil) {
      this.ascendToSurface(ant);
      return;
    }
    if (this.tryPickUpBrood(ant)) return; // starts carrying next frame

    const erratic = this.config.antUndergroundErratic;
    ant.direction = rotate(ant.direction, erratic * Math.random() - erratic * 0.5);

    const speed = this.config.antUndergroundSpeed;
    const nextPosition = add(ant.position, scale(ant.direction, speed));

    if (this.undergroundGrid.canPass(nextPosition)) {
      ant.position = nextPosition;
      ant.traveled += speed;
      return;
    }

    const [xg, yg] = this.undergroundGrid.worldToGrid(nextPosition.x, nextPosition.y);
    if (this.undergroundGrid.canDig(xg, yg)) {
      // correctly positioned at a valid dig site — keep the heading and keep trying frame to
      // frame rather than randomizing away on every failed roll, otherwise an ant that happens
      // to reach the one designated cell almost never accumulates enough consecutive attempts
      // to actually win the roll before wandering off again
      if (Math.random() < this.config.antUndergroundDigChance) {
        this.undergroundGrid.dig(xg, yg);
        ant.position = nextPosition;
        ant.traveled += speed;
      }
    } else {
      // genuinely blocked by a static, non-diggable wall — turn away
      ant.direction = fromAngle(Math.random() * Math.PI * 2);
    }
  }

  /** Steers `ant` one leg at a time along `path` (a queue of dug-tunnel waypoints, see
   * `UndergroundGrid.findPath`), rather than steering straight at the final target — a direct
   * line usually cuts through undug walls the moment the target isn't a straight shot away
   * (down a corridor, then around a corner into a branch chamber, say), which is the normal
   * case here. Shared by cargo delivery and brood-carrying, which both need identical
   * wall-deviation/arrival-tolerance handling. Returns true once `path` is empty (arrived, or
   * there was never a route), so the caller can wrap up (deposit cargo, settle brood, etc). */
  private followPath(ant: Ant, path: Vector2[], speed: number): boolean {
    if (path.length === 0) return true;

    const waypoint = path[0];
    // steer from this cell's own center, not the ant's raw (possibly off-center) position —
    // keeps the intended heading exactly aligned with the corridor (often just 1 cell wide)
    // instead of occasionally clipping a corner wall when the ant isn't perfectly centered
    const [cxg, cyg] = this.undergroundGrid.worldToGrid(ant.position.x, ant.position.y);
    const half = this.config.mapGridSize / 2;
    const cellCenter = add(this.undergroundGrid.gridToWorldOrigin(cxg, cyg), { x: half, y: half });
    const toward = directionTo(cellCenter, waypoint, ant.direction);

    // try the ideal heading, then progressively wider deviations either side, so a single
    // blocked frame can't freeze the ant solid recomputing the exact same blocked heading
    // forever (position and target unchanged -> same "toward" -> same block, every frame)
    const deviations = [0, 0.3, -0.3, 0.7, -0.7, 1.2, -1.2];
    for (const angle of deviations) {
      const candidate = rotate(toward, angle);
      const nextPosition = add(ant.position, scale(candidate, speed));
      if (this.undergroundGrid.canPass(nextPosition)) {
        ant.direction = candidate;
        ant.position = nextPosition;
        ant.traveled += speed;
        break;
      }
    }

    // generous arrival tolerance, scaled to the grid cell itself (not to per-frame speed, which
    // was tight enough — well under 1 world unit against 16-unit cells — that the ant could
    // orbit near a waypoint indefinitely without ever landing precisely inside it)
    if (distance(ant.position, waypoint) < half) {
      path.shift();
    }
    return path.length === 0;
  }

  private stepUndergroundDelivery(ant: Ant): void {
    if (this.followPath(ant, ant.deliveryPath, this.config.antUndergroundSpeed)) {
      ant.cargo.count = 0;
      ant.deliveringUnderground = false;
      this.foodStored += 1;
    }
  }

  /** Opportunistically notices any loose brood (not already being carried, not yet at the
   * nursery) within `broodCarryNoticeRadius` of a wandering underground ant and picks up the
   * nearest one — like the rest of underground behavior, this is "stumble upon," not a
   * colony-wide assignment system. Returns true if a carry was started this frame. */
  private tryPickUpBrood(ant: Ant): boolean {
    let nearest: Brood | null = null;
    let nearestDist = this.config.broodCarryNoticeRadius;
    for (const b of this.brood) {
      if (b.beingCarried || b.atNursery) continue;
      const d = distance(ant.position, b.position);
      if (d < nearestDist) {
        nearest = b;
        nearestDist = d;
      }
    }
    if (!nearest) return false;

    nearest.beingCarried = true;
    ant.carriedBrood = nearest;
    ant.broodCarryPath = this.undergroundGrid.findPath(ant.position, this.nurseryChamberPosition) ?? [];
    return true;
  }

  /** Carries `ant.carriedBrood` toward the nursery chamber, dragging its `position` along with
   * the ant so it visibly travels rather than teleporting on arrival. Settles it into the
   * nursery (with a little scatter so brood doesn't all stack on one point) once the route is
   * complete. */
  private stepBroodCarry(ant: Ant): void {
    const brood = ant.carriedBrood!;
    const arrived = this.followPath(ant, ant.broodCarryPath, this.config.antUndergroundSpeed);
    brood.position = { ...ant.position };

    if (arrived) {
      const scatter = scale(fromAngle(Math.random() * Math.PI * 2), Math.random() * this.config.mapGridSize * 0.3);
      brood.position = add(this.nurseryChamberPosition, scatter);
      brood.atNursery = true;
      brood.beingCarried = false;
      ant.carriedBrood = null;
      ant.broodCarryPath = [];
    }
  }

  /** A cargo-carrying ant reaching the surface cave descends to physically deliver the food
   * underground rather than it vanishing at the surface — see `interactionWithCells`. Cargo is
   * intentionally *not* cleared yet; it clears on arrival at the queen chamber (see
   * `stepUndergroundDelivery`). */
  private beginUndergroundDelivery(ant: Ant): void {
    ant.maxLeadScore = 0;
    taskFound(ant, this.config, this.frame); // flips lookingFor/nextTask back to 'food' for when it resurfaces
    ant.layer = 'underground';
    ant.deliveringUnderground = true;
    ant.position = { ...this.cavePosition }; // 1:1 coordinates with the surface entrance
    ant.deliveryPath = this.undergroundGrid.findPath(ant.position, this.queenChamberPosition) ?? [];
    ant.paused = false;
    ant.undergroundDutyUntil = this.frame + Math.round(randomInRange(this.config.antUndergroundDutyDaysRange) * this.config.framesPerDay);
    this.undergroundAntCount++;
  }

  /** End of an underground duty shift: back to the surface to resume foraging. */
  private ascendToSurface(ant: Ant): void {
    const direction = fromAngle(Math.random() * Math.PI * 2);
    ant.layer = 'surface';
    ant.position = add(this.cavePosition, scale(direction, 50));
    ant.direction = direction;
    ant.speed = 0.1;
    ant.paused = false;
    ant.restAt = this.frame + randomInRange(this.config.antActiveDurationRange);
    this.undergroundAntCount = Math.max(0, this.undergroundAntCount - 1);
  }

  /** Queen egg-laying and brood (egg/larva/pupa) aging, feeding, and stage transitions. Runs
   * once per frame after ants have moved. See `SimConfig`'s brood-economy doc comment for the
   * numbers used and what's a real citation vs. a game-balance approximation. */
  private updateQueenAndBrood(): void {
    const cfg = this.config;
    this.queen.ageDays += 1 / cfg.framesPerDay;

    if (this.frame >= this.queen.nextEggAttemptFrame) {
      const populationCap = cfg.numAnts * cfg.populationCapMultiplier;
      if (this.ants.length < populationCap && this.foodStored >= cfg.queenEggFoodCost) {
        this.foodStored -= cfg.queenEggFoodCost;
        this.brood.push(createEgg(this.queen.position));
        this.queen.nextEggAttemptFrame = this.frame + randomInRange(cfg.queenEggCooldownFramesRange);
      } else {
        this.queen.nextEggAttemptFrame = this.frame + cfg.queenEggRetryFrames;
      }
    }

    for (let i = this.brood.length - 1; i >= 0; i--) {
      const b = this.brood[i];
      advanceBroodAge(b, cfg);
      if (b.stage === 'larva') {
        this.foodStored -= feedLarva(b, cfg, this.foodStored);
      }
      if (tryAdvanceBroodStage(b, cfg)) {
        // pupa ready to eclose: remove from brood, spawn a fresh callow worker in its place
        this.brood.splice(i, 1);
        const direction = fromAngle(Math.random() * Math.PI * 2);
        const newAnt = createAnt(cfg, b.position, direction, 0, 'underground');
        newAnt.undergroundDutyUntil = this.frame + Math.round(randomInRange(cfg.antUndergroundDutyDaysRange) * cfg.framesPerDay);
        this.ants.push(newAnt);
        this.undergroundAntCount++;
      }
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
    if (ant.layer === 'underground') return; // just descended — the rest of this is surface-only

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
      ant.lastTimeSeen.cave = this.frame;
      this.beginUndergroundDelivery(ant); // physically carries the food down rather than it vanishing here
      return;
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
