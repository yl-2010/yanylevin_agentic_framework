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
  const actionsEl = document.getElementById("action-list");
  const agentsEl = document.getElementById("dash-agents");

  const AGENT_BANDS = [
    {
      time: "every 5m",
      items: [
        {
          id: "life-state",
          name: "Life state",
          model: "Composer 2.5",
          kind: "clock",
        },
      ],
    },
    {
      time: "hourly",
      items: [
        {
          id: "home-agent",
          name: "Home agent",
          model: "Composer 2.5",
          kind: "clock",
        },
        {
          id: "canvas-hourly",
          name: "Canvas hourly",
          model: "Composer 2.5",
          kind: "clock",
        },
      ],
    },
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
          model: "Grok 4.7 xhigh",
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
          model: "Grok 4.7 xhigh",
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
        {
          id: "life-state-cleanup",
          name: "Life-state cleanup",
          model: "Grok 4.7 xhigh",
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
          model: "Grok 4.7 xhigh",
          kind: "after",
        },
        { edge: true },
        {
          id: "actions",
          name: "Nightly actions",
          model: "Grok 4.7 xhigh",
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
          model: "Grok 4.7 xhigh",
          kind: "after",
        },
      ],
    },
    {
      time: "06:00",
      items: [
        {
          id: "briefing-news",
          name: "Daily news",
          model: "Grok 4.7 xhigh",
          kind: "clock",
        },
        { edge: true },
        {
          id: "briefing-recap",
          name: "Agent recap",
          model: "Grok 4.7 xhigh",
          kind: "after",
        },
        { edge: true },
        {
          id: "briefing-unslop",
          name: "Unslop",
          model: "Composer 2.5",
          kind: "after",
        },
      ],
    },
    {
      time: "message or email",
      items: [
        {
          id: "jev-calendar",
          name: "Jev",
          model: "yes or no",
          kind: "clock",
        },
        { edge: true },
        {
          id: "calendar-on-demand",
          name: "Calendar",
          model: "Composer 2.5",
          kind: "after",
        },
      ],
    },
    {
      time: "you @agent",
      items: [
        {
          id: "you-mention",
          name: "iMessage or Teams",
          model: "Grok 4.7",
          kind: "clock",
        },
      ],
    },
    {
      time: "someone @agent",
      items: [
        {
          id: "guest-agent",
          name: "Guest",
          model: "Composer 2.5",
          kind: "clock",
        },
      ],
    },
    {
      time: "@agentg",
      items: [
        {
          id: "agentg",
          name: "Guest",
          model: "Grok 4.7",
          kind: "clock",
        },
      ],
    },
    {
      time: "your chat",
      items: [
        {
          id: "personal",
          name: "Personal agent",
          model: "Grok 4.7",
          kind: "clock",
        },
      ],
    },
    {
      time: "JYPE site",
      items: [
        {
          id: "jype",
          name: "JYPE agent",
          model: "Grok 4.7",
          kind: "clock",
        },
      ],
    },
    {
      time: "fitness",
      items: [
        {
          id: "fitness",
          name: "Fitness",
          model: "Composer 2.5",
          kind: "clock",
        },
      ],
    },
    {
      time: "public question",
      items: [
        {
          id: "public-faq",
          name: "Site FAQ",
          model: "GPT-OSS 20b",
          kind: "clock",
        },
      ],
    },
    {
      time: "after a reply",
      items: [
        {
          id: "brain-extraction",
          name: "Brain extraction",
          model: "Composer 2.5",
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

  function renderActionEntry(entry, index) {
    const id = `lg-action-${index}`;
    return `<li
      class="dash-entry dash-action"
      data-liquid-glass="rounded"
      data-lg-radius="18"
      data-filter-id="${escapeHtml(id)}"
      data-key="${escapeHtml(`${entry.utc || ""}|${entry.kind || ""}|${index}`)}"
    >
      <div class="dash-entry-in">
        <p class="dash-when">${escapeHtml(shortWhen(entry))}</p>
        <p class="dash-action-agent">${escapeHtml(entry.agentName || entry.agent || "")}</p>
        <p class="dash-action-line">${escapeHtml(entry.summary || "")}</p>
      </div>
    </li>`;
  }

  function renderEmptyAction() {
    return `<li
      class="dash-entry dash-action is-empty"
      data-liquid-glass="rounded"
      data-lg-radius="18"
      data-filter-id="lg-action-empty"
    >
      <div class="dash-entry-in">
        <p class="dash-action-line">No actions yet</p>
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

  function renderActions(entries) {
    if (!actionsEl) return;
    const rows = entries.length
      ? entries.map(renderActionEntry)
      : [renderEmptyAction()];
    actionsEl.innerHTML = rows.join("");
    resetRailScroll(actionsEl);
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

  async function fetchAgentActions() {
    const { res, data } = await fetchJson("/api/dashboard/agent-actions");
    if (res.status === 401) {
      show("login");
      return null;
    }
    if (res.status === 403) {
      show("denied");
      return null;
    }
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `agent-actions failed (${res.status})`);
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
      const [chat, logins, actions] = await Promise.all([
        fetchChatLog(),
        fetchLoginLog(),
        fetchAgentActions(),
      ]);
      if (!chat || !logins || !actions) return;
      renderChats(Array.isArray(chat.entries) ? chat.entries : []);
      renderLogins(Array.isArray(logins.entries) ? logins.entries : []);
      renderActions(Array.isArray(actions.entries) ? actions.entries : []);
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
