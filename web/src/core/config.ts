/** Things ants look for and communicate about via pheromone trails. */
export const INTERESTS = ['food', 'cave'] as const;
export type Interest = (typeof INTERESTS)[number];

/** Relative grid offsets scanned for pheromone info: self + 8 neighbors. */
export const GRID_COM_SCAN: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/** Five options, roughly in evolutionary order:
 *
 * 'legacy' is a *literal* port of the original Löve2D/Lua game's pheromone system, kept
 * deliberately unfixed as a true baseline — see `Simulation.communicatePheromonesClassic` for
 * the full rationale and the specific Lua lines it mirrors. In short, three things this rewrite
 * later changed on purpose (all still present in 'legacy'):
 *  - Steering hard-snaps straight onto the remembered lead point, no blending.
 *  - Re-steering is gated by a persistent per-ant high-water-mark (`maxLeadScore`) that's only
 *    ever raised, never reset — not "best lead available right now."
 *  - No rest/idle activity cycle and no scout-vs-recruited erratic-wander variation: the
 *    original's ants forage continuously forever at one constant wander amount (`pause()` is
 *    dead code in the original — never actually called).
 *
 * 'legacy+' is what this rewrite calls "legacy" everywhere else: the *fixed* version of the
 * same raw-frame-time scoring — re-evaluates the best local lead every cycle and blends the
 * turn — plus the modern ant-behavior layer (rest/idle, scout/recruited wander, colony foraging
 * throttle) that 'legacy' never had. Benchmarking 'legacy' against 'legacy+' is what actually
 * measures how much all of that was worth.
 *
 * 'gradient' is 'legacy+' with the score run through exponential decay (evaporates if not
 * refreshed) instead of raw frame-time (never fades).
 *
 * 'flow' is structurally different: instead of a remembered coordinate, each cell holds a
 * decaying *direction* vector built from the headings of ants who walked through it, and
 * followers align with the local vector sum rather than beelining for a point — the piece
 * needed to route around obstacles and support multiple simultaneous destinations.
 *
 * 'diffusion' goes further: once a resource is discovered, its cell becomes a constant scent
 * *source*, and that scent spreads outward frame by frame into neighboring cells like heat or a
 * real chemical smell — critically, only through *passable* cells, so walls block the exchange
 * exactly like they'd block a real scent. The resulting field's gradient organically curves
 * around obstacles without any ant needing to remember a path or a point; an ant just always
 * turns toward "stronger smell," the same instinct real chemotaxis relies on. This is also why
 * it should out-navigate legacy+/gradient on an obstacle-heavy map: they can point an ant
 * straight at a memorized point on the far side of a wall (dead reckoning through solid ground),
 * and flow's local vector has no persistent large-scale structure to detour with — a diffused
 * field is shaped by the passable-cell graph itself. See
 * `Simulation.communicatePheromones`/`communicatePheromonesClassic`/`communicatePheromonesFlow`/
 * `communicatePheromonesDiffusion` and `WorldGrid.diffuseScent`, kept side by side so all five
 * are directly comparable (see also `core/benchmark.ts`).
 *
 * 'integration' is the odd one out: the other four are all pure trail-following (an ant with no
 * usable lead just keeps wandering) — 'integration' is the first to also model the *individual*
 * side of real ant navigation research shows matters just as much as the trail itself. Per a
 * research pass on *Lasius niger* foraging biology: (1) trail-following at a junction is a
 * probabilistic choice biased by concentration, not a deterministic snap to the single best
 * lead — modeled here as the Deneubourg/Beckers/Goss choice function `(k+C)^α`, blended as a
 * weighted direction rather than winner-take-all; (2) recruitment (laying a trail advertising a
 * find) is a threshold decision gated by food quality, not automatic — real foragers at richer
 * sources lay substantially more trail than at poor ones, and a meaningful fraction of trips
 * never recruit at all; (3) an ant's return trip leans on its own path-integration home vector
 * (accumulated displacement since it left the nest — real ants dead-reckon home via compass +
 * odometry, not by re-finding a trail) at least as much as on any trail, which is what lets a
 * lone or trail-less ant still get home reliably. See
 * `Simulation.communicatePheromonesIntegration`, `Ant.homeVector`. */
export type PheromoneAlgorithm = 'legacy' | 'legacy+' | 'gradient' | 'flow' | 'diffusion' | 'integration';

export interface SimConfig {
  numAnts: number;
  antMaxSpeed: number;
  /** Communicate pheromone info every frame, or only on the ant's own cadence. */
  antComEveryFrame: boolean;
  /** [min, max] frames between an ant's pheromone communications. */
  antComNeedFrameStep: [number, number];
  /** Distance within which an ant can identify/avoid things. */
  antSightDistance: number;
  /** Frames a foraging ant spends frozen, chewing off a bite, once it reaches a food cell before
   * actually picking up cargo and departing — real ants don't teleport a piece of food into
   * their mandibles the instant they touch it. The ant is fully paused for the duration (see
   * `Ant.chewingUntil`), not just visually delayed. This is the first of what's meant to become a
   * general convention: timed actions instead of instant ones (see `antQueenFeedFrames` for the
   * other current example). */
  antFoodChewFrames: number;
  /** How many past positions each ant remembers (used as its pheromone "where"). */
  antPositionMemorySize: number;
  /** Heading jitter applied while confidently following a known trail — tight and mostly
   * straight, like a recruited real ant. */
  antErraticInformed: number;
  /** Heading jitter while there's no recent pheromone guidance — loopier, undirected search,
   * like a real scout. Kept at the original flat wander rate rather than pushed higher: an
   * even loopier search covers less net ground per frame, which measurably starves trail
   * discovery/repair (especially for 'flow', whose whole mechanic depends on continuous
   * exploration keeping the field alive). */
  antErraticSearching: number;
  /** Chance a wander turn that would repeat the same rotational direction as the previous one
   * gets flipped to the opposite direction instead — negative turn autocorrelation, matching
   * real foragers' search paths (measured in Temnothorax: ~78% of ants show a significant
   * negative autocorrelation in turn direction at ~3 body-lengths). Spreads search out and cuts
   * down on re-crossing just-searched ground, versus a pure independent random walk. See
   * `updateAnt`. */
  antTurnAlternationBias: number;
  /** How long "recently informed" status lasts after last receiving useful pheromone
   * guidance before an ant reverts to searching-style wander. */
  antInformedWindow: number;
  antObjectAvoidance: boolean;
  /** Half-angle (radians) of the field of view used for collision avoidance. */
  antObjectAvoidanceFov: number;

  /** Fraction of the colony that starts out actively foraging; the rest start already resting
   * at the nest. Without this, the entire colony would lurch out searching simultaneously at
   * frame 0 regardless of whether anyone has found food yet — this keeps the colony looking
   * genuinely idle at first, with only a small scouting party out. Everyone else's wake-up is
   * governed by `antRecruitmentWakeGain` (recruitment via trail strength) and this range only
   * as an absolute fallback. */
  antInitialActiveFraction: number;
  /** [min, max] frames the initially-dormant majority stays resting before its wake-up timer
   * alone (ignoring recruitment) would fire. Deliberately long — this is a safety net so the
   * colony doesn't stay dormant forever if no food is ever found, not the primary mechanism;
   * in practice `antRecruitmentWakeGain` below wakes most of the colony well before this. */
  antInitialRestDurationRange: [number, number];
  /** Real ant colonies recruit foragers in proportion to trail pheromone concentration, not on
   * a blind timer — a strong, fresh trail recruits fast, a weak or absent one recruits nobody
   * (Deneubourg/Beckers mass-recruitment). Modeled here as a per-frame wake probability for
   * resting ants: `min(1, cave-adjacent food-trail strength) * antRecruitmentWakeGain`, checked
   * every frame alongside (not instead of) the fallback duration-timer wake-up. 0 disables
   * recruitment entirely, falling back to pure timers. */
  antRecruitmentWakeGain: number;
  /** [min, max] frames an ant stays active before resting again. */
  antActiveDurationRange: [number, number];
  /** [min, max] frames an ant then rests for. Naively, this duty cycle alone would average out
   * to roughly 40% resting — matching observed real ant colony inactivity rates (studies report
   * ~40-65% of workers inactive at a given time) — but the eligibility gate below (only cargo-
   * free ants near the cave may start resting) pulls the realized colony-wide figure down to
   * roughly 15-20% in practice, since foraging round trips keep most active ants away from the
   * cave for long stretches. That's a reasonable result given every ant here is a forager (real
   * colonies' higher inactivity rate includes a large non-foraging worker caste this sim doesn't
   * model yet); push these ranges further if a lazier colony is wanted. */
  antRestDurationRange: [number, number];
  /** How close to the cave (world units) an ant must be to be eligible to start resting, and
   * how far a resting ant is allowed to mill before being pulled back — real ants rest in and
   * around the nest, not wherever they happen to be out on the trail. */
  antRestTetherRadius: number;
  /** Crawl speed while resting/milling near the cave — much slower than foraging cruise speed,
   * but not a full freeze. */
  antRestSpeed: number;
  /** Heading jitter while milling at rest. */
  antRestErratic: number;
  /** Trophallaxis (flavor only — see `antTrophallaxisFrames`): world-unit distance within which
   * two resting surface ants are close enough to trigger a food-sharing pause. Deliberately tight
   * (well under one grid cell) so it reads as two ants actually in antennal contact, not a pairing
   * across the whole resting cluster. */
  antTrophallaxisRadius: number;
  /** Trophallaxis: per-frame chance an eligible nearby pair (see `antTrophallaxisRadius`) actually
   * starts a hand-off, rolled once per pair per frame while both are idle and neither is already
   * mid-exchange. Kept low so it reads as occasional social behavior rather than every resting ant
   * glowing constantly. */
  antTrophallaxisChance: number;
  /** Trophallaxis: frames both ants in a pair spend paused together once triggered, tinted the
   * same warm color as `Ant.chewingUntil` — purely a visual/social cue (see `Ant.trophallaxisUntil`).
   * No food numbers move: unlike the queen (`antQueenFeedFrames`) and larvae (`antLarvaFeedFrames`),
   * ordinary workers aren't modeled as needing to be fed themselves, so this never touches
   * `foodStored` or any ant's cargo — it's colony-life flavor, gated on the colony actually having
   * some food stored so it doesn't play out of a truly empty larder. */
  antTrophallaxisFrames: number;
  /** At or below this many total ants, the whole rest/idle activity cycle is suppressed — every
   * ant forages continuously, and anyone already resting is woken immediately — regardless of
   * `antInitialActiveFraction`/timers/recruitment. All of the above (mostly-resting start,
   * timer-gated wake-up) was tuned for an *established* colony with a large surplus workforce,
   * where a resting majority is realistic and harmless. A small founding colony (see
   * `Simulation.initGameplay`) has no surplus: measured empirically, a 5-ant colony left to the
   * normal cycle went 200,000 frames (~55 real minutes at 60fps) completing 3 deliveries and
   * laying zero eggs — not slow, genuinely stalled, since on average as few as 0-1 of its 5 ants
   * were ever active foragers at once. This is the fix: below the threshold, the highest-priority
   * job for every ant is simply "forage," full stop, same idea as real colonies putting nearly
   * the entire workforce on foraging duty during a founding/famine phase rather than maintaining
   * a leisure class they can't yet afford. See `Simulation.update`'s `smallColony` check. */
  antSmallColonyThreshold: number;
  /** Small colonies only (see `antSmallColonyThreshold`): how strongly a cargo-carrying ant's
   * heading blends toward the literal, always-known cave position every communication tick,
   * layered on top of whatever the active pheromone algorithm already steered it toward. Fixes a
   * second, more fundamental gap the threshold above doesn't touch: every algorithm here leaves
   * `ant.direction` completely unchanged when it finds no usable lead at the ant's current cell
   * (see e.g. `communicatePheromonesScored`'s `if (bestWhere)` guard) — fine for an established
   * colony with hundreds of ants constantly refreshing trails everywhere, but with only a
   * handful of ants spread across a large map, a laden ant that wanders off the one thin trail
   * has *nothing* pulling it home and just wanders forever. Measured empirically: even after
   * fixing the rest-cycle stall above, a 5-ant colony still delivered only 3 loads in 100,000
   * frames, with most ants sitting motionless (in net displacement) at `cargo=1` for tens of
   * thousands of frames straight. Real ants solve this with path integration — dead-reckoning
   * home via internal odometry and a celestial compass — which this sim otherwise doesn't model
   * for the return trip at all; this is a deliberately crude stand-in for that, kept weak (a
   * gentle per-tick nudge, not a hard snap) so it reads as "eventually finds its way back"
   * rather than "beelines home like it has GPS." Applied only when `lookingFor === 'cave'` (a
   * real ant has no equivalent prior knowledge of undiscovered food, so outbound search stays
   * untouched) and never for the 'legacy' algorithm (a deliberately unfixed historical baseline,
   * see `communicatePheromonesClassic`'s doc comment) or outside `gameMode === 'gameplay'`'s
   * small colonies, so the pheromone-algorithm benchmark keeps comparing each algorithm's own
   * trail-following rather than a shared homing cheat. See `Simulation.applySmallColonyHoming`. */
  antSmallColonyHomingBlend: number;
  /** Small colonies only (see `antSmallColonyThreshold`), gameplay mode only, same non-'legacy'
   * scoping as `antSmallColonyHomingBlend`: an ant is "stuck" if it hasn't net-moved at least
   * `antStuckCheckDistance` world units in the last `antStuckCheckFrames` — checked once per
   * that window, not continuously. Fixes a failure mode the homing blend above can't: it's
   * deliberately gated off wherever there's no straight line to the cave (so it never pulls an
   * ant *into* a wall), but that leaves it inert for an ant genuinely trapped bouncing in a
   * pocket's walled corner — measured empirically, a single ant can get wedged there, moving at
   * full speed every frame yet net-stuck in an ~10-unit box, for 40,000+ frames straight (real
   * ants facing this — antennae/legs jammed against an obstacle with no clear sensory gradient to
   * follow — reorient with a fresh, more drastic search heading rather than endlessly repeating
   * whatever nudged them into the corner in the first place; this is that same "give up and try
   * a new direction" behavior). When triggered, the ant's heading is replaced outright (not
   * blended) with a fresh random direction — anything gentler just re-enters the same collision
   * pattern that trapped it. See `Simulation.applySmallColonyStuckEscape`. */
  antStuckCheckFrames: number;
  /** See `antStuckCheckFrames`. */
  antStuckCheckDistance: number;

  /** Colony-level foraging throttle: real harvester ant colonies adjust how many foragers they
   * send out based on recent forager *return* rate relative to their own baseline — a burst of
   * successful returns (good conditions) recruits more foragers, a lull (scarcity/risk) pulls
   * them back in, independent of any single ant's own experience (Gordon's encounter-rate task
   * allocation). Modeled here as two EMAs of colony-wide deliveries/frame; their ratio scales
   * how long ants stay active vs. resting. */
  antForagingThrottleFastDecay: number;
  antForagingThrottleSlowDecay: number;
  /** Clamp on the throttle ratio, so a lucky/unlucky streak can't swing the duty cycle wildly. */
  antForagingThrottleMin: number;
  antForagingThrottleMax: number;
  /** Below this delivery-rate baseline (deliveries/frame, colony-wide), the throttle stays
   * neutral (1) rather than reacting to noise before a real baseline has formed. */
  antForagingThrottleWarmupRate: number;

  /** Real-time compression: how many simulation frames make up one in-game day. Ant lifespans
   * are months to years — this scales that down to something a play session can actually show
   * (see `antLifespanMinDays`/`antLifespanMaxDays`). Purely a presentation choice, tunable. */
  framesPerDay: number;
  /** Adult worker body length (mm), sampled per-ant. Lasius niger is monomorphic (no distinct
   * size castes) with only minor individual variation: workers run 3.5-5mm. Not currently tied
   * to any behavior (research on L. niger found no consistent link between worker size and
   * task/efficiency) — modeled for realism and to have on hand for later. */
  antSizeRangeMm: [number, number];
  /** Newly-eclosed ("callow"/teneral) workers are pale, soft-bodied, and stay inside the nest
   * doing brood care rather than foraging until they've matured — real colonies show this
   * age-based division of labor (temporal polyethism). No L. niger-specific figure was found in
   * research for this species; this is a reasonable placeholder pending a better source. While
   * callow, an ant cannot be woken (by timer or recruitment) — see `updateActivityCycle`. */
  antCallowMaturityDays: number;
  /** [min, max] natural worker lifespan in days, sampled per-ant with a bias toward the low end
   * (real survivorship is right-skewed — most workers die well before the maximum). Grounded in
   * Lund et al. 2016: workers averaged ~310-430 days depending on founding cohort, with observed
   * maxima of ~1094-1129 days (~3 years); lab workers have lived 4+ years. On natural death an
   * ant currently respawns as a fresh callow worker at the nest rather than actually vanishing —
   * a stand-in for real brood-rearing (no queen/egg-laying system exists yet) that keeps colony
   * population stable instead of slowly declining to zero over a long play session. */
  antLifespanMinDays: number;
  antLifespanMaxDays: number;

  /** Fraction of the colony assigned underground as diggers rather than surface foragers — the
   * same population split into two, not extra ants (see the below-ground overlay). Debugging-
   * phase behavior only: no queen/brood/food-carrying yet, just excavating the nest. */
  antUndergroundFraction: number;
  /** Heading jitter for underground wandering, so tunnels get explored/dug in varied directions
   * rather than dead-straight lines. */
  antUndergroundErratic: number;
  /** Per-frame chance an ant blocked by dirt digs it out (rather than just turning away) —
   * keeps excavation gradual/visible instead of instant. */
  antUndergroundDigChance: number;
  /** Target nest volume (dug tiles) per underground ant — real nest volume grows roughly
   * proportionally with digging population (Toffin et al. 2010). Digging stops once
   * `undergroundGrid.dugCount()` reaches `undergroundAntCount * this`, so the nest doesn't grow
   * unboundedly; a growing/shrinking underground population naturally raises/lowers the target. */
  antUndergroundVolumePerAnt: number;
  /** How many "next dig site" cells stay actively designated (diggable) at once — a small
   * number keeps expansion to a few controlled working edges rather than opening up the whole
   * nest boundary at once (see `UndergroundGrid.ensureDesignatedFrontier`). */
  antUndergroundDesignationPoolSize: number;

  /** Colony food economy and reproduction. Egg/larva/pupa durations are grounded in "eggs
   * develop to imagines in 8-10 weeks" (AntWiki); the split between the three stages within
   * that total, and every food-cost/rate number here, is a game-balance approximation, not a
   * cited figure — no source gave per-stage durations or feeding rates for L. niger specifically.
   *
   * Real ant colonies constantly relocate eggs/larvae/pupae between chambers by temperature/
   * humidity need (brood transport) — modeled as a one-way trip: newly-laid eggs sit at the
   * queen's chamber until an idle underground ant becomes a nurse and carries them to the
   * nursery chamber (see `Simulation.tryBecomeNurse`), then stay put for the rest of development. */
  eggDurationDays: number;
  /** Larvae need both age *and* accumulated feeding (`larvaNutritionNeeded`) to pupate — well-
   * fed brood develops faster in reality, but here it's a hard gate: underfed larvae just wait. */
  larvaDurationDays: number;
  /** Number of physical feeding visits (see `antLarvaFeedFrames`) a larva needs before it's
   * allowed to pupate — each visit delivers exactly 1 unit, the same "1 food unit = 1 nutrition
   * unit" idea as before, just paid out by an actual nurse trip instead of an abstract per-frame
   * trickle from the shared larder. */
  larvaNutritionNeeded: number;
  pupaDurationDays: number;
  /** [min, max] frames between the queen's egg-laying attempts. Each attempt costs
   * `queenEggFoodCost` from `foodStored`; if there isn't enough, she just waits and retries
   * `queenEggRetryFrames` later rather than skipping a full cycle. */
  queenEggCooldownFramesRange: [number, number];
  /** Paid out of `Queen.foodStash`, not the colony's shared larder total directly — she has to
   * actually be fed by a feeder ant (`Simulation.tryBecomeQueenFeeder`) to lay, the same way real
   * queens are fed via trophallaxis rather than drawing on the colony's food in the abstract. */
  queenEggFoodCost: number;
  queenEggRetryFrames: number;
  /** Frames a feeder ant spends physically handing food to the queen once it's walked to her
   * chamber, before it actually transfers into her `foodStash` — a timed hand-off, not an instant
   * transfer (see `Ant.queenFeedUntil`, and `antFoodChewFrames`'s doc comment for the convention
   * this follows). */
  antQueenFeedFrames: number;
  /** Frames a nurse ant spends physically feeding a larva once it's walked there with a claimed
   * unit of food, before that unit actually lands in the larva's `nutritionReceived` — same timed
   * hand-off shape as `antQueenFeedFrames` (see `Ant.larvaFeedUntil`), replacing the old abstract
   * per-frame trickle from the shared larder with an actual physical trophallaxis trip
   * (`Simulation.tryBecomeLarvaFeeder`). */
  antLarvaFeedFrames: number;
  /** Homeostatic laying target as a multiple of the starting population: the queen lays to keep
   * living workers + in-pipeline brood near `initialPopulation * this`, replacing natural-death
   * losses so the colony holds steady rather than growing unboundedly or bleeding out. */
  populationCapMultiplier: number;
  /** Storage is discrete tiles, not one shared number — the larder chamber's cells (see
   * `UndergroundGrid.seedStarterNest`'s `larderCells`) each hold up to this many food units; a
   * delivering ant always targets whichever tile currently has the *least* fill, so tiles fill up
   * roughly in turn rather than one pile absorbing everything, and once every tile is at capacity
   * the colony's total storage is naturally capped at `tiles × this` — no separate global cap
   * needed. `Simulation.foodStored` is the live sum across all tiles, kept for the egg-cost/larva-
   * feeding checks and the UI, but is no longer where deliveries are actually written. */
  foodTileCapacity: number;
  /** Same discrete-tile idea as `foodTileCapacity`, applied to the nursery: each cell holds up to
   * this many brood items, but — unlike a food tile, which is happy to hold any mix — a brood
   * tile is locked to a *single* developmental stage at a time (all-eggs, all-larvae, or
   * all-pupae). When an item advances stage while already settled on a tile, that tile is now the
   * wrong stage for it: `Simulation` vacates its slot and an idle underground ant physically
   * relocates it to a same-stage tile (creating one if needed) — the same nurse pipeline that
   * carries a brand new egg from the queen in the first place, just with a different starting
   * position. Real colonies do exactly this: continuously sorting/relocating brood by stage
   * between chambers, not just once at laying. */
  broodTileCapacity: number;
  /** Nutrients in the corpse a surface ant leaves when it dies — a small, finite food source
   * (see `Simulation.dropCorpse`), picked clean after this many carry-offs. */
  corpseNutrients: number;
  /** Fraction of the starting population to pre-seed as in-progress brood (eggs/larvae/pupae
   * spread across all developmental stages) at init, so an established colony starts eclosing
   * new workers within the first minute rather than after a full ~20k-frame development lag —
   * see `Simulation.seedEstablishedBrood`. */
  seededBroodFraction: number;
  /** A cargo-carrying ant reaching the surface cave always descends to physically deliver the
   * food to underground storage rather than it vanishing at the surface — the two layers are
   * one colony, not two disconnected populations. `antUndergroundDutyDaysRange` is how long it
   * then stays below (helping dig/tend brood) before resurfacing to forage again. */
  antUndergroundDutyDaysRange: [number, number];

  mapMinX: number;
  mapMinY: number;
  mapMaxX: number;
  mapMaxY: number;
  mapGridSize: number;

  /** 'gradient' algorithm: per-frame multiplier applied when scoring a lead's age (exponential
   * decay/evaporation). */
  pheromoneDecayPerFrame: number;
  /** 'legacy' algorithm only: nominal strength stamped on deposit, purely for the debug
   * overlay ('gradient' scores are already a normalized 0-1 decay factor). */
  pheromoneDepositAmount: number;
  /** Strength at which the debug overlay renders a tile at full intensity. */
  pheromoneSaturation: number;
  /** How far (0-1) an ant rotates its heading toward the best local pheromone lead each
   * communication — for 'legacy+'/'gradient'/'flow'/'diffusion'. 1 = hard-snap (orbits a stored
   * point and stalls for legacy+/gradient; converges worse for flow/diffusion too); low values
   * glide the ant along the trail instead. Not read by 'legacy' at all — it hard-snaps
   * unconditionally, faithfully to the original. See
   * `communicatePheromonesScored`/`communicatePheromonesFlow`/`communicatePheromonesDiffusion`. */
  pheromoneLeadBlend: number;
  /** 'diffusion' only: fraction of the gap to each passable neighbor's scent exchanged per
   * relaxation step (like thermal conductivity) — see `WorldGrid.diffuseScent`. */
  diffusionRate: number;
  /** 'diffusion' only: per-*step* multiplier applied to every cell's scent after the exchange,
   * so the field settles to a real distance-shaped gradient rather than eventually saturating
   * flat everywhere. Deliberately its own knob, not reusing `pheromoneDecayPerFrame` — this decay
   * is a property of the medium (how far scent carries), not of a specific social memory.
   * Measured to matter a lot and in a narrow band: too low (faster decay, e.g. 0.99) starves
   * most of the map of any signal at all — with a source pinned at 1 and a `diffusionRate` of
   * 0.25, the field's characteristic falloff length is short enough that almost nothing beyond
   * the immediate area around a source reads above noise, so ants far away get no more guidance
   * than undirected wander. Too high (slower decay, e.g. 0.9999) goes the other way — nothing
   * ever meaningfully cools off, so the field trends toward flooding flat at the source strength
   * almost everywhere reachable, which erases the *gradient* (the only thing ants actually
   * steer by) even though the field itself is "strong". 0.9997 was the best measured point
   * between those failure modes on the stress-test map. */
  diffusionDecayPerStep: number;
  /** 'diffusion' only: the constant value a discovered resource cell is pinned to every step
   * (a fixed-temperature source, in heat-equation terms). Ants' own steering reads the raw
   * gradient, so this only ever matters at the source itself and immediately around it — see
   * `diffusionArrowSaturation` for the debug overlay, which needs a much smaller reference. */
  diffusionSourceStrength: number;
  /** 'diffusion' only: the debug overlay's normalization reference for arrow length/opacity —
   * deliberately much smaller than `diffusionSourceStrength`. A diffused scent field spreads out
   * smoothly rather than staying near its pinned peak the way legacy/gradient/flow's discrete
   * deposits do (those get re-topped to ~`pheromoneSaturation` by frequent re-deposits along any
   * actually-used trail); away from the immediate source, real observed scent typically lands
   * well under 1 (empirically: median ~0.33, p90 ~0.49 in a 600-ant colony after 6000 frames).
   * Normalizing against the full source strength made every arrow off the source itself look
   * faint-to-invisible even where the gradient was a perfectly good, followable signal — this is
   * a separate, smaller reference so diffusion's arrows read at a comparable visual weight to the
   * other algorithms' instead of looking uniquely weak. */
  diffusionArrowSaturation: number;
  /** 'diffusion' only: relaxation steps run per simulation frame. More steps make the field
   * physically propagate across the map faster (in simulated time) without changing how often
   * ants themselves re-sample it. */
  diffusionSubstepsPerFrame: number;

  /** 'integration' only: the Deneubourg/Beckers/Goss junction-choice function's baseline
   * attraction-to-an-unmarked-option constant — `P_i ∝ (k + C_i)^α`. Fitted to Lasius niger and
   * Argentine-ant double-bridge data at k≈6. Read alongside `integrationAlpha` as weights in a
   * blended-direction steer rather than a discrete branch pick (see
   * `Simulation.communicatePheromonesIntegration`). */
  integrationK: number;
  /** 'integration' only: same choice function's nonlinearity exponent — α>1 means a branch with
   * slightly more pheromone gets disproportionately more traffic (the actual engine of trail
   * selection in the real experiments). Fitted around α≈2 in most double-bridge setups. */
  integrationAlpha: number;
  /** 'integration' only: how strongly a cave-seeking ant's heading blends toward its own
   * path-integration home vector (see `Ant.homeVector`) each communication tick — real ants lean
   * on this dead-reckoned vector for the return trip at least as much as on any trail, so it's
   * deliberately blended in on top of (not gated behind absence of) the pheromone trail. */
  integrationHomeVectorBlend: number;
  /** 'integration' only: below this accumulated-vector length (world units), the home vector is
   * too short to have a meaningful direction yet (an ant that just left the nest) — skip steering
   * by it rather than dividing a near-zero vector into noise. */
  integrationHomeVectorMinLength: number;
  /** 'integration' only: baseline probability a trip recruits (lays a 'food' trail) at all once
   * cargo is picked up, before `integrationRecruitQualityBonus` — real recruitment is an
   * all-or-none per-trip decision gated by a "desired volume" threshold, not automatic; a
   * meaningful fraction of trips (measured ~14%) never recruit regardless of food quality. */
  integrationRecruitBaseProbability: number;
  /** 'integration' only: added to `integrationRecruitBaseProbability`, scaled by the food's
   * remaining-nutrients fraction at pickup (`Ant.lastFoodQuality`) — richer/fresher sources
   * recruit more reliably (measured: 43% more trail marks at the richest vs. poorest sucrose
   * concentrations tested). */
  integrationRecruitQualityBonus: number;
  /** 'integration' only: decayed recent-traffic count (see `readTraffic`) at which 'food'-trail
   * reinforcement is suppressed by half — real foragers deposit substantially less when they
   * encounter many nestmates on the same stretch of trail (measured: a ~5.6x reduction from
   * least- to most-crowded conditions), which is what lets a colony reallocate to a *less*
   * crowded, potentially better source instead of permanently over-committing to the first one
   * found. Deliberately scoped to the 'food' deposit only (the recruitment signal), not 'cave' —
   * crowding on the way home is just heavy traffic, not a reason to stop finding your way back. */
  integrationCrowdingHalfSaturation: number;
  pheromoneAlgorithm: PheromoneAlgorithm;
}

export const defaultConfig: SimConfig = {
  numAnts: 1500,
  antMaxSpeed: 1.2,
  antComEveryFrame: false,
  antComNeedFrameStep: [3, 13],
  antSightDistance: 30,
  antFoodChewFrames: 180,
  antPositionMemorySize: 10,
  antErraticInformed: 0.08,
  antErraticSearching: 0.2,
  antTurnAlternationBias: 0.6,
  antInformedWindow: 120,
  antObjectAvoidance: true,
  antObjectAvoidanceFov: Math.PI / 6,

  antInitialActiveFraction: 0.15,
  antInitialRestDurationRange: [2000, 6000],
  antRecruitmentWakeGain: 0.01,
  antActiveDurationRange: [400, 1000],
  antRestDurationRange: [300, 700],
  antRestTetherRadius: 60,
  antRestSpeed: 0.2,
  antRestErratic: 0.35,
  antTrophallaxisRadius: 10,
  antTrophallaxisChance: 0.01,
  antTrophallaxisFrames: 90,
  antSmallColonyThreshold: 20,
  antSmallColonyHomingBlend: 0.15,
  antStuckCheckFrames: 1200,
  antStuckCheckDistance: 60,

  // half-life ~23 frames (recent conditions) vs ~693 frames (long-run baseline)
  antForagingThrottleFastDecay: 0.97,
  antForagingThrottleSlowDecay: 0.999,
  antForagingThrottleMin: 0.7,
  antForagingThrottleMax: 1.4,
  antForagingThrottleWarmupRate: 0.02,

  // 5 seconds/day at 60fps: an average worker (~450 days, see antLifespan*) lives roughly
  // half an hour of continuous play — long enough to be a background presence, not so long
  // aging/mortality never visibly matters in a normal session
  framesPerDay: 300,
  antSizeRangeMm: [3.5, 5.0],
  antCallowMaturityDays: 5,
  // extended so natural death is a calm background event, not constant churn: with ~1500 ants
  // and death now a real removal (replaced by an eclosion from the nest, not an in-place
  // respawn), a short lifespan meant ~1 death every frame or two scattered across the map
  antLifespanMinDays: 500,
  antLifespanMaxDays: 3000,

  antUndergroundFraction: 0.1,
  antUndergroundErratic: 0.5,
  antUndergroundDigChance: 0.05,
  antUndergroundVolumePerAnt: 3,
  antUndergroundDesignationPoolSize: 5,

  // 12 + 26 + 18 = 56 days total egg-to-adult, matching the cited 8-10 week (56-70 day) range
  eggDurationDays: 12,
  larvaDurationDays: 26,
  larvaNutritionNeeded: 8,
  pupaDurationDays: 18,
  // faster than before so homeostatic laying can actually keep pace with worker deaths and hold
  // the colony steady (rather than slowly bleeding out); still gated by food and the committed-
  // population target, so she only lays this fast while there are losses to replace
  queenEggCooldownFramesRange: [60, 140],
  queenEggFoodCost: 5,
  queenEggRetryFrames: 60,
  antQueenFeedFrames: 120,
  antLarvaFeedFrames: 90,
  populationCapMultiplier: 1.3,
  foodTileCapacity: 20,
  broodTileCapacity: 5,
  corpseNutrients: 20,
  seededBroodFraction: 0.06,
  antUndergroundDutyDaysRange: [1, 3],

  // a smaller, square play area (was a wide 900x600 rectangle)
  mapMinX: -320,
  mapMinY: -320,
  mapMaxX: 320,
  mapMaxY: 320,
  mapGridSize: 16,

  // half-life of roughly 3500 frames (~1min at 60fps): long enough to survive a full round
  // trip and be found by relay, short enough that abandoned leads still fade out eventually
  pheromoneDecayPerFrame: 0.9998,
  pheromoneDepositAmount: 1,
  pheromoneSaturation: 1,
  pheromoneLeadBlend: 0.5,
  diffusionRate: 0.25,
  diffusionDecayPerStep: 0.9997,
  diffusionSourceStrength: 1,
  diffusionArrowSaturation: 0.4,
  diffusionSubstepsPerFrame: 3,

  integrationK: 6,
  integrationAlpha: 2,
  integrationHomeVectorBlend: 0.3,
  integrationHomeVectorMinLength: 5,
  integrationRecruitBaseProbability: 0.5,
  integrationRecruitQualityBonus: 0.36,
  integrationCrowdingHalfSaturation: 8,

  pheromoneAlgorithm: 'gradient',
};
