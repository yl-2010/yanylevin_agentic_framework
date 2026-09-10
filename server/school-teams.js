/**
 * School Microsoft 365 Teams (owner@school.example). No Graph app
 * registration. Reuses the school-mail Chrome profile cookies, captures
 * first-party tokens from teams.microsoft.com (CSA list, IC3 messages,
 * MT people), then reads chats / channels and sends.
 *
 * Graph Chat.Read is not available without admin consent. Do not register
 * an Azure app or reuse the Outlook Web client id with Chat scopes.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAgentSentFooter } from "./imessage-mention.js";
import {
  GRAPH_BASE,
  SCHOOL_EMAIL,
  isSessionFresh,
  jwtEmail,
  jwtExp,
  jwtClaims,
  redactSecrets,
  schoolMailDir,
  stripHtml,
  tokenAudience,
} from "./school-mail.js";

export { SCHOOL_EMAIL, GRAPH_BASE };

const LOGIN_WAIT_MS = 10 * 60_000;
const REFRESH_WAIT_MS = 45_000;
const MT_GRACE_MS = 2_000;
export const TEAMS_WEB_URL = "https://teams.microsoft.com/";
export const TEAMS_CLOUD = "https://teams.cloud.microsoft";
export const DUMP_BODY_MAX = 400;
export const DUMP_MAX = 150;
const MESSAGE_TEXT_MAX = 4000;
const PEOPLE_LOOKUP_CONCURRENCY = 6;

export function schoolTeamsDir() {
  return (
    String(process.env.SCHOOL_TEAMS_DIR || "").trim() ||
    join(homedir(), ".yanylevin", "school-teams")
  );
}

export function chromeProfileDir() {
  return (
    String(process.env.SCHOOL_TEAMS_PROFILE || "").trim() ||
    join(schoolMailDir(), "chrome-profile")
  );
}

export function sessionPath(root = schoolTeamsDir()) {
  return join(root, "session.json");
}

export function peoplePath(root = schoolTeamsDir()) {
  return join(root, "people.json");
}

export function parseArgs(argv) {
  const args = [...argv];
  const cmd = String(args.shift() || "").trim();
  const out = {
    cmd,
    force: false,
    headed: false,
    limit: 20,
    query: "",
    id: "",
    chat: "",
    team: "",
    channel: "",
    text: "",
    since: "",
    out: "",
  };
  while (args.length) {
    const a = args.shift();
    if (a === "--force") out.force = true;
    else if (a === "--headed") out.headed = true;
    else if (a === "--chat" || a === "--to") {
      const rest = [];
      while (args.length && !String(args[0]).startsWith("--")) rest.push(args.shift());
      out.chat = rest.join(" ").trim();
    } else if (a === "--team") {
      const rest = [];
      while (args.length && !String(args[0]).startsWith("--")) rest.push(args.shift());
      out.team = rest.join(" ").trim();
    } else if (a === "--channel") {
      const rest = [];
      while (args.length && !String(args[0]).startsWith("--")) rest.push(args.shift());
      out.channel = rest.join(" ").trim();
    } else if (a === "--text") {
      const rest = [];
      while (args.length && !String(args[0]).startsWith("--")) rest.push(args.shift());
      out.text = rest.join(" ").trim();
    } else if (a === "--since") out.since = String(args.shift() || "").trim();
    else if (a === "--out") out.out = String(args.shift() || "").trim();
    else if (a === "--limit") {
      const n = Number(args.shift());
      out.limit = Number.isFinite(n) ? Math.min(50, Math.max(1, Math.trunc(n))) : 20;
    } else if (cmd === "search" && !out.query) {
      const rest = [a];
      while (args.length && !String(args[0]).startsWith("--")) rest.push(args.shift());
      out.query = rest.join(" ").trim();
    } else if (cmd === "thread" && !out.id && !out.chat && !String(a).startsWith("--")) {
      out.chat = String(a || "").trim();
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return out;
}

export function teamsScopes(token) {
  const claims = jwtClaims(token);
  const blob = [claims.scp, claims.roles]
    .flatMap((v) => (Array.isArray(v) ? v : String(v || "").split(/\s+/)))
    .filter(Boolean)
    .join(" ");
  return blob
    .split(/\s+/)
    .filter((s) => /^(Chat|ChatMessage|ChannelMessage|Channel|Team)(\.|$)/i.test(s));
}

export function hasChatRead(token) {
  return teamsScopes(token).some((s) => /^Chat\.(ReadBasic|Read|ReadWrite)(\.|$)/i.test(s));
}

export function hasChannelRead(token) {
  return teamsScopes(token).some((s) =>
    /^(ChannelMessage\.(Read|ReadWrite)|Team\.ReadBasic)/i.test(s)
  );
}

export function isGraphAudience(token) {
  const aud = tokenAudience(token).toLowerCase();
  if (!aud) return false;
  return (
    aud.includes("graph.microsoft.com") ||
    aud.includes("00000003-0000-0000-c000-000000000000")
  );
}

export function isIc3Token(token) {
  const aud = tokenAudience(token).toLowerCase();
  if (!aud.includes("ic3.teams.office.com")) return false;
  return /Teams\.AccessAsUser/i.test(String(jwtClaims(token).scp || ""));
}

export function isCsaToken(token) {
  const aud = tokenAudience(token).toLowerCase();
  return aud.includes("chatsvcagg.teams.microsoft.com");
}

export function isMtToken(token) {
  const aud = tokenAudience(token).toLowerCase();
  return aud.includes("api.spaces.skype.com") || aud.includes("chatsvcagg");
}

export function isTeamsToken(token) {
  if (isIc3Token(token)) return true;
  if (!isGraphAudience(token)) return false;
  return hasChatRead(token);
}

export function pickByName(rows, needle, nameKey = "name") {
  const n = String(needle || "").trim().toLowerCase();
  if (!n) return { match: null, ambiguous: [] };
  const list = Array.isArray(rows) ? rows : [];
  const exact = list.filter((r) => String(r[nameKey] || "").trim().toLowerCase() === n);
  if (exact.length === 1) return { match: exact[0], ambiguous: [] };
  const hits = list.filter((r) => String(r[nameKey] || "").trim().toLowerCase().includes(n));
  if (hits.length === 1) return { match: hits[0], ambiguous: [] };
  return { match: null, ambiguous: hits };
}

export function messageText(raw, max = MESSAGE_TEXT_MAX) {
  const body = raw?.body || {};
  const content = String(body.content || raw?.content || "");
  const type = String(body.contentType || raw?.contenttype || "").toLowerCase();
  if (type === "text" && !/<[a-z][\s\S]*>/i.test(content)) {
    return content.trim().slice(0, max);
  }
  return stripHtml(content, max);
}

function memberEmail(raw) {
  return String(
    raw?.email || raw?.mail || raw?.user?.email || raw?.user?.userPrincipalName || ""
  )
    .trim()
    .toLowerCase();
}

function memberName(raw) {
  return String(raw?.displayName || raw?.name || raw?.user?.displayName || "").trim();
}

function memberObjectId(raw) {
  return String(raw?.objectId || raw?.id || raw?.user?.id || "").trim();
}

export function chatDisplayName(raw, selfEmail = SCHOOL_EMAIL) {
  const topic = String(raw?.title || raw?.topic || raw?.name || "").trim();
  if (topic) return topic;
  const self = String(selfEmail || "").trim().toLowerCase();
  const selfId = String(raw?.selfObjectId || "").trim().toLowerCase();
  const members = Array.isArray(raw?.members) ? raw.members : [];
  const others = members
    .map((m) => ({
      name: memberName(m),
      email: memberEmail(m),
      objectId: memberObjectId(m).toLowerCase(),
    }))
    .filter((m) => {
      if (m.email && m.email === self) return false;
      if (selfId && m.objectId && m.objectId === selfId) return false;
      return m.name || m.email;
    });
  if (others.length) {
    return others.map((m) => m.name || m.email).join(", ");
  }
  const last = raw?.lastMessage || raw?.lastMessagePreview || {};
  const lastName = String(
    last.imDisplayName || last.imdisplayname || last.fromDisplayNameInToken || ""
  ).trim();
  if (lastName && raw?.isLastMessageFromMe !== true) return lastName;
  return "(chat)";
}

function chatTypeOf(raw) {
  if (raw?.isOneOnOne === true) return "oneOnOne";
  const t = String(raw?.threadType || raw?.chatType || "").trim().toLowerCase();
  if (t === "meeting") return "meeting";
  return "group";
}

export function normalizeChat(raw, selfEmail = SCHOOL_EMAIL) {
  const preview = raw?.lastMessagePreview || raw?.lastMessage || {};
  const updated = String(
    raw?.lastUpdatedDateTime ||
      preview.originalArrivalTime ||
      preview.originalarrivaltime ||
      preview.composeTime ||
      preview.composetime ||
      preview.createdDateTime ||
      raw?.createdAt ||
      ""
  ).trim();
  return {
    id: String(raw?.id || "").trim(),
    name: chatDisplayName(raw, selfEmail),
    chatType: chatTypeOf(raw),
    updated: isoOrEmpty(updated) || updated,
    preview: messageText(preview, 200),
    members: (Array.isArray(raw?.members) ? raw.members : [])
      .map((m) => ({
        name: memberName(m),
        email: memberEmail(m),
        objectId: memberObjectId(m),
      }))
      .filter((m) => m.name || m.email || m.objectId),
  };
}

export function normalizeTeam(raw) {
  return {
    id: String(raw?.id || "").trim(),
    name: String(raw?.displayName || raw?.name || "").trim(),
    description: String(raw?.description || "").trim(),
    channels: Array.isArray(raw?.channels) ? raw.channels.map(normalizeChannel) : undefined,
  };
}

export function normalizeChannel(raw) {
  return {
    id: String(raw?.id || "").trim(),
    name: String(raw?.displayName || raw?.name || "").trim(),
    membershipType: String(raw?.membershipType || raw?.channelType || "").trim(),
  };
}

export function fromMeOf(raw, self = {}) {
  const objectId = String(self.objectId || "").trim().toLowerCase();
  const email = String(self.email || SCHOOL_EMAIL)
    .trim()
    .toLowerCase();
  const from = raw?.from;
  if (typeof from === "string") {
    const blob = from.toLowerCase();
    if (objectId && blob.includes(objectId)) return true;
  }
  const fromUser = from && typeof from === "object" ? from.user || from : {};
  const upn = String(fromUser.userPrincipalName || fromUser.email || "")
    .trim()
    .toLowerCase();
  if (upn && upn === email) return true;
  const id = String(fromUser.id || fromUser.objectId || "")
    .trim()
    .toLowerCase();
  if (objectId && id && id === objectId) return true;
  return false;
}

function normalizeMessageType(raw) {
  const t = String(raw?.messageType || raw?.messagetype || "").trim();
  if (!t || /^(text|richtext\/html|message)$/i.test(t)) return "message";
  return t;
}

export function normalizeMessage(raw, extra = {}) {
  const fromUser = raw?.from?.user || {};
  const text = messageText(raw, extra.textMax || DUMP_BODY_MAX);
  const fromName = String(
    fromUser.displayName ||
      raw?.imdisplayname ||
      raw?.imDisplayName ||
      raw?.fromDisplayNameInToken ||
      fromUser.userPrincipalName ||
      ""
  ).trim();
  const at = String(
    raw?.createdDateTime ||
      raw?.lastModifiedDateTime ||
      raw?.originalarrivaltime ||
      raw?.originalArrivalTime ||
      raw?.composetime ||
      raw?.composeTime ||
      ""
  ).trim();
  return {
    id: String(raw?.id || "").trim(),
    at: isoOrEmpty(at) || at,
    from: fromName,
    fromEmail: String(fromUser.userPrincipalName || fromUser.email || extra.fromEmail || "").trim(),
    fromMe: fromMeOf(raw, extra.self || extra),
    text,
    messageType: normalizeMessageType(raw),
    chatId: extra.chatId || "",
    chat: extra.chat || "",
    team: extra.team || "",
    channel: extra.channel || "",
    kind: extra.kind || "chat",
  };
}

export function buildCsaUpdatesUrl(region = "amer") {
  const r = encodeURIComponent(String(region || "amer").trim() || "amer");
  return `${TEAMS_CLOUD}/api/csa/${r}/api/v3/teams/users/me/updates?isPrefetch=false&enableMembershipSummary=true`;
}

export function buildChatsUrl({ region = "amer" } = {}) {
  return buildCsaUpdatesUrl(region);
}

export function buildChatMessagesUrl(chatId, { limit = 20, region = "amer" } = {}) {
  const safe = encodeURIComponent(String(chatId || "").trim());
  const top = Math.min(50, Math.max(1, Number(limit) || 20));
  const r = encodeURIComponent(String(region || "amer").trim() || "amer");
  return `${TEAMS_CLOUD}/api/chatsvc/${r}/v1/users/ME/conversations/${safe}/messages?view=msnp24Equivalent&pageSize=${top}`;
}

export function buildSendChatUrl(chatId, { region = "amer" } = {}) {
  const safe = encodeURIComponent(String(chatId || "").trim());
  const r = encodeURIComponent(String(region || "amer").trim() || "amer");
  return `${TEAMS_CLOUD}/api/chatsvc/${r}/v1/users/ME/conversations/${safe}/messages`;
}

export function buildMtUserUrl(objectId, { region = "amer" } = {}) {
  const id = encodeURIComponent(String(objectId || "").trim());
  const r = encodeURIComponent(String(region || "amer").trim() || "amer");
  return `${TEAMS_CLOUD}/api/mt/${r}/beta/users/${id}`;
}

export function buildJoinedTeamsUrl({ limit = 50 } = {}) {
  const top = Math.min(50, Math.max(1, Number(limit) || 50));
  return `${GRAPH_BASE}/me/joinedTeams?$select=id,displayName,description&$top=${top}`;
}

export function buildChannelsUrl(teamId) {
  const safe = encodeURIComponent(String(teamId || "").trim());
  return `${GRAPH_BASE}/teams/${safe}/channels?$select=id,displayName,membershipType`;
}

export function buildChannelMessagesUrl(teamId, channelId, { limit = 20 } = {}) {
  const team = encodeURIComponent(String(teamId || "").trim());
  const channel = encodeURIComponent(String(channelId || "").trim());
  const top = Math.min(50, Math.max(1, Number(limit) || 20));
  return `${GRAPH_BASE}/teams/${team}/channels/${channel}/messages?$top=${top}`;
}

export function buildSendChannelUrl(teamId, channelId) {
  const team = encodeURIComponent(String(teamId || "").trim());
  const channel = encodeURIComponent(String(channelId || "").trim());
  return `${GRAPH_BASE}/teams/${team}/channels/${channel}/messages`;
}

export function buildSendChatBody(text) {
  const n = Math.floor(Math.random() * 1e6);
  return {
    content: String(text || ""),
    messagetype: "Text",
    contenttype: "text",
    clientmessageid: `${Date.now()}${String(n).padStart(6, "0")}`.slice(0, 19),
  };
}

export function isTeamsSessionFresh(session, nowMs = Date.now()) {
  if (!session?.token || !session?.csaToken) return false;
  if (!isIc3Token(session.token) && !isTeamsToken(session.token)) return false;
  if (!isCsaToken(session.csaToken)) return false;
  const ic3Ok = isSessionFresh(
    { token: session.token, exp: session.exp || jwtExp(session.token) },
    nowMs
  );
  const csaOk = isSessionFresh(
    { token: session.csaToken, exp: session.csaExp || jwtExp(session.csaToken) },
    nowMs
  );
  return ic3Ok && csaOk;
}

function needsLoginPayload(detail) {
  return {
    ok: false,
    error: "not signed in",
    hint: "On the Mac Studio, run: node server/school-teams.js login",
    detail: detail || "",
    account: SCHOOL_EMAIL,
  };
}

async function loadSession(root = schoolTeamsDir()) {
  try {
    const raw = await readFile(sessionPath(root), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveSession(session, root = schoolTeamsDir()) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dest = sessionPath(root);
  const tmp = `${dest}.${process.pid}.tmp`;
  const token = session.token;
  const csaToken = session.csaToken || "";
  await writeFile(
    tmp,
    JSON.stringify(
      {
        token,
        csaToken,
        mtToken: session.mtToken || "",
        graphToken: session.graphToken || "",
        exp: jwtExp(token),
        csaExp: csaToken ? jwtExp(csaToken) : 0,
        mtExp: session.mtToken ? jwtExp(session.mtToken) : 0,
        graphExp: session.graphToken ? jwtExp(session.graphToken) : 0,
        aud: tokenAudience(token),
        email: jwtEmail(token) || jwtEmail(csaToken) || SCHOOL_EMAIL,
        region: session.region || "amer",
        objectId: session.objectId || jwtClaims(token).oid || "",
        partition: session.partition || "",
        userAgent: session.userAgent || "",
        capturedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  await rename(tmp, dest);
}

async function loadPeople(root = schoolTeamsDir()) {
  try {
    const raw = JSON.parse(await readFile(peoplePath(root), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

async function savePeople(map, root = schoolTeamsDir()) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dest = peoplePath(root);
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
  await rename(tmp, dest);
}

async function launchChrome(opts) {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error("playwright-core is not installed (cd server && npm install)");
  }
  const headed = Boolean(opts.headed);
  const dir = opts.profile || chromeProfileDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return chromium.launchPersistentContext(dir, {
    channel: "chrome",
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    args: headed ? [] : ["--window-position=-2400,-2400"],
  });
}

function waitForTeamsTokens(context, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    let grace = null;
    const found = {
      ic3: "",
      csa: "",
      mt: "",
      graph: "",
      objectId: "",
      partition: "",
      region: "amer",
      userAgent: "",
    };
    const timer = setTimeout(() => {
      cleanup();
      if (found.ic3 && found.csa) {
        finish();
        return;
      }
      const missing = [
        !found.ic3 ? "IC3" : "",
        !found.csa ? "CSA" : "",
      ]
        .filter(Boolean)
        .join(" + ");
      reject(new Error(`timed out waiting for Teams chat tokens (${missing || "CSA + IC3"})`));
    }, timeoutMs);

    function finish() {
      if (done) return;
      done = true;
      cleanup();
      resolve(found);
    }

    function maybeDone() {
      if (!found.ic3 || !found.csa || done) return;
      if (found.mt) {
        finish();
        return;
      }
      if (!grace) {
        grace = setTimeout(finish, MT_GRACE_MS);
      }
    }

    function consider(token, headers, url) {
      if (done || !token) return;
      const h = headers || {};
      if (h["user-agent"]) found.userAgent = h["user-agent"];
      if (h["x-ms-object-id"]) found.objectId = h["x-ms-object-id"];
      if (h["x-ms-partition"]) found.partition = h["x-ms-partition"];
      const m = String(url || "").match(/\/api\/(?:csa|chatsvc|mt)\/([^/]+)\//);
      if (m) found.region = m[1];
      if (isIc3Token(token)) found.ic3 = token;
      if (isCsaToken(token)) found.csa = token;
      if (String(url || "").includes("/api/mt/") && token) found.mt = token;
      if (isGraphAudience(token) && (hasChannelRead(token) || hasChatRead(token))) {
        found.graph = token;
      }
      maybeDone();
    }

    function onReq(req) {
      const headers = req.headers();
      const h = headers.authorization || headers.Authorization || "";
      if (!/^Bearer\s+/i.test(h)) return;
      consider(h.replace(/^Bearer\s+/i, "").trim(), headers, req.url());
    }

    function cleanup() {
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      context.off("request", onReq);
    }

    context.on("request", onReq);
  });
}

async function clickIfVisible(page, name, timeoutMs = 4000) {
  try {
    const btn = page.getByRole("button", { name, exact: false });
    await btn.first().waitFor({ state: "visible", timeout: timeoutMs });
    await btn.first().click({ timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function captureToken(opts) {
  const headed = Boolean(opts.headed);
  const waitMs = headed ? LOGIN_WAIT_MS : REFRESH_WAIT_MS;
  const context = await launchChrome(opts);
  try {
    const pending = waitForTeamsTokens(context, waitMs);
    const page = context.pages()[0] || (await context.newPage());
    try {
      await page.goto(TEAMS_WEB_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    } catch {
      // token listener still runs
    }
    await sleep(2000);
    await clickIfVisible(page, "Chat");
    await clickIfVisible(page, "Chats");
    try {
      await page.goto("https://teams.microsoft.com/v2/#/chats", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    } catch {
      // still listening
    }
    const found = await pending;
    const session = {
      token: found.ic3,
      csaToken: found.csa,
      mtToken: found.mt,
      graphToken: found.graph,
      region: found.region || "amer",
      objectId: found.objectId || jwtClaims(found.ic3).oid || "",
      partition: found.partition,
      userAgent: found.userAgent,
    };
    await saveSession(session, opts.root);
    return { ...session, ...(await loadSession(opts.root || schoolTeamsDir())) };
  } finally {
    await context.close().catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function teamsHeaders(session, { token, extra } = {}) {
  const bearer = token || session.token;
  return {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/json",
    origin: "https://teams.cloud.microsoft",
    referer: "https://teams.cloud.microsoft/",
    "user-agent": session.userAgent || "Mozilla/5.0",
    "x-ms-client-type": "web",
    "x-ms-user-type": "aad",
    ...(session.objectId ? { "x-ms-object-id": session.objectId } : {}),
    ...(session.partition ? { "x-ms-partition": session.partition } : {}),
    ...(session.region ? { "x-ms-region": session.region } : {}),
    ...extra,
  };
}

async function apiRequest(url, session, { method = "GET", body, token, extra } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        ...teamsHeaders(session, { token, extra }),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (res.status === 429 || res.status === 503) {
      lastErr = new Error(`Teams API ${res.status}`);
      lastErr.status = res.status;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      const snippet = redactSecrets(text).replace(/\s+/g, " ").slice(0, 220);
      const err = new Error(`Teams API ${res.status}: ${snippet}`);
      err.status = res.status;
      throw err;
    }
    if (!text.trim()) return {};
    return JSON.parse(text);
  }
  throw lastErr || new Error("Teams API retry exhausted");
}

async function resolveSession(opts) {
  const root = opts.root || schoolTeamsDir();
  const session = await loadSession(root);
  if (isTeamsSessionFresh(session) && !opts.force) {
    return { ...session, root };
  }
  if (!session) {
    throw new Error("no saved school Teams session");
  }
  if (opts.allowStale && !opts.force && session.token && session.csaToken) {
    return { ...session, root };
  }
  try {
    const next = await captureToken({
      headed: Boolean(opts.headed),
      root,
    });
    return { ...next, root };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (session.token && session.csaToken && !opts.force) {
      return { ...session, root };
    }
    throw new Error(msg);
  }
}

async function csaSnapshot(session) {
  if (session._csa && Date.now() - (session._csaAt || 0) < 8_000) {
    return session._csa;
  }
  const data = await apiRequest(buildCsaUpdatesUrl(session.region || "amer"), session, {
    token: session.csaToken,
    extra: { "x-ms-synctoken": "0" },
  });
  session._csa = data;
  session._csaAt = Date.now();
  return data;
}

async function mapPool(items, n, fn) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  let i = 0;
  const width = Math.max(1, Math.min(n, list.length || 1));
  async function worker() {
    while (i < list.length) {
      const idx = i++;
      out[idx] = await fn(list[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: list.length ? width : 0 }, worker));
  return out;
}

async function lookupPerson(session, objectId, cache) {
  const id = String(objectId || "").trim();
  if (!id) return null;
  if (cache[id]?.name || cache[id]?.email) return cache[id];
  if (!session.mtToken) return cache[id] || null;
  try {
    const data = await apiRequest(buildMtUserUrl(id, { region: session.region }), session, {
      token: session.mtToken,
    });
    const val = data.value && typeof data.value === "object" ? data.value : data;
    const person = {
      name: String(val.displayName || "").trim(),
      email: String(val.mail || val.userPrincipalName || val.email || "")
        .trim()
        .toLowerCase(),
    };
    if (person.name || person.email) cache[id] = person;
    return cache[id] || person;
  } catch {
    return cache[id] || null;
  }
}

function clipMembers(members, max = 8) {
  return (Array.isArray(members) ? members : [])
    .filter((m) => m && (m.name || m.email))
    .slice(0, max);
}

async function enrichChats(session, chats) {
  const root = session.root || schoolTeamsDir();
  const cache = await loadPeople(root);
  const selfId = String(session.objectId || "").trim();
  const ids = new Set();
  for (const chat of chats) {
    const named = String(chat.name || "").trim();
    if (named && named !== "(chat)") continue;
    const others = (chat.members || []).filter(
      (m) => m.objectId && m.objectId !== selfId && !m.name && !m.email && !cache[m.objectId]
    );
    const take = chat.chatType === "oneOnOne" ? others.slice(0, 1) : others.slice(0, 4);
    for (const m of take) ids.add(m.objectId);
  }
  if (ids.size) {
    await mapPool([...ids], PEOPLE_LOOKUP_CONCURRENCY, async (id) => {
      await lookupPerson(session, id, cache);
    });
    await savePeople(cache, root).catch(() => {});
  }
  return chats.map((chat) => {
    const members = (chat.members || []).map((m) => {
      const hit = m.objectId ? cache[m.objectId] : null;
      return {
        ...m,
        name: m.name || hit?.name || "",
        email: m.email || hit?.email || "",
      };
    });
    const named = {
      ...chat,
      members,
      selfObjectId: selfId,
      title: chat.name && chat.name !== "(chat)" ? chat.name : "",
    };
    return {
      ...chat,
      members,
      name: chatDisplayName(named, session.email || SCHOOL_EMAIL),
    };
  });
}

export async function listChats(session, { limit = 50 } = {}) {
  const data = await csaSnapshot(session);
  const rows = Array.isArray(data.chats) ? data.chats : [];
  const mapped = rows
    .filter((row) => row && row.hidden !== true)
    .map((row) =>
      normalizeChat({ ...row, selfObjectId: session.objectId }, session.email || SCHOOL_EMAIL)
    )
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const cap = Math.min(mapped.length, Math.max(1, Number(limit) || 50));
  const enriched = await enrichChats(session, mapped.slice(0, cap));
  return enriched.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

export async function listChatMessages(session, chatId, { limit = 20 } = {}) {
  const data = await apiRequest(
    buildChatMessagesUrl(chatId, { limit, region: session.region }),
    session
  );
  const rows = Array.isArray(data.messages)
    ? data.messages
    : Array.isArray(data.value)
      ? data.value
      : [];
  const self = { objectId: session.objectId, email: session.email || SCHOOL_EMAIL };
  return rows.map((row) =>
    normalizeMessage(row, {
      chatId,
      kind: "chat",
      textMax: MESSAGE_TEXT_MAX,
      self,
    })
  );
}

export async function listJoinedTeams(session, { limit = 50 } = {}) {
  const data = await csaSnapshot(session);
  const rows = Array.isArray(data.teams) ? data.teams : [];
  return rows
    .map((row) => normalizeTeam(row))
    .filter((t) => t.id && t.name)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, Math.min(50, Math.max(1, Number(limit) || 50)));
}

export async function listChannels(session, teamId) {
  const teams = await listJoinedTeams(session, { limit: 50 });
  const team =
    teams.find((t) => t.id === teamId) ||
    teams.find((t) => t.name.toLowerCase() === String(teamId || "").toLowerCase());
  if (team?.channels) return team.channels;
  const data = await csaSnapshot(session);
  const raw = (data.teams || []).find((t) => t.id === teamId);
  return Array.isArray(raw?.channels) ? raw.channels.map(normalizeChannel) : [];
}

export async function listChannelMessages(session, _teamId, channelId, { limit = 20 } = {}) {
  return listChatMessages(session, channelId, { limit });
}

function isoOrEmpty(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

/**
 * Recent chat messages for the @agent poller. Only chats updated since `since`.
 * @param {{ since?: string, chatLimit?: number, messageLimit?: number, root?: string, headed?: boolean, force?: boolean, session?: object }} [opts]
 */
export async function fetchRecentChatMessages(opts = {}) {
  const session =
    opts.session ||
    (await resolveSession({ ...opts, allowStale: opts.allowStale !== false }));
  const since = isoOrEmpty(opts.since);
  const chats = await listChats(session, { limit: opts.chatLimit || 40 });
  /** @type {object[]} */
  const out = [];
  for (const chat of chats) {
    if (since && chat.updated && chat.updated < since) continue;
    const rows = await listChatMessages(session, chat.id, {
      limit: opts.messageLimit || 20,
    });
    for (const row of rows) {
      out.push({ ...row, chatId: chat.id, chat: chat.name, kind: "chat" });
    }
    await sleep(40);
  }
  return out;
}

/**
 * Nightly dump: recent chat + channel messages since `since`.
 * @param {{ since?: string, max?: number, root?: string, headed?: boolean, force?: boolean, session?: object }} [opts]
 */
export async function fetchSchoolTeams(opts = {}) {
  const session = opts.session || (await resolveSession(opts));
  const since = isoOrEmpty(opts.since);
  const max = Number(opts.max) || DUMP_MAX;
  const chats = await listChats(session, { limit: 50 });
  /** @type {object[]} */
  const messages = [];
  const self = { objectId: session.objectId, email: session.email || SCHOOL_EMAIL };

  for (const chat of chats) {
    if (messages.length >= max) break;
    if (since && chat.updated && chat.updated < since) continue;
    const rows = await listChatMessages(session, chat.id, { limit: 15 });
    for (const row of rows) {
      if (since && row.at && row.at < since) continue;
      messages.push({
        ...row,
        text: String(row.text || "").slice(0, DUMP_BODY_MAX),
        chatId: chat.id,
        chat: chat.name,
        kind: "chat",
      });
      if (messages.length >= max) break;
    }
    await sleep(40);
  }

  let teams = [];
  try {
    teams = await listJoinedTeams(session, { limit: 30 });
  } catch {
    teams = [];
  }
  const snap = session._csa || {};
  for (const team of (snap.teams || teams).slice(0, 8)) {
    if (messages.length >= max) break;
    const teamName = team.displayName || team.name;
    const channels = Array.isArray(team.channels)
      ? team.channels.map((c) =>
          c.id && c.name ? c : normalizeChannel(c)
        )
      : [];
    for (const channel of channels.slice(0, 4)) {
      if (messages.length >= max) break;
      const last = channel.lastMessage || {};
      const lastAt = isoOrEmpty(
        last.originalArrivalTime || last.originalarrivaltime || last.composeTime || last.composetime
      );
      if (since && lastAt && lastAt < since) continue;
      let rows = [];
      try {
        rows = await listChatMessages(session, channel.id, { limit: 12 });
      } catch {
        if (last && (last.content || last.id)) {
          rows = [
            normalizeMessage(last, {
              kind: "channel",
              textMax: DUMP_BODY_MAX,
              self,
            }),
          ];
        }
      }
      for (const row of rows) {
        if (since && row.at && row.at < since) continue;
        messages.push({
          ...row,
          team: teamName,
          channel: channel.displayName || channel.name,
          kind: "channel",
        });
        if (messages.length >= max) break;
      }
      await sleep(40);
    }
  }

  messages.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return {
    chats: chats.map((c) => ({
      id: c.id,
      name: c.name,
      chatType: c.chatType,
      updated: c.updated,
      preview: c.preview,
      members: clipMembers(c.members),
    })),
    messages: messages.slice(0, max),
  };
}

function looksLikeEmail(raw) {
  return /@/.test(String(raw || ""));
}

async function resolveChat(session, needle) {
  const n = String(needle || "").trim();
  if (!n) return { match: null, ambiguous: [], chats: [] };
  const chats = await listChats(session, { limit: 200 });
  const byId = chats.find((c) => c.id === n);
  if (byId) return { match: byId, ambiguous: [], chats };
  const picked = pickByName(chats, n);
  if (picked.match || picked.ambiguous.length) return { ...picked, chats };
  if (looksLikeEmail(n)) {
    const email = n.toLowerCase();
    const hits = chats.filter((c) =>
      (c.members || []).some((m) => String(m.email || "").toLowerCase() === email)
    );
    if (hits.length === 1) return { match: hits[0], ambiguous: [], chats };
    if (hits.length > 1) return { match: null, ambiguous: hits, chats };
  }
  return { match: null, ambiguous: [], chats };
}

async function resolveTeamChannel(session, teamNeedle, channelNeedle) {
  const teams = await listJoinedTeams(session, { limit: 50 });
  const team = pickByName(teams, teamNeedle);
  if (!team.match) {
    return {
      error: team.ambiguous.length ? "ambiguous team name" : "team not found",
      teams: (team.ambiguous.length ? team.ambiguous : teams).map((t) => t.name),
    };
  }
  const channels =
    team.match.channels && team.match.channels.length
      ? team.match.channels
      : await listChannels(session, team.match.id);
  const channel = pickByName(channels, channelNeedle);
  if (!channel.match) {
    return {
      error: channel.ambiguous.length ? "ambiguous channel name" : "channel not found",
      team: team.match.name,
      channels: (channel.ambiguous.length ? channel.ambiguous : channels).map(
        (c) => c.name
      ),
    };
  }
  return { team: team.match, channel: channel.match };
}

export async function sendTeamsMessage(opts = {}) {
  const session = opts.session || (await resolveSession(opts));
  const text = String(opts.text || "").trim();
  if (!text) return { ok: false, error: "send needs --text" };
  const chatNeedle = String(opts.chat || "").trim();
  const teamNeedle = String(opts.team || "").trim();
  const channelNeedle = String(opts.channel || "").trim();
  const originChat = chatNeedle || teamNeedle;
  const body = applyAgentSentFooter(text, { chat: originChat });
  if (!body) return { ok: false, error: "empty body" };

  if (teamNeedle && channelNeedle) {
    const resolved = await resolveTeamChannel(session, teamNeedle, channelNeedle);
    if (resolved.error) return { ok: false, ...resolved, account: SCHOOL_EMAIL };
    const data = await apiRequest(
      buildSendChatUrl(resolved.channel.id, { region: session.region }),
      session,
      { method: "POST", body: buildSendChatBody(body) }
    );
    return {
      ok: true,
      account: SCHOOL_EMAIL,
      kind: "channel",
      team: resolved.team.name,
      channel: resolved.channel.name,
      id: String(data?.id || "").trim(),
    };
  }

  if (!chatNeedle) {
    return { ok: false, error: "send needs --chat or --team and --channel" };
  }
  const resolved = await resolveChat(session, chatNeedle);
  if (!resolved.match) {
    return {
      ok: false,
      error: resolved.ambiguous.length ? "ambiguous chat name" : "chat not found",
      chats: (resolved.ambiguous.length ? resolved.ambiguous : resolved.chats)
        .slice(0, 12)
        .map((c) => c.name),
      account: SCHOOL_EMAIL,
    };
  }
  const data = await apiRequest(
    buildSendChatUrl(resolved.match.id, { region: session.region }),
    session,
    { method: "POST", body: buildSendChatBody(body) }
  );
  return {
    ok: true,
    account: SCHOOL_EMAIL,
    kind: "chat",
    chat: resolved.match.name,
    chatId: resolved.match.id,
    id: String(data?.id || "").trim(),
  };
}

async function withSession(parsed, root, fn) {
  let session;
  try {
    session = await resolveSession({
      root,
      headed: parsed.headed,
      force: parsed.force,
    });
  } catch (err) {
    return needsLoginPayload(err instanceof Error ? err.message : String(err));
  }
  try {
    return await fn(session);
  } catch (err) {
    const status = Number(err?.status || 0);
    if (status === 401 || status === 403) {
      return needsLoginPayload(err instanceof Error ? err.message : String(err));
    }
    return {
      ok: false,
      error: redactSecrets(err instanceof Error ? err.message : String(err)),
      account: SCHOOL_EMAIL,
    };
  }
}

export async function runSchoolTeams(argv, opts = {}) {
  const parsed = parseArgs(argv);
  const root = opts.root || schoolTeamsDir();
  const cmd = parsed.cmd;

  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    return {
      ok: true,
      usage:
        "node server/school-teams.js login|status|chats|teams|channels --team <name>|thread --chat <id|name>|thread --team T --channel C|search <q>|send --chat <name> --text <body>|send --team T --channel C --text <body>|dump [--since ISO]",
      account: SCHOOL_EMAIL,
    };
  }

  if (cmd === "status") {
    const session = await loadSession(root);
    const fresh = isTeamsSessionFresh(session);
    const aud = session?.token ? tokenAudience(session.token) : "";
    const wrong =
      session?.token && !isIc3Token(session.token) && !isCsaToken(session.token)
        ? { error: `wrong audience (${aud})` }
        : {};
    return {
      ok: true,
      signedIn: fresh,
      account: SCHOOL_EMAIL,
      email: session?.email || "",
      exp: session?.exp || 0,
      ...wrong,
    };
  }

  if (cmd === "login") {
    process.stderr.write(
      `Chrome opens Teams as ${SCHOOL_EMAIL}. Sign in if asked. The window closes once chat tokens are captured.\n`
    );
    try {
      const session = await captureToken({ headed: true, root });
      return {
        ok: true,
        signedIn: true,
        account: SCHOOL_EMAIL,
        email: session.email || jwtEmail(session.token),
      };
    } catch (err) {
      return needsLoginPayload(err instanceof Error ? err.message : String(err));
    }
  }

  if (cmd === "chats") {
    return withSession(parsed, root, async (session) => ({
      ok: true,
      account: SCHOOL_EMAIL,
      chats: (await listChats(session, { limit: parsed.limit })).slice(0, parsed.limit).map((c) => ({
        ...c,
        members: clipMembers(c.members),
      })),
    }));
  }

  if (cmd === "teams") {
    return withSession(parsed, root, async (session) => ({
      ok: true,
      account: SCHOOL_EMAIL,
      teams: await listJoinedTeams(session, { limit: parsed.limit }),
    }));
  }

  if (cmd === "channels") {
    if (!parsed.team) return { ok: false, error: "channels needs --team" };
    return withSession(parsed, root, async (session) => {
      const teams = await listJoinedTeams(session, { limit: 50 });
      const picked = pickByName(teams, parsed.team);
      if (!picked.match) {
        return {
          ok: false,
          error: picked.ambiguous.length ? "ambiguous team name" : "team not found",
          teams: (picked.ambiguous.length ? picked.ambiguous : teams).map((t) => t.name),
          account: SCHOOL_EMAIL,
        };
      }
      return {
        ok: true,
        account: SCHOOL_EMAIL,
        team: picked.match.name,
        channels: await listChannels(session, picked.match.id),
      };
    });
  }

  if (cmd === "thread") {
    if (parsed.team && parsed.channel) {
      return withSession(parsed, root, async (session) => {
        const resolved = await resolveTeamChannel(session, parsed.team, parsed.channel);
        if (resolved.error) return { ok: false, ...resolved, account: SCHOOL_EMAIL };
        const rows = await listChannelMessages(
          session,
          resolved.team.id,
          resolved.channel.id,
          { limit: parsed.limit }
        );
        return {
          ok: true,
          account: SCHOOL_EMAIL,
          team: resolved.team.name,
          channel: resolved.channel.name,
          messages: rows.map((row) => ({
            ...row,
            team: resolved.team.name,
            channel: resolved.channel.name,
            kind: "channel",
          })),
        };
      });
    }
    const chatNeedle = parsed.chat || parsed.id;
    if (!chatNeedle) return { ok: false, error: "thread needs --chat or --team and --channel" };
    return withSession(parsed, root, async (session) => {
      const resolved = await resolveChat(session, chatNeedle);
      if (!resolved.match) {
        return {
          ok: false,
          error: resolved.ambiguous.length ? "ambiguous chat name" : "chat not found",
          chats: (resolved.ambiguous.length ? resolved.ambiguous : resolved.chats)
            .slice(0, 12)
            .map((c) => c.name),
          account: SCHOOL_EMAIL,
        };
      }
      const rows = await listChatMessages(session, resolved.match.id, {
        limit: parsed.limit,
      });
      return {
        ok: true,
        account: SCHOOL_EMAIL,
        chat: resolved.match.name,
        chatId: resolved.match.id,
        messages: rows.map((row) => ({
          ...row,
          chat: resolved.match.name,
          chatId: resolved.match.id,
        })),
      };
    });
  }

  if (cmd === "search") {
    if (!parsed.query) return { ok: false, error: "search needs a query" };
    const needle = parsed.query.toLowerCase();
    return withSession(parsed, root, async (session) => {
      const recent = await fetchRecentChatMessages({
        session,
        chatLimit: 25,
        messageLimit: 20,
      });
      const hits = recent.filter((m) =>
        `${m.text} ${m.from} ${m.chat}`.toLowerCase().includes(needle)
      );
      return {
        ok: true,
        account: SCHOOL_EMAIL,
        query: parsed.query,
        messages: hits.slice(0, parsed.limit),
      };
    });
  }

  if (cmd === "send") {
    return withSession(parsed, root, async (session) =>
      sendTeamsMessage({
        session,
        chat: parsed.chat,
        team: parsed.team,
        channel: parsed.channel,
        text: parsed.text,
        root,
      })
    );
  }

  if (cmd === "dump") {
    return withSession(parsed, root, async (session) => {
      const since =
        parsed.since || new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
      const dump = await fetchSchoolTeams({
        session,
        since,
        max: DUMP_MAX,
      });
      return {
        ok: true,
        account: SCHOOL_EMAIL,
        since,
        count: dump.messages.length,
        chats: dump.chats.length,
        messages: dump.messages,
      };
    });
  }

  return { ok: false, error: `unknown command: ${cmd}` };
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  runSchoolTeams(process.argv.slice(2))
    .then((payload) => {
      console.log(JSON.stringify(payload, null, 2));
      if (!payload?.ok) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(redactSecrets(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    });
}
