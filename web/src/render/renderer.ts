import { Container, Graphics, type Application, Sprite, type Texture } from 'pixi.js';
import { Camera } from '../core/camera';
import { type Ant, dirToRad, walkFrame } from '../core/ant';
import type { Cell } from '../core/cells';
import { FoodCell, PortalCell } from '../core/cells';
import { GRID_COM_SCAN } from '../core/config';
import { readPheromoneFlow, readPheromoneStrength } from '../core/grid';
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
  /** Keyed by ant, not index — population isn't fixed anymore (new workers eclose from brood)
   * and ants can leave this layer entirely (descend underground), so sprites are created
   * lazily and torn down when an ant is no longer on the surface, rather than a parallel
   * fixed-size array built once at construction. */
  private readonly antSprites = new Map<Ant, Sprite>();
  /** Small food icon shown at an ant's mouth while it's carrying cargo. Child of the ant
   * sprite, so it automatically follows its position/rotation — only visibility needs
   * updating per frame. */
  private readonly cargoSprites = new Map<Ant, Sprite>();

  showPheromones = false;

  set visible(value: boolean) {
    this.worldContainer.visible = value;
  }

  get visible(): boolean {
    return this.worldContainer.visible;
  }

  constructor(app: Application, sim: Simulation, textures: Textures) {
    this.app = app;
    this.sim = sim;
    this.textures = textures;

    this.worldContainer.addChild(this.groundContainer, this.cellContainer, this.pheromoneLayer, this.antContainer);
    this.worldContainer.addChild(this.buildMapBorder());
    this.app.stage.addChild(this.worldContainer);

    this.buildGroundTiles();
  }

  /** Detach and free this renderer's PixiJS objects (e.g. when restarting the simulation with
   * a fresh Simulation instance). The underlying `app`/canvas is left alone. */
  destroy(): void {
    this.app.stage.removeChild(this.worldContainer);
    this.worldContainer.destroy({ children: true });
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

  /** Lazily creates (and returns) the sprite pair for an ant that's newly on this layer. */
  private createAntSprite(ant: Ant): Sprite {
    const sprite = new Sprite(this.textures.antWalk[0]);
    sprite.anchor.set(0.5);
    sprite.scale.set(IMG_SCALE);
    sprite.x = ant.position.x;
    sprite.y = ant.position.y;

    // positioned near the front of the 32px ant texture, in the ant sprite's own local
    // (pre-scale) space, so it rides along at the mouth as the ant turns
    const cargoSprite = new Sprite(this.textures.food);
    cargoSprite.anchor.set(0.5);
    cargoSprite.scale.set(0.18);
    cargoSprite.x = 13;
    cargoSprite.visible = false;
    sprite.addChild(cargoSprite);

    this.antContainer.addChild(sprite);
    this.antSprites.set(ant, sprite);
    this.cargoSprites.set(ant, cargoSprite);
    return sprite;
  }

  private textureForCell(cell: Cell): Texture {
    switch (cell.type) {
      case 'grass':
        return this.textures.grass;
      case 'food':
        return (cell as FoodCell).isCorpse ? this.textures.corpse : this.textures.food;
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
    const onSurface = new Set<Ant>();
    for (const ant of this.sim.ants) {
      if (ant.layer !== 'surface') continue;
      onSurface.add(ant);

      const sprite = this.antSprites.get(ant) ?? this.createAntSprite(ant);
      sprite.x = ant.position.x;
      sprite.y = ant.position.y;
      sprite.rotation = dirToRad(ant);
      sprite.texture = this.textures.antWalk[walkFrame(ant)];
      sprite.tint = (ant.color[0] << 16) | (ant.color[1] << 8) | ant.color[2];
      this.cargoSprites.get(ant)!.visible = ant.cargo.count > 0;
    }

    // tear down sprites for ants that left this layer (descended underground)
    for (const [ant, sprite] of this.antSprites) {
      if (onSurface.has(ant)) continue;
      this.antContainer.removeChild(sprite);
      sprite.destroy({ children: true });
      this.antSprites.delete(ant);
      this.cargoSprites.delete(ant);
    }
  }

  /** Draws a short arrow per cell/interest showing *which way* that cell's pheromone points,
   * not just how strong it is — a flat tile tint can't show that, and direction is the whole
   * point of comparing algorithms (especially 'flow'/'diffusion', which have no other visual
   * signature). For 'legacy'/'gradient' the arrow points at the remembered `where`; for 'flow'
   * it's the decayed flow vector itself; for 'diffusion' it's the local scent gradient estimated
   * from the 8 surrounding cells (same finite-difference computation ants themselves steer by).
   * Intensity is squared before mapping to alpha/length so a merely-touched cell stays faint and
   * only genuinely concentrated trails stand out — with 1500+ ants constantly refreshing nearby
   * cells, a linear mapping made most of the map look uniformly "lit" instead of showing where
   * the real trails are. */
  private syncPheromoneOverlay(): void {
    this.pheromoneLayer.clear();
    if (!this.showPheromones) return;

    const { grid, config, frame } = this.sim;
    const gridSize = config.mapGridSize;
    const isFlow = config.pheromoneAlgorithm === 'flow';
    const isDiffusion = config.pheromoneAlgorithm === 'diffusion';

    for (let xg = grid.minXg; xg <= grid.maxXg; xg++) {
      for (let yg = grid.minYg; yg <= grid.maxYg; yg++) {
        const centerX = xg * gridSize + gridSize / 2;
        const centerY = yg * gridSize + gridSize / 2;
        const { pheromones } = grid.get(xg, yg);

        for (const [interest, info] of Object.entries(pheromones)) {
          let magnitude: number;
          let dirX: number;
          let dirY: number;

          if (isFlow) {
            const flow = readPheromoneFlow(info, frame, config.pheromoneDecayPerFrame);
            magnitude = Math.hypot(flow.x, flow.y);
            if (magnitude < 1e-3) continue;
            dirX = flow.x / magnitude;
            dirY = flow.y / magnitude;
          } else if (isDiffusion) {
            if (info.scent < 1e-3) continue; // field hasn't reached this cell yet
            let gx = 0;
            let gy = 0;
            for (const [dx, dy] of GRID_COM_SCAN) {
              if (dx === 0 && dy === 0) continue;
              const dist = Math.hypot(dx, dy);
              const neighborScent = grid.get(xg + dx, yg + dy).pheromones[interest as 'food' | 'cave'].scent;
              const rate = (neighborScent - info.scent) / dist;
              gx += (dx / dist) * rate;
              gy += (dy / dist) * rate;
            }
            const gradLen = Math.hypot(gx, gy);
            if (gradLen < 1e-3) continue; // sitting on a local peak/plateau — no direction to show
            dirX = gx / gradLen;
            dirY = gy / gradLen;
            magnitude = info.scent; // arrow prominence follows local concentration, not gradient steepness
          } else {
            magnitude = readPheromoneStrength(info, frame, config.pheromoneDecayPerFrame);
            if (magnitude <= 0) continue;
            const dx = info.where.x - centerX;
            const dy = info.where.y - centerY;
            const len = Math.hypot(dx, dy);
            if (len < 1e-3) continue;
            dirX = dx / len;
            dirY = dy / len;
          }

          const saturation = isDiffusion ? config.diffusionSourceStrength : config.pheromoneSaturation;
          const raw = Math.min(1, magnitude / saturation);
          const intensity = raw * raw; // steeper falloff so weak/ambient signal stays faint
          if (intensity < 0.03) continue;

          // vivid magenta for food, vivid cyan for cave — near-complementary hues, both far
          // enough from the tan/sand ground color to stay readable at low alpha (amber was
          // too close to the ground's own warm hue and washed out against it)
          const color = interest === 'food' ? 0xff2d95 : 0x18ffff;
          const shaftLen = gridSize * 0.15 + gridSize * 0.3 * intensity;
          const tipX = centerX + dirX * shaftLen;
          const tipY = centerY + dirY * shaftLen;
          const angle = Math.atan2(dirY, dirX);
          const headLen = Math.min(3, shaftLen * 0.45);
          const headSpread = Math.PI / 7;

          this.pheromoneLayer
            .moveTo(centerX, centerY)
            .lineTo(tipX, tipY)
            .moveTo(tipX, tipY)
            .lineTo(tipX - headLen * Math.cos(angle - headSpread), tipY - headLen * Math.sin(angle - headSpread))
            .moveTo(tipX, tipY)
            .lineTo(tipX - headLen * Math.cos(angle + headSpread), tipY - headLen * Math.sin(angle + headSpread))
            .stroke({ width: 0.3 + intensity * 0.7, color, alpha: 0.25 + intensity * 0.65 });
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
