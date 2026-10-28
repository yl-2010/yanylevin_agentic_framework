/**
 * Reads this Mac's Cursor desktop database and posts prompts to the usage API.
 * On the Studio it also pulls the subscription billing feed. Other Macs also
 * post their agent transcript tags, so their billing does not fall to Alex.
 * LaunchAgent com.yanylevin.cursor-usage. Person defaults to Yan.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyLocalPrompt, projectRepo, PROJECTS, readHead, refreshLocalIndex } from "./usage-local.js";
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
const EXCHANGE_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
const BACKFILL_MS = 45 * 24 * 60 * 60 * 1000;
/** A run's usage event keeps its start timestamp while the totals fill in. */
const BILLING_REFRESH_MS = 3 * 60 * 60 * 1000;
const COMPOSERS_PER_TICK = 25;
const TRANSCRIPTS_PER_TICK = 200;
const FETCH_TIMEOUT_MS = 60_000;
/** A tick that runs this long is hung. launchd restarts the process. */
const TICK_LIMIT_MS = 15 * 60 * 1000;

/** @type {{ token: string, exp: number }} */
let exchanged = { token: "", exp: 0 };
let postedThisTick = false;

/**
 * Every network call gets a deadline. A fetch with none can stall the loop for good.
 * @param {string} url
 * @param {RequestInit} [init]
 */
function fetchSoon(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

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
  const res = await fetchSoon(`${ingestUrl()}/api/usage/ingest`, {
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
  postedThisTick = true;
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
  /** @type {Map<string, object>} */
  const metas = new Map();
  /** @type {Map<string, number>} */
  const ownStamps = new Map();
  for (const row of headers) {
    const meta = parseJson(row.value) || {};
    const id = String(row.composerId);
    metas.set(id, meta);
    ownStamps.set(id, Number(row.lastUpdatedAt) || Number(meta.lastUpdatedAt) || 0);
    const parent = String(meta.subagentInfo?.parentComposerId || "");
    if (parent && !parents.has(id)) parents.set(id, parent);
  }
  /**
   * Cursor leaves lastUpdatedAt at 0 on some subagents. Those ride on the
   * parent's stamp, which moves when the turn that ran them ends.
   * @param {object} row
   */
  const stampOf = (row) => {
    const id = String(row.composerId);
    return ownStamps.get(id) || ownStamps.get(parents.get(id) || "") || Number(metas.get(id)?.createdAt) || 0;
  };
  const relinked = state.relinkedSubagents || {};
  const relinkDone = state.subagentRelink === true;
  const pending = headers
    .filter((row) => {
      const fresh = stampOf(row) > Number(seen[row.composerId] || 0);
      const relink = !relinkDone && row.isSubagent && !relinked[row.composerId];
      return fresh || relink;
    })
    .sort((a, b) => stampOf(b) - stampOf(a))
    .slice(0, COMPOSERS_PER_TICK);
  if (!pending.length) return 0;

  const machine = machineName();
  /** @type {object[]} */
  const prompts = [];
  /** @type {Record<string, number>} */
  const done = {};

  for (const header of pending) {
    const meta = metas.get(String(header.composerId)) || {};
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
        composerUpdatedAt: stampOf(header) || undefined,
      });
    });
    done[header.composerId] = stampOf(header) || Date.now();
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
 * @param {string} token
 */
function jwtExpiry(token) {
  try {
    const part = String(token).split(".")[1] || "";
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return Number(payload.exp) * 1000 || 0;
  } catch {
    return 0;
  }
}

/**
 * Cursor now stores the desktop token encrypted (cursor-safe-storage:v1,
 * key in the Keychain). The account API key trades for a session token
 * with no Keychain prompt. A plain stored JWT still works as a fallback.
 * @param {import('node:sqlite').DatabaseSync} db
 */
async function accessToken(db) {
  if (exchanged.token && exchanged.exp - Date.now() > 5 * 60 * 1000) return exchanged.token;
  const key = String(process.env.CURSOR_API_KEY || "").trim();
  if (key) {
    try {
      const res = await fetchSoon(EXCHANGE_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: "{}",
      });
      if (res.ok) {
        const token = String((await res.json()).accessToken || "").trim();
        if (token) {
          exchanged = { token, exp: jwtExpiry(token) || Date.now() + 30 * 60 * 1000 };
          return token;
        }
      }
      console.error("[usage-collect] key exchange", res.status);
    } catch (err) {
      console.error("[usage-collect] key exchange", err instanceof Error ? err.message : err);
    }
  }
  const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken");
  const stored = asText(row?.value).trim();
  return stored.split(".").length === 3 ? stored : "";
}

/**
 * @param {object} state
 * @param {string} person
 * @param {import('node:sqlite').DatabaseSync} db
 */
async function pullBilling(state, person, db) {
  const token = await accessToken(db);
  if (!token) {
    console.error("[usage-collect] no usable Cursor token. Set CURSOR_API_KEY in server/.env");
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
    const res = await fetchSoon(USAGE_URL, { headers: { authorization: headers.authorization } });
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
    const ok = await post({ machine: machineName(), person, billing: rows, periodStart, plan, billingOk: true });
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
    await post({ machine: machineName(), person, billing: [], periodStart, plan, billingOk: true });
    state.billingUntil = newest;
    state.billingSeen = seen;
    await writeState(state);
    return;
  }
  const ok = await post({ machine: machineName(), person, billing: changed, periodStart, plan, billingOk: true });
  if (!ok) return;
  state.billingUntil = newest;
  state.billingSeen = seen;
  await writeState(state);
  console.log(`[usage-collect] billing refresh=${changed.length}`);
}

async function pullPlan(headers) {
  try {
    const res = await fetchSoon(PLAN_URL, { method: "POST", headers, body: "{}" });
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
  const res = await fetchSoon(BILLING_URL, {
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
    if (res.status === 401) exchanged = { token: "", exp: 0 };
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

/**
 * Off the Studio, billing cannot see this Mac's transcripts. Post their tags
 * (conversation id, repo, kind, first prompt) so the Studio can match them.
 * @param {object} state
 * @param {string} person
 */
async function postTranscripts(state, person) {
  const since = Date.now() - BACKFILL_MS;
  /** @type {Record<string, number>} */
  const sent = state.transcripts || {};
  /** @type {{ id: string, file: string, project: string, mtimeMs: number }[]} */
  const pending = [];
  let projects = [];
  try {
    projects = await readdir(PROJECTS);
  } catch {
    return 0;
  }
  for (const project of projects) {
    let ids = [];
    try {
      ids = await readdir(join(PROJECTS, project, "agent-transcripts"));
    } catch {
      continue;
    }
    for (const id of ids) {
      const file = join(PROJECTS, project, "agent-transcripts", id, `${id}.jsonl`);
      let info;
      try {
        info = await stat(file);
      } catch {
        continue;
      }
      if (info.mtimeMs < since || sent[id] === info.mtimeMs) continue;
      pending.push({ id, file, project, mtimeMs: info.mtimeMs });
    }
  }
  if (!pending.length) return 0;
  pending.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const batch = pending.slice(0, TRANSCRIPTS_PER_TICK);
  /** @type {Map<string, string>} */
  const repos = new Map();
  /** @type {object[]} */
  const transcripts = [];
  for (const item of batch) {
    let head = "";
    try {
      head = await readHead(item.file);
    } catch {
      continue;
    }
    if (!repos.has(item.project)) repos.set(item.project, projectRepo(item.project));
    const tagged = classifyLocalPrompt(head, repos.get(item.project) || "Other", person);
    transcripts.push({ conversationId: item.id, at: new Date(item.mtimeMs).toISOString(), ...tagged });
  }
  if (transcripts.length && !(await post({ machine: machineName(), person, transcripts }))) return pending.length;
  const next = {};
  for (const [id, mtimeMs] of Object.entries(sent)) {
    if (Number(mtimeMs) >= since) next[id] = mtimeMs;
  }
  for (const item of batch) next[item.id] = item.mtimeMs;
  state.transcripts = next;
  await writeState(state);
  console.log(`[usage-collect] transcripts ${machineName()} sent=${transcripts.length} left=${pending.length - batch.length}`);
  return pending.length - batch.length;
}

async function tick() {
  postedThisTick = false;
  if (isStudio()) {
    try {
      await refreshLocalIndex();
    } catch (err) {
      console.error("[usage-collect] local index", err instanceof Error ? err.message : err);
    }
  }
  const state = await readState();
  const person = await personName();
  const folders = await workspaceFolders();
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let left = 0;
  try {
    left = await scanDesktop(db, state, folders, person);
    if (isStudio()) {
      try {
        await pullBilling(state, person, db);
      } catch (err) {
        console.error("[usage-collect] billing", err instanceof Error ? err.message : err);
      }
    }
  } finally {
    db.close();
  }
  if (!isStudio()) {
    try {
      if ((await postTranscripts(state, person)) > 0) left = Math.max(left, COMPOSERS_PER_TICK);
    } catch (err) {
      console.error("[usage-collect] transcripts", err instanceof Error ? err.message : err);
    }
  }
  if (!postedThisTick) await post({ machine: machineName(), person });
  return left;
}

async function main() {
  console.log(`[usage-collect] ${machineName()} -> ${ingestUrl()}`);
  for (;;) {
    let left = 0;
    const watchdog = setTimeout(() => {
      console.error("[usage-collect] tick hung, exiting so launchd restarts");
      process.exit(1);
    }, TICK_LIMIT_MS);
    try {
      left = (await tick()) || 0;
    } catch (err) {
      console.error("[usage-collect]", err instanceof Error ? err.message : err);
    } finally {
      clearTimeout(watchdog);
    }
    const wait = left >= COMPOSERS_PER_TICK ? 2000 : 60_000;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

main();
