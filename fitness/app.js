/**
 * /fitness — view-only gym history.
 * Data/SSE: Mac api.yanylevin.com via YanMacApi (not Vercel Fluid).
 * Auth session stays same-origin on Vercel.
 */
(() => {
  const stages = {
    loading: document.getElementById("stage-loading"),
    login: document.getElementById("stage-login"),
    denied: document.getElementById("stage-denied"),
    full: document.getElementById("stage-full"),
  };
  const appEl = document.getElementById("fit-app");

  const OVERVIEW_ID = "__overview__";
  const RANGE_OPTIONS = [
    { key: "10", label: "10", n: 10 },
    { key: "25", label: "25", n: 25 },
    { key: "50", label: "50", n: 50 },
    { key: "100", label: "100", n: 100 },
    { key: "all", label: "All", n: null },
  ];
  const MACHINE_COLORS = [
    "#1b7d8a",
    "#c45c26",
    "#3d6b3d",
    "#8b4d9a",
    "#b8860b",
    "#2f5d9f",
    "#a63d4a",
    "#5a6a7a",
  ];
  const RANGE_KEY = "yl-fit-chart-range";
  const OVERVIEW_FILTER_KEY = "yl-fit-overview-machines";

  /** @type {any} */
  let tree = null;
  /** @type {string} */
  let selectedId = OVERVIEW_ID;
  /** @type {string} */
  let chartRange = loadRange();
  /** @type {Set<string>} */
  let overviewVisible = new Set();
  let fingerprint = "";
  let didEntrance = false;
  let overviewBootstrapped = false;

  function loadRange() {
    try {
      const v = localStorage.getItem(RANGE_KEY);
      if (RANGE_OPTIONS.some((o) => o.key === v)) return /** @type {string} */ (v);
    } catch {
      /* ignore */
    }
    return "50";
  }

  function saveRange(key) {
    chartRange = key;
    try {
      localStorage.setItem(RANGE_KEY, key);
    } catch {
      /* ignore */
    }
  }

  function loadOverviewVisible(machines) {
    try {
      const raw = localStorage.getItem(OVERVIEW_FILTER_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) {
          const ids = new Set(machines.map((m) => m.id));
          const kept = arr.map(String).filter((id) => ids.has(id));
          if (kept.length) return new Set(kept);
        }
      }
    } catch {
      /* ignore */
    }
    return new Set(machines.map((m) => m.id));
  }

  function saveOverviewVisible() {
    try {
      localStorage.setItem(
        OVERVIEW_FILTER_KEY,
        JSON.stringify([...overviewVisible])
      );
    } catch {
      /* ignore */
    }
  }

  function showStage(name) {
    for (const [k, el] of Object.entries(stages)) {
      if (!el) continue;
      el.hidden = k !== name;
    }
  }

  async function fetchSession() {
    const res = await fetch("/api/auth/session", { credentials: "include" });
    if (!res.ok) return null;
    return res.json();
  }

  async function loadTree() {
    const mac = window.YanMacApi;
    if (!mac) throw new Error("YanMacApi missing");
    const res = await mac.macFetch("/api/fitness/data", { timeoutMs: 30_000 });
    if (res.status === 401) return { unauthorized: true };
    if (res.status === 403) return { forbidden: true };
    if (!res.ok) throw new Error(`data ${res.status}`);
    return res.json();
  }

  function treeFingerprint(t) {
    try {
      return JSON.stringify(t?.machines || []);
    } catch {
      return String(Date.now());
    }
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatWhen(iso) {
    try {
      const d = new Date(iso);
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(d);
    } catch {
      return iso;
    }
  }

  /** Pacific date keys before this collapse into one "Historical" session. */
  const HISTORICAL_BEFORE = "2026-08-08";
  const HISTORICAL_KEY = "historical";

  function isHistoricalDay(key) {
    return Boolean(key) && key !== "unknown" && key < HISTORICAL_BEFORE;
  }

  function sessionGroupKey(dateKey) {
    return isHistoricalDay(dateKey) ? HISTORICAL_KEY : dateKey || "unknown";
  }

  function formatDay(key) {
    if (key === HISTORICAL_KEY) return "Historical";
    try {
      const d = new Date(`${key}T12:00:00-07:00`);
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(d);
    } catch {
      return key;
    }
  }

  function machineHistory(machine) {
    const hist = machine?.history;
    if (Array.isArray(hist) && hist.length) return hist;
    return machine?.graph || [];
  }

  function sliceByRange(points) {
    const opt = RANGE_OPTIONS.find((o) => o.key === chartRange) || RANGE_OPTIONS[2];
    if (opt.n == null || points.length <= opt.n) return points;
    return points.slice(-opt.n);
  }

  function selectedMachine() {
    const machines = tree?.machines || [];
    if (!machines.length) return null;
    if (selectedId === OVERVIEW_ID) return null;
    return machines.find((m) => m.id === selectedId) || machines[0];
  }

  function machineColor(machine, index) {
    const raw = machine?.color;
    if (typeof raw === "string") {
      let s = raw.trim();
      if (s && s[0] !== "#") s = `#${s}`;
      if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
    }
    return MACHINE_COLORS[index % MACHINE_COLORS.length];
  }

  function machineAbbrev(name) {
    const words = String(name || "")
      .replace(/\d+x\d+/gi, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) return "?";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  function rangeControlsHtml(shown, total) {
    const count =
      total != null
        ? `<span class="fit-range-count">${esc(shown)} of ${esc(total)}</span>`
        : "";
    return `<div class="fit-chart-toolbar">
      <div class="fit-range" role="group" aria-label="Chart range">
      ${RANGE_OPTIONS.map(
        (o) =>
          `<button type="button" class="fit-range-btn" data-range="${esc(o.key)}" aria-pressed="${
            chartRange === o.key ? "true" : "false"
          }">${esc(o.label)}</button>`
      ).join("")}
      </div>
      ${count}
    </div>`;
  }

  function overviewFilterHtml(machines) {
    return `<div class="edu-filters fit-machine-filters" role="group" aria-label="Machine filters">${machines
      .map((m, i) => {
        const on = overviewVisible.has(m.id);
        const color = machineColor(m, i);
        const abbr = machineAbbrev(m.name);
        return `<label
          class="edu-filter circle${on ? " is-on" : ""}"
          data-liquid-glass="circle"
          data-filter-id="lg-fit-filter-${esc(m.id)}"
          title="${esc(m.name)}"
          aria-label="${esc(m.name)}"
          style="--fit-filter-color:${color}"
        ><input type="checkbox" data-machine-filter="${esc(m.id)}" ${
          on ? "checked" : ""
        } /><span>${esc(abbr)}</span></label>`;
      })
      .join("")}</div>`;
  }

  /**
   * @param {{ weight: number, at?: string, dateKey?: string }[]} points
   * @param {{ color?: string, ariaLabel?: string }} [opts]
   */
  function chartSvg(points, opts = {}) {
    if (!points?.length) {
      return `<div class="fit-chart-empty">No history yet</div>`;
    }
    const color = opts.color || "var(--accent)";
    const w = 720;
    const h = 260;
    const padL = 40;
    const padR = 16;
    const padT = 18;
    const padB = 36;
    const weights = points.map((p) => p.weight);
    let min = Math.min(...weights);
    let max = Math.max(...weights);
    if (min === max) {
      min -= 5;
      max += 5;
    }
    const span = max - min || 1;
    const xs = points.map((_, i) => {
      if (points.length === 1) return padL + (w - padL - padR) / 2;
      return padL + (i / (points.length - 1)) * (w - padL - padR);
    });
    const ys = weights.map(
      (v) => padT + (1 - (v - min) / span) * (h - padT - padB)
    );
    const line = xs
      .map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`)
      .join(" ");
    const showAllDots = points.length <= 60;
    const dots = xs
      .map((x, i) => {
        if (!showAllDots && i !== 0 && i !== points.length - 1 && i % 4 !== 0) {
          return "";
        }
        return `<circle cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="3.5" fill="${color}" />`;
      })
      .join("");
    const yLabels = [max, (max + min) / 2, min]
      .map((v, i) => {
        const y = padT + (i / 2) * (h - padT - padB);
        return `<text x="4" y="${y + 4}" fill="var(--muted)" font-size="11">${Math.round(v)}</text>`;
      })
      .join("");

    const first = points[0];
    const last = points[points.length - 1];
    const xLabels = [
      `<text x="${padL}" y="${h - 10}" fill="var(--muted)" font-size="10">${esc(
        formatDay(first.dateKey || "")
      )}</text>`,
      `<text x="${w - padR}" y="${h - 10}" fill="var(--muted)" font-size="10" text-anchor="end">${esc(
        formatDay(last.dateKey || "")
      )}</text>`,
    ].join("");

    return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(
      opts.ariaLabel || `Weight history (${points.length} sets)`
    )}">
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" />
      ${dots}
      ${yLabels}
      ${xLabels}
    </svg>`;
  }

  /**
   * Multi-series chart aligned by absolute time.
   * @param {{ id: string, name: string, color: string, points: { weight: number, at: string, dateKey: string }[] }[]} series
   */
  function multiChartSvg(series) {
    const active = series.filter((s) => s.points.length);
    if (!active.length) {
      return `<div class="fit-chart-empty">No history yet</div>`;
    }

    const allPoints = active.flatMap((s) => s.points);
    const weights = allPoints.map((p) => p.weight);
    let min = Math.min(...weights);
    let max = Math.max(...weights);
    if (min === max) {
      min -= 5;
      max += 5;
    }
    const span = max - min || 1;

    const times = allPoints.map((p) => new Date(p.at).getTime()).filter(Number.isFinite);
    let tMin = Math.min(...times);
    let tMax = Math.max(...times);
    if (tMin === tMax) {
      tMin -= 1;
      tMax += 1;
    }
    const tSpan = tMax - tMin;

    const w = 720;
    const h = 280;
    const padL = 40;
    const padR = 16;
    const padT = 18;
    const padB = 36;

    const paths = active
      .map((s) => {
        const sorted = [...s.points].sort(
          (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
        );
        const coords = sorted.map((p) => {
          const t = new Date(p.at).getTime();
          const x = padL + ((t - tMin) / tSpan) * (w - padL - padR);
          const y = padT + (1 - (p.weight - min) / span) * (h - padT - padB);
          return { x, y };
        });
        const line = coords
          .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
          .join(" ");
        const showAllDots = sorted.length <= 40;
        const dots = coords
          .map((c, i) => {
            if (!showAllDots && i !== 0 && i !== coords.length - 1 && i % 5 !== 0) {
              return "";
            }
            return `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3" fill="${s.color}" />`;
          })
          .join("");
        return `<path d="${line}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" opacity="0.92" />${dots}`;
      })
      .join("");

    const yLabels = [max, (max + min) / 2, min]
      .map((v, i) => {
        const y = padT + (i / 2) * (h - padT - padB);
        return `<text x="4" y="${y + 4}" fill="var(--muted)" font-size="11">${Math.round(v)}</text>`;
      })
      .join("");

    const firstKey = allPoints.reduce((a, b) =>
      new Date(a.at).getTime() <= new Date(b.at).getTime() ? a : b
    ).dateKey;
    const lastKey = allPoints.reduce((a, b) =>
      new Date(a.at).getTime() >= new Date(b.at).getTime() ? a : b
    ).dateKey;

    return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="All machines weight history">
      ${paths}
      ${yLabels}
      <text x="${padL}" y="${h - 10}" fill="var(--muted)" font-size="10">${esc(
        formatDay(firstKey || "")
      )}</text>
      <text x="${w - padR}" y="${h - 10}" fill="var(--muted)" font-size="10" text-anchor="end">${esc(
        formatDay(lastKey || "")
      )}</text>
    </svg>`;
  }

  function historyHtml(machine) {
    const points = [...machineHistory(machine)].reverse();
    if (!points.length && !(machine.pending || []).length) {
      return `<p class="fit-empty">No entries yet. Log sets from the iOS Fitness tab.</p>`;
    }

    /** @type {Map<string, any[]>} */
    const byDay = new Map();
    for (const e of points) {
      const key = sessionGroupKey(e.dateKey);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(e);
    }

    /** @type {string[]} */
    const rows = [];
    for (const [day, entries] of byDay) {
      rows.push(`<li class="fit-session-head">${esc(formatDay(day))}</li>`);
      const hideWhen = day === HISTORICAL_KEY;
      for (const e of entries) {
        const when = hideWhen
          ? ""
          : `<span class="fit-when">${esc(formatWhen(e.at))}</span>`;
        rows.push(`<li><span class="fit-w">${esc(e.weight)}</span>${when}</li>`);
      }
    }
    return `<ul class="fit-history">${rows.join("")}</ul>`;
  }

  function refreshLiquidGlass() {
    try {
      if (typeof window.reinitLiquidGlass === "function") {
        window.reinitLiquidGlass();
      }
    } catch {
      /* ignore */
    }
  }

  function render() {
    if (!appEl || !tree) return;
    const machines = tree.machines || [];
    if (!selectedId) selectedId = OVERVIEW_ID;
    if (
      selectedId !== OVERVIEW_ID &&
      !machines.some((m) => m.id === selectedId)
    ) {
      selectedId = OVERVIEW_ID;
    }
    const isOverview = selectedId === OVERVIEW_ID;
    const machine = selectedMachine();

    const list = `<ul class="fit-machine-list" role="listbox" aria-label="Machines">
      <li>
        <button type="button" class="fit-machine-btn" data-machine="${OVERVIEW_ID}" aria-current="${
          isOverview ? "true" : "false"
        }">
          <span class="fit-m-name">Overview</span>
        </button>
      </li>
      ${
        machines.length
          ? machines
              .map(
                (m, i) => `<li>
              <button type="button" class="fit-machine-btn" data-machine="${esc(
                m.id
              )}" aria-current="${m.id === (machine?.id || "") ? "true" : "false"}">
                <span class="fit-m-name" style="--fit-swatch:${machineColor(m, i)}">${esc(
                  m.name
                )}</span>
              </button>
            </li>`
              )
              .join("")
          : `<li><p class="fit-empty">No machines yet.</p></li>`
      }
    </ul>`;

    let panel = `<p class="fit-empty">Select a machine.</p>`;
    if (isOverview) {
      const series = machines
        .map((m, i) => ({
          id: m.id,
          name: m.name,
          color: machineColor(m, i),
          points: overviewVisible.has(m.id) ? sliceByRange(machineHistory(m)) : [],
        }))
        .filter((s) => overviewVisible.has(s.id));
      panel = `
        <div class="fit-panel">
          <div class="fit-panel-head">
            <h2 class="fit-title" style="font-size:20px;margin:0">Overview</h2>
            ${overviewFilterHtml(machines)}
          </div>
          ${rangeControlsHtml(
            series.reduce((n, s) => n + s.points.length, 0),
            machines
              .filter((m) => overviewVisible.has(m.id))
              .reduce((n, m) => n + machineHistory(m).length, 0)
          )}
          <div class="fit-chart-wrap fit-chart-wrap--tall">${multiChartSvg(series)}</div>
        </div>`;
    } else if (machine) {
      const pending = machine.pending || [];
      const pendingNote = pending.length
        ? `<p class="fit-pending-note">${pending.length} set${
            pending.length === 1 ? "" : "s"
          } still settling — charts update after 2 hours.</p>`
        : "";
      const full = machineHistory(machine);
      const points = sliceByRange(full);
      const color = machineColor(
        machine,
        machines.findIndex((m) => m.id === machine.id)
      );
      panel = `
        <div class="fit-panel">
          <h2 class="fit-title" style="font-size:20px;margin-bottom:1rem">${esc(
            machine.name
          )}</h2>
          ${pendingNote}
          <div class="fit-stats fit-stats--pair">
            <div class="fit-stat"><span class="fit-stat-label">Sets</span><span class="fit-stat-value">${esc(
              machine.historyCount ?? full.length
            )}</span></div>
            <div class="fit-stat"><span class="fit-stat-label">All-time max</span><span class="fit-stat-value">${
              machine.allTimeMax != null ? esc(machine.allTimeMax) : "—"
            }</span></div>
          </div>
          ${rangeControlsHtml(points.length, full.length)}
          <div class="fit-chart-wrap fit-chart-wrap--tall">${chartSvg(points, {
            color,
            ariaLabel: `${machine.name} weight history`,
          })}</div>
          ${historyHtml(machine)}
        </div>`;
    }

    appEl.innerHTML = `
      <header class="fit-header">
        <div>
          <h1 class="fit-title">Fitness</h1>
        </div>
      </header>
      <div class="fit-layout">
        <nav aria-label="Machines">${list}</nav>
        ${panel}
      </div>`;

    if (!didEntrance) {
      appEl.classList.add("fit-enter");
      didEntrance = true;
    }

    appEl.querySelectorAll("[data-machine]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedId = btn.getAttribute("data-machine") || OVERVIEW_ID;
        render();
      });
    });

    appEl.querySelectorAll("[data-range]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-range") || "50";
        saveRange(key);
        render();
      });
    });

    appEl.querySelectorAll(".edu-filter").forEach((chip) => {
      chip.addEventListener("click", (ev) => {
        ev.preventDefault();
        const input = chip.querySelector("input[data-machine-filter]");
        const id = input?.getAttribute("data-machine-filter");
        if (!id) return;
        if (overviewVisible.has(id)) overviewVisible.delete(id);
        else overviewVisible.add(id);
        saveOverviewVisible();
        render();
      });
    });

    requestAnimationFrame(refreshLiquidGlass);
  }

  async function refresh({ force = false } = {}) {
    const data = await loadTree();
    if (data.unauthorized) {
      showStage("login");
      return;
    }
    if (data.forbidden) {
      showStage("denied");
      return;
    }
    const fp = treeFingerprint(data);
    if (!force && fp === fingerprint && tree) return;
    fingerprint = fp;
    tree = data;
    const machines = tree.machines || [];
    if (!overviewBootstrapped) {
      overviewVisible = loadOverviewVisible(machines);
      overviewBootstrapped = true;
    } else {
      const ids = new Set(machines.map((m) => m.id));
      overviewVisible = new Set([...overviewVisible].filter((id) => ids.has(id)));
      if (!overviewVisible.size) {
        for (const m of machines) overviewVisible.add(m.id);
      }
    }
    if (
      selectedId !== OVERVIEW_ID &&
      selectedId &&
      !machines.some((m) => m.id === selectedId)
    ) {
      selectedId = OVERVIEW_ID;
    }
    showStage("full");
    render();
  }

  function bindLiveUpdates() {
    const mac = window.YanMacApi;
    if (!mac) return;
    mac.subscribeEvents("/api/fitness/events", {
      onChange: () => {
        refresh().catch(() => {});
      },
      onError: (err) => console.warn("[fitness sse]", err),
    });
    window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      if (!stages.full || stages.full.hidden) return;
      refresh().catch(() => {});
    }, 45_000);
  }

  async function boot() {
    showStage("loading");
    try {
      const session = await fetchSession();
      if (!session?.authenticated) {
        showStage("login");
        return;
      }
      if (session.access !== "full") {
        showStage("denied");
        return;
      }
      await refresh({ force: true });
      bindLiveUpdates();
    } catch (err) {
      console.error("[fitness]", err);
      showStage("login");
    }
  }

  boot();
})();
