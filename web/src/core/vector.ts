export interface Vector2 {
  x: number;
  y: number;
}

export function vec(x: number, y: number): Vector2 {
  return { x, y };
}

export function add(a: Vector2, b: Vector2): Vector2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vector2, b: Vector2): Vector2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(v: Vector2, s: number): Vector2 {
  return { x: v.x * s, y: v.y * s };
}

export function length(v: Vector2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

export function sqLength(v: Vector2): number {
  return v.x * v.x + v.y * v.y;
}

export function distance(a: Vector2, b: Vector2): number {
  return length(sub(b, a));
}

/** Normalized direction from `a` to `b`, or `fallback` if the points coincide. */
export function directionTo(a: Vector2, b: Vector2, fallback: Vector2 = { x: 1, y: 0 }): Vector2 {
  const d = sub(b, a);
  const len = length(d);
  return len === 0 ? fallback : scale(d, 1 / len);
}

export function normalize(v: Vector2, fallback: Vector2 = { x: 1, y: 0 }): Vector2 {
  const len = length(v);
  return len === 0 ? fallback : scale(v, 1 / len);
}

export function rotate(v: Vector2, angle: number): Vector2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

export function fromAngle(angle: number): Vector2 {
  return { x: Math.cos(angle), y: Math.sin(angle) };
}
