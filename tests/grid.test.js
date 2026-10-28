import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createState } from '../src/state.js';
import {
  cellOf, cellCenter, cellKey, cellsBetween, cellsAlongPolyline,
  routeCells, routePts,
} from '../src/grid.js';
import { buildRoad, roadCellIndex } from '../src/roads.js';
import { lineSegPts, addLine } from '../src/networks.js';
import { findPath } from '../src/routing.js';
import { placeBuilding, seedInitial } from '../src/spawn.js';

const CS = CONFIG.grid.cell;

test('cellOf / cellCenter round-trip', () => {
  assert.deepEqual(cellOf({ x: 0, y: 0 }), { cx: 0, cy: 0 });
  assert.deepEqual(cellOf({ x: CS * 2 + 19, y: CS * 3 + 1 }), { cx: 2, cy: 3 });
  const c = cellCenter(4, 5);
  assert.deepEqual(cellOf(c), { cx: 4, cy: 5 });
  assert.equal(c.x, 4 * CS + CS / 2);
});

test('cellsBetween produces contiguous inclusive cell paths', () => {
  const cells = cellsBetween({ cx: 2, cy: 2 }, { cx: 7, cy: 4 });
  assert.deepEqual(cells[0], { cx: 2, cy: 2 });
  assert.deepEqual(cells[cells.length - 1], { cx: 7, cy: 4 });
  for (let i = 1; i < cells.length; i++) {
    const dx = Math.abs(cells[i].cx - cells[i - 1].cx);
    const dy = Math.abs(cells[i].cy - cells[i - 1].cy);
    assert.ok(dx <= 1 && dy <= 1 && dx + dy > 0, `gap at ${i}`);
  }
});

test('routeCells bends at most once: diagonal then straight', () => {
  for (const [a, b] of [
    [{ cx: 2, cy: 2 }, { cx: 10, cy: 8 }],
    [{ cx: 10, cy: 2 }, { cx: 2, cy: 9 }],
    [{ cx: 3, cy: 3 }, { cx: 9, cy: 3 }],   // straight row
    [{ cx: 4, cy: 1 }, { cx: 4, cy: 12 }],  // straight column
  ]) {
    const cells = routeCells(a, b);
    let bends = 0;
    for (let i = 2; i < cells.length; i++) {
      const d1 = [cells[i - 1].cx - cells[i - 2].cx, cells[i - 1].cy - cells[i - 2].cy];
      const d2 = [cells[i].cx - cells[i - 1].cx, cells[i].cy - cells[i - 1].cy];
      if (d1[0] !== d2[0] || d1[1] !== d2[1]) bends++;
    }
    assert.ok(bends <= 1, `${JSON.stringify(a)}→${JSON.stringify(b)} had ${bends} bends`);
  }
});

test('routePts returns world polyline pinned to endpoints', () => {
  const a = { x: 105, y: 103 };
  const b = { x: 407, y: 205 };
  const pts = routePts(a, b);
  assert.deepEqual(pts[0], { x: 105, y: 103 });
  assert.deepEqual(pts[pts.length - 1], { x: 407, y: 205 });
  for (const p of pts.slice(1, -1)) {
    assert.equal(p.x % (CS / 2), 0, 'interior points on cell centers');
  }
});

test('lineSegPts routes a line segment along the grid', () => {
  const s = createState();
  s.buildings.set(1, { id: 1, x: 100, y: 100 });
  s.buildings.set(2, { id: 2, x: 300, y: 220 });
  const pts = lineSegPts(s, 1, 2);
  assert.ok(pts.length >= 2);
  assert.deepEqual(pts[0], { x: 100, y: 100 });
  assert.deepEqual(pts[pts.length - 1], { x: 300, y: 220 });
});

test('spawned buildings snap to the grid with ≥3-cell spacing', () => {
  const s = createState();
  seedInitial(s);
  for (let i = 0; i < 10; i++) placeBuilding(s, i % 2 ? 'home' : 'work', true);
  const cells = [...s.buildings.values()].map((b) => cellOf(b));
  for (const b of s.buildings.values()) {
    if (b.type === 'work') {
      // works are centred on a grid vertex spanning a 2×2 cell block
      assert.equal(b.x % CS, 0, 'work not on a grid vertex');
      assert.equal(b.y % CS, 0, 'work not on a grid vertex');
    } else {
      const c = cellCenter(cellOf(b).cx, cellOf(b).cy);
      assert.deepEqual({ x: b.x, y: b.y }, c, 'building off cell center');
    }
  }
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const d = Math.max(Math.abs(cells[i].cx - cells[j].cx), Math.abs(cells[i].cy - cells[j].cy));
      assert.ok(d >= 3, `cells ${cellKey(cells[i])} and ${cellKey(cells[j])} too close`);
    }
  }
});

function b(state, id, type, x, y) {
  state.buildings.set(id, {
    id, type, x, y, active: true, waiting: [], capacity: 6, overflowT: 0, spawnClock: 2,
  });
}

test('orthogonal roads sharing a cell join at an intersection', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);   // cell (2,2)
  b(s, 2, 'work', 100, 340);   // cell (2,8)
  b(s, 3, 'work', 500, 220);   // cell (12,5)
  b(s, 4, 'work', 500, 100);   // cell (12,2)
  // vertical road through column cx=2, then horizontal road through row cy=5
  // → they share cell (2,5)… actually road1 is col 2 (cy 2..8), road2 row 5 (cx 2..12)
  buildRoad(s, cellsBetween({ cx: 2, cy: 2 }, { cx: 2, cy: 8 }));
  const before = s.roadEdges.size;
  buildRoad(s, cellsBetween({ cx: 2, cy: 5 }, { cx: 12, cy: 5 }));
  assert.ok(s.roadEdges.size > before + 1, 'shared cell should split the old edge');

  // path from home (cell 2,2) down col 2 then across row 5 to work at (500,220)
  const legs = findPath(s, 1, (bb) => bb.id === 3);
  assert.ok(legs, 'no path through shared-cell intersection');
  assert.ok(legs[0].nodes.some((n) => n.startsWith('r')), 'expected an intersection node');
});

test('train traveling backwards stays on the drawn segment polyline', async () => {
  const { trainPos } = await import('../src/vehicles.js');
  const s = createState();
  b(s, 1, 'home', 100, 260);
  b(s, 2, 'work', 500, 100);
  const line = addLine(s, [1, 2]);
  // simulate a train heading from stop 1 back toward stop 0, mid-segment
  const v = { line: line.id, from: 1, dir: -1, t: 0.5, dwellT: 0, pax: [] };
  const pos = trainPos(s, v);
  const pts = lineSegPts(s, 1, 2);
  const onSeg = pts.some((p, i) => {
    if (i === 0) return false;
    // point lies on one of the drawn sub-segments (within a couple px)
    const [a2, b2] = [pts[i - 1], p];
    const len = Math.hypot(b2.x - a2.x, b2.y - a2.y);
    const d = Math.abs((b2.x - a2.x) * (a2.y - pos.y) - (a2.x - pos.x) * (b2.y - a2.y)) / len;
    const dot = (pos.x - a2.x) * (b2.x - a2.x) + (pos.y - a2.y) * (b2.y - a2.y);
    return d < 2 && dot >= -1 && dot <= len * len + 1;
  });
  assert.ok(onSeg, `train at ${pos.x},${pos.y} left the drawn polyline`);
  // exact spot: midpoint of the drawn polyline
  const { pointAtLen, polyLen } = await import('../src/roads.js');
  const expect = pointAtLen(pts, polyLen(pts) * 0.5);
  assert.ok(Math.hypot(pos.x - expect.x, pos.y - expect.y) < 1);
});

test('road cell index covers every edge cell', () => {
  const s = createState();
  buildRoad(s, cellsBetween({ cx: 2, cy: 2 }, { cx: 5, cy: 5 }));
  const idx = roadCellIndex(s);
  assert.ok(idx.has(cellKey({ cx: 3, cy: 3 })));
  assert.ok(idx.has(cellKey({ cx: 4, cy: 4 })));
  assert.ok(!idx.has(cellKey({ cx: 3, cy: 4 })));
});

test('cellsAlongPolyline covers traversed cells', () => {
  const cells = cellsAlongPolyline([{ x: 10, y: 10 }, { x: 130, y: 10 }]);
  const keys = new Set(cells.map(cellKey));
  for (const k of ['0,0', '1,0', '2,0', '3,0']) assert.ok(keys.has(k), `missing ${k}`);
});

test('buildings never spawn on road cells — only the one free tile works', () => {
  const s = createState();
  // pave every spawnable row of the 40×32 world (cy 3..28, cx 3..36)
  // except leave (15,8) open
  for (let cy = 3; cy <= 28; cy++) {
    if (cy === 8) {
      buildRoad(s, cellsBetween({ cx: 3, cy: 8 }, { cx: 14, cy: 8 }));
      buildRoad(s, cellsBetween({ cx: 16, cy: 8 }, { cx: 36, cy: 8 }));
    } else {
      buildRoad(s, cellsBetween({ cx: 3, cy }, { cx: 36, cy }));
    }
  }
  let placed = null;
  for (let i = 0; i < 50 && !placed; i++) placed = placeBuilding(s, 'home', true);
  assert.ok(placed, 'no valid spawn found despite a free tile');
  assert.deepEqual(cellOf(placed), { cx: 15, cy: 8 });
});
