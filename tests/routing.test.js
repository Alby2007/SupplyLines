import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/state.js';
import { addLine } from '../src/networks.js';
import { findPath } from '../src/routing.js';

function b(state, id, type, x, y) {
  state.buildings.set(id, {
    id, type, x, y, active: true, waiting: [], capacity: 6, overflowT: 0,
  });
}

test('direct ride on one line produces a single leg', () => {
  const s = createState();
  b(s, 1, 'home', 0, 0);
  b(s, 2, 'work', 100, 0);
  addLine(s, [1, 2]);
  const legs = findPath(s, 1, 'work');
  assert.equal(legs.length, 1);
  assert.equal(legs[0].mode, 'line');
  assert.equal(legs[0].from, 1);
  assert.equal(legs[0].to, 2);
});

test('transfer between two lines produces two legs meeting at the shared stop', () => {
  const s = createState();
  b(s, 1, 'home', 0, 0);
  b(s, 2, 'home', 100, 0);
  b(s, 3, 'work', 200, 100);
  addLine(s, [1, 2]);
  addLine(s, [2, 3]);
  const legs = findPath(s, 1, 'work');
  assert.equal(legs.length, 2);
  assert.equal(legs[0].to, 2);
  assert.equal(legs[1].from, 2);
  assert.equal(legs[1].to, 3);
});

test('returns null when destination type is unreachable', () => {
  const s = createState();
  b(s, 1, 'home', 0, 0);
  b(s, 2, 'work', 100, 0);
  b(s, 3, 'work', 400, 400);
  addLine(s, [1, 2]);
  const legs = findPath(s, 1, 'work');
  assert.equal(legs.length, 1);
  assert.equal(legs[0].to, 2); // nearest reachable work, not the isolated one
});

test('no path at all when nothing is connected', () => {
  const s = createState();
  b(s, 1, 'home', 0, 0);
  b(s, 2, 'work', 500, 500);
  assert.equal(findPath(s, 1, 'work'), null);
});

test('loop line routes either direction', () => {
  const s = createState();
  b(s, 1, 'home', 0, 0);
  b(s, 2, 'home', 100, 0);
  b(s, 3, 'work', 100, 100);
  addLine(s, [1, 2, 3]);
  const line = [...s.lines.values()][0];
  line.loop = true;
  const legs = findPath(s, 1, 'work');
  assert.equal(legs.length, 1);
  assert.equal(legs[0].to, 3);
});

test('multi-stop ride compresses into one leg', () => {
  const s = createState();
  b(s, 1, 'home', 0, 0);
  b(s, 2, 'home', 100, 0);
  b(s, 3, 'work', 200, 0);
  addLine(s, [1, 2, 3]);
  const legs = findPath(s, 1, 'work');
  assert.equal(legs.length, 1);
  assert.deepEqual(legs[0].nodes.map((n) => n.replace('b', '')).map(Number), [1, 2, 3]);
});
