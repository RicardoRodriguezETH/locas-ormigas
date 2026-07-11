import type { Interest, SimConfig } from './config';
import { type Vector2, add, directionTo, distance, normalize, rotate, scale } from './vector';

export interface Cargo {
  count: number;
  capacity: number;
}

/** Which of the two overlays this ant currently lives on. Surface ants run the full
 * foraging/pheromone/rest pipeline; underground ants run a much simpler dig-and-wander
 * behavior (see `Simulation.stepUndergroundAnt`) — the two never interact directly yet. */
export type AntLayer = 'surface' | 'underground';

/** An ant's state. Plain data + free functions, rather than per-instance methods,
 * since thousands of these are updated every frame. */
export interface Ant {
  position: Vector2;
  direction: Vector2;
  radius: number;
  speed: number;
  traveled: number;
  friction: number;
  acceleration: number;
  maxSpeed: number;

  /** What this ant is currently seeking: 'food' when empty-handed, 'cave' when carrying food. */
  lookingFor: Interest;
  nextTask: Interest;
  cargo: Cargo;

  /** Frame each interest was last personally observed; -1 means never. Also gates what this
   * ant is willing to deposit pheromone about. */
  lastTimeSeen: Record<Interest, number>;
  /** Score (either raw frame-time for 'legacy', or decayed strength for 'gradient') of the
   * best pheromone lead currently being followed — only switches heading when something
   * better turns up. Reset to 0 whenever a task completes, making the ant receptive again. */
  maxLeadScore: number;
  /** Frame until which this ant counts as "recently informed" by a pheromone trail — walks
   * tight and mostly straight until then, loopier undirected search afterward. Set whenever
   * pheromone communication actually updates its heading. */
  informedUntil: number;

  color: readonly [number, number, number];
  lastCollisionTime: number;

  /** Pheromone trail: false while an ant is "fresh from a task" and hasn't walked far enough
   * to lay a meaningful trail again. */
  pheromonesWrite: boolean;
  pheromonesBackTime: number;

  paused: boolean;
  pauseUntil: number;
  /** Frame this ant should next stop being active and start resting (see
   * `updateActivityCycle`). Ignored while already paused. */
  restAt: number;

  teleportedOnFrame: number | null;

  /** Ring buffer of recent positions; the oldest one is what gets shared as this ant's
   * pheromone location (an approximation of "where I came from"). */
  pastPositions: Vector2[];
  oldestPositionIndex: number;
  oldestPositionRemembered: Vector2;

  /** Frame cadence on which this ant checks/shares pheromone info (staggered per-ant). */
  comEvery: number;
  comEveryOffset: number;

  /** Which overlay this ant currently lives/acts on. */
  layer: AntLayer;

  /** Body length in mm, sampled once per ant — see `SimConfig.antSizeRangeMm`. Not currently
   * tied to any behavior; tracked for realism and future use. */
  size: number;
  /** Age in simulated days (fractional; see `SimConfig.framesPerDay`). Drives `getLifeStage`
   * and, on exceeding `naturalLifespanDays`, natural death. */
  ageDays: number;
  /** This individual's natural lifespan in days, sampled once at birth — see
   * `SimConfig.antLifespanMinDays`/`antLifespanMaxDays`. */
  naturalLifespanDays: number;
}

export type LifeStage = 'callow' | 'mature';

/** Newly-eclosed workers stay "callow" (too young to forage, see `updateActivityCycle`) until
 * `SimConfig.antCallowMaturityDays` have passed. */
export function getLifeStage(ant: Ant, cfg: SimConfig): LifeStage {
  return ant.ageDays < cfg.antCallowMaturityDays ? 'callow' : 'mature';
}

/** Samples a natural lifespan biased toward the low end of the range, matching real
 * right-skewed worker survivorship (most workers die well before the observed maximum). */
function sampleLifespanDays(cfg: SimConfig): number {
  const { antLifespanMinDays: min, antLifespanMaxDays: max } = cfg;
  return min + (max - min) * Math.random() ** 2;
}

export function createAnt(
  cfg: SimConfig,
  position: Vector2,
  direction: Vector2,
  initialAgeDays = 0,
  layer: AntLayer = 'surface',
): Ant {
  const pastPositions = Array.from({ length: cfg.antPositionMemorySize }, () => ({ ...position }));
  return {
    position: { ...position },
    direction: { ...direction },
    radius: 2,
    speed: 0.1,
    traveled: 0,
    friction: 1,
    acceleration: 0.04 + Math.random() * 0.05,
    maxSpeed: cfg.antMaxSpeed,

    layer,

    lookingFor: 'food',
    nextTask: 'cave',
    cargo: { count: 0, capacity: 1 },

    lastTimeSeen: { food: -1, cave: -1 },
    maxLeadScore: -1,
    informedUntil: -1,

    color: [255, 255, 255],
    lastCollisionTime: -1,

    pheromonesWrite: true,
    pheromonesBackTime: -1,

    paused: false,
    pauseUntil: -1,
    // staggered so the whole colony doesn't rest in sync
    restAt: Math.floor(Math.random() * cfg.antActiveDurationRange[1]),

    teleportedOnFrame: null,

    pastPositions,
    oldestPositionIndex: 0,
    oldestPositionRemembered: pastPositions[0],

    comEvery: cfg.antComNeedFrameStep[0] + Math.floor(Math.random() * (cfg.antComNeedFrameStep[1] - cfg.antComNeedFrameStep[0] + 1)),
    comEveryOffset: Math.floor(Math.random() * cfg.antComNeedFrameStep[1]) + 1,

    size: cfg.antSizeRangeMm[0] + Math.random() * (cfg.antSizeRangeMm[1] - cfg.antSizeRangeMm[0]),
    ageDays: initialAgeDays,
    naturalLifespanDays: sampleLifespanDays(cfg),
  };
}

/** Advances an ant's age by one frame's worth of simulated time. Call once per ant per frame. */
export function advanceAge(ant: Ant, cfg: SimConfig): void {
  ant.ageDays += 1 / cfg.framesPerDay;
}

/** Natural death, standing in for real brood-rearing (no queen/egg-laying system exists yet):
 * rather than actually removing the ant (which would slowly empty the colony over a long play
 * session with nothing replacing losses), it re-emerges as a fresh callow worker at the nest —
 * new size/lifespan sampled, age reset to 0, task/pheromone/trail state reset like a new spawn.
 * Stays on whichever layer the ant was already on. */
export function respawnAsCallow(ant: Ant, cfg: SimConfig, position: Vector2, direction: Vector2): void {
  Object.assign(ant, createAnt(cfg, position, direction, 0, ant.layer));
}

/** Push `position` into the ring buffer, dropping the oldest remembered position. */
export function storePosition(ant: Ant, position: Vector2): void {
  ant.pastPositions[ant.oldestPositionIndex] = { ...position };
  ant.oldestPositionIndex = (ant.oldestPositionIndex + 1) % ant.pastPositions.length;
  ant.oldestPositionRemembered = ant.pastPositions[ant.oldestPositionIndex];
}

export function resetPositionMemory(ant: Ant, position: Vector2): void {
  for (let i = 0; i < ant.pastPositions.length; i++) {
    ant.pastPositions[i] = { ...position };
  }
  ant.oldestPositionRemembered = ant.pastPositions[ant.oldestPositionIndex];
}

export function disablePheromonesWrite(ant: Ant, frame: number, time: number): void {
  ant.pheromonesWrite = false;
  ant.pheromonesBackTime = frame + time;
}

export function enablePheromonesWrite(ant: Ant): void {
  ant.pheromonesWrite = true;
}

export function pause(ant: Ant, frame: number, time: number): void {
  ant.pauseUntil = frame + time;
  ant.paused = true;
}

export function unpause(ant: Ant): void {
  ant.paused = false;
}

export function randomInRange([min, max]: readonly [number, number]): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Duty-cycles an ant between active and resting, independent of what it's doing task-wise —
 * real ants take breaks even mid-foraging-career. Call once per ant per frame; owns both the
 * "wake up" and "go rest" transitions, so `updateAnt` no longer needs to.
 *
 * `eligibleToRest` gates only the *start* of a rest (an ant already out foraging with an empty
 * schedule slot just keeps going until it's actually near the cave and free-handed).
 *
 * `throttle` is the colony-level foraging throttle (see `SimConfig.antForagingThrottle*`): above
 * 1 it stretches active windows and shrinks rest windows (more of the colony out foraging),
 * below 1 it does the opposite (colony conserving effort).
 *
 * `recruitmentSignal` is how strong the food trail near the cave currently reads (0-1, see
 * `Simulation`'s `caveFoodSignal`) — resting ants get a per-frame chance to wake early
 * proportional to it (`SimConfig.antRecruitmentWakeGain`), on top of the fallback duration
 * timer, so recruitment tracks real trail evidence rather than a blind clock: no signal means
 * the fallback timer is the only thing waking anyone up, a strong fresh trail wakes the colony
 * fast.
 *
 * `isCallow` (see `getLifeStage`) unconditionally blocks waking — real callow workers are too
 * young to forage regardless of trail strength or elapsed time. */
export function updateActivityCycle(
  ant: Ant,
  cfg: SimConfig,
  frame: number,
  eligibleToRest: boolean,
  throttle = 1,
  recruitmentSignal = 0,
  isCallow = false,
): void {
  if (ant.paused) {
    if (isCallow) return;
    const recruited = recruitmentSignal > 0 && Math.random() < recruitmentSignal * cfg.antRecruitmentWakeGain;
    if (frame >= ant.pauseUntil || recruited) {
      unpause(ant);
      ant.restAt = frame + Math.round(randomInRange(cfg.antActiveDurationRange) * throttle);
    }
  } else if (frame >= ant.restAt) {
    if (eligibleToRest) {
      pause(ant, frame, Math.round(randomInRange(cfg.antRestDurationRange) / throttle));
    } else {
      // not near the cave (or currently carrying food) — check again shortly rather than
      // waiting for the next full active-duration window to roll around
      ant.restAt = frame + 30;
    }
  }
}

/** Reached the thing it was looking for: swap goals, reverse course, and go quiet on the
 * pheromone trail for a while (so it doesn't immediately re-advertise the spot it just left). */
export function taskFound(ant: Ant, cfg: SimConfig, frame: number): void {
  [ant.lookingFor, ant.nextTask] = [ant.nextTask, ant.lookingFor];
  ant.direction = scale(ant.direction, -1);
  ant.speed = 0;
  disablePheromonesWrite(ant, frame, cfg.antPositionMemorySize);
}

/** Whether this is one of the frames on which the ant checks/shares pheromone info. */
export function isComNeeded(ant: Ant, frame: number): boolean {
  return (frame + ant.comEveryOffset) % ant.comEvery === 0;
}

/** Advance speed/heading for one frame. Movement + collision happens separately in the grid.
 * Pause/rest transitions are handled by `updateActivityCycle`, called separately. */
export function updateAnt(ant: Ant, cfg: SimConfig, frame: number): void {
  storePosition(ant, ant.position);

  if (ant.paused) return;

  ant.speed = (ant.speed + ant.acceleration) * ant.friction;
  if (ant.speed > ant.maxSpeed) ant.speed = ant.maxSpeed;

  // tight, mostly-straight wander while recently guided by a trail; loopier, more undirected
  // search otherwise — like a recruited forager vs. a scout
  const erratic = frame < ant.informedUntil ? cfg.antErraticInformed : cfg.antErraticSearching;
  ant.direction = rotate(ant.direction, erratic * Math.random() - erratic * 0.5);
  ant.friction = 1;
}

/** Movement for a resting ant: a slow mill/chill near the cave rather than a full freeze.
 * Wanders with a loose heading jitter, blended with a gentle pull back toward the cave that
 * strengthens the further the ant drifts from it — keeps resting ants visually clustered
 * around the colony entrance instead of drifting off across the map. */
export function updateRestingMovement(ant: Ant, cfg: SimConfig, cavePosition: Vector2): void {
  ant.speed = cfg.antRestSpeed;
  ant.direction = rotate(ant.direction, cfg.antRestErratic * Math.random() - cfg.antRestErratic * 0.5);

  const distanceFromCave = distance(ant.position, cavePosition);
  const driftFraction = distanceFromCave / cfg.antRestTetherRadius;
  if (driftFraction > 0.5) {
    const homeward = directionTo(ant.position, cavePosition, ant.direction);
    const pull = Math.min(1, (driftFraction - 0.5) * 2);
    ant.direction = normalize(add(scale(ant.direction, 1 - pull), scale(homeward, pull)), ant.direction);
  }
}

/** Steer away from an obstacle sensed straight ahead, by checking a bit left/right of it. */
export function objectAvoidance(ant: Ant, cfg: SimConfig, canPass: (p: Vector2) => boolean): void {
  const ahead = add(ant.position, scale(ant.direction, cfg.antSightDistance));
  if (canPass(ahead)) return;

  const left = rotate(ant.direction, -cfg.antObjectAvoidanceFov);
  const right = rotate(ant.direction, cfg.antObjectAvoidanceFov);
  const lookDist = cfg.antSightDistance / 2;
  const freeLeft = canPass(add(ant.position, scale(left, lookDist)));
  const freeRight = canPass(add(ant.position, scale(right, lookDist)));

  if (freeLeft && !freeRight) {
    ant.direction = left;
  } else if (freeRight && !freeLeft) {
    ant.direction = right;
  }
  // if both or neither are free, keep current heading (matches original behavior)
}

export function dirToRad(ant: Ant): number {
  return ant.direction.y > 0 ? Math.acos(ant.direction.x) : Math.PI * 2 - Math.acos(ant.direction.x);
}

/** Rough animation frame index from distance traveled, for a 4-frame walk cycle. */
export function walkFrame(ant: Ant): number {
  return Math.floor(ant.traveled % 4);
}
