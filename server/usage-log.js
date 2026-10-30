/**
 * Cursor usage clumps. One user prompt is one row.
 * Billing that neither the Studio nor the MacBook can trace (no prompt, no
 * transcript on either machine) is Alex. He no longer runs a collector,
 * so kind is cursor-desktop and repo is Other. Files stay on the Mac under
 * data/usage/. Gitignored.
 */

import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chatTitlesForSessions } from "./education-chat-history.js";
import { canonicalizeEmail } from "./identity.js";

import { USAGE_DIR as ONEDRIVE_USAGE_DIR } from "./onedrive-projects.js";

export const USAGE_DIR = ONEDRIVE_USAGE_DIR;
export const USAGE_ROWS_PATH = join(USAGE_DIR, "rows.jsonl");
export const USAGE_META_PATH = join(USAGE_DIR, "meta.json");

const PROMPT_STORE_MAX = 80_000;
const PROMPT_API_MAX = 8_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHAT_KINDS = new Set(["jype-agent", "personal-agent", "agent", "cursor-desktop", "teams-agent"]);
const CHANNEL_KINDS = new Set(["teams-agent", "imessage-agent", "personal-chat", "jype-chat", "whatsapp-agent"]);
const CHANNEL_LABEL = { Teams: "teams", iMessage: "iMessage" };

/** @type {Promise<void>} */
let writeChain = Promise.resolve();

/** @type {{ key: string, clumps: object[] | null, billedAt: string }} */
let builtCache = { key: "", clumps: null, billedAt: "" };
/** @type {{ key: string, promise: Promise<{ clumps: object[], billedAt: string }> } | null} */
let builtFlight = null;
/** Dedupe signatures by row id, valid while the jsonl stamp matches. */
/** @type {{ stamp: string, sigs: Map<string, string> } | null} */
let knownRows = null;

/**
 * @param {string|null|undefined} email
 */
export function personFromEmail(email) {
  const canonical = canonicalizeEmail(email);
  if (!canonical) return "Yan";
  if (canonical === "you@example.com") return "Yan";
  if (canonical === "you@example.com") return "Alex";
  if (canonical === "friend@example.com") return "Example Friend";
  if (canonical === "neighbor@example.com") return "Example Neighbor";
  return "Other";
}

/** Cursor Desktop agent, ask, and plan. Older rows stored these as agent, chat, and plan. */
const DESKTOP_MODES = new Set(["agent", "chat", "plan", "ask"]);

export function desktopKind(kind) {
  const value = String(kind ?? "agent").trim() || "agent";
  return DESKTOP_MODES.has(value) ? "cursor-desktop" : value;
}

/**
 * One name for the same nightly job. Older SDK rows say "synthesis".
 * JYPE site chats used to log as jype-chat. Same workspace as jype-agent.
 * @param {string|null|undefined} kind
 */
export function canonicalKind(kind) {
  const value = desktopKind(kind);
  if (value === "synthesis") return "context-synthesis";
  if (value === "jype-chat") return "jype-agent";
  return value;
}

/** Usage page name. The WhatsApp agent is off, so it does not get its own row. */
export function visibleKind(kind) {
  const value = canonicalKind(kind);
  return value === "whatsapp-agent" ? "personal-agent" : value;
}

/**
 * Drop WhatsApp-agent lines from a prompt shown on the usage page.
 * @param {string} text
 */
export function hideWhatsAppAgentPrompt(text) {
  const lines = String(text || "")
    .split("\n")
    .filter((line) => !/whatsapp/i.test(line));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Chat titles that name the WhatsApp agent stay off the usage page.
 * @param {Record<string, string>|null|undefined} titles
 */
export function scrubWhatsAppAgentTitles(titles) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(titles || {})) {
    const text = String(value || "");
    if (/whatsapp/i.test(text) && /(agent|poller|@agent)/i.test(text)) continue;
    out[key] = text;
  }
  return out;
}

/**
 * Collapsed thread name. Scheduled jobs stay the kind ("life state", "canvas hourly").
 * A chat turn named in the transcript is the person and channel ("Example Neighbor teams").
 * @param {{ kind?: string, prompt?: string }} input
 */
export function agentTypeLabel(input) {
  const raw = String(input?.kind || "agent").trim() || "agent";
  const kind = visibleKind(raw);
  if (CHAT_KINDS.has(raw) || CHAT_KINDS.has(kind) || CHAT_KINDS.has(desktopKind(raw))) {
    const called = String(input?.prompt || "").match(
      /Called by ([A-Za-z]+)(?: \([^)]*\))? on (Teams|iMessage)/
    );
    if (called) return called[1] + " " + (CHANNEL_LABEL[called[2]] || called[2].toLowerCase());
  }
  return kind.replace(/-/g, " ");
}

function personChannelLabel(label) {
  return / (teams|iMessage)$/.test(String(label || ""));
}

/**
 * @param {{ label?: string, labelAt?: number }} thread
 * @param {{ kind?: string, prompt?: string, at?: string }} row
 */
function applyThreadLabel(thread, row) {
  const next = agentTypeLabel(row);
  const rowTime = Date.parse(row.at || "") || 0;
  if (personChannelLabel(next)) {
    if (!personChannelLabel(thread.label) || rowTime >= (thread.labelAt || 0)) {
      thread.label = next;
      thread.labelAt = rowTime;
    }
    return;
  }
  if (personChannelLabel(thread.label) && CHAT_KINDS.has(String(row.kind || ""))) return;
  if (!thread.label || rowTime >= (thread.labelAt || 0)) {
    thread.label = next;
    thread.labelAt = rowTime;
  }
}

/**
 * @param {object[]} rows
 */
export function threadLabelFromRows(rows) {
  const thread = { label: "", labelAt: 0 };
  for (const row of rows) applyThreadLabel(thread, row);
  return thread.label || "cursor desktop";
}

export function kindFromPrefix(prefix) {
  const p = String(prefix || "").trim();
  if (!p || p === "test") return "unspecified";
  if (p.startsWith("daily-briefing")) return "daily-briefing";
  if (p.startsWith("nightly-")) return p.slice("nightly-".length) || "context-synthesis";
  if (p.startsWith("health-history")) return "health-history";
  if (p === "location-history") return "location-compose";
  if (p === "canvas-sync") return "canvas-nightly";
  if (p === "brain-extraction") return "brain-extract";
  if (p === "people-enrich" || p === "people-bootstrap" || p === "synthesis" || p === "context-synthesis") {
    return "context-synthesis";
  }
  return p;
}

/**
 * @param {string|undefined} header
 */
export function ingestTokenOk(header) {
  const expected = String(process.env.USAGE_INGEST_TOKEN || "");
  if (!expected) return false;
  const match = String(header || "").match(/^Bearer\s+(\S+)\s*$/i);
  if (!match) return false;
  const got = Buffer.from(match[1]);
  const want = Buffer.from(expected);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

/**
 * @param {unknown} model
 */
export function describeModel(model) {
  if (!model) return { model: "", modelConfig: null };
  if (typeof model === "string") return { model: model.trim(), modelConfig: null };
  const id = String(/** @type {{ id?: string }} */ (model).id || "").trim();
  const raw = /** @type {{ params?: { id?: string, value?: unknown }[] }} */ (model).params;
  const params = Array.isArray(raw)
    ? raw
        .filter((p) => p && p.id)
        .map((p) => ({ id: String(p.id), value: String(p.value ?? "") }))
    : [];
  let name = id;
  const reasoning = params.find((p) => /reason|thinking/i.test(p.id));
  const fast = params.find((p) => p.id === "fast");
  if (reasoning?.value) name = `${name}-${reasoning.value}`;
  if (fast && /^(true|on|1)$/i.test(fast.value)) name = `${name}-fast`;
  return {
    model: name,
    modelConfig: id ? { id, params } : null,
  };
}

/**
 * @param {unknown} usage
 */
export function tokensFromUsage(usage) {
  if (!usage || typeof usage !== "object") return emptyTokens();
  const row = /** @type {Record<string, unknown>} */ (usage);
  return {
    input: num(row.inputTokens ?? row.input),
    output: num(row.outputTokens ?? row.output),
    cacheRead: num(row.cacheReadTokens ?? row.cacheRead),
    cacheWrite: num(row.cacheWriteTokens ?? row.cacheWrite),
    reasoning: num(row.reasoningTokens ?? row.reasoning),
  };
}

export function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

/**
 * @param {ReturnType<typeof emptyTokens>} a
 * @param {ReturnType<typeof emptyTokens>} b
 */
function addTokensKeepBlank(a, b) {
  const sum = (x, y) => (x == null && y == null ? null : (Number(x) || 0) + (Number(y) || 0));
  const left = a || emptyTokens();
  const right = b || emptyTokens();
  return {
    input: (left.input || 0) + (right.input || 0),
    output: (left.output || 0) + (right.output || 0),
    cacheRead: sum(left.cacheRead, right.cacheRead),
    cacheWrite: sum(left.cacheWrite, right.cacheWrite),
    reasoning: (left.reasoning || 0) + (right.reasoning || 0),
  };
}

export function addTokens(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
  };
}

export function tokenSum(tokens) {
  const t = tokens || emptyTokens();
  return (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);
}

/**
 * Cursor updates a usage event in place after the run finishes.
 * The timestamp stays at the start, so a later poll has to notice
 * the token and cents change itself.
 * @param {object} row
 */
export function billingSnapshotKey(row) {
  const tokens = tokensFromUsage(row?.tokenUsage || row?.tokens);
  return [
    tokens.input,
    tokens.output,
    tokens.cacheRead,
    tokens.cacheWrite,
    tokens.reasoning,
    Math.round(num(row?.chargedCents) * 10000),
  ].join(":");
}

/**
 * @param {object[]} rows
 * @param {Record<string, string>} [seen]
 */
export function billingSnapshotsToSend(rows, seen = {}) {
  /** @type {Record<string, string>} */
  const next = {};
  /** @type {object[]} */
  const changed = [];
  for (const row of rows) {
    const id = String(row?.usageEventId || "").trim();
    if (!id) continue;
    const key = billingSnapshotKey(row);
    next[id] = key;
    if (seen[id] !== key) changed.push(row);
  }
  return { changed, seen: next };
}

/**
 * The SDK folds cache read and cache write into inputTokens.
 * Billing reports those separately. Subtract cache out of input when it fits.
 * @param {ReturnType<typeof emptyTokens>} tokens
 */
export function splitCacheFromInput(tokens) {
  const t = tokensFromUsage(tokens);
  const cache = t.cacheRead + t.cacheWrite;
  if (cache > 0 && t.input >= cache) t.input -= cache;
  return t;
}

/**
 * @param {number} n
 */
function num(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * @param {string} text
 * @param {number} max
 */
function clip(text, max) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return s.slice(0, max);
}

/**
 * @param {() => Promise<void>} fn
 */
function enqueue(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

/**
 * @param {string} path
 */
async function readRows(path) {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") return [];
    throw err;
  }
  /** @type {object[]} */
  const rows = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* torn line */
    }
  }
  return rows;
}

/**
 * Last line for an id wins.
 * @param {object[]} rows
 */
function latestById(rows) {
  /** @type {Map<string, object>} */
  const map = new Map();
  for (const row of rows) {
    const id = String(row?.id || "");
    if (!id) continue;
    map.set(id, row);
  }
  return [...map.values()];
}

/**
 * A re-sent row only earns a new line when this changes.
 * @param {object} row
 */
function rowSignature(row) {
  if (row?.source === "transcript") {
    const text = [row.person, row.repo, row.kind, row.prompt].map((v) => String(v || "")).join("\u0001");
    return "tx:" + createHash("sha1").update(text).digest("base64");
  }
  return billingSnapshotKey(row) + "|" + String(row?.parentComposerId || "");
}

async function knownRowSigs() {
  const stamp = await fileStamp(USAGE_ROWS_PATH);
  if (knownRows && knownRows.stamp === stamp) return knownRows.sigs;
  /** @type {Map<string, string>} */
  const sigs = new Map();
  for (const row of await readRows(USAGE_ROWS_PATH)) {
    if (row?.id) sigs.set(String(row.id), rowSignature(row));
  }
  knownRows = { stamp, sigs };
  return sigs;
}

/**
 * @param {object[]} rows
 */
async function appendRows(rows) {
  if (!rows.length) return;
  const sigs = await knownRowSigs();
  await mkdir(USAGE_DIR, { recursive: true });
  await appendFile(USAGE_ROWS_PATH, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  for (const row of rows) sigs.set(String(row.id), rowSignature(row));
  knownRows = { stamp: await fileStamp(USAGE_ROWS_PATH), sigs };
}

/**
 * Log one SDK run. Skips auth failures that never reported tokens.
 * @param {{
 *   person?: string,
 *   kind?: string,
 *   threadId?: string,
 *   prompt?: string,
 *   model?: unknown,
 *   result?: { id?: string, requestId?: string, status?: string, usage?: object }|null,
 *   startedAt?: string,
 *   repo?: string,
 *   always?: boolean,
 * }} input
 */
export async function logSdkResult(input) {
  const result = input?.result || null;
  const usage = result && typeof result === "object" ? result.usage : null;
  const status = result && typeof result === "object" ? String(result.status || "") : "";
  if (!usage && status !== "finished" && !input?.always) return;

  const described = describeModel(input.model || result?.model);
  const tokens = tokensFromUsage(usage);
  const requestId = String(result?.requestId || "").trim();
  const runId = String(result?.id || "").trim();
  const at = new Date().toISOString();
  const id = `sdk:${requestId || runId || randomUUID()}`;
  const prompt = clip(input.prompt || "", PROMPT_STORE_MAX);
  const row = {
    id,
    source: "sdk",
    at,
    startedAt: input.startedAt || at,
    endedAt: at,
    person: String(input.person || "Yan").trim() || "Yan",
    repo: input.repo || "yanylevin-agents",
    kind: String(input.kind || "unspecified").trim() || "unspecified",
    model: described.model,
    modelConfig: described.modelConfig,
    prompt,
    threadId: String(input.threadId || "").trim(),
    requestId,
    runId,
    tokens,
  };
  await enqueue(async () => {
    if ((await knownRowSigs()).has(id)) return;
    await appendRows([row]);
  });
}

/**
 * @param {{
 *   machine?: string,
 *   person?: string,
 *   prompts?: object[],
 *   billing?: object[],
 *   transcripts?: object[],
 *   periodStart?: string,
 *   plan?: object,
 *   billingOk?: boolean,
 * }} body
 */
export async function ingestUsageBatch(body) {
  const machine = String(body?.machine || "").trim().slice(0, 40);
  const person = String(body?.person || "Yan").trim().slice(0, 80) || "Yan";
  const prompts = Array.isArray(body?.prompts) ? body.prompts : [];
  const billing = Array.isArray(body?.billing) ? body.billing : [];
  const transcripts = Array.isArray(body?.transcripts) ? body.transcripts : [];
  const now = new Date().toISOString();
  /** @type {object[]} */
  const rows = [];

  for (const raw of prompts) {
    if (!raw || typeof raw !== "object") continue;
    const composerId = String(raw.composerId || "").trim();
    const bubbleId = String(raw.bubbleId || "").trim();
    if (!composerId || !bubbleId) continue;
    const id = `desk:${machine || "mac"}:${composerId}:${bubbleId}`;
    const described = describeModel(raw.model);
    rows.push({
      id,
      source: "desktop",
      at: isoOrEmpty(raw.at),
      composerCreatedAt: isoOrEmpty(raw.composerCreatedAt),
      composerUpdatedAt: isoOrEmpty(raw.composerUpdatedAt),
      person,
      repo: clip(raw.repo || "Other", 120) || "Other",
      kind: clip(desktopKind(raw.kind), 80) || "cursor-desktop",
      model: described.model || clip(raw.modelName || "", 120),
      modelConfig: described.modelConfig,
      prompt: clip(raw.prompt || "", PROMPT_STORE_MAX),
      threadId: composerId,
      composerId,
      parentComposerId: clip(raw.parentComposerId || "", 80),
      bubbleId,
      machine,
      usageUuids: stringList(raw.usageUuids).slice(0, 80),
      tokens: tokensFromUsage(raw.tokens),
      index: Number.isFinite(Number(raw.index)) ? Number(raw.index) : 0,
      windowEnd: isoOrEmpty(raw.windowEnd),
    });
  }

  for (const raw of billing) {
    if (!raw || typeof raw !== "object") continue;
    const usageEventId = String(raw.usageEventId || "").trim();
    if (!usageEventId) continue;
    const atMs = Number(raw.timestamp || raw.at);
    const at = Number.isFinite(atMs) && atMs > 1e11 ? new Date(atMs).toISOString() : isoOrEmpty(raw.at);
    rows.push({
      id: `bill:${usageEventId}`,
      source: "billing",
      at: at || new Date().toISOString(),
      usageEventId,
      conversationId: String(raw.conversationId || "").trim(),
      model: clip(raw.model || "", 120),
      billingKind: clip(raw.kind || raw.billingKind || "", 80),
      tokens: tokensFromUsage(raw.tokenUsage || raw.tokens),
      chargedCents: num(raw.chargedCents),
    });
  }

  for (const raw of transcripts) {
    if (!raw || typeof raw !== "object" || !machine) continue;
    const conversationId = String(raw.conversationId || "").trim().slice(0, 120);
    if (!conversationId) continue;
    rows.push({
      id: `tx:${machine}:${conversationId}`,
      source: "transcript",
      at: isoOrEmpty(raw.at) || now,
      conversationId,
      machine,
      person: clip(raw.person || person, 80) || person,
      repo: clip(raw.repo || "Other", 120) || "Other",
      kind: clip(raw.kind || "cursor-desktop", 80) || "cursor-desktop",
      prompt: clip(raw.prompt || "", PROMPT_STORE_MAX),
    });
  }

  let wrote = 0;
  await enqueue(async () => {
    if (rows.length) {
      const sigs = await knownRowSigs();
      /** @type {Map<string, string>} */
      const batch = new Map();
      /** @type {object[]} */
      const fresh = [];
      for (const row of rows) {
        const sig = rowSignature(row);
        if ((batch.get(row.id) ?? sigs.get(row.id)) === sig) continue;
        batch.set(row.id, sig);
        fresh.push(row);
      }
      await appendRows(fresh);
      wrote = fresh.length;
    }
    const periodStart = isoOrEmpty(body?.periodStart);
    const plan = planFromBody(body?.plan);
    if (!machine && !periodStart && !plan) return;
    const meta = await readMeta();
    if (periodStart) meta.periodStart = periodStart;
    if (plan) meta.plan = plan;
    if (machine) {
      const collectors = meta.collectors && typeof meta.collectors === "object" ? meta.collectors : {};
      const seen = { ...(collectors[machine] || {}), at: now };
      if (body?.billingOk || plan || billing.length) seen.billingAt = now;
      collectors[machine] = seen;
      meta.collectors = collectors;
    }
    await mkdir(USAGE_DIR, { recursive: true });
    await writeFile(USAGE_META_PATH, `${JSON.stringify(meta)}\n`, "utf8");
  });
  return { ok: true, wrote };
}

async function readMeta() {
  try {
    const meta = JSON.parse(await readFile(USAGE_META_PATH, "utf8"));
    return meta && typeof meta === "object" ? meta : {};
  } catch {
    return {};
  }
}

/**
 * @param {unknown} value
 */
function isoOrEmpty(value) {
  if (typeof value === "number" && value > 1e11) return new Date(value).toISOString();
  const s = String(value || "").trim();
  if (!s) return "";
  if (/^\d{12,}$/.test(s)) return new Date(Number(s)).toISOString();
  const t = Date.parse(s);
  if (Number.isNaN(t)) return "";
  return new Date(t).toISOString();
}

/**
 * @param {unknown} value
 */
function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v || "").trim()).filter(Boolean);
}

/**
 * @param {object[]} rows
 * @param {Map<string, { person?: string, repo?: string, kind?: string, prompt?: string }>|null} [local]
 */
export function buildClumps(rows, local = null) {
  const all = latestById(rows);
  const billing = all.filter((r) => r.source === "billing");
  const prompts = all.filter((r) => r.source === "sdk" || r.source === "desktop");
  /** @type {Set<string>} */
  const explained = new Set();

  /** @type {object[]} */
  const clumps = [];
  const index = transcriptIndex(all, local);
  const bills = indexBilling(billing, index);
  const sdk = prompts
    .filter((p) => p.source === "sdk")
    .map((prompt) => ({ ...prompt, tokens: splitCacheFromInput(prompt.tokens) }))
    .sort((a, b) => Date.parse(a.startedAt || a.at) - Date.parse(b.startedAt || b.at));
  for (const prompt of sdk) {
    const matched = matchSdkBilling(prompt, bills, explained);
    for (const bill of matched) explained.add(bill.id);
    clumps.push(toClump({ ...prompt, kind: canonicalKind(prompt.kind) }, matched));
  }
  const desktop = prompts.filter((p) => p.source === "desktop");
  const desktopMatches = matchDesktopGroups(desktop, bills, explained);
  for (const prompt of desktop) {
    const matched = desktopMatches.get(prompt.id) || [];
    for (const bill of matched) explained.add(bill.id);
    clumps.push(toClump(prompt, matched));
  }
  const folded = foldSubagents(clumps);
  clumps.length = 0;
  clumps.push(...folded);
  /** @type {Map<string, object[]>} */
  const localGroups = new Map();
  for (const bill of billing) {
    if (explained.has(bill.id)) continue;
    const conv = String(bill.conversationId || "");
    if (!conv || !index.has(conv)) {
      clumps.push(billingOnlyClump(bill));
      continue;
    }
    const list = localGroups.get(conv) || [];
    list.push(bill);
    localGroups.set(conv, list);
  }
  for (const [conv, list] of localGroups) {
    const hit = index.get(conv) || {};
    clumps.push(
      toClump(
        {
          id: `local:${conv}`,
          source: "local",
          at: list.map((bill) => bill.at).sort().at(-1) || "",
          person: hit.person || "Yan",
          repo: hit.repo || "Other",
          kind: canonicalKind(hit.kind),
          model: dominantModel(list),
          prompt: hit.prompt || "",
          threadId: conv,
          machine: hit.machine || "",
          tokens: emptyTokens(),
        },
        list
      )
    );
  }
  clumps.sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));
  return clumps;
}

/**
 * Transcripts the MacBook reported, with this Studio's own index on top.
 * @param {object[]} rows
 * @param {Map<string, object>|null} local
 */
function transcriptIndex(rows, local) {
  const own = local instanceof Map ? local : new Map();
  const remote = rows.filter((row) => row.source === "transcript" && row.conversationId);
  if (!remote.length) return own;
  /** @type {Map<string, object>} */
  const index = new Map();
  for (const row of remote) {
    index.set(String(row.conversationId), {
      person: row.person,
      repo: row.repo,
      kind: row.kind,
      prompt: row.prompt,
      machine: row.machine,
    });
  }
  for (const [id, hit] of own) index.set(id, hit);
  return index;
}

/**
 * @typedef {{
 *   byEvent: Map<string, object>,
 *   byConv: Map<string, object[]>,
 *   timed: { bill: object, t: number, owner: string }[],
 *   times: number[],
 * }} BillingIndex
 */

/**
 * Billing sorted by time once, so each run only scans its own window.
 * @param {object[]} billing
 * @param {Map<string, { kind?: string }>} local
 * @returns {BillingIndex}
 */
function indexBilling(billing, local) {
  /** @type {Map<string, object>} */
  const byEvent = new Map();
  /** @type {Map<string, object[]>} */
  const byConv = new Map();
  /** @type {{ bill: object, t: number, owner: string }[]} */
  const timed = [];
  for (const bill of billing) {
    if (bill.usageEventId) byEvent.set(bill.usageEventId, bill);
    const conv = String(bill.conversationId || "");
    if (conv) {
      const list = byConv.get(conv) || [];
      list.push(bill);
      byConv.set(conv, list);
    }
    const t = Date.parse(bill.at);
    if (!Number.isNaN(t)) timed.push({ bill, t, owner: localAgentKind(local, conv) });
  }
  timed.sort((a, b) => a.t - b.t);
  return { byEvent, byConv, timed, times: timed.map((row) => row.t) };
}

/**
 * @param {number[]} sorted
 * @param {number} value
 */
function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A transcript already named this run. A channel log (Teams, iMessage)
 * can wear that name. A different job cannot take the bill.
 * @param {string} owner
 * @param {string} promptKind
 */
function billingOwnedElsewhere(owner, promptKind) {
  if (!owner) return false;
  if (!promptKind || owner === promptKind) return false;
  return !CHANNEL_KINDS.has(promptKind);
}

/**
 * @param {Map<string, { kind?: string }>|null} local
 * @param {string} conversationId
 */
function localAgentKind(local, conversationId) {
  if (!local?.get) return "";
  const hit = local.get(String(conversationId || ""));
  const kind = canonicalKind(hit?.kind || "");
  if (!kind || kind === "cursor-desktop" || kind === "other" || kind === "unspecified") return "";
  if (CHANNEL_KINDS.has(kind)) return "";
  return kind;
}

/**
 * @param {object} prompt
 * @param {BillingIndex} bills
 * @param {Set<string>} explained
 */
function matchSdkBilling(prompt, bills, explained) {
  /** @type {object[]} */
  const direct = [];
  for (const key of [prompt.requestId, prompt.runId]) {
    if (!key) continue;
    const hit = bills.byEvent.get(key);
    if (hit && !explained.has(hit.id)) direct.push(hit);
  }
  if (direct.length) return direct;

  const start = Date.parse(prompt.startedAt || prompt.at) - 5000;
  const end = Date.parse(prompt.endedAt || prompt.at) + 20_000;
  if (Number.isNaN(start) || Number.isNaN(end)) return [];
  const promptKind = canonicalKind(prompt?.kind);
  /** @type {object[]} */
  const window = [];
  for (let i = lowerBound(bills.times, start); i < bills.timed.length && bills.timed[i].t <= end; i++) {
    const { bill, owner } = bills.timed[i];
    if (explained.has(bill.id) || billingOwnedElsewhere(owner, promptKind)) continue;
    window.push(bill);
  }
  if (!window.length) return [];

  const want = prompt.tokens?.input || 0;
  if (!want) {
    const family = modelFamily(prompt.model);
    return window.filter((b) => !family || modelFamily(b.model) === family);
  }
  /** @type {object[]} */
  const taken = [];
  let sum = 0;
  for (const bill of window) {
    const next = sum + (bill.tokens?.input || 0);
    if (taken.length && next > want * 1.12) break;
    if (!taken.length && next > want * 1.25) continue;
    taken.push(bill);
    sum = next;
    if (sum >= want * 0.92) break;
  }
  return taken;
}

/**
 * Split a composer's billing events across its prompts.
 * usageUuid hits stick to that prompt. The rest go by time window,
 * or in order when the bubbles have no clock.
 * @param {object[]} desktops
 * @param {BillingIndex} bills
 * @param {Set<string>} explained
 */
function matchDesktopGroups(desktops, bills, explained) {
  /** @type {Map<string, object[]>} */
  const out = new Map();
  /** @type {Map<string, object[]>} */
  const groups = new Map();
  for (const prompt of desktops) {
    const key = String(prompt.composerId || prompt.id);
    const list = groups.get(key) || [];
    list.push(prompt);
    groups.set(key, list);
    out.set(prompt.id, []);
  }
  for (const prompts of groups.values()) {
    prompts.sort((a, b) => (a.index || 0) - (b.index || 0) || String(a.at).localeCompare(String(b.at)));
    /** @type {Set<string>} */
    const claimed = new Set();
    for (const prompt of prompts) {
      for (const id of prompt.usageUuids || []) {
        const bill = bills.byEvent.get(id);
        if (!bill || explained.has(bill.id) || claimed.has(bill.id)) continue;
        out.get(prompt.id).push(bill);
        claimed.add(bill.id);
      }
    }
    const conv = String(prompts[0].composerId || "");
    const pool = (bills.byConv.get(conv) || [])
      .filter((b) => !explained.has(b.id) && !claimed.has(b.id))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (!pool.length) continue;
    const timed = prompts.every((p) => p.at) && new Set(prompts.map((p) => p.at)).size === prompts.length;
    if (timed && prompts.length > 1) {
      for (const bill of pool) {
        const t = Date.parse(bill.at);
        let dest = prompts[0];
        for (const prompt of prompts) {
          if (Date.parse(prompt.at) <= t) dest = prompt;
        }
        out.get(dest.id).push(bill);
      }
      continue;
    }
    const size = Math.ceil(pool.length / prompts.length);
    prompts.forEach((prompt, i) => {
      out.get(prompt.id).push(...pool.slice(i * size, (i + 1) * size));
    });
  }
  return out;
}

/**
 * @param {string} model
 */
/**
 * @param {object[]} bills
 */
function dominantModel(bills) {
  /** @type {Map<string, number>} */
  const score = new Map();
  for (const bill of bills) {
    const model = String(bill.model || "");
    score.set(model, (score.get(model) || 0) + (Number(bill.chargedCents) || 0) + 0.0001);
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function modelFamily(model) {
  return String(model || "")
    .toLowerCase()
    .replace(/-fast$/, "")
    .replace(/-(high|xhigh|low|medium|thinking.*)$/, "");
}

/**
 * @param {object} prompt
 * @param {object[]} matched
 */
function toClump(prompt, matched) {
  let tokens = emptyTokens();
  let chargedCents = 0;
  /** @type {object[]} */
  const calls = [];
  if (matched.length) {
    for (const bill of matched) {
      const part = tokensFromUsage(bill.tokens);
      tokens = addTokens(tokens, part);
      chargedCents += num(bill.chargedCents);
      calls.push({
        at: bill.at,
        model: bill.model || prompt.model || "",
        usageEventId: bill.usageEventId || "",
        tokens: part,
      });
    }
    const own = tokensFromUsage(prompt.tokens);
    if (tokenSum(own) > tokenSum(tokens)) tokens = own;
  } else {
    tokens = tokensFromUsage(prompt.tokens);
    if (prompt.source === "desktop") {
      tokens = { ...tokens, cacheRead: null, cacheWrite: null };
    }
  }
  const model = prompt.model || calls.find((c) => c.model)?.model || "";
  return {
    id: prompt.id,
    source: prompt.source,
    at: prompt.at || prompt.composerUpdatedAt || prompt.startedAt || "",
    person: prompt.person || "Other",
    repo: prompt.repo || "Other",
    kind: prompt.kind ? canonicalKind(prompt.kind) : "",
    model,
    modelConfig: prompt.modelConfig || null,
    prompt: prompt.prompt || "",
    threadId: prompt.threadId || prompt.composerId || "",
    parentComposerId: prompt.parentComposerId || "",
    machine: prompt.machine || "",
    tokens,
    chargedCents,
    calls,
  };
}

/**
 * @param {object} bill
 */
function foldSubagents(clumps) {
  /** @type {Map<string, object[]>} */
  const parents = new Map();
  for (const row of clumps) {
    if (row.kind === "subagent" || !row.threadId) continue;
    const list = parents.get(row.threadId) || [];
    list.push(row);
    parents.set(row.threadId, list);
  }
  /** @type {object[]} */
  const kept = [];
  for (const row of clumps) {
    if (row.kind !== "subagent" || !row.parentComposerId) {
      kept.push(row);
      continue;
    }
    const list = parents.get(row.parentComposerId) || [];
    const parent = pickParentPrompt(list, row);
    if (!parent) {
      kept.push(row);
      continue;
    }
    parent.tokens = addTokensKeepBlank(parent.tokens, row.tokens);
    parent.chargedCents = num(parent.chargedCents) + num(row.chargedCents);
    parent.calls = [...(parent.calls || []), ...(row.calls || [])];
  }
  return kept;
}

/**
 * @param {object[]} parents
 * @param {object} child
 */
function pickParentPrompt(parents, child) {
  const t = Date.parse(child.at);
  let best = null;
  for (const parent of parents) {
    const pt = Date.parse(parent.at);
    if (Number.isNaN(pt)) continue;
    if (Number.isNaN(t) || pt <= t) {
      if (!best || Date.parse(best.at) < pt) best = parent;
    }
  }
  return best || parents[0] || null;
}

function billingOnlyClump(bill) {
  const tokens = tokensFromUsage(bill.tokens);
  return {
    id: bill.id,
    source: "billing",
    at: bill.at || "",
    person: "Alex",
    repo: "Other",
    kind: "cursor-desktop",
    model: bill.model || "",
    modelConfig: null,
    prompt: "",
    threadId: bill.conversationId || "",
    machine: "",
    tokens,
    chargedCents: num(bill.chargedCents),
    calls: [
      {
        at: bill.at,
        model: bill.model || "",
        usageEventId: bill.usageEventId || "",
        tokens,
      },
    ],
  };
}

/**
 * @param {string} iso
 */
export function pacificDay(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(t));
}

/**
 * @param {object[]} clumps
 * @param {object} query
 */
export function filterClumps(clumps, query) {
  const person = String(query.person || "").trim();
  const repo = String(query.repo || "").trim();
  const kind = String(query.kind || "").trim();
  const model = String(query.model || "").trim();
  const threadId = String(query.threadId || query.thread || "").trim();
  const from = query.from ? Date.parse(query.from) : NaN;
  const to = query.to ? Date.parse(query.to) : NaN;
  return clumps.filter((row) => {
    if (person && row.person !== person) return false;
    if (repo && row.repo !== repo) return false;
    if (kind && row.kind !== kind) return false;
    if (model && row.model !== model) return false;
    if (threadId && row.threadId !== threadId) return false;
    const t = Date.parse(row.at || "");
    if (!Number.isNaN(from) && (Number.isNaN(t) || t < from)) return false;
    if (!Number.isNaN(to) && (Number.isNaN(t) || t > to)) return false;
    return true;
  });
}

/**
 * @param {object[]} clumps
 */
export function summarizeClumps(clumps) {
  let totals = emptyTokens();
  let cents = 0;
  /** @type {Map<string, { tokens: ReturnType<typeof emptyTokens>, cents: number }>} */
  const byPerson = new Map();
  /** @type {Map<string, { tokens: ReturnType<typeof emptyTokens>, cents: number }>} */
  const byModel = new Map();
  /** @type {Map<string, { tokens: ReturnType<typeof emptyTokens>, cents: number }>} */
  const byRepo = new Map();
  /** @type {Map<string, { tokens: ReturnType<typeof emptyTokens>, cents: number }>} */
  const byKind = new Map();
  /** @type {Map<string, Map<string, { total: number, cents: number }>>} */
  const byDay = new Map();

  for (const row of clumps) {
    const tokens = tokensFromUsage(row.tokens);
    const rowCents = num(row.chargedCents);
    totals = addTokens(totals, tokens);
    cents += rowCents;
    addMap(byPerson, row.person || "Other", tokens, rowCents);
    addMap(byModel, row.model || "unknown", tokens, rowCents);
    addMap(byRepo, row.repo || "Other", tokens, rowCents);
    addMap(byKind, visibleKind(row.kind) || "other", tokens, rowCents);
    const day = pacificDay(row.at);
    if (!day) continue;
    const weight = tokenSum(tokens);
    const people = byDay.get(day) || new Map();
    const person = row.person || "Other";
    const prev = people.get(person) || { total: 0, cents: 0 };
    people.set(person, { total: prev.total + weight, cents: prev.cents + rowCents });
    byDay.set(day, people);
  }

  const grand = tokenSum(totals) || 1;
  return {
    totals,
    total: tokenSum(totals),
    cents,
    byPerson: barsFrom(byPerson, grand),
    byModel: barsFrom(byModel, grand),
    byRepo: barsFrom(byRepo, grand),
    byKind: barsFrom(byKind, grand),
    byDay: [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, people]) => ({
        date,
        people: [...people.entries()]
          .map(([name, bucket]) => ({ name, total: bucket.total, cents: bucket.cents }))
          .sort((a, b) => b.total - a.total),
      })),
  };
}

/**
 * @param {Map<string, { tokens: ReturnType<typeof emptyTokens>, cents: number }>} map
 * @param {string} key
 * @param {ReturnType<typeof emptyTokens>} tokens
 * @param {number} cents
 */
function addMap(map, key, tokens, cents) {
  const prev = map.get(key) || { tokens: emptyTokens(), cents: 0 };
  map.set(key, { tokens: addTokens(prev.tokens, tokens), cents: prev.cents + cents });
}

/**
 * @param {Map<string, { tokens: ReturnType<typeof emptyTokens>, cents: number }>} map
 * @param {number} grand
 */
function barsFrom(map, grand) {
  return [...map.entries()]
    .map(([name, bucket]) => {
      const total = tokenSum(bucket.tokens);
      return {
        name,
        total,
        cents: bucket.cents,
        share: total / grand,
      };
    })
    .filter((row) => row.total > 0 || row.cents > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/**
 * @param {unknown} raw
 */
function planFromBody(raw) {
  if (!raw || typeof raw !== "object") return null;
  const plan = /** @type {Record<string, unknown>} */ (raw);
  const totalSpend = num(plan.totalSpend);
  const totalPercentUsed = Number(plan.totalPercentUsed);
  if (!totalSpend || !Number.isFinite(totalPercentUsed)) return null;
  return {
    totalPercentUsed,
    apiPercentUsed: Number(plan.apiPercentUsed) || 0,
    autoPercentUsed: Number(plan.autoPercentUsed) || 0,
    totalSpend,
    limit: num(plan.limit),
    cycleStart: isoOrEmpty(plan.cycleStart),
    cycleEnd: isoOrEmpty(plan.cycleEnd),
  };
}

async function readPlan() {
  try {
    const meta = JSON.parse(await readFile(USAGE_META_PATH, "utf8"));
    return planFromBody(meta.plan);
  } catch {
    return null;
  }
}

/**
 * @param {object} query
 * @param {number} [now]
 */
export async function resolveRange(query, now = Date.now()) {
  const range = String(query.range || "30d");
  const to = now;
  if (range === "7d") return { from: new Date(to - 7 * DAY_MS).toISOString(), to: new Date(to).toISOString(), range };
  if (range === "period") {
    let start = "";
    try {
      const meta = JSON.parse(await readFile(USAGE_META_PATH, "utf8"));
      start = isoOrEmpty(meta.periodStart);
    } catch {
      start = "";
    }
    if (!start) {
      const day = pacificDay(new Date(to).toISOString());
      start = `${day.slice(0, 8)}01T00:00:00-07:00`;
    }
    return { from: start, to: new Date(to).toISOString(), range };
  }
  return { from: new Date(to - 30 * DAY_MS).toISOString(), to: new Date(to).toISOString(), range: "30d" };
}

async function fileStamp(path) {
  try {
    const info = await stat(path);
    return info.mtimeMs + ":" + info.size;
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") return "0:0";
    throw err;
  }
}

/**
 * Built clumps stay in memory until rows or the local index change.
 * Rebuilding from the jsonl is a few seconds, and filter clicks must not pay it.
 */
async function loadBuiltClumps() {
  const { localIndexForReport } = await import("./usage-local.js");
  const local = await localIndexForReport();
  const key = (await fileStamp(USAGE_ROWS_PATH)) + ":" + (await fileStamp(join(USAGE_DIR, "local-index.json")));
  if (builtCache.key === key && builtCache.clumps) return { clumps: builtCache.clumps, billedAt: builtCache.billedAt };
  if (builtFlight && builtFlight.key === key) return builtFlight.promise;
  const promise = (async () => {
    const rows = await readRows(USAGE_ROWS_PATH);
    let billedAt = "";
    for (const row of rows) {
      if (row?.source === "billing" && String(row.at || "") > billedAt) billedAt = String(row.at);
    }
    const clumps = buildClumps(rows, local);
    builtCache = { key, clumps, billedAt };
    return { clumps, billedAt };
  })();
  builtFlight = { key, promise };
  try {
    return await promise;
  } finally {
    if (builtFlight && builtFlight.promise === promise) builtFlight = null;
  }
}

/**
 * Compact events for the browser. Field order is the client contract.
 * [time, person, repo, kind, model, thread, label, input, output, cacheRead, cacheWrite, cents]
 * @param {object[]} clumps
 */
export function packUsageEvents(clumps) {
  const dict = { person: [], repo: [], kind: [], model: [], thread: [], label: [] };
  /** @type {Record<string, Map<string, number>>} */
  const index = {
    person: new Map(),
    repo: new Map(),
    kind: new Map(),
    model: new Map(),
    thread: new Map(),
    label: new Map(),
  };
  const idOf = (key, value) => {
    const text = String(value || "");
    const map = index[key];
    let id = map.get(text);
    if (id == null) {
      id = dict[key].length;
      dict[key].push(text);
      map.set(text, id);
    }
    return id;
  };
  const events = clumps.map((row) => {
    const tokens = tokensFromUsage(row.tokens);
    return [
      Date.parse(row.at || "") || 0,
      idOf("person", row.person || "Other"),
      idOf("repo", row.repo || "Other"),
      idOf("kind", visibleKind(row.kind) || "other"),
      idOf("model", row.model || "unknown"),
      idOf("thread", row.threadId || row.id || ""),
      idOf("label", agentTypeLabel(row)),
      tokens.input || 0,
      tokens.output || 0,
      tokens.cacheRead || 0,
      tokens.cacheWrite || 0,
      num(row.chargedCents),
      tokens.reasoning || 0,
    ];
  });
  return { dict, events };
}

/**
 * @param {{ dict: Record<string, string[]>, events: number[][] }} packed
 */
export function unpackUsageEvents(packed) {
  const dict = packed.dict;
  return packed.events.map((event) => ({
    at: new Date(event[0] || 0).toISOString(),
    person: dict.person[event[1]] || "Other",
    repo: dict.repo[event[2]] || "Other",
    kind: dict.kind[event[3]] || "other",
    model: dict.model[event[4]] || "unknown",
    threadId: dict.thread[event[5]] || "",
    label: dict.label[event[6]] || "cursor desktop",
    tokens: {
      input: event[7] || 0,
      output: event[8] || 0,
      cacheRead: event[9] || 0,
      cacheWrite: event[10] || 0,
      reasoning: event[12] || 0,
    },
    chargedCents: event[11] || 0,
  }));
}

/**
 * One payload covers billing period, 7 days, and 30 days.
 * The page filters it locally.
 * @param {number} [now]
 */
export async function usageIndex(now = Date.now()) {
  const { clumps, billedAt } = await loadBuiltClumps();
  const period = await resolveRange({ range: "period" }, now);
  const week = await resolveRange({ range: "7d" }, now);
  const month = await resolveRange({ range: "30d" }, now);
  const from = Math.min(Date.parse(period.from), Date.parse(month.from));
  /** @type {object[]} */
  const ranged = [];
  for (const row of clumps) {
    const t = Date.parse(row.at || "");
    if (Number.isNaN(t) || t < from || t > now) continue;
    ranged.push(row);
  }
  const packed = packUsageEvents(ranged);
  /** @type {Record<string, string>} */
  let titles = {};
  try {
    const ids = [];
    for (const row of ranged) {
      if (row.threadId) ids.push(row.threadId);
    }
    titles = scrubWhatsAppAgentTitles(await chatTitlesForSessions(ids));
  } catch (err) {
    console.error("[usage] chat titles", err);
  }
  return {
    ok: true,
    bounds: {
      period: { from: period.from, to: period.to },
      "7d": { from: week.from, to: week.to },
      "30d": { from: month.from, to: month.to },
    },
    plan: await readPlan(),
    sync: await readSync(billedAt),
    dict: packed.dict,
    events: packed.events,
    titles,
  };
}

/**
 * When each collector last checked in, and the newest billing event on file.
 * @param {string} billedAt
 */
async function readSync(billedAt) {
  const meta = await readMeta();
  /** @type {Record<string, { at: string, billingAt?: string }>} */
  const collectors = {};
  const raw = meta.collectors && typeof meta.collectors === "object" ? meta.collectors : {};
  for (const [machine, seen] of Object.entries(raw)) {
    const at = isoOrEmpty(seen?.at);
    if (!at) continue;
    collectors[machine] = { at };
    const billingAt = isoOrEmpty(seen?.billingAt);
    if (billingAt) collectors[machine].billingAt = billingAt;
  }
  return { billedAt: billedAt || "", collectors };
}

/**
 * @param {object} query
 */
export async function usageReport(query) {
  const bounds = await resolveRange(query);
  const { clumps: built } = await loadBuiltClumps();
  const ranged = filterClumps(built, { from: bounds.from, to: bounds.to });
  const clumps = filterClumps(ranged, query);
  const offset = Math.max(0, Number(query.offset) || 0);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 40));
  const threadOnly = String(query.threadId || query.thread || "").trim() && String(query.group || "") !== "thread";
  if (threadOnly) {
    return {
      ok: true,
      ...bounds,
      total: clumps.length,
      prompts: clumps.slice(offset, offset + limit).map(publicClump),
    };
  }
  const summary = summarizeClumps(clumps);
  summary.byPerson = summarizeClumps(filterClumps(ranged, { ...query, person: "" })).byPerson;
  summary.byModel = summarizeClumps(filterClumps(ranged, { ...query, model: "" })).byModel;
  summary.byRepo = summarizeClumps(filterClumps(ranged, { ...query, repo: "" })).byRepo;
  summary.byKind = summarizeClumps(filterClumps(ranged, { ...query, kind: "" })).byKind;
  summary.facets = {
    person: facetNames(ranged, "person"),
    model: facetNames(ranged, "model"),
    repo: facetNames(ranged, "repo"),
    kind: [...new Set(facetNames(ranged, "kind").map((name) => visibleKind(name)))].sort((a, b) =>
      a.localeCompare(b)
    ),
  };
  summary.plan = await readPlan();
  const group = String(query.group || "");

  if (group === "thread") {
    /** @type {Map<string, object>} */
    const threads = new Map();
    for (const row of clumps) {
      const key = row.threadId || row.id;
      const prev = threads.get(key);
      if (!prev) {
        const thread = {
          threadId: key,
          person: row.person,
          repo: row.repo,
          kind: visibleKind(row.kind),
          model: row.model,
          at: row.at,
          count: 1,
          tokens: tokensFromUsage(row.tokens),
          chargedCents: num(row.chargedCents),
          label: "",
          labelAt: 0,
        };
        applyThreadLabel(thread, row);
        threads.set(key, thread);
        continue;
      }
      prev.count += 1;
      prev.tokens = addTokens(prev.tokens, tokensFromUsage(row.tokens));
      prev.chargedCents = num(prev.chargedCents) + num(row.chargedCents);
      if (Date.parse(row.at) > Date.parse(prev.at)) {
        prev.at = row.at;
        prev.model = row.model || prev.model;
        prev.kind = visibleKind(row.kind) || prev.kind;
        prev.person = row.person || prev.person;
      }
      applyThreadLabel(prev, row);
    }
    const list = [...threads.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return {
      ok: true,
      ...bounds,
      summary,
      total: list.length,
      threads: list.slice(offset, offset + limit).map(publicThread),
    };
  }

  const page = clumps.slice(offset, offset + limit).map(publicClump);
  return {
    ok: true,
    ...bounds,
    summary,
    total: clumps.length,
    prompts: page,
  };
}

/**
 * @param {object} row
 */
/**
 * @param {object[]} rows
 * @param {string} key
 */
function facetNames(rows, key) {
  return [...new Set(rows.map((row) => String(row[key] || "").trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function publicClump(row) {
  const prompt = hideWhatsAppAgentPrompt(String(row.prompt || ""));
  return {
    id: row.id,
    at: row.at,
    person: row.person,
    repo: row.repo,
    kind: visibleKind(row.kind),
    model: row.model,
    modelConfig: row.modelConfig,
    threadId: row.threadId,
    prompt: prompt.slice(0, PROMPT_API_MAX),
    promptTruncated: prompt.length > PROMPT_API_MAX,
    tokens: publicTokens(row.tokens),
    chargedCents: num(row.chargedCents),
    calls: Array.isArray(row.calls) ? row.calls : [],
  };
}

/**
 * @param {object} row
 */
function publicTokens(tokens) {
  const t = tokensFromUsage(tokens);
  if (tokens && tokens.cacheRead == null) t.cacheRead = null;
  if (tokens && tokens.cacheWrite == null) t.cacheWrite = null;
  return t;
}

function publicThread(row) {
  return {
    threadId: row.threadId,
    person: row.person,
    repo: row.repo,
    kind: visibleKind(row.kind),
    label: row.label && !/whatsapp/i.test(row.label) ? row.label : agentTypeLabel(row),
    model: row.model,
    at: row.at,
    count: row.count,
    tokens: publicTokens(row.tokens),
    chargedCents: num(row.chargedCents),
  };
}
