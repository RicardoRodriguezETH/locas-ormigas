import { describe, expect, it } from 'vitest';
import { createAnt } from '../ant';
import { CaveCell, FoodCell, GrassCell, PortalFactory } from '../cells';
import { defaultConfig } from '../config';

const ctx = (frame = 0) => ({ frame, config: defaultConfig });

describe('cells', () => {
  it('grass slows an ant down via friction', () => {
    const ant = createAnt(defaultConfig, { x: 0, y: 0 }, { x: 1, y: 0 });
    new GrassCell().affectAnt(ant, ctx());
    expect(ant.friction).toBe(0.8);
  });

  it('food fills cargo and flips an ant looking for food onto the cave task', () => {
    const ant = createAnt(defaultConfig, { x: 0, y: 0 }, { x: 1, y: 0 });
    ant.lookingFor = 'food';
    new FoodCell().affectAnt(ant, ctx(10));
    expect(ant.cargo.count).toBe(ant.cargo.capacity);
    expect(ant.lookingFor).toBe('cave');
  });

  it('food does nothing to an ant not looking for food', () => {
    const ant = createAnt(defaultConfig, { x: 0, y: 0 }, { x: 1, y: 0 });
    ant.lookingFor = 'cave';
    new FoodCell().affectAnt(ant, ctx(10));
    expect(ant.cargo.count).toBe(0);
    expect(ant.lookingFor).toBe('cave');
  });

  it('cave empties cargo and flips an ant looking for a cave onto the food task', () => {
    const ant = createAnt(defaultConfig, { x: 0, y: 0 }, { x: 1, y: 0 });
    ant.lookingFor = 'cave';
    ant.nextTask = 'food';
    ant.cargo.count = 1;
    new CaveCell().affectAnt(ant, ctx(10));
    expect(ant.cargo.count).toBe(0);
    expect(ant.lookingFor).toBe('food');
  });

  it('pairs up portals: blue, then linked orange, then a fresh blue', () => {
    const factory = new PortalFactory();
    const first = factory.create();
    const second = factory.create();
    const third = factory.create();

    expect(first.color).toBe('blue');
    expect(second.color).toBe('orange');
    expect(second.link).toBe(first);
    expect(first.link).toBe(second);
    expect(third.color).toBe('blue');
    expect(third.link).toBeNull();
  });

  it('teleports an ant to its linked portal and resets its position memory', () => {
    const factory = new PortalFactory();
    const a = factory.create();
    const b = factory.create();
    a.position = { x: 100, y: 100 };
    b.position = { x: -100, y: -100 };

    const ant = createAnt(defaultConfig, { x: 100, y: 100 }, { x: 1, y: 0 });
    a.affectAnt(ant, ctx(5));

    const half = defaultConfig.mapGridSize / 2;
    expect(ant.position).toEqual({ x: -100 + half, y: -100 + half });
    expect(ant.teleportedOnFrame).toBe(5);
    expect(ant.pastPositions.every((p) => p.x === -100 + half && p.y === -100 + half)).toBe(true);
  });

  it('ignores a portal for a cooldown window right after teleporting', () => {
    const factory = new PortalFactory();
    const a = factory.create();
    const b = factory.create();
    b.position = { x: 42, y: 42 };

    const ant = createAnt(defaultConfig, { x: 0, y: 0 }, { x: 1, y: 0 });
    ant.teleportedOnFrame = 10;
    a.affectAnt(ant, ctx(20));

    expect(ant.position).toEqual({ x: 0, y: 0 });
  });
});
