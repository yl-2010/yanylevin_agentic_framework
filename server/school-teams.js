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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyAgentSentFooter,
  textHasAgentSentFooter,
} from "./imessage-mention.js";
import { markdownToTeamsHtml } from "./teams-format.js";
import { applyDumpClock, givenName } from "./local-clock.js";
import {
  GRAPH_BASE,
  SCHOOL_EMAIL,
  isSessionFresh,
  jwtEmail,
  jwtExp,
  jwtClaims,
  monthKeyFromIso,
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
/** Teams "Chat with yourself" / Notes. CSA omits this virtual conversation. */
export const TEAMS_SELF_CHAT_ID = "48:notes";
export const DUMP_BODY_MAX = 400;
export const DUMP_MAX = 150;
export const DUMP_PAGE_SIZE = 50;
export const FILL_BODY_MAX = 4000;
export const DUMP_CHAT_MAX = 20000;
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
    via: "",
    since: "",
    out: "",
    full: false,
    reaction: "",
    from: "",
  };
  while (args.length) {
    const a = args.shift();
    if (a === "--force") out.force = true;
    else if (a === "--headed") out.headed = true;
    else if (a === "--full") out.full = true;
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
    } else if (a === "--via") {
      out.via = String(args.shift() || "").trim();
    } else if (a === "--text") {
      const rest = [];
      while (args.length && !String(args[0]).startsWith("--")) rest.push(args.shift());
      out.text = rest.join(" ").trim();
    } else if (a === "--since") out.since = String(args.shift() || "").trim();
    else if (a === "--out") out.out = String(args.shift() || "").trim();
    else if (a === "--id") out.id = String(args.shift() || "").trim();
    else if (a === "--from") {
      const rest = [];
      while (args.length && !String(args[0]).startsWith("--")) rest.push(args.shift());
      out.from = rest.join(" ").trim();
    } else if (a === "--reaction") out.reaction = String(args.shift() || "").trim();
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

/** Graph bearer usable for chatMessage setReaction (delegated Teams messaging). */
export function hasGraphMessaging(token) {
  if (!isGraphAudience(token)) return false;
  const claims = jwtClaims(token);
  const blob = [claims.scp, claims.roles]
    .flatMap((v) => (Array.isArray(v) ? v : String(v || "").split(/\s+/)))
    .filter(Boolean)
    .join(" ");
  return /chat|channelmessage|chatmessage/i.test(blob);
}

export function normalizeReactionType(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s || s === "like" || s === "thumbsup" || s === "thumb" || s === "+1") return "👍";
  return String(raw || "").trim() || "👍";
}

export function buildSetReactionUrl(chatId, messageId) {
  const chat = encodeURIComponent(String(chatId || "").trim());
  const msg = encodeURIComponent(String(messageId || "").trim());
  return `${GRAPH_BASE}/chats/${chat}/messages/${msg}/setReaction`;
}

/** chatsvc emotion key. Teams web sends this, not Graph setReaction. */
export function emotionKeyFor(reactionType) {
  const s = String(reactionType || "").trim().toLowerCase();
  if (!s || s === "👍" || s === "like" || s === "thumbsup" || s === "thumb" || s === "+1") {
    return "like";
  }
  if (s === "❤️" || s === "heart") return "heart";
  if (s === "😆" || s === "laugh") return "laugh";
  if (s === "😮" || s === "surprised") return "surprised";
  if (s === "😢" || s === "sad") return "sad";
  if (s === "😠" || s === "angry") return "angry";
  return s;
}

export function buildEmotionUrl(chatId, messageId, { region = "amer" } = {}) {
  const chat = encodeURIComponent(String(chatId || "").trim());
  const msg = encodeURIComponent(String(messageId || "").trim());
  const r = encodeURIComponent(String(region || "amer").trim() || "amer");
  return `${TEAMS_CLOUD}/api/chatsvc/${r}/v1/users/ME/conversations/${chat}/messages/${msg}/properties?name=emotions`;
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

/**
 * CSA marks Chat-tab 1:1s and Chat-tab group chats as hidden (they live
 * on the Chat tab, not the Teams tab). Keep those. Drop deleted threads
 * only. Do not treat `hidden` as user-muted: that flag is how CSA
 * hides Chat-tab groups, and dropping it makes @agent miss them.
 */
export function includeCsaChat(row) {
  if (!row) return false;
  return row.isConversationDeleted !== true;
}

export function isTeamsSelfChat(row) {
  const id = String(row?.id || "")
    .trim()
    .toLowerCase();
  const chatId = String(row?.chatId || "")
    .trim()
    .toLowerCase();
  if (id === TEAMS_SELF_CHAT_ID || chatId === TEAMS_SELF_CHAT_ID) return true;
  const t = String(
    row?.threadType || row?.threadProperties?.threadType || row?.chatType || ""
  )
    .trim()
    .toLowerCase();
  return t === "streamofnotes";
}

export function isTeamsSelfChatNeedle(needle, selfChat = null, selfEmail = SCHOOL_EMAIL) {
  const n = String(needle || "").trim().toLowerCase();
  if (!n) return false;
  if (n === TEAMS_SELF_CHAT_ID) return true;
  if (n === "me" || n === "myself" || n === "self") return true;
  if (n === "chat with myself" || n === "chat with me") return true;
  const email = String(selfEmail || SCHOOL_EMAIL).trim().toLowerCase();
  if (email && n === email) return true;
  const members = Array.isArray(selfChat?.members) ? selfChat.members : [];
  for (const m of members) {
    const name = String(m?.name || "").trim().toLowerCase();
    if (name && n === name) return true;
    const given = givenName(m?.name).toLowerCase();
    if (given && n === given) return true;
    const memEmail = String(m?.email || "").trim().toLowerCase();
    if (memEmail && n === memEmail) return true;
  }
  return false;
}

export function teamsSelfChatStub(self = {}) {
  const email = String(self.email || SCHOOL_EMAIL).trim() || SCHOOL_EMAIL;
  const objectId = String(self.objectId || "").trim();
  const name = String(self.name || "").trim() || "Me";
  return {
    id: TEAMS_SELF_CHAT_ID,
    name: "Me",
    chatType: "oneOnOne",
    updated: String(self.updated || "").trim(),
    preview: String(self.preview || "").trim(),
    members: [{ name, email, objectId }].filter((m) => m.name || m.email || m.objectId),
  };
}

/**
 * CSA never lists 48:notes. Pin it so @agent and --chat myself keep working.
 * Call after the recent-chat slice so an old Notes thread is not dropped.
 */
export function ensureSelfChat(chats, self = {}) {
  const list = Array.isArray(chats) ? [...chats] : [];
  const stub = teamsSelfChatStub(self);
  const idx = list.findIndex((c) => isTeamsSelfChat(c));
  if (idx < 0) return [stub, ...list];
  const existing = list[idx];
  list[idx] = {
    ...existing,
    id: existing.id || TEAMS_SELF_CHAT_ID,
    name:
      existing.name && existing.name !== "(chat)" && existing.name !== stub.name
        ? existing.name
        : "Me",
    chatType: "oneOnOne",
    members: existing.members?.length ? existing.members : stub.members,
  };
  return list;
}

function memberMatchesNeedle(member, needle, selfEmail = SCHOOL_EMAIL) {
  const q = String(needle || "").trim().toLowerCase();
  if (!q) return false;
  const email = String(member?.email || "").trim().toLowerCase();
  if (email && email === String(selfEmail || "").trim().toLowerCase()) return false;
  const name = String(member?.name || "").trim().toLowerCase();
  return (name && (name === q || name.includes(q))) || email === q;
}

export function pickChat(chats, needle, selfEmail = SCHOOL_EMAIL) {
  const n = String(needle || "").trim();
  const list = Array.isArray(chats) ? chats : [];
  if (!n) return { match: null, ambiguous: [], chats: list };
  const byId = list.find((c) => c.id === n);
  if (byId) return { match: byId, ambiguous: [], chats: list };
  const selfChat = list.find((c) => isTeamsSelfChat(c));
  if (selfChat && isTeamsSelfChatNeedle(n, selfChat, selfEmail)) {
    return { match: selfChat, ambiguous: [], chats: list };
  }
  const namePicked = pickByName(list, n);
  const hits = [];
  const seen = new Set();
  const add = (c) => {
    const id = c?.id || "";
    if (!c || (id && seen.has(id))) return;
    if (id) seen.add(id);
    hits.push(c);
  };
  if (namePicked.match) add(namePicked.match);
  for (const c of namePicked.ambiguous) add(c);
  for (const c of list) {
    if (c?.id && seen.has(c.id)) continue;
    if ((c.members || []).some((m) => memberMatchesNeedle(m, n, selfEmail))) add(c);
  }
  if (hits.length === 1) return { match: hits[0], ambiguous: [], chats: list };
  if (hits.length > 1) {
    const ones = hits.filter((c) => c.chatType === "oneOnOne");
    if (ones.length === 1) return { match: ones[0], ambiguous: [], chats: list };
    return { match: null, ambiguous: ones.length ? ones : hits, chats: list };
  }
  return { match: null, ambiguous: [], chats: list };
}

/**
 * Teams quote-replies wrap the parent in a Skype Reply blockquote. stripHtml
 * would keep that parent's @agent, so a reply with no mention would still
 * start a session. Drop the quote before converting to text.
 */
export function stripTeamsReplyQuoteHtml(html) {
  let s = String(html || "");
  s = s.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, " ");
  s = s.replace(
    /<([a-zA-Z][\w:-]*)\b[^>]*itemtype\s*=\s*["'][^"']*schema\.skype\.com\/Reply["'][^>]*>[\s\S]*?<\/\1>/gi,
    " "
  );
  return s;
}

export function messageText(raw, max = MESSAGE_TEXT_MAX) {
  const body = raw?.body || {};
  const content = String(body.content || raw?.content || "");
  const unquoted = stripTeamsReplyQuoteHtml(content);
  const type = String(body.contentType || raw?.contenttype || "").toLowerCase();
  if (type === "text" && !/<[a-z][\s\S]*>/i.test(unquoted)) {
    return unquoted.trim().slice(0, max);
  }
  return stripHtml(unquoted, max);
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
  if (isTeamsSelfChat(raw)) return "Me";
  const topic = String(raw?.title || raw?.topic || raw?.name || "").trim();
  if (topic && topic !== "(chat)") return topic;
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
  if (isTeamsSelfChat(raw)) return "oneOnOne";
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

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i;

/** Pictures and files the text CLI drops. images is a count. files are names. */
export function teamsMedia(raw) {
  const html = stripTeamsReplyQuoteHtml(String(raw?.body?.content || raw?.content || ""));
  const imgTags = (html.match(/<img\b/gi) || []).length;
  const cards = (html.match(/schema\.skype\.com\/[A-Za-z]*Image/gi) || []).length;
  const attachments = Array.isArray(raw?.attachments) ? raw.attachments : [];
  let imageAttachments = 0;
  const files = [];
  for (const item of attachments) {
    const name = String(item?.name || item?.content?.name || item?.fileName || "").trim();
    const type = String(item?.contentType || item?.contenttype || "").toLowerCase();
    if (type.includes("image") || IMAGE_FILE.test(name)) {
      imageAttachments += 1;
      continue;
    }
    if (name) files.push(name);
  }
  return {
    images: Math.max(imgTags, cards, imageAttachments),
    files,
  };
}

export function normalizeMessage(raw, extra = {}) {
  const fromUser = raw?.from?.user || {};
  const rawContent = String(raw?.body?.content || raw?.content || "");
  const text = messageText(raw, extra.textMax || DUMP_BODY_MAX);
  const media = teamsMedia(raw);
  const fromAgent =
    textHasAgentSentFooter(rawContent) || textHasAgentSentFooter(text);
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
  const row = applyDumpClock({
    id: String(raw?.id || "").trim(),
    at: isoOrEmpty(at) || at,
    from: fromName,
    fromEmail: String(fromUser.userPrincipalName || fromUser.email || extra.fromEmail || "").trim(),
    fromMe: fromMeOf(raw, extra.self || extra),
    fromAgent,
    text,
    messageType: normalizeMessageType(raw),
    chatId: extra.chatId || "",
    chat: extra.chat || "",
    chatType: extra.chatType || "",
    team: extra.team || "",
    channel: extra.channel || "",
    kind: extra.kind || "chat",
  });
  if (media.images) row.images = media.images;
  if (media.files.length) row.files = media.files;
  return row;
}

export function defaultDumpDir() {
  return join(tmpdir(), "yanylevin-school-teams-export");
}

export function extractBackwardLink(data) {
  const raw = String(data?._metadata?.backwardLink || "").trim();
  if (!raw) return "";
  const url = raw.startsWith("/") ? `${TEAMS_CLOUD}${raw}` : raw;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return "";
    const host = u.hostname.toLowerCase();
    const allowed =
      host === "teams.cloud.microsoft" ||
      host === "teams.microsoft.com" ||
      host.endsWith(".teams.microsoft.com");
    if (!allowed) return "";
    if (!u.pathname.includes("/api/chatsvc/") || !u.pathname.includes("/messages")) {
      return "";
    }
    return u.toString();
  } catch {
    return "";
  }
}

export function shouldSkipTeamsDumpMessage(msg, raw = {}) {
  const type = String(msg?.messageType || raw?.messagetype || raw?.type || "");
  if (/^(control|event|threadactivity)\b/i.test(type)) return true;
  if (/^(Control|Event|ThreadActivity)\//.test(type)) return true;
  if (Number(msg?.images) > 0) return false;
  if (Array.isArray(msg?.files) && msg.files.length) return false;
  return !String(msg?.text || "").trim();
}

export function formatDumpMessage(msg) {
  applyDumpClock(msg);
  const from = msg.fromEmail ? `${msg.from} <${msg.fromEmail}>` : String(msg.from || "");
  const where =
    msg.kind === "channel"
      ? `team=${msg.team || ""} | channel=${msg.channel || ""}`
      : `chat=${msg.chat || ""} | type=${msg.chatType || "chat"}`;
  const body = String(msg.text || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, FILL_BODY_MAX);
  const speaker = msg.speaker || (msg.fromMe ? "Yan" : givenName(msg.from) || "them");
  const local = msg.atLocal ? ` | atLocal=${msg.atLocal}` : "";
  const agent = msg.fromAgent ? " | fromAgent=true" : "";
  const images = Number(msg.images) > 0 ? ` | images=${Number(msg.images)}` : "";
  const fileNames = Array.isArray(msg.files) ? msg.files.filter(Boolean) : [];
  const files = fileNames.length ? ` | files=${fileNames.join(", ")}` : "";
  return [
    `${msg.at} | kind=${msg.kind || "chat"} | ${where} | speaker=${speaker} | from=${from} | fromMe=${msg.fromMe ? "true" : "false"}${agent}${local}${images}${files}`,
    body,
    "",
  ].join("\n");
}

export function groupMessagesByMonth(messages) {
  /** @type {Map<string, object[]>} */
  const map = new Map();
  for (const msg of messages || []) {
    const key = monthKeyFromIso(msg.at);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(msg);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
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
    content: markdownToTeamsHtml(text),
    messagetype: "RichText/Html",
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
      if (found.mt && found.graph) {
        finish();
        return;
      }
      if (!grace) {
        grace = setTimeout(finish, Math.max(MT_GRACE_MS, 10_000));
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
      if (hasGraphMessaging(token)) {
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
    try {
      await page.goto("https://teams.microsoft.com/v2/#/teams", {
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

export const CAPTURE_COOLDOWN_MS = 5 * 60_000;
/** @type {number} */
let captureFailAt = 0;

export function isTeamsAuthError(err) {
  const status = Number(err?.status || 0);
  if (status === 401 || status === 403) return true;
  const msg = err instanceof Error ? err.message : String(err || "");
  return /no saved school Teams session|not signed in|timed out waiting|User is not authorized|Teams API 401|Teams API 403/i.test(
    msg
  );
}

async function resolveSession(opts) {
  const root = opts.root || schoolTeamsDir();
  const session = await loadSession(root);
  if (isTeamsSessionFresh(session) && !opts.force && !opts.refresh) {
    return { ...session, root };
  }
  if (!session) {
    throw new Error("no saved school Teams session");
  }
  if (
    opts.allowStale &&
    !opts.force &&
    !opts.refresh &&
    session.token &&
    session.csaToken
  ) {
    return { ...session, root };
  }
  if (!opts.force && captureFailAt && Date.now() - captureFailAt < CAPTURE_COOLDOWN_MS) {
    throw new Error("timed out waiting for Teams chat tokens");
  }
  try {
    const next = await captureToken({
      headed: Boolean(opts.headed),
      root,
    });
    captureFailAt = 0;
    return { ...next, root };
  } catch (err) {
    captureFailAt = Date.now();
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.refresh || opts.force) throw new Error(msg);
    if (session.token && session.csaToken) {
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
    const unnamed = !named || named === "(chat)";
    const others = (chat.members || []).filter((m) => {
      if (!m.objectId || m.objectId === selfId || cache[m.objectId]) return false;
      if (chat.chatType === "oneOnOne") return !m.name || !m.email;
      return unnamed && !m.name && !m.email;
    });
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
      name: chat.name && chat.name !== "(chat)" ? chat.name : "",
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
    .filter((row) => includeCsaChat(row))
    .map((row) =>
      normalizeChat({ ...row, selfObjectId: session.objectId }, session.email || SCHOOL_EMAIL)
    )
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const cap = Math.min(mapped.length, Math.max(1, Number(limit) || 50));
  const claims = jwtClaims(session.token || "");
  const pinned = ensureSelfChat(mapped.slice(0, cap), {
    email: session.email || SCHOOL_EMAIL,
    objectId: session.objectId,
    name: String(claims.name || claims.given_name || "").trim(),
  });
  const enriched = await enrichChats(session, pinned);
  return enriched.sort((a, b) => {
    if (isTeamsSelfChat(a) !== isTeamsSelfChat(b)) return isTeamsSelfChat(a) ? -1 : 1;
    return String(b.updated).localeCompare(String(a.updated));
  });
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

/**
 * Newest-first pages until `since` or no backwardLink. Entire-history fill uses this.
 * @param {object} session
 * @param {string} chatId
 * @param {{ since?: string, max?: number, textMax?: number, extra?: object }} [opts]
 */
export async function listChatMessagesPaged(session, chatId, opts = {}) {
  const since = isoOrEmpty(opts.since);
  const max = Number(opts.max) || DUMP_CHAT_MAX;
  const textMax = Number(opts.textMax) || FILL_BODY_MAX;
  const extra = opts.extra && typeof opts.extra === "object" ? opts.extra : {};
  const self = { objectId: session.objectId, email: session.email || SCHOOL_EMAIL };
  /** @type {object[]} */
  const out = [];
  const seen = new Set();
  let url = buildChatMessagesUrl(chatId, { limit: DUMP_PAGE_SIZE, region: session.region });
  for (let page = 0; page < 500 && url && out.length < max; page++) {
    const data = await apiRequest(url, session);
    const rows = Array.isArray(data.messages)
      ? data.messages
      : Array.isArray(data.value)
        ? data.value
        : [];
    if (!rows.length) break;
    let olderThanSince = false;
    let newIds = 0;
    for (const row of rows) {
      const msg = normalizeMessage(row, { ...extra, chatId, textMax, self });
      if (since && msg.at && msg.at < since) {
        olderThanSince = true;
        continue;
      }
      if (!msg.id || seen.has(msg.id)) continue;
      seen.add(msg.id);
      newIds += 1;
      if (shouldSkipTeamsDumpMessage(msg, row)) continue;
      out.push(msg);
      if (out.length >= max) break;
    }
    if (page === 0 || (page + 1) % 10 === 0) {
      process.stderr.write(
        `[school-teams]   page ${page + 1} +${out.length} msgs ${extra.chat || extra.channel || chatId}\n`
      );
    }
    if (olderThanSince || out.length >= max || newIds === 0) break;
    const next = extractBackwardLink(data);
    if (!next || next === url) break;
    url = next;
    await sleep(60);
  }
  return out;
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
 * @param {{
 *   since?: string,
 *   chatLimit?: number,
 *   messageLimit?: number,
 *   root?: string,
 *   headed?: boolean,
 *   force?: boolean,
 *   allowStale?: boolean,
 *   session?: object,
 *   resolveSession?: typeof resolveSession,
 *   listRecent?: typeof listRecentChatMessages,
 * }} [opts]
 */
export async function fetchRecentChatMessages(opts = {}) {
  const resolve = opts.resolveSession || resolveSession;
  const list = opts.listRecent || listRecentChatMessages;
  if (opts.session) return list(opts.session, opts);
  const session = await resolve({
    ...opts,
    allowStale: opts.allowStale === true,
  });
  try {
    return await list(session, opts);
  } catch (err) {
    if (!isTeamsAuthError(err)) throw err;
    const next = await resolve({
      ...opts,
      allowStale: false,
      refresh: true,
    });
    return await list(next, opts);
  }
}

async function listRecentChatMessages(session, opts = {}) {
  const since = isoOrEmpty(opts.since);
  const chats = await listChats(session, { limit: opts.chatLimit || 40 });
  /** @type {object[]} */
  const out = [];
  for (const chat of chats) {
    if (since && chat.updated && chat.updated < since && !isTeamsSelfChat(chat)) continue;
    let rows = [];
    try {
      rows = await listChatMessages(session, chat.id, {
        limit: opts.messageLimit || 20,
      });
    } catch (err) {
      if (isTeamsSelfChat(chat)) continue;
      throw err;
    }
    const selfChat = isTeamsSelfChat(chat);
    for (const row of rows) {
      out.push({
        ...row,
        fromMe: selfChat ? true : row.fromMe,
        chatId: chat.id,
        chat: chat.name,
        chatType: chat.chatType || row.chatType || "",
        members: (Array.isArray(chat.members) ? chat.members : [])
          .map((m) => ({
            name: String(m?.name || "").trim(),
            email: String(m?.email || "").trim(),
          }))
          .filter((m) => m.name || m.email)
          .slice(0, 12),
        kind: "chat",
      });
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

/**
 * Recent messages in one chat or channel, for the realtime calendar agent.
 * @param {string} chatId
 * @param {{ limit?: number, session?: object, resolveSession?: typeof resolveSession, listChatMessages?: typeof listChatMessages, allowStale?: boolean }} [opts]
 */
export async function fetchChatWindow(chatId, opts = {}) {
  const id = String(chatId || "").trim();
  if (!id) return [];
  const resolve = opts.resolveSession || resolveSession;
  const session =
    opts.session ||
    (await resolve({
      ...opts,
      allowStale: opts.allowStale !== false,
    }));
  const list = opts.listChatMessages || listChatMessages;
  return list(session, id, { limit: opts.limit || 40 });
}

/**
 * Channel posts updated since `since`. Chats stay on the mention poller.
 * @param {{ since?: string, max?: number, session?: object, resolveSession?: typeof resolveSession, listJoinedTeams?: typeof listJoinedTeams, listChatMessages?: typeof listChatMessages, allowStale?: boolean }} [opts]
 */
export async function fetchRecentChannelMessages(opts = {}) {
  const resolve = opts.resolveSession || resolveSession;
  const session =
    opts.session ||
    (await resolve({
      ...opts,
      allowStale: opts.allowStale !== false,
    }));
  const since = isoOrEmpty(opts.since);
  const max = Number(opts.max) || 40;
  const listTeams = opts.listJoinedTeams || listJoinedTeams;
  let teams = [];
  try {
    teams = await listTeams(session, { limit: 30 });
  } catch (err) {
    if (isTeamsAuthError(err)) throw err;
    teams = [];
  }
  const snapTeams = (session._csa && session._csa.teams) || teams;
  /** @type {object[]} */
  const messages = [];
  const listMessages = opts.listChatMessages || listChatMessages;
  const self = { objectId: session.objectId, email: session.email || SCHOOL_EMAIL };
  for (const team of snapTeams.slice(0, 8)) {
    if (messages.length >= max) break;
    const teamName = team.displayName || team.name;
    const channels = Array.isArray(team.channels)
      ? team.channels.map((c) => (c.id && c.name ? c : normalizeChannel(c)))
      : [];
    for (const channel of channels.slice(0, 4)) {
      if (messages.length >= max) break;
      const last = channel.lastMessage || {};
      const lastAt = isoOrEmpty(
        last.originalArrivalTime ||
          last.originalarrivaltime ||
          last.composeTime ||
          last.composetime
      );
      if (since && lastAt && lastAt < since) continue;
      let rows = [];
      try {
        rows = await listMessages(session, channel.id, { limit: 12 });
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
          chatId: row.chatId || channel.id,
          kind: "channel",
        });
        if (messages.length >= max) break;
      }
      await sleep(40);
    }
  }
  messages.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return messages;
}

/**
 * Full-history dump for the Composer fill. Monthly files under /tmp.
 * @param {{ since?: string, outDir?: string, root?: string, headed?: boolean, force?: boolean, session?: object }} [opts]
 */
export async function dumpSchoolTeams(opts = {}) {
  const session = opts.session || (await resolveSession(opts));
  const since = isoOrEmpty(opts.since);
  const outDir = String(opts.outDir || "").trim() || defaultDumpDir();
  const chats = await listChats(session, { limit: 500 });
  /** @type {object[]} */
  const messages = [];
  const seen = new Set();
  const add = (row) => {
    const key = `${row.kind || "chat"}:${row.chatId || ""}:${row.id}`;
    if (!row?.id || seen.has(key)) return;
    seen.add(key);
    messages.push(row);
  };

  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];
    process.stderr.write(`[school-teams] dump chat ${i + 1}/${chats.length} ${chat.name}\n`);
    try {
      const rows = await listChatMessagesPaged(session, chat.id, {
        since,
        extra: {
          chatId: chat.id,
          chat: chat.name,
          chatType: chat.chatType,
          kind: "chat",
        },
      });
      for (const row of rows) add({ ...row, chatType: chat.chatType });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[school-teams] skip chat ${chat.name}: ${redactSecrets(detail)}\n`);
    }
    await sleep(40);
  }

  let teams = [];
  try {
    const snap = await csaSnapshot(session);
    teams = Array.isArray(snap.teams) ? snap.teams : [];
  } catch {
    teams = [];
  }
  for (const team of teams) {
    const teamName = String(team.displayName || team.name || "").trim();
    const channels = Array.isArray(team.channels)
      ? team.channels.map((c) => (c.id && (c.name || c.displayName) ? c : normalizeChannel(c)))
      : [];
    for (const channel of channels) {
      const channelName = String(channel.displayName || channel.name || "").trim();
      if (!channel.id) continue;
      process.stderr.write(`[school-teams] dump channel ${teamName} / ${channelName}\n`);
      try {
        const rows = await listChatMessagesPaged(session, channel.id, {
          since,
          extra: {
            kind: "channel",
            team: teamName,
            channel: channelName,
            chatId: channel.id,
          },
        });
        for (const row of rows) add(row);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[school-teams] skip channel ${teamName}/${channelName}: ${redactSecrets(detail)}\n`
        );
      }
      await sleep(40);
    }
  }

  messages.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const months = groupMessagesByMonth(messages);
  /** @type {{ month: string, file: string, count: number, bytes: number }[]} */
  const files = [];
  for (const [month, rows] of months) {
    const file = `${month}.txt`;
    const body = rows.map((m) => formatDumpMessage(m)).join("\n");
    await writeFile(join(outDir, file), body, { mode: 0o600 });
    files.push({ month, file, count: rows.length, bytes: Buffer.byteLength(body) });
  }
  const manifest = {
    ok: true,
    account: SCHOOL_EMAIL,
    since,
    at: new Date().toISOString(),
    messages: messages.length,
    chats: chats.length,
    files,
  };
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return { ...manifest, outDir };
}

async function resolveChat(session, needle) {
  const n = String(needle || "").trim();
  if (!n) return { match: null, ambiguous: [], chats: [] };
  const chats = await listChats(session, { limit: 200 });
  return pickChat(chats, n, session.email || SCHOOL_EMAIL);
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

export async function reactTeamsMessage(opts = {}) {
  const session = opts.session || (await resolveSession(opts));
  const chatNeedle = String(opts.chat || "").trim();
  const messageId = String(opts.id || "").trim();
  const fromNeedle = String(opts.from || "").trim().toLowerCase();
  const reactionType = normalizeReactionType(opts.reaction || "like");
  const graphToken = String(session.graphToken || "").trim();
  if (!chatNeedle) return { ok: false, error: "react needs --chat", account: SCHOOL_EMAIL };
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
  let targetId = messageId;
  if (!targetId && fromNeedle) {
    const rows = await listChatMessages(session, resolved.match.id, { limit: 50 });
    const hit = rows.find((row) => {
      if (row.fromMe) return false;
      const from = String(row.from || "").toLowerCase();
      const speaker = givenName(row.from).toLowerCase();
      return from.includes(fromNeedle) || speaker.includes(fromNeedle) || fromNeedle.includes(speaker);
    });
    if (!hit) {
      return {
        ok: false,
        error: `no recent message from ${opts.from}`,
        account: SCHOOL_EMAIL,
        chat: resolved.match.name,
      };
    }
    targetId = hit.id;
  }
  if (!targetId) {
    return {
      ok: false,
      error: "react needs --id or --from <speaker>",
      account: SCHOOL_EMAIL,
    };
  }
  const emotion = emotionKeyFor(reactionType);
  try {
    await apiRequest(
      buildEmotionUrl(resolved.match.id, targetId, { region: session.region }),
      session,
      {
        method: "PUT",
        body: { emotions: JSON.stringify({ key: emotion, value: Date.now() }) },
        extra: { "x-ms-client-caller": "updateMessageReactionAdd" },
      }
    );
  } catch (err) {
    if (!graphToken) throw err;
    await apiRequest(
      buildSetReactionUrl(resolved.match.id, targetId),
      session,
      { method: "POST", body: { reactionType }, token: graphToken }
    );
  }
  return {
    ok: true,
    account: SCHOOL_EMAIL,
    chat: resolved.match.name,
    chatId: resolved.match.id,
    messageId: targetId,
    reactionType,
    emotion,
  };
}

export async function sendTeamsMessage(opts = {}) {
  const session = opts.session || (await resolveSession(opts));
  const text = String(opts.text || "").trim();
  if (!text) return { ok: false, error: "send needs --text" };
  const chatNeedle = String(opts.chat || "").trim();
  const teamNeedle = String(opts.team || "").trim();
  const channelNeedle = String(opts.channel || "").trim();
  const originChat = chatNeedle || teamNeedle;
  const body = applyAgentSentFooter(text, {
    chat: originChat,
    platform: "teams",
  });
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
        "node server/school-teams.js login|status|chats|teams|channels --team <name>|thread --chat <id|name>|thread --team T --channel C|search <q>|send --chat <name> --text <body>|send --team T --channel C --text <body>|react --chat <name> --from <speaker>|react --chat <name> --id <messageId> [--reaction like]|dump [--since ISO]|dump --full [--since ISO] [--out dir]",
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
    return withSession(parsed, root, async (session) => {
      return sendTeamsMessage({
        session,
        chat: parsed.chat,
        team: parsed.team,
        channel: parsed.channel,
        text: parsed.text,
        root,
      });
    });
  }

  if (cmd === "react") {
    return withSession(parsed, root, async (session) => {
      return reactTeamsMessage({
        session,
        chat: parsed.chat,
        id: parsed.id,
        from: parsed.from,
        reaction: parsed.reaction || "like",
        root,
      });
    });
  }

  if (cmd === "dump") {
    return withSession(parsed, root, async (session) => {
      if (parsed.full) {
        const result = await dumpSchoolTeams({
          session,
          since: parsed.since,
          outDir: parsed.out,
          root,
        });
        return {
          ok: true,
          account: SCHOOL_EMAIL,
          since: result.since,
          messages: result.messages,
          chats: result.chats,
          files: result.files,
          outDir: result.outDir,
        };
      }
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
