# Testing

88 tests across 10 files, all headless — the sim layer is DOM-free so Node's
built-in runner executes it directly.

```sh
npm test                    # node --test 'tests/*.test.js'
node --test tests/roads.test.js   # one file
```

## Layout

| File | Covers |
|---|---|
| `grid.test.js` | Cell math: Bresenham, route geometry, clampCell, polylines |
| `roads.test.js` | Building, splitting, intersections, stubs, cell index, bulldoze |
| `routing.test.js` | Dijkstra legs, transfers, mode filters, graph-cache invalidation |
| `networks`→`lines.test.js` | Extend/prepend, train.from, loops, demolition |
| `junction.test.js` | Placement rules, splicing, overflow reason |
| `spawn.test.js` | Placement rules, type/colour choice, seed retries |
| `agents`→`colors.test.js` | Colour locks, unlock progression, colour-aware food |
| `food.test.js` | Farm→market→home chain, staffing, milk trucks, commutes |
| `freight.test.js` | Freight lines, crate routing, wagons |
| `sim.test.js` | Integration/fuzz: connectivity, liveness, traffic deadlocks |

## Conventions

All tests follow the same stub-and-drive pattern — no framework, no fixtures:

```js
import { createState } from '../src/state.js';

function b(state, id, type, x, y) {           // minimal building stub
  state.buildings.set(id, {
    id, type, x, y, active: true, waiting: [], capacity: 6,
    overflowT: 0, spawnClock: 2,
    // add fields the system under test touches: workers, stock,
    // hungerT, demandT, trucks, assignedMarket, roadNodeId...
  });
}
```

- `createState()` builds a real world object — most tests skip `seedInitial`
  and plant buildings via the stub.
- Drive the sim by calling the subsystem updates directly:
  `agents.update(s, 1/60)`, `vehicles.update(s, 1/60)` — usually in a
  `runTicks(s, n)` helper loop.
- `state.time` only advances if you advance it — `s.time += dt` manually or
  rely on subsystem timers. Tests that need real elapsed time tick it.
- When mutating network structure by hand (splicing `line.stops`, deleting
  edges) bump `state.netVersion++` yourself — production code does it for you,
  raw test surgery doesn't.
- Assertions are `node:assert/strict` — `assert.equal`, `assert.deepEqual`,
  `assert.ok`.

## Writing a test for new behaviour

1. Pick the owning file by subsystem (see table) or add a new `*.test.js` —
   the glob picks it up automatically.
2. Stub buildings at real coordinates — positions matter (`cellOf`,
   `routePts`, `roadCellIndex` all consume x/y).
3. For route-dependent tests, build connectivity explicitly: `addLine`,
   `buildRoad(cellsBetween(cellOf(a), cellOf(b)))`, `insertJunction`.
4. For agent tests, either `spawnAgent(s, b, 'person', dest)` or hand-roll the
   minimal agent `{id, kind, color, home, dest, loc, legs, pathV, retryT,
   wait}` — `mkAgent` helpers exist in `lines.test.js`/`food.test.js`.
5. Prefer asserting **observable outcomes** (agent.loc, building.waiting,
   map sizes) over internals — these tests survived multiple refactors
   because they pin behaviour, not implementation.

## Known test caveats

- `state.nextId` starts at 1 — stub buildings with literal ids (1, 2, 3) and
  let `nid()` allocate vehicles/agents; avoid colliding with stub ids.
- `buildings` created by the stub lack `workers`/`stock` etc. — add the fields
  your path touches or you'll get `undefined`-arithmetic NaNs.
- `sim.test.js` fuzz cases are seeded runs — keep them deterministic; don't
  add `Math.random()` reliance without a seeded helper.
- The suite is fast (~1s); a slow test is usually a `runTicks` count that's
  too high for the assertion — most arrivals need <10 sim-seconds.
