# *Lasius niger* foraging research — backlog beyond the pheromone system

Source: a research pass on real *L. niger* foraging biology, done to design the `'integration'`
pheromone algorithm (see `PheromoneAlgorithm` in `src/core/config.ts`). That algorithm implements
the pheromone-specific findings (trail chemistry/decay, the `(k+C)^α` junction choice function,
threshold/quality-gated recruitment, path integration for the return trip). Everything below is
from the same research but is a *behavioral/systemic* change, not a pheromone mechanic — logged
here as candidate future work rather than implemented now.

## Individual movement

- ~~**Correlated random walk + negative turn autocorrelation for exploration.**~~ **Shipped.**
  `updateAnt` (`src/core/ant.ts`) now biases a wander turn to flip sign when it would otherwise
  repeat the previous turn's direction (`SimConfig.antTurnAlternationBias`) — applied to every
  algorithm equally (a shared movement-realism change, not an `'integration'`-specific mechanic),
  so it doesn't affect cross-algorithm benchmark fairness.
- **Central-place foraging reset.** Still not modeled. Real scouts don't just CRW forever — they
  periodically reset back toward the nest rather than diffusing arbitrarily far.
  `antRestTetherRadius` covers this for *resting* ants; foraging ants have no equivalent soft
  leash. Deliberately not added: this map is already bounded (ants bounce off the edges) and food
  sites sit at a fixed, moderate distance from the nest, so an added leash risks actively
  preventing foragers from ever reaching a real, deliberately-placed food source rather than
  modeling realistic-but-unbounded-landscape search behavior. Worth revisiting only alongside a
  much larger map where "wandering too far to ever come back" becomes a real failure mode.

## Recruitment method scales with colony size

- Beckers/Goss/Deneubourg/Pasteels (1989), across 98 species: solitary → tandem running → group
  recruitment → mass pheromone recruitment → trunk trails, as colony size grows. Small colonies
  lean on individual memory/solitary foraging; only once forager density is high enough to
  out-reinforce trail evaporation does mass recruitment "ignite."
- Planqué et al. (2010): this is mechanistic, not just ecological — recruitment depends on
  encounter rates between workers, which scale with density/colony size.
- Implication for us: the small-colony sustainability fixes already shipped (rest suppression,
  line-of-sight homing, stuck-escape, closer gameplay food) are a hand-tuned analogue of "small
  colonies rely on individual navigation, not trails." The `'integration'` algorithm's
  always-on path-integration component is a first step toward making that emerge naturally
  from colony size/density rather than being hard-coded to `gameMode === 'gameplay'` +
  `antSmallColonyThreshold`. A future pass could let recruitment strength emerge purely from
  encounter-rate density instead of a threshold constant.

## Tandem running (small-colony alternative to trails)

- A one-to-one recruitment behavior: an informed forager walks slowly toward a resource while a
  single nestmate follows in antennal contact, learning the route directly. Used by small/incipient
  colonies where too few ants exist to sustain a pheromone trail. Not modeled at all currently —
  would need a "leader/follower pair" ant state, a shared target, and a route-teaching mechanic.
  Possibly the more biologically honest fix for tiny founding colonies than the trail-adjacent
  hacks currently in place.

## Quorum sensing / speed–accuracy trade-off

- Colonies commit to an option (a nest site in the studied case, but generalizes to food sources)
  only once a threshold number of nestmates are detected there, which pools individual judgment
  and improves collective accuracy; colonies can lower the threshold to decide faster but less
  accurately under urgency. Not modeled — could apply to how many foragers "commit" to a newly
  found source before the colony treats it as reliably worth full recruitment.
- Active-scout count scales roughly linearly with colony size in some species (`Temnothorax`:
  ~5.95 + 0.38 × colony size) — a concrete, checkable formula if we ever want scout-count scaling
  to be principled rather than a flat fraction.

## Negative feedback / crowding

- ~~Real foragers reduce trail deposition when they encounter many nestmates on the same
  trail.~~ **Partially shipped.** `GridCellData.traffic` (`src/core/grid.ts`) is now a decaying
  per-cell passage count, read via `readTraffic`; `'integration'`'s 'food'-trail deposit (the
  recruitment signal, not the 'cave' wayfinding one) is suppressed by
  `SimConfig.integrationCrowdingHalfSaturation` as traffic builds up on a stretch of trail. Still
  not modeled: **preferring unoccupied over occupied feeders** specifically — that would need a
  discrete "how many ants are at this exact food source right now" concept, which doesn't exist
  yet (the traffic field is a general per-tile passage count, not per-resource occupancy).

## Food/colony biology (flavor, not mechanics)

- Trophallaxis: liquid food is carried internally (crop/"social stomach") and redistributed
  mouth-to-mouth inside the nest; distribution is regulated mainly by exchange *frequency*, not
  volume per exchange. Could inform a future underground food-sharing animation/mechanic beyond
  the current larder-deposit model.
- Claustral founding: a single queen seals herself in and raises the first workers ("nanitics")
  entirely off her own reserves (mostly degraded wing muscle) without foraging at all. Matches
  the existing "no seeded brood, finite food" design of `initGameplay` reasonably well already.
- *L. niger* colonies: typically 4,000–7,000 workers (up to ~40,000 in rare cases), single queen,
  queen lifespan up to ~29 years — real-world flavor numbers, useful if we ever want an in-game
  "colony almanac"/fun-facts panel.

## ACO comparison (design philosophy note, not a task)

- Standard Ant Colony Optimization (Dorigo) deliberately diverges from real ant biology in ways
  worth remembering if we're ever tempted to "clean up" `'integration'` toward a more
  textbook-ACO shape: ACO ants see global edge-length heuristics and sometimes deposit based on
  whole-tour quality (a global evaluation no real ant performs); evaporation in ACO is a
  convergence-control device, whereas in real ants it's mostly about abandoning depleted sources.
  Keeping `'integration'` local-information-only (no global map knowledge, no tour-quality
  scoring) is a deliberate choice to stay biology-first rather than optimization-first.
