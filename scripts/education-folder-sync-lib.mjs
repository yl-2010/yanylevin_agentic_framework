/**
 * SSH + retry helpers for education-folder-sync.
 * Keep this import-safe: the LaunchAgent script calls main() on load.
 */

import { homedir } from "node:os";

/** GitHub SSH over 443, IPv4 only. UW Wi-Fi and some home routers black-hole IPv6. */
export const SSH_PRIMARY =
  "ssh -4 -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 -o Hostname=ssh.github.com -p 443";

/**
 * github.com:22 with no ssh config. The MacBook config rewrites github.com to
 * ssh.github.com:443, so a plain fallback still dies when that name does not resolve.
 */
export const SSH_FALLBACK =
  `ssh -F /dev/null -4 -i ${homedir()}/.ssh/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 -o ServerAliveInterval=5 -o ServerAliveCountMax=2`;

export const STUDIO_POLL_MS = 20000;
export const MACBOOK_POLL_MS = 5000;
/** A poll timer this late means the Mac slept. Wall clock, not the paused monotonic clock. */
export const WAKE_LATE_MS = 30000;

export const STALE_LOCK_RELS = [
  "index.lock",
  "HEAD.lock",
  "packed-refs.lock",
  "config.lock",
  "shallow.lock",
  "refs/heads/main.lock",
  "refs/remotes/origin/main.lock",
];

export function isLockError(text) {
  return /index\.lock|Unable to create|cannot lock ref|another git process|\blocked\b/i.test(
    String(text || "")
  );
}

export function isTransientRemoteError(text) {
  return /timed out|Could not resolve hostname|nodename nor servname|Could not read from remote repository|Connection (timed out|reset|refused)|Network is unreachable|early EOF|Operation timed out|Broken pipe|Connection closed/i.test(
    String(text || "")
  );
}

export function pickSshCommand(attempt, lastError = "") {
  const err = String(lastError || "");
  if (
    attempt > 0 &&
    /ssh\.github\.com|timed out|Could not resolve hostname/i.test(err)
  ) {
    return SSH_FALLBACK;
  }
  return SSH_PRIMARY;
}

export function shouldRetryGit(text, attempt, maxAttempts) {
  if (attempt >= maxAttempts - 1) return false;
  return isLockError(text) || isTransientRemoteError(text);
}

export function remoteUpdateArgs(canFastForward) {
  if (canFastForward) return ["merge", "--ff-only", "origin/main"];
  // git pull --rebase origin main on Apple Git 2.54 dies with
  // "Cannot rebase onto multiple branches" because FETCH_HEAD already
  // has the fetch from this same poll. Rebase onto origin/main instead.
  return ["-c", "rebase.autoStash=true", "rebase", "origin/main"];
}

export function shouldRemoveStaleLock({ ageMs, hasHolder, staleMs }) {
  if (hasHolder) return false;
  return Number(ageMs) >= Number(staleMs);
}

/** macOS ships lsof in /usr/sbin. The education-sync LaunchAgent PATH does not include that directory, so a bare `lsof` never runs and every stale lock looks held. */
export function lsofBin(platform = process.platform) {
  return platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
}

/** Studio stays on a 20s poll. The MacBook polls faster so a manual pull is usually empty. */
export function defaultPollMs(host, envValue) {
  if (envValue != null && String(envValue).trim() !== "") {
    const n = Number(envValue);
    if (Number.isFinite(n) && n >= 1000) return n;
  }
  if (/mac-?studio/i.test(String(host || ""))) return STUDIO_POLL_MS;
  return MACBOOK_POLL_MS;
}

/** setInterval fires late by the sleep duration. 30s late is a wake, not a slow tick. */
export function wokeFromSleep(lateMs, thresholdMs = WAKE_LATE_MS) {
  return Number(lateMs) >= Number(thresholdMs);
}
