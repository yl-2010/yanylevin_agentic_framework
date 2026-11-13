/**
 * iPhone and iPad push tokens, Live Activity tokens, and dismissed alert ids.
 * Gitignored. The API writes it. The agent worker reads it.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeEmail } from "./identity.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PUSH_CAP_PER_HOUR = 8;
export const PUSH_CAP_WINDOW_MS = 60 * 60 * 1000;
export const DISMISS_TTL_MS = 24 * 60 * 60 * 1000;

export function pushDevicesPath() {
  return process.env.PUSH_DEVICES_PATH || join(REPO_ROOT, "data", "push-devices.json");
}

function emptyStore() {
  return { accounts: {} };
}

/**
 * @param {string} email
 */
function accountKey(email) {
  return canonicalizeEmail(email);
}

/**
 * @param {ReturnType<typeof emptyStore>} data
 * @param {string} email
 */
function accountOf(data, email) {
  const key = accountKey(email);
  if (!key) return null;
  if (!data.accounts[key]) {
    data.accounts[key] = {
      devices: [],
      liveActivities: [],
      dismissed: [],
      pushTimes: [],
    };
  }
  return data.accounts[key];
}

/**
 * @param {ReturnType<typeof emptyStore>} data
 * @param {number} [now]
 */
function prune(data, now = Date.now()) {
  for (const acct of Object.values(data.accounts || {})) {
    acct.dismissed = (acct.dismissed || []).filter(
      (row) => row && now - Number(row.at || 0) < DISMISS_TTL_MS
    );
    acct.pushTimes = (acct.pushTimes || []).filter(
      (at) => now - Number(at) < PUSH_CAP_WINDOW_MS
    );
  }
}

/** @type {Promise<void>} */
let chain = Promise.resolve();

/**
 * @template T
 * @param {(data: ReturnType<typeof emptyStore>) => T|Promise<T>} mutator
 * @returns {Promise<T>}
 */
function update(mutator) {
  const run = chain.then(async () => {
    const loaded = await readStore();
    if (!loaded.ok || !loaded.data) {
      throw new Error("push device store unreadable");
    }
    const data = loaded.data;
    prune(data);
    const result = await mutator(data);
    await writeStore(data);
    return result;
  });
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function readStore() {
  try {
    const raw = await readFile(pushDevicesPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.accounts) {
      return { ok: true, data: emptyStore() };
    }
    return { ok: true, data: parsed };
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: true, data: emptyStore() };
    console.error("[push-devices] read", err);
    return { ok: false, data: null };
  }
}

/**
 * @param {ReturnType<typeof emptyStore>} data
 */
async function writeStore(data) {
  const path = pushDevicesPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, path);
}

function hexToken(value) {
  const token = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{32,}$/.test(token)) return "";
  return token;
}

/**
 * @param {string} email
 * @param {{ deviceId: string, token: string, sandbox: boolean, idiom?: string, name?: string }} row
 */
export function registerDevice(email, row) {
  const deviceId = String(row?.deviceId || "").trim().slice(0, 80);
  const token = hexToken(row?.token);
  if (!accountKey(email) || !deviceId || !token) {
    return Promise.reject(new Error("deviceId and token are required"));
  }
  return update((data) => {
    const acct = accountOf(data, email);
    const now = new Date().toISOString();
    const next = {
      deviceId,
      token,
      sandbox: Boolean(row.sandbox),
      idiom: row.idiom === "pad" ? "pad" : "phone",
      name: String(row.name || "").trim().slice(0, 80),
      updatedAt: now,
    };
    const list = acct.devices || [];
    const idx = list.findIndex((d) => d.deviceId === deviceId);
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    acct.devices = list;
    return { ok: true };
  });
}

/**
 * @param {string} email
 */
export function listDevices(email) {
  return update((data) => {
    const acct = data.accounts?.[accountKey(email)];
    return (acct?.devices || []).map((d) => ({ ...d }));
  });
}

/**
 * @param {string} email
 * @param {string} token
 */
export function dropDeviceToken(email, token) {
  const needle = hexToken(token);
  if (!needle) return Promise.resolve({ ok: true });
  return update((data) => {
    const acct = data.accounts?.[accountKey(email)];
    if (!acct) return { ok: true };
    acct.devices = (acct.devices || []).filter((d) => hexToken(d.token) !== needle);
    return { ok: true };
  });
}

/**
 * Successful alert pushes in the last hour.
 * @param {string} email
 */
export function recentPushCount(email) {
  return update((data) => {
    const acct = data.accounts?.[accountKey(email)];
    return (acct?.pushTimes || []).length;
  });
}

/**
 * @param {string} email
 */
export function notePushSent(email) {
  return update((data) => {
    const acct = accountOf(data, email);
    acct.pushTimes.push(Date.now());
    return { ok: true, count: acct.pushTimes.length };
  });
}

/**
 * @param {string} email
 * @param {string} id
 * @param {string} [exceptDeviceId]
 */
export function recordDismissed(email, id, exceptDeviceId = "") {
  const noteId = String(id || "").trim().slice(0, 80);
  if (!noteId) return Promise.reject(new Error("id is required"));
  return update((data) => {
    const acct = accountOf(data, email);
    const at = Date.now();
    acct.dismissed = (acct.dismissed || []).filter((row) => row.id !== noteId);
    acct.dismissed.push({ id: noteId, at });
    const others = (acct.devices || []).filter((d) => d.deviceId !== exceptDeviceId);
    return { ok: true, at, devices: others.map((d) => ({ ...d })) };
  });
}

/**
 * @param {string} email
 * @param {number} since
 */
export function dismissedSince(email, since) {
  const cutoff = Number(since) || 0;
  return update((data) => {
    const acct = data.accounts?.[accountKey(email)];
    const ids = (acct?.dismissed || [])
      .filter((row) => Number(row.at) >= cutoff)
      .map((row) => row.id);
    return { ok: true, ids, now: Date.now() };
  });
}

/**
 * @param {string} email
 * @param {{
 *   deviceId: string,
 *   sandbox?: boolean,
 *   pushToStartToken?: string,
 *   activityPushToken?: string,
 *   dayId?: string,
 *   ended?: boolean,
 * }} row
 */
export function upsertLiveActivity(email, row) {
  const deviceId = String(row?.deviceId || "").trim().slice(0, 80);
  if (!accountKey(email) || !deviceId) {
    return Promise.reject(new Error("deviceId is required"));
  }
  const pushToStartToken = hexToken(row.pushToStartToken);
  const activityPushToken = hexToken(row.activityPushToken);
  const dayId = String(row.dayId || "").trim().slice(0, 40);
  const ended = Boolean(row.ended);
  return update((data) => {
    const acct = accountOf(data, email);
    const list = acct.liveActivities || [];
    let current = list.find((item) => item.deviceId === deviceId);
    if (!current) {
      current = { deviceId };
      list.push(current);
    }
    current.sandbox = Boolean(row.sandbox);
    current.updatedAt = new Date().toISOString();
    if (pushToStartToken) current.pushToStartToken = pushToStartToken;
    if (ended) {
      current.activityPushToken = "";
      current.pendingStartAt = 0;
      current.contentSig = "";
    } else if (activityPushToken) {
      const dayChanged = dayId && current.dayId && current.dayId !== dayId;
      current.activityPushToken = activityPushToken;
      current.pendingStartAt = 0;
      if (dayId) current.dayId = dayId;
      if (!current.startedAt || dayChanged) current.startedAt = Date.now();
    }
    acct.liveActivities = list;
    return { ok: true };
  });
}

/**
 * @param {string} email
 * @param {string} deviceId
 * @param {Record<string, unknown>} patch
 */
export function patchLiveActivity(email, deviceId, patch) {
  return update((data) => {
    const acct = data.accounts?.[accountKey(email)];
    const current = (acct?.liveActivities || []).find((item) => item.deviceId === deviceId);
    if (!current) return { ok: false };
    Object.assign(current, patch, { updatedAt: new Date().toISOString() });
    return { ok: true };
  });
}

/**
 * Accounts that have a device token or a Live Activity token.
 */
export function listPushAccounts() {
  return update((data) => {
    /** @type {string[]} */
    const emails = [];
    for (const [email, acct] of Object.entries(data.accounts || {})) {
      const devices = acct.devices || [];
      const lives = acct.liveActivities || [];
      const hasLive = lives.some((row) => row.pushToStartToken || row.activityPushToken);
      if (devices.length || hasLive) emails.push(email);
    }
    return emails;
  });
}

/**
 * @param {string} email
 */
export function liveActivitiesFor(email) {
  return update((data) => {
    const acct = data.accounts?.[accountKey(email)];
    return (acct?.liveActivities || []).map((row) => ({ ...row }));
  });
}
