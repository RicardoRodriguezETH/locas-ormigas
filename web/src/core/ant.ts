import type { Interest, SimConfig } from './config';
import { type Vector2, add, rotate, scale } from './vector';

export interface Cargo {
  count: number;
  capacity: number;
}

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
}

export function createAnt(cfg: SimConfig, position: Vector2, direction: Vector2): Ant {
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
  };
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
  ant.speed = 0; // waking back up starts slow again, not resuming at cruise speed
}

export function unpause(ant: Ant): void {
  ant.paused = false;
}

function randomInRange([min, max]: readonly [number, number]): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Duty-cycles an ant between active and resting, independent of what it's doing task-wise —
 * real ants take breaks even mid-foraging-career. Call once per ant per frame; owns both the
 * "wake up" and "go rest" transitions, so `updateAnt` no longer needs to. */
export function updateActivityCycle(ant: Ant, cfg: SimConfig, frame: number): void {
  if (ant.paused) {
    if (frame >= ant.pauseUntil) {
      unpause(ant);
      ant.restAt = frame + randomInRange(cfg.antActiveDurationRange);
    }
  } else if (frame >= ant.restAt) {
    pause(ant, frame, randomInRange(cfg.antRestDurationRange));
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
