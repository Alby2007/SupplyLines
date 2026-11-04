# Architecture

## Stack

- **Vanilla JavaScript ES modules**, no build step. `index.html` loads
  `src/main.js` as a module; everything else is imported from there.
- **HTML5 Canvas** for the world; DOM only for HUD/modals/hotbar.
- **node:test** for tests — the simulation modules are DOM-free, so tests
  import them directly under Node (`"type": "module"` in package.json).

The sim layer (`state`, `grid`, `spawn`, `roads`, `networks`, `routing`,
`agents`, `vehicles`, `food`, `economy`) never touches the DOM — that's what
makes the headless test suite possible.

## Module graph

```
config   state   grid
   │       │       │
   ▼       ▼       ▼
spawn ──► roads ◄──► networks      (roads ↔ networks is circular, safe:
   │       ▲           ▲            both use call-time function refs)
   │       │           │
   ▼       │           │
routing ───┴───────────┤
   ▲                   │
agents ◄──► vehicles ──┘           (agents ↔ vehicles is also circular)
   ▲           ▲
   └─────┬─────┘
        food
          ▲
       economy
```

`main.js` wires `input` → sim modules → `render`/`ui`. The DOM-side modules
(`input`, `render`, `ui`, `main`) are never imported by sim code.

## The state object

`createState()` returns the single mutable world. Everything lives here —
there's no store, no classes, just plain objects in Maps keyed by integer id
(`nid()` issues ids).

```js
{
  time, week, weekT,                 // sim clock; weekT rolls into week++
  buildings: Map<id, Building>,      // homes/works/farms/markets/junctions
  lines: Map<id, Line>,              // transit lines
  roadNodes: Map<id, RoadNode>,      // graph vertices (incl. building nodes)
  roadEdges: Map<id, RoadEdge>,      // graph edges (polylines + vehicle sets)
  agents: Map<id, Agent>,            // people and crates mid-journey
  vehicles: Map<id, Vehicle>,        // cars, foodTruck, milkTruck, train
  nextId,                            // id allocator
  delivered, freightDelivered,       // score counters
  gameOver, paused, pauseMenu, speed,
  upgradePending,                    // weekly modal gate
  netVersion,                        // THE invalidation counter — see below
  unlockedColors: [0],               // palette indexes, ratchet
  colorSeedQueue: [],                // pending forced spawns after unlocks
  maxLines, roadTiles, roadCapBonus, // budgets
  motorways, motorwayGranted,        // item stock + first-grant flag (week 4)
  roundabouts, roundaboutGranted,
  trafficLights, trafficLightGranted,
  camera: {x, y},
  assignClock, spawnClock,           // subsystem timers
}
```

### Key object shapes

**Building** — `id, type, shape, color|null, x, y, active, waiting[], capacity,
overflowT, spawnClock, openAt, workers[], stock, hungerT, demandT, level,
served, produceClock, assignedMarket, marketDist, trucks, activeTrucks,
dispatchT, roadNodeId?`.

Not all fields are meaningful per type (`stock` only markets, `level`/`demandT`
only works, `assignedMarket` only homes). `waiting[]` holds agent ids, not
agents.

**Line** — `id, color|null, stops[buildingId], loop, trains[vehicleId],
wagons, freight`. `stops` is ordered; loops have no duplicated endpoint.

**RoadNode** — `id, x, y, bid|null` (`bid` set when the node is a building's
driveway), `light?` (`{groups, idx, t, edgeCount}` — installed traffic-light
phases). **RoadEdge** — `id, a, b` (node ids), `pts`, `vehicles:Set<vid>`,
plus flags: `motorway` (elevated express edge), `oneway` (roundabout ring
arcs), `roundabout:{x,y}` (ring membership — used for atomic demolition and
yield rules).

**Agent** — `id, kind:'person'|'crate', color, home, dest, loc, legs, pathV,
retryT, wait, workingAt?, shiftT?`. `loc` is a **building id** while waiting or
`{veh: vehicleId}` while riding. `legs` is the cached route (see
[routing](systems/routing.md)); `dest` is a matcher function or array of them.

**Vehicle** — cars/trucks: `id, kind, color, segs[], seg, dist, pax[]`. Trains:
`id, kind:'train', line, freight, from, dir, t, dwellT, pax[], cap`.
MilkTruck adds `market, load, phase, targets[]`.

## The tick loop

`main.js` runs a fixed-step accumulator:

```js
const STEP = 1/60;
acc += dt * state.speed * 0.5;   // 1x = half the "natural" pace
while (acc >= STEP) tick(STEP);
```

`tick(state, dt)` lives in `src/tick.js`, shared verbatim by `main.js` and
the headless drivers (`autoplay.mjs` → `rl/env_worker.mjs`, which bolt on
their env flags through `opts`). Order matters:

```js
state.time += dt; state.weekT += dt;  // clock first
// week rollover → week++, upgradePending, +roadTiles
spawn.update(state, dt);     // placements, activation, colour unlocks
economy.update(state, dt);   // meters, game-over (can end the game)
food.update(state, dt);      // shifts decay, production, dispatch
agents.update(state, dt);    // pathing, departures, shift release
vehicles.update(state, dt);  // trains then road vehicles; arrivals
```

Rendering (`draw`) and `updateHUD` run once per `requestAnimationFrame`,
decoupled from sim steps.

The accumulator is gated by `!state.paused && !state.gameOver &&
!state.upgradePending` — three separate pause sources: `paused` (Space, HUD
button, or the Esc **pause menu**, which also sets `pauseMenu` to show its
card), `gameOver`, and the weekly upgrade modal. The camera keeps panning
while paused.

## The `netVersion` contract

`state.netVersion` is bumped by **every** mutation to routable structure:
buildRoad, splitEdgeMulti, demolishRoad, buildMotorway, placeRoundabout,
buildRoundabout, placeTrafficLight (and its removal), addLine, extendLine,
insertJunction, removeJunction, deleteLine. Two families of consumers read it:

1. **Agents** — `a.pathV !== state.netVersion` invalidates cached `legs`, so
   paths recompute after any edit (with a 2s `retryT` delay).
2. **Derived indexes** — `roadCellIndex`, `lineCellIndex`, `lineSegCellIndex`,
   and the routing `graphFor` cache are all memoized on it.

**Rule:** if you add a mutation that changes what roads/lines exist or how
they connect, bump `netVersion`. Missing a bump = ghost routes over deleted
geometry. All three indexes also keep separate caches — road edits currently
invalidate the line cell cache too (harmless, slightly wasteful).

## Memoized/cached state (don't serialize, all `_`-prefixed)

| Field | Owner | Keyed on |
|---|---|---|
| `_cellIdx`/`_cellIdxV` | `roadCellIndex` | `netVersion` |
| `_lineCellIdx`/`_lineCellV` | `lineCellIndex` | `netVersion` |
| `_lineSegIdx`/`_lineSegV` | `lineSegCellIndex` | `netVersion` |
| `_graphs` | `graphFor` (routing) | `netVersion` + `floor(time/0.8)` |
| `_tick`, `_yieldIdx`, `_yieldV` | vehicle yield buckets | per `update()` call |
| `_camInit` | main.js | one-shot camera centering |

## Conventions

- **Ids are integers**, allocated by `nid(state)`. Buildings, agents, vehicles,
  road nodes, and edges share one sequence.
- **`state.X` Maps** are the only indexes; arrays like `line.trains`,
  `b.waiting`, `v.pax`, `e.vehicles` hold ids, always resolved via the Map.
- **Time is sim-seconds.** Tests usually leave `state.time` at 0 and call
  `update()` directly — anything keyed on `time` still works.
- **Positions are world px**, grid cells are `cx/cy` (`CONFIG.grid.cell`=40).
  Angles are radians; screen-y is down (affects lane offsets).
- **Error handling is light by design** — absence is represented by `null`/
  `undefined`/empty collections, not exceptions. `?.` chains everywhere.
- **Intentional quirks** (don't "fix" without checking docs/comments): cars
  finish trips on cached geometry when their road is demolished
  (`segsForLeg`/`edgeId: null` fallback); connection trains are only awarded
  by *new* lines, not extensions.
