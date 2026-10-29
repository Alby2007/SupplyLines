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
| `W` `A` `S` `D` / arrows | Pan the camera |
| `Space` | Pause |
| `1` / `2` | Game speed |
| `Esc` | Cancel the current draft |

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
Orphaned road nodes are cleaned up; buildings stay.

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

## Automatic behaviour worth knowing

- **Carpooling** — household members leaving for the same destination share one
  car (cap: residents per home).
- **Staff as drivers** — market workers double as milk-truck drivers; a
  short-staffed market still delivers, just with fewer trucks.
- **Shifts** — workers stay ~25s at offices, ~75s at farms/markets, then
  commute home. A home's resident slot stays occupied until they're back.
- **Workers prefer understaffed farms/markets** over offices — they'll walk
  past an office to staff a starving food chain.
