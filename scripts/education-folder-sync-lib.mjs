/**
 * SSH + retry helpers for education-folder-sync.
 * Keep this import-safe: the LaunchAgent script calls main() on load.
 */

/** GitHub SSH over 443, IPv4 only. UW Wi-Fi and some home routers black-hole IPv6. */
export const SSH_PRIMARY =
  "ssh -4 -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 -o Hostname=ssh.github.com -p 443";

/** Same options on github.com:22 when ssh.github.com DNS or 443 fails. */
export const SSH_FALLBACK =
  "ssh -4 -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 -o ServerAliveInterval=5 -o ServerAliveCountMax=2";

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
