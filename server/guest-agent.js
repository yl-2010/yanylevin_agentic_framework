/**
 * Other people calling @agent on iMessage / Teams.
 * Yan fromMe stays on the existing Personal Agent path. This module is
 * contacts, clock-hour limits, and guest model pick.
 */

import { readFile, writeFile } from "node:fs/promises";
import { listEntities } from "./brain-lib.js";
import { contactMatchesQuery } from "./contacts-read.js";
import {
  applyAgentSentFooter,
  isClassOf2028Thread,
  isGradeWideThread,
  isJypeThread,
  normalizeIMessageOrigin,
  replyTargetForMessage,
} from "./imessage-mention.js";
import { sendIMessage } from "./imessage-send.js";
import { isDirectChatId } from "./imessage-read.js";
import { sendTeamsMessage } from "./school-teams.js";
import { normalizeTeamsOrigin } from "./teams-mention.js";
import {
  isJypeMember,
  jypeEmailForSlug,
  originIsJypeThread,
} from "./jype.js";

export const GUEST_LIMITS_PATH = "/tmp/yanylevin-guest-agent-limits.json";
export const GUEST_TZ = "America/Los_Angeles";
export const HOURLY_LIMIT = 5;
export const FRIEND_HOURLY_LIMIT = 20;
export const CONTACTS_TTL_MS = 60_000;
export const PEOPLE_TTL_MS = 60_000;

/** Grok turns per Pacific clock hour, per platform. Then Composer. */
export const GROK_HOURLY = {
  "alex-rivera": FRIEND_HOURLY_LIMIT,
  "example-friend": FRIEND_HOURLY_LIMIT / 2,
  "example-neighbor": FRIEND_HOURLY_LIMIT / 2,
};

export const HOURLY_BY_SLUG = {
  "alex-rivera": FRIEND_HOURLY_LIMIT,
  "example-friend": FRIEND_HOURLY_LIMIT,
  "example-neighbor": FRIEND_HOURLY_LIMIT,
};

export function hourlyLimitForSlug(slug) {
  const n = Number(HOURLY_BY_SLUG[String(slug || "")]);
  return n > 0 ? n : HOURLY_LIMIT;
}

/** Teams Class of 2028 only. Yan is fromMe and never hits this. */
export const TEAMS_CLASS_OF_2028_ALLOW_SLUGS = new Set([
  "alex-rivera",
  "example-friend",
  "example-neighbor",
]);

export const TEAMS_CLASS_OF_2028_ALLOW_GIVEN = new Set([
  "prasham",
  "jeffery",
  "everette",
]);

export const GUEST_COMPOSER_SPEC = {
  id: "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

export const GUEST_FRIEND_COMPOSER_SPEC = {
  id: "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

/** Grok for @agent (iMessage / Teams / JYPE group). Fast off. */
export const GUEST_GROK_SPEC = {
  id: "grok-4.7",
  params: [
    { id: "context", value: "256k" },
    { id: "reasoning_effort", value: "high" },
    { id: "fast", value: "false" },
  ],
};

/** @param {{ id?: string, params?: { id: string, value: string }[] }|null|undefined} spec */
export function copyModelSpec(spec) {
  return {
    id: String(spec?.id || ""),
    params: (spec?.params || []).map((p) => ({
      id: String(p.id),
      value: String(p.value),
    })),
  };
}

/** Fast off, keep other params (reasoning_effort, context, etc.). */
export function withoutFast(spec) {
  const next = copyModelSpec(spec);
  next.params = next.params.filter((p) => p.id !== "fast");
  next.params.push({ id: "fast", value: "false" });
  return next;
}

export function isFriendGuest(slug, name = "") {
  if (HOURLY_BY_SLUG[String(slug || "")]) return true;
  return TEAMS_CLASS_OF_2028_ALLOW_GIVEN.has(givenNameOf(name).toLowerCase());
}

const PLATFORMS = ["imessage", "teams"];

/** @type {{ at: number, rows: object[]|null }} */
let contactsCache = { at: 0, rows: null };
/** @type {{ at: number, rows: object[]|null }} */
let peopleCache = { at: 0, rows: null };

export function resetGuestAgentCaches() {
  contactsCache = { at: 0, rows: null };
  peopleCache = { at: 0, rows: null };
}

export function phoneDigits(raw) {
  return String(raw || "").replace(/\D/g, "");
}

export function phonesMatch(a, b) {
  const da = phoneDigits(a);
  const db = phoneDigits(b);
  if (!da || !db) return false;
  if (da === db) return true;
  const last10 = (s) => (s.length >= 10 ? s.slice(-10) : "");
  const a10 = last10(da);
  const b10 = last10(db);
  return Boolean(a10 && a10 === b10);
}

export function normalizeEmail(raw) {
  return String(raw || "").trim().toLowerCase();
}

/**
 * @param {Date} date
 * @param {string} [tz]
 */
export function zonedParts(date, tz = GUEST_TZ) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
  });
  /** @type {Record<string, string>} */
  const parts = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: Number(parts.hour),
  };
}

export function hourKey(date, tz = GUEST_TZ) {
  const p = zonedParts(date, tz);
  return `${p.year}-${p.month}-${p.day}T${String(p.hour).padStart(2, "0")}`;
}

export function dayKey(date, tz = GUEST_TZ) {
  const p = zonedParts(date, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Next Pacific clock hour, like "6:00 PM".
 * @param {Date} date
 * @param {string} [tz]
 */
export function formatRetryAt(date, tz = GUEST_TZ) {
  const p = zonedParts(date, tz);
  const nextHour = (p.hour + 1) % 24;
  const hour12 = nextHour % 12 || 12;
  const ampm = nextHour < 12 ? "AM" : "PM";
  return `${hour12}:00 ${ampm}`;
}

export function formatRateLimitMessage(retryAt) {
  return `Your hourly rate limit has been reached. Try again at ${retryAt}.`;
}

/**
 * @param {{ name: string, platform: string, text: string }} opts
 */
export function formatGuestUserBubble(opts) {
  const name = String(opts?.name || "someone").trim() || "someone";
  const platform = String(opts?.platform || "").trim() || "iMessage";
  const text = String(opts?.text || "").trim();
  return `From ${name} on ${platform}:\n\n${text}`;
}

export function platformLabel(platform) {
  return String(platform || "").toLowerCase() === "teams" ? "Teams" : "iMessage";
}

export function personSlug(entity) {
  return String(entity?.id || "")
    .replace(/^people\//, "")
    .trim();
}

export function givenNameOf(raw) {
  const name = String(raw || "").trim();
  if (!name) return "";
  return name.split(/\s+/)[0];
}

/**
 * @param {object} row
 * @param {string} handle
 */
export function contactHasHandle(row, handle) {
  const h = String(handle || "").trim();
  if (!h || !row) return false;
  if (h.includes("@")) {
    const emails = String(row.emails || "")
      .toLowerCase()
      .split(/[\s,;]+/)
      .filter(Boolean);
    return emails.includes(h.toLowerCase());
  }
  const phones = String(row.phones || "");
  if (phonesMatch(phones, h)) return true;
  for (const part of phones.split(/[\s,;|/]+/)) {
    if (part && phonesMatch(part, h)) return true;
  }
  return contactMatchesQuery(row, h);
}

function emailsOf(entity) {
  const fields = entity?.fields || {};
  const raw = Array.isArray(fields.emails) ? fields.emails : [];
  return raw.map((e) => normalizeEmail(e)).filter(Boolean);
}

function phonesOf(entity) {
  const fields = entity?.fields || {};
  return Array.isArray(fields.phones) ? fields.phones : [];
}

function aliasesOf(entity) {
  const fields = entity?.fields || {};
  const raw = Array.isArray(fields.aliases) ? fields.aliases : [];
  return raw.map((a) => String(a || "").trim().toLowerCase()).filter(Boolean);
}

/**
 * @param {object} entity
 * @param {{ handle?: string, email?: string, name?: string }} ids
 */
export function personMatches(entity, ids) {
  if (!entity) return false;
  const handle = String(ids?.handle || "").trim();
  const email = normalizeEmail(ids?.email || (handle.includes("@") ? handle : ""));
  const name = String(ids?.name || "").trim().toLowerCase();
  const emails = emailsOf(entity);
  const phones = phonesOf(entity);
  if (email && emails.includes(email)) return true;
  if (handle && !handle.includes("@") && phones.some((p) => phonesMatch(p, handle))) {
    return true;
  }
  if (!name) return false;
  const full = String(entity.name || "").trim().toLowerCase();
  if (full && full === name) return true;
  const aliases = aliasesOf(entity);
  if (aliases.includes(name)) return true;
  return false;
}

function identifierMatch(entity, ids) {
  const handle = String(ids?.handle || "").trim();
  const email = normalizeEmail(ids?.email || (handle.includes("@") ? handle : ""));
  const emails = emailsOf(entity);
  const phones = phonesOf(entity);
  if (email && emails.includes(email)) return true;
  if (handle && !handle.includes("@") && phones.some((p) => phonesMatch(p, handle))) {
    return true;
  }
  return false;
}

/**
 * @param {object[]} people
 * @param {{ handle?: string, email?: string, name?: string }} ids
 */
export function resolvePerson(people, ids) {
  const list = Array.isArray(people) ? people : [];
  const hits = list.filter((p) => personMatches(p, ids));
  if (hits.length === 1) return hits[0];
  const exact = hits.filter((p) => identifierMatch(p, ids));
  if (exact.length === 1) return exact[0];
  const fullName = String(ids?.name || "").trim().toLowerCase();
  if (fullName.includes(" ")) {
    const named = hits.filter(
      (p) => String(p.name || "").trim().toLowerCase() === fullName
    );
    if (named.length === 1) return named[0];
  }
  return null;
}

export function displayGivenName({ person, contact, fromName }) {
  if (person?.name) return givenNameOf(person.name) || "someone";
  const first = String(contact?.first || "").trim();
  if (first) return first;
  const from = givenNameOf(fromName);
  if (from) return from;
  const contactName = givenNameOf(contact?.name);
  if (contactName) return contactName;
  return "someone";
}

/**
 * @param {unknown} raw
 */
export function parseLimitState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  /** @type {Record<string, Record<string, { hourKey: string, hourCount: number, dayKey: string, grokCount: number }>>} */
  const out = { imessage: {}, teams: {} };
  for (const platform of PLATFORMS) {
    const bag = src[platform] && typeof src[platform] === "object" ? src[platform] : {};
    /** @type {Record<string, { hourKey: string, hourCount: number, dayKey: string, grokCount: number }>} */
    const next = {};
    for (const [key, row] of Object.entries(bag)) {
      const id = String(key || "").trim();
      if (!id) continue;
      const rec = row && typeof row === "object" ? row : {};
      next[id] = {
        hourKey: String(rec.hourKey || ""),
        hourCount: Math.max(0, Number(rec.hourCount) || 0),
        dayKey: String(rec.dayKey || ""),
        grokCount: Math.max(0, Number(rec.grokCount) || 0),
      };
    }
    out[platform] = next;
  }
  return out;
}

export async function loadLimitState(path = GUEST_LIMITS_PATH) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return parseLimitState(raw);
  } catch {
    return parseLimitState({});
  }
}

export async function saveLimitState(state, path = GUEST_LIMITS_PATH) {
  const next = parseLimitState(state);
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * Count one guest @agent against the clock-hour and (if eligible) Grok day.
 * @param {{
 *   platform: 'imessage'|'teams',
 *   personKey: string,
 *   slug?: string,
 *   now?: Date,
 *   statePath?: string,
 * }} opts
 */
export async function takeGuestSlot(opts) {
  const platform = opts.platform === "teams" ? "teams" : "imessage";
  const personKey = String(opts.personKey || "").trim();
  const slug = String(opts.slug || "").trim();
  const now = opts.now || new Date();
  const path = opts.statePath || GUEST_LIMITS_PATH;
  if (!personKey) {
    return { overHourly: true, useGrok: false };
  }
  const state = await loadLimitState(path);
  const hour = hourKey(now);
  const day = dayKey(now);
  const bag = state[platform];
  const row = bag[personKey] || {
    hourKey: "",
    hourCount: 0,
    dayKey: "",
    grokCount: 0,
  };
  if (row.hourKey !== hour) {
    row.hourKey = hour;
    row.hourCount = 0;
    row.grokCount = 0;
  }
  if (row.dayKey !== day) {
    row.dayKey = day;
    row.grokCount = 0;
  }
  const hourCap = hourlyLimitForSlug(slug);
  if (row.hourCount >= hourCap) {
    bag[personKey] = row;
    await saveLimitState(state, path);
    return { overHourly: true, useGrok: false, hourCount: row.hourCount };
  }
  row.hourCount += 1;
  const grokCap = Number(GROK_HOURLY[slug]) || 0;
  let useGrok = false;
  if (grokCap > 0 && row.grokCount < grokCap) {
    row.grokCount += 1;
    useGrok = true;
  }
  bag[personKey] = row;
  await saveLimitState(state, path);
  return {
    overHourly: false,
    useGrok,
    hourCount: row.hourCount,
    grokCount: row.grokCount,
  };
}

export function isTeamsOneOnOne(message) {
  return String(message?.chatType || "").trim().toLowerCase() === "oneonone";
}

export function isTeamsClassOf2028Chat(message) {
  if (!message || typeof message !== "object") return false;
  if (isTeamsOneOnOne(message)) return false;
  return isClassOf2028Thread(message.chat);
}

export function isAllowedTeamsClassOf2028Caller(slug, fromName) {
  if (TEAMS_CLASS_OF_2028_ALLOW_SLUGS.has(String(slug || "").trim())) return true;
  const given = givenNameOf(fromName).toLowerCase();
  return TEAMS_CLASS_OF_2028_ALLOW_GIVEN.has(given);
}

function viewerLabels(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    const label =
      typeof row === "string"
        ? row.trim()
        : String(row?.name || row?.email || "").trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    if (/^yan(\s|$)/i.test(label)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * Who will see the outbound reply. dm = 1:1, group = everyone in the thread.
 * @param {'imessage'|'teams'} platform
 * @param {object} message
 */
export function describeGuestAudience(platform, message) {
  const chat = String(message?.chat || "").trim();
  const kind =
    platform === "teams"
      ? isTeamsOneOnOne(message)
        ? "dm"
        : "group"
      : isDirectChatId(message?.chatId, message?.handle)
        ? "dm"
        : "group";
  const viewers =
    platform === "teams"
      ? viewerLabels(message?.members || message?.viewers)
      : viewerLabels(
          message?.members || message?.viewers || message?.participants
        );
  const gradeWide = kind === "group" && isGradeWideThread(chat);
  return {
    kind,
    threadLabel: chat,
    viewers,
    ...(gradeWide ? { gradeWide: true } : {}),
  };
}

export function quotaKeyFor(handle, slug) {
  if (slug) return slug;
  const h = String(handle || "").trim().toLowerCase();
  const digits = phoneDigits(h);
  if (digits.length >= 10) return `phone:${digits.slice(-10)}`;
  if (h.includes("@")) return `email:${h}`;
  return h ? `id:${h}` : "";
}

async function getCachedContacts(deps = {}) {
  if (Array.isArray(deps.contacts)) return deps.contacts;
  const now = Date.now();
  if (contactsCache.rows && now - contactsCache.at < CONTACTS_TTL_MS) {
    return contactsCache.rows;
  }
  const list =
    deps.listContacts ||
    (await import("./contacts-read.js")).listContacts;
  let rows = [];
  try {
    rows = await list();
  } catch {
    rows = [];
  }
  const listRows = Array.isArray(rows) ? rows : [];
  contactsCache = { at: now, rows: listRows };
  return listRows;
}

function getCachedPeople(deps = {}) {
  if (Array.isArray(deps.people)) return deps.people;
  const now = Date.now();
  if (peopleCache.rows && now - peopleCache.at < PEOPLE_TTL_MS) {
    return peopleCache.rows;
  }
  let rows = [];
  try {
    const listed = deps.listPeople ? deps.listPeople() : listEntities().entities;
    rows = (Array.isArray(listed) ? listed : []).filter((e) => {
      const kind = String(e?.kind || "");
      const id = String(e?.id || "");
      return kind === "person" || id.startsWith("people/");
    });
  } catch {
    rows = [];
  }
  peopleCache = { at: now, rows };
  return rows;
}

function guestModelSpec(useGrok, slug, name) {
  const friend = isFriendGuest(slug, name);
  if (useGrok && friend) return copyModelSpec(GUEST_GROK_SPEC);
  if (friend) return copyModelSpec(GUEST_FRIEND_COMPOSER_SPEC);
  return copyModelSpec(GUEST_COMPOSER_SPEC);
}

function messageIsJypeThread(message) {
  return originIsJypeThread(message) || isJypeThread(message?.chat);
}

function isJypeGuestCaller(slug, email, name) {
  if (jypeEmailForSlug(slug)) return true;
  if (isJypeMember(email)) return true;
  return TEAMS_CLASS_OF_2028_ALLOW_GIVEN.has(givenNameOf(name).toLowerCase());
}

/** Preferred + fallback for a guest @agent turn. Friends stay on Composer if Grok fails. */
export function guestRunModels(caller) {
  const friend = isFriendGuest(caller?.slug, caller?.displayName);
  const preferred = caller?.model ? copyModelSpec(caller.model) : null;
  return {
    preferred,
    fallback: friend ? copyModelSpec(GUEST_FRIEND_COMPOSER_SPEC) : null,
  };
}

/**
 * Decide what to do with a non-Yan @agent mention.
 * Yan fromMe never belongs here; the poller should skip this.
 *
 * @param {{
 *   platform: 'imessage'|'teams',
 *   message: object,
 *   now?: Date,
 *   contacts?: object[],
 *   people?: object[],
 *   listContacts?: () => Promise<object[]>,
 *   listPeople?: () => object[],
 *   statePath?: string,
 * }} opts
 * @returns {Promise<{
 *   action: 'ignore'|'rate-limit'|'start',
 *   caller?: object,
 *   text?: string,
 *   platform?: string,
 * }>}
 */
export async function evaluateGuestMention(opts) {
  const platform = opts.platform === "teams" ? "teams" : "imessage";
  const message = opts.message || {};
  const now = opts.now || new Date();

  if (message.fromMe === true) {
    return { action: "ignore" };
  }

  const people = getCachedPeople(opts);
  let handle = "";
  let email = "";
  let fromName = "";
  /** @type {object|null} */
  let contact = null;
  let inContacts = false;

  if (platform === "imessage") {
    handle = String(message.handle || "").trim();
    if (!handle) return { action: "ignore" };
    let contacts = [];
    try {
      contacts = await getCachedContacts(opts);
    } catch {
      return { action: "ignore" };
    }
    contact = contacts.find((row) => contactHasHandle(row, handle)) || null;
    inContacts = Boolean(contact);
    if (!inContacts) return { action: "ignore" };
    fromName = String(contact.name || contact.first || "").trim();
    if (handle.includes("@")) email = handle;
  } else {
    email = String(message.fromEmail || "").trim();
    fromName = String(message.from || "").trim();
    handle = email || fromName;
    if (!handle) return { action: "ignore" };
    inContacts = true;
  }

  const person = resolvePerson(people, {
    handle,
    email,
    name: fromName || contact?.name,
  });
  const slug = person ? personSlug(person) : "";
  const displayName = displayGivenName({ person, contact, fromName });
  if (
    platform === "teams" &&
    isTeamsClassOf2028Chat(message) &&
    !isAllowedTeamsClassOf2028Caller(slug, fromName)
  ) {
    return { action: "ignore" };
  }
  const personKey = quotaKeyFor(handle, slug);
  if (!personKey) return { action: "ignore" };

  if (messageIsJypeThread(message)) {
    if (!isJypeGuestCaller(slug, email, fromName)) {
      return { action: "ignore" };
    }
    return {
      action: "start",
      platform,
      caller: {
        displayName,
        slug,
        platform,
        handle,
        inContacts,
        audience: describeGuestAudience(platform, message),
        model: copyModelSpec(GUEST_GROK_SPEC),
        workspace: "jype",
      },
    };
  }

  const slot = await takeGuestSlot({
    platform,
    personKey,
    slug,
    now,
    statePath: opts.statePath,
  });

  if (slot.overHourly) {
    return {
      action: "rate-limit",
      platform,
      text: formatRateLimitMessage(formatRetryAt(now)),
    };
  }

  return {
    action: "start",
    platform,
    caller: {
      displayName,
      slug,
      platform,
      handle,
      inContacts,
      audience: describeGuestAudience(platform, message),
      model: guestModelSpec(Boolean(slot.useGrok), slug, displayName),
    },
  };
}

/**
 * Programmatic hourly-cap reply. No agent.
 * @param {{
 *   platform: 'imessage'|'teams',
 *   message: object,
 *   text: string,
 *   sendIMessage?: typeof sendIMessage,
 *   sendTeamsMessage?: typeof sendTeamsMessage,
 * }} opts
 */
export async function deliverGuestRateLimit(opts) {
  const text = String(opts.text || "").trim();
  if (!text) return { ok: false, skipped: "empty" };
  const message = opts.message || {};
  if (opts.platform === "teams") {
    const origin = normalizeTeamsOrigin(message);
    const chat = String(origin?.chatId || origin?.to || origin?.chat || "").trim();
    if (!chat) return { ok: false, skipped: "no-target" };
    const send = opts.sendTeamsMessage || sendTeamsMessage;
    return send({ chat, text });
  }
  const origin = normalizeIMessageOrigin(message);
  const to =
    String(origin?.to || "").trim() ||
    replyTargetForMessage(message) ||
    String(origin?.chatId || origin?.handle || "").trim();
  const chatGuid = String(origin?.chatGuid || message.chatGuid || "").trim();
  if (!to && !chatGuid) return { ok: false, skipped: "no-target" };
  const send = opts.sendIMessage || sendIMessage;
  return send({
    to: to || chatGuid,
    text: applyAgentSentFooter(text, origin),
    chatGuid: chatGuid || undefined,
  });
}
