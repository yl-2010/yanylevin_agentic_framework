/**
 * Serialized best-effort git add / commit / push for server-side file updates.
 */

import { execFile } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Promise<unknown>} */
let chain = Promise.resolve();

/**
 * Keep only paths git can stage (inside this repo). OneDrive class trees are skipped.
 * @param {unknown[]} paths
 * @returns {string[]}
 */
export function repoGitPaths(paths) {
  if (!Array.isArray(paths)) return [];
  /** @type {string[]} */
  const out = [];
  for (const p of paths) {
    const s = String(p || "").trim();
    if (!s || s.startsWith("-")) continue;
    const abs = isAbsolute(s) ? resolve(s) : resolve(ROOT, s);
    const rel = relative(ROOT, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    out.push(rel);
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string[]} opts.paths repo-relative paths to stage
 * @param {string} opts.message commit message
 * @returns {Promise<{ pushed: boolean, reason?: string }>}
 */
export function gitAddCommitPush({ paths, message }) {
  const job = async () => {
    const inside = repoGitPaths(paths);
    if (!inside.length) {
      return { pushed: false, reason: "no paths" };
    }
    await execFileAsync("git", ["add", "--", ...inside], { cwd: ROOT });
    const { stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain", "--", ...inside],
      { cwd: ROOT }
    );
    if (!status.trim()) return { pushed: false, reason: "no changes" };

    await execFileAsync("git", ["commit", "-m", message], { cwd: ROOT });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: ROOT });
    return { pushed: true };
  };

  const run = chain.then(job, job);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run.catch((err) => {
    console.error("[git-publish]", err);
    return {
      pushed: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  });
}
