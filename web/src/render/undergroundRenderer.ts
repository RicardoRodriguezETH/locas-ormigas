import { Container, type Application, Sprite } from 'pixi.js';
import type { Camera } from '../core/camera';
import { dirToRad, walkFrame, type Ant } from '../core/ant';
import type { Brood } from '../core/brood';
import type { Simulation } from '../core/simulation';
import type { Textures } from './textures';

const IMG_SCALE = 0.25;

function tileKey(xg: number, yg: number): string {
  return `${xg},${yg}`;
}

/** Draws the below-ground overlay: dug tunnels/chambers vs solid dirt, and the underground
 * ants digging/wandering through them. Shares the surface renderer's `Camera` so panning/
 * zooming stays in sync between the two overlays when toggling. */
export class UndergroundRenderer {
  private readonly app: Application;
  private readonly sim: Simulation;
  private readonly textures: Textures;
  private readonly camera: Camera;

  private readonly worldContainer = new Container();
  private readonly groundContainer = new Container();
  private readonly cellContainer = new Container();
  private readonly broodContainer = new Container();
  private readonly antContainer = new Container();
  private readonly queenSprite: Sprite;
  private readonly larderPileSprite: Sprite;

  private readonly groundSprites = new Map<string, Sprite>();
  private readonly antSprites = new Map<Ant, Sprite>();
  /** Small food icon shown at a delivering ant's mouth, mirroring `SimulationRenderer`'s
   * cargo indicator — otherwise a food delivery in progress looks identical to plain wandering. */
  private readonly cargoSprites = new Map<Ant, Sprite>();
  private readonly broodSprites = new Map<Brood, Sprite>();

  constructor(app: Application, sim: Simulation, textures: Textures, camera: Camera) {
    this.app = app;
    this.sim = sim;
    this.textures = textures;
    this.camera = camera;

    this.worldContainer.addChild(this.groundContainer, this.cellContainer, this.broodContainer, this.antContainer);
    this.app.stage.addChild(this.worldContainer);
    this.worldContainer.visible = false;

    this.buildGroundTiles();
    this.buildEntranceMarker();
    this.queenSprite = this.buildQueenSprite();
    this.larderPileSprite = this.buildLarderPile();
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

  /** A clear "this is the hole leading back up to the surface" landmark — reuses the same cave
   * texture as the surface entrance so the connection between the two overlays reads instantly,
   * rather than the entrance chamber looking like just another patch of tunnel. */
  private buildEntranceMarker(): void {
    const { undergroundGrid, cavePosition } = this.sim;
    const [xg, yg] = undergroundGrid.worldToGrid(cavePosition.x, cavePosition.y);
    const origin = undergroundGrid.gridToWorldOrigin(xg, yg);

    const sprite = new Sprite(this.textures.cave);
    sprite.scale.set(IMG_SCALE);
    sprite.x = origin.x;
    sprite.y = origin.y;
    this.cellContainer.addChild(sprite);
  }

  private buildQueenSprite(): Sprite {
    const sprite = new Sprite(this.textures.queen);
    sprite.anchor.set(0.5);
    sprite.scale.set(IMG_SCALE * 2.2);
    this.antContainer.addChild(sprite);
    return sprite;
  }

  /** A visible pile at the larder chamber that grows with `foodStored` — otherwise the colony's
   * food store is an invisible number with no chamber of its own to look at, and delivering
   * ants would read as endlessly feeding the queen directly (see `syncLarder`). */
  private buildLarderPile(): Sprite {
    const sprite = new Sprite(this.textures.food);
    sprite.anchor.set(0.5);
    sprite.x = this.sim.larderPosition.x;
    sprite.y = this.sim.larderPosition.y;
    sprite.scale.set(0);
    this.cellContainer.addChild(sprite);
    return sprite;
  }

  private createAntSprite(ant: Ant): Sprite {
    const sprite = new Sprite(this.textures.antWalk[0]);
    sprite.anchor.set(0.5);
    sprite.scale.set(IMG_SCALE);
    sprite.x = ant.position.x;
    sprite.y = ant.position.y;

    // positioned near the front of the 32px ant texture, matching the surface renderer's
    // cargo indicator so the same visual language carries across both overlays
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
    const underground = new Set<Ant>();
    for (const ant of this.sim.ants) {
      if (ant.layer !== 'underground') continue;
      underground.add(ant);

      const sprite = this.antSprites.get(ant) ?? this.createAntSprite(ant);
      sprite.x = ant.position.x;
      sprite.y = ant.position.y;
      sprite.rotation = dirToRad(ant);
      sprite.texture = this.textures.antWalk[walkFrame(ant)];
      sprite.tint = (ant.color[0] << 16) | (ant.color[1] << 8) | ant.color[2];
      this.cargoSprites.get(ant)!.visible = ant.cargo.count > 0;
    }

    // tear down sprites for ants that left this layer (resurfaced)
    for (const [ant, sprite] of this.antSprites) {
      if (underground.has(ant)) continue;
      this.antContainer.removeChild(sprite);
      sprite.destroy({ children: true });
      this.antSprites.delete(ant);
      this.cargoSprites.delete(ant);
    }
  }

  private syncQueen(): void {
    this.queenSprite.x = this.sim.queen.position.x;
    this.queenSprite.y = this.sim.queen.position.y;
  }

  /** Grows the larder pile with `foodStored` (square-root so early deliveries are still
   * visible rather than the pile staying invisibly tiny for a long warm-up period), capped at
   * a bit larger than one tile so it doesn't overrun the chamber. */
  private syncLarder(): void {
    const { foodStored } = this.sim;
    const growth = Math.min(1, Math.sqrt(foodStored) / Math.sqrt(150));
    this.larderPileSprite.scale.set(foodStored > 0.01 ? IMG_SCALE * (0.15 + growth * 0.85) : 0);
  }

  private createBroodSprite(): Sprite {
    const sprite = new Sprite(this.textures.egg);
    sprite.anchor.set(0.5);
    this.broodContainer.addChild(sprite);
    return sprite;
  }

  /** Brood items are created (eggs laid) and removed (eclosion) constantly over the colony's
   * lifetime, so sprites are lazily created/torn down the same way ant sprites are. Larvae grow
   * visibly with age via scale, matching their real size increase before pupating. */
  private syncBrood(): void {
    const alive = new Set<Brood>();
    for (const b of this.sim.brood) {
      alive.add(b);
      const sprite = this.broodSprites.get(b) ?? this.createBroodSprite();
      this.broodSprites.set(b, sprite);
      sprite.x = b.position.x;
      sprite.y = b.position.y;

      if (b.stage === 'egg') {
        sprite.texture = this.textures.egg;
        sprite.scale.set(IMG_SCALE);
      } else if (b.stage === 'larva') {
        const growth = Math.min(1, b.ageDays / this.sim.config.larvaDurationDays);
        sprite.texture = this.textures.larva;
        sprite.scale.set(IMG_SCALE * (0.7 + growth * 0.5));
      } else {
        sprite.texture = this.textures.pupa;
        sprite.scale.set(IMG_SCALE);
      }
    }

    for (const [b, sprite] of this.broodSprites) {
      if (alive.has(b)) continue;
      this.broodContainer.removeChild(sprite);
      sprite.destroy({ children: true });
      this.broodSprites.delete(b);
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
    this.syncQueen();
    this.syncLarder();
    this.syncBrood();
    this.syncAnts();
  }
}
