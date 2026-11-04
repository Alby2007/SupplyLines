# Supply Lines

A browser logistics game — Mini Metro's colour-locked transit lines crossed
with Mini Motorways' road budget, demand meters, and traffic — built on a
sim that doubles as an instrumented RL research platform.

Vanilla JavaScript ES modules + HTML5 Canvas. No build step, no dependencies.

## Quick start

```sh
python3 serve.py              # http://localhost:8000 (no-store headers)
npm test                      # node:test suite
node autoplay.mjs --runs=12   # headless bot plays seeded games + postmortems
```

Add `?level=N` to pick a map, `?debug` to expose `window.__state` for live
inspection.

## Documentation

Everything lives in [docs/](docs/README.md): gameplay, architecture, the
state object and tick loop, every `CONFIG` knob, testing conventions, and
the RL program under `rl/` (environment protocol, PPO trainer, generated-map
suite, and the running experiment log).

## License

[MIT](LICENSE)
