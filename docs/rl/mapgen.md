# Procedural map generation (`src/mapgen.js`, `src/genmaps.mjs`)

Generated maps are ordinary `CONFIG.levels` entries — concrete defs (absolute
water cells / river params resolved at emit time), merged onto base CONFIG the
same way hand maps are. A level's ID *is* its seed:
`levelDefForSeed(101)` fully reproduces level 101.

## Knobs

| knob | range | hand-map anchor |
|---|---|---|
| `map.width` | 40 / 56 / 80 cells (height fixed 32) | L1=40, L2/3=80 |
| water | none ~35% / blob ~35% / river ~30% | L1 none, L2 blob, L3 river |
| `spawn.seedBias` | none / left / right | L3=right |
| `bridges` | **river ⟹ granted** (else unsolvable) | L3 only |
| `spawn.intervalStart` | 11–14 s | 14 base |
| `food.hungerLimit` | 100–140 s | 120 base |
| `demand.rate` | 0.9–1.15 | 1.0 base |
| `win.stars` | `[5,8,11]`; hard combos may get `[4,7,10]` | L3 softer |

Wide maps (>40 cols) automatically get the distance-compensation road package
(`carSpeed 110, tilesStart 50, tilesPerWeek 22` — map size, not theme).
`blobCells` emits the same offset-cell list format Map 2's oasis uses.

## The frozen suite

`node src/genmaps.mjs --n=50 --start=101` → `src/genlevels.js` (committed,
diffable) → `config.js` spreads it into `CONFIG.levels`. Browser, autoplayer,
and env workers all see gen levels uniformly.

## Calibration (`rl/calibrate.py`)

Bot-probes every level (`autoplay.mjs --runs=K` each, parallel) →
`rl/calibration.json`: median weeks, death causes, tier, and a stratified
train/held-out split.

Current suite (50 maps): **0 broken**, 1 hard (L113, bot-med 4), 44 medium
(5–8), 5 easy (9) — brackets the hand maps' ~9-week bot baseline.

- **Train pool**: `calibration.json → train` (33 maps, tier-stratified)
- **Held-out**: 17 gen maps + the 3 hand maps (the human-designed
  generalization test)

## Regeneration discipline

Broken seeds (bot median <3) get *replaced*, not debugged — bump the seed and
re-emit. The suite is a benchmark artifact; its contents must stay frozen
once runs reference it (regenerate to a new ID range if it needs to change).
