/**
 * Unique Mail.app correspondents from Envelope Index (not message bodies).
 * LaunchAgent / Full Disk Access. Never copies the DB into the repo.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function defaultMailEnvelopeDb() {
  return (
    String(process.env.MAIL_ENVELOPE_DB || "").trim() ||
    join(homedir(), "Library/Mail/V10/MailData/Envelope Index")
  );
}

function clip(raw, max = 160) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, max);
}

export function looksLikeNoreplyAddress(address) {
  const a = String(address || "").toLowerCase();
  return /noreply|no-reply|donotreply|do-not-reply|newsletter|newsdigest|notifications?@|mailer-daemon/.test(
    a
  );
}

/**
 * @param {{ db?: string, limit?: number }} [opts]
 */
export async function listMailCorrespondents(opts = {}) {
  const db = opts.db || defaultMailEnvelopeDb();
  const limit = Math.min(Math.max(Number(opts.limit) || 800, 1), 2000);
  const sql = `
    SELECT
      a.comment as name,
      a.address as address,
      COUNT(*) as n
    FROM messages m
    JOIN addresses a ON a.ROWID = m.sender
    WHERE a.address IS NOT NULL AND a.address != ''
    GROUP BY a.ROWID
    ORDER BY n DESC
    LIMIT ${limit};
  `;
  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      ["-readonly", "-json", db, sql],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }
    );
    const text = String(stdout || "").trim();
    const rows = text ? JSON.parse(text) : [];
    const people = (Array.isArray(rows) ? rows : []).map((row) => {
      const address = clip(row.address, 120);
      const name = clip(row.name, 80) || address;
      return {
        name,
        address,
        count: Number(row.n) || 0,
        likelyNoreply: looksLikeNoreplyAddress(address),
      };
    });
    return { ok: true, count: people.length, people };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      /unable to open|authorization|permission|not a database/i.test(msg)
        ? "Mail Envelope Index unreadable. Grant Full Disk Access to node."
        : msg
    );
    wrapped.cause = err;
    throw wrapped;
  }
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  listMailCorrespondents()
    .then((payload) => {
      console.log(JSON.stringify(payload, null, 2));
    })
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}
