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

## Verb #2: `courier` — NET POSITIVE (bypass signature confirmed)

2-tile cross-country walker feeding one unassigned home. Retuned
(radius 24, any-color, survive-the-walk) after geometry showed the
tight mask reached ~15% of the target class. Adopted 10%→83% of eps,
~3.7 dispatches/ep at ~100% delivery. Matched lift +0.6wk on feasible
episodes, replicated ~9000 eps. Starvation share bent below 50% while
un% rose (accumulation, not decay — surviving clients). Frontier moved
to understaffing. Organic hire→courier tile reallocation observed.

## Verb #3: `shuttle` worker escort — ADOPTED BUT INERT (retired)

Worker-side courier analog: escort home→work, arrive() parity. 92-94%
adoption from it 1 (inherited score prior), ~3.3 disp/ep. Target metric
never moved: understaffed% flat 30-37% across 115 iters. Cause:
relief-per-dispatch asymmetry — 1 courier feed ≈ 120s survival, 1
escort ≈ 24s demandT delay. A save beats a delay. Cannibalized courier
(2.26→1.78/ep). Retired via RL_SHUTTLE gate (impl preserved).
Verdict: relief-valve verbs only work when the dispatch is a save.

## Held-out eval — first non-training-mix measurement

eval_sweep.py: 3 era ckpts × maps 1-3 + 7 held-out gen levels × 8 eps,
greedy argmax, disjoint seeds. hire_it210 scored under RL_COURIER=0.

  level   bot(med)  hire210  cour335  latest
  L1        8        5.0      5.2      5.5
  L2        8        5.6      6.0      6.4
  L3        8        6.2      5.5      6.8
  124 e     9        5.8      5.4      5.4
  135       6        5.6      4.9      6.0
  140       7        5.0      5.9      5.1
  145       5        4.2      4.6      4.2
  146       7        4.8      4.9      4.8
  148       7        5.2      5.1      5.8
  150       6        4.6      3.9      5.0
  mean     ~7       5.20     5.14     5.50

Findings:
- NO generalization gap: held-out ≈ training-mix weeks (~5.2). The
  policy generalizes; it does not memorize.
- Uniform ~70-80% of bot on every map — a skill-ceiling gap, not a
  map-familiarity gap. No ckpt reaches bot median anywhere.
- eval_latest ≥ both eras (wins/ties 9/10 vs hire, 7/10 vs courier).
  Verb-era training didn't hurt transfer; may have helped slightly.
- Courier's training-mix lift did NOT translate to a clear held-out
  advantage — era deltas are within noise at n=8. The verbs moved
  death-cause mix, not the survival ceiling.
- Held-out death mix ≈ training mix (starved ~50%, understaffed
  ~25-30%); the bottleneck structure itself generalizes.

Implication: the plateau is a play-quality ceiling, not a coverage or
observability one. Next levers target depth: RL_RESTORE exploration,
structural reachability verbs, or reward shaping — not more relief.
