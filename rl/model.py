"""Actor-critic for Supply Lines.

CNN over the channel grid + MLP over globals → shared embedding. Each
enumerated action carries a feature vector; the actor scores each
(embedding, action-feat) pair — a masked pointer head, so the action count
can vary per step. Critic reads the embedding.
"""
import os
import torch
import torch.nn as nn
import torch.nn.functional as F

# MIOpen's GEMM-based weight-gradient conv solver (GemmWrwUniversal: per-sample
# im2col + rocBLAS GEMM, ~512 launches/layer at minibatch 512) segfaults after
# ~15 training updates on this RX 7600 XT (gfx1102), reproducibly and on an
# otherwise idle GPU; rollout forwards alone are fine. Native torch convs avoid
# it at no throughput cost (~240 SPS vs ~228 with MIOpen). RL_MIOPEN=1 opts back
# in; MIOPEN_DEBUG_CONV_GEMM=0 also avoids the crash while keeping MIOpen on.
if not os.environ.get('RL_MIOPEN'):
    torch.backends.cudnn.enabled = False


class GemmConv2d(nn.Conv2d):
    """nn.Conv2d as ONE batched GEMM (strided window view -> [B*Ho*Wo, C*k*k] @ W^T).

    Torch's non-MIOpen conv path loops over the batch (~1k tiny launches per
    layer at minibatch 512); this does a single big matmul instead, 2.2x faster
    forward+backward on the minibatch-512 update. Same math and parameters as
    nn.Conv2d (checkpoints interchange); fp32 results agree to ~1e-7 forward and
    ~1e-5 relative on weight grads (summation order). RL_NATIVE_CONV=1 opts out.
    """

    def forward(self, x):
        if self.groups != 1 or self.dilation != (1, 1) or self.padding_mode != 'zeros':
            return super().forward(x)
        (kh, kw), (sh, sw), (ph, pw) = self.kernel_size, self.stride, self.padding
        win = F.pad(x, (pw, pw, ph, ph)).unfold(2, kh, sh).unfold(3, kw, sw)   # [B,C,Ho,Wo,kh,kw]
        b, _, ho, wo = win.shape[:4]
        cols = win.permute(0, 2, 3, 1, 4, 5).reshape(b * ho * wo, -1)
        out = torch.addmm(self.bias, cols, self.weight.view(self.out_channels, -1).t())
        return out.view(b, ho, wo, self.out_channels).permute(0, 3, 1, 2).contiguous()


Conv = nn.Conv2d if os.environ.get('RL_NATIVE_CONV') else GemmConv2d


class ActorCritic(nn.Module):
    def __init__(self, ch=20, gd=24, afd=40, emb=160):
        super().__init__()
        self.cnn = nn.Sequential(
            Conv(ch, 32, 3, padding=1), nn.ReLU(),
            Conv(32, 32, 3, stride=2, padding=1), nn.ReLU(),
            Conv(32, 32, 3, stride=2, padding=1), nn.ReLU(),
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
        # critic reads the trunk but doesn't shape it — TD divergence
        # (bootstrapped v chasing its own drift) used to ride the shared
        # gradient back into the trunk and saturate the policy's logits
        # (ent→0 twice). Detached, worst case is a bad critic — not a
        # corrupted actor.
        return logits, self.value(emb.detach()).squeeze(-1)
