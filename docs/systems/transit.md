# Transit lines, trains & junctions (`src/networks.js`, train parts of `src/vehicles.js`)

## Line model

```js
{ id, color|null, stops[buildingId], loop, trains[vehicleId], wagons, freight }
```

- `stops` is the ordered building-id list. **Loops carry no duplicated
  endpoint** — `loop:true` implies the wrap segment `stops[n-1] → stops[0]`.
- `color` locks to the first coloured stop (farms and colourless junctions
  don't set it). Passenger legs may only ride lines of the agent's colour.
- `freight` is set at creation if any stop is a farm. Freight lines carry
  crates only; the two vehicle payloads never mix, and draft rules keep
  home/work stops off freight lines (and farms off people lines).

## Track geometry

`lineSegPts(a,b) = routePts(a,b)` — the metro-map route: diagonal cells until
one axis aligns, then straight (≤1 bend), with endpoints **pinned to the exact
building positions** (cell centres in between). A reverse journey retraces the
same canonical polyline backwards — the train never takes a mirrored return
route.

`linePts` concatenates segment polylines for drawing; `lineSegLen` sums their
length (min 1px so zero-distance stops don't divide by zero).

## Building a line

Draft (`input.js`): first click on a coloured active building (or a farm),
then hover over more buildings to append stops. Rules enforced while drafting:

- Re-hovering the previous stop pops it (backtrack to undo); re-hovering the
  current stop or an already-included stop is ignored.
- Colour lock: coloured stops must match (or set) the draft colour; farms and
  colourless junctions stay neutral; a non-farm colourless building can't be a
  stop on a people line.
- Farm on the draft flips `freight=true` (rejected on extend of a people line).
- Junctions beyond `junctions.maxLines` reject.
- Extending: dragging from an **endpoint** of a non-loop line extends instead
  of creating — from the head it's a **prepend**.

On release: `addLine` + `addTrain` (one free train) + `awardConnectionTrains`.
Extending: `extendLine(stops, added, prepend)`.

## `extendLine` — the subtle one

- Appending inserts `added` in drag order. **Prepending reverses it** — the
  last stop dragged is the new terminus, so geometry follows the drag.
- On prepend, every train's `from` index is shifted by `added.length` — trains
  stay on their stops instead of teleporting to the new head.
- Loop closing works on **either end**: dragging onto the far endpoint puts a
  duplicated stop where the `stops[0] === stops[last]` check finds it
  (prepend → index 0 after reversing; append → the tail). It pops the dup,
  sets `loop`, and re-bases train `from` indices modulo the new length.

## Trains (`updateTrain`)

State: `from` (stop index the train is at/left), `dir` (±1), `t` (0..1 along
the segment), `dwellT`.

- Non-loop lines: trains traverse segments in order and **bounce** at the ends
  (`dir` flips). Loop lines: circulate forever.
- `trainPos` resolves `from`/`dir`/`t` to world position along the canonical
  segment polyline — that's how dir=-1 rides the same track backwards.
- At each stop the train dwells `CONFIG.trains.dwell`s, then `exchange()`:
  **alight** riders whose current leg ends here (or whose legs were nulled by
  a demolition — stranded riders get off and repath), then **board** waiters
  whose current leg is a line-leg on this line with room (`cap`, or crates on
  freight up to `crateCap·(1+wagons)`).
- Boarding is directional (`dirOk`): riders only board a train actually
  heading toward their leg's target stop — loop lines accept everyone, and at
  bounce endpoints the effective direction is forced inward so nobody boards
  a train about to reverse away from their stop.

## Junctions (interchanges)

A junction is a building: `type:'junction'`, neutral-or-line colour, capacity
6, `radius:9`, ring glyph. It's a stop that produces nothing.

- `junctionPlacement(p)`: nearest track point within `junctions.snap`, in a
  cell not claimed by any building's cells **and** not in `roadCellIndex`
  (junctions can't sit on roads). Placement cell snaps to cell centre.
- `insertJunction(line, segIdx)`: splices the junction after the segIdx stop;
  `train.from` indices at/after the insert shift up one.
- `junctionCanJoin`: a junction accepts another line only while
  `linesThrough(jid) < junctions.maxLines` (3).
- `awardConnectionTrains`: when a **new** line is created through junctions,
  every *other* line through those junctions gains one train (t=0.5 stagger).
  Extensions don't trigger this — deliberate rule asymmetry.

## Freight flow (rail side)

A crate agent at a farm prefers markets **on the same freight line** (computed
per-call by `crateMatchers`); any market is the fallback. Crates board only
`freight:true` line edges; capacity is `crateCap` crates per `(1 + wagons)`
wagons (`wagons` grows via the Cargo wagon upgrade).

## Demolition (`demolishLines` / `deleteLine` / `removeJunction`)

Bulldozer drags hand their cell set to `demolishLines` after `demolishRoad`:

- Any line whose routed track **cells** intersect the drag is deleted whole —
  `deleteLine` despawns its trains and drops each rider at the train's current
  `from` stop with `legs=null` (they repath from there).
- After a deletion, every stop of the dead line is checked: a `junction` with
  `linesThrough() === 0` is swept via `removeJunction` — its waiters are
  relocated to the nearest active non-junction building.
- `removeJunction` (also callable standalone) un-splices the stop from every
  line, decrements `train.from` for trains past the removed index, and nulls
  the legs of riders whose current leg targeted the junction — they'll alight
  at the next stop via the stranded-rider branch of `exchange()`.
- A demolished line frees a `maxLines` slot automatically (`lines.size` drops).

Semantics note: a junction's cell is always on its lines' track, so dragging a
junction cell kills the line(s) too — junction removal is effectively line
demolition, not surgical stop removal.
