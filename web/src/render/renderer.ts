import { Container, Graphics, type Application, Sprite, type Texture } from 'pixi.js';
import { Camera } from '../core/camera';
import { dirToRad, walkFrame } from '../core/ant';
import type { Cell } from '../core/cells';
import { PortalCell } from '../core/cells';
import type { Simulation } from '../core/simulation';
import type { Textures } from './textures';

/** Original sprite sheet art is drawn at quarter size. */
const IMG_SCALE = 0.25;
const PORTAL_ANIM_FRAME_HOLD = 4;

function tileKey(xg: number, yg: number): string {
  return `${xg},${yg}`;
}

/** Draws the current state of a Simulation with PixiJS. Owns no simulation logic itself —
 * call `sim.update()` elsewhere and then `render()` to reflect it. */
export class SimulationRenderer {
  readonly camera = new Camera();

  private readonly app: Application;
  private readonly sim: Simulation;
  private readonly textures: Textures;

  private readonly worldContainer = new Container();
  private readonly groundContainer = new Container();
  private readonly cellContainer = new Container();
  private readonly antContainer = new Container();
  private readonly pheromoneLayer = new Graphics();

  private readonly groundSprites = new Map<string, Sprite>();
  private readonly cellSprites = new Map<string, Sprite>();
  private readonly antSprites: Sprite[] = [];

  showPheromones = false;

  constructor(app: Application, sim: Simulation, textures: Textures) {
    this.app = app;
    this.sim = sim;
    this.textures = textures;

    this.worldContainer.addChild(this.groundContainer, this.cellContainer, this.pheromoneLayer, this.antContainer);
    this.worldContainer.addChild(this.buildMapBorder());
    this.app.stage.addChild(this.worldContainer);

    this.buildGroundTiles();
    this.buildAntSprites();
  }

  private buildMapBorder(): Graphics {
    const { mapMinX, mapMinY, mapMaxX, mapMaxY } = this.sim.config;
    return new Graphics()
      .rect(mapMinX, mapMinY, mapMaxX - mapMinX, mapMaxY - mapMinY)
      .stroke({ width: 1, color: 0x787878 });
  }

  private buildGroundTiles(): void {
    const { grid, config } = this.sim;
    for (let xg = grid.minXg; xg <= grid.maxXg; xg++) {
      for (let yg = grid.minYg; yg <= grid.maxYg; yg++) {
        const sprite = new Sprite(this.textures.ground);
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
      const sprite = new Sprite(this.textures.antWalk[0]);
      sprite.anchor.set(0.5);
      sprite.scale.set(IMG_SCALE);
      sprite.x = ant.position.x;
      sprite.y = ant.position.y;
      this.antContainer.addChild(sprite);
      this.antSprites.push(sprite);
    }
  }

  private textureForCell(cell: Cell): Texture {
    switch (cell.type) {
      case 'grass':
        return this.textures.grass;
      case 'food':
        return this.textures.food;
      case 'cave':
        return this.textures.cave;
      case 'portal': {
        const portal = cell as PortalCell;
        const frames = portal.color === 'blue' ? this.textures.portalBlue : this.textures.portalOrange;
        return frames[Math.floor(this.sim.frame / PORTAL_ANIM_FRAME_HOLD) % frames.length];
      }
    }
  }

  private syncGroundAndCells(): void {
    const { grid, config } = this.sim;
    for (let xg = grid.minXg; xg <= grid.maxXg; xg++) {
      for (let yg = grid.minYg; yg <= grid.maxYg; yg++) {
        const key = tileKey(xg, yg);
        const data = grid.get(xg, yg);

        const groundSprite = this.groundSprites.get(key)!;
        groundSprite.texture = data.pass ? this.textures.ground : this.textures.block;

        const cellSprite = this.cellSprites.get(key);
        if (!data.cell) {
          if (cellSprite) {
            this.cellContainer.removeChild(cellSprite);
            cellSprite.destroy();
            this.cellSprites.delete(key);
          }
          continue;
        }

        let sprite = cellSprite;
        if (!sprite) {
          sprite = new Sprite();
          sprite.scale.set(IMG_SCALE);
          sprite.x = xg * config.mapGridSize;
          sprite.y = yg * config.mapGridSize;
          this.cellContainer.addChild(sprite);
          this.cellSprites.set(key, sprite);
        }
        sprite.texture = this.textureForCell(data.cell);
      }
    }
  }

  private syncAnts(): void {
    const ants = this.sim.ants;
    for (let i = 0; i < ants.length; i++) {
      const ant = ants[i];
      const sprite = this.antSprites[i];
      sprite.x = ant.position.x;
      sprite.y = ant.position.y;
      sprite.rotation = dirToRad(ant);
      sprite.texture = this.textures.antWalk[walkFrame(ant)];
    }
  }

  private syncPheromoneOverlay(): void {
    this.pheromoneLayer.clear();
    if (!this.showPheromones) return;

    const { grid, config, frame } = this.sim;
    for (let xg = grid.minXg; xg <= grid.maxXg; xg++) {
      for (let yg = grid.minYg; yg <= grid.maxYg; yg++) {
        const centerX = xg * config.mapGridSize + config.mapGridSize / 2;
        const centerY = yg * config.mapGridSize + config.mapGridSize / 2;
        const { pheromones } = grid.get(xg, yg);
        for (const [interest, info] of Object.entries(pheromones)) {
          if (info.time < 0 || (info.where.x === 0 && info.where.y === 0)) continue;
          const age = frame - info.time;
          const alpha = Math.max(0.1, 1 - age / 255);
          const color = interest === 'food' ? 0xfff0c8 : 0xc8c8ff;
          this.pheromoneLayer.moveTo(centerX, centerY).lineTo(info.where.x, info.where.y).stroke({ width: 0.3, color, alpha });
        }
      }
    }
  }

  /** Redraw the current simulation state. Call once per animation frame, after `sim.update()`. */
  render(): void {
    this.worldContainer.x = this.camera.translation.x;
    this.worldContainer.y = this.camera.translation.y;
    const s = this.camera.scale * this.camera.contentScale;
    this.worldContainer.scale.set(s);

    this.syncGroundAndCells();
    this.syncAnts();
    this.syncPheromoneOverlay();
  }
}
