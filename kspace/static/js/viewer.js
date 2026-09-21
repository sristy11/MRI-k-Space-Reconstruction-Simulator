// Single-view viewport: shows exactly one "page" at a time. Most pages hold
// one image; two pages (mask+undersampled k-space, recon+error) hold a pair,
// because those two results come from the same button click and showing
// them together (rather than auto-switching between them a moment apart)
// avoids the "jumbled, everything happens in a millisecond" feeling.
// The "sound" page is a wide page that hosts the sonification lab.
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

const viewerTitleEl = document.getElementById("viewerTitle");
const viewerStageEl = document.getElementById("viewerStage");
const viewerPrevBtn = document.getElementById("viewerPrev");
const viewerNextBtn = document.getElementById("viewerNext");
const viewerStepButtons = document.querySelectorAll(".viewer-nav__step");

// The tabs in the toolbar define the pages (and their order), so adding a
// tab + a page in the HTML is all it takes to add a view.
const VIEWER_PAGES = Array.from(viewerStepButtons).map((btn) => btn.dataset.page);

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
    viewerStageEl.classList.toggle("is-wide", !!(activePage && activePage.classList.contains("viewer-page--wide")));

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

// ---------------------------------------------------------------------------
// UI polish (purely visual; nothing else depends on it)
// ---------------------------------------------------------------------------
(function uiPolish() {
    // 1) filled track on every range slider (CSS reads --p)
    const sliders = Array.from(document.querySelectorAll('input[type="range"].slider'));
    const paintSlider = (s) => {
        const min = parseFloat(s.min) || 0;
        const max = parseFloat(s.max) || 0;
        const p = max > min ? ((parseFloat(s.value) - min) / (max - min)) * 100 : 0;
        s.style.setProperty("--p", `${Math.max(0, Math.min(100, p))}%`);
    };
    sliders.forEach((s) => {
        s.addEventListener("input", () => paintSlider(s));
        paintSlider(s);
    });
    setInterval(() => sliders.forEach(paintSlider), 400);   // catches values set from code (reset, slice count)

    // 2) a green dot on each tab once its picture exists
    const READY_MARKER = {
        pageOriginal: "emptyOriginal",
        pageKspaceFull: "emptyKspaceFull",
        pageMaskUnder: "emptyMask",
        pageReconError: "emptyRecon",
    };
    const syncTabs = () => {
        viewerStepButtons.forEach((btn) => {
            const markerId = READY_MARKER[btn.dataset.page];
            if (!markerId) return;
            const el = document.getElementById(markerId);
            btn.classList.toggle("is-complete", !!el && el.style.display === "none");
        });
    };
    syncTabs();
    setInterval(syncTabs, 500);

    // 3) the status dot follows the status text
    const textEl = document.getElementById("statusText");
    const dotEl = document.getElementById("statusDot");
    if (textEl && dotEl) {
        const syncDot = () => {
            const t = (textEl.textContent || "").toLowerCase();
            let state = "";
            if (/fail|error|ignored|no dataset|no reconstruction|first/.test(t)) state = "is-warning";
            else if (/\.\.\.|…|uploading|loading|reconstructing|running/.test(t)) state = "is-active";
            else if (/complete|loaded|applied|ready|done|finished/.test(t)) state = "is-done";
            dotEl.classList.remove("is-active", "is-warning", "is-done");
            if (state) dotEl.classList.add(state);
        };
        new MutationObserver(syncDot).observe(textEl, { childList: true, characterData: true, subtree: true });
        syncDot();
    }
})();