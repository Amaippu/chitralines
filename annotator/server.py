"""
Wall annotator backend.

Usage:
    python server.py --dir /path/to/images [--port 8000]

Serves a browser-based annotator UI. Point it at a folder of .jpg/.jpeg
floorplan images; each image gets a sibling <same_basename>.json holding
its wall-segment annotation, created/updated as you annotate.
"""

import argparse
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

app = FastAPI()

# Populated at startup from --dir
IMAGE_DIR: Path = None

VALID_EXTS = {".jpg", ".jpeg"}


def annotation_path_for(image_filename: str) -> Path:
    """Given 'floorplan_001.jpg', return Path to 'floorplan_001.json' in the same dir."""
    return IMAGE_DIR / (Path(image_filename).stem + ".json")


@app.get("/api/images")
def list_images():
    """Return all jpg/jpeg filenames in IMAGE_DIR, sorted, plus whether each
    already has an annotation on disk (so the frontend can show progress)."""
    if not IMAGE_DIR.is_dir():
        raise HTTPException(status_code=500, detail=f"Directory not found: {IMAGE_DIR}")

    files = sorted(
        p.name for p in IMAGE_DIR.iterdir()
        if p.suffix.lower() in VALID_EXTS and p.is_file()
    )
    result = []
    for f in files:
        ann_path = annotation_path_for(f)
        result.append({"filename": f, "annotated": ann_path.exists()})
    return result


@app.get("/api/image/{filename}")
def get_image(filename: str):
    path = IMAGE_DIR / filename
    if not path.is_file() or path.suffix.lower() not in VALID_EXTS:
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(path)


@app.get("/api/annotation/{filename}")
def get_annotation(filename: str):
    """Return the saved annotation for this image, or an empty graph if none exists yet."""
    ann_path = annotation_path_for(filename)
    if ann_path.exists():
        with open(ann_path, "r") as f:
            return JSONResponse(json.load(f))
    return JSONResponse({"nodes": [], "edges": []})


@app.post("/api/annotation/{filename}")
async def save_annotation(filename: str, payload: dict):
    """
    Save the annotation for this image.
    Expected payload shape:
        {
          "image_width": int,
          "image_height": int,
          "nodes": [{"id": int, "x": float, "y": float}, ...],
          "edges": [{"a": node_id, "b": node_id}, ...]
        }
    Stored to disk exactly as received (node/edge graph, pixel coords).
    Normalization to [x1,y1,x2,y2] segments happens at training-data-export
    time, not here, so the annotator always keeps the authoritative graph.
    """
    ann_path = annotation_path_for(filename)
    with open(ann_path, "w") as f:
        json.dump(payload, f, indent=2)
    return {"status": "ok", "path": str(ann_path)}


def main():
    global IMAGE_DIR

    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, help="Directory of .jpg/.jpeg images to annotate")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    IMAGE_DIR = Path(args.dir).resolve()
    if not IMAGE_DIR.is_dir():
        raise SystemExit(f"Not a directory: {IMAGE_DIR}")

    # Serve the frontend (index.html, annotator.js, style.css) from ./static
    static_dir = Path(__file__).parent / "static"
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

    print(f"Serving annotator for images in: {IMAGE_DIR}")
    print(f"Open: http://localhost:{args.port}")
    uvicorn.run(app, host="0.0.0.0", port=args.port)


if __name__ == "__main__":
    main()