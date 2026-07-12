import { describe, expect, it } from 'vitest';
import { add, directionTo, distance, fromAngle, length, normalize, rotate, scale, sub } from '../vector';

describe('vector', () => {
  it('adds and subtracts', () => {
    expect(add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
    expect(sub({ x: 4, y: 6 }, { x: 1, y: 2 })).toEqual({ x: 3, y: 4 });
  });

  it('scales', () => {
    expect(scale({ x: 2, y: 3 }, 2)).toEqual({ x: 4, y: 6 });
  });

  it('computes length and distance', () => {
    expect(length({ x: 3, y: 4 })).toBe(5);
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('normalizes, falling back on zero-length vectors', () => {
    const n = normalize({ x: 0, y: 5 });
    expect(n.x).toBeCloseTo(0);
    expect(n.y).toBeCloseTo(1);
    expect(normalize({ x: 0, y: 0 })).toEqual({ x: 1, y: 0 });
  });

  it('computes direction between two points, falling back when coincident', () => {
    const d = directionTo({ x: 0, y: 0 }, { x: 0, y: 10 });
    expect(d.x).toBeCloseTo(0);
    expect(d.y).toBeCloseTo(1);
    expect(directionTo({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 1, y: 0 });
  });

  it('rotates a vector by an angle', () => {
    const r = rotate({ x: 1, y: 0 }, Math.PI / 2);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(1);
  });

  it('builds a unit vector from an angle', () => {
    const v = fromAngle(0);
    expect(v.x).toBeCloseTo(1);
    expect(v.y).toBeCloseTo(0);
  });
});
