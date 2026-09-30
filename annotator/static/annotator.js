// ============================================================================
// Wall Annotator
//
// Data model: a node/edge graph (not raw line segments). Nodes are unique
// points; edges reference node IDs. Snapping onto an existing point reuses
// its exact node ID rather than a nearby float coordinate -- this is what
// keeps corners/junctions exact, which matters for later minimal-cycle room
// extraction on the exported wall graph.
// ============================================================================

// ----------------------------------------------------------------------------
// CONFIG -- every visual/behavioral constant lives here. Change appearance
// or snap sensitivity by editing this object only; nothing below should
// contain a hardcoded color, size, or threshold.
// ----------------------------------------------------------------------------
const CONFIG = {
    colors: {
        edge: "#43c6ff",
        edgeSelected: "#ff5050",
        node: "#43c6ff",
        chainPreview: "#ffd24d",
        snapRing: "#ffd24d",
        alignGuide: "#ff50c8",
    },
    sizes: {
        edgeWidth: 5,
        edgeWidthSelected: 6,
        nodeRadius: 7,
        snapRingRadius: 16,
        snapRingWidth: 4,
        chainPreviewWidth: 4,
        alignGuideWidth: 2,
        alignedNodeRingRadius: 14,   // highlight ring drawn around a node the guide line is aligned to
        alignedNodeRingWidth: 4,
    },
    dash: {
        chainPreview: [5, 4],
        alignGuide: [6, 4],
    },
    snap: {
        radiusScreenPx: 12,     // endpoint/edge snap radius, in screen pixels (divided by zoom)
        angleSnapDegrees: 45,   // snap angle to nearest multiple of this, while Shift is held
        alignThresholdScreenPx: 10, // how close (in screen px) to another node's x/y counts as "aligned"
    },
};

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const state = {
    dir: null,
    images: [],           // [{filename, annotated}]
    currentIndex: -1,
    image: null,           // HTMLImageElement, currently loaded
    imageWidth: 0,
    imageHeight: 0,

    nodes: [],             // [{id, x, y}]  (x,y in IMAGE pixel space)
    edges: [],             // [{a: nodeId, b: nodeId}]
    nextNodeId: 0,

    // view transform: screen = image * zoom + pan
    zoom: 1,
    panX: 0,
    panY: 0,

    // interaction
    mode: "idle",          // "idle" | "drawing"
    drawChain: [],         // node IDs committed so far in the current polyline chain
    hoverPoint: null,      // {x,y, snapType?} in IMAGE space -- the "next click" preview point
    selectedEdgeIndex: -1,
    angleSnapHeld: false,  // Shift key -- used both while drawing a chain and while dragging a node

    draggingNodeId: null,
    dragOriginalPos: null, // {x, y} of the node BEFORE the current drag started, for Shift axis-lock
    activeGuides: null,    // {x: number|null, y: number|null} -- alignment guide lines to render, in IMAGE space

    dirty: false,          // unsaved changes since last save
    undoStack: [],
    redoStack: [],
};

// ----------------------------------------------------------------------------
// Coordinate transforms
// ----------------------------------------------------------------------------

function imageToScreen(x, y) {
    return { x: x * state.zoom + state.panX, y: y * state.zoom + state.panY };
}

function screenToImage(x, y) {
    return { x: (x - state.panX) / state.zoom, y: (y - state.panY) / state.zoom };
}

function snapRadiusInImageSpace() {
    return CONFIG.snap.radiusScreenPx / state.zoom;
}

function alignThresholdInImageSpace() {
    return CONFIG.snap.alignThresholdScreenPx / state.zoom;
}

// ----------------------------------------------------------------------------
// Undo / redo
// ----------------------------------------------------------------------------

function snapshotGraph() {
    return {
        nodes: state.nodes.map(n => ({ ...n })),
        edges: state.edges.map(e => ({ ...e })),
        nextNodeId: state.nextNodeId,
    };
}

function pushUndo() {
    state.undoStack.push(snapshotGraph());
    state.redoStack = [];
    if (state.undoStack.length > 200) state.undoStack.shift();
}

function restoreSnapshot(snap) {
    state.nodes = snap.nodes.map(n => ({ ...n }));
    state.edges = snap.edges.map(e => ({ ...e }));
    state.nextNodeId = snap.nextNodeId;
}

function undo() {
    if (state.undoStack.length === 0) return;
    state.redoStack.push(snapshotGraph());
    const snap = state.undoStack.pop();
    restoreSnapshot(snap);
    markDirty();
    render();
}

function redo() {
    if (state.redoStack.length === 0) return;
    state.undoStack.push(snapshotGraph());
    const snap = state.redoStack.pop();
    restoreSnapshot(snap);
    markDirty();
    render();
}

// ----------------------------------------------------------------------------
// Graph operations
// ----------------------------------------------------------------------------

function deleteNode(nodeId) {
    // Remove the node and any connected edges (cascade delete).
    state.nodes = state.nodes.filter(n => n.id !== nodeId);
    state.edges = state.edges.filter(e => e.a !== nodeId && e.b !== nodeId);
}

function addNode(x, y) {
    const node = { id: state.nextNodeId++, x, y };
    state.nodes.push(node);
    return node;
}

function addEdge(nodeIdA, nodeIdB) {
    if (nodeIdA === nodeIdB) return; // no zero-length self edge
    const exists = state.edges.some(
        e => (e.a === nodeIdA && e.b === nodeIdB) || (e.a === nodeIdB && e.b === nodeIdA)
    );
    if (exists) return;
    state.edges.push({ a: nodeIdA, b: nodeIdB });
}

function getNode(id) {
    return state.nodes.find(n => n.id === id);
}

function deleteEdgeAt(index) {
    const edge = state.edges[index];
    if (!edge) return;
    state.edges.splice(index, 1);
    // remove now-orphaned nodes (not referenced by any remaining edge)
    const referenced = new Set();
    state.edges.forEach(e => { referenced.add(e.a); referenced.add(e.b); });
    state.nodes = state.nodes.filter(n => referenced.has(n.id));
}

// ----------------------------------------------------------------------------
// Snapping: corner/T-junction snap (existing geometry)
// ----------------------------------------------------------------------------

// Returns the best snap target near an image-space point (px, py), or null.
// Priority: existing node (endpoint) > interior of an existing edge (T-junction).
function findSnapTarget(px, py, excludeNodeId) {
    const radius = snapRadiusInImageSpace();

    let best = null;
    let bestDist = radius;
    for (const n of state.nodes) {
        if (n.id === excludeNodeId) continue;
        const d = Math.hypot(n.x - px, n.y - py);
        if (d < bestDist) {
            bestDist = d;
            best = { type: "node", nodeId: n.id, x: n.x, y: n.y };
        }
    }
    if (best) return best;

    let bestEdge = null;
    let bestEdgeDist = radius;
    for (const e of state.edges) {
        const a = getNode(e.a), b = getNode(e.b);
        if (!a || !b) continue;
        const proj = projectPointOntoSegment(px, py, a.x, a.y, b.x, b.y);
        if (proj.t > 0.02 && proj.t < 0.98) {
            const d = Math.hypot(proj.x - px, proj.y - py);
            if (d < bestEdgeDist) {
                bestEdgeDist = d;
                bestEdge = { type: "edge", edgeIndex: state.edges.indexOf(e), x: proj.x, y: proj.y };
            }
        }
    }
    return bestEdge;
}

function projectPointOntoSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return { x: ax, y: ay, t: 0 };
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return { x: ax + t * dx, y: ay + t * dy, t };
}

// ----------------------------------------------------------------------------
// Snapping: alignment guides (align to another node's x or y coordinate)
// ----------------------------------------------------------------------------

// Looks at every node except excludeNodeId, and finds the closest match (if
// any, within the alignment threshold) on the x axis and on the y axis
// independently. Returns the snapped point, the guide coordinate for each
// axis, AND the id of every node that actually sits on that guide line --
// so the caller can highlight each one (e.g. in a square, both the top-left
// and bottom-left nodes share the same x, and both should light up).
function findAlignmentSnap(px, py, excludeNodeId) {
    const threshold = alignThresholdInImageSpace();

    let bestX = null, bestXDist = threshold;
    let bestY = null, bestYDist = threshold;

    for (const n of state.nodes) {
        if (n.id === excludeNodeId) continue;
        const dx = Math.abs(n.x - px);
        if (dx < bestXDist) { bestXDist = dx; bestX = n.x; }
        const dy = Math.abs(n.y - py);
        if (dy < bestYDist) { bestYDist = dy; bestY = n.y; }
    }

    // second pass: now that we know the snapped x/y values, collect every
    // node (excluding the dragged one) that sits on those exact lines --
    // there may be more than one node sharing a coordinate.
    const alignedNodeIdsX = [];
    const alignedNodeIdsY = [];
    if (bestX !== null || bestY !== null) {
        for (const n of state.nodes) {
            if (n.id === excludeNodeId) continue;
            if (bestX !== null && Math.abs(n.x - bestX) < 1e-6) alignedNodeIdsX.push(n.id);
            if (bestY !== null && Math.abs(n.y - bestY) < 1e-6) alignedNodeIdsY.push(n.id);
        }
    }

    return {
        x: bestX !== null ? bestX : px,
        y: bestY !== null ? bestY : py,
        guideX: bestX,   // the x-coordinate to draw a vertical guide line at, or null
        guideY: bestY,   // the y-coordinate to draw a horizontal guide line at, or null
        alignedNodeIdsX, // every node id that sits exactly on the x guide line
        alignedNodeIdsY, // every node id that sits exactly on the y guide line
    };
}

// Given a fixed start point and a raw target point, snap the angle between
// them to the nearest multiple of angleSnapDegrees, preserving distance.
function applyAngleSnap(startX, startY, targetX, targetY) {
    const dx = targetX - startX, dy = targetY - startY;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return { x: targetX, y: targetY };
    const angle = Math.atan2(dy, dx);
    const step = (CONFIG.snap.angleSnapDegrees * Math.PI) / 180;
    const snappedAngle = Math.round(angle / step) * step;
    return {
        x: startX + Math.cos(snappedAngle) * dist,
        y: startY + Math.sin(snappedAngle) * dist,
    };
}

// Resolve a snap target into an actual node ID, creating a new node if the
// target is a raw point, or splitting an existing edge if the target is its
// interior (T-junction).
function resolveToNodeId(px, py, snapTarget) {
    if (snapTarget && snapTarget.type === "node") {
        return snapTarget.nodeId;
    }
    if (snapTarget && snapTarget.type === "edge") {
        const edge = state.edges[snapTarget.edgeIndex];
        const a = edge.a, b = edge.b;
        state.edges.splice(snapTarget.edgeIndex, 1);
        const newNode = addNode(snapTarget.x, snapTarget.y);
        addEdge(a, newNode.id);
        addEdge(b, newNode.id);
        return newNode.id;
    }
    const newNode = addNode(px, py);
    return newNode.id;
}

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------

function resizeCanvasToWrap() {
    const wrap = document.getElementById("canvas-wrap");
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
}

function fitImageToView() {
    if (!state.image) return;
    const wrap = document.getElementById("canvas-wrap");
    const margin = 40;
    const scaleX = (wrap.clientWidth - margin) / state.imageWidth;
    const scaleY = (wrap.clientHeight - margin) / state.imageHeight;
    state.zoom = Math.min(scaleX, scaleY, 1.5);
    state.panX = (wrap.clientWidth - state.imageWidth * state.zoom) / 2;
    state.panY = (wrap.clientHeight - state.imageHeight * state.zoom) / 2;
}

function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (state.image) {
        const topLeft = imageToScreen(0, 0);
        ctx.drawImage(
            state.image, topLeft.x, topLeft.y,
            state.imageWidth * state.zoom, state.imageHeight * state.zoom
        );
    }

    // alignment guide lines (drawn under the geometry, full-canvas dashed lines)
    if (state.activeGuides) {
        ctx.save();
        ctx.strokeStyle = CONFIG.colors.alignGuide;
        ctx.lineWidth = CONFIG.sizes.alignGuideWidth;
        ctx.setLineDash(CONFIG.dash.alignGuide);
        if (state.activeGuides.x !== null) {
            const sx = imageToScreen(state.activeGuides.x, 0).x;
            ctx.beginPath();
            ctx.moveTo(sx, 0);
            ctx.lineTo(sx, canvas.height);
            ctx.stroke();
        }
        if (state.activeGuides.y !== null) {
            const sy = imageToScreen(0, state.activeGuides.y).y;
            ctx.beginPath();
            ctx.moveTo(0, sy);
            ctx.lineTo(canvas.width, sy);
            ctx.stroke();
        }
        ctx.restore();

        // highlight every node the guide line actually passes through, so it's
        // unambiguous WHICH node(s) the current drag is aligned to
        const highlightedIds = new Set([
            ...(state.activeGuides.nodeIdsX || []),
            ...(state.activeGuides.nodeIdsY || []),
        ]);
        if (highlightedIds.size > 0) {
            ctx.save();
            ctx.strokeStyle = CONFIG.colors.alignGuide;
            ctx.lineWidth = CONFIG.sizes.alignedNodeRingWidth;
            ctx.setLineDash([]);
            highlightedIds.forEach(id => {
                const n = getNode(id);
                if (!n) return;
                const p = imageToScreen(n.x, n.y);
                ctx.beginPath();
                ctx.arc(p.x, p.y, CONFIG.sizes.alignedNodeRingRadius, 0, Math.PI * 2);
                ctx.stroke();
            });
            ctx.restore();
        }
    }

    // committed edges
    state.edges.forEach((e, idx) => {
        const a = getNode(e.a), b = getNode(e.b);
        if (!a || !b) return;
        const pa = imageToScreen(a.x, a.y), pb = imageToScreen(b.x, b.y);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.strokeStyle = idx === state.selectedEdgeIndex ? CONFIG.colors.edgeSelected : CONFIG.colors.edge;
        ctx.lineWidth = idx === state.selectedEdgeIndex ? CONFIG.sizes.edgeWidthSelected : CONFIG.sizes.edgeWidth;
        ctx.stroke();
    });

    // nodes (corners/junctions)
    state.nodes.forEach(n => {
        const p = imageToScreen(n.x, n.y);
        ctx.beginPath();
        ctx.arc(p.x, p.y, CONFIG.sizes.nodeRadius, 0, Math.PI * 2);
        ctx.fillStyle = CONFIG.colors.node;
        ctx.fill();
    });

    // in-progress chain preview
    if (state.mode === "drawing" && state.drawChain.length > 0) {
        const last = getNode(state.drawChain[state.drawChain.length - 1]);
        if (last && state.hoverPoint) {
            const pa = imageToScreen(last.x, last.y);
            const pb = imageToScreen(state.hoverPoint.x, state.hoverPoint.y);
            ctx.beginPath();
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(pb.x, pb.y);
            ctx.strokeStyle = CONFIG.colors.chainPreview;
            ctx.lineWidth = CONFIG.sizes.chainPreviewWidth;
            ctx.setLineDash(CONFIG.dash.chainPreview);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }

    // snap indicator (highlight ring at hover point if it snapped to existing geometry)
    if (state.hoverPoint && state.hoverPoint.snapType) {
        const p = imageToScreen(state.hoverPoint.x, state.hoverPoint.y);
        ctx.beginPath();
        ctx.arc(p.x, p.y, CONFIG.sizes.snapRingRadius, 0, Math.PI * 2);
        ctx.strokeStyle = CONFIG.colors.snapRing;
        ctx.lineWidth = CONFIG.sizes.snapRingWidth;
        ctx.stroke();
    }
}

// ----------------------------------------------------------------------------
// Mouse interaction
// ----------------------------------------------------------------------------

function getMouseImagePoint(evt) {
    const rect = canvas.getBoundingClientRect();
    const sx = evt.clientX - rect.left;
    const sy = evt.clientY - rect.top;
    return screenToImage(sx, sy);
}

canvas.addEventListener("mousemove", evt => {
    if (!state.image) return;
    const raw = getMouseImagePoint(evt);

    // --- actively dragging a node (Ctrl+drag) ---
    if (state.draggingNodeId !== null) {
        const node = getNode(state.draggingNodeId);
        if (!node) return;

        let px = raw.x, py = raw.y;
        state.activeGuides = null;

        if (state.angleSnapHeld && state.dragOriginalPos) {
            // Shift: constrain movement direction to the nearest 45deg from where
            // the node started, same mental model as Shift while drawing a chain.
            const snapped = applyAngleSnap(state.dragOriginalPos.x, state.dragOriginalPos.y, raw.x, raw.y);
            px = snapped.x;
            py = snapped.y;
        } else {
            // no angle-lock requested: offer alignment-guide snapping to other nodes
            const align = findAlignmentSnap(raw.x, raw.y, node.id);
            px = align.x;
            py = align.y;
            if (align.guideX !== null || align.guideY !== null) {
                state.activeGuides = {
                    x: align.guideX,
                    y: align.guideY,
                    nodeIdsX: align.alignedNodeIdsX,
                    nodeIdsY: align.alignedNodeIdsY,
                };
            }
        }

        node.x = px;
        node.y = py;
        markDirty();
        render();
        return; // skip normal hover/snap-preview logic while dragging
    }

    // --- normal hover (drawing mode or idle) ---
    const excludeId =
        state.mode === "drawing" && state.drawChain.length > 0
            ? state.drawChain[state.drawChain.length - 1]
            : undefined;
    const snap = findSnapTarget(raw.x, raw.y, excludeId);

    let px = snap ? snap.x : raw.x;
    let py = snap ? snap.y : raw.y;
    state.activeGuides = null;

    if (state.mode === "drawing" && state.angleSnapHeld && !snap && state.drawChain.length > 0) {
        const start = getNode(state.drawChain[state.drawChain.length - 1]);
        const snapped = applyAngleSnap(start.x, start.y, raw.x, raw.y);
        px = snapped.x;
        py = snapped.y;
    } else if (!snap) {
        // also offer alignment guides while placing a fresh point (not just dragging)
        const align = findAlignmentSnap(raw.x, raw.y, excludeId);
        if (align.guideX !== null || align.guideY !== null) {
            px = align.x;
            py = align.y;
            state.activeGuides = {
                x: align.guideX,
                y: align.guideY,
                nodeIdsX: align.alignedNodeIdsX,
                nodeIdsY: align.alignedNodeIdsY,
            };
        }
    }

    state.hoverPoint = { x: px, y: py, snapType: snap ? snap.type : null };
    render();
});

canvas.addEventListener("click", evt => {
    if (evt.ctrlKey || evt.metaKey || evt.altKey) return;

    if (!state.image) return;
    if (!state.hoverPoint) return;

    const { x, y } = state.hoverPoint;

    const excludeId =
        state.mode === "drawing" && state.drawChain.length > 0
            ? state.drawChain[state.drawChain.length - 1]
            : undefined;
    const snap = findSnapTarget(x, y, excludeId);

    if (state.mode !== "drawing") {
        pushUndo();
        const nodeId = resolveToNodeId(x, y, snap);
        state.drawChain = [nodeId];
        state.mode = "drawing";
        markDirty();
        render();
        return;
    }

    const lastId = state.drawChain[state.drawChain.length - 1];
    pushUndo();
    const nodeId = resolveToNodeId(x, y, snap);
    addEdge(lastId, nodeId);
    state.drawChain.push(nodeId);
    markDirty();
    render();
});

canvas.addEventListener("dblclick", evt => {
    evt.preventDefault();
    endDrawing();
});

canvas.addEventListener("contextmenu", evt => {
    evt.preventDefault();
    endDrawing();
});

function endDrawing() {
    state.mode = "idle";
    state.drawChain = [];
    render();
}

canvas.addEventListener("mousedown", evt => {
    if (!state.image) return;

    // Ctrl + Left Click: start dragging a node
    if ((evt.ctrlKey || evt.metaKey) && evt.button === 0) {
        const raw = getMouseImagePoint(evt);
        const radius = snapRadiusInImageSpace();
        let bestNode = null;
        let bestDist = radius;

        state.nodes.forEach(n => {
            const d = Math.hypot(n.x - raw.x, n.y - raw.y);
            if (d < bestDist) { bestDist = d; bestNode = n; }
        });

        if (bestNode) {
            pushUndo();
            state.draggingNodeId = bestNode.id;
            state.dragOriginalPos = { x: bestNode.x, y: bestNode.y };
        }
        return;
    }

    // Alt + Left Click: delete node (cascade) or, failing that, an edge
    if (evt.altKey && evt.button === 0) {
        const raw = getMouseImagePoint(evt);
        const radius = snapRadiusInImageSpace();

        let bestNode = null;
        let bestNodeDist = radius;
        state.nodes.forEach(n => {
            const d = Math.hypot(n.x - raw.x, n.y - raw.y);
            if (d < bestNodeDist) { bestNodeDist = d; bestNode = n; }
        });

        if (bestNode) {
            pushUndo();
            deleteNode(bestNode.id);
            endDrawing();
            markDirty();
            render();
            return;
        }

        let bestIdx = -1, bestDist = radius;
        state.edges.forEach((e, idx) => {
            const a = getNode(e.a), b = getNode(e.b);
            if (!a || !b) return;
            const proj = projectPointOntoSegment(raw.x, raw.y, a.x, a.y, b.x, b.y);
            const d = Math.hypot(proj.x - raw.x, proj.y - raw.y);
            if (d < bestDist) { bestDist = d; bestIdx = idx; }
        });
        if (bestIdx >= 0) {
            pushUndo();
            deleteEdgeAt(bestIdx);
            endDrawing();
            markDirty();
            render();
        }
    }
});

// zoom (wheel, centered on cursor)
canvas.addEventListener("wheel", evt => {
    evt.preventDefault();
    if (!state.image) return;
    const rect = canvas.getBoundingClientRect();
    const sx = evt.clientX - rect.left, sy = evt.clientY - rect.top;
    const before = screenToImage(sx, sy);

    const factor = evt.deltaY < 0 ? 1.1 : 1 / 1.1;
    state.zoom = Math.max(0.05, Math.min(20, state.zoom * factor));

    const after = screenToImage(sx, sy);
    state.panX += (after.x - before.x) * state.zoom;
    state.panY += (after.y - before.y) * state.zoom;
    render();
}, { passive: false });

// pan (space + drag, or middle-mouse drag)
let isPanning = false;
let panStart = null;
let spaceHeld = false;

window.addEventListener("keydown", evt => {
    if (evt.code === "Space") spaceHeld = true;
    if (evt.key === "Shift") { state.angleSnapHeld = true; }
    if (evt.key === "Escape") endDrawing();
    if ((evt.ctrlKey || evt.metaKey) && evt.key === "z") { evt.preventDefault(); undo(); }
    if ((evt.ctrlKey || evt.metaKey) && evt.key === "y") { evt.preventDefault(); redo(); }
    if ((evt.ctrlKey || evt.metaKey) && evt.key === "s") { evt.preventDefault(); saveAnnotation(); }
    if (evt.key === ",") goToImage(state.currentIndex - 1);
    if (evt.key === ".") goToImage(state.currentIndex + 1);
});
window.addEventListener("keyup", evt => {
    if (evt.code === "Space") spaceHeld = false;
    if (evt.key === "Shift") { state.angleSnapHeld = false; }
});

canvas.addEventListener("mousedown", evt => {
    if (evt.button === 1 || (evt.button === 0 && spaceHeld)) {
        isPanning = true;
        panStart = { x: evt.clientX, y: evt.clientY, panX: state.panX, panY: state.panY };
    }
});
window.addEventListener("mousemove", evt => {
    if (!isPanning) return;
    state.panX = panStart.panX + (evt.clientX - panStart.x);
    state.panY = panStart.panY + (evt.clientY - panStart.y);
    render();
});
window.addEventListener("mouseup", () => {
    isPanning = false;
    state.draggingNodeId = null;
    state.dragOriginalPos = null;
    state.activeGuides = null;
    render();
});

// ----------------------------------------------------------------------------
// Save / dirty state
// ----------------------------------------------------------------------------

function markDirty() {
    state.dirty = true;
    const el = document.getElementById("save-status");
    el.textContent = "unsaved changes";
    el.className = "dirty";
}

async function saveAnnotation() {
    if (state.currentIndex < 0) return;
    const filename = state.images[state.currentIndex].filename;
    const payload = {
        image_width: state.imageWidth,
        image_height: state.imageHeight,
        nodes: state.nodes,
        edges: state.edges,
    };
    const el = document.getElementById("save-status");
    try {
        const res = await fetch(`/api/annotation/${encodeURIComponent(filename)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(await res.text());
        state.dirty = false;
        el.textContent = "saved";
        el.className = "";
        state.images[state.currentIndex].annotated = state.edges.length > 0;
        renderImageList();
    } catch (err) {
        el.textContent = "save failed";
        el.className = "error";
        console.error(err);
    }
}

// ----------------------------------------------------------------------------
// Image / directory loading
// ----------------------------------------------------------------------------

async function loadDirectory() {
    const dirInput = document.getElementById("dir-input");
    state.dir = dirInput.value.trim();
    const res = await fetch("/api/images");
    if (!res.ok) {
        alert("Failed to list images: " + (await res.text()));
        return;
    }
    state.images = await res.json();
    renderImageList();
    if (state.images.length > 0) goToImage(0);
}

function renderImageList() {
    const list = document.getElementById("image-list");
    list.innerHTML = "";
    state.images.forEach((img, idx) => {
        const item = document.createElement("div");
        item.className = "image-list-item" + (idx === state.currentIndex ? " active" : "");
        item.innerHTML = `<span>${img.filename}</span><span class="dot ${img.annotated ? "done" : ""}"></span>`;
        item.onclick = () => goToImage(idx);
        list.appendChild(item);
    });
    document.getElementById("progress-count").textContent =
        state.images.length > 0
            ? `${state.images.filter(i => i.annotated).length}/${state.images.length} annotated`
            : "";
}

async function goToImage(index) {
    if (index < 0 || index >= state.images.length) return;
    if (state.dirty) {
        const ok = confirm("You have unsaved changes. Save before switching images?");
        if (ok) await saveAnnotation();
    }

    state.currentIndex = index;
    const filename = state.images[index].filename;
    document.getElementById("current-filename").textContent = filename;

    const img = new Image();
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = `/api/image/${encodeURIComponent(filename)}?t=${Date.now()}`;
    });
    state.image = img;
    state.imageWidth = img.naturalWidth;
    state.imageHeight = img.naturalHeight;

    const annRes = await fetch(`/api/annotation/${encodeURIComponent(filename)}`);
    const ann = await annRes.json();
    state.nodes = ann.nodes || [];
    state.edges = ann.edges || [];
    state.nextNodeId = state.nodes.length > 0 ? Math.max(...state.nodes.map(n => n.id)) + 1 : 0;
    state.undoStack = [];
    state.redoStack = [];
    state.mode = "idle";
    state.drawChain = [];
    state.dirty = false;
    document.getElementById("save-status").textContent = "";
    document.getElementById("save-status").className = "";

    fitImageToView();
    renderImageList();
    render();
}

// ----------------------------------------------------------------------------
// Wire up toolbar
// ----------------------------------------------------------------------------

document.getElementById("load-dir-btn").onclick = loadDirectory;
document.getElementById("prev-btn").onclick = () => goToImage(state.currentIndex - 1);
document.getElementById("next-btn").onclick = () => goToImage(state.currentIndex + 1);
document.getElementById("undo-btn").onclick = undo;
document.getElementById("redo-btn").onclick = redo;
document.getElementById("save-btn").onclick = saveAnnotation;
document.getElementById("clear-btn").onclick = () => {
    if (state.nodes.length === 0 && state.edges.length === 0) return;
    if (!confirm("Are you sure you want to clear all annotations?")) return;

    pushUndo();
    state.nodes = [];
    state.edges = [];
    state.nextNodeId = 0;
    endDrawing();
    markDirty();
    render();
};

window.addEventListener("resize", () => {
    resizeCanvasToWrap();
    render();
});

// initial boot
resizeCanvasToWrap();
render();
loadDirectory();