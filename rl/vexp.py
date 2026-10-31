"""Vectorized client for rl/env_worker.mjs processes.

Each worker is a Node subprocess speaking JSON-lines over stdio. Obs are
base64 float32 grids decoded to numpy; action features are padded to MAXA.
Done workers auto-reset with the next seed in the stream; terminal stats go
in info['episode'].
"""
import base64
import json
import subprocess
import numpy as np

NODE = None
MAXA = 64


def _node_bin():
    global NODE
    if NODE is None:
        import os
        import shutil
        NODE = shutil.which('node') or os.path.expanduser('~/.local/node/bin/node')
    return NODE


class EnvWorker:
    def __init__(self, level=1, cwd=None):
        import os
        cwd = cwd or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.proc = subprocess.Popen(
            [_node_bin(), 'rl/env_worker.mjs', f'--level={level}'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
            cwd=cwd, bufsize=1)
        ready = self._read()
        assert 'ready' in ready, ready
        self.ch, self.gd, self.afd = ready['ch'], ready['gd'], ready['afd']
        self.rows, self.cols = ready['rows'], ready['cols']
        self.level = level

    def _read(self):
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError(f'env worker (level {self.level}) died')
        msg = json.loads(line)
        if 'error' in msg:
            raise RuntimeError(msg['error'])
        return msg

    def _send(self, msg):
        self.proc.stdin.write(json.dumps(msg) + '\n')
        self.proc.stdin.flush()

    def reset(self, seed, warm=0):
        self._send({'cmd': 'reset', 'seed': seed, 'warm': warm})
        return self._read()

    def step(self, a):
        self._send({'cmd': 'step', 'a': int(a)})
        return self._read()

    def close(self):
        try:
            self._send({'cmd': 'close'})
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


class VecEnv:
    """N workers → batched obs/feats/mask numpy arrays. Auto-resets done envs."""

    def __init__(self, n, level=1, base_seed=0, warm=0):
        self.workers = [EnvWorker(level) for _ in range(n)]
        self.n = n
        self.ch, self.rows, self.cols = self.workers[0].ch, self.workers[0].rows, self.workers[0].cols
        self.gd, self.afd = self.workers[0].gd, self.workers[0].afd
        self._next_seed = base_seed
        # max seconds of bot pre-play per episode — train.py anneals it down
        self.warm = warm

    def _seeds(self, n):
        s = list(range(self._next_seed, self._next_seed + n))
        self._next_seed += n
        return s

    def _pack(self, msgs):
        # wire format: ch0-14 bitpacked in obs['bin'], ch15-17 as f16 in
        # obs['con']; feats are f16-packed base64 — see env_worker.mjs
        nbin = self.ch - 3
        ncells = self.rows * self.cols
        grids = np.empty((len(msgs), self.ch, self.rows, self.cols), np.float32)
        globs = np.empty((len(msgs), self.gd), np.float32)
        feats = np.zeros((len(msgs), MAXA, self.afd), np.float32)
        mask = np.zeros((len(msgs), MAXA), np.bool_)
        for i, m in enumerate(msgs):
            o = m['obs']
            b = np.unpackbits(np.frombuffer(base64.b64decode(o['bin']), np.uint8),
                              count=nbin * ncells)
            grids[i, :nbin] = b.reshape(nbin, self.rows, self.cols)
            grids[i, nbin:] = np.frombuffer(
                base64.b64decode(o['con']), np.float16).reshape(3, self.rows, self.cols)
            globs[i] = o['glob']
            fr = base64.b64decode(m['feats'])
            na = len(fr) // (2 * self.afd)
            feats[i, :na] = np.frombuffer(fr, np.float16).reshape(na, self.afd)
            mask[i, :na] = True
        return {'grid': grids, 'glob': globs, 'feats': feats, 'mask': mask}

    def reset(self):
        msgs = [w.reset(s, self.warm) for w, s in zip(self.workers, self._seeds(self.n))]
        return self._pack(msgs)

    def step(self, actions):
        msgs = [w.step(a) for w, a in zip(self.workers, actions)]
        rews = np.array([m['reward'] for m in msgs], np.float32)
        dones = np.array([m['done'] for m in msgs], np.bool_)
        infos = [m['info'] for m in msgs]
        obs = self._pack(msgs)
        # auto-reset finished games; fresh obs replaces terminal obs
        for i, (w, m) in enumerate(zip(self.workers, msgs)):
            if m['done']:
                infos[i]['episode'] = dict(m['info'])
                infos[i]['truncated'] = not m['info'].get('reason')
                rm = w.reset(int(self._seeds(1)[0]), self.warm)
                for k in obs:
                    obs[k][i] = self._pack([rm])[k][0]
        return obs, rews, dones, infos

    def close(self):
        for w in self.workers:
            w.close()
