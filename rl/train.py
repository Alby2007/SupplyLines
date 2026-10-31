"""PPO trainer for Supply Lines.

Usage:
  python rl/train.py --envs 8 --level 1 --iters 300 --tag map1
"""
import argparse
import json
import os
import time
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from vexp import VecEnv, MAXA
from model import ActorCritic


def parse():
    p = argparse.ArgumentParser()
    p.add_argument('--envs', type=int, default=8)
    p.add_argument('--level', type=int, default=1)
    p.add_argument('--levels', type=str, default=None,
                   help='comma list cycled across envs for mixed-map training, e.g. 1,1,2,3')
    p.add_argument('--iters', type=int, default=300)
    p.add_argument('--tsteps', type=int, default=2048, help='rollout steps per iter')
    p.add_argument('--gamma', type=float, default=0.997)
    p.add_argument('--lam', type=float, default=0.95)
    p.add_argument('--lr', type=float, default=3e-4)
    p.add_argument('--clip', type=float, default=0.2)
    p.add_argument('--epochs', type=int, default=4)
    p.add_argument('--minibatch', type=int, default=512)
    p.add_argument('--ent', type=float, default=0.005)
    p.add_argument('--eps', type=float, default=0.0, help='epsilon-greedy explore rate at iter 1')
    p.add_argument('--epsend', type=float, default=0.02, help='epsilon floor')
    p.add_argument('--epsdecay', type=float, default=0.995, help='per-iter decay')
    p.add_argument('--warmstart', type=float, default=0,
                   help='max seconds of bot pre-play per episode at iter 1')
    p.add_argument('--warmdecay', type=float, default=1.0, help='per-iter decay on warmstart')
    p.add_argument('--vf', type=float, default=0.5)
    p.add_argument('--seed', type=int, default=0)
    p.add_argument('--tag', type=str, default='run')
    p.add_argument('--device', type=str, default='cuda' if torch.cuda.is_available() else 'cpu')
    p.add_argument('--ckpt', type=str, default=None, help='resume from checkpoint')
    return p.parse_args()


def main():
    args = parse()
    torch.manual_seed(args.seed)
    dev = torch.device(args.device)
    run_dir = os.path.join(os.path.dirname(__file__), 'runs', args.tag)
    os.makedirs(run_dir, exist_ok=True)

    levels = [int(x) for x in args.levels.split(',')] if args.levels else args.level
    env = VecEnv(args.envs, level=levels, base_seed=args.seed, warm=args.warmstart)
    net = ActorCritic(ch=env.ch, gd=env.gd, afd=env.afd).to(dev)
    if args.ckpt:
        net.load_state_dict(torch.load(args.ckpt, map_location=dev))
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)
    with torch.no_grad():
        dummy = torch.zeros(1, env.ch, env.rows, env.cols, device=dev)
        net(dummy, torch.zeros(1, env.gd, device=dev),
            torch.zeros(1, 1, env.afd, device=dev), torch.ones(1, 1, dtype=torch.bool, device=dev))

    T, N = args.tsteps, args.envs
    shape_g = (T, N, env.ch, env.rows, env.cols)
    b_grid = np.zeros(shape_g, np.float16)
    b_glob = np.zeros((T, N, env.gd), np.float32)
    b_feats = np.zeros((T, N, MAXA, env.afd), np.float16)
    b_mask = np.zeros((T, N, MAXA), np.bool_)
    b_act = np.zeros((T, N), np.int64)
    b_logp = np.zeros((T, N), np.float32)
    b_val = np.zeros((T, N), np.float32)
    b_rew = np.zeros((T, N), np.float32)
    b_done = np.zeros((T, N), np.bool_)

    obs = env.reset()
    ep_stats = []
    t_start = time.time()
    step_total = 0

    for it in range(1, args.iters + 1):
        net.eval()
        cur_eps = max(args.epsend, args.eps * (args.epsdecay ** (it - 1)))
        # warm-start anneal: deep bot prefixes early, agent-owned episodes late
        env.warm = args.warmstart * (args.warmdecay ** (it - 1))
        for t in range(T):
            g = torch.as_tensor(obs['grid'], device=dev)
            gl = torch.as_tensor(obs['glob'], device=dev)
            f = torch.as_tensor(obs['feats'], device=dev)
            m = torch.as_tensor(obs['mask'], device=dev)
            with torch.no_grad():
                logits, v = net(g, gl, f, m)
                dist = torch.distributions.Categorical(logits=logits)
                a = dist.sample()
                logp = dist.log_prob(a)
            na = a.cpu().numpy()
            if cur_eps > 0:  # epsilon-greedy: uniform over the valid mask
                forced = np.random.rand(N) < cur_eps
                for i in np.flatnonzero(forced):
                    na[i] = np.random.choice(np.flatnonzero(obs['mask'][i]))
                if forced.any():
                    with torch.no_grad():
                        logp = dist.log_prob(torch.as_tensor(na, device=dev))
            # store the state the action was taken FROM before stepping —
            # env.step's return is s_{t+1}, and pairing it with a_t teaches
            # the policy to act on observations it never saw
            b_grid[t] = obs['grid'].astype(np.float16)
            b_glob[t] = obs['glob']
            b_feats[t] = obs['feats'].astype(np.float16)
            b_mask[t] = obs['mask']
            b_act[t] = na
            b_logp[t] = logp.cpu().numpy()
            b_val[t] = v.cpu().numpy()
            obs, rews, dones, infos = env.step(na)
            for i, inf in enumerate(infos):
                if 'episode' in inf:
                    inf['episode']['iter'] = it
                    ep_stats.append(inf['episode'])
            b_rew[t] = rews
            b_done[t] = dones
        step_total += T * N

        # GAE — next-value bootstrap on non-terminal obs (auto-reset keeps obs fresh)
        with torch.no_grad():
            g = torch.as_tensor(obs['grid'], device=dev)
            gl = torch.as_tensor(obs['glob'], device=dev)
            f = torch.as_tensor(obs['feats'], device=dev)
            m = torch.as_tensor(obs['mask'], device=dev)
            _, nextv = net(g, gl, f, m)
        adv = np.zeros((T, N), np.float32)
        lastgae = np.zeros(N, np.float32)
        nv = nextv.cpu().numpy()
        for t in reversed(range(T)):
            nonterm = 1.0 - b_done[t].astype(np.float32)
            delta = b_rew[t] + args.gamma * nv * nonterm - b_val[t]
            lastgae = delta + args.gamma * args.lam * nonterm * lastgae
            adv[t] = lastgae
            nv = b_val[t]
        ret = adv + b_val

        # flatten batch dims
        fg = b_grid.reshape(T * N, env.ch, env.rows, env.cols)
        fgl = b_glob.reshape(T * N, env.gd)
        ff = b_feats.reshape(T * N, MAXA, env.afd)
        fm = b_mask.reshape(T * N, MAXA)
        fa = b_act.ravel()
        flogp = b_logp.ravel()
        fadv = adv.ravel()
        fret = ret.ravel()
        fadv = (fadv - fadv.mean()) / (fadv.std() + 1e-8)

        net.train()
        idx = np.arange(T * N)
        pl = vl = el = 0.0
        nb = 0
        for ep in range(args.epochs):
            np.random.shuffle(idx)
            for s in range(0, T * N, args.minibatch):
                mb = idx[s:s + args.minibatch]
                g = torch.as_tensor(fg[mb], device=dev, dtype=torch.float32)
                gl = torch.as_tensor(fgl[mb], device=dev)
                f = torch.as_tensor(ff[mb], device=dev, dtype=torch.float32)
                m = torch.as_tensor(fm[mb], device=dev)
                a = torch.as_tensor(fa[mb], device=dev)
                logits, v = net(g, gl, f, m)
                dist = torch.distributions.Categorical(logits=logits)
                logp = dist.log_prob(a)
                ratio = (logp - torch.as_tensor(flogp[mb], device=dev)).exp()
                madv = torch.as_tensor(fadv[mb], device=dev)
                pg1, pg2 = -madv * ratio, -madv * ratio.clamp(1 - args.clip, 1 + args.clip)
                ploss = torch.max(pg1, pg2).mean()
                vloss = F.mse_loss(v, torch.as_tensor(fret[mb], device=dev))
                ent = dist.entropy().mean()
                loss = ploss + args.vf * vloss - args.ent * ent
                opt.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(net.parameters(), 0.5)
                opt.step()
                pl += ploss.item(); vl += vloss.item(); el += ent.item(); nb += 1

        if it % 5 == 0 or it == 1:
            recent = ep_stats[-30:]
            wks = [e['week'] for e in recent]
            dr = [e['delivered'] for e in recent]
            # action mix across recent episodes — a healthy policy diversifies
            # into lines/specials as the city grows; ~all 'connect' is collapse
            amix = {}
            for e in recent:
                for k, v in (e.get('acts') or {}).items():
                    amix[k] = amix.get(k, 0) + v
            atot = sum(amix.values()) or 1
            astr = ' '.join(f'{k[:4]} {v/atot:.0%}' for k, v in
                            sorted(amix.items(), key=lambda x: -x[1])[:5])
            sps = int(step_total / (time.time() - t_start))
            print(f'it {it:4d} | sps {sps:5d} | eps {len(ep_stats):4d} | warm {env.warm:5.0f}s | '
                  f'weeks avg {np.mean(wks) if wks else 0:.1f} max {max(wks) if wks else 0} | '
                  f'del {np.mean(dr) if dr else 0:.0f} | acts {astr} | '
                  f'pl {pl/max(nb,1):.3f} vl {vl/max(nb,1):.3f} ent {el/max(nb,1):.3f}', flush=True)
            # write ALL finished episodes — truncating to `recent` would drop
            # every episode beyond the last 30 in the window
            with open(os.path.join(run_dir, 'episodes.jsonl'), 'a') as fh:
                for e in ep_stats:
                    fh.write(json.dumps(e) + '\n')
            ep_stats.clear()
        if it % 20 == 0:
            torch.save(net.state_dict(), os.path.join(run_dir, 'latest.pt'))

    torch.save(net.state_dict(), os.path.join(run_dir, 'latest.pt'))
    env.close()


if __name__ == '__main__':
    main()
