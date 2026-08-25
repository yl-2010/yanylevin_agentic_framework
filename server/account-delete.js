/**
 * Record account-deletion requests (App Store 5.1.1(v)).
 * Append-only audit; does not wipe education folders automatically.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatPacificTime } from "./chat-log.js";
import { canonicalizeEmail } from "./identity.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = join(ROOT, "data", "account-deletion-log.md");

/**
 * @param {{ email: string, at?: Date|string|number }} opts
 */
export async function recordAccountDeletionRequest({ email, at = new Date() } = {}) {
  const normalized = canonicalizeEmail(email);
  if (!normalized || !normalized.includes("@")) {
    throw new Error("email required");
  }
  const when = formatPacificTime(at);
  const iso = (at instanceof Date ? at : new Date(at)).toISOString();
  const block = [
    "",
    "## Account deletion request",
    "",
    `**${when}**`,
    "",
    `- email: \`${normalized}\``,
    `- utc: ${iso}`,
    `- note: Session revoked on client. Login/chat logs retained for audit unless manually redacted. Education folder not auto-deleted.`,
    "",
    "---",
    "",
  ].join("\n");

  await mkdir(dirname(LOG_PATH), { recursive: true });
  await appendFile(LOG_PATH, block, "utf8");
  return { email: normalized, recorded: true };
}
