# Roads & traffic (`src/roads.js`, road parts of `src/vehicles.js`)

## Model

Roads are a planar graph on the 40px cell grid:

- **RoadNode** `{id, x, y, bid|null}` — a vertex. `bid` set = a building's
  driveway node (created lazily by `roadNodeForBuilding`, cached on
  `b.roadNodeId`).
- **RoadEdge** `{id, a, b, pts, vehicles:Set<vid>}` — a polyline between two
  nodes, with the live set of vehicle ids currently on it (for congestion and
  follow gaps).

Buildings connect via **stub edges**: when a drawn cell path passes within
`connectRadius` of a building (snap 26 + glyph radius), its driveway node is
spliced into the path — that's the "driveway" you see.

## Drawing → cells → graph

1. `input.js` collects a Bresenham cell path (`cellsBetween`), clamped to the
   map (`clampCell`), with endpoints snapped by `snapPoint`
   (building > road edge within `snap` px > free point).
2. `buildRoad(state, cells)` walks the path:
   - Junction cells are a **hard reject**: if any drawn cell holds a junction,
     the entire build fails (`return []`) — no road, no charge.
   - Cells already holding road merge into the network for free — cost only
     counts unindexed cells (`roadCellCost`), and only when `buildRoad` came
     back non-empty are tiles deducted.
   - `anchorAt` resolves free endpoints: building within snap → driveway node;
     edge within snap → `splitEdgeMulti` at the hit `t` (or reuse the nearer
     endpoint when `t` near 0/1); otherwise a cell-center node.
   - Drawn cells that hit existing road **edges** get split-and-joined, which
     is how intersections form.
3. Cost = `roadCellCost` = cells not already indexed in `roadCellIndex`.

## Splitting (`splitEdgeMulti`)

An edge split at marks `t[]` (arclength fractions):

- Marks are coalesced: marks closer than ~1px-equivalent (`minGap`, scaled to
  the edge's length) share one node — near-coincident split points can't birth
  degenerate stubs.
- Each chunk is `slicePolyline`d; chunks whose polyline length is ≤ ~1px are
  replaced by a **stub edge** linking the two distinct nodes — connectivity is
  never silently broken, even when two joins land at the same arclength
  position (a real bug class this code exists to prevent).

## The cell index (`roadCellIndex`)

`Map<cellKey, [{edgeId}]>` covering every cell every edge's polyline crosses
(`cellsAlongPolyline`). Memoized on `netVersion`. Used by: spawn blocking,
`roadCellCost`, `roadCellCost`-style coverage checks in `junctionPlacement`,
and the spatially-restricted `nearestEdgePoint`.

## Traffic model (`updateRoadVeh`)

Road vehicles move along `v.segs` — cached per-leg chunks
`{pts, len, edgeId, fwd}`:

- `edgeId` may be **stale** (edge demolished/split after routing): the vehicle
  keeps driving the cached geometry to its destination. **This is
  intentional** — Motorways-style, don't "fix" ghost driving.
- Per edge, vehicles register in `e.vehicles` on entry (`registerOnEdge`) and
  leave on exit (`leaveEdge`) — the same set drives congestion and following.

**Following**: along each edge, cars measure the gap to the next vehicle
*in travel direction* (`fwd`-aware — reversed segments invert the axis, which
is why the code computes positions in edge-arclength space then gaps in travel
space). Distance this tick is clamped to `gap - followGap`.

**Junction yield**: within `yieldLookahead` px of a segment end, a car checks
the node (segment's last point) for any vehicle inside `junctionBox` px.
Blocked cars hold short (`rem - 2` px) until `yieldPatience` seconds pass —
then they nose in anyway, which is the deadlock breaker for a parked,
follow-blocked car sitting in the box.

The "inside the box" query uses a **per-tick spatial bucket**
(`yieldIndex`): all road vehicles bucketed into `junctionBox`-sized cells once
per `update()`; the check probes the 3×3 neighbourhood. Positions are a
per-tick snapshot (drift ≤ speed·dt ≈ 1.5px, negligible vs the 16px box);
`yielding` vehicles and mid-tick deletions are filtered fresh.

**Congestion**: `congestFactor` = `1 - frac·(1 - 0.45)` where `frac` ramps
from `congestAt`(6) to `maxPerEdge+bonus`(12) vehicles — free flow down to
0.45× speed on packed edges. Cars and trucks both scale. The same factor feeds
routing costs, so congested roads lose to rail.

**Lanes**: `carPos` offsets `laneOffset` px to the right of travel
(perpendicular `-sin, +cos` in screen-y-down space) — pure cosmetics, but it
also means junction-box checks use the visual position.

## Bulldozing (`demolishRoad`)

- Takes dragged **cells**; deletes every edge whose polyline passes through
  them; returns the count of tiles no longer covered (refunded to
  `state.roadTiles`, capped at `tilesCap`).
- **Orphan sweep**: road nodes with no remaining edges are removed — except
  building driveway nodes (`bid != null`), which persist so buildings stay
  reconnectable.
- Bumps `netVersion`. Line/junction demolition is a separate pass
  (`demolishLines` in networks.js).
