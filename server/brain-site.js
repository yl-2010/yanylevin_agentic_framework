/** Yan-only brain snapshot reader. The caller must also use requireAuth. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalizeEmail } from "./identity.js";
import { YAN_BACKEND_DIR } from "./onedrive-projects.js";

export function createBrainSnapshotHandler({ snapshotPath = join(YAN_BACKEND_DIR, "brain-site", "brain.json") } = {}) {
  return async function brainSnapshotHandler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (canonicalizeEmail(req.user?.email) !== "you@example.com") {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    try {
      const text = await readFile(snapshotPath, "utf8");
      res.type("application/json").send(text);
    } catch (err) {
      console.error("[/api/brain]", err.code || err.message);
      res.status(err.code === "ENOENT" ? 404 : 500).json({
        ok: false,
        error: err.code === "ENOENT" ? "brain snapshot missing" : "brain read failed",
      });
    }
  };
}
