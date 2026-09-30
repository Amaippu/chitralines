"""
WallNet: LETR-style set-prediction model for detecting wall line segments
from a floorplan RGB image (photo, sketch, DXF-render, etc.)

Output: a fixed-size set of (x1, y1, x2, y2, confidence) predictions.
No masks, no heatmaps, no ILP. Rooms are recovered afterward by building
a planar graph from surviving segments and extracting minimal cycles
(see postprocess.py / rooms.py).
"""

import torch
import torch.nn as nn
import torchvision


# ---------------------------------------------------------------------------
# Backbone
# ---------------------------------------------------------------------------
class Backbone(nn.Module):
    """ResNet-50 backbone, returns a feature map from the last conv stage."""

    def __init__(self, pretrained=True):
        super().__init__()
        resnet = torchvision.models.resnet50(
            weights=torchvision.models.ResNet50_Weights.DEFAULT if pretrained else None
        )
        self.body = nn.Sequential(*list(resnet.children())[:-2])
        self.out_channels = 2048

    def forward(self, x):
        return self.body(x)


# ---------------------------------------------------------------------------
# Positional encoding (sine, standard DETR-style)
# ---------------------------------------------------------------------------
class PositionEmbeddingSine(nn.Module):
    def __init__(self, num_pos_feats=128, temperature=10000):
        super().__init__()
        self.num_pos_feats = num_pos_feats
        self.temperature = temperature

    def forward(self, feat_map):
        b, _, h, w = feat_map.shape
        device = feat_map.device
        y_embed = torch.arange(h, dtype=torch.float32, device=device).unsqueeze(1).repeat(1, w)
        x_embed = torch.arange(w, dtype=torch.float32, device=device).unsqueeze(0).repeat(h, 1)

        eps = 1e-6
        y_embed = y_embed / (h + eps) * 2 * 3.14159
        x_embed = x_embed / (w + eps) * 2 * 3.14159

        dim_t = torch.arange(self.num_pos_feats, dtype=torch.float32, device=device)
        dim_t = self.temperature ** (2 * (dim_t // 2) / self.num_pos_feats)

        pos_x = x_embed.unsqueeze(-1) / dim_t
        pos_y = y_embed.unsqueeze(-1) / dim_t
        pos_x = torch.stack((pos_x[..., 0::2].sin(), pos_x[..., 1::2].cos()), dim=-1).flatten(-2)
        pos_y = torch.stack((pos_y[..., 0::2].sin(), pos_y[..., 1::2].cos()), dim=-1).flatten(-2)

        pos = torch.cat((pos_y, pos_x), dim=-1)
        pos = pos.permute(2, 0, 1).unsqueeze(0).repeat(b, 1, 1, 1)
        return pos


# ---------------------------------------------------------------------------
# Full model: backbone -> transformer encoder/decoder -> heads
# ---------------------------------------------------------------------------
class WallNet(nn.Module):
    def __init__(
        self,
        num_queries=150,
        hidden_dim=256,
        nheads=8,
        num_encoder_layers=6,
        num_decoder_layers=6,
        pretrained_backbone=True,
    ):
        super().__init__()
        self.backbone = Backbone(pretrained=pretrained_backbone)
        self.input_proj = nn.Conv2d(self.backbone.out_channels, hidden_dim, kernel_size=1)
        self.pos_embed = PositionEmbeddingSine(num_pos_feats=hidden_dim // 2)

        self.transformer = nn.Transformer(
            d_model=hidden_dim,
            nhead=nheads,
            num_encoder_layers=num_encoder_layers,
            num_decoder_layers=num_decoder_layers,
            dim_feedforward=hidden_dim * 4,
            batch_first=True,
        )

        self.num_queries = num_queries
        self.query_embed = nn.Embedding(num_queries, hidden_dim)

        self.endpoint_head = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, 4),
            nn.Sigmoid(),
        )
        self.conf_head = nn.Linear(hidden_dim, 1)

    def forward(self, images):
        feat = self.backbone(images)
        feat = self.input_proj(feat)
        pos = self.pos_embed(feat)

        b, c, h, w = feat.shape
        src = (feat + pos).flatten(2).permute(0, 2, 1)

        queries = self.query_embed.weight.unsqueeze(0).repeat(b, 1, 1)
        decoded = self.transformer(src, queries)

        pred_segments = self.endpoint_head(decoded)
        pred_logits = self.conf_head(decoded).squeeze(-1)

        return {"pred_segments": pred_segments, "pred_logits": pred_logits}