/**
 * File college-spam and routine security alerts out of Mail.app inbox/junk.
 * Jev only. Destinations are iCloud mailboxes Colleges and Security.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { listRecentAppleMail } from "./apple-mail.js";
import { choice, systemOne, typesafeConfig } from "./typesafe.js";

const execFileAsync = promisify(execFile);
const ROOT = dirname(fileURLToPath(import.meta.url));

export const STATE_PATH = "/tmp/yanylevin-apple-mail-file.json";
export const MOVE_SCRIPT = join(ROOT, "apple-mail-file.applescript");
export const POLL_MS = 10_000;
export const POLL_LIMIT = 20;
export const OVERLAP_MS = 20_000;
export const SEEN_MAX = 500;
export const MIN_CONFIDENCE = 0.5;
export const DEST_ACCOUNT = "iCloud";
export const DEST_COLLEGES = "Colleges";
export const DEST_SECURITY = "Security";

const FILE_QUESTION = choice(
  [
    "Pick one bucket for this email.",
    "college: unsolicited college-admissions marketing. Campus tours, apply-now, students-like-you, Common App or Coalition promo, university newsletters the recipient did not ask for, recruitment from a .edu or admissions office that is spam.",
    "security: routine sign-in or new-device noise. Google, Apple, Microsoft, GitHub, or similar 'new login', 'new device', 'was this you?' alerts that do not need action.",
    "other: everything else, including real people, PathIvy, EPS/Scoir counseling, a college the recipient already writes, interview or visit scheduling they started, receipts, and any 2FA or one-time passcode. One-time codes stay in the inbox.",
  ].join(" "),
  {
    college: "Unsolicited college admissions marketing",
    security: "Routine account sign-in or new-device alert, not a passcode",
    other: "Anything that should stay in the main inbox",
  }
);

/** @type {ReturnType<typeof setInterval>|null} */
let timer = null;
let ticking = false;

function messageKey(row) {
  const mid = String(row?.messageId || "").trim();
  if (mid) return `mid:${mid}`;
  const id = String(row?.id || "").trim();
  const account = String(row?.account || "").trim();
  if (id) return `id:${account}:${id}`;
  return "";
}

function receivedIso(row) {
  const raw = String(row?.received || "").trim();
  if (!raw) return "";
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

/**
 * @param {unknown} raw
 */
export function parseFileState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const lastAt = String(src.lastAt || "").trim();
  const seen = Array.isArray(src.seenIds)
    ? src.seenIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  return {
    lastAt: Number.isFinite(Date.parse(lastAt)) ? new Date(lastAt).toISOString() : "",
    seenIds: seen.slice(-SEEN_MAX),
  };
}

export async function loadFileState(path = STATE_PATH) {
  try {
    return parseFileState(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return parseFileState({});
  }
}

export async function saveFileState(state, path = STATE_PATH) {
  const next = parseFileState(state);
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function buildFileState(row) {
  return {
    account: String(row?.account || ""),
    folder: String(row?.folder || ""),
    from: String(row?.from || ""),
    to: String(row?.to || ""),
    subject: String(row?.subject || ""),
    received: String(row?.received || ""),
    message_id: String(row?.messageId || ""),
    body: String(row?.body || ""),
  };
}

/**
 * @param {{ choice?: string, confidence?: number } | null | undefined} answer
 */
export function decideFileAction(answer) {
  const bucket = String(answer?.choice || "").trim().toLowerCase();
  const confidence = Number(answer?.confidence);
  const conf = Number.isFinite(confidence) ? confidence : 0;
  if (bucket !== "college" && bucket !== "security") return "skip";
  if (conf < MIN_CONFIDENCE) return "skip";
  return bucket === "college" ? "colleges" : "security";
}

export function destMailboxForAction(action) {
  if (action === "colleges") return DEST_COLLEGES;
  if (action === "security") return DEST_SECURITY;
  return "";
}

/**
 * @param {{
 *   account: string,
 *   folder: string,
 *   id?: number | string,
 *   messageId?: string,
 *   destMailbox: string,
 * }} row
 */
export function moveArgs(row) {
  return [
    String(row.destMailbox || ""),
    String(row.account || ""),
    String(row.folder || ""),
    row.id == null || row.id === "" ? "" : String(row.id),
    String(row.messageId || ""),
  ];
}

export async function classifyMailRow(row, deps = {}) {
  const run = deps.systemOne || systemOne;
  const result = await run({
    state: buildFileState(row),
    questions: { bucket: FILE_QUESTION },
  });
  return result?.answers?.bucket;
}

export async function moveAndMarkRead(row, destMailbox, deps = {}) {
  const exec = deps.execFile || execFileAsync;
  const script = deps.script || MOVE_SCRIPT;
  const args = moveArgs({ ...row, destMailbox });
  const { stdout } = await exec("osascript", [script, ...args], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return String(stdout || "").trim();
}

/**
 * Classify and file a list of inbox/junk rows. Jev only.
 * @param {object[]} rows
 * @param {object} [deps]
 */
export async function fileMailRows(rows, deps = {}) {
  const classify = deps.classifyMailRow || classifyMailRow;
  const move = deps.moveAndMarkRead || moveAndMarkRead;
  const seen = new Set(
    Array.isArray(deps.seenIds) ? deps.seenIds.map((id) => String(id || "").trim()) : []
  );
  const skipSeen = deps.skipSeen !== false;
  const logEvery = Number(deps.logEvery) || 0;
  const list = Array.isArray(rows) ? rows : [];
  let filed = 0;
  let skipped = 0;
  let errors = 0;
  const nextSeen = [...seen];
  let i = 0;
  for (const row of list) {
    i += 1;
    const key = messageKey(row);
    if (skipSeen && key && seen.has(key)) continue;
    let answer;
    try {
      answer = await classify(row, deps);
    } catch (err) {
      errors += 1;
      console.error("[apple-mail-file] jev", err);
      continue;
    }
    const action = decideFileAction(answer);
    if (action === "skip") {
      if (key) {
        nextSeen.push(key);
        seen.add(key);
      }
      skipped += 1;
      if (logEvery && i % logEvery === 0) {
        console.log(
          `[apple-mail-file] ${i}/${list.length} filed=${filed} skipped=${skipped} errors=${errors}`
        );
      }
      continue;
    }
    const dest = destMailboxForAction(action);
    try {
      await move(row, dest, deps);
    } catch (err) {
      errors += 1;
      console.error("[apple-mail-file] move", err);
      continue;
    }
    if (key) {
      nextSeen.push(key);
      seen.add(key);
    }
    filed += 1;
    console.log(
      `[apple-mail-file] ${action} from=${row.from} subject=${String(row.subject || "").slice(0, 80)}`
    );
    if (logEvery && i % logEvery === 0) {
      console.log(
        `[apple-mail-file] ${i}/${list.length} filed=${filed} skipped=${skipped} errors=${errors}`
      );
    }
  }
  return {
    ok: true,
    filed,
    skipped,
    errors,
    scanned: list.length,
    nextSeen,
  };
}

/**
 * Newest inbox/junk messages across Mail.app accounts, then Jev-file them.
 * Does not change the live poller watermark.
 * @param {number} [limit]
 * @param {object} [deps]
 */
export async function backfillAppleMailFile(limit = 1000, deps = {}) {
  if (!typesafeConfig().configured && !deps.systemOne && !deps.classifyMailRow) {
    return { ok: false, skipped: "no-key" };
  }
  const n = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
  const list = deps.listRecentAppleMail || listRecentAppleMail;
  let rows = [];
  try {
    rows = await list({ newest: true, limit: n });
  } catch (err) {
    console.error("[apple-mail-file] list", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  console.log(
    `[apple-mail-file] backfill ${rows.length} messages` +
      (rows[0]?.received ? ` from ${rows[0].received}` : "") +
      (rows[rows.length - 1]?.received ? ` to ${rows[rows.length - 1].received}` : "")
  );
  const result = await fileMailRows(rows, {
    ...deps,
    skipSeen: false,
    logEvery: deps.logEvery ?? 25,
  });
  return {
    ...result,
    backfill: n,
    oldest: rows[0]?.received || "",
    newest: rows[rows.length - 1]?.received || "",
  };
}

/**
 * One poll. First run with empty state only writes a watermark (no backlog).
 * @param {object} [deps]
 */
export async function pollAppleMailFile(deps = {}) {
  const path = deps.statePath || STATE_PATH;
  const nowFn = deps.now || (() => new Date());
  const nowIso = nowFn().toISOString();
  const state = await loadFileState(path);

  if (!typesafeConfig().configured && !deps.systemOne && !deps.classifyMailRow) {
    return { ok: false, skipped: "no-key" };
  }

  if (!state.lastAt) {
    await saveFileState({ lastAt: nowIso, seenIds: [] }, path);
    return { ok: true, skipped: "watermark", filed: 0 };
  }

  const sinceMs = Date.parse(state.lastAt) - OVERLAP_MS;
  const since = new Date(Math.max(0, sinceMs)).toISOString();
  const list = deps.listRecentAppleMail || listRecentAppleMail;
  let rows = [];
  try {
    rows = await list({ since, limit: 80 });
  } catch (err) {
    console.error("[apple-mail-file] list", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const seen = new Set(state.seenIds);
  /** @type {object[]} */
  const hits = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = messageKey(row);
    if (!key || seen.has(key)) continue;
    hits.push(row);
  }
  const batch = hits.slice(0, POLL_LIMIT);
  const result = await fileMailRows(batch, {
    ...deps,
    seenIds: state.seenIds,
    skipSeen: true,
  });
  let newest = state.lastAt;
  for (const row of batch) {
    const at = receivedIso(row);
    if (at && at > newest) newest = at;
  }
  if (nowIso > newest && batch.length === hits.length) newest = nowIso;
  await saveFileState(
    { lastAt: newest, seenIds: result.nextSeen.slice(-SEEN_MAX) },
    path
  );
  return {
    ok: true,
    filed: result.filed,
    skipped: result.skipped,
    scanned: Array.isArray(rows) ? rows.length : 0,
    pending: Math.max(0, hits.length - batch.length),
  };
}

export function startAppleMailFileScheduler() {
  if (timer) return;
  if (!typesafeConfig().configured) {
    console.warn("[apple-mail-file] TYPESAFE_API_KEY missing; filer off");
    return;
  }
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    pollAppleMailFile()
      .catch((err) => console.error("[apple-mail-file] poll", err))
      .finally(() => {
        ticking = false;
      });
  }, POLL_MS);
  timer.unref?.();
  pollAppleMailFile().catch((err) =>
    console.error("[apple-mail-file] first poll", err)
  );
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const cmd = process.argv[2] || "once";
  const n = Number(process.argv[3]) || 1000;
  if (cmd !== "once" && cmd !== "poll" && cmd !== "backfill") {
    console.error("usage: node --env-file=.env apple-mail-file.js once|backfill [n]");
    process.exit(2);
  }
  const run = cmd === "backfill" ? backfillAppleMailFile(n) : pollAppleMailFile();
  run
    .then((out) => {
      console.log(JSON.stringify(out));
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
