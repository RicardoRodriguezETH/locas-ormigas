import type { Ant } from './ant';
import { resetPositionMemory, taskFound } from './ant';
import type { SimConfig } from './config';
import type { Vector2 } from './vector';

export type CellType = 'grass' | 'food' | 'cave' | 'portal';

export interface CellContext {
  frame: number;
  config: SimConfig;
}

export interface Cell {
  readonly type: CellType;
  affectAnt(ant: Ant, ctx: CellContext): void;
}

export class GrassCell implements Cell {
  readonly type = 'grass';
  friction = 0.8;

  affectAnt(ant: Ant, _ctx: CellContext): void {
    ant.friction = this.friction;
  }
}

export class FoodCell implements Cell {
  readonly type = 'food';

  affectAnt(ant: Ant, ctx: CellContext): void {
    if (ant.lookingFor !== 'food') return;
    ant.cargo.count = ant.cargo.capacity;
    ant.maxLeadScore = 0; // receptive to any lead again for the new goal
    taskFound(ant, ctx.config, ctx.frame);
  }
}

export class CaveCell implements Cell {
  readonly type = 'cave';

  affectAnt(ant: Ant, ctx: CellContext): void {
    if (ant.lookingFor !== 'cave') return;
    ant.cargo.count = 0;
    ant.maxLeadScore = 0; // receptive to any lead again for the new goal
    taskFound(ant, ctx.config, ctx.frame);
  }
}

/** Frames an ant ignores a portal it just stepped out of, so it doesn't bounce straight back. */
const PORTAL_COOLDOWN_FRAMES = 30;

export class PortalCell implements Cell {
  readonly type = 'portal';
  readonly color: 'blue' | 'orange';
  /** World position of this portal's tile center. */
  position: Vector2 = { x: 0, y: 0 };
  gridX = 0;
  gridY = 0;
  link: PortalCell | null = null;

  constructor(color: 'blue' | 'orange') {
    this.color = color;
  }

  affectAnt(ant: Ant, ctx: CellContext): void {
    if (!this.link) return;
    if (ant.teleportedOnFrame !== null && ctx.frame - ant.teleportedOnFrame <= PORTAL_COOLDOWN_FRAMES) return;
    // `position` is the linked tile's corner (matching how it's placed on the grid); step out
    // into the middle of that tile rather than right on its edge.
    const half = ctx.config.mapGridSize / 2;
    ant.position = { x: this.link.position.x + half, y: this.link.position.y + half };
    resetPositionMemory(ant, ant.position);
    ant.teleportedOnFrame = ctx.frame;
  }
}

/** Portals pair up in creation order: blue, then the next one becomes orange and links back
 * to it; the one after that starts a fresh (initially unlinked) blue, and so on. */
export class PortalFactory {
  private last: PortalCell | null = null;

  create(): PortalCell {
    let portal: PortalCell;
    if (!this.last || this.last.color === 'orange') {
      portal = new PortalCell('blue');
    } else {
      portal = new PortalCell('orange');
      portal.link = this.last;
      this.last.link = portal;
    }
    this.last = portal;
    return portal;
  }
}
