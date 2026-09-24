// ============================================================
// SLICE VIDEO
// ============================================================
// Reconstructs every slice of the currently loaded dataset with
// whatever sampling pattern / acceleration / mask is set in panel
// 02, then cross-fades through the reconstructions, first to last
// — a flythrough of the reconstructed volume, not the raw scans.
//
// Reuses _createImageData / _easeInOut / canvasAnimations from
// canvasRender.js and maskPayload() / postJSON() / reconColormap
// from controls.js rather than duplicating that logic. All plain
// <script> tags share one scope, so that's safe here.
// ============================================================

const sliceVideoReel = document.getElementById("sliceVideoReel");
const btnPlaySliceVideo = document.getElementById("btnPlaySliceVideo");
const sliceVideoTrack = document.getElementById("sliceVideoTrack");
const sliceVideoFill = document.getElementById("sliceVideoFill");
const sliceVideoCounter = document.getElementById("sliceVideoCounter");
const sliceVideoStatus = document.getElementById("sliceVideoStatus");

const SLICE_VIDEO_IDLE_STATUS = "click play to reconstruct every slice";
const SLICE_VIDEO_FRAME_MS = 450; // time to cross-fade from one slice's reconstruction into the next

let sliceVideoPlaying = false;
let sliceVideoBusy = false;
let videoLockedControls = [];

function setSliceVideoStatus(text) {
    sliceVideoStatus.textContent = text;
}

// Indeterminate fill while slices are being reconstructed one by one — we
// don't know how long each request will take.
function setReelBusy(isBusy) {
    sliceVideoTrack.classList.toggle("is-busy", isBusy);
    if (isBusy) sliceVideoFill.style.width = "";
}

// Determinate fill once playback starts, since total frame count is known.
function setReelProgress(current, total) {
    sliceVideoTrack.classList.remove("is-busy");
    sliceVideoFill.style.width = `${total > 0 ? Math.round((current / total) * 100) : 0}%`;
}

// Reconstructs every slice with the given (fixed-for-this-run) mask settings.
// Sequential, not Promise.all: each request re-runs masking + inverse FFT on
// the backend, and this keeps the "reconstructing slice i/N" status honest
// instead of firing dozens of heavy requests at once.
async function reconstructSliceStack(dataset, numSlices, maskParams, onProgress) {
    const recons = [];
    const metrics = [];
    const cleanMetrics = [];
    const errors = [];
    const references = [];

    for (let i = 0; i < numSlices; i++) {
        if (!sliceVideoPlaying) break;

        onProgress(i, numSlices);

        const data = await postJSON("/pipeline/reconstruct", {
            source: "dataset",
            dataset,
            slice_index: i,
            ...maskParams,
        });

        if (!sliceVideoPlaying) break;
        recons.push(data.recon);
        errors.push(data.error);
        references.push(data.reference);
        metrics.push(data.metrics);
        cleanMetrics.push(data.metrics_clean);
    }

    return { recons, metrics, cleanMetrics, errors, references };
}

function buildOffscreen(width, height, array2d, colorFn) {
    const imageData = _createImageData(width, height, array2d, colorFn);
    const offscreen = document.createElement("canvas");
    offscreen.width = width;
    offscreen.height = height;
    offscreen.getContext("2d").putImageData(imageData, 0, 0);
    return offscreen;
}

// Cross-fades `canvas` from array `from` to array `to` over `duration` ms.
// Checks sliceVideoPlaying every frame so stopSliceVideo() can end it early
// without leaving this promise unresolved.
function crossfadeSlices(canvas, from, to, duration, colorFn) {
    return new Promise((resolve) => {
        const height = from.length;
        const width = from[0].length;

        const fromOffscreen = buildOffscreen(width, height, from, colorFn);
        const toOffscreen = buildOffscreen(width, height, to, colorFn);

        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = false;

        const start = performance.now();

        function frame(now) {
            if (!sliceVideoPlaying) {
                canvasAnimations.delete(canvas);
                resolve();
                return;
            }

            const progress = Math.min(1, (now - start) / duration);
            const eased = _easeInOut(progress);

            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(fromOffscreen, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
            ctx.globalAlpha = eased;
            ctx.drawImage(toOffscreen, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
            ctx.globalAlpha = 1;

            if (progress < 1) {
                canvasAnimations.set(canvas, requestAnimationFrame(frame));
            } else {
                canvasAnimations.delete(canvas);
                resolve();
            }
        }

        canvasAnimations.set(canvas, requestAnimationFrame(frame));
    });
}

async function playSliceVideo() {
    if (sliceVideoBusy) return;

    if (window.APP_STATE.source !== "dataset" || !window.APP_STATE.dataset) {
        statusTextEl.textContent = "load a dataset slice first";
        addLog("error: reconstructed slice video needs a dataset loaded");
        return;
    }

    if (pipelineParams.pattern === "custom" && typeof paintHasAnyPoints === "function" && !paintHasAnyPoints()) {
        statusTextEl.textContent = "paint at least one point first";
        addLog("error: custom mask is empty — nothing painted yet");
        return;
    }

    const dataset = window.APP_STATE.dataset;
    const numSlices = parseInt(sliceSlider.max, 10) + 1;

    if (!numSlices || numSlices < 2) {
        statusTextEl.textContent = "dataset has only one slice";
        addLog("error: not enough slices to play a video");
        return;
    }

    // Snapshot the mask settings once so a mid-run tweak in panel 02 can't
    // change parameters partway through this batch of reconstructions.
    const maskParams = maskPayload();

    sliceVideoPlaying = true;
    sliceVideoBusy = true;
    // Prevent competing requests / canvas animations while video owns the view.
    videoLockedControls = [...document.querySelectorAll('button, input, select')]
        .filter(el => el !== btnPlaySliceVideo && el.id !== 'comparisonSlider')
        .map(el => [el, el.disabled]);
    videoLockedControls.forEach(([el]) => { el.disabled = true; });
    if (window.clearFrequencyExperiment) window.clearFrequencyExperiment();
    sliceVideoReel.classList.add("is-playing");
    btnPlaySliceVideo.setAttribute("aria-label", "stop reconstructed slice video");
    btnLoadDataset.disabled = true;
    datasetSelect.disabled = true;
    sliceSlider.disabled = true;

    const reconFrame = canvasRecon.closest(".viewcell__frame");
    if (reconFrame) reconFrame.classList.add("is-scanning");

    try {
        setReelBusy(true);
        sliceVideoCounter.textContent = `0 / ${numSlices - 1}`;
        setSliceVideoStatus(`reconstructing slice 0 of ${numSlices - 1}\u2026`);

        const { recons, metrics, cleanMetrics, errors, references } = await reconstructSliceStack(dataset, numSlices, maskParams, (i, total) => {
            setSliceVideoStatus(`reconstructing slice ${i} of ${total - 1}\u2026`);
            sliceVideoCounter.textContent = `${i} / ${total - 1}`;
        });

        if (!sliceVideoPlaying || recons.length < 2) {
            return;
        }

        _cancelCanvasAnimation(canvasRecon);
        _cancelCanvasAnimation(canvasError);
        _cancelCanvasAnimation(canvasOriginal);
        emptyError.style.display = "none";
        renderGrayscale(canvasRecon, recons[0]);
        renderHot(canvasError, errors[0]);
        renderGrayscale(canvasOriginal, references[0]);
        showStep("canvasRecon");
        emptyRecon.style.display = "none";

        const colorFn = reconColormap === "jet" ? _jet : _grayscale;
        const lastIndex = recons.length - 1;

        window.LAST_RECON = recons[0];
        window.updateMRIComparison({reference: references[0], recon: recons[0]});
        sliceSlider.value = 0;
        sliceValue.textContent = 0;
        window.APP_STATE = { source: "dataset", filename: null, dataset, sliceIndex: 0 };
        metricMSE.textContent = fmt(metrics[0].mse, 6);
        metricPSNR.textContent = metrics[0].psnr === null ? "∞ dB" : `${fmt(metrics[0].psnr, 2)} dB`;
        metricNRMSE.textContent = fmt(metrics[0].nrmse, 4);
        renderNoiseReview(metrics[0], cleanMetrics[0], maskParams.noise_level);
        setReelProgress(0, lastIndex);

        for (let i = 0; i < lastIndex && sliceVideoPlaying; i++) {
            setSliceVideoStatus(`slice ${i} \u2192 ${i + 1} of ${lastIndex}`);
            sliceVideoCounter.textContent = `${i + 1} / ${lastIndex}`;

            await Promise.all([
                crossfadeSlices(canvasRecon, recons[i], recons[i + 1], SLICE_VIDEO_FRAME_MS, colorFn),
                crossfadeSlices(canvasError, errors[i], errors[i + 1], SLICE_VIDEO_FRAME_MS, _hot),
                crossfadeSlices(canvasOriginal, references[i], references[i + 1], SLICE_VIDEO_FRAME_MS, _grayscale),
            ]);
            // Snap to a complete frame on stop so image, heatmap and metrics agree.
            renderGrayscale(canvasOriginal, references[i + 1]);
            renderHot(canvasError, errors[i + 1]);
            window.updateMRIComparison({reference: references[i + 1], recon: recons[i + 1]});

            // Keep slider, label, metrics, progress bar, and the pipeline's
            // notion of "current slice" all pointing at whatever is actually
            // on screen, including if the user stops the video partway
            // through.
            sliceSlider.value = i + 1;
            sliceValue.textContent = i + 1;
            window.APP_STATE = { source: "dataset", filename: null, dataset, sliceIndex: i + 1 };
            setReelProgress(i + 1, lastIndex);

            window.LAST_RECON = recons[i + 1];
            renderRecon();
            metricMSE.textContent = fmt(metrics[i + 1].mse, 6);
            metricPSNR.textContent = metrics[i + 1].psnr === null ? "∞ dB" : `${fmt(metrics[i + 1].psnr, 2)} dB`;
            metricNRMSE.textContent = fmt(metrics[i + 1].nrmse, 4);
            renderNoiseReview(metrics[i + 1], cleanMetrics[i + 1], maskParams.noise_level);
        }

        if (sliceVideoPlaying) {
            addLog(`played reconstructed slice video: ${dataset} (0 \u2192 ${lastIndex}, ${maskParams.pattern} @ \u00d7${maskParams.acceleration})`);
        }
    } catch (error) {
        console.error("Slice video failed:", error);
        statusTextEl.textContent = "slice video failed";
        addLog(`error: ${error.message}`);
    } finally {
        sliceVideoBusy = false;
        videoLockedControls.forEach(([el, disabled]) => { el.disabled = disabled; });
        videoLockedControls = [];
        stopSliceVideo();
    }
}

function stopSliceVideo() {
    sliceVideoPlaying = false;
    if (sliceVideoBusy) {
        setSliceVideoStatus("stopping…");
        return;
    }
    sliceVideoReel.classList.remove("is-playing");
    btnPlaySliceVideo.setAttribute("aria-label", "play reconstructed slice video");
    btnLoadDataset.disabled = false;
    datasetSelect.disabled = false;
    sliceSlider.disabled = false;

    sliceVideoTrack.classList.remove("is-busy");
    sliceVideoFill.style.width = "0%";
    sliceVideoCounter.textContent = "";
    setSliceVideoStatus(SLICE_VIDEO_IDLE_STATUS);

    const reconFrame = canvasRecon.closest(".viewcell__frame");
    if (reconFrame) reconFrame.classList.remove("is-scanning");
}

btnPlaySliceVideo.addEventListener("click", () => {
    if (sliceVideoPlaying) {
        stopSliceVideo();
    } else {
        playSliceVideo();
    }
});
