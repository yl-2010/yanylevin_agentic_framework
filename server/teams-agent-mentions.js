/**
 * Poll school Teams chats for Yan fromMe texts that mention @agent.
 * Each hit starts a normal Personal Agent session (app + website).
 */

import { readFile, writeFile } from "node:fs/promises";
import { applyAgentpControl, parseAgentpControl } from "./agentp-appendix.js";
import { fetchRecentChatMessages, isTeamsAuthError, isTeamsSelfChat } from "./school-teams.js";
import {
  deliverGuestRateLimit,
  evaluateGuestMention,
} from "./guest-agent.js";
import {
  shouldTriggerTeamsAgent,
  teamsMessageKey,
} from "./teams-mention.js";

export const STATE_PATH = "/tmp/yanylevin-teams-agent-mentions.json";
export const POLL_MS = 8_000;
const SEEN_MAX = 400;
const OVERLAP_MS = 8_000;

/** @type {ReturnType<typeof setInterval>|null} */
let timer = null;
let ticking = false;

/**
 * @param {unknown} raw
 */
export function parseMentionState(raw) {
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

/**
 * @param {string} [path]
 */
export async function loadMentionState(path = STATE_PATH) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return parseMentionState(raw);
  } catch {
    return parseMentionState({});
  }
}

/**
 * @param {{ lastAt?: string, seenIds?: string[] }} state
 * @param {string} [path]
 */
export async function saveMentionState(state, path = STATE_PATH) {
  const next = parseMentionState(state);
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
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
 * }} [deps]
 */
export async function pollTeamsAgentMentions(deps = {}) {
  const path = deps.statePath || STATE_PATH;
  const nowFn = deps.now || (() => new Date());
  const nowIso = nowFn().toISOString();
  const state = await loadMentionState(path);

  if (!state.lastAt) {
    await saveMentionState({ lastAt: nowIso, seenIds: [] }, path);
    return { ok: true, skipped: "watermark", started: 0 };
  }

  const sinceMs = Date.parse(state.lastAt) - OVERLAP_MS;
  const since = new Date(Math.max(0, sinceMs)).toISOString();
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
  /** @type {object[]} */
  const hits = [];
  let newest = state.lastAt;
  if (newest > nowIso) newest = nowIso;
  for (const row of Array.isArray(rows) ? rows : []) {
    const at = messageAtIso(row);
    if (at && at <= nowIso && at > newest) newest = at;
    if (!shouldTriggerTeamsAgent(row)) continue;
    const key = teamsMessageKey(row);
    if (!key || seen.has(key)) continue;
    const hit = isTeamsSelfChat(row) ? { ...row, fromMe: true } : row;
    hits.push(hit);
  }

  hits.sort((a, b) => {
    const atA = messageAtIso(a);
    const atB = messageAtIso(b);
    if (atA && atB && atA !== atB) return atA < atB ? -1 : 1;
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
    seen.add(key);
    /** @type {object} */
    const message = { ...hit };
    if (message.fromMe === true && parseAgentpControl(message.text)) {
      try {
        const result = await applyAgentpControl({
          fromMe: true,
          raw: message.text,
          root: deps.appendixRoot,
        });
        await sendRateLimit({
          platform: "teams",
          message,
          text: result.reply,
        });
      } catch (err) {
        console.error("[teams-agent] agentp", err);
      }
      continue;
    }
    if (message.fromMe !== true) {
      let decision;
      try {
        decision = await evaluateGuest({
          platform: "teams",
          message,
          now: nowFn(),
          people: deps.people,
          statePath: deps.limitsPath,
          appendixRoot: deps.appendixRoot,
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
    try {
      await start(message);
      started += 1;
    } catch (err) {
      console.error("[teams-agent] start", err);
    }
  }

  if (nowIso > newest) newest = nowIso;
  await saveMentionState(
    { lastAt: newest, seenIds: nextSeen.slice(-SEEN_MAX) },
    path
  );
  await calendarTask;
  return { ok: true, started, scanned: Array.isArray(rows) ? rows.length : 0 };
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
