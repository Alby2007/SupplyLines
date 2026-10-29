import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/state.js';
import { addLine, addJunction, insertJunction } from '../src/networks.js';
import { addTrain, awardConnectionTrains, update as updateVehicles } from '../src/vehicles.js';
import { findPath } from '../src/routing.js';
import { spawnAgent, marketMatch, update as updateAgents } from '../src/agents.js';
import { update as updateFood } from '../src/food.js';

function b(state, id, type, x, y, extra = {}) {
  state.buildings.set(id, {
    id, type, x, y, active: true, waiting: [], capacity: 6, overflowT: 0,
    spawnClock: 2, workers: [], stock: 0, produceClock: 0,
    color: type === 'farm' ? null : 0,
    ...extra,
  });
  return state.buildings.get(id);
}

function runTicks(state, seconds, dt = 1 / 60) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    state.time += dt;
    updateFood(state, dt);
    updateAgents(state, dt);
    updateVehicles(state, dt);
  }
}

test('a line with a farm stop becomes a freight line', () => {
  const s = createState();
  const f = b(s, 1, 'farm', 100, 100);
  const m = b(s, 2, 'market', 400, 100);
  const line = addLine(s, [f.id, m.id]);
  assert.equal(line.freight, true);
  assert.equal(line.color, 0, 'freight line takes its market’s colour');
  const t = addTrain(s, line);
  assert.equal(t.freight, true);
});

test('a freight train hauls crates farm→market with no road at all', () => {
  const s = createState();
  s.spawnClock = 99999;
  const f = b(s, 1, 'farm', 100, 100, { workers: [9, 9, 9] });
  const m = b(s, 2, 'market', 500, 100);
  const line = addLine(s, [f.id, m.id]);
  addTrain(s, line);
  assert.equal(line.freight, true);

  runTicks(s, 40);
  assert.ok(m.stock > 0, 'no crates reached the market by rail');
  assert.ok(s.freightDelivered > 0);
});

test('people can’t route onto freight lines; crates can’t route onto people lines', () => {
  const s = createState();
  const h = b(s, 1, 'home', 100, 100);
  const f = b(s, 2, 'farm', 300, 100);
  const m = b(s, 3, 'market', 500, 100);
  const w = b(s, 4, 'work', 700, 100);
  // freight line m→f and a people line h→w share the market area loosely —
  // the point is each agent kind only sees its own rails
  const freight = addLine(s, [f.id, m.id]);
  const people = addLine(s, [h.id, w.id]);

  // person at the market colour-matches the… market is a stop on the freight
  // line, but freight edges are filtered out → no path without roads
  const pLegs = findPath(s, m.id, (bb) => bb.id === w.id, { lineColor: 0 });
  assert.ok(!pLegs || pLegs.every((l) => l.mode !== 'line'), 'person used a freight line');

  // crate at the farm: the people line carries no crates → market via the
  // freight line only; a pure-people-line path must not appear
  const cLegs = findPath(s, f.id, (bb) => bb.id === m.id, { freight: true });
  assert.ok(cLegs, 'crate found no freight path');
  assert.ok(cLegs.every((l) => l.lineId !== people.id), 'crate used a people line');
});

test('crates on a freight-connected farm prefer that line’s markets', () => {
  const s = createState();
  const f = b(s, 1, 'farm', 100, 100);
  const mNear = b(s, 2, 'market', 300, 100);   // on the freight line
  b(s, 3, 'market', 120, 300);                // not on it
  addLine(s, [f.id, mNear.id]);

  const crate = spawnAgent(s, f, 'crate', marketMatch);
  updateAgents(s, 0.1); // routes on the first tick
  assert.ok(crate.legs, 'crate found no path');
  const dest = crate.legs.at(-1).to;
  assert.equal(dest, mNear.id, 'crate did not prefer the freight-line market');
});

test('a new line through a junction adds a train to the line it connects', () => {
  const s = createState();
  const a = b(s, 1, 'home', 100, 100);
  const c = b(s, 2, 'work', 400, 100);
  const d = b(s, 3, 'home', 250, 300);
  const line1 = addLine(s, [a.id, c.id]);
  addTrain(s, line1);
  assert.equal(line1.trains.length, 1);

  // junction spliced into line1, then a new line through it
  const j = addJunction(s, 250, 100, line1.color);
  insertJunction(s, j, line1, 0);
  const line2 = addLine(s, [d.id, j.id]);
  awardConnectionTrains(s, line2);

  assert.equal(line1.trains.length, 2, 'connected line gained no train');
  assert.equal(line2.trains.length, 0, 'bonus trains belong to the existing line');
});
