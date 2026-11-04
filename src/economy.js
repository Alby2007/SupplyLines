import { CONFIG } from './config.js';
import { spawnAgent, personDestFor, presenceCounts } from './agents.js';

const OVERFLOW_REASONS = {
  home: 'A home overflowed',
  work: 'A workplace overflowed',
  farm: 'Food rotted at a farm',
  market: 'A market overflowed',
  junction: 'A junction overflowed',
};

// 0–3 stars from the survival thresholds — the week you *reached* counts,
// so dying mid-week-5 still earns a threshold-5 star
export function starsEarned(state) {
  return (CONFIG.win?.stars ?? []).filter((w) => state.week >= w).length;
}

// weekly rush hour — where in the week the surge sits. `active` inside the
// window; `in` counts seconds to the next one's start (0 while active).
// Fixed weekT offset → the same wall-clock point every week, which is what
// makes it preparable: the week bar telegraphs it, networks get over-built.
export function rushStatus(state) {
  const R = CONFIG.rush;
  if (!R?.mul) return { active: false, in: Infinity };
  const WS = CONFIG.weekSeconds;
  const s = R.at * WS, e = s + R.len;
  if (state.week >= R.firstWeek && state.weekT >= s && state.weekT < e) {
    return { active: true, in: 0 };
  }
  const tw = state.week < R.firstWeek ? R.firstWeek
    : state.weekT >= e ? state.week + 1 : state.week;
  return { active: false, in: (tw - state.week) * WS + s - state.weekT };
}

// how jammed a building's frontage is: the densest edge at its road node,
// 0..1. Unconnected buildings read 0 — they're stranded, not stressed.
export function servingStress(state, b) {
  const n = b.roadNodeId != null ? state.roadNodes.get(b.roadNodeId) : null;
  if (!n) return 0;
  const cap = CONFIG.roads.maxPerEdge + (state.roadCapBonus || 0);
  let s = 0;
  for (const eid of n.edges) {
    const e = state.roadEdges.get(eid);
    if (e) s = Math.max(s, e.vehicles.size / Math.max(1, cap));
  }
  return Math.min(1, s);
}

export function update(state, dt, rng = Math.random) {
  // the first motorway and roundabout arrive once week 3 is done — more come
  // from weekly picks (MM: they're the upgrade-menu road tools)
  if (!state.motorwayGranted && state.week >= CONFIG.motorways.unlockWeek) {
    state.motorwayGranted = true;
    state.motorways = 1;
  }
  if (!state.roundaboutGranted && state.week >= CONFIG.roundabouts.unlockWeek) {
    state.roundaboutGranted = true;
    state.roundabouts = 1;
  }
  if (!state.trafficLightGranted && state.week >= CONFIG.trafficLights.unlockWeek) {
    state.trafficLightGranted = true;
    state.trafficLights = 1;
  }
  // Map 3's river kit: a bundle is gifted once week 1 is done — on top of the
  // weekly pick (the section only exists on maps that define it)
  if (CONFIG.bridges && !state.bridgesGranted && state.week >= CONFIG.bridges.unlockWeek) {
    state.bridgesGranted = true;
    state.bridges = CONFIG.bridges.grant;
  }

  let foodEra = false;
  for (const b of state.buildings.values()) {
    if (b.type === 'farm' && b.active) { foodEra = true; break; }
  }

  let counts = null; // built lazily — only when a spawn check actually fires
  // inside the rush window every home's commuter clock runs fast — the surge
  // compresses existing clocks toward a synchronized burst, not a faster drip
  const rush = rushStatus(state).active ? CONFIG.rush.mul : 1;
  for (const b of state.buildings.values()) {
    if (!b.active) continue;

    if (b.type === 'home') {
      b.spawnClock -= dt * rush;
      if (b.spawnClock <= 0) {
        b.spawnClock = 1; // retry soon — a home is capped at `residents` people out
        counts ??= presenceCounts(state);
        if ((counts.out.get(b.id) ?? 0) < CONFIG.homes.residents + (b.resBonus ?? 0)) {
          b.spawnClock =
            CONFIG.commuters.interval * (1 + (rng() * 2 - 1) * CONFIG.commuters.jitter);
          spawnAgent(state, b, 'person', personDestFor(b.color));
        }
      }
      if (foodEra) {
        // congestion stress: a home fronted by saturated edges goes hungry
        // faster — the jam is its own kind of starvation, not just a delay
        b.hungerT += dt * (1 + CONFIG.stress.gain * servingStress(state, b));
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
      // same stress rule as homes: a work whose frontage jams needs relief —
      // a bypass that frees it is worth real demand headroom
      b.demandT += rate * dt * (1 + CONFIG.stress.gain * servingStress(state, b));
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
