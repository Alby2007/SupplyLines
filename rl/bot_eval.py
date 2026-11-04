"""Bot baseline on the eval suite: play episodes via the bcstep worker
command (autoplayer decides, sim ticks) and report per-level weeks
median/mean/deaths — the same shape eval.py produces for checkpoints.

  python rl/bot_eval.py --levels 1,2,3 --episodes 8 --out runs/bot_eval.json

This is the raw-heuristic column in the bot | BC | RL comparison.
"""
import argparse, json, os, sys
from collections import defaultdict
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vexp import EnvWorker


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--levels', default='1,2,3,124,135,140,145,146,148,150')
    ap.add_argument('--episodes', type=int, default=8)
    ap.add_argument('--seed', type=int, default=70000)
    ap.add_argument('--out', default='runs/bot_eval.json')
    args = ap.parse_args()

    levels = [int(x) for x in args.levels.split(',')]
    # one worker per level — each plays args.episodes on its map
    ws = {lv: EnvWorker(lv) for lv in levels}
    seed = args.seed
    for w in ws.values():
        w.send_reset(seed, 0)
        seed += 1
    for w in ws.values():
        w.recv()

    res = {lv: {'level': lv, 'weeks': [], 'deaths': defaultdict(int)} for lv in levels}
    left = {lv: args.episodes for lv in levels}
    while any(left.values()):
        for lv, w in ws.items():
            if left[lv] > 0:
                w._send({'cmd': 'bcstep'})
        for lv, w in ws.items():
            if left[lv] <= 0:
                continue
            m = w.recv()
            if m['done']:
                left[lv] -= 1
                info = m.get('info') or {}
                res[lv]['weeks'].append(info.get('week') or 0)
                res[lv]['deaths'][info.get('reason') or 'survived'] += 1
                done_eps = sum(args.episodes - v for v in left.values())
                print(f'{done_eps}/{args.episodes * len(levels)} eps '
                      f'(L{lv} wk {info.get("week")})', flush=True)
                if left[lv] > 0:
                    w.send_reset(seed, 0)
                    seed += 1
                    w.recv()

    out = {}
    for lv, r in res.items():
        wk = r['weeks']
        out[str(lv)] = {
            'level': lv, 'weeks_med': float(np.median(wk)),
            'weeks_mean': float(np.mean(wk)),
            'weeks_min': int(min(wk)), 'weeks_max': int(max(wk)),
            'deaths': dict(r['deaths'])}
        print(f"L{lv}: med {out[str(lv)]['weeks_med']:.0f} "
              f"mean {out[str(lv)]['weeks_mean']:.1f} | {dict(r['deaths'])}")
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump({'bot': out}, open(args.out, 'w'), indent=1)
    print(f'wrote {args.out}')
    for w in ws.values():
        w.close()


if __name__ == '__main__':
    main()
