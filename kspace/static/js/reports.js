(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function text(id, fallback = "—") {
    const el = $(id);
    const value = el ? (el.textContent || "").trim() : "";
    return value || fallback;
  }

  function selectedText(id, fallback = "—") {
    const el = $(id);
    if (!el) return fallback;
    if (el.selectedOptions && el.selectedOptions[0]) return (el.selectedOptions[0].textContent || el.value || fallback).trim();
    return (el.value || fallback).trim();
  }

  function isPlaceholder(value) {
    const v = String(value || "").trim();
    return !v || v === "—" || v === "-";
  }

  function canvasReady(canvasId, emptyId) {
    const canvas = $(canvasId);
    if (!canvas) return false;
    const empty = emptyId ? $(emptyId) : null;
    if (!empty) return true;
    return empty.hidden || getComputedStyle(empty).display === "none" || empty.style.display === "none";
  }

  function canvasHasSignal(canvas) {
    if (!canvas || !canvas.width || !canvas.height) return false;
    try {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const stepX = Math.max(1, Math.floor(canvas.width / 18));
      const stepY = Math.max(1, Math.floor(canvas.height / 18));
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let y = 0; y < canvas.height; y += stepY) {
        for (let x = 0; x < canvas.width; x += stepX) {
          const i = (y * canvas.width + x) * 4;
          if (data[i + 3] > 0 && (data[i] > 2 || data[i + 1] > 2 || data[i + 2] > 2)) return true;
        }
      }
    } catch (_) {
      return true;
    }
    return false;
  }

  function canvasImage(canvasId, emptyId, requireSignal = false) {
    const canvas = $(canvasId);
    if (!canvas || !canvasReady(canvasId, emptyId)) return "";
    if (requireSignal && !canvasHasSignal(canvas)) return "";
    try { return canvas.toDataURL("image/png"); } catch (_) { return ""; }
  }

  function currentSource() {
    const state = window.APP_STATE || {};
    const type = state.source || "unknown";
    let name = "";
    if (type === "upload") name = state.filename || "uploaded image";
    if (type === "dataset") name = state.dataset || "dataset";
    return {
      type,
      name,
      slice: type === "dataset" && state.sliceIndex !== null && state.sliceIndex !== undefined
        ? String(state.sliceIndex)
        : ""
    };
  }

  function buildPayload() {
    const achieved = text("autoMaskAchieved", "—");
    const targetUsed = !isPlaceholder(achieved);
    const pattern = text("patternTriggerText", "—");
    const noiseLevel = $("noiseSlider") ? `${$("noiseSlider").value}%` : "—";

    return {
      title: "K-SPACE Reconstruction Report",
      source: currentSource(),
      settings: {
        pattern,
        acceleration: $("factorSlider") ? `×${$("factorSlider").value}` : "—",
        acs: $("acsSlider") ? String($("acsSlider").value) : "—",
        noise_level: noiseLevel
      },
      metrics: {
        sampling_density: text("metricDensity"),
        points: text("metricPoints"),
        mse: text("metricMSE"),
        psnr: text("metricPSNR"),
        nrmse: text("metricNRMSE")
      },
      noise_metrics: {
        noise: text("metricNoise"),
        psnr_clean: text("metricPSNRClean"),
        mse_clean: text("metricMSEClean"),
        nrmse_clean: text("metricNRMSEClean"),
        psnr_drop: text("metricPSNRDrop")
      },
      target_metrics: targetUsed ? {
        metric: selectedText("autoMaskMetric"),
        target: $("autoMaskTarget") ? String($("autoMaskTarget").value) : "—",
        achieved,
        density: text("autoMaskDensity"),
        status: $("autoMaskUnreachable") && getComputedStyle($("autoMaskUnreachable")).display !== "none"
          ? "Closest reachable result shown"
          : "Target reached"
      } : {},
      frequency: {
        mode: selectedText("comparisonMode", ""),
        cutoff: text("frequencyCutoffValue", "")
      },
      images: {
        source: canvasImage("canvasOriginal", "emptyOriginal"),
        kspace_full: canvasImage("canvasKspaceFull", "emptyKspaceFull"),
        mask: canvasImage("canvasMask", "emptyMask"),
        kspace_under: canvasImage("canvasKspaceUnder", "emptyKspaceUnder"),
        reconstruction: canvasImage("canvasRecon", "emptyRecon"),
        error: canvasImage("canvasError", "emptyError"),
        frequency_low: canvasImage("frequencyLow", null, true),
        frequency_high: canvasImage("frequencyHigh", null, true),
        frequency_comparison: canvasImage("comparisonCanvas", null, true)
      },
      log: Array.from(document.querySelectorAll("#logList .log__entry"))
        .map((el) => (el.textContent || "").trim())
        .filter(Boolean)
    };
  }

  function filenameFromDisposition(response, fallback) {
    const header = response.headers.get("Content-Disposition") || "";
    const match = header.match(/filename="?([^";]+)"?/i);
    return match ? match[1] : fallback;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function errorMessage(response) {
    try {
      const data = await response.json();
      return data.detail || data.message || `Request failed (${response.status})`;
    } catch (_) {
      return `Request failed (${response.status})`;
    }
  }

  function setExportState(button, status, busy, message, kind) {
    if (button) {
      button.disabled = busy;
      button.classList.toggle("is-busy", busy);
      const label = button.querySelector(".report-export__label");
      if (label) label.textContent = busy ? "Building PDF…" : "Export report";
    }
    if (status) {
      status.textContent = message || "";
      status.dataset.kind = kind || "";
    } else if (!busy && kind === "error" && message) {
      window.alert(message);
    }
  }

  async function exportCurrentReport(button, status) {
    const payload = buildPayload();
    if (!payload.images.source) {
      setExportState(button, status, false, "Load an image or dataset slice first.", "error");
      return;
    }
    if (!payload.images.reconstruction) {
      setExportState(button, status, false, "Run a reconstruction before exporting the report.", "error");
      return;
    }

    setExportState(button, status, true, "Collecting reconstruction views and metrics…", "working");
    try {
      const response = await fetch("/reports/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const blob = await response.blob();
      downloadBlob(blob, filenameFromDisposition(response, "kspace_report.pdf"));
      setExportState(button, status, false, "PDF report exported.", "success");
      const log = $("logList");
      if (log) {
        const li = document.createElement("li");
        li.className = "log__entry";
        li.textContent = "report: exported full reconstruction PDF";
        log.appendChild(li);
      }
    } catch (error) {
      setExportState(button, status, false, error.message || "PDF export failed.", "error");
    }
  }

  function ensureHeaderExport() {
    const right = document.querySelector(".console__header .header__right");
    if (!right || $("btnExportReport")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.id = "btnExportReport";
    button.className = "report-export";
    button.title = "Export the current reconstruction, mask, k-space views, metrics and settings as PDF";
    button.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 15v4h14v-4"/></svg>
      <span class="report-export__label">Export report</span>`;
    const theme = $("themeToggle");
    if (theme) right.insertBefore(button, theme);
    else right.prepend(button);

    const syncAvailability = () => {
      const ready = !!(window.APP_STATE && window.APP_STATE.source) && canvasReady("canvasRecon", "emptyRecon");
      button.disabled = !ready;
      button.title = ready
        ? "Export the current reconstruction, mask, k-space views, metrics and settings as PDF"
        : "Run a reconstruction before exporting a PDF report";
    };
    syncAvailability();
    const emptyRecon = $("emptyRecon");
    if (emptyRecon) new MutationObserver(syncAvailability).observe(emptyRecon, { attributes: true, childList: true });
    const logList = $("logList");
    if (logList) new MutationObserver(syncAvailability).observe(logList, { childList: true });
    button.addEventListener("click", () => exportCurrentReport(button, null));
  }

  function fileLabel(input, label, placeholder) {
    const file = input.files && input.files[0];
    if (!file) {
      label.textContent = placeholder;
      label.classList.remove("has-file");
      return;
    }
    label.textContent = `${file.name} · ${(file.size / (1024 * 1024)).toFixed(2)} MB`;
    label.classList.add("has-file");
  }

  function buildCompareWorkspace() {
    const host = $("reportsWorkspaceBody");
    if (!host || host.dataset.reportReady === "1") return;
    host.dataset.reportReady = "1";
    host.innerHTML = `
      <div class="report-page-grid">
        <section class="report-compare-card report-compare-card--intro">
          <div class="report-compare-card__eyebrow">PDF COMPARISON</div>
          <h3>Compare two reconstruction reports</h3>
          <p>Choose two K-SPACE PDF reports. The comparison PDF summarizes reconstruction metrics and acquisition settings, calculates A − B deltas, and appends both complete source reports.</p>
          <div class="report-compare-note">
            <strong>Best results:</strong> use PDFs exported by this version of K-SPACE so the embedded report metadata can be read directly. Older K-SPACE reports are also parsed from visible text when possible.
          </div>
        </section>

        <section class="report-compare-card report-compare-card--files">
          <div class="report-file-grid">
            <label class="report-drop" for="reportFileA">
              <input type="file" id="reportFileA" accept="application/pdf,.pdf">
              <span class="report-drop__badge">A</span>
              <span class="report-drop__copy"><strong>Report A</strong><small id="reportFileALabel">Choose a PDF report</small></span>
              <span class="report-drop__action">Browse</span>
            </label>
            <div class="report-vs" aria-hidden="true">VS</div>
            <label class="report-drop" for="reportFileB">
              <input type="file" id="reportFileB" accept="application/pdf,.pdf">
              <span class="report-drop__badge">B</span>
              <span class="report-drop__copy"><strong>Report B</strong><small id="reportFileBLabel">Choose a PDF report</small></span>
              <span class="report-drop__action">Browse</span>
            </label>
          </div>
          <div class="report-compare-actions">
            <div class="report-compare-output">
              <span class="report-compare-output__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M7 3.75h7.25L19 8.5v11.75H7z"/><path d="M14 3.75V9h5"/><path d="M10 13h6M10 16h6"/></svg>
              </span>
              <div class="report-compare-output__copy">
                <strong>Comparison output</strong>
                <span>One professional PDF with quantitative differences, side-by-side report views, and both originals attached for traceability.</span>
                <div class="report-compare-output__tags" aria-label="Comparison PDF contents">
                  <span>Metrics</span><span>Settings</span><span>Visual A/B</span><span>Appendices</span>
                </div>
              </div>
            </div>
            <button type="button" class="btn btn--accent report-compare-button" id="btnCompareReports" disabled>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11"/><path d="m8 10 4 4 4-4"/><path d="M5 18v2h14v-2"/></svg>
              <span>Generate comparison PDF</span>
            </button>
          </div>
          <div class="report-status" id="reportCompareStatus" role="status" aria-live="polite"></div>
        </section>
      </div>`;

    const inputA = $("reportFileA");
    const inputB = $("reportFileB");
    const labelA = $("reportFileALabel");
    const labelB = $("reportFileBLabel");
    const button = $("btnCompareReports");
    const status = $("reportCompareStatus");

    const sync = () => {
      fileLabel(inputA, labelA, "Choose a PDF report");
      fileLabel(inputB, labelB, "Choose a PDF report");
      button.disabled = !(inputA.files && inputA.files[0] && inputB.files && inputB.files[0]);
      status.textContent = "";
      status.dataset.kind = "";
    };

    inputA.addEventListener("change", sync);
    inputB.addEventListener("change", sync);

    button.addEventListener("click", async () => {
      const a = inputA.files && inputA.files[0];
      const b = inputB.files && inputB.files[0];
      if (!a || !b) return sync();
      if (!/\.pdf$/i.test(a.name) || !/\.pdf$/i.test(b.name)) {
        status.textContent = "Both files must be PDF reports.";
        status.dataset.kind = "error";
        return;
      }
      button.disabled = true;
      button.classList.add("is-busy");
      button.querySelector("span").textContent = "Comparing reports…";
      status.textContent = "Reading report metadata and building the comparison PDF…";
      status.dataset.kind = "working";

      try {
        const form = new FormData();
        form.append("report_a", a);
        form.append("report_b", b);
        const response = await fetch("/reports/compare", { method: "POST", body: form });
        if (!response.ok) throw new Error(await errorMessage(response));
        const blob = await response.blob();
        downloadBlob(blob, filenameFromDisposition(response, "kspace_report_comparison.pdf"));
        status.textContent = "Comparison PDF generated and downloaded.";
        status.dataset.kind = "success";
      } catch (error) {
        status.textContent = error.message || "Could not compare these reports.";
        status.dataset.kind = "error";
      } finally {
        button.classList.remove("is-busy");
        button.querySelector("span").textContent = "Generate comparison PDF";
        button.disabled = false;
      }
    });
  }

  function init() {
    ensureHeaderExport();
    buildCompareWorkspace();

    // Re-run once after workspaceLayout creates page 05 if script ordering or
    // browser caching causes the reports script to initialize first.
    if (!$("reportsWorkspaceBody")) setTimeout(buildCompareWorkspace, 80);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
