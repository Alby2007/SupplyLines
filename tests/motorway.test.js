import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createState } from '../src/state.js';
import {
  buildRoad, buildMotorway, demolishRoad, roadCellIndex, polyLen,
} from '../src/roads.js';
import { cellOf, cellsBetween, cellKey } from '../src/grid.js';
import { findPath } from '../src/routing.js';
import { update as updateVehicles } from '../src/vehicles.js';
import * as economy from '../src/economy.js';

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

test('a motorway is one elevated edge with no ground cells', () => {
  const s = createState();
  const h = b(s, 1, 'home', 100, 100);
  const w = b(s, 2, 'work', 600, 100);
  road(s, h, w);

  const e = buildMotorway(s, [
    { x: 150, y: 100 }, { x: 150, y: 300 }, { x: 550, y: 300 }, { x: 550, y: 100 },
  ]);
  assert.ok(e, 'span rejected');
  assert.equal(e.motorway, true);
  // mid-span cells never register — surface roads can't join it mid-air
  const idx = roadCellIndex(s);
  for (const p of [{ x: 150, y: 300 }, { x: 350, y: 300 }, { x: 550, y: 300 }]) {
    assert.ok(!idx.has(cellKey(cellOf(p))), `motorway occupied cell at ${p.x},${p.y}`);
  }
});

test('a motorway passes over surface roads without splitting them', () => {
  const s = createState();
  const h = b(s, 1, 'home', 100, 100);
  const w = b(s, 2, 'work', 500, 100);
  road(s, h, w);                          // surface at y=100
  road(s, { x: 100, y: 700 }, { x: 500, y: 700 }); // surface at y=700

  const before = s.roadEdges.size;
  // anchored at the two buildings, dipping down and crossing the y=700 road twice
  buildMotorway(s, [
    { x: 100, y: 100 }, { x: 100, y: 700 }, { x: 500, y: 700 }, { x: 500, y: 100 },
  ]);
  // +1 for the motorway itself — the crossed road stays in one piece
  assert.equal(s.roadEdges.size, before + 1);
});

test('a motorway endpoint must land on the network', () => {
  const s = createState();
  const h = b(s, 1, 'home', 100, 100);
  const w = b(s, 2, 'work', 500, 100);
  road(s, h, w);
  // free-floating end in empty space → rejected
  assert.equal(
    buildMotorway(s, [{ x: 100, y: 100 }, { x: 300, y: 700 }]),
    null,
  );
  // same node at both ends → rejected
  assert.equal(
    buildMotorway(s, [{ x: 100, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 100 }]),
    null,
  );
});

test('routers prefer the motorway when it is the faster path', () => {
  const s = createState();
  const h = b(s, 1, 'home', 100, 100);
  const w = b(s, 2, 'work', 500, 100);
  // surface detour: down, across, up — ~1200px at surface speed
  road(s, h, { x: 100, y: 500 });
  road(s, { x: 100, y: 500 }, { x: 500, y: 500 });
  road(s, { x: 500, y: 500 }, w);
  // motorway: 400px straight at 1.6× speed
  const m = buildMotorway(s, [{ x: 100, y: 100 }, { x: 500, y: 100 }]);

  const legs = findPath(s, h.id, (bb) => bb.id === w.id);
  assert.ok(legs, 'no path');
  const edgeIds = legs.flatMap((l) => l.edgeIds ?? []);
  assert.ok(edgeIds.includes(m.id), 'router ignored the express edge');
});

test('vehicles cruise faster on a motorway than on the surface', () => {
  const s = createState();
  const h = b(s, 1, 'home', 100, 100);
  const w = b(s, 2, 'work', 500, 100);
  road(s, h, w);
  const m = buildMotorway(s, [{ x: 100, y: 100 }, { x: 500, y: 100 }]);

  const v = {
    id: 900, kind: 'car', color: 0,
    segs: [{ pts: m.pts, len: polyLen(m.pts), edgeId: m.id, fwd: true }],
    seg: 0, dist: 0, pax: [],
  };
  s.vehicles.set(v.id, v);
  m.vehicles.add(v.id);
  updateVehicles(s, 0.1);
  const expected = CONFIG.roads.carSpeed * CONFIG.motorways.speedFactor * 0.1;
  assert.ok(
    Math.abs(v.dist - expected) < 0.5,
    `expected ~${expected}px, got ${v.dist}`,
  );
});

test('bulldozing a motorway kills the span and refunds the item', () => {
  const s = createState();
  const h = b(s, 1, 'home', 100, 100);
  const w = b(s, 2, 'work', 500, 100);
  road(s, h, w);
  s.motorways = 3;
  const m = buildMotorway(s, [{ x: 100, y: 100 }, { x: 300, y: 300 }, { x: 500, y: 100 }]);
  s.motorways = 1; // simulate having spent the stock on the span

  const surfaceEdges = s.roadEdges.size - 1;
  demolishRoad(s, cellsBetween(cellOf({ x: 280, y: 280 }), cellOf({ x: 320, y: 320 })));
  assert.ok(!s.roadEdges.has(m.id), 'span survived the bulldozer');
  assert.equal(s.motorways, 2, 'item was not refunded');
  assert.equal(s.roadEdges.size, surfaceEdges, 'surface road was hit');
});

test('the first motorway is granted when week 3 ends', () => {
  const s = createState();
  economy.update(s, 1 / 60);
  assert.equal(s.motorways, 0);
  assert.equal(s.motorwayGranted, false);
  s.week = CONFIG.motorways.unlockWeek;
  economy.update(s, 1 / 60);
  assert.equal(s.motorways, 1);
  economy.update(s, 1 / 60);
  assert.equal(s.motorways, 1, 'grant fired twice');
});
