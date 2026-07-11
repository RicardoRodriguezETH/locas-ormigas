import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../config';
import { createAnt, isComNeeded, objectAvoidance, storePosition, taskFound, updateActivityCycle, updateAnt } from '../ant';

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

  it('signals communication need on its own cadence', () => {
    const ant = createAnt(defaultConfig, { x: 0, y: 0 }, { x: 1, y: 0 });
    ant.comEvery = 5;
    ant.comEveryOffset = 0;
    expect(isComNeeded(ant, 10)).toBe(true);
    expect(isComNeeded(ant, 11)).toBe(false);
  });

  it('accelerates up to max speed each update, and does nothing while paused', () => {
    const ant = createAnt(defaultConfig, { x: 0, y: 0 }, { x: 1, y: 0 });
    ant.speed = 0;
    ant.acceleration = 10;
    updateAnt(ant, defaultConfig, 0);
    expect(ant.speed).toBe(defaultConfig.antMaxSpeed);

    ant.paused = true;
    ant.speed = 1;
    updateAnt(ant, defaultConfig, 0);
    expect(ant.speed).toBe(1); // untouched while paused
  });

  it('duty-cycles between active and resting, staggered so ants do not sync up', () => {
    const cfg = { ...defaultConfig, antActiveDurationRange: [100, 100] as [number, number], antRestDurationRange: [50, 50] as [number, number] };
    const ant = createAnt(cfg, { x: 0, y: 0 }, { x: 1, y: 0 });
    ant.restAt = 100; // pin the staggered start for a deterministic test

    updateActivityCycle(ant, cfg, 99);
    expect(ant.paused).toBe(false);

    updateActivityCycle(ant, cfg, 100);
    expect(ant.paused).toBe(true);
    expect(ant.pauseUntil).toBe(150);
    expect(ant.speed).toBe(0);

    updateActivityCycle(ant, cfg, 149);
    expect(ant.paused).toBe(true);

    updateActivityCycle(ant, cfg, 150);
    expect(ant.paused).toBe(false);
    expect(ant.restAt).toBe(250); // next active window scheduled from the wake-up frame
  });

  it('wanders tighter when recently informed, loopier when searching', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1); // maximize rotation so the difference is measurable
    const cfg = { ...defaultConfig, antErraticInformed: 0.1, antErraticSearching: 0.5 };

    const informed = createAnt(cfg, { x: 0, y: 0 }, { x: 1, y: 0 });
    informed.informedUntil = 100;
    updateAnt(informed, cfg, 0); // frame 0 < informedUntil 100 -> tight wander

    const searching = createAnt(cfg, { x: 0, y: 0 }, { x: 1, y: 0 });
    searching.informedUntil = -1;
    updateAnt(searching, cfg, 0); // frame 0 >= informedUntil -1 -> loopy wander

    const informedAngle = Math.abs(Math.atan2(informed.direction.y, informed.direction.x));
    const searchingAngle = Math.abs(Math.atan2(searching.direction.y, searching.direction.x));
    expect(searchingAngle).toBeGreaterThan(informedAngle);
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
