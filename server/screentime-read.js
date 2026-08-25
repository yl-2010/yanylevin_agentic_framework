/**
 * Read-only Apple Screen Time / app usage via knowledgeC.db on the Mac Studio.
 * iPhone, iPad, and MacBook usage syncs here when Screen Time sharing is on.
 * Requires Full Disk Access for node. Never copies the DB into the repo.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_DB = join(homedir(), "Library/Application Support/Knowledge/knowledgeC.db");
export const APPLE_EPOCH_S = 978_307_200;
export const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 14;
const TOP_APPS_PER_DEVICE = 12;
const TOP_APPS_WEEK = 20;
const TOP_DOMAINS = 8;
const MIN_APP_SECONDS = 60;
const MAX_SESSION_SECONDS = 12 * 3600;

const TRACKER_RE =
  /doubleclick|googlesyndication|googleadservices|googleads|googletagmanager|google-analytics|scorecardresearch|facebook\.net|tiqcdn|adservice|\.ads\.|pixel\.|adnxs|rubiconproject/i;

/** @type {Record<string, { name: string, category: string }>} */
const APP_CATALOG = {
  "ai.perplexity.comet": { name: "Perplexity Comet", category: "browser" },
  "cameronnazemi.Tappy": { name: "Tappy", category: "game" },
  "com.adobe.LightroomClassicCC7": { name: "Lightroom Classic", category: "creative" },
  "com.apple.AppStore": { name: "App Store", category: "system" },
  "com.apple.calculator": { name: "Calculator", category: "system" },
  "com.apple.dt.Devices": { name: "Devices", category: "productivity" },
  "com.apple.dt.Xcode": { name: "Xcode", category: "productivity" },
  "com.apple.facetime": { name: "FaceTime", category: "messaging" },
  "com.apple.finder": { name: "Finder", category: "system" },
  "com.apple.FinalCut": { name: "Final Cut Pro", category: "creative" },
  "com.apple.Home": { name: "Home", category: "system" },
  "com.apple.iCal": { name: "Calendar", category: "productivity" },
  "com.apple.IconComposer": { name: "Icon Composer", category: "creative" },
  "com.apple.mail": { name: "Mail", category: "messaging" },
  "com.apple.Maps": { name: "Maps", category: "travel" },
  "com.apple.MobileSMS": { name: "Messages", category: "messaging" },
  "com.apple.mobilenotes": { name: "Notes", category: "productivity" },
  "com.apple.Music": { name: "Music", category: "video" },
  "com.apple.news": { name: "News", category: "news" },
  "com.apple.Photos": { name: "Photos", category: "creative" },
  "com.apple.Preferences": { name: "Settings", category: "system" },
  "com.apple.Preview": { name: "Preview", category: "system" },
  "com.apple.Safari": { name: "Safari", category: "browser" },
  "com.apple.ScreenshotServicesService": { name: "Screenshots", category: "system" },
  "com.apple.systempreferences": { name: "System Settings", category: "system" },
  "com.apple.Terminal": { name: "Terminal", category: "productivity" },
  "com.apple.TV": { name: "TV", category: "video" },
  "com.apple.tv": { name: "TV", category: "video" },
  "com.burbn.barcelona": { name: "Threads", category: "social" },
  "com.burbn.instagram": { name: "Instagram", category: "social" },
  "com.chromanoir.Zeit": { name: "Zeit", category: "other" },
  "com.duolingo.DuolingoMobile": { name: "Duolingo", category: "education" },
  "com.google.chrome": { name: "Chrome", category: "browser" },
  "com.google.ios.youtube": { name: "YouTube", category: "video" },
  "com.openai.chat": { name: "ChatGPT", category: "productivity" },
  "com.spotify.client": { name: "Spotify", category: "video" },
  "com.supercell.scroll": { name: "Supercell", category: "game" },
  "com.tesla.riders": { name: "Tesla", category: "travel" },
  "com.todesktop.230313mzl4w4u92": { name: "Cursor", category: "productivity" },
  "com.toyopagroup.picaboo": { name: "Snapchat", category: "social" },
  "com.example.personalagent": { name: "Yan Levin", category: "productivity" },
  "com.zhiliaoapp.musically": { name: "TikTok", category: "video" },
  "company.thebrowser.ArcMobile2": { name: "Arc", category: "browser" },
  "company.thebrowser.Browser": { name: "Arc", category: "browser" },
  "net.whatsapp.WhatsApp": { name: "WhatsApp", category: "messaging" },
  "tv.parsec.www": { name: "Parsec", category: "remote" },
  "us.zoom.xos": { name: "Zoom", category: "messaging" },
};

const MODEL_NAMES = {
  "Mac15,14": "Mac Studio",
  "Mac14,9": "MacBook",
  "iPhone15,3": "iPhone",
  "iPad16,5": "iPad",
  "Watch6,14": "Watch",
  "AppleTV14,1": "Apple TV",
  "AudioAccessory5,1": "HomePod",
};

const SKIP_KINDS = new Set(["watch", "apple tv", "homepod"]);

export function defaultKnowledgeDb() {
  return String(process.env.SCREENTIME_DB_PATH || "").trim() || DEFAULT_DB;
}

/**
 * @param {string} sql
 * @param {{ db?: string }} [opts]
 */
export async function queryKnowledge(sql, opts = {}) {
  const db = opts.db || defaultKnowledgeDb();
  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      ["-readonly", "-json", db, sql],
      { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }
    );
    const text = String(stdout || "").trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      /unable to open|authorization|permission|not a database/i.test(msg)
        ? "Screen Time DB unreadable. Grant Full Disk Access to Terminal/node (System Settings > Privacy & Security > Full Disk Access)."
        : msg
    );
    wrapped.cause = err;
    throw wrapped;
  }
}

/**
 * @param {string} [model]
 * @param {string|null} [deviceId]
 */
export function deviceLabel(model, deviceId = null) {
  const m = String(model || "").trim();
  if (MODEL_NAMES[m]) return MODEL_NAMES[m];
  if (/^iPhone/i.test(m)) return "iPhone";
  if (/^iPad/i.test(m)) return "iPad";
  if (/^Watch/i.test(m)) return "Watch";
  if (/^AppleTV/i.test(m)) return "Apple TV";
  if (/^AudioAccessory/i.test(m)) return "HomePod";
  if (/^Mac15,14/i.test(m)) return "Mac Studio";
  if (/^Mac/i.test(m)) return "Mac";
  if (!deviceId) return "Mac Studio";
  return "Unknown device";
}

export function deviceKind(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("iphone")) return "iphone";
  if (n.includes("ipad")) return "ipad";
  if (n.includes("studio")) return "studio";
  if (n.includes("macbook") || n === "mac") return "macbook";
  if (n.includes("watch")) return "watch";
  if (n.includes("tv")) return "apple tv";
  if (n.includes("homepod")) return "homepod";
  return "other";
}

export function appInfo(bundle) {
  const id = String(bundle || "").trim();
  if (APP_CATALOG[id]) return { bundle: id, ...APP_CATALOG[id] };
  const last = id.split(".").pop() || id;
  const name = last.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  let category = "other";
  if (/^com\.apple\./i.test(id)) category = "system";
  return { bundle: id, name, category };
}

export function dateKeyInTimeZone(date, timezone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function hourInTimeZone(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(date);
    return Number(parts.find((p) => p.type === "hour")?.value);
  } catch {
    return date.getUTCHours();
  }
}

function roundMinutes(seconds) {
  return Math.round((Number(seconds) / 60) * 10) / 10;
}

function isTrackerDomain(domain) {
  return TRACKER_RE.test(String(domain || ""));
}

/**
 * @param {{
 *   startMs: number,
 *   endMs: number,
 *   bundle: string,
 *   deviceId?: string|null,
 *   model?: string|null,
 * }[]} rows
 * @param {{ timezone: string, now?: Date, lookbackDays?: number }} opts
 */
export function summarizeUsage(rows, opts) {
  const timezone = opts.timezone || "America/Chicago";
  const now = opts.now instanceof Date ? opts.now : new Date();
  const lookbackDays = Math.min(
    MAX_LOOKBACK_DAYS,
    Math.max(1, Number(opts.lookbackDays) || DEFAULT_LOOKBACK_DAYS)
  );
  const sinceMs = now.getTime() - lookbackDays * 24 * 60 * 60 * 1000;
  const sinceKey = dateKeyInTimeZone(new Date(sinceMs), timezone);

  /** @type {Map<string, { name: string, model: string|null, lastEnd: string, sessions: number }>} */
  const devices = new Map();
  /** @type {Map<string, { dateKey: string, devices: Map<string, any>, hourly: number[], categories: Map<string, number> }>} */
  const days = new Map();
  /** @type {Map<string, { minutes: number, sessions: number, info: ReturnType<typeof appInfo> }>} */
  const weekApps = new Map();

  for (const row of rows) {
    const startMs = Number(row.startMs);
    const endMs = Number(row.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const seconds = Math.min(MAX_SESSION_SECONDS, (endMs - startMs) / 1000);
    if (seconds < 1) continue;
    if (endMs < sinceMs) continue;
    const info = appInfo(row.bundle);
    const name = deviceLabel(row.model, row.deviceId || null);
    const kind = deviceKind(name);
    if (SKIP_KINDS.has(kind)) continue;
    const dateKey = dateKeyInTimeZone(new Date(startMs), timezone);
    if (dateKey < sinceKey) continue;

    const endIso = new Date(endMs).toISOString();
    const prevDev = devices.get(name);
    if (!prevDev) {
      devices.set(name, {
        name,
        kind,
        model: row.model || null,
        lastEnd: endIso,
        sessions: 1,
      });
    } else {
      prevDev.sessions += 1;
      if (endIso > prevDev.lastEnd) prevDev.lastEnd = endIso;
    }

    let day = days.get(dateKey);
    if (!day) {
      day = {
        dateKey,
        devices: new Map(),
        hourly: Array(24).fill(0),
        categories: new Map(),
      };
      days.set(dateKey, day);
    }
    const hour = hourInTimeZone(new Date(startMs), timezone);
    if (Number.isFinite(hour) && hour >= 0 && hour < 24) {
      day.hourly[hour] += seconds;
    }
    day.categories.set(
      info.category,
      (day.categories.get(info.category) || 0) + seconds
    );

    let devDay = day.devices.get(name);
    if (!devDay) {
      devDay = { name, kind, totalSeconds: 0, sessions: 0, apps: new Map() };
      day.devices.set(name, devDay);
    }
    devDay.totalSeconds += seconds;
    devDay.sessions += 1;
    const appRow = devDay.apps.get(info.bundle) || {
      ...info,
      seconds: 0,
      sessions: 0,
    };
    appRow.seconds += seconds;
    appRow.sessions += 1;
    devDay.apps.set(info.bundle, appRow);

    const week = weekApps.get(info.bundle) || { minutes: 0, sessions: 0, info };
    week.minutes += seconds / 60;
    week.sessions += 1;
    weekApps.set(info.bundle, week);
  }

  const dayList = [...days.values()]
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
    .map((day) => {
      const deviceList = [...day.devices.values()]
        .map((d) => {
          const apps = [...d.apps.values()]
            .filter((a) => a.seconds >= MIN_APP_SECONDS)
            .sort((a, b) => b.seconds - a.seconds)
            .slice(0, TOP_APPS_PER_DEVICE)
            .map((a) => ({
              name: a.name,
              bundle: a.bundle,
              category: a.category,
              minutes: roundMinutes(a.seconds),
              sessions: a.sessions,
            }));
          return {
            name: d.name,
            kind: d.kind,
            totalMinutes: roundMinutes(d.totalSeconds),
            sessions: d.sessions,
            apps,
          };
        })
        .sort((a, b) => b.totalMinutes - a.totalMinutes);
      const categories = [...day.categories.entries()]
        .map(([category, seconds]) => ({
          category,
          minutes: roundMinutes(seconds),
        }))
        .filter((c) => c.minutes >= 1)
        .sort((a, b) => b.minutes - a.minutes);
      const hourly = day.hourly
        .map((seconds, hour) => ({ hour, minutes: roundMinutes(seconds) }))
        .filter((h) => h.minutes >= 1);
      return {
        dateKey: day.dateKey,
        totalMinutes: Math.round(
          deviceList.reduce((sum, d) => sum + d.totalMinutes, 0) * 10
        ) / 10,
        devices: deviceList,
        categories,
        hourly,
      };
    });

  return {
    timezone,
    since: new Date(sinceMs).toISOString(),
    lookbackDays,
    devices: [...devices.values()].sort((a, b) => a.name.localeCompare(b.name)),
    days: dayList,
    weekTopApps: [...weekApps.values()]
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, TOP_APPS_WEEK)
      .filter((a) => a.minutes >= 1)
      .map((a) => ({
        name: a.info.name,
        bundle: a.info.bundle,
        category: a.info.category,
        minutes: Math.round(a.minutes * 10) / 10,
        sessions: a.sessions,
      })),
  };
}

function appleSince(sinceMs) {
  return sinceMs / 1000 - APPLE_EPOCH_S;
}

/**
 * @param {{ days?: number, timezone?: string, now?: Date, db?: string }} [opts]
 */
export async function screenTimeSummary(opts = {}) {
  const timezone = opts.timezone || "America/Chicago";
  const now = opts.now instanceof Date ? opts.now : new Date();
  const days = Math.min(
    MAX_LOOKBACK_DAYS,
    Math.max(1, Number(opts.days) || DEFAULT_LOOKBACK_DAYS)
  );
  const sinceMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  const sinceApple = appleSince(sinceMs);
  const usageSql = `
    SELECT
      o.ZSTARTDATE as startApple,
      o.ZENDDATE as endApple,
      o.ZVALUESTRING as bundle,
      s.ZDEVICEID as deviceId,
      p.ZMODEL as model
    FROM ZOBJECT o
    LEFT JOIN ZSOURCE s ON o.ZSOURCE = s.Z_PK
    LEFT JOIN (
      SELECT ZDEVICEID, MAX(ZMODEL) AS ZMODEL
      FROM ZSYNCPEER
      WHERE ZMODEL IS NOT NULL AND TRIM(ZMODEL) != ''
      GROUP BY ZDEVICEID
    ) p ON p.ZDEVICEID = s.ZDEVICEID
    WHERE o.ZSTREAMNAME = '/app/usage'
      AND o.ZENDDATE >= ${sinceApple}
      AND o.ZVALUESTRING IS NOT NULL
      AND o.ZVALUESTRING != '';
  `;
  const raw = await queryKnowledge(usageSql, { db: opts.db });
  const rows = raw.map((row) => ({
    startMs: (Number(row.startApple) + APPLE_EPOCH_S) * 1000,
    endMs: (Number(row.endApple) + APPLE_EPOCH_S) * 1000,
    bundle: String(row.bundle || ""),
    deviceId: row.deviceId || null,
    model: row.model || null,
  }));
  const summary = summarizeUsage(rows, { timezone, now, lookbackDays: days });

  let domains = [];
  try {
    const webSql = `
      SELECT
        m.Z_DKDIGITALHEALTHMETADATAKEY__WEBDOMAIN as domain,
        SUM(o.ZENDDATE - o.ZSTARTDATE) as seconds
      FROM ZOBJECT o
      JOIN ZSTRUCTUREDMETADATA m ON o.ZSTRUCTUREDMETADATA = m.Z_PK
      WHERE o.ZSTREAMNAME = '/app/webUsage'
        AND o.ZENDDATE >= ${sinceApple}
        AND m.Z_DKDIGITALHEALTHMETADATAKEY__WEBDOMAIN IS NOT NULL
        AND m.Z_DKDIGITALHEALTHMETADATAKEY__WEBDOMAIN != ''
      GROUP BY domain
      ORDER BY seconds DESC
      LIMIT 40;
    `;
    const webRows = await queryKnowledge(webSql, { db: opts.db });
    domains = webRows
      .filter((r) => !isTrackerDomain(r.domain))
      .map((r) => ({
        domain: String(r.domain || ""),
        minutes: roundMinutes(Number(r.seconds) || 0),
      }))
      .filter((r) => r.domain && r.minutes >= 1)
      .slice(0, TOP_DOMAINS);
  } catch {
    domains = [];
  }

  return {
    ok: true,
    at: now.toISOString(),
    ...summary,
    webDomains: domains,
  };
}

/**
 * @param {{ limit?: number, since?: string, db?: string }} [opts]
 */
export async function recentSessions(opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 40, 1), 80);
  const sinceMs = opts.since ? Date.parse(String(opts.since)) : Date.now() - 24 * 60 * 60 * 1000;
  const sinceApple = Number.isFinite(sinceMs) ? appleSince(sinceMs) : appleSince(Date.now() - 86400000);
  const sql = `
    SELECT
      o.ZSTARTDATE as startApple,
      o.ZENDDATE as endApple,
      o.ZVALUESTRING as bundle,
      s.ZDEVICEID as deviceId,
      p.ZMODEL as model
    FROM ZOBJECT o
    LEFT JOIN ZSOURCE s ON o.ZSOURCE = s.Z_PK
    LEFT JOIN (
      SELECT ZDEVICEID, MAX(ZMODEL) AS ZMODEL
      FROM ZSYNCPEER
      WHERE ZMODEL IS NOT NULL AND TRIM(ZMODEL) != ''
      GROUP BY ZDEVICEID
    ) p ON p.ZDEVICEID = s.ZDEVICEID
    WHERE o.ZSTREAMNAME = '/app/usage'
      AND o.ZENDDATE >= ${sinceApple}
      AND o.ZVALUESTRING IS NOT NULL
    ORDER BY o.ZSTARTDATE DESC
    LIMIT ${limit};
  `;
  const raw = await queryKnowledge(sql, { db: opts.db });
  return raw.map((row) => {
    const startMs = (Number(row.startApple) + APPLE_EPOCH_S) * 1000;
    const endMs = (Number(row.endApple) + APPLE_EPOCH_S) * 1000;
    const info = appInfo(row.bundle);
    return {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      minutes: roundMinutes(Math.max(0, (endMs - startMs) / 1000)),
      device: deviceLabel(row.model, row.deviceId || null),
      ...info,
    };
  });
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const args = process.argv.slice(2);
  const cmd = args[0] || "help";
  const rest = args.slice(1).join(" ");
  const run = async () => {
    if (cmd === "summary") {
      return screenTimeSummary({ days: rest || DEFAULT_LOOKBACK_DAYS });
    }
    if (cmd === "recent") {
      return recentSessions({ since: rest || undefined });
    }
    return {
      ok: false,
      usage: "node screentime-read.js summary [days] | recent [since-iso]",
    };
  };
  run()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}
