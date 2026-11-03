"""Vectorized client for rl/env_worker.mjs processes.

Each worker is a Node subprocess: commands go in as JSON lines, replies come
back as binary frames (5×u32 LE lengths [meta,bin,con,glob,feats] + payloads,
see frame() in env_worker.mjs). Obs decode to numpy; action features are
padded to MAXA. Done workers auto-reset with the next seed in the stream;
terminal stats go in info['episode'].
"""
import json
import struct
import subprocess
import numpy as np

NODE = None
MAXA = 80


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
        self.level = level
        self.proc = subprocess.Popen(
            [_node_bin(), 'rl/env_worker.mjs', f'--level={level}'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, cwd=cwd)
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError(f'env worker (level {level}) died at startup')
        ready = json.loads(line)
        assert 'ready' in ready, ready
        self.ch, self.gd, self.afd = ready['ch'], ready['gd'], ready['afd']
        self.rows, self.cols = ready['rows'], ready['cols']

    def _readn(self, n):
        b = self.proc.stdout.read(n)
        if len(b) != n:
            raise RuntimeError(f'env worker (level {self.level}) died')
        return b

    def _read(self):
        ml, nb, nc, ng, nf = struct.unpack('<5I', self._readn(20))
        body = memoryview(self._readn(ml + nb + nc + ng + nf))
        msg = json.loads(bytes(body[:ml]))
        if 'error' in msg:
            raise RuntimeError(msg['error'])
        p = ml
        msg['obs'] = {'bin': body[p:p + nb], 'con': body[p + nb:p + nb + nc],
                      'glob': np.frombuffer(body[p + nb + nc:p + nb + nc + ng], np.float32)}
        msg['feats'] = body[p + nb + nc + ng:]
        return msg

    def _send(self, msg):
        self.proc.stdin.write((json.dumps(msg) + '\n').encode())
        self.proc.stdin.flush()

    # send/recv halves let VecEnv fire every worker before reading any reply,
    # so the sims run concurrently instead of one at a time
    def send_reset(self, seed, warm=0):
        self._send({'cmd': 'reset', 'seed': seed, 'warm': warm})

    def send_step(self, a):
        self._send({'cmd': 'step', 'a': int(a)})

    def recv(self):
        return self._read()

    def reset(self, seed, warm=0):
        self.send_reset(seed, warm)
        return self.recv()

    def step(self, a):
        self.send_step(a)
        return self.recv()

    def close(self):
        try:
            self._send({'cmd': 'close'})
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


class VecEnv:
    """N workers → batched obs/feats/mask numpy arrays. Auto-resets done envs.

    `level` may be an int or a sequence cycled across workers for mixed-map
    training (e.g. [1,1,2,3]). env_worker pads every grid to a fixed canvas
    and one-hots the level in globals, so mixed levels batch cleanly."""

    def __init__(self, n, level=1, base_seed=0, warm=0, n_groups=1):
        levels = list(level) if isinstance(level, (list, tuple)) else [level]
        self.workers = [EnvWorker(levels[i % len(levels)]) for i in range(n)]
        dims = {(w.ch, w.rows, w.cols, w.gd, w.afd) for w in self.workers}
        assert len(dims) == 1, f'obs dims differ across levels: {dims}'
        self.n = n
        # contiguous worker groups for double-buffering (1 = no overlap)
        bounds = np.linspace(0, n, min(n_groups, n) + 1).astype(int)
        self.groups = [slice(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]
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
        # wire format: binary channels bitpacked in obs['bin'], the trailing
        # continuous channels as f16 in obs['con']; feats are raw f16 — the
        # bin/con channel split is derived from buffer sizes so channel
        # additions in env_worker need no decoder change
        ncells = self.rows * self.cols
        # grids/feats stay float16 on the host (the wire is f16 / 0-1, so this is
        # lossless) — callers widen on the GPU, halving host copies and PCIe bytes
        grids = np.zeros((len(msgs), self.ch, self.rows, self.cols), np.float16)
        globs = np.empty((len(msgs), self.gd), np.float32)
        feats = np.zeros((len(msgs), MAXA, self.afd), np.float16)
        mask = np.zeros((len(msgs), MAXA), np.bool_)
        for i, m in enumerate(msgs):
            o = m['obs']
            braw, craw = o['bin'], o['con']
            nbin = len(braw) * 8 // ncells
            ncon = len(craw) // 2 // ncells
            b = np.unpackbits(np.frombuffer(braw, np.uint8), count=nbin * ncells)
            grids[i, :nbin] = b.reshape(nbin, self.rows, self.cols)
            grids[i, nbin:nbin + ncon] = np.frombuffer(
                craw, np.float16).reshape(ncon, self.rows, self.cols)
            globs[i] = o['glob']
            fr = m['feats']
            na = len(fr) // (2 * self.afd)
            feats[i, :na] = np.frombuffer(fr, np.float16).reshape(na, self.afd)
            mask[i, :na] = True
        return {'grid': grids, 'glob': globs, 'feats': feats, 'mask': mask}

    def reset(self):
        for w, s in zip(self.workers, self._seeds(self.n)):
            w.send_reset(s, self.warm)
        return self._pack([w.recv() for w in self.workers])

    def _finish(self, ws, msgs):
        rews = np.array([m['reward'] for m in msgs], np.float32)
        dones = np.array([m['done'] for m in msgs], np.bool_)
        infos = [m['info'] for m in msgs]
        obs = self._pack(msgs)
        # auto-reset finished games; fresh obs replaces terminal obs. Seeds are
        # drawn in worker order and resets fired together, same results as serial
        done_ix = [i for i, m in enumerate(msgs) if m['done']]
        for i in done_ix:
            infos[i]['episode'] = dict(msgs[i]['info'])
            infos[i]['truncated'] = not msgs[i]['info'].get('reason')
            ws[i].send_reset(int(self._seeds(1)[0]), self.warm)
        for i in done_ix:
            rm = self._pack([ws[i].recv()])
            for k in obs:
                obs[k][i] = rm[k][0]
        return obs, rews, dones, infos

    def step(self, actions):
        for w, a in zip(self.workers, actions):
            w.send_step(a)
        return self._finish(self.workers, [w.recv() for w in self.workers])

    # group API for double-buffered rollouts (rollout.collect): fire one group's
    # sims, do other work (GPU forward, decode) while they run, recv later
    def split(self, obs):
        return [{k: v[sl] for k, v in obs.items()} for sl in self.groups]

    def send_group(self, g, actions):
        for w, a in zip(self.workers[self.groups[g]], actions):
            w.send_step(a)

    def recv_group(self, g):
        ws = self.workers[self.groups[g]]
        return self._finish(ws, [w.recv() for w in ws])

    def close(self):
        for w in self.workers:
            w.close()
