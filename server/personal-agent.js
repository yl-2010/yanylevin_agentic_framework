/**
 * Cursor SDK local agent sessions for the Personal Agent
 * (iOS Chat tab / /education chat). Local-only — never cloud runtime.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { isEducationUser, resolveNowScheduleContext } from "./education-data.js";
import { notifyEducationClients } from "./education-events.js";
import { canonicalizeEmail, isJypeAccessEmail, isFullAccessEmail, OWNER_EMAIL as YAN_EMAIL } from "./identity.js";
import { logSdkResult, personFromEmail } from "./usage-log.js";
import {
  browserCustomTools,
  closeAgentBrowser,
  sessionMayUseBrowser,
} from "./agent-browser.js";
import { computerUseCustomTools } from "./computer-use.js";
import {
  jypeEmailForSlug,
  jypeGivenName,
  normalizeJypeWorkspace,
  originIsJypeThread,
} from "./jype.js";
import { gitAddCommitPush } from "./git-publish.js";
import { encodeEducationRouteId } from "./education-route-id.js";
import { enqueueBrainExtraction } from "./brain-extraction.js";
import { parseLocationPayload } from "./phone-location.js";
import { formatCalendarLiveLines } from "./calendar-cli.js";
import { formatCanvasLiveLine } from "./canvas-sync.js";
import {
  applyChatWorkingStatus,
  listChatHistory,
  loadChatHistory,
  markChatHistoryRead,
  persistChatHistory,
  resolveChatStarter,
  sanitizeSessionId,
  EPHEMERAL_HIDE_MS,
} from "./education-chat-history.js";
import { enqueueChatTitle, isStubChatTitle } from "./chat-title.js";
import {
  armFutureAgentTimer,
  armStoredFutureAgents,
  cancelFutureAgent,
  clearFutureAgentTimer,
  formatScheduledSystemBlock,
  markFutureAgentStatus,
  readFutureAgent,
  scheduleFutureAgent,
} from "./future-agents.js";
import {
  formatWidgetsAsFences,
  parseAgentReply,
} from "./chat-widgets.js";
import { sendIMessage, takeIMessageReplyFiles } from "./imessage-send.js";
import { sendWhatsApp } from "./whatsapp-send.js";
import {
  applyAgentSentFooter,
  formatIMessageOriginBlock,
  messageForcesGrok,
  normalizeIMessageOrigin,
  stripAgentSentFooter,
} from "./imessage-mention.js";
import { sendTeamsMessage } from "./school-teams.js";
import {
  formatTeamsOriginBlock,
  jypeComposerScheduleLine,
  normalizeTeamsOrigin,
} from "./teams-mention.js";
import {
  formatWhatsAppOriginBlock,
  normalizeWhatsAppOrigin,
  WHATSAPP_AGENT_ENABLED,
} from "./whatsapp-mention.js";
import {
  copyModelSpec,
  formatGuestUserBubble,
  GUEST_GROK_SPEC,
  guestRunModels,
  jypeMentionModelSpec,
  platformLabel,
  withoutFast,
} from "./guest-agent.js";
import {
  AUTO_MODEL_SELECTION,
  INTERACTIVE_FALLBACK_DELAYS_MS,
  INTERACTIVE_MODEL_DELAYS_MS,
  WORKING_LABEL_DEFAULT,
  createLocalCursorAgent,
  disposeCursorAgent,
  recreateLocalCursorAgent,
  onLocalCursorExecutorEvict,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
  runWithModelFallback,
  workingLabelForAttempt,
} from "./cursor-sdk-auth.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PA_ERROR_REPLY =
  "The personal agent hit an error. Try again or use Cursor Desktop with the personal-agent skill.";

/** @typedef {{ role: 'user'|'assistant', content: string, queued?: boolean, queueId?: string, widgets?: object[], at?: string, endOfTurn?: boolean }} ChatMessage */

/**
 * Prepared agent turn (active or waiting in turnQueue).
 * @typedef {{
 *   prompt: string,
 *   images: { data: string, mimeType: string }[],
 *   model: ModelSelection,
 *   normalized: string,
 *   nowContext: object|null,
 *   attachmentCount: number,
 *   sessionAttachmentCount: number,
 *   bubble: string,
 *   queueId?: string,
 *   interrupted?: boolean,
 *   imessageDeliverFinal?: boolean,
 *   teamsDeliverFinal?: boolean,
 *   whatsappDeliverFinal?: boolean,
 * }} TurnOpts
 */

/**
 * @typedef {{
 *   agent: any,
 *   email: string,
 *   workspace?: string,
 *   starter?: string,
 *   createdAt: number,
 *   lastUsedAt: number,
 *   uploads: StagedFile[],
 *   uploadDirRel: string|null,
 *   messages: ChatMessage[],
 *   status: 'idle'|'running'|'error',
 *   workingLabel?: string|null,
 *   runPromise: Promise<void>|null,
 *   turnQueue: TurnOpts[],
 *   replayUiTranscript?: boolean,
 *   activeRun?: any,
 *   interrupting?: boolean,
 *   pendingNavigate?: Omit<EducationNavigate, 'id'>|null,
 *   navigate?: EducationNavigate|null,
 *   imessageOrigin?: object|null,
 *   imessageDeliverFinal?: boolean,
 *   teamsOrigin?: object|null,
 *   teamsDeliverFinal?: boolean,
 *   channelProgress?: ''|'imessage'|'teams',
 *   lastChannelProgressText?: string,
 *   activeTurnId?: string,
 *   guestCaller?: object|null,
 *   ephemeralPinned?: boolean,
 *   channelReplyOwed?: ''|'imessage'|'teams'|'whatsapp',
 * }} Session
 */

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const ephemeralHideTimers = new Map();

/**
 * One-shot education SPA / iOS stack target. Not stored in chat history.
 * @typedef {{
 *   id: string,
 *   view: 'home'|'class'|'project'|'todo'|'date'|'capsule'|'case',
 *   classId?: string,
 *   projectId?: string,
 *   todoId?: string,
 *   dateId?: string,
 *   capsuleId?: string,
 *   caseId?: string,
 *   caseSide?: string,
 * }} EducationNavigate
 */

/** @typedef {{ name: string, mimeType?: string, data: string }} AttachmentInput */

/** @typedef {{ name: string, mimeType: string, relPath: string, absPath: string, bytes: number, isImage: boolean }} StagedFile */

/** @type {Map<string, Session>} */
const sessions = new Map();

/** Focused session id per user (the chat the UI last opened). Others may still run. */
/** @type {Map<string, string>} */
const activeByEmail = new Map();

function sessionWorkspace(session) {
  return normalizeJypeWorkspace(session?.workspace);
}

function usagePerson(session) {
  if (session?.usagePerson) return String(session.usagePerson).trim();
  const guest = session?.guestCaller?.displayName;
  if (guest) return String(guest).trim();
  return personFromEmail(session?.email);
}

function usageKind(session, opts) {
  if (opts?.scheduledKickoff) return "future-agent";
  if (session?.teamsOrigin) return "teams-agent";
  if (session?.imessageOrigin) return "imessage-agent";
  if (session?.whatsappOrigin) return "whatsapp-agent";
  if (sessionWorkspace(session) === "jype") return "jype-chat";
  return "personal-chat";
}

function focusKey(email, workspace) {
  const normalized = canonicalizeEmail(email);
  const ws = normalizeJypeWorkspace(workspace);
  return ws ? `${ws}:${normalized}` : normalized;
}

function canUseAgent(email, workspace) {
  const normalized = canonicalizeEmail(email);
  if (normalizeJypeWorkspace(workspace) === "jype") {
    return isJypeAccessEmail(normalized);
  }
  return isEducationUser(normalized);
}

function canAccessSession(session, email) {
  const normalized = canonicalizeEmail(email);
  if (!session) return false;
  if (sessionWorkspace(session) === "jype") return isJypeAccessEmail(normalized);
  return session.email === normalized;
}

function notifyAgentClients(session, email, data) {
  const ws = sessionWorkspace(session);
  notifyEducationClients(email || session?.email, "change", {
    ...data,
    ...(ws ? { workspace: ws } : {}),
  });
}

const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_ATTACHMENTS = 16;
/** Per-file and per-message decoded caps. JSON+base64 is ~4/3 on the wire (~86MB at 64MB), under Express 100mb and Cloudflare ~100MB. */
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 64 * 1024 * 1024;
/** Grok/xAI image input is ~20MiB; larger images still stage on disk, just skip inline. */
const MAX_GROK_IMAGE_BYTES = 20 * 1024 * 1024;
/** Max user messages waiting behind the in-flight Personal Agent turn. */
export const MAX_QUEUED_TURNS = 8;

/** Added to a queued turn's prompt when that turn is promoted into an interrupt. */
export const INTERRUPT_NOTE =
  "The user interrupted your previous work with a new message. Treat this as the current request. Disk changes from the cancelled turn may already be partial. Do not redo completed work unless asked.";

/**
 * Interrupt of an @agent whose chat reply has not gone out yet.
 * Default is a clarification, so the final bubble still goes to that chat.
 * @param {string} [kind]
 */
export function interruptClarificationNote(kind) {
  const where =
    kind === "teams"
      ? "Teams"
      : kind === "imessage"
        ? "iMessage"
        : kind === "whatsapp"
          ? "WhatsApp"
          : "";
  if (!where) return INTERRUPT_NOTE;
  return `The user interrupted the unfinished @agent with a clarification. Treat this message as extra instructions for that same job. Disk changes from the cancelled turn may already be partial. Do not redo completed work unless this message asks. The final reply still goes to that ${where} chat unless this message says not to.`;
}

/** Final bubble when the model returns no text (and this was not an interrupt). */
export const EMPTY_TURN_REPLY = "Done";

/**
 * ModelSelection shape required by Agent.create / agent.send:
 *   { id: string, params?: [{ id: string, value: string }] }
 * Parameterized models need explicit params (not a separate "-fast" / "-high" id).
 *
 * @typedef {{ id: string, value: string }} ModelParam
 * @typedef {{ id: string, params: ModelParam[] }} ModelSelection
 */

/**
 * Personal Agent ModelSelection from an env id.
 * grok-4.7 → high, Fast off. composer-* → Composer, Fast off.
 * Text-only and attachments are separate specs so text-only can go back
 * to Composer later without moving attachment turns.
 * @param {string|undefined} envId
 * @param {string} fallbackId
 * @returns {{ id: string, params: ModelParam[] }}
 */
function personalModelSpec(envId, fallbackId) {
  const id = String(envId || fallbackId);
  /** @type {ModelParam[]} */
  const params = id.startsWith("composer")
    ? [{ id: "fast", value: "false" }]
    : [
        { id: "context", value: "256k" },
        { id: "reasoning_effort", value: "high" },
        { id: "fast", value: "false" },
      ];
  return { id, params };
}

/** Text-only Personal Agent. Default grok-4.7 high, Fast off. */
export const DEFAULT_MODEL_SPEC = personalModelSpec(
  process.env.CURSOR_PERSONAL_MODEL || process.env.CURSOR_EDUCATION_MODEL,
  "grok-4.7"
);

/** Attachment / image Personal Agent. grok-4.7 high, Fast off, independent of text-only. */
export const ATTACHMENT_MODEL_SPEC = personalModelSpec(
  process.env.CURSOR_PERSONAL_ATTACHMENT_MODEL ||
    process.env.CURSOR_EDUCATION_ATTACHMENT_MODEL,
  "grok-4.7"
);

/**
 * Copy a ModelSelection (never reuse param object refs).
 * @param {{ id: string, params?: ModelParam[] }} spec
 * @returns {ModelSelection}
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
 * Prefer an exact catalog variant's params when available (SDK-recommended).
 * @param {string} apiKey
 * @param {{ id: string, params: ModelParam[] }} spec
 * @returns {Promise<ModelSelection>}
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
      if (params.length !== wanted.length) {
        // Still match if every wanted param is present (extra params ok).
        return wanted.every((w) =>
          params.some((p) => p.id === w.id && p.value === w.value)
        );
      }
      return wanted.every((w) =>
        params.some((p) => p.id === w.id && p.value === w.value)
      );
    });

    if (variant?.params?.length) {
      return modelSelection({ id: listed.id, params: variant.params });
    }

    // Catalog has the model but no matching variant — keep explicit params.
    return fallback;
  } catch (err) {
    console.warn(
      "[personal-agent] model catalog lookup failed; using explicit ModelSelection",
      err instanceof Error ? err.message : err
    );
    return fallback;
  }
}

const IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

function pruneSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.status === "running") continue;
    if ((s.turnQueue || []).length > 0) continue;
    if (now - s.lastUsedAt > SESSION_TTL_MS) {
      disposeSession(id).catch(() => {});
    }
  }
}
setInterval(pruneSessions, 5 * 60 * 1000).unref?.();

/**
 * Committed transcript + waiting queue bubbles (queued msgs are NOT in
 * session.messages until their turn starts, so replies stay interleaved).
 * @param {Session} session
 * @returns {ChatMessage[]}
 */
export function snapshotMessages(session) {
  /** @type {ChatMessage[]} */
  const out = (session.messages || []).map((m) => {
    /** @type {ChatMessage} */
    const row = {
      role: m.role,
      content: m.content,
    };
    if (Array.isArray(m.widgets) && m.widgets.length) {
      row.widgets = m.widgets;
    }
    // endOfTurn is backend-only — never shown in the UI.
    return row;
  });
  for (const turn of session.turnQueue || []) {
    /** @type {ChatMessage} */
    const row = {
      role: "user",
      content: turn.bubble || "(attachment)",
      queued: true,
    };
    if (turn.queueId) row.queueId = turn.queueId;
    out.push(row);
  }
  return out;
}

/**
 * Put the interrupt sentence in front of the user line. No-op if it is already there.
 * @param {string} prompt
 * @returns {string}
 */
export function withInterruptNote(prompt, kind) {
  const note = interruptClarificationNote(kind);
  let text = String(prompt || "");
  if (!text) return text;
  if (note !== INTERRUPT_NOTE && text.includes(INTERRUPT_NOTE)) {
    text = text.replace(INTERRUPT_NOTE, note);
  }
  if (text.includes(note)) return text;
  const marker = "\n\nUser:\n";
  const at = text.lastIndexOf(marker);
  if (at < 0) return `${text}\n\n${note}`;
  return `${text.slice(0, at)}\n\n${note}${text.slice(at)}`;
}

const OWED_CHANNEL_LATER = {
  teams: [
    "This turn is on the website or app. The reply stays in this chat. Do not post it to Teams. Do not run school-teams.js send. send_chat_message stays in the app and website only.",
    "Post to that Teams chat only when this message asks you to tell that chat, reply there, or send something those people should see. A follow-up on the same topic, typed here, stays here. The group already got the first reply.",
  ].join("\n"),
  imessage: [
    "This turn is on the website or app. The reply stays in this chat. Do not text it. Do not sendIMessage or POST /imessage/send for this reply. send_chat_message stays in the app and website only.",
    "Text that iMessage chat only when this message asks you to tell that chat, reply there, or send something those people should see. A follow-up on the same topic, typed here, stays here. The chat already got the first reply.",
  ].join("\n"),
  whatsapp:
    "This turn is on the website or app. The reply stays here. Do not send it to WhatsApp unless this message asks you to tell that chat.",
};

const OWED_CHANNEL_DELIVER = {
  teams:
    "This interruption is a clarification of the unfinished @agent. Write the final bubble as the text that should land in that Teams chat. Markdown is fine. The server delivers that bubble to Teams. Do not also school-teams send that same final text. On a long job, send_chat_message still posts to that Teams chat.",
  imessage:
    "This interruption is a clarification of the unfinished @agent. Write the final bubble as the text that should land in that iMessage. Plain words, no markdown. The server delivers that bubble to iMessage. Do not also sendIMessage that same final text. On a long job, send_chat_message still posts to that iMessage chat.",
  whatsapp:
    "This interruption is a clarification of the unfinished @agent. Write the final bubble as the text that should land in that WhatsApp chat. Plain words, no markdown. The server delivers that bubble. Do not also send it yourself.",
};

/**
 * A queued prompt was built as a later app turn. The @agent reply never
 * went out, so swap the stay-in-the-app lines for a delivery instruction.
 * @param {string} prompt
 * @param {string} [kind]
 */
export function rewritePromptForOwedChannel(prompt, kind) {
  const text = String(prompt || "");
  const from = OWED_CHANNEL_LATER[kind];
  const to = OWED_CHANNEL_DELIVER[kind];
  if (!text || !from || !to || !text.includes(from)) return text;
  return text.replace(from, to);
}

/**
 * The cancelled @agent turn never delivered. Put the channel flag back
 * so this turn's prompt and send path still reply in that chat.
 * @param {Session} session
 * @returns {''|'imessage'|'teams'|'whatsapp'}
 */
export function restoreOwedChannelDelivery(session) {
  const kind = String(session?.channelReplyOwed || "");
  if (kind === "imessage") session.imessageDeliverFinal = true;
  else if (kind === "teams") session.teamsDeliverFinal = true;
  else if (kind === "whatsapp") session.whatsappDeliverFinal = true;
  return /** @type {''|'imessage'|'teams'|'whatsapp'} */ (
    kind === "imessage" || kind === "teams" || kind === "whatsapp" ? kind : ""
  );
}

/**
 * Move session deliver flags onto the turn that will actually send.
 * @param {Session} session
 * @param {TurnOpts} turnOpts
 */
export function claimChannelDelivery(session, turnOpts) {
  if (!session || !turnOpts) return "";
  const kind = channelProgressKind(session);
  if (!kind) return "";
  if (kind === "imessage") turnOpts.imessageDeliverFinal = true;
  else if (kind === "teams") turnOpts.teamsDeliverFinal = true;
  else if (kind === "whatsapp") turnOpts.whatsappDeliverFinal = true;
  session.imessageDeliverFinal = false;
  session.teamsDeliverFinal = false;
  session.whatsappDeliverFinal = false;
  session.channelReplyOwed = kind;
  return kind;
}

/**
 * Promoted queued turn takes over a reply that has not gone out yet.
 * @param {Session} session
 * @param {TurnOpts} turn
 */
export function handOffOwedChannel(session, turn) {
  const kind = String(session?.channelReplyOwed || "");
  if (!kind || !turn) return "";
  if (kind !== "imessage" && kind !== "teams" && kind !== "whatsapp") return "";
  turn.imessageDeliverFinal = kind === "imessage";
  turn.teamsDeliverFinal = kind === "teams";
  turn.whatsappDeliverFinal = kind === "whatsapp";
  return kind;
}

/**
 * Remove one waiting turn by id. Other queued turns stay in order.
 * @param {{ turnQueue?: TurnOpts[] }} session
 * @param {string} queueId
 * @returns {TurnOpts|null}
 */
export function detachQueuedTurn(session, queueId) {
  const id = String(queueId || "").trim();
  if (!id || !session || !Array.isArray(session.turnQueue)) return null;
  const index = session.turnQueue.findIndex((turn) => turn && turn.queueId === id);
  if (index < 0) return null;
  const [turn] = session.turnQueue.splice(index, 1);
  return turn || null;
}

/**
 * @param {Session} session
 * @returns {number}
 */
function queuedTurnCount(session) {
  return Array.isArray(session.turnQueue) ? session.turnQueue.length : 0;
}

/**
 * Full visible thread for a recreated Cursor agent. No truncation: the new
 * Agent has an empty cache, so the model only sees what we put here.
 * Omits the in-flight user bubble (already in this turn's prompt).
 * Queued waiting bubbles are not included; they have not started yet.
 * @param {Session} session
 * @param {string} [currentBubble]
 */
export function formatVisibleTranscript(session, currentBubble) {
  const msgs = Array.isArray(session?.messages) ? session.messages : [];
  let end = msgs.length;
  const bubble = String(currentBubble || "");
  if (
    end > 0 &&
    bubble &&
    msgs[end - 1]?.role === "user" &&
    msgs[end - 1]?.content === bubble
  ) {
    end -= 1;
  }
  /** @type {string[]} */
  const lines = [];
  for (let i = 0; i < end; i++) {
    const m = msgs[i];
    const text = String(m?.content || "").trim();
    const fences =
      m?.role === "assistant" ? formatWidgetsAsFences(m.widgets) : "";
    if (!text && !fences) continue;
    const who = m.role === "assistant" ? "Assistant" : "User";
    lines.push(`${who}:`);
    if (text) lines.push(text);
    if (fences) lines.push(fences);
    lines.push("");
  }
  if (!lines.length) return "";
  return [
    "Previous messages in this chat (still shown in the UI). The local Cursor agent was recreated and does not have this thread in its cache. This is the full conversation so far. Use it as context. Do not redo work already completed in this thread unless the current message asks.",
    "",
    ...lines,
  ]
    .join("\n")
    .trim();
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isTruthyFlag(raw) {
  if (raw === true || raw === 1) return true;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
  return false;
}

/**
 * Queue vs interrupt vs take the idle slot.
 * Interrupt never consumes a queue slot (ignores the 8-cap).
 * @param {string} status
 * @param {boolean} interrupt
 * @param {number} queueLength
 * @param {number} [maxQueued]
 * @returns {{ willQueue: boolean, interrupt: boolean }}
 */
export function resolveIncomingTurnMode(
  status,
  interrupt,
  queueLength,
  maxQueued = MAX_QUEUED_TURNS
) {
  const running = status === "running";
  if (running && interrupt) {
    return { willQueue: false, interrupt: true };
  }
  if (running) {
    if (queueLength >= maxQueued) {
      const err = new Error(
        `Message queue full (max ${maxQueued}). Wait for a reply before sending more.`
      );
      err.status = 429;
      throw err;
    }
    return { willQueue: true, interrupt: false };
  }
  return { willQueue: false, interrupt: false };
}

/**
 * Skip a duplicate EOT when the last send_chat_message already has this text.
 * @param {ChatMessage[]|undefined|null} messages
 * @param {string} content
 * @param {object[]} [widgets]
 */
export function shouldAppendEndOfTurn(messages, content, widgets) {
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
  if (!last || last.role !== "assistant") return true;
  const next = String(content || "").trim();
  const prev = String(last.content || "").trim();
  if (prev !== next) return true;
  return JSON.stringify(last.widgets || []) !== JSON.stringify(widgets || []);
}

/**
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @param {object[]} [widgets]
 * @param {{ endOfTurn?: boolean }} [extra]
 */
export function stampMessage(role, content, widgets, extra) {
  const text =
    role === "assistant" ? stripAgentSentFooter(content) : content;
  /** @type {ChatMessage} */
  const row = { role, content: text, at: new Date().toISOString() };
  if (Array.isArray(widgets) && widgets.length) row.widgets = widgets;
  if (extra?.endOfTurn) row.endOfTurn = true;
  return row;
}

/**
 * @param {Session} session
 */
function releaseTurnRun(session) {
  session.activeRun = null;
  session.runPromise = null;
  session.workingLabel = null;
}

/**
 * @param {Session} session
 * @param {string} sid
 * @param {string|null} label
 */
function setSessionWorkingLabel(session, sid, label) {
  const next = label || null;
  if (session.workingLabel === next) return;
  session.workingLabel = next;
  notifyEducationClients(session.email, "change", {
    source: "agent",
    sessionId: sid,
    status: session.status || "running",
    workingLabel: next,
  });
}

function mintNavigateId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `nav-${Date.now().toString(36)}`;
}

/**
 * Sanitize an education page target from the agent tool (or tests).
 * @param {unknown} raw
 * @returns {Omit<EducationNavigate, 'id'> & { id?: string } | null}
 */
export function normalizeEducationNavigate(raw) {
  if (!raw || typeof raw !== "object") return null;
  const src = /** @type {Record<string, unknown>} */ (raw);
  const view = String(src.view || "")
    .trim()
    .toLowerCase();
  if (!EDUCATION_VIEWS.has(view)) return null;
  const str = (key, max = 120) => {
    if (src[key] == null) return "";
    return String(src[key]).trim().slice(0, max);
  };
  const classId = str("classId");
  const projectId = str("projectId");
  const todoId = str("todoId", 200);
  const dateId = str("dateId", 200);
  const capsuleId = str("capsuleId");
  const caseId = str("caseId");
  const caseSideRaw = str("caseSide") || str("side");
  const caseSide = caseSideRaw.toLowerCase() === "neg" ? "neg" : caseSideRaw ? "aff" : "";
  if (view === "class" && !classId) return null;
  if (view === "project" && !projectId) return null;
  if (view === "todo" && !todoId) return null;
  if (view === "date" && !dateId) return null;
  if (view === "capsule" && (!todoId || !capsuleId)) return null;
  if (view === "case" && !caseId) return null;
  /** @type {Omit<EducationNavigate, 'id'> & { id?: string }} */
  const out = { view: /** @type {EducationNavigate['view']} */ (view) };
  if (classId) out.classId = classId;
  if (projectId) out.projectId = projectId;
  if (todoId) out.todoId = todoId;
  if (dateId) out.dateId = dateId;
  if (capsuleId) out.capsuleId = capsuleId;
  if (caseId) out.caseId = caseId;
  if (view === "case") out.caseSide = caseSide === "neg" ? "neg" : "aff";
  const id = str("id", 80);
  if (id) out.id = id;
  return out;
}

/**
 * Website pathname (+ query) for a navigate target.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function educationNavigateHref(raw) {
  const n = normalizeEducationNavigate(raw);
  if (!n) return null;
  const q = n.projectId
    ? `?project=${encodeURIComponent(n.projectId)}`
    : n.classId
      ? `?class=${encodeURIComponent(n.classId)}`
      : "";
  switch (n.view) {
    case "home":
      return "/education/";
    case "class":
      return `/education/class/${encodeEducationRouteId(n.classId || "")}`;
    case "project":
      return `/education/project/${encodeEducationRouteId(n.projectId || "")}`;
    case "todo":
      return `/education/todo/${encodeEducationRouteId(n.todoId || "")}${q}`;
    case "date":
      return `/education/date/${encodeEducationRouteId(n.dateId || "")}${q}`;
    case "capsule":
      return `/education/todo/${encodeEducationRouteId(n.todoId || "")}/capsule/${encodeEducationRouteId(
        n.capsuleId || ""
      )}${q}`;
    case "case": {
      const side = n.caseSide === "neg" ? "neg" : "aff";
      return `/debate/case/${encodeEducationRouteId(n.caseId || "")}/${side}`;
    }
    default:
      return null;
  }
}

/**
 * @param {Session} session
 * @returns {EducationNavigate|null}
 */
function sessionNavigatePayload(session) {
  return session?.navigate || null;
}

/**
 * Remember a page to open when this turn finishes. Last call wins.
 * Does not jump clients yet.
 * @param {Session|null|undefined} session
 * @param {unknown} raw
 * @returns {Omit<EducationNavigate, 'id'>|null}
 */
export function queueEducationNavigate(session, raw) {
  const nav = normalizeEducationNavigate(raw);
  if (!session || !nav) return null;
  const { id: _ignored, ...rest } = nav;
  session.pendingNavigate = rest;
  return rest;
}

/**
 * Mint the one-shot jump for a finished turn. No-op if nothing was queued.
 * @param {Session|null|undefined} session
 * @returns {EducationNavigate|null}
 */
export function publishQueuedEducationNavigate(session) {
  if (!session?.pendingNavigate) return null;
  /** @type {EducationNavigate} */
  const next = { ...session.pendingNavigate, id: mintNavigateId() };
  session.pendingNavigate = null;
  session.navigate = next;
  return next;
}

/**
 * @param {Session} session
 * @param {string} sid
 * @param {Record<string, unknown>} extra
 */
function notifyTurnFinished(session, sid, extra) {
  const navigate = publishQueuedEducationNavigate(session);
  /** @type {Record<string, unknown>} */
  const payload = {
    source: "agent",
    sessionId: sid,
    ...extra,
  };
  if (navigate) payload.navigate = navigate;
  notifyEducationClients(session.email, "change", payload);
  scheduleEphemeralHideNotify(sid, session, extra?.status);
}

function clearEphemeralHideTimer(sid) {
  const t = ephemeralHideTimers.get(sid);
  if (t) {
    clearTimeout(t);
    ephemeralHideTimers.delete(sid);
  }
}

/**
 * SSE/poll so an open history drawer drops the row at 10 minutes.
 * List filtering still uses the file's `updated` time if the process restarts.
 * @param {string} sid
 * @param {Session} session
 * @param {unknown} status
 */
function scheduleEphemeralHideNotify(sid, session, status) {
  clearEphemeralHideTimer(sid);
  if (shouldPersistChatEphemeral(session) !== true) return;
  if (String(status || "") === "running") return;
  const t = setTimeout(() => {
    ephemeralHideTimers.delete(sid);
    if (session.ephemeralPinned) return;
    notifyEducationClients(session.email, "change", {
      source: "agent",
      sessionId: sid,
      status: "idle",
    });
  }, EPHEMERAL_HIDE_MS);
  if (typeof t.unref === "function") t.unref();
  ephemeralHideTimers.set(sid, t);
}

/**
 * @param {string} sid
 * @param {Session} session
 */
function openEducationPageTool(sid, session) {
  return {
    open_education_page: {
      description:
        "Queue an education dashboard page to open once this turn finishes (website in place, iOS Education tab without leaving Chat). The jump happens when your final reply lands, not when you call this tool. Last call in the turn wins. Call when the user asks about one todo, class, project, date, capsule, or debate case, says show/take me there, or you just created that object. Skip if Live context is already that page, for lists of many items, or for mail/news/fitness. Call after the folder exists. Express/web/iOS only; not Cursor Desktop.",
      inputSchema: {
        type: "object",
        properties: {
          view: {
            type: "string",
            description: "home | class | project | todo | date | capsule | case",
          },
          classId: { type: "string", description: "Class folder id" },
          projectId: { type: "string", description: "Project folder id" },
          todoId: {
            type: "string",
            description:
              "Todo folder name on disk (OneDrive class folders look like HW Sep 15 Title, not the UI title alone)",
          },
          dateId: { type: "string", description: "Date folder name on disk" },
          capsuleId: { type: "string", description: "Briefing capsule id" },
          caseId: { type: "string", description: "Debate case folder id" },
          caseSide: { type: "string", description: "aff or neg" },
        },
        required: ["view"],
      },
      execute(input) {
        if (!sessions.has(sid) || sessions.get(sid) !== session) {
          return "session gone";
        }
        const queued = queueEducationNavigate(session, input);
        if (!queued) return "invalid target";
        return `queued ${queued.view} (opens when this turn finishes)`;
      },
    },
  };
}

function originFromSession(session) {
  const teams = session?.teamsOrigin;
  if (teams && typeof teams === "object") {
    const chatId = String(teams.chatId || teams.to || "").trim();
    if (chatId) {
      return {
        kind: "teams",
        chatId,
        chat: String(teams.chat || "").trim(),
        to: String(teams.to || chatId).trim(),
        text: String(teams.text || "").slice(0, 500),
      };
    }
  }
  const im = session?.imessageOrigin;
  if (im && typeof im === "object") {
    const to = String(im.to || im.handle || "").trim();
    const chatGuid = String(im.chatGuid || "").trim();
    if (to || chatGuid) {
      return {
        kind: "imessage",
        to,
        chatGuid,
        chat: String(im.chat || "").trim(),
        text: String(im.text || "").slice(0, 500),
      };
    }
  }
  const wa = session?.whatsappOrigin;
  if (wa && typeof wa === "object") {
    const to = String(wa.to || wa.chat || "").trim();
    const chatJid = String(wa.chatJid || wa.chatId || "").trim();
    if (to || chatJid) {
      return {
        kind: "whatsapp",
        to,
        chat: String(wa.chat || "").trim(),
        chatId: chatJid,
        chatJid,
        text: String(wa.text || "").slice(0, 500),
      };
    }
  }
  return { kind: "" };
}

function canManageFutureAgent(record, session) {
  if (!record || !session) return false;
  if (sessionWorkspace(session) === "jype") return record.workspace === "jype";
  return record.workspace !== "jype" && record.email === session.email;
}

/**
 * @param {Session} session
 * @param {object|null|undefined} record
 */
function attachScheduledToSession(session, record) {
  if (!session || !record) return;
  session.scheduled = true;
  session.scheduledRunAt = record.runAt;
  session.scheduledStatus = record.status || "pending";
  session.futureAgentRecord = record;
  session.forceGrok = true;
  session.ephemeralPinned = true;
  const origin = record.origin || {};
  if (origin.kind === "teams" && origin.chatId) {
    session.teamsOrigin = {
      chatId: origin.chatId,
      to: origin.to || origin.chatId,
      chat: origin.chat || "",
      text: origin.text || "",
    };
  } else if (origin.kind === "imessage" && (origin.to || origin.chatGuid)) {
    session.imessageOrigin = {
      to: origin.to || "",
      chatGuid: origin.chatGuid || "",
      chat: origin.chat || "",
      handle: origin.to || "",
      text: origin.text || "",
    };
  } else if (origin.kind === "whatsapp" && (origin.to || origin.chatJid || origin.chatId)) {
    session.whatsappOrigin = {
      platform: "whatsapp",
      to: origin.to || origin.chat || "",
      chat: origin.chat || "",
      chatId: origin.chatId || origin.chatJid || "",
      chatJid: origin.chatJid || origin.chatId || "",
      text: origin.text || "",
    };
  }
}

function notifyScheduledThread(email, workspace, sessionId, status) {
  notifyEducationClients(email, "change", {
    source: "agent",
    sessionId,
    status: status || "idle",
    ...(workspace === "jype" ? { workspace: "jype" } : {}),
  });
}

/**
 * @param {string} sid
 * @param {Session} session
 */
function futureAgentTools(sid, session) {
  return {
    schedule_future_agent: {
      description:
        "Schedule a one-time future agent in this same chat history. Use it whenever the user wants a reminder, a message after something finishes, or anything that has to wait (end of a period, once we're done, send it later). A hint is enough. Pass an ISO time with a timezone offset, the task the future agent should do, and context it cannot re-derive (URLs, who asked, what you already did). The tool copies this session's Teams or iMessage chat. The thread shows up immediately. Do the work that can happen now yourself. Schedule only the part that has to wait.",
      inputSchema: {
        type: "object",
        properties: {
          runAt: {
            type: "string",
            description:
              "ISO time with an offset, America/Los_Angeles. Example 2026-10-13T09:35:00-07:00. For a result ready at a bell, use the period end minus 5 minutes.",
          },
          prompt: {
            type: "string",
            description:
              "The task, in plain words. This becomes the first user message under the scheduled time.",
          },
          context: {
            type: "string",
            description:
              "Facts the future agent needs: live URL, who asked, which chat this came from, what you already finished.",
          },
        },
        required: ["runAt", "prompt"],
      },
      async execute({ runAt, prompt, context }) {
        if (!sessions.has(sid) || sessions.get(sid) !== session) {
          return "session gone";
        }
        try {
          const result = await scheduleFutureAgentLive({
            runAt,
            prompt,
            context,
            workspace: sessionWorkspace(session),
            email: session.email,
            person: usagePerson(session),
            origin: originFromSession(session),
          });
          return JSON.stringify({
            ok: true,
            sessionId: result.sessionId,
            runAtLocal: result.runAtLocal,
            history: result.history,
            title: result.title,
            pending: result.pending,
          });
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
    },
    cancel_future_agent: {
      description:
        "Cancel a pending future agent you can see in this workspace. Pass the sessionId from schedule_future_agent or from the pending list. Does nothing once it has started.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
        },
        required: ["sessionId"],
      },
      async execute({ sessionId }) {
        if (!sessions.has(sid) || sessions.get(sid) !== session) {
          return "session gone";
        }
        try {
          const result = await cancelFutureAgentLive(sessionId, session);
          return JSON.stringify(result);
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
    },
  };
}

/**
 * @param {string} sid
 * @param {Session} session
 */
function sessionCustomTools(sid, session) {
  return {
    ...sendChatMessageTool(sid, session),
    ...futureAgentTools(sid, session),
    ...openEducationPageTool(sid, session),
    ...(sessionMayUseBrowser(session) ? browserCustomTools(session) : {}),
    ...computerUseCustomTools(session),
  };
}

/**
 * @param {string} sid
 * @param {Session} session
 */
function sendChatMessageTool(sid, session) {
  return {
    send_chat_message: {
      description:
        "Send a user-visible chat bubble immediately without ending the turn. On an iMessage or Teams @agent or @agentg first turn, this also posts that text to the same chat right away. Before a long job (a new page, a study guide, a big write), send one short line of what you are about to do, then start the work. Send another only when that chat should hear something new. Do not send still working with no news. The server still sends your final reply when the work is done, so do not put that same final text here. On a normal app chat this stays in the app and website only. Do not call this for a short answer.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Markdown bubble text. Widget fences allowed.",
          },
        },
        required: ["text"],
      },
      async execute({ text }) {
        const raw = String(text || "").trim();
        if (!raw) return "ignored empty";
        if (!sessions.has(sid) || sessions.get(sid) !== session) {
          return "session gone";
        }
        const parsed = parseAgentReply(raw);
        const content =
          parsed.content || (parsed.widgets.length ? "" : raw);
        if (!content && !parsed.widgets.length) return "ignored empty";
        if (!Array.isArray(session.messages)) session.messages = [];
        session.messages.push(
          stampMessage("assistant", content, parsed.widgets)
        );
        persistSessionHistory(sid, session);
        notifyEducationClients(session.email, "change", {
          source: "agent",
          sessionId: sid,
          status: "running",
        });
        if (!session.channelProgress || !content) return "delivered";
        const sent = await deliverChannelProgress(session, content);
        return channelSendToolResult(sent);
      },
    },
  };
}

/**
 * @param {Session} session
 */
async function cancelActiveRun(session) {
  const run = session.activeRun;
  if (run && typeof run.cancel === "function") {
    try {
      await run.cancel();
    } catch {
      /* already finished */
    }
  }
  if (session.runPromise) {
    await session.runPromise.catch(() => {});
  }
}

function persistSessionHistory(sid, session) {
  const snap = snapshotMessages(session);
  const userTurns = snap.filter((m) => m.role === "user").length;
  const hasAssistant = snap.some((m) => m.role === "assistant");
  const ephemeral = shouldPersistChatEphemeral(session);
  /** @type {{
   *   email: string,
   *   sessionId: string,
   *   messages: ReturnType<typeof snapshotMessages>,
   *   markRead: boolean,
   *   ephemeral?: boolean,
   * }} */
  const opts = {
    email: session.email,
    sessionId: sid,
    messages: snap,
    markRead: shouldKeepChatHistoryRead(session, snap),
    workspace: sessionWorkspace(session),
    starter: session.starter || "",
  };
  if (ephemeral != null) opts.ephemeral = ephemeral;
  if (session.scheduled) {
    opts.scheduled = true;
    opts.scheduledRunAt = session.scheduledRunAt || "";
    opts.scheduledStatus = session.scheduledStatus || "pending";
  }
  return persistChatHistory(opts)
    .then(() => {
      // Wait for the first assistant bubble so the title agent is not
      // racing the live Grok turn (Teams @agent was getting the truncated
      // first message as the title).
      if (userTurns === 1 && hasAssistant) {
        enqueueChatTitle({
          email: session.email,
          sessionId: sid,
          workspace: sessionWorkspace(session),
          starter: session.starter || "",
        });
      }
    })
    .catch((err) => {
      console.error("[personal-agent] chat-history", err);
    });
}

/**
 * @param {TurnOpts|null|undefined} opts
 * @returns {''|'imessage'|'teams'}
 */
export function channelProgressKind(opts) {
  if (opts?.imessageDeliverFinal) return "imessage";
  if (opts?.teamsDeliverFinal) return "teams";
  if (opts?.whatsappDeliverFinal) return "whatsapp";
  return "";
}

function originForChannel(session, kind) {
  if (kind === "whatsapp") return session?.whatsappOrigin;
  if (kind === "teams") return session?.teamsOrigin;
  return session?.imessageOrigin;
}

function channelName(kind) {
  if (kind === "whatsapp") return "WhatsApp";
  if (kind === "teams") return "Teams";
  return "iMessage";
}

/**
 * The early plan line already went out. Skip a second copy of that same text.
 * @param {unknown} last
 * @param {unknown} finalText
 */
export function shouldSkipDuplicateChannelSend(last, finalText) {
  const prev = String(last || "").trim();
  const next = String(finalText || "").trim();
  return Boolean(prev) && prev === next;
}

/**
 * Early @agent / @agentg line. Text only, so a later final reply can still attach files.
 * @param {object|null|undefined} origin
 * @param {string} content
 */
export async function deliverIMessageProgressReply(origin, content) {
  const body = applyAgentSentFooter(content, origin);
  if (!body) return { ok: false, skipped: "empty" };
  if (body.includes(PA_ERROR_REPLY)) return { ok: false, skipped: "error" };
  const to = String(origin?.to || origin?.chatId || origin?.handle || "").trim();
  const chatGuid = String(origin?.chatGuid || "").trim();
  if (!to && !chatGuid) return { ok: false, skipped: "no-target" };
  return sendIMessage({
    to: to || chatGuid,
    text: body,
    chatGuid: chatGuid || undefined,
  });
}

/**
 * Post one in-progress line to the iMessage or Teams chat this turn came from.
 * @param {Session} session
 * @param {string} content
 */
async function deliverChannelProgress(session, content) {
  const kind = session.channelProgress;
  const body = String(content || "").trim();
  if (!kind || !body) return { ok: false, skipped: "empty" };
  if (body.includes(PA_ERROR_REPLY)) return { ok: false, skipped: "error" };
  const rawOrigin = originForChannel(session, kind);
  try {
    const result =
      kind === "imessage"
        ? await deliverIMessageProgressReply(rawOrigin, body)
        : kind === "whatsapp"
          ? await deliverWhatsAppProgressReply(rawOrigin, body)
          : await deliverTeamsFinalReply(rawOrigin, body);
    if (result?.ok && !result?.skipped) {
      session.lastChannelProgressText = body;
    }
    return result;
  } catch (err) {
    console.error(`[personal-agent] ${kind} progress`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * First turn of an iMessage-originated chat: send the final bubble to that thread.
 * @param {object|null|undefined} origin
 * @param {string} content
 */
export async function deliverIMessageFinalReply(origin, content) {
  const body = applyAgentSentFooter(content, origin);
  if (!body) {
    takeIMessageReplyFiles(origin);
    return { ok: false, skipped: "empty" };
  }
  if (body.includes(PA_ERROR_REPLY)) {
    takeIMessageReplyFiles(origin);
    return { ok: false, skipped: "error" };
  }
  const to = String(origin?.to || origin?.chatId || origin?.handle || "").trim();
  const chatGuid = String(origin?.chatGuid || "").trim();
  if (!to && !chatGuid) {
    takeIMessageReplyFiles(origin);
    return { ok: false, skipped: "no-target" };
  }
  return sendIMessage({
    to: to || chatGuid,
    text: body,
    chatGuid: chatGuid || undefined,
    files: takeIMessageReplyFiles(origin),
  });
}

/**
 * First turn of a Teams-originated chat: send the final bubble to that thread.
 * @param {object|null|undefined} origin
 * @param {string} content
 */
export async function deliverWhatsAppProgressReply(origin, content) {
  if (!WHATSAPP_AGENT_ENABLED) return { ok: false, skipped: "disabled" };
  const body = applyAgentSentFooter(content, { ...origin, platform: "whatsapp" });
  if (!body) return { ok: false, skipped: "empty" };
  if (body.includes(PA_ERROR_REPLY)) return { ok: false, skipped: "error" };
  const chat = String(origin?.chat || origin?.to || "").trim();
  const chatJid = String(origin?.chatJid || origin?.chatId || "").trim();
  if (!chat && !chatJid) return { ok: false, skipped: "no-target" };
  return sendWhatsApp({
    to: chat || chatJid,
    chat,
    chatJid,
    text: body,
  });
}

export async function deliverWhatsAppFinalReply(origin, content) {
  return deliverWhatsAppProgressReply(origin, content);
}

export async function deliverTeamsFinalReply(origin, content) {
  const body = String(content || "").trim();
  if (!body) return { ok: false, skipped: "empty" };
  if (body.includes(PA_ERROR_REPLY)) return { ok: false, skipped: "error" };
  const chat = String(origin?.chatId || origin?.to || origin?.chat || "").trim();
  if (!chat) return { ok: false, skipped: "no-target" };
  return sendTeamsMessage({
    chat,
    text: body,
  });
}

/** How many times to wake the same agent after a chat send fails. */
export const OUTBOUND_RESUME_LIMIT = 3;

/**
 * @param {unknown} err
 */
export function outboundFailureText(err) {
  if (!err) return "send failed";
  return err instanceof Error ? err.message : String(err);
}

/**
 * The Nikita miss: Messages rejected a chat id and the turn ended.
 * @param {unknown} error
 */
export function shouldDropRejectedChatGuid(error) {
  return /no Messages chat|Refusing to text a person/i.test(String(error || ""));
}

/**
 * @param {object|null|undefined} origin
 * @param {unknown} error
 */
export function dropRejectedChatGuid(origin, error) {
  if (!origin || typeof origin !== "object") return false;
  if (!String(origin.chatGuid || "").trim()) return false;
  if (!shouldDropRejectedChatGuid(error)) return false;
  origin.chatGuid = "";
  return true;
}

/**
 * @param {{ ok?: boolean, skipped?: string, failed?: boolean, error?: string }|null|undefined} delivery
 */
export function shouldResumeOutboundSend(delivery) {
  if (!delivery || delivery.ok || delivery.skipped) return false;
  return Boolean(delivery.failed || delivery.error);
}

/**
 * @param {{
 *   delivery?: { ok?: boolean, skipped?: string, failed?: boolean, error?: string }|null,
 *   guidDropped?: boolean,
 *   resumes?: number,
 * }} state
 * @returns {"done"|"drop-guid"|"resume"|"give-up"}
 */
export function nextOutboundAction(state) {
  const delivery = state?.delivery;
  if (!shouldResumeOutboundSend(delivery)) return "done";
  if (!state?.guidDropped && shouldDropRejectedChatGuid(delivery?.error)) {
    return "drop-guid";
  }
  if ((state?.resumes || 0) >= OUTBOUND_RESUME_LIMIT) return "give-up";
  return "resume";
}

/**
 * @param {string} channel
 * @param {unknown} error
 * @param {string} text
 */
export function outboundResumePrompt(channel, error, text) {
  const where = channelName(channel);
  return [
    `The ${where} send failed. This turn is not done.`,
    `Error: ${error || "send failed"}`,
    "Send the text below to that same chat. If the error is a rejected chat id, send to the person or phone and leave chatGuid off.",
    "Do not stop until a send returns ok. Do not redo work that already finished.",
    "",
    String(text || "").trim(),
  ].join("\n");
}

/**
 * What send_chat_message tells the model. A failure must not look like success.
 * @param {{ ok?: boolean, skipped?: string, error?: string }|null|undefined} sent
 */
export function channelSendToolResult(sent) {
  if (sent?.ok) return "delivered to the chat";
  if (sent?.skipped) return "delivered";
  const error = sent?.error ? String(sent.error) : "send failed";
  return `not sent. ${error} This turn is not done until that text is in the chat. Send it again.`;
}

/**
 * First-turn @agent: send the final to iMessage/Teams. App and website keep
 * that bubble, plus any send_chat_message updates from the same turn.
 * @param {Session} session
 * @param {string} content
 * @param {TurnOpts} opts
 * @returns {Promise<{ ok?: boolean, skipped?: string, failed?: boolean, error?: string }>}
 */
export async function confirmOutboundDelivery(session, content, opts) {
  const kind = channelProgressKind(opts);
  if (!kind) return { ok: true, skipped: "no-channel" };
  if (shouldSkipDuplicateChannelSend(session.lastChannelProgressText, content)) {
    return { ok: true, skipped: "duplicate" };
  }

  const rawOrigin = originForChannel(session, kind);
  try {
    const result =
      kind === "imessage"
        ? await deliverIMessageFinalReply(rawOrigin, content)
        : kind === "whatsapp"
          ? await deliverWhatsAppFinalReply(rawOrigin, content)
          : await deliverTeamsFinalReply(rawOrigin, content);
    if (result?.skipped) return { ok: false, skipped: result.skipped };
    if (result?.ok === false) {
      return {
        ok: false,
        failed: true,
        error: result.error || "send failed",
      };
    }
    session.lastChannelProgressText = String(content || "").trim();
    return { ok: true };
  } catch (err) {
    const error = outboundFailureText(err);
    console.error(
      `[personal-agent] ${kind} reply`,
      err
    );
    return { ok: false, failed: true, error };
  }
}

/**
 * One more send on the agent that just finished, so a failed text does not end the turn.
 * @param {Session} session
 * @param {string} sid
 * @param {string} text
 * @param {ModelSelection} model
 */
async function continueAgentSend(session, sid, text, model) {
  if (!session.agent || typeof session.agent.send !== "function") return "";
  const chunks = [];
  try {
    const run = await session.agent.send(text, {
      model,
      local: { customTools: sessionCustomTools(sid, session) },
    });
    session.activeRun = run;
    if (session.interrupting && typeof run.cancel === "function") {
      await run.cancel().catch(() => {});
      return "";
    }
    if (typeof run.stream === "function") {
      for await (const event of run.stream()) {
        if (session.interrupting) break;
        if (event?.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block?.type === "text" && typeof block.text === "string") {
              chunks.push(block.text);
            }
          }
        }
      }
    }
    if (session.interrupting) return "";
    const result = await run.wait();
    await logSdkResult({
      person: usagePerson(session),
      kind: usageKind(session),
      threadId: sid,
      prompt: "Channel delivery",
      model,
      result,
      startedAt: new Date().toISOString(),
    }).catch((err) => console.error("[usage] delivery log failed", err));
    let content =
      result && typeof result.result === "string" ? result.result.trim() : "";
    if (!content) {
      for (let i = chunks.length - 1; i >= 0; i--) {
        const piece = String(chunks[i] || "").trim();
        if (piece) {
          content = piece;
          break;
        }
      }
    }
    return content;
  } catch (err) {
    console.error("[personal-agent] outbound resume", err);
    return "";
  }
}

/**
 * Send the final bubble. If Messages or Teams rejects it, drop a bad chat id
 * and keep the same agent working until a send lands.
 * @param {Session} session
 * @param {string} sid
 * @param {string} content
 * @param {TurnOpts} opts
 * @param {ModelSelection} model
 */
async function settleOutboundSend(session, sid, content, opts, model) {
  const channel = channelProgressKind(opts);
  if (!channel) return content;
  let guidDropped = false;
  let resumes = 0;
  for (let guard = 0; guard < 8; guard++) {
    if (session.interrupting || !sessions.has(sid) || sessions.get(sid) !== session) {
      return content;
    }
    const delivery = await confirmOutboundDelivery(session, content, opts);
    const action = nextOutboundAction({ delivery, guidDropped, resumes });
    if (action === "done") {
      session.channelReplyOwed = "";
      return content;
    }
    if (action === "drop-guid") {
      const origin = originForChannel(session, channel);
      dropRejectedChatGuid(origin, delivery.error);
      guidDropped = true;
      continue;
    }
    if (action === "give-up" || !session.agent) {
      session.channelReplyOwed = "";
      const where = channelName(channel);
      const note = `The ${where} send still failed: ${delivery.error || "send failed"}`;
      session.messages.push(
        stampMessage("assistant", note, undefined, { endOfTurn: true })
      );
      await persistSessionHistory(sid, session);
      return content;
    }
    resumes += 1;
    setSessionWorkingLabel(session, sid, "Sending the reply");
    const next = await continueAgentSend(
      session,
      sid,
      outboundResumePrompt(channel, delivery.error, content),
      model
    );
    if (session.interrupting) return content;
    const parsed = parseAgentReply(next);
    const resumed = stripAgentSentFooter(parsed.content || "").trim();
    if (!resumed) continue;
    content = resumed;
    if (shouldAppendEndOfTurn(session.messages, content, parsed.widgets)) {
      session.messages.push(stampMessage("assistant", content, parsed.widgets));
    }
    await persistSessionHistory(sid, session);
  }
  return content;
}

/**
 * True when this session still has work to finish after the user leaves it.
 * @param {Session|undefined|null} session
 */
export function sessionHasBackgroundWork(session) {
  if (!session) return false;
  if (session.status === "running") return true;
  return queuedTurnCount(session) > 0;
}

/**
 * Teams/iMessage @agent first turn: keep the history row read after the
 * reply lands. Working still shows. Later app turns use unread as usual.
 * @param {Session|undefined|null} session
 * @param {{ role?: string }[]|undefined} messages
 */
export function shouldKeepChatHistoryRead(session, messages) {
  if (!session?.imessageOrigin && !session?.teamsOrigin && !session?.whatsappOrigin) return false;
  const userTurns = (messages || []).filter((m) => m.role === "user").length;
  return userTurns <= 1;
}

/**
 * Web and iOS Personal Agent clients. iMessage/Teams @agent is not this.
 * @param {Record<string, unknown>|null|undefined} uiContext
 */
export function isUiChatClient(uiContext) {
  const client = String(uiContext?.client || "")
    .trim()
    .toLowerCase();
  return client === "web" || client === "ios";
}

/**
 * true = mark the transcript ephemeral, false = pin it, null = leave the file as-is.
 * @param {Session|undefined|null} session
 * @returns {boolean|null}
 */
export function shouldPersistChatEphemeral(session) {
  if (!session) return null;
  if (sessionWorkspace(session) === "jype") return false;
  if (session.ephemeralPinned) return false;
  if (session.imessageOrigin || session.teamsOrigin || session.whatsappOrigin) return true;
  return null;
}

/**
 * A follow-up typed in the app cancels the 10-minute hide.
 * @param {Session|undefined|null} session
 * @param {Record<string, unknown>|null|undefined} uiContext
 * @param {string} [sessionId]
 */
export function pinEphemeralChatIfUiClient(session, uiContext, sessionId) {
  if (!session || !isUiChatClient(uiContext)) return false;
  session.ephemeralPinned = true;
  const sid = String(sessionId || "").trim();
  if (sid) clearEphemeralHideTimer(sid);
  return true;
}

/**
 * Drop an unfocused session only when it is empty and idle.
 * Running / queued threads keep working. Idle threads with a transcript
 * stay until TTL so /state still serves them.
 * @param {string} id
 */
async function releaseFocusFrom(id) {
  const prior = sessions.get(id);
  if (!prior) return;
  if (sessionHasBackgroundWork(prior)) return;
  if ((prior.messages || []).length > 0) return;
  await disposeSession(id).catch(() => {});
}

/**
 * Move the next queued turn's user bubble into the committed transcript.
 * @param {Session} session
 * @param {TurnOpts} turn
 */
function appendPromotedUserMessage(session, turn) {
  if (!Array.isArray(session.messages)) session.messages = [];
  session.messages.push(stampMessage("user", turn.bubble || "(attachment)"));
}

/**
 * Start a background turn; does not await completion.
 * @param {string} sid
 * @param {Session} session
 * @param {TurnOpts} opts
 */
function kickoffTurn(sid, session, opts) {
  session.status = "running";
  const runPromise = executeAgentTurn(sid, session, opts);
  session.runPromise = runPromise;
  runPromise.catch(() => {});
}

/**
 * @param {string} id
 */
async function disposeSession(id) {
  const s = sessions.get(id);
  sessions.delete(id);
  if (s?.email && activeByEmail.get(focusKey(s.email, s.workspace)) === id) {
    activeByEmail.delete(focusKey(s.email, s.workspace));
  }
  if (s?.uploadDirRel) {
    await rm(join(REPO_ROOT, s.uploadDirRel), {
      recursive: true,
      force: true,
    }).catch(() => {});
  }
  await disposeCursorAgent(s?.agent);
  await closeAgentBrowser().catch(() => {});
}

function requireKey() {
  return requireCursorApiKey();
}

/**
 * @param {Session} session
 * @param {ModelSelection} model
 */
async function replaceSessionAgent(session, model) {
  const prev = session.agent;
  session.agent = null;
  if (prev) await disposeCursorAgent(prev);
  await recreateLocalCursorAgent({
    model,
    cwd: REPO_ROOT,
    attach: (agent) => {
      session.agent = agent;
      session.replayUiTranscript = true;
    },
  });
}

onLocalCursorExecutorEvict(() => {
  for (const session of sessions.values()) {
    session.agent = null;
    session.replayUiTranscript = true;
  }
});

/** Global unslop skill. Always Read; never inline the whole file into the prompt. */
export const UNSLOP_SKILL_PATH = join(REPO_ROOT, ".cursor/skills/unslop/SKILL.md");

/** Four11 IDs + Fix Photo Group school photos. User-level; not in the repo. */
export const FOUR11_SKILL_PATH = join(
  homedir(),
  ".cursor/skills/eps-four11/SKILL.md"
);

/** On-demand files. Do not inline their contents into the turn prompt. */
export const PERSONAL_SKILL_PATHS = {
  agent: ".cursor/skills/personal-agent/SKILL.md",
  soul: "SOUL.md",
  education: ".cursor/skills/personal-agent/education-dashboard.md",
  debate: ".cursor/skills/debate-cases/SKILL.md",
  schedule: ".cursor/skills/class-schedule/SKILL.md",
  widgets: ".cursor/skills/chat-widgets/SKILL.md",
  mail: ".cursor/skills/personal-mail/SKILL.md",
  schoolMail: ".cursor/skills/personal-school-mail/SKILL.md",
  schoolOnenote: ".cursor/skills/personal-onenote/SKILL.md",
  schoolTeams: ".cursor/skills/personal-school-teams/SKILL.md",
  location: ".cursor/skills/phone-location/SKILL.md",
  lifeState: ".cursor/skills/life-state/SKILL.md",
  calendar: ".cursor/skills/personal-calendar/SKILL.md",
  home: ".cursor/skills/personal-home/SKILL.md",
  canvas: ".cursor/skills/personal-canvas/SKILL.md",
  imessage: ".cursor/skills/personal-imessage/SKILL.md",
  whatsapp: ".cursor/skills/personal-whatsapp/SKILL.md",
  screentime: ".cursor/skills/personal-screentime/SKILL.md",
  contacts: ".cursor/skills/personal-contacts/SKILL.md",
  people: ".cursor/skills/personal-people/SKILL.md",
  chats: ".cursor/skills/past-chats/SKILL.md",
  news: ".cursor/skills/daily-news/SKILL.md",
  fitness: ".cursor/skills/fitness-os/SKILL.md",
  browser: ".cursor/skills/personal-browser/SKILL.md",
  computer: ".cursor/skills/personal-computer/SKILL.md",
  brain: "education/you@example.com/brain/schema.md",
  synthesis: ".cursor/skills/context-synthesis/SKILL.md",
  locationEnrichment: ".cursor/skills/location-enrichment/SKILL.md",
  locationBrain: ".cursor/skills/location-brain/SKILL.md",
  healthBrain: ".cursor/skills/health-brain/SKILL.md",
  factCheck: ".cursor/skills/nightly-fact-check/SKILL.md",
  jypeAgent: ".cursor/skills/jype-agent/SKILL.md",
  futureAgents: ".cursor/skills/future-agents/SKILL.md",
  celebration: ".cursor/skills/create-celebration-website/SKILL.md",
};

const FUTURE_AGENT_HINT =
  "If the reply has to wait (remind me, once we're done, end of the period, send it later), call schedule_future_agent this turn. Read the future-agents skill. Do what you can now. Do not say you will remember.";

const EDUCATION_VIEWS = new Set([
  "home",
  "class",
  "project",
  "todo",
  "date",
  "capsule",
  "case",
]);

/**
 * Slim establishing prompt. Recipes live in PERSONAL_SKILL_PATHS.
 * @param {string} email
 */
export function systemPrompt(email, opts = {}) {
  const isOwner = isFullAccessEmail(email);
  const isJype = normalizeJypeWorkspace(opts.workspace) === "jype";
  if (isJype) {
    const given = jypeGivenName(email) || "JYPE";
    return [
      "You are the JYPE agent for yanylevin.com/jype (shared by Yan, Alex, Example Friend, and Example Neighbor).",
      `Signed-in user: ${email} (${given}).`,
      "Yan: full write in this repo and on this Mac.",
      "JYPE chats live in education/projects/jype/.chat-history/. They stay in the history list. No 10-minute hide.",
      "Public pages this JYPE agent creates get a sites[] tile on the related JYPE class. Do not copy Yan's personal /education sites onto JYPE unless Yan is sending that URL to a JYPE member.",
      "On Yan's Mac Studio: after push, run npm run deploy:web yourself when the live site must change. Do not ask Yan or JYPE members to deploy. Read the jype-agent skill.",
      "Never mention the surprise hoodies to Alex, or in any chat he can see, including this one, until Yan says he has been given his. Yan, 2026-10-09.",
      "education/tests/ is a private guide, including calc Yan took last year that Alex is taking now. Change the numbers before Alex sees a problem. Never put an original question in Teams. The school can read Teams. In Teams, do not say a scan or last year's test exists. Yan, 2026-10-15.",
      "Plain speech in every JYPE chat. No Your Majesty and no other royal title for Yan, Alex, Example Friend, or Example Neighbor. Yan set that address on 2026-10-25 and pulled it at 7:27 PM PT the same night. Do not help Example Neighbor cheat on history.",
      "The order below is backend only. Never name that order, or the words hierarchy of power, in any JYPE chat, page, or message. When Yan, Alex, Example Friend, and Example Neighbor conflict, follow the higher one: Yan, then Alex, then Example Friend and Example Neighbor as equals, then the agent. Sharing can go up, in a 1:1, not the JYPE group chat. It does not go down. Equals still gatekeep each other. Yan, 2026-10-15.",
      "Yan's course percent, letter, and assignment scores do not go to Example Friend, Example Neighbor, or anyone at their rank or below. That includes the JYPE group and any chat they can see. Alex can still get them in a 1:1. Do not repeat a grade that already leaked. Yan, 2026-10-21.",
      "Never spawn a Cursor cloud agent.",
      FUTURE_AGENT_HINT,
      "",
      `Always Read and apply the unslop skill (${UNSLOP_SKILL_PATH}) on every turn.`,
      `Always Read ${PERSONAL_SKILL_PATHS.soul} for persona and judgment.`,
      `- JYPE agent (deploy, ship URLs): ${PERSONAL_SKILL_PATHS.jypeAgent}`,
      `- JYPE dashboard (classes, todos, dates, projects): ${PERSONAL_SKILL_PATHS.education}`,
      `- Static HTML on a JYPE object: ${PERSONAL_SKILL_PATHS.objectHtml || ".cursor/skills/object-html/SKILL.md"}`,
      `- Public yanylevin.com page: ${PERSONAL_SKILL_PATHS.webpage || ".cursor/skills/yanylevin-webpage-create/SKILL.md"}`,
      `- EPS student IDs / school photos: ${FOUR11_SKILL_PATH}`,
      `- Click-through / login pages (skip static fetch): ${PERSONAL_SKILL_PATHS.browser}`,
      `- Mac apps, Arc if Chrome fails. Computer use when the CLI cannot do the job: ${PERSONAL_SKILL_PATHS.computer}`,
      `- Future agents (schedule a later run): ${PERSONAL_SKILL_PATHS.futureAgents}`,
      `- Celebration site: ${PERSONAL_SKILL_PATHS.celebration}`,
      "File uploads can be stored in the matching JYPE class or project folder.",
      "Math on the website and in the iOS app is a display block, with a blank line before and after. Put $$ on its own line, then LaTeX, then $$ on its own line. Stack equations one per line in that block. Use \\(x\\) or $x^2$ only for a symbol inside a sentence. Never backticks for math. iMessage and Teams cannot render KaTeX, so those replies stay plain words.",
    ].join("\n");
  }
  return [
    "You are the Personal Agent for yanylevin.com (iOS Chat tab person icon / /education chat) and Cursor Desktop on this Mac.",
    "The /education website is still the school dashboard. You are a personal agent that can manage that dashboard when asked, plus mail, news, location, and anything else the user asks.",
    `Signed-in user email: ${email}`,
    "Yan: full write in this repo and on this Mac. Do not refuse repo-wide or Mac-wide work. Class files go on OneDrive (education-dashboard skill), never under education/you@example.com/ except .chat-uploads staging. An existing Word, Excel, or PowerPoint file is edited in that app with computer use. Do not rewrite its bytes.",
    "Code outside education-sync must be committed and pushed to origin/main before the turn ends. Commit only files from this turn. Sync covers education/<email>/, education/projects/jype/, fitness/<email>/, data/chat-log.md, data/login-log.md, tmp/. Never commit server/.env.",
    "Never spawn a Cursor cloud agent. Never edit main-site chatbot.js / /api/chat / LM Studio unless Yan explicitly asks.",
    FUTURE_AGENT_HINT,
    "Never mention the surprise hoodies to Alex, or in any chat he can see, including this one, until Yan says he has been given his. Yan, 2026-10-09.",
    "education/tests/ is a private guide, including calc Yan took last year that Alex is taking now. Change the numbers before Alex sees a problem. Never put an original question in Teams. The school can read Teams. In Teams, do not say a scan or last year's test exists. Yan, 2026-10-15.",
    "A chat PDF is homework or a finished MA/QA scan. Homework goes on the existing todo. A new todo is rare. An MA/QA scan goes on the earlier MA or QA todo for that test, named like the Canvas title with MA or QA kept, plus a copy in education/tests under that class. Do not make a new todo due today to hold the scan. Yan, 2026-10-19.",
    "Yan's course percent, letter, and assignment scores do not go to Example Friend, Example Neighbor, or anyone at their rank or below. That includes the JYPE group and any chat they can see. Alex can still get them in a 1:1. Do not repeat a grade that already leaked. Yan, 2026-10-21.",
    "",
    `Always Read and apply the unslop skill (${UNSLOP_SKILL_PATH}) on every turn. Do not skip it. Do not inline the whole skill here.`,
    `Always Read ${PERSONAL_SKILL_PATHS.soul} for persona and judgment. Do not skip it. Do not inline it.`,
    `When this turn names a person (given name, nickname, or alias), pull the entity card: node server/brain-entity-card.js "<name or slug>" (fields, edges, typed files, recent timeline in one call), guided by ${PERSONAL_SKILL_PATHS.people}. Aliases live on the card. Do not guess who they are, and do not glob brain/people/.`,
    `Unknown shorthand: node server/brain-glossary.js "<term>". New slang this turn: node server/brain-glossary.js add --term "..." --gloss "..." before the turn ends. Person nicknames stay on the person card.`,
    `When Yan states a fact or correction about a person or entity, write it the same turn per ${PERSONAL_SKILL_PATHS.people}: dated timeline entry or frontmatter field on that entity. Do not also copy the person fact onto identity.md. Identity people lines are name, role, and a people/slug pointer. Facts about Yan himself go to education/you@example.com/brain/identity.md (map) or identity-school.md / identity-accounts.md / identity-logistics.md or threads/. Rewrite a standing line. Do not wait for the nightly job.`,
    "Do not preload other skills. Read only the file this turn needs:",
    `- Identity / permissions / reply style: ${PERSONAL_SKILL_PATHS.agent}`,
    `- Education dashboard (classes, todos, dates, projects, school attachments): ${PERSONAL_SKILL_PATHS.education}`,
    `- Debate / case building: ${PERSONAL_SKILL_PATHS.debate}`,
    `- Class schedule: ${PERSONAL_SKILL_PATHS.schedule}`,
    `- EPS student IDs / school photos: ${FOUR11_SKILL_PATH}`,
    `- Past chats: ${PERSONAL_SKILL_PATHS.chats}`,
    `- Chat widgets (map / html / image fences): ${PERSONAL_SKILL_PATHS.widgets}`,
    isJypeAccessEmail(email)
      ? `- Click-through / login pages (skip static fetch): ${PERSONAL_SKILL_PATHS.browser}`
      : "",
    `- Mac apps, Arc if Chrome fails. Computer use when the CLI cannot do the job: ${PERSONAL_SKILL_PATHS.computer}`,
    `- Yan Mail.app search and send: ${PERSONAL_SKILL_PATHS.mail}`,
    `- School Outlook (owner@school.example) via school-mail.js: ${PERSONAL_SKILL_PATHS.schoolMail}`,
    `- School OneNote (on demand only): ${PERSONAL_SKILL_PATHS.schoolOnenote}`,
    `- School Teams (owner@school.example) via school-teams.js: ${PERSONAL_SKILL_PATHS.schoolTeams}`,
    `- Phone location: ${PERSONAL_SKILL_PATHS.location}`,
    `- Life state (what Yan is doing now or at a past time): ${PERSONAL_SKILL_PATHS.lifeState}`,
    `- Apple Calendar: ${PERSONAL_SKILL_PATHS.calendar}`,
    `- Apple Home: ${PERSONAL_SKILL_PATHS.home}`,
    `- Canvas: ${PERSONAL_SKILL_PATHS.canvas}`,
    `- Yan iMessage search and send: ${PERSONAL_SKILL_PATHS.imessage}`,
    `- Yan WhatsApp search and send: ${PERSONAL_SKILL_PATHS.whatsapp}`,
    `- Screen Time: ${PERSONAL_SKILL_PATHS.screentime}`,
    `- Contacts: ${PERSONAL_SKILL_PATHS.contacts}`,
    `- Daily Briefing compile / news sources / thumbs: ${PERSONAL_SKILL_PATHS.news}`,
    `- Fitness / gym: ${PERSONAL_SKILL_PATHS.fitness}`,
    `- Future agents (schedule a later run): ${PERSONAL_SKILL_PATHS.futureAgents}`,
    `- Celebration site: ${PERSONAL_SKILL_PATHS.celebration}`,
    `- Memories / brain: ${PERSONAL_SKILL_PATHS.brain}`,
    "",
    "Live context below is authoritative for clock, class-now, and the open screen. Trust it. Named-people lookup still opens brain/people/. Other education/<email>/ files only when the question needs that data.",
    "",
    "Reply: short. School mutations 1-3 lines. Markdown OK in the text bubble; never HTML tags or markdown images. Never em dashes. No thinking aloud. Do not tell the user to refresh. Read the widgets skill before emitting any widget fence. Never put Sent by Yan's Personal Agent in app or website bubbles; that footer is only for iMessage, WhatsApp, email, and Teams.",
    "Math on the website and in the iOS app is a display block, with a blank line before and after. Put $$ on its own line, then LaTeX, then $$ on its own line. Stack equations one per line in that block. Use \\(x\\) or $x^2$ only for a symbol inside a sentence. Never backticks for math. iMessage, WhatsApp, and Teams cannot render KaTeX, so those replies stay plain words.",
    "Send to a person with no channel named: iMessage, then Teams, then email. Named channel (on Teams / iMessage / email) wins for text. iMessage files are native attachments (iMessage skill), never a URL stand-in. Each file is its own message, then the text. school-teams.js cannot attach a file. Send that file in the Teams app with computer use. A message with images has no pixels. Open that chat in the Teams app and look. School Outlook still cannot send.",
    "Long work: send_chat_message first with a short status. Send more mid-run when new info, a change, or a useful update appears. Then a final Done. Quick answers: one reply only (that is the end of turn). On an iMessage, WhatsApp, or Teams @agent or @agentg first turn, that first status is also posted to the chat before you start the work.",
    "To show one education page on web/iOS, call open_education_page (education-dashboard skill). The jump happens once when this turn ends, not when you call the tool. Last call in the turn wins. Skip if already on that page. Not on Cursor Desktop.",
    "No period when the reply is one word, one phrase, or one sentence.",
  ].join("\n");
}

/**
 * Sanitize optional client UI context (web route / iOS client tag).
 * @param {unknown} raw
 */
function normalizeUiContext(raw) {
  if (!raw || typeof raw !== "object") return null;
  const src = /** @type {Record<string, unknown>} */ (raw);
  /** @type {Record<string, unknown>} */
  const out = {};
  const str = (key, max = 200) => {
    if (src[key] == null) return;
    const v = String(src[key]).trim();
    if (v) out[key] = v.slice(0, max);
  };
  str("client", 40);
  str("path", 300);
  str("view", 40);
  str("workspace", 16);
  str("classId", 120);
  str("className", 160);
  str("period", 8);
  str("projectId", 120);
  str("projectName", 160);
  str("todoId", 200);
  str("todoName", 200);
  str("tag", 8);
  str("dateId", 200);
  str("dateName", 200);
  str("date", 32);
  str("capsuleId", 120);
  str("capsuleTitle", 240);
  str("capsuleCategory", 40);
  str("capsuleBody", 4000);
  str("capsuleCitations", 2500);
  str("title", 200);
  if (typeof src.done === "boolean") out.done = src.done;
  if (typeof src.freePeriod === "boolean") out.freePeriod = src.freePeriod;
  const phoneLocation = parseLocationPayload(src.phoneLocation);
  if (phoneLocation) out.phoneLocation = phoneLocation;
  return Object.keys(out).length ? out : null;
}

/**
 * @param {object|null} nowContext
 * @param {Record<string, unknown>|null} uiContext
 * @param {string} [appendix]
 */
export function formatLiveContextBlock(nowContext, uiContext, appendix = "") {
  /** @type {string[]} */
  const lines = ["Live context (authoritative for this turn — use fully):"];

  if (nowContext) {
    lines.push(
      `Schedule clock: ${nowContext.dateKey} ${nowContext.localTime} (${nowContext.timezone}).`,
      `School day today: ${nowContext.isSchoolDay ? "yes" : "no"}.`,
      "Classes are in person. Say in a class, never class meeting."
    );
    if (nowContext.inClass && nowContext.currentClass) {
      const c = nowContext.currentClass;
      lines.push(
        `IN CLASS NOW: ${c.name} (period ${c.period}, ${c.start}–${c.end}, id ${c.classId}). Default new work to this class unless the user says otherwise.`
      );
    } else if (nowContext.inFreePeriod && nowContext.currentClass) {
      const c = nowContext.currentClass;
      lines.push(
        `IN FREE PERIOD NOW: period ${c.period} (${c.start}–${c.end}, id ${c.classId}).`
      );
    } else if (nowContext.currentClass) {
      const c = nowContext.currentClass;
      lines.push(
        `HEADING TO CLASS: ${c.name} (period ${c.period}, ${c.start}–${c.end}, id ${c.classId}). Not in the room yet.`
      );
    } else {
      lines.push("Not currently in a class.");
      if (nowContext.nextClass) {
        const n = nowContext.nextClass;
        lines.push(
          `Next today: ${n.name} period ${n.period} at ${n.start} (id ${n.classId}).`
        );
      }
      if (nowContext.previousClass) {
        const p = nowContext.previousClass;
        lines.push(
          `Previous today: ${p.name} period ${p.period} ended ${p.end} (id ${p.classId}).`
        );
      }
    }
    lines.push(
      `The rest of today and the weekly schedule are not in this prompt. Read ${PERSONAL_SKILL_PATHS.schedule} when you need another class or the week.`
    );
  } else {
    lines.push(
      `Schedule clock unavailable — Read ${PERSONAL_SKILL_PATHS.schedule} if you need bells or today's classes.`
    );
  }

  if (uiContext) {
    lines.push("Client page / screen:");
    const view = String(uiContext.view || "");
    const client = String(uiContext.client || "unknown");
    lines.push(`- client: ${client}`);
    if (uiContext.path) lines.push(`- path: ${uiContext.path}`);
    if (view === "home") {
      lines.push("- Viewing Education home (TODO / Classes / Dates / Projects panels).");
    } else if (view === "class") {
      lines.push(
        `- Viewing expanded CLASS: ${uiContext.className || uiContext.classId || "?"}` +
          (uiContext.period ? ` (period ${uiContext.period})` : "") +
          (uiContext.classId ? ` [id ${uiContext.classId}]` : "")
      );
      lines.push(
        "- Prefer this class for creates/edits unless the user clearly means another."
      );
    } else if (view === "project") {
      lines.push(
        `- Viewing expanded PROJECT: ${uiContext.projectName || uiContext.projectId || "?"}` +
          (uiContext.projectId ? ` [id ${uiContext.projectId}]` : "")
      );
      lines.push(
        "- Prefer this project for creates/edits unless the user clearly means another. Projects are not schedule classes (no period / no school time)."
      );
    } else if (view === "todo") {
      lines.push(
        `- Viewing TODO/assignment detail: ${uiContext.todoName || uiContext.todoId || "?"}` +
          (uiContext.tag ? ` [${uiContext.tag}]` : "") +
          (uiContext.done === true
            ? " (done)"
            : uiContext.done === false
              ? " (open)"
              : "")
      );
      if (uiContext.projectId || uiContext.projectName) {
        lines.push(
          `- Parent project: ${uiContext.projectName || ""}${uiContext.projectId ? ` [id ${uiContext.projectId}]` : ""}`.trim()
        );
      } else if (uiContext.classId || uiContext.className) {
        lines.push(
          `- Parent class: ${uiContext.className || ""}${uiContext.classId ? ` [id ${uiContext.classId}]` : ""}`.trim()
        );
      } else {
        lines.push("- Parent: user-level (no class / project).");
      }
      if (uiContext.todoId) lines.push(`- todoId: ${uiContext.todoId}`);
      lines.push(
        "- Prefer this todo as the edit target unless the user names another."
      );
    } else if (view === "capsule") {
      lines.push(
        `- Viewing Daily Briefing news story: ${uiContext.capsuleTitle || uiContext.capsuleId || "?"}`
      );
      if (uiContext.capsuleId) lines.push(`- capsuleId: ${uiContext.capsuleId}`);
      if (uiContext.todoId) {
        lines.push(
          `- Parent briefing todo: ${uiContext.todoName || ""} [id ${uiContext.todoId}]`.trim()
        );
      }
      if (uiContext.capsuleCategory) {
        lines.push(`- Category: ${uiContext.capsuleCategory}`);
      }
      if (uiContext.capsuleBody) {
        lines.push("- Story (full text on screen; you already have it):");
        lines.push(String(uiContext.capsuleBody));
      }
      if (uiContext.capsuleCitations) {
        lines.push("- Citations for this story:");
        lines.push(String(uiContext.capsuleCitations));
      }
      lines.push(
        "- This is the story the user is looking at. Answer follow-ups from this text. Web search is OK for more detail. Do not ask them to paste it."
      );
    } else if (view === "date") {
      lines.push(
        `- Viewing important DATE detail: ${uiContext.dateName || uiContext.dateId || "?"}` +
          (uiContext.date ? ` on ${uiContext.date}` : "")
      );
      if (uiContext.projectId || uiContext.projectName) {
        lines.push(
          `- Parent project: ${uiContext.projectName || ""}${uiContext.projectId ? ` [id ${uiContext.projectId}]` : ""}`.trim()
        );
      } else if (uiContext.classId || uiContext.className) {
        lines.push(
          `- Parent class: ${uiContext.className || ""}${uiContext.classId ? ` [id ${uiContext.classId}]` : ""}`.trim()
        );
      }
      if (uiContext.dateId) lines.push(`- dateId: ${uiContext.dateId}`);
    } else if (view) {
      lines.push(`- view: ${view}`);
    }
    if (uiContext.title && !view) lines.push(`- title: ${uiContext.title}`);
    if (EDUCATION_VIEWS.has(view)) {
      lines.push(
        `- Before creating or editing dashboard objects, Read ${PERSONAL_SKILL_PATHS.education}.`
      );
      lines.push(
        `- Class schedule: Read ${PERSONAL_SKILL_PATHS.schedule} if you need it.`
      );
    }
    if (view === "capsule") {
      lines.push(
        `- News source / thumbs rules: Read ${PERSONAL_SKILL_PATHS.news} if you need them.`
      );
    }
  }

  const extra = String(appendix || "").trim();
  if (extra) {
    lines.push("", extra);
  }

  return lines.join("\n");
}

/**
 * Yan-only Calendar + Canvas live lines.
 * @param {string} email
 * @param {string} [timeZone]
 */
export async function buildYanLiveAppendix(email, timeZone) {
  if (!isFullAccessEmail(email)) return "";
  /** @type {string[]} */
  const lines = [];
  try {
    const cal = await formatCalendarLiveLines({
      timeZone: timeZone || "America/Los_Angeles",
    });
    if (Array.isArray(cal) && cal.length) lines.push(...cal);
  } catch (err) {
    console.error("[personal-agent] calendar live", err);
  }
  try {
    const canvas = await formatCanvasLiveLine();
    if (canvas) lines.push(canvas);
  } catch (err) {
    console.error("[personal-agent] canvas live", err);
  }
  return lines.join("\n");
}

/**
 * @param {string} name
 */
function sanitizeFilename(name) {
  const base = basename(String(name || "file").replace(/\\/g, "/"));
  const cleaned = base
    .replace(/[^\w.\- ()[\]]+/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || "file";
}

/**
 * @param {string} mimeType
 * @param {string} filename
 */
function guessMime(mimeType, filename) {
  const mt = String(mimeType || "")
    .trim()
    .toLowerCase();
  if (mt && mt !== "application/octet-stream") return mt;
  const ext = extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".pdf") return "application/pdf";
  return mt || "application/octet-stream";
}

/**
 * @param {unknown} raw
 * @returns {AttachmentInput[]}
 */
function normalizeAttachments(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  if (raw.length > MAX_ATTACHMENTS) {
    const err = new Error(`at most ${MAX_ATTACHMENTS} attachments`);
    err.status = 400;
    throw err;
  }
  /** @type {AttachmentInput[]} */
  const out = [];
  let total = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const name = sanitizeFilename(
      /** @type {{ name?: string, filename?: string }} */ (item).name ||
        /** @type {{ filename?: string }} */ (item).filename ||
        "file"
    );
    const dataRaw = String(
      /** @type {{ data?: string, content?: string }} */ (item).data ||
        /** @type {{ content?: string }} */ (item).content ||
        ""
    ).trim();
    if (!dataRaw) {
      const err = new Error(`attachment ${name} missing data`);
      err.status = 400;
      throw err;
    }
    // Allow data-URL prefix
    const b64 = dataRaw.includes(",")
      ? dataRaw.slice(dataRaw.indexOf(",") + 1)
      : dataRaw;
    let buf;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      const err = new Error(`attachment ${name} is not valid base64`);
      err.status = 400;
      throw err;
    }
    if (!buf.length) {
      const err = new Error(`attachment ${name} is empty`);
      err.status = 400;
      throw err;
    }
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      const err = new Error(
        `attachment ${name} exceeds ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB`
      );
      err.status = 400;
      throw err;
    }
    total += buf.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      const err = new Error(
        `attachments total size exceeds ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024))}MB`
      );
      err.status = 400;
      throw err;
    }
    const mimeType = guessMime(
      /** @type {{ mimeType?: string, type?: string }} */ (item).mimeType ||
        /** @type {{ type?: string }} */ (item).type ||
        "",
      name
    );
    out.push({
      name,
      mimeType,
      data: buf.toString("base64"),
      // keep buffer via closure for write — re-decode below is fine
    });
    // stash bytes on object for write step
    /** @type {any} */ (out[out.length - 1])._buf = buf;
  }
  return out;
}

/**
 * Stage new attachments into the session upload dir (kept until session ends).
 * @param {Session} session
 * @param {string} sessionId
 * @param {AttachmentInput[]} attachments
 * @returns {Promise<StagedFile[]>} newly staged files only
 */
async function stageAttachments(session, sessionId, attachments) {
  if (!attachments.length) return [];

  if (!session.uploadDirRel) {
    session.uploadDirRel = `education/${session.email}/.chat-uploads/${sessionId}`;
  }
  const dirRel = session.uploadDirRel;
  const dirAbs = join(REPO_ROOT, dirRel);
  await mkdir(dirAbs, { recursive: true });

  if (!Array.isArray(session.uploads)) session.uploads = [];

  /** @type {StagedFile[]} */
  const files = [];
  const usedNames = new Set(
    session.uploads.map((f) => f.name.toLowerCase())
  );

  for (const att of attachments) {
    let name = att.name;
    if (usedNames.has(name.toLowerCase())) {
      const stem = name.replace(/(\.[^.]+)?$/, "");
      const ext = extname(name);
      let n = 2;
      while (usedNames.has(`${stem}-${n}${ext}`.toLowerCase())) n += 1;
      name = `${stem}-${n}${ext}`;
    }
    usedNames.add(name.toLowerCase());
    const buf =
      /** @type {any} */ (att)._buf || Buffer.from(att.data, "base64");
    const absPath = join(dirAbs, name);
    await writeFile(absPath, buf);
    const mimeType = guessMime(att.mimeType || "", name);
    /** @type {StagedFile} */
    const staged = {
      name,
      mimeType,
      relPath: `${dirRel}/${name}`,
      absPath,
      bytes: buf.length,
      isImage: IMAGE_MIME.has(mimeType),
    };
    files.push(staged);
    session.uploads.push(staged);
  }

  return files;
}

function guestAgentCreateOpts(guest) {
  const run = guestRunModels(guest);
  if (!run.preferred) return {};
  return {
    model: run.preferred,
    fallbackModel: run.fallback || AUTO_MODEL_SELECTION,
  };
}

/** @agent iMessage/Teams first turn. JYPE Teams group is Composer 2.5. @agentg is Grok. */
function mentionAgentCreateOpts(guest, workspace, platform, forceGrok) {
  if (forceGrok) {
    return guestAgentCreateOpts({
      ...(guest && typeof guest === "object" ? guest : {}),
      model: copyModelSpec(GUEST_GROK_SPEC),
    });
  }
  if (workspace === "jype") {
    return guestAgentCreateOpts({
      ...(guest && typeof guest === "object" ? guest : {}),
      model: jypeMentionModelSpec(platform),
    });
  }
  if (guest) return guestAgentCreateOpts(guest);
  return {
    model: withoutFast(DEFAULT_MODEL_SPEC),
    fallbackModel: AUTO_MODEL_SELECTION,
  };
}

export function guestTurnModelSpec(session, hasSessionFiles) {
  if (session.forceGrok) return copyModelSpec(GUEST_GROK_SPEC);
  const mentionFirstTurn =
    Boolean(session.imessageDeliverFinal) ||
    Boolean(session.teamsDeliverFinal) ||
    Boolean(session.whatsappDeliverFinal);
  if (
    mentionFirstTurn &&
    session.teamsDeliverFinal &&
    sessionWorkspace(session) === "jype"
  ) {
    return jypeMentionModelSpec("teams");
  }
  if (mentionFirstTurn) {
    const run = guestRunModels(session.guestCaller);
    if (run.preferred) return run.preferred;
    return withoutFast(
      hasSessionFiles ? ATTACHMENT_MODEL_SPEC : DEFAULT_MODEL_SPEC
    );
  }
  return hasSessionFiles ? ATTACHMENT_MODEL_SPEC : DEFAULT_MODEL_SPEC;
}

function guestTurnFallback(session) {
  return guestRunModels(session.guestCaller).fallback || AUTO_MODEL_SELECTION;
}

/**
 * @returns {Promise<any>}
 */
async function createPersonalCursorAgent(opts = {}) {
  await reloadCursorApiKeyFromEnv();
  const apiKey = requireKey();
  const preferred = opts.model || DEFAULT_MODEL_SPEC;
  const fallback = opts.fallbackModel || AUTO_MODEL_SELECTION;
  const model = await resolveModelSelection(apiKey, preferred);

  /** @type {any} */
  let agent = null;
  const outcome = await runWithModelFallback({
    prefix: "personal-agent-create",
    preferredModel: model,
    delaysMs: INTERACTIVE_MODEL_DELAYS_MS,
    fallbackModel: fallback,
    fallbackDelaysMs: INTERACTIVE_FALLBACK_DELAYS_MS,
    laterDelaysMs: [],
    run: async (currentModel) => {
      agent = await createLocalCursorAgent({
        model: currentModel,
        cwd: REPO_ROOT,
      });
      return { status: "finished", result: "ok" };
    },
  });
  if (!agent) {
    const err = new Error("failed to create personal agent");
    err.status = 503;
    throw err;
  }
  if (outcome.usedFallback) {
    console.warn(
      `[personal-agent] created session on ${outcome.model?.id || "auto"} after preferred create failed`
    );
  }
  return agent;
}

/**
 * @param {string} email
 */
export async function startAgent(email, opts = {}) {
  const workspace = normalizeJypeWorkspace(opts.workspace);
  const normalized = canonicalizeEmail(email);
  if (!canUseAgent(normalized, workspace)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }

  const createOpts =
    workspace === "jype"
      ? { ...opts, model: opts.model || copyModelSpec(DEFAULT_MODEL_SPEC) }
      : opts;
  const agent = await createPersonalCursorAgent(createOpts);

  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `pa-${Date.now().toString(36)}`;

  const key = focusKey(normalized, workspace);
  // Switch focus. Running / queued threads keep working in the background.
  const priorId = activeByEmail.get(key);
  if (priorId && priorId !== id) {
    await releaseFocusFrom(priorId);
  }

  const starter = resolveChatStarter({
    workspace,
    email: normalized,
    starter: opts.starter,
    guest: opts.guest || opts.guestCaller,
  });
  const uploadRoot =
    workspace === "jype"
      ? `education/projects/jype/.chat-uploads/${id}`
      : `education/${normalized}/.chat-uploads/${id}`;

  sessions.set(id, {
    agent,
    email: normalized,
    workspace,
    starter,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    uploads: [],
    uploadDirRel: uploadRoot,
    messages: [],
    status: "idle",
    workingLabel: null,
    runPromise: null,
    turnQueue: [],
    imessageOrigin: null,
    imessageDeliverFinal: false,
    teamsOrigin: null,
    teamsDeliverFinal: false,
    whatsappOrigin: null,
    whatsappDeliverFinal: false,
    guestCaller: null,
    ephemeralPinned: workspace === "jype",
  });
  activeByEmail.set(key, id);

  return { sessionId: id, email: normalized, status: "idle", messages: [], workspace };
}

/**
 * New Personal Agent thread whose first user message is an iMessage that
 * mentioned @agent. Listed in the app/website for 10 minutes after the
 * reply finishes, then dropped unless Yan continues from web or iOS.
 * @param {object} message
 */
export async function startAgentFromIMessageMention(message) {
  const origin = normalizeIMessageOrigin(message);
  const raw = String(origin?.text || message?.text || "").trim();
  const guest = message?.guestCaller || null;
  const text = guest
    ? formatGuestUserBubble({
        name: guest.displayName,
        platform: platformLabel("imessage"),
        text: raw,
      })
    : raw;
  if (!origin || !text) {
    const err = new Error("imessage @agent text required");
    err.status = 400;
    throw err;
  }
  const workspace = originIsJypeThread(origin) ? "jype" : "";
  const forceGrok = messageForcesGrok(raw);
  const startEmail =
    workspace === "jype"
      ? jypeEmailForSlug(guest?.slug) || YAN_EMAIL
      : YAN_EMAIL;
  const createOpts = mentionAgentCreateOpts(guest, workspace, "imessage", forceGrok);
  const started = await startAgent(startEmail, {
    ...createOpts,
    workspace,
    guest,
  });
  const session = sessions.get(started.sessionId);
  if (!session) {
    const err = new Error("session not found");
    err.status = 500;
    throw err;
  }
  session.imessageOrigin = origin;
  session.imessageDeliverFinal = true;
  session.guestCaller = guest;
  session.forceGrok = forceGrok;
  return messageAgent(started.sessionId, startEmail, text, [], {
    client: "imessage",
    workspace,
  });
}

/**
 * New Personal Agent thread whose first user message is a Teams chat that
 * mentioned @agent. Same 10-minute UI hide as iMessage @agent unless Yan
 * continues from web or iOS.
 * @param {object} message
 */
export async function startAgentFromTeamsMention(message) {
  const origin = normalizeTeamsOrigin(message);
  const raw = String(origin?.text || message?.text || "").trim();
  const guest = message?.guestCaller || null;
  const text = guest
    ? formatGuestUserBubble({
        name: guest.displayName,
        platform: platformLabel("teams"),
        text: raw,
      })
    : raw;
  if (!origin || !text) {
    const err = new Error("teams @agent text required");
    err.status = 400;
    throw err;
  }
  const workspace = originIsJypeThread(origin) ? "jype" : "";
  const forceGrok = messageForcesGrok(raw);
  const startEmail =
    workspace === "jype"
      ? jypeEmailForSlug(guest?.slug) || YAN_EMAIL
      : YAN_EMAIL;
  const createOpts = mentionAgentCreateOpts(guest, workspace, "teams", forceGrok);
  const started = await startAgent(startEmail, {
    ...createOpts,
    workspace,
    guest,
  });
  const session = sessions.get(started.sessionId);
  if (!session) {
    const err = new Error("session not found");
    err.status = 500;
    throw err;
  }
  session.teamsOrigin = origin;
  session.teamsDeliverFinal = true;
  session.guestCaller = guest;
  session.forceGrok = forceGrok;
  return messageAgent(started.sessionId, startEmail, text, [], {
    client: "teams",
    workspace,
  });
}

/**
 * New Personal Agent thread from a WhatsApp @agent / @agentg.
 * Same 10-minute UI hide as iMessage unless Yan continues from web or iOS.
 * @param {object} message
 */
export async function startAgentFromWhatsAppMention(message) {
  if (!WHATSAPP_AGENT_ENABLED) return { ok: false, skipped: "disabled" };
  const origin = normalizeWhatsAppOrigin(message);
  const raw = String(origin?.text || message?.text || "").trim();
  const guest = message?.guestCaller || null;
  const text = guest
    ? formatGuestUserBubble({
        name: guest.displayName,
        platform: platformLabel("whatsapp"),
        text: raw,
      })
    : raw;
  if (!origin || !text) {
    const err = new Error("whatsapp @agent text required");
    err.status = 400;
    throw err;
  }
  const workspace =
    originIsJypeThread(origin) || guest?.workspace === "jype" ? "jype" : "";
  const forceGrok = messageForcesGrok(raw) || guest?.forceGrok === true;
  const startEmail =
    workspace === "jype"
      ? jypeEmailForSlug(guest?.slug) || YAN_EMAIL
      : YAN_EMAIL;
  const createOpts = mentionAgentCreateOpts(
    guest,
    workspace,
    "whatsapp",
    forceGrok
  );
  const started = await startAgent(startEmail, {
    ...createOpts,
    workspace,
    guest,
  });
  const session = sessions.get(started.sessionId);
  if (!session) {
    const err = new Error("session not found");
    err.status = 500;
    throw err;
  }
  session.whatsappOrigin = origin;
  session.whatsappDeliverFinal = true;
  session.guestCaller = guest;
  session.forceGrok = forceGrok;
  return messageAgent(started.sessionId, startEmail, text, [], {
    client: "whatsapp",
    workspace,
  });
}

/**
 * List this user's persisted threads. Enqueues untitled files for titles.
 * @param {string} email
 */
export async function listAgentChats(email, opts = {}) {
  const workspace = normalizeJypeWorkspace(opts.workspace);
  const normalized = canonicalizeEmail(email);
  if (!canUseAgent(normalized, workspace)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  const workingIds = new Set();
  for (const [sid, session] of sessions) {
    if (!sessionHasBackgroundWork(session)) continue;
    if (workspace === "jype") {
      if (sessionWorkspace(session) === "jype") workingIds.add(sid);
      continue;
    }
    if (session?.email === normalized && sessionWorkspace(session) !== "jype") {
      workingIds.add(sid);
    }
  }
  const chats = await listChatHistory({
    email: normalized,
    workingIds,
    workspace,
  });
  for (const row of chats) {
    if (
      row?.sessionId &&
      (!row.title || isStubChatTitle(row.title, row.preview))
    ) {
      enqueueChatTitle({
        email: normalized,
        sessionId: row.sessionId,
        workspace,
      });
    }
  }
  return {
    ok: true,
    sessionId: activeByEmail.get(focusKey(normalized, workspace)) || null,
    workspace,
    chats: applyChatWorkingStatus(chats, workingIds),
  };
}

/**
 * Mark a thread as read for the history unread dot.
 * @param {unknown} sessionId
 * @param {string} email
 */
export async function markAgentChatRead(sessionId, email, opts = {}) {
  const workspace = normalizeJypeWorkspace(opts.workspace);
  const normalized = canonicalizeEmail(email);
  if (!canUseAgent(normalized, workspace)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  const sid = sanitizeSessionId(sessionId);
  if (!sid) {
    const err = new Error("sessionId required");
    err.status = 400;
    throw err;
  }
  const lastRead = await markChatHistoryRead({
    email: normalized,
    sessionId: sid,
    workspace,
  });
  notifyEducationClients(normalized, "change", {
    source: "agent",
    sessionId: sid,
    status: "read",
    ...(workspace ? { workspace } : {}),
  });
  return { ok: true, sessionId: sid, lastRead };
}

/**
 * Hydrate a persisted thread as the live session so the user can continue it.
 * @param {string} sessionId
 * @param {string} email
 */
export async function resumeAgent(sessionId, email, opts = {}) {
  const workspace = normalizeJypeWorkspace(opts.workspace);
  const normalized = canonicalizeEmail(email);
  if (!canUseAgent(normalized, workspace)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  const sid = sanitizeSessionId(sessionId);
  if (!sid) {
    const err = new Error("sessionId required");
    err.status = 400;
    throw err;
  }

  const live = sessions.get(sid);
  if (live) {
    if (!canAccessSession(live, normalized)) {
      const err = new Error("forbidden");
      err.status = 403;
      throw err;
    }
    live.lastUsedAt = Date.now();
    activeByEmail.set(focusKey(normalized, workspace || sessionWorkspace(live)), sid);
    if (!live.messages?.length) {
      /* empty live session */
    }
    await markChatHistoryRead({
      email: normalized,
      sessionId: sid,
      workspace: workspace || sessionWorkspace(live),
    });
    enqueueChatTitle({
      email: normalized,
      sessionId: sid,
      workspace: workspace || sessionWorkspace(live),
    });
    notifyEducationClients(normalized, "change", {
      source: "agent",
      sessionId: sid,
      status: live.status || "idle",
      ...(workspace || sessionWorkspace(live)
        ? { workspace: workspace || sessionWorkspace(live) }
        : {}),
    });
    return {
      ok: true,
      sessionId: sid,
      status: live.status || "idle",
      messages: snapshotMessages(live),
      queueLength: queuedTurnCount(live),
    };
  }

  const loaded = await loadChatHistory({
    email: normalized,
    sessionId: sid,
    workspace,
  });
  if (!loaded) {
    const err = new Error("session not found");
    err.status = 404;
    throw err;
  }

  const priorId = activeByEmail.get(focusKey(normalized, workspace));
  if (priorId && priorId !== sid) {
    await releaseFocusFrom(priorId);
  }

  const agent = await createPersonalCursorAgent(
    workspace === "jype" ? { model: copyModelSpec(DEFAULT_MODEL_SPEC) } : {}
  );
  /** @type {ChatMessage[]} */
  const messages = (loaded.messages || []).map((m) => {
    /** @type {ChatMessage} */
    const row = { role: m.role, content: m.content, at: m.at };
    if (Array.isArray(m.widgets) && m.widgets.length) row.widgets = m.widgets;
    return row;
  });

  const uploadRoot =
    workspace === "jype"
      ? `education/projects/jype/.chat-uploads/${sid}`
      : `education/${normalized}/.chat-uploads/${sid}`;

  sessions.set(sid, {
    agent,
    email: normalized,
    workspace,
    starter: resolveChatStarter({
      workspace,
      email: normalized,
      starter: loaded.starter,
      firstUserMessage: messages.find((m) => m.role === "user")?.content,
    }),
    createdAt: Date.parse(loaded.started) || Date.now(),
    lastUsedAt: Date.now(),
    uploads: [],
    uploadDirRel: uploadRoot,
    messages,
    status: "idle",
    workingLabel: null,
    runPromise: null,
    turnQueue: [],
    replayUiTranscript: true,
    imessageOrigin: null,
    imessageDeliverFinal: false,
    teamsOrigin: null,
    teamsDeliverFinal: false,
    whatsappOrigin: null,
    whatsappDeliverFinal: false,
    guestCaller: null,
    ephemeralPinned: workspace === "jype" ? true : !loaded.ephemeral,
  });
  if (loaded.scheduled) {
    const record = await readFutureAgent(sid);
    const resumed = sessions.get(sid);
    if (record && resumed) attachScheduledToSession(resumed, record);
    else if (resumed) {
      resumed.scheduled = true;
      resumed.scheduledRunAt = loaded.scheduledRunAt || "";
      resumed.scheduledStatus = loaded.scheduledStatus || "pending";
      resumed.forceGrok = true;
      resumed.ephemeralPinned = true;
    }
  }
  activeByEmail.set(focusKey(normalized, workspace), sid);
  await markChatHistoryRead({ email: normalized, sessionId: sid, workspace });
  const firstUser =
    loaded.messages?.find((m) => m.role === "user")?.content ||
    loaded.preview ||
    "";
  if (!loaded.title || isStubChatTitle(loaded.title, firstUser)) {
    enqueueChatTitle({ email: normalized, sessionId: sid, workspace });
  }
  notifyEducationClients(normalized, "change", {
    source: "agent",
    sessionId: sid,
    status: "idle",
    ...(workspace ? { workspace } : {}),
  });
  return {
    ok: true,
    sessionId: sid,
    status: "idle",
    messages: snapshotMessages(sessions.get(sid)),
    queueLength: 0,
  };
}

/**
 * Format the user bubble text (matches web/iOS clients).
 * @param {string} text
 * @param {StagedFile[]} newFiles
 */
function userBubbleLabel(text, newFiles) {
  const files = newFiles || [];
  if (!files.length) return text;
  const tag = `[${files.length} file${files.length === 1 ? "" : "s"}: ${files
    .map((f) => f.name)
    .join(", ")}]`;
  return text ? `${text}\n${tag}` : tag;
}

/**
 * Run Cursor send/wait in the background; mutate session when done.
 * @param {string} sid
 * @param {Session} session
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {{ data: string, mimeType: string }[]} opts.images
 * @param {ModelSelection} opts.model
 * @param {string} opts.normalized
 * @param {object|null} opts.nowContext
 * @param {number} opts.attachmentCount
 * @param {number} opts.sessionAttachmentCount
 */
async function executeAgentTurn(sid, session, opts) {
  const {
    prompt,
    images,
    model,
    normalized,
    nowContext,
    attachmentCount,
    sessionAttachmentCount,
  } = opts;

  session.pendingNavigate = null;
  const usageStartedAt = new Date().toISOString();
  const turnId = mintNavigateId();
  session.activeTurnId = turnId;
  session.channelProgress = channelProgressKind(opts);
  session.lastChannelProgressText = "";

  try {
    /** @type {string[]} */
    const chunks = [];
    const outcome = await runWithModelFallback({
      prefix: "personal-agent",
      preferredModel: model,
      delaysMs: INTERACTIVE_MODEL_DELAYS_MS,
      fallbackModel: guestTurnFallback(session),
      fallbackDelaysMs: INTERACTIVE_FALLBACK_DELAYS_MS,
      laterDelaysMs: [],
      shouldAbort: () =>
        !sessions.has(sid) ||
        sessions.get(sid) !== session ||
        Boolean(session.interrupting),
      onBeforeAttempt: async ({ model: nextModel, recreate, isFallback }) => {
        setSessionWorkingLabel(
          session,
          sid,
          workingLabelForAttempt({
            model: nextModel,
            isFallback,
            recreate,
          })
        );
        if (recreate) {
          await replaceSessionAgent(session, nextModel);
        } else if (!session.agent) {
          session.agent = await createLocalCursorAgent({
            model: nextModel,
            cwd: REPO_ROOT,
          });
          session.replayUiTranscript = true;
        }
      },
      run: async (nextModel) => {
        if (!session.agent) {
          session.agent = await createLocalCursorAgent({
            model: nextModel,
            cwd: REPO_ROOT,
          });
          session.replayUiTranscript = true;
        }
        const sendOpts = {
          model: nextModel,
          local: { customTools: sessionCustomTools(sid, session) },
        };
        const history = session.replayUiTranscript
          ? formatVisibleTranscript(session, opts.bubble)
          : "";
        const text = history ? `${history}\n\n${prompt}` : prompt;
        const sendPayload = images.length > 0 ? { text, images } : text;
        chunks.length = 0;
        const run = await session.agent.send(sendPayload, sendOpts);
        session.activeRun = run;
        if (session.interrupting && typeof run.cancel === "function") {
          await run.cancel().catch(() => {});
        }
        try {
          if (typeof run.stream === "function") {
            for await (const event of run.stream()) {
              if (session.interrupting) break;
              if (event?.type === "assistant" && event.message?.content) {
                for (const block of event.message.content) {
                  if (block?.type === "text" && typeof block.text === "string") {
                    chunks.push(block.text);
                  }
                }
              }
            }
          }
        } catch (err) {
          if (!session.interrupting) {
            console.error("[personal-agent] stream", err);
          }
        }
        if (session.interrupting) {
          const err = new Error("interrupted");
          throw err;
        }
        return run.wait();
      },
    });
    if (outcome.aborted || session.interrupting) {
      session.pendingNavigate = null;
      if (session.interrupting) releaseTurnRun(session);
      return;
    }
    if (!sessions.has(sid) || sessions.get(sid) !== session) return;
    const result = outcome.result;
    const shownPrompt =
      opts.scheduledKickoff && session.futureAgentRecord?.prompt
        ? session.futureAgentRecord.prompt
        : opts.bubble || prompt;
    await logSdkResult({
      person: usagePerson(session),
      kind: usageKind(session, opts),
      threadId: sid,
      prompt: shownPrompt,
      model: outcome.model || model,
      result,
      startedAt: usageStartedAt,
      always: true,
    }).catch((err) => console.error("[usage] turn log failed", err));
    if (outcome.usedFallback) {
      console.warn(
        `[personal-agent] turn used ${outcome.model?.id || "auto"} after grok/auto retries`
      );
    }

    if (opts.scheduledKickoff) {
      session.scheduledStatus = result?.status === "error" ? "failed" : "done";
      session.scheduledKickoff = false;
      if (session.futureAgentRecord) {
        session.futureAgentRecord = {
          ...session.futureAgentRecord,
          status: session.scheduledStatus,
        };
      }
      await markFutureAgentStatus(sid, session.scheduledStatus).catch((err) => {
        console.error("[future-agents] status", err);
      });
    }

    let content =
      result && typeof result.result === "string" ? result.result.trim() : "";
    if (!content) {
      for (let i = chunks.length - 1; i >= 0; i--) {
        const piece = String(chunks[i] || "").trim();
        if (piece) {
          content = piece;
          break;
        }
      }
    }
    if (!content) {
      content =
        result?.status === "error"
          ? PA_ERROR_REPLY
          : EMPTY_TURN_REPLY;
    }

    const parsed = parseAgentReply(content);
    content = stripAgentSentFooter(
      parsed.content || (parsed.widgets.length ? "" : EMPTY_TURN_REPLY)
    );
    if (!content && !parsed.widgets.length) content = EMPTY_TURN_REPLY;
    if (shouldAppendEndOfTurn(session.messages, content, parsed.widgets)) {
      session.messages.push(
        stampMessage("assistant", content, parsed.widgets, { endOfTurn: true })
      );
    } else {
      const last = session.messages[session.messages.length - 1];
      if (last && last.role === "assistant") last.endOfTurn = true;
    }
    await persistSessionHistory(sid, session);
    session.lastUsedAt = Date.now();
    if (String(result?.status || "").toLowerCase() !== "error") {
      session.replayUiTranscript = false;
    }
    const finishedStatus = result?.status === "error" ? "error" : "idle";
    if (finishedStatus === "idle" && !session.interrupting) {
      content = await settleOutboundSend(
        session,
        sid,
        content,
        opts,
        outcome.model || model
      );
    }
    if (session.interrupting) {
      releaseTurnRun(session);
      return;
    }
    releaseTurnRun(session);
    session.lastResult = {
      content,
      widgets: parsed.widgets,
      status: result?.status || "finished",
      model: outcome.model?.id || model.id,
      attachmentCount,
      sessionAttachmentCount,
      nowContext: nowContext
        ? {
            inClass: nowContext.inClass,
            currentClass: nowContext.currentClass,
            dateKey: nowContext.dateKey,
            localTime: nowContext.localTime,
          }
        : null,
    };
    gitAddCommitPush({
      paths: [`education/${normalized}`],
      message: `education: agent update for ${normalized}`,
    }).catch((err) => console.error("[personal-agent] git publish", err));

    if (finishedStatus === "idle") {
      enqueueBrainExtraction({
        email: normalized,
        sessionId: sid,
        userText: opts.bubble,
        assistantText: content,
      });
    }

    if (session.interrupting) return;
    if (!Array.isArray(session.turnQueue)) session.turnQueue = [];
    if (session.interrupting) return;
    if (session.turnQueue.length > 0) {
      const next = session.turnQueue.shift();
      appendPromotedUserMessage(session, next);
      persistSessionHistory(sid, session);
      session.status = "running";
      notifyTurnFinished(session, sid, { status: "running" });
      kickoffTurn(sid, session, next);
    } else {
      session.status = finishedStatus;
      notifyTurnFinished(session, sid, { status: session.status });
    }
  } catch (err) {
    if (
      session.interrupting ||
      (err instanceof Error && err.message === "interrupted")
    ) {
      session.pendingNavigate = null;
      releaseTurnRun(session);
      return;
    }
    console.error("[personal-agent] run", err);
    if (!sessions.has(sid) || sessions.get(sid) !== session) return;
    if (opts.scheduledKickoff) {
      session.scheduledStatus = "failed";
      session.scheduledKickoff = false;
      if (session.futureAgentRecord) {
        session.futureAgentRecord = {
          ...session.futureAgentRecord,
          status: "failed",
        };
      }
      await markFutureAgentStatus(sid, "failed").catch((statusErr) => {
        console.error("[future-agents] status", statusErr);
      });
    }
    const fallback = PA_ERROR_REPLY;
    session.messages.push(
      stampMessage("assistant", fallback, undefined, { endOfTurn: true })
    );
    await persistSessionHistory(sid, session);
    session.lastUsedAt = Date.now();
    releaseTurnRun(session);
    session.lastResult = {
      content: fallback,
      status: "error",
      model: model.id,
      attachmentCount,
      sessionAttachmentCount,
      nowContext: null,
    };

    if (session.interrupting) return;
    if (!Array.isArray(session.turnQueue)) session.turnQueue = [];
    if (session.interrupting) return;
    if (session.turnQueue.length > 0) {
      const next = session.turnQueue.shift();
      appendPromotedUserMessage(session, next);
      persistSessionHistory(sid, session);
      session.status = "running";
      notifyTurnFinished(session, sid, { status: "running" });
      kickoffTurn(sid, session, next);
    } else {
      session.status = "error";
      notifyTurnFinished(session, sid, { status: "error" });
    }
  } finally {
    if (session.activeTurnId === turnId) session.channelProgress = "";
    if (session.status !== "running") {
      let otherRunning = false;
      for (const [id, s] of sessions.entries()) {
        if (id === sid) continue;
        if (s.status === "running") otherRunning = true;
      }
      if (!otherRunning) {
        await closeAgentBrowser().catch(() => {});
      }
    }
  }
}

/**
 * @param {string} sessionId
 * @param {string} email
 * @param {string} message
 * @param {unknown} [attachmentsRaw]
 * @param {unknown} [uiContextRaw]
 * @param {unknown} [interruptRaw]
 */
export async function messageAgent(
  sessionId,
  email,
  message,
  attachmentsRaw,
  uiContextRaw,
  interruptRaw
) {
  const normalized = canonicalizeEmail(email);
  const sid = String(sessionId || "").trim();
  const text = String(message || "").trim();
  const attachments = normalizeAttachments(attachmentsRaw);
  const uiContext = normalizeUiContext(uiContextRaw);
  const wantInterrupt = isTruthyFlag(interruptRaw);
  if (!sid || (!text && !attachments.length)) {
    const err = new Error("sessionId and message or attachments required");
    err.status = 400;
    throw err;
  }

  const session = sessions.get(sid);
  if (!session) {
    const err = new Error("session not found");
    err.status = 404;
    throw err;
  }
  if (!canAccessSession(session, normalized)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }

  pinEphemeralChatIfUiClient(session, uiContext, sid);

  if (!Array.isArray(session.turnQueue)) session.turnQueue = [];
  if (!Array.isArray(session.uploads)) session.uploads = [];
  if (!Array.isArray(session.messages)) session.messages = [];

  // Claim the run slot early so concurrent idle POSTs queue instead of
  // both calling agent.send. Queued turns stay behind status === "running".
  // Hold-to-interrupt cancels the live run and does not use a queue slot.
  let willQueue = false;
  let claimedIdleSlot = false;
  let interrupting = false;
  const mode = resolveIncomingTurnMode(
    session.status,
    wantInterrupt,
    queuedTurnCount(session)
  );
  willQueue = mode.willQueue;
  interrupting = mode.interrupt;
  if (!willQueue && !interrupting) {
    session.status = "running";
    claimedIdleSlot = true;
  }

  // Cancel before the prompt is built. Otherwise the live @agent can deliver
  // while this clarification is still being assembled, or the prompt is
  // written as a later app turn and the chat never gets a reply.
  if (interrupting) {
    session.interrupting = true;
    try {
      await cancelActiveRun(session);
    } finally {
      session.interrupting = false;
    }
    restoreOwedChannelDelivery(session);
  }

  session.lastUsedAt = Date.now();

  let newFiles;
  try {
    newFiles = await stageAttachments(session, sid, attachments);
  } catch (err) {
    if (claimedIdleSlot || interrupting) session.status = "idle";
    throw err;
  }
  const sessionFiles = session.uploads;
  const hasSessionFiles = sessionFiles.length > 0;
  const hasNewAttachments = newFiles.length > 0;
  const isOwner = normalized === "you@example.com";

  let nowContext = null;
  try {
    nowContext = await resolveNowScheduleContext(normalized);
  } catch (err) {
    console.error("[personal-agent] nowContext", err);
  }

  const apiKey = requireKey();
  let model;
  try {
    model = await resolveModelSelection(
      apiKey,
      guestTurnModelSpec(session, hasSessionFiles)
    );
  } catch (err) {
    if (claimedIdleSlot || interrupting) session.status = "idle";
    throw err;
  }

  let promptSystem = systemPrompt(normalized, {
    workspace: sessionWorkspace(session),
  });
  /** @type {string[]} */
  const promptParts = [
    promptSystem,
    "",
    formatLiveContextBlock(
      nowContext,
      uiContext,
      await buildYanLiveAppendix(normalized, nowContext?.timezone)
    ),
  ];
  const imessageBlock = formatIMessageOriginBlock(session.imessageOrigin, {
    deliverFinal: Boolean(session.imessageDeliverFinal),
    guestCaller: session.guestCaller,
  });
  if (imessageBlock) {
    promptParts.push("", imessageBlock);
  }
  const teamsBlock = formatTeamsOriginBlock(session.teamsOrigin, {
    deliverFinal: Boolean(session.teamsDeliverFinal),
    guestCaller: session.guestCaller,
  });
  if (teamsBlock) {
    promptParts.push("", teamsBlock);
  }
  const whatsappBlock = formatWhatsAppOriginBlock(session.whatsappOrigin, {
    deliverFinal: Boolean(session.whatsappDeliverFinal),
    guestCaller: session.guestCaller,
  });
  if (whatsappBlock) {
    promptParts.push("", whatsappBlock);
  }
  const composerSchedule = jypeComposerScheduleLine(model, session.teamsOrigin);
  if (composerSchedule) {
    promptParts.push("", composerSchedule);
  }
  if (session.futureAgentRecord) {
    promptParts.push(
      "",
      formatScheduledSystemBlock(session.futureAgentRecord, { kickoff: false })
    );
  }
  if (interrupting) {
    promptParts.push("", interruptClarificationNote(session.channelReplyOwed));
  }
  promptParts.push("", "User:", text || "(no text — see attachments)");

  if (hasSessionFiles) {
    promptParts.push(
      "",
      hasNewAttachments
        ? "Chat attachments available this session (still on disk, copy from these paths when storing context; earlier files remain usable on later turns):"
        : "Previously attached files still available this session (still on disk, copy from these paths; do not ask the user to re-send):"
    );
    for (const f of sessionFiles) {
      const tag = newFiles.some((n) => n.relPath === f.relPath)
        ? " [new this turn]"
        : " [earlier in this chat]";
      promptParts.push(
        `- ${f.name} (${f.mimeType}, ${f.bytes} bytes)${tag} → ${f.relPath}`
      );
    }
    promptParts.push(
      `When storing long-term dashboard context, Read ${PERSONAL_SKILL_PATHS.education} then copy identical bytes into the matching object folder.`,
      `Yan class files: that class's OneDrive todo/date folder (meta.json onedriveRoot + gradeFolder + onedriveFolder). Do not write class files under education/${normalized}/ except .chat-uploads. A new Word, Excel, or PowerPoint file can be stored. If that Office file already exists, edit it in the app with computer use. Do not store over it. Turn in / submit / upload to Canvas: identify the assignment (Live context first), name the file from the Canvas assignment title (or the todo name if there is no Canvas title; do not use the header printed on the sheet), store, then node --env-file=server/.env server/canvas-files.js submit --canvas-id <id> --file <path>. Save / put this in / handle the file: same store path (node --env-file=server/.env server/canvas-files.js store --src <path> --class <id> --todo "<Finder folder>"), do not submit. Ask only if the assignment is unclear.`
    );
  }

  const prompt = promptParts.join("\n");

  /** @type {{ data: string, mimeType: string }[]} */
  const images = [];
  const imageSources = hasNewAttachments ? newFiles : sessionFiles;
  if (imageSources.length) {
    const { readFile, access } = await import("node:fs/promises");
    const { constants: fsConstants } = await import("node:fs");
    for (const f of imageSources) {
      if (!f.isImage || images.length >= 5) continue;
      try {
        await access(f.absPath, fsConstants.R_OK);
        const diskBuf = await readFile(f.absPath);
        if (diskBuf.length > MAX_GROK_IMAGE_BYTES) continue;
        images.push({
          data: diskBuf.toString("base64"),
          mimeType: f.mimeType === "image/jpg" ? "image/jpeg" : f.mimeType,
        });
      } catch {
        /* skip missing */
      }
    }
  }

  const bubble = userBubbleLabel(text, newFiles) || "(attachment)";
  /** @type {TurnOpts} */
  const turnOpts = {
    prompt,
    images,
    model,
    normalized,
    nowContext,
    attachmentCount: newFiles.length,
    sessionAttachmentCount: sessionFiles.length,
    bubble,
    interrupted: interrupting,
  };
  claimChannelDelivery(session, turnOpts);

  activeByEmail.set(focusKey(normalized, sessionWorkspace(session)), sid);

  if (interrupting) session.status = "running";

  if (willQueue) {
    // Keep queued user bubbles out of session.messages until their turn
    // starts, so assistant replies stay interleaved (u1,a1,u2,a2,…).
    turnOpts.queueId = randomUUID();
    session.turnQueue.push(turnOpts);
    persistSessionHistory(sid, session);
    notifyEducationClients(normalized, "change", {
      source: "agent",
      sessionId: sid,
      status: "running",
      queued: true,
      queueLength: queuedTurnCount(session),
    });
  } else {
    session.messages.push(stampMessage("user", bubble));
    persistSessionHistory(sid, session);
    session.workingLabel = WORKING_LABEL_DEFAULT;
    notifyEducationClients(normalized, "change", {
      source: "agent",
      sessionId: sid,
      status: "running",
      workingLabel: session.workingLabel,
    });
    kickoffTurn(sid, session, turnOpts);
  }

  return {
    ok: true,
    sessionId: sid,
    status: "running",
    queued: willQueue,
    queueLength: queuedTurnCount(session),
    messages: snapshotMessages(session),
    workingLabel: session.workingLabel || null,
    // Keep content null while running — clients poll /agent/state.
    content: null,
    attachmentCount: newFiles.length,
    sessionAttachmentCount: sessionFiles.length,
    nowContext: nowContext
      ? {
          inClass: nowContext.inClass,
          currentClass: nowContext.currentClass,
          dateKey: nowContext.dateKey,
          localTime: nowContext.localTime,
        }
      : null,
  };
}

/**
 * Pull a waiting turn out of the queue and run it now.
 * Cancels the live turn when one is running. Other queued turns stay behind it.
 * @param {string} sessionId
 * @param {string} email
 * @param {unknown} queueIdRaw
 */
export async function promoteQueuedTurn(sessionId, email, queueIdRaw) {
  const normalized = canonicalizeEmail(email);
  const sid = String(sessionId || "").trim();
  const queueId = String(queueIdRaw || "").trim();
  if (!sid || !queueId) {
    const err = new Error("sessionId and queueId required");
    err.status = 400;
    throw err;
  }

  const session = sessions.get(sid);
  if (!session) {
    const err = new Error("session not found");
    err.status = 404;
    throw err;
  }
  if (!canAccessSession(session, normalized)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }

  if (!Array.isArray(session.turnQueue)) session.turnQueue = [];
  const queued = session.turnQueue.some((turn) => turn && turn.queueId === queueId);
  if (!queued) {
    const err = new Error("queued message not found");
    err.status = 404;
    throw err;
  }

  const wasRunning = session.status === "running";
  // Block the live turn's finish path from also shifting the queue.
  if (wasRunning) session.interrupting = true;
  const turn = detachQueuedTurn(session, queueId);
  if (!turn) {
    if (wasRunning) session.interrupting = false;
    const err = new Error("queued message not found");
    err.status = 404;
    throw err;
  }

  if (wasRunning) {
    try {
      await cancelActiveRun(session);
    } finally {
      session.interrupting = false;
    }
    const owed = session.channelReplyOwed || "";
    turn.prompt = rewritePromptForOwedChannel(turn.prompt, owed);
    turn.prompt = withInterruptNote(turn.prompt, owed);
    if (owed) handOffOwedChannel(session, turn);
    turn.interrupted = true;
  }

  session.lastUsedAt = Date.now();
  appendPromotedUserMessage(session, turn);
  persistSessionHistory(sid, session);
  session.workingLabel = WORKING_LABEL_DEFAULT;
  notifyAgentClients(session, normalized, {
    source: "agent",
    sessionId: sid,
    status: "running",
    workingLabel: session.workingLabel,
  });
  kickoffTurn(sid, session, turn);

  return {
    ok: true,
    sessionId: sid,
    status: "running",
    queued: false,
    queueLength: queuedTurnCount(session),
    messages: snapshotMessages(session),
    workingLabel: session.workingLabel || null,
    content: null,
  };
}

/**
 * @param {string} sessionId
 * @param {string} email
 */
export function getAgentState(sessionId, email) {
  const normalized = canonicalizeEmail(email);
  const sid = String(sessionId || "").trim();
  if (!sid) {
    const err = new Error("sessionId required");
    err.status = 400;
    throw err;
  }
  const session = sessions.get(sid);
  if (!session) {
    const err = new Error("session not found");
    err.status = 404;
    throw err;
  }
  if (!canAccessSession(session, normalized)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  session.lastUsedAt = Date.now();
  /** @type {Record<string, unknown>} */
  const out = {
    ok: true,
    sessionId: sid,
    status: session.status || "idle",
    workingLabel:
      session.status === "running" ? session.workingLabel || null : null,
    messages: snapshotMessages(session),
    queueLength: queuedTurnCount(session),
  };
  if (session.status !== "running" && session.lastResult?.content) {
    out.content = session.lastResult.content;
  }
  const navigate = sessionNavigatePayload(session);
  if (navigate) out.navigate = navigate;
  return out;
}

/**
 * @param {string} email
 */
export function getActiveAgent(email, opts = {}) {
  const workspace = normalizeJypeWorkspace(opts.workspace);
  const normalized = canonicalizeEmail(email);
  if (!canUseAgent(normalized, workspace)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  const key = focusKey(normalized, workspace);
  const sid = activeByEmail.get(key) || null;
  if (!sid) {
    return { ok: true, sessionId: null, status: null, messages: [] };
  }
  const session = sessions.get(sid);
  if (!session) {
    activeByEmail.delete(key);
    return { ok: true, sessionId: null, status: null, messages: [] };
  }
  session.lastUsedAt = Date.now();
  /** @type {Record<string, unknown>} */
  const out = {
    ok: true,
    sessionId: sid,
    status: session.status || "idle",
    workingLabel:
      session.status === "running" ? session.workingLabel || null : null,
    messages: snapshotMessages(session),
    queueLength: queuedTurnCount(session),
    content:
      session.status !== "running" && session.lastResult?.content
        ? session.lastResult.content
        : null,
  };
  const navigate = sessionNavigatePayload(session);
  if (navigate) out.navigate = navigate;
  return out;
}

/**
 * Personal Agent threads that still have work (running or queued).
 * @param {string} email
 */
export async function getRunningAgents(email, opts = {}) {
  const workspace = normalizeJypeWorkspace(opts.workspace);
  const normalized = canonicalizeEmail(email);
  if (!canUseAgent(normalized, workspace)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  /** @type {{ sessionId: string, status: string, workingLabel: string, queueLength: number, lastUsedAt: number }[]} */
  const live = [];
  for (const [sid, session] of sessions) {
    if (workspace === "jype") {
      if (sessionWorkspace(session) !== "jype") continue;
    } else if (session?.email !== normalized || sessionWorkspace(session) === "jype") {
      continue;
    }
    if (!sessionHasBackgroundWork(session)) continue;
    live.push({
      sessionId: sid,
      status: session.status || "idle",
      workingLabel:
        session.status === "running"
          ? session.workingLabel || WORKING_LABEL_DEFAULT
          : "Queued",
      queueLength: queuedTurnCount(session),
      lastUsedAt: session.lastUsedAt || session.createdAt || 0,
    });
  }
  live.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  const workingIds = new Set(live.map((row) => row.sessionId));
  const chats = live.length
    ? await listChatHistory({ email: normalized, workingIds, workspace })
    : [];
  const titleById = new Map(
    (chats || []).map((row) => [
      String(row.sessionId || ""),
      row.title || row.preview || "",
    ])
  );
  return {
    ok: true,
    agents: live.map((row) => {
      const raw = String(titleById.get(row.sessionId) || "").trim();
      return {
        sessionId: row.sessionId,
        title: raw || "Chat",
        workingLabel: row.workingLabel,
        status: row.status,
        queueLength: row.queueLength,
      };
    }),
  };
}

/**
 * @param {string} sessionId
 * @param {string} email
 */
export async function stopAgent(sessionId, email, opts = {}) {
  const workspace = normalizeJypeWorkspace(opts.workspace);
  const normalized = canonicalizeEmail(email);
  const sid = String(sessionId || "").trim();
  const session = sessions.get(sid);
  const key = focusKey(normalized, workspace || sessionWorkspace(session));
  if (!session) {
    if (activeByEmail.get(key) === sid) {
      activeByEmail.delete(key);
    }
    notifyEducationClients(normalized, "change", {
      source: "agent",
      sessionId: sid || null,
      status: "stopped",
      ...(workspace ? { workspace } : {}),
    });
    return { ok: true, stopped: false };
  }
  if (!canAccessSession(session, normalized)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  await disposeSession(sid);
  notifyEducationClients(normalized, "change", {
    source: "agent",
    sessionId: sid,
    status: "stopped",
    ...(sessionWorkspace(session) ? { workspace: sessionWorkspace(session) } : {}),
  });
  return { ok: true, stopped: true };
}

/** @type {Set<string>} */
const scheduledInflight = new Set();

/**
 * Schedule from a live session or the local socket. Arms the timer and
 * tells open history drawers the thread exists.
 * @param {object} input
 */
export async function scheduleFutureAgentLive(input) {
  const result = await scheduleFutureAgent(input);
  armFutureAgentTimer(result.record, (record) => runScheduledAgent(record));
  notifyScheduledThread(
    result.record.email,
    result.record.workspace,
    result.sessionId,
    "idle"
  );
  return result;
}

/**
 * @param {string} sessionId
 * @param {Session|null} [session]
 */
export async function cancelFutureAgentLive(sessionId, session = null) {
  const sid = String(sessionId || "").trim();
  const record = await readFutureAgent(sid);
  if (!record) {
    const err = new Error("scheduled agent not found");
    err.status = 404;
    throw err;
  }
  if (session && !canManageFutureAgent(record, session)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  const result = await cancelFutureAgent(sid);
  clearFutureAgentTimer(sid);
  notifyScheduledThread(record.email, record.workspace, sid, "idle");
  return result;
}

/**
 * @param {Session} session
 * @param {object} record
 * @param {boolean} kickoff
 */
async function scheduledTurnPrompt(session, record, kickoff) {
  const email = record?.email || session.email;
  const workspace = record?.workspace || sessionWorkspace(session);
  let nowContext = null;
  try {
    nowContext = await resolveNowScheduleContext(email);
  } catch (err) {
    console.error("[future-agents] nowContext", err);
  }
  const model = copyModelSpec(DEFAULT_MODEL_SPEC);
  /** @type {string[]} */
  const parts = [
    systemPrompt(email, { workspace }),
    "",
    formatLiveContextBlock(
      nowContext,
      {},
      await buildYanLiveAppendix(email, nowContext?.timezone)
    ),
  ];
  if (kickoff && record.origin?.kind === "teams") {
    session.teamsDeliverFinal = true;
  }
  if (kickoff && record.origin?.kind === "imessage") {
    session.imessageDeliverFinal = true;
  }
  if (kickoff && record.origin?.kind === "whatsapp" && WHATSAPP_AGENT_ENABLED) {
    session.whatsappDeliverFinal = true;
  }
  const imessageBlock = formatIMessageOriginBlock(session.imessageOrigin, {
    deliverFinal: Boolean(session.imessageDeliverFinal),
  });
  if (imessageBlock) parts.push("", imessageBlock);
  const teamsBlock = formatTeamsOriginBlock(session.teamsOrigin, {
    deliverFinal: Boolean(session.teamsDeliverFinal),
  });
  if (teamsBlock) parts.push("", teamsBlock);
  const whatsappBlock = formatWhatsAppOriginBlock(session.whatsappOrigin, {
    deliverFinal: Boolean(session.whatsappDeliverFinal),
    guestCaller: session.guestCaller,
  });
  if (whatsappBlock) parts.push("", whatsappBlock);
  parts.push("", formatScheduledSystemBlock(record, { kickoff }));
  if (kickoff) {
    parts.push(
      "",
      "It is now the scheduled time. Do the task. The first user message is already in the thread."
    );
  }
  return { prompt: parts.join("\n"), nowContext, model };
}

/**
 * Start the scheduled run on the existing thread. Does not take UI focus.
 * @param {object} record
 */
export async function runScheduledAgent(record) {
  const sid = String(record?.sessionId || "").trim();
  if (!sid) return;
  if (scheduledInflight.has(sid)) return;
  const fresh = await readFutureAgent(sid);
  if (!fresh) return;
  if (fresh.status === "done" || fresh.status === "canceled" || fresh.status === "failed") {
    return;
  }
  const live = sessions.get(sid);
  if (live?.status === "running" && live.runPromise) {
    live.runPromise.finally(() => {
      runScheduledAgent(fresh).catch((err) => {
        console.error("[future-agents] retry", err);
      });
    });
    return;
  }

  scheduledInflight.add(sid);
  try {
    const email = fresh.email;
    const workspace = fresh.workspace;
    let session = sessions.get(sid);
    if (!session) {
      const loaded = await loadChatHistory({
        email,
        sessionId: sid,
        workspace,
      });
      if (!loaded) {
        await markFutureAgentStatus(sid, "failed");
        scheduledInflight.delete(sid);
        return;
      }
      const messages = (loaded.messages || []).map((m) => {
        /** @type {ChatMessage} */
        const row = { role: m.role, content: m.content, at: m.at };
        if (Array.isArray(m.widgets) && m.widgets.length) row.widgets = m.widgets;
        return row;
      });
      const uploadRoot =
        workspace === "jype"
          ? `education/projects/jype/.chat-uploads/${sid}`
          : `education/${email}/.chat-uploads/${sid}`;
      session = {
        agent: null,
        email,
        workspace,
        starter: loaded.starter || "",
        createdAt: Date.parse(loaded.started) || Date.now(),
        lastUsedAt: Date.now(),
        uploads: [],
        uploadDirRel: uploadRoot,
        messages,
        status: "idle",
        workingLabel: null,
        runPromise: null,
        turnQueue: [],
        replayUiTranscript: true,
        imessageOrigin: null,
        imessageDeliverFinal: false,
        teamsOrigin: null,
        teamsDeliverFinal: false,
        whatsappOrigin: null,
        whatsappDeliverFinal: false,
        guestCaller: null,
        usagePerson: fresh.person || personFromEmail(email),
        ephemeralPinned: true,
      };
      sessions.set(sid, session);
    }
    session.usagePerson = fresh.person || personFromEmail(email);
    attachScheduledToSession(session, fresh);
    session.scheduledStatus = "running";
    session.futureAgentRecord = { ...fresh, status: "running" };
    session.scheduledKickoff = true;
    session.replayUiTranscript = true;
    await markFutureAgentStatus(sid, "running");
    const built = await scheduledTurnPrompt(session, session.futureAgentRecord, true);
    const apiKey = requireKey();
    const model = await resolveModelSelection(apiKey, built.model);
    /** @type {TurnOpts} */
    const turnOpts = {
      prompt: built.prompt,
      images: [],
      model,
      normalized: email,
      nowContext: built.nowContext,
      attachmentCount: 0,
      sessionAttachmentCount: 0,
      bubble: "",
      scheduledKickoff: true,
    };
    claimChannelDelivery(session, turnOpts);
    session.lastUsedAt = Date.now();
    session.workingLabel = WORKING_LABEL_DEFAULT;
    notifyScheduledThread(email, workspace, sid, "running");
    kickoffTurn(sid, session, turnOpts);
    const pending = session.runPromise;
    if (pending) {
      pending.finally(() => {
        scheduledInflight.delete(sid);
        notifyScheduledThread(email, workspace, sid, session.status || "idle");
      });
    } else {
      scheduledInflight.delete(sid);
    }
  } catch (err) {
    scheduledInflight.delete(sid);
    console.error("[future-agents] run", err);
    await markFutureAgentStatus(sid, "failed").catch(() => {});
  }
}

export function startFutureAgentScheduler() {
  armStoredFutureAgents((record) => runScheduledAgent(record)).catch((err) => {
    console.error("[future-agents] scheduler", err);
  });
}
