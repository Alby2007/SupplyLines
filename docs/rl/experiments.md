# Experiment log

Running record of interventions and their measured effects. Rule: a result
counts when the *mechanism* moves in the data (postmortem fields, death mix,
take-rates), not just the score.

## Baseline: the starvation diagnosis (~pre-mapgen)

24-episode evals showed starvation dominating deaths on all three maps.
Postmortems: **17/26 homes hungry while markets held ~27 stock and ~9 trucks
rolled** — production wasn't the bottleneck. `activeTrucks ≤ min(fleet,
workers)` with drivers-as-staff made it a transport/staffing problem wearing
a food costume.

## Food shaping (RL_FOODSHAPE) — WORKED

`preshape_it300` vs shaped `latest` (24 eps/map, deterministic):

| | map1 | map2 | map3 |
|---|---|---|---|
| med wk (pre→post) | 5→6 | 5→6 | 6→6 |
| max wk | 6→**9** | 7→7 | 8→7 |
| stars mean | 0.50→**1.00** | 0.71→0.92 | 1.08→1.12 |
| top death | home overflow 58% | starved 46% | starved 62% |
| → after | **starved 83%** | starved 79% | starved 96% |

The early-game failure (home overflow) collapsed 58%→4% — the policy survived
*into* the food era. Fingerprint: truck-upgrade take-rate 36%→82%. Fleet grew
25% but **active trucks barely moved** — driver cap exposed. Caveat: shaped
ckpt also had +265 iters — attribution is the shift, not all of the gain.

## Driver-cap pressure (RL_DRIVERSHAPE) — INERT, removed

Rewarded the `min(trucks, workers+1) − workers` gap. Across 235 iters:
`mktStaffed` flat 0.69 (iter-corr −0.03), `dpProxy` flat 0.58 — truck
take-rate kept rising to 85%, so it wasn't even suppressing purchases.
Why it failed: staffing is gated upstream by coverage (−0.49 corr), and
shift-end departures made half its events uncontrollable noise.

## Coverage pressure (RL_COVERSHAPE) — WEAK POSITIVE

`unassignedHomes/homes` at weight 2.5, hot-swapped onto the run at its
it-250 checkpoint (no obs change → no ckpt break). ~70 iters:
unassignedFrac 0.263 → ~0.245 and held; mktStaffed 0.71→0.73. Bought the
*marginal* coverage (one-connection-away homes), plateaued at the
structural remainder — the residual needs a mechanism, not a signal.

## Mapgen + param obs + per-episode rotation — the platform shift

gd 30→37 (one-hot → 10 map params), `--levels` = i.i.d. pool, per-episode
CONFIG restore. Partial transfer (19/20 keys, dropped only `globmlp.0`)
landed immediately: **avg 5.5 wk, max 12 on unseen generated maps at it 1**
— the first generalization evidence. 575→550 SPS — rotation ~free.

## Verb #1: `hire` market driver — RUNNING

Data-driven pick: `activeTrucks ~ week` corr **0.797** (throughput IS
survival); coverage plateau says the residual needs a lever. `hire` opens
`min(fleet, workers)` on demand. Pad-transfer kept all 20 keys (score.0
200→204). Prediction: `hiredDrv`>0 → activeTrucks/fleet↑ → starvation share
bends on coverage-poor maps. The watch-item: will the policy *discover* the
verb at ε=0.02 — or do new verbs need an exploration budget?
