/**
 * Detect Yan fromMe iMessages that mention @agent / @Agent.
 * Poller and Personal Agent share these helpers.
 */

export const AGENT_SENT_FOOTER = "Sent by Yan's Personal Agent";
const FOOTER_ESC = AGENT_SENT_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FOOTER_RE = new RegExp(FOOTER_ESC, "i");
const TRAILING_FOOTER_RE = new RegExp(
  `(?:\\r?\\n[ \\t]*)+${FOOTER_ESC}[ \\t]*$`,
  "i"
);
/** Word token, any casing. Avoids emails like foo@agent.com. */
export const AGENT_MENTION_RE = /(^|[^\w@])@agent\b/i;

/**
 * @param {unknown} raw
 */
export function messageMentionsAgent(raw) {
  return AGENT_MENTION_RE.test(String(raw || ""));
}

/**
 * True when the body is only the mention (optional surrounding punctuation).
 * "@agent ping" is not bare. "@agent" / "@Agent." are.
 * @param {unknown} raw
 */
export function isBareAgentMention(raw) {
  const text = String(raw || "").trim();
  if (!text || !messageMentionsAgent(text)) return false;
  const rest = text
    .replace(AGENT_MENTION_RE, " ")
    .replace(/[\s.,!?;:'"“”]+/g, " ")
    .trim();
  return rest === "";
}

/**
 * @param {unknown} raw
 */
function clip(raw, max = 200) {
  return String(raw || "").trim().slice(0, max);
}

/**
 * @param {object|null|undefined} message
 */
export function messageKey(message) {
  const guid = clip(message?.guid, 80);
  if (guid) return `guid:${guid}`;
  const id = message?.id;
  if (id != null && String(id).trim()) return `id:${String(id).trim()}`;
  return "";
}

/**
 * @param {object|null|undefined} message
 */
export function shouldTriggerIMessageAgent(message) {
  if (!message || typeof message !== "object") return false;
  if (message.fromMe !== true) return false;
  if (message.tapback) return false;
  const associated = Number(message.associatedType) || 0;
  if (associated >= 2000 && associated <= 3007) return false;
  const text = String(message.text || "").trim();
  if (!text) return false;
  if (FOOTER_RE.test(text)) return false;
  return messageMentionsAgent(text);
}

/**
 * Best `to` for sendIMessage: named group, then 1:1 handle, then chat id.
 * @param {object|null|undefined} message
 */
export function replyTargetForMessage(message) {
  const chat = clip(message?.chat, 80);
  const chatId = clip(message?.chatId, 80);
  const handle = clip(message?.handle, 80);
  const looksLikeHandle =
    handle.startsWith("+") || handle.includes("@") || /^\d{10,}$/.test(handle);
  const namedGroup =
    chat &&
    chat !== chatId &&
    !chat.startsWith("+") &&
    !chat.includes("@");
  if (namedGroup) return chat;
  if (looksLikeHandle) return handle;
  if (handle) return handle;
  if (chatId) return chatId;
  return chat;
}

/**
 * @param {object|null|undefined} message
 */
export function normalizeIMessageOrigin(message) {
  if (!message || typeof message !== "object") return null;
  const chat = clip(message.chat, 80);
  const chatId = clip(message.chatId, 80);
  const handle = clip(message.handle, 80);
  const to = replyTargetForMessage(message);
  if (!to && !chatId) return null;
  /** @type {Record<string, string>} */
  const out = {
    to: to || chatId || chat,
    chat,
    chatId,
    handle,
    key: messageKey(message),
    text: String(message.text || "").trim().slice(0, 10_000),
  };
  const guid = clip(message.guid, 80);
  if (guid) out.messageGuid = guid;
  const chatGuid = clip(message.chatGuid, 120);
  if (chatGuid) out.chatGuid = chatGuid;
  return out;
}

/**
 * Skip the agent footer on texts to Rajasi, Michael, or the parents-only thread.
 * @param {object|null|undefined} origin
 */
export function shouldOmitAgentFooter(origin) {
  const chat = String(origin?.chat || "").trim();
  const blob = [chat, origin?.chatId, origin?.handle]
    .map((s) => String(s || "").trim())
    .join("\n");
  return false;
}

/**
 * Drop a trailing agent attribution. App/website bubbles never keep it.
 * @param {unknown} text
 */
export function stripAgentSentFooter(text) {
  const body = String(text ?? "");
  if (!body) return body;
  const trimmed = body.trim();
  if (FOOTER_RE.test(trimmed) && trimmed.replace(FOOTER_RE, "").trim() === "") {
    return "";
  }
  if (!TRAILING_FOOTER_RE.test(body)) return body;
  return body.replace(TRAILING_FOOTER_RE, "").replace(/[ \t]+$/gm, "");
}

/**
 * @param {string} text
 * @param {object|null|undefined} origin
 */
export function applyAgentSentFooter(text, origin) {
  const body = stripAgentSentFooter(text).trim();
  if (!body) return "";
  if (shouldOmitAgentFooter(origin)) return body;
  return `${body}\n\n${AGENT_SENT_FOOTER}`;
}

/**
 * Live-context block for a session started from an iMessage @agent mention.
 * @param {object|null|undefined} origin
 * @param {{ deliverFinal?: boolean }} [opts]
 */
export function formatIMessageOriginBlock(origin, opts = {}) {
  if (!origin || typeof origin !== "object") return "";
  const chat = String(origin.chat || origin.chatId || origin.to || "").trim();
  const chatId = String(origin.chatId || "").trim();
  const handle = String(origin.handle || "").trim();
  const to = String(origin.to || chatId || handle || chat).trim();
  const threadQ = encodeURIComponent(chatId || handle || chat || to);
  const bare = isBareAgentMention(origin.text);
  const threadLimit = bare ? 80 : 40;
  const lines = [
    "Called from iMessage. This Personal Agent chat is otherwise normal (app and website bubbles, send_chat_message, tools).",
    `- iMessage chat: ${chat || "?"}${chatId && chatId !== chat ? ` (${chatId})` : ""}`,
  ];
  if (handle) lines.push(`- handle: ${handle}`);
  if (to) lines.push(`- send replies to: ${to}`);
  if (bare) {
    lines.push(
      "The user message is only @agent. That is not the task. Read the surrounding iMessage thread first, then infer why they called you and what to do from the recent messages (a question someone asked, a plan, a thing they want handled). Do not reply asking what they want unless the thread is empty or you truly cannot tell."
    );
  }
  lines.push(
    `Read the surrounding thread before answering: curl -sS --unix-socket /tmp/personal-agent-local.sock "http://localhost/imessage/thread?person=${threadQ}&limit=${threadLimit}" (iMessage skill).`,
    "Write the final bubble as the text that should land in that iMessage (plain text, no markdown, no @agent). Do not add Sent by Yan's Personal Agent. The server appends that footer on the iMessage only, never in the app or website thread. Intermediate send_chat_message bubbles stay in the Personal Agent app only."
  );
  if (opts.deliverFinal !== false) {
    lines.push(
      "The server delivers your final bubble to that same iMessage chat. Do not also sendIMessage that same final text."
    );
  } else {
    lines.push(
      "This chat started from that iMessage thread. Later app turns do not auto-text it; send via the iMessage skill when a reply belongs there."
    );
  }
  return lines.join("\n");
}
