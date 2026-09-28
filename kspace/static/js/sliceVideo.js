// ============================================================
// RECONSTRUCTED SLICE VIDEO — media-style playback controls
// ============================================================
// Reconstructs every slice in the active dataset using a fixed snapshot of
// the current mask/noise settings, then plays the reconstructed volume as a
// scrub-able timeline. Play, pause, stop/reset and seeking operate on the
// generated reconstruction stack rather than on a decorative UI layer.
// ============================================================

const sliceVideoReel = document.getElementById("sliceVideoReel");
const btnPlaySliceVideo = document.getElementById("btnPlaySliceVideo");
const btnPauseSliceVideo = document.getElementById("btnPauseSliceVideo");
const btnStopSliceVideo = document.getElementById("btnStopSliceVideo");
const sliceVideoTrack = document.getElementById("sliceVideoTrack");
const sliceVideoFill = document.getElementById("sliceVideoFill");
const sliceVideoCounter = document.getElementById("sliceVideoCounter");
const sliceVideoStatus = document.getElementById("sliceVideoStatus");
const sliceVideoSeek = document.getElementById("sliceVideoSeek");
const sliceVideoTime = document.getElementById("sliceVideoTime");
const btnOpenSliceVideoModal = document.getElementById("btnOpenSliceVideoModal");
const sliceVideoModal = document.getElementById("sliceVideoModal");
const sliceVideoModalBackdrop = document.getElementById("sliceVideoModalBackdrop");
const sliceVideoModalClose = document.getElementById("sliceVideoModalClose");
const sliceVideoModalCanvas = document.getElementById("sliceVideoModalCanvas");
const sliceVideoModalStatus = document.getElementById("sliceVideoModalStatus");
const sliceVideoModalCounter = document.getElementById("sliceVideoModalCounter");
const sliceVideoModalSeek = document.getElementById("sliceVideoModalSeek");
const sliceVideoModalTime = document.getElementById("sliceVideoModalTime");
const btnPlaySliceVideoModal = document.getElementById("btnPlaySliceVideoModal");
const btnPauseSliceVideoModal = document.getElementById("btnPauseSliceVideoModal");
const btnStopSliceVideoModal = document.getElementById("btnStopSliceVideoModal");

const SLICE_VIDEO_IDLE_STATUS = "press play to reconstruct every slice";
const SLICE_VIDEO_FRAME_MS = 450;
const SLICE_VIDEO_FRAME_SECONDS = SLICE_VIDEO_FRAME_MS / 1000;

let sliceVideoSessionActive = false;
let sliceVideoPreparing = false;
let sliceVideoPlaying = false;
let sliceVideoPaused = false;
let sliceVideoCache = null;
let sliceVideoPosition = 0; // fractional slice position, e.g. 3.5 = halfway 3 -> 4
let sliceVideoRaf = null;
let sliceVideoLastTick = 0;
let sliceVideoShownIndex = -1;
let videoLockedControls = [];
let sliceVideoPairCache = null;
let sliceVideoScrubbing = false;
let sliceVideoResumeAfterScrub = false;
let sliceVideoScrubSource = null;

function setSliceVideoStatus(text) {
    if (sliceVideoStatus) sliceVideoStatus.textContent = text;
    if (sliceVideoModalStatus) sliceVideoModalStatus.textContent = text;
}

function formatVideoTime(seconds) {
    const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const minutes = Math.floor(safe / 60);
    const secs = safe - minutes * 60;
    return `${minutes}:${secs.toFixed(1).padStart(4, "0")}`;
}

function videoDurationSeconds() {
    if (!sliceVideoCache || sliceVideoCache.recons.length < 2) return 0;
    return (sliceVideoCache.recons.length - 1) * SLICE_VIDEO_FRAME_SECONDS;
}

function _syncVideoSeek(seekEl, current, duration) {
    if (!seekEl) return;
    seekEl.max = String(duration || 0);
    if (!sliceVideoScrubbing || sliceVideoScrubSource !== seekEl) {
        seekEl.value = String(current);
    }
    const shownValue = Math.min(duration, Math.max(0, Number(seekEl.value) || 0));
    const seekPct = duration > 0 ? Math.min(100, Math.max(0, (shownValue / duration) * 100)) : 0;
    seekEl.style.setProperty("--seek-progress", `${seekPct}%`);
}

function updateVideoTimeline() {
    const duration = videoDurationSeconds();
    const current = Math.min(duration, Math.max(0, sliceVideoPosition * SLICE_VIDEO_FRAME_SECONDS));

    _syncVideoSeek(sliceVideoSeek, current, duration);
    _syncVideoSeek(sliceVideoModalSeek, current, duration);

    const timeText = `${formatVideoTime(current)} / ${formatVideoTime(duration)}`;
    if (sliceVideoTime) sliceVideoTime.textContent = timeText;
    if (sliceVideoModalTime) sliceVideoModalTime.textContent = timeText;

    if (sliceVideoCache) {
        const lastIndex = sliceVideoCache.recons.length - 1;
        const visibleIndex = Math.min(lastIndex, Math.max(0, Math.round(sliceVideoPosition)));
        const counterText = `${visibleIndex} / ${lastIndex}`;
        if (sliceVideoCounter) sliceVideoCounter.textContent = counterText;
        if (sliceVideoModalCounter) sliceVideoModalCounter.textContent = counterText;
        setReelProgress(lastIndex ? sliceVideoPosition / lastIndex : 0);
    } else {
        if (sliceVideoCounter) sliceVideoCounter.textContent = "—";
        if (sliceVideoModalCounter) sliceVideoModalCounter.textContent = "—";
        setReelProgress(0);
    }
}

function setReelBusy(isBusy) {
    if (!sliceVideoTrack || !sliceVideoFill) return;
    sliceVideoTrack.classList.toggle("is-busy", isBusy);
    if (isBusy) {
        sliceVideoFill.style.width = "";
    } else {
        sliceVideoFill.style.transform = "";
    }
}

function setReelProgress(fraction) {
    if (!sliceVideoTrack || !sliceVideoFill || sliceVideoPreparing) return;
    sliceVideoTrack.classList.remove("is-busy");
    const pct = Math.round(Math.min(1, Math.max(0, fraction || 0)) * 100);
    sliceVideoFill.style.width = `${pct}%`;
}

function updateVideoControlState() {
    if (!sliceVideoReel) return;

    sliceVideoReel.classList.toggle("is-preparing", sliceVideoPreparing);
    sliceVideoReel.classList.toggle("is-playing", sliceVideoPlaying);
    sliceVideoReel.classList.toggle("is-paused", sliceVideoPaused && !sliceVideoPlaying);

    const canPlay = !sliceVideoPreparing && !sliceVideoPlaying;
    const canPause = sliceVideoPlaying;
    const canStop = sliceVideoSessionActive || sliceVideoPreparing;
    const canSeek = Boolean(sliceVideoCache) && !sliceVideoPreparing;
    const canEnlarge = Boolean(sliceVideoCache) && !sliceVideoPreparing;

    if (btnPlaySliceVideo) btnPlaySliceVideo.disabled = !canPlay;
    if (btnPauseSliceVideo) btnPauseSliceVideo.disabled = !canPause;
    if (btnStopSliceVideo) btnStopSliceVideo.disabled = !canStop;
    if (sliceVideoSeek) sliceVideoSeek.disabled = !canSeek;
    if (btnOpenSliceVideoModal) btnOpenSliceVideoModal.disabled = !canEnlarge;

    if (btnPlaySliceVideoModal) btnPlaySliceVideoModal.disabled = !canPlay || !sliceVideoCache;
    if (btnPauseSliceVideoModal) btnPauseSliceVideoModal.disabled = !canPause;
    if (btnStopSliceVideoModal) btnStopSliceVideoModal.disabled = !canStop;
    if (sliceVideoModalSeek) sliceVideoModalSeek.disabled = !canSeek;
}

function lockVideoExternalControls() {
    if (videoLockedControls.length) return;
    const allowed = new Set([
        "btnPlaySliceVideo",
        "btnPauseSliceVideo",
        "btnStopSliceVideo",
        "sliceVideoSeek",
        "btnOpenSliceVideoModal",
        "btnPlaySliceVideoModal",
        "btnPauseSliceVideoModal",
        "btnStopSliceVideoModal",
        "sliceVideoModalSeek",
        "sliceVideoModalClose",
        "comparisonSlider",
    ]);

    videoLockedControls = [...document.querySelectorAll("button, input, select")]
        .filter((el) => !allowed.has(el.id))
        .map((el) => [el, el.disabled]);

    videoLockedControls.forEach(([el]) => {
        el.disabled = true;
    });
}

function unlockVideoExternalControls() {
    videoLockedControls.forEach(([el, disabled]) => {
        el.disabled = disabled;
    });
    videoLockedControls = [];
}

async function reconstructSliceStack(dataset, numSlices, maskParams, onProgress) {
    const recons = [];
    const metrics = [];
    const cleanMetrics = [];
    const errors = [];
    const references = [];

    for (let i = 0; i < numSlices; i++) {
        if (!sliceVideoSessionActive) break;

        onProgress(i, numSlices);
        const data = await postJSON("/pipeline/reconstruct", {
            source: "dataset",
            dataset,
            slice_index: i,
            ...maskParams,
        });

        if (!sliceVideoSessionActive) break;
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

function ensureCanvasSize(canvas, array2d) {
    if (!canvas || !array2d || !array2d.length || !array2d[0]) return;
    const height = array2d.length;
    const width = array2d[0].length;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
}

function clearSliceVideoPairCache() {
    sliceVideoPairCache = null;
}

function pairCanvasesFor(baseIndex) {
    const cache = sliceVideoCache;
    const lastIndex = cache.recons.length - 1;
    const nextIndex = Math.min(lastIndex, baseIndex + 1);
    const key = `${baseIndex}:${nextIndex}:${reconColormap}`;
    if (sliceVideoPairCache && sliceVideoPairCache.key === key) return sliceVideoPairCache;

    const reconColor = reconColormap === "jet" ? _jet : _grayscale;
    const height = cache.recons[baseIndex].length;
    const width = cache.recons[baseIndex][0].length;

    sliceVideoPairCache = {
        key,
        reconFrom: buildOffscreen(width, height, cache.recons[baseIndex], reconColor),
        reconTo: buildOffscreen(width, height, cache.recons[nextIndex], reconColor),
        errorFrom: buildOffscreen(width, height, cache.errors[baseIndex], _hot),
        errorTo: buildOffscreen(width, height, cache.errors[nextIndex], _hot),
        refFrom: buildOffscreen(width, height, cache.references[baseIndex], _grayscale),
        refTo: buildOffscreen(width, height, cache.references[nextIndex], _grayscale),
    };
    return sliceVideoPairCache;
}

function drawCanvasBlend(canvas, fromCanvas, toCanvas, fraction) {
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
    ctx.drawImage(fromCanvas, 0, 0, fromCanvas.width, fromCanvas.height, 0, 0, canvas.width, canvas.height);

    if (fraction > 0.0001) {
        ctx.globalAlpha = Math.min(1, Math.max(0, fraction));
        ctx.drawImage(toCanvas, 0, 0, toCanvas.width, toCanvas.height, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;
    }
}

function isSliceVideoReady() {
    return Boolean(sliceVideoCache && sliceVideoCache.recons && sliceVideoCache.recons.length);
}

function syncSliceVideoModalFrame() {
    if (!sliceVideoModal || !sliceVideoModal.classList.contains("is-open") || !sliceVideoModalCanvas || !canvasRecon) return;
    if (!canvasRecon.width || !canvasRecon.height) return;

    if (sliceVideoModalCanvas.width !== canvasRecon.width) sliceVideoModalCanvas.width = canvasRecon.width;
    if (sliceVideoModalCanvas.height !== canvasRecon.height) sliceVideoModalCanvas.height = canvasRecon.height;
    const ctx = sliceVideoModalCanvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, sliceVideoModalCanvas.width, sliceVideoModalCanvas.height);
    ctx.drawImage(canvasRecon, 0, 0);
}

function openSliceVideoModal() {
    if (!isSliceVideoReady() || !sliceVideoModal) return;
    syncSliceVideoModalFrame();
    updateVideoTimeline();
    updateVideoControlState();
    sliceVideoModal.classList.add("is-open");
    sliceVideoModal.setAttribute("aria-hidden", "false");
    // Copy once more after the modal becomes visible so the first frame is
    // guaranteed to be painted even in browsers that defer hidden canvases.
    syncSliceVideoModalFrame();
}

function closeSliceVideoModal() {
    if (!sliceVideoModal) return;
    sliceVideoModal.classList.remove("is-open");
    sliceVideoModal.setAttribute("aria-hidden", "true");
}

function applySliceVideoMetadata(index, force = false) {
    if (!sliceVideoCache) return;
    const cache = sliceVideoCache;
    const lastIndex = cache.recons.length - 1;
    const safeIndex = Math.min(lastIndex, Math.max(0, index));
    if (!force && safeIndex === sliceVideoShownIndex) return;

    sliceVideoShownIndex = safeIndex;
    const dataset = cache.dataset;
    const maskParams = cache.maskParams;

    window.LAST_RECON = cache.recons[safeIndex];
    if (window.updateMRIComparison) {
        window.updateMRIComparison({
            reference: cache.references[safeIndex],
            recon: cache.recons[safeIndex],
        });
    }

    sliceSlider.value = safeIndex;
    sliceValue.textContent = safeIndex;
    window.APP_STATE = { source: "dataset", filename: null, dataset, sliceIndex: safeIndex };

    metricMSE.textContent = fmt(cache.metrics[safeIndex].mse, 6);
    metricPSNR.textContent = cache.metrics[safeIndex].psnr === null
        ? "∞ dB"
        : `${fmt(cache.metrics[safeIndex].psnr, 2)} dB`;
    metricNRMSE.textContent = fmt(cache.metrics[safeIndex].nrmse, 4);
    renderNoiseReview(cache.metrics[safeIndex], cache.cleanMetrics[safeIndex], maskParams.noise_level);
}

function drawSliceVideoPosition(position, forceMetadata = false) {
    if (!sliceVideoCache) return;

    const cache = sliceVideoCache;
    const lastIndex = cache.recons.length - 1;
    const clamped = Math.min(lastIndex, Math.max(0, position));
    sliceVideoPosition = clamped;

    const baseIndex = Math.min(lastIndex, Math.floor(clamped));
    const nextIndex = Math.min(lastIndex, baseIndex + 1);
    const rawFraction = nextIndex === baseIndex ? 0 : clamped - baseIndex;
    const fraction = _easeInOut(rawFraction);

    _cancelCanvasAnimation(canvasRecon);
    _cancelCanvasAnimation(canvasError);
    _cancelCanvasAnimation(canvasOriginal);

    ensureCanvasSize(canvasRecon, cache.recons[baseIndex]);
    ensureCanvasSize(canvasError, cache.errors[baseIndex]);
    ensureCanvasSize(canvasOriginal, cache.references[baseIndex]);

    const pair = pairCanvasesFor(baseIndex);
    drawCanvasBlend(canvasRecon, pair.reconFrom, pair.reconTo, fraction);
    drawCanvasBlend(canvasError, pair.errorFrom, pair.errorTo, fraction);
    drawCanvasBlend(canvasOriginal, pair.refFrom, pair.refTo, fraction);
    syncSliceVideoModalFrame();

    emptyRecon.style.display = "none";
    emptyError.style.display = "none";
    if (typeof emptyOriginalEl !== "undefined" && emptyOriginalEl) emptyOriginalEl.style.display = "none";
    showStep("canvasRecon");

    applySliceVideoMetadata(Math.round(clamped), forceMetadata);
    updateVideoTimeline();
}

function cancelSliceVideoAnimationFrame() {
    if (sliceVideoRaf !== null) {
        cancelAnimationFrame(sliceVideoRaf);
        sliceVideoRaf = null;
    }
    sliceVideoLastTick = 0;
}

function finishNaturalPlayback() {
    sliceVideoPlaying = false;
    sliceVideoPaused = false;
    cancelSliceVideoAnimationFrame();
    drawSliceVideoPosition(sliceVideoCache.recons.length - 1, true);
    setSliceVideoStatus("finished — scrub the timeline or press play to replay");
    updateVideoControlState();

    const cache = sliceVideoCache;
    if (cache && !cache.loggedPlayback) {
        cache.loggedPlayback = true;
        addLog(`played reconstructed slice video: ${cache.dataset} (0 → ${cache.recons.length - 1}, ${cache.maskParams.pattern} @ ×${cache.maskParams.acceleration})`);
    }
}

function sliceVideoTick(now) {
    if (!sliceVideoSessionActive || !sliceVideoPlaying || !sliceVideoCache) return;

    if (!sliceVideoLastTick) sliceVideoLastTick = now;
    const delta = Math.max(0, Math.min(100, now - sliceVideoLastTick));
    sliceVideoLastTick = now;

    if (!sliceVideoScrubbing) {
        sliceVideoPosition += delta / SLICE_VIDEO_FRAME_MS;
    }

    const lastIndex = sliceVideoCache.recons.length - 1;
    if (sliceVideoPosition >= lastIndex) {
        finishNaturalPlayback();
        return;
    }

    drawSliceVideoPosition(sliceVideoPosition);
    sliceVideoRaf = requestAnimationFrame(sliceVideoTick);
}

function resumeSliceVideo() {
    if (!sliceVideoSessionActive || sliceVideoPreparing || !sliceVideoCache) return;

    const lastIndex = sliceVideoCache.recons.length - 1;
    if (sliceVideoPosition >= lastIndex - 0.0001) {
        sliceVideoPosition = 0;
        clearSliceVideoPairCache();
        drawSliceVideoPosition(0, true);
    }

    sliceVideoPlaying = true;
    sliceVideoPaused = false;
    sliceVideoLastTick = 0;
    setSliceVideoStatus("playing reconstructed slices");
    updateVideoControlState();
    cancelSliceVideoAnimationFrame();
    sliceVideoRaf = requestAnimationFrame(sliceVideoTick);
}

function pauseSliceVideo(silent = false) {
    if (!sliceVideoPlaying) return;
    sliceVideoPlaying = false;
    sliceVideoPaused = true;
    cancelSliceVideoAnimationFrame();
    if (!silent) {
        const current = sliceVideoPosition * SLICE_VIDEO_FRAME_SECONDS;
        setSliceVideoStatus(`paused at ${formatVideoTime(current)}`);
    }
    updateVideoControlState();
}

function releaseSliceVideoSession({ resetToStart = true, preserveStatus = false } = {}) {
    cancelSliceVideoAnimationFrame();
    sliceVideoSessionActive = false;
    sliceVideoPreparing = false;
    sliceVideoPlaying = false;
    sliceVideoPaused = false;
    sliceVideoScrubbing = false;
    sliceVideoResumeAfterScrub = false;
    sliceVideoScrubSource = null;

    if (resetToStart && sliceVideoCache) {
        clearSliceVideoPairCache();
        drawSliceVideoPosition(0, true);
    }

    unlockVideoExternalControls();
    setReelBusy(false);
    if (sliceVideoTrack) sliceVideoTrack.classList.remove("is-busy");

    const reconFrame = canvasRecon.closest(".viewcell__frame");
    if (reconFrame) reconFrame.classList.remove("is-scanning");

    if (!preserveStatus) setSliceVideoStatus(SLICE_VIDEO_IDLE_STATUS);

    sliceVideoCache = null;
    sliceVideoPosition = 0;
    sliceVideoShownIndex = -1;
    clearSliceVideoPairCache();

    [sliceVideoSeek, sliceVideoModalSeek].forEach((seek) => {
        if (!seek) return;
        seek.value = "0";
        seek.max = "0";
        seek.disabled = true;
        seek.style.setProperty("--seek-progress", "0%");
    });
    if (sliceVideoTime) sliceVideoTime.textContent = "0:00.0 / 0:00.0";
    if (sliceVideoModalTime) sliceVideoModalTime.textContent = "0:00.0 / 0:00.0";
    if (sliceVideoCounter) sliceVideoCounter.textContent = "—";
    if (sliceVideoModalCounter) sliceVideoModalCounter.textContent = "—";
    if (sliceVideoFill) sliceVideoFill.style.width = "0%";
    updateVideoControlState();
}

function stopSliceVideo() {
    if (!sliceVideoSessionActive && !sliceVideoPreparing) {
        releaseSliceVideoSession({ resetToStart: false });
        return;
    }

    // Reconstruction requests cannot be aborted through postJSON, so mark the
    // session inactive; reconstructSliceStack exits after the in-flight request.
    if (sliceVideoPreparing) {
        sliceVideoSessionActive = false;
        sliceVideoPlaying = false;
        setSliceVideoStatus("stopping reconstruction…");
        updateVideoControlState();
        return;
    }

    releaseSliceVideoSession({ resetToStart: true });
}

async function prepareSliceVideo() {
    if (sliceVideoPreparing || sliceVideoSessionActive) return;

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

    const maskParams = maskPayload();
    sliceVideoSessionActive = true;
    sliceVideoPreparing = true;
    sliceVideoPlaying = false;
    sliceVideoPaused = false;
    sliceVideoPosition = 0;
    sliceVideoShownIndex = -1;
    sliceVideoCache = null;
    clearSliceVideoPairCache();

    lockVideoExternalControls();
    if (window.clearFrequencyExperiment) window.clearFrequencyExperiment();

    const reconFrame = canvasRecon.closest(".viewcell__frame");
    if (reconFrame) reconFrame.classList.add("is-scanning");

    setReelBusy(true);
    setSliceVideoStatus(`reconstructing slice 0 of ${numSlices - 1}…`);
    sliceVideoCounter.textContent = `0 / ${numSlices - 1}`;
    updateVideoControlState();

    try {
        const stack = await reconstructSliceStack(dataset, numSlices, maskParams, (i, total) => {
            setSliceVideoStatus(`reconstructing slice ${i} of ${total - 1}…`);
            sliceVideoCounter.textContent = `${i} / ${total - 1}`;
        });

        if (!sliceVideoSessionActive) {
            releaseSliceVideoSession({ resetToStart: false });
            return;
        }

        if (stack.recons.length < 2) {
            throw new Error("not enough reconstructed slices to play");
        }

        sliceVideoCache = {
            dataset,
            maskParams,
            ...stack,
            loggedPlayback: false,
        };
        sliceVideoPreparing = false;
        setReelBusy(false);
        if (sliceVideoTrack) sliceVideoTrack.classList.remove("is-busy");

        _cancelCanvasAnimation(canvasRecon);
        _cancelCanvasAnimation(canvasError);
        _cancelCanvasAnimation(canvasOriginal);
        sliceVideoPosition = 0;
        drawSliceVideoPosition(0, true);
        updateVideoControlState();
        resumeSliceVideo();
    } catch (error) {
        console.error("Slice video failed:", error);
        statusTextEl.textContent = "slice video failed";
        addLog(`error: ${error.message}`);
        releaseSliceVideoSession({ resetToStart: false, preserveStatus: true });
        setSliceVideoStatus("reconstruction video failed");
    }
}

function playSliceVideo() {
    if (sliceVideoPreparing || sliceVideoPlaying) return;
    if (sliceVideoSessionActive && sliceVideoCache) {
        resumeSliceVideo();
    } else {
        prepareSliceVideo();
    }
}

function seekSliceVideoToSeconds(seconds) {
    if (!sliceVideoCache) return;
    const duration = videoDurationSeconds();
    const safeSeconds = Math.min(duration, Math.max(0, Number(seconds) || 0));
    clearSliceVideoPairCache();
    drawSliceVideoPosition(safeSeconds / SLICE_VIDEO_FRAME_SECONDS, true);
    sliceVideoLastTick = 0;
}

btnPlaySliceVideo.addEventListener("click", playSliceVideo);
btnPauseSliceVideo.addEventListener("click", () => pauseSliceVideo(false));
btnStopSliceVideo.addEventListener("click", stopSliceVideo);

if (btnOpenSliceVideoModal) btnOpenSliceVideoModal.addEventListener("click", openSliceVideoModal);
if (sliceVideoModalBackdrop) sliceVideoModalBackdrop.addEventListener("click", closeSliceVideoModal);
if (sliceVideoModalClose) sliceVideoModalClose.addEventListener("click", closeSliceVideoModal);
if (btnPlaySliceVideoModal) btnPlaySliceVideoModal.addEventListener("click", playSliceVideo);
if (btnPauseSliceVideoModal) btnPauseSliceVideoModal.addEventListener("click", () => pauseSliceVideo(false));
if (btnStopSliceVideoModal) btnStopSliceVideoModal.addEventListener("click", stopSliceVideo);

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sliceVideoModal && sliceVideoModal.classList.contains("is-open")) {
        closeSliceVideoModal();
    }
});

function beginSliceVideoScrub(seekEl) {
    if (!sliceVideoCache) return;
    sliceVideoScrubbing = true;
    sliceVideoScrubSource = seekEl;
    sliceVideoResumeAfterScrub = sliceVideoPlaying;
    if (sliceVideoPlaying) pauseSliceVideo(true);
}

function inputSliceVideoScrub(seekEl) {
    if (!sliceVideoCache) return;
    if (!sliceVideoScrubbing || sliceVideoScrubSource !== seekEl) beginSliceVideoScrub(seekEl);
    seekSliceVideoToSeconds(parseFloat(seekEl.value));
    const currentText = (sliceVideoModalTime || sliceVideoTime).textContent.split(" / ")[0];
    setSliceVideoStatus(`seeking — ${currentText}`);
}

function finishSliceVideoScrub(seekEl) {
    if (!sliceVideoScrubbing) return;
    if (sliceVideoScrubSource && seekEl && sliceVideoScrubSource !== seekEl) return;
    const shouldResume = sliceVideoResumeAfterScrub;
    sliceVideoScrubbing = false;
    sliceVideoResumeAfterScrub = false;
    sliceVideoScrubSource = null;
    updateVideoTimeline();

    if (shouldResume) {
        resumeSliceVideo();
    } else if (sliceVideoCache) {
        sliceVideoPaused = true;
        const current = sliceVideoPosition * SLICE_VIDEO_FRAME_SECONDS;
        setSliceVideoStatus(`paused at ${formatVideoTime(current)}`);
        updateVideoControlState();
    }
}

[sliceVideoSeek, sliceVideoModalSeek].forEach((seekEl) => {
    if (!seekEl) return;
    seekEl.addEventListener("pointerdown", () => beginSliceVideoScrub(seekEl));
    seekEl.addEventListener("input", () => inputSliceVideoScrub(seekEl));
    seekEl.addEventListener("change", () => finishSliceVideoScrub(seekEl));
    seekEl.addEventListener("pointerup", () => finishSliceVideoScrub(seekEl));
    seekEl.addEventListener("pointercancel", () => finishSliceVideoScrub(seekEl));
});

updateVideoTimeline();
updateVideoControlState();
