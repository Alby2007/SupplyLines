# Reinforcement learning (`rl/`)

A PPO agent learns to play the real game headlessly: Node workers run the
actual sim on CPU (`rl/env_worker.mjs`), a PyTorch actor-critic trains on GPU
(`rl/train.py`), and the heuristic autoplayer (`autoplay.mjs`) is both the
warm-start curriculum and the calibrated baseline.

## Quick start

```sh
# train on the generated-map pool (resumes checkpoints automatically by tag)
python rl/train.py --envs 8 --levels 101,105,112 --iters 2000 \
  --tag myrun --device cuda

# resume a differently-shaped run (new obs/action dims) keeping learned weights
python rl/train.py --ckpt rl/runs/foodobs/latest.pt --transfer ...

# evaluate on held-out seeds
python rl/eval.py --ckpt rl/runs/genobs/latest.pt --level 3 --episodes 24

# calibrate generated maps with the bot
python rl/calibrate.py --levels 101-150 --runs 8 --procs 10
```

Python env: `/home/alby/ml/venv` (torch ROCm — `torch.cuda.is_available()` is
the GPU path even on AMD). Node: `~/.local/node/bin/node`.

## Contents

- [environment.md](environment.md) — worker protocol, observation encoding, action space
- [training.md](training.md) — PPO config, curriculum, checkpoints, throughput
- [shaping.md](shaping.md) — every reward term, its env flag, and its measured effect
- [mapgen.md](mapgen.md) — the generator, the frozen suite, calibration + tiers
- [verbs.md](verbs.md) — the action vocabulary and the verb-expansion program
- [analysis.md](analysis.md) — `episodes.jsonl` schema, postmortems, eval tooling
- [experiments.md](experiments.md) — the empirical log: what was tried, what moved, what didn't
- [archive.md](archive.md) — frontier-state restoration (Go-Explore-lite, dormant)

## The project in one paragraph

The agent plays the full game — not a proxy: the same tick loop, the same
death rules, the same upgrade lottery. It sees a 25-channel grid + global
feature vector, picks one masked action every 0.5 sim-seconds, and trains on
a **distribution of generated maps** rather than the three hand-made ones —
the maps are the measurement instrument for whether learned strategy
generalizes. The research question underneath: does the agent's skill have a
ceiling because its action vocabulary is exhausted, and can richer verbs (the
first: `hire`, an on-demand market driver) keep discovery going?
