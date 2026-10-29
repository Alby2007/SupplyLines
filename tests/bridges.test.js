import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, applyLevelOverrides } from '../src/config.js';
import { createState } from '../src/state.js';
import { buildRoad, roadCellCost, bridgeCost, demolishRoad } from '../src/roads.js';
import { cellOf, cellKey, cellsBetween } from '../src/grid.js';
import { findPath } from '../src/routing.js';
import * as economy from '../src/economy.js';

function b(state, id, type, x, y) {
  state.buildings.set(id, {
    id, type, x, y, active: true, waiting: [], capacity: 6, overflowT: 0, spawnClock: 2,
  });
}

// a vertical water strip the horizontal road has to cross: cx 4..6, all rows
function waterStrip(s, cx0 = 4, cx1 = 6) {
  s.water = new Set();
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = 0; cy < 32; cy++) s.water.add(cellKey({ cx, cy }));
  }
}

const across = () => cellsBetween(cellOf({ x: 100, y: 100 }), cellOf({ x: 400, y: 100 }));

test('water rejects road paths when the bridge stock cannot cover them', () => {
  const s = createState();
  waterStrip(s);
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 400, 100);
  assert.equal(s.bridges, 0);
  assert.deepEqual(buildRoad(s, across()), []);
  assert.equal(s.roadEdges.size, 0);
});

test('a road across water auto-spends one bridge per uncovered water cell', () => {
  const s = createState();
  waterStrip(s);
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 400, 100);
  s.bridges = 5;
  const cells = across();
  const wet = bridgeCost(s, cells);
  assert.ok(wet >= 3, `crossing should span the strip, got ${wet}`);
  assert.ok(wet <= 5, 'test strip should be crossable on 5 bridges');
  const edges = buildRoad(s, cells);
  assert.ok(edges.length > 0, 'road should build when bridges cover the span');
  assert.equal(s.bridges, 5 - wet, 'spent exactly the water cells crossed');
  const decks = [...s.roadEdges.values()].filter((e) => e.bridge);
  assert.ok(decks.length > 0, 'crossing edges should be flagged as bridge decks');
  // the two banks are now one network — cars route straight through
  assert.ok(findPath(s, 1, (bb) => bb.id === 2), 'banks should be connected');
});

test('water cells cost bridges, not tiles — the two stay separate', () => {
  const s = createState();
  waterStrip(s);
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 400, 100);
  s.bridges = 5;
  const cells = across();
  const dry = roadCellCost(s, cells);
  const wet = bridgeCost(s, cells);
  assert.ok(wet > 0);
  // the strip is 3 cells wide; the path is ~8 cells total
  assert.equal(dry + wet, cells.length, 'every cell is either tiles or bridges');
});

test('re-tracing an existing bridge costs no bridges', () => {
  const s = createState();
  waterStrip(s);
  s.bridges = 5;
  const cells = across();
  buildRoad(s, cells);
  const spent = 5 - s.bridges;
  assert.equal(bridgeCost(s, cells), 0, 'cells under a deck are already road');
  const edges2 = buildRoad(s, cells);
  assert.equal(s.bridges, 5 - spent, 'second pass spends nothing');
  assert.ok(edges2.length >= 0); // may rebuild zero new edges — either way free
});

test('bulldozing a bridge refunds the spent bridges, not tiles', () => {
  const s = createState();
  waterStrip(s);
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 400, 100);
  s.bridges = 5;
  applyLevelOverrides(3); // CONFIG.bridges exists → refunds have somewhere to go
  const cells = across();
  const wet = bridgeCost(s, cells);
  buildRoad(s, cells);
  const after = s.bridges;
  demolishRoad(s, cells);
  assert.equal(s.bridges, Math.min(CONFIG.bridges.cap, after + wet),
    'water cells come back as bridges, capped at CONFIG.bridges.cap');
});

test('the gift lands once week 1 completes — only where the section exists', () => {
  applyLevelOverrides(3); // CONFIG.bridges only exists on the river map
  const s = createState();
  s.week = 2;
  economy.update(s, 0.016);
  assert.equal(s.bridgesGranted, true);
  assert.equal(s.bridges, CONFIG.bridges.grant);
  // a second tick does not re-grant
  economy.update(s, 0.016);
  assert.equal(s.bridges, CONFIG.bridges.grant);

  // without the level section (maps 1/2) the mechanism is inert
  const saved = CONFIG.bridges;
  delete CONFIG.bridges;
  const s2 = createState();
  s2.week = 2;
  economy.update(s2, 0.016);
  assert.equal(s2.bridgesGranted, false);
  assert.equal(s2.bridges, 0);
  CONFIG.bridges = saved;
});
