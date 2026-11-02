"""Held-out eval sweep: checkpoints × levels → runs/eval_heldout.json.

  python rl/eval_sweep.py --episodes 12 --envs 8 --seed 10000

Era ablation: hire_it210 is evaluated with RL_COURIER=0 so its untrained
score columns never see courier candidates (clean hire-only vocabulary).
"""
import argparse, json, os, re, subprocess, sys

CKPTS = [
    ('hire_it210',    'runs/genobs/hire_it210.pt',    {'RL_COURIER': '0'}),
    ('courier_it335', 'runs/genobs/courier_it335.pt', {}),
    ('eval_latest',   'runs/genobs/eval_latest.pt',   {}),
]
HELDOUT = [124, 135, 136, 137, 138, 139, 140, 141, 142, 143,
           144, 145, 146, 147, 148, 149, 150]
# stratified subset for the sweep: the easy map + a span of mediums
# (full held-out suite ≈ 3× the sim time; same inference at lower n)
SUBSET = [124, 135, 140, 145, 146, 148, 150]
LEVELS = [1, 2, 3] + SUBSET

WEEKS = re.compile(r'weeks: min (\d+) median (\d+) max (\d+) mean ([\d.]+)')
STARS = re.compile(r'mean ([\d.]+)')
DEATHS = re.compile(r'deaths: (\{.*\})')


def run_eval(ckpt, level, episodes, envs, seed, env_extra):
    env = {**os.environ, **env_extra}
    cmd = [sys.executable, 'eval.py', '--ckpt', ckpt, '--level', str(level),
           '--episodes', str(episodes), '--envs', str(envs), '--seed', str(seed)]
    p = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=os.path.dirname(__file__) or '.')
    out = p.stdout
    w = WEEKS.search(out)
    s = STARS.search(out)
    d = DEATHS.search(out)
    if not w:
        return {'level': level, 'error': (out + p.stderr)[-400:]}
    return {
        'level': level,
        'weeks_min': int(w.group(1)), 'weeks_med': int(w.group(2)),
        'weeks_max': int(w.group(3)), 'weeks_mean': float(w.group(4)),
        'stars_mean': float(s.group(1)) if s else None,
        'deaths': json.loads(d.group(1).replace("'", '"')) if d else {},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--episodes', type=int, default=12)
    ap.add_argument('--envs', type=int, default=8)
    ap.add_argument('--seed', type=int, default=10000)
    ap.add_argument('--only', default='')
    args = ap.parse_args()

    ckpts = CKPTS if not args.only else [c for c in CKPTS if c[0] == args.only]
    results = {}
    for label, ckpt, env_extra in ckpts:
        results[label] = {}
        for lv in LEVELS:
            r = run_eval(ckpt, lv, args.episodes, args.envs, args.seed, env_extra)
            results[label][lv] = r
            med = r.get('weeks_med')
            print(f'{label:>14} L{lv:<4} wk med {med} mean {r.get("weeks_mean")} '
                  f'| deaths {r.get("deaths") or r.get("error", "")[:80]}', flush=True)
        with open('runs/eval_heldout.json', 'w') as f:
            json.dump(results, f, indent=1)
    print('\nwrote runs/eval_heldout.json')


if __name__ == '__main__':
    main()
