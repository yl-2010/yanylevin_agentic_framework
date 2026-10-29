/**
 * Server-synced chat composer drafts so web and iOS share unsent text and files.
 * Stored next to .chat-history in each workspace root:
 *   <root>/.chat-drafts/<draftId>.json
 *   <root>/.chat-drafts/<draftId>/<fileId>-<name>
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import express from "express";
import { sanitizeSessionId } from "./education-chat-history.js";
import { userEducationRoot } from "./education-data.js";
import { canonicalizeEmail } from "./identity.js";
import { notifyEducationClients } from "./education-events.js";
import { normalizeJypeWorkspace } from "./jype.js";

export const CHAT_DRAFTS_DIRNAME = ".chat-drafts";
export const DRAFT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const MAX_DRAFT_FILES = 16;
export const MAX_DRAFT_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_DRAFT_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_DRAFT_TEXT = 100_000;
export const DRAFT_TITLE_MAX = 80;
const FILENAME_MAX = 180;

/**
 * @typedef {{ id: string, name: string, mimeType: string, size: number }} DraftFile
 * @typedef {DraftFile & { stored: string }} StoredDraftFile
 * @typedef {{
 *   id: string,
 *   sessionId: string|null,
 *   text: string,
 *   files: StoredDraftFile[],
 *   created: string,
 *   updated: string,
 * }} StoredDraft
 * @typedef {{
 *   id: string,
 *   sessionId: string|null,
 *   text: string,
 *   title: string,
 *   files: DraftFile[],
 *   created: string,
 *   updated: string,
 * }} Draft
 */

function badRequest(message) {
  const err = new Error(message);
  /** @type {any} */ (err).status = 400;
  return err;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function assertDraftId(raw) {
  const id = typeof raw === "string" ? raw : "";
  if (!DRAFT_ID_RE.test(id)) throw badRequest("invalid draft id");
  return id;
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isValidDraftId(raw) {
  return typeof raw === "string" && DRAFT_ID_RE.test(raw);
}

/**
 * @param {unknown} text
 * @param {{ name?: string }[]} [files]
 * @returns {string}
 */
export function draftTitle(text, files = []) {
  const line =
    String(text || "")
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .find(Boolean) || "";
  if (line) return line.slice(0, DRAFT_TITLE_MAX).trim();
  const first = Array.isArray(files) ? files[0]?.name : "";
  if (first) return String(first).slice(0, DRAFT_TITLE_MAX).trim();
  return "Draft";
}

/**
 * Same rules as personal-agent's sanitizeFilename, capped so
 * "<fileId>-<name>" stays under the 255-byte filename limit.
 * @param {unknown} name
 */
export function sanitizeDraftFilename(name) {
  const base = basename(String(name || "file").replace(/\\/g, "/"));
  let cleaned = base
    .replace(/[^\w.\- ()[\]]+/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (cleaned.length > FILENAME_MAX) {
    const ext = extname(cleaned).slice(0, 20);
    cleaned = cleaned.slice(0, FILENAME_MAX - ext.length).trim() + ext;
  }
  return cleaned || "file";
}

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

/**
 * @param {unknown} mimeType
 * @param {string} filename
 */
export function guessDraftMime(mimeType, filename) {
  const mt = String(mimeType || "")
    .trim()
    .toLowerCase();
  if (mt && mt !== "application/octet-stream") return mt;
  const ext = extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] || mt || "application/octet-stream";
}

/**
 * Drafts live next to .chat-history: education/<email>/ or the JYPE root.
 * JYPE history is shared by the group, but drafts stay per member.
 * @param {string} email
 * @param {unknown} [workspace]
 */
export function chatDraftsRoot(email, workspace) {
  const ws = normalizeJypeWorkspace(workspace);
  const root = userEducationRoot(email, { workspace: ws });
  if (!ws) return root;
  const member = canonicalizeEmail(email).replace(/[^a-z0-9@._-]/g, "_");
  return join(root, CHAT_DRAFTS_DIRNAME, "members", member || "unknown");
}

function draftsDir(root) {
  return join(root, CHAT_DRAFTS_DIRNAME);
}

function draftJsonPath(root, id) {
  return join(draftsDir(root), `${id}.json`);
}

function draftFilesDir(root, id) {
  return join(draftsDir(root), id);
}

/** @type {Map<string, Promise<unknown>>} */
const locks = new Map();

/**
 * Serialize read-modify-write per draft. Parallel uploads to one draft are normal.
 * @template T
 * @param {string} root
 * @param {string} id
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withDraftLock(root, id, fn) {
  const key = `${root}\0${id}`;
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

/**
 * @param {unknown} raw
 * @returns {StoredDraft|null}
 */
function parseStoredDraft(raw, id) {
  if (!raw || typeof raw !== "object") return null;
  const r = /** @type {any} */ (raw);
  const files = Array.isArray(r.files)
    ? r.files
        .filter((f) => f && isValidDraftId(f.id) && typeof f.stored === "string")
        .map((f) => ({
          id: f.id,
          name: String(f.name || "file"),
          mimeType: String(f.mimeType || "application/octet-stream"),
          size: Number(f.size) || 0,
          stored: basename(f.stored),
        }))
    : [];
  const now = new Date().toISOString();
  return {
    id,
    sessionId: sanitizeSessionId(r.sessionId) || null,
    text: typeof r.text === "string" ? r.text : "",
    files,
    created: String(r.created || r.updated || now),
    updated: String(r.updated || r.created || now),
  };
}

/**
 * @param {string} root
 * @param {string} id
 * @returns {Promise<StoredDraft|null>}
 */
async function readStoredDraft(root, id) {
  let raw;
  try {
    raw = await readFile(draftJsonPath(root, id), "utf8");
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return null;
    throw err;
  }
  try {
    return parseStoredDraft(JSON.parse(raw), id);
  } catch {
    return null;
  }
}

/**
 * @param {string} root
 * @param {StoredDraft} draft
 */
async function writeStoredDraft(root, draft) {
  const dir = draftsDir(root);
  await mkdir(dir, { recursive: true });
  const final = draftJsonPath(root, draft.id);
  const tmp = `${final}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
  await rename(tmp, final);
}

/**
 * @param {StoredDraft|null} draft
 * @returns {Draft|null}
 */
function publicDraft(draft) {
  if (!draft) return null;
  const files = draft.files.map(({ id, name, mimeType, size }) => ({
    id,
    name,
    mimeType,
    size,
  }));
  return {
    id: draft.id,
    sessionId: draft.sessionId,
    text: draft.text,
    title: draftTitle(draft.text, files),
    files,
    created: draft.created,
    updated: draft.updated,
  };
}

/**
 * @param {StoredDraft} draft
 */
function draftIsEmpty(draft) {
  return !draft.text.trim() && !draft.files.length;
}

function newStoredDraft(id) {
  const now = new Date().toISOString();
  return { id, sessionId: null, text: "", files: [], created: now, updated: now };
}

/**
 * @param {StoredDraft} draft
 */
function touch(draft) {
  const now = Date.now();
  const prev = Date.parse(draft.updated);
  draft.updated = new Date(
    Number.isFinite(prev) && prev >= now ? prev + 1 : now
  ).toISOString();
}

/**
 * Apply a sessionId from the client. undefined keeps the current value.
 * @param {StoredDraft} draft
 * @param {unknown} sessionId
 */
function applySessionId(draft, sessionId) {
  if (sessionId === undefined) return;
  draft.sessionId = sanitizeSessionId(sessionId) || null;
}

async function removeDraftFromDisk(root, id) {
  await rm(draftJsonPath(root, id), { force: true });
  await rm(draftFilesDir(root, id), { recursive: true, force: true });
}

/**
 * @param {string} root
 * @returns {Promise<Draft[]>} newest first
 */
export async function listDrafts(root) {
  let names;
  try {
    names = await readdir(draftsDir(root));
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return [];
    throw err;
  }
  /** @type {Draft[]} */
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!isValidDraftId(id)) continue;
    const draft = publicDraft(await readStoredDraft(root, id));
    if (draft) out.push(draft);
  }
  out.sort((a, b) => (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0));
  return out;
}

/**
 * @param {string} root
 * @param {unknown} id
 * @returns {Promise<Draft|null>}
 */
export async function getDraft(root, id) {
  return publicDraft(await readStoredDraft(root, assertDraftId(id)));
}

/**
 * Save composer text. Blank text with no files deletes the draft.
 * @param {string} root
 * @param {unknown} idRaw
 * @param {{ text?: unknown, sessionId?: unknown }} input
 * @returns {Promise<Draft|null>}
 */
export async function saveDraftText(root, idRaw, input = {}) {
  const id = assertDraftId(idRaw);
  if (typeof input.text !== "string") throw badRequest("text must be a string");
  if (input.text.length > MAX_DRAFT_TEXT) {
    throw badRequest(`draft text exceeds ${MAX_DRAFT_TEXT} characters`);
  }
  const text = input.text;
  return withDraftLock(root, id, async () => {
    const draft = (await readStoredDraft(root, id)) || newStoredDraft(id);
    draft.text = text;
    applySessionId(draft, input.sessionId);
    if (draftIsEmpty(draft)) {
      await removeDraftFromDisk(root, id);
      return null;
    }
    touch(draft);
    await writeStoredDraft(root, draft);
    return publicDraft(draft);
  });
}

/**
 * Store one file's bytes on a draft. Creates the draft if missing.
 * @param {string} root
 * @param {unknown} idRaw
 * @param {{ name?: unknown, mimeType?: unknown, data: unknown, sessionId?: unknown }} input
 * @returns {Promise<{ file: DraftFile, draft: Draft }>}
 */
export async function addDraftFile(root, idRaw, input) {
  const id = assertDraftId(idRaw);
  const data = input?.data;
  if (!Buffer.isBuffer(data) || !data.length) throw badRequest("file is empty");
  if (data.length > MAX_DRAFT_FILE_BYTES) {
    throw badRequest(
      `file exceeds ${Math.round(MAX_DRAFT_FILE_BYTES / (1024 * 1024))}MB`
    );
  }
  const name = sanitizeDraftFilename(input?.name);
  const mimeType = guessDraftMime(input?.mimeType, name);
  return withDraftLock(root, id, async () => {
    const draft = (await readStoredDraft(root, id)) || newStoredDraft(id);
    if (draft.files.length >= MAX_DRAFT_FILES) {
      throw badRequest(`at most ${MAX_DRAFT_FILES} files per draft`);
    }
    const total = draft.files.reduce((n, f) => n + f.size, 0) + data.length;
    if (total > MAX_DRAFT_TOTAL_BYTES) {
      throw badRequest(
        `draft files total size exceeds ${Math.round(MAX_DRAFT_TOTAL_BYTES / (1024 * 1024))}MB`
      );
    }
    const fileId = randomBytes(6).toString("base64url");
    const stored = `${fileId}-${name}`;
    const dir = draftFilesDir(root, id);
    await mkdir(dir, { recursive: true });
    const abs = join(dir, stored);
    await writeFile(abs, data);
    /** @type {StoredDraftFile} */
    const file = { id: fileId, name, mimeType, size: data.length, stored };
    draft.files.push(file);
    applySessionId(draft, input?.sessionId);
    touch(draft);
    try {
      await writeStoredDraft(root, draft);
    } catch (err) {
      await rm(abs, { force: true });
      throw err;
    }
    return {
      file: { id: fileId, name, mimeType, size: data.length },
      draft: /** @type {Draft} */ (publicDraft(draft)),
    };
  });
}

/**
 * Drop one file. Deletes the draft when nothing is left.
 * @param {string} root
 * @param {unknown} idRaw
 * @param {unknown} fileIdRaw
 * @returns {Promise<Draft|null>}
 */
export async function removeDraftFile(root, idRaw, fileIdRaw) {
  const id = assertDraftId(idRaw);
  if (!isValidDraftId(fileIdRaw)) throw badRequest("invalid file id");
  const fileId = /** @type {string} */ (fileIdRaw);
  return withDraftLock(root, id, async () => {
    const draft = await readStoredDraft(root, id);
    if (!draft) return null;
    const file = draft.files.find((f) => f.id === fileId);
    if (file) {
      draft.files = draft.files.filter((f) => f.id !== fileId);
      await rm(join(draftFilesDir(root, id), file.stored), { force: true });
    }
    if (draftIsEmpty(draft)) {
      await removeDraftFromDisk(root, id);
      return null;
    }
    if (file) {
      touch(draft);
      await writeStoredDraft(root, draft);
    }
    return publicDraft(draft);
  });
}

/**
 * Idempotent.
 * @param {string} root
 * @param {unknown} idRaw
 */
export async function deleteDraft(root, idRaw) {
  const id = assertDraftId(idRaw);
  await withDraftLock(root, id, () => removeDraftFromDisk(root, id));
}

/**
 * Draft files still on disk, with absolute paths for staging into a chat.
 * Does not delete anything; call deleteDraft after the message is accepted.
 * Unknown or invalid ids return [].
 * @param {string} root
 * @param {unknown} idRaw
 * @returns {Promise<{ id: string, name: string, mimeType: string, size: number, path: string }[]>}
 */
export async function takeDraftFiles(root, idRaw) {
  if (!isValidDraftId(idRaw)) return [];
  const id = /** @type {string} */ (idRaw);
  const draft = await readStoredDraft(root, id);
  if (!draft) return [];
  const out = [];
  for (const f of draft.files) {
    const path = join(draftFilesDir(root, id), f.stored);
    try {
      const st = await stat(path);
      if (!st.isFile() || !st.size) continue;
      out.push({ id: f.id, name: f.name, mimeType: f.mimeType, size: st.size, path });
    } catch {
      /* file vanished */
    }
  }
  return out;
}

/**
 * @param {unknown} raw
 */
function decodeHeaderName(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Register P/drafts routes for one workspace.
 * @param {import('express').Express} app
 * @param {{
 *   prefix: string,
 *   guard: import('express').RequestHandler,
 *   workspace?: string,
 * }} opts
 */
export function attachChatDraftRoutes(app, opts) {
  const { prefix, guard } = opts;
  const workspace = normalizeJypeWorkspace(opts.workspace);
  const label = `${prefix}/drafts`;
  // Auth runs before this so unauthenticated uploads are never buffered.
  const rawParser = express.raw({ type: () => true, limit: "70mb" });

  /** @type {import('express').RequestHandler} */
  function rawBody(req, res, next) {
    rawParser(req, res, (err) => {
      if (!err) {
        next();
        return;
      }
      const tooLarge = err?.type === "entity.too.large";
      res.status(tooLarge ? 400 : err?.status || 400).json({
        ok: false,
        error: tooLarge
          ? `file exceeds ${Math.round(MAX_DRAFT_FILE_BYTES / (1024 * 1024))}MB`
          : err?.message || "bad upload body",
      });
    });
  }

  const rootFor = (req) => chatDraftsRoot(req.user.email, workspace);
  const notify = (req, draftId) => {
    notifyEducationClients(req.user.email, "change", {
      source: "drafts",
      draftId,
      ...(workspace ? { workspace } : {}),
    });
  };
  const fail = (res, where, err, fallback) => {
    if ((err?.status || 500) >= 500) console.error(`[${where}]`, err);
    res.status(err?.status || 500).json({
      ok: false,
      error: err?.message || fallback,
    });
  };

  app.get(`${prefix}/drafts`, guard, async (req, res) => {
    try {
      const drafts = await listDrafts(rootFor(req));
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, drafts });
    } catch (err) {
      fail(res, label, err, "drafts failed");
    }
  });

  app.put(`${prefix}/drafts/:id`, guard, async (req, res) => {
    try {
      const id = assertDraftId(req.params.id);
      const draft = await saveDraftText(rootFor(req), id, {
        text: req.body?.text,
        sessionId: req.body?.sessionId,
      });
      notify(req, id);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, draft });
    } catch (err) {
      fail(res, label, err, "draft save failed");
    }
  });

  app.post(`${prefix}/drafts/:id/files`, guard, rawBody, async (req, res) => {
    try {
      const id = assertDraftId(req.params.id);
      if (!Buffer.isBuffer(req.body)) {
        throw badRequest("send file bytes as application/octet-stream");
      }
      const result = await addDraftFile(rootFor(req), id, {
        name: decodeHeaderName(req.get("X-File-Name")),
        mimeType: req.get("X-File-Type") || "",
        data: req.body,
        sessionId: req.get("X-Session-Id") || undefined,
      });
      notify(req, id);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, ...result });
    } catch (err) {
      fail(res, label, err, "draft upload failed");
    }
  });

  app.delete(`${prefix}/drafts/:id/files/:fileId`, guard, async (req, res) => {
    try {
      const id = assertDraftId(req.params.id);
      const draft = await removeDraftFile(rootFor(req), id, req.params.fileId);
      notify(req, id);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, draft });
    } catch (err) {
      fail(res, label, err, "draft file delete failed");
    }
  });

  app.delete(`${prefix}/drafts/:id`, guard, async (req, res) => {
    try {
      const id = assertDraftId(req.params.id);
      await deleteDraft(rootFor(req), id);
      notify(req, id);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true });
    } catch (err) {
      fail(res, label, err, "draft delete failed");
    }
  });
}

/**
 * Draft files for /agent/message plus a cleanup to run once the message is accepted.
 * @param {string} email
 * @param {unknown} workspace
 * @param {unknown} draftIdRaw
 */
export async function loadMessageDraft(email, workspace, draftIdRaw) {
  if (!isValidDraftId(draftIdRaw)) {
    return { files: [], consume: async () => {} };
  }
  const id = /** @type {string} */ (draftIdRaw);
  const ws = normalizeJypeWorkspace(workspace);
  const root = chatDraftsRoot(email, ws);
  const files = await takeDraftFiles(root, id);
  return {
    files,
    consume: async () => {
      try {
        await deleteDraft(root, id);
        notifyEducationClients(email, "change", {
          source: "drafts",
          draftId: id,
          ...(ws ? { workspace: ws } : {}),
        });
      } catch (err) {
        console.error("[chat-drafts] consume", err);
      }
    },
  };
}
