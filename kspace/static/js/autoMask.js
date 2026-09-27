// "Target error -> auto mask": instead of picking a sampling pattern by
// hand, the user states the reconstruction error they're willing to accept
// and we ask the backend to search for the mask that gets closest to it
// (see kspace_core/auto_mask.py). The result is rendered into the same
// canvases /mask and /reconstruct already use, and loaded into the paint
// grid as an editable custom mask.

const autoMaskMetricEl = document.getElementById("autoMaskMetric");
const autoMaskTargetEl = document.getElementById("autoMaskTarget");
const autoMaskTargetLabelEl = document.getElementById("autoMaskTargetLabel");
const autoMaskFamilyEl = document.getElementById("autoMaskFamily");
const autoMaskCenterSlider = document.getElementById("autoMaskCenterSlider");
const autoMaskCenterValueEl = document.getElementById("autoMaskCenterValue");
const btnAutoMask = document.getElementById("btnAutoMask");

const autoMaskAchievedEl = document.getElementById("autoMaskAchieved");
const autoMaskDensityEl = document.getElementById("autoMaskDensity");
const autoMaskIterationsEl = document.getElementById("autoMaskIterations");
const autoMaskUnreachableEl = document.getElementById("autoMaskUnreachable");

// Sensible default target + step per metric, so switching the dropdown
// doesn't leave a value from a totally different scale sitting in the box.
const AUTO_MASK_METRIC_DEFAULTS = {
    nrmse: { label: "Target NRMSE", value: 0.05, step: 0.01, min: 0 },
    psnr: { label: "Target PSNR (dB)", value: 25, step: 1, min: 0 },
    mse: { label: "Target MSE", value: 0.01, step: 0.001, min: 0 },
};

function syncAutoMaskTargetField() {
    const defaults = AUTO_MASK_METRIC_DEFAULTS[autoMaskMetricEl.value];
    autoMaskTargetLabelEl.textContent = defaults.label;
    autoMaskTargetEl.step = defaults.step;
    autoMaskTargetEl.min = defaults.min;
    autoMaskTargetEl.value = defaults.value;
}

autoMaskMetricEl.addEventListener("change", syncAutoMaskTargetField);
syncAutoMaskTargetField();

autoMaskCenterSlider.addEventListener("input", () => {
    autoMaskCenterValueEl.textContent = `${autoMaskCenterSlider.value}%`;
});

// ---- switch the sampling-pattern UI over to "custom" so the found mask is
// what the next /mask or /reconstruct call actually uses ----
function activateCustomPatternUI() {
    patternButtons.forEach((b) => {
        const isCustom = b.dataset.pattern === "custom";
        b.classList.toggle("is-active", isCustom);
        b.setAttribute("aria-checked", isCustom ? "true" : "false");
    });
    pipelineParams.pattern = "custom";
    accelerationField.style.display = "none";
    acsField.style.display = "none";
    paintField.style.display = "";
}

btnAutoMask.addEventListener("click", async () => {
    if (!requireImage()) return;

    const targetValue = parseFloat(autoMaskTargetEl.value);
    if (Number.isNaN(targetValue)) {
        statusTextEl.textContent = "enter a target value first";
        addLog("error: target error value is not a number");
        return;
    }

    const metric = autoMaskMetricEl.value;
    const family = autoMaskFamilyEl.value;
    const centerFraction = parseFloat(autoMaskCenterSlider.value) / 100;

    statusTextEl.textContent = "searching for a mask that hits the target error...";
    btnAutoMask.disabled = true;

    try {
        const data = await postJSON("/pipeline/auto-mask", {
            ...sourcePayload(),
            metric,
            target_value: targetValue,
            family,
            center_fraction: centerFraction,
            noise_level: pipelineParams.noise_level,
            noise_seed: pipelineParams.noise_seed,
        });

        // Keep the completed target-error result separate from the animated
        // Studio canvases. The dedicated target page renders these arrays
        // directly, so its mask/reconstruction/error previews update immediately.
        window.LAST_TARGET_ERROR_RESULT = data;

        // Make "custom" (the found mask) the active pattern, and load it
        // into the paint grid so it's visible and still hand-editable.
        activateCustomPatternUI();
        if (typeof setPaintMaskArray === "function") setPaintMaskArray(data.mask);

        // Render straight into the existing mask / k-space / recon / error
        // canvases, same as a normal "undersample" + "reconstruct" run.
        renderGrayscale(canvasMask, data.mask);
        emptyMask.style.display = "none";

        renderGrayscale(canvasKspaceUnder, data.kspace_under);
        emptyKspaceUnder.style.display = "none";

        window.LAST_RECON = data.recon;
        if (window.updateMRIComparison) window.updateMRIComparison(data);
        renderRecon(true);
        emptyRecon.style.display = "none";

        renderHot(canvasError, data.error);
        emptyError.style.display = "none";

        showStep("canvasRecon");

        metricDensity.textContent = `${(data.density * 100).toFixed(1)}%`;
        metricPoints.textContent = data.points_kept.toLocaleString();
        metricMSE.textContent = fmt(data.metrics.mse, 6);
        metricPSNR.textContent = data.metrics.psnr === null ? "∞ dB" : `${fmt(data.metrics.psnr, 2)} dB`;
        metricNRMSE.textContent = fmt(data.metrics.nrmse, 4);

        const unit = metric === "psnr" ? " dB" : "";
        autoMaskAchievedEl.textContent = `${fmt(data.achieved_value, metric === "mse" ? 6 : 4)}${unit} (target ${targetValue}${unit})`;
        autoMaskDensityEl.textContent = `${(data.density * 100).toFixed(1)}% · ${data.points_kept.toLocaleString()} pts`;
        autoMaskIterationsEl.textContent = data.iterations;
        autoMaskUnreachableEl.style.display = data.achievable ? "none" : "";

        // Force the dedicated Target Error page to consume the finished arrays
        // now; do not wait for a workspace navigation event to refresh it.
        if (window.syncTargetErrorPreview) window.syncTargetErrorPreview();

        statusTextEl.textContent = data.achievable
            ? "auto mask found — target error reached"
            : "auto mask found — target was out of reach, showing closest result";
        addLog(
            `auto-mask: ${family} @ ${(data.density * 100).toFixed(1)}% density, ` +
            `${metric}=${fmt(data.achieved_value, metric === "mse" ? 6 : 4)}${unit} ` +
            `(target ${targetValue}${unit}, ${data.iterations} iterations)` +
            (data.achievable ? "" : " — target unreachable, closest shown")
        );
    } catch (err) {
        statusTextEl.textContent = "auto-mask search failed";
        addLog(`error: ${err.message}`);
    } finally {
        btnAutoMask.disabled = false;
    }
});
