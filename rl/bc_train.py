"""Behavior-clone the autoplayer: cross-entropy on masked logits over the
demonstration tuples from bc_collect.py.

  python rl/bc_train.py --data runs/bc/demo.npz --out runs/bc/bc.pt --epochs 8

The result is the bot expressed through the same interface the RL policy
uses — the interface-fidelity baseline column (bot | BC | RL).
"""
import argparse, json, os, sys
import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import ActorCritic


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--out', default='runs/bc/bc.pt')
    ap.add_argument('--epochs', type=int, default=8)
    ap.add_argument('--bs', type=int, default=512)
    ap.add_argument('--lr', type=float, default=3e-4)
    ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    ap.add_argument('--seed', type=int, default=0)
    args = ap.parse_args()
    torch.manual_seed(args.seed)
    dev = torch.device(args.device)

    # memmap layout from bc_collect.py: <data>_grid.npy … + _meta.json
    meta = json.load(open(args.data + '_meta.json'))
    n = meta['n']
    G = np.load(args.data + '_grid.npy', mmap_mode='r')[:n]
    GL = np.load(args.data + '_glob.npy', mmap_mode='r')[:n]
    FT = np.load(args.data + '_feats.npy', mmap_mode='r')[:n]
    MK = np.load(args.data + '_mask.npy', mmap_mode='r')[:n]
    AC = np.load(args.data + '_act.npy', mmap_mode='r')[:n]
    print(f'{n} samples | grid {tuple(G.shape)} | glob {GL.shape[1]} | afd {FT.shape[-1]}')

    net = ActorCritic(ch=G.shape[1], gd=GL.shape[1], afd=FT.shape[-1]).to(dev)
    with torch.no_grad():
        net(torch.as_tensor(G[:1]).float().to(dev),
            torch.as_tensor(GL[:1]).float().to(dev),
            torch.as_tensor(FT[:1]).float().to(dev),
            torch.as_tensor(MK[:1]).to(dev))
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)

    idx = np.arange(n)
    for ep in range(args.epochs):
        np.random.shuffle(idx)
        tot, corr, nb = 0.0, 0, 0
        for s in range(0, n, args.bs):
            mb = idx[s:s + args.bs]
            g = torch.as_tensor(G[mb]).float().to(dev, non_blocking=True)
            gl = torch.as_tensor(GL[mb]).float().to(dev)
            f = torch.as_tensor(FT[mb]).float().to(dev)
            m = torch.as_tensor(MK[mb]).to(dev)
            a = torch.as_tensor(AC[mb]).long().to(dev)
            logits, _ = net(g, gl, f, m)
            loss = F.cross_entropy(logits, a)
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
            opt.step()
            tot += loss.item()
            corr += (logits.argmax(-1) == a).sum().item()
            nb += 1
        print(f'ep {ep}: ce {tot/nb:.4f} | top1 {corr/n:.3f}', flush=True)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    torch.save(net.state_dict(), args.out)
    print(f'wrote {args.out}')


if __name__ == '__main__':
    main()
