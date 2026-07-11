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
