// Single-view viewport: shows exactly one "page" at a time. Most pages hold
// one image; two pages (mask+undersampled k-space, recon+error) hold a pair,
// because those two results come from the same button click and showing
// them together (rather than auto-switching between them a moment apart)
// avoids the "jumbled, everything happens in a millisecond" feeling.
//
// controls.js / main.js still call showStep(canvasId) with the individual
// canvas id right after rendering it, same as before — this file maps that
// canvas id to whichever page contains it, so no other file needed to change.

const CANVAS_TO_PAGE = {
    canvasOriginal: "pageOriginal",
    canvasKspaceFull: "pageKspaceFull",
    canvasMask: "pageMaskUnder",
    canvasKspaceUnder: "pageMaskUnder",
    canvasRecon: "pageReconError",
    canvasError: "pageReconError",
};

const VIEWER_PAGES = ["pageOriginal", "pageKspaceFull", "pageMaskUnder", "pageReconError"];

const viewerTitleEl = document.getElementById("viewerTitle");
const viewerStageEl = document.getElementById("viewerStage");
const viewerPrevBtn = document.getElementById("viewerPrev");
const viewerNextBtn = document.getElementById("viewerNext");
const viewerStepButtons = document.querySelectorAll(".viewer-nav__step");

let currentPageIndex = 0;

function showPage(pageId) {
    const index = VIEWER_PAGES.indexOf(pageId);
    if (index === -1) return;
    currentPageIndex = index;

    document.querySelectorAll("#viewerStage .viewer-page").forEach((page) => {
        const isActive = page.dataset.page === pageId;
        page.classList.toggle("is-active", isActive);
        if (isActive) {
            viewerTitleEl.textContent = page.dataset.title || pageId;
        }
    });

    const activePage = document.getElementById(pageId);
    viewerStageEl.classList.toggle("is-pair", !!(activePage && activePage.classList.contains("viewer-page--pair")));

    viewerStepButtons.forEach((btn) => {
        const isActive = btn.dataset.page === pageId;
        btn.classList.toggle("is-active", isActive);
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });
}

// Called by controls.js / main.js with a canvas id (e.g. "canvasRecon") —
// resolves it to whichever page contains that canvas and shows that page.
function showStep(canvasId) {
    const pageId = CANVAS_TO_PAGE[canvasId];
    if (pageId) showPage(pageId);
}

viewerStepButtons.forEach((btn) => {
    btn.addEventListener("click", () => showPage(btn.dataset.page));
});

viewerPrevBtn.addEventListener("click", () => {
    const newIndex = Math.max(0, currentPageIndex - 1);
    showPage(VIEWER_PAGES[newIndex]);
});

viewerNextBtn.addEventListener("click", () => {
    const newIndex = Math.min(VIEWER_PAGES.length - 1, currentPageIndex + 1);
    showPage(VIEWER_PAGES[newIndex]);
});