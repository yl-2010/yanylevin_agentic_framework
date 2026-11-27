/** Yan-only brain snapshot reader. The caller must also use requireAuth. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalizeEmail } from "./identity.js";
import { YAN_BACKEND_DIR } from "./onedrive-projects.js";

/**
 * Live snapshot folder, written every few minutes by scripts/brain-data/refresh.mjs (LaunchAgent
 * com.yanylevin.brain-data). Local disk, not OneDrive, so the frequent rewrites never sync anywhere.
 * The old OneDrive copy (.backend/brain-site) is only a fallback while the live one is missing.
 */
export const BRAIN_SITE_DIR = process.env.BRAIN_SITE_DIR || join(homedir(), "Library", "Application Support", "yanylevin", "brain-site");
export const LEGACY_BRAIN_SITE_DIR = join(YAN_BACKEND_DIR, "brain-site");

export function createBrainSnapshotHandler({ file = "brain.json", snapshotPath, fallbackPath } = {}) {
  const paths = snapshotPath ? [snapshotPath, fallbackPath].filter(Boolean) : [join(BRAIN_SITE_DIR, file), join(LEGACY_BRAIN_SITE_DIR, file)];
  return async function brainSnapshotHandler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (canonicalizeEmail(req.user?.email) !== "you@example.com") {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    let lastErr = null;
    for (const p of paths) {
      try {
        const text = await readFile(p, "utf8");
        res.type("application/json").send(text);
        return;
      } catch (err) {
        lastErr = err;
        if (err.code !== "ENOENT") break;
      }
    }
    console.error("[/api/brain]", lastErr?.code || lastErr?.message);
    res.status(lastErr?.code === "ENOENT" ? 404 : 500).json({
      ok: false,
      error: lastErr?.code === "ENOENT" ? "brain snapshot missing" : "brain read failed",
    });
  };
}
