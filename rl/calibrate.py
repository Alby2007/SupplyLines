"""Bot-probe every generated level → calibration.json: solvability filter,
difficulty tiers, and a stratified train/test split for the RL pool.

  python rl/calibrate.py --levels 101-150 --runs 8 --procs 10

Tiers: broken (<3 bot-median weeks — regenerate that seed), hard (<5),
medium (5-8), easy (>8). Train pool = stratified pick across tiers;
held-out = the rest of the valid suite.
"""
import argparse
import json
import os
import re
import subprocess
from concurrent.futures import ProcessPoolExecutor

from vexp import _node_bin

NODE = _node_bin()  # which('node') first, then ~/.local — same as the env client
AUTOPLAY = os.path.join(os.path.dirname(__file__), '..', 'autoplay.mjs')
MED = re.compile(r'weeks survived: min (\d+) median (\d+) max (\d+)')
CAUSES = re.compile(r'death causes: (\{.*\})')


def _probe_args(a):
    return probe(*a)


def probe(level, runs, max_weeks):
    out = subprocess.run(
        [NODE, AUTOPLAY, f'--level={level}', f'--runs={runs}',
         f'--maxWeeks={max_weeks}'],
        capture_output=True, text=True, timeout=3600).stdout
    m = MED.search(out)
    c = CAUSES.search(out)
    causes = {}
    if c:
        for kv in re.findall(r"'([^']+)': (\d+)", c.group(1)):
            causes[kv[0]] = int(kv[1])
    if not m:
        return dict(level=level, median=0, min=0, max=0, causes=causes,
                    error=out[-400:] if out else 'no output')
    return dict(level=level, min=int(m.group(1)), median=int(m.group(2)),
                max=int(m.group(3)), causes=causes)


def tier(median, survived_share):
    if median < 3:
        return 'broken'
    if survived_share > 0.6 or median > 8:
        return 'easy'
    if median < 5:
        return 'hard'
    return 'medium'


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--levels', default='101-150', help='range a-b or comma list')
    p.add_argument('--runs', type=int, default=8)
    p.add_argument('--maxweeks', type=int, default=12)
    p.add_argument('--procs', type=int, default=10)
    p.add_argument('--out', default=None)
    args = p.parse_args()

    if '-' in args.levels:
        a, b = [int(x) for x in args.levels.split('-')]
        levels = list(range(a, b + 1))
    else:
        levels = [int(x) for x in args.levels.split(',')]

    with ProcessPoolExecutor(args.procs) as ex:
        results = list(ex.map(_probe_args,
                              [(lv, args.runs, args.maxweeks) for lv in levels]))

    for r in results:
        surv = r['causes'].get('SURVIVED (cap reached)', 0)
        r['survivedShare'] = round(surv / max(1, sum(r['causes'].values())), 3)
        r['tier'] = tier(r['median'], r['survivedShare'])

    valid = [r for r in results if r['tier'] != 'broken']
    by_tier = {}
    for r in valid:
        by_tier.setdefault(r['tier'], []).append(r['level'])
    # stratified train pool ≈ 2/3 of each tier, remainder held out for eval
    train, heldout = [], []
    for t, ids in sorted(by_tier.items()):
        ids = sorted(ids)
        cut = max(1, round(len(ids) * 2 / 3))
        train += ids[:cut]
        heldout += ids[cut:]

    report = dict(levels={r['level']: r for r in results}, tiers=by_tier,
                  broken=[r['level'] for r in results if r['tier'] == 'broken'],
                  train=sorted(train), heldout=sorted(heldout))
    out = args.out or os.path.join(os.path.dirname(__file__), 'calibration.json')
    with open(out, 'w') as f:
        json.dump(report, f, indent=1)

    for t in ('broken', 'hard', 'medium', 'easy'):
        ids = by_tier.get(t, [])
        print(f'{t:7s} ({len(ids)}): {ids}')
    print(f'\ntrain pool ({len(train)}): {train}')
    print(f'held-out  ({len(heldout)}): {heldout}')
    for r in sorted(results, key=lambda r: r['median']):
        print(f"  L{r['level']:>3} med {r['median']:>2} "
              f"({r['min']}-{r['max']}) surv {r['survivedShare']:.0%} {r['tier']}")
    print(f'wrote {out}')


if __name__ == '__main__':
    main()
