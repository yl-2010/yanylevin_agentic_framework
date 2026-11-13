/**
 * Poll school Teams chats for Yan fromMe texts that mention @agent.
 * Each hit starts a normal Personal Agent session (app + website).
 *
 * Teams listing returns the last N messages of every chat that changed,
 * not only messages since the watermark. So the poller itself must drop
 * old rows. A mention starts a session only when it is new on every axis:
 * - created after the watermark (minus a short overlap),
 * - created within MAX_AGE_MS of now,
 * - created after the newest mention already handled in that chat,
 * - its message key was never handled before.
 * Created time comes from the Teams message id (epoch ms, fixed on edit)
 * and the row time, whichever is older, so an edit never looks new.
 * State lives under data/ in the repo, not /tmp, so reboots keep it.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchRecentChatMessages, isTeamsAuthError, isTeamsSelfChat } from "./school-teams.js";
import {
  deliverGuestRateLimit,
  evaluateGuestMention,
} from "./guest-agent.js";
import {
  shouldTriggerTeamsAgent,
  teamsMessageKey,
} from "./teams-mention.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_PATH = join(ROOT, "data", "agent-mentions", "teams.json");
/** Pre-2026-11-12 location. /tmp is wiped on reboot. Read once to migrate. */
export const LEGACY_STATE_PATH = "/tmp/yanylevin-teams-agent-mentions.json";
export const POLL_MS = 8_000;
const SEEN_MAX = 4_000;
const CHATS_MAX = 1_000;
/** Re-scan window behind the watermark. Seen keys dedupe inside it. */
export const OVERLAP_MS = 60_000;
/** A mention older than this never starts a session, even after downtime. */
export const MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** Teams chat message ids are epoch ms. Accept 2015..2100 only. */
const ID_MS_MIN = Date.UTC(2015, 0, 1);
const ID_MS_MAX = Date.UTC(2100, 0, 1);

/** @type {ReturnType<typeof setInterval>|null} */
let timer = null;
let ticking = false;

function isoOrEmpty(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

/**
 * @param {unknown} raw
 */
export function parseMentionState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const lastAt = isoOrEmpty(src.lastAt);
  const seen = Array.isArray(src.seenIds)
    ? src.seenIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  /** @type {Record<string, string>} */
  const chats = {};
  const rawChats = src.chats && typeof src.chats === "object" ? src.chats : {};
  const entries = Object.entries(rawChats)
    .map(([id, at]) => [String(id || "").trim(), isoOrEmpty(at)])
    .filter(([id, at]) => id && at)
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .slice(-CHATS_MAX);
  for (const [id, at] of entries) chats[id] = at;
  return {
    lastAt,
    seenIds: [...new Set(seen)].slice(-SEEN_MAX),
    chats,
  };
}

/**
 * @param {string} [path]
 */
export async function loadMentionState(path = STATE_PATH) {
  const paths = path === STATE_PATH ? [path, LEGACY_STATE_PATH] : [path];
  for (const p of paths) {
    try {
      const raw = JSON.parse(await readFile(p, "utf8"));
      return parseMentionState(raw);
    } catch {
      // missing or corrupt: try the next one
    }
  }
  return parseMentionState({});
}

/**
 * Atomic write so a crash mid-write cannot leave half a JSON file.
 * @param {{ lastAt?: string, seenIds?: string[], chats?: Record<string, string> }} state
 * @param {string} [path]
 */
export async function saveMentionState(state, path = STATE_PATH) {
  const next = parseMentionState(state);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  return next;
}

function messageAtIso(message) {
  const raw = String(message?.at || "").trim();
  if (!raw) return "";
  const withZ = /Z$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`;
  const ms = Date.parse(withZ);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

/**
 * When the message was first posted, in ms. Uses the oldest of the row
 * time and the Teams id (epoch ms, unchanged by edits). NaN when unknown.
 * @param {object|null|undefined} message
 */
export function teamsMessageCreatedMs(message) {
  const times = [];
  const at = messageAtIso(message);
  if (at) times.push(Date.parse(at));
  const id = String(message?.id || "").trim();
  if (/^\d{12,14}$/.test(id)) {
    const ms = Number(id);
    if (ms >= ID_MS_MIN && ms <= ID_MS_MAX) times.push(ms);
  }
  return times.length ? Math.min(...times) : NaN;
}

/**
 * Why an @agent row should not start a session, or "" when it is fresh.
 * @param {object} row
 * @param {{ cutoffMs: number, nowMs: number, chats: Record<string, string>, seen: Set<string> }} ctx
 */
export function staleTeamsMentionReason(row, ctx) {
  const key = teamsMessageKey(row);
  if (!key) return "no-key";
  if (ctx.seen.has(key)) return "seen";
  const created = teamsMessageCreatedMs(row);
  if (!Number.isFinite(created)) return "no-time";
  if (created < ctx.cutoffMs) return "before-watermark";
  if (created > ctx.nowMs + OVERLAP_MS) return "future";
  const chatId = String(row?.chatId || "").trim();
  const chatLast = chatId ? Date.parse(ctx.chats[chatId] || "") : NaN;
  if (Number.isFinite(chatLast) && created < chatLast) return "before-chat-last";
  return "";
}

/** Keys already logged as skipped, so a quiet backlog logs once per process. */
const loggedSkips = new Set();

/**
 * One poll. First run with empty state only writes a watermark (no backlog).
 * @param {{
 *   fetchRecent?: typeof fetchRecentChatMessages,
 *   startFromMessage?: (message: object) => Promise<unknown>,
 *   evaluateGuestMention?: typeof evaluateGuestMention,
 *   deliverGuestRateLimit?: typeof deliverGuestRateLimit,
 *   now?: () => Date,
 *   statePath?: string,
 *   limitsPath?: string,
 *   people?: object[],
 *   liveCalendar?: boolean,
 *   log?: (line: string) => void,
 * }} [deps]
 */
export async function pollTeamsAgentMentions(deps = {}) {
  const path = deps.statePath || STATE_PATH;
  const nowFn = deps.now || (() => new Date());
  const log = deps.log || ((line) => console.log(line));
  const nowDate = nowFn();
  const nowIso = nowDate.toISOString();
  const nowMs = nowDate.getTime();
  const state = await loadMentionState(path);

  if (!state.lastAt) {
    await saveMentionState({ lastAt: nowIso, seenIds: [], chats: {} }, path);
    return { ok: true, skipped: "watermark", started: 0 };
  }

  const watermarkMs = Math.min(Date.parse(state.lastAt), nowMs);
  const cutoffMs = Math.max(0, watermarkMs - OVERLAP_MS, nowMs - MAX_AGE_MS);
  const since = new Date(cutoffMs).toISOString();
  const fetchRecent = deps.fetchRecent || fetchRecentChatMessages;
  let rows = [];
  try {
    rows = await fetchRecent({ since, chatLimit: 25, messageLimit: 15 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isTeamsAuthError(err)) {
      return { ok: false, skipped: "not-signed-in", error: msg, started: 0 };
    }
    console.error("[teams-agent] recent", err);
    return { ok: false, error: msg };
  }

  /** @type {Promise<unknown>} */
  const calendarTask = deps.liveCalendar
    ? import("./calendar-on-demand.js")
        .then((mod) => mod.observeCalendarMessages("teams", rows))
        .catch((err) => console.error("[teams-agent] calendar", err))
    : Promise.resolve();

  const seen = new Set(state.seenIds);
  const chats = { ...state.chats };
  /** @type {object[]} */
  const hits = [];
  /** @type {Record<string, number>} */
  const skipped = {};
  let newest = state.lastAt;
  if (newest > nowIso) newest = nowIso;
  for (const row of Array.isArray(rows) ? rows : []) {
    const at = messageAtIso(row);
    if (at && at <= nowIso && at > newest) newest = at;
    if (!shouldTriggerTeamsAgent(row)) continue;
    const reason = staleTeamsMentionReason(row, { cutoffMs, nowMs, chats, seen });
    if (reason) {
      if (reason !== "seen") {
        skipped[reason] = (skipped[reason] || 0) + 1;
        const key = teamsMessageKey(row) || `${row?.chatId}:${row?.id}`;
        if (!loggedSkips.has(key)) {
          loggedSkips.add(key);
          log(
            `[teams-agent] skip old @agent ${reason} chat=${String(row?.chat || row?.chatId || "?")} id=${String(row?.id || "?")} at=${at || "?"}`
          );
        }
      }
      continue;
    }
    // Same message listed twice in one poll.
    seen.add(teamsMessageKey(row));
    const hit = isTeamsSelfChat(row) ? { ...row, fromMe: true } : row;
    hits.push(hit);
  }
  if (loggedSkips.size > SEEN_MAX) loggedSkips.clear();

  hits.sort((a, b) => {
    const atA = teamsMessageCreatedMs(a);
    const atB = teamsMessageCreatedMs(b);
    if (atA !== atB) return atA < atB ? -1 : 1;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });

  const start =
    deps.startFromMessage ||
    (async (message) => {
      const { startAgentFromTeamsMention } = await import("./personal-agent.js");
      return startAgentFromTeamsMention(message);
    });
  const evaluateGuest = deps.evaluateGuestMention || evaluateGuestMention;
  const sendRateLimit = deps.deliverGuestRateLimit || deliverGuestRateLimit;

  let started = 0;
  const nextSeen = [...state.seenIds];
  for (const hit of hits) {
    const key = teamsMessageKey(hit);
    nextSeen.push(key);
    const chatId = String(hit?.chatId || "").trim();
    const createdIso = new Date(teamsMessageCreatedMs(hit)).toISOString();
    if (chatId && (!chats[chatId] || chats[chatId] < createdIso)) {
      chats[chatId] = createdIso;
    }
    // Persist before starting, so a crash or restart mid-start never
    // makes this mention look unhandled on the next poll.
    await saveMentionState(
      { lastAt: state.lastAt, seenIds: nextSeen.slice(-SEEN_MAX), chats },
      path
    );
    /** @type {object} */
    const message = { ...hit };
    if (message.fromMe !== true) {
      let decision;
      try {
        decision = await evaluateGuest({
          platform: "teams",
          message,
          now: nowFn(),
          people: deps.people,
          statePath: deps.limitsPath,
        });
      } catch (err) {
        console.error("[teams-agent] guest", err);
        continue;
      }
      if (!decision || decision.action === "ignore") continue;
      if (decision.action === "rate-limit") {
        try {
          await sendRateLimit({
            platform: "teams",
            message,
            text: decision.text,
          });
        } catch (err) {
          console.error("[teams-agent] rate-limit", err);
        }
        continue;
      }
      if (decision.action === "start" && decision.caller) {
        message.guestCaller = decision.caller;
      } else {
        continue;
      }
    }
    log(
      `[teams-agent] start chat=${String(message.chat || chatId || "?")} id=${String(message.id || "?")} at=${createdIso}`
    );
    try {
      await start(message);
      started += 1;
    } catch (err) {
      console.error("[teams-agent] start", err);
    }
  }

  if (nowIso > newest) newest = nowIso;
  await saveMentionState(
    { lastAt: newest, seenIds: nextSeen.slice(-SEEN_MAX), chats },
    path
  );
  await calendarTask;
  return {
    ok: true,
    started,
    scanned: Array.isArray(rows) ? rows.length : 0,
    skippedOld: skipped,
  };
}

export function startTeamsAgentMentionScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    pollTeamsAgentMentions({ liveCalendar: true })
      .catch((err) => console.error("[teams-agent] poll", err))
      .finally(() => {
        ticking = false;
      });
  }, POLL_MS);
  timer.unref?.();
  pollTeamsAgentMentions({ liveCalendar: true }).catch((err) =>
    console.error("[teams-agent] first poll", err)
  );
}
