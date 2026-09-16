// Paint-brush sampling: instead of an algorithmic pattern, the user directly
// paints which k-space points are kept. Sent to the backend as
// pattern="custom" with a custom_mask 2D array of 0/1.
//
// Two canvases share one underlying mask: a small inline one in the sidebar,
// and a larger one in an expandable modal for easier precise drawing. Both
// always redraw together, so closing the modal just reveals the same result
// on the small canvas — nothing is lost or reset by expanding/collapsing.

const canvasPaintMask = document.getElementById("canvasPaintMask");
const canvasPaintMaskLarge = document.getElementById("canvasPaintMaskLarge");
const paintCanvases = [canvasPaintMask, canvasPaintMaskLarge];

const paintDensityValue = document.getElementById("paintDensityValue");
const paintDensityValueLarge = document.getElementById("paintDensityValueLarge");

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

const PAINT_SIZE = 256;
let paintMask = new Uint8Array(PAINT_SIZE * PAINT_SIZE); // 0 = not sampled, 1 = sampled
let paintBrushRadius = parseInt(paintBrushSize.value, 10);
let paintIsDrawing = false;
let paintEraseMode = false;
let paintRedrawPending = false;

function paintIndex(x, y) {
    return y * PAINT_SIZE + x;
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
    const background = window.LAST_KSPACE_FULL;
    const imageData = new ImageData(PAINT_SIZE, PAINT_SIZE);

    for (let y = 0; y < PAINT_SIZE; y++) {
        const bgRow = background ? background[y] : null;
        for (let x = 0; x < PAINT_SIZE; x++) {
            const idx = paintIndex(x, y);
            const pixelIdx = idx * 4;
            const painted = paintMask[idx] === 1;

            if (painted) {
                imageData.data[pixelIdx] = 63;
                imageData.data[pixelIdx + 1] = 215;
                imageData.data[pixelIdx + 2] = 255;
            } else {
                const bg = bgRow ? Math.round(bgRow[x] * 70) : 0;
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
    drawPaintCanvas();
    updatePaintDensity();
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

function getPaintMaskArray() {
    const arr = [];
    for (let y = 0; y < PAINT_SIZE; y++) {
        const row = new Array(PAINT_SIZE);
        for (let x = 0; x < PAINT_SIZE; x++) {
            row[x] = paintMask[paintIndex(x, y)];
        }
        arr.push(row);
    }
    return arr;
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
    const x = Math.floor(((point.clientX - rect.left) / rect.width) * PAINT_SIZE);
    const y = Math.floor(((point.clientY - rect.top) / rect.height) * PAINT_SIZE);
    return { x, y };
}

function paintAt(x, y, erase) {
    const r = paintBrushRadius;
    const r2 = r * r;
    const minX = Math.max(0, x - r);
    const maxX = Math.min(PAINT_SIZE - 1, x + r);
    const minY = Math.max(0, y - r);
    const maxY = Math.min(PAINT_SIZE - 1, y + r);

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
    paintBrushRadius = value;
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