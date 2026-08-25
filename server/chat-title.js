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
import {
  fallbackChatTitle,
  loadChatHistory,
  patchChatHistoryTitle,
  sanitizeChatTitle,
} from "./education-chat-history.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TITLE_TIMEOUT_MS = 40_000;
const TITLE_MODEL = {
  id: "composer-2",
  params: [{ id: "fast", value: "true" }],
};

/** Shared with the 01:30 full-transcript refresh job. */
export const CHAT_TITLE_STYLE = `Keyword-style chat list title, not a sentence.
2 to 5 words, about 24-36 characters. Distinctive nouns: people, places, tasks.
No filler (hi, greeting, simple, nearby places to eat clones).
No quotes. No trailing punctuation. No em dashes. No explanation.`;

export const TITLE_PROMPT = `Reply with only a short chat list title for this first user message.
${CHAT_TITLE_STYLE}

Message:
`;

/** @type {{ email: string, sessionId: string, root?: string }[]} */
const queue = [];
let pumping = false;

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function titleFromAgentReply(raw) {
  return sanitizeChatTitle(raw);
}

/**
 * @param {{ email: string, sessionId: string, root?: string }} job
 */
export function enqueueChatTitle(job) {
  const email = String(job?.email || "").trim();
  const sessionId = String(job?.sessionId || "").trim();
  if (!email || !sessionId) return;
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
 * @param {{ email: string, sessionId: string, root?: string }} opts
 * @returns {Promise<string|null>}
 */
export async function generateAndStoreChatTitle(opts) {
  const loaded = await loadChatHistory(opts);
  if (!loaded) return null;
  if (loaded.title) return loaded.title;

  const seed = loaded.preview || loaded.messages.find((m) => m.role === "user")?.content || "";
  let title = "";
  try {
    title = await generateTitleWithAgent(seed);
  } catch (err) {
    console.warn(
      "[chat-title] agent failed; using preview",
      err instanceof Error ? err.message : err
    );
  }
  if (!title) title = fallbackChatTitle(seed);
  if (!title) return null;
  return patchChatHistoryTitle({
    email: opts.email,
    sessionId: opts.sessionId,
    title,
    root: opts.root,
  });
}

/**
 * @param {string} firstPrompt
 * @returns {Promise<string>}
 */
async function generateTitleWithAgent(firstPrompt) {
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
    if (!content && run && typeof run.wait === "function") {
      const result = await run.wait();
      content =
        result && typeof result.result === "string" ? result.result : "";
    }
    return titleFromAgentReply(content);
  } finally {
    await disposeCursorAgent(agent);
  }
}
