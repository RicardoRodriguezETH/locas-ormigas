import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../config';
import {
  createAnt,
  getLifeStage,
  isComNeeded,
  objectAvoidance,
  respawnAsCallow,
  storePosition,
  taskFound,
  updateActivityCycle,
  updateAnt,
  updateRestingMovement,
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

    updateActivityCycle(ant, cfg, 99, true);
    expect(ant.paused).toBe(false);

    updateActivityCycle(ant, cfg, 100, true);
    expect(ant.paused).toBe(true);
    expect(ant.pauseUntil).toBe(150);

    updateActivityCycle(ant, cfg, 149, true);
    expect(ant.paused).toBe(true);

    updateActivityCycle(ant, cfg, 150, true);
    expect(ant.paused).toBe(false);
    expect(ant.restAt).toBe(250); // next active window scheduled from the wake-up frame
  });

  it('the colony-level foraging throttle stretches/shrinks active and rest windows', () => {
    const cfg = { ...defaultConfig, antActiveDurationRange: [100, 100] as [number, number], antRestDurationRange: [100, 100] as [number, number] };

    const busy = createAnt(cfg, { x: 0, y: 0 }, { x: 1, y: 0 });
    busy.restAt = 100;
    updateActivityCycle(busy, cfg, 100, true, 2); // throttle > 1: colony ramping up foraging
    expect(busy.pauseUntil).toBe(150); // rest window halved (100 / 2)
    updateActivityCycle(busy, cfg, 150, true, 2);
    expect(busy.restAt).toBe(350); // active window doubled (150 + 100*2)

    const idle = createAnt(cfg, { x: 0, y: 0 }, { x: 1, y: 0 });
    idle.restAt = 100;
    updateActivityCycle(idle, cfg, 100, true, 0.5); // throttle < 1: colony conserving effort
    expect(idle.pauseUntil).toBe(300); // rest window doubled (100 / 0.5)
    updateActivityCycle(idle, cfg, 300, true, 0.5);
    expect(idle.restAt).toBe(350); // active window halved (300 + 100*0.5)
  });

  it('will not start resting until eligible (near the cave, not carrying food)', () => {
    const cfg = { ...defaultConfig, antActiveDurationRange: [100, 100] as [number, number], antRestDurationRange: [50, 50] as [number, number] };
    const ant = createAnt(cfg, { x: 0, y: 0 }, { x: 1, y: 0 });
    ant.restAt = 100;

    updateActivityCycle(ant, cfg, 100, false); // not eligible yet (e.g. carrying food, or far from cave)
    expect(ant.paused).toBe(false);
    expect(ant.restAt).toBeGreaterThan(100); // rechecks again shortly rather than stalling forever

    updateActivityCycle(ant, cfg, ant.restAt, true); // now eligible
    expect(ant.paused).toBe(true);
  });

  it('mills slowly near the cave while resting, pulled back if it drifts past the tether radius', () => {
    const cfg = { ...defaultConfig, antRestSpeed: 0.2, antRestTetherRadius: 60 };
    const cave = { x: 0, y: 0 };

    const near = createAnt(cfg, { x: 10, y: 0 }, { x: 1, y: 0 });
    updateRestingMovement(near, cfg, cave);
    expect(near.speed).toBe(cfg.antRestSpeed);

    // far past the tether radius, heading straight away from the cave -> should get pulled homeward
    const far = createAnt(cfg, { x: 100, y: 0 }, { x: 1, y: 0 });
    updateRestingMovement(far, cfg, cave);
    expect(far.direction.x).toBeLessThan(1); // no longer pointed straight away from the cave
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

  it('samples size and natural lifespan within their configured ranges, and starts callow at age 0', () => {
    const cfg = { ...defaultConfig, antSizeRangeMm: [3.5, 5.0] as [number, number], antLifespanMinDays: 120, antLifespanMaxDays: 1100 };
    const ant = createAnt(cfg, { x: 0, y: 0 }, { x: 1, y: 0 });
    expect(ant.size).toBeGreaterThanOrEqual(3.5);
    expect(ant.size).toBeLessThanOrEqual(5.0);
    expect(ant.naturalLifespanDays).toBeGreaterThanOrEqual(120);
    expect(ant.naturalLifespanDays).toBeLessThanOrEqual(1100);
    expect(ant.ageDays).toBe(0);
    expect(getLifeStage(ant, cfg)).toBe('callow');
  });

  it('matures from callow to mature once past the callow threshold', () => {
    const cfg = { ...defaultConfig, antCallowMaturityDays: 5 };
    const ant = createAnt(cfg, { x: 0, y: 0 }, { x: 1, y: 0 });
    ant.ageDays = 4.9;
    expect(getLifeStage(ant, cfg)).toBe('callow');
    ant.ageDays = 5.1;
    expect(getLifeStage(ant, cfg)).toBe('mature');
  });

  it('a callow ant cannot be woken by timer or recruitment', () => {
    const cfg = { ...defaultConfig, antCallowMaturityDays: 5, antRecruitmentWakeGain: 1 };
    vi.spyOn(Math, 'random').mockReturnValue(0); // would always "win" the recruitment roll if checked
    const ant = createAnt(cfg, { x: 0, y: 0 }, { x: 1, y: 0 });
    ant.paused = true;
    ant.pauseUntil = 0; // already expired — would normally wake immediately
    updateActivityCycle(ant, cfg, 100, true, 1, 1, true); // isCallow=true, strong recruitment signal
    expect(ant.paused).toBe(true);

    updateActivityCycle(ant, cfg, 100, true, 1, 1, false); // now mature
    expect(ant.paused).toBe(false);
  });

  it('respawns as a fresh callow worker at the given position on natural death', () => {
    const cfg = { ...defaultConfig };
    const ant = createAnt(cfg, { x: 500, y: 500 }, { x: 1, y: 0 });
    ant.ageDays = ant.naturalLifespanDays + 1;
    ant.cargo.count = 1;

    respawnAsCallow(ant, cfg, { x: 0, y: 0 }, { x: 0, y: 1 });
    expect(ant.position).toEqual({ x: 0, y: 0 });
    expect(ant.ageDays).toBe(0);
    expect(ant.cargo.count).toBe(0);
    expect(getLifeStage(ant, cfg)).toBe('callow');
  });
});
