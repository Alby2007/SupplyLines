import { GEN_LEVELS } from './genlevels.js';

export const CONFIG = {
  map: {
    width: 1600,            // world px — 40 cells wide
    height: 1280,           // world px — 32 cells (1280 tiles total)
    margin: 90,
  },
  view: {
    width: 1280,            // viewport px — 32×20 = 640 tiles visible
    height: 800,
  },
  grid: {
    cell: 40,               // px — world grid tile size
  },
  // per-map overrides, applied on top of the base CONFIG at boot (main.js) —
  // each level may differ in world size, spawn pacing, budgets, etc.
  levels: {
    2: {
      map: { width: 3200, height: 1280 },  // 80×32 cells — double Map 1's tiles
      // faster cruise compresses the 2× distance; the tile bump covers the
      // new-colour onboarding burst (a colour lands with ~6 homes + work and
      // every one needs a road before its commuters exist)
      roads: { carSpeed: 110, truckSpeed: 85, tilesStart: 50, tilesPerWeek: 22 },
      // desert oasis: 16 cells of impassable water at a fixed spot — roads
      // and building spawns can't touch it
      water: {
        at: { cx: 54, cy: 11 },
        cells: [
          [1, 0], [2, 0],
          [0, 1], [1, 1], [2, 1], [3, 1],
          [0, 2], [1, 2], [2, 2], [3, 2], [4, 2],
          [2, 3], [3, 3], [4, 3],
          [2, 4], [3, 4],
        ],
        fill: '#9fcbe0',             // dusty sky blue, sits easy on the sand
        edge: '#7cb2c7',
      },
    },
    3: {
      map: { width: 3200, height: 1280 },  // same 80×32 canvas as Map 2
      // same distance-compensation budgets — they're about map size, not theme
      roads: { carSpeed: 110, truckSpeed: 85, tilesStart: 50, tilesPerWeek: 22 },
      spawn: { seedBias: 'right' },        // opening city forms on the right
      water: {
        // vertical river through the middle-third columns, ≥6 cells thick —
        // the right-seeded city's western gate; motorways and transit lines
        // are the only way across (fixed seed → same river every game)
        river: { center: 40, meander: 4.2, minHalf: 3, wobble: 2.2, seed: 11 },
        fill: '#71b3d6',                   // deeper than the oasis's dusty sky
        edge: '#5398bf',
      },
      // MM bridges: no tool — a road drawn across water auto-spends one per
      // water cell it covers. Map-3-only section; other maps never create it
      bridges: {
        unlockWeek: 2,     // gifted automatically once week 1 is done
        grant: 12,         // the gift — ~1 full river crossing plus slack
        pick: 8,           // bridges awarded when picked from upgrades
        cap: 36,
      },
      // the river tax is real — softer star thresholds than the open maps
      win: { stars: [4, 7, 10] },
    },
    ...GEN_LEVELS,     // generated suite — IDs 101+, emitted by src/genmaps.mjs
  },
  spawn: {
    intervalStart: 14,      // seconds between new buildings at week 1
    intervalMin: 8,
    intervalRamp: 0.6,      // interval shrinks by this much per week
    warnTime: 3,            // building shows "incoming" outline this long before opening
    minDist: 110,           // min px between buildings
    maxTries: 60,
    homeRatio: 0.65,        // target fraction of homes among home+work spawns
    foodStartWeek: 2,       // farms/markets begin spawning this week (phase 3)
    homesPerMarket: 4,      // pacing: ~1 market per this many homes
    marketsPerFarm: 2,      // pacing: ~1 farm per this many markets
    homesPerWork: 4,        // a workplace may only spawn once this many homes exist per work
    cityReach: 10,          // cells — new buildings must spawn within this of the city
  },
  commuters: {
    interval: 5,            // avg seconds between commuter spawns per home
    jitter: 0.6,            // 1±jitter multiplier
  },
  // weekly rush hour — a predictable surge: every week at the same weekT
  // offset, commuter spawn clocks run `mul`× fast for `len` seconds, so the
  // city empties onto the network on a schedule that can be prepared for
  rush: {
    firstWeek: 2,           // rushes begin once week 1 is done
    at: 0.3,                // fraction into the week the surge starts
    len: 20,                // seconds of compressed spawn clocks
    // commuter clock speed inside the window
    mul: (typeof process !== 'undefined' && +process.env.NORUSH) ? 1 : 2.5,
  },
  // subdivision tracts — occasionally a small same-colour estate lands at the
  // city edge as one piece: a mini onboarding burst between colour unlocks
  subdivision: {
    first: (typeof process !== 'undefined' && +process.env.NOSUBDIV)
      ? Infinity : 130,     // seconds until the first tract can land
    every: 130,             // mean seconds between tracts (±30% jitter)
    sizeMin: 2, sizeMax: 4, // homes per tract — all one colour
    ringMin: 6, ringMax: 10,// cells outward from the anchor building
    span: 3,                // half-extent of the tract's placement region
    warn: 12,               // seconds of "incoming" before tract homes open —
                            // a whole estate at 3s is unanswerable; 12s is a
                            // staging decision (pre-connect or hold the tiles)
  },
  // congestion stress: a building whose frontage edges are saturated feels
  // the jam as pressure, not just delay — meters accrue up to (1+gain)× fast.
  // It makes bypasses instrumentally valuable for a second reason besides
  // speed, which is what makes road hierarchy worth learning.
  stress: { gain: (typeof process !== 'undefined' && +process.env.NOSTRESS) ? 0 : 0.5 },
  // walking: buildings within `catch` px are walk-linked — slow, free, and
  // congestion-immune. Short hops walk instead of calling a car, and homes
  // near a line's stop get rail access without road frontage.
  walk: { speed: 34, catch: 66 },
  homes: {
    residents: 3,           // a house has at most this many people out at once
  },
  work: {
    shiftLen: 18,           // seconds a worker stays on-site before commuting home
  },
  trains: {
    speed: 130,             // px/s
    capacity: 6,
    dwell: 0.8,             // seconds stopped at each stop
  },
  // buses: transit lines that run over existing roads instead of track —
  // free to create and no line-slot cost, but they move at car speed and
  // share congestion like any other road user. The modal choice: rail is
  // traffic-immune and slot-expensive, bus is free and traffic-exposed.
  bus: {
    max: 4,                 // bus route slots, independent of maxLines
    capacity: 8,            // riders per bus
    buses: 2,               // vehicles per route — a lone bus's headway loses
    firstWeek: 3,           // buses unlock when motorways do (mid-game tool)
    // routed hops price below raw road time: a rider on a scheduled bus is
    // one fewer car feeding the jam — the discount internalizes that
    // externality so buses win exactly where the roads are hurting
    discount: 0.8,
  },
  roads: {
    carSpeed: 90,
    truckSpeed: 85,
    width: 16,              // px — two visible lanes
    laneOffset: 4,          // px — vehicles keep right of the centre line
    congestAt: 6,           // vehicles on an edge before slowdown kicks in
    congestFactor: 0.45,    // speed multiplier at full congestion
    maxPerEdge: 12,
    snap: 26,               // px — endpoints snap to buildings/roads within this
    followGap: 16,          // px centre-to-centre spacing cars keep while queued
    yieldLookahead: 14,     // px before a node where junction checks engage
    junctionBox: 16,        // px radius around a node that counts as "in the junction"
    yieldPatience: 1.5,     // s a yielded car waits before nosing in anyway
    turnRadius: 12,         // px — corner fillet radius on vehicle paths
    tilesStart: 40,         // road budget at game start
    tilesPerWeek: 18,       // road budget granted each week
    tilesCap: 99,
  },
  motorways: {
    // MM motorways: elevated free-form spans that hop over the surface
    // network — cost zero tiles, capped as a countable item
    speedFactor: 1.6,       // × car speed while on the elevated edge
    unlockWeek: 4,          // first one granted once week 3 is done
    cap: 9,                 // MM parity — the game stops offering them at 9
    width: 18,              // px — chunkier than surface roads
  },
  roundabouts: {
    // MM roundabouts: swap a junction node for a one-way circulating ring —
    // entering cars yield once, circulating cars never stop inside
    unlockWeek: 4,          // first one granted once week 3 is done
    cap: 9,
    radius: 17,             // px — ring centre to ring nodes
  },
  trafficLights: {
    // MM traffic lights: a junction cycles green phases between arm groups —
    // red arms hold unconditionally, so a dominant road can't starve a side
    // road the way yield-to-occupied does
    unlockWeek: 4,
    cap: 9,
    phase: 2.2,             // seconds each arm group holds the green
  },
  food: {
    produceInterval: 3,     // seconds per crate at a staffed farm
    workersNeeded: 2,       // workers on-site to fully staff a farm/market
    shiftLen: 180,          // seconds an arrived worker stays on-shift
    stockpileCap: 10,
    hungerLimit: 120,       // seconds a home can go unfed
    pantryStart: 40,        // new homes spawn with this much food buffer
    hungryAt: 10,           // dispatch ignores homes hungrier than this ago only below threshold
    marketTrucksStart: 3,   // milkman trucks per market
    marketServeCap: 5,      // homes a market can handle per truck
    milkCap: 6,             // deliveries per milkman run
    crateCap: 4,            // crates per cargo wagon
    dispatchInterval: 2,    // seconds between market dispatch checks
    assignInterval: 3,      // seconds between home→market reassignment
    hireCost: 4,            // road tiles per hired market driver (RL/action lever)
    hireLen: 180,           // seconds a hired driver works (one shift)
  },
  buildings: { capacity: 6, radius: 13, homeRadius: 16, workRadius: 35, junctionRadius: 9 },
  junctions: {
    snap: 26,           // px — a junction click must land this close to a line
    maxLines: 3,        // the track it sits on plus two connecting lines
  },
  demand: {
    rate: 1,            // demandT seconds accumulated per second unserved
    relief: 24,         // seconds of demand each arriving worker clears
    limit: 90,          // meter full → game over
    grace: 15,          // new workplaces start with this much slack
    growth: 0.15,       // extra demand rate per level — L3 = 1 + 2×0.15 = 1.3× rate
    promoteEvery: 20,   // worker arrivals per level — a work upgrades as it's served
    maxLevel: 3,
  },
  overflowLimit: 25,        // seconds at/over capacity before game over
  weekSeconds: 60,
  // stars earned by the week you reach: die during week 5 → ★ at threshold 5.
  // Levels may override the whole list (Map 3 runs easier targets)
  win: { stars: [5, 8, 11] },
  lines: {
    maxStart: 3,
    width: 5,
  },
  colors: {
    // shared palette for buildings and the lines that serve them;
    // unlock one at a time as each colour's population grows
    palette: ['#e63946', '#457b9d', '#2a9d8f', '#e9a13b', '#9b5de5', '#00b4d8'],
    startUnlocked: 1,       // colours available at game start
    popToUnlock: 16,        // live people of a colour on the map to unlock the next
  },
  costs: {                  // routing weights
    transferPenalty: 6,
    stopPenalty: 0.6,
    boardWait: 3,
    // curb time — parking/unparking at each end of a car trip. It's the
    // hidden cost that makes scheduled transit worth boarding at all:
    // without it a ride can never beat a frictionless drive.
    parkPenalty: (typeof process !== 'undefined' && +process.env.NOPARK) ? 0 : 4,
  },
};

// merge a level's overrides onto CONFIG — must tolerate sections that only
// exist in the level def (e.g. `water`), which is why it's not a bare assign
export function applyLevelOverrides(level) {
  for (const [k, v] of Object.entries(CONFIG.levels?.[level] ?? {})) {
    CONFIG[k] = Object.assign(CONFIG[k] ?? {}, v);
  }
}

export const SHAPES = { home: 'circle', work: 'square', farm: 'octagon', market: 'triangle' };
