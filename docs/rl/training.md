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

## Restarting a run (learned the hard way — twice)

`nohup python train.py & echo $!` reports the **launcher** pid, not the
trainer — the python process is `$!+1` (or find it: `pgrep -f "train.py.*cuda"`).
Killing the launcher leaves the trainer alive: it keeps writing
`latest.pt`/`episodes.jsonl` and silently forks the experiment into two
interleaved runs (this happened twice — caught by out-of-order `it N`
lines in the log and halved SPS). On restart: kill the **python** pid,
verify `pgrep -f "train.py.*cuda"` is empty *and* `pgrep env_worker` drains
(workers die on stdin EOF), snapshot `latest.pt` under a run-boundary name,
then record `wc -l episodes.jsonl` as the boundary line.

## Model

`ActorCritic`: 3× Conv(GemmConv) → LazyLinear(256) ‖ glob MLP(64) →
fuse(emb=160) → `score` pointer head (emb+afd → 1 per action) + `value`.

`GemmConv2d` replaces `nn.Conv2d` with one batched GEMM (2.2× on the
minibatch-512 update; MIOpen's weight-grad solver segfaults on this GPU —
`RL_MIOPEN=1` opts back in, `RL_NATIVE_CONV=1` uses plain convs).

## Stability guards (each one learned from a dead run)

The full stack that keeps PPO from eating itself — every guard maps to a
failure observed in the wild:

- **log-ratio clamp ±20** — an extreme minibatch ratio `exp(logp−old)` once
  overflowed to inf → NaN grads → NaN weights → `torch.save` persisted the
  poison → every resume crashed in 12s (the "ROCm ghost" era).
- **nskip** — minibatches with non-finite loss or grad-norm are skipped and
  counted in the log line.
- **save/load NaN guards** — `latest.pt` won't be written with non-finite
  params; `--ckpt` load refuses poisoned tensors and says to restore a
  snapshot.
- **frozen return normalizer** — the v-head regresses z-scored returns;
  σ/μ freeze from the first batch. A *live* normalizer fed σ back into
  returns built from de-normalized `v` — loop gain √T, `rsd` went
  23→1.2e12 in 20 iters.
- **`emb.detach()` critic** — `self.value(emb.detach())`: TD divergence
  (bootstrapped v chasing its own drift) used to ride the shared gradient
  into the trunk and saturate logits (`ent`→0 twice). Detached, worst case
  is a bad critic — never a corrupted actor.
- **Huber value loss** — `smooth_l1_loss` bounds outlier gradients on the
  critic's own weights.
- **KL early-stop (0.03)** — the canonical guard that was missing longest:
  without it a few bad minibatches move the policy far inside an epoch, and
  the ±20 clamp then *masks* exactly the samples that should supply PPO's
  braking signal. `klstop` in the log = the brake fired that iteration.

Together they converted explosion into **erosion**: runs no longer crash —
they converge slowly toward deterministic saturation (`ent`→0 over
~300-500 iters) instead. Frozen-argmax checkpoints are genuinely strong
(argmax play outscores sampled by ~3wk — the sampled-vs-argmax gap hid the
policy's real ability), but a reproducible *stable climb* is still the open
trainer problem.

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

## Trainer watchdog — rl/supervise.sh

train.py can die silently (GPU faults, OOM) and sit dead for hours.
supervise.sh wraps the launch: relaunches on ANY exit, sleeps 30s after
long runs, backs off linearly on <5min crashes, gives up after 5 fast
crashes. Launch/exit history in runs/supervise.<tag>.log.

  RL_*=… nohup ./supervise.sh genobs --envs 8 ... --ckpt runs/genobs/latest.pt &

Verified: kill -TERM trainer → logged rc=143, relaunched in 60s, strict
resume from latest.pt. The python pid is the supervisor's CHILD — kill
the wrapper too when stopping deliberately (pkill -f supervise.sh).
