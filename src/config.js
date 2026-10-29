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
  homes: {
    residents: 2,           // a house has at most this many people out at once
  },
  work: {
    shiftLen: 25,           // seconds a worker stays on-site before commuting home
  },
  trains: {
    speed: 130,             // px/s
    capacity: 6,
    dwell: 0.8,             // seconds stopped at each stop
  },
  roads: {
    carSpeed: 90,
    truckSpeed: 70,
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
    tilesStart: 40,         // road budget at game start
    tilesPerWeek: 18,       // road budget granted each week
    tilesCap: 99,
  },
  food: {
    produceInterval: 6,     // seconds per crate at a staffed farm
    workersNeeded: 2,       // workers on-site to fully staff a farm/market
    shiftLen: 75,           // seconds an arrived worker stays on-shift
    stockpileCap: 10,
    hungerLimit: 90,        // seconds a home can go unfed
    pantryStart: 30,        // new homes spawn with this much food buffer
    hungryAt: 20,           // dispatch ignores homes hungrier than this ago only below threshold
    marketTrucksStart: 3,   // milkman trucks per market
    marketServeCap: 5,      // homes a market can handle per truck
    milkCap: 3,             // deliveries per milkman run
    crateCap: 4,            // crates per cargo wagon
    dispatchInterval: 2,    // seconds between market dispatch checks
    assignInterval: 3,      // seconds between home→market reassignment
  },
  buildings: { capacity: 6, radius: 13, homeRadius: 16, workRadius: 35, junctionRadius: 9 },
  junctions: {
    snap: 26,           // px — a junction click must land this close to a line
    maxLines: 3,        // the track it sits on plus two connecting lines
  },
  demand: {
    rate: 1,            // demandT seconds accumulated per second unserved
    relief: 18,         // seconds of demand each arriving worker clears
    limit: 90,          // meter full → game over
    grace: 15,          // new workplaces start with this much slack
    growth: 0.5,        // extra demand rate per level — L3 = 1 + 2×0.5 = 2× rate
    promoteEvery: 8,    // worker arrivals per level — a work upgrades as it's served
    maxLevel: 3,
  },
  overflowLimit: 25,        // seconds at/over capacity before game over
  weekSeconds: 60,
  lines: {
    maxStart: 3,
    width: 5,
  },
  colors: {
    // shared palette for buildings and the lines that serve them;
    // unlock one at a time as each colour's population grows
    palette: ['#e63946', '#457b9d', '#2a9d8f', '#e9a13b', '#9b5de5', '#00b4d8'],
    startUnlocked: 1,       // colours available at game start
    popToUnlock: 12,        // live people of a colour on the map to unlock the next
  },
  costs: {                  // routing weights
    transferPenalty: 6,
    stopPenalty: 0.6,
    boardWait: 3,
  },
};

export const SHAPES = { home: 'circle', work: 'square', farm: 'octagon', market: 'triangle' };
