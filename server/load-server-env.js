/**
 * Side-effect import for CLIs run outside the LaunchAgent: loads server/.env
 * the way `node --env-file=.env index.js` does, so a CLI sees the same
 * settings (DAILY_BRIEFING_RUNNER, model ids) as the running server.
 * Import it first. Variables already in the environment win.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const envPath = join(dirname(fileURLToPath(import.meta.url)), ".env");
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    /* unreadable .env: fall back to the process env */
  }
}
