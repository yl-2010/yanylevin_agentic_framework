/**
 * Shared constants for the API <-> agent worker loopback channel.
 */

export const AGENT_WORKER_HOST = "127.0.0.1";
export const AGENT_WORKER_PORT = Number(process.env.AGENT_WORKER_PORT) || 3005;
export const AGENT_WORKER_LABEL = "com.personalagent.agent-worker";

/** personal-agent.js exports the API may call through POST /rpc. */
export const AGENT_WORKER_METHODS = Object.freeze([
  "startAgent",
  "messageAgent",
  "promoteQueuedTurn",
  "stopAgent",
  "getAgentState",
  "getActiveAgent",
  "getRunningAgents",
  "listAgentChats",
  "resumeAgent",
  "markAgentChatRead",
  "resolveChatUploadFile",
  "scheduleFutureAgentLive",
  "cancelFutureAgentLive",
]);

export function agentWorkerBaseUrl() {
  return (
    String(process.env.AGENT_WORKER_URL || "").replace(/\/+$/, "") ||
    `http://${AGENT_WORKER_HOST}:${AGENT_WORKER_PORT}`
  );
}

/** AGENT_WORKER=inprocess runs agents inside the API (old behavior, dev/tests). */
export function agentWorkerInProcess() {
  return String(process.env.AGENT_WORKER || "").trim().toLowerCase() === "inprocess";
}
