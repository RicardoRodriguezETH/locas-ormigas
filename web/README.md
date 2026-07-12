# Locas Ormigas — web

A from-scratch TypeScript + PixiJS rewrite of the original Löve2D/Lua ant colony simulation
(see the repo root for the original). Runs in any modern browser, phone included, with an
eventual path to a native iOS build.

**[Live demo](https://ricardorodriguezeth.github.io/locas-ormigas/)** — auto-deployed on every
push to `master` that touches this directory.

## Layout

- `src/core/` — the simulation itself: vectors, config, the world grid, cell types
  (food/cave/grass/portals), ants, brood/queen, the underground grid, the camera, and the
  `Simulation` orchestrator. No rendering or DOM dependencies, so it's fully unit-tested in
  isolation (`src/core/__tests__/`).
- `src/render/` — PixiJS rendering: texture loading and a `SimulationRenderer`/
  `UndergroundRenderer` that draw whatever `Simulation` currently holds, including an optional
  pheromone debug overlay.
- `src/ui/` — the DOM-based tool sidebar (cell painting tools, zoom, layer switch, pheromone
  toggle and algorithm picker).
- `src/main.ts` — wires it all together: pointer input (mouse + touch), camera, and the frame
  loop.

## Scripts

```
npm install
npm run dev         # local dev server with hot reload
npm run build        # typecheck + production build to dist/
npm test             # run the unit test suite (vitest)
npm run typecheck    # tsc --noEmit
```

## Status

Core simulation, rendering, and tooling are functional and unit-tested. Current feature set:

- **Foraging loop**: ants cycle between finding food and delivering it to the cave, with erratic
  wander, collision/obstacle avoidance, and a rest/idle activity cycle (scouts explore
  independently; ants near the nest can be recruited back out when a strong trail signal is
  present).
- **Pheromone communication** — four selectable algorithms (toggle in the sidebar), all gated so
  an ant only acts on a resource once it (or another ant) has actually reached it:
  - **Legacy** — raw frame-time argmax, no decay.
  - **Gradient** — same argmax, but the lead's score exponentially decays/evaporates over time.
  - **Flow** — each cell holds a decaying, accumulating direction vector instead of a remembered
    point, so trails curve rather than beeline.
  - **Diffusion** — a discretized heat-equation scent field that only diffuses through passable
    cells, so it naturally bends around obstacles; ants climb the local gradient. Outperforms the
    other three on the obstacle-heavy stress-test map.
- **Colony**: a queen lays eggs, brood advances through egg → larva → pupa → callow-worker
  stages (fed from stored food), and a colony-level foraging throttle keeps delivery rate
  proportional to actual demand rather than saturating.
- **Underground layer**: ants dig a chamber network below the cave with a designated-diggable
  frontier, separate from the surface layer; nursery/larder-style zoning is in progress.
- **World**: obstacle/wall map with food tucked into wall pockets (a stress test for pathfinding
  quality, not just distance), portals, corpses left by dead ants as a finite scavengeable food
  source, and a paint-tool sidebar (block/grass/food/remove) for editing the map live.

## Inspiration & direction

The original is an ant-trail *simulation*; this rewrite is growing into a colony
**management/builder** game. **RimWorld is a major inspiration** — its colony-simulation depth
is the north star for where this can go. Already underway: colonists (ants) with roles and an
activity cycle, a queen/brood pipeline, underground zones/designations, and corpses as a
resource. Worth drawing from next:

- Needs and priorities that actually compete (hunger, rest, defense) rather than a single
  foraging loop.
- A living world that produces events over time (weather/seasons, raids/predators, resource
  nodes depleting and respawning).
- Player-drawn rooms and stockpile zones, extending the underground designation system.
- An incident/story layer and richer readable stats/overlays for what the colony is doing.

None of this is committed scope — it's the design compass for prioritizing features.
