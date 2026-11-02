/**
 * Top-right liquid-glass circle for non-main pages.
 * Draggable (snaps home near top-right); click toggles light/dark theme.
 * Theme is session-only.
 *
 * On education, dashboard, usage, and debate, a logged-in L of glass squares
 * sits in the bottom-left. Drag the circle into the empty cell and it becomes
 * a square that still toggles the theme. Drag it back out and it is a circle.
 *
 * Any other page with the top YL squircle and this circle grows the same
 * bottom-left dock and the bottom-right agent chat when the Google session
 * is you@example.com. Logged-out visitors stay on the top two only.
 */
(() => {
  const el = document.querySelector(".c-tr");
  if (!el) return;

  /** @typedef {"light"|"dark"|"system"} ThemePreference */
  /** @typedef {"light"|"dark"} ResolvedTheme */

  /** @type {ThemePreference} */
  let themePreference = "system";
  const HOME_SNAP = 90;
  const DOCK_SNAP = 72;

  /** @param {ThemePreference} preference @returns {ResolvedTheme} */
  function resolveTheme(preference) {
    if (preference === "dark") return "dark";
    if (preference === "light") return "light";
    if (typeof window.__resolveSystemTheme === "function") {
      const resolved = window.__resolveSystemTheme();
      if (resolved === "dark" || resolved === "light") return resolved;
    }
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

  window.__refreshSiteTheme = () => applyTheme(themePreference);

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

  function withNoTransition(node, fn) {
    const prev = node.style.transition;
    node.style.transition = "none";
    const result = fn();
    void node.offsetWidth;
    node.style.transition = prev;
    return result;
  }

  function getHomeRect(node) {
    return withNoTransition(node, () => {
      const prev = node.style.transform;
      node.style.transform = "none";
      void node.offsetWidth;
      const rect = node.getBoundingClientRect();
      node.style.transform = prev;
      return rect;
    });
  }

  function appDockPage() {
    const path = location.pathname.replace(/\/+$/, "") || "/";
    return (
      path === "/education" ||
      path.startsWith("/education/") ||
      path === "/dashboard" ||
      path.startsWith("/dashboard/") ||
      path === "/usage" ||
      path.startsWith("/usage/") ||
      path === "/debate" ||
      path.startsWith("/debate/")
    );
  }

  // Empty cell of the bottom-left L: right of Usage, above Dashboard.
  function getDockSlotRect() {
    const dock = document.getElementById("app-dock");
    if (!dock || dock.hidden) return null;
    const usage = document.querySelector(".dock-usage");
    const dash = document.querySelector(".dock-dash");
    const home = document.querySelector(".dock-home");
    if (!usage || !dash || !home) return null;
    const usageR = usage.getBoundingClientRect();
    const dashR = dash.getBoundingClientRect();
    const size = home.getBoundingClientRect().width;
    if (size < 8) return null;
    return { left: dashR.left, top: usageR.top, width: size, height: size };
  }

  function offsetToRect(node, target) {
    const home = getHomeRect(node);
    return { x: target.left - home.left, y: target.top - home.top };
  }

  function distCenters(a, b) {
    return Math.hypot(
      a.left + a.width / 2 - (b.left + b.width / 2),
      a.top + a.height / 2 - (b.top + b.height / 2)
    );
  }

  function preserveCenterOffset(node) {
    const visual = node.getBoundingClientRect();
    const cx = visual.left + visual.width / 2;
    const cy = visual.top + visual.height / 2;
    const home = getHomeRect(node);
    node._bx = cx - home.width / 2 - home.left;
    node._by = cy - home.height / 2 - home.top;
    node._mx = 0;
    node._my = 0;
    applyT(node);
  }

  function socialRadius() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--social-size");
    const size = parseFloat(raw) || 50;
    return Math.round(size * 0.35);
  }

  function snapToSlot(node) {
    const slot = getDockSlotRect();
    if (!slot) return;
    const off = offsetToRect(node, slot);
    node._bx = off.x;
    node._by = off.y;
    node._mx = 0;
    node._my = 0;
    applyT(node);
  }

  function dockOrb(node) {
    const wasDocked = node._docked;
    node._docked = true;
    withNoTransition(node, () => {
      node.classList.add("is-docked", "squircle");
      node.classList.remove("circle");
      node.setAttribute("data-liquid-glass", "squircle");
      node.style.setProperty("--lg-radius", `${socialRadius()}px`);
      preserveCenterOffset(node);
    });
    snapToSlot(node);
    if (!wasDocked && typeof window.reinitLiquidGlass === "function") {
      window.reinitLiquidGlass();
    }
  }

  function undockOrb(node) {
    if (!node._docked) return;
    node._docked = false;
    withNoTransition(node, () => {
      node.classList.remove("is-docked", "squircle");
      node.classList.add("circle");
      node.setAttribute("data-liquid-glass", "circle");
      preserveCenterOffset(node);
    });
    if (typeof window.reinitLiquidGlass === "function") window.reinitLiquidGlass();
  }

  function snapOrbHome(node) {
    undockOrb(node);
    node._bx = 0;
    node._by = 0;
    node._mx = 0;
    node._my = 0;
    applyT(node);
  }

  el._docked = false;
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
    const slot = getDockSlotRect();
    if (el._docked && slot && distCenters(el.getBoundingClientRect(), slot) > DOCK_SNAP) {
      undockOrb(el);
      el._sx = e.clientX - (el._bx || 0);
      el._sy = e.clientY - (el._by || 0);
    }
  });

  const end = () => {
    if (!el._drag) return;
    el._drag = false;
    el.classList.remove("is-dragging");
    const slot = getDockSlotRect();
    const visual = el.getBoundingClientRect();
    if (slot && distCenters(visual, slot) < DOCK_SNAP) {
      dockOrb(el);
    } else if (Math.hypot(el._bx || 0, el._by || 0) < HOME_SNAP) {
      snapOrbHome(el);
    } else if (el._docked) {
      undockOrb(el);
    }
  };

  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("lostpointercapture", end);

  addEventListener("resize", () => {
    if (!el._docked || el._drag) return;
    snapToSlot(el);
  });

  const YL_PATH =
    "M229.4,214.58c0,11.34-9.21,20.52-20.55,20.51l-117.33-.11c-2.66-.02-5.21-.49-7.64-1.48-9.37-3.58-14.91-14.5-12.23-24.2.17-.64.37-1.29.61-1.92,0,0,22.86-63.64,22.86-63.64L26.54,49.57c-6.68-9.17-4.66-22.01,4.51-28.69,9.17-6.67,22.01-4.65,28.68,4.51l52.17,71.64,23.93-66.63c3.8-10.58,15.47-16.08,26.05-12.28,10.59,3.81,16.09,15.47,12.28,26.05l-53.8,149.78,88.53.08c11.34.01,20.53,9.21,20.51,20.55Z";

  function dockMarkup() {
    return `
      <a class="corner social-orb dock-usage squircle" data-liquid-glass="squircle" data-filter-id="lg-dock-usage" href="/usage/" aria-label="Usage">
        <svg viewBox="0 0 24 24" aria-hidden="true" draggable="false"><path fill="currentColor" d="M4 13.2c0-.7.5-1.2 1.2-1.2h1.6c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H5.2c-.7 0-1.2-.5-1.2-1.2v-6.1Zm6-8.4c0-.7.5-1.2 1.2-1.2h1.6c.7 0 1.2.5 1.2 1.2v14.5c0 .7-.5 1.2-1.2 1.2h-1.6c-.7 0-1.2-.5-1.2-1.2V4.8Zm6 4.2c0-.7.5-1.2 1.2-1.2h1.6c.7 0 1.2.5 1.2 1.2v10.3c0 .7-.5 1.2-1.2 1.2h-1.6c-.7 0-1.2-.5-1.2-1.2V9Z"/></svg>
      </a>
      <a class="corner social-orb dock-home squircle" data-liquid-glass="squircle" data-filter-id="lg-dock-home" href="/" aria-label="Yan Levin">
        <svg viewBox="0 0 252 252" aria-hidden="true" draggable="false"><path fill="currentColor" d="${YL_PATH}"/></svg>
      </a>
      <a class="corner social-orb dock-dash squircle" data-liquid-glass="squircle" data-filter-id="lg-dock-dash" href="/dashboard/" aria-label="Dashboard">
        <svg viewBox="0 0 24 24" aria-hidden="true" draggable="false"><g fill="currentColor"><rect x="2.2" y="3" width="4.4" height="18" rx="1.15"/><rect x="10" y="3" width="11.8" height="7.3" rx="1.15"/><rect x="10" y="13.7" width="11.8" height="7.3" rx="1.15"/></g></svg>
      </a>`;
  }

  function markDock(dock) {
    const path = location.pathname.replace(/\/+$/, "") || "/";
    const usage = dock.querySelector(".dock-usage");
    const dash = dock.querySelector(".dock-dash");
    if (usage) {
      if (path === "/usage") usage.setAttribute("aria-current", "page");
      else usage.removeAttribute("aria-current");
    }
    if (dash) {
      if (path === "/dashboard") dash.setAttribute("aria-current", "page");
      else dash.removeAttribute("aria-current");
    }
  }

  function watchStage(node) {
    const stage = document.getElementById("stage-full");
    if (!stage || !node) return;
    const sync = () => {
      const on = !stage.hidden;
      if (node.hidden === !on) return;
      node.hidden = !on;
      if (!on) {
        if (node.id === "app-dock" && el._docked) snapOrbHome(el);
        return;
      }
      if (node.id === "app-dock") markDock(node);
      if (typeof window.reinitLiquidGlass === "function") window.reinitLiquidGlass();
    };
    sync();
    new MutationObserver(sync).observe(stage, {
      attributes: true,
      attributeFilter: ["hidden"],
    });
  }

  function buildAppDock(hidden) {
    const dock = document.createElement("nav");
    dock.id = "app-dock";
    dock.className = "app-dock";
    dock.setAttribute("aria-label", "Sites");
    dock.hidden = hidden;
    dock.innerHTML = dockMarkup();
    return dock;
  }

  function installAppDock() {
    if (!appDockPage()) return;
    const stage = document.getElementById("stage-full");
    if (!stage || document.getElementById("app-dock")) return;
    const dock = buildAppDock(true);
    document.body.appendChild(dock);
    watchStage(dock);
  }

  function ensureGlassDefs() {
    if (document.getElementById("liquid-glass-defs")) return;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "liquid-glass-svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.id = "liquid-glass-defs";
    svg.appendChild(defs);
    document.body.appendChild(svg);
  }

  function ownerPad() {
    if (document.getElementById("stage-full")) return;
    if (document.getElementById("yl-owner-corners-css")) return;
    document.documentElement.classList.add("yl-owner-corners");
    const style = document.createElement("style");
    style.id = "yl-owner-corners-css";
    style.textContent =
      "html.yl-owner-corners body{padding-bottom:calc(var(--corner-pad, 1.2rem) + var(--corner-orb, 120px) + 1.5rem)}";
    document.head.appendChild(style);
  }

  function chatLabel() {
    const path = location.pathname;
    if (path === "/jype" || path.startsWith("/jype/")) return "JYPE agent";
    return "Personal assistant";
  }

  function ensureChatWorkspace() {
    if (window.YL_EDU) return;
    const path = location.pathname;
    if (path === "/jype" || path.startsWith("/jype/")) {
      window.YL_EDU = {
        basePath: "/jype",
        apiPrefix: "/api/jype",
        workspace: "jype",
        title: "JYPE",
      };
    }
  }

  function chatMarkup(label) {
    return `
    <div id="edu-chat" class="yan-chat" data-state="closed">
      <div class="yan-chat-column yan-chat-column--history">
        <div class="yan-chat-panel" data-liquid-glass="rounded" data-filter-id="lg-owner-chat-panel" hidden aria-hidden="true" role="region" aria-label="Chat history">
          <button type="button" class="yan-chat-close yan-chat-close--panel circle" data-liquid-glass="circle" data-filter-id="lg-owner-chat-x-panel" data-edu-chat-close-all aria-label="Close chat">
            <svg viewBox="0 0 24 24" aria-hidden="true" style="transform: rotate(45deg)"><g fill="currentColor"><rect x="10.35" y="4.5" width="3.3" height="15" rx="1.65"/><rect x="4.5" y="10.35" width="15" height="3.3" rx="1.65"/></g></svg>
          </button>
          <div class="yan-chat-history"></div>
        </div>
        <div class="yan-chat-pill corner circle c-br" data-liquid-glass="circle" data-filter-id="lg-owner-chat-pill">
          <button type="button" class="yan-chat-launcher" aria-label="${label}" aria-expanded="false" aria-controls="edu-chat-input">
            <svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><rect x="10.35" y="4.5" width="3.3" height="15" rx="1.65"/><rect x="4.5" y="10.35" width="15" height="3.3" rx="1.65"/></g></svg>
          </button>
          <form class="yan-chat-form" action="#" autocomplete="off">
            <label class="visually-hidden" for="edu-chat-input">Ask your agent</label>
            <textarea id="edu-chat-input" class="yan-chat-input" name="q" rows="1" maxlength="32000" tabindex="-1" autocomplete="off" wrap="soft" aria-multiline="true"></textarea>
            <button type="submit" class="yan-chat-send circle" data-liquid-glass="circle" data-filter-id="lg-owner-chat-send" aria-label="Send">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="3.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 18.2V6.4"/><path d="M6.9 11.3L12 6.2L17.1 11.3"/></g></svg>
            </button>
          </form>
        </div>
      </div>
      <div class="yan-chat-column yan-chat-column--thread" hidden>
        <div class="yan-chat-panel" data-liquid-glass="rounded" data-filter-id="lg-owner-chat-panel-thread" hidden aria-hidden="true" role="region" aria-label="${label}">
          <button type="button" class="yan-chat-close yan-chat-close--panel circle" data-liquid-glass="circle" data-filter-id="lg-owner-chat-x-thread" data-edu-chat-close-thread aria-label="Close this chat">
            <svg viewBox="0 0 24 24" aria-hidden="true" style="transform: rotate(45deg)"><g fill="currentColor"><rect x="10.35" y="4.5" width="3.3" height="15" rx="1.65"/><rect x="4.5" y="10.35" width="15" height="3.3" rx="1.65"/></g></svg>
          </button>
          <div class="yan-chat-messages" aria-live="polite"></div>
        </div>
        <div class="yan-chat-pill corner circle c-br" data-liquid-glass="circle" data-filter-id="lg-owner-chat-pill-thread">
          <form class="yan-chat-form" action="#" autocomplete="off">
            <label class="visually-hidden" for="edu-chat-thread-input">Continue this chat</label>
            <textarea id="edu-chat-thread-input" class="yan-chat-input" name="q" rows="1" maxlength="32000" tabindex="-1" autocomplete="off" wrap="soft" aria-multiline="true"></textarea>
            <button type="submit" class="yan-chat-send circle" data-liquid-glass="circle" data-filter-id="lg-owner-chat-send-thread" aria-label="Send">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="3.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 18.2V6.4"/><path d="M6.9 11.3L12 6.2L17.1 11.3"/></g></svg>
            </button>
          </form>
        </div>
      </div>
    </div>`;
  }

  function loadScript(src, type) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      if (type) s.type = type;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(src));
      document.body.appendChild(s);
    });
  }

  function loadOwnerChat() {
    const sources = [
      ["/js/mac-api.js", ""],
      ["/js/chat-send-flight.js?v=1", ""],
      ["https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js", ""],
      ["/education/markdown.js?v=katex-2", ""],
      ["/js/chat-orb.js?v=2", "module"],
      ["/education/chatbot.js?v=chat-file-open", ""],
    ];
    if (!document.querySelector("link[href*='katex.min.css']")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css";
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    }
    return sources.reduce(
      (chain, [src, type]) => chain.then(() => loadScript(src, type)),
      Promise.resolve()
    );
  }

  function installOwnerCorners() {
    if (!document.querySelector("a.c-tl")) return;
    const needsDock = !document.getElementById("app-dock");
    const needsChat = !document.getElementById("edu-chat");
    if (!needsDock && !needsChat) return;

    fetch("/api/auth/session", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then((res) => res.json().catch(() => ({})))
      .then((data) => {
        const email = String(data && data.email ? data.email : "")
          .trim()
          .toLowerCase();
        if (!data || !data.authenticated || email !== "you@example.com") return;

        const stage = document.getElementById("stage-full");
        const hold = Boolean(stage && stage.hidden);
        let added = false;

        if (!document.getElementById("app-dock")) {
          const dock = buildAppDock(hold);
          document.body.appendChild(dock);
          if (stage) watchStage(dock);
          else markDock(dock);
          added = true;
        }

        if (!document.getElementById("edu-chat")) {
          ensureChatWorkspace();
          const holder = document.createElement("div");
          holder.innerHTML = chatMarkup(chatLabel());
          const chat = holder.firstElementChild;
          if (hold) chat.hidden = true;
          document.body.appendChild(chat);
          if (stage) watchStage(chat);
          added = true;
          loadOwnerChat()
            .then(() => {
              if (typeof window.reinitLiquidGlass === "function") window.reinitLiquidGlass();
            })
            .catch(() => {});
        }

        ensureGlassDefs();
        ownerPad();
        if (added && typeof window.reinitLiquidGlass === "function") {
          window.reinitLiquidGlass();
        }
      })
      .catch(() => {});
  }

  installAppDock();
  installOwnerCorners();
})();
