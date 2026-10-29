import { CONFIG } from './config.js';
import { addTrain } from './vehicles.js';
import { getTool, setTool } from './input.js';

let el = {};
// last-rendered HUD values — DOM writes only happen on change, not per frame
let lastColorsHtml = '';
let lastRoad = -1;
let lastLines = -1;
let lastMotor = -1;
let lastRound = -1;
let lastLight = -1;

export const UPGRADES = [
  {
    name: 'New transit line',
    ok: () => true,
    apply: (s) => { s.maxLines++; },
  },
  {
    name: 'Add a train',
    ok: (s) => s.lines.size > 0,
    apply: (s) => {
      const lines = [...s.lines.values()];
      const target = lines.reduce((a, b) => (a.trains.length <= b.trains.length ? a : b));
      addTrain(s, target);
    },
  },
  {
    name: 'Larger buildings (+3 waiting space)',
    ok: () => true,
    apply: (s) => { for (const b of s.buildings.values()) b.capacity += 3; },
  },
  {
    name: 'Wider roads (+2 capacity)',
    ok: (s) => s.roadEdges.size > 0,
    apply: (s) => { s.roadCapBonus += 2; },
  },
  {
    name: 'Motorway (elevated express road)',
    ok: (s) => s.motorwayGranted && s.motorways < CONFIG.motorways.cap,
    apply: (s) => { s.motorways = Math.min(CONFIG.motorways.cap, s.motorways + 1); },
  },
  {
    name: 'Roundabout (free-flow junction)',
    ok: (s) => s.roundaboutGranted && s.roundabouts < CONFIG.roundabouts.cap,
    apply: (s) => { s.roundabouts = Math.min(CONFIG.roundabouts.cap, s.roundabouts + 1); },
  },
  {
    name: 'Traffic light (phase-controlled junction)',
    ok: (s) => s.trafficLightGranted && s.trafficLights < CONFIG.trafficLights.cap,
    apply: (s) => { s.trafficLights = Math.min(CONFIG.trafficLights.cap, s.trafficLights + 1); },
  },
  {
    name: '+12 road tiles',
    ok: () => true,
    apply: (s) => { s.roadTiles = Math.min(CONFIG.roads.tilesCap, s.roadTiles + 12); },
  },
  {
    name: 'Cargo wagon (freight by rail)',
    ok: (s) => [...s.lines.values()].some((l) => l.freight),
    apply: (s) => {
      const fs = [...s.lines.values()].filter((l) => l.freight);
      fs.reduce((a, b) => (a.wagons <= b.wagons ? a : b)).wagons++;
    },
  },
  {
    name: '+1 market delivery truck',
    ok: (s) => [...s.buildings.values()].some((b) => b.type === 'market'),
    apply: (s) => {
      const ms = [...s.buildings.values()].filter((b) => b.type === 'market');
      ms.reduce((a, b) => (a.trucks <= b.trucks ? a : b)).trucks++;
    },
  },
];

export function initUI(state) {
  el = {
    week: document.getElementById('hud-week'),
    weekFill: document.getElementById('week-bar-fill'),
    delivered: document.getElementById('hud-delivered'),
    pause: document.getElementById('btn-pause'),
    s1: document.getElementById('btn-1x'),
    s2: document.getElementById('btn-2x'),
    hotRoad: document.getElementById('hot-road'),
    hotLine: document.getElementById('hot-line'),
    hotJunction: document.getElementById('hot-junction'),
    subbar: document.getElementById('subbar'),
    hotBulldoze: document.getElementById('hot-bulldoze'),
    hotMotorway: document.getElementById('hot-motorway'),
    hotMotorCount: document.getElementById('hot-motor-count'),
    hotRoundabout: document.getElementById('hot-roundabout'),
    hotRoundCount: document.getElementById('hot-round-count'),
    hotLight: document.getElementById('hot-light'),
    hotLightCount: document.getElementById('hot-light-count'),
    roadbar: document.getElementById('roadbar'),
    hotRoadCount: document.getElementById('hot-road-count'),
    hotLineCount: document.getElementById('hot-line-count'),
    colors: document.getElementById('hud-colors'),
    freight: document.getElementById('hud-freight'),
    modal: document.getElementById('modal'),
    modalTitle: document.getElementById('modal-title'),
    modalOpts: document.getElementById('modal-options'),
    over: document.getElementById('gameover'),
    overReason: document.getElementById('gameover-reason'),
    overStats: document.getElementById('gameover-stats'),
    pauseMenu: document.getElementById('pausemenu'),
    pauseResume: document.getElementById('pause-resume'),
    pauseRestart: document.getElementById('pause-restart'),
  };
  el.pause.addEventListener('click', () => { state.paused = !state.paused; });
  el.pauseResume.addEventListener('click', () => { state.pauseMenu = false; state.paused = false; });
  el.pauseRestart.addEventListener('click', () => location.reload());
  el.s1.addEventListener('click', () => { state.speed = 1; });
  el.s2.addEventListener('click', () => { state.speed = 2; });
  el.hotLine.addEventListener('click', () => setTool('line'));
  el.hotRoad.addEventListener('click', () => setTool('road'));
  // junction is a sub-tool of the line group: re-clicking falls back to 'line'
  el.hotJunction.addEventListener('click', () =>
    setTool(getTool() === 'junction' ? 'line' : 'junction'));
  // bulldozer is a sub-tool of the road group: re-clicking falls back to 'road'
  el.hotBulldoze.addEventListener('click', () =>
    setTool(getTool() === 'bulldoze' ? 'road' : 'bulldoze'));
  // motorway likewise — armable only while a span is in stock
  el.hotMotorway.addEventListener('click', () => {
    if (state.motorways > 0) setTool(getTool() === 'motorway' ? 'road' : 'motorway');
  });
  // roundabout — same stock-gated pattern, click-to-place on junctions
  el.hotRoundabout.addEventListener('click', () => {
    if (state.roundabouts > 0) setTool(getTool() === 'roundabout' ? 'road' : 'roundabout');
  });
  // traffic light — armable with stock; clicking a lit junction always removes
  el.hotLight.addEventListener('click', () => {
    if (state.trafficLights > 0) setTool(getTool() === 'light' ? 'road' : 'light');
  });
}

export function updateHUD(state) {
  el.week.textContent = `Week ${state.week}`;
  el.weekFill.style.width = `${(state.weekT / CONFIG.weekSeconds) * 100}%`;
  el.delivered.textContent = state.delivered;
  el.freight.textContent = `${state.freightDelivered} food`;
  el.pause.innerHTML = state.paused ? '&#9654;' : '&#10074;&#10074;';
  el.pauseMenu.classList.toggle('hidden', !state.pauseMenu);
  el.s1.classList.toggle('on', state.speed === 1);
  el.s2.classList.toggle('on', state.speed === 2);
  const tool = getTool();
  const lineGroup = tool === 'line' || tool === 'junction';
  const roadGroup =
    tool === 'road' || tool === 'bulldoze' || tool === 'motorway' ||
    tool === 'roundabout' || tool === 'light';
  el.hotLine.classList.toggle('on', lineGroup);
  el.hotRoad.classList.toggle('on', roadGroup);
  el.subbar.classList.toggle('hidden', !lineGroup);
  el.roadbar.classList.toggle('hidden', !roadGroup);
  el.hotJunction.classList.toggle('on', tool === 'junction');
  el.hotBulldoze.classList.toggle('on', tool === 'bulldoze');
  // the motorway slot appears once the first one is granted; empty stock dims
  el.hotMotorway.classList.toggle('hidden', !state.motorwayGranted);
  el.hotMotorway.classList.toggle('on', tool === 'motorway');
  el.hotMotorway.classList.toggle('empty', state.motorways <= 0);
  if (lastMotor !== state.motorways) {
    lastMotor = state.motorways;
    el.hotMotorCount.textContent = state.motorways;
  }
  el.hotRoundabout.classList.toggle('hidden', !state.roundaboutGranted);
  el.hotRoundabout.classList.toggle('on', tool === 'roundabout');
  el.hotRoundabout.classList.toggle('empty', state.roundabouts <= 0);
  if (lastRound !== state.roundabouts) {
    lastRound = state.roundabouts;
    el.hotRoundCount.textContent = state.roundabouts;
  }
  el.hotLight.classList.toggle('hidden', !state.trafficLightGranted);
  el.hotLight.classList.toggle('on', tool === 'light');
  el.hotLight.classList.toggle('empty', state.trafficLights <= 0);
  if (lastLight !== state.trafficLights) {
    lastLight = state.trafficLights;
    el.hotLightCount.textContent = state.trafficLights;
  }
  if (lastRoad !== state.roadTiles) {
    lastRoad = state.roadTiles;
    el.hotRoadCount.textContent = state.roadTiles;
  }
  const linesLeft = state.maxLines - state.lines.size;
  if (lastLines !== linesLeft) {
    lastLines = linesLeft;
    el.hotLineCount.textContent = linesLeft;
  }

  // per-colour population dots; the next colour shows dimmed as it charges
  const counts = new Map();
  for (const a of state.agents.values()) {
    if (a.kind === 'person' && a.color != null) {
      counts.set(a.color, (counts.get(a.color) ?? 0) + 1);
    }
  }
  let html = '';
  const show = state.unlockedColors.length + 1; // unlocked + the next one
  for (let i = 0; i < Math.min(show, CONFIG.colors.palette.length); i++) {
    const unlocked = i < state.unlockedColors.length;
    const n = counts.get(i) ?? 0;
    html +=
      `<span class="cpair"${unlocked ? '' : ` title="${n}/${CONFIG.colors.popToUnlock} to unlock"`}>` +
      `<span class="cdot" style="background:${CONFIG.colors.palette[i]};opacity:${unlocked ? 1 : 0.35}"></span>` +
      `<span class="ccount">${n}</span></span>`;
  }
  if (html !== lastColorsHtml) {
    lastColorsHtml = html;
    el.colors.innerHTML = html;
  }
}

export function showUpgrade(state) {
  const valid = UPGRADES.filter((u) => u.ok(state));
  const picks = [];
  while (picks.length < 2 && valid.length) {
    const i = Math.floor(Math.random() * valid.length);
    picks.push(valid.splice(i, 1)[0]);
  }
  el.modalTitle.textContent = `Week ${state.week - 1} complete — choose an upgrade`;
  el.modalOpts.innerHTML = '';
  for (const u of picks) {
    const btn = document.createElement('button');
    btn.textContent = u.name;
    btn.addEventListener('click', () => {
      u.apply(state);
      state.upgradePending = false;
      el.modal.classList.add('hidden');
    });
    el.modalOpts.appendChild(btn);
  }
  el.modal.classList.remove('hidden');
}

export function showGameOver(state) {
  el.overReason.textContent = state.gameOver.reason;
  el.overStats.textContent =
    `${state.delivered} passengers and ${state.freightDelivered} food delivered over ` +
    `${state.week} week${state.week === 1 ? '' : 's'}`;
  el.over.classList.remove('hidden');
}
