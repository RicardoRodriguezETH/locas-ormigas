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
  taskFound,
  updateActivityCycle,
  updateAnt,
  updateRestingMovement,
} from './ant';
import { type Brood, type Queen, advanceBroodAge, createEgg, createQueen, createSeededBrood, feedLarva, tryAdvanceBroodStage } from './brood';
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

/** One point in `Simulation.history` — a cheap scalar snapshot for the stats overlay's trend
 * charts, sampled every `HISTORY_SAMPLE_INTERVAL_FRAMES` frames regardless of whether that
 * overlay is currently visible, so opening it later still shows the colony's real history
 * rather than starting from a blank chart. */
export interface HistorySample {
  frame: number;
  population: number;
  foodStored: number;
  foragingThrottle: number;
  dugCount: number;
}
const HISTORY_SAMPLE_INTERVAL_FRAMES = 30;
/** Caps memory/redraw cost — old samples fall off the front as new ones are appended. */
const HISTORY_MAX_SAMPLES = 400;

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
  /** Where delivering foragers actually walk to and deposit cargo — see `seedStarterNest` doc
   * comment for why this is a separate chamber from the queen's. */
  larderPosition: Vector2 = { x: 0, y: 0 };
  queen: Queen = createQueen(this.queenChamberPosition);
  brood: Brood[] = [];
  /** Colony-wide stored food, fed by underground-delivered cargo and spent on egg-laying and
   * larva feeding — see `Simulation.beginUndergroundDelivery`/`updateQueenAndBrood`. */
  foodStored = 0;
  /** Number of ants spawned at `init` — the base the reproduction cap is measured against (see
   * `updateQueenAndBrood`), so a colony started with fewer ants (e.g. the reduced mobile count)
   * caps proportionally rather than always against the config default. */
  private initialPopulation = 0;
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

  /** Rolling history for the stats overlay's trend charts — see `HistorySample`. */
  history: HistorySample[] = [];

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
    const { queenChamberXg, queenChamberYg, nurseryChamberXg, nurseryChamberYg, larderChamberXg, larderChamberYg } =
      this.undergroundGrid.seedStarterNest(caveGx, caveGy);
    const half = this.config.mapGridSize / 2;
    this.queenChamberPosition = add(this.undergroundGrid.gridToWorldOrigin(queenChamberXg, queenChamberYg), { x: half, y: half });
    this.nurseryChamberPosition = add(this.undergroundGrid.gridToWorldOrigin(nurseryChamberXg, nurseryChamberYg), { x: half, y: half });
    this.larderPosition = add(this.undergroundGrid.gridToWorldOrigin(larderChamberXg, larderChamberYg), { x: half, y: half });
    this.queen = createQueen(this.queenChamberPosition);
    this.brood = [];
    this.foodStored = 0;
    this.history = [];

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
        ant.undergroundDutyUntil = this.randomDutyFrames();
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
    this.initialPopulation = this.ants.length;
    this.seedEstablishedBrood();
  }

  /** Seeds the nursery with brood already spread across all developmental stages, plus a little
   * starting food — the same "established colony, not a fresh founding" idea used for the adult
   * age spread just above. Without this the colony starts with an empty brood pipeline and zero
   * food, so nothing can eclose until food slowly accumulates (~10k frames at low populations)
   * *and* a full egg->adult development runs (16.8k frames): the first new worker wouldn't appear
   * for ~20k frames (minutes of real time, more on a low-framerate phone), leaving the population
   * visibly frozen at its starting count the whole time. Seeding a spread of in-progress brood
   * makes new workers start eclosing within the first minute and keeps a steady trickle after. */
  private seedEstablishedBrood(): void {
    const cfg = this.config;
    // enough for the queen to keep laying through the early game before deliveries have ramped up
    this.foodStored = cfg.queenEggFoodCost * 12;

    const totalDevDays = cfg.eggDurationDays + cfg.larvaDurationDays + cfg.pupaDurationDays;
    const count = Math.round(this.initialPopulation * cfg.seededBroodFraction);
    for (let i = 0; i < count; i++) {
      const scatter = scale(fromAngle(Math.random() * Math.PI * 2), Math.random() * cfg.mapGridSize * 0.4);
      const position = add(this.nurseryChamberPosition, scatter);
      // spread uniformly across the whole timeline so eclosions are staggered, not all at once
      this.brood.push(createSeededBrood(position, Math.random() * totalDevDays, cfg));
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
    let dead: Set<Ant> | null = null;

    for (const ant of this.ants) {
      advanceAge(ant, this.config);
      if (ant.ageDays >= ant.naturalLifespanDays) {
        // natural death: remove the ant outright. The queen's homeostatic egg-laying
        // (`updateQueenAndBrood`) replaces the loss with a worker that ecloses from the nest, so
        // the colony holds steady without the old in-place "respawn as callow" — which spawned a
        // fresh pale ant wherever each ant happened to die, reading as ants randomly popping into
        // existence all over the surface.
        this.settleDeadAnt(ant);
        (dead ??= new Set<Ant>()).add(ant);
        continue;
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
      if (ant.layer === 'surface' && !dead?.has(ant)) updateAnt(ant, this.config, this.frame);
    }

    this.updateForagingThrottle();
    this.caveFoodSignal = this.computeCaveFoodSignal();
    const targetVolume = this.undergroundAntCount * this.config.antUndergroundVolumePerAnt;
    this.undergroundGrid.ensureDesignatedFrontier(this.config.antUndergroundDesignationPoolSize, targetVolume);
    this.updateQueenAndBrood();
    if (this.foodStored > this.config.foodStorageCap) this.foodStored = this.config.foodStorageCap;
    if (dead) this.ants = this.ants.filter((a) => !dead!.has(a));
    if (this.frame % HISTORY_SAMPLE_INTERVAL_FRAMES === 0) this.recordHistorySample();
    this.frame += 1;
  }

  /** Settles an ant's in-flight state the frame it dies, before it's removed from `this.ants`:
   * release any brood it was carrying, land any delivery already counted at the cave, and keep
   * the underground headcount accurate. */
  private settleDeadAnt(ant: Ant): void {
    if (ant.carriedBrood) ant.carriedBrood.beingCarried = false;
    if (ant.deliveringUnderground && ant.cargo.count > 0) this.foodStored += 1;
    if (ant.layer === 'underground') this.undergroundAntCount = Math.max(0, this.undergroundAntCount - 1);
  }

  /** A length-of-underground-duty-shift in frames, drawn *continuously* across
   * `antUndergroundDutyDaysRange`. `randomInRange` returns whole integers, so using it for a
   * 1–3 *day* range then scaling by `framesPerDay` collapses to just {1,2,3}×framesPerDay — fine
   * for staggered events (deliveries, eclosions happen on varied frames anyway) but at init the
   * whole underground cohort shares frame 0, so quantized timers make ~a third of them march out
   * of the hole together in three synchronized waves. A continuous spread avoids that. */
  private randomDutyFrames(): number {
    const [min, max] = this.config.antUndergroundDutyDaysRange;
    return Math.round((min + Math.random() * (max - min)) * this.config.framesPerDay);
  }

  /** Appends one `HistorySample`, dropping the oldest once over `HISTORY_MAX_SAMPLES`. */
  private recordHistorySample(): void {
    this.history.push({
      frame: this.frame,
      population: this.ants.length,
      foodStored: this.foodStored,
      foragingThrottle: this.foragingThrottle,
      dugCount: this.undergroundGrid.dugCount(),
    });
    if (this.history.length > HISTORY_MAX_SAMPLES) this.history.shift();
  }

  /** Underground behavior. Five modes, checked in order:
   * 1. Carrying a delivery (`deliveringUnderground`): steer straight for the larder chamber
   *    and deposit on arrival — see `beginUndergroundDelivery`.
   * 2. Carrying brood (`carriedBrood`): steer for the nursery chamber and settle it there on
   *    arrival — see `tryPickUpBrood`/`stepBroodCarry`. Finishing a carry takes priority over
   *    resurfacing, same as a food delivery does.
   * 3. Already walking out (`headingToSurface`): keep following the route back to the entrance
   *    and resurface on arrival — see `beginHeadingToSurface`/`stepHeadToExit`.
   * 4. Duty shift just ended (`frame >= undergroundDutyUntil`, and not mid-delivery/carry):
   *    start walking back to the entrance rather than resurfacing instantly from wherever the
   *    ant happens to be — ants only ever cross layers by actually reaching the hole.
   * 5. Otherwise, debugging-phase filler behavior: wander the dug tunnel network, opportunistically
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
    if (ant.headingToSurface) {
      this.stepHeadToExit(ant);
      return;
    }
    if (this.frame >= ant.undergroundDutyUntil) {
      this.beginHeadingToSurface(ant);
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
   * intentionally *not* cleared yet; it clears on arrival at the larder (see
   * `stepUndergroundDelivery`), a chamber separate from the queen's — see `seedStarterNest`. */
  private beginUndergroundDelivery(ant: Ant): void {
    ant.maxLeadScore = 0;
    taskFound(ant, this.config, this.frame); // flips lookingFor/nextTask back to 'food' for when it resurfaces
    ant.layer = 'underground';
    ant.deliveringUnderground = true;
    ant.position = { ...this.cavePosition }; // 1:1 coordinates with the surface entrance
    ant.deliveryPath = this.undergroundGrid.findPath(ant.position, this.larderPosition) ?? [];
    ant.paused = false;
    ant.undergroundDutyUntil = this.frame + this.randomDutyFrames();
    this.undergroundAntCount++;
  }

  /** Duty shift just ended: rather than resurfacing instantly from wherever the ant happens to
   * be underground (which could be deep in the larder or nursery, or way out at the current dig
   * frontier), start walking the route back to the entrance — see `stepHeadToExit`. Keeps
   * "ants only ever cross layers by reaching the hole" literally true, not just true by
   * convention. */
  private beginHeadingToSurface(ant: Ant): void {
    ant.headingToSurface = true;
    ant.exitPath = this.undergroundGrid.findPath(ant.position, this.cavePosition) ?? [];
  }

  /** Follows `ant.exitPath` back to the entrance one leg at a time, then actually resurfaces
   * once it arrives — see `beginHeadingToSurface`. */
  private stepHeadToExit(ant: Ant): void {
    if (this.followPath(ant, ant.exitPath, this.config.antUndergroundSpeed)) {
      this.ascendToSurface(ant);
    }
  }

  /** Ant has physically reached the entrance: pop out of the hole and resume foraging. Emerges a
   * short distance out into the open rather than exactly on the cave tile so the colony doesn't
   * visibly pile up on one point — but only onto a passable tile: an unchecked offset could drop
   * the ant inside a wall (painted block, randomized rubble, the maze), which `fixTrapped` would
   * then snap up to 100 units away, a visible teleport. Tries a few directions, falling back to
   * the cave tile itself (always passable) if the surroundings are boxed in. */
  private ascendToSurface(ant: Ant): void {
    let emergePosition = { ...this.cavePosition };
    let emergeDirection = fromAngle(Math.random() * Math.PI * 2);
    for (let i = 0; i < 6; i++) {
      const dir = fromAngle(Math.random() * Math.PI * 2);
      const candidate = add(this.cavePosition, scale(dir, 50));
      if (this.grid.canPass(candidate)) {
        emergePosition = candidate;
        emergeDirection = dir;
        break;
      }
    }
    ant.layer = 'surface';
    ant.position = emergePosition;
    ant.direction = emergeDirection;
    ant.speed = 0.1;
    ant.paused = false;
    ant.headingToSurface = false;
    ant.exitPath = [];
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
      // Homeostatic laying: the queen lays to keep the *committed* colony — living workers plus
      // the brood already developing toward adulthood — near a target measured off the actual
      // starting population (so a smaller mobile colony targets proportionally lower, and it
      // never balloons past the config default). Counting in-pipeline brood is what makes this
      // stable: as workers die, `ants + brood` dips below target and she lays just enough to
      // refill the pipeline, so eclosions replace losses without over- or under-shooting.
      const target = this.initialPopulation * cfg.populationCapMultiplier;
      const committed = this.ants.length + this.brood.length;
      if (committed < target && this.foodStored >= cfg.queenEggFoodCost) {
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
      if (tryAdvanceBroodStage(b, cfg) && !b.beingCarried) {
        // pupa ready to eclose: remove from brood, spawn a fresh callow worker in its place.
        // Deferred while `beingCarried` — a pupa can cross its eclosion age mid-transport; if we
        // removed it here the carrying ant would keep a dangling reference and visibly haul
        // nothing to the nursery. `tryAdvanceBroodStage` on a ready pupa is idempotent, so it
        // simply ecloses next frame once the nurse drops it.
        this.brood.splice(i, 1);
        const direction = fromAngle(Math.random() * Math.PI * 2);
        const newAnt = createAnt(cfg, b.position, direction, 0, 'underground');
        newAnt.undergroundDutyUntil = this.frame + this.randomDutyFrames();
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

    // Re-evaluate the *current* best lead in the neighborhood every communication, then steer by
    // BLENDING toward it rather than hard-snapping. Two deliberate departures from the original,
    // both needed for trails to actually converge (measured):
    //  - The original anchored to a persistent `maxLeadScore` high-water mark and only re-steered
    //    on a strictly-fresher lead, so an ant went effectively deaf to the field after its first
    //    commit and drifted home by random walk — trails never tightened (laden ants stayed
    //    spread ~150u from the ideal line). Recomputing the best local lead each cycle keeps ants
    //    actually following the trail.
    //  - Hard-snapping the heading onto the stored `where` (a point only ~1 cell back) makes ants
    //    orbit that point and stall — with re-evaluation on, throughput collapsed. Blending a
    //    fraction of the way there each cycle glides the ant along the trail instead of orbiting.
    let bestScore = 0;
    let bestWhere: Vector2 | null = null;
    for (const [dx, dy] of GRID_COM_SCAN) {
      const info = this.grid.get(gx + dx, gy + dy).pheromones[ant.lookingFor];
      const score = useDecay ? readPheromoneStrength(info, this.frame, this.config.pheromoneDecayPerFrame) : info.time;
      if (score > bestScore) {
        bestScore = score;
        bestWhere = info.where;
      }
    }
    ant.maxLeadScore = bestScore;
    if (bestWhere) {
      const toward = directionTo(ant.position, bestWhere, ant.direction);
      const b = this.config.pheromoneLeadBlend;
      ant.direction = normalize(add(scale(ant.direction, 1 - b), scale(toward, b)), ant.direction);
      ant.informedUntil = this.frame + this.config.antInformedWindow;
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
