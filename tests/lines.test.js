import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/state.js';
import { addLine, extendLine, lineSegPts, addJunction, insertJunction, removeJunction, deleteLine, demolishLines } from '../src/networks.js';
import { addTrain, trainPos, update as updateVehicles } from '../src/vehicles.js';
import { cellOf, cellsBetween } from '../src/grid.js';

function b(state, id, type, x, y) {
  state.buildings.set(id, {
    id, type, x, y, active: true, waiting: [], capacity: 6, overflowT: 0, spawnClock: 2,
  });
}

function mkAgent(s, id, legs) {
  const a = { id, kind: 'person', color: 0, home: 1, dest: null, loc: null, legs, pathV: 0, retryT: 0, wait: 0 };
  s.agents.set(id, a);
  return a;
}

function runTicks(s, n) {
  for (let i = 0; i < n; i++) updateVehicles(s, 1 / 60);
}

test('extending a line appends stops in drag order', () => {
  const s = createState();
  b(s, 1, 'home', 400, 200);
  b(s, 2, 'work', 600, 200);
  b(s, 3, 'home', 800, 200);
  const line = addLine(s, [1, 2]);
  extendLine(s, line, [3], false);
  assert.deepEqual(line.stops, [1, 2, 3]);
});

// draft.stops = [anchor, ...added in drag order]; from a line's head the drag
// runs outward, so the added stops must be inserted reversed — the last stop
// dragged is the new terminus, the first stays the anchor's neighbour
test('prepending inserts stops anchor-outward so the line follows the drag', () => {
  const s = createState();
  b(s, 1, 'home', 400, 200); // B — stops[0]
  b(s, 2, 'work', 600, 200); // C
  const line = addLine(s, [1, 2]);
  b(s, 3, 'home', 200, 400); // X
  b(s, 4, 'home', 400, 400); // Y
  // user dragged B → X → Y: added = [X, Y]; terminus must be Y, and X must be
  // B's neighbour — not a stray Y→B hop that skips X
  extendLine(s, line, [3, 4], true);
  assert.deepEqual(line.stops, [4, 3, 1, 2]);
  const seg = lineSegPts(s, 3, 1); // X→B segment follows the drag
  assert.equal(seg[0].x, 200);
  assert.equal(seg[0].y, 400);
});

test('prepending shifts train.from so trains stay on their stops', () => {
  const s = createState();
  b(s, 1, 'home', 400, 200);
  b(s, 2, 'work', 600, 200);
  const line = addLine(s, [1, 2]);
  const t = addTrain(s, line);
  b(s, 3, 'home', 200, 400);
  b(s, 4, 'home', 400, 400);
  extendLine(s, line, [3, 4], true);
  assert.equal(line.stops[t.from], 1, 'train teleported to the new head');
  assert.deepEqual(trainPos(s, t), { x: 400, y: 200, angle: 0 });
});

// closing a loop by dragging from a line's head onto its far endpoint used to
// leave the far stop duplicated at the tail — with reversed prepend the
// duplicate lands at stops[0] where the existing loop check catches it
test('prepend onto the far endpoint closes a loop', () => {
  const s = createState();
  b(s, 1, 'home', 200, 200); // A — stops[0]
  b(s, 2, 'work', 400, 200); // B
  b(s, 3, 'home', 600, 200); // C — stops[last]
  const line = addLine(s, [1, 2, 3]);
  b(s, 4, 'home', 400, 500); // S
  // drag A → S → C (far endpoint): added = [S, C]
  extendLine(s, line, [4, 3], true);
  assert.equal(line.loop, true);
  assert.deepEqual(line.stops, [3, 4, 1, 2]); // C appears once — no doubled tail
});

test('append onto the far endpoint still closes a loop', () => {
  const s = createState();
  b(s, 1, 'home', 200, 200);
  b(s, 2, 'work', 400, 200);
  b(s, 3, 'home', 600, 200);
  const line = addLine(s, [1, 2, 3]);
  b(s, 4, 'home', 400, 500);
  extendLine(s, line, [4, 1], false); // drag C → S → A
  assert.equal(line.loop, true);
  assert.deepEqual(line.stops, [1, 2, 3, 4]);
});

// ---- demolition ----

test('demolishLines deletes a line and dumps riders at their stop', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 400, 100);
  const line = addLine(s, [1, 2]);
  const t = addTrain(s, line);
  const a = mkAgent(s, 90, [{ mode: 'line', lineId: line.id, to: 2 }]);
  a.loc = { veh: t.id };
  t.pax.push(a.id);

  demolishLines(s, cellsBetween(cellOf({ x: 100, y: 100 }), cellOf({ x: 400, y: 100 })));

  assert.equal(s.lines.size, 0, 'line should be deleted');
  assert.equal(s.vehicles.size, 0, 'trains should despawn');
  assert.equal(a.loc, 1, 'rider should be dumped at the train\'s stop');
  assert.ok(s.buildings.get(1).waiting.includes(a.id));
  assert.equal(a.legs, null, 'rider should repath from the dumped stop');
});

test('deleting a line sweeps junctions left without service', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 400, 100);
  const line = addLine(s, [1, 2]);
  const j = addJunction(s, 250, 100, 0);
  insertJunction(s, j, line, 0); // stops: [1, j, 2]

  demolishLines(s, cellsBetween(cellOf({ x: 100, y: 100 }), cellOf({ x: 400, y: 100 })));

  assert.equal(s.lines.size, 0);
  assert.ok(!s.buildings.has(j.id), 'orphan junction should be removed');
});

test('removeJunction un-splices a junction and keeps the line', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 400, 100);
  const line = addLine(s, [1, 2]);
  const t = addTrain(s, line);
  const j = addJunction(s, 250, 100, 0);
  insertJunction(s, j, line, 0); // stops: [1, j, 2]
  const a = mkAgent(s, 90, [{ mode: 'line', lineId: line.id, to: j.id }]);
  a.loc = { veh: t.id };
  t.pax.push(a.id);

  removeJunction(s, j);

  assert.deepEqual(line.stops, [1, 2], 'junction spliced out, line survives');
  assert.ok(!s.buildings.has(j.id));
  assert.equal(a.legs, null, 'rider heading for the junction should repath');
});

test('a rider whose destination vanished alights at the next stop', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 400, 100);
  const line = addLine(s, [1, 2]);
  const t = addTrain(s, line);
  const a = mkAgent(s, 90, null); // legs nulled by a deletion mid-ride
  a.loc = { veh: t.id };
  t.pax.push(a.id);

  runTicks(s, 300); // dwell + A→B at ~130px/s over ~300px

  assert.equal(a.loc, 2, 'stranded rider should get off at the next stop');
  assert.ok(s.buildings.get(2).waiting.includes(a.id));
  assert.equal(t.pax.length, 0);
});

test('deleteLine removes a junction still on a surviving line only if orphan', () => {
  const s = createState();
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 400, 100);
  b(s, 3, 'home', 700, 100);
  const lineA = addLine(s, [1, 2]);
  const lineB = addLine(s, [2, 3]);
  const j = addJunction(s, 250, 100, 0);
  insertJunction(s, j, lineA, 0);
  // pretend junction also sits on lineB
  lineB.stops.splice(1, 0, j.id);

  deleteLine(s, lineA);

  assert.equal(s.lines.size, 1, 'lineB survives');
  assert.ok(s.buildings.has(j.id), 'junction still serves lineB — kept');
  assert.ok(lineB.stops.includes(j.id));
});
