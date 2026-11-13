/**
 * Long-lived Personal Agent worker. Owns Cursor SDK agents, sessions, turn
 * queues, channel replies, the @agent mention pollers, and the future-agent
 * scheduler. The Express API (index.js) proxies to it over loopback HTTP, so
 * `launchctl kickstart -k com.personalagent.server` no longer kills running turns.
 *
 *   POST /rpc     { method, args } -> personal-agent.js export
 *   GET  /events  SSE of every notifyEducationClients call in this process
 *   GET  /health
 *   POST /restart-when-idle  exit once no chat is running or queued; launchd
 *                            (KeepAlive) starts the new code. An agent can ask
 *                            for this mid-turn: its own turn finishes first.
 *
 * Run: node --env-file=.env agent-worker.js (LaunchAgent com.personalagent.agent-worker).
 */

import http from "node:http";
import { fileURLToPath } from "node:url";
import {
  AGENT_WORKER_HOST,
  AGENT_WORKER_METHODS,
  AGENT_WORKER_PORT,
} from "./agent-worker-protocol.js";

const STARTED_AT = new Date().toISOString();

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

/** @param {import("node:http").IncomingMessage} req */
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/**
 * @param {{
 *   handlers: Record<string, (...args: any[]) => unknown>,
 *   onNotify: (fn: (email: string, event: string, data: object) => void) => () => void,
 *   heartbeatMs?: number,
 *   stats?: () => object,
 *   busy?: () => number,
 *   exit?: () => void,
 *   idlePollMs?: number,
 * }} opts
 */
export function createAgentWorkerServer({
  handlers,
  onNotify,
  heartbeatMs = 15_000,
  stats,
  busy = () => 0,
  exit = () => process.exit(0),
  idlePollMs = 2000,
}) {
  /** @type {Set<import("node:http").ServerResponse>} */
  const streams = new Set();

  onNotify((email, event, data) => {
    if (!streams.size) return;
    const line = `event: notify\ndata: ${JSON.stringify({ email, event, data })}\n\n`;
    for (const res of streams) {
      try {
        res.write(line);
      } catch {
        /* closed */
      }
    }
  });

  /** @type {ReturnType<typeof setInterval>|null} */
  let restartTimer = null;
  let restartRequestedAt = "";

  function requestRestartWhenIdle() {
    if (restartTimer) return;
    restartRequestedAt = new Date().toISOString();
    console.log("[agent-worker] restart requested; exiting once idle");
    const check = () => {
      if (busy() > 0) return;
      if (restartTimer) clearInterval(restartTimer);
      restartTimer = null;
      console.log("[agent-worker] idle; exiting for restart");
      exit();
    };
    restartTimer = setInterval(check, idlePollMs);
    // Let the HTTP reply go out before a no-op exit.
    setTimeout(check, 50);
  }

  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://localhost").pathname;
    try {
      if (req.method === "GET" && path === "/health") {
        return sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          startedAt: STARTED_AT,
          streams: streams.size,
          restartPending: Boolean(restartTimer),
          ...(restartRequestedAt ? { restartRequestedAt } : {}),
          ...(stats ? stats() : {}),
        });
      }
      if (req.method === "GET" && path === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        res.write(
          `event: hello\ndata: ${JSON.stringify({ pid: process.pid, startedAt: STARTED_AT })}\n\n`
        );
        streams.add(res);
        const beat = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), heartbeatMs);
        beat.unref?.();
        const drop = () => {
          clearInterval(beat);
          streams.delete(res);
        };
        req.on("close", drop);
        res.on("close", drop);
        return;
      }
      if (req.method === "POST" && path === "/restart-when-idle") {
        requestRestartWhenIdle();
        return sendJson(res, 200, { ok: true, busySessions: busy() });
      }
      if (req.method === "POST" && path === "/rpc") {
        const body = await readJson(req);
        const method = String(body?.method || "");
        const args = Array.isArray(body?.args) ? body.args : [];
        const fn = AGENT_WORKER_METHODS.includes(method) ? handlers[method] : null;
        if (typeof fn !== "function") {
          return sendJson(res, 404, { ok: false, error: `unknown method ${method}` });
        }
        try {
          const result = await fn(...args);
          return sendJson(res, 200, { ok: true, result: result ?? null });
        } catch (err) {
          const e = /** @type {{ status?: number, message?: string }} */ (err || {});
          return sendJson(res, 200, {
            ok: false,
            status: Number(e.status) || 500,
            error: e.message || String(err),
          });
        }
      }
      return sendJson(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      console.error("[agent-worker]", err);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : "failed" });
      }
    }
  });

  return { server, streams, requestRestartWhenIdle };
}

async function main() {
  const agent = await import("./personal-agent.js");
  const { onEducationNotify } = await import("./education-events.js");
  /** @type {Record<string, (...args: any[]) => unknown>} */
  const handlers = {};
  for (const name of AGENT_WORKER_METHODS) {
    const fn = /** @type {Record<string, unknown>} */ (agent)[name];
    if (typeof fn === "function") handlers[name] = /** @type {any} */ (fn);
  }
  const { server } = createAgentWorkerServer({
    handlers,
    onNotify: onEducationNotify,
    stats: () => ({ busySessions: agent.busySessionCount() }),
    busy: () => agent.busySessionCount(),
  });
  server.on("error", (err) => {
    console.error("[agent-worker] listen failed", err);
    process.exit(1);
  });
  server.listen(AGENT_WORKER_PORT, AGENT_WORKER_HOST, async () => {
    console.log(
      `[agent-worker] listening on http://${AGENT_WORKER_HOST}:${AGENT_WORKER_PORT} pid=${process.pid}`
    );
    // AGENT_WORKER_SCHEDULERS=0: test copy, no pollers or future agents.
    if (String(process.env.AGENT_WORKER_SCHEDULERS || "1") === "0") return;
    const [{ startIMessageAgentMentionScheduler }, { startTeamsAgentMentionScheduler }, { startWhatsAppAgentMentionScheduler }] =
      await Promise.all([
        import("./imessage-agent-mentions.js"),
        import("./teams-agent-mentions.js"),
        import("./whatsapp-agent-mentions.js"),
      ]);
    startIMessageAgentMentionScheduler();
    startTeamsAgentMentionScheduler();
    startWhatsAppAgentMentionScheduler();
    agent.startFutureAgentScheduler();
    const { startClassLiveActivityScheduler } = await import("./class-live-activity-scheduler.js");
    startClassLiveActivityScheduler();
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // One stray rejection must not take every running chat down with it.
  process.on("unhandledRejection", (reason) => {
    console.error("[agent-worker] unhandled rejection", reason);
  });
  main().catch((err) => {
    console.error("[agent-worker] fatal", err);
    process.exit(1);
  });
}
