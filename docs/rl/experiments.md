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

## RL_RESTORE=0.3 — frontier-restore run (LAUNCHED, it 1)

Held-out eval showed a uniform ~70-80%-of-bot play-quality ceiling with
no generalization gap — a depth deficit, not a familiarity one. Restore
(Go-Explore-lite, worker-side: 48-snap/week-boundary archive, drawn ∝
week) restarts ~30% of episodes from states the run actually reached.
Live-verified: 60/176 post-launch eps are branches (34% ≈ target),
branch points wk 2-4 deepening as the archive fills; restored branches
already extend +3-4wk past their launch week. Boundary: line 38847;
pre-restore ckpt saved as postshuttle_it190.pt.

Falsifiable read (the experiment's whole point):
- branches die near their frontier → deep-game COMPETENCE deficit
  (fix: shaping/capacity, the game is deep enough already)
- branches push wk 10+ → visitation deficit (restore is the fix;
  max-week should climb as the archive self-advances)

## RL_RESTORE verdict + verb #4 `reconnect` + difficulty rebalance

Restore diagnostic RESOLVED at ~it 200 (2175 branches): extension-at-depth
flat (+0.5wk) across ~1100 deep launches; launch-5 extension q-over-q
+0.69/+0.75/+0.71/+0.68; deep-branch death mix identical to fresh
(starved 53%/understaffed 42%). Not OOD, not learnable-by-reps — a
pressure-throughput equilibrium: simultaneous crises outscale the ~2
useful actions/step + linear tile budget. Deep-branch act mix: noop→0%,
line 62%, demolish 27% — fully subscribed treadmill of low-yield verbs.

Verb #4 `reconnect` (slot 43): the stranded-component class connect's
mask can't see — buildings ON a road yet service-disconnected (unassigned
homes on market-less components; understaffed works on worker-less
components). One action routes a Dijkstra to the *serving* component
(market comps for homes, eligible-home comps for understaffed) —
permanent fix, the only verb class that amortizes over crisis count.
Verified live: cand offered → whole bridge built in one action → home
assigned → cand gone. Gate: RL_RECONNECT=0.

Difficulty rebalance ("pace" preset): intervalMin ×1.375 (8→11s),
subdivision.every ×1.3 (130→169s), tilesPerWeek ×1.15 — slows the
quadratic crisis growth, adds structural headroom. Env multipliers
preserve per-level variation; autoplay --tune=path=*factor matches.
Boundary: line 48834; pre-change ckpt restore_it290.pt.

## Era-end eval: reconpace_it205 (native pace + old-difficulty transfer)

Held-out sweep, 10 levels × 8 eps, greedy argmax, bot re-baselined
under identical tuning.

- Native pace difficulty: mean 6.0wk vs bot ~7.5 (80%); bot-median
  parity on 5/10 levels (L1, L3, 124, 140, 148) — first era with any
  parity results. Residual gap concentrates on 145/146/150, all
  understaffed-dominated deaths.
- Old difficulty (pure transfer): mean 5.45 vs eval_latest 5.50 —
  within noise. The +1.4wk training-mix lift was environment easing,
  not capability growth. Reconnect's matched-subset lift (+0.9wk on
  stranded states) is real but small in aggregate.
- Reconnect adoption: ~22% of eps, retained through era end; users
  outlive matched non-users by +0.3-0.9wk (self-selecting into harder
  stranded states — conservative estimate).

Conclusion: policy skill is ~flat on the original game; the agent can
reach a ceiling when the game permits one, but cannot raise the
ceiling itself.

## Commuter-rate probe (RL_COMMUTER=0.75) — verdict

~1800 eps: understaffed deaths 48% → 37-39% and stable across
quartiles; weeks flat (~6.4). Confirms worker *supply rate* is a real
causal bottleneck — but relief rotates into starvation (50%) rather
than buying survival. Single-link fixes cannot lift the equilibrium:
two links alternate as the binding constraint. The plateau is
pressure-curve geometry, not missing vocabulary.

Trainer killed by HSA_STATUS_ERROR_EXCEPTION at ~it 35 (GPU fault);
rl/supervise.sh watchdog added — relaunches on any exit with
backoff + crash-loop bound, verified by kill test. Boundary 60290;
ckpt commuter_it80.pt.

## Ceiling-climb: "calm" preset — the deep-regime experiment

Question: is a learnable deep regime reachable by tuning, before
building deeper mechanics? Bot calibration across 3 doses showed
arrival-rate easing saturates via bottleneck rotation (median stuck
~9-12). Winning dose adds severity-axis fuse length:

  RL_SPAWNFLOOR=2 RL_TRACTEVERY=2 RL_TILESWK=1.5 RL_COMMUTER=0.7
  RL_HUNGERLIMIT=1.4 RL_DEMANDLIMIT=1.4 RL_RESTORE=0.3

Bot under calm: L1 med 11/max 14, L140 med 13/max 17, L150 med 10/max
14 — deep regime exists (variance widened; tail reaches 14-17).
New tuners: RL_DEMANDLIMIT, RL_HUNGERLIMIT, RL_COMMUTER.

Falsifiable read at ~it 100:
- agent max week climbs toward 14+ → deep competence exists →
  prosperity-gated growth is justified as the next mechanic
- agent plateaus ~8 while bot reaches 17 → policy-side deficit even
  under a reachable ceiling → fix capability before mechanics

Boundary: line 62013; pre-calm ckpt commuter_it80.pt.

## NaN checkpoint poisoning — incident + guards

Calm launch hit a crash loop: giant policy-loss spikes (~4.6e9)
overflowed the PPO ratio exp() to inf → NaN grads → NaN weights →
saved into latest.pt → every resume died in ~12s. Supervisor correctly
gave up after 5 fast crashes. Root cause chain found by scanning
state_dicts for non-finite tensors.

Guards added in train.py: log-ratio clamp ±20 (exp overflow), skip
minibatches with non-finite loss or grad-norm (counted as `nskip`),
refuse to save latest.pt when weights are non-finite, refuse to load
a poisoned ckpt at startup. Recovered by restoring commuter_it80.pt.

## Value-head normalization — root cause of the entropy collapse

Calm run diverged at ~it 15: vl exploded 2.4e6, ent collapsed to
0.000, pl spikes ~7e5 — yet weeks held ~10.4 (policy coasting on
old skill while learning died). Cause: advantages are z-normalized
but RETURNS were regressed raw — the calm preset roughly doubled
episode length, shifting the return distribution off the v-head's
trained scale; vf·vloss dominated the 0.5-norm clipped gradient and
dragged the policy head into saturation. The pl spikes across ALL
prior eras (up to 1.6e12) were early symptoms of the same scale bug.

First fix (live per-batch normalizer) blew up exponentially —
rsd 23→1.2e12 in 20 iters: de-normalizing v by a sigma measured
from returns built from de-normalized v is a √T-gain feedback loop.

Correct fix: FREEZE ret mu/sd at the first batch — a constant
de-normalizer cannot amplify. Result: rsd pinned 25.3, vl 393→0.2,
pl 7e5→0.004, ent 0.472 alive, weeks 8-9 and LEARNING (not coasting).
v now predicts z-scored returns, de-normalized at both GAE
consumption points (b_val during rollout, nextv bootstrap).
Restarted from clean commuter_it80.pt.

## Full-stack bug audit (post-NaN-incident sweep)

Systematic read of train/rollout/model/vexp/env_worker/eval.

Fixed:
- enumerate() could return an EMPTY mask: upgradePending with zero
  eligible upgrades early-returned [] — all-False mask → np.random.choice
  crash on eps-forced picks (and uniform-over-invalid sampling on the
  main path). Now falls through to normal enumeration.
- np.empty → np.zeros in _pack/eval-pack: under-sent channels would
  ship uninitialized host memory as obs.
- eval.py now refuses non-finite checkpoints (parity with train.py).
- eps-greedy guards empty masks at the consumer too (defense in depth).

Verified correct: GAE done-mask/nextv/step alignment; mask -1e9 → exact
0-prob sampling; v shape (B,) no broadcast; group/obs concat order;
pending-acts↔feat index alignment; all pushed types in TYPE_IDX;
--tune *factor ≡ worker RL_* multipliers; deterministic srand/reseed;
noop last-slot guarantee (normal path always ≥1 act); obs canvas ≥ all
pool maps (80×32 cap); supervise.sh backoff/bounds.

Noted, deliberately kept: f16bits maps NaN→65504 (wire-safe but hides
upstream NaN sources); eps-greedy stores π logp not mixture logp
(small IS bias at eps=0.02, standard practice); deepClone assumes
plain-object state (fragile if classes ever enter game state);
supervise relaunches clean exits too (intended keep-alive semantics).

## Ceiling-climb VERDICT: deep competence exists (~95% bot parity under calm)

calmfrozen_it480 held-out eval (10 levels × 8 eps, argmax, calm
preset): mean 10.4wk, med-of-meds 11.2, cap-survivals on 6/10 levels.
At/above calm-bot band on ~8/10; above on L1/L146/L150. Weak maps
(135/140/145) are the usual starvation↔understaffing rotation, not a
skill wall. vs eval_latest 5.50 (73%) and reconpace 6.00 (80%).

Two caveats: (1) the checkpoint is entropy-saturated — it reached
argmax strength partly via divergence-luck, not deliberate training;
reproducible stable path to this strength unproven. (2) Calm env did
heavy lifting — same policy class scores 5.45 native.

Stable-trainer work landed along the way: KL early-stop (the missing
canonical guard — caps per-iteration policy movement), frozen return
normalizer, emb-detached critic, huber value loss, nskip/NaN-save/
NaN-load guards. Together they converted explosion into erosion —
the run diverges slowly now instead of dying.

Design consequence: the agent exploits a deep regime when the game
provides one — the sampled-vs-argmax gap (~3wk) hid most of its
ability. Mechanics that raise the NATIVE ceiling (prosperity-gated
growth, bounded threats) are now evidence-justified.

## T0+T1: calm-native difficulty + freight-linked budget — VERDICT: works

First ceiling-raising mechanics landed: T0 = the calm preset adopted as
the research-native tuning (env multipliers, unchanged); T1 = endogenous
budget — `CONFIG.roads.freightTiles = 0.25`, each weekly crate earns
bonus road tiles (autoplay.mjs + main.js week rollover, RL_FREIGHTTILES
env gate for ablation). Design intent: capability ∝ throughput, so the
pressure race is winnable by play rather than lost to the calendar.

Run: commuter_it80 lineage, calm env + T1 live, 33-map train pool.
Converged to another saturated artifact (entropy drained ~it 300-500 —
the slow-march failure mode persists under klstop, just slower), but
T1-aware this time: sampled del climbed 355→704/ep (≈58 crates/wk)
while learning — the freight-economy fingerprint.

Held-out eval, t1frozen_it540 vs calmfrozen_it480 (argmax, 8 eps/lv,
calm+T1): mean 11.3 vs 10.4 · med-of-meds 13 vs 12 · cap-survivals
19 on 8/10 levels vs 12 on 6/10 · median wins 7 / losses 2 / tie 1.
Gains concentrate exactly on the prior gap maps: L140 +5 med, L135 +2,
L148 +3 with 4 survivals. L145 the sole holdout (9/8.4, understaffed-
dominated). L2/L150 regressed ~2-3 (n=8, could be seed variance).
New minor failure signature: 'Food rotted at a farm' on 4 levels —
freight-heavy play can glut farm output.

Read: the endogenous-budget loop measurably buys deep-regime capacity
on held-out maps — evidence for the feedback-loop design pattern
(T2 prosperity-gated growth is the next candidate on the same principle;
T3 worker demographics attacks the residual understaffing wall).
Trainer stability remains the open problem: two strong artifacts now,
both reached via saturation rather than a reproducible stable climb.
