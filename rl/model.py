"""Actor-critic for Supply Lines.

CNN over the channel grid + MLP over globals → shared embedding. Each
enumerated action carries a feature vector; the actor scores each
(embedding, action-feat) pair — a masked pointer head, so the action count
can vary per step. Critic reads the embedding.
"""
import os
import torch
import torch.nn as nn

# MIOpen's conv kernels hard-fault on this RDNA3 card (hipErrorLaunchFailure /
# segfault inside miopen_convolution, wedging the GPU) while every other op is
# stable. Native torch convs sidestep it; RL_MIOPEN=1 opts back in.
if not os.environ.get('RL_MIOPEN'):
    torch.backends.cudnn.enabled = False


class ActorCritic(nn.Module):
    def __init__(self, ch=20, gd=24, afd=40, emb=160):
        super().__init__()
        self.cnn = nn.Sequential(
            nn.Conv2d(ch, 32, 3, padding=1), nn.ReLU(),
            nn.Conv2d(32, 32, 3, stride=2, padding=1), nn.ReLU(),
            nn.Conv2d(32, 32, 3, stride=2, padding=1), nn.ReLU(),
        )
        # 80x32 → s2 → 40x16 → s2 → 20x8 ; map1 is 40x32 → 20x16 → 10x8
        self.cnn_out = nn.LazyLinear(256)
        self.globmlp = nn.Sequential(nn.Linear(gd, 64), nn.ReLU(), nn.Linear(64, 64), nn.ReLU())
        self.fuse = nn.Sequential(nn.LazyLinear(emb), nn.ReLU())
        self.score = nn.Sequential(nn.Linear(emb + afd, 96), nn.ReLU(), nn.Linear(96, 1))
        self.value = nn.Linear(emb, 1)

    def _cnn_flat(self, grid):
        b = grid.shape[0]
        h = self.cnn(grid)
        return h.reshape(b, -1)

    def embed(self, grid, glob):
        z = torch.cat([self.cnn_out(self._cnn_flat(grid)), self.globmlp(glob)], dim=-1)
        return self.fuse(z)

    def forward(self, grid, glob, feats, mask):
        """grid [B,CH,R,C], glob [B,GD], feats [B,A,AFD], mask [B,A] bool"""
        emb = self.embed(grid, glob)                       # [B,E]
        b, a, f = feats.shape
        e = emb.unsqueeze(1).expand(b, a, emb.shape[1])
        logits = self.score(torch.cat([e, feats], dim=-1)).squeeze(-1)  # [B,A]
        logits = logits.masked_fill(~mask, -1e9)
        return logits, self.value(emb).squeeze(-1)
