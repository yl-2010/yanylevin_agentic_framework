// Post-turn brain extraction (decision D12/R6): after every Yan Express turn,
// a Composer 2.5 (not fast) pass checks whether facts from the turn belong in
// the brain and writes timeline entries / frontmatter fields / identity lines
// the in-chat agent missed. Backstop only; the Personal Agent's same-turn
// write rule is the primary path, and the nightly lint phase dedupes.
// Serial queue so extractions never write the brain concurrently.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitAddCommitPush } from "./git-publish.js";
import { promptWithAuthRetry } from "./cursor-sdk-auth.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRAIN_REL = "education/you@example.com/brain";
const YAN = "you@example.com";
const MAX_TEXT = 6000;

const EXTRACTION_MODEL = {
  id: process.env.CURSOR_BRAIN_EXTRACTION_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

/** @type {Promise<unknown>} */
let queue = Promise.resolve();

/**
 * @param {{ userText?: string, assistantText?: string }} turn
 */
export function buildExtractionPrompt({ userText, assistantText }) {
  const clip = (s) => String(s || "").slice(0, MAX_TEXT);
  return [
    "You are the post-turn brain extraction pass for Yan (you@example.com). Yan only.",
    "Local only. Never spawn a Cursor cloud agent.  No sends, no education or calendar writes.",
    `Follow the entity contract in ${BRAIN_REL}/schema.md and the write rules in .cursor/skills/personal-people/SKILL.md.`,
    "Below is one Personal Agent chat turn. Decide whether Yan stated durable facts or corrections the brain should hold.",
    "Allowed writes ONLY:",
    `- append a dated timeline entry (- YYYY-MM-DD | fact [chat]) on an existing entity under ${BRAIN_REL}/people|groups|orgs|places`,
    "- update a frontmatter field (schema rules) and bump last_touched",
    `- edit or add a short standing line in ${BRAIN_REL}/identity.md or identity-school.md / identity-accounts.md / identity-logistics.md, or a ${BRAIN_REL}/threads/ page, for facts about Yan himself. Rewrite the line. Do not append into a mega-bullet. Dated events go to the matching org or thread.`,
    "Person spelling, emails, nicknames, phones, birthdays, deaths, and jobs never go on identity.md as prose. Those stay on the person card. Identity people lines are name, role, and a people/slug pointer. You may still edit identity.md for Yan facts.",
    "Never write prose sections, never create new entity cards, never edit generated files, never touch journal/ or patterns.md.",
    "First pull the entity card (node server/brain-entity-card.js <slug>) and check the fact is not already there; the in-chat agent may have written it this turn. Duplicate means do nothing.",
    "Questions, chit-chat, coding requests, and agent instructions are not brain facts. When in doubt, do nothing.",
    "",
    "=== Yan said ===",
    clip(userText),
    "",
    "=== Agent replied ===",
    clip(assistantText),
    "",
    'Reply with one line: "wrote: <what and where>" or "nothing".',
  ].join("\n");
}

/**
 * Fire-and-forget. Never throws into the caller.
 * @param {{ email: string, sessionId: string, userText: string, assistantText: string }} opts
 */
export function enqueueBrainExtraction({ email, sessionId, userText, assistantText }) {
  if (String(email || "").toLowerCase() !== YAN) return;
  if (!String(userText || "").trim()) return;
  queue = queue
    .then(async () => {
      const t0 = Date.now();
      const { result, transientFailed } = await promptWithAuthRetry({
        prefix: "brain-extraction",
        prompt: buildExtractionPrompt({ userText, assistantText }),
        model: EXTRACTION_MODEL,
        cwd: REPO_ROOT,
        laterDelaysMs: [],
      });
      const secs = Math.round((Date.now() - t0) / 1000);
      if (transientFailed) {
        console.warn(`[brain-extraction] ${sessionId} failed in ${secs}s (skipped; nightly covers it)`);
        return;
      }
      console.log(
        `[brain-extraction] ${sessionId} status=${result?.status || "finished"} in ${secs}s`
      );
      await gitAddCommitPush({
        paths: [BRAIN_REL],
        message: "education: chat-turn brain extraction",
      }).catch(() => {});
    })
    .catch((err) => {
      console.error("[brain-extraction]", err instanceof Error ? err.message : err);
    });
}
