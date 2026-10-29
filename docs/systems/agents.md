# Agents (`src/agents.js`, arrival resolution in `src/vehicles.js`)

Agents are the unified travellers — `kind:'person'` (commuters/staff) and
`kind:'crate'` (farm produce). One object, one `update()` loop, different
destinations and payload rules.

## Lifecycle

`spawnAgent(state, atBuilding, kind, dest)`:

- `color` inherits the building's colour; `home` = the spawning building's id
  for people (this is what the residents cap counts on — see below).
- `dest` is a **matcher** (`(building)=>bool`) or an array of them tried in
  order. Agents start in `atBuilding.waiting` with `legs:null`.

Per `agents.update(dt)`:

1. **Shift release** — agents parked `workingAt != null` tick `shiftT` down;
   at expiry they clear work state, retarget `dest = home`, and requeue at the
   building they're parked in.
2. Riders (`loc` not a number) skip — vehicles own them.
3. `a.wait` accumulates; `pathV !== netVersion` invalidates `legs`.
4. No legs → `findPath` through each matcher until one returns a route
   (people pass `{lineColor: a.color}`, crates `{freight:true}`); `retryT = 2`
   regardless, so post-edit recomputes are throttled.
5. `legs[0].mode === 'road'` → immediate departure: `spawnCar` builds the
   vehicle from the leg's cached segments, then the **carpool** pass.

## Carpooling

When a person departs by road, other waiting agents may ride along — all must
be:

- `kind:'person'` from the **same `home`** (household members), and
- routed to the **same final destination** (`legs.at(-1).to` equality — full
  routes may differ in intermediate legs, only the destination is compared).

They get a copy of the driver's leg array (`a.legs.slice()` — legs are mutated
by `shift()` on arrival), board `v.pax` up to `CONFIG.homes.residents`
passengers total. The driver is explicitly skipped (`oid === a.id` self-guard
was a real bug). `arriveCar` resolves *every* passenger's own leg — carpools
alight together.

## Arrival (`arrive` in vehicles.js)

Resolves by kind + building type:

| Agent | At | Effect |
|---|---|---|
| crate | market | `b.stock++`, `freightDelivered++`, agent deleted |
| person | own home | deleted — round trip complete, resident slot frees |
| person | work | `demandT -= relief` (floored at `-grace`); `served++` → level promotion at `lvl*promoteEvery` (max 3, promotion clears demand); agent parked `workingAt`, `shiftT = work.shiftLen` |
| person | farm/market | if `workers.length < workersNeeded*2`: push shift timer + park the agent identically to offices — staff commute home after their shift |
| anything | else | deleted |

The staff rule is important: **agents are not consumed on arrival at
farms/markets** — they hold the resident slot at home until they physically
return, so a 2-resident home supports at most 2 concurrent workers incl.
travel. Offices behave identically, keeping the two systems consistent.

## Where people want to go (`personDestFor`)

Matchers tried in order:

1. `understaffedFor(color)` — active farms (any colour — they're neutral) or
   same-colour markets with `workers.length < workersNeeded + 1`. Workers
   prefer the food chain over offices at any distance.
2. `officeFor(color)` — active same-colour workplaces.

Falls through to `null` legs → waits, retries every 2s.

## `presenceCounts`

One `O(agents)` scan producing `out` (home→residents away) and `shift`
(building→workers on shift) maps — called once per render frame and once per
economy update (lazily, only when a spawn check fires), replacing what used to
be a per-building agent scan.

## Edge cases the code handles

- `legs` referencing a deleted line/edge → invalidated by `netVersion` at the
  next wait; riders on a demolished train are dumped at the train's current
  stop instead.
- Agents waiting at a removed junction are relocated to the nearest active
  non-junction building (or deleted if the world is empty).
- A rider whose destination junction was bulldozed has `legs[0].to` pointing at
  a dead id → `removeJunction` nulls their legs and `exchange()`'s stranded
  branch drops them at the next stop.
