# The action vocabulary

Up to 80 masked actions per decision across 13 verbs. `feat()` encodes each:
type one-hot, color, `costFrac`, `meter`, `wait`, `dist`, `stops`, `freight`,
`rescue`, `bridgeFrac`, `upgradeIdx`, `alt`, `demo`, `bus`.

| verb | what it does | features |
|---|---|---|
| `noop` | pass the decision | — |
| `connect` | draw road to an unserved building (≤24/step, hottest first) | color, tiles cost, meter, bridge cost |
| `connect(alt)` | a second route under congestion (`alt=1`) | same + congestion-penalty pathing |
| `roadlink` | road-to-road links | — |
| `line` | new/extend transit line or bus route (`bus=1`) | color, stops, freight/rescue flags |
| `junction` | splice a transfer into crossing tracks | color, load |
| `motorway` | elevated span (countable item) | — |
| `roundabout` | swap junction for a ring | — |
| `light` | signal a junction | — |
| `demolish` | remove spur/link/span/junction/line | `demo` subtype, tile refund |
| `upgrade` | take a lottery offer (whole action space during `upgradePending`) | `upgradeIdx` one-hot |
| **`hire`** | **pay `hireCost` tiles → +1 driver for `hireLen` s on a driver-gapped market** | color, costFrac, served-hunger meter, utilization |
| **`courier`** | **pay `courierCost` tiles → walker carries 1 crate cross-country to an unreachable same-colour home** | color, costFrac, target-hunger meter, in-flight wait, dist, radius-targets stops, rescue=1 |

## Why `hire` was verb #1

The starvation postmortem proved the ceiling: `activeTrucks ≤ min(fleet,
workers)`, fleets ~70% idle because drivers *are* market staff, and staffing
is gated upstream by home→market road coverage (~26% of homes unreachable,
flat for 500+ iters). Rewards could buy marginal coverage (+2pts) but not the
structural fix — the chain `assignment → arrival → dispatch` was unreachable
by any action. `hire` opens the `min(fleet, workers)` cap directly: on-demand
staffing for 4 tiles/shift, masked to markets with a real driver gap
(`workers + hired < trucks`). In `src/food.js`, `driversOf()` counts
commuter staff + unexpired hires for both the dispatch cap *and* the
assignment "staffed" check — a hired market is an operational market.

**Verdict (210 iters, concurrent control arm): negative.** Adoption was near-
universal (~92% of episodes) but outcomes fell on every metric vs the
coverage-era control run (wk 5.11 vs 5.64, activeTrucks 6.2 vs 7.9,
unassigned 0.33 vs 0.25) — hiring patches a *reachable* market's driver count
while the binding constraint is *unreachable* homes it can never feed. The
mechanism evidence: within-run, hire>0 vs hire=0 episodes were identical
(actT 7.1 vs 7.0) — the harm is the verb's *presence* reshaping policy
allocation (tiles+attention to staffing patches over road coverage), and the
policy began de-adopting it (2.67→2.13 hires/ep). Checkpoint snapshot:
`runs/genobs/hire_it210.pt`.

## Why `courier` is verb #2

The hire result localised the bottleneck to *reachability*: ~26-33% of homes
end with `assignedMarket === null` (no same-colour market road-reachable) and
can never be fed by any truck. `courier` attacks exactly that segment — a
paid walker who carries one crate straight-line to the hungriest same-colour
unassigned home within `courierRadius`, consuming market stock, capped at
`courierCap` in flight per market. Deliberate inefficiency keeps it a relief
valve rather than a road substitute: 1 delivery per ~2 tiles vs a truck's
6/run, and ~2 tiles/home/week to sustain an isolated home against ~18-22
tiles/week income. Implemented via the existing walk-leg machinery (an
`edgeId:null` straight-line seg at `walk.speed`), arrival feeds identically
to `milkArrive` so the delivery reward terms apply unchanged. Predicted
signature if it works: starvation share falls *while* `unassignedFrac` stays
high — the bypass signature, distinguishable from a coverage fix (both fall).

## Adding a verb (the checklist)

1. `feat` slot: `TYPE_IDX` → a free one-hot (`hire`=40, `courier`=41; 42-43
   free).
   Growing `afd` pads `score.0.weight` on `--transfer` — learned action
   preferences survive, the new verb's columns start fresh.
2. `enumerate()`: candidates + `push({type, ...feats}, apply, desc)` — masked
   by construction (only push when the action is actually legal *and useful*).
3. Sim side in `src/` — the verb changes game state like any player action.
4. Postmortem: add the metric the verb should move (hires → `food.hiredDrv`).
5. Boundary-mark `episodes.jsonl` and resume the run — `--transfer` keeps
   weights when dims moved.

## The vocabulary-ceiling hypothesis (what verbs are *for*)

Three ceilings exist: the game's optimal policy (unreachable), PPO's
exploration/credit limit (annealing), and **vocabulary exhaustion** — ~80
actions but ~12 verbs; once the meta stabilizes, training polishes execution
of a fixed strategy. New verbs multiply *strategies* but cost sample
complexity and must be *discovered* under low ε. Each verb therefore enters
one at a time against the generated-map distribution, measured factorially:
does it bend its target metric (`hire` → `activeTrucks/fleet`), and does that
move survival on the maps designed to stress it?
