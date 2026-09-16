/**
 * SSE live updates when education/<email>/** changes,
 * plus in-process broadcasts (e.g. agent status) for instant clients.
 */

import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalizeEmail } from "./identity.js";
import { userEducationRoot } from "./education-data.js";
import { gradeDirFromMeta } from "./education-onedrive.js";

/** @type {Map<string, Set<(event: string, data: object) => void>>} */
const listenersByEmail = new Map();

/**
 * Push an SSE event to all live education event subscribers for this user.
 * Used for filesystem changes and agent status (same "change" path clients already handle).
 * @param {string} email
 * @param {string} [event='change']
 * @param {object} [data]
 */
export function notifyEducationClients(email, event = "change", data = {}) {
  const workspace = String(data?.workspace || "").trim().toLowerCase();
  const key = workspace === "jype" ? "jype" : canonicalizeEmail(email);
  const set = listenersByEmail.get(key);
  if (!set || !set.size) return;
  const payload = {
    at: new Date().toISOString(),
    ...data,
  };
  for (const send of set) {
    try {
      send(event, payload);
    } catch {
      /* ignore broken listener */
    }
  }
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} email
 */
export function attachEducationEvents(req, res, email, opts = {}) {
  const workspace = String(opts.workspace || "").trim().toLowerCase();
  const normalized = canonicalizeEmail(email);
  const listenerKey = workspace === "jype" ? "jype" : normalized;
  const root = userEducationRoot(normalized, { workspace });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store, no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!listenersByEmail.has(listenerKey)) {
    listenersByEmail.set(listenerKey, new Set());
  }
  listenersByEmail.get(listenerKey).add(send);

  send("ready", {
    email: normalized,
    workspace: workspace || "",
    root: workspace === "jype" ? "education/projects/jype" : `education/${normalized}`,
  });

  let timer = null;
  const bump = (filename) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      send("change", {
        path: filename || "",
        at: new Date().toISOString(),
      });
    }, 200);
  };

  let watcher;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      bump(filename ? String(filename) : "");
    });
  } catch (err) {
    send("error", {
      error: err instanceof Error ? err.message : "watch failed",
    });
  }

  /** @type {import('node:fs').FSWatcher|null} */
  let driveWatcher = null;
  let closed = false;
  readFile(join(root, "meta.json"), "utf8")
    .then((raw) => {
      if (closed) return;
      let meta = {};
      try {
        meta = JSON.parse(raw);
      } catch {
        return;
      }
      const gradeDir = gradeDirFromMeta(meta);
      if (!gradeDir) return;
      driveWatcher = watch(gradeDir, { recursive: true }, (_event, filename) => {
        bump(filename ? `onedrive:${String(filename)}` : "onedrive");
      });
    })
    .catch(() => {
      /* no OneDrive watch */
    });

  const heartbeat = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 25000);

  const cleanup = () => {
    closed = true;
    clearInterval(heartbeat);
    if (timer) clearTimeout(timer);
    try {
      watcher?.close();
    } catch {
      /* ignore */
    }
    try {
      driveWatcher?.close();
    } catch {
      /* ignore */
    }
    const set = listenersByEmail.get(listenerKey);
    if (set) {
      set.delete(send);
      if (!set.size) listenersByEmail.delete(listenerKey);
    }
  };

  req.on("close", cleanup);
  res.on("close", cleanup);
}
