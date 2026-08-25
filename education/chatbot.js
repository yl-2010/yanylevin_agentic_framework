/**
 * /education chatbot — same orb→pill→panel visuals as main site.
 * Agent calls go to Mac via YanMacApi (api.yanylevin.com), never /api/chat.
 * Runs continue on the Mac after tab close or a new chat; resume via
 * /agent/active, /agent/state, or past-chats. New chat does not stop the
 * previous thread (queued turns still drain in the background).
 * Drag-and-drop files onto the input to attach them.
 */
(() => {
  const root = document.getElementById("edu-chat");
  if (!root) return;

  const pill = root.querySelector(".yan-chat-pill");
  const panel = root.querySelector(".yan-chat-panel");
  const messagesEl = root.querySelector(".yan-chat-messages");
  const historyEl = root.querySelector(".yan-chat-history");
  const form = root.querySelector(".yan-chat-form");
  const input = root.querySelector(".yan-chat-input");
  const launcher = root.querySelector(".yan-chat-launcher");
  const clearBtns = root.querySelectorAll("[data-edu-chat-clear]");
  const minimizeBtns = root.querySelectorAll("[data-edu-chat-minimize]");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** @type {string|null} */
  let sessionId = null;
  let starting = false;
  let sending = false;
  /** @type {{ role: string, content: string, queued?: boolean }[]} */
  let messages = [];
  /** @type {ReturnType<typeof setInterval>|null} */
  let pollTimer = null;
  let preferPanel = false;
  let showingHistory = false;
  /** Bumped when the visible thread changes so in-flight polls/resumes cannot paint an older chat. */
  let viewGen = 0;
  let historyFetchGen = 0;
  let historyStructureKey = "";
  /** @type {string|null} */
  let historyPointerSid = null;

  /** @type {{ id: string, file: File }[]} */
  let pendingFiles = [];
  const MAX_FILES = 16;
  /** Match server MAX_ATTACHMENT_BYTES (JSON+base64 path to Mac API). */
  const MAX_FILE_BYTES = 12 * 1024 * 1024;
  const MAX_QUEUED = 8;
  const POLL_MS = 2000;

  /** @type {HTMLElement|null} */
  let chipsEl = null;
  /** @type {HTMLElement|null} */
  let workingEl = null;
  let busyLabel = "Working…";
  let bubbleSeq = 0;

  function storageKey() {
    const email =
      typeof window.__eduUserEmail === "function"
        ? String(window.__eduUserEmail() || "").trim().toLowerCase()
        : "";
    return email ? `edu-chat-v1:${email}` : "edu-chat-v1";
  }

  function persistLocal() {
    try {
      localStorage.setItem(
        storageKey(),
        JSON.stringify({
          sessionId,
          messages,
          preferPanel,
        })
      );
    } catch {
      /* ignore quota */
    }
  }

  function clearLocal() {
    try {
      localStorage.removeItem(storageKey());
    } catch {
      /* ignore */
    }
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(storageKey());
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return null;
      return data;
    } catch {
      return null;
    }
  }

  function ensureChipsEl() {
    if (chipsEl) return chipsEl;
    chipsEl = document.createElement("div");
    chipsEl.className = "yan-chat-attach-chips";
    chipsEl.hidden = true;
    if (form) {
      form.insertBefore(chipsEl, form.firstChild);
    }
    return chipsEl;
  }

  function renderChips() {
    const el = ensureChipsEl();
    el.innerHTML = "";
    if (!pendingFiles.length) {
      el.hidden = true;
      root.classList.remove("has-attachments");
      return;
    }
    el.hidden = false;
    root.classList.add("has-attachments");
    for (const item of pendingFiles) {
      const chip = document.createElement("span");
      chip.className = "yan-chat-attach-chip";
      chip.title = item.file.name;
      const label = document.createElement("span");
      label.className = "yan-chat-attach-chip-name";
      label.textContent = item.file.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "yan-chat-attach-chip-x";
      remove.setAttribute("aria-label", `Remove ${item.file.name}`);
      remove.textContent = "×";
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        pendingFiles = pendingFiles.filter((f) => f.id !== item.id);
        renderChips();
      });
      chip.appendChild(label);
      chip.appendChild(remove);
      el.appendChild(chip);
    }
  }

  /**
   * @param {FileList|File[]} list
   */
  function addFiles(list) {
    const files = Array.from(list || []);
    for (const file of files) {
      if (!file || !(file instanceof File)) continue;
      if (pendingFiles.length >= MAX_FILES) break;
      if (file.size > MAX_FILE_BYTES) {
        appendBubble(
          "assistant",
          `“${file.name}” is too large (max ~12MB per file).`
        );
        setState("panel");
        continue;
      }
      const dup = pendingFiles.some(
        (p) => p.file.name === file.name && p.file.size === file.size
      );
      if (dup) continue;
      pendingFiles.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
      });
    }
    renderChips();
  }

  /**
   * @param {File} file
   * @returns {Promise<{ name: string, mimeType: string, data: string }>}
   */
  function fileToAttachment(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        const data = comma >= 0 ? result.slice(comma + 1) : result;
        resolve({
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          data,
        });
      };
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  function refreshGlass() {
    if (typeof window.reinitLiquidGlass === "function") {
      window.reinitLiquidGlass();
    }
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function widgetList(msg) {
    return Array.isArray(msg?.widgets) ? msg.widgets.filter(Boolean) : [];
  }

  /** @type {WeakMap<HTMLIFrameElement, object>} */
  const htmlIframeWidgets = new WeakMap();

  function resolvedIsDark() {
    return document.documentElement.getAttribute("data-resolved-theme") === "dark";
  }

  /**
   * @param {object} widget
   */
  function htmlForWidget(widget) {
    const darkHtml = String(widget?.htmlDark || "").trim();
    const lightHtml = String(widget?.htmlLight || widget?.html || "").trim();
    if (resolvedIsDark()) return darkHtml || lightHtml;
    return lightHtml || darkHtml;
  }

  /**
   * @param {string} inner
   */
  function htmlSrcdoc(inner) {
    const fg =
      getComputedStyle(document.documentElement).getPropertyValue("--fg").trim() ||
      (resolvedIsDark() ? "#E9EEF2" : "#14181D");
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;padding:0;background:transparent;color:${escapeHtml(
      fg
    )};font:15px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;overflow:hidden;border-radius:14px}body>*{border-radius:14px!important;overflow:hidden}img{max-width:100%;height:auto}a{color:inherit}</style></head><body>${
      inner
    }<script>function report(){try{parent.postMessage({type:'yl-widget-h',h:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)},'*')}catch(e){}}new ResizeObserver(report).observe(document.body);window.addEventListener('load',report);report();<\/script></body></html>`;
  }

  /**
   * @param {HTMLIFrameElement} iframe
   * @param {object} widget
   */
  function fillHtmlIframe(iframe, widget) {
    htmlIframeWidgets.set(iframe, widget);
    const inner = htmlForWidget(widget);
    const sig = `${resolvedIsDark() ? "d" : "l"}:${inner.length}:${inner.slice(0, 48)}:${inner.slice(-48)}`;
    if (iframe.dataset.htmlSig === sig) return;
    iframe.dataset.htmlSig = sig;
    iframe.srcdoc = htmlSrcdoc(inner);
  }

  function refreshHtmlWidgets() {
    if (!messagesEl) return;
    messagesEl.querySelectorAll("iframe.yan-chat-widget-html").forEach((iframe) => {
      const widget = htmlIframeWidgets.get(iframe);
      if (widget) fillHtmlIframe(iframe, widget);
    });
  }

  let htmlThemeWatch = false;
  function watchHtmlTheme() {
    if (htmlThemeWatch) return;
    htmlThemeWatch = true;
    new MutationObserver(() => refreshHtmlWidgets()).observe(
      document.documentElement,
      { attributes: true, attributeFilter: ["data-resolved-theme"] }
    );
  }

  window.addEventListener("message", (ev) => {
    const data = ev.data;
    if (!data || data.type !== "yl-widget-h" || !messagesEl) return;
    const iframes = messagesEl.querySelectorAll("iframe.yan-chat-widget-html");
    for (const iframe of iframes) {
      if (iframe.contentWindow === ev.source) {
        const h = Math.min(360, Math.max(80, Number(data.h) || 160));
        iframe.style.height = `${h}px`;
        break;
      }
    }
  });

  /**
   * @param {unknown} latRaw
   * @param {unknown} lngRaw
   * @returns {{ lat: number, lng: number } | null}
   */
  function parseLatLng(latRaw, lngRaw) {
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  }

  /**
   * @param {object} widget
   * @param {object[]} widgets
   * @returns {{ lat: number, lng: number, title: string } | null}
   */
  function pinForPlace(widget, widgets) {
    const title = String(widget?.title || widget?.pinId || "Place");
    const own = parseLatLng(widget?.lat, widget?.lng);
    if (own) return { ...own, title };
    /** @type {{ id?: string, lat?: number, lng?: number, title?: string }[]} */
    const pins = [];
    for (const w of widgets || []) {
      if (String(w?.type || "").toLowerCase() !== "map") continue;
      if (Array.isArray(w.pins)) pins.push(...w.pins);
    }
    const key = String(widget?.pinId || widget?.id || "");
    const match =
      (key && pins.find((p) => String(p.id) === key)) ||
      pins.find((p) => String(p.title || "") === title);
    if (!match) return null;
    const coord = parseLatLng(match.lat, match.lng);
    if (!coord) return null;
    return { ...coord, title: String(match.title || title) };
  }

  /**
   * @param {{ lat: number, lng: number, title: string }} pin
   */
  function appleMapsWebUrl(pin) {
    const q = encodeURIComponent(pin.title || "Place");
    return `https://maps.apple.com/?q=${q}&sll=${pin.lat},${pin.lng}&z=16`;
  }

  /**
   * @param {object} widget
   * @param {string} filterId
   * @param {object[]} widgets
   */
  function renderWidgetCard(widget, filterId, widgets) {
    const type = String(widget.type || "").toLowerCase();
    const pin = type === "place" || type === "map" ? pinForPlace(widget, widgets) : null;
    const mapsUrl = pin ? appleMapsWebUrl(pin) : "";
    const card = document.createElement(mapsUrl ? "a" : "div");
    card.className = "yan-chat-widget";
    card.dataset.liquidGlass = "rounded";
    card.dataset.filterId = filterId;
    if (widget.id) card.dataset.widgetId = String(widget.id);
    if (widget.pinId) card.dataset.pinId = String(widget.pinId);
    if (mapsUrl) {
      card.href = mapsUrl;
      card.target = "_blank";
      card.rel = "noopener noreferrer";
      card.title = "Open in Apple Maps";
      card.setAttribute("aria-label", `Open ${pin.title} in Apple Maps`);
    }
    const clip = document.createElement("div");
    clip.className = "yan-chat-widget-clip";
    if (type === "image") {
      const url = String(widget.url || "");
      if (/^https:\/\//i.test(url)) {
        const img = document.createElement("img");
        img.className = "yan-chat-widget-img";
        img.src = url;
        img.alt = String(widget.alt || "Image");
        img.loading = "lazy";
        clip.appendChild(img);
      } else {
        clip.textContent = String(widget.alt || "Image unavailable");
      }
      card.appendChild(clip);
    } else if (type === "place" || type === "map") {
      const box = document.createElement("div");
      box.className = "yan-chat-place";
      const title = document.createElement("p");
      title.className = "yan-chat-place-title";
      title.textContent = String(widget.title || widget.pinId || "Place");
      box.appendChild(title);
      const sub = String(widget.subtitle || "").trim();
      if (sub) {
        const p = document.createElement("p");
        p.className = "yan-chat-place-sub";
        p.textContent = sub;
        box.appendChild(p);
      }
      const body = String(widget.body || "").trim();
      if (body && body !== sub) {
        const p = document.createElement("p");
        p.className = "yan-chat-place-body";
        p.textContent = body;
        box.appendChild(p);
      }
      card.appendChild(box);
    } else {
      const iframe = document.createElement("iframe");
      iframe.className = "yan-chat-widget-html";
      iframe.setAttribute(
        "sandbox",
        "allow-scripts allow-popups allow-popups-to-escape-sandbox"
      );
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.title = "Widget";
      clip.appendChild(iframe);
      card.appendChild(clip);
      fillHtmlIframe(iframe, widget);
      watchHtmlTheme();
    }
    return card;
  }

  function renderIosMapHint(filterId) {
    const el = document.createElement("div");
    el.className = "yan-chat-map-ios";
    el.dataset.liquidGlass = "rounded";
    el.dataset.filterId = filterId || "lg-edu-map-ios";
    el.setAttribute("role", "note");
    el.innerHTML =
      '<svg class="yan-chat-map-ios-pin" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path fill="currentColor" d="M12 2.4c-3.5 0-6.4 2.7-6.4 6.1 0 4.6 6.4 12.7 6.4 12.7s6.4-8.1 6.4-12.7c0-3.4-2.9-6.1-6.4-6.1zm0 8.4a2.3 2.3 0 1 1 0-4.6 2.3 2.3 0 0 1 0 4.6z"/>' +
      "</svg>" +
      "<span>View map on iOS</span>";
    return el;
  }

  function renderWidgetsRow(msg, msgIndex) {
    const widgets = widgetList(msg);
    if (!widgets.length) return null;
    const hasMap = widgets.some(
      (w) => String(w.type || "").toLowerCase() === "map"
    );
    const cards = widgets.filter(
      (w) => String(w.type || "").toLowerCase() !== "map"
    );
    const wrap = document.createElement("div");
    wrap.className = "yan-chat-widget-stack";
    if (hasMap) {
      const hint = document.createElement("div");
      hint.className = "yan-chat-map-ios-wrap";
      hint.appendChild(renderIosMapHint(`lg-edu-map-ios-${msgIndex}`));
      wrap.appendChild(hint);
    }
    if (cards.length) {
      const row = document.createElement("div");
      row.className = "yan-chat-widgets";
      cards.forEach((w, i) => {
        row.appendChild(
          renderWidgetCard(w, `lg-edu-widget-${msgIndex}-${i}`, widgets)
        );
      });
      wrap.appendChild(row);
    }
    return wrap.childElementCount ? wrap : null;
  }

  function state() {
    return root.dataset.state || "closed";
  }

  function localDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function relativeChatAge(iso, now = new Date()) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const ms = now.getTime() - d.getTime();
    if (ms < 60 * 1000) return "now";
    const mins = Math.floor(ms / (60 * 1000));
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${hours}h`;
    return "";
  }

  function chatHistoryGroup(iso, now = new Date()) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return { key: "older", label: "Older", showAge: false };
    }
    const that = localDateKey(d);
    const today = localDateKey(now);
    if (that === today) return { key: "today", label: "Today", showAge: true };
    const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (that === localDateKey(yest)) {
      return { key: "yesterday", label: "Yesterday", showAge: false };
    }
    const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.round((startToday - startThat) / 86400000);
    if (diffDays > 1 && diffDays < 7) {
      return {
        key: that,
        label: d.toLocaleDateString(undefined, { weekday: "long" }),
        showAge: false,
      };
    }
    return { key: "older", label: "Older", showAge: false };
  }

  /**
   * @param {{ sessionId: string, title?: string, preview?: string, updated: string }[]} chats
   */
  function groupChatHistory(chats) {
    const now = new Date();
    /** @type {Map<string, { key: string, label: string, showAge: boolean, chats: typeof chats }>} */
    const byKey = new Map();
    /** @type {{ key: string, label: string, showAge: boolean, chats: typeof chats }[]} */
    const sections = [];
    for (const chat of chats || []) {
      const g = chatHistoryGroup(chat.updated, now);
      let sec = byKey.get(g.key);
      if (!sec) {
        sec = { key: g.key, label: g.label, showAge: g.showAge, chats: [] };
        byKey.set(g.key, sec);
        sections.push(sec);
      }
      sec.chats.push(chat);
    }
    return sections;
  }

  function chatDisplayTitle(chat) {
    const title = String(chat?.title || "").trim();
    if (title) return title;
    const preview = String(chat?.preview || "").trim();
    return preview || "Chat";
  }

  function syncHistoryFrost() {
    root.classList.toggle("is-history", showingHistory);
  }

  function hideHistory(opts = {}) {
    const wasShowing = showingHistory;
    showingHistory = false;
    syncHistoryFrost();
    historyStructureKey = "";
    historyPointerSid = null;
    if (messagesEl) messagesEl.hidden = false;
    if (historyEl) {
      historyEl.hidden = true;
      historyEl.setAttribute("aria-hidden", "true");
      historyEl.innerHTML = "";
    }
    if (opts.markVisibleRead && wasShowing && sessionId && !sending) {
      markChatRead(sessionId);
    }
  }

  async function showHistory() {
    showingHistory = true;
    syncHistoryFrost();
    setState("panel", { skipFocus: true });
    if (messagesEl) messagesEl.hidden = true;
    if (historyEl) {
      historyEl.hidden = false;
      historyEl.setAttribute("aria-hidden", "false");
      historyEl.innerHTML = "";
      const loading = document.createElement("p");
      loading.className = "yan-chat-history-empty";
      loading.textContent = "Loading…";
      historyEl.appendChild(loading);
    }
    await renderHistory();
  }

  function toggleHistory() {
    if (showingHistory) hideHistory({ markVisibleRead: true });
    else showHistory();
  }

  /**
   * Row identity for the history list. Omit `updated` so a running agent
   * (which rewrites the transcript every bubble) does not rebuild the DOM
   * under the pointer.
   * @param {{ sessionId?: string, title?: string, preview?: string }[]} chats
   */
  function historyRowsKey(chats) {
    return (chats || [])
      .map((c) => `${c.sessionId || ""}\0${chatDisplayTitle(c)}`)
      .join("\n");
  }

  /**
   * @param {HTMLElement} row
   * @param {{ working?: boolean, unread?: boolean }} chat
   */
  function applyHistoryDot(row, chat) {
    const working = Boolean(chat?.working);
    const unread = Boolean(chat?.unread) && !working;
    let dot = row.querySelector(".yan-chat-history-dot");
    if (!working && !unread) {
      dot?.remove();
      const title = String(row.querySelector(".yan-chat-history-title")?.textContent || "Chat");
      row.setAttribute("aria-label", title);
      return;
    }
    if (!dot) {
      dot = document.createElement("span");
      dot.className = "yan-chat-history-dot";
      dot.setAttribute("aria-hidden", "true");
      row.insertBefore(dot, row.firstChild);
    }
    dot.classList.toggle("is-working", working);
    dot.classList.toggle("is-unread", unread);
    const title = String(row.querySelector(".yan-chat-history-title")?.textContent || "Chat");
    row.setAttribute("aria-label", working ? `${title}, working` : `${title}, unread`);
  }

  /**
   * @param {{ sessionId?: string, updated?: string, working?: boolean, unread?: boolean }[]} chats
   */
  function patchHistoryRows(chats) {
    if (!historyEl) return;
    const now = new Date();
    for (const chat of chats || []) {
      const sid = String(chat?.sessionId || "");
      if (!sid) continue;
      const row = historyEl.querySelector(
        `.yan-chat-history-row[data-session-id="${CSS.escape(sid)}"]`
      );
      if (!row) continue;
      const age = row.querySelector(".yan-chat-history-age");
      if (age) age.textContent = relativeChatAge(chat.updated, now);
      applyHistoryDot(row, chat);
    }
  }

  async function renderHistory() {
    if (!historyEl || !window.YanMacApi) return;
    const fetchGen = ++historyFetchGen;
    try {
      const res = await window.YanMacApi.macFetch("/api/education/agent/chats", {
        method: "GET",
        timeoutMs: 30_000,
      });
      const data = await res.json().catch(() => ({}));
      if (fetchGen !== historyFetchGen || !showingHistory) return;
      const chats = Array.isArray(data.chats) ? data.chats : [];
      const nextKey = historyRowsKey(chats);
      if (nextKey === historyStructureKey && historyEl.childElementCount) {
        patchHistoryRows(chats);
        return;
      }
      historyStructureKey = nextKey;
      historyEl.innerHTML = "";
      if (!chats.length) {
        const empty = document.createElement("p");
        empty.className = "yan-chat-history-empty";
        empty.textContent = "No past chats yet.";
        historyEl.appendChild(empty);
        return;
      }
      const sections = groupChatHistory(chats);
      for (const section of sections) {
        const wrap = document.createElement("section");
        wrap.className = "yan-chat-history-section";
        const label = document.createElement("h2");
        label.className = "yan-chat-history-label";
        label.textContent = section.label;
        wrap.appendChild(label);
        for (const chat of section.chats) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "yan-chat-history-row";
          btn.dataset.sessionId = String(chat.sessionId || "");
          const title = document.createElement("span");
          title.className = "yan-chat-history-title";
          title.textContent = chatDisplayTitle(chat);
          btn.appendChild(title);
          if (section.showAge) {
            const age = document.createElement("span");
            age.className = "yan-chat-history-age";
            age.textContent = relativeChatAge(chat.updated);
            btn.appendChild(age);
          }
          applyHistoryDot(btn, chat);
          wrap.appendChild(btn);
        }
        historyEl.appendChild(wrap);
      }
    } catch {
      if (fetchGen !== historyFetchGen || !showingHistory || !historyEl) return;
      historyStructureKey = "";
      historyEl.innerHTML = "";
      const empty = document.createElement("p");
      empty.className = "yan-chat-history-empty";
      empty.textContent = "Could not load past chats.";
      historyEl.appendChild(empty);
    }
  }

  async function markChatRead(sid) {
    const id = String(sid || "").trim();
    if (!id || !window.YanMacApi) return;
    try {
      await window.YanMacApi.macFetch("/api/education/agent/read", {
        method: "POST",
        json: { sessionId: id },
        timeoutMs: 15_000,
      });
    } catch {
      /* ignore */
    }
  }

  async function openHistoryChat(sid) {
    const id = String(sid || "").trim();
    if (!id) return;
    hideHistory();
    markChatRead(id);
    if (id === sessionId) {
      setState("panel");
      return;
    }
    if (!window.YanMacApi) return;
    const gen = ++viewGen;
    stopPolling();
    try {
      const res = await window.YanMacApi.macFetch("/api/education/agent/resume", {
        method: "POST",
        json: { sessionId: id },
        timeoutMs: 120_000,
      });
      const data = await res.json().catch(() => ({}));
      if (gen !== viewGen) return;
      if (!res.ok || !data.sessionId) {
        throw new Error(data.error || `resume failed (${res.status})`);
      }
      sessionId = data.sessionId;
      if (Array.isArray(data.messages)) applyServerMessages(data.messages);
      preferPanel = true;
      persistLocal();
      setState("panel");
      if (data.status === "running") {
        setBusy(true);
        setBusyLabel(data.workingLabel || "Working…");
        startPolling();
      } else {
        setBusy(false);
      }
    } catch (err) {
      if (gen !== viewGen) return;
      console.error("[edu-chat] resume", err);
      appendBubble(
        "assistant",
        "Could not open that chat. Is the Mac API running?"
      );
      setState("panel");
    }
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

  function setState(next, opts = {}) {
    root.dataset.state = next;
    const open = next !== "closed";
    root.classList.toggle("is-open", open);
    root.classList.toggle("has-panel", next === "panel");
    if (next === "panel") preferPanel = true;
    if (panel) {
      panel.hidden = next !== "panel";
      panel.setAttribute("aria-hidden", next === "panel" ? "false" : "true");
    }
    if (pill) {
      pill._lgMagClamp = open;
      if (!open) releaseChatMagnetic(pill);
    }
    if (next !== "panel") {
      releaseChatMagnetic(panel);
      clearBtns.forEach(releaseChatMagnetic);
    }
    if (!open) minimizeBtns.forEach(releaseChatMagnetic);
    if (launcher) {
      launcher.setAttribute("aria-expanded", open ? "true" : "false");
      launcher.tabIndex = open ? -1 : 0;
    }
    if (input) {
      input.tabIndex = open ? 0 : -1;
      if (open && !opts.skipFocus) {
        window.setTimeout(
          () => input.focus({ preventScroll: true }),
          reduceMotion ? 0 : 420
        );
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

  function queuedCount() {
    return messages.filter((m) => m && m.queued).length;
  }

  function queueFull() {
    return queuedCount() >= MAX_QUEUED;
  }

  function updateComposerEnabled() {
    const full = queueFull();
    if (input) input.disabled = false;
    const submit = form?.querySelector('button[type="submit"]');
    if (submit) {
      // Keep enabled while busy so hold-to-interrupt still works at queue cap.
      submit.disabled = full && !sending;
      submit.title = full && !sending
        ? `Queue full (max ${MAX_QUEUED}). Wait for a reply.`
        : sending
          ? "Hold 2 seconds to interrupt instead of queueing"
          : "";
    }
  }

  function clearMessagesDom() {
    if (!messagesEl) return;
    messagesEl.innerHTML = "";
    workingEl = null;
  }

  function messageReuseKey(msg) {
    return JSON.stringify({
      role: msg.role,
      content: String(msg.content || ""),
      widgets: msg.widgets || null,
    });
  }

  function messagesFingerprint(list) {
    return JSON.stringify(
      (list || []).map((m) => ({
        role: m.role,
        content: String(m.content || ""),
        queued: Boolean(m.queued),
        widgets: m.widgets || null,
      }))
    );
  }

  function setBusyLabel(next) {
    const label = String(next || "").trim() || "Working…";
    if (busyLabel === label) return;
    busyLabel = label;
    if (workingEl) {
      const inner = workingEl.querySelector(":scope > .yan-chat-bubble-in");
      if (inner) inner.textContent = busyLabel;
    }
  }

  function syncWorkingEl() {
    if (!messagesEl) return;
    if (!sending) {
      if (workingEl) {
        workingEl.remove();
        workingEl = null;
      }
      return;
    }
    let created = false;
    if (!workingEl) {
      workingEl = document.createElement("div");
      workingEl.className =
        "yan-chat-bubble yan-chat-bubble--assistant yan-chat-working";
      workingEl.dataset.liquidGlass = "rounded";
      workingEl.dataset.filterId = "lg-edu-chat-working";
      const inner = document.createElement("span");
      inner.className = "yan-chat-bubble-in";
      inner.textContent = busyLabel;
      workingEl.appendChild(inner);
      created = true;
    }
    const firstQueued = [...messagesEl.querySelectorAll(":scope > .yan-chat-turn")].find(
      (el) => el.classList.contains("yan-chat-turn--queued")
    );
    if (firstQueued) {
      if (workingEl.nextSibling !== firstQueued) {
        messagesEl.insertBefore(workingEl, firstQueued);
      }
    } else if (messagesEl.lastElementChild !== workingEl) {
      messagesEl.appendChild(workingEl);
    }
    if (created) refreshGlass();
  }

  function buildTurn(msg, msgIndex) {
    const turn = document.createElement("div");
    turn.className = `yan-chat-turn yan-chat-turn--${msg.role}`;
    turn.dataset.reuseKey = messageReuseKey(msg);
    if (msg.queued) turn.classList.add("yan-chat-turn--queued");
    const text = String(msg.content || "");
    if (text.trim()) {
      const el = document.createElement("div");
      el.className = `yan-chat-bubble yan-chat-bubble--${msg.role}`;
      el.dataset.liquidGlass = "rounded";
      el.dataset.filterId = `lg-edu-chat-b-${++bubbleSeq}`;
      if (msg.role === "assistant") {
        el.classList.add("md-body");
        const api = window.YLMarkdown;
        el.innerHTML =
          api && typeof api.render === "function" ? api.render(text) : text;
      } else {
        const inner = document.createElement("span");
        inner.className = "yan-chat-bubble-in";
        inner.textContent = text;
        el.appendChild(inner);
      }
      turn.appendChild(el);
    }
    if (msg.role === "assistant") {
      const row = renderWidgetsRow(msg, msgIndex);
      if (row) turn.appendChild(row);
    }
    return turn;
  }

  /**
   * @param {{ forceScroll?: boolean }} [opts]
   */
  function renderMessagesDom(opts = {}) {
    if (!messagesEl) return;
    const forceScroll = Boolean(opts.forceScroll);
    const nearBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
    const prevScroll = messagesEl.scrollTop;
    /** @type {Map<string, number>} */
    const widgetScrolls = new Map();
    for (const row of messagesEl.querySelectorAll(".yan-chat-widgets")) {
      const turn = row.closest(".yan-chat-turn");
      const key = turn?.dataset.reuseKey || "";
      if (key) widgetScrolls.set(key, row.scrollLeft);
    }

    if (workingEl) workingEl.remove();

    const existing = [...messagesEl.querySelectorAll(":scope > .yan-chat-turn")];
    /** @type {Map<string, HTMLElement>} */
    const pool = new Map();
    for (const el of existing) {
      const key = el.dataset.reuseKey || "";
      if (key && !pool.has(key)) pool.set(key, el);
      else {
        el.remove();
      }
    }

    /** @type {HTMLElement[]} */
    const nextTurns = [];
    let addedGlass = false;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const key = messageReuseKey(msg);
      let turn = pool.get(key);
      if (turn) {
        pool.delete(key);
        turn.classList.toggle("yan-chat-turn--queued", Boolean(msg.queued));
      } else {
        turn = buildTurn(msg, i);
        if (turn.querySelector("[data-liquid-glass]")) addedGlass = true;
      }
      nextTurns.push(turn);
    }
    for (const leftover of pool.values()) {
      leftover.remove();
    }

    let anchor = null;
    for (const turn of nextTurns) {
      if (anchor) {
        if (anchor.nextSibling !== turn) {
          messagesEl.insertBefore(turn, anchor.nextSibling);
        }
      } else if (messagesEl.firstElementChild !== turn) {
        messagesEl.insertBefore(turn, messagesEl.firstChild);
      }
      anchor = turn;
    }

    syncWorkingEl();

    for (const row of messagesEl.querySelectorAll(".yan-chat-widgets")) {
      const turn = row.closest(".yan-chat-turn");
      const left = widgetScrolls.get(turn?.dataset.reuseKey || "");
      if (Number.isFinite(left)) row.scrollLeft = left;
    }

    if (forceScroll || nearBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      messagesEl.scrollTop = prevScroll;
    }
    updateComposerEnabled();
    if (addedGlass) refreshGlass();
  }

  /**
   * @param {string} role
   * @param {string} text
   * @param {{ queued?: boolean }} [opts]
   */
  function appendBubble(role, text, opts = {}) {
    /** @type {{ role: string, content: string, queued?: boolean }} */
    const msg = { role, content: text };
    if (opts.queued) msg.queued = true;
    messages.push(msg);
    renderMessagesDom({ forceScroll: true });
    persistLocal();
  }

  function lastUserBubble() {
    if (!messagesEl) return null;
    const turns = messagesEl.querySelectorAll(":scope > .yan-chat-turn--user");
    const turn = turns[turns.length - 1];
    if (turn) return turn.querySelector(".yan-chat-bubble--user");
    const bubbles = messagesEl.querySelectorAll(":scope > .yan-chat-bubble--user");
    return bubbles[bubbles.length - 1] || null;
  }

  function flyUserBubble(originRect) {
    if (typeof window.yanChatSendFlight !== "function") return;
    window.yanChatSendFlight({
      destEl: lastUserBubble(),
      originRect,
      root,
      reduceMotion,
    });
  }

  function setBusy(busy) {
    const next = Boolean(busy);
    if (!next) setBusyLabel("Working…");
    const wasSending = sending;
    if (sending === next) {
      if (next) startPolling();
      return;
    }
    sending = next;
    root.classList.toggle("is-busy", busy);
    const nearBottom =
      !messagesEl ||
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
    syncWorkingEl();
    if (sending && nearBottom && messagesEl) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    if (sending) startPolling();
    else stopPolling();
    if (wasSending && !next && !showingHistory && sessionId) {
      markChatRead(sessionId);
    }
  }

  function stopPolling() {
    if (pollTimer != null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling() {
    if (pollTimer != null) return;
    pollTimer = setInterval(() => {
      pollState().catch(() => {});
    }, POLL_MS);
  }

  /**
   * @param {{ role?: string, content?: string, queued?: boolean }[]} list
   */
  function applyServerMessages(list) {
    if (!Array.isArray(list)) return;
    const next = list
      .filter((m) => m && (m.role === "user" || m.role === "assistant"))
      .map((m) => {
        /** @type {{ role: string, content: string, queued?: boolean, widgets?: object[] }} */
        const out = {
          role: String(m.role),
          content: String(m.content || ""),
        };
        if (m.queued) out.queued = true;
        if (Array.isArray(m.widgets) && m.widgets.length) out.widgets = m.widgets;
        return out;
      });
    if (messagesFingerprint(next) === messagesFingerprint(messages)) return;
    messages = next;
    renderMessagesDom();
    persistLocal();
  }

  async function pollState() {
    if (!sessionId || !window.YanMacApi) return;
    const requested = sessionId;
    const gen = viewGen;
    const res = await window.YanMacApi.macFetch(
      `/api/education/agent/state?sessionId=${encodeURIComponent(requested)}`,
      { method: "GET", timeoutMs: 15_000 }
    );
    if (sessionId !== requested || gen !== viewGen) return;
    const data = await res.json().catch(() => ({}));
    if (sessionId !== requested || gen !== viewGen) return;
    if (data.sessionId && data.sessionId !== sessionId) return;
    if (res.status === 404) {
      // Cleared on another device (or TTL) — wipe local transcript too.
      sessionId = null;
      messages = [];
      preferPanel = false;
      setBusy(false);
      clearMessagesDom();
      clearLocal();
      hideHistory();
      return;
    }
    if (!res.ok) return;
    if (Array.isArray(data.messages)) {
      applyServerMessages(data.messages);
    }
    const status = String(data.status || "idle");
    if (status === "running") {
      setBusy(true);
      setBusyLabel(data.workingLabel || "Working…");
    } else {
      setBusy(false);
      setBusyLabel("Working…");
      if (messages.length) preferPanel = true;
      window.__eduRefresh?.();
    }
  }

  async function ensureSession() {
    if (sessionId) return sessionId;
    if (starting) {
      while (starting) await new Promise((r) => setTimeout(r, 80));
      return sessionId;
    }
    starting = true;
    try {
      const res = await window.YanMacApi.macFetch("/api/education/agent/start", {
        method: "POST",
        json: {},
        timeoutMs: 120_000,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.sessionId) {
        throw new Error(data.error || `start failed (${res.status})`);
      }
      sessionId = data.sessionId;
      persistLocal();
      return sessionId;
    } finally {
      starting = false;
    }
  }

  /**
   * @param {string} [raw]
   * @param {{ interrupt?: boolean }} [opts]
   */
  async function sendMessage(raw, opts = {}) {
    const interrupt = Boolean(opts.interrupt);
    const text = String(raw || "").trim();
    const files = pendingFiles.slice();
    if (!text && !files.length) return;
    if (!interrupt && queueFull()) return;

    const originRect = pill ? pill.getBoundingClientRect() : null;
    if (state() !== "panel") {
      root.classList.add("is-send-flight");
      setState("panel");
    }

    const label =
      text +
      (files.length
        ? `${text ? "\n" : ""}[${files.length} file${files.length === 1 ? "" : "s"}: ${files
            .map((f) => f.file.name)
            .join(", ")}]`
        : "");
    const willQueue = sending && !interrupt;
    appendBubble("user", label || "(attachment)", { queued: willQueue });
    if (input) input.value = "";
    syncComposerSize();
    pendingFiles = [];
    renderChips();
    flyUserBubble(originRect);
    if (!sending) setBusy(true);
    else {
      updateComposerEnabled();
      startPolling();
    }
    preferPanel = true;
    const sendGen = viewGen;

    try {
      const sid = await ensureSession();
      /** @type {{ name: string, mimeType: string, data: string }[]} */
      const attachments = [];
      for (const item of files) {
        attachments.push(await fileToAttachment(item.file));
      }
      /** @type {Record<string, unknown>} */
      const body = { sessionId: sid, message: text };
      if (attachments.length) body.attachments = attachments;
      if (interrupt) body.interrupt = true;
      try {
        const ui =
          typeof window.__eduUiContext === "function"
            ? window.__eduUiContext()
            : null;
        if (ui && typeof ui === "object") body.uiContext = ui;
      } catch {
        /* ignore */
      }

      const res = await window.YanMacApi.macFetch(
        "/api/education/agent/message",
        {
          method: "POST",
          json: body,
          // Staging attachments can take a bit; agent run itself is async.
          timeoutMs: 120_000,
        }
      );
      const data = await res.json().catch(() => ({}));
      if (sendGen !== viewGen || (sid && sessionId && sid !== sessionId)) return;
      if (!res.ok) {
        // Drop the optimistic bubble on failure.
        if (
          messages.length &&
          messages[messages.length - 1]?.role === "user" &&
          messages[messages.length - 1]?.content === (label || "(attachment)")
        ) {
          messages.pop();
        }
        if (!willQueue) setBusy(false);
        else renderMessagesDom();
        if (res.status === 503) {
          appendBubble(
            "assistant",
            data.error ||
              "Personal agent unavailable (CURSOR_API_KEY / SDK). You can still edit via Cursor Desktop with the personal-agent skill."
          );
        } else if (res.status === 429) {
          appendBubble(
            "assistant",
            data.error ||
              `Queue full (max ${MAX_QUEUED}). Wait for a reply before sending more.`
          );
        } else {
          appendBubble("assistant", data.error || "Something went wrong.");
        }
        setState("panel");
        return;
      }
      if (Array.isArray(data.messages)) {
        applyServerMessages(data.messages);
      }
      setBusy(true);
      setState("panel");
      // Keep busy + poll until assistant reply lands (and queue drains).
      startPolling();
      await pollState();
    } catch (err) {
      if (sendGen !== viewGen) return;
      console.error("[edu-chat]", err);
      if (
        messages.length &&
        messages[messages.length - 1]?.role === "user" &&
        messages[messages.length - 1]?.content === (label || "(attachment)")
      ) {
        messages.pop();
      }
      if (!willQueue) setBusy(false);
      else renderMessagesDom();
      appendBubble(
        "assistant",
        "Could not reach the personal agent. Is the Mac API running?"
      );
      setState("panel");
    } finally {
      if (input && state() !== "closed") {
        input.focus({ preventScroll: true });
      }
    }
  }

  function openChat() {
    if (state() !== "closed") return;
    if (messages.length || preferPanel) {
      setState("panel");
    } else {
      setState("open");
    }
    if (sending || (sessionId && messages.length)) {
      pollState().catch(() => {});
    }
  }

  /** Soft hide — keep session + transcript; discard draft. */
  function minimizeChat() {
    if (input) input.value = "";
    syncComposerSize();
    pendingFiles = [];
    renderChips();
    preferPanel = messages.length > 0 || preferPanel;
    persistLocal();
    hideHistory();
    setState("closed");
  }

  /** New chat — leave the previous thread running in the background. */
  async function clearChat() {
    viewGen += 1;
    stopPolling();
    const hadThread = messages.length > 0 || sending;
    sessionId = null;
    messages = [];
    preferPanel = false;
    sending = false;
    root.classList.remove("is-busy");
    if (input) {
      input.value = "";
      input.disabled = false;
      syncComposerSize();
    }
    const submit = form?.querySelector('button[type="submit"]');
    if (submit) {
      submit.disabled = false;
      submit.title = "";
    }
    pendingFiles = [];
    renderChips();
    clearMessagesDom();
    clearLocal();
    hideHistory();
    setState("closed");
    if (hadThread && window.YanMacApi) {
      try {
        const res = await window.YanMacApi.macFetch("/api/education/agent/start", {
          method: "POST",
          json: {},
          timeoutMs: 120_000,
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.sessionId) {
          sessionId = data.sessionId;
          persistLocal();
        }
      } catch {
        /* ignore */
      }
    }
  }

  launcher?.addEventListener(
    "click",
    (event) => {
      if (!event.shiftKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showHistory();
    },
    true
  );

  launcher?.addEventListener("click", (event) => {
    event.preventDefault();
    openChat();
  });

  clearBtns.forEach((btn) => {
    btn.addEventListener("click", (event) => {
      if (event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      clearChat();
    });

    btn.addEventListener(
      "click",
      (event) => {
        if (!event.shiftKey) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleHistory();
      },
      true
    );
  });

  minimizeBtns.forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      minimizeChat();
    });
  });

  const HOLD_MS = 2000;
  let sendHoldTimer = null;
  let sendHoldArmed = false;
  let sendHoldConsumed = false;

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.shiftKey) return;
    if (sendHoldConsumed) {
      sendHoldConsumed = false;
      return;
    }
    sendMessage(input?.value);
  });

  const sendBtn = form?.querySelector(".yan-chat-send");

  function clearSendHold() {
    if (sendHoldTimer) {
      window.clearTimeout(sendHoldTimer);
      sendHoldTimer = null;
    }
    sendHoldArmed = false;
    sendBtn?.classList.remove("is-interrupt-armed");
  }

  sendBtn?.addEventListener("pointerdown", (event) => {
    if (event.button && event.button !== 0) return;
    if (event.shiftKey) return;
    sendHoldConsumed = false;
    clearSendHold();
    sendHoldTimer = window.setTimeout(() => {
      sendHoldTimer = null;
      if (!sending) return;
      sendHoldArmed = true;
      sendBtn.classList.add("is-interrupt-armed");
    }, HOLD_MS);
  });

  sendBtn?.addEventListener("pointerup", (event) => {
    const armed = sendHoldArmed && sending;
    clearSendHold();
    if (!armed) return;
    event.preventDefault();
    event.stopPropagation();
    sendHoldConsumed = true;
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate([40, 35, 90]);
    }
    sendMessage(input?.value, { interrupt: true });
  });

  sendBtn?.addEventListener("pointercancel", () => {
    sendHoldConsumed = false;
    clearSendHold();
  });

  sendBtn?.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  sendBtn?.addEventListener(
    "click",
    (event) => {
      if (!event.shiftKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleHistory();
    },
    true
  );

  historyEl?.addEventListener("pointerdown", (event) => {
    if (event.button && event.button !== 0) return;
    const row = event.target.closest?.(".yan-chat-history-row");
    historyPointerSid = row?.dataset.sessionId || null;
  });
  historyEl?.addEventListener("pointercancel", () => {
    historyPointerSid = null;
  });
  historyEl?.addEventListener("click", (event) => {
    const row = event.target.closest?.(".yan-chat-history-row");
    const sid = historyPointerSid || row?.dataset.sessionId || "";
    historyPointerSid = null;
    if (sid) openHistoryChat(sid);
  });

  input?.addEventListener("focus", () => {
    if (showingHistory) hideHistory({ markVisibleRead: true });
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

  // Drag-and-drop attachments onto the chat input / form.
  const dropTargets = [form, input, pill].filter(Boolean);
  let dragDepth = 0;

  function onDragEnter(event) {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    dragDepth += 1;
    root.classList.add("is-dragover");
    if (state() === "closed") openChat();
  }

  function onDragOver(event) {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(event) {
    if (![...event.dataTransfer.types].includes("Files")) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) root.classList.remove("is-dragover");
  }

  function onDrop(event) {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    root.classList.remove("is-dragover");
    if (state() === "closed") openChat();
    addFiles(event.dataTransfer.files);
    input?.focus({ preventScroll: true });
  }

  dropTargets.forEach((el) => {
    el.addEventListener("dragenter", onDragEnter);
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);
  });

  // Paste images into the input.
  input?.addEventListener("paste", (event) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    /** @type {File[]} */
    const files = [];
    for (const item of items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || state() === "closed") return;
    if (showingHistory) {
      hideHistory({ markVisibleRead: true });
      return;
    }
    minimizeChat();
  });

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

  async function resumeFromServer() {
    if (!window.YanMacApi) return;
    const gen = viewGen;
    try {
      const res = await window.YanMacApi.macFetch(
        "/api/education/agent/active",
        { method: "GET", timeoutMs: 15_000 }
      );
      const data = await res.json().catch(() => ({}));
      if (gen !== viewGen) return;
      if (res.ok && data.sessionId) {
        sessionId = data.sessionId;
        if (Array.isArray(data.messages)) applyServerMessages(data.messages);
        preferPanel = messages.length > 0;
        persistLocal();
        if (data.status === "running") {
          setBusy(true);
          setBusyLabel(data.workingLabel || "Working…");
          startPolling();
        } else {
          setBusy(false);
        }
        return;
      }
    } catch {
      /* fall through to local */
    }

    if (gen !== viewGen) return;
    const local = loadLocal();
    if (!local) return;
    if (typeof local.sessionId === "string" && local.sessionId) {
      sessionId = local.sessionId;
    }
    if (Array.isArray(local.messages)) {
      messages = local.messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant"))
        .map((m) => {
          /** @type {{ role: string, content: string, queued?: boolean }} */
          const out = {
            role: String(m.role),
            content: String(m.content || ""),
          };
          if (m.queued) out.queued = true;
          return out;
        });
      preferPanel = Boolean(local.preferPanel) || messages.length > 0;
      renderMessagesDom();
    }
    if (sessionId) {
      try {
        await pollState();
      } catch {
        /* ignore */
      }
    }
  }

  window.__eduChatAttachFiles = (files) => {
    addFiles(files);
    const next = messages.length || preferPanel ? "panel" : "open";
    setState(next);
  };

  ensureChipsEl();
  setState("closed");

  // Instant updates via the same education SSE / 45s poll path as the dashboard.
  window.__eduChatRefresh = () => {
    if (sessionId) pollState().catch(() => {});
    else resumeFromServer().catch(() => {});
    if (showingHistory) renderHistory().catch(() => {});
  };

  // Resume after auth/email is available (app.js boot). Retry briefly.
  let resumeAttempts = 0;
  const resumeKick = () => {
    resumeAttempts += 1;
    resumeFromServer().catch(() => {});
    if (resumeAttempts < 8 && !sessionId && !messages.length) {
      window.setTimeout(resumeKick, 400);
    }
  };
  if (document.readyState === "complete") {
    window.setTimeout(resumeKick, 200);
  } else {
    window.addEventListener("load", () => window.setTimeout(resumeKick, 200));
  }
})();
