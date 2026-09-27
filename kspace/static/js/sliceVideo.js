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

function setSliceVideoStatus(text) {
    if (sliceVideoStatus) sliceVideoStatus.textContent = text;
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

function updateVideoTimeline() {
    const duration = videoDurationSeconds();
    const current = Math.min(duration, Math.max(0, sliceVideoPosition * SLICE_VIDEO_FRAME_SECONDS));

    if (sliceVideoSeek) {
        sliceVideoSeek.max = String(duration || 0);
        if (!sliceVideoScrubbing) sliceVideoSeek.value = String(current);
        const seekPct = duration > 0 ? Math.min(100, Math.max(0, (current / duration) * 100)) : 0;
        sliceVideoSeek.style.setProperty("--seek-progress", `${seekPct}%`);
    }
    if (sliceVideoTime) {
        sliceVideoTime.textContent = `${formatVideoTime(current)} / ${formatVideoTime(duration)}`;
    }

    if (sliceVideoCache) {
        const lastIndex = sliceVideoCache.recons.length - 1;
        const visibleIndex = Math.min(lastIndex, Math.max(0, Math.round(sliceVideoPosition)));
        sliceVideoCounter.textContent = `${visibleIndex} / ${lastIndex}`;
        setReelProgress(lastIndex ? sliceVideoPosition / lastIndex : 0);
    } else {
        sliceVideoCounter.textContent = "—";
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

    if (btnPlaySliceVideo) btnPlaySliceVideo.disabled = sliceVideoPreparing || sliceVideoPlaying;
    if (btnPauseSliceVideo) btnPauseSliceVideo.disabled = !sliceVideoPlaying;
    if (btnStopSliceVideo) btnStopSliceVideo.disabled = !sliceVideoSessionActive;
    if (sliceVideoSeek) sliceVideoSeek.disabled = !sliceVideoCache || sliceVideoPreparing;
}

function lockVideoExternalControls() {
    if (videoLockedControls.length) return;
    const allowed = new Set([
        "btnPlaySliceVideo",
        "btnPauseSliceVideo",
        "btnStopSliceVideo",
        "sliceVideoSeek",
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

    if (sliceVideoSeek) {
        sliceVideoSeek.value = "0";
        sliceVideoSeek.max = "0";
        sliceVideoSeek.disabled = true;
        sliceVideoSeek.style.setProperty("--seek-progress", "0%");
    }
    if (sliceVideoTime) sliceVideoTime.textContent = "0:00.0 / 0:00.0";
    if (sliceVideoCounter) sliceVideoCounter.textContent = "—";
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

sliceVideoSeek.addEventListener("pointerdown", () => {
    if (!sliceVideoCache) return;
    sliceVideoScrubbing = true;
    sliceVideoResumeAfterScrub = sliceVideoPlaying;
    if (sliceVideoPlaying) pauseSliceVideo(true);
});

sliceVideoSeek.addEventListener("input", () => {
    if (!sliceVideoCache) return;
    if (!sliceVideoScrubbing) {
        sliceVideoScrubbing = true;
        sliceVideoResumeAfterScrub = sliceVideoPlaying;
        if (sliceVideoPlaying) pauseSliceVideo(true);
    }
    seekSliceVideoToSeconds(parseFloat(sliceVideoSeek.value));
    setSliceVideoStatus(`seeking — ${sliceVideoTime.textContent.split(" / ")[0]}`);
});

function finishSliceVideoScrub() {
    if (!sliceVideoScrubbing) return;
    const shouldResume = sliceVideoResumeAfterScrub;
    sliceVideoScrubbing = false;
    sliceVideoResumeAfterScrub = false;
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

sliceVideoSeek.addEventListener("change", finishSliceVideoScrub);
sliceVideoSeek.addEventListener("pointerup", finishSliceVideoScrub);
sliceVideoSeek.addEventListener("pointercancel", finishSliceVideoScrub);

updateVideoTimeline();
updateVideoControlState();
