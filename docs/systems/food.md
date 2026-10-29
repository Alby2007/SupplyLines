# Food logistics (`src/food.js`)

The food chain runs **farm → crate → market → milk truck → home**, staffed by
the same commuters that run offices. It starts at `week >= foodStartWeek` (2).

## Staffing

Farms and markets don't run themselves — they hold shift timers in
`b.workers[]` (one entry per worker, `food.shiftLen` = 120s each, decayed in
`food.update`). The arriving worker's **agent is parked** at the building with
`workingAt` set, and commutes home when the shift ends (see
[agents](agents.md)) — the resident slot at home stays occupied the whole
round trip.

- **Farm** produces a crate every `produceInterval` (4s) while
  `workers.length >= workersNeeded` (2). All-or-nothing.
- **Market** dispatches trucks gated per worker (see below) — degrades
  gracefully rather than all-or-nothing.
- Agent capacity is `workersNeeded*2` — a couple extra staff can overlap
  before the shift timers rotate out.
- **Attraction** (in agents.js) matches function: farms pull workers only
  while below `workersNeeded`; markets pull while below
  `min(trucks, workersNeeded*2)` — staff are truck drivers, so a market
  staffs up to its truck count and a "+1 truck" upgrade actually lands.

## Crates

Farm spawn: `spawnAgent(b, 'crate', marketMatch)` — dest overridden at path
time by `crateMatchers`:

1. `hungryMarketMatch` — a market under a truckload of stock whose assigned
   homes are going hungry gets crates **first** (the old nearest-market rule
   funnelled all produce into one colour and starved every other).
2. Markets on the farm's own **freight line** — product rides the railway it
   was loaded onto.
3. Any active market.

Crates ride `foodTruck`s on road legs or freight wagons on lines — never
passenger cars. When the farm's own waiting queue hits ~4 crates they switch
to **road-first** routing (unrestricted as fallback), so a single congested
freight train can't rot the farm. On arrival at a market: `b.stock++`,
`freightDelivered++`, agent deleted.

## Home → market assignment

Every `assignInterval` (3s), `assignHomes` runs `roadDistancesFrom` per colour:

- For each colour, multi-source Dijkstra over the **road** graph from that
  colour's active markets — run first over markets with ≥1 worker (staff are
  the truck drivers), then over all markets as fallback.
- Each active same-colour home records `assignedMarket` = nearest reachable
  **staffed** market, falling back to nearest unstaffed one when nothing
  staffed can reach — an unstaffed market can't poach homes it can't serve.
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
- `load = min(stock, milkCap(4), targets.length)`; stock decrements on spawn.

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
