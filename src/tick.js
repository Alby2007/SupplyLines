// The one game tick — shared by the browser loop (main.js) and the headless
// drivers (autoplay.mjs → rl/env_worker.mjs) so game-logic changes land in
// one place instead of two mirrored copies. `opts` is how headless callers
// bolt on their env flags; every hook is optional:
//   opts.freightRate() → weekly bonus-tiles-per-crate rate override
//                        (null/undefined → CONFIG.roads.freightTiles)
//   opts.skip(name)    → true skips that subsystem's update this tick
//   opts.phase(state, name) → called before each subsystem's update
//   opts.rng           → seeded draw function (default Math.random); headless
//                        drivers pass srand(seed) instead of monkeypatching
//                        the global so episodes stay reproducible
import { CONFIG } from './config.js';
import * as spawn from './spawn.js';
import * as economy from './economy.js';
import * as food from './food.js';
import * as agents from './agents.js';
import * as vehicles from './vehicles.js';

const PHASES = [
  ['spawn', spawn],
  ['economy', economy],
  ['food', food],
  ['agents', agents],
  ['vehicles', vehicles],
];

export function tick(state, dt, opts = null) {
  const rng = opts?.rng ?? Math.random;
  state.time += dt;
  state.weekT += dt;
  if (state.weekT >= CONFIG.weekSeconds) {
    state.weekT = 0;
    state.week++;
    state.upgradePending = true;
    // freight-linked budget: crates delivered that week earn bonus tiles on
    // top of the flat tilesPerWeek grant
    const frate = opts?.freightRate?.() ?? (CONFIG.roads.freightTiles ?? 0);
    const fDelta = state.freightDelivered - (state.freightWeek0 ?? 0);
    state.roadTiles = Math.min(CONFIG.roads.tilesCap,
      state.roadTiles + CONFIG.roads.tilesPerWeek + frate * fDelta);
    state.freightWeek0 = state.freightDelivered;
  }
  for (const [name, mod] of PHASES) {
    if (opts?.skip?.(name)) continue;
    opts?.phase?.(state, name);
    mod.update(state, dt, rng);
  }
}
