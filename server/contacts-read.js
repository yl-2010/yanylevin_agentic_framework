/**
 * Read-only dump of Yan's Apple Contacts via AddressBook sqlite.
 * LaunchAgent node (Full Disk Access). Never copies the DB into the repo.
 */

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ADDRESSBOOK_ROOT = join(
  homedir(),
  "Library/Application Support/AddressBook"
);

function clip(raw, max = 200) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, max);
}

/**
 * @param {string} db
 * @param {string} sql
 */
async function queryDb(db, sql) {
  const { stdout } = await execFileAsync(
    "sqlite3",
    ["-readonly", "-json", db, sql],
    { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }
  );
  const text = String(stdout || "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

export function defaultAddressBookDbs() {
  return [
    join(ADDRESSBOOK_ROOT, "AddressBook-v22.abcddb"),
    join(ADDRESSBOOK_ROOT, "Sources/*/AddressBook-v22.abcddb"),
  ];
}

/**
 * @param {string} [root]
 */
export async function listAddressBookDbPaths(root = ADDRESSBOOK_ROOT) {
  /** @type {string[]} */
  const paths = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.name === "AddressBook-v22.abcddb") paths.push(p);
    }
  }
  await walk(root);
  return paths.sort();
}

function personKey(row) {
  const name = clip(`${row.first || ""} ${row.last || ""}`.trim() || row.organization, 120).toLowerCase();
  const email = clip(String(row.emails || "").split(/\s+/)[0], 80).toLowerCase();
  const phone = clip(String(row.phones || "").replace(/\D/g, ""), 20);
  return `${name}|${email}|${phone}`;
}

export function looksLikeBusinessContact(row) {
  const org = clip(row.organization, 80);
  const first = clip(row.first, 40);
  const last = clip(row.last, 40);
  const emails = clip(row.emails, 200).toLowerCase();
  if (!first && !last && org) return true;
  if (/\b(noreply|no-reply|donotreply|newsletter|newsdigest)\b/i.test(emails)) {
    return true;
  }
  if (/\b(llc|inc\.?|ltd\.?|corp\.?)\b/i.test(`${first} ${last} ${org}`)) {
    return true;
  }
  return false;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} query
 */
export function contactMatchesQuery(row, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return false;
  const hay = [
    row.name,
    row.first,
    row.last,
    row.nickname,
    row.organization,
    row.emails,
    row.phones,
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
  if (hay.includes(q)) return true;
  const digits = q.replace(/\D/g, "");
  if (digits.length >= 4) {
    const phones = String(row.phones || "").replace(/\D/g, "");
    if (phones.includes(digits)) return true;
  }
  return false;
}

/**
 * @param {string} query
 * @param {{ root?: string, people?: Record<string, unknown>[] }} [opts]
 */
export async function searchContacts(query, opts = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const people = Array.isArray(opts.people)
    ? opts.people
    : await listContacts(opts);
  return people.filter((row) => contactMatchesQuery(row, q));
}

/**
 * @param {{ root?: string }} [opts]
 */
export async function listContacts(opts = {}) {
  const dbs = await listAddressBookDbPaths(opts.root || ADDRESSBOOK_ROOT);
  /** @type {Map<string, Record<string, unknown>>} */
  const byKey = new Map();
  for (const db of dbs) {
    let rows;
    try {
      rows = await queryDb(
        db,
        `SELECT
          r.ZFIRSTNAME as first,
          r.ZLASTNAME as last,
          r.ZNICKNAME as nickname,
          r.ZORGANIZATION as organization,
          (SELECT GROUP_CONCAT(e.ZADDRESS, ' ') FROM ZABCDEMAILADDRESS e WHERE e.ZOWNER = r.Z_PK) as emails,
          (SELECT GROUP_CONCAT(p.ZFULLNUMBER, ' ') FROM ZABCDPHONENUMBER p WHERE p.ZOWNER = r.Z_PK) as phones
        FROM ZABCDRECORD r
        WHERE r.ZFIRSTNAME IS NOT NULL
           OR r.ZLASTNAME IS NOT NULL
           OR r.ZORGANIZATION IS NOT NULL`
      );
    } catch {
      continue;
    }
    for (const raw of rows) {
      const row = {
        first: clip(raw.first, 60),
        last: clip(raw.last, 60),
        nickname: clip(raw.nickname, 60),
        organization: clip(raw.organization, 80),
        emails: clip(raw.emails, 240),
        phones: clip(raw.phones, 120),
      };
      row.name = clip(`${row.first} ${row.last}`.trim() || row.organization, 120);
      if (!row.name) continue;
      row.likelyBusiness = looksLikeBusinessContact(row);
      const key = personKey(row);
      if (!byKey.has(key)) byKey.set(key, row);
    }
  }
  return [...byKey.values()].sort((a, b) =>
    String(a.name).localeCompare(String(b.name))
  );
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const args = process.argv.slice(2);
  const cmd = args[0] || "list";
  const rest = args.slice(1).join(" ");
  const run = async () => {
    if (cmd === "search") {
      const people = await searchContacts(rest);
      return { ok: true, count: people.length, people };
    }
    if (cmd === "list" || cmd === "help") {
      if (cmd === "help") {
        return {
          ok: false,
          usage: "node contacts-read.js list | search <name-or-phone>",
        };
      }
      const people = await listContacts();
      return { ok: true, count: people.length, people };
    }
    const people = await searchContacts([cmd, rest].filter(Boolean).join(" "));
    return { ok: true, count: people.length, people };
  };
  run()
    .then((rows) => {
      console.log(JSON.stringify(rows, null, 2));
    })
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}
