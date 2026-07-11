import { describe, expect, it } from 'vitest';
import { Camera } from '../camera';

describe('Camera', () => {
  it('converts screen coordinates to world coordinates using translation and scale', () => {
    const cam = new Camera();
    cam.translation = { x: 100, y: 50 };
    cam.scale = 2;
    expect(cam.screenToWorld(120, 70)).toEqual({ x: 10, y: 10 });
  });

  it('converts screen coordinates to grid coordinates', () => {
    const cam = new Camera();
    expect(cam.screenToGrid(32, 17, 16)).toEqual([2, 1]);
  });

  it('pans by translating', () => {
    const cam = new Camera();
    cam.pan(5, -5);
    cam.pan(5, 5);
    expect(cam.translation).toEqual({ x: 10, y: 0 });
  });

  it('clamps zoom to [minScale, maxScale]', () => {
    const cam = new Camera({ minScale: 1, maxScale: 4 });
    cam.zoom(-10);
    expect(cam.scale).toBe(1);
    cam.zoom(10);
    expect(cam.scale).toBe(4);
  });

  it('keeps the zoom origin fixed on screen while zooming', () => {
    const cam = new Camera({ minScale: 1, maxScale: 4 });
    cam.translation = { x: 0, y: 0 };
    cam.zoomOrigin = { x: 100, y: 100 };

    const worldAtOriginBefore = cam.screenToWorld(100, 100);
    cam.zoom(1); // scale 1 -> 2
    const worldAtOriginAfter = cam.screenToWorld(100, 100);

    expect(worldAtOriginAfter.x).toBeCloseTo(worldAtOriginBefore.x);
    expect(worldAtOriginAfter.y).toBeCloseTo(worldAtOriginBefore.y);
  });
});
