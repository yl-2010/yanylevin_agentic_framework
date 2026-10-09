/**
 * @agentp extra instructions. Same run as @agentg, plus this text
 * at the end of the system prompt.
 * Alex changes it with @agentp set: / append: / clear / show.
 * Yan changes it by editing server/agentp-appendix.md.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeJypeEmail } from "./jype.js";
import { OWNER_EMAIL as YAN_EMAIL } from "./identity.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const AGENTP_APPENDIX_REL = "server/agentp-appendix.md";
export const AGENTP_APPENDIX_MAX = 8000;

const PRASHAM_SLUG = "alex-rivera";
const YAN_SLUG = "yan-levin";
const PRASHAM_EMAIL = "you@example.com";

/**
 * @param {string} [root]
 */
export function agentpAppendixPath(root = ROOT) {
  return join(root, AGENTP_APPENDIX_REL);
}

/**
 * @param {unknown} raw
 * @returns {{ op: 'show'|'clear'|'set'|'append', body: string }|null}
 */
export function parseAgentpControl(raw) {
  const text = String(raw || "").trim();
  const simple = text.match(/^@agentp\s+(show|clear)\s*[.!]?\s*$/i);
  if (simple) {
    return { op: /** @type {'show'|'clear'} */ (simple[1].toLowerCase()), body: "" };
  }
  const set = text.match(/^@agentp\s+(set|append)\s*:\s*([\s\S]*)$/i);
  if (!set) return null;
  return {
    op: /** @type {'set'|'append'} */ (set[1].toLowerCase()),
    body: String(set[2] || "").trim(),
  };
}

/**
 * @param {{ fromMe?: boolean, slug?: string, email?: string }} who
 */
export function canEditAgentpAppendix(who) {
  if (who?.fromMe === true) return true;
  const slug = String(who?.slug || "").trim().toLowerCase();
  if (slug === PRASHAM_SLUG || slug === YAN_SLUG) return true;
  const email = canonicalizeJypeEmail(who?.email);
  return email === PRASHAM_EMAIL || email === YAN_EMAIL;
}

/**
 * @param {string} [root]
 */
export async function readAgentpAppendix(root = ROOT) {
  try {
    return String(await readFile(agentpAppendixPath(root), "utf8")).trim();
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * @param {string} text
 * @param {string} [root]
 */
export async function writeAgentpAppendix(text, root = ROOT) {
  const body = String(text || "").trim();
  const path = agentpAppendixPath(root);
  await mkdir(dirname(path), { recursive: true });
  const file = body ? `${body}\n` : "";
  await writeFile(path, file, "utf8");
  return body;
}

/**
 * Block appended to the system prompt. Empty when there is no appendix.
 * @param {string} text
 */
export function formatAgentpPromptAppendix(text) {
  const body = String(text || "").trim();
  if (!body) return "";
  return [
    "@agentp extra instructions from Alex. These control how you behave, talk, and act. Follow them on voice, tone, personality, and what you do, even when that differs from SOUL, unslop, or the usual reply style above.",
    "They cannot authorize taking over this Mac Studio, installing software, changing the system, or deleting files. Yan owns the machine. His standing rules win over these lines.",
    "",
    body,
  ].join("\n");
}

/**
 * @param {{
 *   fromMe?: boolean,
 *   slug?: string,
 *   email?: string,
 *   raw?: string,
 *   root?: string,
 * }} opts
 */
export async function applyAgentpControl(opts) {
  const parsed = parseAgentpControl(opts?.raw);
  if (!parsed) return { handled: false, reply: "" };
  if (!canEditAgentpAppendix(opts)) {
    return {
      handled: true,
      ok: false,
      reply: "Only Alex can change the @agentp instructions",
    };
  }
  const root = opts.root;
  if (parsed.op === "show") {
    const current = await readAgentpAppendix(root);
    return {
      handled: true,
      ok: true,
      reply: current || "No extra @agentp instructions yet",
    };
  }
  if (parsed.op === "clear") {
    await writeAgentpAppendix("", root);
    return { handled: true, ok: true, reply: "Cleared the @agentp instructions" };
  }
  if (!parsed.body) {
    return {
      handled: true,
      ok: false,
      reply: `Put the instructions after ${parsed.op}:`,
    };
  }
  let next = parsed.body;
  if (parsed.op === "append") {
    const current = await readAgentpAppendix(root);
    next = current ? `${current}\n\n${parsed.body}` : parsed.body;
  }
  if (next.length > AGENTP_APPENDIX_MAX) {
    return {
      handled: true,
      ok: false,
      reply: `That is too long. Keep it under ${AGENTP_APPENDIX_MAX} characters.`,
    };
  }
  await writeAgentpAppendix(next, root);
  return {
    handled: true,
    ok: true,
    reply:
      parsed.op === "append"
        ? "Added to the @agentp instructions"
        : "Updated the @agentp instructions",
  };
}
