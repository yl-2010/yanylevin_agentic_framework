/**
 * One-shot thread titles for Personal Agent chats.
 * Isolated Cursor agent — never injected into the live chat thread.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalCursorAgent,
  disposeCursorAgent,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
} from "./cursor-sdk-auth.js";
import { logSdkResult, personFromEmail } from "./usage-log.js";
import {
  applyChatTitleStarter,
  CHAT_GUEST_WRAP_RE,
  fallbackChatTitle,
  loadChatHistory,
  patchChatHistoryTitle,
  resolveChatStarter,
  sanitizeChatTitle,
  scheduledTaskFromUserMessage,
  withScheduledTitlePrefix,
} from "./education-chat-history.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TITLE_TIMEOUT_MS = 40_000;
export const TITLE_MODEL = {
  id: "composer-2.5",
  params: [{ id: "fast", value: "true" }],
};

/** Shared with the 01:30 full-transcript refresh job. */
export const CHAT_TITLE_STYLE = `Keyword-style chat list title, not a sentence.
2 to 5 words, about 24-36 characters. Distinctive nouns: people, places, tasks.
No filler (hi, greeting, simple, nearby places to eat clones).
No quotes. No trailing punctuation. No em dashes. No explanation.`;

export const TITLE_PROMPT = `Reply with only a short chat list title for this first user message.
${CHAT_TITLE_STYLE}
Do not prefix the title with a person's name or Name:. The server adds that when needed.
Do not prefix the title with Scheduled:. The server adds that on a future agent thread.
If this is a Teams or iMessage @agent ping, title the request, not the From Name on Teams/iMessage wrapper or the @agent mention.
If the message starts with "Agent scheduled for", title the task under that line, not the date.

Message:
`;

const AGENT_MENTION_LEAD_RE = /^@agent\b[:,]?\s*/i;

/**
 * First-user-message text the title agent should see.
 * Guest @agent bubbles start with "From Name on Teams:" plus @agent; that
 * wrapper is not the topic.
 * @param {unknown} raw
 * @returns {string}
 */
export function titleSeedFromUserMessage(raw) {
  const task = scheduledTaskFromUserMessage(raw);
  if (task) return task;
  let s = String(raw || "").trim();
  const wrap = s.match(CHAT_GUEST_WRAP_RE);
  let who = "";
  let platform = "";
  if (wrap) {
    who = String(wrap[1] || "").trim();
    platform = String(wrap[2] || "").trim();
    s = s.slice(wrap[0].length).trim();
  }
  s = s.replace(AGENT_MENTION_LEAD_RE, "").trim();
  if (!s && wrap) s = "@agent";
  if (who && platform) {
    return `${who} (${platform}): ${s}`.trim();
  }
  return s;
}

/**
 * Live fallback / copied-wrapper titles. Composer should replace these.
 * @param {unknown} title
 * @param {unknown} firstUserMessage
 */
function isScheduledThread(loaded, firstUserMessage) {
  return Boolean(loaded?.scheduled) || Boolean(scheduledTaskFromUserMessage(firstUserMessage));
}

function storeChatTitle(title, loaded, firstUserMessage, starterOpts) {
  if (isScheduledThread(loaded, firstUserMessage)) {
    return withScheduledTitlePrefix(title);
  }
  return applyChatTitleStarter(title, starterOpts) || sanitizeChatTitle(title);
}

export function isStubChatTitle(title, firstUserMessage) {
  const t = sanitizeChatTitle(title);
  const task = scheduledTaskFromUserMessage(firstUserMessage);
  if (task) {
    if (!t) return true;
    if (t === withScheduledTitlePrefix(fallbackChatTitle(task))) return true;
  }
  if (!t) return true;
  if (CHAT_GUEST_WRAP_RE.test(t)) return true;
  const collapsed = String(firstUserMessage || "").replace(/\s+/g, " ").trim();
  if (!collapsed) return false;
  if (t === fallbackChatTitle(collapsed)) return true;
  if (t === fallbackChatTitle(String(firstUserMessage || ""))) return true;
  if (t === fallbackChatTitle(titleSeedFromUserMessage(firstUserMessage))) {
    return true;
  }
  return false;
}

/** @type {{ email: string, sessionId: string, root?: string, attempt?: number }[]} */
const queue = [];
let pumping = false;

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function titleFromAgentReply(raw) {
  return sanitizeChatTitle(raw);
}

/** @type {Set<string>} */
const pendingRetry = new Set();

function titleJobKey(email, sessionId) {
  return `${email}\0${sessionId}`;
}

/**
 * @param {{ email: string, sessionId: string, root?: string, attempt?: number }} job
 */
export function enqueueChatTitle(job) {
  const email = String(job?.email || "").trim();
  const sessionId = String(job?.sessionId || "").trim();
  if (!email || !sessionId) return;
  const attempt = Number(job?.attempt) || 0;
  const key = titleJobKey(email, sessionId);
  if (attempt < 1 && pendingRetry.has(key)) return;
  if (
    queue.some(
      (row) => row.email === email && row.sessionId === sessionId
    )
  ) {
    return;
  }
  queue.push({
    email,
    sessionId,
    root: job?.root,
    workspace: job?.workspace,
    starter: job?.starter,
    attempt,
  });
  pumpTitleQueue().catch((err) => {
    console.error("[chat-title] queue", err);
  });
}

async function pumpTitleQueue() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      if (!job) continue;
      try {
        await generateAndStoreChatTitle(job);
      } catch (err) {
        console.error("[chat-title]", job.sessionId, err);
      }
    }
  } finally {
    pumping = false;
  }
}

/**
 * @param {{ email: string, sessionId: string, root?: string, attempt?: number }} opts
 * @returns {Promise<string|null>}
 */
export async function generateAndStoreChatTitle(opts) {
  const loaded = await loadChatHistory(opts);
  if (!loaded) return null;
  const firstUser =
    loaded.messages.find((m) => m.role === "user")?.content ||
    loaded.preview ||
    "";
  const starterOpts = {
    email: opts.email,
    workspace: opts.workspace || loaded.workspace,
    starter: opts.starter || loaded.starter,
    firstUserMessage: firstUser,
  };
  const starter = resolveChatStarter(starterOpts);
  if (loaded.title && !isStubChatTitle(loaded.title, firstUser)) {
    const kept = storeChatTitle(loaded.title, loaded, firstUser, starterOpts);
    if (kept === loaded.title && starter === (loaded.starter || "")) {
      return loaded.title;
    }
    return patchChatHistoryTitle({
      email: opts.email,
      sessionId: opts.sessionId,
      title: kept || loaded.title,
      starter,
      root: opts.root,
      workspace: opts.workspace,
    });
  }

  const seed = titleSeedFromUserMessage(firstUser);
  let title = "";
  try {
    title = await generateTitleWithAgent(seed, opts.email);
    if (title && isStubChatTitle(title, firstUser)) title = "";
  } catch (err) {
    console.warn(
      "[chat-title] agent failed; using preview",
      err instanceof Error ? err.message : err
    );
  }
  if (!title) {
    const attempt = Number(opts.attempt) || 0;
    if (attempt < 1) {
      const key = titleJobKey(opts.email, opts.sessionId);
      pendingRetry.add(key);
      setTimeout(() => {
        pendingRetry.delete(key);
        enqueueChatTitle({
          email: opts.email,
          sessionId: opts.sessionId,
          root: opts.root,
          workspace: opts.workspace,
          starter: opts.starter || starter,
          attempt: 1,
        });
      }, 8_000);
      return loaded.title || null;
    }
    title = fallbackChatTitle(seed);
  }
  if (!title) return null;
  if (isStubChatTitle(title, firstUser) && loaded.title) {
    title = loaded.title;
  }
  const named = storeChatTitle(title, loaded, firstUser, starterOpts);
  return patchChatHistoryTitle({
    email: opts.email,
    sessionId: opts.sessionId,
    title: named || title,
    starter,
    root: opts.root,
    workspace: opts.workspace,
  });
}

/**
 * @param {string} firstPrompt
 * @param {string} [email]
 * @returns {Promise<string>}
 */
async function generateTitleWithAgent(firstPrompt, email) {
  const seed = String(firstPrompt || "").trim();
  if (!seed) return "";

  await reloadCursorApiKeyFromEnv();
  requireCursorApiKey();

  const agent = await createLocalCursorAgent({
    model: TITLE_MODEL,
    cwd: REPO_ROOT,
  });
  try {
    const run = await Promise.race([
      agent.send(`${TITLE_PROMPT}${seed.slice(0, 800)}`),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("title agent timed out")),
          TITLE_TIMEOUT_MS
        );
      }),
    ]);
    let content = "";
    if (run && typeof run.stream === "function") {
      /** @type {string[]} */
      const chunks = [];
      for await (const event of run.stream()) {
        if (event?.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block?.type === "text" && typeof block.text === "string") {
              chunks.push(block.text);
            }
          }
        }
      }
      content = chunks.join("");
    }
    let result = null;
    if (run && typeof run.wait === "function") {
      result = await run.wait();
    }
    if (!content && result && typeof result.result === "string") {
      content = result.result;
    }
    await logSdkResult({
      person: personFromEmail(email),
      kind: "chat-title",
      prompt: seed,
      model: TITLE_MODEL,
      result,
    }).catch((err) => console.error("[usage] title log failed", err));
    return titleFromAgentReply(content);
  } finally {
    await disposeCursorAgent(agent);
  }
}
