/**
 * Send a WhatsApp message by driving WhatsApp.app.
 * The Mac app has no send API. Menu and click actions work. The composer
 * takes a paste and Return.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isWhatsAppAgentPaused } from "./whatsapp-agent-mentions.js";
import { WHATSAPP_AGENT_ENABLED } from "./whatsapp-mention.js";
import { findWhatsAppChat, recentMessages } from "./whatsapp-read.js";

const execFileAsync = promisify(execFile);
const ROOT = dirname(fileURLToPath(import.meta.url));
export const WHATSAPP_SEND_SCRIPT = join(ROOT, "whatsapp-send.applescript");

/** @type {Promise<void>} */
let tail = Promise.resolve();

function statusError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * One UI send at a time. Two replies pasting at once would cross chats.
 * @param {() => Promise<T>} fn
 * @template T
 */
function enqueue(fn) {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function setClipboardFile(file) {
  const quoted = `'${String(file).replaceAll("'", "'\\''")}'`;
  await execFileAsync(
    "/bin/zsh",
    ["-c", `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; pbcopy < ${quoted}`],
    { timeout: 5_000, env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } }
  );
}

/**
 * @param {string} chat
 * @param {"send"|"open"} mode
 */
async function runScript(chat, mode) {
  const { stdout } = await execFileAsync(
    "osascript",
    [WHATSAPP_SEND_SCRIPT, chat, mode],
    { timeout: 45_000, maxBuffer: 1024 * 1024 }
  );
  return String(stdout || "").trim();
}

/** Strip footer and punctuation noise so DB mojibake still matches. */
function normalizeOutgoingBody(raw) {
  let s = String(raw || "");
  const footer = "\n\n// Sent by Yan's Personal Agent";
  if (s.endsWith(footer)) s = s.slice(0, -footer.length);
  s = s.replaceAll("`", "").replaceAll(/\s+/g, " ").trim().toLowerCase();
  return s.replaceAll(/[^\p{L}\p{N}@.' ]+/gu, " ").replaceAll(/\s+/g, " ").trim();
}

/**
 * @param {import("./whatsapp-read.js").WhatsAppRow[]} rows
 * @param {string} chat
 * @param {string} [chatJid]
 * @param {string} text
 * @param {{ minAt?: number }} [opts]
 */
function findOutgoing(rows, chat, chatJid, text, opts = {}) {
  const needle = normalizeOutgoingBody(text).slice(0, 72);
  if (!needle) return null;
  const minAt = opts.minAt ?? 0;
  return (
    rows.find((row) => {
      if (row.fromMe !== true) return false;
      if (chatJid && row.chatJid && row.chatJid !== chatJid) return false;
      if (!chatJid && row.chat !== chat) return false;
      const body = normalizeOutgoingBody(row.text);
      if (!body.includes(needle) && !needle.includes(body.slice(0, 72))) return false;
      const at = Date.parse(String(row.at || ""));
      return Number.isFinite(at) && at >= minAt;
    }) || null
  );
}

/**
 * @param {string} chat
 * @param {string} text
 * @param {string} [chatJid]
 */
async function waitForOutgoing(chat, text, chatJid) {
  const started = Date.now();
  while (Date.now() - started < 12_000) {
    const rows = await recentMessages({ limit: 20 });
    const hit = findOutgoing(rows, chat, chatJid, text, {
      minAt: started - 20_000,
    });
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/**
 * @param {{ to?: string, text?: string, chat?: string, chatJid?: string, openOnly?: boolean }} opts
 */
export async function sendWhatsApp(opts) {
  return enqueue(() => sendWhatsAppNow(opts));
}

/**
 * @param {{ to?: string, text?: string, chat?: string, chatJid?: string, openOnly?: boolean }} opts
 */
export async function sendWhatsAppNow(opts) {
  if (!WHATSAPP_AGENT_ENABLED || isWhatsAppAgentPaused()) {
    throw statusError("WhatsApp agent is off", 503);
  }
  const text = String(opts?.text || "").trim();
  const openOnly = opts?.openOnly === true;
  if (!text && !openOnly) throw statusError("text required", 400);
  const hint = String(opts?.chat || opts?.to || "").trim();
  const jid = String(opts?.chatJid || "").trim();
  const found =
    (jid && (await findWhatsAppChat(jid))) ||
    (hint && (await findWhatsAppChat(hint))) ||
    null;
  if (!found?.chat) {
    throw statusError(`no WhatsApp chat for ${hint || jid || "(empty)"}`, 404);
  }
  if (openOnly) {
    const via = await runScript(found.chat, "open");
    return { ok: true, to: found.chat, chatJid: found.chatJid, via };
  }
  const recent = await recentMessages({ limit: 25 });
  const already = findOutgoing(recent, found.chat, found.chatJid, text, {
    minAt: Date.now() - 5 * 60_000,
  });
  if (already) {
    return {
      ok: true,
      to: found.chat,
      chatJid: found.chatJid,
      via: "dedupe",
      id: already.id,
    };
  }
  const dir = await mkdtemp(join(tmpdir(), "wa-send-"));
  const bodyPath = join(dir, "body.txt");
  try {
    await writeFile(bodyPath, text, "utf8");
    await setClipboardFile(bodyPath);
    const via = await runScript(found.chat, "send");
    let landed = await waitForOutgoing(found.chat, text, found.chatJid);
    if (!landed) {
      const rows = await recentMessages({ limit: 25 });
      landed = findOutgoing(rows, found.chat, found.chatJid, text, {
        minAt: Date.now() - 3 * 60_000,
      });
    }
    if (!landed) {
      throw statusError(
        `WhatsApp send was not stored in ${found.chat}. The composer may have missed the paste.`,
        502
      );
    }
    return {
      ok: true,
      to: found.chat,
      chatJid: found.chatJid,
      via,
      id: landed.id,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
