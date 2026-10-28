import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createState } from '../src/state.js';
import { addLine } from '../src/networks.js';
import { buildRoad } from '../src/roads.js';
import { findPath } from '../src/routing.js';
import { cellOf, cellsBetween } from '../src/grid.js';
import { personDestFor, marketMatch, spawnAgent } from '../src/agents.js';
import { pickColor, update as spawnUpdate } from '../src/spawn.js';
import * as economy from '../src/economy.js';
import * as food from '../src/food.js';
import * as agents from '../src/agents.js';
import * as vehicles from '../src/vehicles.js';

function b(state, id, type, x, y, color = 0, extra = {}) {
  state.buildings.set(id, {
    id, type, x, y, color, active: true, waiting: [], capacity: 6, overflowT: 0,
    spawnClock: 2, workers: [], stock: 0, hungerT: 0, produceClock: 0,
    assignedMarket: null, marketDist: Infinity,
    trucks: CONFIG.food.marketTrucksStart, activeTrucks: 0, dispatchT: 0, fedAt: 0,
    ...extra,
  });
  return state.buildings.get(id);
}

function road(s, a, bPt) {
  return buildRoad(s, cellsBetween(cellOf(a), cellOf(bPt)));
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

test('people only commute to same-colour buildings', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100, 0);
  b(s, 2, 'work', 400, 100, 1); // wrong colour
  road(s, { x: 100, y: 100 }, { x: 400, y: 100 });
  // road connects them physically, but the destination predicate rejects green work
  const legs = findPath(s, 1, personDestFor(0)[1]);
  assert.equal(legs, null);
});

test('same-colour commute works and delivers', () => {
  const s = createState();
  s.spawnClock = 99999;
  b(s, 1, 'home', 100, 100, 0);
  b(s, 2, 'work', 400, 100, 0);
  b(s, 3, 'work', 700, 100, 1); // green work further away — ignored
  road(s, { x: 100, y: 100 }, { x: 400, y: 100 });
  road(s, { x: 400, y: 100 }, { x: 700, y: 100 });
  runTicks(s, 60);
  assert.ok(s.delivered > 0, `expected deliveries, got ${s.delivered}`);
});

test('lines take their first stop’s colour and filter riders', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100, 0);
  b(s, 2, 'work', 400, 100, 0);
  const line = addLine(s, [1, 2]);
  assert.equal(line.color, 0);

  // pretend this line is actually green — a red person must not board it
  line.color = 1;
  assert.equal(findPath(s, 1, 'work', { lineColor: 0 }), null);
  assert.ok(findPath(s, 1, 'work', { lineColor: 1 }), 'green agents ride the green line');
  assert.ok(findPath(s, 1, 'work'), 'colourless agents are unrestricted');
});

test('reaching the population threshold unlocks the next colour', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100, 0);
  b(s, 2, 'work', 400, 100, 0);
  assert.deepEqual(s.unlockedColors, [0]);

  // fewer than threshold → nothing
  for (let i = 0; i < CONFIG.colors.popToUnlock - 1; i++) {
    s.agents.set(100 + i, { id: 100 + i, kind: 'person', color: 0 });
  }
  spawnUpdate(s, 0.016);
  assert.deepEqual(s.unlockedColors, [0]);

  // one more → colour 1 unlocks and places a home+work seed pair
  s.agents.set(199, { id: 199, kind: 'person', color: 0 });
  spawnUpdate(s, 0.016);
  assert.deepEqual(s.unlockedColors, [0, 1]);
  const newCol = [...s.buildings.values()].filter((x) => x.color === 1);
  assert.equal(newCol.length, 2);
  assert.deepEqual(newCol.map((x) => x.type).sort(), ['home', 'work']);
});

test('homes assign only to same-colour markets', () => {
  const s = createState();
  const home = b(s, 1, 'home', 100, 100, 0, { hungerT: 50 });
  const redMkt = b(s, 2, 'market', 500, 100, 0, { workers: [45, 45, 45], stock: 5 });
  b(s, 3, 'market', 300, 100, 1, { workers: [45, 45, 45], stock: 5 }); // nearer but green
  road(s, { x: 100, y: 100 }, { x: 500, y: 100 });

  runTicks(s, 15);
  assert.equal(home.assignedMarket, redMkt.id, 'red home should take the red market');
  assert.ok(home.fedAt > 0, 'red home was never fed');
});

test('crates ride colour-locked lines to reach a market', () => {
  const s = createState();
  b(s, 1, 'farm', 100, 100, null);
  b(s, 2, 'market', 400, 100, 0);
  const line = addLine(s, [1, 2]); // takes colour of stop 1 (farm → null → 0 fallback)
  void line;
  // crates have no colour filter — the line just needs to reach a market
  const legs = findPath(s, 1, marketMatch);
  assert.ok(legs, 'crate found no path to market');
  assert.equal(legs[legs.length - 1].to, 2);
});

test('pickColor never picks a home colour with no same-colour work', () => {
  const s = createState();
  s.unlockedColors = [0, 1];
  b(s, 1, 'home', 100, 100, 0);
  b(s, 2, 'work', 400, 100, 0);
  // colour 1 has no work → homes must always come out colour 0
  for (let i = 0; i < 20; i++) assert.equal(pickColor(s, 'home'), 0);
  // a work for colour 1 is fine (colour 1 has no homes → score favours 0… but not excluded)
  // markets prefer the colour with uncovered homes — colour 0 here
  assert.equal(pickColor(s, 'market'), 0);
});
