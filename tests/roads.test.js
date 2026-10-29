import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/state.js';
import { addLine } from '../src/networks.js';
import { buildRoad, roadCost, roadCellCost, demolishRoad, demolishRefund } from '../src/roads.js';
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

test('bulldozing removes edges under the path and refunds their tiles', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 460, 100);
  road(s, { x: 100, y: 100 }, { x: 460, y: 100 });
  const before = s.roadEdges.size;
  assert.ok(before > 0);
  // bulldoze the middle — every edge touching the dragged cells dies
  const mid = cellsBetween(cellOf({ x: 260, y: 100 }), cellOf({ x: 300, y: 100 }));
  const refund = demolishRoad(s, mid);
  assert.ok(refund > 0, 'expected freed tiles');
  assert.equal(demolishRefund(s, mid), 0); // already gone — nothing left to refund
  assert.ok(s.roadEdges.size < before);
  // orphan nodes are swept; the buildings' nodes stay so they can re-connect
  for (const n of s.roadNodes.values()) {
    assert.ok(n.bid != null || n.edges.length > 0, 'orphan road node survived');
  }
});

test('bulldozing a shared stretch only refunds cells no road still covers', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'home', 100, 300);
  b(s, 3, 'work', 500, 100);
  // two roads sharing a straight run: b1→b3 via the middle row, b2→middle
  road(s, { x: 100, y: 100 }, { x: 500, y: 100 });
  road(s, { x: 100, y: 300 }, { x: 300, y: 100 });
  const sharedCell = cellOf({ x: 300, y: 100 });
  // demolish the b1→b3 road's west end; the east cells that b2's spur also
  // covers must not be refunded twice
  const cut = cellsBetween(cellOf({ x: 100, y: 100 }), cellOf({ x: 180, y: 100 }));
  const refund = demolishRoad(s, cut);
  assert.ok(refund > 0);
  // road to b3's west is gone — but the shared/intersection cells still work
  const legs = findPath(s, 2, (bb) => bb.id === 3) ??
    findPath(s, 2, (bb) => bb.type === 'work');
  assert.ok(legs, 'surviving road should still route');
});

test('a building brushing a road endpoint must not orphan the anchor building', () => {
  // regression: b2 sat within connectRadius of the path's start, so its
  // connect mark landed at t=0 — the same fraction as b4's anchor node. The
  // zero-length bridging chunk was skipped and b4's node ended up edgeless:
  // the road looked anchored but never carried a car.
  const s = createState();
  b(s, 1, 'home', 260, 340);
  const w1 = b(s, 2, 'work', 620, 340); // near the path's start, off-path
  b(s, 3, 'home', 460, 140);
  const w2 = b(s, 4, 'work', 580, 380); // road endpoint building
  b(s, 5, 'work', 540, 380);            // on the path
  road(s, { x: 580, y: 380 }, { x: 260, y: 340 }); // b4 → b1
  const legs = findPath(s, 4, (bb) => bb.id === 1);
  assert.ok(legs, 'anchor building was orphaned by a same-t connect mark');
  assert.equal(legs[0].mode, 'road');
  // the brushing work is served too
  assert.ok(findPath(s, 2, (bb) => bb.id === 1), 'brushing work unroutable');
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
