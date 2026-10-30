#!/usr/bin/env node
/**
 * Keep education user data folders in sync with origin/main,
 * and keep Personal + EPS OneDrive accounts running on Mac.
 *
 * Watches local changes → commit + push those paths.
 * Polls origin → fast-forward when local has no extra commits, else rebase onto origin/main.
 * On each poll, relaunches OneDrive if either signed-in account quit.
 *
 * Paths:
 *   tmp
 * User data and project trees live on OneDrive, not in this sync.
 *
 * Run via LaunchAgent com.personalagent.education-sync (Mac Studio + MacBook).
 */

import { watch, writeSync, statSync, unlinkSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { promisify } from "node:util";
import {
  SSH_PRIMARY,
  STALE_LOCK_RELS,
  defaultPollMs,
  lsofBin,
  pickSshCommand,
  remoteUpdateArgs,
  shouldRemoveStaleLock,
  shouldRetryGit,
  wokeFromSleep,
} from "./education-folder-sync-lib.mjs";

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = (process.env.OWNER_EMAIL || "you@example.com").trim().toLowerCase();
export const PATHS = [
  `education/${OWNER}`,
  `fitness/${OWNER}`,
  "tmp",
];

const HOST = hostname().replace(/\.local$/, "");
const DEBOUNCE_MS = Number(process.env.EDU_SYNC_DEBOUNCE_MS || 2500);
const POLL_MS = defaultPollMs(HOST, process.env.EDU_SYNC_POLL_MS);
const GIT_TIMEOUT_MS = Number(process.env.EDU_SYNC_GIT_TIMEOUT_MS || 45000);
const PULL_TIMEOUT_MS = Number(process.env.EDU_SYNC_PULL_TIMEOUT_MS || 300000);
const STALE_LOCK_MS = Number(process.env.EDU_SYNC_STALE_LOCK_MS || 15000);
const GIT_SSH_COMMAND = process.env.GIT_SSH_COMMAND || SSH_PRIMARY;
const IS_MAC = process.platform === "darwin";
const ONEDRIVE_APP = "/Applications/OneDrive.app";
const ONEDRIVE_EXPECTED = Number(process.env.EDU_SYNC_ONEDRIVE_EXPECTED || 0);
const ONEDRIVE_RETRY_MS = Number(process.env.EDU_SYNC_ONEDRIVE_RETRY_MS || 120000);

/** @type {number} */
let lastOneDriveLaunchAt = 0;

/** @type {Promise<void>} */
let chain = Promise.resolve();
let debounceTimer = null;
let syncing = false;

/** @type {{ pid: number, kind: string } | null} */
let inflight = null;

function log(...args) {
  const line = `[education-sync ${new Date().toISOString()}] ${args.join(" ")}\n`;
  try {
    writeSync(1, line);
  } catch {
    console.error(line.trimEnd());
  }
}

function killProcessGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run git in its own process group so a timeout kills ssh children too.
 * execFile SIGTERM left ssh holding origin/main.lock and the next fetch died.
 *
 * @param {string[]} args
 * @param {{ allowFail?: boolean, timeout?: number, sshCommand?: string }} [opts]
 */
async function git(args, opts = {}) {
  const timeout = opts.timeout ?? GIT_TIMEOUT_MS;
  const sshCommand = opts.sshCommand || GIT_SSH_COMMAND;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_SSH_COMMAND: sshCommand,
  };

  const result = await new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    inflight = { pid: child.pid, kind: String(args[0] || "") };
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (inflight && inflight.pid === child.pid) inflight = null;
      resolve(payload);
    };
    timer = setTimeout(() => {
      killProcessGroup(child.pid);
      finish({
        ok: false,
        stdout,
        stderr: `timed out after ${timeout}ms`,
        code: null,
        signal: "SIGKILL",
      });
    }, timeout);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 10 * 1024 * 1024) killProcessGroup(child.pid);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      finish({
        ok: false,
        stdout,
        stderr: err.message || String(err),
        code: err.code,
      });
    });
    child.on("close", (code, signal) => {
      const timedOut = signal === "SIGKILL" || signal === "SIGTERM";
      if (code === 0) {
        finish({ ok: true, stdout, stderr });
        return;
      }
      finish({
        ok: false,
        stdout,
        stderr: timedOut ? `timed out after ${timeout}ms` : stderr,
        code,
        signal,
      });
    });
  });

  if (result.ok || opts.allowFail) return result;
  throw new Error(String(result.stderr || "").trim() || `git ${args[0]} failed`);
}

/** True if a live process has the lock file open. */
async function lockHasHolder(lockPath) {
  try {
    const { stdout } = await execFileAsync(lsofBin(), [lockPath], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    return Boolean(String(stdout || "").trim());
  } catch (err) {
    if (err && err.code === 1) return false;
    log(
      "lsof failed, leaving lock in place:",
      err && err.code ? err.code : err
    );
    return true;
  }
}

/** SIGKILL / crash can leave *.lock with nobody holding it. */
async function clearStaleGitLocks() {
  for (const rel of STALE_LOCK_RELS) {
    const lockPath = join(ROOT, ".git", rel);
    let st;
    try {
      st = statSync(lockPath);
    } catch {
      continue;
    }
    const hasHolder = await lockHasHolder(lockPath);
    const ageMs = Date.now() - st.mtimeMs;
    if (!shouldRemoveStaleLock({ ageMs, hasHolder, staleMs: STALE_LOCK_MS })) {
      continue;
    }
    try {
      unlinkSync(lockPath);
      log(`removed stale .git/${rel} (${Math.round(ageMs / 1000)}s old)`);
    } catch (err) {
      log(
        `could not remove ${rel}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

function enqueue(label, fn) {
  const run = chain.then(async () => {
    try {
      await fn();
    } catch (err) {
      log(`${label} error:`, err instanceof Error ? err.message : err);
    }
  });
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Personal + EPS each have a OneDrive GUI process. Relaunch if either is gone. */
async function countOneDriveProcesses() {
  const listed = await execFileAsync("pgrep", ["-x", "OneDrive"], {
    maxBuffer: 64 * 1024,
  }).catch((err) => err);
  const stdout = String(listed?.stdout || "");
  return stdout.trim() ? stdout.trim().split("\n").length : 0;
}

async function ensureOneDriveRunning() {
  if (!IS_MAC) return;
  try {
    statSync(ONEDRIVE_APP);
  } catch {
    return;
  }

  const count = await countOneDriveProcesses();
  if (count >= ONEDRIVE_EXPECTED) return;

  const now = Date.now();
  if (now - lastOneDriveLaunchAt < ONEDRIVE_RETRY_MS) return;
  lastOneDriveLaunchAt = now;

  log(`OneDrive processes=${count} (want ${ONEDRIVE_EXPECTED}); launching`);
  try {
    // Open the main app. The LoginItems "OneDrive Launcher" helper sticks in
    // launchd ("Operation already in progress") and never brings the GUI back.
    await execFileAsync("open", ["-a", ONEDRIVE_APP], { timeout: 15000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("onedrive launch failed:", msg.split("\n")[0]);
  }
}

/** Retry git on index/ref locks, DNS, and hung SSH. Rotate GitHub 443 → 22. */
async function gitRetry(args, opts = {}, attempts = 5) {
  let last;
  let lastErr = "";
  for (let i = 0; i < attempts; i++) {
    last = await git(args, {
      ...opts,
      allowFail: true,
      sshCommand: pickSshCommand(i, lastErr),
    });
    if (last.ok) return last;
    lastErr = `${last.stderr} ${last.stdout}`;
    if (!shouldRetryGit(lastErr, i, attempts)) {
      if (opts.allowFail) return last;
      throw new Error(lastErr.trim() || `git ${args[0]} failed`);
    }
    await sleep(400 * (i + 1));
  }
  if (opts.allowFail) return last;
  throw new Error((lastErr || `git ${args[0]} failed`).trim());
}

async function commitLocalIfNeeded() {
  await gitRetry(["add", "--", ...PATHS]);
  const { stdout: status } = await git([
    "status",
    "--porcelain",
    "--",
    ...PATHS,
  ]);
  if (!status.trim()) return false;

  const shortHost = HOST.slice(0, 24);
  const message = `sync: user data from ${shortHost}`;
  await gitRetry(["commit", "-m", message]);
  log(`committed local changes (${shortHost})`);
  return true;
}

async function pullRemote() {
  const fetch = await gitRetry(["fetch", "origin", "main"], { allowFail: true });
  if (!fetch.ok) {
    log("fetch failed:", fetch.stderr.trim() || fetch.stdout.trim());
    return false;
  }

  const { stdout: behind } = await git([
    "rev-list",
    "--count",
    "HEAD..origin/main",
  ]);
  if (String(behind).trim() === "0") return false;

  const { stdout: ahead } = await git([
    "rev-list",
    "--count",
    "origin/main..HEAD",
  ]);
  const canFf = String(ahead).trim() === "0";
  const pull = await gitRetry(remoteUpdateArgs(canFf), {
    allowFail: true,
    timeout: PULL_TIMEOUT_MS,
  });
  if (!pull.ok) {
    log(
      canFf ? "merge --ff-only failed:" : "rebase origin/main failed:",
      pull.stderr.trim() || pull.stdout.trim()
    );
    if (!canFf) await git(["rebase", "--abort"], { allowFail: true });
    await clearStaleGitLocks();
    return false;
  }
  log(canFf ? "fast-forwarded origin/main" : "rebased onto origin/main");
  return true;
}

async function pushIfNeeded() {
  const { stdout: ahead } = await git([
    "rev-list",
    "--count",
    "origin/main..HEAD",
  ]);
  if (String(ahead).trim() === "0") return false;

  const push = await gitRetry(["push", "origin", "main"], { allowFail: true });
  if (!push.ok) {
    log("push failed:", push.stderr.trim() || push.stdout.trim());
    // Someone else pushed — next cycle will pull.
    return false;
  }
  log("pushed to origin/main");
  return true;
}

async function syncCycle(reason) {
  if (syncing && reason === "poll") return;
  if (reason === "poll") syncing = true;
  return enqueue(reason, async () => {
    syncing = true;
    try {
      log(`sync (${reason})`);
      await clearStaleGitLocks();
      await commitLocalIfNeeded();
      await pullRemote();
      // After rebase, local folder edits may need another commit (rare).
      await commitLocalIfNeeded();
      await pushIfNeeded();
      log(`idle (${reason})`);
    } finally {
      syncing = false;
    }
  });
}

function scheduleLocalSync() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    syncCycle("local-watch").catch(() => {});
  }, DEBOUNCE_MS);
}

function startWatchers() {
  for (const rel of PATHS) {
    const abs = join(ROOT, rel);
    try {
      const isDir = statSync(abs).isDirectory();
      watch(abs, { recursive: isDir }, (_event, filename) => {
        // Ignore noisy editor/git junk if it ever appears under the tree.
        const name = filename ? String(filename) : "";
        if (name.includes(".git/") || name.endsWith("~")) return;
        scheduleLocalSync();
      });
      log(`watching ${rel}`);
    } catch (err) {
      log(
        `watch failed for ${rel}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

async function main() {
  log(`starting in ${ROOT}`);
  log(`paths: ${PATHS.join(", ")}`);
  log(
    `debounce=${DEBOUNCE_MS}ms poll=${POLL_MS}ms gitTimeout=${GIT_TIMEOUT_MS}ms pullTimeout=${PULL_TIMEOUT_MS}ms`
  );

  startWatchers();
  await ensureOneDriveRunning().catch((err) => {
    log("onedrive error:", err instanceof Error ? err.message : err);
  });
  await syncCycle("startup");

  setInterval(() => {
    ensureOneDriveRunning().catch((err) => {
      log("onedrive error:", err instanceof Error ? err.message : err);
    });
    syncCycle("poll").catch(() => {});
  }, POLL_MS);

  // Sleep pauses this timer. On wake it fires late by about the sleep length.
  // A fetch started before the lid closed is a dead socket. Kill that one so
  // the cycle retries on the network that is up now.
  let nextBeat = Date.now() + 5000;
  setInterval(() => {
    const now = Date.now();
    const late = now - nextBeat;
    nextBeat = now + 5000;
    if (!wokeFromSleep(late)) return;
    const stuck = inflight;
    if (!stuck || stuck.kind !== "fetch") {
      log(`awake after ${Math.round(late / 1000)}s`);
      return;
    }
    log(`awake after ${Math.round(late / 1000)}s, dropping the fetch`);
    killProcessGroup(stuck.pid);
  }, 5000);
}

const isMain =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
