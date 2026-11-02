# Training (`rl/train.py`, `rl/model.py`, `rl/rollout.py`)

PPO over a masked pointer head: CNN over the grid + MLP over globals → shared
embedding; each enumerated action carries a feature vector scored against the
embedding (action count varies per step). Critic reads the same embedding.

## Reference command

```sh
python train.py --envs 8 --levels <pool> --iters 2000 --tsteps 2048 \
  --minibatch 512 --ent 0.012 --gamma 0.999 --eps 0.09 --epsdecay 0.995 \
  --warmstart 20 --warmdecay 0.99 --groups 4 --tag <run> --device cuda
```

- `--levels` — comma pool; each worker i.i.d.-samples a level per reset
- `--warmstart` — max seconds of bot pre-play per episode (annealed by
  `--warmdecay`/iter); 25% of resets stay cold. Teaches week-5+ states
  from iteration 1 — a crude Go-Explore (the real one is in [archive.md](archive.md))
- `--eps` / `--epsend` / `--epsdecay` — ε-greedy exploration floor + decay
- `--groups` — env groups for double-buffered rollouts (4 measured best)
- `--transfer` — resume a checkpoint across shape changes: loads
  shape-matching keys, **pad-loads** wider-input layers (the learned slice
  is copied, new columns start fresh — e.g. `score.0 (96,200)->(96,204)`
  when `afd` grew for the hire verb)

Checkpoints: `rl/runs/<tag>/latest.pt` every iter; episodes stream to
`rl/runs/<tag>/episodes.jsonl`.

## Model

`ActorCritic`: 3× Conv(GemmConv) → LazyLinear(256) ‖ glob MLP(64) →
fuse(emb=160) → `score` pointer head (emb+afd → 1 per action) + `value`.

`GemmConv2d` replaces `nn.Conv2d` with one batched GEMM (2.2× on the
minibatch-512 update; MIOpen's weight-grad solver segfaults on this GPU —
`RL_MIOPEN=1` opts back in, `RL_NATIVE_CONV=1` uses plain convs).

## Throughput history (steps/sec, measured)

| change | SPS |
|---|---|
| serial JSON+base64 baseline | ~230 |
| concurrent env stepping (`0d2f6ae`) | ~374 |
| GemmConv + GPU-resident buffers + fp16 obs (`c13b587`) | ~597 |
| binary wire protocol (`3105075`) | ~635 |
| + double-buffered groups=4 (`3105075`) | ~700-715 |
| gen-map run (per-episode setLevel) | ~550-590 |

The pipeline stays near that ceiling: per-episode `setLevel` costs ~ms.
