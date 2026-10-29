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
      /** @type {PendingFile[]} */
      pendingFiles: [],
      /** @type {HTMLElement|null} */
      chipsEl: null,
      lastPillH: 0,
      /** Server draft this composer saves into. Null until the first edit. */
      /** @type {string|null} */
      draftId: null,
      /** @type {string|null} */
      draftSessionId: null,
      draftUpdated: "",
      /** Local text edits not yet sent to the server. */
      dirty: false,
      saveTimer: 0,
      /** Date.now() of the last server ack, so an older GET cannot clear it. */
      draftTouchedAt: 0,
    };
  }

  /**
   * @typedef {{ id: string, file: File|null, name: string, mimeType: string, size: number,
   *   serverId: string, uploading: boolean, removed?: boolean, localOnly?: boolean,
   *   upload?: Promise<void> }} PendingFile
   */

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
  /** Row under pointerdown, kept in case the list rebuilds before click. */
  /** @type {{ sid: string, draftId: string, pending: boolean }|null} */
  let historyPointerRow = null;

  const MAX_FILES = 16;
  /** Match server MAX_ATTACHMENT_BYTES / MAX_TOTAL_ATTACHMENT_BYTES. */
  const MAX_FILE_BYTES = 64 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
  const MAX_QUEUED = 8;
  const POLL_MS = 2000;

  /** @type {HTMLElement|null} */
  let workingEl = null;
  /** @type {{ destroy: () => void }|null} */
  let workingOrb = null;
  let orbWaiting = false;
  let busyLabel = "Working…";
  let bubbleSeq = 0;

  /** Last GET chats payload. Drafts are { id, sessionId, text, title, files, created, updated }. */
  /** @type {{ sessionId?: string, title?: string, preview?: string, updated?: string, working?: boolean, unread?: boolean }[]} */
  let lastChats = [];
  /** @type {{ id: string, sessionId: string|null, text?: string, title?: string, files?: { id: string, name: string, mimeType?: string, size?: number }[], created?: string, updated?: string }[]} */
  let lastDrafts = [];
  let historyLoaded = false;
  /**
   * Sends that are not accepted yet (or accepted but not in GET chats yet).
   * @type {Map<string, { key: string, title: string, updated: string, sessionId: string, draftId: string, pending: boolean }>}
   */
  const pendingRows = new Map();
  /** @type {Map<string, Promise<void>>} */
  const draftSaves = new Map();
  /** Set when the Mac API has no drafts routes. Composers then stay local. */
  let draftsApiMissing = false;
  let launcherTimer = 0;
  const DRAFT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
  const DRAFT_SAVE_MS = 500;
  const LAUNCHER_POLL_MS = 5000;

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
    // In the column, not the pill, so tiles skip the pill's magnetic transform.
    composer.column.appendChild(chipsEl);
    composer.chipsEl = chipsEl;
    return chipsEl;
  }

  function fileExtLabel(name) {
    const m = String(name || "").match(/\.([A-Za-z0-9]{1,10})$/);
    return m ? `.${m[1].toLowerCase()}` : "file";
  }

  function fileStem(name) {
    const raw = String(name || "");
    const m = raw.match(/^(.+)\.[A-Za-z0-9]{1,10}$/);
    return m ? m[1] : raw;
  }

  function renderChips(composer) {
    const el = ensureChipsEl(composer);
    el.innerHTML = "";
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
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "yan-chat-attach-tile";
      tile.classList.toggle("is-uploading", item.uploading);
      tile.title = item.name;
      tile.setAttribute("aria-label", `Remove ${item.name}`);
      const ext = document.createElement("span");
      ext.className = "yan-chat-attach-tile-ext";
      ext.setAttribute("aria-hidden", "true");
      const extText = fileExtLabel(item.name);
      ext.textContent = extText;
      ext.classList.toggle("is-long", extText.length > 5);
      const name = document.createElement("span");
      name.className = "yan-chat-attach-tile-name";
      name.setAttribute("aria-hidden", "true");
      name.textContent = fileStem(item.name);
      tile.appendChild(ext);
      tile.appendChild(name);
      tile.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        removePendingFile(composer, item.id);
      });
      el.appendChild(tile);
      window.lgBindMagnetic?.(tile, 0.2);
    }
  }

  function localFileId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function newDraftId() {
    try {
      if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
    } catch {
      /* fall through */
    }
    return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }

  function draftPath(id, suffix = "") {
    return `${API}/agent/drafts/${encodeURIComponent(id)}${suffix}`;
  }

  function validDraft(d) {
    return Boolean(d && typeof d === "object" && DRAFT_ID_RE.test(String(d.id || "")));
  }

  function upsertLocalDraft(draft) {
    if (!validDraft(draft)) return;
    lastDrafts = [draft, ...lastDrafts.filter((d) => d.id !== draft.id)].sort(
      (a, b) => (Date.parse(b.updated || "") || 0) - (Date.parse(a.updated || "") || 0)
    );
    for (const composer of composers) {
      if (composer.draftId === draft.id) composer.draftUpdated = String(draft.updated || "");
    }
  }

  function removeLocalDraft(id) {
    if (!id) return;
    lastDrafts = lastDrafts.filter((d) => d.id !== id);
  }

  function draftOnServer(id) {
    return Boolean(id) && lastDrafts.some((d) => d.id === id);
  }

  /** Express answers unknown routes with a 404 page, not { ok }. */
  function isMissingRoute(res, data) {
    return (
      (res.status === 404 || res.status === 405 || res.status === 501) &&
      !(data && typeof data === "object" && "ok" in data)
    );
  }

  function markDraftsMissing() {
    if (draftsApiMissing) return;
    draftsApiMissing = true;
    console.warn("[edu-chat] drafts API unavailable; keeping composers local");
  }

  /** Binds the composer to a draft id on its first edit. */
  function ensureComposerDraft(composer) {
    if (composer.draftId) return composer.draftId;
    if (composer.role === "thread" && sessionId) {
      const id = `s-${sessionId}`;
      if (!DRAFT_ID_RE.test(id)) return null;
      composer.draftId = id;
      composer.draftSessionId = sessionId;
    } else {
      composer.draftId = newDraftId();
      composer.draftSessionId = null;
    }
    composer.draftUpdated = "";
    return composer.draftId;
  }

  /** Focused with content, unsaved, or mid-upload: a remote refresh must not touch it. */
  function composerBusy(composer) {
    const hasContent =
      Boolean(String(composer.input?.value || "").length) || composer.pendingFiles.length > 0;
    if (composer.dirty || composer.saveTimer) return true;
    if (composer.draftId && draftSaves.has(composer.draftId)) return true;
    if (composer.pendingFiles.some((f) => f.uploading)) return true;
    return hasContent && document.activeElement === composer.input;
  }

  /**
   * @param {ReturnType<typeof bindComposer>} composer
   * @param {object} draft
   */
  function applyDraftToComposer(composer, draft) {
    window.clearTimeout(composer.saveTimer);
    composer.saveTimer = 0;
    composer.dirty = false;
    composer.draftId = String(draft.id);
    composer.draftSessionId = draft.sessionId ? String(draft.sessionId) : null;
    composer.draftUpdated = String(draft.updated || "");
    if (composer.input) composer.input.value = String(draft.text || "");
    composer.pendingFiles = (Array.isArray(draft.files) ? draft.files : [])
      .filter((f) => f && f.id)
      .map((f) => ({
        id: localFileId(),
        file: null,
        name: String(f.name || "file"),
        mimeType: String(f.mimeType || "application/octet-stream"),
        size: Number(f.size) || 0,
        serverId: String(f.id),
        uploading: false,
      }));
    renderChips(composer);
    syncComposerSize(composer);
  }

  function clearComposerUi(composer) {
    composer.pendingFiles = [];
    if (composer.input) {
      composer.input.value = "";
      composer.input.disabled = false;
    }
    renderChips(composer);
    syncComposerSize(composer);
  }

  function unbindComposerDraft(composer) {
    window.clearTimeout(composer.saveTimer);
    composer.saveTimer = 0;
    composer.dirty = false;
    composer.draftId = null;
    composer.draftSessionId = null;
    composer.draftUpdated = "";
  }

  /**
   * PUTs are chained per draft so an older body never lands after a newer one.
   * @param {string} id
   * @param {{ text: string, sessionId?: string }} body
   */
  function saveDraft(id, body) {
    const prev = draftSaves.get(id) || Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(async () => {
        if (draftsApiMissing || !window.YanMacApi) return;
        const res = await window.YanMacApi.macFetch(draftPath(id), {
          method: "PUT",
          json: body,
          timeoutMs: 30_000,
        });
        const data = await res.json().catch(() => null);
        if (isMissingRoute(res, data)) {
          markDraftsMissing();
          return;
        }
        if (!res.ok) throw new Error(data?.error || `draft save failed (${res.status})`);
        if (data?.draft) upsertLocalDraft(data.draft);
        else removeLocalDraft(id);
        for (const composer of composers) {
          if (composer.draftId === id) composer.draftTouchedAt = Date.now();
        }
        renderHistoryList();
      })
      .catch((err) => {
        console.warn("[edu-chat] draft save", err);
        for (const composer of composers) {
          if (composer.draftId === id) composer.dirty = true;
        }
      });
    draftSaves.set(id, run);
    run.finally(() => {
      if (draftSaves.get(id) === run) draftSaves.delete(id);
    });
    return run;
  }

  /** Fire-and-forget request that survives pagehide. */
  function keepaliveJson(method, path, body) {
    const api = window.YanMacApi;
    const token = api?.peekMacToken?.();
    const base = window.__yanMacApiBase;
    if (!token || !base) {
      api?.macFetch(path, { method, json: body, timeoutMs: 15_000 }).catch(() => {});
      return;
    }
    try {
      fetch(`${String(base).replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {ReturnType<typeof bindComposer>} composer
   * @param {{ keepalive?: boolean }} [opts]
   */
  function flushDraft(composer, opts = {}) {
    window.clearTimeout(composer.saveTimer);
    composer.saveTimer = 0;
    const id = composer.draftId;
    if (!id || !composer.dirty || draftsApiMissing) return Promise.resolve();
    composer.dirty = false;
    /** @type {{ text: string, sessionId?: string }} */
    const body = { text: String(composer.input?.value || "") };
    if (composer.draftSessionId) body.sessionId = composer.draftSessionId;
    if (opts.keepalive) {
      keepaliveJson("PUT", draftPath(id), body);
      return Promise.resolve();
    }
    return saveDraft(id, body);
  }

  function onComposerEdit(composer) {
    if (draftsApiMissing) return;
    const text = String(composer.input?.value || "");
    if (!composer.draftId && !text && !composer.pendingFiles.length) return;
    if (!ensureComposerDraft(composer)) return;
    composer.dirty = true;
    window.clearTimeout(composer.saveTimer);
    composer.saveTimer = window.setTimeout(() => {
      composer.saveTimer = 0;
      flushDraft(composer);
    }, DRAFT_SAVE_MS);
  }

  function flushAllDraftsKeepalive() {
    for (const composer of composers) flushDraft(composer, { keepalive: true });
  }

  /**
   * Clears the local composer and unbinds it. The draft stays on the server
   * (and in the sidebar) unless it was just sent.
   * @param {ReturnType<typeof bindComposer>} composer
   * @param {{ flush?: boolean }} [opts]
   */
  function resetComposer(composer, opts = {}) {
    if (opts.flush !== false) flushDraft(composer);
    unbindComposerDraft(composer);
    clearComposerUi(composer);
  }

  /**
   * @param {ReturnType<typeof bindComposer>} composer
   * @param {PendingFile} item
   */
  function composerHolding(item) {
    return composers.find((c) => c.pendingFiles.includes(item)) || null;
  }

  function dropFailedUpload(item, message) {
    const composer = composerHolding(item);
    if (composer) {
      composer.pendingFiles = composer.pendingFiles.filter((f) => f !== item);
      renderChips(composer);
    }
    if (item.removed) return;
    if (composer?.role === "thread") {
      appendBubble("assistant", message);
      setState("panel");
    } else {
      console.warn("[edu-chat]", message);
    }
  }

  /**
   * @param {ReturnType<typeof bindComposer>} composer
   * @param {string} draftId
   * @param {PendingFile} item
   */
  function startUpload(composer, draftId, item) {
    item.uploading = true;
    const draftSessionId = composer.draftSessionId;
    item.upload = (async () => {
      try {
        /** @type {Record<string, string>} */
        const headers = {
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(item.name),
          "X-File-Type": item.mimeType,
        };
        if (draftSessionId) headers["X-Session-Id"] = draftSessionId;
        const res = await window.YanMacApi.macFetch(draftPath(draftId, "/files"), {
          method: "POST",
          body: item.file,
          headers,
          timeoutMs: 300_000,
        });
        const data = await res.json().catch(() => null);
        item.uploading = false;
        if (isMissingRoute(res, data)) {
          markDraftsMissing();
          item.localOnly = true;
        } else if (!res.ok || !data?.file?.id) {
          dropFailedUpload(
            item,
            data?.error || `Could not upload “${item.name}” (${res.status}).`
          );
          return;
        } else {
          item.serverId = String(data.file.id);
          if (data.draft) upsertLocalDraft(data.draft);
          for (const c of composers) {
            if (c.draftId === draftId) c.draftTouchedAt = Date.now();
          }
          if (item.removed) deleteDraftFile(draftId, item.serverId);
          else renderHistoryList();
        }
      } catch (err) {
        item.uploading = false;
        console.error("[edu-chat] upload", err);
        dropFailedUpload(item, `Could not upload “${item.name}”. Is the Mac API running?`);
        return;
      }
      const holder = composerHolding(item);
      if (holder) renderChips(holder);
    })();
  }

  async function deleteDraftFile(draftId, fileId) {
    if (!draftId || !fileId || draftsApiMissing || !window.YanMacApi) return;
    try {
      const res = await window.YanMacApi.macFetch(
        draftPath(draftId, `/files/${encodeURIComponent(fileId)}`),
        { method: "DELETE", timeoutMs: 30_000 }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) return;
      if (data?.draft) upsertLocalDraft(data.draft);
      else removeLocalDraft(draftId);
      for (const composer of composers) {
        if (composer.draftId === draftId) composer.draftTouchedAt = Date.now();
      }
      renderHistoryList();
    } catch {
      /* ignore */
    }
  }

  function removePendingFile(composer, localId) {
    const item = composer.pendingFiles.find((f) => f.id === localId);
    if (!item) return;
    composer.pendingFiles = composer.pendingFiles.filter((f) => f !== item);
    item.removed = true;
    renderChips(composer);
    if (item.serverId && composer.draftId) deleteDraftFile(composer.draftId, item.serverId);
    // Still uploading: startUpload deletes it once the server id comes back.
  }

  /**
   * @param {ReturnType<typeof bindComposer>} composer
   * @param {FileList|File[]} list
   */
  function addFiles(composer, list) {
    const files = Array.from(list || []);
    let pendingTotal = composer.pendingFiles.reduce((n, p) => n + (p.size || 0), 0);
    /** @type {PendingFile[]} */
    const added = [];
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
        (p) => p.name === file.name && p.size === file.size
      );
      if (dup) continue;
      /** @type {PendingFile} */
      const item = {
        id: localFileId(),
        file,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        serverId: "",
        uploading: false,
      };
      composer.pendingFiles.push(item);
      added.push(item);
      pendingTotal += file.size;
    }
    if (added.length && !draftsApiMissing && window.YanMacApi) {
      const draftId = ensureComposerDraft(composer);
      if (draftId) {
        for (const item of added) startUpload(composer, draftId, item);
      }
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
    historyPointerRow = null;
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

  function draftDisplayTitle(draft) {
    const title = String(draft?.title || "").trim();
    if (title) return title;
    const text = String(draft?.text || "").trim().split("\n")[0];
    if (text) return text.slice(0, 80);
    const file = Array.isArray(draft?.files) ? draft.files[0] : null;
    return file?.name ? String(file.name) : "Draft";
  }

  /**
   * @typedef {{ key: string, title: string, updated: string, sessionId: string, draftId: string,
   *   working: boolean, unread: boolean, pending: boolean, draft: boolean }} HistoryEntry
   */

  /** Chats, new-chat drafts, and local pending sends, newest first. */
  function historyEntries() {
    /** @type {Map<string, HistoryEntry>} */
    const byKey = new Map();
    for (const d of lastDrafts) {
      if (!validDraft(d) || d.sessionId) continue;
      const key = `d:${d.id}`;
      byKey.set(key, {
        key,
        title: draftDisplayTitle(d),
        updated: String(d.updated || d.created || ""),
        sessionId: "",
        draftId: String(d.id),
        working: false,
        unread: false,
        pending: false,
        draft: true,
      });
    }
    for (const chat of lastChats) {
      const sid = String(chat?.sessionId || "");
      if (!sid) continue;
      const key = `s:${sid}`;
      byKey.set(key, {
        key,
        title: chatDisplayTitle(chat),
        updated: String(chat.updated || ""),
        sessionId: sid,
        draftId: "",
        working: Boolean(chat.working) || (sending && sid === sessionId),
        unread: Boolean(chat.unread),
        pending: false,
        draft: false,
      });
    }
    for (const p of pendingRows.values()) {
      const prev = byKey.get(p.key);
      if (p.draftId) byKey.delete(`d:${p.draftId}`);
      const sid = p.sessionId || prev?.sessionId || "";
      byKey.set(p.key, {
        key: p.key,
        title: (prev && !prev.draft && prev.title) || p.title,
        updated: p.updated,
        sessionId: sid,
        draftId: sid ? "" : p.draftId,
        working: Boolean(prev?.working) || (Boolean(sid) && sending && sid === sessionId),
        unread: Boolean(prev?.unread),
        pending: p.pending,
        draft: false,
      });
    }
    return [...byKey.values()].sort(
      (a, b) => (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0)
    );
  }

  /**
   * Row identity for the history list: ids, titles, and day group only. Row
   * state and age are patched in place so a running agent (which rewrites
   * the transcript every bubble) does not rebuild the DOM under the pointer.
   * @param {HistoryEntry[]} entries
   */
  function historyRowsKey(entries) {
    const now = new Date();
    return `rows:${entries
      .map((e) => `${e.key}\0${e.title}\0${chatHistoryGroup(e.updated, now).key}`)
      .join("\n")}`;
  }

  function setBeam(el, on) {
    if (!el) return;
    let ring = el.querySelector(":scope > .yl-beam-ring");
    if (on) {
      window.clearTimeout(el._ylBeamFade);
      el.classList.remove("is-beam-fading");
      if (el.classList.contains("is-beaming")) return;
      if (!ring) {
        ring = document.createElement("span");
        ring.className = "yl-beam-ring";
        ring.setAttribute("aria-hidden", "true");
        const bloom = document.createElement("span");
        bloom.className = "yl-beam-bloom";
        ring.appendChild(bloom);
        el.appendChild(ring);
        void ring.offsetWidth;
      }
      el.classList.add("is-beaming");
      return;
    }
    if (!el.classList.contains("is-beaming")) return;
    el.classList.remove("is-beaming");
    el.classList.add("is-beam-fading");
    el._ylBeamFade = window.setTimeout(() => el.classList.remove("is-beam-fading"), 650);
  }

  /**
   * One state per row, highest first: working > unread > pending > draft.
   * @param {HTMLElement} row
   * @param {HistoryEntry} entry
   */
  function applyRowState(row, entry) {
    const working = entry.working;
    const unread = !working && entry.unread;
    const pending = !working && !unread && entry.pending;
    const draft = !working && !unread && !pending && entry.draft;
    row.classList.toggle("is-working", working);
    row.classList.toggle("is-unread", unread);
    row.classList.toggle("is-pending", pending);
    row.classList.toggle("is-draft", draft);
    setBeam(row, working);
    if (entry.sessionId) {
      row.dataset.sessionId = entry.sessionId;
      delete row.dataset.draftId;
    } else if (entry.draftId) {
      row.dataset.draftId = entry.draftId;
      delete row.dataset.sessionId;
    }
    if (entry.pending) row.dataset.pending = "1";
    else delete row.dataset.pending;
    const title = entry.title || "Chat";
    const suffix = working
      ? ", working"
      : unread
        ? ", unread"
        : pending
          ? ", sending"
          : draft
            ? ", draft"
            : "";
    row.setAttribute("aria-label", `${title}${suffix}`);
  }

  /** @param {HistoryEntry} entry */
  function buildHistoryRow(entry, showAge) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "yan-chat-history-row";
    btn.dataset.rowKey = entry.key;
    const title = document.createElement("span");
    title.className = "yan-chat-history-title";
    title.textContent = entry.title || "Chat";
    btn.appendChild(title);
    if (showAge) {
      const age = document.createElement("span");
      age.className = "yan-chat-history-age";
      age.textContent = relativeChatAge(entry.updated);
      btn.appendChild(age);
    }
    applyRowState(btn, entry);
    return btn;
  }

  /** @param {HistoryEntry[]} entries */
  function patchHistoryRows(entries) {
    if (!historyEl) return;
    const now = new Date();
    for (const entry of entries) {
      const row = historyEl.querySelector(
        `.yan-chat-history-row[data-row-key="${CSS.escape(entry.key)}"]`
      );
      if (!row) continue;
      const age = row.querySelector(".yan-chat-history-age");
      if (age) age.textContent = relativeChatAge(entry.updated, now);
      applyRowState(row, entry);
    }
  }

  /** Paint the sidebar from the cached lists. Cheap; patches when ids/titles match. */
  function renderHistoryList() {
    if (!historyEl) return;
    const entries = historyEntries();
    if (!historyLoaded && !entries.length) return;
    const nextKey = historyRowsKey(entries);
    if (nextKey === historyStructureKey) {
      patchHistoryRows(entries);
      markCurrentHistoryRow();
      return;
    }
    historyStructureKey = nextKey;
    historyEl.innerHTML = "";
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "yan-chat-history-empty";
      empty.textContent = "No past chats yet.";
      historyEl.appendChild(empty);
      return;
    }
    for (const section of groupChatHistory(entries)) {
      const wrap = document.createElement("section");
      wrap.className = "yan-chat-history-section";
      const label = document.createElement("h2");
      label.className = "yan-chat-history-label";
      label.textContent = section.label;
      wrap.appendChild(label);
      for (const entry of section.chats) {
        wrap.appendChild(buildHistoryRow(entry, section.showAge));
      }
      historyEl.appendChild(wrap);
    }
    markCurrentHistoryRow();
  }

  function anyChatWorking() {
    return sending || lastChats.some((c) => c && c.working);
  }

  /** Thread panel beams while the viewed chat runs; the closed circle beams for any run. */
  function syncBeams() {
    const closed = state() === "closed";
    setBeam(threadComposer.panel, sending && !closed);
    setBeam(historyComposer.pill, closed && anyChatWorking());
    const poll = closed && lastChats.some((c) => c && c.working);
    if (!poll) {
      window.clearTimeout(launcherTimer);
      launcherTimer = 0;
    } else if (!launcherTimer) {
      launcherTimer = window.setTimeout(() => {
        launcherTimer = 0;
        refreshChats().catch(() => {});
      }, LAUNCHER_POLL_MS);
    }
  }

  /** Pull remote draft edits into idle composers; last write wins by `updated`. */
  function syncComposersFromDrafts(fetchStartedAt) {
    for (const composer of composers) {
      if (composerBusy(composer)) continue;
      if (composer.draftTouchedAt > fetchStartedAt) continue;
      if (composer.draftId) {
        const remote = lastDrafts.find((d) => d.id === composer.draftId);
        if (!remote) {
          // Sent or cleared on another device.
          unbindComposerDraft(composer);
          clearComposerUi(composer);
          continue;
        }
        const remoteAt = Date.parse(remote.updated || "") || 0;
        const localAt = Date.parse(composer.draftUpdated || "") || 0;
        if (remoteAt > localAt) applyDraftToComposer(composer, remote);
        continue;
      }
      if (composer.role !== "thread" || !sessionId) continue;
      if (String(composer.input?.value || "") || composer.pendingFiles.length) continue;
      const saved = lastDrafts.find((d) => d.id === `s-${sessionId}`);
      if (saved) applyDraftToComposer(composer, saved);
    }
  }

  /** Drop pending rows once GET chats lists their session. */
  function prunePendingRows() {
    const known = new Set(lastChats.map((c) => String(c?.sessionId || "")));
    for (const [id, p] of pendingRows) {
      if (!p.pending && p.sessionId && known.has(p.sessionId)) pendingRows.delete(id);
    }
  }

  async function refreshChats() {
    if (!window.YanMacApi) return;
    const fetchGen = ++historyFetchGen;
    const startedAt = Date.now();
    try {
      const res = await window.YanMacApi.macFetch(`${API}/agent/chats`, {
        method: "GET",
        timeoutMs: 30_000,
      });
      const data = await res.json().catch(() => ({}));
      if (fetchGen !== historyFetchGen) return;
      if (!res.ok) throw new Error(data.error || `chats failed (${res.status})`);
      lastChats = Array.isArray(data.chats) ? data.chats : [];
      if (Array.isArray(data.drafts)) {
        lastDrafts = data.drafts.filter(validDraft);
        syncComposersFromDrafts(startedAt);
      }
      historyLoaded = true;
      prunePendingRows();
      renderHistoryList();
      syncBeams();
    } catch {
      if (fetchGen !== historyFetchGen || !historyEl) return;
      syncBeams();
      if (historyLoaded) return;
      historyStructureKey = "";
      if (!showingHistory) return;
      historyEl.innerHTML = "";
      const empty = document.createElement("p");
      empty.className = "yan-chat-history-empty";
      empty.textContent = "Could not load past chats.";
      historyEl.appendChild(empty);
    }
  }

  function renderHistory() {
    return refreshChats();
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
    if (id !== sessionId) resetComposer(threadComposer);
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
      restoreSessionDraft();
      setState("panel", { focusComposer: threadComposer });
      if (data.status === "running") {
        setBusy(true);
        setBusyLabel(data.workingLabel || "Working…");
        startPolling();
      } else {
        setBusy(false);
      }
      refreshChats().catch(() => {});
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

  /** Put a saved `s-<sessionId>` draft back into an empty thread composer. */
  function restoreSessionDraft() {
    const composer = threadComposer;
    if (!sessionId || composer.draftId) return;
    if (String(composer.input?.value || "") || composer.pendingFiles.length) return;
    const saved = lastDrafts.find((d) => d.id === `s-${sessionId}`);
    if (saved) applyDraftToComposer(composer, saved);
  }

  /** Leave the current thread view without stopping its run. */
  function detachThreadView() {
    viewGen += 1;
    stopPolling();
    sessionId = null;
    messages = [];
    sending = false;
    root.classList.remove("is-busy");
    clearMessagesDom();
    persistLocal();
  }

  /** Open a new-chat draft: empty thread, its text and files in the composer. */
  function openDraft(id) {
    const draft = lastDrafts.find((d) => d.id === id);
    if (!draft) return;
    if (threadComposer.draftId !== id) {
      if (messages.length || sending || sessionId) detachThreadView();
      resetComposer(threadComposer);
      if (historyComposer.draftId === id) {
        // Same draft is live in the new-chat composer: move it over as is.
        const from = historyComposer;
        const dirty = from.dirty || Boolean(from.saveTimer);
        threadComposer.draftId = from.draftId;
        threadComposer.draftSessionId = from.draftSessionId;
        threadComposer.draftUpdated = from.draftUpdated;
        threadComposer.draftTouchedAt = from.draftTouchedAt;
        if (threadComposer.input) threadComposer.input.value = String(from.input?.value || "");
        threadComposer.pendingFiles = from.pendingFiles;
        from.pendingFiles = [];
        unbindComposerDraft(from);
        clearComposerUi(from);
        renderChips(threadComposer);
        syncComposerSize(threadComposer);
        if (dirty) onComposerEdit(threadComposer);
      } else {
        applyDraftToComposer(threadComposer, draft);
      }
    }
    showThread = true;
    if (wideEnough()) showingHistory = true;
    else hideHistory();
    setState("panel", { focusComposer: threadComposer });
    renderHistoryList();
  }

  function showPendingThread() {
    showThread = true;
    if (wideEnough()) showingHistory = true;
    else hideHistory();
    setState("panel", { focusComposer: threadComposer });
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
    const viewedDraft = !sessionId && showThread ? threadComposer.draftId : null;
    historyEl.querySelectorAll(".yan-chat-history-row").forEach((row) => {
      const on = sessionId
        ? row.dataset.sessionId === sessionId
        : Boolean(viewedDraft) && row.dataset.draftId === viewedDraft;
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
    closeThreadBtns.forEach((btn) => {
      btn.setAttribute("aria-label", dual ? "Hide this chat" : "Close this chat");
    });
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
    syncBeams();
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
    removeWorkingEl();
    messagesEl.innerHTML = "";
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
        pending: Boolean(m.pending),
        queueId: m.queued && m.queueId ? String(m.queueId) : "",
        widgets: m.widgets || null,
      }))
    );
  }

  function setBusyLabel(next) {
    const label = String(next || "").trim() || "Working…";
    if (busyLabel === label) return;
    busyLabel = label;
    workingEl?.setAttribute("aria-label", busyLabel);
  }

  function removeWorkingEl() {
    workingOrb?.destroy();
    workingOrb = null;
    workingEl?.remove();
    workingEl = null;
  }

  /** chat-orb.js is a deferred module; mount once it has set window.YLOrb. */
  function mountWorkingOrb() {
    if (!workingEl || workingOrb || !workingEl.isConnected) return;
    const canvas = workingEl.querySelector(".yan-chat-working-orb");
    if (!canvas) return;
    if (window.YLOrb && typeof window.YLOrb.mount === "function") {
      workingOrb = window.YLOrb.mount(canvas, { size: 48 });
      return;
    }
    if (orbWaiting) return;
    orbWaiting = true;
    window.addEventListener(
      "ylorb-ready",
      () => {
        orbWaiting = false;
        mountWorkingOrb();
      },
      { once: true }
    );
  }

  function syncWorkingEl() {
    if (!messagesEl) return;
    if (!sending) {
      removeWorkingEl();
      return;
    }
    let created = false;
    if (!workingEl) {
      workingEl = document.createElement("div");
      workingEl.className =
        "yan-chat-bubble yan-chat-bubble--assistant yan-chat-working";
      workingEl.dataset.liquidGlass = "rounded";
      workingEl.dataset.filterId = "lg-edu-chat-working";
      workingEl.setAttribute("role", "status");
      workingEl.setAttribute("aria-label", busyLabel);
      const canvas = document.createElement("canvas");
      canvas.className = "yan-chat-working-orb";
      canvas.width = 80;
      canvas.height = 80;
      canvas.setAttribute("aria-hidden", "true");
      workingEl.appendChild(canvas);
      created = true;
    }
    const firstQueued = [...messagesEl.querySelectorAll(":scope > .yan-chat-turn")].find(
      (el) =>
        el.classList.contains("yan-chat-turn--queued") ||
        el.classList.contains("yan-chat-turn--pending")
    );
    if (firstQueued) {
      if (workingEl.nextSibling !== firstQueued) {
        messagesEl.insertBefore(workingEl, firstQueued);
      }
    } else if (messagesEl.lastElementChild !== workingEl) {
      messagesEl.appendChild(workingEl);
    }
    mountWorkingOrb();
    if (created) refreshGlass();
  }

  function syncQueuedTurn(turn, msg) {
    const queued = Boolean(msg && msg.queued);
    turn.classList.toggle("yan-chat-turn--pending", Boolean(msg && msg.pending) && !queued);
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
   * @param {{ queued?: boolean, pending?: boolean }} [opts]
   */
  function appendBubble(role, text, opts = {}) {
    /** @type {{ role: string, content: string, queued?: boolean, pending?: boolean }} */
    const msg = { role, content: text };
    if (opts.queued) msg.queued = true;
    else if (opts.pending) msg.pending = true;
    messages.push(msg);
    renderMessagesDom({ forceScroll: true });
    persistLocal();
    return msg;
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
    if (!next && sessionId) {
      const chat = lastChats.find((c) => c && c.sessionId === sessionId);
      if (chat) chat.working = false;
    }
    renderHistoryList();
    syncBeams();
    if (wasSending && !next) refreshChats().catch(() => {});
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
    // Sends the server has not accepted yet stay at the end.
    next.push(...messages.filter((m) => m && m.pending));
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
    const items = composer.pendingFiles.slice();
    if (!text && !items.length) return;
    if (!fresh && !interrupt && queueFull()) return;

    const draftId = composer.draftId;
    const draftSessionId = composer.draftSessionId;
    const saveInFlight = draftId ? draftSaves.get(draftId) : null;

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
      (items.length
        ? `${text ? "\n" : ""}[${items.length} file${items.length === 1 ? "" : "s"}: ${items
            .map((f) => f.name)
            .join(", ")}]`
        : "");
    const willQueue = !fresh && sending && !interrupt;
    // Idle chat: show the turn faded until the server accepts it. No orb or
    // beam yet. A busy chat keeps the queued / interrupt path.
    const usePending = !sending;
    const localMsg = appendBubble("user", label || "(attachment)", {
      queued: willQueue,
      pending: usePending,
    });
    resetComposer(composer, { flush: false });
    setState("panel", { skipFocus: true });
    flyUserBubble(originRect);
    if (!usePending) {
      updateComposerEnabled();
      startPolling();
    }
    preferPanel = true;
    const sendGen = viewGen;

    let rowId = "";
    if (usePending) {
      rowId = localFileId();
      const draftRow = Boolean(draftId) && !draftSessionId;
      const followUp = !fresh && sessionId ? sessionId : "";
      pendingRows.set(rowId, {
        key: followUp ? `s:${followUp}` : draftRow ? `d:${draftId}` : `p:${rowId}`,
        title: (text.split("\n")[0] || items[0]?.name || "Chat").slice(0, 80),
        updated: new Date().toISOString(),
        sessionId: followUp,
        draftId: draftRow ? String(draftId) : "",
        pending: true,
      });
      renderHistoryList();
    }
    const dropPendingRow = () => {
      if (rowId && pendingRows.delete(rowId)) renderHistoryList();
    };

    const removeLocalMsg = () => {
      const idx = messages.lastIndexOf(localMsg);
      if (idx >= 0) messages.splice(idx, 1);
    };

    const restoreComposer = () => {
      const target = !composer.column.hidden ? composer : threadComposer;
      if (target.draftId || String(target.input?.value || "") || target.pendingFiles.length) {
        return;
      }
      target.draftId = draftId;
      target.draftSessionId = draftSessionId;
      target.draftUpdated = "";
      if (target.input) target.input.value = text;
      target.pendingFiles = items.filter((f) => !f.removed);
      renderChips(target);
      syncComposerSize(target);
      if (draftId && text) onComposerEdit(target);
    };

    let accepted = false;
    try {
      const waitUploads = Promise.all([
        saveInFlight ? saveInFlight.catch(() => {}) : null,
        ...items.map((f) => (f.upload ? f.upload.catch(() => {}) : null)),
      ]);
      const [sid] = await Promise.all([ensureSession(), waitUploads]);
      const fallback = items.filter((f) => !f.removed && !f.serverId && f.file);
      /** @type {{ name: string, mimeType: string, data: string }[]} */
      const attachments = await Promise.all(fallback.map((f) => fileToAttachment(f.file)));
      /** @type {Record<string, unknown>} */
      const body = { sessionId: sid, message: text };
      const sendDraft =
        Boolean(draftId) && (draftOnServer(draftId) || items.some((f) => f.serverId));
      if (sendDraft) body.draftId = draftId;
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
      const stale = sendGen !== viewGen || Boolean(sid && sessionId && sid !== sessionId);
      if (!res.ok) {
        dropPendingRow();
        if (stale) {
          refreshChats().catch(() => {});
          return;
        }
        // Drop the optimistic bubble on failure.
        removeLocalMsg();
        if (!willQueue && !usePending) setBusy(false);
        else renderMessagesDom();
        restoreComposer();
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
      accepted = true;
      // The server deleted the draft when it took the message.
      if (sendDraft) removeLocalDraft(String(draftId));
      const row = rowId ? pendingRows.get(rowId) : null;
      if (row) {
        row.pending = false;
        row.sessionId = sid;
        row.key = `s:${sid}`;
        row.draftId = "";
      }
      if (stale) {
        renderHistoryList();
        refreshChats().catch(() => {});
        return;
      }
      // The 202 means the prompt reached the model. Clearing the flag can leave
      // the fingerprint unchanged, so always re-render to drop the fade.
      delete localMsg.pending;
      if (Array.isArray(data.messages)) applyServerMessages(data.messages);
      renderMessagesDom();
      persistLocal();
      setBusy(true);
      setState("panel", { skipFocus: true });
      refreshChats().catch(() => {});
      // Keep busy + poll until assistant reply lands (and queue drains).
      startPolling();
      await pollState();
    } catch (err) {
      if (accepted) {
        console.error("[edu-chat] after send", err);
        return;
      }
      dropPendingRow();
      if (sendGen !== viewGen) {
        refreshChats().catch(() => {});
        return;
      }
      console.error("[edu-chat]", err);
      removeLocalMsg();
      if (!willQueue && !usePending) setBusy(false);
      else renderMessagesDom();
      restoreComposer();
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
    composers.forEach((composer) => resetComposer(composer));
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

    input?.addEventListener("input", () => {
      syncComposerSize(composer);
      onComposerEdit(composer);
    });

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

  /** @param {Element|null|undefined} row */
  function historyRowRef(row) {
    if (!row) return null;
    const el = /** @type {HTMLElement} */ (row);
    return {
      sid: el.dataset.sessionId || "",
      draftId: el.dataset.draftId || "",
      pending: el.dataset.pending === "1",
    };
  }

  historyEl?.addEventListener("pointerdown", (event) => {
    if (event.button && event.button !== 0) return;
    historyPointerRow = historyRowRef(event.target.closest?.(".yan-chat-history-row"));
  });
  historyEl?.addEventListener("pointercancel", () => {
    historyPointerRow = null;
  });
  historyEl?.addEventListener("click", (event) => {
    const ref =
      historyPointerRow || historyRowRef(event.target.closest?.(".yan-chat-history-row"));
    historyPointerRow = null;
    if (!ref) return;
    if (ref.sid) openHistoryChat(ref.sid);
    else if (ref.pending) showPendingThread();
    else if (ref.draftId) openDraft(ref.draftId);
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

  /** @type {HTMLElement|null} */
  let dropTarget = null;

  /** The one box (input pill or the panel above it) under the drag. */
  function dropBox(node) {
    const el = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
    const box = el?.closest?.(".yan-chat-pill, .yan-chat-panel");
    return box && composerFromNode(box) ? /** @type {HTMLElement} */ (box) : null;
  }

  function setDropTarget(el) {
    if (dropTarget === el) return;
    dropTarget?.classList.remove("is-drop-target");
    dropTarget = el;
    dropTarget?.classList.add("is-drop-target");
  }

  function onDragEnter(event) {
    const composer = composerFromNode(event.target);
    if (!isFileDrag(event) || !composer) return;
    event.preventDefault();
    setDropTarget(dropBox(event.target));
    if (state() === "closed") openChat();
  }

  function onDragOver(event) {
    const composer = composerFromNode(event.target);
    if (!isFileDrag(event) || !composer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropTarget(dropBox(event.target));
  }

  function onDragLeave(event) {
    if (!isFileDrag(event)) return;
    setDropTarget(dropBox(event.relatedTarget));
  }

  function onDrop(event) {
    setDropTarget(null);
    const composer = composerFromNode(event.target);
    if (!composer) return;
    const files = filesFromDrop(event);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
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
  window.addEventListener("drop", () => setDropTarget(null), true);
  window.addEventListener("dragend", () => setDropTarget(null));

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAllDraftsKeepalive();
  });
  window.addEventListener("pagehide", flushAllDraftsKeepalive);

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
    refreshChats().catch(() => {});
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
    // The closed circle needs the chat list to know if anything is running.
    if (!historyLoaded && window.YanMacApi) refreshChats().catch(() => {});
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
