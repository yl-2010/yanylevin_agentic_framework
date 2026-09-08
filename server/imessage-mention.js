/**
 * Detect Yan fromMe iMessages that mention @agent / @Agent.
 * Poller and Personal Agent share these helpers.
 */

export const AGENT_SENT_FOOTER = "Sent by Yan's Personal Agent";
/** Word token, any casing. Avoids emails like foo@agent.com. */
export const AGENT_MENTION_RE = /(^|[^\w@])@agent\b/i;

/**
 * @param {unknown} raw
 */
export function messageMentionsAgent(raw) {
  return AGENT_MENTION_RE.test(String(raw || ""));
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
  if (new RegExp(AGENT_SENT_FOOTER, "i").test(text)) return false;
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
 * @param {string} text
 * @param {object|null|undefined} origin
 */
export function applyAgentSentFooter(text, origin) {
  const body = String(text || "").trim();
  if (!body) return "";
  if (new RegExp(AGENT_SENT_FOOTER, "i").test(body)) return body;
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
  const lines = [
    "Called from iMessage. This Personal Agent chat is otherwise normal (app and website bubbles, send_chat_message, tools).",
    `- iMessage chat: ${chat || "?"}${chatId && chatId !== chat ? ` (${chatId})` : ""}`,
  ];
  if (handle) lines.push(`- handle: ${handle}`);
  if (to) lines.push(`- send replies to: ${to}`);
  lines.push(
    `Read the surrounding thread before answering: curl -sS --unix-socket /tmp/personal-agent-local.sock "http://localhost/imessage/thread?person=${threadQ}&limit=40" (iMessage skill).`,
    "Write the final bubble as the text that should land in that iMessage (plain text, no markdown, no @agent). Intermediate send_chat_message bubbles stay in the Personal Agent app only."
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
