/**
 * Cursor SDK local agent sessions for the Personal Agent
 * (iOS Chat tab / /education chat). Local-only — never cloud runtime.
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { isEducationUser, resolveNowScheduleContext } from "./education-data.js";
import { notifyEducationClients } from "./education-events.js";
import { canonicalizeEmail, isFullAccessEmail } from "./identity.js";
import { gitAddCommitPush } from "./git-publish.js";
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
  sanitizeSessionId,
} from "./education-chat-history.js";
import { enqueueChatTitle } from "./chat-title.js";
import {
  formatWidgetsAsFences,
  parseAgentReply,
} from "./chat-widgets.js";
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

/** @typedef {{ role: 'user'|'assistant', content: string, queued?: boolean, widgets?: object[], at?: string, endOfTurn?: boolean }} ChatMessage */

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
 *   interrupted?: boolean,
 * }} TurnOpts
 */

/**
 * @typedef {{
 *   agent: any,
 *   email: string,
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
 * }} Session
 */

/** @typedef {{ name: string, mimeType?: string, data: string }} AttachmentInput */

/** @typedef {{ name: string, mimeType: string, relPath: string, absPath: string, bytes: number, isImage: boolean }} StagedFile */

/** @type {Map<string, Session>} */
const sessions = new Map();

/** Focused session id per user (the chat the UI last opened). Others may still run. */
/** @type {Map<string, string>} */
const activeByEmail = new Map();

const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_ATTACHMENTS = 16;
/** Per-file cap — under Grok/xAI ~20MiB image input; base64 fits Express JSON. */
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
/** Total decoded bytes per message; ~24MB raw → ~32MB base64 + JSON under Express 40mb. */
const MAX_TOTAL_ATTACHMENT_BYTES = 24 * 1024 * 1024;
/** Max user messages waiting behind the in-flight Personal Agent turn. */
export const MAX_QUEUED_TURNS = 8;

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
 * grok-4.6 → high, not fast. composer-* → Composer Fast.
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
    ? [{ id: "fast", value: "true" }]
    : [
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ];
  return { id, params };
}

/** Text-only Personal Agent. Default grok-4.6 high; Composer Fast via CURSOR_PERSONAL_MODEL. */
const DEFAULT_MODEL_SPEC = personalModelSpec(
  process.env.CURSOR_PERSONAL_MODEL || process.env.CURSOR_EDUCATION_MODEL,
  "grok-4.6"
);

/** Attachment / image Personal Agent — grok-4.6 high, independent of text-only. */
const ATTACHMENT_MODEL_SPEC = personalModelSpec(
  process.env.CURSOR_PERSONAL_ATTACHMENT_MODEL ||
    process.env.CURSOR_EDUCATION_ATTACHMENT_MODEL,
  "grok-4.6"
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
    out.push({
      role: "user",
      content: turn.bubble || "(attachment)",
      queued: true,
    });
  }
  return out;
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
  /** @type {ChatMessage} */
  const row = { role, content, at: new Date().toISOString() };
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

/**
 * @param {string} sid
 * @param {Session} session
 */
function sendChatMessageTool(sid, session) {
  return {
    send_chat_message: {
      description:
        "Send a user-visible chat bubble immediately without ending the turn. Call once, first, only before longer agentic work (education writes, widgets, scanning lots of data). The turn still ends with your final reply (usually Done). Do not call for a normal short answer.",
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
      execute({ text }) {
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
        return "delivered";
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
  persistChatHistory({
    email: session.email,
    sessionId: sid,
    messages: snap,
  })
    .then(() => {
      if (userTurns === 1) enqueueChatTitle({ email: session.email, sessionId: sid });
    })
    .catch((err) => {
      console.error("[personal-agent] chat-history", err);
    });
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
  if (s?.email && activeByEmail.get(s.email) === id) {
    activeByEmail.delete(s.email);
  }
  if (s?.uploadDirRel) {
    await rm(join(REPO_ROOT, s.uploadDirRel), {
      recursive: true,
      force: true,
    }).catch(() => {});
  }
  await disposeCursorAgent(s?.agent);
}

function requireKey() {
  return requireCursorApiKey();
}

/**
 * @param {Session} session
 * @param {ModelSelection} model
 */
async function replaceSessionAgent(session, model) {
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

/** On-demand files. Do not inline their contents into the turn prompt. */
export const PERSONAL_SKILL_PATHS = {
  agent: ".cursor/skills/personal-agent/SKILL.md",
  soul: "SOUL.md",
  education: ".cursor/skills/personal-agent/education-dashboard.md",
  schedule: ".cursor/skills/class-schedule/SKILL.md",
  widgets: ".cursor/skills/chat-widgets/SKILL.md",
  mail: ".cursor/skills/personal-mail/SKILL.md",
  schoolMail: ".cursor/skills/personal-school-mail/SKILL.md",
  location: ".cursor/skills/phone-location/SKILL.md",
  calendar: ".cursor/skills/personal-calendar/SKILL.md",
  canvas: ".cursor/skills/personal-canvas/SKILL.md",
  imessage: ".cursor/skills/personal-imessage/SKILL.md",
  screentime: ".cursor/skills/personal-screentime/SKILL.md",
  contacts: ".cursor/skills/personal-contacts/SKILL.md",
  people: ".cursor/skills/personal-people/SKILL.md",
  chats: ".cursor/skills/past-chats/SKILL.md",
  news: ".cursor/skills/daily-news/SKILL.md",
  fitness: ".cursor/skills/fitness-os/SKILL.md",
  brain: "education/you@example.com/brain/schema.md",
  synthesis: ".cursor/skills/context-synthesis/SKILL.md",
  locationEnrichment: ".cursor/skills/location-enrichment/SKILL.md",
  locationBrain: ".cursor/skills/location-brain/SKILL.md",
  healthBrain: ".cursor/skills/health-brain/SKILL.md",
  factCheck: ".cursor/skills/nightly-fact-check/SKILL.md",
};

const EDUCATION_VIEWS = new Set([
  "home",
  "class",
  "project",
  "todo",
  "date",
  "capsule",
]);

/**
 * Slim establishing prompt. Recipes live in PERSONAL_SKILL_PATHS.
 * @param {string} email
 */
export function systemPrompt(email) {
  const isOwner = isFullAccessEmail(email);
  return [
    "You are the Personal Agent for yanylevin.com (iOS Chat tab person icon / /education chat) and Cursor Desktop on this Mac.",
    "The /education website is still the school dashboard. You are a personal agent that can manage that dashboard when asked, plus mail, news, location, and anything else the user asks.",
    `Signed-in user email: ${email}`,
    "Yan: full write in this repo and on this Mac. Do not refuse repo-wide or Mac-wide work.",
    "Never spawn a Cursor cloud agent. Never edit main-site chatbot.js / /api/chat / LM Studio unless Yan explicitly asks.",
    "",
    `Always Read and apply the unslop skill (${UNSLOP_SKILL_PATH}) on every turn. Do not skip it. Do not inline the whole skill here.`,
    `Always Read ${PERSONAL_SKILL_PATHS.soul} for persona and judgment. Do not skip it. Do not inline it.`,
    `When this turn names a person (given name, nickname, or alias), pull the entity card: node server/brain-entity-card.js "<name or slug>" (fields, edges, typed files, recent timeline in one call), guided by ${PERSONAL_SKILL_PATHS.people}. Aliases live on the card. Do not guess who they are, and do not glob brain/people/.`,
    `When Yan states a fact or correction about a person or entity, write it the same turn per ${PERSONAL_SKILL_PATHS.people}: dated timeline entry or frontmatter field on that entity. Do not also copy the person fact onto identity.md. Identity people lines are name, role, and a people/slug pointer. Facts about Yan himself go to education/you@example.com/brain/identity.md (map) or identity-school.md / identity-accounts.md / identity-logistics.md or threads/. Rewrite a standing line. Do not wait for the nightly job.`,
    "Do not preload other skills. Read only the file this turn needs:",
    `- Identity / permissions / reply style: ${PERSONAL_SKILL_PATHS.agent}`,
    `- Education dashboard (classes, todos, dates, projects, school attachments): ${PERSONAL_SKILL_PATHS.education}`,
    `- Class schedule: ${PERSONAL_SKILL_PATHS.schedule}`,
    `- Past chats: ${PERSONAL_SKILL_PATHS.chats}`,
    `- Chat widgets (map / html / image fences): ${PERSONAL_SKILL_PATHS.widgets}`,
    `- Yan Mail.app search and send: ${PERSONAL_SKILL_PATHS.mail}`,
    `- School Outlook (owner@school.example) via school-mail.js: ${PERSONAL_SKILL_PATHS.schoolMail}`,
    `- Phone location: ${PERSONAL_SKILL_PATHS.location}`,
    `- Apple Calendar: ${PERSONAL_SKILL_PATHS.calendar}`,
    `- Canvas: ${PERSONAL_SKILL_PATHS.canvas}`,
    `- Yan iMessage search and send: ${PERSONAL_SKILL_PATHS.imessage}`,
    `- Screen Time: ${PERSONAL_SKILL_PATHS.screentime}`,
    `- Contacts: ${PERSONAL_SKILL_PATHS.contacts}`,
    `- Daily Briefing compile / news sources / thumbs: ${PERSONAL_SKILL_PATHS.news}`,
    `- Fitness / gym: ${PERSONAL_SKILL_PATHS.fitness}`,
    `- Memories / brain: education/you@example.com/brain/ (identity.md map, identity-school.md, identity-accounts.md, identity-logistics.md, patterns.md, health.md, threads/, journal/, places/; contract in ${PERSONAL_SKILL_PATHS.brain})`,
    "",
    "Live context below is authoritative for clock, class-now, and the open screen. Trust it. Named-people lookup still opens brain/people/. Other education/<email>/ files only when the question needs that data.",
    "",
    "Reply: short. School mutations 1-3 lines. Markdown OK in the text bubble; never HTML tags or markdown images. Never em dashes. No thinking aloud. Do not tell the user to refresh. Read the widgets skill before emitting any widget fence.",
    "Long work: call send_chat_message first with a short status, then act, then a final Done. Quick answers: one reply only (that is the end of turn).",
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
  str("classId", 120);
  str("className", 160);
  str("period", 8);
  str("projectId", 120);
  str("projectName", 160);
  str("todoId", 120);
  str("todoName", 200);
  str("tag", 8);
  str("dateId", 120);
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
    if (Array.isArray(nowContext.todayClasses) && nowContext.todayClasses.length) {
      lines.push(
        "Today's classes: " +
          nowContext.todayClasses
            .map(
              (c) =>
                `${c.period} ${c.name} ${c.start}–${c.end}${c.freePeriod ? " (free)" : ""}`
            )
            .join("; ")
      );
    }
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
      const err = new Error("attachments total size too large");
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

/**
 * @returns {Promise<any>}
 */
async function createPersonalCursorAgent() {
  await reloadCursorApiKeyFromEnv();
  const apiKey = requireKey();
  const model = await resolveModelSelection(apiKey, DEFAULT_MODEL_SPEC);

  /** @type {any} */
  let agent = null;
  const outcome = await runWithModelFallback({
    prefix: "personal-agent-create",
    preferredModel: model,
    delaysMs: INTERACTIVE_MODEL_DELAYS_MS,
    fallbackModel: AUTO_MODEL_SELECTION,
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
    console.warn("[personal-agent] created session on auto after grok create failed");
  }
  return agent;
}

/**
 * @param {string} email
 */
export async function startAgent(email) {
  const normalized = canonicalizeEmail(email);
  if (!isEducationUser(normalized)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }

  const agent = await createPersonalCursorAgent();

  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `pa-${Date.now().toString(36)}`;

  // Switch focus. Running / queued threads keep working in the background.
  const priorId = activeByEmail.get(normalized);
  if (priorId && priorId !== id) {
    await releaseFocusFrom(priorId);
  }

  sessions.set(id, {
    agent,
    email: normalized,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    uploads: [],
    uploadDirRel: `education/${normalized}/.chat-uploads/${id}`,
    messages: [],
    status: "idle",
    workingLabel: null,
    runPromise: null,
    turnQueue: [],
  });
  activeByEmail.set(normalized, id);

  return { sessionId: id, email: normalized, status: "idle", messages: [] };
}

/**
 * List this user's persisted threads. Enqueues untitled files for titles.
 * @param {string} email
 */
export async function listAgentChats(email) {
  const normalized = canonicalizeEmail(email);
  if (!isEducationUser(normalized)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  const chats = await listChatHistory({ email: normalized });
  const workingIds = new Set();
  for (const [sid, session] of sessions) {
    if (session?.email === normalized && sessionHasBackgroundWork(session)) {
      workingIds.add(sid);
    }
  }
  for (const row of chats) {
    if (!row?.title && row?.sessionId) {
      enqueueChatTitle({ email: normalized, sessionId: row.sessionId });
    }
  }
  return {
    ok: true,
    sessionId: activeByEmail.get(normalized) || null,
    chats: applyChatWorkingStatus(chats, workingIds),
  };
}

/**
 * Mark a thread as read for the history unread dot.
 * @param {unknown} sessionId
 * @param {string} email
 */
export async function markAgentChatRead(sessionId, email) {
  const normalized = canonicalizeEmail(email);
  if (!isEducationUser(normalized)) {
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
  });
  notifyEducationClients(normalized, "change", {
    source: "agent",
    sessionId: sid,
    status: "read",
  });
  return { ok: true, sessionId: sid, lastRead };
}

/**
 * Hydrate a persisted thread as the live session so the user can continue it.
 * @param {string} sessionId
 * @param {string} email
 */
export async function resumeAgent(sessionId, email) {
  const normalized = canonicalizeEmail(email);
  if (!isEducationUser(normalized)) {
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
    if (live.email !== normalized) {
      const err = new Error("forbidden");
      err.status = 403;
      throw err;
    }
    live.lastUsedAt = Date.now();
    activeByEmail.set(normalized, sid);
    if (!live.messages?.length) {
      /* empty live session */
    }
    await markChatHistoryRead({ email: normalized, sessionId: sid });
    enqueueChatTitle({ email: normalized, sessionId: sid });
    notifyEducationClients(normalized, "change", {
      source: "agent",
      sessionId: sid,
      status: live.status || "idle",
    });
    return {
      ok: true,
      sessionId: sid,
      status: live.status || "idle",
      messages: snapshotMessages(live),
      queueLength: queuedTurnCount(live),
    };
  }

  const loaded = await loadChatHistory({ email: normalized, sessionId: sid });
  if (!loaded) {
    const err = new Error("session not found");
    err.status = 404;
    throw err;
  }

  const priorId = activeByEmail.get(normalized);
  if (priorId && priorId !== sid) {
    await releaseFocusFrom(priorId);
  }

  const agent = await createPersonalCursorAgent();
  /** @type {ChatMessage[]} */
  const messages = (loaded.messages || []).map((m) => {
    /** @type {ChatMessage} */
    const row = { role: m.role, content: m.content, at: m.at };
    if (Array.isArray(m.widgets) && m.widgets.length) row.widgets = m.widgets;
    return row;
  });

  sessions.set(sid, {
    agent,
    email: normalized,
    createdAt: Date.parse(loaded.started) || Date.now(),
    lastUsedAt: Date.now(),
    uploads: [],
    uploadDirRel: `education/${normalized}/.chat-uploads/${sid}`,
    messages,
    status: "idle",
    workingLabel: null,
    runPromise: null,
    turnQueue: [],
    replayUiTranscript: true,
  });
  activeByEmail.set(normalized, sid);
  await markChatHistoryRead({ email: normalized, sessionId: sid });
  if (!loaded.title) enqueueChatTitle({ email: normalized, sessionId: sid });
  notifyEducationClients(normalized, "change", {
    source: "agent",
    sessionId: sid,
    status: "idle",
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

  try {
    /** @type {string[]} */
    const chunks = [];
    const outcome = await runWithModelFallback({
      prefix: "personal-agent",
      preferredModel: model,
      delaysMs: INTERACTIVE_MODEL_DELAYS_MS,
      fallbackModel: AUTO_MODEL_SELECTION,
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
          local: { customTools: sendChatMessageTool(sid, session) },
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
      if (session.interrupting) releaseTurnRun(session);
      return;
    }
    if (!sessions.has(sid) || sessions.get(sid) !== session) return;
    const result = outcome.result;
    if (outcome.usedFallback) {
      console.warn(
        `[personal-agent] turn used ${outcome.model?.id || "auto"} after grok/auto retries`
      );
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
          ? "The personal agent hit an error. Try again or use Cursor Desktop with the personal-agent skill."
          : EMPTY_TURN_REPLY;
    }

    const parsed = parseAgentReply(content);
    content =
      parsed.content || (parsed.widgets.length ? "" : EMPTY_TURN_REPLY);
    if (shouldAppendEndOfTurn(session.messages, content, parsed.widgets)) {
      session.messages.push(
        stampMessage("assistant", content, parsed.widgets, { endOfTurn: true })
      );
    } else {
      const last = session.messages[session.messages.length - 1];
      if (last && last.role === "assistant") last.endOfTurn = true;
    }
    persistSessionHistory(sid, session);
    session.lastUsedAt = Date.now();
    if (String(result?.status || "").toLowerCase() !== "error") {
      session.replayUiTranscript = false;
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

    const finishedStatus = result?.status === "error" ? "error" : "idle";
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

    if (!Array.isArray(session.turnQueue)) session.turnQueue = [];
    if (session.turnQueue.length > 0) {
      const next = session.turnQueue.shift();
      appendPromotedUserMessage(session, next);
      persistSessionHistory(sid, session);
      session.status = "running";
      notifyEducationClients(normalized, "change", {
        source: "agent",
        sessionId: sid,
        status: "running",
      });
      kickoffTurn(sid, session, next);
    } else {
      session.status = finishedStatus;
      notifyEducationClients(normalized, "change", {
        source: "agent",
        sessionId: sid,
        status: session.status,
      });
    }
  } catch (err) {
    if (
      session.interrupting ||
      (err instanceof Error && err.message === "interrupted")
    ) {
      releaseTurnRun(session);
      return;
    }
    console.error("[personal-agent] run", err);
    if (!sessions.has(sid) || sessions.get(sid) !== session) return;
    const fallback =
      "The personal agent hit an error. Try again or use Cursor Desktop with the personal-agent skill.";
    session.messages.push(
      stampMessage("assistant", fallback, undefined, { endOfTurn: true })
    );
    persistSessionHistory(sid, session);
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

    if (!Array.isArray(session.turnQueue)) session.turnQueue = [];
    if (session.turnQueue.length > 0) {
      const next = session.turnQueue.shift();
      appendPromotedUserMessage(session, next);
      persistSessionHistory(sid, session);
      session.status = "running";
      notifyEducationClients(normalized, "change", {
        source: "agent",
        sessionId: sid,
        status: "running",
      });
      kickoffTurn(sid, session, next);
    } else {
      session.status = "error";
      notifyEducationClients(normalized, "change", {
        source: "agent",
        sessionId: sid,
        status: "error",
      });
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
  if (session.email !== normalized) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }

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

  session.lastUsedAt = Date.now();

  let newFiles;
  try {
    newFiles = await stageAttachments(session, sid, attachments);
  } catch (err) {
    if (claimedIdleSlot) session.status = "idle";
    throw err;
  }
  const sessionFiles = session.uploads;
  const hasSessionFiles = sessionFiles.length > 0;
  const hasNewAttachments = newFiles.length > 0;

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
      hasSessionFiles ? ATTACHMENT_MODEL_SPEC : DEFAULT_MODEL_SPEC
    );
  } catch (err) {
    if (claimedIdleSlot) session.status = "idle";
    throw err;
  }

  /** @type {string[]} */
  const promptParts = [
    systemPrompt(normalized),
    "",
    formatLiveContextBlock(
      nowContext,
      uiContext,
      await buildYanLiveAppendix(normalized, nowContext?.timezone)
    ),
  ];
  if (interrupting) {
    promptParts.push(
      "",
      "The user interrupted your previous work with a new message. Treat this as the current request. Disk changes from the cancelled turn may already be partial. Do not redo completed work unless asked."
    );
  }
  promptParts.push("", "User:", text || "(no text — see attachments)");

  if (hasSessionFiles) {
    promptParts.push(
      "",
      hasNewAttachments
        ? "Chat attachments available this session (still on disk — copy from these paths when storing context; earlier files remain usable on later turns):"
        : "Previously attached files still available this session (still on disk — copy from these paths; do not ask the user to re-send):"
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
      `User-level / "main education folder" = education/${normalized}/ (next to meta.json / schedule.json).`
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

  activeByEmail.set(normalized, sid);

  if (interrupting) {
    session.interrupting = true;
    await cancelActiveRun(session);
    session.interrupting = false;
    session.status = "running";
  }

  if (willQueue) {
    // Keep queued user bubbles out of session.messages until their turn
    // starts, so assistant replies stay interleaved (u1,a1,u2,a2,…).
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
  if (session.email !== normalized) {
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
  return out;
}

/**
 * @param {string} email
 */
export function getActiveAgent(email) {
  const normalized = canonicalizeEmail(email);
  if (!isEducationUser(normalized)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  const sid = activeByEmail.get(normalized) || null;
  if (!sid) {
    return { ok: true, sessionId: null, status: null, messages: [] };
  }
  const session = sessions.get(sid);
  if (!session) {
    activeByEmail.delete(normalized);
    return { ok: true, sessionId: null, status: null, messages: [] };
  }
  session.lastUsedAt = Date.now();
  return {
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
}

/**
 * @param {string} sessionId
 * @param {string} email
 */
export async function stopAgent(sessionId, email) {
  const normalized = canonicalizeEmail(email);
  const sid = String(sessionId || "").trim();
  const session = sessions.get(sid);
  if (!session) {
    if (activeByEmail.get(normalized) === sid) {
      activeByEmail.delete(normalized);
    }
    notifyEducationClients(normalized, "change", {
      source: "agent",
      sessionId: sid || null,
      status: "stopped",
    });
    return { ok: true, stopped: false };
  }
  if (session.email !== normalized) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  await disposeSession(sid);
  notifyEducationClients(normalized, "change", {
    source: "agent",
    sessionId: sid,
    status: "stopped",
  });
  return { ok: true, stopped: true };
}
