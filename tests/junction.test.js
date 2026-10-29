import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createState } from '../src/state.js';
import {
  addLine, addJunction, insertJunction, junctionPlacement, junctionCanJoin,
} from '../src/networks.js';
import { buildRoad } from '../src/roads.js';
import { cellOf, cellsBetween, cellKey } from '../src/grid.js';
import { findPath } from '../src/routing.js';
import * as economy from '../src/economy.js';

function b(state, id, type, x, y) {
  state.buildings.set(id, {
    id, type, x, y, active: true, waiting: [], capacity: 6, overflowT: 0, spawnClock: 2,
  });
}

// place a junction on `line` by simulating a click at world point p
function dropJunction(s, p) {
  const pl = junctionPlacement(s, p);
  if (!pl) return null;
  const j = addJunction(s, pl.x, pl.y, pl.line.color);
  insertJunction(s, j, pl.line, pl.segIdx);
  return j;
}

test('junction placed on a line splices into its stop order and takes its colour', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 300, 100);
  const line = addLine(s, [1, 2]);

  const j = dropJunction(s, { x: 200, y: 108 });
  assert.ok(j, 'expected a valid junction placement near the track');
  assert.deepEqual(line.stops, [1, j.id, 2]);
  assert.equal(j.color, line.color);
  // snapped to the cell centre — it claims exactly one grid tile
  assert.equal(j.x % CONFIG.grid.cell, CONFIG.grid.cell / 2);
  assert.equal(j.y % CONFIG.grid.cell, CONFIG.grid.cell / 2);
});

test('junction placement rejects clicks far from any line', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 300, 100);
  addLine(s, [1, 2]);
  assert.equal(junctionPlacement(s, { x: 200, y: 500 }), null);
});

test('junction placement rejects a cell that already holds a building', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 300, 100);
  addLine(s, [1, 2]);
  assert.equal(junctionPlacement(s, { x: 100, y: 104 }), null); // home's cell
  const j = dropJunction(s, { x: 200, y: 106 });
  assert.ok(j);
  assert.equal(junctionPlacement(s, { x: j.x + 6, y: j.y + 4 }), null); // its own cell
});

test('a junction accepts up to three lines total, then refuses more', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 300, 100);
  b(s, 3, 'work', 300, 300);
  b(s, 4, 'work', 500, 300);
  b(s, 5, 'work', 100, 300);
  addLine(s, [1, 2]);
  const j = dropJunction(s, { x: 200, y: 106 });
  assert.ok(j);
  assert.equal(junctionCanJoin(s, j.id), true);  // on 1 of 3
  addLine(s, [j.id, 3]);
  addLine(s, [j.id, 4]);
  assert.equal(junctionCanJoin(s, j.id), false); // at the cap
});

test('a road drawn through a junction cell is rejected wholesale', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 300, 100);
  addLine(s, [1, 2]);
  const j = dropJunction(s, { x: 200, y: 106 });
  assert.ok(j);
  const jc = cellOf(j);
  const edges = buildRoad(s, cellsBetween(
    { cx: jc.cx, cy: jc.cy + 2 },
    { cx: jc.cx, cy: jc.cy - 2 },
  ));
  assert.equal(edges.length, 0);
  assert.equal(s.roadEdges.size, 0);
  assert.equal(j.roadNodeId ?? null, null);
});

test('passengers transfer between lines at a junction mid-track', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);   // line A: home → far home
  b(s, 2, 'home', 500, 100);
  b(s, 3, 'work', 300, 300);   // line B: junction → work
  addLine(s, [1, 2]);
  const j = dropJunction(s, { x: 300, y: 104 });
  assert.ok(j);
  addLine(s, [j.id, 3]);

  const legs = findPath(s, 1, 'work');
  assert.ok(legs, 'no path found');
  assert.equal(legs.length, 2);
  assert.equal(legs[0].to, j.id);
  assert.equal(legs[1].from, j.id);
  assert.equal(legs[1].to, 3);
});

// junctions claim their tile — a cell a road already runs through is occupied
test('junction placement rejects a cell that already holds a road', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 300, 100);
  addLine(s, [1, 2]);
  // road crossing the track's middle cell — (4,2) sits on the line's path
  buildRoad(s, cellsBetween({ cx: 4, cy: 1 }, { cx: 4, cy: 3 }));
  assert.equal(junctionPlacement(s, { x: 180, y: 100 }), null);
});

test('an overflowing junction reports a junction-specific game over', () => {
  const s = createState();
  const j = addJunction(s, 200, 200, 0);
  j.waiting = [1, 2, 3, 4, 5, 6]; // at capacity
  j.overflowT = CONFIG.overflowLimit;
  economy.update(s, 1 / 60);
  assert.equal(s.gameOver?.reason, 'A junction overflowed');
});
