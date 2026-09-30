"""WallLoss: confidence + endpoint + angle loss on matched wall segment pairs."""

import torch
import torch.nn as nn
import torch.nn.functional as F


class WallLoss(nn.Module):
    def __init__(self, matcher, endpoint_weight=5.0, angle_weight=2.0, conf_weight=1.0):
        super().__init__()
        self.matcher = matcher
        self.endpoint_weight = endpoint_weight
        self.angle_weight = angle_weight
        self.conf_weight = conf_weight

    def forward(self, outputs, targets):
        indices = self.matcher(outputs, targets)
        bs, num_queries = outputs["pred_logits"].shape

        # ---- confidence loss (all queries: matched=1, unmatched=0) ----
        conf_target = torch.zeros(bs, num_queries, device=outputs["pred_logits"].device)
        for b, (pred_idx, _) in enumerate(indices):
            conf_target[b, pred_idx] = 1.0
        conf_loss = F.binary_cross_entropy_with_logits(outputs["pred_logits"], conf_target)

        # ---- endpoint + angle loss (matched pairs only) ----
        endpoint_loss_total = 0.0
        angle_loss_total = 0.0
        num_matched = 0

        for b, (pred_idx, tgt_idx) in enumerate(indices):
            if pred_idx.numel() == 0:
                continue
            pred_segs = outputs["pred_segments"][b, pred_idx]        # (k, 4)
            tgt_segs = targets[b]["segments"][tgt_idx]                # (k, 4)

            tgt_swapped = torch.cat([tgt_segs[:, 2:], tgt_segs[:, :2]], dim=1)
            l1_fwd = F.l1_loss(pred_segs, tgt_segs, reduction="none").sum(-1)
            l1_bwd = F.l1_loss(pred_segs, tgt_swapped, reduction="none").sum(-1)
            endpoint_loss_total += torch.minimum(l1_fwd, l1_bwd).sum()

            def seg_angle(segs):
                dx = segs[:, 2] - segs[:, 0]
                dy = segs[:, 3] - segs[:, 1]
                return torch.atan2(dy, dx)

            a_diff = torch.abs(seg_angle(pred_segs) - seg_angle(tgt_segs)) % 3.14159265
            a_diff = torch.minimum(a_diff, 3.14159265 - a_diff)
            angle_loss_total += a_diff.sum()

            num_matched += pred_idx.numel()

        num_matched = max(num_matched, 1)
        endpoint_loss = endpoint_loss_total / num_matched
        angle_loss = angle_loss_total / num_matched

        total_loss = (
            self.conf_weight * conf_loss
            + self.endpoint_weight * endpoint_loss
            + self.angle_weight * angle_loss
        )

        return {
            "loss": total_loss,
            "conf_loss": conf_loss.detach(),
            "endpoint_loss": endpoint_loss.detach() if torch.is_tensor(endpoint_loss) else torch.tensor(endpoint_loss),
            "angle_loss": angle_loss.detach() if torch.is_tensor(angle_loss) else torch.tensor(angle_loss),
        }