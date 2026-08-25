/**
 * Top-right liquid-glass circle for non-main pages.
 * Draggable (snaps home near top-right); click toggles light/dark theme.
 * Theme is session-only — no YouTube / link behavior.
 */
(() => {
  const el = document.querySelector(".c-tr");
  if (!el) return;

  /** @typedef {"light"|"dark"|"system"} ThemePreference */
  /** @typedef {"light"|"dark"} ResolvedTheme */

  /** @type {ThemePreference} */
  let themePreference = "system";
  const HOME_SNAP = 90;

  /** @param {ThemePreference} preference @returns {ResolvedTheme} */
  function resolveTheme(preference) {
    if (preference === "dark") return "dark";
    if (preference === "light") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  /** @param {ThemePreference} preference @returns {ResolvedTheme} */
  function applyTheme(preference) {
    themePreference = preference;
    const resolved = resolveTheme(preference);
    const html = document.documentElement;
    html.setAttribute("data-theme", preference);
    html.setAttribute("data-resolved-theme", resolved);
    html.style.colorScheme = resolved;
    void html.offsetHeight;
    if (typeof window.reinitLiquidGlass === "function") {
      window.reinitLiquidGlass();
    }
    return resolved;
  }

  function toggleTheme() {
    const current = resolveTheme(themePreference);
    applyTheme(current === "dark" ? "light" : "dark");
  }

  // Keep in sync with the head bootstrap (system).
  applyTheme("system");

  const schemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const onSchemeChange = () => {
    if (themePreference !== "system") return;
    applyTheme("system");
  };
  if (typeof schemeQuery.addEventListener === "function") {
    schemeQuery.addEventListener("change", onSchemeChange);
  } else if (typeof schemeQuery.addListener === "function") {
    schemeQuery.addListener(onSchemeChange);
  }

  function applyT(node) {
    if (typeof window.__lgApplyTransform === "function") {
      window.__lgApplyTransform(node);
      return;
    }
    const bx = node._bx || 0;
    const by = node._by || 0;
    const mx = node._mx || 0;
    const my = node._my || 0;
    node.style.transform = `translate(${bx + mx}px, ${by + my}px)`;
  }

  function snapOrbHome(node) {
    node._bx = 0;
    node._by = 0;
    node._mx = 0;
    node._my = 0;
    applyT(node);
  }

  el.removeAttribute("href");
  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (el._moved) return;
    toggleTheme();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (el._moved) return;
    toggleTheme();
  });
  el.addEventListener("dragstart", (e) => e.preventDefault());

  el.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    el._drag = true;
    el._moved = false;
    el.classList.add("is-dragging");
    try {
      el.setPointerCapture(e.pointerId);
    } catch (_) {}
    el._sx = e.clientX - (el._bx || 0);
    el._sy = e.clientY - (el._by || 0);
    el._mx = 0;
    el._my = 0;
  });

  el.addEventListener("pointermove", (e) => {
    if (!el._drag) return;
    const nx = e.clientX - el._sx;
    const ny = e.clientY - el._sy;
    if (Math.hypot(nx - (el._bx || 0), ny - (el._by || 0)) > 4) {
      el._moved = true;
    }
    el._bx = nx;
    el._by = ny;
    applyT(el);
  });

  const end = () => {
    if (!el._drag) return;
    el._drag = false;
    el.classList.remove("is-dragging");
    if (Math.hypot(el._bx || 0, el._by || 0) < HOME_SNAP) {
      snapOrbHome(el);
    }
  };

  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("lostpointercapture", end);
})();
