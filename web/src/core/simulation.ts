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
import { CaveCell, FoodCell, type FoodType } from './cells';
import { type PaintableCellType, type SerializedGridCell, WorldGrid, readPheromoneFlow, readPheromoneStrength } from './grid';
import { UndergroundGrid } from './underground';
import { add, directionTo, distance, fromAngle, length, normalize, rotate, scale, type Vector2 } from './vector';

export interface SimulationOptions {
  /** Sprinkle a little random grass/rubble across the map on init. Tests usually want this off. */
  randomizeGrid?: boolean;
}

/** Base map: two food sources, each tucked inside a three-sided wall pocket that hides it from
 * the nest so reaching it takes real foraging (weave around the pocket, then in through the gap)
 * rather than a beeline — a light challenge for the pheromone systems without being a labyrinth.
 * Grid coords, relative to the cave at (-6,-4). */
const FOOD_SITES: ReadonlyArray<{ xg: number; yg: number; type: FoodType }> = [
  { xg: 11, yg: -9, type: 'honeydew' }, // aphid trophobiosis, the carb staple
  { xg: 9, yg: 11, type: 'prey' }, // protein
];
const FOOD_POCKET_RADIUS = 3;
const GRASS_PATCHES = 22;
/** 'gameplay' mode's founding colony size — see `Simulation.initGameplay`. A handful of workers
 * rather than a literal lone ant: enough that early foraging isn't entirely hostage to one
 * individual's random wander before anything can be found at all. */
const GAMEPLAY_STARTING_ANTS = 5;

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

/** `Ant`, but `carriedBrood`/`fetchingBrood` are indices into `SaveData.brood` instead of direct
 * object references — both are shared references into `Simulation.brood` in the live game (the
 * same item is reachable from `brood[]` *and* from whichever ant is carrying/fetching it), which
 * plain JSON has no way to express; an index lets `Simulation.loadSaveData` reconnect the same
 * shared reference on the other side instead of silently forking two independent copies. */
export interface SerializedAnt extends Omit<Ant, 'carriedBrood' | 'fetchingBrood'> {
  carriedBroodIndex: number | null;
  fetchingBroodIndex: number | null;
}

/** Everything needed to exactly resume a running `Simulation` later — see
 * `Simulation.toSaveData`/`fromSaveData`. Deliberately excludes pheromone trail data and
 * `history` (both transient/derived — see `WorldGrid.exportModifiedCells`'s doc comment) and the
 * per-frame `deliveriesThisFrame` accumulator (reset every frame anyway). */
export interface SaveData {
  version: 1;
  config: SimConfig;
  gameMode: GameMode;
  frame: number;
  cavePosition: Vector2;
  queenChamberPosition: Vector2;
  nurseryChamberPosition: Vector2;
  larderPosition: Vector2;
  queen: Queen;
  brood: Brood[];
  foodStored: number;
  initialPopulation: number;
  undergroundAntCount: number;
  deliveryEmaFast: number;
  deliveryEmaSlow: number;
  foragingThrottle: number;
  totalDeliveries: number;
  caveFoodSignal: number;
  ants: SerializedAnt[];
  gridCells: SerializedGridCell[];
  foodIsFinite: boolean;
  dugCells: Array<[number, number]>;
}

/** Owns the ant colony and drives the pheromone-following behavior each frame: move, react to
 * the tile underfoot, then read/write trail info in the surrounding grid cells. */
export type GameMode = 'testing' | 'gameplay';

export class Simulation {
  readonly config: SimConfig;
  readonly grid: WorldGrid;
  readonly undergroundGrid: UndergroundGrid;
  /** 'testing': an established colony (see `init`) with effectively-bottomless food, for
   * comparing pheromone algorithms on equal footing. 'gameplay' (see `initGameplay`): a true
   * founding colony — the queen and a small starting party of workers — with finite food, for
   * actually playing. Purely informational to most of the simulation (both modes run the exact
   * same update loop); only
   * `WorldGrid.foodIsFinite` and the two init paths themselves read it. */
  gameMode: GameMode = 'testing';
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
  /** Lifetime food->cave delivery count — a plain running total, unlike the EMAs above which are
   * deliberately smoothed/decayed for the throttle. Used by the pheromone-algorithm benchmark
   * (see `core/benchmark.ts`) to score a run's throughput. */
  totalDeliveries = 0;

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

  /** 'testing' mode: an established colony (see `gameMode`'s doc comment), same as this class
   * has always seeded — kept exactly as-is so existing benchmarks/tests are unaffected. */
  init(numAnts: number = this.config.numAnts): void {
    this.gameMode = 'testing';
    this.grid.foodIsFinite = false;
    this.setupMapAndNest();
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
      // range purely as a fallback so the colony isn't dormant forever if nothing is ever found.
      // Part of the same activity-cycle system 'legacy' skips entirely (see update()) — pausing
      // any of its ants here would leave them stuck forever, since nothing ever unpauses them.
      if (!isUnderground && this.config.pheromoneAlgorithm !== 'legacy' && Math.random() >= this.config.antInitialActiveFraction) {
        pause(ant, 0, randomInRange(this.config.antInitialRestDurationRange));
      }
      this.ants.push(ant);
    }
    this.initialPopulation = this.ants.length;
    this.seedEstablishedBrood();
  }

  /** 'gameplay' mode: a true founding colony on the same prebuilt map/nest as `init`, instead of
   * an established-colony snapshot — just the queen and a small starting party of workers, no
   * seeded brood, and finite food (`WorldGrid.foodIsFinite`). Everything from here on grows
   * purely through the queen's own egg-laying. The reproduction cap still targets a *full-size*
   * colony (`config.numAnts`), not literally "1.3x the handful of starting ants" —
   * `initialPopulation` is the cap's basis (see `updateQueenAndBrood`), not a record of how many
   * ants actually spawned, so it's set to the design target directly rather than to
   * `this.ants.length`. */
  initGameplay(): void {
    this.gameMode = 'gameplay';
    this.grid.foodIsFinite = true;
    this.setupMapAndNest();
    this.queen = createQueen(this.queenChamberPosition);
    this.brood = [];
    this.foodStored = 0;
    this.history = [];

    this.ants = [];
    for (let i = 0; i < GAMEPLAY_STARTING_ANTS; i++) {
      const direction = fromAngle(Math.random() * Math.PI * 2);
      // a little scatter around the entrance rather than perfectly stacked, same idea as init's
      // clustered surface spawn
      const position = add(this.cavePosition, scale(direction, 2 + i));
      this.ants.push(createAnt(this.config, position, direction, 0, 'surface'));
    }
    this.undergroundAntCount = 0;
    this.initialPopulation = this.config.numAnts;
  }

  /** Cave placement, the two hidden food pockets + grass, and the pre-built starter nest
   * (queen/nursery/larder chambers) — shared by both `init` and `initGameplay`; they only differ
   * in how the *colony itself* (ants/brood/food) is seeded on top of this same map. */
  private setupMapAndNest(): void {
    const caveGx = -6;
    const caveGy = -4;
    this.grid.seedCell('cave', caveGx, caveGy);
    this.cavePosition = add(this.grid.gridToWorldOrigin(caveGx, caveGy), scale({ x: this.config.mapGridSize, y: this.config.mapGridSize }, 0.5));
    this.buildBaseMap(caveGx, caveGy);
    // pre-built starter nest rather than an empty seed — see UndergroundGrid.seedStarterNest
    const { queenChamberXg, queenChamberYg, nurseryChamberXg, nurseryChamberYg, larderChamberXg, larderChamberYg } =
      this.undergroundGrid.seedStarterNest(caveGx, caveGy);
    const half = this.config.mapGridSize / 2;
    this.queenChamberPosition = add(this.undergroundGrid.gridToWorldOrigin(queenChamberXg, queenChamberYg), { x: half, y: half });
    this.nurseryChamberPosition = add(this.undergroundGrid.gridToWorldOrigin(nurseryChamberXg, nurseryChamberYg), { x: half, y: half });
    this.larderPosition = add(this.undergroundGrid.gridToWorldOrigin(larderChamberXg, larderChamberYg), { x: half, y: half });
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

  /** Seeds the two food sources, each hidden inside a wall pocket, plus scattered grass. Grid
   * coords are relative to the cave (passed in) so the layout tracks the nest. */
  private buildBaseMap(caveXg: number, caveYg: number): void {
    for (const site of FOOD_SITES) {
      const fx = caveXg + site.xg;
      const fy = caveYg + site.yg;
      this.buildFoodPocket(fx, fy, caveXg, caveYg);
      this.grid.seedCell('food', fx, fy, site.type);
    }
    this.seedGrassPatches();
  }

  /** Walls three sides of a box around a food tile, leaving the gap on the edge facing *away*
   * from the cave — so the food is obscured and an ant has to circle around the pocket and come
   * in from the far side rather than walking straight to it. */
  private buildFoodPocket(fx: number, fy: number, caveXg: number, caveYg: number): void {
    const r = FOOD_POCKET_RADIUS;
    // which border edge to leave open: the one on the far side of the food from the cave, along
    // whichever axis the cave is further away on
    const dxFromCave = fx - caveXg;
    const dyFromCave = fy - caveYg;
    const openAxisX = Math.abs(dxFromCave) >= Math.abs(dyFromCave);
    const openSign = openAxisX ? Math.sign(dxFromCave) : Math.sign(dyFromCave);

    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // border cells only
        // leave a 3-cell gap centered on the open edge
        const onOpenEdge = openAxisX
          ? dx === openSign * r && Math.abs(dy) <= 1
          : dy === openSign * r && Math.abs(dx) <= 1;
        if (onOpenEdge) continue;
        const cell = this.grid.get(fx + dx, fy + dy);
        cell.pass = false;
        cell.cell = null;
      }
    }
  }

  /** Scatters small grass patches (clusters, not lone tiles) across the open map for texture. */
  private seedGrassPatches(): void {
    const { minXg, maxXg, minYg, maxYg } = this.grid;
    for (let i = 0; i < GRASS_PATCHES; i++) {
      const cx = minXg + Math.floor(Math.random() * (maxXg - minXg + 1));
      const cy = minYg + Math.floor(Math.random() * (maxYg - minYg + 1));
      const spread = 1 + Math.floor(Math.random() * 3);
      for (let dx = -spread; dx <= spread; dx++) {
        for (let dy = -spread; dy <= spread; dy++) {
          if (dx * dx + dy * dy <= spread * spread && Math.random() < 0.55) {
            this.grid.seedGrass(cx + dx, cy + dy);
          }
        }
      }
    }
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

      // 'legacy' faithfully never rests — the original's ant.pause() exists but its only call
      // site is commented out, so its ants forage continuously forever. Skipping the activity
      // cycle entirely leaves `ant.paused` at its permanent default of false.
      if (this.config.pheromoneAlgorithm !== 'legacy') {
        const eligibleToRest = ant.cargo.count === 0 && distance(ant.position, this.cavePosition) <= this.config.antRestTetherRadius;
        updateActivityCycle(ant, this.config, this.frame, eligibleToRest, this.foragingThrottle, this.caveFoodSignal, isCallow);
      }
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
    // relax the scent field after this frame's movement/discovery, before it's read for the cave
    // signal below and, next frame, by every diffusion-following ant.
    if (this.config.pheromoneAlgorithm === 'diffusion') this.grid.diffuseScent(this.config);
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
    if (ant.fetchingBrood) ant.fetchingBrood.beingCarried = false; // release the claim so another nurse can take it
    if (ant.deliveringUnderground && ant.cargo.count > 0) this.foodStored += 1;
    if (ant.layer === 'underground') {
      this.undergroundAntCount = Math.max(0, this.undergroundAntCount - 1);
    } else {
      this.dropCorpse(ant);
    }
  }

  /** Leaves a corpse where a surface ant died: a small, *finite* food source (unlike the two
   * main sources) that foragers can carry off, after which it's picked clean and removed. Skips
   * cells that already hold something important (a wall, the cave, another food) so a corpse
   * never clobbers the map; landing on grass is fine to overwrite. */
  private dropCorpse(ant: Ant): void {
    const [gx, gy] = this.grid.worldToGrid(ant.position.x, ant.position.y);
    if (!this.grid.isInsideGrid(gx, gy)) return;
    const cell = this.grid.get(gx, gy);
    if (!cell.pass) return;
    if (cell.cell && cell.cell.type !== 'grass') return;
    cell.cell = new FoodCell('prey', { nutrients: this.config.corpseNutrients, perishable: true, isCorpse: true });
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

  /** Underground behavior. Modes, checked in order:
   * 1. Carrying a delivery (`deliveringUnderground`): steer for the larder chamber and deposit
   *    on arrival — see `beginUndergroundDelivery`.
   * 2. Carrying brood (`carriedBrood`): steer for the nursery chamber and settle it there on
   *    arrival — see `stepBroodCarry`. Finishing a carry takes priority over resurfacing.
   * 3. Fetching brood (`fetchingBrood`): walk to a claimed loose brood item, then pick it up and
   *    switch to carrying it — see `tryBecomeNurse`/`stepFetchBrood`.
   * 4. Already walking out (`headingToSurface`): keep following the route back to the entrance
   *    and resurface on arrival — see `beginHeadingToSurface`/`stepHeadToExit`.
   * 5. Duty shift just ended (`frame >= undergroundDutyUntil`, and not mid-delivery/carry/fetch):
   *    start walking back to the entrance rather than resurfacing instantly from wherever the
   *    ant happens to be — ants only ever cross layers by actually reaching the hole.
   * 6. Loose brood exists: become a nurse and go fetch it (`tryBecomeNurse`).
   * 7. Otherwise: wander the dug tunnel network, digging out the colony's current designated
   *    site(s) if bumped into (see `UndergroundGrid.ensureDesignatedFrontier`) — no pheromones,
   *    no rest cycle. Ants bumping into a plain, non-designated wall just turn away;
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
    if (ant.fetchingBrood) {
      this.stepFetchBrood(ant);
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
    if (this.tryBecomeNurse(ant)) return; // walks to fetch the brood next frame

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

  /** Turns an idle underground ant into a nurse: if any loose brood exists (laid at the queen,
   * not yet moved to the nursery and not already claimed by another nurse), it claims the nearest
   * one and starts walking to fetch it. Self-limiting — each brood item is claimed by exactly one
   * nurse (via `beingCarried`), so the colony fields as many nurses as there is brood to move and
   * no more, and eggs get relayed to the nursery promptly instead of piling up at the queen.
   * Returns true if the ant became a nurse this frame. */
  private tryBecomeNurse(ant: Ant): boolean {
    let nearest: Brood | null = null;
    let nearestDist = Infinity;
    for (const b of this.brood) {
      if (b.beingCarried || b.atNursery) continue;
      const d = distance(ant.position, b.position);
      if (d < nearestDist) {
        nearest = b;
        nearestDist = d;
      }
    }
    if (!nearest) return false;

    // claim it: excludes it from other nurses, and (since eclosion is deferred while
    // `beingCarried`) keeps it waiting at the queen until this nurse arrives to pick it up
    nearest.beingCarried = true;
    ant.fetchingBrood = nearest;
    ant.fetchPath = this.undergroundGrid.findPath(ant.position, nearest.position) ?? [];
    return true;
  }

  /** Walks a nurse to the loose brood it claimed, then takes it in its mandibles and switches to
   * carrying it to the nursery. */
  private stepFetchBrood(ant: Ant): void {
    const brood = ant.fetchingBrood!;
    if (brood.atNursery || !this.brood.includes(brood)) {
      // it was settled or removed out from under us — abandon and go back to being idle
      ant.fetchingBrood = null;
      ant.fetchPath = [];
      return;
    }
    if (this.followPath(ant, ant.fetchPath, this.config.antUndergroundSpeed)) {
      ant.carriedBrood = brood;
      ant.broodCarryPath = this.undergroundGrid.findPath(ant.position, this.nurseryChamberPosition) ?? [];
      ant.fetchingBrood = null;
      ant.fetchPath = [];
    }
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

  /** Ant has physically reached the entrance: it emerges *at the cave hole* and walks outward.
   * Deliberately placed right on the cave tile, not offset out into the open — a returning
   * forager and (especially) a freshly-eclosed worker popping into existence a few tiles away
   * from the nest read as ants randomly spawning around the colony. Coming out of the hole and
   * walking out reads as what it is: emerging from the nest. The resting cluster already sits
   * here, so briefly overlapping it is invisible. */
  private ascendToSurface(ant: Ant): void {
    ant.layer = 'surface';
    ant.position = { ...this.cavePosition };
    ant.direction = fromAngle(Math.random() * Math.PI * 2); // walk out in some outward direction
    ant.speed = this.config.antMaxSpeed * 0.5; // a little push so it clears the entrance
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
    const algorithm = this.config.pheromoneAlgorithm;
    const decay = this.config.pheromoneDecayPerFrame;

    if (algorithm === 'diffusion') {
      let maxScent = 0;
      for (const [dx, dy] of GRID_COM_SCAN) {
        const scent = this.grid.get(cgx + dx, cgy + dy).pheromones.food.scent;
        if (scent > maxScent) maxScent = scent;
      }
      return Math.min(1, maxScent / this.config.diffusionSourceStrength);
    }

    let maxStrength = 0;
    for (const [dx, dy] of GRID_COM_SCAN) {
      const info = this.grid.get(cgx + dx, cgy + dy).pheromones.food;
      const strength = algorithm === 'flow' ? length(readPheromoneFlow(info, this.frame, decay)) : readPheromoneStrength(info, this.frame, decay);
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
    // few frames" snapshot mechanic. 'diffusion' doesn't deposit at all (the field self-propagates
    // from pinned sources) but still wants every-frame *reads* for smooth continuous gradient
    // following rather than a jerky re-steer every few frames.
    const isEveryFrameAlgorithm = this.config.pheromoneAlgorithm === 'flow' || this.config.pheromoneAlgorithm === 'diffusion';
    const shouldCommunicate = isEveryFrameAlgorithm || this.config.antComEveryFrame || isComNeeded(ant, this.frame);
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
      this.totalDeliveries++;
      ant.lastTimeSeen.cave = this.frame;
      (cell as CaveCell).discovered = true;
      this.beginUndergroundDelivery(ant); // physically carries the food down rather than it vanishing here
      return;
    }
    cell.affectAnt(ant, { frame: this.frame, config: this.config });
    if (cell.type === 'food' || cell.type === 'cave') {
      ant.lastTimeSeen[cell.type] = this.frame;
      (cell as FoodCell | CaveCell).discovered = true;
    }
    // a corpse (or any perishable food) that's been picked clean disappears
    if (cell.type === 'food' && (cell as FoodCell).perishable && (cell as FoodCell).nutrients <= 0) {
      this.grid.removeCell(xg, yg);
    }
  }

  /** Ants never talk to each other directly; they leave/read pheromone info on the grid cell
   * they're standing on. Dispatches to whichever algorithm is configured. */
  private communicatePheromones(ant: Ant): void {
    if (this.config.pheromoneAlgorithm === 'legacy') {
      this.communicatePheromonesClassic(ant);
    } else if (this.config.pheromoneAlgorithm === 'flow') {
      this.communicatePheromonesFlow(ant);
    } else if (this.config.pheromoneAlgorithm === 'diffusion') {
      this.communicatePheromonesDiffusion(ant);
    } else {
      this.communicatePheromonesScored(ant);
    }
  }

  /** 'legacy': a literal, deliberately-unfixed port of the original Löve2D/Lua game's pheromone
   * algorithm (`sim.algorithm_pheromones` in the original `code/simulation.lua`) — the true
   * baseline every other algorithm here departed from, kept around specifically so 'legacy' vs
   * 'legacy+' can benchmark how much all of that departure was actually worth. Three things,
   * all still present, all later identified as the problem and fixed for everything else:
   *  - Steering is the original's `ant.headTo(...)`: hard-snap straight onto the remembered lead
   *    point, no blend cap.
   *  - Re-steering is gated by `maxLeadScore` (the original's `ant.maxTimeSeen`) — a per-ant
   *    high-water mark that only ever rises, and is *never* reset (not even on a goal switch;
   *    see the `pheromoneAlgorithm !== 'legacy'` guards in `FoodCell`/`CaveCell.affectAnt`).
   *    Once an ant has locked onto a strong enough lead, anything weaker becomes permanently
   *    invisible to it — this is the exact "went effectively deaf, drifted home by random walk"
   *    mechanic `communicatePheromonesScored`'s doc comment describes fixing. Left in on purpose
   *    here, not a bug.
   *  - No blend, no scout-vs-recruited erratic-wander split (`informedUntil` is never touched
   *    here, so `updateAnt` always falls through to the single constant `antErraticSearching`,
   *    matching the original's one `cfg.antErratic`), and no rest/idle cycle — see the
   *    `updateActivityCycle` guard in `update()`; the original's `ant.pause()` exists but its
   *    only call site is commented out, so its ants forage continuously forever. */
  private communicatePheromonesClassic(ant: Ant): void {
    const [gx, gy] = this.grid.worldToGrid(ant.position.x, ant.position.y);

    for (const [dx, dy] of GRID_COM_SCAN) {
      const info = this.grid.get(gx + dx, gy + dy).pheromones[ant.lookingFor];
      if (info.time > ant.maxLeadScore) {
        ant.maxLeadScore = info.time;
        ant.direction = directionTo(ant.position, info.where, ant.direction);
      }
    }

    this.depositRawFrameTime(ant, gx, gy);
  }

  /** 'legacy+' and 'gradient': both share the same "snap directly to whichever nearby cell
   * scores best, and only overwrite a cell if you'd raise its score" mechanic — that decisive,
   * immediate-commitment behavior is what makes it work. They differ only in what "score"
   * means:
   *  - 'legacy+': raw frame-time. A lead is exactly as good as it ever was until something
   *    newer replaces it — simple, but stale leads can linger and mislead indefinitely.
   *  - 'gradient': frame-time run through exponential decay, so a lead quietly loses
   *    authority the longer it goes unrefreshed, and an ant's own contribution is scaled by
   *    how recently *it* personally confirmed the resource. This is the one piece of realism
   *    (evaporation) 'legacy+' was missing, without touching the mechanic that actually makes
   *    foraging work.
   *
   * Both are 'legacy' (see `communicatePheromonesClassic`) with the two fixes that mattered
   * most, measured: recompute the *current* best lead in the neighborhood every communication
   * instead of gating on a persistent high-water mark that goes stale and never resets (an ant
   * went effectively deaf to the field after its first commit and drifted home by random walk —
   * trails never tightened, laden ants stayed spread ~150u from the ideal line), and steer by
   * BLENDING toward it instead of hard-snapping (hard-snapping onto a point only ~1 cell back
   * makes ants orbit that point and stall — with re-evaluation on, throughput collapsed;
   * blending a fraction of the way there each cycle glides the ant along the trail instead). */
  private communicatePheromonesScored(ant: Ant): void {
    const useDecay = this.config.pheromoneAlgorithm === 'gradient';
    const [gx, gy] = this.grid.worldToGrid(ant.position.x, ant.position.y);

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

    if (useDecay) {
      if (ant.pheromonesWrite) {
        for (const interest of INTERESTS) {
          const lastSeen = ant.lastTimeSeen[interest];
          if (lastSeen < 0) continue;
          const info = this.grid.get(gx, gy).pheromones[interest];
          const candidateScore = this.config.pheromoneDecayPerFrame ** (this.frame - lastSeen);
          const existingScore = readPheromoneStrength(info, this.frame, this.config.pheromoneDecayPerFrame);
          if (candidateScore <= existingScore) continue;
          info.strength = candidateScore;
          info.lastUpdated = this.frame;
          info.where = { ...ant.oldestPositionRemembered };
        }
      } else if (this.frame >= ant.pheromonesBackTime) {
        enablePheromonesWrite(ant);
      }
    } else {
      this.depositRawFrameTime(ant, gx, gy);
    }
  }

  /** Raw frame-time deposit shared by 'legacy' and 'legacy+' (the two algorithms that score on
   * time directly rather than a decayed/vector/scent field): overwrite a cell's lead for an
   * interest only if this ant's own sighting of it is fresher than what's already stored there. */
  private depositRawFrameTime(ant: Ant, gx: number, gy: number): void {
    if (!ant.pheromonesWrite) {
      if (this.frame >= ant.pheromonesBackTime) enablePheromonesWrite(ant);
      return;
    }
    for (const interest of INTERESTS) {
      const lastSeen = ant.lastTimeSeen[interest];
      if (lastSeen < 0) continue;
      const info = this.grid.get(gx, gy).pheromones[interest];
      if (lastSeen <= info.time) continue;
      info.time = lastSeen;
      info.strength = this.config.pheromoneDepositAmount; // for the debug overlay only
      info.lastUpdated = this.frame;
      info.where = { ...ant.oldestPositionRemembered };
    }
  }

  /** 'flow': each cell holds a decaying direction *vector* per interest — built from the
   * headings of ants who walked through it while seeking that interest — instead of a
   * remembered coordinate. Followers align with the local vector rather than beelining for a
   * stored point, which is what lets a trail curve around obstacles and lets multiple
   * simultaneous trails coexist without needing to track which source each one leads to.
   *
   * Two things needed fixing before this actually worked (measured: deliveries went from ~20,
   * *worse* than no guidance at all, to within the same order of magnitude as legacy/gradient):
   *  - Read only the ant's own cell, not a sum across the 3x3 neighborhood. Unlike legacy/
   *    gradient's "keep only the single freshest sighting" scoring, flow's cells accumulate
   *    (decaying) vector *sums* from every ant that passed through — summing that across 9 cells
   *    let conflicting headings from different discovery events partially cancel into a smeared,
   *    sometimes actively-wrong resultant, worst right at busy hubs like the cave/food.
   *  - The deposited heading is captured *before* this function's own pull-read rotates
   *    `ant.direction`. Using the post-read direction created a same-frame read-then-write loop:
   *    an ant would steer toward whatever the field said, then immediately write that
   *    already-steered heading back into the same cell it just read, reinforcing noise instead
   *    of reporting independent travel history.
   *  - Steering is still blend-capped like legacy/gradient (`pheromoneLeadBlend`), not
   *    hard-snapped: even with the two fixes above, an uncapped turn rate reliably converged
   *    worse (more laden ants stuck wandering) than a capped one, in every run tested. */
  private communicatePheromonesFlow(ant: Ant): void {
    const [gx, gy] = this.grid.worldToGrid(ant.position.x, ant.position.y);
    const decay = this.config.pheromoneDecayPerFrame;
    // captured before the pull-read below rotates ant.direction — see doc comment
    const incomingDirection = { x: ant.direction.x, y: ant.direction.y };

    const pull = readPheromoneFlow(this.grid.get(gx, gy).pheromones[ant.lookingFor], this.frame, decay);
    const strength = length(pull);
    if (strength > 0) {
      const confidence = Math.min(1, strength / this.config.pheromoneSaturation);
      const b = Math.min(confidence, this.config.pheromoneLeadBlend);
      const blended = add(scale(ant.direction, 1 - b), scale(normalize(pull, ant.direction), b));
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
        const heading = interest === ant.lookingFor ? incomingDirection : scale(incomingDirection, -1);
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

  /** 'diffusion': unlike the other three, ants never write anything here — the field is
   * entirely self-maintaining (see `WorldGrid.diffuseScent`), shaped by the passable-cell graph
   * and pinned at discovered sources. An ant just estimates the local gradient from the scent at
   * its 8 surrounding cells (a finite-difference stand-in for sensing a concentration difference
   * across its own body, the way a real ant's antennae work) and blend-steers up it — same
   * `pheromoneLeadBlend`-capped mechanic as every other algorithm, for the same reason: an
   * uncapped snap onto a locally noisy gradient orbits and stalls instead of arriving.
   *
   * Because the field already bends around walls (it only diffuses through passable cells), this
   * gradient is obstacle-aware without any explicit path search — an ant on the far side of a
   * wall pocket reads a gradient that already curves in through the gap, rather than pointing
   * straight through the wall the way legacy/gradient's remembered-point dead reckoning does. */
  private communicatePheromonesDiffusion(ant: Ant): void {
    const [gx, gy] = this.grid.worldToGrid(ant.position.x, ant.position.y);
    const field = ant.lookingFor;
    const ownScent = this.grid.get(gx, gy).pheromones[field].scent;

    let gradient = { x: 0, y: 0 };
    for (const [dx, dy] of GRID_COM_SCAN) {
      if (dx === 0 && dy === 0) continue;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const neighborScent = this.grid.get(gx + dx, gy + dy).pheromones[field].scent;
      const rate = (neighborScent - ownScent) / dist; // per-unit-distance rise toward this neighbor
      gradient = add(gradient, scale({ x: dx / dist, y: dy / dist }, rate));
    }

    const strength = length(gradient);
    if (strength > 0) {
      const confidence = Math.min(1, ownScent / this.config.diffusionSourceStrength);
      const b = Math.min(confidence, this.config.pheromoneLeadBlend);
      const blended = add(scale(ant.direction, 1 - b), scale(normalize(gradient, ant.direction), b));
      ant.direction = normalize(blended, ant.direction);
      if (confidence > 0.3) {
        ant.informedUntil = this.frame + this.config.antInformedWindow;
      }
    }
  }

  /** Snapshots everything needed to exactly resume this colony later — see `SaveData`'s doc
   * comment for what's deliberately left out. Pure/read-only: doesn't touch `this` at all. */
  toSaveData(): SaveData {
    const broodIndex = new Map<Brood, number>(this.brood.map((b, i) => [b, i]));
    const ants: SerializedAnt[] = this.ants.map((ant) => {
      const { carriedBrood, fetchingBrood, ...rest } = ant;
      return {
        ...rest,
        carriedBroodIndex: carriedBrood ? (broodIndex.get(carriedBrood) ?? null) : null,
        fetchingBroodIndex: fetchingBrood ? (broodIndex.get(fetchingBrood) ?? null) : null,
      };
    });

    return {
      version: 1,
      config: this.config,
      gameMode: this.gameMode,
      frame: this.frame,
      cavePosition: this.cavePosition,
      queenChamberPosition: this.queenChamberPosition,
      nurseryChamberPosition: this.nurseryChamberPosition,
      larderPosition: this.larderPosition,
      queen: this.queen,
      brood: this.brood,
      foodStored: this.foodStored,
      initialPopulation: this.initialPopulation,
      undergroundAntCount: this.undergroundAntCount,
      deliveryEmaFast: this.deliveryEmaFast,
      deliveryEmaSlow: this.deliveryEmaSlow,
      foragingThrottle: this.foragingThrottle,
      totalDeliveries: this.totalDeliveries,
      caveFoodSignal: this.caveFoodSignal,
      ants,
      gridCells: this.grid.exportModifiedCells(),
      foodIsFinite: this.grid.foodIsFinite,
      dugCells: this.undergroundGrid.exportDugCells(),
    };
  }

  /** Reconstructs a fully-running `Simulation` from `toSaveData`'s output. A static factory
   * rather than an instance method: `config` is `readonly`, set once at construction, so there's
   * no "load into an existing instance" — a save's config has to be threaded through `new
   * Simulation(...)` itself before the rest of the state can be restored on top. */
  static fromSaveData(data: SaveData): Simulation {
    const sim = new Simulation(data.config, { randomizeGrid: false });
    sim.loadSaveData(data);
    return sim;
  }

  private loadSaveData(data: SaveData): void {
    this.gameMode = data.gameMode;
    this.frame = data.frame;
    this.cavePosition = data.cavePosition;
    this.queenChamberPosition = data.queenChamberPosition;
    this.nurseryChamberPosition = data.nurseryChamberPosition;
    this.larderPosition = data.larderPosition;
    this.queen = data.queen;
    this.brood = data.brood;
    this.foodStored = data.foodStored;
    this.initialPopulation = data.initialPopulation;
    this.undergroundAntCount = data.undergroundAntCount;
    this.deliveryEmaFast = data.deliveryEmaFast;
    this.deliveryEmaSlow = data.deliveryEmaSlow;
    this.foragingThrottle = data.foragingThrottle;
    this.totalDeliveries = data.totalDeliveries;
    this.caveFoodSignal = data.caveFoodSignal;
    this.history = [];

    this.grid.foodIsFinite = data.foodIsFinite;
    this.grid.importModifiedCells(data.gridCells);
    this.undergroundGrid.importDugCells(data.dugCells);

    this.ants = data.ants.map((saved) => {
      const { carriedBroodIndex, fetchingBroodIndex, ...rest } = saved;
      return {
        ...rest,
        carriedBrood: carriedBroodIndex !== null ? this.brood[carriedBroodIndex] : null,
        fetchingBrood: fetchingBroodIndex !== null ? this.brood[fetchingBroodIndex] : null,
      };
    });
  }
}
