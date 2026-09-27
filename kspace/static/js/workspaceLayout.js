(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function makeHeading(title, description) {
    const head = document.createElement("div");
    head.className = "studio-page-head";
    head.innerHTML = `<div><h2>${title}</h2><p>${description}</p></div>`;
    return head;
  }

  function makeTargetPreviewCard(letter, label, canvasId, emptyText) {
    const card = document.createElement("div");
    card.className = "target-preview-card";
    card.innerHTML = `
      <div class="target-preview-label"><b>${letter}</b>${label}</div>
      <div class="target-preview-frame" id="${canvasId}Frame">
        <canvas id="${canvasId}" width="256" height="256"></canvas>
        <div class="target-preview-empty" id="${canvasId}Empty">${emptyText}</div>
      </div>`;
    return card;
  }

  function copyCanvas(sourceId, targetId) {
    const source = $(sourceId);
    const target = $(targetId);
    const empty = $(`${targetId}Empty`);
    const frame = $(`${targetId}Frame`);
    if (!source || !target) return;

    const sourceEmpty = source.parentElement && source.parentElement.querySelector(".viewcell__empty");
    const ready = !sourceEmpty || sourceEmpty.style.display === "none";
    if (!ready) {
      if (empty) empty.style.display = "grid";
      return;
    }

    const width = source.width || 256;
    const height = source.height || 256;
    target.width = width;
    target.height = height;
    const ctx = target.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, 0, 0, width, height);
    if (frame) frame.style.aspectRatio = `${width} / ${height}`;
    if (empty) empty.style.display = "none";
  }

  function clearTargetPreviews() {
    window.LAST_TARGET_ERROR_RESULT = null;
    ["targetSourcePreview", "targetMaskPreview", "targetReconPreview", "targetErrorPreview"].forEach((id) => {
      const canvas = $(id);
      const empty = $(`${id}Empty`);
      const frame = $(`${id}Frame`);
      if (canvas) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
      if (empty) empty.style.display = "grid";
      if (frame) frame.style.aspectRatio = "1";
    });
  }

  // Target-error results should not be copied from the animated Studio canvases.
  // Those canvases are still revealing their pixels when the auto-mask request
  // finishes, so an immediate copy can capture an empty/partial frame. Render the
  // finished arrays returned by /pipeline/auto-mask directly into this page.
  function renderTargetArray(targetId, array, renderer) {
    const target = $(targetId);
    const empty = $(`${targetId}Empty`);
    const frame = $(`${targetId}Frame`);
    if (!target || !Array.isArray(array) || !array.length || !Array.isArray(array[0])) return false;

    renderer(target, array, false);
    const height = array.length;
    const width = array[0].length || 1;
    if (frame) frame.style.aspectRatio = `${width} / ${height}`;
    if (empty) empty.style.display = "none";
    return true;
  }

  function syncTargetPreview() {
    copyCanvas("canvasOriginal", "targetSourcePreview");

    const result = window.LAST_TARGET_ERROR_RESULT;
    if (result) {
      const maskReady = renderTargetArray("targetMaskPreview", result.mask, renderGrayscale);
      const reconReady = renderTargetArray("targetReconPreview", result.recon, renderGrayscale);
      const errorReady = renderTargetArray("targetErrorPreview", result.error, renderHot);

      if (!maskReady) copyCanvas("canvasMask", "targetMaskPreview");
      if (!reconReady) copyCanvas("canvasRecon", "targetReconPreview");
      if (!errorReady) copyCanvas("canvasError", "targetErrorPreview");
      return;
    }

    copyCanvas("canvasMask", "targetMaskPreview");
    copyCanvas("canvasRecon", "targetReconPreview");
    copyCanvas("canvasError", "targetErrorPreview");
  }

  function bindMetricMirror(sourceId, targetId) {
    const source = $(sourceId);
    const target = $(targetId);
    if (!source || !target) return;
    const sync = () => { target.textContent = source.textContent; };
    new MutationObserver(sync).observe(source, { childList: true, characterData: true, subtree: true });
    sync();
  }

  function rememberHome(node, key) {
    if (!node || !node.parentNode) return null;
    const marker = document.createComment(`workspace-home:${key}`);
    node.parentNode.insertBefore(marker, node);
    return marker;
  }

  function restoreHome(node, marker) {
    if (!node || !marker || !marker.parentNode) return;
    marker.parentNode.insertBefore(node, marker.nextSibling);
  }

  function init() {
    const consoleRoot = document.querySelector(".console");
    const pipeline = document.querySelector(".console__body");
    const frequencyLab = $("frequencyLab");
    if (!consoleRoot || !pipeline || !frequencyLab || $("studioWorkspaceNav")) return;

    // Page 01 is deliberately the original studio page, unchanged: left controls,
    // centre Source/k-space/Sampling/Result/Sound viewer and right readouts/log.
    pipeline.id = "studioPipeline";
    pipeline.classList.add("studio-page", "is-active");
    pipeline.dataset.studioPage = "pipeline";

    const noisePanel = $("noisePanel");
    const noiseReadout = $("noiseReadout");
    const autoMaskPanel = $("autoMaskPanel");
    const soundPage = $("pageSound");

    // Remember exact original locations. Specialized pages temporarily reuse the
    // same live controls rather than cloning IDs or creating disconnected copies.
    const homes = {
      noisePanel: rememberHome(noisePanel, "noise-panel"),
      noiseReadout: rememberHome(noiseReadout, "noise-readout"),
      soundPage: rememberHome(soundPage, "sound-page")
    };

    const restoreSharedNodes = () => {
      restoreHome(noisePanel, homes.noisePanel);
      restoreHome(noiseReadout, homes.noiseReadout);
      restoreHome(soundPage, homes.soundPage);
    };

    // ---------------- Noise + audio page ----------------
    const noisePage = document.createElement("section");
    noisePage.id = "studioNoiseAudio";
    noisePage.className = "studio-page studio-page-shell";
    noisePage.dataset.studioPage = "noise";
    noisePage.hidden = true;
    noisePage.appendChild(makeHeading(
      "Audio analysis",
      "Compare and inspect the sonified source, k-space, sampling and reconstruction data in one full-width workspace."
    ));
    const noiseGrid = document.createElement("div");
    noiseGrid.className = "noise-audio-grid noise-audio-grid--audio-only";
    const audioWorkbench = document.createElement("div");
    audioWorkbench.id = "audioWorkspaceBody";
    audioWorkbench.className = "audio-workbench";
    audioWorkbench.innerHTML = '<h3 class="audio-workbench__title">Audio analysis</h3>';
    noiseGrid.append(audioWorkbench);
    noisePage.appendChild(noiseGrid);

    // ---------------- Target error page ----------------
    const targetPage = document.createElement("section");
    targetPage.id = "studioTargetError";
    targetPage.className = "studio-page studio-page-shell";
    targetPage.dataset.studioPage = "target";
    targetPage.hidden = true;
    targetPage.appendChild(makeHeading(
      "Target-error reconstruction",
      "Target search controls, the automatically selected mask, reconstruction, error image and achieved metrics together."
    ));

    const targetGrid = document.createElement("div");
    targetGrid.className = "target-error-grid";
    const targetSidebar = document.createElement("div");
    targetSidebar.id = "targetWorkspaceSidebar";
    targetSidebar.className = "target-error-sidebar";
    // Target-error controls belong exclusively to workspace 03.
    // Move the live panel out of Studio once and keep it here permanently.
    if (autoMaskPanel) targetSidebar.appendChild(autoMaskPanel);
    const targetResults = document.createElement("div");
    targetResults.className = "target-error-results";
    const targetPreviewGrid = document.createElement("div");
    targetPreviewGrid.className = "target-preview-grid";
    targetPreviewGrid.append(
      makeTargetPreviewCard("A", "Source image", "targetSourcePreview", "run target-error reconstruction to preview"),
      makeTargetPreviewCard("D", "Auto-found sampling mask", "targetMaskPreview", "run target-error reconstruction to preview"),
      makeTargetPreviewCard("E", "Reconstructed image", "targetReconPreview", "run target-error reconstruction to preview"),
      makeTargetPreviewCard("F", "Error map |orig − recon|", "targetErrorPreview", "run target-error reconstruction to preview")
    );

    const metricPanel = document.createElement("section");
    metricPanel.className = "panel target-metric-panel";
    metricPanel.innerHTML = `
      <h2 class="panel__eyebrow">Reconstruction metrics</h2>
      <dl class="metrics">
        <div class="metrics__row"><dt>Sampling density</dt><dd id="targetMetricDensity">—</dd></div>
        <div class="metrics__row"><dt>k-space points kept</dt><dd id="targetMetricPoints">—</dd></div>
        <div class="metrics__row metrics__row--highlight"><dt>MSE</dt><dd id="targetMetricMSE">—</dd></div>
        <div class="metrics__row metrics__row--highlight"><dt>PSNR</dt><dd id="targetMetricPSNR">—</dd></div>
        <div class="metrics__row"><dt>NRMSE</dt><dd id="targetMetricNRMSE">—</dd></div>
      </dl>`;
    targetResults.append(targetPreviewGrid, metricPanel);
    targetGrid.append(targetSidebar, targetResults);
    targetPage.appendChild(targetGrid);

    // ---------------- Frequency page ----------------
    const frequencyPage = document.createElement("section");
    frequencyPage.id = "studioFrequency";
    frequencyPage.className = "studio-page studio-page-shell";
    frequencyPage.dataset.studioPage = "frequency";
    frequencyPage.hidden = true;
    frequencyPage.appendChild(makeHeading(
      "MRI frequency-region comparison",
      "Compare MRI frequency regions and low-/high-frequency reconstructions in one workspace."
    ));
    const frequencyWorkspaceBody = document.createElement("div");
    frequencyWorkspaceBody.id = "frequencyWorkspaceBody";
    frequencyPage.appendChild(frequencyWorkspaceBody);

    // Keep the MRI frequency lab physically inside page 04 at all times.
    // This prevents it from leaking below Studio / Noise / Target pages when
    // shared controls are restored to their original locations.
    if (frequencyLab) frequencyWorkspaceBody.appendChild(frequencyLab);

    // ---------------- Report comparison page ----------------
    const reportsPage = document.createElement("section");
    reportsPage.id = "studioReports";
    reportsPage.className = "studio-page studio-page-shell";
    reportsPage.dataset.studioPage = "reports";
    reportsPage.hidden = true;
    reportsPage.appendChild(makeHeading(
      "Report comparison",
      "Upload two K-SPACE PDF reports, compare their reconstruction metrics and settings, then export one combined comparison PDF."
    ));
    const reportsWorkspaceBody = document.createElement("div");
    reportsWorkspaceBody.id = "reportsWorkspaceBody";
    reportsPage.appendChild(reportsWorkspaceBody);

    pipeline.insertAdjacentElement("afterend", noisePage);
    noisePage.insertAdjacentElement("afterend", targetPage);
    targetPage.insertAdjacentElement("afterend", frequencyPage);
    frequencyPage.insertAdjacentElement("afterend", reportsPage);

    // ---------------- Workspace navigation ----------------
    const nav = document.createElement("nav");
    nav.id = "studioWorkspaceNav";
    nav.className = "studio-workspace-nav";
    nav.setAttribute("aria-label", "K-space pages");
    const navTitle = document.createElement("div");
    navTitle.className = "studio-workspace-nav__title";
    navTitle.textContent = "WORKSPACES";
    nav.appendChild(navTitle);

    const tabSpecs = [
      ["pipeline", "01", "Studio"],
      ["noise", "02", "Noise & audio"],
      ["target", "03", "Target error"],
      ["frequency", "04", "MRI frequency"],
      ["reports", "05", "Report compare"]
    ];
    tabSpecs.forEach(([page, index, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `studio-workspace-tab${page === "pipeline" ? " is-active" : ""}`;
      button.dataset.studioTarget = page;
      button.setAttribute("aria-selected", page === "pipeline" ? "true" : "false");
      button.innerHTML = `<span class="studio-workspace-tab__index">${index}</span><span class="studio-workspace-tab__label">${label}</span>`;
      nav.appendChild(button);
    });
    // Place workspace navigation directly under the main header so it behaves as a true top bar.
    consoleRoot.insertBefore(nav, pipeline);
    consoleRoot.classList.add("has-workspace-nav");

    const pages = [pipeline, noisePage, targetPage, frequencyPage, reportsPage];
    const tabs = Array.from(nav.querySelectorAll(".studio-workspace-tab"));

    function activateWorkspace(name) {
      restoreSharedNodes();

      // Move the actual live feature blocks only while their dedicated page is open.
      if (name === "noise") {
        // Keep the Noise simulation and Noise review blocks in Studio.
        // The dedicated Noise & audio workspace is now reserved for the
        // full-width audio-analysis/sonification interface only.
        if (soundPage) audioWorkbench.appendChild(soundPage);
      }

      pages.forEach((page) => {
        const active = page.dataset.studioPage === name;
        page.hidden = !active;
        page.classList.toggle("is-active", active);
      });
      tabs.forEach((tab) => {
        const active = tab.dataset.studioTarget === name;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", active ? "true" : "false");
      });

      // The sound renderer checks this class before redrawing.
      if (soundPage) soundPage.classList.toggle("is-active", name === "noise");
      if (name === "target") syncTargetPreview();

      try { sessionStorage.setItem("kspace-workspace", name); } catch (_) {}
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
      window.scrollTo({ top: 0, behavior: "auto" });
    }

    tabs.forEach((tab) => tab.addEventListener("click", () => activateWorkspace(tab.dataset.studioTarget)));

    bindMetricMirror("metricDensity", "targetMetricDensity");
    bindMetricMirror("metricPoints", "targetMetricPoints");
    bindMetricMirror("metricMSE", "targetMetricMSE");
    bindMetricMirror("metricPSNR", "targetMetricPSNR");
    bindMetricMirror("metricNRMSE", "targetMetricNRMSE");

    const achieved = $("autoMaskAchieved");
    if (achieved) {
      new MutationObserver(() => requestAnimationFrame(syncTargetPreview))
        .observe(achieved, { childList: true, characterData: true, subtree: true });
    }

    const reset = $("btnReset");
    if (reset) reset.addEventListener("click", clearTargetPreviews);
    window.syncTargetErrorPreview = syncTargetPreview;

    let initial = "pipeline";
    try {
      const saved = sessionStorage.getItem("kspace-workspace");
      if (tabSpecs.some(([page]) => page === saved)) initial = saved;
    } catch (_) {}
    activateWorkspace(initial);
  }

  init();
})();
