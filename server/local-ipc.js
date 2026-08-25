/**
 * Loopback Unix socket for Cursor-sandboxed agents. chat.db needs Full Disk
 * Access on the LaunchAgent node process; Cursor shells cannot open it.
 * Not exposed on :3004 / Cloudflare Tunnel.
 */

import http from "node:http";
import { chmod, unlink } from "node:fs/promises";
import {
  exportPersonThread,
  listIMessagePeople,
  recentMessages,
  recentThread,
  searchMessages,
} from "./imessage-read.js";
import { sendIMessage } from "./imessage-send.js";
import { recentSessions, screenTimeSummary } from "./screentime-read.js";

export const LOCAL_SOCK = "/tmp/personal-agent-local.sock";

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function queryOf(req) {
  try {
    return new URL(req.url || "/", "http://localhost").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function pathOf(req) {
  try {
    return new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

/**
 * @param {import("node:http").IncomingMessage & { body?: unknown }} req
 * @param {number} [limit]
 */
async function readJsonBody(req, limit = 512 * 1024) {
  if (req && Object.prototype.hasOwnProperty.call(req, "body")) {
    const body = req.body;
    if (body == null) return {};
    if (typeof body === "string") {
      const trimmed = body.trim();
      if (!trimmed) return {};
      try {
        return JSON.parse(trimmed);
      } catch {
        const err = new Error("invalid JSON");
        err.status = 400;
        throw err;
      }
    }
    return body;
  }
  if (!req || typeof req[Symbol.asyncIterator] !== "function") return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) {
      const err = new Error("body too large");
      err.status = 413;
      throw err;
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("invalid JSON");
    err.status = 400;
    throw err;
  }
}

/**
 * @param {{
 *   recentMessages?: typeof recentMessages,
 *   searchMessages?: typeof searchMessages,
 *   recentThread?: typeof recentThread,
 *   exportPersonThread?: typeof exportPersonThread,
 *   listIMessagePeople?: typeof listIMessagePeople,
 *   sendIMessage?: typeof sendIMessage,
 *   screenTimeSummary?: typeof screenTimeSummary,
 *   recentSessions?: typeof recentSessions,
 *   listContacts?: () => Promise<unknown>,
 *   listMailCorrespondents?: () => Promise<unknown>,
 *   loadSchoolNames?: () => Promise<unknown>,
 *   runContextSynthesis?: (opts: { force?: boolean, bootstrapPeople?: boolean }) => Promise<unknown>,
 * }} [deps]
 */
export function createLocalIpcHandler(deps = {}) {
  const recent = deps.recentMessages || recentMessages;
  const search = deps.searchMessages || searchMessages;
  const thread = deps.recentThread || recentThread;
  const exportThread = deps.exportPersonThread || exportPersonThread;
  const people = deps.listIMessagePeople || listIMessagePeople;
  const sendMsg = deps.sendIMessage || sendIMessage;
  const screenSummary = deps.screenTimeSummary || screenTimeSummary;
  const screenRecent = deps.recentSessions || recentSessions;
  const contacts =
    deps.listContacts ||
    (async () => {
      const { listContacts } = await import("./contacts-read.js");
      return listContacts();
    });
  const mailPeople =
    deps.listMailCorrespondents ||
    (async () => {
      const { listMailCorrespondents } = await import("./mail-people-read.js");
      return listMailCorrespondents();
    });
  const schoolNames =
    deps.loadSchoolNames ||
    (async () => {
      const { loadSchoolNames } = await import("./school-names-read.js");
      return loadSchoolNames();
    });
  const runSynth =
    deps.runContextSynthesis ||
    (async (opts) => {
      const { runContextSynthesis } = await import("./context-synthesis-agent.js");
      return runContextSynthesis(opts);
    });

  return async function localIpcHandler(req, res) {
    const method = String(req.method || "GET").toUpperCase();
    const path = pathOf(req);
    const q = queryOf(req);
    try {
      if (method === "GET" && path === "/health") {
        return sendJson(res, 200, { ok: true, service: "yanylevin-local-ipc" });
      }
      if (method === "GET" && path === "/imessage/recent") {
        const rows = await recent({
          since: q.get("since") || undefined,
          limit: q.get("limit") || undefined,
        });
        return sendJson(res, 200, rows);
      }
      if (method === "GET" && path === "/imessage/search") {
        const rows = await search(q.get("q") || "");
        return sendJson(res, 200, rows);
      }
      if (method === "GET" && path === "/imessage/thread") {
        const rows = await thread(q.get("person") || "", {
          limit: q.get("limit") || undefined,
        });
        return sendJson(res, 200, rows);
      }
      if (method === "GET" && path === "/imessage/people") {
        const rows = await people({
          limit: q.get("limit") || undefined,
        });
        return sendJson(res, 200, rows);
      }
      if (method === "POST" && path === "/imessage/export") {
        const payload = await readJsonBody(req);
        const handles = Array.isArray(payload?.handles)
          ? payload.handles
          : [payload?.person, payload?.handle].filter(Boolean);
        const result = await exportThread({
          slug: payload?.slug || "",
          handles,
          since: payload?.since || "",
          sharedChats: payload?.sharedChats === true,
        });
        return sendJson(res, 200, result);
      }
      if (method === "POST" && path === "/imessage/send") {
        const payload = await readJsonBody(req);
        const result = await sendMsg({
          to: payload?.to || payload?.person || "",
          text: payload?.text || payload?.body || "",
        });
        return sendJson(res, 200, result);
      }
      if (method === "GET" && path === "/screentime/summary") {
        const payload = await screenSummary({
          days: q.get("days") || undefined,
        });
        return sendJson(res, 200, payload);
      }
      if (method === "GET" && path === "/screentime/recent") {
        const rows = await screenRecent({
          since: q.get("since") || undefined,
          limit: q.get("limit") || undefined,
        });
        return sendJson(res, 200, rows);
      }
      if (method === "GET" && path === "/contacts/list") {
        const rows = await contacts();
        return sendJson(res, 200, rows);
      }
      if (method === "GET" && path === "/contacts/search") {
        const rows = await contacts();
        const list = Array.isArray(rows) ? rows : [];
        const { contactMatchesQuery } = await import("./contacts-read.js");
        return sendJson(
          res,
          200,
          list.filter((row) => contactMatchesQuery(row, q.get("q") || ""))
        );
      }
      if (method === "GET" && path === "/mail/people") {
        const payload = await mailPeople();
        return sendJson(res, 200, payload);
      }
      if (method === "GET" && path === "/school/names") {
        const payload = await schoolNames();
        return sendJson(res, 200, payload);
      }
      if (method === "POST" && path === "/jobs/context-synthesis") {
        runSynth({ force: true }).catch((err) => {
          console.error(
            "[local-ipc] context-synthesis failed",
            err instanceof Error ? err.message : err
          );
        });
        return sendJson(res, 202, { ok: true, started: true });
      }
      if (method === "POST" && path === "/jobs/bootstrap-people") {
        runSynth({ force: true, bootstrapPeople: true }).catch((err) => {
          console.error(
            "[local-ipc] bootstrap-people failed",
            err instanceof Error ? err.message : err
          );
        });
        return sendJson(res, 202, { ok: true, started: true, bootstrapPeople: true });
      }
      return sendJson(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      const status = Number(err?.status) || 500;
      return sendJson(res, status, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export function startLocalIpc() {
  const server = http.createServer(createLocalIpcHandler());
  const listen = async () => {
    try {
      await unlink(LOCAL_SOCK);
    } catch {
      /* no leftover */
    }
    server.listen(LOCAL_SOCK, async () => {
      try {
        await chmod(LOCAL_SOCK, 0o600);
      } catch (err) {
        console.warn(
          "[local-ipc] chmod failed",
          err instanceof Error ? err.message : err
        );
      }
      console.log(`[local-ipc] ${LOCAL_SOCK}`);
    });
  };
  listen().catch((err) => {
    console.error("[local-ipc] listen failed", err);
  });
  return server;
}
