/**
 * Dump clocks and speaker labels for nightly writers.
 * iMessage sqlite `at` is UTC with no suffix. Agents paste it as local unless
 * we also give them atLocal and a speaker they cannot confuse with the chat.
 */

export const DEFAULT_LOCAL_TZ = "America/Los_Angeles";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * @param {unknown} raw
 */
export function parseDumpAt(raw) {
  const s = String(raw || "").trim();
  if (!s) return NaN;
  if (s.includes("T") || /Z$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) {
    return Date.parse(s);
  }
  return Date.parse(`${s.replace(" ", "T")}Z`);
}

/**
 * @param {unknown} raw
 */
export function isoUtcFromDumpAt(raw) {
  const ms = parseDumpAt(raw);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

/**
 * @param {unknown} raw
 */
export function phoneDigits(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d;
  if (d.length === 10) return `1${d}`;
  return d;
}

/**
 * First name writers can copy. Phones stay phones.
 * @param {unknown} raw
 */
export function givenName(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("+") || /^\d+$/.test(s)) return s;
  const beforeAt = s.includes("@") ? s.slice(0, s.indexOf("@")) : s;
  const token = beforeAt.split(/[\s._-]+/).filter(Boolean)[0] || "";
  if (!token) return s;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * @param {unknown} raw
 * @param {string} [timeZone]
 */
export function formatAtLocal(raw, timeZone = DEFAULT_LOCAL_TZ) {
  const ms = parseDumpAt(raw);
  if (!Number.isFinite(ms)) return "";
  const tz = String(timeZone || DEFAULT_LOCAL_TZ);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const weekday = get("weekday");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const dayPeriod = get("dayPeriod");
  if (!weekday || !month || !day) return "";
  return `${weekday} ${month} ${day}, ${hour}:${minute} ${dayPeriod} PT`;
}

/**
 * @param {string} dateKey
 */
export function addDateKeyDays(dateKey, days) {
  const [y, m, d] = String(dateKey)
    .split("-")
    .map((n) => Number(n));
  if (!y || !m || !d) return "";
  const dt = new Date(Date.UTC(y, m - 1, d + Number(days || 0)));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Weekday of a YYYY-MM-DD calendar date. US zones share the same weekday.
 * @param {string} dateKey
 */
export function dateKeyWeekday(dateKey) {
  const [y, m, d] = String(dateKey)
    .split("-")
    .map((n) => Number(n));
  if (!y || !m || !d) return "";
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return WEEKDAYS[dt.getUTCDay()] || "";
}

/**
 * @param {string} dateKey
 * @param {{ year?: boolean }} [opts]
 */
export function prettyDateKey(dateKey, opts = {}) {
  const [y, m, d] = String(dateKey)
    .split("-")
    .map((n) => Number(n));
  if (!y || !m || !d) return "";
  const weekday = dateKeyWeekday(dateKey);
  const month = MONTHS[m - 1] || "";
  const day = String(d);
  if (opts.year) return `${weekday} ${month} ${day}, ${y}`;
  return `${weekday} ${month} ${day}`;
}

/**
 * @param {string} dateKey
 * @param {string} [timeZone]
 */
export function weekDateHelper(dateKey, timeZone = DEFAULT_LOCAL_TZ) {
  const key = String(dateKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return "";
  const tz = String(timeZone || DEFAULT_LOCAL_TZ);
  const job = prettyDateKey(key, { year: true });
  const yest = addDateKeyDays(key, -1);
  const yestPretty = prettyDateKey(yest);
  const [y, m, d] = key.split("-").map((n) => Number(n));
  const wd = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
  const sunday = addDateKeyDays(key, -wd);
  /** @type {string[]} */
  const days = [];
  for (let i = 0; i < 7; i++) {
    const k = addDateKeyDays(sunday, i);
    const label = prettyDateKey(k);
    if (k === key) days.push(`${label} (today)`);
    else if (k === yest) days.push(`${label} (yesterday)`);
    else days.push(label);
  }
  const nextSun = prettyDateKey(addDateKeyDays(sunday, 7));
  return [
    `Job date ${job} (${tz}).`,
    `Yesterday (journal day) is ${yestPretty}.`,
    `This week: ${days.join("; ")}.`,
    `Next Sunday is ${nextSun}.`,
    `A chat or mail that says Thursday without a date means this week's Thursday, not a guess.`,
    `Convert weekday words (tmmr, Thursday this week, Sunday) to YYYY-MM-DD in this zone before writing them.`,
  ].join(" ");
}

/**
 * @param {Iterable<Record<string, unknown>>} [people]
 * @returns {Map<string, string>}
 */
export function contactHandleNames(people) {
  /** @type {Map<string, string>} */
  const map = new Map();
  const put = (key, label) => {
    const k = String(key || "").trim().toLowerCase();
    if (!k || !label || map.has(k)) return;
    map.set(k, label);
  };
  for (const p of people || []) {
    const label = String(p.first || "").trim() || givenName(p.name);
    if (!label) continue;
    for (const token of String(p.phones || "").split(/[,;]|\s+(?=\+)/)) {
      const digits = phoneDigits(token);
      if (digits.length >= 10) {
        put(digits, label);
        put(`+${digits}`, label);
      }
    }
    const whole = phoneDigits(p.phones);
    if (whole.length >= 10 && whole.length <= 11) {
      put(whole, label);
      put(`+${whole}`, label);
    }
    for (const token of String(p.emails || "").split(/[\s,;]+/)) {
      const email = String(token || "").trim().toLowerCase();
      if (email.includes("@")) put(email, label);
    }
  }
  return map;
}

/**
 * @param {unknown} handle
 * @param {Map<string, string>|undefined|null} names
 */
export function lookupSpeakerName(handle, names) {
  if (!names || typeof names.get !== "function") return "";
  const raw = String(handle || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (names.has(lower)) return names.get(lower) || "";
  const digits = phoneDigits(raw);
  if (digits && names.has(digits)) return names.get(digits) || "";
  if (digits && names.has(`+${digits}`)) return names.get(`+${digits}`) || "";
  return "";
}

/**
 * Display name of who said the line. Never the 1:1 chat title on a fromMe row.
 * @param {Record<string, unknown>} message
 * @param {Map<string, string>|undefined|null} [names]
 */
export function speakerLabel(message, names) {
  if (message?.fromMe) return "Yan";
  const from = String(message?.from || "").trim();
  if (from) {
    return (
      lookupSpeakerName(message.fromEmail, names) ||
      givenName(from) ||
      from
    );
  }
  const who = String(message?.who || "");
  if (who === "yan") return "Yan";
  const looked =
    lookupSpeakerName(message?.handle, names) ||
    lookupSpeakerName(message?.chatId, names) ||
    lookupSpeakerName(who, names);
  if (looked) return looked;
  if (who === "them") {
    const chat = String(message?.chat || "").trim();
    if (chat && !chat.startsWith("+") && !/^chat/i.test(chat)) {
      return givenName(chat) || chat;
    }
    return "them";
  }
  if (who) return givenName(who) || who;
  return "them";
}

/**
 * Stamp UTC `at`, Pacific `atLocal`, and `speaker` onto a dump row.
 * @param {Record<string, unknown>} msg
 * @param {{ names?: Map<string, string>|null, timeZone?: string }} [opts]
 */
export function applyDumpClock(msg, opts = {}) {
  if (!msg || typeof msg !== "object") return msg;
  const iso = isoUtcFromDumpAt(msg.at);
  if (iso) msg.at = iso;
  msg.atLocal = formatAtLocal(msg.at, opts.timeZone);
  msg.speaker = speakerLabel(msg, opts.names);
  return msg;
}
