# Supply Lines — documentation

A browser logistics game: Mini Metro's colour-locked transit lines crossed with
Mini Motorways' road budget, demand meters, and traffic. Vanilla JavaScript ES
modules + HTML5 Canvas. No build step, no dependencies.

## Quick start

```sh
python3 serve.py        # http://localhost:8000 (adds no-store headers)
# or
python3 -m http.server 8000
npm test                # 110 tests, node:test, runs in ~1s
node autoplay.mjs --runs=12   # headless bot plays seeded games + postmortems
```

Open `index.html` through a local server — ES modules won't load from `file://`.

## The game in one paragraph

Buildings (homes, workplaces, farms, markets) spawn on a 40×32-cell world grid,
one every few seconds. You draw **roads** between them from a limited tile
budget and **transit lines** between buildings from a limited line count.
Residents commute to work; workplaces fill a demand meter while understaffed.
From week 2, farms produce crates that must reach markets, and markets dispatch
milk trucks to homes that are getting hungry. From week 4 the road toolkit
grows Mini Motorways-style hardware — **roundabouts**, **traffic lights**, and
**motorways** as countable items. Let any meter fill — workplace demand, home
hunger, or waiting-room overflow — and it's game over. Each 60-second week
grants road tiles and an upgrade pick.

## Contents

- [gameplay.md](gameplay.md) — controls, tools, buildings, meters, how to win/lose
- [architecture.md](architecture.md) — module map, the state object, tick loop, invariants
- [configuration.md](configuration.md) — every `CONFIG` knob and what reads it
- [testing.md](testing.md) — test suite layout, conventions, the headless autoplayer

System deep dives, in `systems/`:

- [spawning.md](systems/spawning.md) — building placement, colours, colour unlocks
- [roads.md](systems/roads.md) — road graph model, building/splitting, traffic, bulldozer
- [transit.md](systems/transit.md) — lines, trains, junctions, freight, demolition
- [agents.md](systems/agents.md) — agent lifecycle, legs, carpooling, shifts
- [routing.md](systems/routing.md) — the unified multimodal graph and pathfinding
- [food.md](systems/food.md) — the farm → market → home chain end to end
- [economy.md](systems/economy.md) — demand/hunger/overflow meters, weeks, upgrades

## Source map

| File | Responsibility |
|---|---|
| `src/config.js` | All tuning constants + shape table |
| `src/state.js` | `createState()`, `nid()`, `dist()`, `applyLevelFeatures()` |
| `src/terrain.js` | Deterministic river generator (seeded noise → water cells) |
| `src/grid.js` | Cell math: Bresenham paths, metro routing, polyline utils |
| `src/spawn.js` | Building placement, type/colour choice, colour unlocks |
| `src/roads.js` | Road nodes/edges, splitting, cell index, bulldozer, snapping |
| `src/motorways.js` | Elevated motorway anchoring + span building |
| `src/roundabouts.js` | Roundabout stamping, junction replacement, ghosts |
| `src/lights.js` | Traffic-light placement, phase groups, ghosts |
| `src/networks.js` | Lines, junctions, cell indexes, line/junction demolition |
| `src/routing.js` | Multimodal graph + Dijkstra, congestion, graph cache |
| `src/agents.js` | Agent update loop, destinations, carpooling, presence counts |
| `src/vehicles.js` | Trains, cars, food/milk trucks, arrival resolution, traffic |
| `src/food.js` | Farm production, market assignment, milk-truck dispatch |
| `src/economy.js` | Demand/hunger/overflow meters, game-over detection |
| `src/input.js` | Pointer/keyboard → drafts, tools, camera |
| `src/render.js` | Canvas drawing |
| `src/ui.js` | HUD, upgrade modal, game-over card |
| `src/main.js` | Fixed-step loop, wiring |
| `autoplay.mjs` | Headless autoplayer — drives the real sim, prints postmortems |
