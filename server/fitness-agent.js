/**
 * Cursor SDK local agent sessions for /fitness text input (iOS).
 * Composer 2.5 Fast — text-only. Local-only — never cloud runtime.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isFitnessUser } from "./fitness-data.js";
import { canonicalizeEmail } from "./identity.js";
import { gitAddCommitPush } from "./git-publish.js";
import {
  AUTO_MODEL_SELECTION,
  INTERACTIVE_FALLBACK_DELAYS_MS,
  INTERACTIVE_MODEL_DELAYS_MS,
  createLocalCursorAgent,
  disposeCursorAgent,
  recreateLocalCursorAgent,
  onLocalCursorExecutorEvict,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
  runWithModelFallback,
} from "./cursor-sdk-auth.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @typedef {{ agent: any, email: string, createdAt: number, lastUsedAt: number }} Session */

onLocalCursorExecutorEvict(() => {
  for (const session of sessions.values()) {
    session.agent = null;
  }
});

/** @type {Map<string, Session>} */
const sessions = new Map();

const SESSION_TTL_MS = 60 * 60 * 1000;

/**
 * @typedef {{ id: string, value: string }} ModelParam
 * @typedef {{ id: string, params: ModelParam[] }} ModelSelection
 */

const DEFAULT_MODEL_SPEC = {
  id: process.env.CURSOR_FITNESS_MODEL || "composer-2.5",
  /** @type {ModelParam[]} */
  params: [{ id: "fast", value: "true" }],
};

/**
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
    return fallback;
  } catch (err) {
    console.warn(
      "[fitness-agent] model catalog lookup failed; using explicit ModelSelection",
      err instanceof Error ? err.message : err
    );
    return fallback;
  }
}

function requireKey() {
  const key = process.env.CURSOR_API_KEY || "";
  if (!key) {
    const err = new Error("CURSOR_API_KEY not configured");
    err.status = 503;
    throw err;
  }
  return key;
}

function minifyReply(text) {
  let s = String(text || "").trim();
  if (!s) return "";
  const lines = s.split(/\r?\n/);
  /** @type {string[]} */
  const out = [];
  for (const line of lines) {
    let cleaned = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^[-*]\s+/, "");
    if (cleaned) out.push(cleaned);
  }
  s = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const max = 280;
  if (s.length > max) {
    const cut = s.slice(0, max);
    const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
    s = (lastBreak > 60 ? cut.slice(0, lastBreak + 1) : cut).trim() + "…";
  }
  return s;
}

/**
 * @param {string} email
 * @param {string|null|undefined} machineId
 * @param {string|null|undefined} machineName
 */
function systemPrompt(email, machineId, machineName) {
  const machineHint =
    machineId && machineName
      ? `Active machine (from the app UI): id="${machineId}", name="${machineName}". Prefer this machine when the user does not name another.`
      : machineId
        ? `Active machine id="${machineId}". Prefer this machine when the user does not name another.`
        : "No active machine selected — pick the obvious machine from the message, or the most recently used one. Never ask which machine.";

  return [
    "You are the fitness / gym OS agent for yanylevin.com /fitness (iOS text input).",
    `Signed-in user email: ${email}`,
    `Only create/update files under fitness/${email}/`,
    "Never touch another user's email folder.",
    "Never edit main-site chatbot code, education folders, or LM Studio wiring.",
    "Never spawn a Cursor cloud agent.",
    "Prefer the fitness-os skill instructions when present.",
    "",
    "Data layout:",
    `fitness/${email}/meta.json`,
    `fitness/${email}/machines/<machineId>/machine.json  — { id, name, order, color }`,
    `fitness/${email}/machines/<machineId>/entries.json — { entries: [{ id, weight, at }] }`,
    "",
    "Rules:",
    "- Each weight entry needs weight (number) and at (ISO timestamp, time of input).",
    "- When adding entries now, use the current time (ISO). Space multi-entry batches by 1ms so order is preserved.",
    "- Parse comma/space-separated numbers as separate entries in that order. Example: \"100, 105, 105\" → three entries 100 then 105 then 105.",
    "- Append to entries.json; never wipe unrelated history.",
    "- You CAN delete specific log entries when asked (mistakes, accidental button presses, undo last, remove a weight). Match by recent at/weight/active machine, remove only those objects from the entries array, save entries.json. Do not refuse — this is a supported action.",
    "- Never clear an entire machine's history unless the user explicitly asks to clear all logs for that machine.",
    "- Create a new machine folder only when the user clearly asks for a new machine.",
    "- New machines MUST include color as #rrggbb. Before writing, read sibling machines/*/machine.json colors and pick a hex not already used (case-insensitive). Never reuse or cycle a taken color — invent a clearly different hue if needed.",
    "- A session is the Pacific (America/Los_Angeles) calendar date of each entry's at. Do not invent session metadata files.",
    "- Newly logged entries stay \"pending\" for 2 hours, then solidify into charts/history automatically.",
    machineHint,
    "",
    "Invisible output (critical):",
    "- The user NEVER sees your text. The fitness UI does not show agent messages at all.",
    "- Your only real output is file actions (append/delete entries, create/rename machines). Text is discarded.",
    "- NEVER ask for confirmation, clarification, or a yes/no. The user cannot see or answer you.",
    "- Act immediately from the typed command plus the active machine. If slightly ambiguous, pick the obvious interpretation and do it.",
    "- If you must emit leftover text, one short status line or empty. No markdown, questions, or “please refresh.”",
  ].join("\n");
}

function sweepExpired() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastUsedAt > SESSION_TTL_MS) {
      sessions.delete(id);
      disposeCursorAgent(session.agent).catch(() => {});
    }
  }
}

setInterval(sweepExpired, 5 * 60 * 1000).unref?.();

/**
 * @param {string} email
 */
export async function startFitnessAgent(email) {
  const normalized = canonicalizeEmail(email);
  if (!isFitnessUser(normalized)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }

  await reloadCursorApiKeyFromEnv();
  const apiKey = requireKey();
  const model = await resolveModelSelection(apiKey, DEFAULT_MODEL_SPEC);
  /** @type {any} */
  let agent = null;
  await runWithModelFallback({
    prefix: "fitness-agent-create",
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
    const err = new Error("failed to create fitness agent");
    err.status = 503;
    throw err;
  }

  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `fit-${Date.now().toString(36)}`;

  sessions.set(id, {
    agent,
    email: normalized,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  });

  return { sessionId: id, email: normalized };
}

/**
 * @param {string} sessionId
 * @param {string} email
 * @param {string} message
 * @param {{ machineId?: string, machineName?: string }} [ctx]
 */
export async function messageFitnessAgent(sessionId, email, message, ctx = {}) {
  const normalized = canonicalizeEmail(email);
  const sid = String(sessionId || "").trim();
  const text = String(message || "").trim();
  if (!sid || !text) {
    const err = new Error("sessionId and message required");
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
  const apiKey = requireKey();
  const model = await resolveModelSelection(apiKey, DEFAULT_MODEL_SPEC);

  const prompt = [
    systemPrompt(
      normalized,
      ctx.machineId ? String(ctx.machineId) : null,
      ctx.machineName ? String(ctx.machineName) : null
    ),
    "",
    "User:",
    text,
  ].join("\n");

  /** @type {string[]} */
  const chunks = [];
  const outcome = await runWithModelFallback({
    prefix: "fitness-agent",
    preferredModel: model,
    delaysMs: INTERACTIVE_MODEL_DELAYS_MS,
    fallbackModel: AUTO_MODEL_SELECTION,
    fallbackDelaysMs: INTERACTIVE_FALLBACK_DELAYS_MS,
    laterDelaysMs: [],
    onBeforeAttempt: async ({ model: nextModel, recreate }) => {
      if (recreate) {
        await recreateLocalCursorAgent({
          model: nextModel,
          cwd: REPO_ROOT,
          attach: (agent) => {
            session.agent = agent;
          },
        });
      } else if (!session.agent) {
        session.agent = await createLocalCursorAgent({
          model: nextModel,
          cwd: REPO_ROOT,
        });
      }
    },
    run: async (nextModel) => {
      if (!session.agent) {
        session.agent = await createLocalCursorAgent({
          model: nextModel,
          cwd: REPO_ROOT,
        });
      }
      chunks.length = 0;
      const run = await session.agent.send(prompt, { model: nextModel });
      try {
        if (typeof run.stream === "function") {
          for await (const event of run.stream()) {
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
        console.error("[fitness-agent] stream", err);
      }
      return run.wait();
    },
  });
  const result = outcome.result;
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
  content = minifyReply(content);
  if (!content) {
    content =
      result?.status === "error"
        ? "The fitness agent hit an error. Try again."
        : "Done.";
  }

  gitAddCommitPush({
    paths: [`fitness/${normalized}`],
    message: `fitness: agent update for ${normalized}`,
  }).catch((err) => console.error("[fitness-agent] git publish", err));

  return { ok: true, reply: content, sessionId: sid };
}

/**
 * @param {string} sessionId
 * @param {string} email
 */
export async function stopFitnessAgent(sessionId, email) {
  const normalized = canonicalizeEmail(email);
  const sid = String(sessionId || "").trim();
  const session = sessions.get(sid);
  if (!session) return { ok: true, stopped: false };
  if (session.email !== normalized) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  sessions.delete(sid);
  await disposeCursorAgent(session.agent);
  return { ok: true, stopped: true };
}
