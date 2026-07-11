/** Things ants look for and communicate about via pheromone trails. */
export const INTERESTS = ['food', 'cave'] as const;
export type Interest = (typeof INTERESTS)[number];

/** Relative grid offsets scanned for pheromone info: self + 8 neighbors. */
export const GRID_COM_SCAN: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/** Both snap directly to whichever nearby cell has the best-scoring lead for what an ant is
 * seeking. 'legacy' scores leads by raw frame-time (never fades once written). 'gradient'
 * scores by that same time run through exponential decay (evaporates if not refreshed) — see
 * `Simulation.communicatePheromones` for both, kept side by side for comparison. */
export type PheromoneAlgorithm = 'legacy' | 'gradient';

export interface SimConfig {
  numAnts: number;
  antMaxSpeed: number;
  /** Communicate pheromone info every frame, or only on the ant's own cadence. */
  antComEveryFrame: boolean;
  /** [min, max] frames between an ant's pheromone communications. */
  antComNeedFrameStep: [number, number];
  /** Distance within which an ant can identify/avoid things. */
  antSightDistance: number;
  /** How many past positions each ant remembers (used as its pheromone "where"). */
  antPositionMemorySize: number;
  antErratic: number;
  antObjectAvoidance: boolean;
  /** Half-angle (radians) of the field of view used for collision avoidance. */
  antObjectAvoidanceFov: number;

  mapMinX: number;
  mapMinY: number;
  mapMaxX: number;
  mapMaxY: number;
  mapGridSize: number;

  /** 'gradient' algorithm: per-frame multiplier applied when scoring a lead's age (exponential
   * decay/evaporation). */
  pheromoneDecayPerFrame: number;
  /** 'legacy' algorithm only: nominal strength stamped on deposit, purely for the debug
   * overlay ('gradient' scores are already a normalized 0-1 decay factor). */
  pheromoneDepositAmount: number;
  /** Strength at which the debug overlay renders a tile at full intensity. */
  pheromoneSaturation: number;
  pheromoneAlgorithm: PheromoneAlgorithm;
}

export const defaultConfig: SimConfig = {
  numAnts: 1500,
  antMaxSpeed: 1.2,
  antComEveryFrame: false,
  antComNeedFrameStep: [3, 13],
  antSightDistance: 30,
  antPositionMemorySize: 10,
  antErratic: 0.2,
  antObjectAvoidance: true,
  antObjectAvoidanceFov: Math.PI / 6,

  mapMinX: -350,
  mapMinY: -250,
  mapMaxX: 550,
  mapMaxY: 350,
  mapGridSize: 16,

  // half-life of roughly 3500 frames (~1min at 60fps): long enough to survive a full round
  // trip and be found by relay, short enough that abandoned leads still fade out eventually
  pheromoneDecayPerFrame: 0.9998,
  pheromoneDepositAmount: 1,
  pheromoneSaturation: 1,
  pheromoneAlgorithm: 'gradient',
};
