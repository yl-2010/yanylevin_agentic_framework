/**
 * Poll Messages chat.db for Yan fromMe texts that mention @agent.
 * Each hit starts a normal Personal Agent session (app + website).
 */

import { readFile, writeFile } from "node:fs/promises";
import { recentMessages } from "./imessage-read.js";
import { findChatGuid } from "./imessage-send.js";
import {
  deliverGuestRateLimit,
  evaluateGuestMention,
} from "./guest-agent.js";
import {
  messageKey,
  shouldTriggerIMessageAgent,
} from "./imessage-mention.js";
import { OWNER_EMAIL as YAN_EMAIL } from "./identity.js";

export const STATE_PATH = "/tmp/yanylevin-imessage-agent-mentions.json";
export const POLL_MS = 3_000;
export const POLL_LIMIT = 40;
const SEEN_MAX = 400;
const OVERLAP_MS = 5_000;


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
 *   recentMessages?: typeof recentMessages,
 *   findChatGuid?: typeof findChatGuid,
 *   startFromMessage?: (message: object) => Promise<unknown>,
 *   evaluateGuestMention?: typeof evaluateGuestMention,
 *   deliverGuestRateLimit?: typeof deliverGuestRateLimit,
 *   now?: () => Date,
 *   statePath?: string,
 *   limitsPath?: string,
 *   listContacts?: () => Promise<object[]>,
 *   people?: object[],
 * }} [deps]
 */
export async function pollIMessageAgentMentions(deps = {}) {
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
  const recent = deps.recentMessages || recentMessages;
  let rows = [];
  try {
    rows = await recent({ since, limit: POLL_LIMIT, previewStills: 0 });
  } catch (err) {
    console.error("[imessage-agent] recent", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const seen = new Set(state.seenIds);
  /** @type {object[]} */
  const hits = [];
  let newest = state.lastAt;
  if (newest > nowIso) newest = nowIso;
  for (const row of Array.isArray(rows) ? rows : []) {
    const at = messageAtIso(row);
    if (at && at <= nowIso && at > newest) newest = at;
    if (!shouldTriggerIMessageAgent(row)) continue;
    const key = messageKey(row);
    if (!key || seen.has(key)) continue;
    hits.push(row);
  }

  hits.sort((a, b) => {
    const atA = messageAtIso(a);
    const atB = messageAtIso(b);
    if (atA && atB && atA !== atB) return atA < atB ? -1 : 1;
    return Number(a?.id || 0) - Number(b?.id || 0);
  });

  const start =
    deps.startFromMessage ||
    (async (message) => {
      const { startAgentFromIMessageMention } = await import("./personal-agent.js");
      return startAgentFromIMessageMention(message);
    });
  const findGuid = deps.findChatGuid || findChatGuid;
  const evaluateGuest = deps.evaluateGuestMention || evaluateGuestMention;
  const sendRateLimit = deps.deliverGuestRateLimit || deliverGuestRateLimit;

  let started = 0;
  const nextSeen = [...state.seenIds];
  for (const hit of hits) {
    const key = messageKey(hit);
    nextSeen.push(key);
    seen.add(key);
    /** @type {object} */
    const message = { ...hit };
    if (!message.chatGuid) {
      try {
        const guid =
          (message.chatId && (await findGuid(message.chatId))) ||
          (message.handle && (await findGuid(message.handle))) ||
          "";
        if (guid) message.chatGuid = guid;
      } catch (err) {
        console.warn(
          "[imessage-agent] chat guid",
          err instanceof Error ? err.message : err
        );
      }
    }
    if (message.fromMe !== true) {
      let decision;
      try {
        decision = await evaluateGuest({
          platform: "imessage",
          message,
          now: nowFn(),
          listContacts: deps.listContacts,
          people: deps.people,
          statePath: deps.limitsPath,
        });
      } catch (err) {
        console.error("[imessage-agent] guest", err);
        continue;
      }
      if (!decision || decision.action === "ignore") continue;
      if (decision.action === "rate-limit") {
        try {
          await sendRateLimit({
            platform: "imessage",
            message,
            text: decision.text,
          });
        } catch (err) {
          console.error("[imessage-agent] rate-limit", err);
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
      console.error("[imessage-agent] start", err);
    }
  }

  if (nowIso > newest) newest = nowIso;
  await saveMentionState(
    { lastAt: newest, seenIds: nextSeen.slice(-SEEN_MAX) },
    path
  );
  return { ok: true, started, scanned: Array.isArray(rows) ? rows.length : 0 };
}

export function startIMessageAgentMentionScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    pollIMessageAgentMentions()
      .catch((err) => console.error("[imessage-agent] poll", err))
      .finally(() => {
        ticking = false;
      });
  }, POLL_MS);
  timer.unref?.();
  pollIMessageAgentMentions().catch((err) =>
    console.error("[imessage-agent] first poll", err)
  );
}

export const IMESSAGE_AGENT_EMAIL = YAN_EMAIL;
