"""Sanity check: run a random agent for K steps, print stats + timing."""
import time
import numpy as np
from vexp import VecEnv

env = VecEnv(4, level=1)
obs = env.reset()
print('obs grid', obs['grid'].shape, 'glob', obs['glob'].shape,
      'feats', obs['feats'].shape, 'mask', obs['mask'].shape)
t0 = time.time()
steps = 0
eps = 0
for i in range(400):
    acts = [np.random.choice(np.flatnonzero(m)) for m in obs['mask']]
    obs, r, d, infos = env.step(acts)
    steps += 4
    for inf in infos:
        if 'episode' in inf:
            eps += 1
            e = inf['episode']
            print(f"ep end wk={e['week']} t={e['time']} del={e['delivered']} fr={e['freight']} '{e['reason']}'")
print(f'{steps} env-steps in {time.time()-t0:.1f}s = {steps/(time.time()-t0):.0f}/s, eps={eps}')
env.close()
