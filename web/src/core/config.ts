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

/** 'legacy' and 'gradient' both snap directly to whichever nearby cell has the best-scoring
 * lead for what an ant is seeking — 'legacy' scores by raw frame-time (never fades), 'gradient'
 * by that same time run through exponential decay (evaporates if not refreshed). 'flow' is
 * structurally different: instead of a remembered coordinate, each cell holds a decaying
 * *direction* vector built from the headings of ants who walked through it, and followers
 * align with the local vector sum rather than beelining for a point — the piece needed to
 * route around obstacles and support multiple simultaneous destinations. See
 * `Simulation.communicatePheromones`/`communicatePheromonesFlow`, kept side by side so all
 * three are directly comparable. */
export type PheromoneAlgorithm = 'legacy' | 'gradient' | 'flow';

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
  /** Heading jitter applied while confidently following a known trail — tight and mostly
   * straight, like a recruited real ant. */
  antErraticInformed: number;
  /** Heading jitter while there's no recent pheromone guidance — loopier, undirected search,
   * like a real scout. */
  antErraticSearching: number;
  /** How long "recently informed" status lasts after last receiving useful pheromone
   * guidance before an ant reverts to searching-style wander. */
  antInformedWindow: number;
  antObjectAvoidance: boolean;
  /** Half-angle (radians) of the field of view used for collision avoidance. */
  antObjectAvoidanceFov: number;

  /** [min, max] frames an ant stays active before resting again. */
  antActiveDurationRange: [number, number];
  /** [min, max] frames an ant then rests for. Together with the active range, this duty cycle
   * averages out to roughly 40% of the colony resting at any moment, matching observed real
   * ant colony inactivity rates (studies report ~40-65% of workers inactive at a given time). */
  antRestDurationRange: [number, number];
  /** How close to the cave (world units) an ant must be to be eligible to start resting, and
   * how far a resting ant is allowed to mill before being pulled back — real ants rest in and
   * around the nest, not wherever they happen to be out on the trail. */
  antRestTetherRadius: number;
  /** Crawl speed while resting/milling near the cave — much slower than foraging cruise speed,
   * but not a full freeze. */
  antRestSpeed: number;
  /** Heading jitter while milling at rest. */
  antRestErratic: number;

  /** Colony-level foraging throttle: real harvester ant colonies adjust how many foragers they
   * send out based on recent forager *return* rate relative to their own baseline — a burst of
   * successful returns (good conditions) recruits more foragers, a lull (scarcity/risk) pulls
   * them back in, independent of any single ant's own experience (Gordon's encounter-rate task
   * allocation). Modeled here as two EMAs of colony-wide deliveries/frame; their ratio scales
   * how long ants stay active vs. resting. */
  antForagingThrottleFastDecay: number;
  antForagingThrottleSlowDecay: number;
  /** Clamp on the throttle ratio, so a lucky/unlucky streak can't swing the duty cycle wildly. */
  antForagingThrottleMin: number;
  antForagingThrottleMax: number;
  /** Below this delivery-rate baseline (deliveries/frame, colony-wide), the throttle stays
   * neutral (1) rather than reacting to noise before a real baseline has formed. */
  antForagingThrottleWarmupRate: number;

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
  antErraticInformed: 0.08,
  antErraticSearching: 0.32,
  antInformedWindow: 120,
  antObjectAvoidance: true,
  antObjectAvoidanceFov: Math.PI / 6,

  antActiveDurationRange: [400, 1000],
  antRestDurationRange: [300, 700],
  antRestTetherRadius: 60,
  antRestSpeed: 0.2,
  antRestErratic: 0.35,

  // half-life ~23 frames (recent conditions) vs ~693 frames (long-run baseline)
  antForagingThrottleFastDecay: 0.97,
  antForagingThrottleSlowDecay: 0.999,
  antForagingThrottleMin: 0.7,
  antForagingThrottleMax: 1.4,
  antForagingThrottleWarmupRate: 0.02,

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
