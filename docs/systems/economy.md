# Economy, meters & game over (`src/economy.js`, week logic in `src/main.js`)

`economy.update` owns the three lethal meters, home commuter spawning, and
game-over detection. It runs before `agents`/`vehicles` each tick, so a
game-over flag set here stops later phases that tick.

## Workplace demand

`demandT` fills at `rate · (1 + (level-1)·growth)` per second:

- Starts at `-grace` (−15s) — new workplaces get slack.
- Each worker arrival clears `relief` (18s), floored at `-grace` (can't
  bank extra).
- **Level ratchet**: `served` counts arrivals; at `level·promoteEvery` the
  building levels (max 3), `demandT` clamps to ≤0 on promotion, and the rate
  grows (`growth` 0.3/level — L3 demands 1.6× flow). A well-served workplace
  literally becomes harder to keep fed — the Motorways difficulty ratchet.
- `demandT ≥ limit` (90) → **"A workplace went understaffed"**.

## Home hunger

- Only ticks once a farm exists (`foodEra` — any active farm anywhere).
- `hungerT += dt`; milk-truck delivery resets to 0. Starts at `-pantryStart`.
- `hungerT ≥ hungerLimit` (90) → **"A home starved"**.

## Overflow

Every building (junctions included) tracks `waiting.length ≥ capacity`:

- At/over capacity: `overflowT += dt`. Under: `overflowT -= 1.5·dt` (floored 0).
- `overflowT ≥ overflowLimit` (25s) → game over with a per-type reason:
  home / work / farm ("Food rotted at a farm") / market / junction.

## Commuter spawning

Per home, `spawnClock` counts down (randomized 0..interval at placement):

- On fire: retry in 1s. If `out < homes.residents` (2), spawn a person and set
  `spawnClock = interval · (1 ± jitter)`. `out` comes from `presenceCounts` —
  people anywhere other than home (waiting, riding, or on shift).
- The residents cap is the real throttle on commuter supply — a home with
  everyone out produces nothing until somebody returns.

## Weeks & upgrades (`main.js` + `ui.js`)

- `weekT` accumulates; at `weekSeconds` (60): `week++`, `upgradePending = true`,
  `+tilesPerWeek` road tiles (cap `tilesCap`).
- `upgradePending` pauses the sim and shows the modal: 2 random picks from the
  valid upgrade list (validity checked per upgrade — e.g., "Add a train"
  requires a line to exist).
- Choosing applies the upgrade, clears the flag, resumes.

Upgrade list (`ui.js` `UPGRADES`): new transit line · add a train · +3 waiting
capacity on all buildings · +2 road capacity · +12 road tiles · cargo wagon ·
+1 market truck · motorway · roundabout · traffic light.

The first motorway, roundabout, and traffic light are granted automatically
once `week >= unlockWeek` (4 — i.e. when week 3 completes), via
`*Granted`/`state.X = 1` flags in `economy.update`. After that they appear in
the weekly picks (each `ok`-gated on its grant flag and capped at 9).

## Game-over flow

Any update can set `state.gameOver = { reason, x, y }`. `main.js` shows the
card once (`gameOver.shown`), the sim halts (the `!state.gameOver` guard on
the accumulator), and "Play again" reloads the page — state is ephemeral,
there's no save or seed system.
