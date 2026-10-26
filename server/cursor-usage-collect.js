/**
 * Reads this Mac's Cursor desktop database and posts prompts to the usage API.
 * On the Studio it also pulls the subscription billing feed.
 * LaunchAgent com.yanylevin.cursor-usage. Person defaults to Yan.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshLocalIndex } from "./usage-local.js";
import { billingSnapshotsToSend, desktopKind } from "./usage-log.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const STATE_PATH = join(ROOT, "data", "usage", "collector-state.json");
const MACHINE_PATH = join(ROOT, "data", "usage", "machine.json");
const DB_PATH = join(
  homedir(),
  "Library/Application Support/Cursor/User/globalStorage/state.vscdb"
);
const WORKSPACE_ROOT = join(
  homedir(),
  "Library/Application Support/Cursor/User/workspaceStorage"
);
const BILLING_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents";
const USAGE_URL = "https://api2.cursor.sh/auth/usage";
const PLAN_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const BACKFILL_MS = 45 * 24 * 60 * 60 * 1000;
/** A run's usage event keeps its start timestamp while the totals fill in. */
const BILLING_REFRESH_MS = 3 * 60 * 60 * 1000;
const COMPOSERS_PER_TICK = 25;

function isStudio() {
  return /mac-?studio/i.test(hostname());
}

function machineName() {
  if (process.env.USAGE_MACHINE) return process.env.USAGE_MACHINE;
  return isStudio() ? "studio" : "macbook";
}

function ingestUrl() {
  if (process.env.USAGE_INGEST_URL) return process.env.USAGE_INGEST_URL.replace(/\/$/, "");
  return isStudio() ? "http://127.0.0.1:3004" : "https://api.yanylevin.com";
}

function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }
  return String(value);
}

function parseJson(value) {
  const text = asText(value);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function bubbleTime(obj) {
  for (const key of ["createdAt", "timestamp", "sentAt"]) {
    const value = obj?.[key];
    if (typeof value === "number" && value > 1e12) return new Date(value).toISOString();
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
      return new Date(value).toISOString();
    }
  }
  return "";
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    return { composers: {}, billingPage: 1, billingBackfillDone: false, billingUntil: 0 };
  }
}

async function writeState(state) {
  await mkdir(join(ROOT, "data", "usage"), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state)}\n`, "utf8");
}

async function personName() {
  try {
    const cfg = JSON.parse(await readFile(MACHINE_PATH, "utf8"));
    const person = String(cfg.person || "").trim();
    if (person) return person;
  } catch {
    /* default */
  }
  return "Yan";
}

async function workspaceFolders() {
  /** @type {Map<string, string>} */
  const map = new Map();
  let names = [];
  try {
    names = await readdir(WORKSPACE_ROOT);
  } catch {
    return map;
  }
  for (const name of names) {
    try {
      const raw = await readFile(join(WORKSPACE_ROOT, name, "workspace.json"), "utf8");
      const folder = String(JSON.parse(raw).folder || "");
      if (folder.startsWith("file://")) {
        map.set(name, decodeURIComponent(folder.slice("file://".length)));
      }
    } catch {
      /* skip */
    }
  }
  return map;
}

/**
 * @param {string} path
 */
function repoFromPath(path) {
  const cleaned = String(path || "").replace(/\/$/, "");
  if (!cleaned) return "";
  return basename(cleaned);
}

async function post(body) {
  const token = String(process.env.USAGE_INGEST_TOKEN || "");
  if (!token) {
    console.error("[usage-collect] USAGE_INGEST_TOKEN is not set");
    return false;
  }
  const res = await fetch(`${ingestUrl()}/api/usage/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[usage-collect] ingest", res.status, detail.slice(0, 180));
    return false;
  }
  return true;
}

/**
 * @param {object[]} headers
 */
function parentComposerIndex(headers) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const row of headers) {
    const value = asText(row.value);
    if (!value.includes("subComposerIds")) continue;
    const meta = parseJson(value);
    const ids = meta?.subComposerIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (id) map.set(String(id), String(row.composerId));
    }
  }
  return map;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} state
 * @param {Map<string, string>} folders
 * @param {string} person
 */
async function scanDesktop(db, state, folders, person) {
  const headers = db
    .prepare(
      "SELECT composerId, workspaceId, lastUpdatedAt, isSubagent, value FROM composerHeaders"
    )
    .all();
  const seen = state.composers || {};
  const parents = parentComposerIndex(headers);
  const relinked = state.relinkedSubagents || {};
  const relinkDone = state.subagentRelink === true;
  const pending = headers
    .filter((row) => {
      const fresh = Number(row.lastUpdatedAt) > Number(seen[row.composerId] || 0);
      const relink = !relinkDone && row.isSubagent && !relinked[row.composerId];
      return fresh || relink;
    })
    .sort((a, b) => Number(b.lastUpdatedAt) - Number(a.lastUpdatedAt))
    .slice(0, COMPOSERS_PER_TICK);
  if (!pending.length) return 0;

  const machine = machineName();
  /** @type {object[]} */
  const prompts = [];
  /** @type {Record<string, number>} */
  const done = {};

  for (const header of pending) {
    const meta = parseJson(header.value) || {};
    const gitPath = meta.trackedGitRepos?.[0]?.repoPath || folders.get(header.workspaceId) || "";
    const repo = repoFromPath(gitPath) || "Other";
    const mode = header.isSubagent ? "subagent" : String(meta.unifiedMode || "agent");
    const kind = header.isSubagent ? "subagent" : desktopKind(mode);
    const parentComposerId = parents.get(String(header.composerId)) || "";
    const prefix = `bubbleId:${header.composerId}:`;
    const bubbles = db
      .prepare(
        "SELECT rowid AS rid, key, value FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY rid"
      )
      .all(prefix, `${prefix}\uffff`);
    /** @type {object|null} */
    let current = null;
    /** @type {object[]} */
    const turns = [];
    for (const bubble of bubbles) {
      const obj = parseJson(bubble.value);
      if (!obj) continue;
      if (obj.type === 1) {
        if (current) turns.push(current);
        const bubbleId = String(obj.bubbleId || "").trim() || String(bubble.key).split(":").pop();
        current = {
          composerId: header.composerId,
          bubbleId,
          prompt: typeof obj.text === "string" ? obj.text.slice(0, 20_000) : "",
          at: bubbleTime(obj),
          usageUuids: [],
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          index: turns.length,
        };
      } else if (obj.type === 2 && current) {
        if (obj.usageUuid) current.usageUuids.push(String(obj.usageUuid));
        const count = obj.tokenCount || {};
        current.tokens.input += Number(count.inputTokens) || 0;
        current.tokens.output += Number(count.outputTokens) || 0;
        if (!current.at) current.at = bubbleTime(obj);
      }
    }
    if (current) turns.push(current);
    turns.forEach((turn, index) => {
      if (!turn.prompt && !turn.tokens.input && !turn.tokens.output && !turn.usageUuids.length) return;
      const next = turns[index + 1];
      prompts.push({
        ...turn,
        index,
        windowEnd: next?.at || "",
        repo,
        kind,
        parentComposerId,
        composerUpdatedAt: Number(header.lastUpdatedAt) || undefined,
      });
    });
    done[header.composerId] = Number(header.lastUpdatedAt) || Date.now();
  }

  if (prompts.length) {
    const ok = await post({ machine, person, prompts });
    if (!ok) return pending.length;
  }
  state.composers = { ...seen, ...done };
  if (!relinkDone) {
    const nextRelinked = { ...relinked };
    for (const header of pending) {
      if (header.isSubagent) nextRelinked[header.composerId] = 1;
    }
    state.relinkedSubagents = nextRelinked;
    const still = headers.some((row) => row.isSubagent && !nextRelinked[row.composerId]);
    if (!still) state.subagentRelink = true;
  }
  await writeState(state);
  console.log(
    `[usage-collect] desktop ${machine} composers=${Object.keys(done).length} prompts=${prompts.length}`
  );
  return pending.length;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function accessToken(db) {
  const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken");
  return asText(row?.value).trim();
}

/**
 * @param {object} state
 * @param {string} person
 * @param {import('node:sqlite').DatabaseSync} db
 */
async function pullBilling(state, person, db) {
  const token = accessToken(db);
  if (!token) {
    console.error("[usage-collect] no Cursor access token in the local database");
    return;
  }
  const now = Date.now();
  const backfillStart = now - BACKFILL_MS;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "connect-protocol-version": "1",
  };
  let periodStart = "";
  try {
    const res = await fetch(USAGE_URL, { headers: { authorization: headers.authorization } });
    if (res.ok) {
      const body = await res.json();
      if (body.startOfMonth) periodStart = String(body.startOfMonth);
    }
  } catch (err) {
    console.error("[usage-collect] period", err instanceof Error ? err.message : err);
  }
  const plan = await pullPlan(headers);

  if (!state.billingBackfillDone) {
    const page = Number(state.billingPage) || 1;
    const data = await billingPage(headers, backfillStart, now, page);
    const evs = data.usageEventsDisplay || [];
    if (!evs.length) {
      state.billingBackfillDone = true;
      state.billingUntil = state.billingUntil || now;
      await writeState(state);
      return;
    }
    const rows = evs.map(billingRow).filter(Boolean);
    const ok = await post({ machine: machineName(), person, billing: rows, periodStart, plan });
    if (!ok) return;
    const newest = rows.reduce((max, row) => Math.max(max, Number(row.timestamp) || 0), state.billingUntil || 0);
    state.billingUntil = newest;
    const oldest = rows.reduce((min, row) => Math.min(min, Number(row.timestamp) || min), now);
    if (oldest <= backfillStart || evs.length < 100 || page >= 80) {
      state.billingBackfillDone = true;
    } else {
      state.billingPage = page + 1;
    }
    await writeState(state);
    console.log(`[usage-collect] billing page ${page} events=${rows.length}`);
    return;
  }

  const until = Number(state.billingUntil) || 0;
  const refreshSince = now - BILLING_REFRESH_MS;
  const start = Math.max(0, Math.min(until || refreshSince, refreshSince));
  /** @type {object[]} */
  const batch = [];
  for (let page = 1; page <= 80; page++) {
    const data = await billingPage(headers, start, now, page);
    const evs = data.usageEventsDisplay || [];
    if (!evs.length) break;
    let older = 0;
    for (const ev of evs) {
      const row = billingRow(ev);
      if (!row) continue;
      if (Number(row.timestamp) < start) {
        older += 1;
        continue;
      }
      batch.push(row);
    }
    if (older === evs.length || evs.length < 100) break;
  }
  const { changed, seen } = billingSnapshotsToSend(batch, state.billingSeen || {});
  const newest = batch.reduce((max, row) => Math.max(max, Number(row.timestamp) || 0), until);
  if (!changed.length) {
    if (periodStart || plan) await post({ machine: machineName(), person, billing: [], periodStart, plan });
    state.billingUntil = newest;
    state.billingSeen = seen;
    await writeState(state);
    return;
  }
  const ok = await post({ machine: machineName(), person, billing: changed, periodStart, plan });
  if (!ok) return;
  state.billingUntil = newest;
  state.billingSeen = seen;
  await writeState(state);
  console.log(`[usage-collect] billing refresh=${changed.length}`);
}

async function pullPlan(headers) {
  try {
    const res = await fetch(PLAN_URL, { method: "POST", headers, body: "{}" });
    if (!res.ok) return null;
    const body = await res.json();
    const usage = body.planUsage || {};
    if (!Number.isFinite(Number(usage.totalPercentUsed)) || !Number(usage.totalSpend)) return null;
    return {
      totalPercentUsed: usage.totalPercentUsed,
      apiPercentUsed: usage.apiPercentUsed,
      autoPercentUsed: usage.autoPercentUsed,
      totalSpend: usage.totalSpend,
      limit: usage.limit,
      cycleStart: body.billingCycleStart,
      cycleEnd: body.billingCycleEnd,
    };
  } catch (err) {
    console.error("[usage-collect] plan", err instanceof Error ? err.message : err);
    return null;
  }
}

async function billingPage(headers, start, end, page) {
  const res = await fetch(BILLING_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      teamId: 0,
      startDate: start,
      endDate: end,
      page,
      pageSize: 100,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`billing ${res.status} ${detail.slice(0, 160)}`);
  }
  return res.json();
}

function billingRow(ev) {
  const usageEventId = String(ev?.usageEventId || "").trim();
  if (!usageEventId) return null;
  return {
    usageEventId,
    timestamp: ev.timestamp,
    conversationId: ev.conversationId || "",
    model: ev.model || "",
    kind: ev.kind || "",
    tokenUsage: ev.tokenUsage || {},
    chargedCents: ev.chargedCents,
  };
}

async function tick() {
  try {
    await refreshLocalIndex();
  } catch (err) {
    console.error("[usage-collect] local index", err instanceof Error ? err.message : err);
  }
  const state = await readState();
  const person = await personName();
  const folders = await workspaceFolders();
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const left = await scanDesktop(db, state, folders, person);
    if (isStudio()) await pullBilling(state, person, db);
    return left;
  } finally {
    db.close();
  }
}

async function main() {
  console.log(`[usage-collect] ${machineName()} -> ${ingestUrl()}`);
  for (;;) {
    let left = 0;
    try {
      left = (await tick()) || 0;
    } catch (err) {
      console.error("[usage-collect]", err instanceof Error ? err.message : err);
    }
    const wait = left >= COMPOSERS_PER_TICK ? 2000 : 60_000;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

main();
