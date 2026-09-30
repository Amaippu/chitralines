"""WallMatcher: Hungarian assignment between predicted and ground-truth wall segments."""

import torch
import torch.nn as nn
from scipy.optimize import linear_sum_assignment


class WallMatcher(nn.Module):
    """
    Finds the optimal bipartite matching between N predicted segments and
    M ground-truth segments per image, minimizing endpoint L1 + angle cost.
    """

    def __init__(self, cost_endpoint=5.0, cost_angle=2.0, cost_conf=1.0):
        super().__init__()
        self.cost_endpoint = cost_endpoint
        self.cost_angle = cost_angle
        self.cost_conf = cost_conf

    @torch.no_grad()
    def forward(self, outputs, targets):
        """
        outputs: dict with "pred_segments" (B,N,4), "pred_logits" (B,N)
        targets: list of length B, each a dict with "segments" (M_i, 4) tensor
        returns: list of (pred_idx, tgt_idx) tensors, one pair per image
        """
        bs, num_queries = outputs["pred_logits"].shape
        indices = []

        pred_probs = outputs["pred_logits"].sigmoid()  # (B, N)

        for b in range(bs):
            tgt_segs = targets[b]["segments"]  # (M, 4)
            if tgt_segs.numel() == 0:
                indices.append((torch.empty(0, dtype=torch.long), torch.empty(0, dtype=torch.long)))
                continue

            pred_segs = outputs["pred_segments"][b]  # (N, 4)

            # endpoint L1 cost, considering both directions of each segment
            # (a wall from p1->p2 is the same as p2->p1)
            cost_fwd = torch.cdist(pred_segs, tgt_segs, p=1)  # (N, M)
            tgt_swapped = torch.cat([tgt_segs[:, 2:], tgt_segs[:, :2]], dim=1)
            cost_bwd = torch.cdist(pred_segs, tgt_swapped, p=1)
            cost_endpoint = torch.minimum(cost_fwd, cost_bwd)

            # angle cost: penalize direction mismatch (undirected line, so mod pi)
            def seg_angle(segs):
                dx = segs[:, 2] - segs[:, 0]
                dy = segs[:, 3] - segs[:, 1]
                return torch.atan2(dy, dx)

            pred_angle = seg_angle(pred_segs).unsqueeze(1)  # (N,1)
            tgt_angle = seg_angle(tgt_segs).unsqueeze(0)     # (1,M)
            angle_diff = torch.abs(pred_angle - tgt_angle) % 3.14159265
            angle_diff = torch.minimum(angle_diff, 3.14159265 - angle_diff)

            cost_conf = -pred_probs[b].unsqueeze(1)  # prefer confident predictions

            total_cost = (
                self.cost_endpoint * cost_endpoint
                + self.cost_angle * angle_diff
                + self.cost_conf * cost_conf
            )

            pred_idx, tgt_idx = linear_sum_assignment(total_cost.cpu().numpy())
            indices.append((torch.as_tensor(pred_idx), torch.as_tensor(tgt_idx)))

        return indices