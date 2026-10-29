import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createState } from '../src/state.js';
import { buildRoad, roadCellIndex, demolishRoad } from '../src/roads.js';
import { buildRoundabout, placeRoundabout } from '../src/roundabouts.js';
import { cellOf, cellsBetween, cellKey } from '../src/grid.js';
import { findPath, roadNodeKey } from '../src/routing.js';
import * as spawn from '../src/spawn.js';
import * as economy from '../src/economy.js';
import * as agents from '../src/agents.js';
import * as vehicles from '../src/vehicles.js';

function b(state, id, type, x, y) {
  const bb = {
    id, type, x, y, active: true, waiting: [], capacity: 6, overflowT: 0, spawnClock: 2,
  };
  state.buildings.set(id, bb);
  return bb;
}

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

// three roads meeting at j → the shared junction node
function yJunction(s, j, p1, p2, p3) {
  road(s, j, p1);
  road(s, j, p2);
  road(s, j, p3);
  return [...s.roadNodes.values()].find((n) => n.edges.length >= 3 && n.bid == null);
}

test('a roundabout replaces the junction node with a one-way ring', () => {
  const s = createState();
  const node = yJunction(s, { x: 300, y: 300 }, { x: 100, y: 100 }, { x: 500, y: 100 }, { x: 300, y: 500 });
  assert.ok(node, 'no junction formed');

  assert.ok(buildRoundabout(s, node));
  assert.ok(!s.roadNodes.has(node.id), 'junction node should be gone');
  // no edge still references the dead node
  for (const e of s.roadEdges.values()) {
    assert.ok(e.a !== node.id && e.b !== node.id, 'edge still ends at the dead node');
  }
  // the ring exists and every ring edge is one-way
  const ring = [...s.roadEdges.values()].filter((e) => e.oneway);
  assert.ok(ring.length >= 3, `expected a ring, got ${ring.length} edges`);
  assert.ok(ring.every((e) => e.roundabout), 'ring edges lack the island marker');
});

test('traffic still routes through a roundabout — in ring order', () => {
  const s = createState();
  s.spawnClock = 99999;
  const h = b(s, 1, 'home', 100, 100);
  const w = b(s, 2, 'work', 500, 100);
  const node = yJunction(s, { x: 300, y: 300 }, h, w, { x: 300, y: 500 });
  buildRoundabout(s, node);

  const legs = findPath(s, h.id, 'work');
  assert.ok(legs, 'no path through the roundabout');
  const roadLegs = legs.filter((l) => l.mode === 'road');
  const ringIds = new Set(
    [...s.roadEdges.values()].filter((e) => e.oneway).map((e) => e.id),
  );
  let ringSegs = 0;
  for (const leg of roadLegs) {
    for (let i = 0; i < leg.edgeIds.length; i++) {
      if (!ringIds.has(leg.edgeIds[i])) continue;
      ringSegs++;
      // one-way: traversal must match the edge's built direction
      const e = s.roadEdges.get(leg.edgeIds[i]);
      assert.equal(leg.nodes[i], roadNodeKey(s.roadNodes.get(e.a)));
    }
  }
  assert.ok(ringSegs >= 1, 'path never entered the ring');

  // and cars actually drive it end-to-end
  runTicks(s, 60);
  assert.ok(s.delivered > 0, `no deliveries through the roundabout`);
});

test('a roundabout stamps on open ground and roads join it as normal', () => {
  const s = createState();
  s.spawnClock = 99999;
  const h = b(s, 1, 'home', 100, 100);
  const w = b(s, 2, 'work', 500, 100);
  // free placement on empty ground — no roads near it yet
  const ring = placeRoundabout(s, { x: 300, y: 300 });
  assert.ok(ring?.length >= 4, 'no standalone ring stamped');
  // interior cells register as road — buildings can't spawn in the island
  assert.ok(roadCellIndex(s).has(cellKey(cellOf({ x: 300, y: 300 }))));

  // now draw the roads into it — they must reach the buildings through the ring
  road(s, h, { x: 300, y: 300 });
  road(s, { x: 300, y: 300 }, w);
  const legs = findPath(s, h.id, 'work');
  assert.ok(legs, 'roads drawn to the ring do not connect');
  runTicks(s, 60);
  assert.ok(s.delivered > 0, 'no deliveries through the stamped roundabout');
});

test('a roundabout dropped on a road splits the road into the ring', () => {
  const s = createState();
  const h = b(s, 1, 'home', 100, 100);
  const w = b(s, 2, 'work', 500, 100);
  road(s, h, w);
  assert.ok(placeRoundabout(s, { x: 300, y: 100 }), 'drop on the road failed');
  const ring = [...s.roadEdges.values()].filter((e) => e.oneway);
  assert.ok(ring.length >= 2, 'no ring formed on the road');
  // the surface road still reaches both buildings through the circle
  assert.ok(findPath(s, h.id, 'work'), 'road no longer routes');
});

test('a roundabout cannot land on a building or on another ring', () => {
  const s = createState();
  b(s, 1, 'home', 300, 300);
  assert.equal(placeRoundabout(s, { x: 300, y: 300 }), null, 'placed on a home');
  assert.ok(placeRoundabout(s, { x: 700, y: 700 }), 'standalone stamp failed');
  assert.equal(placeRoundabout(s, { x: 700, y: 700 }), null, 'stacked on a ring');
});

test('bulldozing one arc removes the whole roundabout', () => {
  const s = createState();
  assert.ok(placeRoundabout(s, { x: 700, y: 700 }));
  const before = s.roadEdges.size;
  // a drag across the middle touches the island cells → the ring dies as one
  demolishRoad(s, cellsBetween(cellOf({ x: 680, y: 700 }), cellOf({ x: 720, y: 700 })));
  assert.ok(![...s.roadEdges.values()].some((e) => e.roundabout), 'ring survived');
  assert.equal(s.roadEdges.size, before - 8);
});

test('the first roundabout is granted when week 3 ends', () => {
  const s = createState();
  economy.update(s, 1 / 60);
  assert.equal(s.roundabouts, 0);
  s.week = CONFIG.roundabouts.unlockWeek;
  economy.update(s, 1 / 60);
  assert.equal(s.roundabouts, 1);
  economy.update(s, 1 / 60);
  assert.equal(s.roundabouts, 1, 'grant fired twice');
});
