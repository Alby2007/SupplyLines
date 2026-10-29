# Food logistics (`src/food.js`)

The food chain runs **farm → crate → market → milk truck → home**, staffed by
the same commuters that run offices. It starts at `week >= foodStartWeek` (2).

## Staffing

Farms and markets don't run themselves — they hold shift timers in
`b.workers[]` (one entry per worker, `food.shiftLen` = 75s each, decayed in
`food.update`). The arriving worker's **agent is parked** at the building with
`workingAt` set, and commutes home when the shift ends (see
[agents](agents.md)) — the resident slot at home stays occupied the whole
round trip.

- **Farm** produces a crate every `produceInterval` (6s) while
  `workers.length >= workersNeeded` (2). All-or-nothing.
- **Market** dispatches trucks gated per worker (see below) — degrades
  gracefully rather than all-or-nothing.
- Agent capacity is `workersNeeded*2` — a couple extra staff can overlap
  before the shift timers rotate out.

## Crates

Farm spawn: `spawnAgent(b, 'crate', marketMatch)` — dest overridden at path
time by `crateMatchers`, which prefers markets **on the farm's freight line**
(product rides the railway it was loaded onto), falling back to any active
market. Crates ride `foodTruck`s on road legs or freight wagons on lines —
never passenger cars. On arrival at a market: `b.stock++`,
`freightDelivered++`, agent deleted.

## Home → market assignment

Every `assignInterval` (3s), `assignHomes` runs `roadDistancesFrom` per colour:

- For each colour, multi-source Dijkstra over the **road** graph from that
  colour's active markets.
- Each active same-colour home records `assignedMarket` = nearest reachable
  market (or `null`) and `marketDist`.
- Unreachable or colour-less homes get `assignedMarket: null` — they starve
  unless the player fixes connectivity (that's the game).

## Dispatch (`tryDispatch`)

Every `dispatchInterval` (2s) per market:

- Requires `stock > 0` and **driver room**:
  `activeTrucks < min(trucks, workers.length)` — each on-shift worker means
  one more truck on the road. A 1-worker market with 3 trucks still delivers,
  just one truck at a time. An unstaffed market stalls completely.
- Targets = assigned homes with `hungerT > hungryAt` (20s), sorted hungriest
  first — deliveries triage the most desperate homes.
- `load = min(stock, milkCap(3), targets.length)`; stock decrements on spawn.

## Milk trucks (`spawnMilkTruck` → `milkArrive`)

- Route: `findPathTo` **road-only** legs to the hungriest target — milk trucks
  don't use rail.
- Phase `'deliver'`: on each arrival, `load--`, `home.hungerT = 0`,
  `home.fedAt = time`, shift the target, re-route from the current stop to the
  next target (legs are recomputed fresh at each hop — road edits mid-route
  get picked up here, unlike cached `segs` while driving).
- `load == 0` or targets exhausted → phase `'return'` back to the market.
- Arriving home (or unable to route): despawn, decrement `activeTrucks`.

## Homes starving

`economy.update` adds `dt` to `b.hungerT` every tick once the food era starts.
`hungerT` starts at `-pantryStart` (−30s buffer for new homes). At
`hungerLimit` (90): `gameOver = 'A home starved'`.

The whole loop in one line: staff farm → crates stock markets → trucks reset
`hungerT` before it hits 90 — starved homes are a connectivity failure, not a
numbers failure.
