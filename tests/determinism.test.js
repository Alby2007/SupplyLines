// Episode determinism guard: seeded paths draw from the threaded `rng`
// (srand(seed) set by autoplay's run() / env_worker's doReset), never raw
// Math.random(). A stray Math.random() call doesn't throw — it just quietly
// makes that decision irreproducible — so we audit for them statically.
// (ui.js is deliberately excluded: the browser offer modal isn't seeded.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SEEDED = [
  'src/spawn.js', 'src/economy.js', 'src/tick.js',
  'autoplay.mjs', 'rl/env_worker.mjs',
];

test('no raw Math.random() calls on the seeded path', () => {
  for (const f of SEEDED) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.equal(src.match(/Math\.random\(\)/g)?.length ?? 0, 0,
      `${f} draws Math.random() — use the threaded rng instead`);
  }
});
