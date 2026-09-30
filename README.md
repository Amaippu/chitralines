# chitralines

Wall-segment set-prediction model for floorplan images (LETR-style transformer).
Input: RGB floorplan image (CAD render, styled render, or hand-drawn sketch photo).
Output: a set of wall line segments (continuous through door/window openings),
from which rooms are recovered via minimal-cycle extraction on the resulting
planar graph. No segmentation masks, no ILP.

Part of the Amaippu suite (Chithiram / Suthiram / Niruvagam).


### Torch installation for Radeon-GPU (Mine is RX7600X)

```
# Ignore the below steps if virtual environment is already created
python3.12 -m venv .venv
source .venv/bin/activate

# Installation of the pytorch packages for the GPU

python -m pip install --index-url https://repo.amd.com/rocm/whl-multi-arch/ \
    "torch[device-gfx1102]==2.12.0+rocm7.14.1" \
    "torchvision[device-gfx1102]==0.27.0+rocm7.14.1" \
    "torchaudio==2.11.0+rocm7.14.1"
```