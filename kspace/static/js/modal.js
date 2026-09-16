// Lightbox: click any of the 6 viewport canvases to open an enlarged,
// zoomable view plus a small contextual chart. Reads pixels straight off
// the already-rendered <canvas> (via getImageData), so it works no matter
// how that canvas was drawn (renderGrayscale, renderHot, or a plain photo
// draw) without needing any changes to main.js / controls.js.

const modal = document.getElementById("imageModal");
const modalBackdrop = document.getElementById("modalBackdrop");
const modalClose = document.getElementById("modalClose");
const modalTitleEl = document.getElementById("modalTitle");
const modalCanvas = document.getElementById("modalCanvas");
const modalZoomIn = document.getElementById("modalZoomIn");
const modalZoomOut = document.getElementById("modalZoomOut");
const modalZoomReset = document.getElementById("modalZoomReset");
const modalZoomLevelEl = document.getElementById("modalZoomLevel");
const modalChartCanvas = document.getElementById("modalChartCanvas");
const modalChartTitleEl = document.getElementById("modalChartTitle");
const modalChartNoteEl = document.getElementById("modalChartNote");

let modalZoom = 1;

function getCanvasGrayscaleArray(canvas) {
    const ctx = canvas.getContext("2d");
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const arr = [];
    for (let y = 0; y < height; y++) {
        const row = new Array(width);
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            row[x] = (data[idx] + data[idx + 1] + data[idx + 2]) / (3 * 255);
        }
        arr.push(row);
    }
    return arr;
}

function flatten(arr2d) {
    const out = [];
    for (const row of arr2d) for (const v of row) out.push(v);
    return out;
}

// ---- small dependency-free chart drawing helpers ----

function clearChart(ctx) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

function drawHistogram(ctx, values, bins = 28) {
    clearChart(ctx);
    const counts = new Array(bins).fill(0);
    for (const v of values) {
        let bin = Math.floor(v * bins);
        if (bin >= bins) bin = bins - 1;
        if (bin < 0) bin = 0;
        counts[bin]++;
    }
    const maxCount = Math.max(...counts, 1);

    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const padding = 18;
    const barW = (w - padding * 2) / bins;

    ctx.strokeStyle = "#232B36";
    ctx.beginPath();
    ctx.moveTo(padding, h - padding);
    ctx.lineTo(w - padding, h - padding);
    ctx.stroke();

    ctx.fillStyle = "#3FD7FF";
    counts.forEach((count, i) => {
        const barH = (count / maxCount) * (h - padding * 2);
        ctx.fillRect(
            padding + i * barW,
            h - padding - barH,
            Math.max(barW - 1, 1),
            barH
        );
    });
}

function drawLineChart(ctx, values) {
    clearChart(ctx);
    if (values.length === 0) return;

    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const padding = 18;
    const maxV = Math.max(...values, 1e-9);
    const minV = Math.min(...values, 0);
    const range = maxV - minV || 1;

    ctx.strokeStyle = "#232B36";
    ctx.beginPath();
    ctx.moveTo(padding, h - padding);
    ctx.lineTo(w - padding, h - padding);
    ctx.stroke();

    ctx.strokeStyle = "#3FD7FF";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    values.forEach((v, i) => {
        const x = padding + (i / (values.length - 1)) * (w - padding * 2);
        const y = h - padding - ((v - minV) / range) * (h - padding * 2);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.stroke();
}

// ---- contextual data derived from the pixel array ----

function radialProfile(arr2d) {
    const h = arr2d.length;
    const w = arr2d[0].length;
    const cy = h / 2;
    const cx = w / 2;
    const maxR = Math.floor(Math.min(cx, cy));
    const sums = new Array(maxR).fill(0);
    const counts = new Array(maxR).fill(0);

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const r = Math.floor(Math.hypot(x - cx, y - cy));
            if (r < maxR) {
                sums[r] += arr2d[y][x];
                counts[r]++;
            }
        }
    }

    return sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
}

function rowDensity(arr2d) {
    return arr2d.map((row) => row.reduce((a, b) => a + b, 0) / row.length);
}

function renderModalChart(kind, grayArray) {
    const ctx = modalChartCanvas.getContext("2d");

    if (kind === "profile") {
        modalChartTitleEl.textContent = "radial profile (center → edge)";
        drawLineChart(ctx, radialProfile(grayArray));
        modalChartNoteEl.textContent = "average magnitude by distance from k-space center";
    } else if (kind === "density") {
        modalChartTitleEl.textContent = "row-wise sampling density";
        drawLineChart(ctx, rowDensity(grayArray));
        modalChartNoteEl.textContent = "fraction of each row kept by the mask";
    } else if (kind === "error-histogram") {
        modalChartTitleEl.textContent = "error magnitude histogram";
        drawHistogram(ctx, flatten(grayArray));
        const mseText = typeof metricMSE !== "undefined" ? metricMSE.textContent : "—";
        const psnrText = typeof metricPSNR !== "undefined" ? metricPSNR.textContent : "—";
        const nrmseText = typeof metricNRMSE !== "undefined" ? metricNRMSE.textContent : "—";
        modalChartNoteEl.textContent = `MSE ${mseText} · PSNR ${psnrText} · NRMSE ${nrmseText}`;
    } else {
        modalChartTitleEl.textContent = "pixel intensity histogram";
        drawHistogram(ctx, flatten(grayArray));
        modalChartNoteEl.textContent = "";
    }
}

// ---- zoom controls ----

function updateZoomDisplay() {
    modalCanvas.style.transform = `scale(${modalZoom})`;
    modalZoomLevelEl.textContent = `${Math.round(modalZoom * 100)}%`;
}

modalZoomIn.addEventListener("click", () => {
    modalZoom = Math.min(4, modalZoom + 0.25);
    updateZoomDisplay();
});

modalZoomOut.addEventListener("click", () => {
    modalZoom = Math.max(0.5, modalZoom - 0.25);
    updateZoomDisplay();
});

modalZoomReset.addEventListener("click", () => {
    modalZoom = 1;
    updateZoomDisplay();
});

// ---- open / close ----

function openModal(frame) {
    const canvasId = frame.dataset.canvasId;
    const kind = frame.dataset.kind;
    const title = frame.dataset.title || canvasId;
    const sourceCanvas = document.getElementById(canvasId);
    const emptyEl = frame.querySelector(".viewcell__empty");

    // Nothing drawn yet (placeholder still showing) — don't open an empty modal.
    if (emptyEl && emptyEl.style.display !== "none") {
        return;
    }

    modalTitleEl.textContent = title;

    modalCanvas.width = sourceCanvas.width;
    modalCanvas.height = sourceCanvas.height;
    const ctx = modalCanvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, modalCanvas.width, modalCanvas.height);
    ctx.drawImage(sourceCanvas, 0, 0);

    modalZoom = 1;
    updateZoomDisplay();

    const grayArray = getCanvasGrayscaleArray(sourceCanvas);
    renderModalChart(kind, grayArray);

    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
}

function closeModal() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
}

document.querySelectorAll(".viewcell__frame--clickable").forEach((frame) => {
    frame.addEventListener("click", () => openModal(frame));
});

modalBackdrop.addEventListener("click", closeModal);
modalClose.addEventListener("click", closeModal);

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("is-open")) {
        closeModal();
    }
});