# Analysis tooling

## `episodes.jsonl` — one line per completed episode

```json
{
  "iter": 42, "level": 107, "week": 6, "time": 371.2, "stars": 1,
  "reason": "A home starved",
  "delivered": 214, "freight": 31, "buildings": 41, "steps": 743,
  "mapp": [0.5, 0.173, 0, 1, 1, 0, 1, 0.971, 0.821, 1.02],
  "acts": {"noop": 264, "line": 172, "connect": 27, "demolish": 78, "hire": 3},
  "tilesSpent": 102, "bridgesSpent": 4, "lines": 5,
  "restored": 0,
  "food": {"homes": 26, "hungry": 17, "unassigned": 6, "markets": 6,
           "mktStaffed": 4, "mktStock": 27, "farms": 3, "farmStaffed": 2,
           "trucks": 8, "fleet": 18, "hiredDrv": 2},
  "upgrades": ["Add a train", "+1 market delivery truck"],
  "upgradeOffers": [["New transit line", "Add a train"], ...]
}
```

- `level`, `mapp` — which map + its parameter vector (per-map and
  per-parameter regressions)
- `reason` — the death taxonomy; `null` = hit the 15-min cap (also
  `truncated: true` on those records)
- `food` — the postmortem: coverage (`unassigned`), staffing (`mktStaffed`),
  stock, production (`farmStaffed`), and the capacity gap (`trucks` active
  vs `fleet`, `hiredDrv` hired drivers live at death)
- `upgradeOffers`/`upgrades` — the lottery's choices vs the policy's picks
- `acts` — action histogram per episode (actions *taken*; `actsFailed`
  splits off applies that did nothing); the collapse/emergence detector

**Run boundaries matter**: restarts reset `iter` to 1. Boundary markers are
recorded in commit messages (e.g. `episodes.jsonl` line 6675 = last
pre-coverage episode, 8882 = last pre-hire).

## `rl/eval.py` — deterministic eval on fixed seeds

`python rl/eval.py --ckpt <pt> --level <id> --episodes 24` — argmax policy
(no sampling), held-out seed base (default 10000, disjoint from train
`--seed 0`). Reports weeks min/med/max, stars, delivered, lines/tiles per ep,
death breakdown, action mix. Stars come from worker-emitted `info.stars`
(per-level thresholds automatic).

## `rl/calibrate.py` — bot baseline per map

Probes `autoplay.mjs --runs=K` per level in parallel → `calibration.json`:
bot median weeks + death causes + solvability filter + tier split. The
difficulty axis and the "is this map even winnable" check in one pass.

## Useful queries (python one-liners on episodes.jsonl)

```python
# death mix
collections.Counter(e['reason'] for e in eps)
# market staffing trend (the coverage/shaping target)
np.mean([e['food']['mktStaffed']/e['food']['markets'] for e in eps])
# delivery capacity — the survival metric (corr w/ week ≈ 0.80)
np.mean([e['food']['trucks'] for e in eps])
# truck-upgrade take rate (policy learned 36%→82% under food shaping)
```

## What "the agent learned X" requires to claim

A behavior claim needs a *mechanism* observation, not just score: the
shaping claims are backed by death-mode shifts + postmortem fields +
take-rates, which is why the verdicts can say "worked by moving the failure
frontier" rather than "score went up, maybe".
