import { Container, type Application, Sprite } from 'pixi.js';
import type { Camera } from '../core/camera';
import { dirToRad, walkFrame, type Ant } from '../core/ant';
import type { Simulation } from '../core/simulation';
import type { Textures } from './textures';

const IMG_SCALE = 0.25;

function tileKey(xg: number, yg: number): string {
  return `${xg},${yg}`;
}

/** Draws the below-ground overlay: dug tunnels/chambers vs solid dirt, and the underground
 * ants digging/wandering through them. Deliberately simpler than `SimulationRenderer` — no
 * pheromone overlay, no cargo indicator, no special cell types yet (queen/brood chambers are a
 * later phase). Shares the surface renderer's `Camera` so panning/zooming stays in sync between
 * the two overlays when toggling. */
export class UndergroundRenderer {
  private readonly app: Application;
  private readonly sim: Simulation;
  private readonly textures: Textures;
  private readonly camera: Camera;

  private readonly worldContainer = new Container();
  private readonly groundContainer = new Container();
  private readonly antContainer = new Container();

  private readonly groundSprites = new Map<string, Sprite>();
  private readonly antSprites = new Map<Ant, Sprite>();

  constructor(app: Application, sim: Simulation, textures: Textures, camera: Camera) {
    this.app = app;
    this.sim = sim;
    this.textures = textures;
    this.camera = camera;

    this.worldContainer.addChild(this.groundContainer, this.antContainer);
    this.app.stage.addChild(this.worldContainer);
    this.worldContainer.visible = false;

    this.buildGroundTiles();
    this.buildAntSprites();
  }

  set visible(value: boolean) {
    this.worldContainer.visible = value;
  }

  get visible(): boolean {
    return this.worldContainer.visible;
  }

  destroy(): void {
    this.app.stage.removeChild(this.worldContainer);
    this.worldContainer.destroy({ children: true });
  }

  private buildGroundTiles(): void {
    const { undergroundGrid, config } = this.sim;
    for (let xg = undergroundGrid.minXg; xg <= undergroundGrid.maxXg; xg++) {
      for (let yg = undergroundGrid.minYg; yg <= undergroundGrid.maxYg; yg++) {
        const sprite = new Sprite(this.textures.block);
        sprite.scale.set(IMG_SCALE);
        sprite.x = xg * config.mapGridSize;
        sprite.y = yg * config.mapGridSize;
        this.groundContainer.addChild(sprite);
        this.groundSprites.set(tileKey(xg, yg), sprite);
      }
    }
  }

  private buildAntSprites(): void {
    for (const ant of this.sim.ants) {
      if (ant.layer !== 'underground') continue;
      const sprite = new Sprite(this.textures.antWalk[0]);
      sprite.anchor.set(0.5);
      sprite.scale.set(IMG_SCALE);
      sprite.x = ant.position.x;
      sprite.y = ant.position.y;
      this.antContainer.addChild(sprite);
      this.antSprites.set(ant, sprite);
    }
  }

  private syncGroundTiles(): void {
    const { undergroundGrid } = this.sim;
    for (let xg = undergroundGrid.minXg; xg <= undergroundGrid.maxXg; xg++) {
      for (let yg = undergroundGrid.minYg; yg <= undergroundGrid.maxYg; yg++) {
        const sprite = this.groundSprites.get(tileKey(xg, yg))!;
        // dirt reuses the 'block' texture (solid/impassable look), dug tunnels reuse 'ground'
        sprite.texture = undergroundGrid.get(xg, yg).dug ? this.textures.ground : this.textures.block;
        // tint dirt brown-ish so it reads as earth rather than the surface's stone-block color
        sprite.tint = undergroundGrid.get(xg, yg).dug ? 0xffffff : 0x8a5a34;
      }
    }
  }

  private syncAnts(): void {
    for (const [ant, sprite] of this.antSprites) {
      sprite.x = ant.position.x;
      sprite.y = ant.position.y;
      sprite.rotation = dirToRad(ant);
      sprite.texture = this.textures.antWalk[walkFrame(ant)];
      sprite.tint = (ant.color[0] << 16) | (ant.color[1] << 8) | ant.color[2];
    }
  }

  /** Redraw the current simulation state. Call once per animation frame, after `sim.update()`,
   * regardless of visibility — keeps the underground view instantly current when toggled on. */
  render(): void {
    this.worldContainer.x = this.camera.translation.x;
    this.worldContainer.y = this.camera.translation.y;
    const s = this.camera.scale * this.camera.contentScale;
    this.worldContainer.scale.set(s);

    this.syncGroundTiles();
    this.syncAnts();
  }
}
