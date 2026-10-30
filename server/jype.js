/**
 * Shared JYPE workspace (Yan, Alex, Example Friend, Example Neighbor).
 * Data lives in OneDrive Projects/JYPE. Chats go in that tree's
 * .chat-history, not anyone's personal folder.
 */

import { canonicalizeEmail } from "./identity.js";
import { JYPE_DIR } from "./onedrive-projects.js";

export const JYPE_WORKSPACE = "jype";
export const JYPE_ROOT_REL = "education/projects/jype";

/** Personal Gmail used for Google login on /jype. */
export const JYPE_MEMBERS = Object.freeze({
  "you@example.com": { slug: "yan-levin", given: "Yan" },
  "you@example.com": { slug: "alex-rivera", given: "Alex" },
  "friend@example.com": { slug: "example-friend", given: "Example Friend" },
  "neighbor@example.com": { slug: "example-neighbor", given: "Example Neighbor" },
});

export const JYPE_EMAILS = new Set(Object.keys(JYPE_MEMBERS));

/** School / iCloud aliases that should map onto the Gmail row. */
export const JYPE_EMAIL_ALIASES = Object.freeze({
  "you@icloud.com": "you@example.com",
  "you@icloud.com": "you@example.com",
  "you@example.com": "you@example.com",
  "friend@school.example": "you@example.com",
  "jxu28@school.example": "friend@example.com",
  "edeng@school.example": "neighbor@example.com",
});

export function jypeRootAbs() {
  return JYPE_DIR;
}

export function normalizeJypeWorkspace(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  return s === JYPE_WORKSPACE ? JYPE_WORKSPACE : "";
}

export function canonicalizeJypeEmail(email) {
  const normalized = canonicalizeEmail(email);
  if (!normalized) return "";
  return JYPE_EMAIL_ALIASES[normalized] || normalized;
}

export function isJypeMember(email) {
  const canonical = canonicalizeJypeEmail(email);
  return JYPE_EMAILS.has(canonical);
}

export function jypeMember(email) {
  const canonical = canonicalizeJypeEmail(email);
  const row = JYPE_MEMBERS[canonical];
  if (!row) return null;
  return { email: canonical, ...row };
}

export function jypeGivenName(email) {
  return jypeMember(email)?.given || "";
}

export function jypeEmailForSlug(slug) {
  const key = String(slug || "").trim().toLowerCase();
  if (!key) return "";
  for (const [email, row] of Object.entries(JYPE_MEMBERS)) {
    if (row.slug === key) return email;
  }
  return "";
}

/**
 * @param {object|null|undefined} origin
 */
export function originIsJypeThread(origin) {
  if (!origin || typeof origin !== "object") return false;
  const labels = [origin.chat, origin.to, origin.threadLabel, origin.name];
  return labels.some((label) => /\bjype\b/i.test(String(label || "")));
}
