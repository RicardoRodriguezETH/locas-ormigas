# Locas Ormigas — web

A from-scratch TypeScript + PixiJS rewrite of the original Löve2D/Lua ant colony
simulation (see the repo root for the original). This is the first milestone of the
rewrite: a clean, tested, well-separated architecture with the same core simulation
behavior, running in any modern browser (macOS included) as a first step toward an
eventual iOS build.

## Layout

- `src/core/` — the simulation itself: vectors, config, the world grid, cell types
  (food/cave/grass/portals), ants, the camera, and the `Simulation` orchestrator. No
  rendering or DOM dependencies, so it's fully unit-tested in isolation.
- `src/render/` — PixiJS rendering: texture loading and a `SimulationRenderer` that
  draws whatever `Simulation` currently holds.
- `src/ui/` — the DOM-based tool sidebar (cell painting tools, zoom, pheromone toggle).
- `src/main.ts` — wires it all together: input handling, camera, and the frame loop.

## Scripts

```
npm install
npm run dev        # local dev server with hot reload
npm run build       # typecheck + production build to dist/
npm test            # run the unit test suite (vitest)
npm run typecheck   # tsc --noEmit
```

## Status

Core simulation (grid, ants, pheromone communication, food/cave task cycle, portals,
collision/avoidance) is ported and unit-tested. Rendering and the tool sidebar are
functional but intentionally minimal — visual/gameplay polish is a later milestone.

## Inspiration & direction

The original is an ant-trail *simulation*; this rewrite is growing into a colony
**management/builder** game. **RimWorld is a major inspiration** — its
colony-simulation depth is the north star for where this can go. Features worth
drawing from at some point:

- Colonists (here: ants) with needs, roles/jobs, and priorities you can tune.
- A living world that produces events and resources over time (weather/seasons,
  raids/predators, resource nodes, hauling and stockpiles).
- Corpses and materials as resources (already started: a dead ant leaves a finite
  corpse other ants forage).
- Zones and designations (already started underground: designated-diggable frontier,
  queen/nursery/larder chambers) — extendable into player-drawn rooms and stockpile
  zones.
- An incident/story layer and readable stats/overlays for what the colony is doing.

None of this is committed scope — it's the design compass for prioritising features.
