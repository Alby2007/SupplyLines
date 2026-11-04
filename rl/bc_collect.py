"""Collect behavior-cloning demonstrations: env workers play episodes with
the heuristic bot (bcstep cmd) and we record (grid, glob, feats, mask, aIdx)
tuples for supervised training.

  python rl/bc_collect.py --workers 8 --episodes 120 --out runs/bc/demo

The bot's ops are mapped back onto the enumerated action set inside the
worker (state-diff + op payloads); `unmapped` counts ops the action
vocabulary can't express — itself a measurement of vocabulary thinness.

Samples stream to disk via np.memmap (no RAM accumulation, crash-safe):
<out>_grid.npy / _glob.npy / _feats.npy / _mask.npy / _act.npy + _meta.json.
"""
import argparse, json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vexp import EnvWorker, MAXA
from numpy.lib.format import open_memmap

TRAIN_POOL = ('101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,'
              '117,118,119,120,121,122,123,125,126,127,128,129,130,131,132,133,134')


def pack(w, m):
    ncells = w.rows * w.cols
    o = m['obs']
    braw, craw = o['bin'], o['con']
    nbin = len(braw) * 8 // ncells
    ncon = len(craw) // 2 // ncells
    grid = np.zeros((w.ch, w.rows, w.cols), np.float16)
    b = np.unpackbits(np.frombuffer(braw, np.uint8), count=nbin * ncells)
    grid[:nbin] = b.reshape(nbin, w.rows, w.cols)
    grid[nbin:nbin + ncon] = np.frombuffer(craw, np.float16).reshape(ncon, w.rows, w.cols)
    fr = m['feats']
    na = len(fr) // (2 * w.afd)
    feats = np.zeros((MAXA, w.afd), np.float16)
    feats[:na] = np.frombuffer(fr, np.float16).reshape(na, w.afd)
    mask = np.zeros(MAXA, np.bool_)
    mask[:na] = True
    return grid, np.array(o['glob'], np.float32), feats, mask


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--episodes', type=int, default=120)
    ap.add_argument('--levels', type=str, default=TRAIN_POOL)
    ap.add_argument('--seed', type=int, default=60000)
    ap.add_argument('--out', default='runs/bc/demo')
    ap.add_argument('--cap', type=int, default=150000,
                    help='preallocated dataset rows (extra samples dropped)')
    args = ap.parse_args()

    pool = [int(x) for x in args.levels.split(',')]
    ws = [EnvWorker(pool[i % len(pool)]) for i in range(args.workers)]
    seed = args.seed
    for w in ws:
        w.send_reset(seed, 0)
        seed += 1
    for w in ws:
        w.recv()

    w0 = ws[0]
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    G = open_memmap(args.out + '_grid.npy', 'w+', np.float16,
                    (args.cap, w0.ch, w0.rows, w0.cols))
    GL = open_memmap(args.out + '_glob.npy', 'w+', np.float32, (args.cap, w0.gd))
    F = open_memmap(args.out + '_feats.npy', 'w+', np.float16,
                    (args.cap, MAXA, w0.afd))
    M = open_memmap(args.out + '_mask.npy', 'w+', np.bool_, (args.cap, MAXA))
    A = open_memmap(args.out + '_act.npy', 'w+', np.int64, (args.cap,))

    n, eps, steps, unmapped = 0, 0, 0, 0
    opcounts, ukinds, weeks = {}, {}, []
    done = [False] * len(ws)
    while eps < args.episodes:
        for i, w in enumerate(ws):
            if not done[i]:
                w._send({'cmd': 'bcstep'})
        for i, w in enumerate(ws):
            if done[i]:
                continue
            m = w.recv()
            steps += 1
            info = m.get('info') or {}
            unmapped += info.get('unmapped') or 0
            for ok in info.get('ops') or []:
                opcounts[ok] = opcounts.get(ok, 0) + 1
            for uk in info.get('unmappedKinds') or []:
                ukinds[uk] = ukinds.get(uk, 0) + 1
            chs = info.get('choices') or []
            if chs and n < args.cap:
                g, gl, f, mk = pack(w, m)
                for c in chs:
                    if n >= args.cap:
                        break
                    G[n] = g; GL[n] = gl; F[n] = f; M[n] = mk; A[n] = c
                    n += 1
            if m['done']:
                eps += 1
                weeks.append(info.get('week') or 0)
                done[i] = True
                w.send_reset(seed, 0)
                seed += 1
                w.recv()
                done[i] = False
            if steps % 400 == 0:
                print(f'steps {steps} | eps {eps} | samples {n} | '
                      f'unmapped {unmapped} {ukinds} | ops {opcounts}', flush=True)
                for arr in (G, GL, F, M, A):
                    arr.flush()

    meta = {'n': n, 'episodes': eps, 'unmapped': ukinds, 'ops': opcounts,
            'weeks_mean': float(np.mean(weeks)),
            'shape': {'grid': list(G.shape[1:]), 'glob': G.shape[0] and GL.shape[1],
                      'afd': w0.afd, 'maxa': MAXA}}
    json.dump(meta, open(args.out + '_meta.json', 'w'), indent=1)
    for arr in (G, GL, F, M, A):
        arr.flush()
    print(f'\nwrote {args.out}_*.npy: {n} samples from {eps} bot episodes '
          f'(wk mean {np.mean(weeks):.1f}) | unmapped ops {unmapped} {ukinds} | ops {opcounts}')
    for w in ws:
        w.close()


if __name__ == '__main__':
    main()
