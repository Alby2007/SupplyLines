# Routing (`src/routing.js`)

One multimodal graph unifies roads and transit so a single Dijkstra answers
"how do I get there?" — a route is a list of **legs** alternating between
driving and riding a line.

## Graph construction (`buildGraph`)

Nodes:

- `b{id}` — every building (junctions included).
- `r{id}` — every road node, except nodes with `bid != null` which alias to
  `b{bid}` (`roadNodeKey`) — building driveways are graphically *part* of the
  road graph but logically resolve to the building.

Edges (per mode filter `opts.modes`):

- **line** — each adjacent stop pair (wrap-around on loops), both directions.
  Cost = `segLen / trainSpeed + stopPenalty`. Carries `lineId`, `lineColor`,
  `freight`, and `wait` — the expected boarding wait, computed per line:
  `wait = max(boardWait, cycleTime / trains / 2)`, where cycle time is the
  line's full length (or 2× for non-loops) plus dwells. Sparse lines cost more
  to board, so adding trains genuinely improves routing.
- **road** — each `roadEdge`, both directions. Cost =
  `len / max(10, carSpeed·congestFactor(edge))` — live congestion makes busy
  roads slower *in pathfinding*, not just in animation. **Motorway** edges
  multiply the cruise speed by `motorways.speedFactor` (1.6×) in the same
  cost term, so routing prefers the express option. **`oneway`** edges
  (roundabout ring arcs) only route in their built direction — the reverse
  adjacency entry is skipped.

## Pathfinding (`findPath`)

Dijkstra over `(node, transport)` states — `skey = "n~m"` where `m` is `''`,
`'r'`, or `l{lineId}`:

- Entering a line costs its `wait` once; switching transport mid-trip
  (`cur.m !== em` with a non-empty current mode) adds `transferPenalty`.
  Riding the same line through consecutive segments costs nothing extra.
- `opts.lineColor` filters line edges to that colour and never freight;
  `opts.freight` filters to freight lines only. Colour-lock and cargo rules
  are enforced **at the graph level**.
- Goal: first *active* building node matching the `dest` predicate (a type
  string or matcher function). Returns `null` if unreachable.
- Priority queue is a linear-scan array — small graphs, correct enough;
  it's a known O(V²) Dijkstra that stays cheap at this scale.

## Leg compression

Raw edge sequences compress into legs — consecutive same-mode (and same-line)
edges merge:

```js
{ mode, lineId, from, to, fromNode, toNode, nodes[], edgeIds[] }
```

- `from`/`to` are *building ids* (line legs always terminate at buildings —
  transfers happen at shared stops).
- `nodes[]`/`edgeIds[]` keep the full node path and road edge ids so
  `segsForLeg` can rebuild drive geometry — including stale `edgeId`s after a
  split or demolition (geometry is cached by design).

`findPathTo` is `findPath` with a single-building predicate.
`roadDistancesFrom` is a multi-source Dijkstra over the road-only graph
returning `{dist, src}` maps — used to assign each home its nearest market
(staffed markets preferred; see food.md).

## The `graphFor` cache

`buildGraph` ran per `findPath` — every retry, dispatch, and assignment. Now
graphs are cached per mode slot (`'a'` both, `'l'` line-only, `'r'` road-only)
under:

```
key = `${netVersion}:${floor(time / 0.8)}`
```

- **Topology is exact**: legs may embed edge ids that must exist, so the cache
  key always includes `netVersion` — demolition can never serve stale edges
  (there's a regression test).
- **Congestion costs are ~0.8s stale**: the sim-time epoch lets traffic shifts
  reroute without rebuilding on every call.
