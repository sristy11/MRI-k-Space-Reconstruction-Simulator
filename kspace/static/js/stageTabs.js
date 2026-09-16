// Drives the 4-tab pipeline stage view (Source / K-Space / Undersampling /
// Reconstruction). Doesn't touch any existing IDs or logic in main.js /
// controls.js — it only shows/hides the panels those scripts already render
// into, and switches tabs automatically as the user moves through the
// pipeline so they're never looking at all six canvases at once.

(function () {
  const tabs = Array.from(document.querySelectorAll(".stage-tab"));
  const panels = Array.from(document.querySelectorAll(".stage-panel"));

  function activateTab(name) {
    tabs.forEach((tab) => {
      const active = tab.dataset.tab === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    panels.forEach((panel) => {
      const active = panel.dataset.tabPanel === name;
      panel.classList.toggle("is-active", active);
      panel.hidden = !active;
    });
  }

  function markComplete(name) {
    const tab = tabs.find((t) => t.dataset.tab === name);
    if (tab) tab.classList.add("is-complete");
  }

  function clearComplete() {
    tabs.forEach((t) => t.classList.remove("is-complete"));
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  });

  // ---- auto-advance: jump to the tab that's about to get new content ----
  const advanceOnClick = [
    ["btnTransform", "kspace"],
    ["btnUndersample", "sampling"],
    ["btnReconstruct", "result"],
    ["btnLoadDataset", "source"],
  ];

  advanceOnClick.forEach(([id, tab]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", () => activateTab(tab));
  });

  const resetBtn = document.getElementById("btnReset");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      activateTab("source");
      clearComplete();
    });
  }

  // ---- completion checkmarks: watch the "empty" placeholders that
  // main.js / controls.js already toggle when a canvas gets drawn ----
  const watchList = [
    ["emptyOriginal", "source"],
    ["emptyKspaceFull", "kspace"],
    ["emptyKspaceUnder", "sampling"],
    ["emptyMask", "sampling"],
    ["emptyRecon", "result"],
    ["emptyError", "result"],
  ];

  watchList.forEach(([id, tab]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const observer = new MutationObserver(() => {
      if (el.style.display === "none") markComplete(tab);
    });
    observer.observe(el, { attributes: true, attributeFilter: ["style"] });
  });

  activateTab("source");
})();
