/**
 * Yan Levin site chatbot — liquid-glass pill + response panel.
 * Talks to Mac Studio GPT-OSS via same-origin /api/chat (prod)
 * or local apiBase + /api/visitor-token (dev).
 * Theme preference is session-only (resets to system on refresh).
 */
(() => {
  const root = document.getElementById("yan-chat");
  if (!root) return;

  const pill = root.querySelector(".yan-chat-pill");
  const panel = root.querySelector(".yan-chat-panel");
  const messagesEl = root.querySelector(".yan-chat-messages");
  const form = root.querySelector(".yan-chat-form");
  const input = root.querySelector(".yan-chat-input");
  const launcher = root.querySelector(".yan-chat-launcher");
  const closeBtns = root.querySelectorAll("[data-yan-chat-close]");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** @type {{role: string, content: string}[]} */
  let history = [];
  let sending = false;
  let configPromise = null;
  let tokenCache = { token: "", expiresAt: 0 };

  /** In-memory only (not a cookie / localStorage). Groups turns in chat-log. */
  const sessionId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

  /** @typedef {"light"|"dark"|"system"} ThemePreference */
  /** @typedef {"light"|"dark"} ResolvedTheme */

  /** Session-only; never written to localStorage. */
  /** @type {ThemePreference} */
  let themePreference = "system";

  /** @param {unknown} value @returns {value is ThemePreference} */
  function isThemePreference(value) {
    return value === "light" || value === "dark" || value === "system";
  }

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
    if (!isThemePreference(preference)) return resolveTheme(themePreference);
    themePreference = preference;
    const resolved = resolveTheme(preference);
    const html = document.documentElement;
    html.setAttribute("data-theme", preference);
    html.setAttribute("data-resolved-theme", resolved);
    html.style.colorScheme = resolved;
    void html.offsetHeight;
    return resolved;
  }

  function refreshGlass() {
    if (typeof window.reinitLiquidGlass === "function") {
      window.reinitLiquidGlass();
    }
  }

  window.__refreshSiteTheme = () => {
    applyTheme(themePreference);
    refreshGlass();
  };

  // Bootstrap already set system; keep JS state in sync.
  applyTheme("system");

  const schemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const onSchemeChange = () => {
    if (themePreference !== "system") return;
    applyTheme("system");
    refreshGlass();
  };
  if (typeof schemeQuery.addEventListener === "function") {
    schemeQuery.addEventListener("change", onSchemeChange);
  } else if (typeof schemeQuery.addListener === "function") {
    schemeQuery.addListener(onSchemeChange);
  }

  function state() {
    return root.dataset.state || "closed";
  }

  const COMPOSER_MAX_LINES = 8;
  let lastPillH = 0;
  let composerGlassTimer = 0;

  function cssPx(el, name) {
    const raw = String(getComputedStyle(el).getPropertyValue(name) || "").trim();
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return n;
    const nested = raw.match(/^var\(\s*(--[\w-]+)/);
    return nested ? cssPx(el, nested[1]) : 0;
  }

  function circlePx() {
    return cssPx(root, "--chat-circle") || cssPx(root, "--corner-orb") || 80;
  }

  function desktopEnterSends() {
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  }

  /** Count wrapped + hard-break lines without reading textarea.scrollHeight (flex min-height lies). */
  function composerLineCount() {
    const text = String(input.value || "");
    const parts = text.split("\n");
    const width = Math.max(0, input.clientWidth || input.offsetWidth || 0);
    if (width < 8) return Math.max(1, parts.length);
    const cs = getComputedStyle(input);
    const canvas =
      composerLineCount._c || (composerLineCount._c = document.createElement("canvas"));
    const ctx = canvas.getContext("2d");
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    let lines = 0;
    for (const part of parts) {
      if (!part) {
        lines += 1;
        continue;
      }
      const w = ctx.measureText(part).width;
      lines += Math.max(1, Math.ceil(w / width));
    }
    return Math.max(1, lines);
  }

  function syncComposerFrost() {
    const filled = state() !== "closed" && Boolean(input && String(input.value).length);
    root.classList.toggle("has-input-text", filled);
  }

  function bumpComposerGlass() {
    window.clearTimeout(composerGlassTimer);
    composerGlassTimer = window.setTimeout(() => {
      if (typeof window.reinitLiquidGlass === "function") {
        window.reinitLiquidGlass();
      }
    }, 90);
  }

  /** Grow the liquid-glass pill with wrapped / multiline text. Same corner radius. */
  function syncComposerSize() {
    if (!input || !root) return;
    syncComposerFrost();
    const circle = circlePx();
    const radius = Math.round(circle / 2);
    if (pill) pill.setAttribute("data-lg-radius", String(radius));

    if (state() === "closed") {
      input.style.height = "";
      input.style.overflowY = "hidden";
      root.classList.remove("is-composer-tall");
      if (lastPillH !== 0) {
        lastPillH = 0;
        root.style.setProperty("--pill-h", `${Math.round(circle)}px`);
      }
      return;
    }

    const cs = getComputedStyle(input);
    let lineH = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lineH) || lineH < 8) {
      lineH = (parseFloat(cs.fontSize) || 16) * 1.35;
    }
    const lines = composerLineCount();
    const fromClosed = lastPillH === 0;

    // One visual line: original circle-height pill, text centered in the form.
    if (lines <= 1) {
      input.style.height = "";
      input.style.overflowY = "hidden";
      root.classList.remove("is-composer-tall");
      const changed = lastPillH !== circle;
      lastPillH = circle;
      root.style.setProperty("--pill-h", `${Math.round(circle)}px`);
      if (changed && !fromClosed) bumpComposerGlass();
      return;
    }

    const nextH = Math.min(lines, COMPOSER_MAX_LINES) * lineH;
    input.style.height = `${nextH}px`;
    input.style.overflowY = lines > COMPOSER_MAX_LINES ? "auto" : "hidden";

    const formCs = form ? getComputedStyle(form) : null;
    const formPad = formCs
      ? (parseFloat(formCs.paddingTop) || 0) + (parseFloat(formCs.paddingBottom) || 0)
      : 0;
    const pillH = Math.max(circle, Math.ceil(nextH + formPad));
    root.classList.toggle("is-composer-tall", pillH > circle + 4);
    if (Math.abs(pillH - lastPillH) > 0.5) {
      lastPillH = pillH;
      root.style.setProperty("--pill-h", `${pillH}px`);
      if (!fromClosed) bumpComposerGlass();
    }
  }

  function releaseChatMagnetic(el) {
    if (!el) return;
    el._mx = 0;
    el._my = 0;
    el._lgAlong = 1;
    el._lgPerp = 1;
    el._lgRot = 0;
    el._lgPress = 1;
    el.style.transform = "";
  }

  function setState(next) {
    root.dataset.state = next;
    const open = next !== "closed";
    root.classList.toggle("is-open", open);
    root.classList.toggle("has-panel", next === "panel");
    if (panel) {
      panel.hidden = next !== "panel";
      panel.setAttribute("aria-hidden", next === "panel" ? "false" : "true");
    }
    if (pill) {
      pill._lgMagClamp = open;
      if (!open) releaseChatMagnetic(pill);
    }
    if (next !== "panel") releaseChatMagnetic(panel);
    closeBtns.forEach((btn) => {
      const pillBtn = btn.classList.contains("yan-chat-close--pill");
      const panelBtn = btn.classList.contains("yan-chat-close--panel");
      if (!open) releaseChatMagnetic(btn);
      else if (next === "panel" && pillBtn) releaseChatMagnetic(btn);
      else if (next !== "panel" && panelBtn) releaseChatMagnetic(btn);
    });
    if (launcher) {
      launcher.setAttribute("aria-expanded", open ? "true" : "false");
      launcher.tabIndex = open ? -1 : 0;
    }
    if (input) {
      input.tabIndex = open ? 0 : -1;
      if (open) {
        // Wait for spring so focus doesn't fight the transform.
        window.setTimeout(() => input.focus({ preventScroll: true }), reduceMotion ? 0 : 420);
      }
    }
    syncComposerSize();
    scheduleGlassRefresh();
  }

  // Pill left/width spring is 0.7s with overshoot. Rebuilding glass mid-tween
  // leaves a pill-sized displacement rim inset inside the settled circle.
  const PILL_SPRING_MS = 780;
  let glassTimer = 0;
  let glassTransitionHandler = null;

  function scheduleGlassRefresh() {
    window.clearTimeout(glassTimer);
    if (glassTransitionHandler && pill) {
      pill.removeEventListener("transitionend", glassTransitionHandler);
      glassTransitionHandler = null;
    }

    if (reduceMotion || !pill) {
      refreshGlass();
      return;
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(glassTimer);
      if (glassTransitionHandler && pill) {
        pill.removeEventListener("transitionend", glassTransitionHandler);
        glassTransitionHandler = null;
      }
      refreshGlass();
    };

    glassTransitionHandler = (event) => {
      if (event.target !== pill) return;
      if (
        event.propertyName !== "width" &&
        event.propertyName !== "left" &&
        event.propertyName !== "height"
      ) {
        return;
      }
      finish();
    };
    pill.addEventListener("transitionend", glassTransitionHandler);
    glassTimer = window.setTimeout(finish, PILL_SPRING_MS);
  }

  async function loadConfig() {
    if (configPromise) return configPromise;
    configPromise = (async () => {
      const host = window.location.hostname;
      const isLocal =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0" ||
        host.endsWith(".local");

      let runtime = { apiBase: "https://api.yanylevin.com", useSameOriginProxy: true };
      try {
        const res = await fetch("/runtime-config.json", { cache: "no-store" });
        if (res.ok) runtime = { ...runtime, ...(await res.json()) };
      } catch {
        /* keep defaults */
      }

      if (isLocal) {
        return {
          apiBase: "http://127.0.0.1:3004",
          useSameOriginProxy: false,
        };
      }
      return {
        apiBase: String(runtime.apiBase || "https://api.yanylevin.com").replace(/\/$/, ""),
        useSameOriginProxy: runtime.useSameOriginProxy !== false,
      };
    })();
    return configPromise;
  }

  async function getBearerToken(apiBase) {
    const now = Date.now();
    if (tokenCache.token && tokenCache.expiresAt > now + 30_000) {
      return tokenCache.token;
    }

    // Prefer same-origin mint on Vercel; fall back to Mac visitor-token.
    const endpoints = [
      "/api/mac-token",
      `${apiBase}/api/visitor-token`,
    ];

    let lastErr = "token unavailable";
    for (const url of endpoints) {
      try {
        const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.token) {
          lastErr = data.error || `token ${res.status}`;
          continue;
        }
        const ttlMs = (Number(data.expiresIn) || 600) * 1000;
        tokenCache = { token: data.token, expiresAt: now + ttlMs };
        return data.token;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }
    throw new Error(lastErr);
  }

  let bubbleSeq = 0;

  function appendBubble(role, text) {
    if (!messagesEl) return null;
    const el = document.createElement("div");
    el.className = `yan-chat-bubble yan-chat-bubble--${role}`;
    el.dataset.liquidGlass = "rounded";
    el.dataset.filterId = `lg-chat-b-${++bubbleSeq}`;
    const inner = document.createElement("span");
    inner.className = "yan-chat-bubble-in";
    inner.textContent = text;
    el.appendChild(inner);
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    refreshGlass();
    return el;
  }

  function flyUserBubble(destEl, originRect) {
    if (typeof window.yanChatSendFlight !== "function") return;
    window.yanChatSendFlight({
      destEl,
      originRect,
      root,
      reduceMotion,
    });
  }

  function setBusy(busy) {
    sending = busy;
    root.classList.toggle("is-busy", busy);
    if (input) input.disabled = busy;
    const submit = form?.querySelector('button[type="submit"]');
    if (submit) submit.disabled = busy;
  }

  function showOffline(message) {
    appendBubble("assistant", message);
    if (state() !== "panel") setState("panel");
  }

  function chatBody() {
    return {
      messages: history,
      temperature: 0.4,
      maxTokens: 2048,
      sessionId,
      uiContext: {
        theme: themePreference,
        resolvedTheme: resolveTheme(themePreference),
      },
    };
  }

  async function sendMessage(raw) {
    const text = String(raw || "").trim();
    if (!text || sending) return;

    const originRect = pill ? pill.getBoundingClientRect() : null;
    if (state() !== "panel") {
      root.classList.add("is-send-flight");
      setState("panel");
    }
    const userEl = appendBubble("user", text);
    history.push({ role: "user", content: text });
    if (input) input.value = "";
    syncComposerSize();
    flyUserBubble(userEl, originRect);
    setBusy(true);

    try {
      const cfg = await loadConfig();
      let res;

      if (cfg.useSameOriginProxy) {
        res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(chatBody()),
        });
      } else {
        const token = await getBearerToken(cfg.apiBase);
        res = await fetch(`${cfg.apiBase}/api/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(chatBody()),
        });
      }

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 502 || res.status === 503) {
          showOffline(
            "The local AI on Yan’s Mac Studio is offline right now. Please try again later."
          );
        } else if (res.status === 401) {
          showOffline("Could not authorize the chat session. Please reload and try again.");
        } else {
          showOffline(data.error || "Something went wrong. Please try again.");
        }
        // Drop the failed user turn so retries stay clean.
        history.pop();
        return;
      }

      const reply =
        typeof data.content === "string" && data.content.trim()
          ? data.content.trim()
          : "No response was returned.";
      history.push({ role: "assistant", content: reply });
      appendBubble("assistant", reply);

      // Theme changes only when the model emitted an action (server → themeUpdate).
      if (isThemePreference(data.themeUpdate?.theme)) {
        applyTheme(data.themeUpdate.theme);
        refreshGlass();
      }

      setState("panel");
    } catch (err) {
      console.error("[yan-chat]", err);
      history.pop();
      showOffline(
        "Could not reach the chatbot. Check that the Mac API is running, then try again."
      );
    } finally {
      setBusy(false);
      if (input && state() !== "closed") {
        input.focus({ preventScroll: true });
      }
    }
  }

  function openChat() {
    if (state() === "closed") setState(history.length ? "panel" : "open");
  }

  function closeChat() {
    setState("closed");
  }

  launcher?.addEventListener("click", (event) => {
    event.preventDefault();
    openChat();
  });

  closeBtns.forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeChat();
    });
  });

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage(input?.value);
  });

  form?.addEventListener("pointerdown", (event) => {
    if (event.target === form) {
      input?.focus({ preventScroll: true });
    }
  });

  input?.addEventListener("input", syncComposerSize);

  // Desktop: Enter sends, Shift+Enter inserts a newline.
  // Touch / iOS: Return inserts a newline; send is the UI button.
  input?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) {
      return;
    }
    if (!desktopEnterSends()) return;
    event.preventDefault();
    sendMessage(input.value);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state() !== "closed") {
      closeChat();
    }
  });

  // Keep glass filters sharp when the viewport resizes while open.
  window.addEventListener(
    "resize",
    (() => {
      let t;
      return () => {
        syncComposerSize();
        if (state() === "closed") return;
        clearTimeout(t);
        t = setTimeout(scheduleGlassRefresh, 120);
      };
    })()
  );

  setState("closed");
})();
