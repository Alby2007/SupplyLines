import { CONFIG } from './config.js';
import { spawnAgent, personDestFor, presenceCounts } from './agents.js';

const OVERFLOW_REASONS = {
  home: 'A home overflowed',
  work: 'A workplace overflowed',
  farm: 'Food rotted at a farm',
  market: 'A market overflowed',
  junction: 'A junction overflowed',
};

export function update(state, dt) {
  let foodEra = false;
  for (const b of state.buildings.values()) {
    if (b.type === 'farm' && b.active) { foodEra = true; break; }
  }

  let counts = null; // built lazily — only when a spawn check actually fires
  for (const b of state.buildings.values()) {
    if (!b.active) continue;

    if (b.type === 'home') {
      b.spawnClock -= dt;
      if (b.spawnClock <= 0) {
        b.spawnClock = 1; // retry soon — a home is capped at `residents` people out
        counts ??= presenceCounts(state);
        if ((counts.out.get(b.id) ?? 0) < CONFIG.homes.residents) {
          b.spawnClock =
            CONFIG.commuters.interval * (1 + (Math.random() * 2 - 1) * CONFIG.commuters.jitter);
          spawnAgent(state, b, 'person', personDestFor(b.color));
        }
      }
      if (foodEra) {
        b.hungerT += dt; // phase 4: food deliveries reset this
      }
      if (b.hungerT >= CONFIG.food.hungerLimit) {
        state.gameOver = { reason: 'A home starved', x: b.x, y: b.y };
        return;
      }
    }

    // workplaces demand a steady flow of workers; bigger (well-served) ones
    // demand proportionally more — Motorways' building-upgrade ratchet
    if (b.type === 'work') {
      const rate = CONFIG.demand.rate * (1 + ((b.level ?? 1) - 1) * CONFIG.demand.growth);
      b.demandT += rate * dt;
      if (b.demandT >= CONFIG.demand.limit) {
        state.gameOver = { reason: 'A workplace went understaffed', x: b.x, y: b.y };
        return;
      }
    }

    const over = b.waiting.length >= b.capacity;
    b.overflowT = over ? b.overflowT + dt : Math.max(0, b.overflowT - dt * 1.5);
    if (b.overflowT >= CONFIG.overflowLimit) {
      state.gameOver = { reason: OVERFLOW_REASONS[b.type] ?? 'A building overflowed', x: b.x, y: b.y };
      return;
    }
  }
}
