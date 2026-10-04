/**
 * Canonical account identity. One operator.
 * Set OWNER_EMAIL (and optional comma-separated OWNER_EMAIL_ALIASES) in server/.env
 */

function loadOwnerEmail() {
  return String(process.env.OWNER_EMAIL || "you@example.com").trim().toLowerCase();
}

function loadAliases() {
  const owner = loadOwnerEmail();
  /** @type {Record<string, string>} */
  const aliases = {};
  const raw = process.env.OWNER_EMAIL_ALIASES || "you@icloud.com";
  for (const part of raw.split(",")) {
    const a = part.trim().toLowerCase();
    if (a && a !== owner) aliases[a] = owner;
  }
  return Object.freeze(aliases);
}

export const OWNER_EMAIL = loadOwnerEmail();
/** Compat alias used by nightly jobs. */
export const YAN_EMAIL = OWNER_EMAIL;

export const FULL_ACCESS_EMAILS = new Set([OWNER_EMAIL]);
export const EMAIL_ALIASES = loadAliases();

/** @param {string|null|undefined} email */
export function canonicalizeEmail(email) {
  if (!email) return "";
  const normalized = String(email).trim().toLowerCase();
  return EMAIL_ALIASES[normalized] || normalized;
}

/** @param {string|null|undefined} email */
export function isFullAccessEmail(email) {
  if (!email) return false;
  return FULL_ACCESS_EMAILS.has(canonicalizeEmail(email));
}

/** @param {string|null|undefined} email */
export function isOwner(email) {
  return isFullAccessEmail(email);
}

export const JYPE_ACCESS_EMAILS = new Set();
export const STUDY_ONLY_EMAILS = new Set();

/** Template has one operator, who can open the group and study apps. */
export function isJypeAccessEmail(email) {
  return isFullAccessEmail(email);
}

/** @param {string|null|undefined} email */
export function isStudyAccessEmail(email) {
  return isFullAccessEmail(email);
}
