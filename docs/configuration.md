# Configuration reference

All tuning lives in `src/config.js` (`CONFIG`) plus the `SHAPES` table. Every
knob, who reads it, and what changing it does.

## World

| Key | Default | Effect |
|---|---|---|
| `map.width/height` | 1600×1280 | World px — 40×32 cells. Camera clamp, spawn bounds, grid |
| `map.margin` | 90 | Spawn exclusion border (px; rounded up to cells) |
| `view.width/height` | 1280×800 | Logical viewport px (canvas is scaled to fit the window) |
| `grid.cell` | 40 | Cell size px — the quantum for roads, drafts, indexes |

## Levels (`CONFIG.levels`, `applyLevelOverrides`, `applyLevelFeatures`)

Per-map deltas merged onto `CONFIG` at boot by `applyLevelOverrides(level)` —
the browser (`?level=N`) and `autoplay.mjs` (`--level=N`) both apply it before
`createState()` so initial values see the overrides. Sections that exist only
in a level def (e.g. `water`) are created, not merged onto a missing base.

`levels[2]` — the desert map:

| Key | Value | Effect |
|---|---|---|
| `map.width` | 3200 | 80×32 cells = 2560 tiles — double Map 1 |
| `roads.carSpeed` | 110 | Faster cruising compresses the 2× distance (~+22%) |
| `roads.truckSpeed` | 85 | Milk-truck routes cover more ground (~+21%) |
| `roads.tilesStart` | 50 | Up from 40 — funds the new-colour onboarding burst |
| `roads.tilesPerWeek` | 22 | Up from 18, same reason |
| `water.at/cells` | anchor `{54,11}` + 16 offsets | The oasis — impassable cells, irregular blob |
| `water.fill/edge` | `#9fcbe0` / `#7cb2c7` | Water colours (shoreline drawn on outer edges) |

`levels[3]` — the deep-pastel green map (surface `#8fbe7d`, a step darker than
Map 1's `#dce9cf`; ground colours live in `SURFACES` in `main.js`):

| Key | Value | Effect |
|---|---|---|
| `map.width` | 3200 | Same 80×32 canvas as Map 2 |
| `roads.*` | same as `levels[2]` | Distance-compensation is about map size, not theme |
| `spawn.seedBias` | `'right'` | Seed cluster + early city form on the right third |
| `water.river` | `{center:40, meander:4.2, minHalf:3, wobble:2.2, seed:11}` | Generated vertical river through the middle-third columns — the western gate for the right-seeded city |
| `water.fill/edge` | `#71b3d6` / `#5398bf` | Deeper than the oasis — flowing water on green |
| `bridges.unlockWeek` / `grant` | 2 / 12 | A bundle is gifted once week 1 is done, on top of the pick (~1 crossing + slack) |
| `bridges.pick` / `cap` | 8 / 36 | Weekly-pick award and stock ceiling — Map-3-only item |

`applyLevelFeatures(state)` materialises water defs into `state.water` (a Set
of cellKeys) — `cells` gives a static offset list (oasis), `river` runs the
deterministic generator in `terrain.js` (seeded, same river every game).
Roads, roundabouts, junctions, and building spawns all reject water cells;
motorways and transit lines can pass over.

## Spawning (`spawn.js`)

| Key | Default | Effect |
|---|---|---|
| `intervalStart` | 14 | Seconds between building spawns, week 1 |
| `intervalMin` | 8 | Floor of the spawn interval |
| `intervalRamp` | 0.6 | Interval shrinks by this per week |
| `warnTime` | 3 | "Incoming" dashed-outline phase before a building activates |
| `minDist` | 110 | Min px between building cells (rounded to cells) |
| `maxTries` | 60 | Random placement attempts before giving up |
| `homeRatio` | 0.65 | Target home fraction of home+work |
| `foodStartWeek` | 2 | Farms/markets begin spawning this week |
| `homesPerMarket` | 4 | Markets keep pace at ~1 per N homes |
| `marketsPerFarm` | 2 | Farms keep pace at ~1 per N markets |
| `homesPerWork` | 4 | A work only spawns below this homes-per-work ratio |
| `cityReach` | 10 | Cells — new buildings must be within this of the blob |
| `seedBias` | unset | `'left'`/`'right'` shifts the seed cluster's third of the map |

## Commuters & shifts

| Key | Default | Effect |
|---|---|---|
| `commuters.interval` | 5 | Avg seconds between departures per home |
| `commuters.jitter` | 0.6 | `1 ± jitter` multiplier on the interval |
| `homes.residents` | 3 | People "out" per home cap **and** carpool cap |
| `homes.densifyCost` | 20 | Tiles for a permanent `resBonus` on one home (RL `densify`) |
| `homes.densifyBonus` | 2 | Residents added per densify |
| `homes.densifyCap` | 4 | Max `resBonus` a home can hold |
| `homes.densifyRadius` | 800 | px — understaffed work must be within this of the home |
| `work.shiftLen` | 18 | Seconds an office worker stays before heading home |
| `food.shiftLen` | 180 | Seconds a farm/market worker stays |

## Rush hour & subdivisions

| Key | Default | Effect |
|---|---|---|
| `rush.firstWeek` | 2 | Week the surges begin |
| `rush.at` | 0.3 | Fraction into the week the window starts (≈18s in) |
| `rush.len` | 20 | Seconds the window lasts |
| `rush.mul` | 2.5 | Commuter spawn-clock speed inside the window |
| `subdivision.first` | 130 | Seconds until the first tract can land |
| `subdivision.every` | 130 | Mean seconds between tracts (±30% jitter) |
| `subdivision.sizeMin`/`sizeMax` | 2/4 | Homes per tract — all one colour |
| `subdivision.ringMin`/`ringMax` | 6/10 | Cells outward from the anchor building |
| `subdivision.span` | 3 | Half-extent of the tract's placement region |
| `subdivision.warn` | 12 | Seconds a tract telegraphs before opening (vs the 3s norm) |

Tract homes consume spawn budget: each placed home defers the next organic
spawn by one `spawnInterval`, so tracts reshape growth rather than adding to it.

## Streets under strain (`economy.js`, `routing.js`, `vehicles.js`)

| Key | Default | Effect |
|---|---|---|
| `stress.gain` | 0.5 | Meter-rate multiplier at fully saturated frontage (homes' hunger, works' demand) |
| `walk.catch` | 66 | Max px between buildings for a walking link |
| `walk.speed` | 34 | Walker px/s — slower than a car, congestion-immune |
| `bus.max` | 4 | Bus route slots — independent of `maxLines` |
| `bus.capacity` | 8 | Riders per bus |
| `bus.buses` | 2 | Vehicles per route (staggered — a lone bus's headway can't compete) |
| `bus.firstWeek` | 3 | When buses unlock (with motorways) |
| `bus.discount` | 0.8 | Route-cost discount — riders on a shared bus are cars the jam never sees |
| `costs.parkPenalty` | 4 | Curb/parking seconds priced into each car trip — what makes transit worth boarding |

Env overrides for ablation runs (all falsy-safe in the browser): `NOSTRESS`,
`NOPARK`, `NOWALK`, `NORUSH`, `NOSUBDIV` each zero out their mechanic;
`BOTNOBUS`, `BOTNOLN`, `BOTNOSP`, `BOTNORD` gate bot strategies.

## Trains (`networks.js`, `vehicles.js`)

| Key | Default | Effect |
|---|---|---|
| `trains.speed` | 130 | px/s along track |
| `trains.capacity` | 6 | Passengers per train car (crates use `food.crateCap`) |
| `trains.dwell` | 0.8 | Seconds stopped per stop |
| `lines.maxStart` | 3 | Starting line budget |
| `lines.width` | 5 | Track rendering width px |

## Roads (`roads.js`, `vehicles.js`, `routing.js`, `input.js`)

| Key | Default | Effect |
|---|---|---|
| `carSpeed` / `truckSpeed` | 90 / 85 | px/s for cars and cargo vehicles |
| `width` | 16 | Rendered road width px (two lanes) |
| `laneOffset` | 4 | Keep-right offset px |
| `congestAt` | 6 | Vehicles per edge before slowdown starts |
| `congestFactor` | 0.45 | Speed multiplier at full congestion |
| `maxPerEdge` | 12 | Edge capacity used by the congestion curve |
| `snap` | 26 | px — endpoints snap to buildings/edges inside this |
| `followGap` | 16 | Centre-to-centre spacing cars keep while queued |
| `yieldLookahead` | 14 | px before a node where junction checks engage |
| `junctionBox` | 16 | px node radius counted as "in the junction" |
| `yieldPatience` | 1.5 | s a yielded car waits before nosing in anyway |
| `turnRadius` | 12 | px — corner fillet radius on vehicle drive paths |
| `tilesStart` / `tilesPerWeek` / `tilesCap` | 40 / 18 / 99 | Road tile budget |
| `roads.freightTiles` | 0.25 | Bonus tiles per crate delivered that week — endogenous budget (T1); `RL_FREIGHTTILES` env overrides / `=0` ablates |

## Motorways, roundabouts, traffic lights (`motorways.js`, `roundabouts.js`, `lights.js`, `vehicles.js`, `routing.js`)

Countable items — first of each granted at `unlockWeek`, more via weekly
picks, `cap` stock ceiling:

| Key | Default | Effect |
|---|---|---|
| `motorways.speedFactor` | 1.6 | Cruise-speed multiplier on the elevated edge (drive + path cost) |
| `motorways.unlockWeek` | 4 | First span granted when this week begins |
| `motorways.cap` | 9 | Stock cap |
| `motorways.width` | 18 | Rendered span width px |
| `roundabouts.unlockWeek` | 4 | First ring granted |
| `roundabouts.cap` | 9 | Stock cap |
| `roundabouts.radius` | 17 | Ring centre to ring nodes px |
| `trafficLights.unlockWeek` | 4 | First light granted |
| `trafficLights.cap` | 9 | Stock cap |
| `trafficLights.phase` | 2.2 | Seconds each arm group holds green |

`CONFIG.bridges` is **Map-3-only** (defined inside `levels[3]`, never in base
config): `unlockWeek: 2` — the week-1 gift fires even though it's "the first
grant", since it's a bundle rather than a single item. `grant: 12`, `pick: 8`,
`cap: 36`. Every bridge gate checks `CONFIG.bridges`/`state.bridgesGranted`,
so the mechanic simply doesn't exist on maps without the section.

## Food (`food.js`, `vehicles.js`)

| Key | Default | Effect |
|---|---|---|
| `produceInterval` | 3 | Seconds per crate at a staffed farm |
| `workersNeeded` | 2 | Workers to fully staff a farm/market |
| `stockpileCap` | 10 | Defined but currently unused (no stock ceiling enforced) |
| `hungerLimit` | 120 | s a home can go unfed → starve game over |
| `pantryStart` | 40 | Negative `hungerT` head start on new homes |
| `hungryAt` | 10 | Dispatch ignores homes under this hunger; also the crate-routing threshold for "hungry market" |
| `marketTrucksStart` | 3 | Milk trucks per market |
| `marketServeCap` | 5 | Defined but currently unused (no per-truck serve cap enforced) |
| `milkCap` | 6 | Deliveries per milk-truck run |
| `crateCap` | 4 | Crates per cargo wagon |
| `dispatchInterval` | 2 | s between market dispatch checks |
| `assignInterval` | 3 | s between home→market reassignment |

## Buildings & junctions

| Key | Default | Effect |
|---|---|---|
| `buildings.capacity` | 6 | Waiting-room size (overflow clock runs at capacity) |
| `buildings.radius` | 13 | Generic glyph radius px |
| `buildings.homeRadius` / `workRadius` / `junctionRadius` | 16 / 35 / 9 | Per-type glyph radii |
| `junctions.snap` | 26 | px — junction click must land this close to track |
| `junctions.maxLines` | 3 | Lines per junction (its track + connecting lines) |

## Demand & overflow (`economy.js`, `vehicles.js`)

| Key | Default | Effect |
|---|---|---|
| `demand.rate` | 1 | demandT per second unserved |
| `demand.relief` | 24 | s of demand each worker arrival clears |
| `demand.limit` | 90 | meter full → "understaffed" game over |
| `demand.grace` | 15 | new workplaces start with this much slack |
| `demand.growth` | 0.15 | extra rate per level (L3 = 1.3× rate) |
| `demand.promoteEvery` | 20 | arrivals per level |
| `demand.maxLevel` | 3 | level cap |
| `overflowLimit` | 25 | s at/over capacity → game over (decays at 1.5×) |

## Pacing & colours

| Key | Default | Effect |
|---|---|---|
| `weekSeconds` | 60 | Week length; rollover grants tiles + an upgrade pick |
| `win.stars` | `[5, 8, 11]` | Week-reached thresholds for 1/2/3 stars at game over (Map 3: `[4, 7, 10]`) |
| `colors.palette` | 6 hex | Building/line colours |
| `colors.startUnlocked` | 1 | Palette indexes available at start |
| `colors.popToUnlock` | 16 | Live people of the newest colour to unlock the next |
| `costs.transferPenalty` | 6 | Added once per mode switch in pathfinding |
| `costs.stopPenalty` | 0.6 | Per line-segment cost in pathfinding |
| `costs.boardWait` | 3 | Minimum expected-wait term for boarding a line |

## SHAPES

`{ home:'circle', work:'square', farm:'octagon', market:'triangle' }` — glyph
per building type (junctions render as a fixed ring, not via this table).

## Simulation constants that aren't in CONFIG

- `STEP = 1/60` — fixed sim step (`main.js`)
- `acc += dt * speed * 0.5` — 1× runs at half the "natural" pace (`main.js`)
- `HIT_RADIUS = 22` — building click radius (`input.js`)
- `spawnCamera speed 620 px/s` — WASD pan speed (`input.js`)
- Graph-cache epoch `0.8` s — congestion-cost staleness budget (`routing.js`)
- Colour-seed retry cap `600` attempts (`spawn.js`)
- `minGap` ≈ 1px-equivalent split coalescing (`roads.js`)
