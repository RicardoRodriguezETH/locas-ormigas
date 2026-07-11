import type { SimConfig } from './config';
import type { Vector2 } from './vector';

export type BroodStage = 'egg' | 'larva' | 'pupa';

/** A single egg/larva/pupa. Stays put where it's laid — real colonies constantly relocate
 * brood between chambers for temperature/humidity (brood transport), not modeled here. */
export interface Brood {
  stage: BroodStage;
  position: Vector2;
  ageDays: number;
  /** Accumulated feeding while a larva — see `SimConfig.larvaNutritionNeeded`. Irrelevant for
   * eggs/pupae, which don't feed. */
  nutritionReceived: number;
}

export function createEgg(position: Vector2): Brood {
  return { stage: 'egg', position: { ...position }, ageDays: 0, nutritionReceived: 0 };
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
