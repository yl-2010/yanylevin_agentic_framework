/**
 * /education chatbot — same orb→pill→panel visuals as main site.
 * Agent calls go to Mac via YanMacApi (api.yanylevin.com), never /api/chat.
 * The circle always opens the history panel. A thread opens only when a row
 * is picked or a message is sent. Runs continue on the Mac after the panel
 * closes. New chat does not stop the previous thread.
 * Drag-and-drop files onto the composer or an open thread (paste images too).
 * Attachments work on later turns, not only the first.
 */
(() => {
  const root = document.getElementById("edu-chat");
  if (!root) return;
  const API = String(window.YL_EDU?.apiPrefix || "/api/education").replace(
    /\/+$/,
    ""
  ) || "/api/education";

  const historyCol = root.querySelector(".yan-chat-column--history");
  const threadCol = root.querySelector(".yan-chat-column--thread");
  if (!historyCol || !threadCol) return;

  /**
   * @param {Element} column
   * @param {"history"|"thread"} role
   */
  function bindComposer(column, role) {
    const pill = column.querySelector(".yan-chat-pill");
    const panel = column.querySelector(".yan-chat-panel");
    const form = column.querySelector(".yan-chat-form");
    const input = column.querySelector(".yan-chat-input");
    return {
      role,
      column,
      pill,
      panel,
      form,
      input,
      sendBtn: form?.querySelector(".yan-chat-send") || null,
      /** @type {{ id: string, file: File }[]} */
      pendingFiles: [],
      /** @type {HTMLElement|null} */
      chipsEl: null,
      /** @type {string[]} */
      chipObjectUrls: [],
      lastPillH: 0,
    };
  }

  const historyComposer = bindComposer(historyCol, "history");
  const threadComposer = bindComposer(threadCol, "thread");
  const composers = [historyComposer, threadComposer];
  const messagesEl = threadCol.querySelector(".yan-chat-messages");
  const historyEl = historyCol.querySelector(".yan-chat-history");
  const launcher = historyCol.querySelector(".yan-chat-launcher");
  const closeAllBtns = root.querySelectorAll("[data-edu-chat-close-all]");
  const closeThreadBtns = root.querySelectorAll("[data-edu-chat-close-thread]");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** @type {string|null} */
  let sessionId = null;
  let starting = false;
  let sending = false;
  /** @type {{ role: string, content: string, queued?: boolean, queueId?: string, widgets?: object[] }[]} */
  let messages = [];
  /** @type {{ pointerId: number, index: number, content: string, queueId: string, startX: number, startY: number, armed: boolean, timer: ReturnType<typeof setTimeout>|null }|null} */
  let queueHold = null;
  /** @type {{ index: number, content: string }|null} */
  let pendingQueueInterrupt = null;
  let promotingQueueId = "";
  /** @type {ReturnType<typeof setInterval>|null} */
  let pollTimer = null;
  let preferPanel = false;
  let showingHistory = false;
  /** Thread column is visible only after a row click or a send. */
  let showThread = false;
  /** Bumped when the visible thread changes so in-flight polls/resumes cannot paint an older chat. */
  let viewGen = 0;
  let historyFetchGen = 0;
  let historyStructureKey = "";
  /** @type {string|null} */
  let historyPointerSid = null;

  const MAX_FILES = 16;
  /** Match server MAX_ATTACHMENT_BYTES / MAX_TOTAL_ATTACHMENT_BYTES. */
  const MAX_FILE_BYTES = 64 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
  const MAX_QUEUED = 8;
  const POLL_MS = 2000;

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

  function ensureChipsEl(composer) {
    if (composer.chipsEl) return composer.chipsEl;
    const chipsEl = document.createElement("div");
    chipsEl.className = "yan-chat-attach-chips";
    chipsEl.hidden = true;
    if (composer.form) composer.form.insertBefore(chipsEl, composer.form.firstChild);
    composer.chipsEl = chipsEl;
    return chipsEl;
  }

  function clearChipObjectUrls(composer) {
    for (const url of composer.chipObjectUrls) URL.revokeObjectURL(url);
    composer.chipObjectUrls = [];
  }

  function renderChips(composer) {
    const el = ensureChipsEl(composer);
    el.innerHTML = "";
    clearChipObjectUrls(composer);
    const had = composer.column.classList.contains("has-attachments");
    if (!composer.pendingFiles.length) {
      el.hidden = true;
      composer.column.classList.remove("has-attachments");
      if (had) scheduleGlassRefresh();
      return;
    }
    el.hidden = false;
    composer.column.classList.add("has-attachments");
    if (!had) scheduleGlassRefresh();
    for (const item of composer.pendingFiles) {
      const chip = document.createElement("span");
      chip.className = "yan-chat-attach-chip";
      chip.title = item.file.name;
      if (item.file.type.startsWith("image/")) {
        const thumb = document.createElement("img");
        thumb.className = "yan-chat-attach-chip-thumb";
        thumb.alt = "";
        const url = URL.createObjectURL(item.file);
        composer.chipObjectUrls.push(url);
        thumb.src = url;
        chip.appendChild(thumb);
      }
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
        composer.pendingFiles = composer.pendingFiles.filter((f) => f.id !== item.id);
        renderChips(composer);
      });
      chip.appendChild(label);
      chip.appendChild(remove);
      el.appendChild(chip);
    }
  }

  function resetComposer(composer) {
    composer.pendingFiles = [];
    if (composer.input) {
      composer.input.value = "";
      composer.input.disabled = false;
    }
    renderChips(composer);
    syncComposerSize(composer);
  }

  /**
   * @param {ReturnType<typeof bindComposer>} composer
   * @param {FileList|File[]} list
   */
  function addFiles(composer, list) {
    const files = Array.from(list || []);
    let pendingTotal = composer.pendingFiles.reduce((n, p) => n + p.file.size, 0);
    for (const file of files) {
      if (!file || !(file instanceof File)) continue;
      if (composer.pendingFiles.length >= MAX_FILES) break;
      if (file.size > MAX_FILE_BYTES) {
        if (composer.role === "thread") {
          appendBubble(
            "assistant",
            `“${file.name}” is too large (max 64MB per file).`
          );
          setState("panel");
        }
        continue;
      }
      if (pendingTotal + file.size > MAX_TOTAL_BYTES) {
        if (composer.role === "thread") {
          appendBubble(
            "assistant",
            `“${file.name}” would exceed 64MB total per message.`
          );
          setState("panel");
        }
        continue;
      }
      const dup = composer.pendingFiles.some(
        (p) => p.file.name === file.name && p.file.size === file.size
      );
      if (dup) continue;
      composer.pendingFiles.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
      });
      pendingTotal += file.size;
    }
    renderChips(composer);
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

  const CHAT_HISTORY_TZ = "America/Los_Angeles";

  function seattleDateKey(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: CHAT_HISTORY_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const pick = (type) => {
      const raw = parts.find((p) => p.type === type)?.value || "";
      const digits = raw.replace(/\D/g, "");
      return digits.padStart(type === "year" ? 4 : 2, "0");
    };
    return `${pick("year")}-${pick("month")}-${pick("day")}`;
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
    const that = seattleDateKey(d);
    const today = seattleDateKey(now);
    if (that === today) return { key: "today", label: "Today", showAge: true };
    const thatNoon = Date.parse(`${that}T12:00:00.000Z`);
    const todayNoon = Date.parse(`${today}T12:00:00.000Z`);
    const diffDays = Math.round((todayNoon - thatNoon) / 86400000);
    if (diffDays === 1) {
      return { key: that, label: "Yesterday", showAge: false };
    }
    if (diffDays > 1 && diffDays < 7) {
      return {
        key: that,
        label: d.toLocaleDateString("en-US", {
          timeZone: CHAT_HISTORY_TZ,
          weekday: "long",
        }),
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

  function threadOpen() {
    return messages.length > 0 || sending;
  }

  function lengthPx(value) {
    const raw = String(value || "").trim();
    const n = parseFloat(raw);
    if (raw.endsWith("px") && Number.isFinite(n)) return n;
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;visibility:hidden;width:" + (raw || "0px");
    root.appendChild(probe);
    const w = probe.getBoundingClientRect().width;
    probe.remove();
    return w;
  }

  function wideEnough() {
    const circle = circlePx();
    const styles = getComputedStyle(root);
    const gap = parseFloat(styles.getPropertyValue("--chat-gap")) || 12;
    const pad = lengthPx(styles.getPropertyValue("--chat-pad"));
    const threadW = circle * 6;
    return window.innerWidth >= threadW * 1.5 + gap + pad * 2 - 1;
  }

  function hideHistory(opts = {}) {
    const wasShowing = showingHistory;
    showingHistory = false;
    historyPointerSid = null;
    if (opts.markVisibleRead && wasShowing && sessionId && !sending) {
      markChatRead(sessionId);
    }
    syncLayout();
  }

  async function showHistory(opts = {}) {
    showThread = false;
    showingHistory = true;
    if (historyEl && !historyEl.childElementCount) {
      historyEl.innerHTML = "";
      const loading = document.createElement("p");
      loading.className = "yan-chat-history-empty";
      loading.textContent = "Loading…";
      historyEl.appendChild(loading);
    }
    setState("panel", {
      skipFocus: !opts.focus,
      focusComposer: opts.focus ? historyComposer : null,
    });
    await renderHistory();
  }

  function toggleHistory() {
    if (root.classList.contains("is-dual")) return;
    if (showThread && !wideEnough()) {
      closeThreadPanel();
      return;
    }
    if (!showThread && threadOpen()) {
      showThread = true;
      if (!wideEnough()) showingHistory = false;
      setState("panel", { focusComposer: threadComposer });
      return;
    }
    showHistory();
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
      const res = await window.YanMacApi.macFetch(`${API}/agent/chats`, {
        method: "GET",
        timeoutMs: 30_000,
      });
      const data = await res.json().catch(() => ({}));
      if (fetchGen !== historyFetchGen || !showingHistory) return;
      const chats = Array.isArray(data.chats) ? data.chats : [];
      const nextKey = historyRowsKey(chats);
      if (nextKey === historyStructureKey && historyEl.childElementCount) {
        patchHistoryRows(chats);
        markCurrentHistoryRow();
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
          if (sessionId && String(chat.sessionId || "") === sessionId) {
            btn.classList.add("is-current");
            btn.setAttribute("aria-current", "true");
          }
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
      await window.YanMacApi.macFetch(`${API}/agent/read`, {
        method: "POST",
        json: { sessionId: id },
        timeoutMs: 15_000,
      });
    } catch {
      /* ignore */
    }
  }

  async function openHistoryChat(sid, opts) {
    const id = String(sid || "").trim();
    if (!id) return;
    showThread = true;
    if (wideEnough()) showingHistory = true;
    else hideHistory();
    markChatRead(id);
    resetComposer(threadComposer);
    setState("panel", { focusComposer: threadComposer });
    if (id === sessionId) return;
    if (!window.YanMacApi) return;
    const gen = ++viewGen;
    stopPolling();
    try {
      const res = await window.YanMacApi.macFetch(`${API}/agent/resume`, {
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
      setState("panel", { focusComposer: threadComposer });
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
      if (opts?.quiet) throw err;
      appendBubble(
        "assistant",
        "Could not open that chat. Is the Mac API running?"
      );
      setState("panel");
    }
  }

  const COMPOSER_MAX_LINES = 8;
  let composerGlassTimer = 0;
  let layoutDual = false;

  function cssPx(el, name) {
    const raw = String(getComputedStyle(el).getPropertyValue(name) || "").trim();
    const n = parseFloat(raw);
    if (Number.isFinite(n) && !/rem|em/.test(raw)) return n;
    const nested = raw.match(/^var\(\s*(--[\w-]+)/);
    if (nested) return cssPx(el, nested[1]);
    return lengthPx(raw);
  }

  function circlePx() {
    return cssPx(root, "--chat-circle") || cssPx(root, "--corner-orb") || 80;
  }

  function desktopEnterSends() {
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  }

  /** Count wrapped + hard-break lines without reading textarea.scrollHeight (flex min-height lies). */
  function composerLineCount(input) {
    const text = String(input?.value || "");
    const parts = text.split("\n");
    const width = Math.max(0, input?.clientWidth || input?.offsetWidth || 0);
    if (!input || width < 8) return Math.max(1, parts.length);
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

  function bumpComposerGlass() {
    window.clearTimeout(composerGlassTimer);
    composerGlassTimer = window.setTimeout(() => {
      if (typeof window.reinitLiquidGlass === "function") {
        window.reinitLiquidGlass();
      }
    }, 90);
  }

  function markCurrentHistoryRow() {
    if (!historyEl) return;
    historyEl.querySelectorAll(".yan-chat-history-row").forEach((row) => {
      const on = Boolean(sessionId) && row.dataset.sessionId === sessionId;
      row.classList.toggle("is-current", on);
      if (on) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    });
  }

  function syncLayout() {
    const open = state() !== "closed";
    const panelOn = state() === "panel";
    const dual = open && panelOn && showThread && wideEnough();
    const wasDual = layoutDual;
    if (dual) showingHistory = true;
    else if (wasDual && showThread && open) showingHistory = false;
    layoutDual = dual;
    root.classList.toggle("is-dual", dual);
    if (dual && !wasDual) renderHistory().catch(() => {});
    syncHistoryFrost();

    const showThreadCol = open && panelOn && showThread;
    const showHistoryCol = !showThreadCol || dual;
    historyCol.hidden = !showHistoryCol;
    threadCol.hidden = !showThreadCol;

    for (const composer of composers) {
      const showCol = composer.role === "history" ? showHistoryCol : showThreadCol;
      const showPanel = panelOn && showCol;
      if (composer.panel) {
        composer.panel.hidden = !showPanel;
        composer.panel.setAttribute("aria-hidden", showPanel ? "false" : "true");
      }
      if (composer.pill) {
        composer.pill._lgMagClamp = open && showCol;
        if (!open || !showCol) releaseChatMagnetic(composer.pill);
      }
      if (!showPanel && composer.panel) releaseChatMagnetic(composer.panel);
      if (composer.input) composer.input.tabIndex = open && showCol ? 0 : -1;
    }
    if (!panelOn) {
      closeAllBtns.forEach(releaseChatMagnetic);
      closeThreadBtns.forEach(releaseChatMagnetic);
    }
    markCurrentHistoryRow();
  }

  /** Grow the liquid-glass pill with wrapped / multiline text. Same corner radius. */
  function syncOneComposer(composer) {
    const input = composer.input;
    const column = composer.column;
    if (!input || !column) return;
    const filled =
      state() !== "closed" && !column.hidden && Boolean(String(input.value || "").length);
    column.classList.toggle("has-input-text", filled);
    const circle = circlePx();
    const radius = Math.round(circle / 2);
    if (composer.pill) composer.pill.setAttribute("data-lg-radius", String(radius));

    if (state() === "closed" || column.hidden) {
      input.style.height = "";
      input.style.overflowY = "hidden";
      column.classList.remove("is-composer-tall");
      if (composer.lastPillH !== 0) {
        composer.lastPillH = 0;
        column.style.setProperty("--pill-h", `${Math.round(circle)}px`);
      }
      return;
    }

    const cs = getComputedStyle(input);
    let lineH = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lineH) || lineH < 8) {
      lineH = (parseFloat(cs.fontSize) || 16) * 1.35;
    }
    const lines = composerLineCount(input);
    const fromClosed = composer.lastPillH === 0;

    if (lines <= 1) {
      input.style.height = "";
      input.style.overflowY = "hidden";
      column.classList.remove("is-composer-tall");
      const changed = composer.lastPillH !== circle;
      composer.lastPillH = circle;
      column.style.setProperty("--pill-h", `${Math.round(circle)}px`);
      if (changed && !fromClosed) bumpComposerGlass();
      return;
    }

    const nextH = Math.min(lines, COMPOSER_MAX_LINES) * lineH;
    input.style.height = `${nextH}px`;
    input.style.overflowY = lines > COMPOSER_MAX_LINES ? "auto" : "hidden";

    /* Count the tall inset before the class is on, so the pill grows
       before the text meets the corner instead of after. */
    const padY = cssPx(root, "--composer-pad-y") || lengthPx("1.25rem");
    const formPad = padY * 2;
    const pillH = Math.max(circle, Math.ceil(nextH + formPad));
    column.classList.toggle("is-composer-tall", pillH > circle + 4);
    if (Math.abs(pillH - composer.lastPillH) > 0.5) {
      composer.lastPillH = pillH;
      column.style.setProperty("--pill-h", `${pillH}px`);
      if (!fromClosed) bumpComposerGlass();
    }
  }

  function syncComposerSize(only) {
    const list = only ? [only] : composers;
    for (const composer of list) syncOneComposer(composer);
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
    if (next === "open") next = "panel";
    root.dataset.state = next;
    const open = next !== "closed";
    root.classList.toggle("is-open", open);
    root.classList.toggle("has-panel", next === "panel");
    if (next === "panel") preferPanel = true;
    syncLayout();
    if (launcher) {
      launcher.setAttribute("aria-expanded", open ? "true" : "false");
      launcher.tabIndex = open ? -1 : 0;
    }
    syncComposerSize();
    scheduleGlassRefresh();
    const focusEl = opts.focusComposer?.input;
    if (open && !opts.skipFocus && focusEl) {
      window.setTimeout(
        () => focusEl.focus({ preventScroll: true }),
        reduceMotion ? 0 : 420
      );
    }
  }

  // Pill left/width spring is 0.7s with overshoot. Rebuilding glass mid-tween
  // leaves a pill-sized displacement rim inset inside the settled circle.
  const PILL_SPRING_MS = 780;
  let glassTimer = 0;
  let glassTransitionHandler = null;

  function pillEls() {
    return composers.map((c) => c.pill).filter(Boolean);
  }

  function scheduleGlassRefresh() {
    window.clearTimeout(glassTimer);
    const pills = pillEls();
    if (glassTransitionHandler) {
      pills.forEach((pill) => pill.removeEventListener("transitionend", glassTransitionHandler));
      glassTransitionHandler = null;
    }

    if (reduceMotion || !pills.length) {
      refreshGlass();
      return;
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(glassTimer);
      if (glassTransitionHandler) {
        pills.forEach((pill) => pill.removeEventListener("transitionend", glassTransitionHandler));
        glassTransitionHandler = null;
      }
      refreshGlass();
    };

    glassTransitionHandler = (event) => {
      if (!pills.includes(event.target)) return;
      if (
        event.propertyName !== "width" &&
        event.propertyName !== "left" &&
        event.propertyName !== "height"
      ) {
        return;
      }
      finish();
    };
    pills.forEach((pill) => pill.addEventListener("transitionend", glassTransitionHandler));
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
    for (const composer of composers) {
      if (composer.input) composer.input.disabled = false;
    }
    const submit = threadComposer.sendBtn;
    if (submit) {
      // Keep enabled while busy so hold-to-interrupt still works at queue cap.
      submit.disabled = full && !sending;
      submit.title = full && !sending
        ? `Queue full (max ${MAX_QUEUED}). Wait for a reply.`
        : sending
          ? "Hold send or Enter 2 seconds to interrupt instead of queueing"
          : "";
    }
    if (historyComposer.sendBtn) {
      historyComposer.sendBtn.disabled = false;
      historyComposer.sendBtn.title = "";
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
        queueId: m.queued && m.queueId ? String(m.queueId) : "",
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

  function syncQueuedTurn(turn, msg) {
    const queued = Boolean(msg && msg.queued);
    turn.classList.toggle("yan-chat-turn--queued", queued);
    if (!queued) {
      turn.removeAttribute("title");
      delete turn.dataset.queueId;
      turn.classList.remove("is-interrupt-armed");
      return;
    }
    turn.title = "Hold 2 seconds, then release, to interrupt with this message";
    if (msg.queueId) turn.dataset.queueId = String(msg.queueId);
    else delete turn.dataset.queueId;
  }

  function buildTurn(msg, msgIndex) {
    const turn = document.createElement("div");
    turn.className = `yan-chat-turn yan-chat-turn--${msg.role}`;
    turn.dataset.reuseKey = messageReuseKey(msg);
    syncQueuedTurn(turn, msg);
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
        syncQueuedTurn(turn, msg);
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
    applyQueueHoldChrome();
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
    if (wasSending && !next && sessionId && !threadCol.hidden) {
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
        /** @type {{ role: string, content: string, queued?: boolean, queueId?: string, widgets?: object[] }} */
        const out = {
          role: String(m.role),
          content: String(m.content || ""),
        };
        if (m.queued) out.queued = true;
        if (m.queued && m.queueId) out.queueId = String(m.queueId);
        if (Array.isArray(m.widgets) && m.widgets.length) out.widgets = m.widgets;
        return out;
      });
    if (messagesFingerprint(next) === messagesFingerprint(messages)) {
      maybeFlushPendingQueueInterrupt();
      return;
    }
    messages = next;
    renderMessagesDom();
    persistLocal();
    maybeFlushPendingQueueInterrupt();
  }

  async function pollState() {
    if (!sessionId || !window.YanMacApi) return;
    const requested = sessionId;
    const gen = viewGen;
    const res = await window.YanMacApi.macFetch(
      `${API}/agent/state?sessionId=${encodeURIComponent(requested)}`,
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
      showThread = false;
      setBusy(false);
      clearMessagesDom();
      clearLocal();
      if (state() !== "closed") showHistory();
      else {
        showingHistory = false;
        syncLayout();
      }
      return;
    }
    if (!res.ok) return;
    if (data.navigate) {
      try {
        window.__eduNavigate?.(data.navigate);
      } catch {
        /* ignore */
      }
    }
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
      const res = await window.YanMacApi.macFetch(`${API}/agent/start`, {
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
    const composer = opts.composer || threadComposer;
    const fresh = composer.role === "history";
    const interrupt = Boolean(opts.interrupt) && !fresh;
    const text = String(raw || "").trim();
    const files = composer.pendingFiles.slice();
    if (!text && !files.length) return;
    if (!fresh && !interrupt && queueFull()) return;

    if (fresh && (messages.length || sending)) {
      viewGen += 1;
      stopPolling();
      sessionId = null;
      messages = [];
      sending = false;
      root.classList.remove("is-busy");
      clearMessagesDom();
    }
    showThread = true;
    if (fresh) {
      resetComposer(threadComposer);
      if (!wideEnough()) showingHistory = false;
    }

    const originRect = composer.pill ? composer.pill.getBoundingClientRect() : null;
    if (state() !== "panel") root.classList.add("is-send-flight");

    const label =
      text +
      (files.length
        ? `${text ? "\n" : ""}[${files.length} file${files.length === 1 ? "" : "s"}: ${files
            .map((f) => f.file.name)
            .join(", ")}]`
        : "");
    const willQueue = !fresh && sending && !interrupt;
    appendBubble("user", label || "(attachment)", { queued: willQueue });
    resetComposer(composer);
    setState("panel", { skipFocus: true });
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
        `${API}/agent/message`,
        {
          method: "POST",
          json: body,
          // Staging attachments can take a bit; 64MB JSON+base64 is slow on cellular.
          timeoutMs: 300_000,
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
      setState("panel", { skipFocus: true });
      if (showingHistory) renderHistory().catch(() => {});
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
      setState("panel", { skipFocus: true });
    } finally {
      const focus = !threadCol.hidden ? threadComposer : historyComposer;
      if (focus.input && state() !== "closed") {
        focus.input.focus({ preventScroll: true });
      }
    }
  }

  function openChat() {
    if (state() !== "closed") return;
    showHistory({ focus: true });
    if (sending || (sessionId && messages.length)) {
      pollState().catch(() => {});
    }
  }

  /** Hide every chat view. The thread stays in history and keeps running. */
  function closeAllChats() {
    viewGen += 1;
    composers.forEach(resetComposer);
    showThread = false;
    showingHistory = false;
    persistLocal();
    setState("closed");
  }

  /** Hide the open chat. History stays up and goes full width. */
  function closeThreadPanel() {
    viewGen += 1;
    showHistory({ focus: true });
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

  root.addEventListener("click", (event) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const a = event.target?.closest?.("a");
    if (!a || !root.contains(a)) return;
    const href = a.getAttribute("href") || "";
    if (!window.__eduNavigatePath?.(href)) return;
    event.preventDefault();
    event.stopPropagation();
  });

  closeAllBtns.forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeAllChats();
    });
  });

  closeThreadBtns.forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeThreadPanel();
    });
  });

  const HOLD_MS = 2000;
  let sendHoldTimer = null;
  let sendHoldArmed = false;
  let sendHoldConsumed = false;
  let enterHoldActive = false;
  /** @type {ReturnType<typeof bindComposer>|null} */
  let enterComposer = null;

  function clearSendHold() {
    if (sendHoldTimer) {
      window.clearTimeout(sendHoldTimer);
      sendHoldTimer = null;
    }
    sendHoldArmed = false;
    threadComposer.sendBtn?.classList.remove("is-interrupt-armed");
  }

  function startSendHold() {
    sendHoldConsumed = false;
    clearSendHold();
    sendHoldTimer = window.setTimeout(() => {
      sendHoldTimer = null;
      if (!sending) return;
      sendHoldArmed = true;
      threadComposer.sendBtn?.classList.add("is-interrupt-armed");
    }, HOLD_MS);
  }

  function finishInterruptHold(event) {
    const armed = sendHoldArmed && sending;
    clearSendHold();
    if (!armed) return false;
    event.preventDefault();
    event.stopPropagation();
    sendHoldConsumed = true;
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate([40, 35, 90]);
    }
    sendMessage(threadComposer.input?.value, {
      interrupt: true,
      composer: threadComposer,
    });
    return true;
  }

  function onEnterKeyup(event) {
    if (event.key !== "Enter" || !enterHoldActive) return;
    const composer = enterComposer || threadComposer;
    enterHoldActive = false;
    enterComposer = null;
    event.preventDefault();
    if (composer.role === "thread" && finishInterruptHold(event)) return;
    sendMessage(composer.input?.value, { composer });
  }

  for (const composer of composers) {
    const { form, input, sendBtn } = composer;
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (event.shiftKey) return;
      if (composer.role === "thread" && sendHoldConsumed) {
        sendHoldConsumed = false;
        return;
      }
      sendMessage(input?.value, { composer });
    });

    form?.addEventListener("pointerdown", (event) => {
      if (event.target === form) input?.focus({ preventScroll: true });
    });

    input?.addEventListener("input", () => syncComposerSize(composer));

    input?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) {
        return;
      }
      if (!desktopEnterSends()) return;
      event.preventDefault();
      if (event.repeat) return;
      enterHoldActive = true;
      enterComposer = composer;
      if (composer.role === "thread") startSendHold();
    });

    input?.addEventListener("keyup", onEnterKeyup);

    input?.addEventListener("blur", () => {
      if (!enterHoldActive || enterComposer !== composer) return;
      enterHoldActive = false;
      enterComposer = null;
      sendHoldConsumed = false;
      clearSendHold();
    });

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
      addFiles(composer, files);
    });

    if (composer.role !== "thread") continue;

    sendBtn?.addEventListener("pointerdown", (event) => {
      if (event.button && event.button !== 0) return;
      if (event.shiftKey) return;
      startSendHold();
    });

    sendBtn?.addEventListener("pointerup", (event) => {
      finishInterruptHold(event);
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
  }

  const QUEUE_HOLD_MOVE_PX = 12;

  function applyQueueHoldChrome() {
    if (!messagesEl) return;
    for (const el of messagesEl.querySelectorAll(":scope > .yan-chat-turn.is-interrupt-armed")) {
      el.classList.remove("is-interrupt-armed");
    }
    const turn = heldQueuedTurn();
    if (queueHold?.armed && turn) turn.classList.add("is-interrupt-armed");
  }

  function heldQueuedTurn() {
    if (!messagesEl || !queueHold) return null;
    const queued = [...messagesEl.querySelectorAll(":scope > .yan-chat-turn--queued")];
    if (queueHold.queueId) {
      return queued.find((el) => el.dataset.queueId === queueHold.queueId) || null;
    }
    const turn = queued[queueHold.index] || null;
    if (!turn) return null;
    const text = turn.querySelector(".yan-chat-bubble-in")?.textContent || "";
    if (text !== queueHold.content) return null;
    return turn;
  }

  function endQueueHold() {
    if (queueHold?.timer) window.clearTimeout(queueHold.timer);
    queueHold = null;
    applyQueueHoldChrome();
  }

  function resolveHeldQueueId(hold) {
    const queued = messages.filter((m) => m && m.queued);
    if (hold.queueId) {
      return queued.some((m) => m.queueId === hold.queueId) ? hold.queueId : "";
    }
    const msg = queued[hold.index];
    if (!msg || String(msg.content || "") !== hold.content) return "";
    return msg.queueId ? String(msg.queueId) : "";
  }

  function maybeFlushPendingQueueInterrupt() {
    if (!pendingQueueInterrupt || promotingQueueId) return;
    const queued = messages.filter((m) => m && m.queued);
    const msg = queued[pendingQueueInterrupt.index];
    if (!msg || String(msg.content || "") !== pendingQueueInterrupt.content) {
      pendingQueueInterrupt = null;
      return;
    }
    if (!msg.queueId) return;
    const queueId = String(msg.queueId);
    pendingQueueInterrupt = null;
    promoteQueued(queueId);
  }

  function promoteQueuedLocally(queueId) {
    const index = messages.findIndex((m) => m && m.queued && m.queueId === queueId);
    if (index < 0) return false;
    const [msg] = messages.splice(index, 1);
    delete msg.queued;
    delete msg.queueId;
    const firstQueued = messages.findIndex((m) => m && m.queued);
    if (firstQueued < 0) messages.push(msg);
    else messages.splice(firstQueued, 0, msg);
    renderMessagesDom();
    persistLocal();
    return true;
  }

  async function promoteQueued(queueId) {
    const id = String(queueId || "").trim();
    if (!id || promotingQueueId || !sessionId || !window.YanMacApi) return;
    const previous = messages.map((m) => ({ ...m }));
    if (!promoteQueuedLocally(id)) return;
    promotingQueueId = id;
    try {
      const res = await window.YanMacApi.macFetch(`${API}/agent/interrupt-queued`, {
        method: "POST",
        json: { sessionId, queueId: id },
        timeoutMs: 120_000,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 404) {
        await pollState().catch(() => {});
        return;
      }
      if (!res.ok) {
        messages = previous;
        renderMessagesDom();
        persistLocal();
        appendBubble("assistant", data.error || "Could not interrupt with that message.");
        return;
      }
      if (Array.isArray(data.messages)) applyServerMessages(data.messages);
      setBusy(true);
      startPolling();
      await pollState();
    } catch (err) {
      console.error("[edu-chat] interrupt queued", err);
      messages = previous;
      renderMessagesDom();
      persistLocal();
      appendBubble(
        "assistant",
        "Could not reach the personal agent. Is the Mac API running?"
      );
    } finally {
      promotingQueueId = "";
    }
  }

  function onQueuePointerDown(event) {
    if (event.button && event.button !== 0) return;
    const turn = event.target?.closest?.(".yan-chat-turn--queued");
    if (!turn || !messagesEl?.contains(turn)) return;
    const queuedTurns = [...messagesEl.querySelectorAll(":scope > .yan-chat-turn--queued")];
    const index = queuedTurns.indexOf(turn);
    if (index < 0) return;
    const msg = messages.filter((m) => m && m.queued)[index];
    if (!msg) return;
    endQueueHold();
    const pointerId = event.pointerId;
    queueHold = {
      pointerId,
      index,
      content: String(msg.content || ""),
      queueId: msg.queueId ? String(msg.queueId) : "",
      startX: event.clientX,
      startY: event.clientY,
      armed: false,
      timer: window.setTimeout(() => {
        if (!queueHold || queueHold.pointerId !== pointerId) return;
        queueHold.armed = true;
        queueHold.timer = null;
        applyQueueHoldChrome();
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          navigator.vibrate(18);
        }
      }, HOLD_MS),
    };
  }

  function onQueuePointerMove(event) {
    if (!queueHold || event.pointerId !== queueHold.pointerId) return;
    const dx = event.clientX - queueHold.startX;
    const dy = event.clientY - queueHold.startY;
    if (dx * dx + dy * dy > QUEUE_HOLD_MOVE_PX * QUEUE_HOLD_MOVE_PX) endQueueHold();
  }

  function onQueuePointerUp(event) {
    if (!queueHold || event.pointerId !== queueHold.pointerId) return;
    const hold = queueHold;
    const armed = hold.armed;
    endQueueHold();
    if (!armed) return;
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate([40, 35, 90]);
    }
    const queueId = resolveHeldQueueId(hold);
    if (queueId) promoteQueued(queueId);
    else pendingQueueInterrupt = { index: hold.index, content: hold.content };
  }

  messagesEl?.addEventListener("pointerdown", onQueuePointerDown);
  window.addEventListener("pointermove", onQueuePointerMove);
  window.addEventListener("pointerup", onQueuePointerUp);
  window.addEventListener("pointercancel", (event) => {
    if (!queueHold || event.pointerId !== queueHold.pointerId) return;
    endQueueHold();
  });
  messagesEl?.addEventListener("contextmenu", (event) => {
    const turn = event.target?.closest?.(".yan-chat-turn--queued");
    if (!turn || !messagesEl.contains(turn)) return;
    event.preventDefault();
  });

  historyComposer.sendBtn?.addEventListener(
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

  window.addEventListener("keyup", onEnterKeyup);

  // Drag-and-drop onto either composer or its panel.
  function isFileDrag(event) {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    return [...types].includes("Files");
  }

  function composerFromNode(node) {
    if (!(node instanceof Node)) return null;
    for (const composer of composers) {
      if (composer.column.hidden) continue;
      if (composer.column.contains(node)) return composer;
    }
    return null;
  }

  function filesFromDrop(event) {
    const dt = event.dataTransfer;
    if (!dt) return [];
    if (dt.files?.length) return Array.from(dt.files);
    const files = [];
    for (const item of dt.items || []) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return files;
  }

  function onDragEnter(event) {
    const composer = composerFromNode(event.target);
    if (!isFileDrag(event) || !composer) return;
    event.preventDefault();
    composer.column.classList.add("is-dragover");
    if (state() === "closed") openChat();
  }

  function onDragOver(event) {
    const composer = composerFromNode(event.target);
    if (!isFileDrag(event) || !composer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    composer.column.classList.add("is-dragover");
  }

  function onDragLeave(event) {
    if (!isFileDrag(event)) return;
    const next = event.relatedTarget;
    if (next instanceof Node && composerFromNode(next)) return;
    composers.forEach((composer) => composer.column.classList.remove("is-dragover"));
  }

  function onDrop(event) {
    const composer = composerFromNode(event.target);
    if (!composer) return;
    const files = filesFromDrop(event);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    composers.forEach((item) => item.column.classList.remove("is-dragover"));
    if (state() === "closed") openChat();
    addFiles(composer, files);
    composer.input?.focus({ preventScroll: true });
  }

  for (const composer of composers) {
    [composer.pill, composer.panel].filter(Boolean).forEach((el) => {
      el.addEventListener("dragenter", onDragEnter);
      el.addEventListener("dragover", onDragOver, true);
      el.addEventListener("dragleave", onDragLeave);
      el.addEventListener("drop", onDrop, true);
    });
  }

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || state() === "closed") return;
    closeAllChats();
  });

  window.addEventListener(
    "resize",
    (() => {
      let t;
      return () => {
        if (state() !== "closed") syncLayout();
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
        `${API}/agent/active`,
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
          /** @type {{ role: string, content: string, queued?: boolean, queueId?: string }} */
          const out = {
            role: String(m.role),
            content: String(m.content || ""),
          };
          if (m.queued) out.queued = true;
          if (m.queued && m.queueId) out.queueId = String(m.queueId);
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
    const composer = !threadCol.hidden ? threadComposer : historyComposer;
    addFiles(composer, files);
    if (state() === "closed") showHistory({ focus: true });
  };

  composers.forEach((composer) => ensureChipsEl(composer));
  setState("closed");

  // Instant updates via the same education SSE / 45s poll path as the dashboard.
  window.__eduChatRefresh = () => {
    if (sessionId) pollState().catch(() => {});
    else resumeFromServer().catch(() => {});
    if (showingHistory) renderHistory().catch(() => {});
  };

  function chatDeepLinkId() {
    try {
      const id = new URLSearchParams(window.location.search).get("chat") || "";
      return /^[a-zA-Z0-9._-]{8,80}$/.test(id) ? id : "";
    } catch {
      return "";
    }
  }

  // Resume after auth/email is available (app.js boot). Retry briefly.
  // ?chat=<sessionId> opens that thread (dashboard scheduled-agent cards).
  let resumeAttempts = 0;
  const deepChat = chatDeepLinkId();
  const resumeKick = () => {
    resumeAttempts += 1;
    if (deepChat) {
      if (!window.YanMacApi) {
        if (resumeAttempts < 8) window.setTimeout(resumeKick, 400);
        return;
      }
      openHistoryChat(deepChat, { quiet: resumeAttempts < 8 }).catch(() => {
        if (resumeAttempts < 8) window.setTimeout(resumeKick, 400);
      });
      return;
    }
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
