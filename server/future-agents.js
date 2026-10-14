/**
 * One-time future agents. A personal or JYPE agent schedules a full
 * Grok 4.7 high run for later. The chat thread is written immediately.
 * The JSON file is what the timer and the dashboard rail read.
 *
 * CLI (Cursor Desktop, no live chat session):
 *   node server/future-agents.js schedule --at <ISO> --prompt "..." --context "..." --workspace jype --email you@example.com --teams-chat <id>
 *   node server/future-agents.js list
 *   node server/future-agents.js cancel --session <id>
 * The CLI talks to the running server on the local socket. If that
 * socket is down, the command fails.
 */

import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEducationUser } from "./education-data.js";
import {
  patchChatHistoryScheduled,
  patchChatHistoryVisibility,
  persistChatHistory,
  withScheduledTitlePrefix,
} from "./education-chat-history.js";
import { canonicalizeEmail, isJypeAccessEmail } from "./identity.js";
import { LOCAL_SOCK } from "./local-ipc.js";
import { WHATSAPP_AGENT_ENABLED } from "./whatsapp-mention.js";
import { normalizeJypeWorkspace } from "./jype.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR_NAME = "future-agents";
const PROMPT_MAX = 4000;
const CONTEXT_MAX = 12000;
const PAST_SLACK_MS = 2 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_000_000;
const STATUSES = new Set(["pending", "running", "done", "failed", "canceled"]);

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function resolveRoot(root) {
  const explicit = String(root || "").trim();
  return explicit || ROOT;
}

export function futureAgentsDir(root) {
  return join(resolveRoot(root), "data", DIR_NAME);
}

function recordPath(sessionId, root) {
  return join(futureAgentsDir(root), `${sessionId}.json`);
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function parseRunAt(raw) {
  const s = String(raw || "").trim();
  const ms = Date.parse(s);
  if (!s || !Number.isFinite(ms)) {
    throw httpError("runAt must be an ISO time with a timezone offset", 400);
  }
  return new Date(ms).toISOString();
}

/**
 * @param {string} iso
 * @param {number} [now]
 */
export function assertRunAtSchedulable(iso, now = Date.now()) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw httpError("runAt must be an ISO time with a timezone offset", 400);
  }
  if (ms < now - PAST_SLACK_MS) {
    throw httpError("runAt is in the past", 400);
  }
  return new Date(ms).toISOString();
}

/**
 * Pacific label for the user bubble. "Tue, Oct 13, 2026, 9:35 AM PT"
 * @param {string} iso
 */
export function formatPacificScheduleLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  return `${date}, ${time} PT`;
}

/**
 * Short rail label. "Oct 13 · 9:35 AM"
 * @param {string} iso
 */
export function formatFutureAgentWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const pick = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${pick("month")} ${pick("day")} · ${pick("hour")}:${pick("minute")} ${pick("dayPeriod")}`;
}

/**
 * @param {string} runAt
 * @param {string} prompt
 */
export function formatScheduledUserBubble(runAt, prompt) {
  const when = formatPacificScheduleLabel(runAt);
  const task = String(prompt || "").trim();
  return `Agent scheduled for ${when}:\n\n${task}`;
}

/**
 * @param {unknown} prompt
 */
export function scheduledChatTitle(prompt) {
  return withScheduledTitlePrefix(prompt);
}

/**
 * @param {object} record
 * @param {{ kickoff?: boolean }} [opts]
 */
export function formatScheduledSystemBlock(record, opts = {}) {
  const when = formatPacificScheduleLabel(record?.runAt) || "the scheduled time";
  const task = String(record?.prompt || "").trim() || "(none)";
  const context = String(record?.context || "").trim();
  const kickoff = opts.kickoff === true;
  /** @type {string[]} */
  const lines = [];
  if (kickoff) {
    lines.push(
      `You are a scheduled agent. Another agent created this thread to run at ${when}.`,
      "That time has arrived. You have the same tools and instructions as the agent that scheduled you.",
      "The first user message is the task. Do that task now. Do not copy the task into a new user bubble."
    );
  } else {
    const status = String(record?.status || "pending").trim() || "pending";
    lines.push(
      `You are a scheduled agent. This thread was set to run at ${when}.`,
      `Status: ${status}.`,
      "The first user message is the original task. If the status is done, do not repeat that task unless the new message asks. If the status is pending, answer the new message. The scheduled run still happens at that time."
    );
  }
  lines.push("", "Task:", task, "", "Situation from the agent that scheduled you:", context || "None stored.");
  const origin = record?.origin && typeof record.origin === "object" ? record.origin : {};
  const kind = String(origin.kind || "").trim();
  if (kind === "teams" && origin.chatId) {
    lines.push(
      "",
      kickoff
        ? `This run answers in Teams chat ${origin.chatId}. The server posts your final reply there. send_chat_message posts there too while you work. Do not send that same final text yourself.`
        : `The scheduled run was tied to Teams chat ${origin.chatId}. A later message typed in the app stays in the app unless this message asks you to post there.`
    );
  } else if (kind === "whatsapp" && (origin.to || origin.chatJid || origin.chatId)) {
    const target = origin.chat || origin.to || origin.chatJid || origin.chatId;
    lines.push(
      "",
      WHATSAPP_AGENT_ENABLED
        ? kickoff
          ? `This run answers in the WhatsApp chat ${target}. The server posts your final reply there. send_chat_message posts there too while you work. Do not send that same final text yourself.`
          : `The scheduled run was tied to WhatsApp chat ${target}. A later message typed in the app stays in the app unless this message asks you to send there.`
        : "The WhatsApp agent is off. This run stays in the app and website chat. Do not send to WhatsApp."
    );
  } else if (kind === "imessage" && (origin.to || origin.chatGuid)) {
    const target = origin.chatGuid || origin.to;
    lines.push(
      "",
      kickoff
        ? `This run answers in the iMessage chat ${target}. The server posts your final reply there. send_chat_message posts there too while you work. Do not send that same final text yourself.`
        : `The scheduled run was tied to iMessage chat ${target}. A later message typed in the app stays in the app unless this message asks you to text that chat.`
    );
  } else if (kickoff) {
    lines.push(
      "",
      "This run stays in the app and website chat. Do not text or post to Teams unless the task says to."
    );
  }
  return lines.join("\n");
}

/**
 * Jobs the boot pass should fire now. Pending and already due, plus any
 * run left in `running` when the process died.
 * @param {object[]} records
 * @param {number|Date} [now]
 */
export function selectDueFutureAgents(records, now = Date.now()) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  return (Array.isArray(records) ? records : []).filter((row) => {
    if (!row || typeof row !== "object") return false;
    if (row.status === "running") return true;
    if (row.status !== "pending") return false;
    const at = Date.parse(String(row.runAt || ""));
    return Number.isFinite(at) && at <= t;
  });
}

/**
 * How long to sleep before this job fires. A `running` record fires now.
 * A wait longer than setTimeout allows is split and rearmed.
 * @param {object} record
 * @param {number} [now]
 */
export function futureAgentWait(record, now = Date.now()) {
  if (record?.status === "running") return { wait: 0, rearm: false };
  const at = Date.parse(String(record?.runAt || ""));
  const delay = Number.isFinite(at) ? Math.max(0, at - now) : 0;
  if (delay > MAX_TIMEOUT_MS) return { wait: MAX_TIMEOUT_MS, rearm: true };
  return { wait: delay, rearm: false };
}

function cleanOrigin(raw) {
  const origin = raw && typeof raw === "object" ? raw : {};
  const kind = String(origin.kind || "").trim().toLowerCase();
  if (kind === "teams") {
    const chatId = String(origin.chatId || origin.to || "").trim();
    if (!chatId) return { kind: "" };
    return {
      kind: "teams",
      chatId: chatId.slice(0, 200),
      chat: String(origin.chat || "").trim().slice(0, 200),
      to: String(origin.to || chatId).trim().slice(0, 200),
      text: String(origin.text || "").trim().slice(0, 500),
    };
  }
  if (kind === "whatsapp") {
    const to = String(origin.to || origin.chat || "").trim().slice(0, 200);
    const chatJid = String(origin.chatJid || origin.chatId || "").trim().slice(0, 200);
    if (!to && !chatJid) return { kind: "" };
    return {
      kind: "whatsapp",
      to,
      chat: String(origin.chat || to).trim().slice(0, 200),
      chatId: chatJid,
      chatJid,
      text: String(origin.text || "").trim().slice(0, 500),
    };
  }
  if (kind === "imessage") {
    const to = String(origin.to || "").trim().slice(0, 200);
    const chatGuid = String(origin.chatGuid || "").trim().slice(0, 200);
    if (!to && !chatGuid) return { kind: "" };
    return {
      kind: "imessage",
      to,
      chatGuid,
      chat: String(origin.chat || "").trim().slice(0, 200),
      text: String(origin.text || "").trim().slice(0, 500),
    };
  }
  return { kind: "" };
}

function normalizeWorkspace(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "jype") return "jype";
  if (!s || s === "personal") return "";
  throw httpError("workspace must be personal or jype", 400);
}

/**
 * @param {object} raw
 */
export function normalizeFutureAgentRecord(raw) {
  const sessionId = String(raw?.sessionId || "").trim();
  const status = String(raw?.status || "").trim();
  if (!sessionId || !STATUSES.has(status)) return null;
  const runAt = parseRunAt(raw?.runAt);
  const workspace = normalizeJypeWorkspace(raw?.workspace);
  const email = canonicalizeEmail(raw?.email);
  if (!email) return null;
  return {
    sessionId,
    runAt,
    status,
    workspace,
    email,
    prompt: String(raw?.prompt || "").trim(),
    context: String(raw?.context || "").trim(),
    origin: cleanOrigin(raw?.origin),
    title: String(raw?.title || "").trim(),
    createdAt: String(raw?.createdAt || "").trim(),
  };
}

async function writeRecord(record, root) {
  const dir = futureAgentsDir(root);
  await mkdir(dir, { recursive: true });
  await writeFile(recordPath(record.sessionId, root), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/**
 * @param {string} sessionId
 * @param {{ root?: string }} [opts]
 */
export async function readFutureAgent(sessionId, opts = {}) {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;
  try {
    const text = await readFile(recordPath(sid, opts.root), "utf8");
    return normalizeFutureAgentRecord(JSON.parse(text));
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") return null;
    return null;
  }
}

/**
 * @param {{ root?: string }} [opts]
 */
export async function listFutureAgentRecords(opts = {}) {
  const dir = futureAgentsDir(opts.root);
  let names = [];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") return [];
    throw err;
  }
  /** @type {object[]} */
  const rows = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const row = await readFutureAgent(name.slice(0, -5), opts);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Pending and running, soonest first.
 * @param {{ root?: string, workspace?: string, email?: string }} [opts]
 */
export async function listUpcomingFutureAgents(opts = {}) {
  const workspace =
    opts.workspace == null ? null : normalizeJypeWorkspace(opts.workspace);
  const email = opts.email ? canonicalizeEmail(opts.email) : "";
  const rows = await listFutureAgentRecords(opts);
  return rows
    .filter((row) => row.status === "pending" || row.status === "running")
    .filter((row) => (workspace == null ? true : row.workspace === workspace))
    .filter((row) => {
      if (!email || workspace === "jype") return true;
      if (workspace == null) return true;
      return row.email === email;
    })
    .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt) || a.sessionId.localeCompare(b.sessionId));
}

/**
 * @param {object} record
 */
export function publicFutureAgentEntry(record) {
  const jype = record.workspace === "jype";
  const prompt = String(record.prompt || "").trim();
  return {
    sessionId: record.sessionId,
    runAt: record.runAt,
    when: formatFutureAgentWhen(record.runAt),
    status: record.status,
    workspace: jype ? "jype" : "personal",
    workspaceLabel: jype ? "JYPE" : "Personal",
    prompt: prompt.length > 180 ? `${prompt.slice(0, 177).trim()}...` : prompt,
    title: record.title,
    href: `${jype ? "/jype/" : "/education/"}?chat=${encodeURIComponent(record.sessionId)}`,
  };
}

/**
 * @param {{
 *   runAt: string,
 *   prompt: string,
 *   context?: string,
 *   workspace?: string,
 *   email: string,
 *   origin?: object,
 *   root?: string,
 *   now?: number,
 *   sessionId?: string,
 * }} input
 */
export async function scheduleFutureAgent(input) {
  const email = canonicalizeEmail(input?.email);
  const workspace = normalizeWorkspace(input?.workspace);
  if (!email) throw httpError("email required", 400);
  if (workspace === "jype") {
    if (!isJypeAccessEmail(email)) throw httpError("forbidden", 403);
  } else if (!isEducationUser(email)) {
    throw httpError("forbidden", 403);
  }
  const prompt = String(input?.prompt || "").trim();
  if (!prompt) throw httpError("prompt required", 400);
  if (prompt.length > PROMPT_MAX) throw httpError("prompt is too long", 400);
  const context = String(input?.context || "").trim();
  if (context.length > CONTEXT_MAX) throw httpError("context is too long", 400);
  const runAt = assertRunAtSchedulable(parseRunAt(input?.runAt), input?.now ?? Date.now());
  const sessionId = String(input?.sessionId || "").trim() || randomUUID();
  const title = scheduledChatTitle(prompt);
  const createdAt = new Date().toISOString();
  const record = {
    sessionId,
    runAt,
    status: "pending",
    workspace,
    email,
    prompt,
    context,
    origin: cleanOrigin(input?.origin),
    title,
    createdAt,
  };
  const bubble = formatScheduledUserBubble(runAt, prompt);
  await persistChatHistory({
    email,
    sessionId,
    workspace,
    root: input?.root,
    title,
    ephemeral: false,
    visibility: "showing",
    scheduled: true,
    scheduledRunAt: runAt,
    scheduledStatus: "pending",
    messages: [{ role: "user", content: bubble, at: createdAt }],
  });
  await writeRecord(record, input?.root);
  const pending = (await listUpcomingFutureAgents({
    root: input?.root,
    workspace,
    email,
  })).filter((row) => row.sessionId !== sessionId);
  return {
    ok: true,
    sessionId,
    runAt,
    runAtLocal: formatPacificScheduleLabel(runAt),
    history: workspace === "jype" ? "jype" : "personal",
    title,
    pending: pending.map((row) => ({
      sessionId: row.sessionId,
      runAtLocal: formatPacificScheduleLabel(row.runAt),
      prompt: row.prompt,
    })),
    record,
  };
}

/**
 * @param {string} sessionId
 * @param {string} status
 * @param {{ root?: string }} [opts]
 */
export async function markFutureAgentStatus(sessionId, status, opts = {}) {
  const next = String(status || "").trim();
  if (!STATUSES.has(next)) throw httpError("bad status", 400);
  const record = await readFutureAgent(sessionId, opts);
  if (!record) return null;
  record.status = next;
  await writeRecord(record, opts.root);
  await patchChatHistoryScheduled({
    email: record.email,
    sessionId: record.sessionId,
    workspace: record.workspace,
    status: next,
    root: opts.root,
  });
  return record;
}

/**
 * Pending only. Hides the chat thread.
 * @param {string} sessionId
 * @param {{ root?: string }} [opts]
 */
export async function cancelFutureAgent(sessionId, opts = {}) {
  const record = await readFutureAgent(sessionId, opts);
  if (!record) throw httpError("scheduled agent not found", 404);
  if (record.status !== "pending") {
    throw httpError(`cannot cancel a ${record.status} agent`, 400);
  }
  record.status = "canceled";
  await writeRecord(record, opts.root);
  await patchChatHistoryScheduled({
    email: record.email,
    sessionId: record.sessionId,
    workspace: record.workspace,
    status: "canceled",
    root: opts.root,
  });
  await patchChatHistoryVisibility({
    email: record.email,
    sessionId: record.sessionId,
    workspace: record.workspace,
    visibility: "hidden",
    root: opts.root,
  });
  return { ok: true, sessionId: record.sessionId, status: "canceled" };
}

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const timers = new Map();

export function clearFutureAgentTimer(sessionId) {
  const sid = String(sessionId || "").trim();
  const handle = timers.get(sid);
  if (handle) clearTimeout(handle);
  timers.delete(sid);
}

/**
 * @param {object} record
 * @param {(record: object) => Promise<void>|void} kick
 * @param {number} [now]
 */
export function armFutureAgentTimer(record, kick, now = Date.now()) {
  const sid = String(record?.sessionId || "").trim();
  if (!sid) return;
  clearFutureAgentTimer(sid);
  const plan = futureAgentWait(record, now);
  const handle = setTimeout(() => {
    timers.delete(sid);
    if (plan.rearm) {
      armFutureAgentTimer(record, kick);
      return;
    }
    Promise.resolve(kick(record)).catch((err) => {
      console.error(
        "[future-agents] kick failed",
        sid,
        err instanceof Error ? err.message : err
      );
    });
  }, plan.wait);
  if (typeof handle.unref === "function") handle.unref();
  timers.set(sid, handle);
}

/**
 * @param {(record: object) => Promise<void>|void} kick
 * @param {{ root?: string }} [opts]
 */
export async function armStoredFutureAgents(kick, opts = {}) {
  const rows = await listFutureAgentRecords(opts);
  for (const record of rows) {
    if (record.status !== "pending" && record.status !== "running") continue;
    armFutureAgentTimer(record, kick);
  }
  return rows.filter((row) => row.status === "pending" || row.status === "running");
}

function ipcJson(method, path, body) {
  const payload = body == null ? "" : JSON.stringify(body);
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      {
        socketPath: LOCAL_SOCK,
        path,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data = {};
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch {
            data = { ok: false, error: raw.slice(0, 200) };
          }
          if ((res.statusCode || 500) >= 400 || data.ok === false) {
            const err = new Error(data.error || `socket ${res.statusCode}`);
            err.status = res.statusCode || 500;
            reject(err);
            return;
          }
          resolvePromise(data);
        });
      }
    );
    req.on("error", (err) => {
      const wrapped = new Error(
        "Future agent server is not running. The local socket is down."
      );
      wrapped.cause = err;
      reject(wrapped);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return "";
  return String(process.argv[i + 1] || "");
}

async function cliMain() {
  const cmd = String(process.argv[2] || "").trim();
  if (cmd === "list") {
    const data = await ipcJson("GET", "/future-agents/list");
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  if (cmd === "cancel") {
    const sessionId = argValue("--session");
    const data = await ipcJson("POST", "/future-agents/cancel", { sessionId });
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  if (cmd === "schedule") {
    const teamsChat = argValue("--teams-chat");
    const imessageTo = argValue("--imessage-to");
    /** @type {object} */
    let origin = { kind: "" };
    if (teamsChat) origin = { kind: "teams", chatId: teamsChat, to: teamsChat };
    else if (imessageTo) {
      origin = {
        kind: "imessage",
        to: imessageTo,
        chatGuid: argValue("--imessage-guid"),
      };
    }
    const data = await ipcJson("POST", "/future-agents/schedule", {
      runAt: argValue("--at"),
      prompt: argValue("--prompt"),
      context: argValue("--context"),
      workspace: argValue("--workspace") || "personal",
      email: argValue("--email"),
      origin,
    });
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  throw new Error("usage: future-agents.js schedule|list|cancel");
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  cliMain().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
