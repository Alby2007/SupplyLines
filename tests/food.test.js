import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createState } from '../src/state.js';
import { buildRoad } from '../src/roads.js';
import { cellOf, cellsBetween } from '../src/grid.js';
import { personDestFor } from '../src/agents.js';

// draw a road between two world points as a contiguous cell path
function road(s, a, bPt) {
  return buildRoad(s, cellsBetween(cellOf(a), cellOf(bPt)));
}
import * as spawn from '../src/spawn.js';
import * as economy from '../src/economy.js';
import * as food from '../src/food.js';
import * as agents from '../src/agents.js';
import * as vehicles from '../src/vehicles.js';

function b(state, id, type, x, y, extra = {}) {
  state.buildings.set(id, {
    id, type, x, y, active: true, waiting: [], capacity: 6, overflowT: 0,
    spawnClock: 2, workers: [], stock: 0, hungerT: 0, produceClock: 0,
    assignedMarket: null, marketDist: Infinity,
    trucks: CONFIG.food.marketTrucksStart, activeTrucks: 0, dispatchT: 0, fedAt: 0,
    ...extra,
  });
  return state.buildings.get(id);
}

function runTicks(state, seconds, dt = 1 / 60) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    state.time += dt;
    economy.update(state, dt);
    food.update(state, dt);
    agents.update(state, dt);
    vehicles.update(state, dt);
    if (state.gameOver) return;
  }
}

test('commuters staff understaffed employers', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 4, 'home', 100, 500); // second home — a house supplies at most 2 residents
  const mkt = b(s, 2, 'market', 300, 100);
  b(s, 3, 'farm', 500, 100);
  road(s, { x: 100, y: 100 }, { x: 500, y: 100 });
  road(s, { x: 100, y: 500 }, { x: 100, y: 100 });

  assert.ok(personDestFor(mkt.color)[0](mkt), 'understaffed market should attract workers');
  runTicks(s, 60);
  assert.ok(mkt.workers.length >= CONFIG.food.workersNeeded,
    `market staffed to ${mkt.workers.length}/${CONFIG.food.workersNeeded}`);
});

test('staffed farm produces crates that reach the market by truck', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  const mkt = b(s, 2, 'market', 300, 100);
  b(s, 3, 'farm', 500, 100, { workers: [45, 45, 45] });
  road(s, { x: 100, y: 100 }, { x: 500, y: 100 });

  runTicks(s, 40);
  assert.ok(s.freightDelivered > 0, `expected crates delivered, got ${s.freightDelivered}`);
});

test('stocked staffed market dispatches milkman and feeds hungry homes', () => {
  const s = createState();
  const home = b(s, 1, 'home', 100, 100, { hungerT: 50 });
  const mkt = b(s, 2, 'market', 300, 100, { workers: [45, 45, 45], stock: 5 });
  road(s, { x: 100, y: 100 }, { x: 300, y: 100 });

  runTicks(s, 15);
  assert.ok(home.fedAt > 0, 'home never received a delivery');
  assert.ok(home.hungerT < 50, `hunger still ${home.hungerT}`);
  assert.ok(mkt.stock < 5, 'stock was not consumed');
});

test('full food chain: workers → farm → crates → market → fed home', () => {
  const s = createState();
  const home = b(s, 1, 'home', 100, 100, { hungerT: -30 });
  b(s, 2, 'market', 300, 100);
  b(s, 3, 'farm', 500, 100, { workers: [40, 40, 40] });
  road(s, { x: 100, y: 100 }, { x: 500, y: 100 });

  runTicks(s, 110);
  assert.ok(s.freightDelivered > 0, 'no crates delivered');
  assert.ok(home.fedAt > 0, 'home never fed');
  assert.equal(s.gameOver, null);
});
