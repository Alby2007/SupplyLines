# Reward shaping

Base reward per decision step: `0.02·t` (time survived) + `0.1·Δdelivered` +
`0.15·Δfreight` + action bonus. Terminal: +stars earned, −2 on death.

On top of that, potential-based terms (`reward += K·(prev − cur)` — pays on
improvement, costs on regression, immune to farming):

| term | potential | weight | flag | status |
|---|---|---|---|---|
| meter relief | max building meter past 50% | 2.0 | always on | works |
| hunger | `max(0, worst−0.4) + 0.25·mean` over homes | 3.0 | `RL_FOODSHAPE` (default on) | **verified** |
| delivery event | milkrun lands (`fedAt` stamps — couriers stamp `courierFedAt` instead, so the bypass never pays this term) | +0.3/drop | same | verified |
| coverage | `unassignedHomes / homes` | 2.5 | `RL_COVERSHAPE` (default on) | weak positive |
| ~~driver-cap~~ | `Σ(driverGap)/Σ(fleet)` | 1.5 | `RL_DRIVERSHAPE` (removed) | **inert — see below** |

## Why the food terms are shaped this way

- Hunger needs its own potential — inside the shared `max()` it competes with
  work-demand and overflow meters for one slot, so gradient only arrives when
  a home is *already* the hottest thing on the map. The 0.4 threshold starts
  the signal ~70s before the 120s limit — early enough for a dispatched
  milkrun to still arrive.
- The delivery event reward is the one term that only fires when the whole
  chain (farm→crate→market→truck→home) holds end to end.

## The postmortem-driven lessons

- **Driver-cap term (removed)** — rewarded `min(trucks, workers+1)` gaps.
  Inert across 235 iters (`mktStaffed` flat 0.69, iter-corr −0.03): staffing
  is gated upstream by home→market road coverage (−0.49 corr), not by the
  staffed-fleet ratio, and half its events were uncontrollable shift-end
  departures. Replaced by coverage pressure.
- **Coverage term** — `unassignedHomes/homes`. Moved the metric off a
  235-iter-flat 26% → ~24% in ~70 iters (with `mktStaffed` 0.71→0.73 riding
  it), then plateaued: it bought the *marginal* coverage but can't steer the
  structural work — the residual needs a mechanism, not a signal. That's the
  empirical case for the `hire` verb.
