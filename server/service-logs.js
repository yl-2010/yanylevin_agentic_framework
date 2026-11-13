/**
 * Permanent locations for LaunchAgent and helper service logs.
 * These used to live in /tmp, which macOS wipes on reboot.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SERVICE_LOG_DIR = join(homedir(), "Library/Logs/yanylevin");
export const SERVICE_LOG_ARCHIVE_DIR = join(SERVICE_LOG_DIR, "archive");

export const SERVICE_LOG_FILES = {
  server: "personal-agent-server.log",
  agentWorker: "personal-agent-worker.log",
  cursorUsage: "personal-agent-cursor-usage.log",
  educationSync: "personal-agent-education-sync.log",
  lmstudioGptOss: "personal-agent-lmstudio-gpt-oss.log",
  cloudflared: "cloudflared-personal-agent.log",
  computerUse: "personal-agent-computer-use.log",
  sarGame: "personal-agent-sar-game.log",
};

/** @type {Record<keyof typeof SERVICE_LOG_FILES, string>} */
export const SERVICE_LOGS = Object.fromEntries(
  Object.entries(SERVICE_LOG_FILES).map(([key, name]) => [key, join(SERVICE_LOG_DIR, name)])
);

export const SERVER_LOG_PATH = SERVICE_LOGS.server;
export const AGENT_WORKER_LOG_PATH = SERVICE_LOGS.agentWorker;
export const CURSOR_USAGE_LOG_PATH = SERVICE_LOGS.cursorUsage;
export const EDUCATION_SYNC_LOG_PATH = SERVICE_LOGS.educationSync;
export const LMSTUDIO_GPT_OSS_LOG_PATH = SERVICE_LOGS.lmstudioGptOss;
export const CLOUDFLARED_LOG_PATH = SERVICE_LOGS.cloudflared;
export const COMPUTER_USE_LOG_PATH = SERVICE_LOGS.computerUse;
export const SAR_GAME_LOG_PATH = SERVICE_LOGS.sarGame;

export function ensureServiceLogDir() {
  mkdirSync(SERVICE_LOG_DIR, { recursive: true });
  mkdirSync(SERVICE_LOG_ARCHIVE_DIR, { recursive: true });
  return SERVICE_LOG_DIR;
}
