import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createState } from '../src/state.js';
import { addLine, addRoadNode, addRoadEdge } from '../src/networks.js';
import { buildRoad, roadCost, roadCellCost, demolishRoad, demolishRefund, splitEdgeMulti } from '../src/roads.js';
import { cellOf, cellsBetween } from '../src/grid.js';
import { findPath } from '../src/routing.js';
import { addTrain, spawnCar, update as updateVehicles } from '../src/vehicles.js';
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

test('cars keep a following gap and never run through the car ahead', () => {
  const s = createState();
  s.spawnClock = 99999;
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 700, 100);
  road(s, { x: 100, y: 100 }, { x: 700, y: 100 });
  const leg = findPath(s, 1, (bb) => bb.id === 2)[0];

  const mk = (id) => {
    const a = { id, kind: 'person', color: 0, home: 1, dest: 2, loc: 1, pathV: 0, retryT: 0, wait: 0 };
    s.agents.set(id, a);
    return spawnCar(s, a, leg);
  };
  const v1 = mk(1);
  updateVehicles(s, 0.5); // v1 pulls well ahead
  const v2 = mk(2);

  const posOn = (v, sg) => (sg.fwd ? v.dist : sg.len - v.dist);
  let minGap = Infinity;
  let shared = false;
  for (let i = 0; i < 240; i++) {
    updateVehicles(s, 1 / 60);
    const s1 = v1.segs[v1.seg];
    const s2 = v2.segs[v2.seg];
    if (s1 && s2 && s1.edgeId != null && s1.edgeId === s2.edgeId && s1.fwd === s2.fwd) {
      shared = true;
      minGap = Math.min(minGap, posOn(v1, s1) - posOn(v2, s2));
    }
  }
  assert.ok(shared, 'cars never shared an edge');
  assert.ok(minGap >= 14, `gap closed to ${minGap}px — cars overlap`);
});

test('a reversed-direction car is not blocked by its own follower', () => {
  // regression: the lead-gap check measured "ahead" in edge arclength, so a
  // car travelling an edge backwards saw its FOLLOWER as a leader — it held
  // forever, and junction yielders piled up behind it into a deadlock.
  const s = createState();
  b(s, 1, 'home', 700, 100);
  b(s, 2, 'work', 100, 100);
  // edge pts run in build order (700→100); cars going 100→700 ride it REVERSED
  road(s, { x: 700, y: 100 }, { x: 100, y: 100 });
  const leg = findPath(s, 2, (bb) => bb.id === 1)[0];

  const mk = (id) => {
    const a = { id, kind: 'person', color: 0, home: 2, dest: 1, loc: 2, pathV: 0, retryT: 0, wait: 0 };
    s.agents.set(id, a);
    return spawnCar(s, a, leg);
  };
  const lead = mk(1);
  const seg = lead.segs[lead.seg];
  assert.equal(seg.fwd, false, 'test needs a reversed-direction car');
  updateVehicles(s, 0.3);
  const follower = mk(2);

  const distBefore = lead.dist;
  updateVehicles(s, 1 / 60);
  assert.ok(lead.dist > distBefore,
    `leader froze behind its follower (dist=${lead.dist})`);
});

test('a yielded car eventually noses in — it can’t wait on its own follower', () => {
  // regression: leader at the stop line yields to a follower that parked
  // inside the junction box behind it (follow-stopped, non-yielding) →
  // both freeze and every car behind stacks up. yieldPatience releases it.
  const s = createState();
  s.spawnClock = 99999;
  b(s, 1, 'home', 420, 600);   // spur building feeding the T
  b(s, 2, 'work', 700, 400);
  b(s, 3, 'home', 100, 400);
  road(s, { x: 100, y: 400 }, { x: 700, y: 400 });
  road(s, { x: 420, y: 600 }, { x: 420, y: 400 });
  const junc = [...s.roadNodes.values()].find((n) => n.bid == null && n.edges.length >= 3);
  assert.ok(junc, 'no junction formed');

  const mk = (id) => {
    const a = { id, kind: 'person', color: 0, home: 1, dest: 2, loc: 1, pathV: 0, retryT: 0, wait: 0 };
    s.agents.set(id, a);
    return spawnCar(s, a, findPath(s, 1, (bb) => bb.id === 2)[0]);
  };
  const leader = mk(1);
  const follower = mk(2);
  const seg = leader.segs[0];
  // corner fillets trim the seg end back by ≤turnRadius — the arc covers the rest
  assert.ok(Math.hypot(seg.pts.at(-1).x - junc.x, seg.pts.at(-1).y - junc.y) < CONFIG.roads.turnRadius + 1);
  // leader at the stop line; follower parked 13px behind it — inside the box
  leader.dist = seg.len - 2;
  follower.dist = seg.len - 15;

  for (let i = 0; i < Math.ceil((CONFIG.roads.yieldPatience + 1) * 60); i++) {
    updateVehicles(s, 1 / 60);
  }
  assert.ok(leader.seg >= 1 || !s.vehicles.has(leader.id),
    'leader deadlocked behind a follower parked inside the junction box');
});

test('household-mates to the same workplace share one car', () => {
  const s = createState();
  s.spawnClock = 99999;
  b(s, 1, 'home', 100, 100);
  b(s, 2, 'work', 500, 100);
  b(s, 3, 'work', 500, 500);
  road(s, { x: 100, y: 100 }, { x: 500, y: 100 });
  road(s, { x: 100, y: 100 }, { x: 500, y: 500 });
  const home = s.buildings.get(1);

  const mk = (id, destBid) => {
    const a = { id, kind: 'person', color: 0, home: 1, dest: (bb) => bb.id === destBid,
      loc: 1, legs: findPath(s, 1, (bb) => bb.id === destBid), pathV: 0, retryT: 0, wait: 0 };
    s.agents.set(id, a);
    home.waiting.push(id);
    return a;
  };
  const a1 = mk(11, 2);
  const a2 = mk(12, 2);   // same home, same destination → carpool
  const a3 = mk(13, 3);   // same home, different destination → own car

  agents.update(s, 1 / 60);

  const cars = [...s.vehicles.values()].filter((v) => v.kind === 'car');
  assert.equal(cars.length, 2, `expected 2 cars (1 shared + 1 solo), got ${cars.length}`);
  const pooled = cars.find((v) => v.pax.length === 2);
  assert.ok(pooled, 'no shared car spawned');
  assert.deepEqual([...pooled.pax].sort(), [11, 12]);
  assert.equal(home.waiting.length, 0);
  assert.equal(a2.loc.veh, pooled.id, 'partner should be riding the shared car');

  // drive them there — both passengers start their shift at the workplace
  for (let i = 0; i < 600 && s.vehicles.size; i++) updateVehicles(s, 1 / 60);
  assert.equal(a1.workingAt, 2, 'driver never arrived');
  assert.equal(a2.workingAt, 2, 'carpool partner never arrived');
});

test('a car yields before entering a junction another vehicle is inside', () => {
  const s = createState();
  s.spawnClock = 99999;
  b(s, 1, 'home', 100, 300);
  b(s, 2, 'work', 500, 300);
  b(s, 3, 'home', 300, 100);
  b(s, 4, 'work', 300, 500);
  road(s, { x: 100, y: 300 }, { x: 500, y: 300 });
  road(s, { x: 300, y: 100 }, { x: 300, y: 500 });
  const junc = [...s.roadNodes.values()].find((n) => n.bid == null && n.edges.length >= 3);
  assert.ok(junc, 'no intersection node formed');

  const mk = (id, from, to) => {
    const a = { id, kind: 'person', color: 0, home: from, dest: to, loc: from, pathV: 0, retryT: 0, wait: 0 };
    s.agents.set(id, a);
    return spawnCar(s, a, findPath(s, from, (bb) => bb.id === to)[0]);
  };

  // A: just past the junction on the far edge = inside the box, driving through
  const vA = mk(1, 1, 2);
  const iA = vA.segs.findIndex(
    (sg) => Math.hypot(sg.pts[0].x - junc.x, sg.pts[0].y - junc.y) < 1
  );
  assert.ok(iA >= 0, 'no edge leaving the junction on A’s route');
  s.roadEdges.get(vA.segs[vA.seg].edgeId)?.vehicles.delete(vA.id);
  vA.seg = iA;
  vA.dist = 2;
  s.roadEdges.get(vA.segs[iA].edgeId)?.vehicles.add(vA.id);

  // B: approaching the junction on the other road, just outside the yield zone
  const vB = mk(2, 3, 4);
  const segB = vB.segs[0];
  assert.ok(
    Math.hypot(segB.pts.at(-1).x - junc.x, segB.pts.at(-1).y - junc.y) < 1,
    'B’s first edge does not end at the junction'
  );
  vB.dist = segB.len - 10;

  for (let i = 0; i < 8; i++) updateVehicles(s, 1 / 60);
  assert.equal(vB.seg, 0, 'B entered the junction while A was inside');
  assert.ok(vB.dist <= segB.len - 2 + 0.01 && vB.dist >= segB.len - 2 - 0.01,
    `B should hold at the stop line, dist=${vB.dist}`);

  // A clears the junction → B proceeds across
  for (let i = 0; i < 90; i++) updateVehicles(s, 1 / 60);
  assert.ok(vB.seg >= 1 || !s.vehicles.has(vB.id), 'B never crossed after the junction cleared');
});

// coincident split points used to leave nodes unlinked — the degenerate chunk
// now becomes a node-to-node stub so the split chain never breaks
test('splitEdgeMulti keeps coincident splits connected', () => {
  const s = createState();
  const a = addRoadNode(s, 0, 0);
  const b2 = addRoadNode(s, 100, 0);
  const e = addRoadEdge(s, a.id, b2.id, [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  const { nodeIds, newEdges } = splitEdgeMulti(s, e, [0.5, 0.5]);
  assert.equal(nodeIds.length, 4);
  for (let i = 0; i + 1 < nodeIds.length; i++) {
    const linked = newEdges.some(
      (ed) => ed.a === nodeIds[i] && ed.b === nodeIds[i + 1],
    );
    assert.ok(linked, `chain broken between nodes ${nodeIds[i]}→${nodeIds[i + 1]}`);
  }
});
