/**
 * Grok Bot usage snapshots for the /usage page (Source = Grok Bot).
 *
 * Grok Bot does not report tokens per run to this Mac. What it can read is its
 * plan page: plan name, weekly limit % used and reset, on-demand $ used of the
 * cycle limit (shared with Cursor), and share-of-usage breakdowns. A Grok Bot
 * routine pushes that page as a snapshot. One JSON line per snapshot lands in
 * USAGE_DIR/grokbot.jsonl next to rows.jsonl, so history survives and the
 * custom date range can read old days.
 *
 *   node server/grokbot-usage.js ingest < snapshot.json     # or --json '{...}'
 *   node server/grokbot-usage.js list [--days 30]
 *
 * POST /api/usage/grokbot (Bearer USAGE_INGEST_TOKEN) calls the same ingest.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { USAGE_DIR } from "./onedrive-projects.js";

export const GROKBOT_USAGE_PATH = join(USAGE_DIR, "grokbot.jsonl");
export const SHARE_WINDOWS = ["this_week", "last_7_days", "last_30_days"];
export const SHARE_BY = ["day", "bot", "routine", "activity"];
const MAX_ROWS = 60;
const MAX_NAME = 120;
const PACIFIC_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

class SnapshotError extends Error {}

function iso(value, field, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) throw new SnapshotError(`${field} is required (ISO time with offset or Z)`);
    return "";
  }
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms) || !/(Z|[+-]\d{2}:?\d{2})$/i.test(String(value).trim())) {
    throw new SnapshotError(`${field} must be an ISO time with offset or Z`);
  }
  return new Date(ms).toISOString();
}

function number(value, field, { min = 0, max = Infinity, required = false } = {}) {
  if (value == null || value === "") {
    if (required) throw new SnapshotError(`${field} is required`);
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new SnapshotError(`${field} must be a number from ${min} to ${max}`);
  return n;
}

/**
 * Validate and normalize one snapshot. Throws SnapshotError with a readable message.
 * @param {any} body
 */
export function normalizeGrokBotSnapshot(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SnapshotError("snapshot must be a JSON object");
  }
  const weekly = body.weekly && typeof body.weekly === "object" ? body.weekly : null;
  if (!weekly) throw new SnapshotError("weekly { percentUsed, resetsAt } is required");
  const onDemand = body.onDemand && typeof body.onDemand === "object" ? body.onDemand : null;
  const shares = Array.isArray(body.shares) ? body.shares : [];
  if (shares.length > 12) throw new SnapshotError("at most 12 share breakdowns");
  return {
    at: iso(body.at, "at", { required: true }),
    plan: String(body.plan || "").trim().slice(0, 80),
    weekly: {
      percentUsed: number(weekly.percentUsed, "weekly.percentUsed", { max: 100000, required: true }),
      resetsAt: iso(weekly.resetsAt, "weekly.resetsAt"),
    },
    onDemand: onDemand
      ? {
          usedDollars: number(onDemand.usedDollars, "onDemand.usedDollars", { required: true }),
          limitDollars: number(onDemand.limitDollars, "onDemand.limitDollars"),
          resetsAt: iso(onDemand.resetsAt, "onDemand.resetsAt"),
          sharedWithCursor: onDemand.sharedWithCursor !== false,
        }
      : null,
    shares: shares.map((share, i) => {
      const where = `shares[${i}]`;
      if (!share || typeof share !== "object") throw new SnapshotError(`${where} must be an object`);
      if (!SHARE_WINDOWS.includes(share.window)) throw new SnapshotError(`${where}.window must be ${SHARE_WINDOWS.join(" | ")}`);
      if (!SHARE_BY.includes(share.by)) throw new SnapshotError(`${where}.by must be ${SHARE_BY.join(" | ")}`);
      const rows = Array.isArray(share.rows) ? share.rows : [];
      if (rows.length > MAX_ROWS) throw new SnapshotError(`${where}.rows: at most ${MAX_ROWS}`);
      if (share.by === "day" && share.dayTimezone && share.dayTimezone !== "UTC" && share.dayTimezone !== "America/Los_Angeles") {
        throw new SnapshotError(`${where}.dayTimezone must be UTC or America/Los_Angeles`);
      }
      return {
        window: share.window,
        by: share.by,
        ...(share.by === "day" ? { dayTimezone: share.dayTimezone || "UTC" } : {}),
        rows: rows.map((row, j) => {
          const name = String(row?.name || "").trim().slice(0, MAX_NAME);
          if (!name) throw new SnapshotError(`${where}.rows[${j}].name is required`);
          if (share.by === "day" && !/^\d{4}-\d{2}-\d{2}$/.test(name)) {
            throw new SnapshotError(`${where}.rows[${j}].name must be YYYY-MM-DD for by=day`);
          }
          return { name, percent: number(row.percent, `${where}.rows[${j}].percent`, { max: 100, required: true }) };
        }),
      };
    }),
  };
}

/**
 * @param {any} body
 * @param {{ path?: string }} [opts]
 */
export async function ingestGrokBotSnapshot(body, { path = GROKBOT_USAGE_PATH } = {}) {
  const snapshot = normalizeGrokBotSnapshot(body);
  const existing = await readGrokBotSnapshots({ path });
  if (existing.some((row) => row.at === snapshot.at && JSON.stringify(row) === JSON.stringify(snapshot))) {
    return { ok: true, wrote: 0, snapshot };
  }
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, `${JSON.stringify(snapshot)}\n`, "utf8");
  return { ok: true, wrote: 1, snapshot };
}

/**
 * @param {{ path?: string }} [opts]
 */
export async function readGrokBotSnapshots({ path = GROKBOT_USAGE_PATH } = {}) {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(normalizeGrokBotSnapshot(JSON.parse(line)));
    } catch {
      /* skip a bad line */
    }
  }
  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return out;
}

/**
 * The page needs the latest snapshot of each Pacific day (history for any
 * date range) plus the newest overall.
 * @param {object[]} snapshots sorted oldest first
 * @param {{ fromMs?: number }} [opts]
 */
export function dailyGrokBotSnapshots(snapshots, { fromMs = 0 } = {}) {
  /** @type {Map<string, object>} */
  const byDay = new Map();
  for (const snap of snapshots) {
    const t = Date.parse(snap.at);
    if (!Number.isFinite(t) || t < fromMs) continue;
    byDay.set(PACIFIC_DAY.format(new Date(t)), snap);
  }
  return [...byDay.values()];
}

/** Payload for /api/usage/index. */
export async function grokBotUsageForIndex({ fromMs = 0, path } = {}) {
  const all = await readGrokBotSnapshots(path ? { path } : {});
  return {
    snapshots: dailyGrokBotSnapshots(all, { fromMs }),
    latest: all.at(-1) || null,
  };
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function cli(argv) {
  const cmd = argv[0] || "list";
  if (cmd === "ingest") {
    const at = argv.indexOf("--json");
    const text = at >= 0 ? String(argv[at + 1] || "") : await readStdin();
    let body;
    try {
      body = JSON.parse(text);
    } catch (err) {
      throw new SnapshotError(`snapshot is not valid JSON: ${err instanceof Error ? err.message : err}`);
    }
    const result = await ingestGrokBotSnapshot(body);
    return { ...result, path: GROKBOT_USAGE_PATH };
  }
  if (cmd === "list") {
    const at = argv.indexOf("--days");
    const days = at >= 0 ? Number(argv[at + 1]) || 30 : 30;
    const fromMs = Date.now() - days * 24 * 60 * 60 * 1000;
    return { ok: true, path: GROKBOT_USAGE_PATH, ...(await grokBotUsageForIndex({ fromMs })) };
  }
  throw new SnapshotError(`unknown command ${cmd}. Use ingest or list.`);
}

export function isSnapshotError(err) {
  return err instanceof SnapshotError;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  cli(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((err) => {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }, null, 2));
      process.exitCode = err instanceof SnapshotError ? 2 : 1;
    });
}
