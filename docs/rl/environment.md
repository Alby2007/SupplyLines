# The environment (`rl/env_worker.mjs` ↔ `rl/vexp.py`)

Each worker is a Node process running the unmodified sim at 60 ticks/s. The
agent decides at `DECIDE_DT = 0.5s` sim cadence; an episode ends on game-over
or the `MAX_SECONDS = 15min` cap (truncation).

## Wire protocol

Length-prefixed binary frames over stdio (replaced base64 JSON — the big SPS
win). `{"cmd":"reset","seed":n,"warm":s}` / `{"cmd":"step","a":i}` /
`{"cmd":"close"}` in; per call a frame out:

```
header: 5 × u32 LE = [meta, bin, con, glob, feats] byte lengths
meta:   JSON {reward, done, info, desc?}
bin:    bitpacked binary obs channels   (nbin × rows × cols bits)
con:    f16 continuous obs channels     (ncon × rows × cols)
glob:   f32 global vector               (gd floats)
feats:  f16 action feature matrix       (n_actions × afd)
```

Python side: `EnvWorker` spawns/frames; `VecEnv` batches N workers, splits
them into `n_groups` for double-buffered rollouts (one group sims while the
other's batch is decoded/scored — see `rl/rollout.py`).

## Observation

Grid is padded to a fixed **80×32** canvas so mixed-size maps batch
(`OBSCOLS = max(cols, 80)`). 25 channels: buildings by type/color, road
edges, lines, water, vehicles, waiting queues, per-building meters, hunger —
the full playable state, no hidden info except tract placement.

`gd = 37` globals: week/time, road tiles, vehicle/item counts, delivered,
freight, entity counts, farm-era flag, upgrade-pending flag, aggregate
wait/meter/rush/subdivision pressure, crate + truck fleet aggregates — and,
at positions **16–25** (where the level one-hot used to be), the **10 map
parameters** from `mapParams()`:

`cols/80, waterFrac, isBlob, isRiver, biasLeft, biasRight, hasBridges,
intervalStart/14, hungerLimit/140, demandRate`

Reading terrain/difficulty as features lets one policy share strategy across
a map distribution instead of memorizing three layouts.

## Action space

Up to `MAXA=80` enumerated, masked actions per step; `afd=44` features each
(type one-hot, color, cost fractions, meters, distances, subtype flags —
layout in `feat()`, slots 41-43 reserved for future verbs). Twelve verbs:
`noop, connect, roadlink, line, motorway, roundabout, light, upgrade,
demolish, junction, hire` (+ `bus` as a line subtype). See
[verbs.md](verbs.md).

During `upgradePending` the action space is *just* the upgrade lottery —
same two-offer process the human sees.

## Level handling

`--level` accepts a pool (`"1,2,3"` or gen IDs): each `reset` i.i.d.-samples
one level. `applyLevelOverrides` merges a level's CONFIG sections one-way, so
`doReset` first restores the boot-time `CONFIG_BASE` clone, then applies the
episode's level — without this, one map's `roads`/`water` would bleed into
the next episode's.
