// Wires the sampling-pattern controls and the run buttons to the
// /pipeline/* backend routes, and renders results onto the viewport canvases.

const statusTextEl = document.getElementById("statusText");

const patternButtons = document.querySelectorAll(".segmented__option[data-pattern]");
const factorSlider = document.getElementById("factorSlider");
const factorLabel = document.getElementById("factorLabel");
const factorValue = document.getElementById("factorValue");
const acsField = document.getElementById("acsField");
const acsSlider = document.getElementById("acsSlider");
const acsValue = document.getElementById("acsValue");

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

// ---- local UI state ----
const pipelineParams = {
    pattern: "cartesian",
    acceleration: parseInt(factorSlider.value, 10),
    acs: parseInt(acsSlider.value, 10),
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

        // radial_mask has no autocalibration-lines concept, so hide that control
        acsField.style.display = pipelineParams.pattern === "radial" ? "none" : "";
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

function sourcePayload() {
    const state = window.APP_STATE;
    if (state.source === "dataset") {
        return { source: "dataset", dataset: state.dataset, slice_index: state.sliceIndex };
    }
    return { source: "upload", filename: state.filename };
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

    statusTextEl.textContent = "applying undersampling mask...";

    try {
        const data = await postJSON("/pipeline/mask", {
            ...sourcePayload(),
            pattern: pipelineParams.pattern,
            acceleration: pipelineParams.acceleration,
            acs: pipelineParams.acs,
        });

        renderGrayscale(canvasMask, data.mask);
        emptyMask.style.display = "none";

        renderGrayscale(canvasKspaceUnder, data.kspace_under);
        emptyKspaceUnder.style.display = "none";

        metricDensity.textContent = `${(data.density * 100).toFixed(1)}%`;
        metricPoints.textContent = data.points_kept.toLocaleString();

        statusTextEl.textContent = `mask applied (${pipelineParams.pattern}, ×${pipelineParams.acceleration})`;
        addLog(`mask: ${pipelineParams.pattern} @ ×${pipelineParams.acceleration}`);
    } catch (err) {
        statusTextEl.textContent = "mask failed";
        addLog(`error: ${err.message}`);
    }
});

// ---- 03 inverse FFT / reconstruct ----
btnReconstruct.addEventListener("click", async () => {
    if (!requireImage()) return;

    statusTextEl.textContent = "reconstructing...";

    try {
        const data = await postJSON("/pipeline/reconstruct", {
            ...sourcePayload(),
            pattern: pipelineParams.pattern,
            acceleration: pipelineParams.acceleration,
            acs: pipelineParams.acs,
        });

        renderGrayscale(canvasRecon, data.recon);
        emptyRecon.style.display = "none";

        renderHot(canvasError, data.error);
        emptyError.style.display = "none";

        metricMSE.textContent = fmt(data.metrics.mse, 6);
        metricPSNR.textContent = data.metrics.psnr === null ? "∞ dB" : `${fmt(data.metrics.psnr, 2)} dB`;
        metricNRMSE.textContent = fmt(data.metrics.nrmse, 4);

        statusTextEl.textContent = "reconstruction complete";
        addLog("reconstruct: k-space → image");
    } catch (err) {
        statusTextEl.textContent = "reconstruction failed";
        addLog(`error: ${err.message}`);
    }
});

// ---- reset session ----
btnReset.addEventListener("click", () => {
    [canvasOriginalEl, canvasKspaceFull, canvasKspaceUnder, canvasMask, canvasRecon, canvasError].forEach(
        clearCanvas
    );

    [emptyOriginalEl, emptyKspaceFull, emptyKspaceUnder, emptyMask, emptyRecon, emptyError].forEach((el) => {
        el.style.display = "";
    });

    [metricDensity, metricPoints, metricMSE, metricPSNR, metricNRMSE].forEach((el) => {
        el.textContent = "—";
    });

    fileInputEl.value = "";
    window.APP_STATE = { source: null, filename: null, dataset: null, sliceIndex: null };

    const sourceToggleBtns = document.querySelectorAll(".segmented__option[data-source]");
    sourceToggleBtns.forEach((b) => {
        b.classList.toggle("is-active", b.dataset.source === "upload");
        b.setAttribute("aria-checked", b.dataset.source === "upload" ? "true" : "false");
    });
    const uploadBlock = document.getElementById("uploadSourceBlock");
    const datasetBlock = document.getElementById("datasetSourceBlock");
    if (uploadBlock) uploadBlock.style.display = "";
    if (datasetBlock) datasetBlock.style.display = "none";
    if (typeof setForwardFFTVisibility === "function") setForwardFFTVisibility("upload");

    const datasetSelectEl = document.getElementById("datasetSelect");
    const sliceFieldEl = document.getElementById("sliceField");
    if (datasetSelectEl) datasetSelectEl.selectedIndex = 0;
    if (sliceFieldEl) sliceFieldEl.style.display = "none";

    logListEl.innerHTML = '<li class="log__entry log__entry--muted">console idle. load an image to begin.</li>';
    statusTextEl.textContent = "awaiting image";
});