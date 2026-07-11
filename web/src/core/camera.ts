import type { Vector2 } from './vector';

export interface CameraOptions {
  minScale?: number;
  maxScale?: number;
}

/** Screen &lt;-&gt; world conversion and pan/zoom state for the game view. Pure math, no
 * rendering dependency, so it's driven by input handlers and read by whatever draws the
 * world (currently the PixiJS renderer). */
export class Camera {
  translation: Vector2 = { x: 0, y: 0 };
  scale = 1;
  /** Extra uniform scale applied for high-density/resized screens, independent of zoom. */
  contentScale = 1;
  zoomOrigin: Vector2 = { x: 0, y: 0 };

  private readonly minScale: number;
  private readonly maxScale: number;

  constructor(options: CameraOptions = {}) {
    this.minScale = options.minScale ?? 1;
    this.maxScale = options.maxScale ?? 4;
  }

  screenToWorld(x: number, y: number): Vector2 {
    return {
      x: (x - this.translation.x) / this.scale / this.contentScale,
      y: (y - this.translation.y) / this.scale / this.contentScale,
    };
  }

  screenToGrid(x: number, y: number, gridSize: number): [number, number] {
    const world = this.screenToWorld(x, y);
    return [Math.floor(world.x / gridSize), Math.floor(world.y / gridSize)];
  }

  pan(dx: number, dy: number): void {
    this.translation = { x: this.translation.x + dx, y: this.translation.y + dy };
  }

  /** Zoom by `inc`, clamped to [minScale, maxScale], pinned around `zoomOrigin` (typically the
   * mouse position or screen center) so that point stays fixed on screen. */
  zoom(inc: number): void {
    const oldScale = this.scale;
    let newScale = this.scale + inc;
    if (newScale < this.minScale) newScale = this.minScale;
    else if (newScale > this.maxScale) newScale = this.maxScale;

    const dx = this.translation.x - this.zoomOrigin.x;
    const dy = this.translation.y - this.zoomOrigin.y;
    this.translation = {
      x: this.zoomOrigin.x + dx * (newScale / oldScale),
      y: this.zoomOrigin.y + dy * (newScale / oldScale),
    };
    this.scale = newScale;
  }
}
