// Report person facts that leaked onto Yan's identity pages.
// Nightly lint relocates them to the matching card. Not a write ban.
//
//   node server/brain-placement-lint.js
//   node server/brain-placement-lint.js --report-only

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAIN_ROOT } from "./brain-lib.js";

export const YAN_EMAILS = new Set(
  [process.env.OWNER_EMAIL || "you@example.com", ...(process.env.OWNER_EMAIL_ALIASES || "").split(",")]
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

export const YAN_PHONES = new Set((process.env.OWNER_PHONES || "").split(",").map((p) => p.replace(/\D/g, "")).filter(Boolean));

const IDENTITY_FILES = [
  "identity.md",
  "identity-school.md",
  "identity-accounts.md",
  "identity-logistics.md",
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
const KEYWORD_RE =
  /\b(?:spelling|alias(?:es)?|nickname|born|never took Levin)\b/i;

function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/**
 * @param {string} file
 * @param {string} text
 * @returns {{ file: string, line: number, reason: string, text: string }[]}
 */
export function lintIdentityText(file, text) {
  const hits = [];
  const lines = String(text || "").split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const n = i + 1;
    for (const m of trimmed.matchAll(EMAIL_RE)) {
      if (!YAN_EMAILS.has(m[0].toLowerCase())) {
        hits.push({ file, line: n, reason: "other-email", text: trimmed });
      }
    }
    for (const m of trimmed.matchAll(PHONE_RE)) {
      if (!YAN_PHONES.has(normalizePhone(m[0]))) {
        hits.push({ file, line: n, reason: "other-phone", text: trimmed });
      }
    }
    if (KEYWORD_RE.test(trimmed)) {
      hits.push({ file, line: n, reason: "person-keyword", text: trimmed });
    }
  });
  return hits;
}

/**
 * @param {string} [brainRoot]
 */
export function lintIdentityPages(brainRoot = BRAIN_ROOT) {
  const hits = [];
  for (const name of IDENTITY_FILES) {
    const p = path.join(brainRoot, name);
    if (!fs.existsSync(p)) continue;
    hits.push(...lintIdentityText(name, fs.readFileSync(p, "utf8")));
  }
  return hits;
}

function formatHit(h) {
  return `placement: ${h.file}:${h.line}: ${h.reason}: ${h.text}`;
}

export function main(argv = process.argv) {
  const hits = lintIdentityPages();
  if (!hits.length) {
    console.log("ok: identity pages have no person-fact leaks");
    return 0;
  }
  for (const h of hits) console.error(formatHit(h));
  if (argv.includes("--report-only")) return 0;
  return 1;
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) process.exit(main());
