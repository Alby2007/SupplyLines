"""Evaluate a checkpoint on fixed seeds per level; report weeks/stars.

  python rl/eval.py --ckpt runs/map1/latest.pt --level 1 --episodes 24
"""
import argparse
import numpy as np
import torch

from vexp import EnvWorker, MAXA
from model import ActorCritic

STARS = {1: [5, 8, 11], 2: [5, 8, 11], 3: [4, 7, 10]}


def stars(level, week):
    return sum(1 for w in STARS.get(level, [5, 8, 11]) if week >= w)


def pack(msgs, w0):
    # same wire format as VecEnv._pack: bitpacked binary channels + f16 rest;
    # bin/con channel split derived from buffer sizes
    ncells = w0.rows * w0.cols
    grids = np.empty((len(msgs), w0.ch, w0.rows, w0.cols), np.float32)
    globs = np.array([m['obs']['glob'] for m in msgs], np.float32)
    feats = np.zeros((len(msgs), MAXA, w0.afd), np.float32)
    mask = np.zeros((len(msgs), MAXA), np.bool_)
    for i, m in enumerate(msgs):
        o = m['obs']
        braw, craw = o['bin'], o['con']
        nbin = len(braw) * 8 // ncells
        ncon = len(craw) // 2 // ncells
        b = np.unpackbits(np.frombuffer(braw, np.uint8), count=nbin * ncells)
        grids[i, :nbin] = b.reshape(nbin, w0.rows, w0.cols)
        grids[i, nbin:nbin + ncon] = np.frombuffer(
            craw, np.float16).reshape(ncon, w0.rows, w0.cols)
        fr = m['feats']
        n = len(fr) // (2 * w0.afd)
        feats[i, :n] = np.frombuffer(fr, np.float16).reshape(n, w0.afd)
        mask[i, :n] = True
    return grids, globs, feats, mask


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--ckpt', required=True)
    p.add_argument('--level', type=int, default=1)
    p.add_argument('--episodes', type=int, default=24)
    p.add_argument('--envs', type=int, default=8)
    p.add_argument('--seed', type=int, default=10000,
                   help='held-out eval seed base — keep disjoint from train --seed')
    p.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    args = p.parse_args()

    dev = torch.device(args.device)
    workers = [EnvWorker(args.level) for _ in range(args.envs)]
    w0 = workers[0]
    net = ActorCritic(ch=w0.ch, gd=w0.gd, afd=w0.afd).to(dev)
    net.load_state_dict(torch.load(args.ckpt, map_location=dev))
    net.eval()

    seeds = [args.seed + i for i in range(args.episodes)]
    results = []
    si = 0
    active = set()
    # per-worker obs slots
    grids = np.zeros((args.envs, w0.ch, w0.rows, w0.cols), np.float32)
    globs = np.zeros((args.envs, w0.gd), np.float32)
    feats = np.zeros((args.envs, MAXA, w0.afd), np.float32)
    mask = np.zeros((args.envs, MAXA), np.bool_)
    for wi in range(args.envs):
        if si >= len(seeds):
            break
        g, gl, f, mk = pack([workers[wi].reset(seeds[si])], w0)
        grids[wi], globs[wi], feats[wi], mask[wi] = g[0], gl[0], f[0], mk[0]
        active.add(wi)
        si += 1

    while active:
        ids = sorted(active)
        with torch.no_grad():
            logits, _ = net(
                torch.as_tensor(grids[ids], device=dev),
                torch.as_tensor(globs[ids], device=dev),
                torch.as_tensor(feats[ids], device=dev),
                torch.as_tensor(mask[ids], device=dev))
            acts = logits.argmax(-1).cpu().numpy()
        for j, wi in enumerate(ids):
            m = workers[wi].step(int(acts[j]))
            if m['done']:
                i = m['info']
                results.append(dict(week=i['week'], time=i['time'],
                                    delivered=i['delivered'], freight=i['freight'],
                                    reason=i['reason'], stars=stars(args.level, i['week']),
                                    acts=i.get('acts'), tilesSpent=i.get('tilesSpent'),
                                    lines=i.get('lines')))
                if si < len(seeds):
                    m = workers[wi].reset(seeds[si])
                    si += 1
                else:
                    active.discard(wi)
                    continue
            g, gl, f, mk = pack([m], w0)
            grids[wi], globs[wi], feats[wi], mask[wi] = g[0], gl[0], f[0], mk[0]

    for w in workers:
        w.close()

    wks = sorted(r['week'] for r in results)
    st = [r['stars'] for r in results]
    print(f'\n=== eval level {args.level} · {len(results)} episodes ===')
    print(f'weeks: min {wks[0]} median {wks[len(wks)//2]} max {wks[-1]} mean {np.mean(wks):.1f}')
    print(f'stars: {dict(zip(*np.unique(st, return_counts=True)))} · mean {np.mean(st):.2f}')
    print(f'delivered mean {np.mean([r["delivered"] for r in results]):.0f} · '
          f'lines/ep {np.mean([r["lines"] or 0 for r in results]):.1f} · '
          f'tiles/ep {np.mean([r["tilesSpent"] or 0 for r in results]):.0f}')
    causes = {}
    for r in results:
        causes[r['reason'] or 'survived'] = causes.get(r['reason'] or 'survived', 0) + 1
    print('deaths:', causes)
    amix = {}
    for r in results:
        for k, v in (r['acts'] or {}).items():
            amix[k] = amix.get(k, 0) + v
    if amix:
        tot = sum(amix.values())
        print('actions:', {k: f'{v/tot:.0%}' for k, v in
                           sorted(amix.items(), key=lambda x: -x[1])})


if __name__ == '__main__':
    main()
