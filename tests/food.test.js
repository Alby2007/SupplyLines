import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createState } from '../src/state.js';
import { buildRoad } from '../src/roads.js';
import { cellOf, cellsBetween } from '../src/grid.js';
import { personDestFor } from '../src/agents.js';
import { findPath } from '../src/routing.js';

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

test('a market with one worker still runs a truck — staff are the drivers', () => {
  const s = createState();
  const home = b(s, 1, 'home', 100, 100, { hungerT: 50 });
  // 1 worker < workersNeeded(2): old all-or-nothing rule sent zero trucks
  const mkt = b(s, 2, 'market', 300, 100, { workers: [45], stock: 5 });
  road(s, { x: 100, y: 100 }, { x: 300, y: 100 });

  runTicks(s, 15);
  assert.ok(home.fedAt > 0, 'understaffed market never dispatched');
});

test('trucks split coverage — no two trucks run the same route', () => {
  const s = createState();
  // five hungry homes; truck 1 loads at most milkCap(4) drops — truck 2 may
  // only visit the lone leftover. Truck 1 re-orders drops by proximity.
  b(s, 1, 'home', 100, 100, { hungerT: 60 });
  b(s, 5, 'home', 600, 100, { hungerT: 58 });
  b(s, 4, 'home', 100, 300, { hungerT: 55 });
  b(s, 6, 'home', 600, 300, { hungerT: 50 });
  b(s, 7, 'home', 600, 500, { hungerT: 48 });
  const mkt = b(s, 2, 'market', 300, 100, { workers: [45, 45], stock: 8 });
  road(s, { x: 100, y: 100 }, { x: 600, y: 100 });
  road(s, { x: 100, y: 300 }, { x: 600, y: 300 });
  road(s, { x: 100, y: 100 }, { x: 100, y: 300 });
  road(s, { x: 600, y: 300 }, { x: 600, y: 500 });

  runTicks(s, 8); // assignment ~3s, then two dispatch windows (interval = 2s)
  const trucks = [...s.vehicles.values()].filter((v) => v.kind === 'milkTruck');
  assert.equal(trucks.length, 2, `expected 2 trucks out, got ${trucks.length}`);

  const [t1, t2] = trucks;
  // truck 2 may only visit homes truck 1 isn't covering — the lone leftover
  assert.deepEqual(t2.targets, [7]);
  for (const id of t1.targets) {
    assert.ok([1, 4, 5, 6].includes(id), `truck 1 unexpectedly targets ${id}`);
  }
  // nearest-neighbour order: h1 already delivered (nearest), now heading to
  // h4 — hunger order would have sent it to h5 (58 > 55) instead
  assert.equal(t1.targets[0], 4, 'truck should visit the nearer home next');
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

// staff keep their agent through the shift (like office workers) — the home's
// resident slot stays taken until they actually commute back
test('farm staff persist through the shift, then commute home', () => {
  const s = createState();
  const h = b(s, 1, 'home', 100, 100, { spawnClock: 99999, hungerT: -9999 });
  const f = b(s, 2, 'farm', 500, 100);
  road(s, h, f);
  const a = agents.spawnAgent(s, h, 'person', (bb) => bb.id === f.id);
  a.legs = findPath(s, h.id, (bb) => bb.id === f.id);

  runTicks(s, 15); // drive to the farm
  assert.equal(a.workingAt, f.id);
  assert.equal(f.workers.length, 1);
  assert.ok(s.agents.has(a.id), 'staff agent should persist through the shift');
  const out = [...s.agents.values()].filter((x) => x.home === h.id).length;
  assert.equal(out, 1, 'resident slot should stay taken while on-shift');

  runTicks(s, 140); // shift ends (~120s) + commute home
  assert.ok(!s.agents.has(a.id), 'returned worker should be deleted at home');
});
