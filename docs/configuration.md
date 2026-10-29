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

## Commuters & shifts

| Key | Default | Effect |
|---|---|---|
| `commuters.interval` | 5 | Avg seconds between departures per home |
| `commuters.jitter` | 0.6 | `1 ± jitter` multiplier on the interval |
| `homes.residents` | 2 | People "out" per home cap **and** carpool cap |
| `work.shiftLen` | 25 | Seconds an office worker stays before heading home |
| `food.shiftLen` | 75 | Seconds a farm/market worker stays |

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
| `carSpeed` / `truckSpeed` | 90 / 70 | px/s for cars and cargo vehicles |
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
| `tilesStart` / `tilesPerWeek` / `tilesCap` | 40 / 18 / 99 | Road tile budget |

## Food (`food.js`, `vehicles.js`)

| Key | Default | Effect |
|---|---|---|
| `produceInterval` | 6 | Seconds per crate at a staffed farm |
| `workersNeeded` | 2 | Workers to fully staff a farm/market |
| `stockpileCap` | 10 | Defined but currently unused (no stock ceiling enforced) |
| `hungerLimit` | 90 | s a home can go unfed → starve game over |
| `pantryStart` | 30 | Negative `hungerT` head start on new homes |
| `hungryAt` | 20 | Dispatch ignores homes under this hunger |
| `marketTrucksStart` | 3 | Milk trucks per market |
| `marketServeCap` | 5 | Defined but currently unused (no per-truck serve cap enforced) |
| `milkCap` | 3 | Deliveries per milk-truck run |
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
| `demand.relief` | 18 | s of demand each worker arrival clears |
| `demand.limit` | 90 | meter full → "understaffed" game over |
| `demand.grace` | 15 | new workplaces start with this much slack |
| `demand.growth` | 0.5 | extra rate per level (L3 = 2× rate) |
| `demand.promoteEvery` | 8 | arrivals per level |
| `demand.maxLevel` | 3 | level cap |
| `overflowLimit` | 25 | s at/over capacity → game over (decays at 1.5×) |

## Pacing & colours

| Key | Default | Effect |
|---|---|---|
| `weekSeconds` | 60 | Week length; rollover grants tiles + an upgrade pick |
| `colors.palette` | 6 hex | Building/line colours |
| `colors.startUnlocked` | 1 | Palette indexes available at start |
| `colors.popToUnlock` | 12 | Live people of the newest colour to unlock the next |
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
