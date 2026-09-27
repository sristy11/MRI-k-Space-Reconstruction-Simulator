(function () {
  "use strict";

  const page = document.getElementById("landingPage");
  if (!page) return;

  const root = document.documentElement;
  const body = document.body;
  const themeButton = document.getElementById("landingThemeToggle");

  function isLight() {
    return root.getAttribute("data-theme") === "light";
  }

  function syncThemeLabel() {
    if (!themeButton) return;
    const label = isLight() ? "Switch to dark mode" : "Switch to light mode";
    themeButton.setAttribute("aria-label", label);
    themeButton.title = label;
  }

  function setTheme(theme) {
    root.setAttribute("data-theme", theme);
    try { localStorage.setItem("kspace-theme", theme); } catch (_) {}
    syncThemeLabel();

    // Keep the application header toggle in sync as well.
    const appTheme = document.getElementById("themeToggle");
    if (appTheme) {
      const label = theme === "light" ? "Switch to dark mode" : "Switch to light mode";
      appTheme.setAttribute("aria-label", label);
      appTheme.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
      appTheme.title = label;
    }
  }

  function enterWorkspace(workspace) {
    const target = workspace || "pipeline";
    const tab = document.querySelector(`[data-studio-target="${target}"]`);
    if (tab) tab.click();

    page.classList.add("is-leaving");
    body.classList.remove("landing-active");

    window.setTimeout(() => {
      page.hidden = true;
      page.classList.remove("is-leaving");
      const focusTarget = document.querySelector(".console__header") || document.querySelector(".console");
      if (focusTarget) focusTarget.scrollIntoView({ block: "start", behavior: "auto" });
    }, 280);
  }

  function showLanding() {
    page.hidden = false;
    page.classList.remove("is-leaving");
    body.classList.add("landing-active");
    page.scrollTop = 0;
    syncThemeLabel();
  }

  document.querySelectorAll("[data-enter-workspace]").forEach((button) => {
    button.addEventListener("click", () => enterWorkspace(button.dataset.enterWorkspace));
  });

  document.querySelectorAll("[data-landing-home]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      showLanding();
    });
  });

  if (themeButton) {
    themeButton.addEventListener("click", () => setTheme(isLight() ? "dark" : "light"));
  }

  // Clicking the application brand gives the workspace a quiet route back to
  // the product overview without adding another control to the top bar.
  const appBrand = document.querySelector(".console__header .brand");
  if (appBrand) {
    appBrand.setAttribute("role", "button");
    appBrand.setAttribute("tabindex", "0");
    appBrand.setAttribute("title", "Open K-SPACE overview");
    appBrand.style.cursor = "pointer";
    appBrand.addEventListener("click", showLanding);
    appBrand.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showLanding();
      }
    });
  }

  syncThemeLabel();
})();
