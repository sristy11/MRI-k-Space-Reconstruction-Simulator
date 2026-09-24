// Paint-brush sampling: instead of an algorithmic pattern, the user directly
// paints which k-space points are kept. Sent to the backend as
// pattern="custom" with a custom_mask 2D array of 0/1.
//
// Two canvases share one underlying mask: a small inline one in the sidebar,
// and a larger one in an expandable modal for easier precise drawing. Both
// always redraw together, so closing the modal just reveals the same result
// on the small canvas — nothing is lost or reset by expanding/collapsing.
//
// IMPORTANT (bug fix): the paint grid is NOT a fixed 256x256 any more. The
// backend multiplies the mask straight into k-space and rejects anything whose
// shape doesn't match, so a hardcoded 256x256 mask could only ever work for
// uploaded photos (which we resize to 256x256). A real .h5 scan slice has its
// own k-space shape (e.g. 640x368), so "apply mask" always failed with
// "custom_mask shape (256, 256) doesn't match k-space shape (640, 368)".
// The grid now tracks the shape of the loaded k-space (window.LAST_KSPACE_FULL)
// and the existing painting is resampled whenever that shape changes.

const canvasPaintMask = document.getElementById("canvasPaintMask");
const canvasPaintMaskLarge = document.getElementById("canvasPaintMaskLarge");
const paintCanvases = [canvasPaintMask, canvasPaintMaskLarge];

const paintDensityValue = document.getElementById("paintDensityValue");
const paintDensityValueLarge = document.getElementById("paintDensityValueLarge");

const paintGridValue = document.getElementById("paintGridValue");
const paintGridValueLarge = document.getElementById("paintGridValueLarge");

const paintBrushSize = document.getElementById("paintBrushSize");
const paintBrushValue = document.getElementById("paintBrushValue");
const paintBrushSizeLarge = document.getElementById("paintBrushSizeLarge");
const paintBrushValueLarge = document.getElementById("paintBrushValueLarge");

const btnPaintClear = document.getElementById("btnPaintClear");
const btnPaintFill = document.getElementById("btnPaintFill");
const btnPaintInvert = document.getElementById("btnPaintInvert");
const btnPaintClearLarge = document.getElementById("btnPaintClearLarge");
const btnPaintFillLarge = document.getElementById("btnPaintFillLarge");
const btnPaintInvertLarge = document.getElementById("btnPaintInvertLarge");

const btnPaintExpand = document.getElementById("btnPaintExpand");
const btnPaintModalClose = document.getElementById("btnPaintModalClose");
const btnPaintDoneLarge = document.getElementById("btnPaintDoneLarge");
const paintModal = document.getElementById("paintModal");
const paintModalBackdrop = document.getElementById("paintModalBackdrop");

// Reference grid the brush-size slider is calibrated against, so a brush of
// "10" covers a visually similar fraction of the canvas on any grid size.
const PAINT_REF_SIZE = 256;

let paintW = PAINT_REF_SIZE;
let paintH = PAINT_REF_SIZE;
let paintMask = new Uint8Array(paintW * paintH); // 0 = not sampled, 1 = sampled
let paintBrushSlider = parseInt(paintBrushSize.value, 10);
let paintIsDrawing = false;
let paintEraseMode = false;
let paintRedrawPending = false;

function paintIndex(x, y) {
    return y * paintW + x;
}

// Brush radius in *grid* pixels, scaled so the slider feels the same on a
// 256x256 upload grid and on a 640x368 scan grid.
function paintBrushRadius() {
    const scale = Math.min(paintW, paintH) / PAINT_REF_SIZE;
    return Math.max(1, Math.round(paintBrushSlider * scale));
}

// ---- grid size tracking -----------------------------------------------------

function paintKspaceDims() {
    const k = window.LAST_KSPACE_FULL;
    if (Array.isArray(k) && k.length > 0 && Array.isArray(k[0]) && k[0].length > 0) {
        return { w: k[0].length, h: k.length };
    }
    return null;
}

// Nearest-neighbour resample so a mask painted before the grid size was known
// (or painted against a different slice/dataset) survives the change instead
// of being silently thrown away.
function resamplePaintMask(src, sw, sh, dw, dh) {
    const out = new Uint8Array(dw * dh);
    for (let y = 0; y < dh; y++) {
        const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
        for (let x = 0; x < dw; x++) {
            const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
            out[y * dw + x] = src[sy * sw + sx];
        }
    }
    return out;
}

function updatePaintGridLabel() {
    const text = `${paintH}×${paintW}`;
    if (paintGridValue) paintGridValue.textContent = text;
    if (paintGridValueLarge) paintGridValueLarge.textContent = text;
}

function setPaintGridSize(w, h) {
    if (w === paintW && h === paintH) return false;

    paintMask = resamplePaintMask(paintMask, paintW, paintH, w, h);
    paintW = w;
    paintH = h;

    // The canvas backing store must match the mask exactly — putImageData
    // does not scale, so a stale width/height would crop the mask.
    paintCanvases.forEach((canvas) => {
        canvas.width = w;
        canvas.height = h;
    });

    updatePaintGridLabel();
    updatePaintDensity();
    return true;
}

// Called before every redraw: keeps the paint grid locked to whatever k-space
// is currently loaded (uploaded image or .h5 dataset slice).
function syncPaintGridToKspace() {
    const dims = paintKspaceDims();
    if (!dims) return false;
    return setPaintGridSize(dims.w, dims.h);
}

function requestPaintRedraw() {
    if (paintRedrawPending) return;
    paintRedrawPending = true;
    requestAnimationFrame(() => {
        paintRedrawPending = false;
        drawPaintCanvas();
    });
}

// Draws the dim k-space reference (if we have one from a forward-FFT call)
// with the painted points overlaid in cyan, so the user paints "on top of"
// the real k-space structure rather than a blank square. Renders onto every
// registered canvas (small + large) so they always stay in sync.
function drawPaintCanvas() {
    syncPaintGridToKspace();

    const background = window.LAST_KSPACE_FULL;
    const imageData = new ImageData(paintW, paintH);

    for (let y = 0; y < paintH; y++) {
        const bgRow = background ? background[y] : null;
        for (let x = 0; x < paintW; x++) {
            const idx = paintIndex(x, y);
            const pixelIdx = idx * 4;
            const painted = paintMask[idx] === 1;

            if (painted) {
                imageData.data[pixelIdx] = 74;
                imageData.data[pixelIdx + 1] = 227;
                imageData.data[pixelIdx + 2] = 197;
            } else {
                const bg = bgRow ? Math.round((bgRow[x] || 0) * 80) : 0;
                imageData.data[pixelIdx] = bg;
                imageData.data[pixelIdx + 1] = bg;
                imageData.data[pixelIdx + 2] = bg;
            }
            imageData.data[pixelIdx + 3] = 255;
        }
    }

    paintCanvases.forEach((canvas) => {
        canvas.getContext("2d").putImageData(imageData, 0, 0);
    });
}

function initPaintCanvas() {
    syncPaintGridToKspace();
    updatePaintGridLabel();
    drawPaintCanvas();
    updatePaintDensity();
    setBrushRadius(paintBrushSlider);
}

function updatePaintDensity() {
    let count = 0;
    for (let i = 0; i < paintMask.length; i++) if (paintMask[i]) count++;
    const text = `${((count / paintMask.length) * 100).toFixed(1)}%`;
    paintDensityValue.textContent = text;
    paintDensityValueLarge.textContent = text;
}

function paintHasAnyPoints() {
    for (let i = 0; i < paintMask.length; i++) if (paintMask[i]) return true;
    return false;
}

// Emitted as rows × cols matching k-space exactly (see the shape check in
// routes/pipeline.py::_build_mask).
function getPaintMaskArray() {
    syncPaintGridToKspace();
    const arr = [];
    for (let y = 0; y < paintH; y++) {
        const row = new Array(paintW);
        for (let x = 0; x < paintW; x++) {
            row[x] = paintMask[paintIndex(x, y)];
        }
        arr.push(row);
    }
    return arr;
}

// Loads an externally-produced mask (e.g. from the target-error auto-mask
// search) into the paint grid, so it becomes the active custom_mask and the
// user can see it and keep hand-editing it like any other painted mask.
function setPaintMaskArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0 || !Array.isArray(arr[0])) return;
    const h = arr.length;
    const w = arr[0].length;

    paintCanvases.forEach((canvas) => {
        canvas.width = w;
        canvas.height = h;
    });
    paintW = w;
    paintH = h;
    paintMask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            paintMask[paintIndex(x, y)] = arr[y][x] ? 1 : 0;
        }
    }

    updatePaintGridLabel();
    requestPaintRedraw();
    updatePaintDensity();
}

function clearPaintMask() {
    paintMask.fill(0);
    requestPaintRedraw();
    updatePaintDensity();
}

function fillPaintMask() {
    paintMask.fill(1);
    requestPaintRedraw();
    updatePaintDensity();
}

function invertPaintMask() {
    for (let i = 0; i < paintMask.length; i++) paintMask[i] = paintMask[i] ? 0 : 1;
    requestPaintRedraw();
    updatePaintDensity();
}

function canvasCoordsFromEvent(evt, canvasEl) {
    const rect = canvasEl.getBoundingClientRect();
    const point = evt.touches ? evt.touches[0] : evt;
    const x = Math.floor(((point.clientX - rect.left) / rect.width) * paintW);
    const y = Math.floor(((point.clientY - rect.top) / rect.height) * paintH);
    return {
        x: Math.max(0, Math.min(paintW - 1, x)),
        y: Math.max(0, Math.min(paintH - 1, y)),
    };
}

function paintAt(x, y, erase) {
    const r = paintBrushRadius();
    const r2 = r * r;
    const minX = Math.max(0, x - r);
    const maxX = Math.min(paintW - 1, x + r);
    const minY = Math.max(0, y - r);
    const maxY = Math.min(paintH - 1, y + r);

    for (let yy = minY; yy <= maxY; yy++) {
        for (let xx = minX; xx <= maxX; xx++) {
            const dx = xx - x;
            const dy = yy - y;
            if (dx * dx + dy * dy <= r2) {
                paintMask[paintIndex(xx, yy)] = erase ? 0 : 1;
            }
        }
    }
    requestPaintRedraw();
}

function handlePaintStart(evt) {
    evt.preventDefault();
    syncPaintGridToKspace();
    paintIsDrawing = true;
    paintEraseMode = evt.button === 2 || evt.shiftKey;
    const { x, y } = canvasCoordsFromEvent(evt, evt.currentTarget);
    paintAt(x, y, paintEraseMode);
}

function handlePaintMove(evt) {
    if (!paintIsDrawing) return;
    evt.preventDefault();
    const { x, y } = canvasCoordsFromEvent(evt, evt.currentTarget);
    paintAt(x, y, paintEraseMode);
}

function handlePaintEnd() {
    if (paintIsDrawing) {
        paintIsDrawing = false;
        updatePaintDensity();
    }
}

paintCanvases.forEach((canvas) => {
    canvas.addEventListener("mousedown", handlePaintStart);
    canvas.addEventListener("mousemove", handlePaintMove);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("touchstart", handlePaintStart, { passive: false });
    canvas.addEventListener("touchmove", handlePaintMove, { passive: false });
    canvas.addEventListener("touchend", handlePaintEnd);
});
window.addEventListener("mouseup", handlePaintEnd);

// ---- brush size (small + large controls stay in sync) ----

function setBrushRadius(value) {
    paintBrushSlider = value;
    paintBrushValue.textContent = value;
    paintBrushValueLarge.textContent = value;
    paintBrushSize.value = value;
    paintBrushSizeLarge.value = value;
}

paintBrushSize.addEventListener("input", () => setBrushRadius(parseInt(paintBrushSize.value, 10)));
paintBrushSizeLarge.addEventListener("input", () => setBrushRadius(parseInt(paintBrushSizeLarge.value, 10)));

// ---- clear / fill / invert (both small + large buttons do the same thing) ----

btnPaintClear.addEventListener("click", clearPaintMask);
btnPaintFill.addEventListener("click", fillPaintMask);
btnPaintInvert.addEventListener("click", invertPaintMask);
btnPaintClearLarge.addEventListener("click", clearPaintMask);
btnPaintFillLarge.addEventListener("click", fillPaintMask);
btnPaintInvertLarge.addEventListener("click", invertPaintMask);

// ---- expand / collapse modal ----

function openPaintModal() {
    paintModal.classList.add("is-open");
    paintModal.setAttribute("aria-hidden", "false");
    drawPaintCanvas(); // make sure the large canvas reflects current state immediately
}

function closePaintModal() {
    paintModal.classList.remove("is-open");
    paintModal.setAttribute("aria-hidden", "true");
}

btnPaintExpand.addEventListener("click", openPaintModal);
btnPaintModalClose.addEventListener("click", closePaintModal);
btnPaintDoneLarge.addEventListener("click", closePaintModal);
paintModalBackdrop.addEventListener("click", closePaintModal);

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && paintModal.classList.contains("is-open")) {
        closePaintModal();
    }
});

updatePaintGridLabel();
