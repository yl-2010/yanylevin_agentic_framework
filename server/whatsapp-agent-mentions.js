/**
 * Poll WhatsApp for @agent / @agentg in any chat, group or 1:1.
 * First run only writes a watermark. No backlog.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { recentMessages } from "./whatsapp-read.js";
import {
  deliverGuestRateLimit,
  evaluateGuestMention,
} from "./guest-agent.js";
import {
  shouldTriggerWhatsAppAgent,
  WHATSAPP_AGENT_ENABLED,
  whatsAppMessageKey,
} from "./whatsapp-mention.js";

export const STATE_PATH = "/tmp/yanylevin-whatsapp-agent-mentions.json";
/** Touch this file (or set YANYLEVIN_WHATSAPP_AGENT=0) to stop @agent polling and sends. */
export const PAUSE_PATH = "/tmp/yanylevin-whatsapp-agent-paused";
export const POLL_MS = 4_000;
export const POLL_LIMIT = 40;
const SEEN_MAX = 400;
const OVERLAP_MS = 5_000;

/** @type {ReturnType<typeof setInterval>|null} */
let timer = null;
let ticking = false;

export function isWhatsAppAgentPaused() {
  if (process.env.YANYLEVIN_WHATSAPP_AGENT === "0") return true;
  return existsSync(PAUSE_PATH);
}

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
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

/**
 * @param {{
 *   recentMessages?: typeof recentMessages,
 *   startFromMessage?: (message: object) => Promise<unknown>,
 *   evaluateGuestMention?: typeof evaluateGuestMention,
 *   deliverGuestRateLimit?: typeof deliverGuestRateLimit,
 *   now?: () => Date,
 *   statePath?: string,
 *   limitsPath?: string,
 *   people?: object[],
 * }} [deps]
 */
export async function pollWhatsAppAgentMentions(deps = {}) {
  const enabled = deps.enabled ?? WHATSAPP_AGENT_ENABLED;
  if (!enabled) return { ok: true, skipped: "disabled", started: 0 };
  if (isWhatsAppAgentPaused()) {
    return { ok: true, skipped: "paused" };
  }
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
    rows = await recent({ since, limit: POLL_LIMIT });
  } catch (err) {
    console.error("[whatsapp-agent] recent", err);
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
    if (!shouldTriggerWhatsAppAgent(row)) continue;
    const key = whatsAppMessageKey(row);
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
      const { startAgentFromWhatsAppMention } = await import("./personal-agent.js");
      return startAgentFromWhatsAppMention(message);
    });
  const evaluateGuest = deps.evaluateGuestMention || evaluateGuestMention;
  const sendRateLimit = deps.deliverGuestRateLimit || deliverGuestRateLimit;

  let started = 0;
  const nextSeen = [...state.seenIds];
  for (const hit of hits) {
    const key = whatsAppMessageKey(hit);
    nextSeen.push(key);
    seen.add(key);
    /** @type {object} */
    const message = { ...hit };
    if (message.fromMe !== true) {
      let decision;
      try {
        decision = await evaluateGuest({
          platform: "whatsapp",
          message,
          now: nowFn(),
          people: deps.people,
          statePath: deps.limitsPath,
        });
      } catch (err) {
        console.error("[whatsapp-agent] guest", err);
        continue;
      }
      if (!decision || decision.action === "ignore") continue;
      if (decision.action === "rate-limit") {
        try {
          await sendRateLimit({
            platform: "whatsapp",
            message,
            text: decision.text,
          });
        } catch (err) {
          console.error("[whatsapp-agent] rate-limit", err);
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
      console.error("[whatsapp-agent] start", err);
    }
  }

  if (nowIso > newest) newest = nowIso;
  await saveMentionState(
    { lastAt: newest, seenIds: nextSeen.slice(-SEEN_MAX) },
    path
  );
  return { ok: true, started, scanned: Array.isArray(rows) ? rows.length : 0 };
}

export function startWhatsAppAgentMentionScheduler() {
  if (!WHATSAPP_AGENT_ENABLED) {
    console.log("[whatsapp-agent] off. It does not read mentions or reply.");
    return;
  }
  if (isWhatsAppAgentPaused()) return;
  if (timer) return;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    pollWhatsAppAgentMentions()
      .catch((err) => console.error("[whatsapp-agent] poll", err))
      .finally(() => {
        ticking = false;
      });
  }, POLL_MS);
  timer.unref?.();
  pollWhatsAppAgentMentions().catch((err) =>
    console.error("[whatsapp-agent] first poll", err)
  );
}
