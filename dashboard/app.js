(function () {
  const LOGIN_FLAG = "yl_login_recorded";

  const stages = {
    loading: document.getElementById("stage-loading"),
    login: document.getElementById("stage-login"),
    denied: document.getElementById("stage-denied"),
    full: document.getElementById("stage-full"),
  };

  const listEl = document.getElementById("dash-list");
  const loginListEl = document.getElementById("login-list");
  const agentsEl = document.getElementById("dash-agents");

  const AGENT_BANDS = [
    {
      time: "every 4h",
      items: [
        {
          id: "compose-4h",
          name: "Location compose",
          model: "Composer 2.5",
          kind: "clock",
        },
      ],
    },
    {
      time: "01:00",
      items: [
        {
          id: "compose-0100",
          name: "Location compose",
          model: "Composer 2.5",
          kind: "clock",
        },
        { edge: true },
        {
          id: "enrichment",
          name: "Location enrichment",
          model: "Grok 4.6 high",
          kind: "after",
        },
        { gap: true },
        {
          id: "takeaways",
          name: "Health takeaways",
          model: "Composer 2.5",
          kind: "clock",
        },
        {
          id: "canvas",
          name: "Canvas LMS sync",
          model: "Grok 4.6 high",
          kind: "clock",
        },
      ],
    },
    {
      time: "01:30",
      items: [
        {
          id: "titles",
          name: "Chat title refresh",
          model: "Composer 2.5",
          kind: "clock",
        },
      ],
    },
    {
      time: "02:30",
      items: [
        {
          id: "triage",
          name: "Nightly triage",
          model: "Composer 2.5",
          kind: "clock",
        },
        { edge: true },
        {
          id: "entities",
          name: "Nightly entities",
          model: "Composer 2.5",
          kind: "after",
        },
        { edge: true },
        {
          id: "synthesis",
          name: "Nightly synthesis",
          model: "Grok 4.6 xhigh",
          kind: "after",
        },
        { edge: true },
        {
          id: "actions",
          name: "Nightly actions",
          model: "Grok 4.6 high",
          kind: "after",
          optional: true,
        },
        { edge: true },
        {
          id: "lint",
          name: "Nightly lint",
          model: "Composer 2.5",
          kind: "after",
        },
      ],
    },
    {
      time: "03:00",
      items: [
        {
          id: "location-brain",
          name: "Location brain",
          model: "Composer 2.5",
          kind: "clock",
        },
        { edge: true, wait: true },
        {
          id: "health-brain",
          name: "Health brain",
          model: "Composer 2.5",
          kind: "clock",
        },
        { edge: true, wait: true },
        {
          id: "fact-check",
          name: "Nightly fact-check",
          model: "Grok 4.6 xhigh",
          kind: "after",
        },
      ],
    },
    {
      time: "06:00",
      items: [
        {
          id: "briefing",
          name: "Daily briefing",
          model: "Grok 4.6 xhigh",
          kind: "clock",
        },
      ],
    },
  ];

  function show(name) {
    Object.keys(stages).forEach((key) => {
      const el = stages[key];
      if (!el) return;
      el.hidden = key !== name;
    });
    queueMicrotask(() => window.reinitLiquidGlass?.());
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function shortWhen(entry) {
    const raw = entry.when || entry.utc || "";
    if (!raw) return "";
    // "Wed, Jul 29, 2026 · 9:05:12 PM PDT" → "Jul 29 · 9:05 PM"
    const m = String(raw).match(
      /([A-Za-z]{3})\s+(\d{1,2}),\s+\d{4}\s*·\s*(\d{1,2}:\d{2})(?::\d{2})?\s*(AM|PM)/
    );
    if (m) return `${m[1]} ${m[2]} · ${m[3]} ${m[4]}`;
    return String(raw);
  }

  function entryKey(entry, index) {
    return [entry.utc || "", entry.session || "", entry.turn ?? "", index].join(
      "|"
    );
  }

  function renderChatEntry(entry, index) {
    const id = `lg-chat-${index}`;
    return `<li
      class="dash-entry"
      data-liquid-glass="rounded"
      data-lg-radius="18"
      data-filter-id="${escapeHtml(id)}"
      data-key="${escapeHtml(entryKey(entry, index))}"
    >
      <div class="dash-entry-in">
        <p class="dash-when">${escapeHtml(shortWhen(entry))}</p>
        <pre class="dash-text">${escapeHtml(entry.user || "")}</pre>
        <pre class="dash-text is-assistant">${escapeHtml(entry.assistant || "")}</pre>
      </div>
    </li>`;
  }

  function renderLoginEntry(entry, index) {
    const email = entry.email || "";
    const id = `lg-login-${index}`;
    return `<li
      class="dash-login"
      data-liquid-glass="rounded"
      data-lg-radius="22"
      data-filter-id="${escapeHtml(id)}"
      data-key="${escapeHtml(`${entry.utc || ""}|${email}|${index}`)}"
      title="${escapeHtml(entry.when || "")}"
    ><span>${escapeHtml(email)}</span></li>`;
  }

  function resetRailScroll(el) {
    if (!el) return;
    el.scrollLeft = 0;
  }

  function renderChats(entries) {
    if (!listEl) return;
    listEl.innerHTML = entries.map(renderChatEntry).join("");
    resetRailScroll(listEl);
    queueMicrotask(() => window.reinitLiquidGlass?.());
  }

  function renderAgentItem(item) {
    if (item.gap) return `<span class="dash-agent-gap" aria-hidden="true"></span>`;
    if (item.edge) {
      const wait = item.wait ? " is-wait" : "";
      return `<span class="dash-agent-edge${wait}" aria-hidden="true"></span>`;
    }
    const clock = item.kind === "clock";
    const optional = item.optional ? " is-optional" : "";
    const kindClass = clock ? "dash-agent--clock" : "dash-agent--after";
    const radius = clock ? "" : ' data-lg-radius="22"';
    return `<article class="dash-agent ${kindClass}${optional}" data-liquid-glass="${
      clock ? "circle" : "rounded"
    }"${radius} data-filter-id="lg-agent-${escapeHtml(item.id)}">
      <p class="dash-agent-name">${escapeHtml(item.name)}</p>
      <p class="dash-agent-model">${escapeHtml(item.model)}</p>
    </article>`;
  }

  function renderAgents() {
    if (!agentsEl || agentsEl.dataset.ready === "1") return;
    agentsEl.innerHTML = AGENT_BANDS.map((band) => {
      const row = band.items.map(renderAgentItem).join("");
      return `<div class="dash-agent-band">
        <p class="dash-agent-time">${escapeHtml(band.time)}</p>
        <div class="dash-agent-row">${row}</div>
      </div>`;
    }).join("");
    agentsEl.dataset.ready = "1";
    queueMicrotask(() => window.reinitLiquidGlass?.());
  }

  function renderLogins(entries) {
    if (!loginListEl) return;
    loginListEl.innerHTML = entries.map(renderLoginEntry).join("");
    resetRailScroll(loginListEl);
    queueMicrotask(() => window.reinitLiquidGlass?.());
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function fetchChatLog() {
    const { res, data } = await fetchJson("/api/dashboard/chat-log");
    if (res.status === 401) {
      show("login");
      return null;
    }
    if (res.status === 403) {
      show("denied");
      return null;
    }
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `chat-log failed (${res.status})`);
    }
    return data;
  }

  async function fetchLoginLog() {
    const { res, data } = await fetchJson("/api/dashboard/login-log");
    if (res.status === 401) {
      show("login");
      return null;
    }
    if (res.status === 403) {
      show("denied");
      return null;
    }
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `login-log failed (${res.status})`);
    }
    return data;
  }

  /** One-shot: ensure current session is in the login log (covers pre-fix cookies). */
  async function ensureLoginRecorded() {
    try {
      if (sessionStorage.getItem(LOGIN_FLAG) === "1") return;
      sessionStorage.setItem(LOGIN_FLAG, "1");
      await fetchJson("/api/dashboard/login-log", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    } catch (_) {
      /* non-fatal — OAuth callback is the primary writer */
      try {
        sessionStorage.removeItem(LOGIN_FLAG);
      } catch (_) {}
    }
  }

  async function loadOnce() {
    try {
      const [chat, logins] = await Promise.all([
        fetchChatLog(),
        fetchLoginLog(),
      ]);
      if (!chat || !logins) return;
      renderChats(Array.isArray(chat.entries) ? chat.entries : []);
      renderLogins(Array.isArray(logins.entries) ? logins.entries : []);
    } catch (err) {
      console.error("[dashboard]", err);
    }
  }

  async function boot() {
    show("loading");
    try {
      const res = await fetch("/api/auth/session", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.authenticated) {
        show("login");
        return;
      }
      if (data.access === "full") {
        show("full");
        renderAgents();
        await ensureLoginRecorded();
        await loadOnce();
        return;
      }
      show("denied");
    } catch (_) {
      show("login");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
