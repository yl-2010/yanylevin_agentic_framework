/**
 * /education personal academic OS — read UI + done checkbox write.
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
  const appEl = document.getElementById("edu-app");

  /** Circular Canvas LMS logomark (monochrome). */
  const CANVAS_ICON_SVG =
    '<svg viewBox="0 0 26.7 26.8" aria-hidden="true" focusable="false" fill="currentColor"><path d="M3.9 13.5c0-2-1.5-3.6-3.4-3.8C.2 10.9 0 12.1 0 13.5s.2 2.6.5 3.8c1.9-.2 3.4-1.9 3.4-3.8z"/><circle cx="6.2" cy="13.4" r="1.2"/><path d="M22.8 13.5c0 2 1.5 3.6 3.4 3.8.3-1.2.5-2.5.5-3.8s-.2-2.6-.5-3.8c-1.9.2-3.4 1.8-3.4 3.8z"/><circle cx="20.2" cy="13.4" r="1.2"/><path d="M13.3 23c-2 0-3.6 1.5-3.8 3.4 1.2.3 2.5.5 3.8.5 1.3 0 2.6-.2 3.8-.5-.2-1.9-1.8-3.4-3.8-3.4z"/><circle cx="13.2" cy="20.4" r="1.2"/><path d="M13.3 4c2 0 3.6-1.5 3.8-3.4-1.2-.3-2.5-.5-3.8-.5-1.3 0-2.6.2-3.8.5C9.7 2.5 11.3 4 13.3 4z"/><circle cx="13.2" cy="6.4" r="1.2"/><path d="M20 20.2c-1.4 1.4-1.5 3.6-.3 5.1 2.2-1.3 4.1-3.2 5.4-5.4-1.5-1.2-3.7-1.1-5.1.3z"/><circle cx="18.2" cy="18.4" r="1.2"/><path d="M6.6 6.8C8 5.4 8.1 3.2 6.9 1.7 4.7 3 2.8 4.9 1.5 7.1 3 8.3 5.2 8.2 6.6 6.8z"/><circle cx="8.2" cy="8.4" r="1.2"/><path d="M20 6.8c1.4 1.4 3.6 1.5 5.1.3-1.3-2.2-3.2-4.1-5.4-5.4-1.2 1.5-1.1 3.7.3 5.1z"/><circle cx="18.2" cy="8.4" r="1.2"/><path d="M6.6 20.2c-1.4-1.4-3.6-1.5-5.1-.3 1.3 2.2 3.2 4.1 5.4 5.4 1.2-1.6 1.1-3.7-.3-5.1z"/><circle cx="8.2" cy="18.4" r="1.2"/></svg>';

  const FILTER_KEY = "yl-edu-type-filters";
  const DATE_FILTER_KEY = "yl-edu-date-filters";
  const TAGS = ["MA", "QA", "HW", "CW", "none"];
  const PATHIVY_PROJECT_ID = "pathivy";
  const DATE_FILTERS_HOME = ["ma", "pa", "class", "loose"];
  const DATE_FILTERS_CLASS = ["ma", "class"];
  const DATE_FILTERS_PATHIVY = ["ma", "pa"];
  const DATE_FILTERS_PROJECT = ["ma", "loose"];
  const DATES_COLLAPSED_LIMIT = 6;
  const GRAD_CAP_SVG =
    '<svg class="edu-filter-cap" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 3 1 9l11 6 9-4.91V17h2V9L12 3zm-7 12.18v2.66c0 .74 1.94 2.16 7 2.16s7-1.42 7-2.16v-2.66l-7 3.82-7-3.82z"/></svg>';
  const THUMB_UP_SVG =
    '<svg class="edu-vote-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="M14.6 3.2c.9.1 1.5.9 1.4 1.8l-.3 2.5h3.6c1.4 0 2.5 1.3 2.3 2.7l-1.1 7.4A2.5 2.5 0 0 1 18 20H9.2V8.8L12.8 3.8A2 2 0 0 1 14.6 3.2ZM7.2 9v11H4.6A1.6 1.6 0 0 1 3 18.4v-8C3 9.6 3.7 9 4.6 9h2.6Z"/></svg>';
  const THUMB_DOWN_SVG =
    '<svg class="edu-vote-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9.4 20.8c-.9-.1-1.5-.9-1.4-1.8l.3-2.5H4.7c-1.4 0-2.5-1.3-2.3-2.7l1.1-7.4A2.5 2.5 0 0 1 6 4h8.8v11.2L11.2 20.2a2 2 0 0 1-1.8.6ZM16.8 15V4h2.6C20.3 4 21 4.6 21 5.6v8c0 .9-.7 1.6-1.6 1.6h-2.6Z"/></svg>';
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "July",
    "Aug",
    "Sept",
    "Oct",
    "Nov",
    "Dec",
  ];
  const MONTHS_FULL = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const WEEKDAYS_SHORT = ["Sun", "Mon", "Tues", "Wed", "Thurs", "Fri", "Sat"];

  /** @type {any} */
  let tree = null;
  /** @type {string} */
  let userEmail = "";
  /** Snapshot to skip no-op SSE/poll refreshes. */
  let treeFingerprint = "";
  /** Entrance fade only on first paint after a real browser load. */
  let didEntrance = false;
  /** @type {Set<string>} */
  let typeFilter = loadFilters();
  /** @type {Set<string>} */
  let dateFilter = loadDateFilters();
  /** Dates panel: collapsed shows upcoming 6; expanded shows all. */
  let datesExpanded = false;
  let route = parseRoute();

  function show(name) {
    Object.keys(stages).forEach((key) => {
      const el = stages[key];
      if (!el) return;
      el.hidden = key !== name;
    });
    queueMicrotask(() => window.reinitLiquidGlass?.());
  }

  /** Normalize / accept http(s) Canvas URLs only. */
  function normalizeCanvasLink(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    try {
      const u = new URL(s);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return u.href;
    } catch {
      return "";
    }
  }

  function canvasOrbHtml(rawLink) {
    const href = normalizeCanvasLink(rawLink);
    if (!href) return "";
    return `<div class="edu-canvas-slot"><a class="corner circle edu-canvas-orb" data-liquid-glass="circle" data-filter-id="lg-edu-canvas" href="${escapeHtml(
      href
    )}" target="_blank" rel="noopener noreferrer" aria-label="Open in Canvas">${CANVAS_ICON_SVG}</a></div>`;
  }

  function loadFilters() {
    try {
      const raw = localStorage.getItem(FILTER_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) return new Set(arr.map(String));
      }
    } catch {
      /* ignore */
    }
    return new Set(TAGS);
  }

  function saveFilters() {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify([...typeFilter]));
    } catch {
      /* ignore */
    }
  }

  function loadDateFilters() {
    try {
      const raw = localStorage.getItem(DATE_FILTER_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) {
          const known = arr.map(String).filter((k) => DATE_FILTERS_HOME.includes(k));
          if (known.length) return new Set(known);
        }
      }
    } catch {
      /* ignore */
    }
    return new Set(DATE_FILTERS_HOME);
  }

  function saveDateFilters() {
    try {
      localStorage.setItem(DATE_FILTER_KEY, JSON.stringify([...dateFilter]));
    } catch {
      /* ignore */
    }
  }

  function todayKey() {
    if (tree?.todayKey) return String(tree.todayKey);
    const t = todayParts();
    return ymd(t.y, t.m, t.day);
  }

  function parseRoute() {
    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    const params = new URLSearchParams(window.location.search);
    const classFromQuery = params.get("class") || params.get("classId") || null;
    const projectFromQuery =
      params.get("project") || params.get("projectId") || null;
    let m = path.match(/^\/education\/class\/([^/]+)$/);
    if (m) return { view: "class", classId: decodeURIComponent(m[1]), projectId: null, itemId: null, capsuleId: null };
    m = path.match(/^\/education\/project\/([^/]+)$/);
    if (m) {
      return {
        view: "project",
        classId: null,
        projectId: decodeURIComponent(m[1]),
        itemId: null,
      };
    }
    m = path.match(/^\/education\/todo\/([^/]+)\/capsule\/([^/]+)$/);
    if (m) {
      return {
        view: "capsule",
        classId: classFromQuery ? decodeURIComponent(classFromQuery) : null,
        projectId: projectFromQuery
          ? decodeURIComponent(projectFromQuery)
          : null,
        itemId: decodeURIComponent(m[1]),
        capsuleId: decodeURIComponent(m[2]),
      };
    }
    m = path.match(/^\/education\/todo\/([^/]+)$/);
    if (m) {
      return {
        view: "todo",
        classId: classFromQuery ? decodeURIComponent(classFromQuery) : null,
        projectId: projectFromQuery
          ? decodeURIComponent(projectFromQuery)
          : null,
        itemId: decodeURIComponent(m[1]),
      };
    }
    m = path.match(/^\/education\/date\/([^/]+)$/);
    if (m) {
      return {
        view: "date",
        classId: classFromQuery ? decodeURIComponent(classFromQuery) : null,
        projectId: projectFromQuery
          ? decodeURIComponent(projectFromQuery)
          : null,
        itemId: decodeURIComponent(m[1]),
      };
    }
    return { view: "home", classId: null, projectId: null, itemId: null };
  }

  /** @type {Map<string, { x: number, y: number }>} */
  const scrollPositions = new Map();
  try {
    if (history.scrollRestoration) history.scrollRestoration = "manual";
  } catch {
    /* ignore */
  }

  function routeScrollQuery(r) {
    if (r?.projectId) return `?project=${encodeURIComponent(r.projectId)}`;
    if (r?.classId) return `?class=${encodeURIComponent(r.classId)}`;
    return "";
  }

  function routeScrollKey(r = route) {
    const view = r?.view || "home";
    if (view === "class" && r.classId) {
      return `/education/class/${encodeURIComponent(r.classId)}`;
    }
    if (view === "project" && r.projectId) {
      return `/education/project/${encodeURIComponent(r.projectId)}`;
    }
    if (view === "capsule" && r.itemId && r.capsuleId) {
      return `/education/todo/${encodeURIComponent(r.itemId)}/capsule/${encodeURIComponent(
        r.capsuleId
      )}${routeScrollQuery(r)}`;
    }
    if (view === "todo" && r.itemId) {
      return `/education/todo/${encodeURIComponent(r.itemId)}${routeScrollQuery(r)}`;
    }
    if (view === "date" && r.itemId) {
      return `/education/date/${encodeURIComponent(r.itemId)}${routeScrollQuery(r)}`;
    }
    return "/education/";
  }

  function captureScroll(key = routeScrollKey()) {
    scrollPositions.set(key, { x: window.scrollX, y: window.scrollY });
  }

  function applyScroll(mode, keepX = 0, keepY = 0) {
    let x = keepX;
    let y = keepY;
    if (mode === "restore") {
      const pos = scrollPositions.get(routeScrollKey());
      x = pos?.x ?? 0;
      y = pos?.y ?? 0;
    } else if (mode === "top") {
      x = 0;
      y = 0;
    }
    requestAnimationFrame(() => {
      window.scrollTo({ left: x, top: y, behavior: "instant" });
    });
  }

  function navigate(path, { replace = false, scroll = "top" } = {}) {
    captureScroll();
    const url = path.startsWith("/") ? path : `/education/${path}`;
    if (replace) history.replaceState({}, "", url);
    else history.pushState({}, "", url);
    route = parseRoute();
    render({ scroll });
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function todayParts(d = new Date()) {
    return {
      y: d.getFullYear(),
      m: d.getMonth() + 1,
      day: d.getDate(),
      weekday: d.getDay(), // 0 Sun
      minutes: d.getHours() * 60 + d.getMinutes(),
    };
  }

  function ymd(y, m, d) {
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }

  function parseYmd(s) {
    const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return { y: +m[1], m: +m[2], day: +m[3] };
  }

  function addDays(y, m, d, n) {
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + n);
    return {
      y: dt.getFullYear(),
      m: dt.getMonth() + 1,
      day: dt.getDate(),
      weekday: dt.getDay(),
    };
  }

  function timeToMinutes(t) {
    const m = String(t || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return +m[1] * 60 + +m[2];
  }

  function use24Hour() {
    return false;
  }

  function formatTime(t) {
    const mins = timeToMinutes(t);
    if (mins == null) return "";
    const h24 = Math.floor(mins / 60);
    const mi = mins % 60;
    if (use24Hour()) return `${pad2(h24)}:${pad2(mi)}`;
    const ap = h24 >= 12 ? "pm" : "am";
    const h12 = h24 % 12 || 12;
    return `${h12}:${pad2(mi)} ${ap}`;
  }

  function ordinal(n) {
    const v = n % 100;
    if (v >= 11 && v <= 13) return `${n}th`;
    switch (n % 10) {
      case 1:
        return `${n}st`;
      case 2:
        return `${n}nd`;
      case 3:
        return `${n}rd`;
      default:
        return `${n}th`;
    }
  }

  function daysBetween(a, b) {
    const ua = Date.UTC(a.y, a.m - 1, a.day);
    const ub = Date.UTC(b.y, b.m - 1, b.day);
    return Math.round((ub - ua) / 86400000);
  }

  /**
   * Natural due/event datetime for list rows (compact relative phrasing).
   * @param {string|null|undefined} dateStr YYYY-MM-DD
   * @param {string|null|undefined} timeStr HH:MM
   */
  function formatNaturalWhen(dateStr, timeStr) {
    const target = parseYmd(dateStr);
    if (!target) {
      return timeStr ? formatTime(timeStr) : "";
    }

    const now = todayParts();
    const targetWeekday = new Date(target.y, target.m - 1, target.day).getDay();
    const delta = daysBetween(now, target);
    const clock = timeStr ? formatTime(timeStr) : "";
    const dayAbbr = WEEKDAYS_SHORT[targetWeekday];

    // Calendar weeks run Sun–Sat. Include weekday abbr for this week + next week.
    const weekStart = addDays(now.y, now.m, now.day, -now.weekday);
    const weekOffset = daysBetween(weekStart, target);
    const inThisOrNextWeek = weekOffset >= 0 && weekOffset <= 13;

    if (delta === 0) {
      return clock ? `${clock} today` : "today";
    }
    if (delta === 1) {
      return clock ? `${clock} tomorrow` : "tomorrow";
    }
    if (delta === -1) {
      return clock ? `${clock} yesterday` : "yesterday";
    }

    const showYear = target.y !== now.y;
    const showMonth = target.m !== now.m || target.y !== now.y || delta < 0;
    const dayPart = showMonth
      ? `${MONTHS[target.m - 1]} ${ordinal(target.day)}`
      : `the ${ordinal(target.day)}`;
    const yearPart = showYear ? `, ${target.y}` : "";
    const dateCore = `${dayPart}${yearPart}`;
    const dated = inThisOrNextWeek ? `${dayAbbr} ${dateCore}` : dateCore;

    // Overdue prior days (before yesterday): no time.
    if (delta < -1) {
      return dated;
    }

    if (clock) return `${clock} on ${dated}`;
    return dated;
  }

  /**
   * Expanded todo/date view: always "08:00 on Friday, August 28th"
   * with (Today)/(Tomorrow)/(Yesterday) when relevant.
   * @param {string|null|undefined} dateStr YYYY-MM-DD
   * @param {string|null|undefined} timeStr HH:MM
   */
  function formatDetailWhen(dateStr, timeStr) {
    const target = parseYmd(dateStr);
    if (!target) {
      return timeStr ? formatTime(timeStr) : "";
    }

    const now = todayParts();
    const delta = daysBetween(now, target);
    const clock = timeStr ? formatTime(timeStr) : "";
    const weekday = WEEKDAYS[new Date(target.y, target.m - 1, target.day).getDay()];
    const month = MONTHS_FULL[target.m - 1];
    const day = ordinal(target.day);
    const yearPart = target.y !== now.y ? `, ${target.y}` : "";
    let relative = "";
    if (delta === 0) relative = " (Today)";
    else if (delta === 1) relative = " (Tomorrow)";
    else if (delta === -1) relative = " (Yesterday)";

    const dated = `${weekday}, ${month} ${day}${yearPart}${relative}`;
    if (clock) return `${clock} on ${dated}`;
    return dated;
  }

  function weekdayLabel(weekday, y, m, d) {
    return `${WEEKDAYS_SHORT[weekday]} ${m}/${d}`;
  }

  function closedSet(schedule) {
    const set = new Set();
    const list = schedule?.closedDates;
    if (Array.isArray(list)) list.forEach((x) => set.add(String(x)));
    return set;
  }

  function dateKeyOf(parts) {
    return ymd(parts.y, parts.m, parts.day);
  }

  function isSchoolDay(parts, schedule) {
    if (parts.weekday === 0 || parts.weekday === 6) return false;
    const key = dateKeyOf(parts);
    if (closedSet(schedule).has(key)) return false;
    const start = schedule?.schoolStart ? String(schedule.schoolStart) : "";
    const end = schedule?.schoolEnd ? String(schedule.schoolEnd) : "";
    if (start && key < start) return false;
    if (end && key > end) return false;
    return true;
  }

  function nextSchoolDay(from, schedule, skipToday = true) {
    let cur = skipToday
      ? addDays(from.y, from.m, from.day, 1)
      : { y: from.y, m: from.m, day: from.day, weekday: from.weekday };
    for (let i = 0; i < 120; i++) {
      if (isSchoolDay(cur, schedule)) return cur;
      cur = addDays(cur.y, cur.m, cur.day, 1);
    }
    return null;
  }

  function periodsForDay(parts, schedule) {
    const map = schedule?.weekdayPeriods || {};
    const key = String(parts.weekday);
    const periods = map[key];
    return Array.isArray(periods) ? periods : [];
  }

  function bells(schedule) {
    return Array.isArray(schedule?.bells) ? schedule.bells : [];
  }

  function dayOverride(parts, schedule) {
    const map = schedule?.dayOverrides;
    if (!map || typeof map !== "object") return null;
    const o = map[dateKeyOf(parts)];
    return o && typeof o === "object" ? o : null;
  }

  function isAllPeriodsDay(parts, schedule) {
    return Boolean(dayOverride(parts, schedule)?.allPeriods);
  }

  function isFreePeriodClass(cls) {
    return Boolean(cls && cls.freePeriod === true);
  }

  /** Schedule row uses "Free Period"; todos/dates use "Free Period C". */
  function classContextName(cls) {
    if (!cls) return "";
    if (isFreePeriodClass(cls)) {
      const p = String(cls.period || "").toUpperCase();
      return p ? `Free Period ${p}` : "Free Period";
    }
    return cls.name || cls.id || "";
  }

  function classScheduleName(cls) {
    if (!cls) return "";
    if (isFreePeriodClass(cls)) return "Free Period";
    return cls.name || cls.id || "";
  }

  /** Prefer a real class over a free-period shell for the same letter. */
  function classForPeriod(visible, period) {
    const letter = String(period || "").toUpperCase();
    if (!letter) return null;
    const matches = (visible || []).filter(
      (c) => String(c.period || "").toUpperCase() === letter
    );
    if (!matches.length) return null;
    return matches.find((c) => !isFreePeriodClass(c)) || matches[0];
  }

  /**
   * Classes for a calendar day: [{ class, period, start, end, startMin, endMin }]
   */
  function classesForDay(parts, schedule, classes) {
    const dayKey = dateKeyOf(parts);
    const allowed = tree?.activeClassIdsByDate?.[dayKey];
    const allowedSet = Array.isArray(allowed) ? new Set(allowed) : null;
    const visible = (classes || []).filter((c) => {
      if (isFixture(c)) return false;
      if (allowedSet) return allowedSet.has(c.id);
      return true;
    });
    /** @type {any[]} */
    const out = [];
    const override = dayOverride(parts, schedule);
    const overrideSlots = Array.isArray(override?.slots)
      ? override.slots
      : Array.isArray(override?.meetings)
        ? override.meetings
        : null;

    if (overrideSlots) {
      overrideSlots.forEach((slot) => {
        const period = String(slot?.period || "").toUpperCase();
        if (!period) return;
        const cls = classForPeriod(visible, period);
        if (!cls) return;
        const start = slot.start;
        const end = slot.end;
        out.push({
          class: cls,
          period,
          start,
          end,
          startMin: timeToMinutes(start),
          endMin: timeToMinutes(end),
        });
      });
    } else {
      const periods = periodsForDay(parts, schedule);
      const bellList = bells(schedule);
      periods.forEach((period, i) => {
        const bell = bellList[i];
        if (!bell) return;
        const cls = classForPeriod(visible, period);
        if (!cls) return;
        out.push({
          class: cls,
          period,
          start: bell.start,
          end: bell.end,
          startMin: timeToMinutes(bell.start),
          endMin: timeToMinutes(bell.end),
        });
      });
    }
    out.sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0));
    return out;
  }

  /** Day-type code like AH / AD / EH / DA / HE (no dash). */
  function dayTypeCode(parts, schedule) {
    const override = dayOverride(parts, schedule);
    const raw = override?.label != null ? String(override.label) : "";
    const fromLabel = raw.replace(/[^A-Za-z]/g, "").toUpperCase();
    if (fromLabel) return fromLabel;
    const periods = Array.isArray(override?.slots)
      ? override.slots.map((m) => String(m?.period || "").toUpperCase()).filter(Boolean)
      : Array.isArray(override?.meetings)
        ? override.meetings.map((m) => String(m?.period || "").toUpperCase()).filter(Boolean)
      : periodsForDay(parts, schedule).map((p) => String(p).toUpperCase());
    if (!periods.length) return "";
    if (periods.length === 1) return periods[0];
    return `${periods[0]}${periods[periods.length - 1]}`;
  }

  function daySectionTitle(parts, schedule) {
    const type = dayTypeCode(parts, schedule);
    const when = weekdayLabel(parts.weekday, parts.y, parts.m, parts.day);
    if (!type) {
      return { plain: when, html: escapeHtml(when) };
    }
    return {
      plain: `${type} ${when}`,
      html: `<span class="edu-day-type">${escapeHtml(type)}</span>${escapeHtml(when)}`,
    };
  }

  function classSections(schedule, classes) {
    const now = todayParts();
    const todayIsSchool = isSchoolDay(now, schedule);
    let day1;
    let day2;
    if (todayIsSchool) {
      day1 = { y: now.y, m: now.m, day: now.day, weekday: now.weekday };
      day2 = nextSchoolDay(now, schedule, true);
    } else {
      day1 = nextSchoolDay(now, schedule, true);
      day2 = day1 ? nextSchoolDay(day1, schedule, true) : null;
    }

    const sections = [];
    if (day1) {
      const allPeriods = isAllPeriodsDay(day1, schedule);
      const title = daySectionTitle(day1, schedule);
      sections.push({
        label: title.plain,
        labelHtml: title.html,
        dateKey: dateKeyOf(day1),
        isToday: todayIsSchool && day1.y === now.y && day1.m === now.m && day1.day === now.day,
        classes: classesForDay(day1, schedule, classes),
        nowMinutes: now.minutes,
        allPeriods,
      });
      // A-H days: one panel with every class — skip the following-day box.
      if (allPeriods) return sections;
    }
    if (day2) {
      const title = daySectionTitle(day2, schedule);
      sections.push({
        label: title.plain,
        labelHtml: title.html,
        dateKey: dateKeyOf(day2),
        isToday: false,
        classes: classesForDay(day2, schedule, classes),
        nowMinutes: now.minutes,
        allPeriods: isAllPeriodsDay(day2, schedule),
      });
    }
    return sections;
  }

  /** Fixture trees stay on disk for agents; never show in the web UI. */
  function isFixture(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (obj.fixture === true) return true;
    const id = String(obj.id || "");
    return id.startsWith("_example-");
  }

  function flattenTodos(data, { classId = null, projectId = null } = {}) {
    /** @type {any[]} */
    const out = [];
    if (projectId) {
      const p = (data.projects || []).find((x) => x.id === projectId);
      if (p && !isFixture(p)) {
        (p.todos || []).forEach((t) => {
          if (isFixture(t)) return;
          out.push({
            ...t,
            classId: null,
            className: null,
            projectId: p.id,
            projectName: p.name || p.id,
          });
        });
      }
      return out;
    }
    if (classId) {
      const c = (data.classes || []).find((x) => x.id === classId);
      if (c && !isFixture(c)) {
        (c.todos || []).forEach((t) => {
          if (isFixture(t)) return;
          out.push({
            ...t,
            classId: c.id,
            className: classContextName(c),
            projectId: null,
            projectName: null,
          });
        });
      }
      return out;
    }
    (data.todos || []).forEach((t) => {
      if (isFixture(t)) return;
      out.push({
        ...t,
        classId: null,
        className: null,
        projectId: null,
        projectName: null,
      });
    });
    (data.classes || []).forEach((c) => {
      if (isFixture(c)) return;
      (c.todos || []).forEach((t) => {
        if (isFixture(t)) return;
        out.push({
          ...t,
          classId: c.id,
          className: classContextName(c),
          projectId: null,
          projectName: null,
        });
      });
    });
    (data.projects || []).forEach((p) => {
      if (isFixture(p)) return;
      (p.todos || []).forEach((t) => {
        if (isFixture(t)) return;
        out.push({
          ...t,
          classId: null,
          className: null,
          projectId: p.id,
          projectName: p.name || p.id,
        });
      });
    });
    return out;
  }

  function flattenDates(data, { classId = null, projectId = null } = {}) {
    /** @type {any[]} */
    const out = [];
    if (projectId) {
      const p = (data.projects || []).find((x) => x.id === projectId);
      if (p && !isFixture(p)) {
        (p.dates || []).forEach((d) => {
          if (isFixture(d)) return;
          out.push({
            ...d,
            classId: null,
            className: null,
            projectId: p.id,
            projectName: p.name || p.id,
          });
        });
      }
      return out;
    }
    if (classId) {
      const c = (data.classes || []).find((x) => x.id === classId);
      if (c && !isFixture(c)) {
        (c.dates || []).forEach((d) => {
          if (isFixture(d)) return;
          out.push({
            ...d,
            classId: c.id,
            className: classContextName(c),
            projectId: null,
            projectName: null,
          });
        });
      }
      return out;
    }
    (data.dates || []).forEach((d) => {
      if (isFixture(d)) return;
      out.push({
        ...d,
        classId: null,
        className: null,
        projectId: null,
        projectName: null,
      });
    });
    (data.classes || []).forEach((c) => {
      if (isFixture(c)) return;
      (c.dates || []).forEach((d) => {
        if (isFixture(d)) return;
        out.push({
          ...d,
          classId: c.id,
          className: classContextName(c),
          projectId: null,
          projectName: null,
        });
      });
    });
    (data.projects || []).forEach((p) => {
      if (isFixture(p)) return;
      (p.dates || []).forEach((d) => {
        if (isFixture(d)) return;
        out.push({
          ...d,
          classId: null,
          className: null,
          projectId: p.id,
          projectName: p.name || p.id,
        });
      });
    });
    return out;
  }

  function findTodoById(id, { classId = null, projectId = null } = {}) {
    const wantClass = classId || null;
    const wantProject = projectId || null;
    return (
      flattenTodos(tree).find((t) => {
        if (t.id !== id) return false;
        return (
          (t.classId || null) === wantClass &&
          (t.projectId || null) === wantProject
        );
      }) || null
    );
  }

  function findDateById(id, { classId = null, projectId = null } = {}) {
    const wantClass = classId || null;
    const wantProject = projectId || null;
    return (
      flattenDates(tree).find((d) => {
        if (d.id !== id) return false;
        return (
          (d.classId || null) === wantClass &&
          (d.projectId || null) === wantProject
        );
      }) || null
    );
  }

  function todoHref(t) {
    const base = `/education/todo/${encodeURIComponent(t.id)}`;
    if (t.projectId) {
      return `${base}?project=${encodeURIComponent(t.projectId)}`;
    }
    return t.classId
      ? `${base}?class=${encodeURIComponent(t.classId)}`
      : base;
  }

  function dateHref(d) {
    const base = `/education/date/${encodeURIComponent(d.id)}`;
    if (d.projectId) {
      return `${base}?project=${encodeURIComponent(d.projectId)}`;
    }
    return d.classId
      ? `${base}?class=${encodeURIComponent(d.classId)}`
      : base;
  }

  function capsuleHref(todo, capsuleId) {
    const qs = todoHref(todo).split("?")[1];
    const base = `/education/todo/${encodeURIComponent(todo.id)}/capsule/${encodeURIComponent(
      capsuleId
    )}`;
    return qs ? `${base}?${qs}` : base;
  }

  function citationHost(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "") || url;
    } catch {
      return url;
    }
  }

  function parseCitations(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {{ name: string, url: string }[]} */
    const out = [];
    for (const item of raw) {
      if (typeof item === "string") {
        const t = item.trim();
        if (!t) continue;
        if (/^https?:\/\//i.test(t)) {
          out.push({ name: citationHost(t), url: t });
        } else {
          out.push({ name: t, url: "" });
        }
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const name = String(
        item.name || item.title || item.source || item.outlet || ""
      ).trim();
      const url = String(item.url || item.href || "").trim();
      if (!name && !url) continue;
      out.push({ name: name || citationHost(url), url });
    }
    return uniqueSortedCitations(out);
  }

  function uniqueSortedCitations(list) {
    /** @type {Map<string, { name: string, url: string }>} */
    const byKey = new Map();
    for (const c of list) {
      const name = String(c?.name || "").trim();
      if (!name) continue;
      const url = String(c?.url || "").trim();
      const key = name.toLowerCase();
      const prev = byKey.get(key);
      if (!prev) byKey.set(key, { name, url });
      else if (!prev.url && url) byKey.set(key, { name: prev.name, url });
    }
    return [...byKey.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
  }

  function overallCitations(todo) {
    const fromTodo = parseCitations(todo?.citations);
    const fromCaps = (Array.isArray(todo?.capsules) ? todo.capsules : []).flatMap(
      (c) => parseCitations(c?.citations || c?.sources)
    );
    return uniqueSortedCitations([...fromTodo, ...fromCaps]);
  }

  function citationsHtml(citations, filterId) {
    const list = Array.isArray(citations) ? citations : [];
    if (!list.length) return "";
    const items = list
      .map((c) => {
        const name = String(c?.name || "").trim();
        if (!name) return "";
        const url = String(c?.url || "").trim();
        if (url && /^https?:\/\//i.test(url)) {
          return `<li><a class="edu-citation-link" href="${escapeHtml(
            url
          )}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a></li>`;
        }
        return `<li>${escapeHtml(name)}</li>`;
      })
      .filter(Boolean)
      .join("");
    if (!items) return "";
    return `<section class="edu-panel edu-citations-panel" data-liquid-glass="rounded" data-filter-id="${escapeHtml(
      filterId
    )}"><h2 class="edu-panel-title">Citations</h2><ul class="edu-citations-list">${items}</ul></section>`;
  }

  function formatCapsuleCitationsText(capsule) {
    return parseCitations(capsule?.citations || capsule?.sources)
      .map((c) => (c.url ? `${c.name}: ${c.url}` : c.name))
      .join("\n");
  }

  function todoTagKey(t) {
    const tag = t.tag ? String(t.tag).toUpperCase() : "";
    if (tag === "CW" || tag === "HW" || tag === "QA" || tag === "MA") return tag;
    return "none";
  }

  /** Effective Dates visibility: MA defaults on; others default off. */
  function todoShowsInDates(t) {
    if (!t || t.done) return false;
    if (typeof t.showInDates === "boolean") return t.showInDates;
    return todoTagKey(t) === "MA";
  }

  function dateItemFilterKey(item) {
    if (item.isMA) return "ma";
    if (item.projectId === PATHIVY_PROJECT_ID) return "pa";
    // Class-linked → grad cap. Other projects + user-level → loose (dot).
    if (item.classId && !item.projectId) return "class";
    return "loose";
  }

  function dateItemSortKey(item) {
    const dt = item.date || "9999-99-99";
    const tm = item.time || "99:99";
    return `${dt}T${tm}`;
  }

  /**
   * Important dates + open todos with showInDates (MA default on).
   * @param {{ classId?: string|null, projectId?: string|null }} [scope]
   */
  function collectDateItems({ classId = null, projectId = null } = {}) {
    /** @type {any[]} */
    const out = [];
    flattenDates(tree, { classId, projectId }).forEach((d) => {
      out.push({
        source: "date",
        id: d.id,
        name: d.name || d.id,
        date: d.date || null,
        time: d.time || null,
        classId: d.classId || null,
        className: d.className || null,
        projectId: d.projectId || null,
        projectName: d.projectName || null,
        isMA: false,
        href: dateHref(d),
      });
    });
    flattenTodos(tree, { classId, projectId }).forEach((t) => {
      if (!todoShowsInDates(t)) return;
      const isMA = todoTagKey(t) === "MA";
      out.push({
        source: "todo",
        id: t.id,
        name: t.name || t.id,
        date: t.dueDate || null,
        time: t.dueTime || null,
        classId: t.classId || null,
        className: t.className || null,
        projectId: t.projectId || null,
        projectName: t.projectName || null,
        isMA,
        href: todoHref(t),
      });
    });
    return out;
  }

  function matchesFilter(t) {
    return typeFilter.has(todoTagKey(t));
  }

  /**
   * Open TODO order: earliest dueDate first (overdue included), undated last;
   * same date → timed before date-only; same due → older createdAt above newer;
   * final tie → id.
   */
  function dueSortKey(t) {
    const d = t.dueDate || "9999-99-99";
    const tm = t.dueTime || "99:99";
    const created = t.createdAt || "";
    const id = t.id || "";
    return `${d}T${tm}\t${created}\t${id}`;
  }

  /** Most recently checked-off first; todos without completedAt sink to the bottom. */
  function completedSortKey(t) {
    return t.completedAt || "";
  }

  function dateSortKey(d) {
    const dt = d.date || "9999-99-99";
    const tm = d.time || "99:99";
    return `${dt}T${tm}`;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function markdownHtml(src) {
    const api = window.YLMarkdown;
    if (api && typeof api.render === "function") return api.render(src);
    return escapeHtml(src);
  }

  function descriptionHtml(desc) {
    const text = String(desc || "").trim();
    if (!text) return `<p class="edu-empty">No description</p>`;
    return `<div class="edu-detail-desc md-body">${markdownHtml(text)}</div>`;
  }

  function markdownPanelHtml(md, filterId) {
    return `<section class="edu-panel edu-panel--desc" data-liquid-glass="rounded" data-filter-id="${escapeHtml(
      filterId
    )}"><div class="md-body">${markdownHtml(md)}</div></section>`;
  }

  function backHrefForItem(item) {
    if (item?.projectId) {
      return `/education/project/${encodeURIComponent(item.projectId)}`;
    }
    if (item?.classId) return `/education/class/${encodeURIComponent(item.classId)}`;
    return "/education/";
  }

  function filterBarHtml() {
    return `<div class="edu-filters" role="group" aria-label="Type filters">${TAGS.map(
      (tag) => {
        const on = typeFilter.has(tag);
        const short = tag === "none" ? "·" : tag;
        const label = tag === "none" ? "none" : tag;
        return `<label
          class="edu-filter circle${on ? " is-on" : ""}"
          data-liquid-glass="circle"
          data-filter-id="lg-edu-filter-${tag}"
          title="${escapeHtml(label)}"
          aria-label="${escapeHtml(label)}"
        ><input type="checkbox" data-filter="${tag}" ${
          on ? "checked" : ""
        } /><span>${escapeHtml(short)}</span></label>`;
      }
    ).join("")}</div>`;
  }

  function dateFilterLabel(key) {
    if (key === "ma") return "MA";
    if (key === "pa") return "PA";
    if (key === "class") return "class";
    return "none";
  }

  function dateFilterGlyph(key) {
    if (key === "ma") return "MA";
    if (key === "pa") return "PA";
    if (key === "class") return GRAD_CAP_SVG;
    return "·";
  }

  function dateFilterBarHtml(keys) {
    return `<div class="edu-filters" role="group" aria-label="Date filters">${keys
      .map((key) => {
        const on = dateFilter.has(key);
        const label = dateFilterLabel(key);
        const glyph = dateFilterGlyph(key);
        return `<label
          class="edu-filter circle${on ? " is-on" : ""}"
          data-liquid-glass="circle"
          data-filter-id="lg-edu-date-filter-${key}"
          title="${escapeHtml(label)}"
          aria-label="${escapeHtml(label)}"
        ><input type="checkbox" data-date-filter="${key}" ${
          on ? "checked" : ""
        } /><span>${glyph}</span></label>`;
      })
      .join("")}</div>`;
  }

  function datesPanelHtml(
    { classId = null, projectId = null } = {},
    filterId = "lg-edu-dates"
  ) {
    const classScoped = Boolean(classId);
    const projectScoped = Boolean(projectId);
    const keys = classScoped
      ? DATE_FILTERS_CLASS
      : projectScoped
        ? projectId === PATHIVY_PROJECT_ID
          ? DATE_FILTERS_PATHIVY
          : DATE_FILTERS_PROJECT
        : DATE_FILTERS_HOME;
    const today = todayKey();
    const upcoming = collectDateItems({ classId, projectId })
      .filter((item) => dateFilter.has(dateItemFilterKey(item)))
      .filter((item) => item.date && String(item.date) >= today)
      .sort((a, b) => dateItemSortKey(a).localeCompare(dateItemSortKey(b)));
    const visible = datesExpanded
      ? upcoming
      : upcoming.slice(0, DATES_COLLAPSED_LIMIT);
    const titleHtml = `<button type="button" class="edu-dates-toggle" data-dates-expand aria-expanded="${
      datesExpanded ? "true" : "false"
    }">Dates</button>`;
    return panelHtml("Dates", listOrEmpty(visible.map(dateItemRowHtml).join("")), {
      filterId,
      titleHtml,
      headExtra: dateFilterBarHtml(keys),
    });
  }

  function todoRowHtml(t) {
    const done = Boolean(t.done);
    const tag = todoTagKey(t);
    const tagLabel = tag === "none" ? "" : `<span class="edu-tag">${escapeHtml(tag)}</span>`;
    const due =
      t.dueDate || t.dueTime
        ? `<span class="edu-meta">${escapeHtml(
            formatNaturalWhen(t.dueDate, t.dueTime)
          )}</span>`
        : "";
    const contextName = t.projectName || t.className;
    const klass = contextName
      ? `<span class="edu-meta">${escapeHtml(contextName)}</span>`
      : "";
    const href = todoHref(t);
    const classAttr = t.classId
      ? ` data-todo-class-id="${escapeHtml(t.classId)}"`
      : "";
    const projectAttr = t.projectId
      ? ` data-todo-project-id="${escapeHtml(t.projectId)}"`
      : "";
    return `<li class="edu-row edu-todo${done ? " is-done" : ""}" data-todo-id="${escapeHtml(
      t.id
    )}"${classAttr}${projectAttr}>
      <button type="button" class="edu-check${done ? " is-checked" : ""}" data-liquid-glass="circle" data-filter-id="lg-edu-check-${escapeHtml(
        t.projectId
          ? `p-${t.projectId}-${t.id}`
          : t.classId
            ? `${t.classId}-${t.id}`
            : t.id
      )}" data-todo-toggle aria-pressed="${done}" aria-label="Mark done"><span class="edu-check-dot" aria-hidden="true"></span></button>
      <a class="edu-row-link" href="${href}">
        <span class="edu-name">${escapeHtml(t.name || t.id)}</span>
        ${tagLabel}${klass}${due}
      </a>
    </li>`;
  }

  function dateRowHtml(d) {
    const when =
      d.date || d.time
        ? `<span class="edu-meta">${escapeHtml(formatNaturalWhen(d.date, d.time))}</span>`
        : "";
    const contextName = d.projectName || d.className;
    const klass = contextName
      ? `<span class="edu-meta">${escapeHtml(contextName)}</span>`
      : "";
    const href = dateHref(d);
    return `<li class="edu-row">
      <a class="edu-row-link" href="${href}">
        <span class="edu-name">${escapeHtml(d.name || d.id)}</span>
        ${klass}${when}
      </a>
    </li>`;
  }

  function dateItemRowHtml(item) {
    const when =
      item.date || item.time
        ? `<span class="edu-meta">${escapeHtml(
            formatNaturalWhen(item.date, item.time)
          )}</span>`
        : "";
    const contextName = item.projectName || item.className;
    const klass = contextName
      ? `<span class="edu-meta">${escapeHtml(contextName)}</span>`
      : "";
    const maTag = item.isMA ? `<span class="edu-tag">MA</span>` : "";
    // Todos in Dates always deep-link to the normal todo detail page (never /date/).
    const href =
      item.source === "todo"
        ? todoHref({
            id: item.id,
            classId: item.classId || null,
            projectId: item.projectId || null,
          })
        : dateHref({
            id: item.id,
            classId: item.classId || null,
            projectId: item.projectId || null,
          });
    return `<li class="edu-row">
      <a class="edu-row-link" href="${escapeHtml(href)}" data-date-item-source="${escapeHtml(
      item.source || "date"
    )}">
        <span class="edu-name">${escapeHtml(item.name)}</span>
        ${maTag}${klass}${when}
      </a>
    </li>`;
  }

  function projectRowHtml(p) {
    const href = `/education/project/${encodeURIComponent(p.id)}`;
    return `<li class="edu-row edu-class-row">
      <a class="edu-row-link" href="${escapeHtml(href)}">
        <span class="edu-name">${escapeHtml(p.name || p.id)}</span>
      </a>
    </li>`;
  }

  function projectsPanelHtml(filterId = "lg-edu-projects") {
    const projects = (tree?.projects || []).filter((p) => !isFixture(p));
    const rows = projects.map(projectRowHtml).join("");
    return panelHtml("Projects", listOrEmpty(rows), { filterId });
  }

  function classRowHtml(m, highlight) {
    const href = `/education/class/${encodeURIComponent(m.class.id)}`;
    return `<li class="edu-row edu-class-row${highlight ? " is-current" : ""}">
      <a class="edu-row-link" href="${href}">
        <span class="edu-tag edu-period">${escapeHtml(m.period)}</span>
        <span class="edu-name">${escapeHtml(classScheduleName(m.class))}</span>
      </a>
    </li>`;
  }

  /**
   * Next class that has not ended yet (today or a future school day).
   * @returns {{ dateKey: string, start: string, end: string, period: string } | null}
   */
  function nextClassOccurrence(cls, schedule) {
    if (!cls?.period) return null;
    const now = todayParts();
    let day = { y: now.y, m: now.m, day: now.day, weekday: now.weekday };
    for (let i = 0; i < 60; i++) {
      if (isSchoolDay(day, schedule)) {
        const dayClasses = classesForDay(day, schedule, [cls]);
        for (const m of dayClasses) {
          const isToday =
            day.y === now.y && day.m === now.m && day.day === now.day;
          if (isToday && m.endMin != null && now.minutes >= m.endMin) continue;
          return {
            dateKey: ymd(day.y, day.m, day.day),
            start: m.start,
            end: m.end,
            period: m.period,
          };
        }
      }
      day = addDays(day.y, day.m, day.day, 1);
    }
    return null;
  }

  function formatNextClassWhen(next) {
    if (!next) return "";
    const range = `${formatTime(next.start)}–${formatTime(next.end)}`;
    const target = parseYmd(next.dateKey);
    if (!target) return range;
    const now = todayParts();
    const delta = daysBetween(now, target);
    if (delta === 0) return `${range} today`;
    if (delta === 1) return `${range} tomorrow`;
    const dayAbbr = WEEKDAYS_SHORT[new Date(target.y, target.m - 1, target.day).getDay()];
    const showYear = target.y !== now.y;
    const showMonth = target.m !== now.m || target.y !== now.y;
    const dayPart = showMonth
      ? `${MONTHS[target.m - 1]} ${ordinal(target.day)}`
      : `the ${ordinal(target.day)}`;
    const yearPart = showYear ? `, ${target.y}` : "";
    const weekStart = addDays(now.y, now.m, now.day, -now.weekday);
    const weekOffset = daysBetween(weekStart, target);
    const inThisOrNextWeek = weekOffset >= 0 && weekOffset <= 13;
    const dateCore = `${dayPart}${yearPart}`;
    const dated = inThisOrNextWeek ? `${dayAbbr} ${dateCore}` : dateCore;
    return `${range} on ${dated}`;
  }

  function panelHtml(title, body, { extraClass = "", headExtra = "", filterId = "", titleHtml = "" } = {}) {
    const id =
      filterId ||
      `lg-edu-panel-${String(title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")}`;
    const heading = titleHtml || escapeHtml(title);
    return `<section class="edu-panel${extraClass ? ` ${extraClass}` : ""}" data-liquid-glass="rounded" data-filter-id="${escapeHtml(
      id
    )}">
      <div class="edu-panel-head">
        <h2 class="edu-panel-title">${heading}</h2>
        ${headExtra}
      </div>
      ${body}
    </section>`;
  }

  /**
   * Context-file query for /api/education/file.
   * @param {{ scope: string, id?: string, classId?: string, projectId?: string, name: string }} opts
   */
  function contextFileQuery(opts) {
    const q = new URLSearchParams();
    q.set("scope", String(opts.scope || ""));
    q.set("name", String(opts.name || ""));
    if (opts.id) q.set("id", String(opts.id));
    if (opts.classId) q.set("classId", String(opts.classId));
    if (opts.projectId) q.set("projectId", String(opts.projectId));
    return q.toString();
  }

  /**
   * Liquid-glass file tiles (newest first already from API).
   * @param {{ name: string }[]|null|undefined} files
   * @param {{ scope: string, id?: string, classId?: string, projectId?: string }} owner
   * @param {{ pair?: boolean, filterPrefix?: string }} [opts]
   */
  function filesHtml(files, owner, { pair = false, filterPrefix = "lg-edu-file" } = {}) {
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return "";
    const tiles = list
      .map((f, i) => {
        const name = String(f?.name || "").trim();
        if (!name) return "";
        const qs = contextFileQuery({ ...owner, name });
        const filterId = `${filterPrefix}-${i}`;
        return `<button type="button" class="edu-file-tile" data-liquid-glass="rounded" data-filter-id="${escapeHtml(
          filterId
        )}" data-edu-file="${escapeHtml(qs)}" title="${escapeHtml(name)}"><span class="edu-file-name">${escapeHtml(
          name
        )}</span></button>`;
      })
      .filter(Boolean)
      .join("");
    if (!tiles) return "";
    return `<div class="edu-files${pair ? " edu-files--pair" : ""}">${tiles}</div>`;
  }

  async function openContextFile(queryString) {
    const mac = window.YanMacApi;
    if (!mac?.macFetch || !queryString) return;
    try {
      const res = await mac.macFetch(`/api/education/file?${queryString}`, {
        timeoutMs: 120_000,
        headers: { Accept: "*/*" },
      });
      if (!res.ok) {
        console.error("[edu-file]", res.status);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      if (!opened) {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        const cd = res.headers.get("Content-Disposition") || "";
        const m = cd.match(/filename\*=UTF-8''([^;]+)|filename="([^"]+)"/i);
        const raw = m ? decodeURIComponent(m[1] || m[2] || "") : "";
        if (raw) a.download = raw;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      console.error("[edu-file]", err);
    }
  }

  function listOrEmpty(itemsHtml) {
    if (!itemsHtml) return `<p class="edu-empty">Nothing here</p>`;
    return `<ul class="edu-list">${itemsHtml}</ul>`;
  }

  const EDU_BACK_PATH =
    "M 18.13 25.56 L 45.69 9.65 Q 59.19 1.85 59.19 17.44 L 59.19 49.26 Q 59.19 64.85 45.69 57.06 L 18.13 41.15 Q 4.63 33.35 18.13 25.56 Z";

  function backLinkHtml(href, filterId = "lg-edu-back") {
    const shadowFilterId = `${filterId}-shadow`;
    return `<a class="edu-back" href="${escapeHtml(
      href
    )}" aria-label="Back"><svg class="edu-back-shadow" viewBox="0 0 63 68" width="63" height="68" aria-hidden="true" focusable="false"><defs><filter id="${escapeHtml(
      shadowFilterId
    )}" x="-80%" y="-80%" width="260%" height="260%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="12" result="blur"/><feOffset in="blur" dx="0" dy="6" result="offset"/><feFlood flood-color="currentColor" result="flood"/><feComposite in="flood" in2="offset" operator="in" result="shadow"/></filter></defs><path fill="#000" filter="url(#${escapeHtml(
      shadowFilterId
    )})" d="${EDU_BACK_PATH}"/></svg><span class="edu-back-glass" aria-hidden="true"></span></a>`;
  }

  function detailShell(backHref, title, bodyHtml, filterId, { canvasLink = "", filesHtml = "" } = {}) {
    const canvas = canvasOrbHtml(canvasLink);
    return `
      <header class="edu-hero edu-hero--detail${canvas ? " edu-hero--detail-canvas" : ""}">
        <div class="edu-hero-lead">
          ${backLinkHtml(backHref)}
          <h1 class="edu-hero-title">${escapeHtml(title)}</h1>
        </div>
        ${canvas}
      </header>
      <div class="edu-grid edu-grid--detail">
        ${panelHtml("Details", bodyHtml, { filterId })}
      </div>
      ${filesHtml}`;
  }

  function renderHome() {
    const todos = flattenTodos(tree).filter(matchesFilter);
    const open = todos
      .filter((t) => !t.done)
      .sort((a, b) => dueSortKey(a).localeCompare(dueSortKey(b)));
    const completed = todos
      .filter((t) => t.done)
      .sort((a, b) => completedSortKey(b).localeCompare(completedSortKey(a)));
    const sections = classSections(tree.schedule || {}, tree.classes || []);

    const dayPanel = (sec, i) => {
      const rows = sec.classes
        .map((m) => {
          const hl =
            sec.isToday &&
            m.startMin != null &&
            m.endMin != null &&
            sec.nowMinutes >= m.startMin &&
            sec.nowMinutes < m.endMin;
          return classRowHtml(m, hl);
        })
        .join("");
      return panelHtml(sec.label, listOrEmpty(rows), {
        extraClass: "edu-panel--day",
        filterId: `lg-edu-day-${sec.dateKey || i}`,
        titleHtml: sec.labelHtml || "",
      });
    };

    const day1 = sections[0] ? dayPanel(sections[0], 0) : "";
    const day2 = sections[1] ? dayPanel(sections[1], 1) : "";
    const datesPanel = datesPanelHtml({}, "lg-edu-dates");
    const projectsPanel = projectsPanelHtml();
    const rightCol =
      day1 || day2
        ? `${day1}${datesPanel}${day2}${projectsPanel}`
        : `${panelHtml("Classes", `<p class="edu-empty">No school days</p>`, {
            filterId: "lg-edu-classes",
          })}${datesPanel}${projectsPanel}`;

    appEl.innerHTML = `
      <div class="edu-grid edu-grid--home">
        <div class="edu-col edu-col--main">
          ${panelHtml("TODO", listOrEmpty(open.map(todoRowHtml).join("")), {
            filterId: "lg-edu-todo",
            headExtra: filterBarHtml(),
          })}
          ${panelHtml("Completed", listOrEmpty(completed.map(todoRowHtml).join("")), {
            filterId: "lg-edu-completed",
            extraClass: "edu-panel--completed",
          })}
        </div>
        <div class="edu-col edu-col--side">
          ${rightCol}
        </div>
      </div>
    `;
  }

  function renderClass() {
    const cls = (tree.classes || []).find(
      (c) => c.id === route.classId && !isFixture(c)
    );
    if (!cls) {
      appEl.innerHTML = detailShell(
        "/education/",
        "Missing",
        `<p class="edu-empty">Class not found.</p>`,
        "lg-edu-missing"
      );
      return;
    }
    const todos = flattenTodos(tree, { classId: cls.id }).filter(matchesFilter);
    const open = todos
      .filter((t) => !t.done)
      .sort((a, b) => dueSortKey(a).localeCompare(dueSortKey(b)));
    const completed = todos
      .filter((t) => t.done)
      .sort((a, b) => completedSortKey(b).localeCompare(completedSortKey(a)));

    const nextWhen = formatNextClassWhen(
      nextClassOccurrence(cls, tree.schedule || {})
    );
    const period = cls.period
      ? `<span class="edu-tag edu-period edu-period--hero">${escapeHtml(
          cls.period
        )}</span>`
      : "";
    const name = escapeHtml(classScheduleName(cls));
    const classDesc = String(cls.description || "").trim();

    appEl.innerHTML = `
      <header class="edu-hero edu-hero--detail">
        ${backLinkHtml("/education/", "lg-edu-back-class")}
        <h1 class="edu-hero-title edu-hero-title--class">${period}<span class="edu-hero-class-name">${name}</span></h1>
        ${
          nextWhen
            ? `<p class="edu-hero-sub">${escapeHtml(nextWhen)}</p>`
            : ""
        }
      </header>
      ${classDesc ? markdownPanelHtml(classDesc, "lg-edu-class-desc") : ""}
      <div class="edu-grid edu-grid--home">
        <div class="edu-col edu-col--main">
          ${panelHtml("TODO", listOrEmpty(open.map(todoRowHtml).join("")), {
            filterId: "lg-edu-class-todo",
            headExtra: filterBarHtml(),
          })}
          ${panelHtml("Completed", listOrEmpty(completed.map(todoRowHtml).join("")), {
            filterId: "lg-edu-class-completed",
            extraClass: "edu-panel--completed",
          })}
        </div>
        <div class="edu-col edu-col--side">
          ${datesPanelHtml({ classId: cls.id }, "lg-edu-class-dates")}
          ${filesHtml(cls.files, { scope: "class", id: cls.id }, {
            filterPrefix: "lg-edu-class-file",
          })}
        </div>
      </div>
    `;
  }

  function renderProject() {
    const project = (tree.projects || []).find(
      (p) => p.id === route.projectId && !isFixture(p)
    );
    if (!project) {
      appEl.innerHTML = detailShell(
        "/education/",
        "Missing",
        `<p class="edu-empty">Project not found.</p>`,
        "lg-edu-project-missing"
      );
      return;
    }
    const todos = flattenTodos(tree, { projectId: project.id }).filter(
      matchesFilter
    );
    const open = todos
      .filter((t) => !t.done)
      .sort((a, b) => dueSortKey(a).localeCompare(dueSortKey(b)));
    const completed = todos
      .filter((t) => t.done)
      .sort((a, b) => completedSortKey(b).localeCompare(completedSortKey(a)));
    const name = escapeHtml(project.name || project.id);
    const projectDesc = String(project.description || "").trim();

    appEl.innerHTML = `
      <header class="edu-hero edu-hero--detail">
        ${backLinkHtml("/education/", "lg-edu-back-project")}
        <h1 class="edu-hero-title">${name}</h1>
      </header>
      ${projectDesc ? markdownPanelHtml(projectDesc, "lg-edu-project-desc") : ""}
      <div class="edu-grid edu-grid--home">
        <div class="edu-col edu-col--main">
          ${panelHtml("TODO", listOrEmpty(open.map(todoRowHtml).join("")), {
            filterId: "lg-edu-project-todo",
            headExtra: filterBarHtml(),
          })}
          ${panelHtml("Completed", listOrEmpty(completed.map(todoRowHtml).join("")), {
            filterId: "lg-edu-project-completed",
            extraClass: "edu-panel--completed",
          })}
        </div>
        <div class="edu-col edu-col--side">
          ${datesPanelHtml({ projectId: project.id }, "lg-edu-project-dates")}
          ${filesHtml(project.files, { scope: "project", id: project.id }, {
            filterPrefix: "lg-edu-project-file",
          })}
        </div>
      </div>
    `;
  }

  function capsuleVoteKey(c) {
    const v = c && c.vote != null ? String(c.vote).toLowerCase() : "";
    return v === "up" || v === "down" ? v : "";
  }

  function voteChipHtml(capsuleId, value, current) {
    const on = current === value;
    const label = value === "up" ? "Thumbs up, more like this" : "Thumbs down, less like this";
    const glyph = value === "up" ? THUMB_UP_SVG : THUMB_DOWN_SVG;
    return `<button type="button" class="edu-filter circle edu-vote${
      on ? " is-on" : ""
    }" data-liquid-glass="circle" data-filter-id="lg-edu-vote-${escapeHtml(
      capsuleId
    )}-${value}" data-capsule-vote="${value}" data-capsule-id="${escapeHtml(
      capsuleId
    )}" aria-pressed="${on}" aria-label="${label}" title="${label}"><span>${glyph}</span></button>`;
  }

  function briefingStatusHtml(todo, { when, tag, contextName }) {
    return `<section class="edu-panel edu-briefing-status" data-liquid-glass="rounded" data-filter-id="lg-edu-briefing-status">
        <div class="edu-detail-row">
          <button type="button" class="edu-check${todo.done ? " is-checked" : ""}" data-liquid-glass="circle" data-filter-id="lg-edu-detail-check" data-todo-toggle aria-pressed="${Boolean(
            todo.done
          )}" aria-label="Mark done"><span class="edu-check-dot" aria-hidden="true"></span></button>
          <span class="edu-detail-status">${todo.done ? "Done" : "Open"}</span>
        </div>
        ${when ? `<p class="edu-detail-meta">${escapeHtml(when)}</p>` : ""}
        ${tag !== "none" ? `<p class="edu-detail-meta"><span class="edu-tag">${escapeHtml(tag)}</span></p>` : ""}
        ${contextName ? `<p class="edu-detail-meta">${escapeHtml(contextName)}</p>` : ""}
      </section>`;
  }

  function capsulesHtml(todo, { link = true } = {}) {
    const list = Array.isArray(todo.capsules) ? todo.capsules : [];
    if (!list.length) {
      return `<section class="edu-panel edu-capsule-panel" data-liquid-glass="rounded" data-filter-id="lg-edu-briefing-empty"><p class="edu-empty">Briefing is still compiling.</p></section>`;
    }
    const cards = list
      .map((c, i) => {
        const id = String(c?.id || `capsule-${i}`);
        const title = String(c?.title || "").trim() || "Untitled";
        const body = String(c?.body || "").trim();
        const noVote = c?.noVote === true;
        const current = capsuleVoteKey(c);
        const href = link && !noVote ? capsuleHref(todo, id) : "";
        const openAttr = href
          ? ` data-capsule-href="${escapeHtml(href)}" role="link" tabindex="0"`
          : "";
        const votesHtml = noVote
          ? ""
          : `<div class="edu-capsule-votes" role="group" aria-label="Rate this story. Thumbs up means more like this, thumbs down means less, and neither is a neutral rating.">
              ${voteChipHtml(id, "up", current)}
              ${voteChipHtml(id, "down", current)}
            </div>`;
        return `<section class="edu-panel edu-capsule edu-capsule-panel${
          href ? " edu-capsule--open" : ""
        }${noVote ? " edu-capsule--no-vote" : ""}" data-liquid-glass="rounded" data-filter-id="lg-edu-capsule-${escapeHtml(
          id
        )}" data-capsule-id="${escapeHtml(id)}"${openAttr}>
          <div class="edu-panel-head">
            <h2 class="edu-panel-title">${escapeHtml(title)}</h2>
            ${votesHtml}
          </div>
          ${body ? `<p class="edu-capsule-body">${escapeHtml(body)}</p>` : ""}
        </section>`;
      })
      .join("");
    const cites = link ? citationsHtml(overallCitations(todo), "lg-edu-briefing-citations") : "";
    return `${cards}${cites}`;
  }

  function renderTodoDetail() {
    const t = findTodoById(route.itemId, {
      classId: route.classId,
      projectId: route.projectId,
    });
    if (!t) {
      appEl.innerHTML = detailShell(
        "/education/",
        "Missing",
        `<p class="edu-empty">Todo not found.</p>`,
        "lg-edu-todo-missing"
      );
      return;
    }
    const tag = todoTagKey(t);
    const when = formatDetailWhen(t.dueDate, t.dueTime);
    const desc = String(t.description || "").trim();
    const capsules = Array.isArray(t.capsules) ? t.capsules : [];
    const isBriefing =
      String(t.kind || "") === "dailyBriefing" || capsules.length > 0;
    const classAttr = t.classId
      ? ` data-todo-class-id="${escapeHtml(t.classId)}"`
      : "";
    const projectAttr = t.projectId
      ? ` data-todo-project-id="${escapeHtml(t.projectId)}"`
      : "";
    const contextName = t.projectName || t.className;
    const fileTiles = filesHtml(
      t.files,
      {
        scope: "todo",
        id: t.id,
        classId: t.classId,
        projectId: t.projectId,
      },
      { pair: true, filterPrefix: "lg-edu-todo-file" }
    );

    if (isBriefing) {
      const canvas = canvasOrbHtml(t.canvasLink);
      appEl.innerHTML = `
      <header class="edu-hero edu-hero--detail${canvas ? " edu-hero--detail-canvas" : ""}">
        <div class="edu-hero-lead">
          ${backLinkHtml(backHrefForItem(t))}
          <h1 class="edu-hero-title">${escapeHtml(t.name || t.id)}</h1>
        </div>
        ${canvas}
      </header>
      <div class="edu-grid edu-grid--detail edu-detail" data-todo-id="${escapeHtml(
        t.id
      )}"${classAttr}${projectAttr}>
        ${briefingStatusHtml(t, { when, tag, contextName })}
        ${capsulesHtml(t)}
      </div>
      ${fileTiles}`;
      return;
    }

    const body = `
      <div class="edu-detail" data-todo-id="${escapeHtml(t.id)}"${classAttr}${projectAttr}>
        <div class="edu-detail-row">
          <button type="button" class="edu-check${t.done ? " is-checked" : ""}" data-liquid-glass="circle" data-filter-id="lg-edu-detail-check" data-todo-toggle aria-pressed="${Boolean(
            t.done
          )}" aria-label="Mark done"><span class="edu-check-dot" aria-hidden="true"></span></button>
          <span class="edu-detail-status">${t.done ? "Done" : "Open"}</span>
        </div>
        ${when ? `<p class="edu-detail-meta">${escapeHtml(when)}</p>` : ""}
        ${tag !== "none" ? `<p class="edu-detail-meta"><span class="edu-tag">${escapeHtml(tag)}</span></p>` : ""}
        ${contextName ? `<p class="edu-detail-meta">${escapeHtml(contextName)}</p>` : ""}
        ${descriptionHtml(desc)}
      </div>`;
    appEl.innerHTML = detailShell(backHrefForItem(t), t.name || t.id, body, "lg-edu-todo-detail", {
      canvasLink: t.canvasLink,
      filesHtml: fileTiles,
    });
  }

  function renderCapsuleDetail() {
    const t = findTodoById(route.itemId, {
      classId: route.classId,
      projectId: route.projectId,
    });
    const capsuleId = String(route.capsuleId || "");
    const cap = (t?.capsules || []).find(
      (c) => c && String(c.id) === capsuleId
    );
    if (!t || !cap) {
      appEl.innerHTML = detailShell(
        t ? todoHref(t) : "/education/",
        "Missing",
        `<p class="edu-empty">News story not found.</p>`,
        "lg-edu-capsule-missing"
      );
      return;
    }
    const title = String(cap.title || "").trim() || "Untitled";
    const classAttr = t.classId
      ? ` data-todo-class-id="${escapeHtml(t.classId)}"`
      : "";
    const projectAttr = t.projectId
      ? ` data-todo-project-id="${escapeHtml(t.projectId)}"`
      : "";
    const card = capsulesHtml(
      { ...t, capsules: [cap] },
      { link: false }
    );
    const cites = citationsHtml(
      parseCitations(cap.citations || cap.sources),
      "lg-edu-capsule-citations"
    );
    appEl.innerHTML = `
      <header class="edu-hero edu-hero--detail">
        <div class="edu-hero-lead">
          ${backLinkHtml(todoHref(t))}
          <h1 class="edu-hero-title">${escapeHtml(title)}</h1>
        </div>
      </header>
      <div class="edu-grid edu-grid--detail edu-detail" data-todo-id="${escapeHtml(
        t.id
      )}" data-capsule-id="${escapeHtml(String(cap.id))}"${classAttr}${projectAttr}>
        ${card}
        ${cites}
      </div>`;
  }

  function renderDateDetail() {
    const d = findDateById(route.itemId, {
      classId: route.classId,
      projectId: route.projectId,
    });
    if (!d) {
      appEl.innerHTML = detailShell(
        "/education/",
        "Missing",
        `<p class="edu-empty">Date not found.</p>`,
        "lg-edu-date-missing"
      );
      return;
    }
    const when = formatDetailWhen(d.date, d.time);
    const desc = String(d.description || "").trim();
    const contextName = d.projectName || d.className;
    const body = `
      <div class="edu-detail">
        ${when ? `<p class="edu-detail-meta">${escapeHtml(when)}</p>` : ""}
        ${contextName ? `<p class="edu-detail-meta">${escapeHtml(contextName)}</p>` : ""}
        ${descriptionHtml(desc)}
      </div>`;
    const fileTiles = filesHtml(
      d.files,
      {
        scope: "date",
        id: d.id,
        classId: d.classId,
        projectId: d.projectId,
      },
      { pair: true, filterPrefix: "lg-edu-date-file" }
    );
    appEl.innerHTML = detailShell(
      backHrefForItem(d),
      d.name || d.id,
      body,
      "lg-edu-date-detail",
      { canvasLink: d.canvasLink, filesHtml: fileTiles }
    );
  }

  function render({ scroll = "keep" } = {}) {
    if (!appEl || !tree) return;
    const keepX = window.scrollX;
    const keepY = window.scrollY;
    if (didEntrance) appEl.classList.add("is-settled");
    else {
      appEl.classList.remove("is-settled");
      window.setTimeout(() => appEl.classList.add("is-settled"), 1100);
    }

    if (route.view === "class") renderClass();
    else if (route.view === "project") renderProject();
    else if (route.view === "capsule") renderCapsuleDetail();
    else if (route.view === "todo") renderTodoDetail();
    else if (route.view === "date") renderDateDetail();
    else renderHome();

    didEntrance = true;
    applyScroll(scroll, keepX, keepY);
    queueMicrotask(() => window.reinitLiquidGlass?.());
  }

  function fingerprintTree(data) {
    try {
      return JSON.stringify(data);
    } catch {
      return String(Date.now());
    }
  }

  function ensurePanelList(panel) {
    let list = panel.querySelector(":scope > .edu-list");
    if (list) return list;
    panel.querySelectorAll(":scope > .edu-empty").forEach((el) => el.remove());
    list = document.createElement("ul");
    list.className = "edu-list";
    panel.appendChild(list);
    return list;
  }

  function markPanelEmptyIfNeeded(panel) {
    const list = panel.querySelector(":scope > .edu-list");
    if (list && list.children.length) return;
    list?.remove();
    if (!panel.querySelector(":scope > .edu-empty")) {
      const empty = document.createElement("p");
      empty.className = "edu-empty";
      empty.textContent = "Nothing here";
      panel.appendChild(empty);
    }
  }

  function insertTodoRowSorted(list, row, todo, isDone) {
    const key = isDone ? completedSortKey(todo || {}) : dueSortKey(todo || {});
    const children = [...list.children];
    for (const child of children) {
      if (child === row) continue;
      const id = child.getAttribute("data-todo-id");
      const childClass = child.getAttribute("data-todo-class-id") || null;
      const childProject = child.getAttribute("data-todo-project-id") || null;
      const other = id
        ? findTodoById(id, { classId: childClass, projectId: childProject })
        : null;
      if (!other) continue;
      const otherKey = isDone ? completedSortKey(other) : dueSortKey(other);
      const before = isDone
        ? otherKey.localeCompare(key) < 0 // completed: most recently checked-off first
        : key.localeCompare(otherKey) < 0; // open: soonest first (asc)
      if (before) {
        list.insertBefore(row, child);
        return;
      }
    }
    list.appendChild(row);
  }

  function setCheckUi(root, nextDone) {
    const check = root.matches?.("[data-todo-toggle], .edu-check")
      ? root
      : root.querySelector?.("[data-todo-toggle], .edu-check");
    if (!check) return;
    check.classList.toggle("is-checked", nextDone);
    check.setAttribute("aria-pressed", String(nextDone));
  }

  function todoDomSelector(todoId, { classId = null, projectId = null } = {}) {
    const idSel = `[data-todo-id="${CSS.escape(todoId)}"]`;
    if (projectId) {
      return `${idSel}[data-todo-project-id="${CSS.escape(projectId)}"]`;
    }
    if (classId) {
      return `${idSel}[data-todo-class-id="${CSS.escape(classId)}"]`;
    }
    return `${idSel}:not([data-todo-class-id]):not([data-todo-project-id])`;
  }

  /**
   * Update only the affected todo UI — no page rebuild, no entrance animation.
   * @returns {boolean} whether a DOM patch was applied
   */
  function patchTodoDoneDom(
    todoId,
    nextDone,
    { classId = null, projectId = null } = {}
  ) {
    if (!appEl) return false;

    const sel = todoDomSelector(todoId, { classId, projectId });

    // Detail page
    const detail = appEl.querySelector(`.edu-detail${sel}`);
    if (detail) {
      setCheckUi(detail, nextDone);
      const status = detail.querySelector(".edu-detail-status");
      if (status) status.textContent = nextDone ? "Done" : "Open";
      return true;
    }

    const row = appEl.querySelector(`li.edu-todo${sel}`);
    if (!row) return false;

    setCheckUi(row, nextDone);
    row.classList.toggle("is-done", nextDone);

    const openPanel =
      appEl.querySelector('[data-filter-id="lg-edu-todo"]') ||
      appEl.querySelector('[data-filter-id="lg-edu-class-todo"]') ||
      appEl.querySelector('[data-filter-id="lg-edu-project-todo"]');
    const donePanel =
      appEl.querySelector('[data-filter-id="lg-edu-completed"]') ||
      appEl.querySelector('[data-filter-id="lg-edu-class-completed"]') ||
      appEl.querySelector('[data-filter-id="lg-edu-project-completed"]');
    if (!openPanel || !donePanel) return true;

    const targetPanel = nextDone ? donePanel : openPanel;
    const sourcePanel = nextDone ? openPanel : donePanel;
    const targetList = ensurePanelList(targetPanel);

    if (row.parentElement !== targetList) {
      row.remove();
      markPanelEmptyIfNeeded(sourcePanel);
      insertTodoRowSorted(
        targetList,
        row,
        findTodoById(todoId, { classId, projectId }),
        nextDone
      );
    }
    return true;
  }

  function applyTodoDoneLocal(
    todoId,
    nextDone,
    { classId = null, projectId = null } = {}
  ) {
    const wantClass = classId || null;
    const wantProject = projectId || null;
    const apply = (list) => {
      const t = (list || []).find((x) => x.id === todoId);
      if (t) {
        t.done = nextDone;
        if (nextDone) t.completedAt = new Date().toISOString();
        else delete t.completedAt;
      }
    };
    if (wantProject) {
      const p = (tree.projects || []).find((x) => x.id === wantProject);
      if (p) apply(p.todos);
    } else if (wantClass) {
      const c = (tree.classes || []).find((x) => x.id === wantClass);
      if (c) apply(c.todos);
    } else {
      apply(tree.todos);
    }
    treeFingerprint = fingerprintTree(tree);
  }

  async function fetchData() {
    const mac = window.YanMacApi;
    if (!mac) throw new Error("YanMacApi missing");
    const res = await mac.macFetch("/api/education/data", {
      timeoutMs: 30_000,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `data ${res.status}`);
    const nextFp = fingerprintTree(data);
    if (tree && nextFp === treeFingerprint) return;
    tree = data;
    treeFingerprint = nextFp;
    if (data.email) userEmail = String(data.email).trim().toLowerCase();
    render();
  }

  async function toggleDone(
    todoId,
    nextDone,
    { classId = null, projectId = null } = {}
  ) {
    // Optimistic local + surgical DOM update (no fade / no full rebuild).
    applyTodoDoneLocal(todoId, nextDone, { classId, projectId });
    if (!patchTodoDoneDom(todoId, nextDone, { classId, projectId })) {
      render();
    }

    try {
      const mac = window.YanMacApi;
      if (!mac) throw new Error("YanMacApi missing");
      const qs = projectId
        ? `?projectId=${encodeURIComponent(projectId)}`
        : classId
          ? `?classId=${encodeURIComponent(classId)}`
          : "";
      const res = await mac.macFetch(
        `/api/education/todo/${encodeURIComponent(todoId)}/done${qs}`,
        {
          method: "PATCH",
          json: {
            done: nextDone,
            ...(projectId ? { projectId } : {}),
            ...(classId ? { classId } : {}),
          },
          timeoutMs: 30_000,
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `done ${res.status}`);
    } catch (err) {
      // Revert on failure
      applyTodoDoneLocal(todoId, !nextDone, { classId, projectId });
      if (!patchTodoDoneDom(todoId, !nextDone, { classId, projectId })) render();
      throw err;
    }
  }

  function applyCapsuleVoteLocal(
    todoId,
    capsuleId,
    nextVote,
    { classId = null, projectId = null } = {}
  ) {
    const wantClass = classId || null;
    const wantProject = projectId || null;
    const apply = (list) => {
      const t = (list || []).find((x) => x.id === todoId);
      if (!t || !Array.isArray(t.capsules)) return;
      const cap = t.capsules.find((c) => c && String(c.id) === capsuleId);
      if (cap) cap.vote = nextVote;
    };
    if (wantProject) {
      const p = (tree.projects || []).find((x) => x.id === wantProject);
      if (p) apply(p.todos);
    } else if (wantClass) {
      const c = (tree.classes || []).find((x) => x.id === wantClass);
      if (c) apply(c.todos);
    } else {
      apply(tree.todos);
    }
    treeFingerprint = fingerprintTree(tree);
  }

  function patchCapsuleVoteDom(todoId, capsuleId, nextVote) {
    if (!appEl) return false;
    const article = appEl.querySelector(
      `.edu-detail[data-todo-id="${CSS.escape(todoId)}"] .edu-capsule[data-capsule-id="${CSS.escape(
        capsuleId
      )}"]`
    );
    if (!article) return false;
    article.querySelectorAll("[data-capsule-vote]").forEach((btn) => {
      const value = btn.getAttribute("data-capsule-vote");
      const on = value === nextVote;
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-pressed", String(on));
    });
    return true;
  }

  async function setCapsuleVote(
    todoId,
    capsuleId,
    nextVote,
    { classId = null, projectId = null } = {}
  ) {
    const t = findTodoById(todoId, { classId, projectId });
    const cap = (t?.capsules || []).find((c) => c && String(c.id) === capsuleId);
    const prev = cap ? capsuleVoteKey(cap) : "";

    applyCapsuleVoteLocal(todoId, capsuleId, nextVote, { classId, projectId });
    if (!patchCapsuleVoteDom(todoId, capsuleId, nextVote)) render();

    try {
      const mac = window.YanMacApi;
      if (!mac) throw new Error("YanMacApi missing");
      const qs = projectId
        ? `?projectId=${encodeURIComponent(projectId)}`
        : classId
          ? `?classId=${encodeURIComponent(classId)}`
          : "";
      const res = await mac.macFetch(
        `/api/education/todo/${encodeURIComponent(todoId)}/capsule/${encodeURIComponent(
          capsuleId
        )}/vote${qs}`,
        {
          method: "PATCH",
          json: {
            vote: nextVote || null,
            ...(projectId ? { projectId } : {}),
            ...(classId ? { classId } : {}),
          },
          timeoutMs: 30_000,
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `vote ${res.status}`);
    } catch (err) {
      applyCapsuleVoteLocal(todoId, capsuleId, prev || null, {
        classId,
        projectId,
      });
      if (!patchCapsuleVoteDom(todoId, capsuleId, prev || null)) render();
      throw err;
    }
  }

  function bindAppClicks() {
    appEl?.addEventListener("click", (event) => {
      const t = /** @type {HTMLElement} */ (event.target);

      const datesToggle = t.closest?.("[data-dates-expand]");
      if (datesToggle) {
        event.preventDefault();
        datesExpanded = !datesExpanded;
        render();
        return;
      }

      const voteChip = t.closest?.("[data-capsule-vote]");
      if (voteChip) {
        event.preventDefault();
        event.stopPropagation();
        const row = voteChip.closest("[data-todo-id]");
        const todoId = row?.getAttribute("data-todo-id");
        const capsuleId = voteChip.getAttribute("data-capsule-id");
        const value = voteChip.getAttribute("data-capsule-vote");
        if (!todoId || !capsuleId || !value) return;
        const classId = row?.getAttribute("data-todo-class-id") || null;
        const projectId = row?.getAttribute("data-todo-project-id") || null;
        const on = voteChip.classList.contains("is-on");
        const next = on ? null : value;
        setCapsuleVote(todoId, capsuleId, next, { classId, projectId }).catch(
          (err) => console.error("[edu vote]", err)
        );
        return;
      }

      const capsuleHit = t.closest?.("[data-capsule-href]");
      if (capsuleHit) {
        event.preventDefault();
        const href = capsuleHit.getAttribute("data-capsule-href");
        if (href) navigate(href);
        return;
      }

      const dateFilterChip = t.closest?.(".edu-filter");
      if (dateFilterChip?.querySelector("input[data-date-filter]")) {
        event.preventDefault();
        const input = dateFilterChip.querySelector("input[data-date-filter]");
        const key = input?.getAttribute("data-date-filter");
        if (!key) return;
        if (dateFilter.has(key)) dateFilter.delete(key);
        else dateFilter.add(key);
        if (dateFilter.size === 0) DATE_FILTERS_HOME.forEach((x) => dateFilter.add(x));
        saveDateFilters();
        render();
        return;
      }

      const filterChip = t.closest?.(".edu-filter");
      if (filterChip) {
        event.preventDefault();
        const input = filterChip.querySelector("input[data-filter]");
        const key = input?.getAttribute("data-filter");
        if (!key) return;
        if (typeFilter.has(key)) typeFilter.delete(key);
        else typeFilter.add(key);
        if (typeFilter.size === 0) TAGS.forEach((x) => typeFilter.add(x));
        saveFilters();
        render();
        return;
      }

      const toggle = t.closest?.("[data-todo-toggle]");
      if (toggle) {
        event.preventDefault();
        event.stopPropagation();
        const row = toggle.closest("[data-todo-id]");
        const id = row?.getAttribute("data-todo-id");
        if (!id) return;
        const classId = row?.getAttribute("data-todo-class-id") || null;
        const projectId = row?.getAttribute("data-todo-project-id") || null;
        const next = !toggle.classList.contains("is-checked");
        toggleDone(id, next, { classId, projectId }).catch((err) =>
          console.error("[edu done]", err)
        );
        return;
      }

      const fileBtn = t.closest?.("[data-edu-file]");
      if (fileBtn) {
        event.preventDefault();
        const qs = fileBtn.getAttribute("data-edu-file");
        if (qs) openContextFile(qs);
        return;
      }

      const link = t.closest?.("a.edu-row-link, a.edu-back");
      if (link && link instanceof HTMLAnchorElement) {
        const href = link.getAttribute("href") || "";
        if (href.startsWith("/education")) {
          event.preventDefault();
          navigate(href, {
            scroll: link.classList.contains("edu-back") ? "restore" : "top",
          });
        }
      }
    });
  }

  function subscribeEvents() {
    const mac = window.YanMacApi;
    if (!mac) return;
    mac.subscribeEvents("/api/education/events", {
      onChange: () => {
        fetchData().catch((err) => console.error("[edu refresh]", err));
        // Same SSE path refreshes the floating education chat (agent reply / status).
        try {
          window.__eduChatRefresh?.();
        } catch (err) {
          console.warn("[edu chat refresh]", err);
        }
      },
      onError: (err) => console.warn("[edu sse]", err),
    });
    // Polling fallback while page is open (hits Mac, not Vercel)
    window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      fetchData().catch(() => {});
      try {
        window.__eduChatRefresh?.();
      } catch {
        /* ignore */
      }
    }, 45_000);
  }

  window.addEventListener("popstate", () => {
    captureScroll();
    route = parseRoute();
    render({ scroll: "restore" });
  });

  appEl?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const t = /** @type {HTMLElement} */ (event.target);
    const capsuleHit = t.closest?.("[data-capsule-href]");
    if (!capsuleHit || t.closest?.("[data-capsule-vote]")) return;
    event.preventDefault();
    const href = capsuleHit.getAttribute("data-capsule-href");
    if (href) navigate(href);
  });

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
      if (data.access !== "full") {
        show("denied");
        return;
      }
      userEmail = String(data.email || "")
        .trim()
        .toLowerCase();
      show("full");
      bindAppClicks();
      await fetchData();
      subscribeEvents();
      // Normalize /education → /education/
      if (window.location.pathname === "/education") {
        navigate("/education/", { replace: true, scroll: "keep" });
      }
    } catch (_) {
      show("login");
    }
  }

  // Expose refresh for chatbot after agent turns
  window.__eduRefresh = () => fetchData().catch(() => {});
  window.__eduUserEmail = () =>
    String(userEmail || tree?.email || "")
      .trim()
      .toLowerCase();

  /** Page context for the Personal Agent (home / class / project / todo / date). */
  window.__eduUiContext = () => {
    const r = route || parseRoute();
    /** @type {Record<string, unknown>} */
    const ctx = {
      client: "web",
      path: window.location.pathname + window.location.search,
      view: r.view || "home",
    };
    if (r.view === "class" && r.classId) {
      const cls = (tree?.classes || []).find((c) => c.id === r.classId);
      ctx.classId = r.classId;
      if (cls?.name) ctx.className = cls.name;
      if (cls?.period) ctx.period = String(cls.period).toUpperCase();
      if (cls?.freePeriod) ctx.freePeriod = true;
      ctx.title = cls?.name || r.classId;
    } else if (r.view === "project" && r.projectId) {
      const project = (tree?.projects || []).find((p) => p.id === r.projectId);
      ctx.projectId = r.projectId;
      if (project?.name) ctx.projectName = project.name;
      ctx.title = project?.name || r.projectId;
    } else if (r.view === "todo" && r.itemId) {
      const t = findTodoById(r.itemId, {
        classId: r.classId,
        projectId: r.projectId,
      });
      ctx.todoId = r.itemId;
      if (t?.name) ctx.todoName = t.name;
      if (t?.tag) ctx.tag = t.tag;
      if (typeof t?.done === "boolean") ctx.done = t.done;
      const projectId = t?.projectId || r.projectId;
      const classId = t?.classId || r.classId;
      if (projectId) {
        ctx.projectId = projectId;
        const project = (tree?.projects || []).find((p) => p.id === projectId);
        if (project?.name) ctx.projectName = project.name;
      } else if (classId) {
        ctx.classId = classId;
        const cls = (tree?.classes || []).find((c) => c.id === classId);
        if (cls?.name) ctx.className = cls.name;
        if (cls?.period) ctx.period = String(cls.period).toUpperCase();
      }
      ctx.title = t?.name || r.itemId;
    } else if (r.view === "capsule" && r.itemId) {
      const t = findTodoById(r.itemId, {
        classId: r.classId,
        projectId: r.projectId,
      });
      const cap = (t?.capsules || []).find(
        (c) => c && String(c.id) === String(r.capsuleId || "")
      );
      ctx.todoId = r.itemId;
      if (t?.name) ctx.todoName = t.name;
      if (r.capsuleId) ctx.capsuleId = r.capsuleId;
      if (cap?.title) ctx.capsuleTitle = cap.title;
      if (cap?.category) ctx.capsuleCategory = String(cap.category);
      const body = String(cap?.body || "").trim();
      if (body) ctx.capsuleBody = body;
      const citeText = formatCapsuleCitationsText(cap);
      if (citeText) ctx.capsuleCitations = citeText;
      const projectId = t?.projectId || r.projectId;
      const classId = t?.classId || r.classId;
      if (projectId) {
        ctx.projectId = projectId;
        const project = (tree?.projects || []).find((p) => p.id === projectId);
        if (project?.name) ctx.projectName = project.name;
      } else if (classId) {
        ctx.classId = classId;
        const cls = (tree?.classes || []).find((c) => c.id === classId);
        if (cls?.name) ctx.className = cls.name;
        if (cls?.period) ctx.period = String(cls.period).toUpperCase();
      }
      ctx.title = cap?.title || r.capsuleId || r.itemId;
    } else if (r.view === "date" && r.itemId) {
      const d = findDateById(r.itemId, {
        classId: r.classId,
        projectId: r.projectId,
      });
      ctx.dateId = r.itemId;
      if (d?.name) ctx.dateName = d.name;
      if (d?.date) ctx.date = d.date;
      const projectId = d?.projectId || r.projectId;
      const classId = d?.classId || r.classId;
      if (projectId) {
        ctx.projectId = projectId;
        const project = (tree?.projects || []).find((p) => p.id === projectId);
        if (project?.name) ctx.projectName = project.name;
      } else if (classId) {
        ctx.classId = classId;
        const cls = (tree?.classes || []).find((c) => c.id === classId);
        if (cls?.name) ctx.className = cls.name;
        if (cls?.period) ctx.period = String(cls.period).toUpperCase();
      }
      ctx.title = d?.name || r.itemId;
    } else {
      ctx.title = "Education home";
    }
    return ctx;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
