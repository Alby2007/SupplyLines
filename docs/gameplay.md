# How to play

**Goal:** keep the growing city connected. Homes produce commuters who need to
reach same-colour workplaces — and later, food. You lose if any building's
meter fills completely.

## Controls

| Input | Action |
|---|---|
| Left-drag (tool armed) | Draw a road or line |
| Left-drag (no tool) | Pan the map |
| Middle-drag | Pan the map (always works) |
| `R` | Road tool |
| `L` | Line tool |
| `J` | Junction sub-tool (in the line group) |
| `B` | Bulldozer sub-tool (in the road group) |
| `M` | Motorway sub-tool (in the road group) |
| `O` | Roundabout sub-tool (in the road group) |
| `T` | Traffic light sub-tool (in the road group) |
| `W` `A` `S` `D` / arrows | Pan the camera |
| `Space` | Pause |
| `1` / `2` | Game speed |
| `Esc` | Cancel draft → then pause menu → closes it |

Clicking the armed tool's hotbar button (or pressing its key again) disarms it.

## Tools

### Road tool

Drag anywhere — the path is quantized to grid cells (8-connected). Drag
**through a building** to serve it: the road snaps to the building as an
anchor. Dragging onto an existing road anchors there too (the edge is split at
the snap point, creating a junction node). Ending a drag in empty space does
nothing — at least one endpoint must anchor.

Costs **road tiles**, one per new cell (shared cells are free). The badge shows
tiles remaining: 40 to start, +18 each week, capped at 99. A drag through a
junction cell is rejected outright — junctions are rail-only.

Roads are shared infrastructure — every colour and every vehicle kind uses
them. Congestion builds where too many vehicles share an edge.

### Line tool

Drag building-to-building. The line locks to the colour of its first coloured
stop and only carries that colour's people. Track routes metro-style:
diagonal-then-straight with at most one bend.

- A new line gets **one train** free.
- Drag from an **endpoint stop** to extend a line (either end). Dragging back
  onto the far endpoint closes it into a **loop** — trains then circulate
  instead of bouncing.
- Maximum lines is fixed (3 at start; the "New transit line" upgrade adds more).
  The badge shows lines remaining.
- Lines including a **farm** become freight lines: neutral colour, carry crates
  only, never people. Freight and passenger stops can't mix.

### Junction sub-tool

Click on existing track in a free cell to drop an interchange **junction** — a
stop that lines can share. Up to 3 lines may pass through one junction. This is
how passengers transfer between lines: their routes path through shared stops.

A **new** line that lands on junctions awards one bonus train to each existing
line it touches (extending an existing line into a junction does not — that's
intentional).

### Bulldozer

Drag cells to erase. Deletes road edges under the drag and refunds every tile
not still covered by another road. Also demolishes any **line** whose track
crosses the dragged cells (trains despawn, passengers are dropped at the
nearest stop to re-route) and removes any **junction** left without service.
Orphaned road nodes are cleaned up; buildings stay. Touching any arc of a
**roundabout** removes the whole ring (no tile refund — it cost an item), and
bulldozing a lit junction refunds the light to your stock.

### Motorway

Arms only while you have a span in stock (first arrives at **week 4**, badge
shows count, more come from weekly picks, cap 9). Drag free-form between two
points on the existing network — the span is an **elevated express edge** that
passes *over* the surface roads: no cells, no tile cost, no intersections.
Both ends must anchor (building > node > edge). Vehicles on it cruise at
**1.6×** car speed, and routing treats it as the fast option.

### Roundabout

Arms with stock (first at **week 4**, cap 9). Click to drop:

- **On a junction** — replaces it; the incident roads become spokes feeding a
  one-way circulating ring.
- **On a road** — splits the edge and both halves feed the ring.
- **On open ground** — stamps a standalone ring; roads drawn to it later join
  normally.

Inside the ring traffic circulates one-way and never yields — entering cars
yield once at their entry node. It's the fix for a junction choked by
yield-lock. Can't be placed on top of a building or another roundabout.

### Traffic light

Arms with stock (first at **week 4**, cap 9). Click a **real junction** (≥3
arms, not a roundabout ring) to install — opposite arms pair into phases that
rotate every 2.2s. Red arms hold at the line unconditionally; that guarantees
a side road its turn on a saturated crossing that yield-to-occupied would
starve forever. Click the lit junction again to remove and refund; bulldozing
the junction refunds it too. The white ring at the crossing shows a green dot
on each arm currently holding the green.

## Buildings

| Shape | Type | Role |
|---|---|---|
| Circle | Home | Houses residents (≤2 out at once), needs workers back, gets hungry |
| Square | Work | Employs people; 2×2-cell footprint; has a demand meter and levels |
| Octagon | Farm | Neutral colour; produces crates when staffed |
| Triangle | Market | Receives crates, dispatches milk trucks to same-colour homes |
| Ring | Junction | Interchange stop; produces nothing |

New buildings appear as dashed "incoming" outlines for ~3s before opening, so
you can pre-draw roads through them.

## Meters (what kills you)

- **Workplace demand** — fills at 1/s while unserved (faster at higher levels).
  Each arriving worker buys back 18s. Workplaces grow through 3 levels as
  they're served; promotion also clears accrued demand.
- **Home hunger** — once farms exist, each home's meter fills at 1/s; a milk
  truck delivery resets it. New homes start with a 30s pantry buffer.
- **Waiting-room overflow** — every building (and junction) holds 6 waiters.
  Sitting at capacity for 25s ends the game.

Game over cards name the cause: understaffed workplace, starved home,
overflowed building/junction, or food rotting at a farm.

## Weekly cadence

Every 60 seconds: +18 road tiles and a choice of **1 of 2** upgrades:

- New transit line (+1 max lines)
- Add a train (to the emptiest line)
- Larger buildings (+3 waiting capacity, all buildings)
- Wider roads (+2 vehicle capacity per edge)
- +12 road tiles
- Cargo wagon (freight trains haul more crates)
- +1 market delivery truck
- Motorway / Roundabout / Traffic light (+1 stock, once granted)
- Bridges +8 — roads may cross water (Map 3 only, once granted)

The first motorway, roundabout, and traffic light each arrive automatically at
the start of **week 4**; after that they show up in the weekly picks (each
capped at 9 in stock). On Map 3 a bundle of **12 bridges** is gifted when
week 1 completes — on top of the pick — and more appear in the weekly pool.

## Stars

There's no finish line — survival is the win. At game over the run earns
**0–3 stars** by the week you *reached*: thresholds are 5/8/11 weeks on Maps
1–2 and 4/7/10 on Map 3 (`CONFIG.win.stars`, per-level overridable). The
game-over card shows the stars plus your deliveries; your **best run per map**
(stars, then deliveries as the tiebreak) is saved to `localStorage` and shown
as a star row under each level card on the Levels screen. Beat your stored
best and the card calls it out — **New best run!**

## Pause menu

`Esc` opens the pause card (after cancelling any in-progress draft): the sim
freezes and a centered card offers **Resume** (or `Esc` again), **Levels**,
and **Restart**. While it's open every other hotkey is dead. `Space` and the
HUD ❚❚ button still pause without the menu.

**Levels** opens a full-screen picker: a card per map —

- **Map 1** — the meadow: 40×32, green surface, base budgets
- **Map 2** — the desert: 80×32 (double-wide), sand surface, an impassable
  oasis, faster vehicles and a bigger road budget for the longer routes
- **Map 3** — the deep green: same 80×32 size and budgets as Map 2, darker
  pastel-green surface, and the city seeds on the **right** side of the map —
  hemmed in from the west by a wide river through the middle third. Surface
  crossings need **bridges** (draw a road across; one per water tile, spent
  automatically), while motorways and transit lines pass over for free

Picking a card starts a **fresh city** (`?level=N`) — there's no save, so
leaving mid-game loses progress. `Esc`/Back returns to the pause card.

## Visual aids

- **Minimap** — bottom-right corner of the map card. Shows the whole world:
  roads, motorway spans, water, and building dots in their colours, plus a
  white rect marking the slice your camera is looking at. It's passive —
  it doesn't block camera drags and can't be clicked.
- **Spawn arrows** — when a new building appears outside your viewport, a
  bobbing chevron sits on the screen edge closest to it, pointing toward it
  and tinted the building's colour. It lives for ~12s (covering the dashed
  "incoming" phase plus the first moments after it opens), fading in and
  out. Pan toward it or it quietly expires.

## Automatic behaviour worth knowing

- **Carpooling** — household members leaving for the same destination share one
  car (cap: residents per home).
- **Staff as drivers** — market workers double as milk-truck drivers; a
  short-staffed market still delivers, just with fewer trucks.
- **Shifts** — workers stay ~25s at offices, ~120s at farms/markets, then
  commute home. A home's resident slot stays occupied until they're back.
- **Workers prefer understaffed farms/markets** over offices — they'll walk
  past an office to staff a starving food chain. Markets keep attracting
  workers until every truck has a driver; farms stop attracting once staffed.
- **Crates pick the neediest market** — a market whose assigned homes are
  going hungry gets produce first (up to a truckload of buffer), then markets
  on the farm's freight line, then any market. If the farm's outbound queue
  backs up (~4 waiting crates), crates spill onto the road instead of waiting
  for the train.
