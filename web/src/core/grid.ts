import type { Ant } from './ant';
import { GRID_COM_SCAN, INTERESTS, type Interest, type SimConfig } from './config';
import { CaveCell, type Cell, FoodCell, type FoodType, GrassCell, PortalCell, PortalFactory } from './cells';
import { type Vector2 } from './vector';

export interface PheromoneInfo {
  /** Concentration as of `lastUpdated`; decays continuously after that — read it with
   * `readPheromoneStrength` rather than using this field directly. Used by the 'gradient'
   * algorithm, and kept updated by 'legacy' too so the debug overlay can render either. */
  strength: number;
  /** Shared decay clock for `strength` and `flow` alike — whichever algorithm is active only
   * ever touches the fields it uses, so one timestamp for both is safe. */
  lastUpdated: number;
  /** 'legacy' algorithm only: frame this was last reported here; -1 = never. */
  time: number;
  /** 'legacy'/'gradient' only: world position to head toward to chase this lead. */
  where: Vector2;
  /** 'flow' algorithm only: decaying sum of the headings of ants who deposited here while
   * seeking this interest. Its *direction* is the trail's direction, its *magnitude* is the
   * trail's strength — read it with `readPheromoneFlow`. */
  flow: Vector2;
  /** 'diffusion' algorithm only: this cell's current scent concentration, maintained entirely by
   * `WorldGrid.diffuseScent` (no per-ant decay math needed — read it directly). */
  scent: number;
}

/** 8-directional neighbor offsets used by scent diffusion — `GRID_COM_SCAN` minus its own-cell
 * entry. */
const DIFFUSION_NEIGHBORS = GRID_COM_SCAN.filter(([dx, dy]) => dx !== 0 || dy !== 0);

/** Plain-data stand-in for a `Cell` instance, for save/load — see `WorldGrid.exportModifiedCells`.
 * Fields are a union of every cell type's needs rather than a proper discriminated union per
 * type, since it's only ever produced/consumed by the (de)serializer right next to it. */
export interface SerializedCell {
  type: 'grass' | 'food' | 'cave' | 'portal';
  foodType?: FoodType;
  nutrients?: number;
  nutrientsMax?: number;
  perishable?: boolean;
  isCorpse?: boolean;
  discovered?: boolean;
  color?: 'blue' | 'orange';
  linkGridX?: number;
  linkGridY?: number;
}

export interface SerializedGridCell {
  xg: number;
  yg: number;
  pass: boolean;
  cell: SerializedCell | null;
}

export interface GridCellData {
  /** Can an ant walk through this tile? */
  pass: boolean;
  cell: Cell | null;
  pheromones: Record<Interest, PheromoneInfo>;
  /** 'integration' algorithm only: a decaying count of how many ants have recently passed
   * through this tile — not per-interest, unlike `pheromones` (crowding is about *traffic*, not
   * about food or the cave specifically). Read with `readTraffic`, bumped in
   * `Simulation.communicatePheromonesIntegration`. See `SimConfig.integrationCrowdingHalfSaturation`
   * for why this exists. */
  traffic: number;
  trafficLastUpdated: number;
}

/** Current concentration of a pheromone deposit, decayed for the time elapsed since it was
 * last topped up. Lazy exponential decay: cheap to read, and needs no per-frame sweep of the
 * whole grid to "tick down" cells nobody is currently looking at. */
export function readPheromoneStrength(info: PheromoneInfo, frame: number, decayPerFrame: number): number {
  const elapsed = frame - info.lastUpdated;
  if (elapsed <= 0) return info.strength;
  return info.strength * decayPerFrame ** elapsed;
}

/** Current decayed traffic count — same lazy-decay shape as `readPheromoneStrength`. */
export function readTraffic(cell: GridCellData, frame: number, decayPerFrame: number): number {
  const elapsed = frame - cell.trafficLastUpdated;
  if (elapsed <= 0) return cell.traffic;
  return cell.traffic * decayPerFrame ** elapsed;
}

/** Current flow vector, decayed the same way as `readPheromoneStrength` — shrinking the
 * vector's magnitude over time while preserving its direction. */
export function readPheromoneFlow(info: PheromoneInfo, frame: number, decayPerFrame: number): Vector2 {
  const elapsed = frame - info.lastUpdated;
  if (elapsed <= 0) return info.flow;
  const factor = decayPerFrame ** elapsed;
  return { x: info.flow.x * factor, y: info.flow.y * factor };
}

/** Placeable tile types, as exposed to the UI's cell-painting tool. */
export type PaintableCellType = 'block' | 'grass' | 'food' | 'cave' | 'portal' | 'ground';

const GRID_BORDER = 2;

/** The world's spatial grid: walkability, special tiles (food/cave/grass/portals), and the
 * pheromone trails ants leave behind. Extends slightly past the map's visible bounds so
 * neighbor lookups never need bounds-checking. */
export class WorldGrid {
  readonly config: SimConfig;
  readonly minXg: number;
  readonly maxXg: number;
  readonly minYg: number;
  readonly maxYg: number;

  private cells = new Map<string, GridCellData>();
  private portalFactory = new PortalFactory();
  /** 'gameplay' mode only (see `Simulation.gameMode`): every food cell placed from here on —
   * whether seeded at map-build time or painted later with the tool sidebar — is finite
   * (`perishable: true`) instead of the effectively-bottomless default 'testing' mode uses for
   * fair, comparable pheromone-algorithm benchmarking. One flag rather than threading an option
   * through every call site, so painting food mid-game stays consistent with map-seeded food
   * without the UI needing to know or care which mode is active. */
  foodIsFinite = false;
  /** Reused scratch buffer for `diffuseScent`'s neighbor-average pass, sized once on first use —
   * avoids reallocating a grid-sized array every relaxation step (this runs several times a
   * frame while the 'diffusion' algorithm is active). */
  private diffusionScratch: Float64Array | null = null;
  /** Flat-array mirror of `cells`, indexed the same way as `diffusionScratch` — built once and
   * reused forever. Safe because every in-bounds cell is created eagerly in the constructor and
   * never replaced afterward (`removeCell`/`setCellAtWorld` mutate a `GridCellData` in place),
   * so a reference captured here stays valid. Exists purely to get `diffuseScentStep`'s hot inner
   * loop off `get()`'s per-call string-key + `Map` lookup — profiling showed that lookup
   * dominated 'diffusion''s frame cost (a full-grid scan, several times a frame) to the point of
   * being the difference between comparable-to and ~20x slower than the other three algorithms. */
  private diffusionCellArray: GridCellData[] | null = null;
  /** Precomputed in-bounds neighbor indices (into `diffusionCellArray`) per cell, same reasoning
   * as `diffusionCellArray` — geometry only (no passability baked in, so a wall painted at
   * runtime is still picked up correctly by reading `.pass` fresh off the referenced cell). */
  private diffusionNeighborIndices: Int32Array[] | null = null;

  constructor(config: SimConfig, options: { randomize?: boolean } = {}) {
    this.config = config;
    const gridSize = config.mapGridSize;
    this.minXg = Math.floor(config.mapMinX / gridSize) - GRID_BORDER;
    this.maxXg = Math.floor(config.mapMaxX / gridSize) + GRID_BORDER;
    this.minYg = Math.floor(config.mapMinY / gridSize) - GRID_BORDER;
    this.maxYg = Math.floor(config.mapMaxY / gridSize) + GRID_BORDER;

    const randomize = options.randomize ?? true;
    for (let xg = this.minXg; xg <= this.maxXg; xg++) {
      for (let yg = this.minYg; yg <= this.maxYg; yg++) {
        this.initCell(xg, yg, randomize);
      }
    }
  }

  private key(xg: number, yg: number): string {
    return `${xg},${yg}`;
  }

  private initCell(xg: number, yg: number, randomize: boolean): GridCellData {
    const data: GridCellData = {
      pass: true,
      cell: null,
      pheromones: {
        food: { strength: 0, lastUpdated: 0, time: -1, where: { x: 0, y: 0 }, flow: { x: 0, y: 0 }, scent: 0 },
        cave: { strength: 0, lastUpdated: 0, time: -1, where: { x: 0, y: 0 }, flow: { x: 0, y: 0 }, scent: 0 },
      },
      traffic: 0,
      trafficLastUpdated: 0,
    };
    // light scattered grass for texture; no random blocks (those are placed deliberately as
    // obstacles in `Simulation.buildBaseMap`, and stray ones were an ascend/spawn hazard)
    if (randomize && Math.random() < 0.004) data.cell = new GrassCell();
    this.cells.set(this.key(xg, yg), data);
    return data;
  }

  get(xg: number, yg: number): GridCellData {
    return this.cells.get(this.key(xg, yg)) ?? this.initCell(xg, yg, false);
  }

  isInsideGrid(xg: number, yg: number): boolean {
    return xg >= this.minXg && xg <= this.maxXg && yg >= this.minYg && yg <= this.maxYg;
  }

  worldToGrid(x: number, y: number): [number, number] {
    const gridSize = this.config.mapGridSize;
    return [Math.floor(x / gridSize), Math.floor(y / gridSize)];
  }

  /** Top-left world corner of a grid tile (tile sprites are positioned/anchored from here). */
  gridToWorldOrigin(xg: number, yg: number): Vector2 {
    const gridSize = this.config.mapGridSize;
    return { x: xg * gridSize, y: yg * gridSize };
  }

  canPass(position: Vector2): boolean {
    const [xg, yg] = this.worldToGrid(position.x, position.y);
    return this.get(xg, yg).pass;
  }

  /** Places food/cave directly by grid coordinates, used for initial world seeding. `foodType`
   * is ignored for 'cave'. */
  seedCell(type: 'food' | 'cave', xg: number, yg: number, foodType?: FoodType): void {
    const data = this.get(xg, yg);
    data.pass = true;
    data.cell = type === 'food' ? new FoodCell(foodType, { perishable: this.foodIsFinite }) : new CaveCell();
  }

  /** Places a decorative grass tile by grid coords, only on empty passable ground (won't paint
   * over food/cave/walls). Used to seed grass patches at world init. */
  seedGrass(xg: number, yg: number): void {
    const data = this.get(xg, yg);
    if (data.pass && !data.cell) data.cell = new GrassCell();
  }

  removeCell(xg: number, yg: number): void {
    const data = this.get(xg, yg);
    if (data.cell?.type === 'portal') {
      const linked = (data.cell as PortalCell).link;
      if (linked) {
        const linkedData = this.get(linked.gridX, linked.gridY);
        linkedData.pass = true;
        linkedData.cell = null;
      }
    }
    data.cell = null;
    data.pass = true;
  }

  /** Paints a tile from world coordinates, matching the UI's click/drag cell tool. */
  setCellAtWorld(type: PaintableCellType, worldPosition: Vector2): void {
    const [xg, yg] = this.worldToGrid(worldPosition.x, worldPosition.y);
    if (!this.isInsideGrid(xg, yg)) return;

    this.removeCell(xg, yg);
    const data = this.get(xg, yg);
    switch (type) {
      case 'block':
        data.pass = false;
        break;
      case 'grass':
        data.cell = new GrassCell();
        break;
      case 'food':
        data.cell = new FoodCell(undefined, { perishable: this.foodIsFinite });
        break;
      case 'cave':
        data.cell = new CaveCell();
        break;
      case 'portal': {
        const portal = this.portalFactory.create();
        portal.gridX = xg;
        portal.gridY = yg;
        portal.position = this.gridToWorldOrigin(xg, yg);
        data.cell = portal;
        break;
      }
      case 'ground':
        // removeCell above already cleared it back to plain ground
        break;
    }
  }

  private serializeCell(cell: Cell | null): SerializedCell | null {
    if (cell instanceof FoodCell) {
      return {
        type: 'food',
        foodType: cell.foodType,
        nutrients: cell.nutrients,
        nutrientsMax: cell.nutrientsMax,
        perishable: cell.perishable,
        isCorpse: cell.isCorpse,
        discovered: cell.discovered,
      };
    }
    if (cell instanceof CaveCell) return { type: 'cave', discovered: cell.discovered };
    if (cell instanceof GrassCell) return { type: 'grass' };
    if (cell instanceof PortalCell) {
      return { type: 'portal', color: cell.color, linkGridX: cell.link?.gridX, linkGridY: cell.link?.gridY };
    }
    return null;
  }

  /** Exports only cells that differ from a freshly-initialized grid (a wall, or anything
   * placed) — for `Simulation` save/load. Pheromone trail data is deliberately excluded: it's
   * transient and rebuilds naturally within moments of resuming play, and skipping it keeps a
   * save's size independent of how long the colony's been running. */
  exportModifiedCells(): SerializedGridCell[] {
    const out: SerializedGridCell[] = [];
    for (const [key, data] of this.cells) {
      if (data.pass && !data.cell) continue; // default state, nothing to save
      const [xg, yg] = key.split(',').map(Number);
      out.push({ xg, yg, pass: data.pass, cell: this.serializeCell(data.cell) });
    }
    return out;
  }

  /** Restores cells previously captured by `exportModifiedCells`. Clears the grid back to
   * default first, so loading into a grid that already has painted walls/food doesn't leave
   * stale leftovers, then replays each saved cell. Portal links are resolved in a second pass
   * since a linked portal's own cell might not exist yet on the first (note: `portalFactory`'s
   * own blue/orange pairing state isn't restored, so a portal painted after loading always
   * starts a fresh pairing rather than continuing one from the save — a minor cosmetic gap, not
   * worth the extra bookkeeping for how rarely portals get painted mid-game). */
  importModifiedCells(cells: SerializedGridCell[]): void {
    this.cells.clear();
    for (let xg = this.minXg; xg <= this.maxXg; xg++) {
      for (let yg = this.minYg; yg <= this.maxYg; yg++) {
        this.initCell(xg, yg, false);
      }
    }
    // stale after clearing/rebuilding `cells` — references would point at discarded objects
    this.diffusionCellArray = null;
    this.diffusionNeighborIndices = null;

    const portalCells: Array<{ data: GridCellData; saved: SerializedCell }> = [];
    for (const saved of cells) {
      const data = this.get(saved.xg, saved.yg);
      data.pass = saved.pass;
      if (!saved.cell) continue;
      switch (saved.cell.type) {
        case 'grass':
          data.cell = new GrassCell();
          break;
        case 'food': {
          const food = new FoodCell(saved.cell.foodType, {
            nutrients: saved.cell.nutrientsMax,
            perishable: saved.cell.perishable,
            isCorpse: saved.cell.isCorpse,
          });
          if (saved.cell.nutrients !== undefined) food.nutrients = saved.cell.nutrients;
          food.discovered = saved.cell.discovered ?? false;
          data.cell = food;
          break;
        }
        case 'cave': {
          const cave = new CaveCell();
          cave.discovered = saved.cell.discovered ?? false;
          data.cell = cave;
          break;
        }
        case 'portal': {
          const portal = new PortalCell(saved.cell.color ?? 'blue');
          portal.gridX = saved.xg;
          portal.gridY = saved.yg;
          portal.position = this.gridToWorldOrigin(saved.xg, saved.yg);
          data.cell = portal;
          portalCells.push({ data, saved: saved.cell });
          break;
        }
      }
    }
    for (const { data, saved } of portalCells) {
      if (saved.linkGridX === undefined || saved.linkGridY === undefined) continue;
      const linkedCell = this.get(saved.linkGridX, saved.linkGridY).cell;
      if (linkedCell instanceof PortalCell) (data.cell as PortalCell).link = linkedCell;
    }
  }

  /** One relaxation step of scent diffusion, for the 'diffusion' pheromone algorithm: every
   * passable cell's scent moves partway toward the average of its passable neighbors' scent
   * (walls are excluded from that average — an *impassable* neighbor is treated the same as no
   * neighbor there at all, so the field can't leak through solid ground and its gradient
   * organically wraps around obstacles instead), decays a little, and any discovered resource
   * cell is then pinned back up to full strength — a fixed-value heat source. Snapshots the old
   * field into a scratch buffer first so the relaxation is simultaneous (order-independent), not
   * a cascading sweep. Called `diffusionSubstepsPerFrame` times per frame, only while 'diffusion'
   * is the active algorithm. */
  diffuseScentStep(cfg: SimConfig): void {
    const { cellArray, neighborIndices } = this.ensureDiffusionCache();
    const size = cellArray.length;
    if (!this.diffusionScratch || this.diffusionScratch.length !== size) {
      this.diffusionScratch = new Float64Array(size);
    }
    const scratch = this.diffusionScratch;

    for (const interest of INTERESTS) {
      for (let i = 0; i < size; i++) {
        scratch[i] = cellArray[i].pheromones[interest].scent;
      }

      for (let i = 0; i < size; i++) {
        const data = cellArray[i];
        if (!data.pass) {
          data.pheromones[interest].scent = 0; // solid ground holds no scent
          continue;
        }

        let sum = 0;
        let count = 0;
        const neighbors = neighborIndices[i];
        for (let n = 0; n < neighbors.length; n++) {
          const nIdx = neighbors[n];
          if (!cellArray[nIdx].pass) continue; // walls block the exchange
          sum += scratch[nIdx];
          count++;
        }
        const own = scratch[i];
        const avgNeighbor = count > 0 ? sum / count : own;
        let next = (own + cfg.diffusionRate * (avgNeighbor - own)) * cfg.diffusionDecayPerStep;

        // a discovered source only pins the scent for its *own* interest — a food cell has
        // nothing to say about the 'cave' field, and vice versa
        const isDiscoveredSource =
          (interest === 'food' && data.cell instanceof FoodCell && data.cell.discovered) ||
          (interest === 'cave' && data.cell instanceof CaveCell && data.cell.discovered);
        if (isDiscoveredSource) {
          next = cfg.diffusionSourceStrength; // pinned, not decayed/diffused away
        }
        data.pheromones[interest].scent = Math.max(0, next);
      }
    }
  }

  /** Lazily builds (and forever after just returns) `diffusionCellArray`/`diffusionNeighborIndices`
   * — see their doc comments for why this caching is safe and why it exists. */
  private ensureDiffusionCache(): { cellArray: GridCellData[]; neighborIndices: Int32Array[] } {
    if (this.diffusionCellArray && this.diffusionNeighborIndices) {
      return { cellArray: this.diffusionCellArray, neighborIndices: this.diffusionNeighborIndices };
    }
    const width = this.maxXg - this.minXg + 1;
    const idx = (xg: number, yg: number) => (yg - this.minYg) * width + (xg - this.minXg);

    const cellArray: GridCellData[] = [];
    for (let xg = this.minXg; xg <= this.maxXg; xg++) {
      for (let yg = this.minYg; yg <= this.maxYg; yg++) {
        cellArray[idx(xg, yg)] = this.get(xg, yg);
      }
    }

    const neighborIndices: Int32Array[] = [];
    for (let xg = this.minXg; xg <= this.maxXg; xg++) {
      for (let yg = this.minYg; yg <= this.maxYg; yg++) {
        const list: number[] = [];
        for (const [dx, dy] of DIFFUSION_NEIGHBORS) {
          const nx = xg + dx;
          const ny = yg + dy;
          if (nx < this.minXg || nx > this.maxXg || ny < this.minYg || ny > this.maxYg) continue;
          list.push(idx(nx, ny));
        }
        neighborIndices[idx(xg, yg)] = Int32Array.from(list);
      }
    }

    this.diffusionCellArray = cellArray;
    this.diffusionNeighborIndices = neighborIndices;
    return { cellArray, neighborIndices };
  }

  /** Runs `diffuseScentStep` `diffusionSubstepsPerFrame` times — more substeps make the field
   * physically propagate across the map faster in simulated time, independent of how often ants
   * themselves re-sample it. */
  diffuseScent(cfg: SimConfig): void {
    for (let i = 0; i < cfg.diffusionSubstepsPerFrame; i++) {
      this.diffuseScentStep(cfg);
    }
  }

  private collidesWithLimits(position: Vector2, direction: Vector2): boolean {
    const { mapMinX, mapMaxX, mapMinY, mapMaxY } = this.config;
    if (position.x < mapMinX) {
      if (direction.x < 0) direction.x = -direction.x;
      return true;
    } else if (position.x > mapMaxX) {
      if (direction.x > 0) direction.x = -direction.x;
      return true;
    }
    if (position.y < mapMinY) {
      if (direction.y < 0) direction.y = -direction.y;
      return true;
    } else if (position.y > mapMaxY) {
      if (direction.y > 0) direction.y = -direction.y;
      return true;
    }
    return false;
  }

  private collidesWithCell(position: Vector2, direction: Vector2): boolean {
    const gridSize = this.config.mapGridSize;
    const [xg, yg] = this.worldToGrid(position.x, position.y);
    if (this.get(xg, yg).pass) return false;

    const centerX = (xg + 0.5) * gridSize;
    const centerY = (yg + 0.5) * gridSize;
    const relX = position.x - centerX;
    const relY = position.y - centerY;
    // which side of the blocking tile did we hit? bounce off the nearer edge.
    if ((relY < -relX && relY > relX) || (relY > -relX && relY < relX)) {
      // left or right side
      if (direction.y >= 0) {
        direction.x = 0;
        direction.y = 1;
      } else {
        direction.x = 0;
        direction.y = -1;
      }
    } else {
      // top or bottom side
      if (direction.x >= 0) {
        direction.x = 1;
        direction.y = 0;
      } else {
        direction.x = -1;
        direction.y = 0;
      }
    }
    return true;
  }

  /** True (and nudges `direction`) if `position` collides with the map limits or a blocking
   * tile. `direction` is mutated in place, mirroring how the caller's movement vector reacts. */
  anyCollisionWith(position: Vector2, direction: Vector2): boolean {
    return this.collidesWithLimits(position, direction) || this.collidesWithCell(position, direction);
  }

  /** An ant is thoroughly stuck (e.g. the user painted a block on top of it): spiral outward
   * from its current spot until we find a free tile, and snap it there. */
  private fixTrapped(ant: Ant): void {
    let angle = 0;
    let radius = 0;
    let collision = true;
    let p: Vector2 = { x: 0, y: 0 };
    do {
      radius += 1;
      angle += 0.1;
      p = {
        x: ant.position.x + radius * Math.cos(angle),
        y: ant.position.y + radius * Math.sin(angle),
      };
      collision = this.anyCollisionWith(p, ant.direction);
    } while (collision && radius < 100);

    if (radius < 100) {
      ant.position = p;
    }
  }

  /** Moves an ant one step, deflecting off obstacles/limits and using `fixTrapped` as a last
   * resort if it's still stuck after a few bounce attempts. */
  resolveBlockingCollisionAndMove(ant: Ant, frame: number): void {
    let numTries = 0;
    let collision = false;
    const dir = { ...ant.direction };
    let newPosition: Vector2 = { ...ant.position };

    do {
      numTries += 1;
      newPosition = {
        x: ant.position.x + dir.x * ant.speed,
        y: ant.position.y + dir.y * ant.speed,
      };
      collision = this.anyCollisionWith(newPosition, dir);
      if (collision && numTries === 3) {
        dir.x = -ant.direction.x;
        dir.y = -ant.direction.y;
      } else if (collision && numTries === 6) {
        this.fixTrapped(ant);
      }
    } while (collision && numTries < 6);

    ant.direction = dir;
    ant.position = {
      x: ant.position.x + dir.x * ant.speed,
      y: ant.position.y + dir.y * ant.speed,
    };
    ant.traveled += ant.speed;

    if (numTries > 1) {
      ant.lastCollisionTime = frame;
    }
  }
}
