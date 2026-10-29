# Spawning & colour progression (`src/spawn.js`)

Buildings spawn continuously — the game is fundamentally a conveyor the player
must keep up with.

## Seeding

`seedInitial` runs on the first update (`state.buildings.size === 0`): one home
and one work, instantly active, in a region covering the **middle third** of
the usable map (`margin`-inset). The camera centres on the cluster on the first
frame (`main.js` `_camInit`).

## Cadence & type choice

Every `spawnInterval` seconds a building spawns:

```
interval = max(intervalMin, intervalStart - (week-1) * intervalRamp)
        = max(8, 14 - 0.6·(week-1))
```

`pickType` decides what spawns, in order:

1. **Food-era quotas** (week ≥ `foodStartWeek` and homes ≥ `homesPerMarket`):
   - if `markets < floor(homes / homesPerMarket)` → market
   - if `farms < ceil(markets / marketsPerFarm)` → farm
2. **Home ratio**: if `homes/(homes+works) < homeRatio` → home
3. **Demand gate**: work only if `works < floor(homes / homesPerWork)` —
   workplaces can only spawn while the housing base can actually staff them;
   otherwise → home.

## Placement (`placeBuilding`)

- Workplaces occupy a **2×2 cell block** centred on a grid vertex; all other
  types take the single cell containing their centre.
- Candidate cells are rejected if covered by `roadCellIndex` or
  `lineCellIndex` — buildings never spawn on roads or track.
- **Spacing**: any building cell within `minDist` (→cells, Chebyshev) of an
  existing building cell rejects.
- **Reach**: at least one existing building must be within `cityReach` cells —
  the city grows as one blob so everything stays linkable.
- Up to `maxTries` random candidates; failure returns `null` (callers handle).
- New buildings start **inactive** with `openAt = time + warnTime` (dashed
  outline). On activation, `connectBuildingToRoad` serves any road the player
  pre-drew through them.
- Farms are colourless (`color: null`); everything else gets a palette colour.

## Colour choice (`pickColor`)

Each type scores the unlocked colours differently — always aiming at a colour
that can function:

- **home**: max `works[c] - homes[c]`, skipping colours with zero works —
  a home whose people can't be employed is pointless.
- **work**: max `homes[c] - works[c]`, skipping colours with zero homes —
  a work that can never be staffed is a guaranteed game over.
- **market**: max `homes[c] - markets[c]·homesPerMarket`, homes required —
  targets under-served colours.
- Fallback for all: uniform random unlocked colour.
- Farm: always `null` (neutral — serves every colour).

## Colour unlocks (population ratchet)

`checkColorUnlocks` runs each update:

- Counts live `person` agents (waiting + riding) per colour.
- If the **newest** unlocked colour reaches `popToUnlock` (12) live people,
  the next palette index unlocks — permanently (ratchet, never re-locks).
- The new colour gets seeded with a guaranteed pair: `{home, work}` pushed to
  `state.colorSeedQueue`, plus `{market}` once the food era has started.

## The colour seed queue

Forced seeds are attempted by `spawn.update`, **one placement attempt per seed
per tick** (the queue is snapshotted with `splice(0)`, failures re-queue). A
seed that fails `placeBuilding` retries for up to 600 ticks (~10s) — a crowded
map may open up — then gives up. Without retries, an unlocked colour could be
left with no homes at all, which cascades into unservable works (see
`pickColor`'s homes guard).

## Building field defaults (from `placeBuilding`)

`waiting:[]`, `capacity:6`, `workers:[]` (shift timers), `stock:0`,
`hungerT:-pantryStart` (30s buffer), `demandT:-grace` (works, 15s slack),
`level:1`, `served:0`, `trucks:marketTrucksStart` (markets), `spawnClock`
randomized in `[0, commuters.interval)` so homes don't pulse in sync.
