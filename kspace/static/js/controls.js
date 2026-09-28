// Wires the sampling-pattern controls and the run buttons to the
// /pipeline/* backend routes, and renders results onto the viewport canvases.

const statusTextEl = document.getElementById("statusText");

const patternButtons = document.querySelectorAll(".segmented__option[data-pattern]");
const accelerationField = document.getElementById("accelerationField");
const factorSlider = document.getElementById("factorSlider");
const factorLabel = document.getElementById("factorLabel");
const factorValue = document.getElementById("factorValue");
const acsField = document.getElementById("acsField");
const acsSlider = document.getElementById("acsSlider");
const acsValue = document.getElementById("acsValue");
const paintField = document.getElementById("paintField");

const btnTransform = document.getElementById("btnTransform");
const btnUndersample = document.getElementById("btnUndersample");
const btnReconstruct = document.getElementById("btnReconstruct");
const btnReset = document.getElementById("btnReset");

const canvasOriginalEl = document.getElementById("canvasOriginal");
const canvasKspaceFull = document.getElementById("canvasKspaceFull");
const canvasKspaceUnder = document.getElementById("canvasKspaceUnder");
const canvasMask = document.getElementById("canvasMask");
const canvasRecon = document.getElementById("canvasRecon");
const canvasError = document.getElementById("canvasError");

const emptyOriginalEl = document.getElementById("emptyOriginal");
const emptyKspaceFull = document.getElementById("emptyKspaceFull");
const emptyKspaceUnder = document.getElementById("emptyKspaceUnder");
const emptyMask = document.getElementById("emptyMask");
const emptyRecon = document.getElementById("emptyRecon");
const emptyError = document.getElementById("emptyError");

const metricDensity = document.getElementById("metricDensity");
const metricPoints = document.getElementById("metricPoints");
const metricMSE = document.getElementById("metricMSE");
const metricPSNR = document.getElementById("metricPSNR");
const metricNRMSE = document.getElementById("metricNRMSE");

const fileInputEl = document.getElementById("fileInput");
const logListEl = document.getElementById("logList");

// noise simulation controls + readout
const noiseSlider = document.getElementById("noiseSlider");
const noiseValue = document.getElementById("noiseValue");
const btnNoiseReroll = document.getElementById("btnNoiseReroll");
const metricNoise = document.getElementById("metricNoise");
const metricPSNRClean = document.getElementById("metricPSNRClean");
const metricMSEClean = document.getElementById("metricMSEClean");
const metricNRMSEClean = document.getElementById("metricNRMSEClean");
const metricPSNRDrop = document.getElementById("metricPSNRDrop");

// ---- local UI state ----
const pipelineParams = {
    pattern: "cartesian",
    acceleration: parseInt(factorSlider.value, 10),
    acs: parseInt(acsSlider.value, 10),
    noise_level: parseFloat(noiseSlider.value),   // % of k-space signal RMS, 0 = off
    noise_seed: 42,                                // change to draw a new noise sample
};

// ---- sampling pattern segmented control ----
patternButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        patternButtons.forEach((b) => {
            b.classList.remove("is-active");
            b.setAttribute("aria-checked", "false");
        });
        btn.classList.add("is-active");
        btn.setAttribute("aria-checked", "true");

        pipelineParams.pattern = btn.dataset.pattern;

        // radial_mask has no autocalibration-lines concept; a hand-painted
        // mask has no acceleration or ACS concept at all, since the user is
        // directly choosing every sampled point; "full" has no undersampling
        // controls at all since nothing is being undersampled.
        const isCustom = pipelineParams.pattern === "custom";
        const isFull = pipelineParams.pattern === "full";
        acsField.style.display = (pipelineParams.pattern === "radial" || isCustom || isFull) ? "none" : "";
        accelerationField.style.display = (isCustom || isFull) ? "none" : "";
        paintField.style.display = isCustom ? "" : "none";

        if (isCustom && typeof initPaintCanvas === "function") {
            initPaintCanvas();
        }
    });
});

// ---- acceleration slider ----
factorSlider.addEventListener("input", () => {
    pipelineParams.acceleration = parseInt(factorSlider.value, 10);
    factorValue.textContent = pipelineParams.acceleration;
    factorLabel.textContent = `acceleration — ×${pipelineParams.acceleration}`;
});

// ---- ACS lines/spokes slider ----
acsSlider.addEventListener("input", () => {
    pipelineParams.acs = parseInt(acsSlider.value, 10);
    acsValue.textContent = pipelineParams.acs;
});

// ---- noise level slider ----
function noiseSnrDb(level) {
    return level > 0 ? -20 * Math.log10(level / 100) : null;
}

function describeNoise(level) {
    if (!(level > 0)) return "off";
    return `${level.toFixed(1)}% · ~${noiseSnrDb(level).toFixed(1)} dB SNR`;
}

function syncNoiseFromSlider() {
    pipelineParams.noise_level = parseFloat(noiseSlider.value);
    noiseValue.textContent = pipelineParams.noise_level > 0
        ? `${pipelineParams.noise_level.toFixed(1)}%`
        : "off";
}

noiseSlider.addEventListener("input", syncNoiseFromSlider);

// If the browser restores the slider position on reload / back, make the
// label and the value we send to the backend match what the slider shows.
window.addEventListener("pageshow", syncNoiseFromSlider);
syncNoiseFromSlider();

// index.html shows a red "noise controls are NOT active" note by default.
// Reaching this line proves the new controls.js is the one running, so hide it.
const noiseStatusEl = document.getElementById("noiseStatus");
if (noiseStatusEl) noiseStatusEl.style.display = "none";

// The backend silently ignores unknown fields, so if routes/pipeline.py is the
// old version noise would quietly do nothing. Detect that from the response.
function warnIfServerIgnoredNoise(data) {
    if (pipelineParams.noise_level > 0 && data.noise_level === undefined) {
        statusTextEl.textContent = "server ignored noise — update routes/pipeline.py";
        addLog("warning: server did not apply noise. routes/pipeline.py is the old version: replace it and restart uvicorn.");
        return true;
    }
    return false;
}

// Same level, different random noise: bump the seed so the next
// undersample / reconstruct run draws a fresh noise realization.
if (btnNoiseReroll) {
    btnNoiseReroll.addEventListener("click", () => {
        pipelineParams.noise_seed = Math.floor(Math.random() * 1_000_000);
        addLog(`noise: new random sample (seed ${pipelineParams.noise_seed})`);
    });
}

// Fills the "noise review" readout. Shared with sliceVideo.js so the slice
// video keeps it in step with the metrics it already updates per slice.
function renderNoiseReview(metrics, metricsClean, noiseLevel) {
    metricNoise.textContent = describeNoise(noiseLevel);

    if (!(noiseLevel > 0) || !metricsClean) {
        [metricPSNRClean, metricMSEClean, metricNRMSEClean, metricPSNRDrop].forEach((el) => {
            el.textContent = "—";
        });
        return;
    }

    metricPSNRClean.textContent = metricsClean.psnr === null ? "∞ dB" : `${fmt(metricsClean.psnr, 2)} dB`;
    metricMSEClean.textContent = fmt(metricsClean.mse, 6);
    metricNRMSEClean.textContent = fmt(metricsClean.nrmse, 4);

    if (metricsClean.psnr === null && metrics.psnr === null) {
        metricPSNRDrop.textContent = "0.00 dB";
    } else if (metricsClean.psnr === null) {
        // noise-free recon was exact (e.g. full sampling): nothing to subtract from
        metricPSNRDrop.textContent = `from ∞ → ${fmt(metrics.psnr, 1)} dB`;
    } else if (metrics.psnr === null) {
        metricPSNRDrop.textContent = "—";
    } else {
        metricPSNRDrop.textContent = `${fmt(metricsClean.psnr - metrics.psnr, 2)} dB`;
    }
}

// ---- helpers ----
function requireImage() {
    const state = window.APP_STATE;
    const hasSource = state && ((state.source === "upload" && state.filename) ||
                                 (state.source === "dataset" && state.dataset));
    if (!hasSource) {
        statusTextEl.textContent = "load an image or dataset slice first";
        addLog("error: no source loaded yet");
        return false;
    }
    return true;
}

// ---- reconstructed image colormap toggle (grayscale / jet) ----

const reconColormapButtons = document.querySelectorAll(".colormap-toggle__btn");
let reconColormap = "gray";

function renderRecon(animate = false) {
    if (!window.LAST_RECON) return;
    if (reconColormap === "jet") {
        renderJet(canvasRecon, window.LAST_RECON, animate);
    } else {
        renderGrayscale(canvasRecon, window.LAST_RECON, animate);
    }
}

reconColormapButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        if (!window.LAST_RECON) {
            if (typeof addLog === "function") addLog("run \"reconstruct\" first before switching colormap");
            if (typeof statusTextEl !== "undefined") statusTextEl.textContent = "no reconstruction yet";
            return;
        }

        reconColormapButtons.forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        reconColormap = btn.dataset.colormap;
        renderRecon();
    });
});

function sourcePayload() {
    const state = window.APP_STATE;
    if (state.source === "dataset") {
        return { source: "dataset", dataset: state.dataset, slice_index: state.sliceIndex };
    }
    return { source: "upload", filename: state.filename };
}

function maskPayload() {
    const base = {
        pattern: pipelineParams.pattern,
        acceleration: pipelineParams.acceleration,
        acs: pipelineParams.acs,
        noise_level: pipelineParams.noise_level,
        noise_seed: pipelineParams.noise_seed,
    };
    if (pipelineParams.pattern === "custom" && typeof getPaintMaskArray === "function") {
        base.custom_mask = getPaintMaskArray();
    }
    return base;
}

async function postJSON(url, body) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.detail || `Request to ${url} failed`);
    }

    return data;
}

function fmt(value, digits = 4) {
    if (value === null || value === undefined) return "∞";
    return Number(value).toFixed(digits);
}

// ---- 01 forward FFT ----
btnTransform.addEventListener("click", async () => {
    if (!requireImage()) return;

    statusTextEl.textContent = "running forward FFT...";

    try {
        const data = await postJSON("/pipeline/fft", sourcePayload());

        renderGrayscale(canvasKspaceFull, data.kspace_full);
        emptyKspaceFull.style.display = "none";
        showStep("canvasKspaceFull");

        window.LAST_KSPACE_FULL = data.kspace_full;
        if (typeof drawPaintCanvas === "function") drawPaintCanvas();

        statusTextEl.textContent = "forward FFT complete";
        addLog("forward FFT: image → k-space");
    } catch (err) {
        statusTextEl.textContent = "FFT failed";
        addLog(`error: ${err.message}`);
    }
});

// ---- 02 apply undersampling mask ----
btnUndersample.addEventListener("click", async () => {
    if (!requireImage()) return;

    if (pipelineParams.pattern === "custom" && typeof paintHasAnyPoints === "function" && !paintHasAnyPoints()) {
        statusTextEl.textContent = "paint at least one point first";
        addLog("error: custom mask is empty — nothing painted yet");
        return;
    }

    statusTextEl.textContent = "applying undersampling mask...";

    try {
        const data = await postJSON("/pipeline/mask", {
            ...sourcePayload(),
            ...maskPayload(),
        });

        renderGrayscale(canvasMask, data.mask);
        emptyMask.style.display = "none";

        renderGrayscale(canvasKspaceUnder, data.kspace_under);
        emptyKspaceUnder.style.display = "none";

        showStep("canvasMask");

        metricDensity.textContent = `${(data.density * 100).toFixed(1)}%`;
        metricPoints.textContent = data.points_kept.toLocaleString();
        warnIfServerIgnoredNoise(data);

        statusTextEl.textContent = `mask applied (${pipelineParams.pattern}, ×${pipelineParams.acceleration})`;
        addLog(`mask: ${pipelineParams.pattern} @ ×${pipelineParams.acceleration}` +
               (pipelineParams.noise_level > 0 ? ` + noise ${describeNoise(pipelineParams.noise_level)}` : ""));
    } catch (err) {
        statusTextEl.textContent = "mask failed";
        addLog(`error: ${err.message}`);
    }
});

// ---- 03 inverse FFT / reconstruct ----
btnReconstruct.addEventListener("click", async () => {
    if (!requireImage()) return;

    if (pipelineParams.pattern === "custom" && typeof paintHasAnyPoints === "function" && !paintHasAnyPoints()) {
        statusTextEl.textContent = "paint at least one point first";
        addLog("error: custom mask is empty — nothing painted yet");
        return;
    }

    statusTextEl.textContent = "reconstructing...";

    try {
        const data = await postJSON("/pipeline/reconstruct", {
            ...sourcePayload(),
            ...maskPayload(),
        });

        window.LAST_RECON = data.recon;
        if (window.updateMRIComparison) window.updateMRIComparison(data);
        renderRecon(true);
        emptyRecon.style.display = "none";

        renderHot(canvasError, data.error);
        emptyError.style.display = "none";

        showStep("canvasRecon");

        metricMSE.textContent = fmt(data.metrics.mse, 6);
        metricPSNR.textContent = data.metrics.psnr === null ? "∞ dB" : `${fmt(data.metrics.psnr, 2)} dB`;
        metricNRMSE.textContent = fmt(data.metrics.nrmse, 4);

        if (warnIfServerIgnoredNoise(data)) return;
        renderNoiseReview(data.metrics, data.metrics_clean, data.noise_level);

        statusTextEl.textContent = "reconstruction complete";
        addLog("reconstruct: k-space → image" +
               (data.noise_level > 0 ? ` (noise ${describeNoise(data.noise_level)})` : ""));
    } catch (err) {
        statusTextEl.textContent = "reconstruction failed";
        addLog(`error: ${err.message}`);
    }
});

// ---- reset session ----
btnReset.addEventListener("click", () => {
    if (typeof stopSliceVideo === "function") stopSliceVideo();
    if (window.clearMRIComparison) window.clearMRIComparison();

    [canvasOriginalEl, canvasKspaceFull, canvasKspaceUnder, canvasMask, canvasRecon, canvasError].forEach(
        clearCanvas
    );

    [emptyOriginalEl, emptyKspaceFull, emptyKspaceUnder, emptyMask, emptyRecon, emptyError].forEach((el) => {
        el.style.display = "";
    });

    [metricDensity, metricPoints, metricMSE, metricPSNR, metricNRMSE,
     metricNoise, metricPSNRClean, metricMSEClean, metricNRMSEClean, metricPSNRDrop].forEach((el) => {
        el.textContent = "—";
    });

    noiseSlider.value = 0;
    noiseValue.textContent = "off";
    pipelineParams.noise_level = 0;
    pipelineParams.noise_seed = 42;

    fileInputEl.value = "";
    window.APP_STATE = { source: null, filename: null, dataset: null, sliceIndex: null };

    const sourceToggleBtns = document.querySelectorAll(".segmented__option[data-source]");
    sourceToggleBtns.forEach((b) => {
        b.classList.toggle("is-active", b.dataset.source === "upload");
        b.setAttribute("aria-checked", b.dataset.source === "upload" ? "true" : "false");
    });
    const uploadBlock = document.getElementById("uploadSourceBlock");
    const h5UploadBlock = document.getElementById("h5UploadSourceBlock");
    const datasetBlock = document.getElementById("datasetSourceBlock");
    if (uploadBlock) uploadBlock.style.display = "";
    if (h5UploadBlock) h5UploadBlock.style.display = "none";
    if (datasetBlock) datasetBlock.style.display = "none";
    const h5InputEl = document.getElementById("h5FileInput");
    if (h5InputEl) h5InputEl.value = "";
    if (typeof setForwardFFTVisibility === "function") setForwardFFTVisibility("upload");

    const datasetSelectEl = document.getElementById("datasetSelect");
    const sliceFieldEl = document.getElementById("sliceField");
    if (datasetSelectEl) datasetSelectEl.selectedIndex = 0;
    if (sliceFieldEl) sliceFieldEl.style.display = "none";

    logListEl.innerHTML = '<li class="log__entry log__entry--muted">console idle. load an image to begin.</li>';
    statusTextEl.textContent = "awaiting image";

    if (typeof showStep === "function") showStep("canvasOriginal");

    patternButtons.forEach((b) => {
        b.classList.toggle("is-active", b.dataset.pattern === "cartesian");
        b.setAttribute("aria-checked", b.dataset.pattern === "cartesian" ? "true" : "false");
    });
    pipelineParams.pattern = "cartesian";
    accelerationField.style.display = "";
    acsField.style.display = "";
    paintField.style.display = "none";
    window.LAST_KSPACE_FULL = null;
    if (typeof clearPaintMask === "function") clearPaintMask();

    window.LAST_RECON = null;
    reconColormap = "gray";
    reconColormapButtons.forEach((b) => b.classList.toggle("is-active", b.dataset.colormap === "gray"));
});