/**
 * Nightly Composer 2.5 (Fast off): retitle Personal Agent chats from the
 * full transcript. 01:30 local, 30 minutes after the first nightly round.
 * --backfill covers every thread before local today.
 */

import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CHAT_TITLE_STYLE } from "./chat-title.js";
import {
  briefingNow,
  chatTitleRefreshHm,
  hmToMinutes,
  resolveBriefingTimezone,
  zonedLocalToUtc,
} from "./daily-briefing-agent.js";
import {
  chatHistoryDirRel,
  chatHistoryTouchMs,
  listChatHistoryFiles,
} from "./education-chat-history.js";
import { gitAddCommitPush } from "./git-publish.js";
import { FULL_ACCESS_EMAILS, OWNER_EMAIL as YAN_EMAIL } from "./identity.js";
import {
  createLaterAuthRetry,
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
} from "./cursor-sdk-auth.js";
import { nextLocalHmAt } from "./location-history-agent.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = "/tmp/yanylevin-chat-title-refresh.lock";
const META_PATH = join(
  REPO_ROOT,
  "education",
  YAN_EMAIL,
  "daily-briefing",
  "meta.json"
);
const STATE_REL = `education/${YAN_EMAIL}/daily-briefing/chat-title-refresh-state.json`;
const LOCK_STALE_MS = 90 * 60 * 1000;

export const CHAT_TITLE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const CHAT_TITLE_REFRESH_BATCH_SIZE = 36;

export const CHAT_TITLE_REFRESH_MODEL_SPEC = {
  id: process.env.CURSOR_CHAT_TITLE_REFRESH_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

export const CHAT_TITLE_REFRESH_EMAILS = [...FULL_ACCESS_EMAILS].sort();

/** @type {Promise<unknown>|null} */
let inFlight = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;

const laterAuthRetry = createLaterAuthRetry({
  prefix: "chat-title-refresh",
  run: ({ dateKey }) => runChatTitleRefresh({ dateKey, force: true }),
});

/**
 * @param {{ id: string, params?: { id: string, value: string }[] }} spec
 */
function modelSelection(spec) {
  return {
    id: String(spec.id),
    params: (spec.params || []).map((p) => ({
      id: String(p.id),
      value: String(p.value),
    })),
  };
}

/**
 * @param {string} apiKey
 * @param {{ id: string, params: { id: string, value: string }[] }} spec
 */
async function resolveModelSelection(apiKey, spec) {
  const fallback = modelSelection(spec);
  try {
    const { Cursor } = await import("@cursor/sdk");
    const models = await Cursor.models.list({ apiKey });
    const listed = models?.find((m) => m?.id === fallback.id);
    if (!listed) return fallback;
    const wanted = fallback.params;
    const variant = (listed.variants || []).find((v) => {
      const params = v?.params || [];
      if (wanted.length === 0) return !params.length;
      return wanted.every((w) =>
        params.some((p) => p.id === w.id && p.value === w.value)
      );
    });
    if (variant?.params?.length) {
      return modelSelection({ id: listed.id, params: variant.params });
    }
    return fallback;
  } catch (err) {
    console.warn(
      "[chat-title-refresh] model catalog lookup failed; using explicit ModelSelection",
      err instanceof Error ? err.message : err
    );
    return fallback;
  }
}

async function readMeta() {
  const raw = await readFile(META_PATH, "utf8");
  const meta = JSON.parse(raw);
  if (!meta || typeof meta !== "object") {
    throw new Error("daily-briefing meta.json missing");
  }
  return meta;
}

function statePath(root = REPO_ROOT) {
  return join(root, STATE_REL);
}

async function readState(root = REPO_ROOT) {
  try {
    const raw = await readFile(statePath(root), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {object} state
 * @param {string} [root]
 */
async function writeState(state, root = REPO_ROOT) {
  await writeFile(statePath(root), `${JSON.stringify(state, null, 2)}\n`);
}

export function chatTitleRefreshModelSpec() {
  return modelSelection(CHAT_TITLE_REFRESH_MODEL_SPEC);
}

export function nextChatTitleRefreshAt(meta, now = new Date()) {
  return nextLocalHmAt(meta, chatTitleRefreshHm(meta), now);
}

/**
 * Local start of the current briefing date.
 * @param {object} meta
 * @param {Date} [now]
 */
export function localStartOfTodayMs(meta, now = new Date()) {
  const clock = briefingNow(meta, now);
  const tz = resolveBriefingTimezone(meta, clock.dateKey);
  return zonedLocalToUtc(clock.dateKey, "00:00", tz).getTime();
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} [size]
 */
export function chunkArray(items, size = CHAT_TITLE_REFRESH_BATCH_SIZE) {
  const n = Math.max(1, Number(size) || CHAT_TITLE_REFRESH_BATCH_SIZE);
  /** @type {T[][]} */
  const out = [];
  for (let i = 0; i < items.length; i += n) {
    out.push(items.slice(i, i + n));
  }
  return out;
}

/**
 * @param {{
 *   email?: string,
 *   sessionId?: string,
 *   path?: string,
 *   title?: string,
 *   updated?: string,
 *   started?: string,
 *   mtimeMs?: number,
 * }[]} rows
 * @param {{ backfill?: boolean, sinceMs?: number, beforeMs?: number }} opts
 */
export function selectChatTitleRefreshTargets(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (opts.backfill) {
    const beforeMs = Number(opts.beforeMs);
    if (!Number.isFinite(beforeMs)) return [];
    return list.filter((row) => chatHistoryTouchMs(row) < beforeMs);
  }
  const sinceMs = Number(opts.sinceMs);
  if (!Number.isFinite(sinceMs)) return [];
  return list.filter((row) => chatHistoryTouchMs(row) >= sinceMs);
}

/**
 * @param {object} opts
 * @param {string} opts.dateKey
 * @param {string} opts.timezone
 * @param {boolean} [opts.backfill]
 * @param {{ path: string, title?: string, email?: string, updated?: string }[]} opts.chats
 * @param {number} [opts.batch]
 * @param {number} [opts.batchCount]
 */
export function buildChatTitleRefreshPrompt({
  dateKey,
  timezone,
  backfill = false,
  chats,
  batch = 1,
  batchCount = 1,
}) {
  const lines = (chats || []).map((row) => {
    const path = String(row.path || "").trim();
    const title = String(row.title || "").trim() || "(none)";
    const email = String(row.email || "").trim();
    const updated = String(row.updated || "").trim();
    return `- ${path}  email=${email}  updated=${updated}  title=${title}`;
  });
  const window = backfill
    ? "Backfill: every listed thread is from before local today. Skip chats that are only from today."
    : "Nightly window: listed threads were updated in the last 24 hours.";
  return [
    "Follow the chat-title-refresh skill (.cursor/skills/chat-title-refresh/SKILL.md).",
    "Retitle Personal Agent chats from the full transcript. Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}). Batch ${batch} of ${batchCount}.`,
    window,
    CHAT_TITLE_STYLE,
    "Read each listed file. Rewrite only the title: line. Keep visibility. Do not change messages. Do not glob .chat-history/. Do not git commit.",
    "Listed chats:",
    lines.join("\n") || "(none)",
  ].join("\n");
}

export async function listChatTitleRefreshCandidates({
  backfill = false,
  now = new Date(),
  root = REPO_ROOT,
  meta,
} = {}) {
  const schedule = meta || (await readMeta());
  const sinceMs = now.getTime() - CHAT_TITLE_LOOKBACK_MS;
  const beforeMs = localStartOfTodayMs(schedule, now);
  /** @type {Awaited<ReturnType<typeof listChatHistoryFiles>>} */
  const all = [];
  for (const email of CHAT_TITLE_REFRESH_EMAILS) {
    const rows = await listChatHistoryFiles({ email, root });
    all.push(...rows);
  }
  return selectChatTitleRefreshTargets(all, { backfill, sinceMs, beforeMs });
}

async function acquireLock() {
  try {
    const handle = await open(LOCK_PATH, "wx");
    await handle.writeFile(String(process.pid));
    return handle;
  } catch (err) {
    if (!err || /** @type {{ code?: string }} */ (err).code !== "EEXIST") {
      throw err;
    }
    try {
      const st = await stat(LOCK_PATH);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await rm(LOCK_PATH, { force: true });
        const handle = await open(LOCK_PATH, "wx");
        await handle.writeFile(String(process.pid));
        return handle;
      }
    } catch {
      /* still locked */
    }
    return null;
  }
}

async function releaseLock(handle) {
  try {
    await handle.close();
  } catch {
    /* ignore */
  }
  await rm(LOCK_PATH, { force: true });
}

/**
 * Existing chat-history dirs plus the refresh state file.
 * @param {string} [root]
 */
export async function chatTitleRefreshGitPaths(root = REPO_ROOT) {
  /** @type {string[]} */
  const paths = [];
  for (const email of CHAT_TITLE_REFRESH_EMAILS) {
    const rel = chatHistoryDirRel(email);
    try {
      await stat(join(root, rel));
      paths.push(rel);
    } catch {
      /* no chats for this user yet */
    }
  }
  paths.push(STATE_REL);
  return paths;
}

export async function refreshRanOn(dateKey, root = REPO_ROOT) {
  const state = await readState(root);
  return String(state?.lastRefreshDateKey || "") === String(dateKey);
}

/**
 * @param {{ force?: boolean, backfill?: boolean, dateKey?: string, root?: string, now?: Date }} [opts]
 */
export async function runChatTitleRefresh(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = runChatTitleRefreshOnce(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runChatTitleRefreshOnce({
  force = false,
  backfill = false,
  root = REPO_ROOT,
  now = new Date(),
} = {}) {
  const meta = await readMeta();
  const clock = briefingNow(meta, now);
  const dateKey = clock.dateKey;
  const timezone = resolveBriefingTimezone(meta, dateKey);

  const handle = await acquireLock();
  if (!handle) {
    console.log(`[chat-title-refresh] skip ${dateKey}: in-flight lock`);
    return { ok: true, skipped: true, reason: "in-flight", dateKey, backfill };
  }

  try {
    if (!backfill && !force && (await refreshRanOn(dateKey, root))) {
      laterAuthRetry.clear();
      return { ok: true, skipped: true, reason: "already-ran", dateKey };
    }

    const chats = await listChatTitleRefreshCandidates({
      backfill,
      now,
      root,
      meta,
    });
    if (!chats.length) {
      if (!backfill) {
        await writeState(
          {
            ...(await readState(root)),
            lastRefreshDateKey: dateKey,
            lastRefreshAt: new Date().toISOString(),
          },
          root
        );
      }
      laterAuthRetry.clear();
      return {
        ok: true,
        skipped: true,
        reason: "no-chats",
        dateKey,
        backfill,
        count: 0,
      };
    }

    await reloadCursorApiKeyFromEnv();
    const apiKey = requireCursorApiKey();
    const model = await resolveModelSelection(
      apiKey,
      CHAT_TITLE_REFRESH_MODEL_SPEC
    );
    const batches = chunkArray(chats, CHAT_TITLE_REFRESH_BATCH_SIZE);
    console.log(
      `[chat-title-refresh] ${dateKey} tz=${timezone} model=${model.id} chats=${chats.length} batches=${batches.length}${backfill ? " backfill" : ""}`
    );

    let lastResult = null;
    for (let i = 0; i < batches.length; i++) {
      const prompt = buildChatTitleRefreshPrompt({
        dateKey,
        timezone,
        backfill,
        chats: batches[i],
        batch: i + 1,
        batchCount: batches.length,
      });
      const { result, authFailed, capacityFailed, transientFailed, usedFallback } =
        await promptWithAuthRetry({
          prefix: "chat-title-refresh",
          prompt,
          model,
          cwd: REPO_ROOT,
        });
      lastResult = result;
      if (usedFallback) {
        console.warn("[chat-title-refresh] used auto after preferred-model retries");
      }
      if (transientFailed) {
        laterAuthRetry.schedule(dateKey);
        return {
          ok: false,
          dateKey,
          backfill,
          status: result?.status || "error",
          reason: authFailed ? "auth" : capacityFailed ? "capacity" : "error",
          count: chats.length,
        };
      }
    }

    const prev = await readState(root);
    const nextState = {
      ...prev,
      lastRefreshAt: new Date().toISOString(),
    };
    if (backfill) {
      nextState.lastBackfillAt = nextState.lastRefreshAt;
    } else {
      nextState.lastRefreshDateKey = dateKey;
    }
    await writeState(nextState, root);

    laterAuthRetry.clear();
    const paths = await chatTitleRefreshGitPaths(root);
    await gitAddCommitPush({
      paths,
      message: backfill
        ? `education: ${dateKey} chat title backfill`
        : `education: ${dateKey} chat title refresh`,
    });

    return {
      ok: true,
      dateKey,
      backfill,
      status: lastResult?.status || "finished",
      count: chats.length,
      batches: batches.length,
    };
  } finally {
    await releaseLock(handle);
  }
}

async function maybeRunMissed() {
  try {
    const meta = await readMeta();
    const now = briefingNow(meta);
    if (now.minutes < hmToMinutes(chatTitleRefreshHm(meta))) return;
    if (await refreshRanOn(now.dateKey)) return;
    console.log(`[chat-title-refresh] missed-job recovery for ${now.dateKey}`);
    await runChatTitleRefresh();
  } catch (err) {
    console.error("[chat-title-refresh] missed-job recovery failed", err);
  }
}

function armTimer(meta) {
  if (timer) clearTimeout(timer);
  const when = nextChatTitleRefreshAt(meta);
  const delay = Math.max(1000, when.getTime() - Date.now());
  const capped = Math.min(delay, 24 * 60 * 60 * 1000);
  console.log(
    `[chat-title-refresh] next run ${when.toISOString()} (in ${Math.round(capped / 60000)} min)`
  );
  timer = setTimeout(() => {
    runChatTitleRefresh()
      .catch((err) =>
        console.error("[chat-title-refresh] scheduled run failed", err)
      )
      .finally(() => {
        readMeta()
          .then((m) => armTimer(m))
          .catch((err) => {
            console.error("[chat-title-refresh] reschedule failed", err);
            timer = setTimeout(
              () => startChatTitleRefreshScheduler(),
              60 * 60 * 1000
            );
          });
      });
  }, capped);
}

export function startChatTitleRefreshScheduler() {
  readMeta()
    .then((meta) => {
      armTimer(meta);
      setTimeout(() => {
        maybeRunMissed().catch((err) =>
          console.error("[chat-title-refresh] missed recovery", err)
        );
      }, 16000);
    })
    .catch((err) => {
      console.error("[chat-title-refresh] scheduler start failed", err);
    });
}

const isMain = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return pathToFileURL(arg).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  const force = process.argv.includes("--force");
  const backfill = process.argv.includes("--backfill");
  runChatTitleRefresh({ force: force || backfill, backfill })
    .then((result) => {
      console.log("[chat-title-refresh]", result);
      if (!result?.ok && !result?.skipped) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[chat-title-refresh] failed", err);
      process.exitCode = 1;
    });
}
