#!/usr/bin/env node
/**
 * Keep education user data folders in sync with origin/main,
 * and keep Personal + EPS OneDrive accounts running on Mac.
 *
 * Watches local changes → commit + push those paths.
 * Polls origin → fast-forward when local has no extra commits, else pull --rebase.
 * On each poll, relaunches OneDrive if either signed-in account quit.
 *
 * Paths:
 *   education/$OWNER_EMAIL
 *   fitness/$OWNER_EMAIL
 *
 * Run via LaunchAgent com.personalagent.education-sync (Mac Studio + MacBook).
 */

import { watch, writeSync, statSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = (process.env.OWNER_EMAIL || "you@example.com").trim().toLowerCase();
const PATHS = [
  `education/${OWNER}`,
  `fitness/${OWNER}`,
];

const DEBOUNCE_MS = Number(process.env.EDU_SYNC_DEBOUNCE_MS || 2500);
const POLL_MS = Number(process.env.EDU_SYNC_POLL_MS || 20000);
const GIT_TIMEOUT_MS = Number(process.env.EDU_SYNC_GIT_TIMEOUT_MS || 45000);
const PULL_TIMEOUT_MS = Number(process.env.EDU_SYNC_PULL_TIMEOUT_MS || 300000);
const STALE_LOCK_MS = Number(process.env.EDU_SYNC_STALE_LOCK_MS || 15000);
const GIT_SSH_COMMAND =
  process.env.GIT_SSH_COMMAND ||
  "ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=5 -o ServerAliveCountMax=3";
const HOST = hostname().replace(/\.local$/, "");
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

function log(...args) {
  const line = `[education-sync ${new Date().toISOString()}] ${args.join(" ")}\n`;
  try {
    writeSync(1, line);
  } catch {
    console.error(line.trimEnd());
  }
}

/**
 * @param {string[]} args
 * @param {{ allowFail?: boolean, timeout?: number }} [opts]
 */
async function git(args, opts = {}) {
  const timeout = opts.timeout ?? GIT_TIMEOUT_MS;
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: ROOT,
      maxBuffer: 10 * 1024 * 1024,
      timeout,
      killSignal: "SIGTERM",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_SSH_COMMAND,
      },
    });
    return {
      ok: true,
      stdout: String(stdout || ""),
      stderr: String(stderr || ""),
    };
  } catch (err) {
    const timedOut =
      Boolean(err.killed) || err.signal === "SIGTERM" || err.signal === "SIGKILL";
    const stderr = timedOut
      ? `timed out after ${timeout}ms`
      : String(err.stderr || err.message || "");
    if (opts.allowFail) {
      return {
        ok: false,
        stdout: String(err.stdout || ""),
        stderr,
        code: err.code,
      };
    }
    throw timedOut ? new Error(stderr) : err;
  }
}

/** True if a live process has .git/index.lock open. */
async function lockHasHolder(lockPath) {
  try {
    const { stdout } = await execFileAsync("lsof", [lockPath], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    return Boolean(String(stdout || "").trim());
  } catch (err) {
    if (err && err.code === 1) return false;
    return true;
  }
}

/** SIGKILL / crash can leave index.lock with nobody holding it. */
async function clearStaleIndexLock() {
  const lockPath = join(ROOT, ".git", "index.lock");
  let st;
  try {
    st = statSync(lockPath);
  } catch {
    return;
  }
  if (await lockHasHolder(lockPath)) return;
  const ageMs = Date.now() - st.mtimeMs;
  if (ageMs < STALE_LOCK_MS) return;
  try {
    unlinkSync(lockPath);
    log(`removed stale .git/index.lock (${Math.round(ageMs / 1000)}s old)`);
  } catch (err) {
    log(
      "could not remove index.lock:",
      err instanceof Error ? err.message : err
    );
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

/** Retry git when another process holds index.lock. */
async function gitRetry(args, opts = {}, attempts = 5) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await git(args, { allowFail: true });
    if (last.ok) return last;
    const errText = `${last.stderr} ${last.stdout}`;
    if (!/index\.lock|Unable to create|locked/i.test(errText) || i === attempts - 1) {
      if (opts.allowFail) return last;
      const err = new Error(errText.trim() || `git ${args[0]} failed`);
      throw err;
    }
    await sleep(300 * (i + 1));
  }
  return last;
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
  const fetch = await git(["fetch", "origin", "main"], { allowFail: true });
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
  const pull = canFf
    ? await git(["merge", "--ff-only", "origin/main"], {
        allowFail: true,
        timeout: PULL_TIMEOUT_MS,
      })
    : await git(
        ["-c", "rebase.autoStash=true", "pull", "--rebase", "origin", "main"],
        { allowFail: true, timeout: PULL_TIMEOUT_MS }
      );
  if (!pull.ok) {
    log(
      canFf ? "merge --ff-only failed:" : "pull --rebase failed:",
      pull.stderr.trim() || pull.stdout.trim()
    );
    if (!canFf) await git(["rebase", "--abort"], { allowFail: true });
    await clearStaleIndexLock();
    return false;
  }
  log(canFf ? "fast-forwarded origin/main" : "pulled origin/main");
  return true;
}

async function pushIfNeeded() {
  const { stdout: ahead } = await git([
    "rev-list",
    "--count",
    "origin/main..HEAD",
  ]);
  if (String(ahead).trim() === "0") return false;

  const push = await git(["push", "origin", "main"], { allowFail: true });
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
      await clearStaleIndexLock();
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
