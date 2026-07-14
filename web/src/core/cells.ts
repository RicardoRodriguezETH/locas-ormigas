import type { Ant } from './ant';
import { resetPositionMemory, taskFound } from './ant';
import type { SimConfig } from './config';
import type { Vector2 } from './vector';

export type CellType = 'grass' | 'food' | 'cave' | 'portal';

export interface CellContext {
  frame: number;
  config: SimConfig;
}

export interface Cell {
  readonly type: CellType;
  affectAnt(ant: Ant, ctx: CellContext): void;
}

export class GrassCell implements Cell {
  readonly type = 'grass';
  friction = 0.8;

  affectAnt(ant: Ant, _ctx: CellContext): void {
    ant.friction = this.friction;
  }
}

/** L. niger runs a generalist, dual-resource diet: honeydew solicited from tended aphids
 * (mostly carbohydrate, a renewable trickle from a living aphid colony) and hunted/scavenged
 * insect prey (mostly protein, a one-off item that's fully consumed). Nutrient amounts here are
 * a game-balance approximation, not a cited figure — real aphid-colony/prey yields vary hugely —
 * but the type split and the fact that a source is a finite quantity, not an inexhaustible tile,
 * are both true to how these colonies actually forage. Not yet wired to deplete on harvest (see
 * `FoodCell.affectAnt`) — that's a bigger behavioral change deferred to a later pass so it can
 * be paired with source respawning/rediscovery instead of just letting the colony starve once
 * the stress-test map's two fixed sources run dry. */
export type FoodType = 'honeydew' | 'prey';

const FOOD_NUTRIENTS_MAX: Record<FoodType, number> = {
  honeydew: 4000,
  prey: 800,
};

export class FoodCell implements Cell {
  readonly type = 'food';
  readonly foodType: FoodType;
  readonly nutrientsMax: number;
  /** Remaining nutrients. Only actually consumed (and thus depleting) for `perishable` food —
   * the two main sources are effectively bottomless, but a corpse is a small finite meal. */
  nutrients: number;
  /** True for corpse food: each pickup consumes a nutrient, and the cell is removed once empty
   * (see `Simulation.interactionWithCells`). */
  readonly perishable: boolean;
  /** A dead ant left where it fell, foraged like any other food but finite and rendered as a
   * corpse rather than a food blob. */
  readonly isCorpse: boolean;
  /** True once any ant has actually reached this source — gates it as a scent origin for the
   * 'diffusion' pheromone algorithm (see `Simulation.interactionWithCells`/`WorldGrid.diffuseScent`).
   * Undiscovered food doesn't "smell" yet, matching how the other algorithms also require a real
   * sighting before any info propagates — the field isn't omniscient. */
  discovered = false;

  constructor(foodType: FoodType = 'honeydew', opts: { nutrients?: number; perishable?: boolean; isCorpse?: boolean } = {}) {
    this.foodType = foodType;
    this.nutrientsMax = opts.nutrients ?? FOOD_NUTRIENTS_MAX[foodType];
    this.nutrients = this.nutrientsMax;
    this.perishable = opts.perishable ?? false;
    this.isCorpse = opts.isCorpse ?? false;
  }

  affectAnt(ant: Ant, ctx: CellContext): void {
    if (ant.lookingFor !== 'food') return;
    if (this.perishable && this.nutrients <= 0) return; // picked clean; nothing left to take
    ant.cargo.count = ant.cargo.capacity;
    // 'legacy' faithfully never resets this (see Simulation.communicatePheromonesClassic) — every
    // other algorithm resets it because a fresh goal deserves to be receptive to any lead again.
    if (ctx.config.pheromoneAlgorithm !== 'legacy') ant.maxLeadScore = 0;
    // 'integration' only (harmless bookkeeping otherwise): "desired volume" recruitment is an
    // all-or-none per-trip decision biased by food quality, not automatic — see
    // SimConfig.integrationRecruitBaseProbability/integrationRecruitQualityBonus.
    ant.lastFoodQuality = this.nutrientsMax > 0 ? this.nutrients / this.nutrientsMax : 1;
    const recruitProbability = ctx.config.integrationRecruitBaseProbability + ctx.config.integrationRecruitQualityBonus * ant.lastFoodQuality;
    ant.recruitsThisTrip = Math.random() < recruitProbability;
    taskFound(ant, ctx.config, ctx.frame);
    if (this.perishable) this.nutrients -= 1;
  }
}

export class CaveCell implements Cell {
  readonly type = 'cave';
  /** See `FoodCell.discovered` — set once any ant has actually reached the cave. */
  discovered = false;

  affectAnt(ant: Ant, ctx: CellContext): void {
    if (ant.lookingFor !== 'cave') return;
    ant.cargo.count = 0;
    // see the matching comment in FoodCell.affectAnt
    if (ctx.config.pheromoneAlgorithm !== 'legacy') ant.maxLeadScore = 0;
    taskFound(ant, ctx.config, ctx.frame);
  }
}

/** Frames an ant ignores a portal it just stepped out of, so it doesn't bounce straight back. */
const PORTAL_COOLDOWN_FRAMES = 30;

export class PortalCell implements Cell {
  readonly type = 'portal';
  readonly color: 'blue' | 'orange';
  /** World position of this portal's tile center. */
  position: Vector2 = { x: 0, y: 0 };
  gridX = 0;
  gridY = 0;
  link: PortalCell | null = null;

  constructor(color: 'blue' | 'orange') {
    this.color = color;
  }

  affectAnt(ant: Ant, ctx: CellContext): void {
    if (!this.link) return;
    if (ant.teleportedOnFrame !== null && ctx.frame - ant.teleportedOnFrame <= PORTAL_COOLDOWN_FRAMES) return;
    // `position` is the linked tile's corner (matching how it's placed on the grid); step out
    // into the middle of that tile rather than right on its edge.
    const half = ctx.config.mapGridSize / 2;
    ant.position = { x: this.link.position.x + half, y: this.link.position.y + half };
    resetPositionMemory(ant, ant.position);
    ant.teleportedOnFrame = ctx.frame;
  }
}

/** Portals pair up in creation order: blue, then the next one becomes orange and links back
 * to it; the one after that starts a fresh (initially unlinked) blue, and so on. */
export class PortalFactory {
  private last: PortalCell | null = null;

  create(): PortalCell {
    let portal: PortalCell;
    if (!this.last || this.last.color === 'orange') {
      portal = new PortalCell('blue');
    } else {
      portal = new PortalCell('orange');
      portal.link = this.last;
      this.last.link = portal;
    }
    this.last = portal;
    return portal;
  }
}
