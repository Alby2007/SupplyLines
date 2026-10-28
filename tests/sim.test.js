import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createState } from '../src/state.js';
import { seedInitial } from '../src/spawn.js';
import { addLine } from '../src/networks.js';
import { addTrain } from '../src/vehicles.js';
import { buildRoad } from '../src/roads.js';
import { findPath } from '../src/routing.js';
import { cellOf, cellsBetween } from '../src/grid.js';
import * as spawn from '../src/spawn.js';
import * as economy from '../src/economy.js';
import * as agents from '../src/agents.js';
import * as vehicles from '../src/vehicles.js';
import * as food from '../src/food.js';

function road(s, a, bPt) {
  return buildRoad(s, cellsBetween(cellOf(a), cellOf(bPt)));
}

function runTicks(state, seconds, dt = 1 / 60) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    state.time += dt;
    spawn.update(state, dt);
    economy.update(state, dt);
    agents.update(state, dt);
    vehicles.update(state, dt);
    if (state.gameOver) return;
  }
}

test('commuters ride a line from home to work and get delivered', () => {
  const s = createState();
  seedInitial(s);
  s.spawnClock = 99999; // freeze new building spawns for determinism
  const ids = [...s.buildings.values()].map((b) => b.id);
  const line = addLine(s, ids); // connect every building: home - work - home
  addTrain(s, line);

  runTicks(s, 60);
  assert.ok(s.delivered > 0, `expected deliveries, got ${s.delivered}`);
  assert.equal(s.gameOver, null);
});

test('disconnected buildings accumulate waiting passengers', () => {
  const s = createState();
  seedInitial(s);
  runTicks(s, 30);
  let waiting = 0;
  for (const b of s.buildings.values()) waiting += b.waiting.length;
  assert.ok(waiting > 0, 'expected passengers waiting with no line built');
});

test('an unattended transfer stop eventually overflows to game over', () => {
  // homes are capped at 2 residents so they can't self-overflow — but a stop
  // where commuters wait for a train that never comes accumulates without bound
  const s = createState();
  s.spawnClock = 99999;
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'home', 300, 100);
  b(s, 3, 'work', 500, 100);
  for (let i = 4; i <= 7; i++) {
    b(s, i, 'home', 100 + (i - 4) * 40, 500);
    road(s, { x: 100 + (i - 4) * 40, y: 500 }, { x: 300, y: 100 });
  }
  road(s, { x: 100, y: 100 }, { x: 300, y: 100 });
  addLine(s, [2, 3]); // line exists but no train ever runs

  runTicks(s, 300);
  assert.ok(s.gameOver, 'expected game over after transfer pile-up');
});

test('an unserved workplace fails via its demand meter', () => {
  const s = createState();
  s.spawnClock = 99999;
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 400, 100); // no road or line reaches it
  runTicks(s, 150);
  assert.ok(s.gameOver, 'expected demand failure');
  assert.match(s.gameOver.reason, /understaffed/i);
});

test('a served workplace keeps its demand meter down', () => {
  const s = createState();
  s.spawnClock = 99999;
  b(s, 1, 'home', 100, 100);
  const w = b(s, 2, 'work', 400, 100);
  road(s, { x: 100, y: 100 }, { x: 400, y: 100 });
  runTicks(s, 150);
  assert.equal(s.gameOver, null);
  assert.ok(w.demandT < CONFIG.demand.limit * 0.5, `demandT crept to ${w.demandT}`);
});

test('a well-served workplace levels up and its meter fills faster', () => {
  const s = createState();
  s.spawnClock = 99999;
  const w = b(s, 2, 'work', 400, 100);
  w.level = 1;
  w.served = 0;
  const D = CONFIG.demand;
  for (let i = 0; i < D.promoteEvery; i++) {
    vehicles.arrive(s, { id: 1000 + i, kind: 'person' }, 2);
  }
  assert.equal(w.level, 2);
  assert.ok(w.demandT <= 0, 'promotion clears accrued demand');
  // a level-2 meter accumulates at the grown rate
  w.demandT = 0;
  economy.update(s, 10);
  const expected = D.rate * (1 + D.growth) * 10;
  assert.ok(Math.abs(w.demandT - expected) < 1e-9, `demandT ${w.demandT} != ${expected}`);
  // cap: serving through maxLevel stops promoting
  w.served = 0;
  for (let i = 0; i < D.promoteEvery * (D.maxLevel + 2); i++) {
    vehicles.arrive(s, { id: 2000 + i, kind: 'person' }, 2);
  }
  assert.equal(w.level, D.maxLevel);
});

test('an arriving worker stays for a shift, then commutes home', () => {
  const s = createState();
  s.spawnClock = 99999;
  b(s, 1, 'home', 100, 100);
  const w = b(s, 2, 'work', 400, 100);
  road(s, { x: 100, y: 100 }, { x: 400, y: 100 }); // return path exists
  const a = {
    id: 42, kind: 'person', color: 0, home: 1, dest: null, loc: 2,
    legs: null, pathV: -1, retryT: 0, wait: 0,
  };
  s.agents.set(42, a);
  vehicles.arrive(s, a, 2);
  assert.ok(s.agents.has(42), 'worker was consumed on arrival');
  assert.equal(a.workingAt, 2);
  assert.equal(s.delivered, 1);

  // the shift elapses — the worker is released homebound (they may already
  // be riding: an open road path departs them in the same tick)
  for (let t = 0; t < CONFIG.work.shiftLen + 0.5; t += 0.1) agents.update(s, 0.1);
  assert.equal(a.workingAt, null);
  assert.ok(w.waiting.includes(42) || typeof a.loc !== 'number',
    'finished worker neither queued nor departed');

  // they ride home and are finally removed — without counting as a delivery
  for (let t = 0; t < 30 && s.agents.has(42); t += 0.1) {
    agents.update(s, 0.1);
    vehicles.update(s, 0.1);
    s.time += 0.1;
  }
  assert.ok(!s.agents.has(42), 'returning worker was not removed at home');
  assert.equal(s.delivered, 1);
});

test('a road through an incoming building serves it once it opens', () => {
  const s = createState();
  const home = {
    id: 1, type: 'home', x: 220, y: 220, color: 0, active: false, openAt: 5,
    waiting: [], capacity: 6, overflowT: 0,
  };
  s.buildings.set(1, home);
  b(s, 2, 'work', 460, 220); // active, cell (11,5)
  // road passes through both buildings' cells before the home opens
  road(s, { x: 140, y: 220 }, { x: 460, y: 220 });
  assert.equal(home.roadNodeId ?? null, null);
  s.time = 10;
  spawn.update(s, 0.1); // activates the home
  assert.ok(home.roadNodeId != null, 'opened building did not join the road');
});

test('a road ending near a building still serves it', () => {
  const s = createState();
  const home = b(s, 1, 'home', 220, 220); // cell (5,5)
  // road covers cells (3,5)..(4,5) — ends 40px short of the home's centre
  road(s, { x: 140, y: 220 }, { x: 180, y: 220 });
  assert.ok(home.roadNodeId != null, 'brushing road did not connect the home');
});

test('a direct drive beats boarding a sparse line', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 400, 100);
  road(s, { x: 100, y: 100 }, { x: 400, y: 100 });
  const line = addLine(s, [1, 2]);
  addTrain(s, line); // one train: long headway → driving wins
  const legs = findPath(s, 1, (bb) => bb.type === 'work', { lineColor: 0 });
  assert.equal(legs[0].mode, 'road');
});

function b(state, id, type, x, y) {
  state.buildings.set(id, {
    id, type, x, y, color: 0, active: true, waiting: [], capacity: 6, overflowT: 0,
    spawnClock: 2, workers: [], stock: 0, hungerT: 0, produceClock: 0,
    assignedMarket: null, marketDist: Infinity,
    trucks: CONFIG.food.marketTrucksStart, activeTrucks: 0, dispatchT: 0, fedAt: 0,
    demandT: type === 'work' ? -CONFIG.demand.grace : 0,
  });
  return state.buildings.get(id);
}
