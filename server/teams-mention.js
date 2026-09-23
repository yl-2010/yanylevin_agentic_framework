/**
 * Detect Teams chat texts that mention @agent / @Agent.
 * Yan fromMe and guest (1:1 and group chats) share the token gate.
 * Who may start a session is the poller's job.
 */

import {
  AGENT_SENT_FOOTER,
  guestCallerLines,
  isBareAgentMention,
  messageMentionsAgent,
  stripAgentSentFooter,
} from "./imessage-mention.js";
import { SCHOOL_EMAIL } from "./school-mail.js";

const FOOTER_RE = new RegExp(
  AGENT_SENT_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  "i"
);

function clip(raw, max = 200) {
  return String(raw || "").trim().slice(0, max);
}

/**
 * @param {object|null|undefined} message
 */
export function teamsMessageKey(message) {
  const id = clip(message?.id, 120);
  const chatId = clip(message?.chatId, 120);
  if (id && chatId) return `teams:${chatId}:${id}`;
  if (id) return `teams:${id}`;
  return "";
}

/**
 * @param {object|null|undefined} message
 */
export function shouldTriggerTeamsAgent(message) {
  if (!message || typeof message !== "object") return false;
  const type = String(message.messageType || "message").trim().toLowerCase();
  if (type && type !== "message") return false;
  const text = String(message.text || "").trim();
  if (!text) return false;
  if (FOOTER_RE.test(text)) return false;
  return messageMentionsAgent(text);
}

/**
 * @param {object|null|undefined} message
 */
export function normalizeTeamsOrigin(message) {
  if (!message || typeof message !== "object") return null;
  const chat = clip(message.chat, 80);
  const chatId = clip(message.chatId, 200);
  if (!chatId && !chat) return null;
  return {
    to: chatId || chat,
    chat,
    chatId,
    key: teamsMessageKey(message),
    text: String(message.text || "").trim().slice(0, 10_000),
    fromEmail: clip(
      message.fromEmail || (message.fromMe === true ? SCHOOL_EMAIL : ""),
      80
    ),
  };
}

/**
 * Live-context block for a session started from a Teams @agent mention.
 * @param {object|null|undefined} origin
 * @param {{ deliverFinal?: boolean, guestCaller?: object|null }} [opts]
 */
export function formatTeamsOriginBlock(origin, opts = {}) {
  if (!origin || typeof origin !== "object") return "";
  const chat = String(origin.chat || "").trim();
  const chatId = String(origin.chatId || origin.to || "").trim();
  const bare = isBareAgentMention(origin.text);
  const threadLimit = bare ? 80 : 40;
  const chatArg = chatId || chat;
  const guestLines = guestCallerLines(opts.guestCaller, "Teams");
  const lines = [
    guestLines.length
      ? guestLines[0]
      : "Called from Teams. This Personal Agent chat is otherwise normal (app and website bubbles, send_chat_message, tools).",
    ...guestLines.slice(1),
    `- Teams chat: ${chat || "?"}${chatId && chatId !== chat ? ` (${chatId})` : ""}`,
  ];
  if (chatId) lines.push(`- send replies to chat id: ${chatId}`);
  if (bare) {
    lines.push(
      "The user message is only @agent. That is not the task. Read the surrounding Teams thread first, then infer why they called you and what to do from the recent messages (a question someone asked, a plan, a thing they want handled). Do not reply asking what they want unless the thread is empty or you truly cannot tell."
    );
  }
  lines.push(
    `Read the surrounding thread before answering: node server/school-teams.js thread --chat ${JSON.stringify(chatArg)} --limit ${threadLimit} (school Teams skill).`,
    "Teams cannot attach a file. When Yan wants a PDF or other file delivered to a person, email it from Apple Mail and say so in the reply. Do not paste a file path into this chat. School Outlook cannot send that file.",
    "The app and website thread is a normal Personal Agent chat. On long work, call send_chat_message first with a short status, then again when something new happens, the same as if this were typed in the app. Those bubbles stay in the app and website only. They are never sent to Teams.",
    "Write the final bubble as the text that should land in that Teams chat. Markdown is fine, same as the app bubble (bold, italic, lists, links, headings, code). The server converts it to Teams HTML so desktop and mobile keep newlines and formatting. No HTML tags, no @agent. The app and website keep that final bubble as the end of the turn (the answer or what you did). Do not write Sent on Teams. Do not add // Sent by Yan's Personal Agent. The server appends that footer on the Teams message only, never in the app or website thread."
  );
  if (opts.deliverFinal !== false) {
    lines.push(
      "The server delivers your final bubble to that same Teams chat. Do not also school-teams send that same final text."
    );
  } else {
    lines.push(
      "This chat started from that Teams thread. Later app turns do not auto-post it; send via the school Teams skill when a reply belongs there."
    );
  }
  return lines.join("\n");
}

export { stripAgentSentFooter };
