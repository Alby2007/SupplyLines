// procedural terrain — river generation for level water defs. Deterministic:
// the def's fixed seed means every city on the level meets the same river,
// like Map 2's hand-placed oasis — terrain never depends on Math.random.

// mulberry32 — tiny seeded PRNG
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1-D smoothed noise: random knots averaged over a window → gentle curves
// rather than per-cell jitter (radius 0 = raw noise for edge bites)
function smoothNoise(rand, n, radius) {
  const raw = Array.from({ length: n }, () => rand() * 2 - 1);
  return raw.map((_, i) => {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) {
      sum += raw[j]; cnt++;
    }
    return sum / cnt;
  });
}

// vertical river wandering the middle third. Every row keeps >= minHalf cells
// on each bank (≥ minHalf*2 thick); banks drift on independent smoothed walks
// with occasional one-cell protrusions, so the shoreline reads natural rather
// than a mirrored or ruled edge.
export function riverCells(def, cols, rows) {
  const rand = prng(def.seed ?? 7);
  const meander = smoothNoise(rand, rows, 4);
  const wobL = smoothNoise(rand, rows, 2);
  const wobR = smoothNoise(rand, rows, 2);
  const jag = smoothNoise(rand, rows, 0);
  const cells = [];
  for (let cy = 0; cy < rows; cy++) {
    const c = def.center + def.meander * meander[cy];
    const lo = Math.ceil(c - def.minHalf - def.wobble * Math.max(0, wobL[cy]));
    const hi = Math.floor(c + def.minHalf + def.wobble * Math.max(0, wobR[cy]));
    for (let cx = lo; cx <= hi; cx++) cells.push({ cx, cy });
    if (jag[cy] > 0.55) cells.push({ cx: lo - 1, cy });
    if (jag[cy] < -0.55) cells.push({ cx: hi + 1, cy });
  }
  return cells.filter((c) => c.cx >= 0 && c.cx < cols);
}
