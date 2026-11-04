"""Double-buffered rollout collection.

The env workers are split into groups (VecEnv.groups). While group A's sims
run, Python decodes and runs the policy forward for group B, and vice versa,
so the GPU forward and the obs decode hide behind sim time instead of
serialising with it. Each env still sees exactly the same obs->action->step
chain as a plain loop; only the wall-clock schedule changes.
"""
import numpy as np


def collect(env, policy, vfn, buf, obs_g, T):
    """Fill buf[...][0:T] with T steps per env; returns finished-episode dicts.

    env    : VecEnv (uses env.groups, send_group, recv_group)
    policy : fn(obs_group, t, group_slice) -> (actions, logp, value), numpy arrays
    vfn    : fn(obs_batch) -> value, for terminal-obs bootstraps on truncation
    buf    : dict of [T, N, ...] arrays: grid glob feats mask act logp val rew
             done trunc tval
    obs_g  : list of per-group obs dicts; updated in place to the post-rollout obs
    A step is stored against the state it was taken FROM (s_t, a_t, r_t); the
    last step's reward/done/next-obs are drained after the loop, so nothing is
    left in flight when this returns.
    """
    episodes = []

    def drain(g, t):                       # results of step t for group g
        sl = env.groups[g]
        obs_g[g], rews, dones, infos = env.recv_group(g)
        buf['rew'][t, sl] = rews
        buf['done'][t, sl] = dones
        buf['trunc'][t, sl] = [bool(i.get('truncated')) for i in infos]
        # capped episodes end mid-life, not mid-death — their last transition
        # bootstraps the critic's V at the terminal obs (stashed by _finish
        # before auto-reset replaced it), batched here per drain
        tix = [i for i, inf in enumerate(infos) if 'term_obs' in inf]
        if tix:
            tobs = {k: np.stack([infos[i]['term_obs'][k] for i in tix])
                    for k in ('grid', 'glob', 'feats', 'mask')}
            buf['tval'][t, sl.start + np.asarray(tix)] = vfn(tobs)
        episodes.extend(i['episode'] for i in infos if 'episode' in i)

    for t in range(T):
        for g, sl in enumerate(env.groups):
            if t:
                drain(g, t - 1)
            o = obs_g[g]
            act, logp, val = policy(o, t, sl)
            for k in ('grid', 'glob', 'feats', 'mask'):
                buf[k][t, sl] = o[k]
            buf['act'][t, sl] = act
            buf['logp'][t, sl] = logp
            buf['val'][t, sl] = val
            env.send_group(g, act)
    for g in range(len(env.groups)):
        drain(g, T - 1)
    return episodes
