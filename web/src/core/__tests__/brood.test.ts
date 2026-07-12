import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import { advanceBroodAge, createEgg, createQueen, createSeededBrood, feedLarva, tryAdvanceBroodStage } from '../brood';

describe('brood', () => {
  it('createEgg starts at age 0 with no nutrition', () => {
    const egg = createEgg({ x: 1, y: 2 });
    expect(egg.stage).toBe('egg');
    expect(egg.ageDays).toBe(0);
    expect(egg.nutritionReceived).toBe(0);
    expect(egg.position).toEqual({ x: 1, y: 2 });
    expect(egg.beingCarried).toBe(false);
    expect(egg.atNursery).toBe(false);
  });

  it('advanceBroodAge increments by one frame worth of days', () => {
    const cfg = { ...defaultConfig, framesPerDay: 100 };
    const egg = createEgg({ x: 0, y: 0 });
    advanceBroodAge(egg, cfg);
    expect(egg.ageDays).toBeCloseTo(0.01);
  });

  it('egg hatches into larva once eggDurationDays is reached, resetting age', () => {
    const cfg = { ...defaultConfig, eggDurationDays: 5 };
    const egg = createEgg({ x: 0, y: 0 });
    egg.ageDays = 4.9;
    expect(tryAdvanceBroodStage(egg, cfg)).toBe(false);
    expect(egg.stage).toBe('egg');

    egg.ageDays = 5.1;
    expect(tryAdvanceBroodStage(egg, cfg)).toBe(false);
    expect(egg.stage).toBe('larva');
    expect(egg.ageDays).toBe(0);
  });

  it('larva only pupates once both aged enough and fully fed', () => {
    const cfg = { ...defaultConfig, larvaDurationDays: 10, larvaNutritionNeeded: 5 };
    const larva = createEgg({ x: 0, y: 0 });
    larva.stage = 'larva';
    larva.ageDays = 11; // aged enough
    larva.nutritionReceived = 2; // not fed enough
    expect(tryAdvanceBroodStage(larva, cfg)).toBe(false);
    expect(larva.stage).toBe('larva');

    larva.nutritionReceived = 5;
    expect(tryAdvanceBroodStage(larva, cfg)).toBe(false);
    expect(larva.stage).toBe('pupa');
    expect(larva.ageDays).toBe(0);
  });

  it('pupa signals ready-to-eclose once pupaDurationDays is reached', () => {
    const cfg = { ...defaultConfig, pupaDurationDays: 8 };
    const pupa = createEgg({ x: 0, y: 0 });
    pupa.stage = 'pupa';
    pupa.ageDays = 7.9;
    expect(tryAdvanceBroodStage(pupa, cfg)).toBe(false);

    pupa.ageDays = 8.1;
    expect(tryAdvanceBroodStage(pupa, cfg)).toBe(true);
    expect(pupa.stage).toBe('pupa'); // caller handles removal, not this function
  });

  it('feedLarva only feeds larvae, capped by need and food available', () => {
    const cfg = { ...defaultConfig, larvaFeedRatePerFrame: 1, larvaNutritionNeeded: 3 };
    const egg = createEgg({ x: 0, y: 0 });
    expect(feedLarva(egg, cfg, 10)).toBe(0); // not a larva

    const larva = createEgg({ x: 0, y: 0 });
    larva.stage = 'larva';
    expect(feedLarva(larva, cfg, 10)).toBe(1); // capped by feed rate
    expect(larva.nutritionReceived).toBe(1);

    larva.nutritionReceived = 2.5;
    expect(feedLarva(larva, cfg, 10)).toBeCloseTo(0.5); // capped by remaining need
    expect(larva.nutritionReceived).toBeCloseTo(3);

    expect(feedLarva(larva, cfg, 10)).toBe(0); // fully fed, nothing more needed

    const hungryLarva = createEgg({ x: 0, y: 0 });
    hungryLarva.stage = 'larva';
    expect(feedLarva(hungryLarva, cfg, 0.2)).toBeCloseTo(0.2); // capped by food available
  });

  it('createQueen starts at her position with no delay before her first attempt', () => {
    const queen = createQueen({ x: 5, y: 5 });
    expect(queen.position).toEqual({ x: 5, y: 5 });
    expect(queen.ageDays).toBe(0);
    expect(queen.nextEggAttemptFrame).toBe(0);
  });

  it('createSeededBrood derives the stage from a total-development age, and pre-feeds larvae', () => {
    const cfg = { ...defaultConfig, eggDurationDays: 10, larvaDurationDays: 20, pupaDurationDays: 15, larvaNutritionNeeded: 8 };

    const egg = createSeededBrood({ x: 0, y: 0 }, 5, cfg); // within [0, 10)
    expect(egg.stage).toBe('egg');
    expect(egg.ageDays).toBe(5);
    expect(egg.atNursery).toBe(true);

    const larva = createSeededBrood({ x: 0, y: 0 }, 25, cfg); // within [10, 30)
    expect(larva.stage).toBe('larva');
    expect(larva.ageDays).toBe(15);
    expect(larva.nutritionReceived).toBe(8); // established larvae are already fed

    const pupa = createSeededBrood({ x: 0, y: 0 }, 40, cfg); // within [30, 45)
    expect(pupa.stage).toBe('pupa');
    expect(pupa.ageDays).toBe(10);
  });
});
