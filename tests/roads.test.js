import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/state.js';
import { addLine } from '../src/networks.js';
import { buildRoad, roadCost, roadCellCost } from '../src/roads.js';
import { cellOf, cellsBetween } from '../src/grid.js';
import { findPath } from '../src/routing.js';
import { addTrain } from '../src/vehicles.js';
import * as spawn from '../src/spawn.js';
import * as economy from '../src/economy.js';
import * as agents from '../src/agents.js';
import * as vehicles from '../src/vehicles.js';

function b(state, id, type, x, y) {
  state.buildings.set(id, {
    id, type, x, y, active: true, waiting: [], capacity: 6, overflowT: 0, spawnClock: 2,
  });
}

// draw a road between two world points as a contiguous cell path
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

test('a road between home and work delivers commuters by car', () => {
  const s = createState();
  s.spawnClock = 99999;
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 400, 100);
  road(s, { x: 100, y: 100 }, { x: 400, y: 100 });
  assert.ok(s.roadEdges.size >= 1);

  const legs = findPath(s, 1, 'work');
  assert.equal(legs.length, 1);
  assert.equal(legs[0].mode, 'road');

  runTicks(s, 60);
  assert.ok(s.delivered > 0, `expected deliveries, got ${s.delivered}`);
});

test('crossing roads share an intersection node that paths can turn through', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'home', 100, 300);
  b(s, 3, 'home', 300, 300);
  b(s, 4, 'work', 300, 100);
  road(s, { x: 100, y: 100 }, { x: 300, y: 300 }); // diagonal b1→b3
  road(s, { x: 100, y: 300 }, { x: 300, y: 100 }); // diagonal b2→b4 (crosses)

  const legs = findPath(s, 1, 'work');
  assert.ok(legs, 'no path found');
  const nodes = legs[0].nodes;
  assert.ok(nodes.some((n) => n.startsWith('r')), `expected an intersection node, got ${nodes}`);
  assert.equal(legs[legs.length - 1].to, 4);
});

test('multimodal trip: car on road leg then train on line leg', () => {
  const s = createState();
  s.spawnClock = 99999;
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'home', 300, 100);  // interchange building
  b(s, 3, 'work', 600, 100);
  road(s, { x: 100, y: 100 }, { x: 300, y: 100 });
  const line = addLine(s, [2, 3]);
  addTrain(s, line);

  const legs = findPath(s, 1, 'work');
  assert.deepEqual(legs.map((l) => l.mode), ['road', 'line']);
  assert.equal(legs[1].from, 2);

  runTicks(s, 90);
  assert.ok(s.delivered > 0, `expected deliveries, got ${s.delivered}`);
});

test('road cost counts unique new cells; reusing road cells is free', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 420, 100);
  const cells = cellsBetween(cellOf({ x: 100, y: 100 }), cellOf({ x: 420, y: 100 }));
  assert.equal(roadCellCost(s, cells), 9); // (2,2)…(10,2) inclusive
  road(s, { x: 100, y: 100 }, { x: 420, y: 100 });
  assert.equal(roadCellCost(s, cells), 0, 're-tracing built cells should be free');
  assert.equal(roadCost([{ x: 0, y: 0 }, { x: 360, y: 0 }]), 10);
});
