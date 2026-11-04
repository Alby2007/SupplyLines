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
from rollout import collect


def parse():
    p = argparse.ArgumentParser()
    p.add_argument('--envs', type=int, default=8)
    p.add_argument('--level', type=int, default=1)
    p.add_argument('--levels', type=str, default=None,
                   help='comma list forming the per-episode level pool — each '
                        'worker i.i.d.-samples a level per reset, e.g. 1,2,3 or '
                        'a generated-map pool like 101,105,112')
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
    p.add_argument('--vtgt', choices=['gae', 'mc'], default='gae',
                   help="value targets: 'gae' = adv+V (self-coupled — the "
                        "co-drift channel); 'mc' = reward-to-go, V only at "
                        "truncation bootstraps")
    p.add_argument('--retnorm', choices=['freeze', 'roll'], default='freeze',
                   help="'roll' re-normalizes returns each batch — safe only "
                        'with --vtgt mc (V-free targets can\'t feed back)')
    p.add_argument('--vanchor', type=float, default=0.0,
                   help='if >0, adds λ·v² to the value loss — restoring force '
                        'on the head\'s offset drift direction')
    p.add_argument('--seed', type=int, default=0)
    p.add_argument('--tag', type=str, default='run')
    p.add_argument('--device', type=str, default='cuda' if torch.cuda.is_available() else 'cpu')
    p.add_argument('--ckpt', type=str, default=None, help='resume from checkpoint')
    p.add_argument('--transfer', action='store_true',
                   help='load only shape-compatible keys from --ckpt — partial '
                        'transfer across an obs/architecture change (e.g. the '
                        'map-param globals), relearning mismatched layers')
    p.add_argument('--groups', type=int, default=2,
                   help='env groups for double-buffered rollouts (1 = no sim/GPU overlap)')
    p.add_argument('--cpu-buffer', action='store_true',
                   help='keep the PPO update buffer on the host instead of the GPU (saves ~1.7GB VRAM)')
    return p.parse_args()


def main():
    args = parse()
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)  # eps-greedy draws + minibatch shuffle order
    dev = torch.device(args.device)
    run_dir = os.path.join(os.path.dirname(__file__), 'runs', args.tag)
    os.makedirs(run_dir, exist_ok=True)
    hb_path = os.path.join(run_dir, 'heartbeat')

    # --levels is a pool string passed straight to workers (i.i.d. per-episode
    # levels); a bare --level int still fixes every worker to one map
    levels = args.levels if args.levels else args.level
    env = VecEnv(args.envs, level=levels, base_seed=args.seed, warm=args.warmstart,
                 n_groups=args.groups)
    net = ActorCritic(ch=env.ch, gd=env.gd, afd=env.afd).to(dev)
    # init lazy layers before loading: --transfer needs real shapes to
    # filter keys, and strict loads initialize from the ckpt either way
    with torch.no_grad():
        dummy = torch.zeros(1, env.ch, env.rows, env.cols, device=dev)
        net(dummy, torch.zeros(1, env.gd, device=dev),
            torch.zeros(1, 1, env.afd, device=dev), torch.ones(1, 1, dtype=torch.bool, device=dev))
    if args.ckpt:
        sd = torch.load(args.ckpt, map_location=dev)
        bad = [k for k, v in sd.items()
               if torch.is_tensor(v) and not v.isfinite().all()]
        if bad:
            raise SystemExit(f'ckpt {args.ckpt} has non-finite tensors '
                             f'({len(bad)}: {bad[:3]}...) — restore a clean snapshot')
        if args.transfer:
            own = net.state_dict()
            ok, padded = {}, []
            for k, v in sd.items():
                if k not in own:
                    continue
                if own[k].shape == v.shape:
                    ok[k] = v
                elif (own[k].ndim == v.ndim and own[k].shape[:-1] == v.shape[:-1]
                        and own[k].shape[-1] > v.shape[-1]):
                    # same layer with a wider input (map params / new verbs):
                    # copy the learned slice, let the new columns start fresh
                    w = own[k].clone()
                    w[..., :v.shape[-1]] = v
                    ok[k] = w
                    padded.append(f'{k} {tuple(v.shape)}->{tuple(own[k].shape)}')
            skipped = sorted(set(sd) - set(ok))
            net.load_state_dict(ok, strict=False)
            print(f'transfer: loaded {len(ok)}/{len(sd)} keys'
                  + (f'; padded {padded}' if padded else '') + f'; skipped {skipped}')
        else:
            net.load_state_dict(sd)
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)

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
    b_trunc = np.zeros((T, N), np.bool_)   # done via MAX_SECONDS cap, not death
    b_tval = np.zeros((T, N), np.float32)  # critic V at the cap's terminal obs

    buf = dict(grid=b_grid, glob=b_glob, feats=b_feats, mask=b_mask, act=b_act,
               logp=b_logp, val=b_val, rew=b_rew, done=b_done,
               trunc=b_trunc, tval=b_tval)
    obs_g = env.split(env.reset())
    ep_stats = []
    t_start = time.time()
    step_total = 0
    ret_mu, ret_sd, ret_init = 0.0, 1.0, False  # frozen at first batch —
    # a live normalizer feeds back through the GAE bootstrap (v noise ∝ sd
    # → ret noise ∝ sd → sd grows → exponential blowup, seen empirically)

    for it in range(1, args.iters + 1):
        net.eval()
        cur_eps = max(args.epsend, args.eps * (args.epsdecay ** (it - 1)))
        # warm-start anneal: deep bot prefixes early, agent-owned episodes late
        env.warm = args.warmstart * (args.warmdecay ** (it - 1))

        def policy(o, t, sl):
            g = torch.as_tensor(o['grid'], device=dev).float()
            gl = torch.as_tensor(o['glob'], device=dev)
            f = torch.as_tensor(o['feats'], device=dev).float()
            m = torch.as_tensor(o['mask'], device=dev)
            with torch.no_grad():
                logits, v = net(g, gl, f, m)
                dist = torch.distributions.Categorical(logits=logits, validate_args=False)
                a = dist.sample()
                logp = dist.log_prob(a)
            na = a.cpu().numpy()
            if cur_eps > 0:  # epsilon-greedy: uniform over the valid mask
                forced = np.random.rand(len(na)) < cur_eps
                for i in np.flatnonzero(forced):
                    valid = np.flatnonzero(o['mask'][i])
                    if len(valid): na[i] = np.random.choice(valid)
                if forced.any():
                    with torch.no_grad():
                        logp = dist.log_prob(torch.as_tensor(na, device=dev))
            return na, logp.cpu().numpy(), (v * ret_sd + ret_mu).cpu().numpy()

        # value-only forward for terminal-obs bootstraps — separate from
        # `policy` so it consumes no np.random draws (eps-greedy) and doesn't
        # perturb the rollout's RNG stream for a handful of cap hits
        def vfn(o):
            g = torch.as_tensor(o['grid'], device=dev).float()
            gl = torch.as_tensor(o['glob'], device=dev)
            f = torch.as_tensor(o['feats'], device=dev).float()
            m = torch.as_tensor(o['mask'], device=dev)
            with torch.no_grad():
                _, v = net(g, gl, f, m)
            return (v * ret_sd + ret_mu).cpu().numpy()

        # steps are stored against the state they were taken FROM (s_t, a_t, r_t);
        # groups of envs overlap each other's sims with the policy forward
        eps_done = collect(env, policy, vfn, buf, obs_g, T)
        for e in eps_done:
            e['iter'] = it
        ep_stats.extend(eps_done)
        obs = {k: np.concatenate([o[k] for o in obs_g]) for k in obs_g[0]}
        step_total += T * N

        # GAE — next-value bootstrap on non-terminal obs (auto-reset keeps obs fresh)
        with torch.no_grad():
            g = torch.as_tensor(obs['grid'], device=dev).float()
            gl = torch.as_tensor(obs['glob'], device=dev)
            f = torch.as_tensor(obs['feats'], device=dev).float()
            m = torch.as_tensor(obs['mask'], device=dev)
            _, nextv = net(g, gl, f, m)
        adv = np.zeros((T, N), np.float32)
        lastgae = np.zeros(N, np.float32)
        nv = (nextv * ret_sd + ret_mu).cpu().numpy()
        for t in reversed(range(T)):
            nonterm = 1.0 - b_done[t].astype(np.float32)
            # a time-cap end still has future value: bootstrap the critic's own
            # V at the terminal obs (tval) instead of zeroing it like a death.
            # nonterm still masks the lastgae carry — the next stored step is a
            # new episode either way
            nvstep = nv * nonterm + b_tval[t] * b_trunc[t]
            delta = b_rew[t] + args.gamma * nvstep - b_val[t]
            lastgae = delta + args.gamma * args.lam * nonterm * lastgae
            adv[t] = lastgae
            nv = b_val[t]
        ret = adv + b_val
        if args.vtgt == 'mc':
            # reward-to-go targets: the critic's own V leaves the label, so a
            # drifting value head can't drag its targets along — the co-drift
            # channel that walked v to −500σ in normalized units while vl
            # read ~35 (targets = adv + own-v track any uniform offset; only
            # terminal states anchor, and they're sparse). V survives only as
            # the tval bootstrap at cap-hits. Policy adv stays standard GAE.
            retm = np.zeros((T, N), np.float32)
            nxt = nv  # same rollout-boundary bootstrap GAE uses
            for t in reversed(range(T)):
                nxt = b_rew[t] + args.gamma * (nxt * (1.0 - b_done[t])
                                               + b_tval[t] * b_trunc[t])
                retm[t] = nxt
            ret = retm

        # flatten batch dims
        fg = b_grid.reshape(T * N, env.ch, env.rows, env.cols)
        fgl = b_glob.reshape(T * N, env.gd)
        ff = b_feats.reshape(T * N, MAXA, env.afd)
        fm = b_mask.reshape(T * N, MAXA)
        fa = b_act.ravel()
        flogp = b_logp.ravel()
        fadv = adv.ravel()
        fret_raw = ret.ravel()
        if not ret_init or args.retnorm == 'roll':
            # roll: safe once targets are V-free (mc) — the original σ feedback
            # loop needed a V-coupled label to run away
            ret_mu, ret_sd, ret_init = (float(fret_raw.mean()),
                                        float(fret_raw.std()) + 1e-8, True)
        fret = (fret_raw - ret_mu) / ret_sd
        fadv = (fadv - fadv.mean()) / (fadv.std() + 1e-8)

        net.train()
        idx = np.arange(T * N)
        # the whole rollout lives on the GPU for the update (~1.7GB fp16), so
        # minibatches are device-side gathers — no per-minibatch host gather or
        # PCIe copy. --cpu-buffer keeps it on the host when VRAM is shared.
        srcs = [fg, fgl, ff, fm, fa, flogp, fadv, fret]
        if not args.cpu_buffer:
            srcs = [torch.from_numpy(np.ascontiguousarray(x)).to(dev) for x in srcs]
        sg, sgl, sf, sm, sa, slogp, sadv, sret = srcs

        def take(src, mb_np, mb_t):
            return src[mb_t] if torch.is_tensor(src) else torch.as_tensor(src[mb_np], device=dev)

        pl = torch.zeros((), device=dev); vl = torch.zeros((), device=dev); el = torch.zeros((), device=dev)
        vmu = torch.zeros((), device=dev)  # mean raw v — early drift detector
        nb = 0; nskip = 0; klstop = 0
        for ep in range(args.epochs):
            if klstop: break
            np.random.shuffle(idx)
            idx_t = torch.as_tensor(idx, device=dev)
            for s in range(0, T * N, args.minibatch):
                mb, mb_t = idx[s:s + args.minibatch], idx_t[s:s + args.minibatch]
                g = take(sg, mb, mb_t).float()
                gl = take(sgl, mb, mb_t)
                f = take(sf, mb, mb_t).float()
                m = take(sm, mb, mb_t)
                a = take(sa, mb, mb_t)
                logits, v = net(g, gl, f, m)
                dist = torch.distributions.Categorical(logits=logits, validate_args=False)
                logp = dist.log_prob(a)
                old_lp = take(slogp, mb, mb_t)
                ld = (logp - old_lp).clamp(-20, 20)
                ratio = ld.exp()
                madv = take(sadv, mb, mb_t)
                pg1, pg2 = -madv * ratio, -madv * ratio.clamp(1 - args.clip, 1 + args.clip)
                ploss = torch.max(pg1, pg2).mean()
                vloss = F.smooth_l1_loss(v, take(sret, mb, mb_t))
                if args.vanchor:
                    # restoring force on the value head's offset direction —
                    # near-free drift channel under gae targets, insurance
                    # even under mc
                    vloss = vloss + args.vanchor * (v ** 2).mean()
                vmu += v.detach().mean()
                ent = dist.entropy().mean()
                loss = ploss + args.vf * vloss - args.ent * ent
                if not torch.isfinite(loss):
                    opt.zero_grad(); nskip += 1; continue
                opt.zero_grad()
                loss.backward()
                gn = nn.utils.clip_grad_norm_(net.parameters(), 0.5)
                if not torch.isfinite(gn):
                    opt.zero_grad(); nskip += 1; continue
                opt.step()
                pl += ploss.detach(); vl += vloss.detach(); el += ent.detach(); nb += 1
                # KL early-stop: once the policy has moved ~0.03 nats from the
                # rollout policy, every later minibatch this epoch trains a
                # policy the batch never sampled — the runaway path that
                # saturates logits (ent→0) after ~50 healthy iters
                if (old_lp - logp).mean().item() > 0.03:
                    klstop += 1; break
        pl, vl, el = pl.item(), vl.item(), el.item()   # one sync per iteration, not 3 per minibatch
        del srcs, sg, sgl, sf, sm, sa, slogp, sadv, sret

        if it % 5 == 0 or it == 1:
            recent = ep_stats[-30:]
            wks = [e['week'] for e in recent]
            tr = [e['truncated'] for e in recent]
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
                  f'del {np.mean(dr) if dr else 0:.0f} | tr {np.mean(tr) if tr else 0:.0%} | '
                  f'acts {astr} | '
                  f'pl {pl/max(nb,1):.3f} vl {vl/max(nb,1):.3f} ent {el/max(nb,1):.3f} '
                  f'rsd {ret_sd:.1f} vμ {vmu.item()/max(nb,1):.2f}'
                  + (f' nskip {nskip}' if nskip else '')
                  + (' klstop' if klstop else ''), flush=True)
            # write ALL finished episodes — truncating to `recent` would drop
            # every episode beyond the last 30 in the window
            with open(os.path.join(run_dir, 'episodes.jsonl'), 'a') as fh:
                for e in ep_stats:
                    fh.write(json.dumps(e) + '\n')
            ep_stats.clear()
        if it % 20 == 0:
            if all(p.isfinite().all() for p in net.parameters()):
                torch.save(net.state_dict(), os.path.join(run_dir, 'latest.pt'))
            else:
                print(f'it {it}: non-finite weights — latest.pt save skipped', flush=True)
        # liveness beat every iteration — supervise.sh's stall watchdog keys on
        # this, NOT latest.pt (a 20-iter save gap makes slow runs look wedged
        # and zombie-loops them: kill → restart → still <20 iters → kill again)
        open(hb_path, 'a').close()
        os.utime(hb_path, None)

    if all(p.isfinite().all() for p in net.parameters()):
        torch.save(net.state_dict(), os.path.join(run_dir, 'latest.pt'))
    env.close()


if __name__ == '__main__':
    main()
