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
};
