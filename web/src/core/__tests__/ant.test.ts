import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../config';
import {
  createAnt,
  headTo,
  isComNeeded,
  objectAvoidance,
  storePosition,
  taskFound,
  updateAnt,
} from '../ant';

describe('ant', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('creates an ant with its position memory pre-filled', () => {
    const ant = createAnt(defaultConfig, { x: 10, y: 20 }, { x: 1, y: 0 });
    expect(ant.pastPositions).toHaveLength(defaultConfig.antPositionMemorySize);
    expect(ant.pastPositions.every((p) => p.x === 10 && p.y === 20)).toBe(true);
    expect(ant.lookingFor).toBe('food');
    expect(ant.nextTask).toBe('cave');
  });

  it('stores positions in a wrapping ring buffer', () => {
    const cfg = { ...defaultConfig, antPositionMemorySize: 3 };
    const ant = createAnt(cfg, { x: 0, y: 0 }, { x: 1, y: 0 });
    storePosition(ant, { x: 1, y: 1 });
    storePosition(ant, { x: 2, y: 2 });
    storePosition(ant, { x: 3, y: 3 });
    storePosition(ant, { x: 4, y: 4 });
    // buffer now holds the 3 most recent positions; oldest remembered wraps around
    expect(ant.oldestPositionRemembered).toEqual({ x: 2, y: 2 });
  });

  it('swaps goals and reverses direction when a task is completed', () => {
    const ant = createAnt(defaultConfig, { x: 0, y: 0 }, { x: 1, y: 0 });
    ant.speed = 1;
    taskFound(ant, defaultConfig, 100);
    expect(ant.lookingFor).toBe('cave');
    expect(ant.nextTask).toBe('food');
    expect(ant.direction.x).toBeCloseTo(-1);
    expect(ant.direction.y).toBeCloseTo(0);
    expect(ant.speed).toBe(0);
    expect(ant.pheromonesWrite).toBe(false);
    expect(ant.pheromonesBackTime).toBe(100 + defaultConfig.antPositionMemorySize);
  });

  it('heads toward a target position', () => {
    const ant = createAnt(defaultConfig, { x: 0, y: 0 }, { x: 1, y: 0 });
    headTo(ant, { x: 0, y: 10 }, 42);
    expect(ant.direction.x).toBeCloseTo(0);
    expect(ant.direction.y).toBeCloseTo(1);
    expect(ant.lastTimeUpdatedPath).toBe(42);
  });

  it('signals communication need on its own cadence', () => {
    const ant = createAnt(defaultConfig, { x: 0, y: 0 }, { x: 1, y: 0 });
    ant.comEvery = 5;
    ant.comEveryOffset = 0;
    expect(isComNeeded(ant, 10)).toBe(true);
    expect(isComNeeded(ant, 11)).toBe(false);
  });

  it('accelerates up to max speed each update, and unpauses on schedule', () => {
    const ant = createAnt(defaultConfig, { x: 0, y: 0 }, { x: 1, y: 0 });
    ant.speed = 0;
    ant.acceleration = 10;
    updateAnt(ant, 0);
    expect(ant.speed).toBe(defaultConfig.antMaxSpeed);

    ant.paused = true;
    ant.pauseUntil = 5;
    updateAnt(ant, 4);
    expect(ant.paused).toBe(true);
    updateAnt(ant, 5);
    expect(ant.paused).toBe(false);
  });

  it('steers away from an obstacle sensed ahead', () => {
    const ant = createAnt(defaultConfig, { x: 0, y: 0 }, { x: 1, y: 0 });
    // blocked straight ahead (x>20) and to the right (y>5), clear to the left -> should turn left
    const canPass = (p: { x: number; y: number }) => p.x <= 20 && p.y <= 5;
    objectAvoidance(ant, defaultConfig, canPass);
    expect(ant.direction.x).toBeGreaterThan(0);
    expect(ant.direction.y).toBeLessThan(0);

    // nothing blocked ahead -> direction unchanged
    const ant2 = createAnt(defaultConfig, { x: 0, y: 0 }, { x: 1, y: 0 });
    objectAvoidance(ant2, defaultConfig, () => true);
    expect(ant2.direction).toEqual({ x: 1, y: 0 });
  });
});
