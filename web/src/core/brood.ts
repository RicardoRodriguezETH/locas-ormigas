import type { SimConfig } from './config';
import type { Vector2 } from './vector';

export type BroodStage = 'egg' | 'larva' | 'pupa';

/** A single egg/larva/pupa. Laid at the queen's position, then carried by a nurse ant to the
 * nursery chamber (see `Simulation.stepUndergroundAnt`'s brood-carry branch) rather than piling
 * up at the queen's feet — real colonies keep egg-laying and brood-rearing in separate chambers
 * and continuously relocate brood between them (for climate control, and away from disturbance).
 * Once settled in the nursery it stays put for the rest of its development; only the initial
 * queen-chamber-to-nursery trip is modeled. */
export interface Brood {
  stage: BroodStage;
  position: Vector2;
  ageDays: number;
  /** Accumulated feeding while a larva — see `SimConfig.larvaNutritionNeeded`. Irrelevant for
   * eggs/pupae, which don't feed. */
  nutritionReceived: number;
  /** True while some ant's `carriedBrood` currently points at this item — excludes it from
   * being picked up a second time mid-carry. */
  beingCarried: boolean;
  /** True once a nurse has delivered this item to the nursery chamber. Newly-laid eggs start
   * false (still sitting where the queen laid them) and are eligible for pickup. */
  atNursery: boolean;
}

export function createEgg(position: Vector2): Brood {
  return { stage: 'egg', position: { ...position }, ageDays: 0, nutritionReceived: 0, beingCarried: false, atNursery: false };
}

/** Creates a brood item already partway through development, for seeding an *established*
 * colony at init — same idea as sampling a spread of adult ages rather than starting everyone
 * newborn (see `Simulation.init`). `totalAgeDays` is age measured from egg-laying across the
 * whole egg→larva→pupa timeline; the stage and within-stage age are derived from it, and any
 * larva is treated as already fed (an established nursery keeps its larvae fed). Marked
 * `atNursery` since it's placed directly in the nursery, not carried there. */
export function createSeededBrood(position: Vector2, totalAgeDays: number, cfg: SimConfig): Brood {
  const eggEnd = cfg.eggDurationDays;
  const larvaEnd = eggEnd + cfg.larvaDurationDays;
  let stage: BroodStage;
  let ageDays: number;
  let nutritionReceived = 0;
  if (totalAgeDays < eggEnd) {
    stage = 'egg';
    ageDays = totalAgeDays;
  } else if (totalAgeDays < larvaEnd) {
    stage = 'larva';
    ageDays = totalAgeDays - eggEnd;
    nutritionReceived = cfg.larvaNutritionNeeded;
  } else {
    stage = 'pupa';
    ageDays = totalAgeDays - larvaEnd;
  }
  return { stage, position: { ...position }, ageDays, nutritionReceived, beingCarried: false, atNursery: true };
}

export function advanceBroodAge(brood: Brood, cfg: SimConfig): void {
  brood.ageDays += 1 / cfg.framesPerDay;
}

/** Feeds a larva from the colony's food store, if there's any to give — caller is responsible
 * for actually deducting `foodStored` by the same amount (kept as a pure function here so the
 * colony-level bookkeeping stays visible in `Simulation`, not buried in this module). Returns
 * how much was actually fed (0 if not a larva, already fully fed, or nothing to feed with). */
export function feedLarva(brood: Brood, cfg: SimConfig, foodAvailable: number): number {
  if (brood.stage !== 'larva') return 0;
  const remaining = cfg.larvaNutritionNeeded - brood.nutritionReceived;
  if (remaining <= 0) return 0;
  const amount = Math.min(cfg.larvaFeedRatePerFrame, remaining, foodAvailable);
  brood.nutritionReceived += amount;
  return amount;
}

/** Advances egg -> larva -> pupa on age (and, for larvae, accumulated feeding); returns true
 * once a pupa is ready to eclose into an adult worker (caller removes it from the brood list
 * and spawns a new callow `Ant` in its place — see `Simulation`). */
export function tryAdvanceBroodStage(brood: Brood, cfg: SimConfig): boolean {
  if (brood.stage === 'egg' && brood.ageDays >= cfg.eggDurationDays) {
    brood.stage = 'larva';
    brood.ageDays = 0;
    return false;
  }
  if (brood.stage === 'larva' && brood.ageDays >= cfg.larvaDurationDays && brood.nutritionReceived >= cfg.larvaNutritionNeeded) {
    brood.stage = 'pupa';
    brood.ageDays = 0;
    return false;
  }
  if (brood.stage === 'pupa' && brood.ageDays >= cfg.pupaDurationDays) {
    return true; // ready to eclose
  }
  return false;
}

/** The colony's single egg-layer. Stays fixed in her chamber. */
export interface Queen {
  position: Vector2;
  ageDays: number;
  /** Frame of her next egg-laying attempt (or retry, if the previous attempt lacked food). */
  nextEggAttemptFrame: number;
}

export function createQueen(position: Vector2): Queen {
  return { position: { ...position }, ageDays: 0, nextEggAttemptFrame: 0 };
}
