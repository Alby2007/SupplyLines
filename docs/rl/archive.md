# Frontier-state restoration (`RL_RESTORE`, dormant)

A Go-Explore-lite archive: each worker snapshots `state` at every week
boundary (`deepClone` — Map/Set/Array/plain-object recursion; agent `dest`
matcher closures share by reference since they only capture immutable ids,
which is what `structuredClone` can't do). `ARCHIVE_CAP=48`, weighted pick
`∝ week` — the frontier dominates but early states stay reachable.

## Why it's feasible here (most envs can't do this)

- **No wall-clock in the sim** — `performance.now` lives only in the render
  loop; sim time is pure ticks → deterministic replay
- **All state is inside `state`** — path caches live *on* state objects
  (`netVersion`-keyed), clone captures them intact
- **Everything is id-referenced** — no live cross-references that delink
- **`srand` is mulberry32** — a uint32; reseeding fresh on a restore is what
  makes the branch *diverge* instead of replay

## Mechanics (`env_worker.mjs`)

`RL_RESTORE=p` — probability a reset restores instead of starting cold. The
restored episode **runs at the snapshot's level** (`setLevel(snap.level)` —
required under per-episode level rotation, else CONFIG mismatches). The
episode record stamps `restored: <srcWeek>` so analysis knows the branch
point. Restore is weight-agnostic — the trainer sees an ordinary episode
that begins mid-game (same trick warm-start plays, except the states are
the agent's own best rather than the bot's).

## Why it's queued, not live

Attribution hygiene: it entered after food-shaping was already the live
experiment, and two concurrent interventions can't be told apart. It was
the next lever behind coverage-shaping → then the hire verb took the slot.
Flipping it is one env var on a restart (`RL_RESTORE=0.5` suggested, keeping
cold resets in the mix).

## The open research question it probes

Warm-start proved the *mechanism* — episodes starting mid-game teach states
the policy can't reach from week 0. Restoration upgrades that from the bot's
canned prefixes to the policy's own frontier: does branching from reachable
good-states beat re-rolling from scratch? The known tradeoff: the critic
trains on states the policy can't yet reach — eval-from-scratch can dip
while deep play improves, which is why it's measured on the fixed-seed eval
protocol, not training-mix numbers.
