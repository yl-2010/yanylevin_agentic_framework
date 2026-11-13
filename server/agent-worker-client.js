/**
 * API-side handle on the agent worker (agent-worker.js). Same function names
 * and return shapes as personal-agent.js, so index.js routes do not change.
 *
 * While the worker is unreachable, calls throw status 503. Never 404: the web
 * chat treats a 404 from /agent/state as "thread gone" and wipes it.
 */

import { execFile, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { notifyEducationClients } from "./education-events.js";
import {
  AGENT_WORKER_LABEL,
  AGENT_WORKER_METHODS,
  agentWorkerBaseUrl,
  agentWorkerInProcess,
} from "./agent-worker-protocol.js";
import { AGENT_WORKER_LOG_PATH, ensureServiceLogDir } from "./service-logs.js";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const RPC_TIMEOUT_MS = Number(process.env.AGENT_WORKER_RPC_TIMEOUT_MS) || 120_000;

/** @type {Promise<Record<string, Function>>|null} */
let inProcessModule = null;

function unavailable(cause) {
  const err = new Error("agent worker unavailable, try again in a moment");
  /** @type {any} */ (err).status = 503;
  /** @type {any} */ (err).cause = cause;
  return err;
}

/**
 * @param {string} method
 * @param {unknown[]} args
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [opts]
 */
export async function callAgentWorker(method, args, opts = {}) {
  if (!AGENT_WORKER_METHODS.includes(method)) {
    throw new Error(`agent worker method not allowed: ${method}`);
  }
  if (agentWorkerInProcess() && !opts.fetchImpl) {
    inProcessModule ||= import("./personal-agent.js");
    const mod = await inProcessModule;
    return mod[method](...args);
  }
  const fetchImpl = opts.fetchImpl || fetch;
  const base = opts.baseUrl || agentWorkerBaseUrl();
  let res;
  try {
    res = await fetchImpl(`${base}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, args }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (err) {
    throw unavailable(err);
  }
  /** @type {any} */
  let body = null;
  try {
    body = await res.json();
  } catch {
    throw unavailable(new Error(`bad worker response ${res.status}`));
  }
  if (body?.ok) return body.result;
  const err = new Error(body?.error || "agent worker call failed");
  /** @type {any} */ (err).status = Number(body?.status) || (res.status >= 400 ? res.status : 500);
  throw err;
}

/** @param {string} name */
const proxy = (name) => (/** @type {unknown[]} */ ...args) => callAgentWorker(name, args);

export const startAgent = proxy("startAgent");
export const messageAgent = proxy("messageAgent");
export const promoteQueuedTurn = proxy("promoteQueuedTurn");
export const stopAgent = proxy("stopAgent");
export const getAgentState = proxy("getAgentState");
export const getActiveAgent = proxy("getActiveAgent");
export const getRunningAgents = proxy("getRunningAgents");
export const listAgentChats = proxy("listAgentChats");
export const resumeAgent = proxy("resumeAgent");
export const markAgentChatRead = proxy("markAgentChatRead");
export const resolveChatUploadFile = proxy("resolveChatUploadFile");
export const scheduleFutureAgentLive = proxy("scheduleFutureAgentLive");
export const cancelFutureAgentLive = proxy("cancelFutureAgentLive");

/**
 * Parse SSE text; returns leftover partial block.
 * @param {string} buffer
 * @param {(event: string, data: string) => void} onBlock
 */
export function drainSseBuffer(buffer, onBlock) {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() || "";
  for (const block of parts) {
    let event = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length) onBlock(event, data.join("\n"));
  }
  return rest;
}

/**
 * Re-broadcast worker agent status to this process's SSE clients. Reconnects
 * forever, so it re-attaches after either side restarts.
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string, notify?: typeof notifyEducationClients, retryMs?: number }} [opts]
 * @returns {{ close: () => void, connected: () => boolean }}
 */
export function startAgentWorkerBridge(opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const base = opts.baseUrl || agentWorkerBaseUrl();
  const notify = opts.notify || notifyEducationClients;
  const retryMs = opts.retryMs ?? 1000;
  let closed = false;
  let isConnected = false;
  let lastPid = null;
  /** @type {AbortController|null} */
  let ac = null;

  const loop = async () => {
    while (!closed) {
      ac = new AbortController();
      try {
        const res = await fetchImpl(`${base}/events`, { signal: ac.signal });
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        isConnected = true;
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of /** @type {any} */ (res.body)) {
          buffer += decoder.decode(chunk, { stream: true });
          buffer = drainSseBuffer(buffer, (event, data) => {
            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch {
              return;
            }
            if (event === "hello") {
              if (lastPid != null && lastPid !== parsed?.pid) {
                console.warn(`[agent-worker-bridge] worker restarted pid=${parsed?.pid}`);
              }
              lastPid = parsed?.pid ?? null;
              return;
            }
            if (event === "notify" && parsed?.email) {
              notify(parsed.email, parsed.event || "change", parsed.data || {});
            }
          });
        }
      } catch (err) {
        if (closed) break;
        if (isConnected) {
          console.warn(
            "[agent-worker-bridge] disconnected",
            err instanceof Error ? err.message : err
          );
        }
      }
      isConnected = false;
      if (closed) break;
      await new Promise((r) => setTimeout(r, retryMs).unref?.());
    }
  };
  loop();
  return {
    close() {
      closed = true;
      try {
        ac?.abort();
      } catch {
        /* ignore */
      }
    },
    connected: () => isConnected,
  };
}

async function workerHealthy() {
  try {
    const res = await fetch(`${agentWorkerBaseUrl()}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** @param {string[]} args */
function launchctl(args) {
  return new Promise((resolve) => {
    execFile("/bin/launchctl", args, (err) => resolve(!err));
  });
}

/**
 * Bring the worker up if nothing answers. Prefers its LaunchAgent; without
 * one, spawns a detached node that outlives this API process.
 */
export async function ensureAgentWorker() {
  if (agentWorkerInProcess()) return { mode: "inprocess" };
  if (await workerHealthy()) return { mode: "running" };
  if (String(process.env.AGENT_WORKER_AUTOSTART || "1") === "0") {
    console.warn("[agent-worker] not running and AGENT_WORKER_AUTOSTART=0");
    return { mode: "down" };
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const service = uid != null ? `gui/${uid}/${AGENT_WORKER_LABEL}` : "";
  if (process.platform === "darwin" && service && (await launchctl(["print", service]))) {
    await launchctl(["kickstart", service]);
    console.log(`[agent-worker] kickstarted ${service}`);
    return { mode: "launchd" };
  }
  const args = [];
  if (process.execArgv.some((a) => a.startsWith("--env-file"))) args.push("--env-file=.env");
  args.push(join(SERVER_DIR, "agent-worker.js"));
  ensureServiceLogDir();
  const log = openSync(AGENT_WORKER_LOG_PATH, "a");
  const child = spawn(process.execPath, args, {
    cwd: SERVER_DIR,
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  console.log(`[agent-worker] spawned detached worker pid=${child.pid}`);
  return { mode: "spawned", pid: child.pid };
}

/**
 * Re-check the worker every intervalMs and bring it back if it stopped
 * answering (crash with no LaunchAgent, or a restart-when-idle exit).
 * @param {{ intervalMs?: number }} [opts]
 */
export function startAgentWorkerWatchdog(opts = {}) {
  if (agentWorkerInProcess()) return () => {};
  const intervalMs = opts.intervalMs ?? 30_000;
  let busy = false;
  let misses = 0;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (await workerHealthy()) {
        misses = 0;
        return;
      }
      misses += 1;
      // launchd KeepAlive usually brings it back within a few seconds.
      if (misses >= 2) {
        misses = 0;
        await ensureAgentWorker();
      }
    } catch (err) {
      console.error("[agent-worker] watchdog", err);
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * In-process mode only: the mention pollers and future-agent scheduler run here.
 */
export async function startInProcessAgentSchedulers() {
  const [im, teams, wa, agent] = await Promise.all([
    import("./imessage-agent-mentions.js"),
    import("./teams-agent-mentions.js"),
    import("./whatsapp-agent-mentions.js"),
    import("./personal-agent.js"),
  ]);
  im.startIMessageAgentMentionScheduler();
  teams.startTeamsAgentMentionScheduler();
  wa.startWhatsAppAgentMentionScheduler();
  agent.startFutureAgentScheduler();
}
