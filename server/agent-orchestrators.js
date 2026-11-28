// One orchestrator session per Teams or iMessage chat and agent kind.
// Default file: data/agent-mentions/orchestrators.json (gitignored).
// The object key is the whole platform:chatId:kind string. Chat ids can
// contain colons, so nothing here splits a key.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ORCHESTRATOR_INDEX_PATH = join(
  repoRoot,
  "data",
  "agent-mentions",
  "orchestrators.json"
);

/**
 * @param {unknown} value
 */
function asString(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

/**
 * @param {unknown} value
 */
function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const ORIGIN_KEYS = ["to", "chat", "chatId", "handle", "key", "chatGuid", "messageGuid"];

/**
 * @param {unknown} value
 */
function sanitizeOrigin(value) {
  if (!plainObject(value)) return null;
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of ORIGIN_KEYS) {
    const text = asString(value[key]).slice(0, 200);
    if (text) out[key] = text;
  }
  if (!out.to && !out.chatId) return null;
  return out;
}

/**
 * @param {unknown} row
 * @returns {{ sessionId: string, cursorAgentId: string, workspace: "" | "jype", email: string, platform?: string, origin?: Record<string, string> }}
 */
function sanitizeRow(row) {
  const src = plainObject(row) ? row : {};
  const platform = asString(src.platform);
  const origin = sanitizeOrigin(src.origin);
  /** @type {{ sessionId: string, cursorAgentId: string, workspace: "" | "jype", email: string, platform?: string, origin?: Record<string, string> }} */
  const out = {
    sessionId: asString(src.sessionId),
    cursorAgentId: asString(src.cursorAgentId),
    workspace: asString(src.workspace) === "jype" ? "jype" : "",
    email: asString(src.email),
  };
  if (platform === "teams" || platform === "imessage") out.platform = platform;
  if (origin) out.origin = origin;
  return out;
}

/**
 * teams stays teams. Every other platform is imessage.
 * agentg and grok are agentg. Every other kind is agent.
 * An empty chat id returns "" so callers can skip the write.
 * @param {unknown} platform
 * @param {unknown} chatId
 * @param {unknown} kind
 */
export function orchestratorKey(platform, chatId, kind) {
  const id = asString(chatId);
  if (!id) return "";
  const plat = platform === "teams" ? "teams" : "imessage";
  const agentKind = kind === "agentg" || kind === "grok" ? "agentg" : "agent";
  return `${plat}:${id}:${agentKind}`;
}

/**
 * Missing file and invalid JSON both return {}.
 * @param {string} [path]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadOrchestratorIndex(path = ORCHESTRATOR_INDEX_PATH) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (!plainObject(raw)) return {};
    return raw;
  } catch {
    return {};
  }
}

/**
 * @param {unknown} key
 * @param {string} [path]
 */
export async function readOrchestrator(key, path = ORCHESTRATOR_INDEX_PATH) {
  const id = asString(key);
  if (!id) return null;
  const index = await loadOrchestratorIndex(path);
  const row = sanitizeRow(index[id]);
  if (!row.sessionId) return null;
  return row;
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} index
 */
async function saveIndex(path, index) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Merge one row into the index. Empty key is ignored.
 * @param {unknown} key
 * @param {unknown} row
 * @param {string} [path]
 */
export async function writeOrchestrator(key, row, path = ORCHESTRATOR_INDEX_PATH) {
  const id = asString(key);
  if (!id) return null;
  const index = await loadOrchestratorIndex(path);
  const clean = sanitizeRow(row);
  index[id] = clean;
  await saveIndex(path, index);
  return clean;
}

/**
 * Delete one key. Missing key leaves the file alone.
 * @param {unknown} key
 * @param {string} [path]
 */
export async function removeOrchestrator(key, path = ORCHESTRATOR_INDEX_PATH) {
  const id = asString(key);
  if (!id) return false;
  const index = await loadOrchestratorIndex(path);
  if (!Object.hasOwn(index, id)) return false;
  delete index[id];
  await saveIndex(path, index);
  return true;
}
